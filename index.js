// ⚡ ZEUS BOT v3.0 — Clan Bot for Diablo Immortal | Zeus Clan
// Server: SEA Bloodraven | Timezone: Asia/Manila | Prefix: $
// NEW in v3: RSS-based Patch Tracker (always includes direct link) | Persistent patch cache
// ENHANCED: Rich announcement embeds with interactive buttons | Type-based styling
// v3.1: Slash commands with modal forms for announcements

const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType
} = require('discord.js');
const cron   = require('node-cron');
const moment = require('moment-timezone');
const axios  = require('axios');
const cheerio = require('cheerio');
const fs     = require('fs');
const path   = require('path');
const stats      = require('./stats');
const attendance = require('./attendance');

const TIMEZONE = 'Asia/Manila';
const PREFIX   = '$';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  announcementChannelName: 'clan-announcements',
  shadowWarChannelName:    'shadow-war-alerts',
  welcomeChannelName:      'welcome',
  modLogChannelName:       'mod-log',
};

// ─── ANNOUNCEMENT SYSTEM CONFIGURATION ─────────────────────────────────────────
// Roles that can use /announce command
const ALLOWED_ANNOUNCE_ROLES = ['Officer', 'Admin'];

// Persistent ack/react tallies, keyed by announcement message ID.
// Survives bot restarts so old announcements keep tallying.
const ANNOUNCE_ACKS_FILE = path.join(__dirname, '.announce_acks.json');
function loadAnnounceAcks() {
  try {
    if (fs.existsSync(ANNOUNCE_ACKS_FILE)) {
      return JSON.parse(fs.readFileSync(ANNOUNCE_ACKS_FILE, 'utf8'));
    }
  } catch (e) {
    console.log('[Announce] ack store load error:', e.message);
  }
  return {};
}
function saveAnnounceAcks(store) {
  try {
    fs.writeFileSync(ANNOUNCE_ACKS_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.log('[Announce] ack store save error:', e.message);
  }
}
function recordAnnounceAck(messageId, userId, kind) {
  const store = loadAnnounceAcks();
  const entry = store[messageId] || { acks: [], reacts: [] };
  const list  = kind === 'acknowledge' ? entry.acks : entry.reacts;
  const already = list.includes(userId);
  if (!already) list.push(userId);
  store[messageId] = entry;
  saveAnnounceAcks(store);
  return { entry, already };
}
const ENGAGEMENT_FIELD_NAME = '📊 **ENGAGEMENT**';
function buildEngagementValue(entry) {
  const acks   = entry.acks?.length   || 0;
  const reacts = entry.reacts?.length || 0;
  return `✅ ${acks} acknowledged · 👍 ${reacts} reacted`;
}

// Banner image URL (Imgur-hosted Zeus Clan welcome banner)
const BANNER_URL = 'https://i.imgur.com/STS2CwI.png';

// Announcement types with colors, icons, and auto-ping behavior
// Colors refined to complement the "Thunderous Clarity" design philosophy:
// - Primary accent: Cyan (#00C8FF) for updates and information
// - Alert accent: Crimson red for urgent matters
// - Gold (#FFC832) for events and special announcements
// - Silver/blue for informational content
const ANNOUNCEMENT_TYPES = {
  event:   { color: 0xFFC832, icon: '📅', ping: null },        // Gold - celebratory/special
  urgent:  { color: 0xFF2E3E, icon: '🚨', ping: '@everyone' }, // Crimson - high alert
  update:  { color: 0x00D9FF, icon: '🆕', ping: null },        // Cyan - fresh/new
  info:    { color: 0x5DADE2, icon: 'ℹ️', ping: null },        // Steel blue - informational
  warning: { color: 0xFFA500, icon: '⚠️', ping: '@here' },     // Orange - caution
};

// ─── ROLE IDs (hardcoded from your Discord server) ───────────────────────────
// These are faster and more reliable than searching by name.
// To find a Role ID: Server Settings → Roles → right-click role → Copy ID
const ROLE_IDS = {
  shadowWar:     '1492377915839742043', // @shadow war
  shadowWarCore: '1492380088103211159', // @shadow war core
  stronkpeople:  '',                    // ← paste your @stronkpeople Role ID here
};

// ─── PATCH TRACKER STATE ──────────────────────────────────────────────────────
// Persists to disk so the bot doesn't re-announce the same patch after a restart
const PATCH_CACHE_FILE = path.join(__dirname, '.patch_cache.json');

function loadPatchCache() {
  try {
    if (fs.existsSync(PATCH_CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(PATCH_CACHE_FILE, 'utf8'));
    }
  } catch {}
  return { lastHash: null, lastTitle: null };
}

function savePatchCache(hash, title) {
  try {
    fs.writeFileSync(PATCH_CACHE_FILE, JSON.stringify({ lastHash: hash, lastTitle: title }, null, 2));
  } catch (e) {
    console.log('[PatchTracker] Could not save cache:', e.message);
  }
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}

// Patterns that identify a post as a patch/update (not just general news)
const PATCH_PATTERNS = /patch\s*notes?|hotfix|bug\s*fix(es)?|balance\s*chang|content\s*update|game\s*update/i;

// ─── TRIVIA ───────────────────────────────────────────────────────────────────
const triviaQuestions = [
  { q: "What faction must you join to participate in Shadow War?", a: "shadows" },
  { q: "What day does Rite of Exile take place?", a: "sunday" },
  { q: "How many members minimum does a clan need to sign up for Shadow War?", a: "30" },
  { q: "What time does Shadow War start on Zeus server (PHT)?", a: "7:30 pm" },
  { q: "What item do you need to invite someone to the Shadows?", a: "akeba's signet" },
  { q: "What are the two types of battles in Shadow War?", a: "main and support" },
  { q: "What is the max team size in Shadow War?", a: "90" },
  { q: "Which NPC do you visit for the Shadows lottery in Westmarch?", a: "mysterious patron" },
  { q: "What legendary item can you earn by winning Shadow War?", a: "legendary crest" },
  { q: "What level do you need to join the Shadows faction?", a: "43" },
];
let activeTriviaQuestion = null;

// ─── CLIENT ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL', 'MESSAGE', 'REACTION'],
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getChannel(guild, name) {
  return guild.channels.cache.find(
    c => c.name.toLowerCase() === name.toLowerCase() && c.isTextBased()
  );
}

function zeusEmbed(title, description, color = 0xFFD700) {
  return new EmbedBuilder()
    .setTitle(`⚡ ${title}`)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
    .setTimestamp();
}

function getRole(guild, name) {
  return guild.roles.cache.find(r => r.name.toLowerCase() === name.toLowerCase());
}

// ─── ROLE MENTION HELPERS (uses hardcoded IDs for reliability) ───────────────

// Ping both @shadow war core + @shadow war
function getAllWarMention(guild) {
  const parts = [];
  if (ROLE_IDS.shadowWarCore) parts.push(`<@&${ROLE_IDS.shadowWarCore}>`);
  if (ROLE_IDS.shadowWar)     parts.push(`<@&${ROLE_IDS.shadowWar}>`);
  return parts.join(' ') || '@everyone';
}

// Ping @shadow war core only (exclusive early alert)
function getCoreMention(guild) {
  return ROLE_IDS.shadowWarCore ? `<@&${ROLE_IDS.shadowWarCore}>` : null;
}

// Ping @stronkpeople (used for patch announcements)
function getStronkMention(guild) {
  if (ROLE_IDS.stronkpeople) return `<@&${ROLE_IDS.stronkpeople}>`;
  // Fallback to name-based search if ID not set yet
  const role = getRole(guild, 'stronkpeople');
  return role ? `<@&${role.id}>` : '@everyone';
}

// ─── ANNOUNCEMENT HANDLER (shared by slash command modal) ─────────────────────
async function postAnnouncement(interaction, type, title, message, section1, section2, section3, targetChannel = null) {
  // ──────────────────────────────────────────────────────────────
  // 1. PERMISSION CHECK
  // ──────────────────────────────────────────────────────────────
  const hasRole = interaction.member.roles.cache.some(r =>
    ALLOWED_ANNOUNCE_ROLES.includes(r.name)
  );
  if (!hasRole) {
    return interaction.reply({
      content: '❌ Only **Officers** and **Admins** can use announcements.',
      ephemeral: true
    });
  }

  // ──────────────────────────────────────────────────────────────
  // 2. VALIDATE TYPE AND BUILD CONFIG
  // ──────────────────────────────────────────────────────────────
  if (!ANNOUNCEMENT_TYPES[type]) {
    return interaction.reply({
      content: `❌ Invalid type. Use: ${Object.keys(ANNOUNCEMENT_TYPES).join(', ')}`,
      ephemeral: true
    });
  }

  if (!title || !message) {
    return interaction.reply({
      content: '❌ Title and message cannot be empty.',
      ephemeral: true
    });
  }

  const { color, icon, ping } = ANNOUNCEMENT_TYPES[type];

  // ──────────────────────────────────────────────────────────────
  // 3. BUILD EMBED WITH OPTIONAL SECTIONS
  // ──────────────────────────────────────────────────────────────

  // Build a visually enhanced description with better formatting
  const formattedMessage = `>>> ${message}`;

  const embed = new EmbedBuilder()
    .setTitle(`${icon} **${title.toUpperCase()}**`)
    .setDescription(formattedMessage)
    .setColor(color)
    .setAuthor({
      name: `⚡ ${interaction.user.username}`,
      iconURL: interaction.user.displayAvatarURL({ dynamic: true })
    })
    .setImage(BANNER_URL)  // Add the Zeus banner at the top
    .setFooter({ text: 'Zeus Clan | ⚔️ SEA Bloodraven | Diablo Immortal' })
    .setTimestamp();

  // Add optional sections as visually enhanced fields
  if (section1 && section1.trim()) {
    embed.addFields({
      name: '━━━━━━━━━━━━━━━━━━━\n🔱 **SECTION 1**',
      value: `>>> ${section1.trim()}`,
      inline: false
    });
  }
  if (section2 && section2.trim()) {
    embed.addFields({
      name: '🔱 **SECTION 2**',
      value: `>>> ${section2.trim()}`,
      inline: false
    });
  }
  if (section3 && section3.trim()) {
    embed.addFields({
      name: '🔱 **SECTION 3**',
      value: `>>> ${section3.trim()}`,
      inline: false
    });
  }

  // ──────────────────────────────────────────────────────────────
  // 4. BUILD INTERACTIVE BUTTONS
  // ──────────────────────────────────────────────────────────────
  const buttons = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`announce_acknowledge_${interaction.user.id}`)
        .setLabel('✅ Acknowledged')
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`announce_react_${interaction.user.id}`)
        .setLabel('👍 React')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`announce_delete_${interaction.user.id}`)
        .setLabel('🗑️ Delete')
        .setStyle(ButtonStyle.Danger)
    );

  // ──────────────────────────────────────────────────────────────
  // 5. SEND TO ANNOUNCEMENT CHANNEL
  // ──────────────────────────────────────────────────────────────
  // Use the channel option if provided, otherwise fall back to #clan-announcements
  let announcementChannel = targetChannel;
  if (!announcementChannel) {
    announcementChannel = getChannel(interaction.guild, CONFIG.announcementChannelName);
  }
  if (!announcementChannel || !announcementChannel.isTextBased?.()) {
    return interaction.reply({
      content: '❌ Target channel not found or not a text channel.',
      ephemeral: true
    });
  }
  // Verify the bot can send in the chosen channel
  const me = interaction.guild.members.me;
  if (me && !announcementChannel.permissionsFor(me)?.has('SendMessages')) {
    return interaction.reply({
      content: `❌ I don't have permission to send messages in <#${announcementChannel.id}>.`,
      ephemeral: true
    });
  }

  try {
    const sentMessage = await announcementChannel.send({
      content: ping ? `${ping} 📣` : null,
      embeds: [embed],
      components: [buttons]
    });

    await interaction.reply({
      content: `✅ Announcement posted to <#${announcementChannel.id}>!`,
      ephemeral: true
    });

    // Button clicks are handled by the global InteractionCreate handler
    // (announce_* branch). No per-message collector — collectors die on bot
    // restart, leaving "This interaction failed" on old announcements.

  } catch (err) {
    console.error('[Announce] Error:', err);
    await interaction.reply({
      content: '❌ Failed to post announcement. Check bot permissions.',
      ephemeral: true
    });
  }
}

