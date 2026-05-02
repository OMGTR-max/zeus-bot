// ⚡ ZEUS BOT — Attendance Tracker
// Tracks Shadow War and VoB attendance via voice channel presence
// and react-to-claim messages. Cycle-based awards.

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { EmbedBuilder } = require('discord.js');

const TIMEZONE = 'Asia/Manila';
const CONFIG_FILE  = path.join(__dirname, '.attendance_config.json');
const STATE_FILE   = path.join(__dirname, '.attendance.json');
const HISTORY_FILE = path.join(__dirname, '.attendance_history.json');

// Event window definitions (Asia/Manila local time)
const EVENT_DEFINITIONS = {
  shadow_war: {
    name: 'Shadow War',
    icon: '⚔️',
    days: [4, 6],     // Thursday, Saturday
    startTime: '19:25',
    endTime:   '21:00',
  },
  vob: {
    name: 'Vault of the Blacksmith',
    icon: '🛡️',
    days: [0],        // Sunday
    startTime: '19:55',
    endTime:   '21:30',
  },
};

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (e) {
    console.log('[Attendance] config load error:', e.message);
  }
  return defaultConfig();
}

function defaultConfig() {
  return {
    warVoiceCategoryId: null,
    checkInChannelId:  null,
    leaderboardChannelId: null,
    awardRoles: {
      mvp: null,
      stormBearer: null,
      lightningStriker: null,
      veteran: null,
    },
    officerRoleIds: [],
  };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('[Attendance] state load error:', e.message);
  }
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('[Attendance] history load error:', e.message);
  }
  return [];
}

function appendHistory(cycleResult) {
  const history = loadHistory();
  history.push(cycleResult);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ─── CYCLE MANAGEMENT ─────────────────────────────────────────────────────────
function startCycle(faction, startDateISO) {
  if (!['shadows', 'immortals'].includes(faction)) {
    throw new Error("faction must be 'shadows' or 'immortals'");
  }
  const start = startDateISO
    ? moment(startDateISO).tz(TIMEZONE).startOf('day')
    : moment().tz(TIMEZONE).startOf('day');
  const state = {
    cycleId: `cycle_${start.format('YYYYMMDD')}_${faction}`,
    faction,
    startDate: start.toISOString(),
    durationWeeks: 7,
    attendance: {},
    checkInMessages: [],
  };
  saveState(state);
  return state;
}

function getCurrentCycle() {
  return loadState();
}

function getCycleWeek(state, now) {
  if (!state) return null;
  const start = moment(state.startDate).tz(TIMEZONE);
  const days = moment(now).tz(TIMEZONE).diff(start, 'days');
  const week = Math.floor(days / 7) + 1;
  if (week < 1 || week > state.durationWeeks) return null;
  return week;
}

// Cycle rules per Zeus Clan spec:
//   SHADOWS:   Shadow War weeks 1-7, VoB weeks 1-3
//   IMMORTALS: VoB weeks 1-3 only
function isEventTracked(state, eventKey, week) {
  if (!state || !week) return false;
  if (state.faction === 'shadows') {
    if (eventKey === 'shadow_war') return week >= 1 && week <= 7;
    if (eventKey === 'vob')        return week >= 1 && week <= 3;
  }
  if (state.faction === 'immortals') {
    if (eventKey === 'vob')        return week >= 1 && week <= 3;
  }
  return false;
}

function getActiveEvent(now = new Date()) {
  const state = loadState();
  if (!state) return null;
  const week = getCycleWeek(state, now);
  if (!week) return null;
  const m = moment(now).tz(TIMEZONE);

  for (const [key, def] of Object.entries(EVENT_DEFINITIONS)) {
    if (!def.days.includes(m.day())) continue;
    const [sh, sm] = def.startTime.split(':').map(Number);
    const [eh, em] = def.endTime.split(':').map(Number);
    const startM = m.clone().set({ hour: sh, minute: sm, second: 0 });
    const endM   = m.clone().set({ hour: eh, minute: em, second: 0 });
    if (m.isBetween(startM, endM, null, '[)')) {
      if (isEventTracked(state, key, week)) {
        return { key, def, week, eventDate: m.format('YYYY-MM-DD') };
      }
    }
  }
  return null;
}

// Compute total possible events for a cycle (for percentage math)
function computeMaxEvents(state) {
  if (!state) return 0;
  if (state.faction === 'shadows')   return 14 + 3; // 7w × (Thu+Sat) + 3 VoB
  if (state.faction === 'immortals') return 3;
  return 0;
}

// ─── ATTENDANCE RECORDING ─────────────────────────────────────────────────────
function recordAttendance(userId, eventKey, eventDate) {
  const state = loadState();
  if (!state) return false;
  if (!state.attendance[userId]) {
    state.attendance[userId] = { count: 0, events: [] };
  }
  const already = state.attendance[userId].events.some(
    e => e.key === eventKey && e.date === eventDate
  );
  if (already) return false;
  state.attendance[userId].events.push({ key: eventKey, date: eventDate });
  state.attendance[userId].count++;
  saveState(state);
  return true;
}

// ─── VOICE PRESENCE LISTENER ──────────────────────────────────────────────────
async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const cfg = loadConfig();
    if (!cfg.warVoiceCategoryId) return;

    const newCh = newState.channel;
    const oldCh = oldState.channel;
    const inWarCategoryNow  = newCh && newCh.parentId === cfg.warVoiceCategoryId;
    const inWarCategoryBefore = oldCh && oldCh.parentId === cfg.warVoiceCategoryId;

    // Only act when the user *enters* the war category (from outside it).
    // Moves between rooms within the same category don't re-trigger.
    if (!inWarCategoryNow) return;
    if (inWarCategoryBefore) return;

    const event = getActiveEvent(new Date());
    if (!event) return;

    const recorded = recordAttendance(newState.id, event.key, event.eventDate);
    if (recorded) {
      const tag = newState.member?.user?.tag || newState.id;
      console.log(`[Attendance] ${tag} credited for ${event.def.name} (joined ${newCh.name})`);
    }
  } catch (e) {
    console.log('[Attendance] voice handler error:', e.message);
  }
}

