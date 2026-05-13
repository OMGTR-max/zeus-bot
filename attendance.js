// ⚡ ZEUS BOT — Attendance Tracker
// Tracks Shadow War and VoB attendance via voice channel presence
// and react-to-claim messages. Cycle-based awards.

const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone');
const { EmbedBuilder } = require('discord.js');
const { safeReadJSON, atomicWriteJSONSync, dataPath } = require('./persistence');

const TIMEZONE = 'Asia/Manila';
const CONFIG_FILE  = dataPath('.attendance_config.json');
const STATE_FILE   = dataPath('.attendance.json');
const HISTORY_FILE = dataPath('.attendance_history.json');

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
    name: 'Vigil of Blades',
    icon: '🛡️',
    days: [0],        // Sunday
    startTime: '19:55',
    endTime:   '21:30',
  },
};

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
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

function loadConfig() {
  return { ...defaultConfig(), ...safeReadJSON(CONFIG_FILE, {}) };
}
function saveConfig(cfg) {
  atomicWriteJSONSync(CONFIG_FILE, cfg);
  try { writeConfigBackup(cfg); } catch (e) { console.log('[config-backup] write error:', e.message); }
}

function loadState() { return safeReadJSON(STATE_FILE, null); }
function saveState(state) {
  atomicWriteJSONSync(STATE_FILE, state);
  // Rotating backup so a wipe (volume swap, accidental /cycle-end, bug)
  // is one /cycle-restore away.
  try { writeBackup(state); } catch (e) { console.log('[backup] write error:', e.message); }
}

const BACKUP_DIR = path.join(path.dirname(STATE_FILE), 'backups');
const CONFIG_BACKUP_DIR = path.join(path.dirname(CONFIG_FILE), 'config-backups');
const MAX_BACKUPS = 10;
function writeBackup(state) {
  if (!state) return;
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `attendance-${stamp}.json`);
  atomicWriteJSONSync(backupPath, state);
  pruneBackups(BACKUP_DIR, 'attendance-');
}
function writeConfigBackup(cfg) {
  if (!cfg) return;
  try { fs.mkdirSync(CONFIG_BACKUP_DIR, { recursive: true }); } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(CONFIG_BACKUP_DIR, `config-${stamp}.json`);
  atomicWriteJSONSync(backupPath, cfg);
  pruneBackups(CONFIG_BACKUP_DIR, 'config-');
}
function pruneBackups(dir, prefix) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .sort(); // ISO timestamps sort lexically
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(dir, oldest)); } catch {}
    }
  } catch {}
}

// Self-heal on boot: if the live state or config file is missing but a
// backup exists, restore the newest one. Keeps the bot working when a
// volume swap, fs glitch, or accidental delete wipes the live files but
// rolling backups survived.
function autoRecoverFromBackups() {
  const result = { stateRecovered: null, configRecovered: null };
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const backups = listBackups();
      if (backups.length > 0) {
        const latest = backups[0];
        const data = loadBackup(latest);
        if (data) {
          atomicWriteJSONSync(STATE_FILE, data);
          result.stateRecovered = latest;
          console.log(`[autorecover] Restored .attendance.json from backup ${latest}`);
        }
      }
    }
  } catch (e) { console.log('[autorecover] state error:', e.message); }
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      const files = fs.existsSync(CONFIG_BACKUP_DIR)
        ? fs.readdirSync(CONFIG_BACKUP_DIR)
            .filter(f => f.startsWith('config-') && f.endsWith('.json'))
            .sort().reverse()
        : [];
      if (files.length > 0) {
        const latest = files[0];
        const data = safeReadJSON(path.join(CONFIG_BACKUP_DIR, latest), null);
        if (data) {
          atomicWriteJSONSync(CONFIG_FILE, data);
          result.configRecovered = latest;
          console.log(`[autorecover] Restored .attendance_config.json from backup ${latest}`);
        }
      }
    }
  } catch (e) { console.log('[autorecover] config error:', e.message); }
  return result;
}
function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('attendance-') && f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
  } catch { return []; }
}
function loadBackup(filename) {
  return safeReadJSON(path.join(BACKUP_DIR, filename), null);
}
function restoreFromBackup(filename) {
  const data = loadBackup(filename);
  if (!data) return null;
  // Use atomicWriteJSONSync directly so the restore itself doesn't trigger
  // another backup-write (would push the just-restored copy to top of list).
  atomicWriteJSONSync(STATE_FILE, data);
  return data;
}