// ─── WELCOME BANNER ───────────────────────────────────────────────────────────
// Creates a rich embed card that acts as the welcome banner.
// BANNER_URL is defined once at the top of this file.

function buildWelcomeBanner(member) {
  const joined      = moment(member.joinedAt).tz(TIMEZONE).format('MMM DD, YYYY');
  const memberCount = member.guild.memberCount;

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setAuthor({
      name:    '⚡ ZEUS CLAN — SEA Bloodraven | Diablo Immortal',
      iconURL: member.guild.iconURL() || undefined,
    })
    .setTitle(`Welcome to Zeus Clan, ${member.user.username}! 🔱`)
    .setDescription(
      `> *"The lightning chooses its warriors. You have been chosen."*\n\n` +
      `👤 **${member.user.username}** has entered the realm of Zeus!\n` +
      `📅 **Joined:** ${joined}\n` +
      `👥 **Member #${memberCount}** of Zeus Clan\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `**⚡ Getting Started:**\n` +
      `• 📬 Check your **DMs** — Zeus Bot sent you a **role setup menu**!\n` +
      `• 📜 Read the rules before jumping in\n` +
      `• ⚔️ Shadow War: **Thu & Sat @ 7:30 PM PHT**\n` +
      `• 💬 Use \`$help\` for all bot commands\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `May your enemies fall before your lightning! ⚡`
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setFooter({ text: 'Zeus Clan | Diablo Immortal | SEA Bloodraven' })
    .setTimestamp();

  // Attach banner image if configured
  if (BANNER_URL) embed.setImage(BANNER_URL);

  return embed;
}

// ─── ROLE DM MENU ─────────────────────────────────────────────────────────────
async function sendRoleDM(member) {
  try {
    const dmEmbed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('⚡ Zeus Clan — Pick Your Roles!')
      .setDescription(
        `Hey **${member.user.username}**! 👋\n\n` +
        `Click the buttons below to assign yourself roles.\n` +
        `You can pick **multiple** — click again to **remove** a role.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔱 **Stronkpeople**\n` +
        `Default Zeus Clan member badge. Recommended for everyone!\n\n` +
        `⚔️ **Shadow War**\n` +
        `Get pinged 30 min before Shadow War every Thu & Sat.\n\n` +
        `🔥 **Shadow War Core**\n` +
        `For active fighters who **show up every war**.\n` +
        `You get an **exclusive early ping at 6:45 PM** (45 min before battle)\n` +
        `plus all regular war pings. Self-assign if you're committed!\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `💡 *You can also use \`$myroles\` in the server anytime to reopen this menu.*`
      )
      .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('role_stronkpeople')
        .setLabel('🔱 Stronkpeople')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('role_shadow_war')
        .setLabel('⚔️ Shadow War')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('role_shadow_war_core')
        .setLabel('🔥 Shadow War Core')
        .setStyle(ButtonStyle.Danger),
    );

    await member.send({ embeds: [dmEmbed], components: [row] });
    console.log(`✅ Role DM sent to ${member.user.username}`);
  } catch {
    console.log(`⚠️ Could not DM ${member.user.username} — DMs may be closed.`);
    const ch = getChannel(member.guild, CONFIG.welcomeChannelName);
    if (ch) {
      ch.send(
        `> ⚠️ **${member.user.username}** — I couldn't DM you! Enable **Allow direct messages from server members** in your Privacy Settings, then use \`$myroles\` here to get your role menu. 🔱`
      );
    }
  }
}

