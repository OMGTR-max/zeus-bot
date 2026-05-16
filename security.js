// security.js — Spam / virus / phishing defense for zeus-bot.
//
// Self-reliant heuristic engine (no external APIs). Every guild message is
// scored against a set of signals; the score determines auto-action:
//
//   ≥  25 → log to mod-log only
//   ≥  50 → delete the message
//   ≥  80 → delete + 24h Discord timeout (auto-quarantine)
//   ≥ 120 → delete + purge user's recent crossposts + 24h timeout
//
// Tuned for the most common Zeus threat: a compromised member posting a
// fake "Discord Nitro" / lookalike-invite link to multiple channels.

const { safeReadJSON, atomicWriteJSONSync, dataPath } = require('./persistence');

// ─── PERSISTENCE FILES ───────────────────────────────────────────────────────
const INCIDENTS_FILE    = dataPath('.security_incidents.json');
const DOMAIN_LISTS_FILE = dataPath('.security_domains.json');

// ─── DEFAULT DOMAIN LISTS ────────────────────────────────────────────────────
// Trusted: skipped entirely (score 0) when ALL urls in the message match.
// Blocked: instant +200 (well above any threshold).
const DEFAULT_TRUSTED = [
  'discord.gg', 'discord.com', 'discordapp.com', 'discord.media',
  'github.com', 'youtube.com', 'youtu.be',
  'blizzard.com', 'news.blizzard.com', 'us.diablo3.com',
  'imgur.com', 'i.imgur.com', 'tenor.com', 'giphy.com',
  'twitch.tv', 'reddit.com',
];

const DEFAULT_BLOCKED = [
  'dlscord.gg', 'dlscord.com', 'discrod.com', 'disocrd.com',
  'discord-nitro.com', 'discord-gift.com', 'discord-gift.ru',
  'discordnitro.gift', 'steamcommunlty.com', 'steamcomminuty.com',
];

function loadDomainLists() {
  const stored = safeReadJSON(DOMAIN_LISTS_FILE, null);
  if (!stored) {
    const init = { trusted: DEFAULT_TRUSTED.slice(), blocked: DEFAULT_BLOCKED.slice(), alliedGuilds: [] };
    saveDomainLists(init);
    return init;
  }
  return {
    trusted: Array.isArray(stored.trusted) ? stored.trusted : DEFAULT_TRUSTED.slice(),
    blocked: Array.isArray(stored.blocked) ? stored.blocked : DEFAULT_BLOCKED.slice(),
    alliedGuilds: Array.isArray(stored.alliedGuilds) ? stored.alliedGuilds : [],
  };
}
function saveDomainLists(lists) {
  try { atomicWriteJSONSync(DOMAIN_LISTS_FILE, lists); }
  catch (e) { console.log('[security] domain-list save error:', e.message); }
}

// ─── INCIDENT LOG ────────────────────────────────────────────────────────────
function loadIncidents() { return safeReadJSON(INCIDENTS_FILE, []); }
function saveIncidents(arr) {
  try {
    const trimmed = arr.length > 500 ? arr.slice(-500) : arr;
    atomicWriteJSONSync(INCIDENTS_FILE, trimmed);
  } catch (e) { console.log('[security] incidents save error:', e.message); }
}
function recordIncident(entry) {
  const all = loadIncidents();
  all.push({ ...entry, ts: Date.now() });
  saveIncidents(all);
}

// ─── URL EXTRACTION ──────────────────────────────────────────────────────────
// Captures `http(s)://host/path` AND bare `host.tld/path` — Discord
// auto-embeds raw domains, so attackers commonly post `dlscord.gg/free` with
// no protocol. Markdown-link form `[text](url)` is captured separately so we
// can detect display↔url mismatch (a classic phishing tell).
const URL_REGEX = /(?:https?:\/\/)?[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)+(?:\/[^\s<>]*)?/gi;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function extractUrls(text) {
  if (!text) return [];
  const found = [];
  let m;
  const md = new RegExp(MARKDOWN_LINK_REGEX.source, 'g');
  while ((m = md.exec(text)) !== null) {
    found.push({ raw: m[2], displayed: m[1], markdown: true });
  }
  const stripped = text.replace(md, ' ');
  const re = new RegExp(URL_REGEX.source, 'gi');
  let mm;
  while ((mm = re.exec(stripped)) !== null) {
    found.push({ raw: mm[0], displayed: null, markdown: false });
  }
  return found;
}