function loadHistory() { return safeReadJSON(HISTORY_FILE, []); }
function appendHistory(cycleResult) {
  const history = loadHistory();
  history.push(cycleResult);
  atomicWriteJSONSync(HISTORY_FILE, history);
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
function recordAttendance(userId, eventKey, eventDate, username = null) {
  const state = loadState();
  if (!state) return false;
  if (!state.attendance[userId]) {
    state.attendance[userId] = { count: 0, events: [] };
  }
  // Stash latest known username so the leaderboard has a non-mention fallback
  // when the member isn't in the bot's cache (uncached idle members render
  // their raw `<@id>` mention as plain text inside an embed).
  if (username) state.attendance[userId].username = username;
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
// Tracks two things per cycle:
// 1. War voice duration (clamped to the event window) — used to flag drive-by
//    credit grabs and to feed the engagement score.
// 2. Global voice duration (any voice channel, anytime) — pure engagement
//    signal, no impact on awards.
async function handleVoiceStateUpdate(oldState, newState) {
  try {
    const userId = newState.id;
    const oldCh = oldState.channel;
    const newCh = newState.channel;
    if (oldCh?.id === newCh?.id) return; // mute/deafen toggles, no channel change

    // Close any session that was open in the old channel (covers leave + move).
    if (oldCh) closeVoiceSession(userId);

    if (newCh) {
      const cfg = loadConfig();
      const inWar = cfg.warVoiceCategoryId && newCh.parentId === cfg.warVoiceCategoryId;
      const event = inWar ? getActiveEvent(new Date()) : null;

      // Existing credit logic preserved: first entry to war category during
      // an active event window earns the boolean +1 attendance.
      if (event) {
        const uname = newState.member?.displayName || newState.member?.user?.username || null;
        const recorded = recordAttendance(userId, event.key, event.eventDate, uname);
        if (recorded) {
          const tag = newState.member?.user?.tag || userId;
          console.log(`[Attendance] ${tag} credited for ${event.def.name} (joined ${newCh.name})`);
        }
      }
      openVoiceSession(userId, newCh.id, event);
    }
  } catch (e) {
    console.log('[Attendance] voice handler error:', e.message);
  }
}

function openVoiceSession(userId, channelId, event) {
  const state = loadState();
  if (!state) return;
  state.voiceSessions = state.voiceSessions || {};
  state.voiceSessions[userId] = {
    joinedAt: new Date().toISOString(),
    channelId,
    eventKey:  event?.key  || null,
    eventDate: event?.eventDate || null,
  };
  saveState(state);
}

function closeVoiceSession(userId) {
  const state = loadState();
  if (!state) return;
  const sess = state.voiceSessions?.[userId];
  if (!sess) return;

  const joinedMs = new Date(sess.joinedAt).getTime();
  const nowMs = Date.now();
  const totalMin = Math.max(0, (nowMs - joinedMs) / 60000);

  // Global voice presence accrues regardless of channel
  state.globalVoiceMinutes = state.globalVoiceMinutes || {};
  state.globalVoiceMinutes[userId] = (state.globalVoiceMinutes[userId] || 0) + totalMin;
  state.voiceLastSeen = state.voiceLastSeen || {};
  state.voiceLastSeen[userId] = new Date().toISOString();

  // War voice: clamp to the event window so post-war hangouts don't inflate
  if (sess.eventKey && sess.eventDate) {
    const warMin = clampToEventWindow(joinedMs, nowMs, sess.eventKey, sess.eventDate);
    if (warMin > 0) {
      const att = state.attendance?.[userId];
      const ev  = att?.events?.find(e => e.key === sess.eventKey && e.date === sess.eventDate);
      if (ev) ev.voiceMinutes = Math.round((ev.voiceMinutes || 0) + warMin);
    }
  }

  delete state.voiceSessions[userId];
  saveState(state);
}

function clampToEventWindow(joinedMs, leftMs, eventKey, eventDate) {
  const def = EVENT_DEFINITIONS[eventKey];
  if (!def) return 0;
  const startMs = moment.tz(`${eventDate} ${def.startTime}`, 'YYYY-MM-DD HH:mm', TIMEZONE).valueOf();
  const endMs   = moment.tz(`${eventDate} ${def.endTime}`,   'YYYY-MM-DD HH:mm', TIMEZONE).valueOf();
  const start = Math.max(joinedMs, startMs);
  const end   = Math.min(leftMs,   endMs);
  return Math.max(0, (end - start) / 60000);
}

// On boot, voice sessions in state are stale (the bot restarted, so the
// session start time is no longer trustworthy). Drop them; new joins/leaves
// will reopen sessions as members move.
function clearStaleVoiceSessions() {
  const state = loadState();
  if (!state) return;
  if (state.voiceSessions && Object.keys(state.voiceSessions).length) {
    state.voiceSessions = {};
    saveState(state);
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

  // Re-load state after the await — a voice/reaction event during
  // channel.send could have written to it, so don't clobber.
  const fresh = loadState();
  if (!fresh) return msg;
  const expiresAt = moment().tz(TIMEZONE).add(15, 'minutes').toISOString();
  fresh.checkInMessages.push({
    messageId: msg.id,
    channelId: msg.channel.id,
    eventKey,
    eventDate,
    expiresAt,
  });
  saveState(fresh);

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

    const member = reaction.message.guild?.members?.cache?.get(user.id);
    const uname = member?.displayName || user.username || null;
    recordAttendance(user.id, checkIn.eventKey, checkIn.eventDate, uname);
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

// Restore in-flight check-in close timers after a bot restart.
// Fires immediately for any expired entry, re-arms timeouts for future ones.
function rearmPendingCheckIns() {
  const state = loadState();
  if (!state || !Array.isArray(state.checkInMessages)) return;
  const now = Date.now();
  for (const c of [...state.checkInMessages]) {
    const expiresMs = new Date(c.expiresAt).getTime();
    const remaining = expiresMs - now;
    if (remaining <= 0) {
      closeCheckIn(c.messageId);
    } else {
      setTimeout(() => closeCheckIn(c.messageId), remaining);
    }
  }
}

// ─── CHAT ACTIVITY ──────────────────────────────────────────────────────────
// Per-user: count, lastMessage, channels (breadth) — feeds engagement score.
function recordChatMessage(userId, channelId) {
  const state = loadState();
  if (!state) return; // only track during an active cycle
  state.chatActivity = state.chatActivity || {};
  if (!state.chatActivity[userId]) {
    state.chatActivity[userId] = { count: 0, lastMessage: null, channels: {} };
  }
  const a = state.chatActivity[userId];
  a.count++;
  a.lastMessage = new Date().toISOString();
  a.channels = a.channels || {};
  a.channels[channelId] = (a.channels[channelId] || 0) + 1;
  saveState(state);
}

function getActivityReport(guild, officerRoleIds = []) {
  const state = loadState();
  if (!state) return null;
  const activity = state.chatActivity || {};
  const entries = Object.entries(activity).map(([userId, data]) => {
    const member = guild?.members?.cache?.get(userId);
    const isOfficer = officerRoleIds.length && member
      ? member.roles.cache.some(r => officerRoleIds.includes(r.id))
      : false;
    return {
      userId,
      username: member?.displayName || member?.user?.username || `<@${userId}>`,
      count: data.count,
      lastMessage: data.lastMessage,
      isOfficer,
    };
  });
  entries.sort((a, b) => b.count - a.count);
  return entries;
}

// ─── ENGAGEMENT SCORE + QUALITY FLAGS ────────────────────────────────────────
// War attendance stays the sole award criterion. Engagement is a separate
// public scale: chat + voice + breadth + recency. Officer-facing quality
// flags surface drive-by credit grabs and ghost members without affecting
// the cycle outcome.
const ENGAGEMENT_WEIGHTS = {
  chatPerMessage:        1,
  channelBreadthPer:     5,
  globalVoicePerMin:     0.5,
  warVoicePerMin:        2,
  attendancePerEvent:    50,
  recencyMultiplier:     2,   // applied to last-7-day chat
};
// Drive-by: less than this many minutes in war voice during the event window
// is treated as a credit grab. Wars are 5–20 min so 5 min = the minimum
// duration of a real engagement.
const DRIVE_BY_THRESHOLD_MIN = 5;

function computeEngagementScore(state, userId) {
  if (!state) return 0;
  const chat   = state.chatActivity?.[userId];
  const att    = state.attendance?.[userId];
  const gvm    = state.globalVoiceMinutes?.[userId] || 0;
  const events = att?.events || [];

  const warVoiceMin = events.reduce((sum, e) => sum + (e.voiceMinutes || 0), 0);
  const channelBreadth = chat?.channels ? Object.keys(chat.channels).length : 0;

  // Recency bonus: messages in the last 7 days. We don't have per-day
  // buckets, so we approximate using lastMessage age — full bonus if last
  // active within 7 days, scaled toward 0 over 14 days.
  let recency = 0;
  if (chat?.lastMessage) {
    const ageDays = (Date.now() - new Date(chat.lastMessage).getTime()) / 86400000;
    recency = Math.max(0, 1 - ageDays / 14);
  }

  return Math.round(
    (chat?.count || 0)        * ENGAGEMENT_WEIGHTS.chatPerMessage +
    channelBreadth            * ENGAGEMENT_WEIGHTS.channelBreadthPer +
    gvm                       * ENGAGEMENT_WEIGHTS.globalVoicePerMin +
    warVoiceMin               * ENGAGEMENT_WEIGHTS.warVoicePerMin +
    (att?.count || 0)         * ENGAGEMENT_WEIGHTS.attendancePerEvent +
    (chat?.count || 0) * recency * ENGAGEMENT_WEIGHTS.recencyMultiplier
  );
}

function getQualityFlags(state, userId) {
  const flags = [];
  if (!state) return flags;
  const att = state.attendance?.[userId];
  const chat = state.chatActivity?.[userId];
  const events = att?.events || [];
  const attended = att?.count || 0;
  const totalWarVoice = events.reduce((sum, e) => sum + (e.voiceMinutes || 0), 0);
  const avgWarVoice = attended ? totalWarVoice / attended : 0;
  const lastMsg = chat?.lastMessage ? new Date(chat.lastMessage).getTime() : 0;
  const lastVoice = state.voiceLastSeen?.[userId]
    ? new Date(state.voiceLastSeen[userId]).getTime() : 0;
  const now = Date.now();
  const daysSinceMsg   = lastMsg   ? (now - lastMsg)   / 86400000 : Infinity;
  const daysSinceVoice = lastVoice ? (now - lastVoice) / 86400000 : Infinity;

  if (attended > 0 && avgWarVoice < DRIVE_BY_THRESHOLD_MIN) flags.push('drive_by');
  if (attended > 0 && daysSinceMsg > 7) flags.push('silent');
  if (daysSinceMsg > 14 && daysSinceVoice > 14) flags.push('ghost');
  return flags;
}

// Build the unified engagement report — every member with any cycle signal,
// sorted by engagement score. Includes raw signals and quality flags.
function getEngagementReport(guild, officerRoleIds = []) {
  const state = loadState();
  if (!state) return null;

  // Union of every userId we've seen any signal for this cycle
  const ids = new Set([
    ...Object.keys(state.attendance || {}),
    ...Object.keys(state.chatActivity || {}),
    ...Object.keys(state.globalVoiceMinutes || {}),
  ]);

  const entries = [...ids].map(userId => {
    const member = guild?.members?.cache?.get(userId);
    const isOfficer = officerRoleIds.length && member
      ? member.roles.cache.some(r => officerRoleIds.includes(r.id))
      : false;
    const att   = state.attendance?.[userId];
    const chat  = state.chatActivity?.[userId];
    const events = att?.events || [];
    return {
      userId,
      username: member?.displayName || member?.user?.username || `<@${userId}>`,
      isOfficer,
      score:           computeEngagementScore(state, userId),
      flags:           getQualityFlags(state, userId),
      attendance:      att?.count || 0,
      chatCount:       chat?.count || 0,
      channelBreadth:  chat?.channels ? Object.keys(chat.channels).length : 0,
      globalVoiceMin:  Math.round(state.globalVoiceMinutes?.[userId] || 0),
      warVoiceMin:     Math.round(events.reduce((s, e) => s + (e.voiceMinutes || 0), 0)),
      lastMessage:     chat?.lastMessage || null,
    };
  });
  entries.sort((a, b) => b.score - a.score);
  return entries;
}

// ─── LEADERBOARD & WINNERS ────────────────────────────────────────────────────
// Async: cache misses (idle members not yet seen by the bot) are filled via
// guild.members.fetch so the leaderboard never falls back to a raw <@id>
// mention — those render as literal text inside embeds and broke the display.
async function buildLeaderboard(state, officerRoleIds = [], guild = null) {
  const max = computeMaxEvents(state);
  const entries = Object.entries(state.attendance || {}).map(([userId, data]) => ({
    userId,
    username: data.username || null,
    storedUsername: data.username || null,
    count: data.count,
    percentage: max ? (data.count / max) * 100 : 0,
    isOfficer: false,
  }));

  if (guild) {
    for (const entry of entries) {
      let member = guild.members.cache.get(entry.userId);
      if (!member) {
        try { member = await guild.members.fetch(entry.userId); }
        catch { member = null; }
      }
      if (member) {
        entry.username = member.displayName || member.user.username;
        if (officerRoleIds.length) {
          entry.isOfficer = member.roles.cache.some(r => officerRoleIds.includes(r.id));
        }
      } else if (!entry.username) {
        entry.username = `Unknown member (${entry.userId})`;
      }
    }
  } else {
    for (const entry of entries) {
      if (!entry.username) entry.username = `<@${entry.userId}>`;
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

  const leaderboard = await buildLeaderboard(state, cfg.officerRoleIds, guild);
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
  recordChatMessage,
  getActivityReport,
  rearmPendingCheckIns,
  computeEngagementScore,
  getQualityFlags,
  getEngagementReport,
  clearStaleVoiceSessions,
  ENGAGEMENT_WEIGHTS,
  DRIVE_BY_THRESHOLD_MIN,
  listBackups,
  loadBackup,
  restoreFromBackup,
  editCycleStartDate,
  autoRecoverFromBackups,
};

// Edit the active cycle's startDate without losing attendance/voice/chat
// data. Recomputes cycleId so it stays consistent with the new date.
function editCycleStartDate(newStartDateISO) {
  const state = loadState();
  if (!state) return { error: 'No active cycle to edit.' };
  const newStart = moment(newStartDateISO).tz(TIMEZONE).startOf('day');
  if (!newStart.isValid()) return { error: 'Invalid date. Use YYYY-MM-DD.' };
  state.startDate = newStart.toISOString();
  state.cycleId   = `cycle_${newStart.format('YYYYMMDD')}_${state.faction}`;
  saveState(state);
  return { state };
}