// ─── BUTTON & SLASH COMMAND HANDLER ────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  // ── Roster pagination buttons ─────────────────────────────────────────────
  if (await stats.handleRosterButton(interaction)) return;

  // ── Slash command dispatch ────────────────────────────────────────────────
  if (interaction.isChatInputCommand?.() || interaction.isCommand) {
    if (interaction.commandName === 'announce') {
      const type     = interaction.options.getString('type');
      const title    = interaction.options.getString('title');
      const message  = interaction.options.getString('message');
      const section1 = interaction.options.getString('section-1');
      const section2 = interaction.options.getString('section-2');
      const section3 = interaction.options.getString('section-3');
      const channel  = interaction.options.getChannel('channel');
      return postAnnouncement(interaction, type, title, message, section1, section2, section3, channel);
    }
    if (interaction.commandName === 'setup')        return handleSetupCommand(interaction);
    if (interaction.commandName === 'leaderboard')  return handleLeaderboardCommand(interaction);
    if (interaction.commandName === 'cycle-end')    return handleCycleEndCommand(interaction);
    if (interaction.commandName === 'cycle-start')  return handleCycleStartCommand(interaction);
    if (interaction.commandName === 'cycle-status') return handleCycleStatusCommand(interaction);
    if (interaction.commandName === 'activity')     return handleActivityCommand(interaction);
    if (interaction.commandName === 'officers')     return handleOfficersCommand(interaction);
  }

  // ── Modal submission (not used in announce anymore, but kept for future) ────
  if (interaction.isModalSubmit()) {
    return;
  }

  // ── Role assignment buttons ───────────────────────────────────────────────
  if (!interaction.isButton()) return;
  const { customId, user } = interaction;

  // ── Announcement buttons (acknowledge / react / delete) ───────────────────
  if (customId.startsWith('announce_')) {
    try {
      const [, action, authorId] = customId.split('_');
      const isAuthor = user.id === authorId;
      const isAdmin  = interaction.member?.roles?.cache?.some(r =>
        ALLOWED_ANNOUNCE_ROLES.includes(r.name)
      );

      if (action === 'acknowledge' || action === 'react') {
        const { entry, already } = recordAnnounceAck(interaction.message.id, user.id, action);

        // Update the engagement field on the original embed.
        try {
          const msg = interaction.message;
          const original = msg.embeds[0];
          if (original) {
            const updated = EmbedBuilder.from(original);
            const fields = original.fields || [];
            const idx = fields.findIndex(f => f.name === ENGAGEMENT_FIELD_NAME);
            const newField = { name: ENGAGEMENT_FIELD_NAME, value: buildEngagementValue(entry), inline: false };
            if (idx >= 0) {
              const next = [...fields];
              next[idx] = newField;
              updated.setFields(next);
            } else {
              updated.addFields(newField);
            }
            await msg.edit({ embeds: [updated, ...msg.embeds.slice(1)], components: msg.components });
          }
        } catch (e) {
          console.log('[Announce] could not update engagement field:', e.message);
        }

        const verb = action === 'acknowledge' ? 'acknowledged' : 'reacted to';
        const icon = action === 'acknowledge' ? '✅' : '👍';
        const note = already ? ' (already counted)' : '';
        return interaction.reply({
          content: `${icon} You ${verb} this announcement.${note}`,
          ephemeral: true,
        });
      }
      if (action === 'delete') {
        if (!isAuthor && !isAdmin) {
          return interaction.reply({
            content: '❌ Only the author or an admin can delete this announcement.',
            ephemeral: true,
          });
        }
        const deletedId = interaction.message.id;
        await interaction.message.delete();
        try {
          const store = loadAnnounceAcks();
          if (store[deletedId]) {
            delete store[deletedId];
            saveAnnounceAcks(store);
          }
        } catch {}
        return interaction.reply({
          content: '🗑️ Announcement deleted.',
          ephemeral: true,
        });
      }
    } catch (err) {
      console.error('[Announce buttons] Error:', err);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: '❌ Action failed.', ephemeral: true });
        } catch {}
      }
    }
    return;
  }

  if (!customId.startsWith('role_')) return;

  // Find member across guilds (needed since button is in DM)
  let member = null;
  for (const guild of client.guilds.cache.values()) {
    try { member = await guild.members.fetch(user.id); if (member) break; } catch {}
  }
  if (!member) {
    return interaction.reply({ content: '❌ Could not find your server membership. Use `$myroles` in the server.', ephemeral: true });
  }

  const roleMap = {
    role_stronkpeople:      { name: 'stronkpeople',      id: ROLE_IDS.stronkpeople   || null },
    role_shadow_war:        { name: 'shadow war',         id: ROLE_IDS.shadowWar      || null },
    role_shadow_war_core:   { name: 'shadow war core',    id: ROLE_IDS.shadowWarCore  || null },
  };
  const emojiMap = {
    role_stronkpeople:     '🔱',
    role_shadow_war:       '⚔️',
    role_shadow_war_core:  '🔥',
  };

  const roleInfo  = roleMap[customId];
  const roleEmoji = emojiMap[customId];

  // Use ID if available, fallback to name search
  let role = null;
  if (roleInfo.id) {
    role = member.guild.roles.cache.get(roleInfo.id);
  }
  if (!role) {
    role = getRole(member.guild, roleInfo.name);
  }

  if (!role) {
    return interaction.reply({
      content: `❌ The role **${roleInfo.name}** doesn't exist on the server yet! Ask an admin to create it first.`,
      ephemeral: true,
    });
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await interaction.reply({ content: `✅ Removed **${roleEmoji} ${role.name}** from your roles.`, ephemeral: true });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: `✅ You now have **${roleEmoji} ${role.name}**! ⚡`, ephemeral: true });
    }
  } catch {
    await interaction.reply({
      content: `❌ Couldn't assign the role — make sure Zeus Bot's role is **above** \`${role.name}\` in Server Settings → Roles.`,
      ephemeral: true,
    });
  }
});

// ─── WELCOME NEW MEMBERS ──────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  // 1. Post welcome banner
  const welcomeCh = getChannel(member.guild, CONFIG.welcomeChannelName);
  if (welcomeCh) await welcomeCh.send({ embeds: [buildWelcomeBanner(member)] });

  // 2. Auto-assign @stronkpeople immediately
  try {
    const defaultRole = getRole(member.guild, 'stronkpeople');
    if (defaultRole) {
      await member.roles.add(defaultRole);
      console.log(`✅ Auto-assigned @stronkpeople to ${member.user.username}`);
    }
  } catch (e) {
    console.log(`⚠️ Could not auto-assign @stronkpeople to ${member.user.username}:`, e.message);
  }

  // 3. Send DM role menu (3s delay so Discord can settle)
  setTimeout(() => sendRoleDM(member), 3000);
});

// ─── PATCH TRACKER ────────────────────────────────────────────────────────────
// Uses the official Blizzard RSS feed — reliable, always has the direct link,
// no JavaScript rendering issues. Cheerio parses the XML just like HTML.

const DI_RSS_URL = 'https://news.blizzard.com/en-us/feed/diablo-immortal';

async function checkForNewPatch(guild) {
  try {
    // ── 1. Fetch the RSS feed ──────────────────────────────────────────────
    const { data } = await axios.get(DI_RSS_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZeusBot/3.0)',
        'Accept':     'application/rss+xml, application/xml, text/xml',
      },
    });

    // ── 2. Parse RSS XML with cheerio ─────────────────────────────────────
    const $ = cheerio.load(data, { xmlMode: true });
    const items = $('item');

    if (!items.length) {
      console.log('[PatchTracker] RSS feed returned no items.');
      return;
    }

    // ── 3. Find the first item that looks like a patch/update ─────────────
    let patchItem = null;
    items.each((i, el) => {
      const title = $(el).find('title').first().text().trim();
      if (!patchItem && PATCH_PATTERNS.test(title)) {
        patchItem = {
          title:     title,
          link:      $(el).find('link').first().text().trim() || $(el).find('guid').first().text().trim(),
          pubDate:   $(el).find('pubDate').first().text().trim(),
          summary:   $(el).find('description').first().text().replace(/<[^>]+>/g, '').trim().slice(0, 200),
        };
      }
    });

    // If no patch-specific post, fall back to the most recent item
    if (!patchItem) {
      const first = items.first();
      patchItem = {
        title:   $(first).find('title').first().text().trim(),
        link:    $(first).find('link').first().text().trim() || $(first).find('guid').first().text().trim(),
        pubDate: $(first).find('pubDate').first().text().trim(),
        summary: $(first).find('description').first().text().replace(/<[^>]+>/g, '').trim().slice(0, 200),
        isFallback: true,
      };
    }

    if (!patchItem.title) return;

    // ── 4. Dedup — skip if we've already announced this one ───────────────
    const cache     = loadPatchCache();
    const entryHash = hashString(patchItem.title + patchItem.link);
    if (cache.lastHash === entryHash) return; // already announced

    savePatchCache(entryHash, patchItem.title);
    console.log(`[PatchTracker] New DI post detected: ${patchItem.title}`);

    // ── 5. Build and send the Discord embed ───────────────────────────────
    const channel    = getChannel(guild, CONFIG.announcementChannelName);
    if (!channel) return;

    const isPatch    = PATCH_PATTERNS.test(patchItem.title);
    const stronkRole = getStronkMention(guild);

    // Format the pub date if available
    let dateStr = '';
    if (patchItem.pubDate) {
      try {
        dateStr = `\n📅 **Posted:** ${moment(patchItem.pubDate).tz(TIMEZONE).format('MMM DD, YYYY h:mm A')} PHT`;
      } catch {}
    }

    const embed = new EmbedBuilder()
      .setColor(isPatch ? 0xFF4500 : 0x00BFFF)
      .setTitle(isPatch ? '🔧 New Patch / Update!' : '📰 New DI News!')
      .setURL(patchItem.link)   // makes the embed title itself a clickable link
      .setDescription(
        `**${patchItem.title}**\n\n` +
        `${isPatch
          ? '🔧 A new **Diablo Immortal** update has dropped!\nMake sure to update your game before the next Shadow War.'
          : '📣 New announcement from the Diablo Immortal team!'
        }\n\n` +
        `${patchItem.summary ? `> ${patchItem.summary}...\n\n` : ''}` +
        `🔗 **[Read Full Patch Notes ↗](${patchItem.link})**` +
        `${dateStr}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *Always update before **Thu & Sat @ 7:30 PM PHT** Shadow War!*`
      )
      .setFooter({ text: 'Zeus Clan Patch Tracker | Source: Blizzard RSS Feed' })
      .setTimestamp();

    await channel.send({ content: stronkRole, embeds: [embed] });

  } catch (err) {
    console.log('[PatchTracker] Check error (will retry next cycle):', err.message);
  }
}