function parseHost(rawUrl) {
  try {
    const withProto = /^https?:\/\//i.test(rawUrl) ? rawUrl : 'http://' + rawUrl;
    return new URL(withProto).hostname.toLowerCase();
  } catch { return null; }
}

// ─── DISCORD INVITE EXTRACTION ───────────────────────────────────────────────
// `discord.gg` is a *trusted domain*, but an invite to an arbitrary server is
// itself a spam vector. Extract the invite code so it can be resolved against
// the API and compared to the server the message was posted in.
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite|discord\.gg\/invite)\/([a-z0-9-]+)/gi;

function extractInviteCodes(text) {
  if (!text) return [];
  const codes = new Set();
  const re = new RegExp(INVITE_REGEX.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) codes.add(m[1]);
  }
  return [...codes];
}

// Resolve an invite code to a verdict via the Discord API:
//   'self'       → points to the guild the message was posted in (always ok)
//   'allied'     → points to a guild on the officer-managed allowlist
//   'foreign'    → points to some other server (spam vector)
//   'unresolved' → expired / invalid / API error (a dead link, harmless)
async function classifyInvite(client, code, currentGuildId) {
  if (!client || typeof client.fetchInvite !== 'function') return 'unresolved';
  let invite;
  try { invite = await client.fetchInvite(code); }
  catch { return 'unresolved'; }
  const gid = invite?.guild?.id;
  if (!gid) return 'unresolved';
  if (currentGuildId && gid === currentGuildId) return 'self';
  const lists = loadDomainLists();
  if (lists.alliedGuilds.includes(gid)) return 'allied';
  return 'foreign';
}

// ─── DETECTION TABLES ────────────────────────────────────────────────────────
const SCAM_KEYWORDS = [
  'free nitro', 'discord nitro', 'nitro gift', 'nitro for free',
  'free gift', 'steam gift', 'free steam', 'free skin',
  'free csgo', 'free vbucks', 'free robux', '1000 robux',
  'airdrop', 'claim your', 'claim now', 'limited offer',
  '1 month nitro', '3 month nitro', '12 month nitro',
];

const SUSPICIOUS_TLDS = new Set([
  'ru', 'cn', 'tk', 'ml', 'gq', 'cf', 'top', 'xyz', 'click',
  'gift', 'work', 'review', 'country', 'kim', 'science', 'zip', 'mov',
]);

const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd',
  'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc',
  'rb.gy', 'shorte.st', 'adf.ly', 'lnkd.in',
]);

const DISCORD_REAL_APEX = ['discord.gg', 'discord.com', 'discordapp.com', 'discord.media'];

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function hasNonAscii(s) { return /[^\x00-\x7F]/.test(s); }

function isDiscordLookalike(host) {
  if (!host) return false;
  if (DISCORD_REAL_APEX.includes(host)) return false;
  const parts = host.split('.');
  const apex = parts.slice(-2).join('.');
  if (DISCORD_REAL_APEX.includes(apex)) return false;
  // Subdomain ending in a real apex (e.g. cdn.discord.com) is fine.
  if (DISCORD_REAL_APEX.some(d => host.endsWith('.' + d))) return false;
  if (hasNonAscii(host)) return true; // homograph attempt
  const sld = parts[parts.length - 2] || '';
  if (sld.length >= 5 && sld.includes('discord')) return true;
  if (sld.length >= 5 && sld.length <= 10 && levenshtein(sld, 'discord') <= 2) return true;
  const knownTypos = ['dlscord', 'discrod', 'disocrd', 'dliscord', 'dixcord', 'discordd', 'dscord'];
  if (knownTypos.includes(sld)) return true;
  return false;
}

function isIpHost(host) { return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host); }

function matchesList(host, list) {
  return list.some(d => host === d || host.endsWith('.' + d));
}

