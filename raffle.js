// raffle.js — Officer-run prize raffles gated on cycle participation.
//
// Entry is earned, not free: a member must clear attendance / voice / war
// thresholds before they can enter. Past the gate everyone has FLAT odds —
// qualifying improves your chance of being allowed in, not your chance of
// winning. Up to three distinct winners are drawn (1st / 2nd / 3rd).
//
// State lives on the persistent volume so a redeploy mid-raffle keeps every
// entry; index.js re-arms the draw timers on boot.

const { safeReadJSON, atomicWriteJSONSync, dataPath } = require('./persistence');
const attendance = require('./attendance');

const RAFFLES_FILE   = dataPath('.raffles.json');
const PRIZE_LOG_FILE = dataPath('.prize_log.json');

// Defaults applied when /raffle-start omits a threshold.
const DEFAULT_REQUIREMENTS = {
  minScore:      30,  // weighted attendance pts (VoB 30 / SW 10 / Vault 1)
  minVoiceHours:  5,  // Discord voice hours accrued this cycle, any channel
  minWarEvents:   2,  // count of VoB + Shadow War credits this cycle
};

const WAR_EVENT_KEYS = ['vob', 'shadow_war'];
const MAX_WINNERS = 3;
const PLACE_LABELS = ['🥇 1st', '🥈 2nd', '🥉 3rd'];

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
function loadRaffles() {
  const arr = safeReadJSON(RAFFLES_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
function saveRaffles(arr) {
  try { atomicWriteJSONSync(RAFFLES_FILE, arr); }
  catch (e) { console.log('[raffle] save error:', e.message); }
}
function getRaffle(id) {
  return loadRaffles().find(r => r.id === id) || null;
}
// Read-modify-write a single raffle by id. Returns the updated raffle, or
// null if it no longer exists.
function mutateRaffle(id, fn) {
  const all = loadRaffles();
  const idx = all.findIndex(r => r.id === id);
  if (idx === -1) return null;
  fn(all[idx]);
  saveRaffles(all);
  return all[idx];
}

function loadPrizeLog() {
  const arr = safeReadJSON(PRIZE_LOG_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
function appendPrizeLog(entry) {
  const all = loadPrizeLog();
  all.push({ ...entry, ts: Date.now() });
  // Keep the ledger bounded — officers only ever read the recent tail.
  const trimmed = all.length > 500 ? all.slice(-500) : all;
  try { atomicWriteJSONSync(PRIZE_LOG_FILE, trimmed); }
  catch (e) { console.log('[raffle] prize-log save error:', e.message); }
}

// ─── DURATION PARSING ────────────────────────────────────────────────────────
// Accepts "30m", "24h", "7d", or a bare number treated as hours.
function parseDuration(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([mhd]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  const unit = m[2] || 'h';
  const ms = unit === 'm' ? n * 60_000
           : unit === 'd' ? n * 86_400_000
           : n * 3_600_000;
  // Guard rails: 1 minute minimum, 30 days maximum.
  if (ms < 60_000 || ms > 30 * 86_400_000) return null;
  return ms;
}

// ─── ELIGIBILITY ─────────────────────────────────────────────────────────────
// Reports the member's current standing plus a human-readable list of what
// they're short on, so the Enter button can tell them exactly why they failed.
function checkEligibility(cycleState, userId, req) {
  const r = { ...DEFAULT_REQUIREMENTS, ...(req || {}) };
  const att = cycleState?.attendance?.[userId];
  const events = att?.events || [];

  const score      = attendance.computeWeightedScore(events);
  const voiceHours = (cycleState?.globalVoiceMinutes?.[userId] || 0) / 60;
  const warEvents  = events.filter(e => WAR_EVENT_KEYS.includes(e.key)).length;

  const missing = [];
  if (score < r.minScore) {
    missing.push(`**${r.minScore - score}** more attendance pts (have ${score}/${r.minScore})`);
  }
  if (voiceHours < r.minVoiceHours) {
    const short = (r.minVoiceHours - voiceHours).toFixed(1);
    missing.push(`**${short}** more voice hours (have ${voiceHours.toFixed(1)}/${r.minVoiceHours})`);
  }
  if (warEvents < r.minWarEvents) {
    missing.push(`**${r.minWarEvents - warEvents}** more VoB/Shadow War events (have ${warEvents}/${r.minWarEvents})`);
  }

  return { eligible: missing.length === 0, missing, score, voiceHours, warEvents, req: r };
}

// ─── LIFECYCLE ───────────────────────────────────────────────────────────────
function createRaffle({ guildId, channelId, createdBy, prizes, requirements, durationMs }) {
  const now = Date.now();
  const raffle = {
    id: `raffle_${now}_${Math.random().toString(36).slice(2, 8)}`,
    guildId,
    channelId,
    messageId: null,            // filled in once the embed is posted
    createdBy,
    createdAt: new Date(now).toISOString(),
    endsAt: new Date(now + durationMs).toISOString(),
    prizes: {
      first:  prizes.first  || null,
      second: prizes.second || null,
      third:  prizes.third  || null,
    },
    requirements: { ...DEFAULT_REQUIREMENTS, ...(requirements || {}) },
    entries: [],
    status: 'open',
    winners: null,
  };
  const all = loadRaffles();
  all.push(raffle);
  saveRaffles(all);
  return raffle;
}

function attachMessage(id, messageId) {
  return mutateRaffle(id, r => { r.messageId = messageId; });
}

// Returns { ok, reason, raffle } — reason is a machine-readable code so the
// button handler can pick the right ephemeral reply.
function enterRaffle(id, userId, cycleState) {
  const raffle = getRaffle(id);
  if (!raffle)                      return { ok: false, reason: 'not_found' };
  if (raffle.status !== 'open')     return { ok: false, reason: 'closed' };
  if (Date.now() >= new Date(raffle.endsAt).getTime()) return { ok: false, reason: 'closed' };
  if (raffle.entries.includes(userId)) return { ok: false, reason: 'already_entered', raffle };

  const elig = checkEligibility(cycleState, userId, raffle.requirements);
  if (!elig.eligible) return { ok: false, reason: 'ineligible', raffle, elig };

  const updated = mutateRaffle(id, r => { r.entries.push(userId); });
  return { ok: true, raffle: updated, elig };
}

// Flat odds: shuffle-and-take, so every entrant has the same chance and no
// one can win two places in the same draw.
function drawWinners(entries, count) {
  const pool = [...entries];
  const picked = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}

// Closes the raffle and records winners. Idempotent — calling it twice (cron
// race, double boot re-arm) returns the already-drawn result instead of
// re-rolling.
function drawRaffle(id) {
  const existing = getRaffle(id);
  if (!existing) return null;
  if (existing.status === 'drawn') return existing;

  const prizeList = [existing.prizes.first, existing.prizes.second, existing.prizes.third]
    .filter(Boolean)
    .slice(0, MAX_WINNERS);
  const picked = drawWinners(existing.entries, prizeList.length);
  const winners = picked.map((userId, i) => ({
    userId,
    place: i + 1,
    placeLabel: PLACE_LABELS[i],
    prize: prizeList[i],
  }));

  const updated = mutateRaffle(id, r => {
    r.status = 'drawn';
    r.winners = winners;
    r.drawnAt = new Date().toISOString();
  });

  if (updated && winners.length) {
    appendPrizeLog({
      raffleId: updated.id,
      guildId:  updated.guildId,
      entrants: updated.entries.length,
      winners:  winners.map(w => ({ userId: w.userId, place: w.place, prize: w.prize })),
    });
  }
  return updated;
}

function cancelRaffle(id) {
  return mutateRaffle(id, r => {
    if (r.status === 'open') r.status = 'cancelled';
  });
}

function listOpenRaffles() {
  return loadRaffles().filter(r => r.status === 'open');
}

// Drop finished raffles older than 30 days so the file doesn't grow forever.
// The prize log keeps the permanent winner record.
function pruneOldRaffles() {
  const cutoff = Date.now() - 30 * 86_400_000;
  const all = loadRaffles();
  const kept = all.filter(r =>
    r.status === 'open' || new Date(r.drawnAt || r.endsAt).getTime() > cutoff
  );
  if (kept.length !== all.length) saveRaffles(kept);
  return all.length - kept.length;
}

module.exports = {
  DEFAULT_REQUIREMENTS,
  MAX_WINNERS,
  PLACE_LABELS,
  parseDuration,
  checkEligibility,
  drawWinners,
  createRaffle,
  attachMessage,
  enterRaffle,
  drawRaffle,
  cancelRaffle,
  getRaffle,
  listOpenRaffles,
  loadPrizeLog,
  pruneOldRaffles,
};