// ─── ATTENDANCE: SLASH COMMAND HANDLERS ──────────────────────────────────────
const ATTENDANCE_ADMIN_ROLES = ['Officer', 'Admin'];

function isAttendanceAdmin(interaction) {
  return interaction.member?.roles?.cache?.some(r =>
    ATTENDANCE_ADMIN_ROLES.includes(r.name)
  );
}

async function handleSetupCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({
      content: '❌ Only **Officers** and **Admins** can run `/setup`.',
      ephemeral: true,
    });
  }
  const cfg = attendance.loadConfig();
  const opts = interaction.options;

  const warVoiceCat = opts.getChannel('war-voice-category');
  const checkInCh   = opts.getChannel('checkin-channel');
  const lbCh        = opts.getChannel('leaderboard-channel');
  const mvpRole     = opts.getRole('mvp-role');
  const stormRole   = opts.getRole('storm-bearer-role');
  const lightRole   = opts.getRole('lightning-striker-role');
  const veteranRole = opts.getRole('veteran-role');
  const officerRole = opts.getRole('officer-role');

  if (warVoiceCat) cfg.warVoiceCategoryId   = warVoiceCat.id;
  if (checkInCh)   cfg.checkInChannelId     = checkInCh.id;
  if (lbCh)        cfg.leaderboardChannelId = lbCh.id;
  if (mvpRole)     cfg.awardRoles.mvp              = mvpRole.id;
  if (stormRole)   cfg.awardRoles.stormBearer      = stormRole.id;
  if (lightRole)   cfg.awardRoles.lightningStriker = lightRole.id;
  if (veteranRole) cfg.awardRoles.veteran          = veteranRole.id;
  if (officerRole) {
    if (!cfg.officerRoleIds.includes(officerRole.id)) {
      cfg.officerRoleIds.push(officerRole.id);
    }
  }
  attendance.saveConfig(cfg);

  const fmt = id => id ? `<#${id}>` : '`(unset)`';
  const fmtRole = id => id ? `<@&${id}>` : '`(unset)`';
  const officerList = cfg.officerRoleIds.length
    ? cfg.officerRoleIds.map(id => `<@&${id}>`).join(', ')
    : '`(none)`';

  const embed = zeusEmbed(
    'Attendance Setup',
    `**Channels**\n` +
    `• War voice category: ${fmt(cfg.warVoiceCategoryId)}\n` +
    `• Check-in: ${fmt(cfg.checkInChannelId)}\n` +
    `• Leaderboard: ${fmt(cfg.leaderboardChannelId)}\n\n` +
    `**Award roles**\n` +
    `🥇 MVP: ${fmtRole(cfg.awardRoles.mvp)}\n` +
    `🥈 Storm Bearer: ${fmtRole(cfg.awardRoles.stormBearer)}\n` +
    `🥉 Lightning Striker: ${fmtRole(cfg.awardRoles.lightningStriker)}\n` +
    `🏛️ Veteran of Zeus: ${fmtRole(cfg.awardRoles.veteran)}\n\n` +
    `**Officer roles (excluded from member awards)**\n${officerList}\n\n` +
    `Run \`/setup\` again to update any field.`
  );
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCycleStartCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', ephemeral: true });
  }
  const existing = attendance.getCurrentCycle();
  if (existing) {
    return interaction.reply({
      content: `⚠️ A cycle is already active (\`${existing.cycleId}\`). Run \`/cycle-end\` first.`,
      ephemeral: true,
    });
  }
  const faction   = interaction.options.getString('faction');
  const startDate = interaction.options.getString('start-date');
  let state;
  try {
    state = attendance.startCycle(faction, startDate || null);
  } catch (e) {
    return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
  }
  const start = moment(state.startDate).tz(attendance.TIMEZONE).format('MMM DD, YYYY');
  return interaction.reply({
    embeds: [zeusEmbed(
      'Cycle Started ⚡',
      `**Faction:** ${faction.toUpperCase()}\n` +
      `**Start date:** ${start}\n` +
      `**Duration:** 7 weeks\n\n` +
      (faction === 'shadows'
        ? '**Tracked events:** Shadow War (Thu/Sat, all 7 weeks) + VoB (Sun, weeks 1–3)'
        : '**Tracked events:** VoB (Sun, weeks 1–3 only)') +
      `\n\nGood luck, Zeus Clan! ⚔️`
    )],
  });
}

async function handleCycleStatusCommand(interaction) {
  const state = attendance.getCurrentCycle();
  if (!state) {
    return interaction.reply({
      content: '⚠️ No active cycle. An officer can start one with `/cycle-start`.',
      ephemeral: true,
    });
  }
  const week = attendance.getCycleWeek(state, new Date()) || '—';
  const max  = attendance.computeMaxEvents(state);
  const my   = state.attendance[interaction.user.id];
  const myCount = my ? my.count : 0;
  const myPct   = max ? ((myCount / max) * 100).toFixed(0) : '0';

  return interaction.reply({
    embeds: [zeusEmbed(
      `Cycle Status — Week ${week} of ${state.durationWeeks}`,
      `**Faction:** ${state.faction.toUpperCase()}\n` +
      `**Started:** ${moment(state.startDate).tz(attendance.TIMEZONE).format('MMM DD, YYYY')}\n` +
      `**Total events possible:** ${max}\n\n` +
      `**Your attendance:** ${myCount}/${max} (${myPct}%)`
    )],
    ephemeral: true,
  });
}

async function handleLeaderboardCommand(interaction) {
  const state = attendance.getCurrentCycle();
  if (!state) {
    return interaction.reply({ content: '⚠️ No active cycle.', ephemeral: true });
  }
  const cfg = attendance.loadConfig();
  const lb  = attendance.buildLeaderboard(state, cfg.officerRoleIds, interaction.guild);

  if (lb.entries.length === 0) {
    return interaction.reply({
      content: '📊 No attendance recorded yet for this cycle.',
      ephemeral: true,
    });
  }

  const lines = lb.entries.slice(0, 25).map((e, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`${String(i + 1).padStart(2)}\``;
    const off = e.isOfficer ? ' *(officer)*' : '';
    const pct = e.percentage.toFixed(0);
    return `${medal} **${e.username}** — ${e.count}/${lb.max} (${pct}%)${off}`;
  });

  return interaction.reply({
    embeds: [zeusEmbed(
      `Attendance Leaderboard — Week ${attendance.getCycleWeek(state, new Date()) || '—'}`,
      lines.join('\n') + `\n\n*Officers are tracked but excluded from member awards.*`
    )],
  });
}

async function handleCycleEndCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', ephemeral: true });
  }
  const state = attendance.getCurrentCycle();
  if (!state) {
    return interaction.reply({ content: '⚠️ No active cycle to end.', ephemeral: true });
  }

  await interaction.deferReply();
  const result = await attendance.endCycle(interaction.guild);
  if (result.error) {
    return interaction.editReply({ content: `❌ ${result.error}` });
  }

  const { winners, leaderboard, faction } = result;
  const fmtWinner = (w) => w
    ? `**${w.username}** — ${w.count}/${leaderboard.max} (${w.percentage.toFixed(0)}%)${w.becameVeteran ? ' 🏛️ *Veteran of Zeus*' : ''}`
    : '*(no eligible member)*';

  const summary =
    `**Faction:** ${faction.toUpperCase()}\n` +
    `**Total events:** ${leaderboard.max}\n` +
    `**Members tracked:** ${leaderboard.entries.length}\n\n` +
    `🥇 **Cycle MVP** — ${fmtWinner(winners.mvp)}\n` +
    `🥈 **Storm Bearer** — ${fmtWinner(winners.stormBearer)}\n` +
    `🥉 **Lightning Striker** — ${fmtWinner(winners.lightningStriker)}\n\n` +
    `Cycle archived. Start the next one with \`/cycle-start\`. ⚡`;

  const cfg = attendance.loadConfig();
  if (cfg.leaderboardChannelId) {
    try {
      const ch = await client.channels.fetch(cfg.leaderboardChannelId);
      if (ch?.isTextBased?.()) {
        await ch.send({ embeds: [zeusEmbed('🏆 Cycle Complete', summary)] });
      }
    } catch {}
  }
  return interaction.editReply({ embeds: [zeusEmbed('Cycle Closed ⚡', summary)] });
}