// ─── RECENT MESSAGE TRACKING (in-memory ring) ────────────────────────────────
// Used for crosspost detection and the "purge user's recent messages" action
// when a compromised account spams the same payload across channels.
const recentByUser = new Map();
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const RECENT_MAX_PER_USER = 30;

function hashContent(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

function trackMessage(message) {
  const uid = message.author?.id;
  if (!uid) return;
  const list = recentByUser.get(uid) || [];
  const now = Date.now();
  list.push({
    messageId: message.id,
    channelId: message.channel.id,
    ts: now,
    contentHash: hashContent(message.content || ''),
  });
  const pruned = list
    .filter(e => now - e.ts < RECENT_WINDOW_MS)
    .slice(-RECENT_MAX_PER_USER);
  recentByUser.set(uid, pruned);
}

function getRecentForUser(uid) {
  const now = Date.now();
  const list = (recentByUser.get(uid) || []).filter(e => now - e.ts < RECENT_WINDOW_MS);
  recentByUser.set(uid, list);
  return list;
}

// ─── SCORING ─────────────────────────────────────────────────────────────────
async function evaluate(message) {
  const reasons = [];
  let score = 0;
  const text = message.content || '';
  const lowerText = text.toLowerCase();
  const lists = loadDomainLists();

  const urls = extractUrls(text);
  if (urls.length === 0) {
    return { score: 0, reasons: [], action: 'none', urls: [] };
  }

  const hosts = urls.map(u => parseHost(u.raw)).filter(Boolean);
  if (hosts.length === 0) {
    return { score: 0, reasons: [], action: 'none', urls: [] };
  }

  // Resolve any Discord invite links against the API. A foreign-server invite
  // is flagged even though `discord.gg` is a trusted domain.
  let foreignInvite = false;
  for (const code of extractInviteCodes(text)) {
    const verdict = await classifyInvite(message.client, code, message.guild?.id);
    if (verdict === 'foreign') {
      foreignInvite = true;
      score += 60;
      reasons.push(`foreign-discord-invite:${code}`);
    }
  }

  // If every host is on the trust list AND no foreign invite was found,
  // short-circuit. A foreign invite forces full scoring even on discord.gg.
  if (!foreignInvite && hosts.every(h => matchesList(h, lists.trusted))) {
    return { score: 0, reasons: ['all-trusted'], action: 'none', urls: hosts };
  }

  for (const host of hosts) {
    if (matchesList(host, lists.blocked)) {
      score += 200;
      reasons.push(`blocked-domain:${host}`);
    }
    if (isDiscordLookalike(host)) {
      score += 100;
      reasons.push(`discord-lookalike:${host}`);
    }
    if (isIpHost(host)) {
      score += 50;
      reasons.push(`ip-url:${host}`);
    }
    const tld = host.split('.').pop();
    if (SUSPICIOUS_TLDS.has(tld)) {
      score += 25;
      reasons.push(`suspicious-tld:.${tld}`);
    }
    if (SHORTENERS.has(host)) {
      score += 30;
      reasons.push(`shortener:${host}`);
    }
  }

  // Markdown link mask: [discord.gg](https://dlscord.gg/...)
  for (const u of urls) {
    if (!u.markdown) continue;
    const realHost = parseHost(u.raw);
    const dispRaw = String(u.displayed || '').toLowerCase();
    if (!realHost || !dispRaw) continue;
    const dispHost = parseHost(dispRaw) || dispRaw;
    if (/[a-z]+\.[a-z]{2,}/i.test(dispRaw) && !realHost.includes(String(dispHost))) {
      score += 40;
      reasons.push(`link-mask:${dispHost}->${realHost}`);
    }
  }

  // Scam keyword present alongside any URL (one match is enough).
  for (const kw of SCAM_KEYWORDS) {
    if (lowerText.includes(kw)) {
      score += 40;
      reasons.push(`keyword:${kw}`);
      break;
    }
  }

  // Mass mention with link — classic compromised-account giveaway.
  if (message.mentions?.everyone || /@everyone|@here/.test(text)) {
    score += 40;
    reasons.push('mass-mention-with-link');
  }

  if (hosts.length >= 3) {
    score += 20;
    reasons.push(`many-urls:${hosts.length}`);
  }

  // Account age signals.
  const created = message.author?.createdTimestamp || 0;
  const accountAge = Date.now() - created;
  if (created && accountAge < 24 * 3600 * 1000) {
    score += 40; reasons.push('new-account-<1d');
  } else if (created && accountAge < 7 * 24 * 3600 * 1000) {
    score += 20; reasons.push('new-account-<7d');
  }

  // Member-in-guild age.
  const joinedAt = message.member?.joinedTimestamp;
  if (joinedAt && Date.now() - joinedAt < 24 * 3600 * 1000) {
    score += 30;
    reasons.push('new-member-<24h');
  }

  // Crossposting: same content hash seen in multiple channels recently.
  const recent = getRecentForUser(message.author?.id);
  const ch = hashContent(text);
  const sameHashRecent = recent.filter(r => r.contentHash === ch && Date.now() - r.ts < 60_000);
  const distinctChannels = new Set(sameHashRecent.map(r => r.channelId));
  distinctChannels.add(message.channel.id);
  if (distinctChannels.size >= 3) {
    score += 60;
    reasons.push(`crosspost:${distinctChannels.size}-channels`);
  } else if (distinctChannels.size === 2) {
    score += 30;
    reasons.push('crosspost:2-channels');
  }

  let action = 'none';
  if (score >= 120)     action = 'purge+timeout';
  else if (score >= 80) action = 'delete+timeout';
  else if (score >= 50) action = 'delete';
  else if (score >= 25) action = 'log';

  return { score, reasons, action, urls: hosts };
}

// ─── DOMAIN LIST MUTATION ────────────────────────────────────────────────────
function _norm(d) { return String(d || '').toLowerCase().trim().replace(/^https?:\/\//, '').split('/')[0]; }

function addBlockDomain(domain) {
  const d = _norm(domain);
  if (!d) return false;
  const lists = loadDomainLists();
  if (lists.blocked.includes(d)) return false;
  lists.blocked.push(d);
  saveDomainLists(lists);
  return true;
}
function removeBlockDomain(domain) {
  const d = _norm(domain);
  const lists = loadDomainLists();
  const before = lists.blocked.length;
  lists.blocked = lists.blocked.filter(x => x !== d);
  if (lists.blocked.length === before) return false;
  saveDomainLists(lists);
  return true;
}
function addTrustDomain(domain) {
  const d = _norm(domain);
  if (!d) return false;
  const lists = loadDomainLists();
  if (lists.trusted.includes(d)) return false;
  lists.trusted.push(d);
  saveDomainLists(lists);
  return true;
}
function removeTrustDomain(domain) {
  const d = _norm(domain);
  const lists = loadDomainLists();
  const before = lists.trusted.length;
  lists.trusted = lists.trusted.filter(x => x !== d);
  if (lists.trusted.length === before) return false;
  saveDomainLists(lists);
  return true;
}

// ─── ALLIED-GUILD ALLOWLIST ──────────────────────────────────────────────────
// Whitelist a partner clan's server (by guild ID) so invites to it pass.
// `$allowinvite` accepts an invite link/code; index.js resolves it to a
// guild ID via the API before calling this.
function addAlliedGuild(guildId) {
  const id = String(guildId || '').trim();
  if (!/^\d{15,20}$/.test(id)) return false;
  const lists = loadDomainLists();
  if (lists.alliedGuilds.includes(id)) return false;
  lists.alliedGuilds.push(id);
  saveDomainLists(lists);
  return true;
}
function removeAlliedGuild(guildId) {
  const id = String(guildId || '').trim();
  const lists = loadDomainLists();
  const before = lists.alliedGuilds.length;
  lists.alliedGuilds = lists.alliedGuilds.filter(x => x !== id);
  if (lists.alliedGuilds.length === before) return false;
  saveDomainLists(lists);
  return true;
}

module.exports = {
  evaluate,
  trackMessage,
  getRecentForUser,
  recordIncident,
  loadIncidents,
  loadDomainLists,
  addBlockDomain,
  removeBlockDomain,
  addTrustDomain,
  removeTrustDomain,
  extractInviteCodes,
  addAlliedGuild,
  removeAlliedGuild,
  RECENT_WINDOW_MS,
};