// ─── REACT-TO-CLAIM ───────────────────────────────────────────────────────────
async function postCheckInMessage(client, eventKey) {
  const cfg = loadConfig();
  if (!cfg.checkInChannelId) {
    console.log('[Attendance] No check-in channel configured; skipping post.');
    return null;
  }
  const state = loadState();
  if (!state) return null;
  const week = getCycleWeek(state, new Date());
  if (!isEventTracked(state, eventKey, week)) return null;

  const def = EVENT_DEFINITIONS[eventKey];
  const channel = await client.channels.fetch(cfg.checkInChannelId).catch(() => null);
  if (!channel) return null;

  const eventDate = moment().tz(TIMEZONE).format('YYYY-MM-DD');
  const embed = new EmbedBuilder()
    .setTitle(`${def.icon} ${def.name} — Attendance Check-In`)
    .setDescription(
      `React with 🛡️ within **15 minutes** to claim attendance.\n\n` +
      `Or join the war voice channel — you'll be credited automatically.\n\n` +
      `**Cycle Week ${week} of ${state.durationWeeks}** | Faction: **${state.faction.toUpperCase()}**`
    )
    .setColor(0xFFD700)
    .setFooter({ text: 'Zeus Clan Attendance Tracker' })
    .setTimestamp();

  const msg = await channel.send({ embeds: [embed] });
  try { await msg.react('🛡️'); } catch {}

  const expiresAt = moment().tz(TIMEZONE).add(15, 'minutes').toISOString();
  state.checkInMessages.push({
    messageId: msg.id,
    channelId: msg.channel.id,
    eventKey,
    eventDate,
    expiresAt,
  });
  saveState(state);

  setTimeout(() => closeCheckIn(msg.id), 15 * 60 * 1000);
  return msg;
}

async function handleCheckInReaction(reaction, user) {
  try {
    if (user.bot) return;
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.emoji.name !== '🛡️') return;

    const state = loadState();
    if (!state) return;
    const checkIn = state.checkInMessages.find(c => c.messageId === reaction.message.id);
    if (!checkIn) return;
    if (moment().isAfter(moment(checkIn.expiresAt))) return;

    recordAttendance(user.id, checkIn.eventKey, checkIn.eventDate);
  } catch (e) {
    console.log('[Attendance] reaction handler error:', e.message);
  }
}