// ─── ATTENDANCE: VOICE & REACTION LISTENERS ──────────────────────────────────
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  attendance.handleVoiceStateUpdate(oldState, newState);
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  attendance.handleCheckInReaction(reaction, user);
});

// ─── CHAT ACTIVITY (silent, officer-only signal) ─────────────────────────────
client.on(Events.MessageCreate, msg => {
  if (msg.author?.bot) return;
  if (!msg.guild) return;
  // Skip slash command interactions; those don't fire MessageCreate anyway,
  // but $-prefix commands do. Track them as activity — using the bot is
  // engagement.
  attendance.recordChatMessage(msg.author.id, msg.channel.id);
});

async function handleActivityCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', ephemeral: true });
  }
  const cfg = attendance.loadConfig();
  const report = attendance.getActivityReport(interaction.guild, cfg.officerRoleIds);
  if (!report || report.length === 0) {
    return interaction.reply({
      content: '📊 No chat activity recorded this cycle. (Cycle may not be active.)',
      ephemeral: true,
    });
  }
  const lines = report.slice(0, 30).map((e, i) => {
    const off  = e.isOfficer ? ' *(officer)*' : '';
    const last = e.lastMessage
      ? moment(e.lastMessage).tz(attendance.TIMEZONE).fromNow()
      : '—';
    return `\`${String(i + 1).padStart(2)}\` **${e.username}** — ${e.count} msgs (last: ${last})${off}`;
  });
  const total = report.reduce((s, e) => s + e.count, 0);
  return interaction.reply({
    embeds: [zeusEmbed(
      'Chat Activity — Officer View',
      `Showing **${Math.min(30, report.length)}** of **${report.length}** active members ` +
      `(${total} total messages this cycle).\n\n` +
      lines.join('\n') +
      `\n\n*This view is officer-only and never shown publicly. Used as a soft engagement signal alongside attendance.*`
    )],
    ephemeral: true,
  });
}

// ─── /officers — post officer roles as styled embeds ───────────────────────
async function handleOfficersCommand(interaction) {
  const header = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('⚡ Zeus Clan — Officer Roles')
    .setDescription('Officer responsibilities, reporting lines, and key workflows.');

  const tier1 = new EmbedBuilder()
    .setColor(0xE67E22)
    .setTitle('🔱 Tier 1 — Senior Officers')
    .addFields(
      { name: 'Menelaus — Clan Relations + Bot Ops', value: '• Alliance contact + internal affairs\n• Drafts Shadow War / VoB lineup\n• Day-to-day bot operations' },
      { name: 'Pandapple — War Captain + External Comms', value: '• War lineup execution in-game\n• Daily alliance / bzap server contact' },
      { name: 'Paunginoon — War Captain + Attendance', value: '• War lineup execution in-game\n• War attendance + roster' },
      { name: 'ATL — External Comms (Backup)', value: '• Backup alliance liaison\n• Non-alliance external servers' },
    );

  const tier2 = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('⚔️ Tier 2 — Kion Officers')
    .addFields(
      { name: 'Monday — Tower War Lead', value: '• Signups, reminders, roster' },
      { name: 'NowhereMan — Internal Health', value: '• Morale, engagement, feedback\n• Runs internal clan-only activities' },
      { name: 'Ynaguinid — External Events + Immortal', value: '• Schedules events with other clans (after war calendar)\n• Immortal activities contact' },
    );

  const tier3 = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎉 Tier 3 — Community & Recruitment')
    .addFields(
      { name: 'Manawari — Discord Ops + Bot Monitoring', value: '• Discord moderation + activity\n• Event facilitation\n• Bot suggestions/bugs → Clan Leader' },
      { name: 'xIcy — Recruitment + In-Game Reminders', value: '• Recruitment + social media\n• Shadow War in-game reminders (lineup from Leader)' },
      { name: 'Nalimotko — Event Prizes', value: '• Prize pool + winner records' },
      { name: 'AkosiMK — Stats + Roster Backup', value: '• Manual stat updates (backup for `$updatemystats`)\n• Roster co-maintenance with Pau\n• Periodic stat audits / drift checks' },
    );

  const flows = new EmbedBuilder()
    .setColor(0x99AAB5)
    .setTitle('🔄 Workflows & Monitoring')
    .addFields(
      { name: 'Shadow War', value: 'Menelaus drafts → 👑 Leader approves → xIcy reminds in-game → Pandapple/Pau execute → Pau logs attendance' },
      { name: 'External Events', value: 'Ynaguinid schedules → Manawari runs → Nalimotko prizes' },
      { name: 'Internal Events', value: 'NowhereMan runs → Manawari facilitates → Nalimotko (if prizes)' },
      { name: 'Who Watches What', value: '• War attendance → **Pau**\n• Morale/engagement → **NowhereMan**\n• Discord activity → **Manawari**\n• In-game behavior → 👑 **Leader**\n• Stats / roster → **AkosiMK** (with Pau)' },
    )
    .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
    .setTimestamp();

  return interaction.reply({ embeds: [header, tier1, tier2, tier3, flows] });
}

// ─── ATTENDANCE: EVENT-START CRON ────────────────────────────────────────────
function scheduleAttendanceCheckIns() {
  // Shadow War: Thu & Sat at 19:30 PHT
  cron.schedule('30 19 * * 4,6', () => {
    const state = attendance.getCurrentCycle();
    if (!state || state.faction !== 'shadows') return;
    attendance.postCheckInMessage(client, 'shadow_war').catch(e =>
      console.log('[Attendance] check-in post error:', e.message)
    );
  }, { timezone: TIMEZONE });

  // VoB: Sunday at 20:00 PHT (only weeks 1-3 — postCheckInMessage validates)
  cron.schedule('0 20 * * 0', () => {
    const state = attendance.getCurrentCycle();
    if (!state) return;
    attendance.postCheckInMessage(client, 'vob').catch(e =>
      console.log('[Attendance] check-in post error:', e.message)
    );
  }, { timezone: TIMEZONE });

  console.log('✅ Attendance check-in cron scheduled (Thu/Sat 19:30 + Sun 20:00 PHT)');
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`\n⚡ Zeus Bot v3.0 online! Logged in as ${client.user.tag}`);
  console.log(`📅 Timezone: Asia/Manila (PHT)`);
  console.log(`🆕 v3.1 Features: Slash command /announce with modal form | RSS Patch Tracker | DM Role Menu`);
  console.log(`✨ ENHANCED: Rich Announcement Embeds with Interactive Buttons\n`);
  client.user.setActivity('⚔️ Shadow War | /announce', { type: 0 });
  scheduleReminders();
  // Patch Tracker disabled — Blizzard RSS feed produces stale/delayed
  // posts. Re-enable by uncommenting the line below.
  // schedulePatchTracker();
  scheduleAttendanceCheckIns();
  registerSlashCommands();
});

// ─── REGISTER SLASH COMMANDS ──────────────────────────────────────────────────
async function registerSlashCommands() {
  try {
    const commands = [
      new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Post a rich clan announcement with interactive buttons')
        .addStringOption(option =>
          option
            .setName('type')
            .setDescription('Announcement type (determines color and icon)')
            .setRequired(true)
            .addChoices(
              { name: '📅 Event', value: 'event' },
              { name: '🚨 Urgent', value: 'urgent' },
              { name: '🆕 Update', value: 'update' },
              { name: 'ℹ️ Info', value: 'info' },
              { name: '⚠️ Warning', value: 'warning' }
            )
        )
        .addStringOption(option =>
          option
            .setName('title')
            .setDescription('Announcement title')
            .setRequired(true)
            .setMaxLength(100)
        )
        .addStringOption(option =>
          option
            .setName('message')
            .setDescription('Main announcement content (paragraphs supported)')
            .setRequired(true)
            .setMaxLength(4000)
        )
        .addStringOption(option =>
          option
            .setName('section-1')
            .setDescription('Optional section 1 (e.g., Schedule, Requirements)')
            .setRequired(false)
            .setMaxLength(1024)
        )
        .addStringOption(option =>
          option
            .setName('section-2')
            .setDescription('Optional section 2')
            .setRequired(false)
            .setMaxLength(1024)
        )
        .addStringOption(option =>
          option
            .setName('section-3')
            .setDescription('Optional section 3')
            .setRequired(false)
            .setMaxLength(1024)
        )
        .addChannelOption(option =>
          option
            .setName('channel')
            .setDescription('Target channel (default: #clan-announcements)')
            .setRequired(false)
        ),

      // ── /setup — configure attendance tracker (Officer/Admin only) ────────
      new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure attendance tracker channels and award roles')
        .addChannelOption(o =>
          o.setName('war-voice-category')
           .setDescription('Voice category — any voice channel inside is monitored during wars')
           .addChannelTypes(ChannelType.GuildCategory)
           .setRequired(false)
        )
        .addChannelOption(o =>
          o.setName('checkin-channel').setDescription('Where check-in messages are posted').setRequired(false)
        )
        .addChannelOption(o =>
          o.setName('leaderboard-channel').setDescription('Where /cycle-end posts results').setRequired(false)
        )
        .addRoleOption(o =>
          o.setName('mvp-role').setDescription('Role granted to Cycle MVP (1st)').setRequired(false)
        )
        .addRoleOption(o =>
          o.setName('storm-bearer-role').setDescription('Role granted to Storm Bearer (2nd)').setRequired(false)
        )
        .addRoleOption(o =>
          o.setName('lightning-striker-role').setDescription('Role granted to Lightning Striker (3rd)').setRequired(false)
        )
        .addRoleOption(o =>
          o.setName('veteran-role').setDescription('Permanent role for 3 consecutive top-3 cycles').setRequired(false)
        )
        .addRoleOption(o =>
          o.setName('officer-role').setDescription('Officer role excluded from member awards').setRequired(false)
        ),

      // ── /cycle-start — begin a new 7-week cycle ──────────────────────────
      new SlashCommandBuilder()
        .setName('cycle-start')
        .setDescription('Start a new 7-week attendance cycle')
        .addStringOption(o =>
          o.setName('faction').setDescription('Zeus faction this cycle').setRequired(true)
            .addChoices(
              { name: '🌑 Shadows',    value: 'shadows' },
              { name: '👑 Immortals',  value: 'immortals' }
            )
        )
        .addStringOption(o =>
          o.setName('start-date').setDescription('YYYY-MM-DD (defaults to today)').setRequired(false)
        ),

      // ── /cycle-status — view current cycle state ─────────────────────────
      new SlashCommandBuilder()
        .setName('cycle-status')
        .setDescription('Show the current cycle progress and your attendance'),

      // ── /leaderboard — show standings ────────────────────────────────────
      new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the current attendance leaderboard'),

      // ── /cycle-end — close cycle, assign awards (Officer/Admin only) ─────
      new SlashCommandBuilder()
        .setName('cycle-end')
        .setDescription('Close the current cycle, assign awards, archive results'),

      // ── /activity — officer-only chat activity report ────────────────────
      new SlashCommandBuilder()
        .setName('activity')
        .setDescription('Officer-only chat activity report for the current cycle'),

      // ── /officers — post officer roles + responsibilities embed ──────────
      new SlashCommandBuilder()
        .setName('officers')
        .setDescription('Post the Zeus Clan officer roles and responsibilities'),
    ];

    const guildId = process.env.DISCORD_GUILD_ID || '1015207597575507998';
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      await guild.commands.set(commands);
      // Purge any leftover global commands so Discord doesn't show duplicates
      // (e.g. /setup and /activity appearing twice from a prior global push).
      try {
        await client.application.commands.set([]);
      } catch (e) {
        console.log('[Slash Commands] Could not clear global commands:', e.message);
      }
      console.log(`✅ Slash commands registered to guild ${guild.name} (instant): /announce, /setup, /cycle-start, /cycle-status, /leaderboard, /cycle-end, /activity, /officers`);
    } else {
      await client.application.commands.set(commands);
      console.log('✅ Slash commands registered globally (may take up to 1h): /announce, /setup, /cycle-start, /cycle-status, /leaderboard, /cycle-end, /activity, /officers');
    }
  } catch (err) {
    console.error('[Slash Commands] Error registering:', err);
  }
}

// ─── PATCH TRACKER SCHEDULE ───────────────────────────────────────────────────
function schedulePatchTracker() {
  // Check every 3 hours
  cron.schedule('0 */3 * * *', () => {
    client.guilds.cache.forEach(guild => checkForNewPatch(guild));
  }, { timezone: TIMEZONE });

  // Initial check 15 seconds after boot
  setTimeout(() => {
    client.guilds.cache.forEach(guild => checkForNewPatch(guild));
  }, 15000);

  console.log('✅ Patch Tracker: active — checking every 3 hours');
}

// ─── SCHEDULED REMINDERS ─────────────────────────────────────────────────────
function scheduleReminders() {
  const guilds = () => client.guilds.cache;

  // Monday 9 AM — sign-ups open (all war roles)
  cron.schedule('0 9 * * 1', () => {
    guilds().forEach(guild => {
      const ch = getChannel(guild, CONFIG.shadowWarChannelName);
      if (!ch) return;
      ch.send({ embeds: [zeusEmbed(
        'Shadow War Sign-Ups Are OPEN!',
        `${getAllWarMention(guild)}\n\n` +
        `📋 **Sign-up window is now open!**\n\n` +
        `• Head to the **Shadows Hideout** in-game\n` +
        `• Register before **Tuesday 9:00 PM** server time\n\n` +
        `⚔️ Battles: **Thursday & Saturday @ 7:30 PM PHT**\n` +
        `🏆 Top 10 clans advance to Rite of Exile!\n\n` +
        `⚡ For Zeus!`
      )]});
    });
  }, { timezone: TIMEZONE });

  // ── THURSDAY ──
  // 6:45 PM — Core early alert (45 min before)
  cron.schedule('45 18 * * 4', () => {
    guilds().forEach(guild => sendCoreEarlyAlert(guild, 'Thursday'));
  }, { timezone: TIMEZONE });
  // 7:00 PM — All war roles (30 min before)
  cron.schedule('0 19 * * 4', () => {
    guilds().forEach(guild => sendWarWarning(guild, 'Thursday'));
  }, { timezone: TIMEZONE });
  // 7:25 PM — All war roles (5 min final call)
  cron.schedule('25 19 * * 4', () => {
    guilds().forEach(guild => sendFinalCall(guild));
  }, { timezone: TIMEZONE });

  // ── SATURDAY ──
  // 6:45 PM — Core early alert
  cron.schedule('45 18 * * 6', () => {
    guilds().forEach(guild => sendCoreEarlyAlert(guild, 'Saturday'));
  }, { timezone: TIMEZONE });
  // 7:00 PM — All war roles
  cron.schedule('0 19 * * 6', () => {
    guilds().forEach(guild => sendWarWarning(guild, 'Saturday'));
  }, { timezone: TIMEZONE });
  // 7:25 PM — Final call
  cron.schedule('25 19 * * 6', () => {
    guilds().forEach(guild => sendFinalCall(guild));
  }, { timezone: TIMEZONE });

  // Sunday 7:30 PM — Rite of Exile warning
  cron.schedule('30 19 * * 0', () => {
    guilds().forEach(guild => {
      const ch = getChannel(guild, CONFIG.shadowWarChannelName);
      if (!ch) return;
      ch.send({ embeds: [zeusEmbed(
        '👑 RITE OF EXILE — 30 Minutes!',
        `${getAllWarMention(guild)}\n\n🔥 **Rite of Exile in 30 minutes!**\n⏰ Starts at **8:00 PM PHT**\n\nLog in NOW. Zeus does not lose! ⚡`,
        0xFF4500
      )]});
    });
  }, { timezone: TIMEZONE });

  // Friday 10 AM — Weekly update
  cron.schedule('0 10 * * 5', () => {
    guilds().forEach(guild => {
      const ch = getChannel(guild, CONFIG.announcementChannelName);
      if (!ch) return;
      ch.send({ embeds: [zeusEmbed(
        `Weekly Clan Update — ${moment().tz(TIMEZONE).format('MMM DD, YYYY')}`,
        `⚡ **Zeus Clan Weekly Reminder**\n\n` +
        `📅 **Schedule (PHT):**\n` +
        `• Mon 9 AM — Sign-ups open\n` +
        `• Tue 9 PM — Sign-ups close\n` +
        `• 🔥 Thu & Sat 6:45 PM — Core early alert\n` +
        `• ⚔️ Thu & Sat 7:00 PM — 30-min warning\n` +
        `• 🚨 Thu & Sat 7:25 PM — Final call\n` +
        `• ⚔️ Thu & Sat 7:30 PM — **SHADOW WAR**\n` +
        `• 👑 Sun 8:00 PM — Rite of Exile (if qualified)\n\n` +
        `Use \`$myroles\` to set your ping tier. For Zeus! ⚡`, 0x9B59B6
      )]});
    });
  }, { timezone: TIMEZONE });

  console.log('✅ All reminders scheduled (tiered: Core 6:45 PM | All 7:00 PM | Final 7:25 PM)');
}

// ─── TIERED PING FUNCTIONS ────────────────────────────────────────────────────