function closeCheckIn(messageId) {
  const state = loadState();
  if (!state) return;
  const idx = state.checkInMessages.findIndex(c => c.messageId === messageId);
  if (idx === -1) return;
  state.checkInMessages.splice(idx, 1);
  saveState(state);
}

// ─── LEADERBOARD & WINNERS ────────────────────────────────────────────────────
function buildLeaderboard(state, officerRoleIds = [], guild = null) {
  const max = computeMaxEvents(state);
  const entries = Object.entries(state.attendance || {}).map(([userId, data]) => ({
    userId,
    username: userId,
    count: data.count,
    percentage: max ? (data.count / max) * 100 : 0,
    isOfficer: false,
  }));

  if (guild) {
    for (const entry of entries) {
      const member = guild.members.cache.get(entry.userId);
      if (member) {
        entry.username = member.displayName || member.user.username;
        if (officerRoleIds.length) {
          entry.isOfficer = member.roles.cache.some(r => officerRoleIds.includes(r.id));
        }
      }
    }
  }

  entries.sort((a, b) => b.count - a.count || b.percentage - a.percentage);
  return { max, entries };
}

function pickWinners(leaderboard) {
  const eligible = leaderboard.entries.filter(e => !e.isOfficer && e.count > 0);
  return {
    mvp:               eligible[0] || null,
    stormBearer:       eligible[1] || null,
    lightningStriker:  eligible[2] || null,
  };
}

// ─── CYCLE END ────────────────────────────────────────────────────────────────
async function endCycle(guild) {
  const state = loadState();
  if (!state) return { error: 'No active cycle to end.' };
  const cfg = loadConfig();

  const leaderboard = buildLeaderboard(state, cfg.officerRoleIds, guild);
  const winners = pickWinners(leaderboard);

  // Assign cycle award roles
  const assignments = [
    ['mvp',              winners.mvp,              cfg.awardRoles.mvp],
    ['stormBearer',      winners.stormBearer,      cfg.awardRoles.stormBearer],
    ['lightningStriker', winners.lightningStriker, cfg.awardRoles.lightningStriker],
  ];
  for (const [, winner, roleId] of assignments) {
    if (!winner || !roleId) continue;
    try {
      const member = await guild.members.fetch(winner.userId);
      await member.roles.add(roleId);
    } catch (e) {
      console.log('[Cycle End] role assign failed:', e.message);
    }
  }

  // Veteran of Zeus: 3 consecutive cycles in top 3
  const history = loadHistory();
  const lastTwo = history.slice(-2);
  const wasInTop3 = (cycle, userId) =>
    ['mvp', 'stormBearer', 'lightningStriker']
      .map(k => cycle.winners?.[k])
      .some(w => w && w.userId === userId);

  for (const winner of [winners.mvp, winners.stormBearer, winners.lightningStriker]) {
    if (!winner) continue;
    if (lastTwo.length < 2) continue;
    if (!lastTwo.every(c => wasInTop3(c, winner.userId))) continue;
    if (!cfg.awardRoles.veteran) continue;
    try {
      const member = await guild.members.fetch(winner.userId);
      await member.roles.add(cfg.awardRoles.veteran);
      winner.becameVeteran = true;
    } catch (e) {
      console.log('[Cycle End] veteran assign failed:', e.message);
    }
  }

  appendHistory({
    cycleId: state.cycleId,
    faction: state.faction,
    startDate: state.startDate,
    endDate: moment().tz(TIMEZONE).toISOString(),
    leaderboard,
    winners,
  });

  try { fs.unlinkSync(STATE_FILE); } catch {}

  return { winners, leaderboard, faction: state.faction };
}

module.exports = {
  EVENT_DEFINITIONS,
  TIMEZONE,
  loadConfig,
  saveConfig,
  loadState,
  loadHistory,
  startCycle,
  getCurrentCycle,
  getCycleWeek,
  getActiveEvent,
  isEventTracked,
  computeMaxEvents,
  recordAttendance,
  handleVoiceStateUpdate,
  handleCheckInReaction,
  postCheckInMessage,
  closeCheckIn,
  buildLeaderboard,
  pickWinners,
  endCycle,
};