// 🔥 CORE ONLY — 45 min heads-up
function sendCoreEarlyAlert(guild, day) {
  const ch          = getChannel(guild, CONFIG.shadowWarChannelName);
  const coreMention = getCoreMention(guild);
  if (!ch || !coreMention) return; // silently skip if no core role set up
  ch.send({ embeds: [new EmbedBuilder()
    .setColor(0xFF4500)
    .setTitle('🔥 CORE ALERT — Shadow War in 45 Minutes!')
    .setDescription(
      `${coreMention}\n\n` +
      `⚡ **Shadow War Core** — exclusive early alert!\n\n` +
      `📅 **${day}** — Battle at **7:30 PM PHT**\n` +
      `⏱️ You have **45 minutes** to prepare.\n\n` +
      `• Log in early\n` +
      `• Coordinate positions with your team\n` +
      `• Brief lower-level members on their support role\n\n` +
      `*This ping is for 🔥 Core members only. Use \`$myroles\` to adjust.*`
    )
    .setFooter({ text: 'Zeus Clan | Core Early Alert | SEA Bloodraven' })
    .setTimestamp()
  ]});
}

// ⚔️ ALL WAR ROLES — 30 min warning
function sendWarWarning(guild, day) {
  const ch = getChannel(guild, CONFIG.shadowWarChannelName);
  if (!ch) return;
  ch.send({ embeds: [zeusEmbed(
    `⚔️ Shadow War in 30 Minutes! (${day})`,
    `${getAllWarMention(guild)}\n\n` +
    `🚨 **Shadow War at 7:30 PM PHT — 30 minutes away!**\n\n` +
    `✅ **Checklist:**\n` +
    `• Log into Diablo Immortal NOW\n` +
    `• Go to the Rite of Exile entrance\n` +
    `• Coordinate with your team leader\n` +
    `• High-level → Main Battle | Low-level → Support\n\n` +
    `⚡ Zeus clan does not fall!`, 0xFF6600
  )]});
}

// 🚨 ALL WAR ROLES — 5 min final call
function sendFinalCall(guild) {
  const ch = getChannel(guild, CONFIG.shadowWarChannelName);
  if (!ch) return;
  ch.send({ embeds: [new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🚨 5 MINUTES TO SHADOW WAR!')
    .setDescription(
      `${getAllWarMention(guild)}\n\n` +
      `⚡ **BATTLE BEGINS IN 5 MINUTES!** ⚡\n\n` +
      `🏹 ALL warriors to your positions NOW!\n` +
      `Report to the Rite of Exile entrance.\n\n` +
      `**FOR ZEUS! FOR GLORY! ⚡🔱**`
    )
    .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
    .setTimestamp()
  ]});
}

// ─── DM HANDLER — intercepts stat form responses ──────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  // Only handle DMs for stat sessions
  if (message.channel.type === 1) { // 1 = DM channel
    await stats.handleStatDMResponse(message);
    return;
  }
});
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // Trivia answer check (before prefix check)
  if (activeTriviaQuestion && !message.content.startsWith(PREFIX) &&
      message.channel.id === activeTriviaQuestion.channelId) {
    if (message.content.toLowerCase().trim().includes(activeTriviaQuestion.answer.toLowerCase())) {
      activeTriviaQuestion = null;
      return message.reply({ embeds: [zeusEmbed('🎉 Correct!',
        `**${message.author.username}** got it right!\nAnswer: **${activeTriviaQuestion?.answer || 'correct'}**\n\n⚡ Zeus is proud!`, 0x00FF00
      )]});
    }
  }

  if (!message.content.startsWith(PREFIX)) return;
  const args    = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── $getstats @user (officer lookup) ─────────────────────────────────────
  if (command === 'getstats') {
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$getstats @user`');
    return stats.getOtherStats(message, target);
  }

  // ── $updatestats ──────────────────────────────────────────────────────────
  if (command === 'updatestats') {
    await message.reply('📬 Check your DMs! I\'m sending you the stat update form now. ⚡');
    await stats.startStatForm(message.member, message.channel);
    return;
  }

  // ── $mystats ──────────────────────────────────────────────────────────────
  if (command === 'mystats') {
    return stats.showMyStats(message);
  }

  // ── $roster ───────────────────────────────────────────────────────────────
  if (command === 'roster') {
    const filterClass = args[0] || null;
    return stats.showRoster(message, filterClass);
  }

  // ── $help ────────────────────────────────────────────────────────────────
  if (command === 'help') {
    return message.reply({ embeds: [zeusEmbed('Zeus Bot v3.0 Commands',
      `**📊 Clan Stats**\n` +
      `\`$updatestats\` — Update your stats via DM form\n` +
      `\`$mystats\` — View your current stats\n` +
      `\`$getstats @user\` — View another member's stats (officers)\n` +
      `\`$roster\` — Full clan roster with pagination\n` +
      `\`$roster [class]\` — Filter roster by class\n\n` +
      `**⚔️ Wars & Schedule**\n` +
      `\`$war\` — Countdown to next war\n` +
      `\`$schedule\` — Full weekly schedule\n` +
      `\`$signup\` — How to sign up\n\n` +
      `**🏆 Cycle & Attendance**\n` +
      `\`/cycle-status\` — Current cycle progress + your attendance\n` +
      `\`/leaderboard\` — Current attendance standings\n` +
      `\`/cycle-start\` — Start a new 7-week cycle (Officer+)\n` +
      `\`/cycle-end\` — Close cycle, assign awards, archive (Officer+)\n` +
      `\`/activity\` — Chat activity report (Officer+)\n` +
      `\`/setup\` — Configure tracker channels + award roles (Admin)\n\n` +
      `**🎭 Roles**\n` +
      `\`$myroles\` — Open your private role menu (DM)\n` +
      `\`$roles\` — List available roles\n` +
      `\`$giverole @user [role]\` — Assign role (Admin)\n\n` +
      `**📢 Announcements & Officers**\n` +
      `\`/announce\` — Rich announcement with interactive buttons (Officer+)\n` +
      `\`/officers\` — Post officer roles & responsibilities\n` +
      `\`$ping @role [msg]\` — Ping a role (Admin)\n` +
      `\`$checkpatch\` — Manual patch check (Admin)\n\n` +
      `**🛡️ Moderation**\n` +
      `\`$kick\` \`$ban\` \`$mute\` \`$warn\` \`$clear\`\n\n` +
      `**🎮 Fun**\n` +
      `\`$roll\` \`$flip\` \`$trivia\` \`$8ball\` \`$rank\``
    )]});
  }

  // ── $myroles ─────────────────────────────────────────────────────────────
  if (command === 'myroles') {
    await sendRoleDM(message.member);
    return message.reply('📬 Check your DMs! Role selection menu sent. If you don\'t see it, enable **DMs from server members** in Privacy Settings.');
  }

  // ── $roles ────────────────────────────────────────────────────────────────
  if (command === 'roles') {
    return message.reply({ embeds: [zeusEmbed('Available Roles',
      `Use \`$myroles\` to open your private role menu!\n\n` +
      `🔱 **Stronkpeople** — Default Zeus member (auto-assigned on join)\n` +
      `⚔️ **Shadow War** — Pinged 30 min before & 5 min before each war\n` +
      `🔥 **Shadow War Core** — Exclusive 45-min early alert + all other pings\n\n` +
      `💡 *Core = active fighters who commit to every war.*`
    )]});
  }

  // ── $war ─────────────────────────────────────────────────────────────────
  if (command === 'war') {
    const now = moment().tz(TIMEZONE);
    const dow = now.day(), hour = now.hour(), min = now.minute();
    let daysUntil = null, nextWarDay = null;
    if ((dow === 4 || dow === 6) && (hour < 19 || (hour === 19 && min < 30))) {
      daysUntil = 0; nextWarDay = dow === 4 ? 'Thursday' : 'Saturday';
    } else {
      for (let i = 1; i <= 7; i++) {
        const d = (dow + i) % 7;
        if (d === 4 || d === 6) { daysUntil = i; nextWarDay = d === 4 ? 'Thursday' : 'Saturday'; break; }
      }
    }
    const diff = moment().tz(TIMEZONE).add(daysUntil, 'days').hour(19).minute(30).second(0).diff(now, 'minutes');
    const h = Math.floor(diff / 60), m = diff % 60;
    return message.reply({ embeds: [zeusEmbed('⚔️ Next Shadow War',
      `📅 **${nextWarDay}** @ **7:30 PM PHT**\n\n` +
      `⏱️ **${daysUntil === 0 ? `${h}h ${m}m` : `${daysUntil} day(s), ${h % 24}h ${m}m`}** remaining\n\n` +
      `🔥 Core ping: **6:45 PM** (45 min early)\n` +
      `⚔️ All war ping: **7:00 PM** (30 min)\n` +
      `🚨 Final call: **7:25 PM** (5 min)\n\n` +
      `Use \`$myroles\` to pick your ping tier! ⚡`
    )]});
  }

  // ── $schedule ─────────────────────────────────────────────────────────────
  if (command === 'schedule') {
    return message.reply({ embeds: [zeusEmbed('Zeus Clan Weekly Schedule',
      `🗓️ **All times PHT (Asia/Manila)**\n\n` +
      `**Monday**\n• 📋 Sign-ups OPEN — 9:00 AM\n\n` +
      `**Tuesday**\n• ⛔ Sign-ups CLOSE — 9:00 PM\n\n` +
      `**Thursday & Saturday**\n` +
      `• 🔥 6:45 PM — Core early alert (Core only)\n` +
      `• ⚔️ 7:00 PM — 30-min warning (All @shadow war)\n` +
      `• 🚨 7:25 PM — Final call (All @shadow war)\n` +
      `• ⚔️ 7:30 PM — **SHADOW WAR BEGINS**\n\n` +
      `**Sunday**\n• 👑 8:00 PM — Rite of Exile (if qualified)\n\n` +
      `**Every Friday**\n• 📢 10:00 AM — Weekly clan update`
    )]});
  }

  // ── $signup ───────────────────────────────────────────────────────────────
  if (command === 'signup') {
    return message.reply({ embeds: [zeusEmbed('Shadow War Sign-Up Guide',
      `📋 **How to Sign Up:**\n\n` +
      `1️⃣ Open Diablo Immortal\n` +
      `2️⃣ Go to the **Shadows Hideout**\n` +
      `3️⃣ Find the **Shadow War** sign-up option\n` +
      `4️⃣ Register before **Tuesday 9:00 PM**\n\n` +
      `⚠️ **Requirements:**\n` +
      `• Must be in the **Shadows faction**\n` +
      `• Must be in Zeus Clan (Dark Clan)\n` +
      `• Clan needs minimum **30 members** signed\n` +
      `• Level 43+ required\n\n⚡ Sign up early!`
    )]});
  }

  // ── $checkpatch ───────────────────────────────────────────────────────────
  if (command === 'checkpatch') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ Need **Manage Messages** permission.');
    }
    const reply = await message.reply('🔍 Checking Blizzard RSS feed for new patches...');

    // Clear the cache so the next check will re-announce even if already seen
    try { fs.writeFileSync(PATCH_CACHE_FILE, JSON.stringify({ lastHash: null, lastTitle: null }, null, 2)); } catch {}

    await checkForNewPatch(message.guild);

    const freshCache = loadPatchCache();
    if (freshCache.lastTitle) {
      reply.edit(`✅ Check complete! Latest: **${freshCache.lastTitle}**\nIf it's new, it's been posted to \`#clan-announcements\`.`);
    } else {
      reply.edit('⚠️ Check complete — couldn\'t reach the Blizzard RSS feed. Will retry automatically next cycle.');
    }
  }

  // ── $ping ─────────────────────────────────────────────────────────────────
  if (command === 'ping') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ Need **Manage Messages** permission.');
    const roleMention = args.shift(), text = args.join(' ');
    if (!roleMention || !text) return message.reply('❌ Usage: `$ping @role [message]`');
    const ch = getChannel(message.guild, CONFIG.announcementChannelName);
    if (!ch) return message.reply('❌ `#clan-announcements` not found.');
    await ch.send({ content: roleMention, embeds: [zeusEmbed('📣 Announcement', text)] });
    return message.reply('✅ Done!');
  }

  // ── $kick ─────────────────────────────────────────────────────────────────
  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) return message.reply('❌ Need **Kick Members** permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$kick @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.kick(reason);
    const embed = zeusEmbed('🦶 Kicked', `**${target.user.tag}** — ${reason}`, 0xFF6600);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $ban ──────────────────────────────────────────────────────────────────
  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) return message.reply('❌ Need **Ban Members** permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$ban @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.ban({ reason });
    const embed = zeusEmbed('🔨 Banned', `**${target.user.tag}** — ${reason}`, 0xFF0000);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $mute ─────────────────────────────────────────────────────────────────
  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) return message.reply('❌ Need **Moderate Members** permission.');
    const target = message.mentions.members.first();
    const minutes = parseInt(args[1]) || 10;
    if (!target) return message.reply('❌ Usage: `$mute @user [minutes]`');
    await target.timeout(minutes * 60 * 1000);
    const embed = zeusEmbed('🔇 Muted', `**${target.user.tag}** — ${minutes} minute(s)`, 0xFFA500);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $warn ─────────────────────────────────────────────────────────────────
  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ Need **Manage Messages** permission.');
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) return message.reply('❌ Usage: `$warn @user [reason]`');
    const embed = zeusEmbed('⚠️ Warning', `**${target.user.tag}** — ${reason}`, 0xFFFF00);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    try { await target.send({ embeds: [zeusEmbed('⚠️ Warning from Zeus Clan', `**Reason:** ${reason}`)] }); } catch {}
    return message.reply({ embeds: [embed] });
  }

  // ── $clear ────────────────────────────────────────────────────────────────
  if (command === 'clear') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ Need **Manage Messages** permission.');
    const amount = Math.min(parseInt(args[0]) || 5, 100);
    await message.channel.bulkDelete(amount + 1, true);
    const r = await message.channel.send(`✅ Deleted **${amount}** messages.`);
    setTimeout(() => r.delete().catch(() => {}), 3000);
  }

  // ── $roll ─────────────────────────────────────────────────────────────────
  if (command === 'roll') {
    const sides = parseInt(args[0]) || 20;
    const result = Math.floor(Math.random() * sides) + 1;
    return message.reply({ embeds: [zeusEmbed('🎲 Dice Roll', `**${message.author.username}** rolled a d${sides}\n\n# ${result} / ${sides}`, 0x9B59B6)] });
  }

  // ── $flip ─────────────────────────────────────────────────────────────────
  if (command === 'flip') {
    return message.reply({ embeds: [zeusEmbed('🪙 Coin Flip', `**${message.author.username}** got: **${Math.random() < 0.5 ? 'Heads' : 'Tails'}**`)] });
  }

  // ── $8ball ────────────────────────────────────────────────────────────────
  if (command === '8ball') {
    const responses = ['✅ Certainly!', '✅ Without a doubt.', '🤔 Ask again later.', '❌ No way.', '⚡ Zeus says YES.', '⚡ Zeus says NO.', '🤔 Unclear — try again.'];
    const q = args.join(' ');
    if (!q) return message.reply('❌ Usage: `$8ball [question]`');
    return message.reply({ embeds: [zeusEmbed('🎱 Magic 8-Ball', `**Q:** ${q}\n\n**A:** ${responses[Math.floor(Math.random() * responses.length)]}`)] });
  }

  // ── $trivia ───────────────────────────────────────────────────────────────
  if (command === 'trivia') {
    if (activeTriviaQuestion) return message.reply('❌ A trivia question is already active!');
    const q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
    activeTriviaQuestion = { answer: q.a, channelId: message.channel.id };
    message.channel.send({ embeds: [zeusEmbed('🎮 DI Trivia!', `❓ **${q.q}**\n\nType your answer! **30 seconds.** ⚡`)] });
    setTimeout(() => {
      if (activeTriviaQuestion?.channelId === message.channel.id) {
        activeTriviaQuestion = null;
        message.channel.send({ embeds: [zeusEmbed('⏰ Time\'s Up!', `The answer was: **${q.a}**`, 0xFF6600)] });
      }
    }, 30000);
  }

  // ── $rank ─────────────────────────────────────────────────────────────────
  if (command === 'rank') {
    const roles = message.member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name).join(', ') || 'No roles';
    const joined = moment(message.member.joinedAt).tz(TIMEZONE).format('MMM DD, YYYY');
    return message.reply({ embeds: [zeusEmbed(`${message.author.username}'s Zeus Profile`,
      `⚡ **Clan:** Zeus | SEA Bloodraven\n📅 **Joined:** ${joined}\n🏷️ **Roles:** ${roles}`
    ).setThumbnail(message.author.displayAvatarURL())] });
  }

  // ── $giverole ─────────────────────────────────────────────────────────────
  if (command === 'giverole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) return message.reply('❌ Need **Manage Roles** permission.');
    const target = message.mentions.members.first();
    const roleName = args.slice(1).join(' ');
    if (!target || !roleName) return message.reply('❌ Usage: `$giverole @user [role name]`');
    const role = getRole(message.guild, roleName);
    if (!role) return message.reply(`❌ Role \`${roleName}\` not found.`);
    await target.roles.add(role);
    return message.reply({ embeds: [zeusEmbed('✅ Role Assigned', `Gave **${role.name}** to **${target.user.tag}**`)] });
  }
});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
client.on('error', err => console.error('Zeus Bot Error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ DISCORD_TOKEN not set!'); process.exit(1); }
client.login(TOKEN);
