// ⚡ ZEUS BOT v3.0 — Clan Bot for Diablo Immortal | Zeus Clan
// Server: SEA Bloodraven | Timezone: Asia/Manila | Prefix: $
// NEW in v3: RSS-based Patch Tracker (always includes direct link) | Persistent patch cache
// ENHANCED: Rich announcement embeds with interactive buttons | Type-based styling
// v3.1: Slash commands with modal forms for announcements

const {
  Client, GatewayIntentBits, Partials, ActivityType, MessageFlags,
  EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, SlashCommandBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType
} = require('discord.js');
const { safeReadJSON, atomicWriteJSONSync, dataPath, DATA_DIR } = require('./persistence');
const cron   = require('node-cron');
const moment = require('moment-timezone');
const axios  = require('axios');
const cheerio = require('cheerio');
const fs     = require('fs');
const path   = require('path');
const stats      = require('./stats');
const attendance = require('./attendance');
const security   = require('./security');

const TIMEZONE = 'Asia/Manila';
const PREFIX   = '$';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  announcementChannelName: 'clan-announcements',
  shadowWarChannelName:    'shadow_vob-war-alerts',
  welcomeChannelName:      'welcome',
  modLogChannelName:       'mod-log',
};

// ─── ANNOUNCEMENT SYSTEM CONFIGURATION ─────────────────────────────────────────
// Persistent ack/react tallies, keyed by announcement message ID.
// Survives bot restarts so old announcements keep tallying.
const ANNOUNCE_ACKS_FILE = dataPath('.announce_acks.json');
function loadAnnounceAcks() { return safeReadJSON(ANNOUNCE_ACKS_FILE, {}); }
function saveAnnounceAcks(store) {
  try { atomicWriteJSONSync(ANNOUNCE_ACKS_FILE, store); }
  catch (e) { console.log('[Announce] ack store save error:', e.message); }
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
const PATCH_CACHE_FILE = dataPath('.patch_cache.json');

function loadPatchCache() {
  return safeReadJSON(PATCH_CACHE_FILE, { lastHash: null, lastTitle: null });
}

function savePatchCache(hash, title) {
  try {
    atomicWriteJSONSync(PATCH_CACHE_FILE, { lastHash: hash, lastTitle: title });
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
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
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
  if (!isOfficerOrAdmin(interaction.member)) {
    return interaction.reply({
      content: '❌ Only **Officers** and **Admins** can use announcements.',
      flags: MessageFlags.Ephemeral
    });
  }

  // ──────────────────────────────────────────────────────────────
  // 2. VALIDATE TYPE AND BUILD CONFIG
  // ──────────────────────────────────────────────────────────────
  if (!ANNOUNCEMENT_TYPES[type]) {
    return interaction.reply({
      content: `❌ Invalid type. Use: ${Object.keys(ANNOUNCEMENT_TYPES).join(', ')}`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (!title || !message) {
    return interaction.reply({
      content: '❌ Title and message cannot be empty.',
      flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
    });
  }
  // Verify the bot can send in the chosen channel
  const me = interaction.guild.members.me;
  if (me && !announcementChannel.permissionsFor(me)?.has('SendMessages')) {
    return interaction.reply({
      content: `❌ I don't have permission to send messages in <#${announcementChannel.id}>.`,
      flags: MessageFlags.Ephemeral
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
      flags: MessageFlags.Ephemeral
    });

    // Button clicks are handled by the global InteractionCreate handler
    // (announce_* branch). No per-message collector — collectors die on bot
    // restart, leaving "This interaction failed" on old announcements.

  } catch (err) {
    console.error('[Announce] Error:', err);
    await interaction.reply({
      content: '❌ Failed to post announcement. Check bot permissions.',
      flags: MessageFlags.Ephemeral
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
    if (interaction.commandName === 'engagement')   return handleEngagementCommand(interaction);
    if (interaction.commandName === 'cycle-edit')   return handleCycleEditCommand(interaction);
    if (interaction.commandName === 'cycle-restore') return handleCycleRestoreCommand(interaction);
    if (interaction.commandName === 'data-debug')   return handleDataDebugCommand(interaction);
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
      const isAdmin  = isOfficerOrAdmin(interaction.member);

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
          flags: MessageFlags.Ephemeral,
        });
      }
      if (action === 'delete') {
        if (!isAuthor && !isAdmin) {
          return interaction.reply({
            content: '❌ Only the author or an admin can delete this announcement.',
            flags: MessageFlags.Ephemeral,
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
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (err) {
      console.error('[Announce buttons] Error:', err);
      if (!interaction.replied && !interaction.deferred) {
        try {
          await interaction.reply({ content: '❌ Action failed.', flags: MessageFlags.Ephemeral });
        } catch {}
      }
    }
    return;
  }

  // ── /cycle-end confirmation buttons ───────────────────────────────────────
  if (customId.startsWith('cycle_end_')) {
    const parts = customId.split('_'); // [cycle, end, action, userId, ...cycleId]
    const action = parts[2];
    const invokerId = parts[3];
    if (user.id !== invokerId) {
      return interaction.reply({ content: '❌ Only the officer who ran `/cycle-end` can confirm.', flags: MessageFlags.Ephemeral });
    }
    if (action === 'cancel') {
      return interaction.update({
        embeds: [zeusEmbed('Cycle End Cancelled', 'No changes made.', 0x95A5A6)],
        components: [],
      });
    }
    if (action === 'confirm') {
      const expectedCycleId = parts.slice(4).join('_');
      const current = attendance.getCurrentCycle();
      if (!current || current.cycleId !== expectedCycleId) {
        return interaction.update({
          content: '⚠️ The cycle changed since you opened this prompt. Run `/cycle-end` again.',
          embeds: [],
          components: [],
        });
      }
      return executeCycleEnd(interaction);
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
    return interaction.reply({ content: '❌ Could not find your server membership. Use `$myroles` in the server.', flags: MessageFlags.Ephemeral });
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
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      await interaction.reply({ content: `✅ Removed **${roleEmoji} ${role.name}** from your roles.`, flags: MessageFlags.Ephemeral });
    } else {
      await member.roles.add(role);
      await interaction.reply({ content: `✅ You now have **${roleEmoji} ${role.name}**! ⚡`, flags: MessageFlags.Ephemeral });
    }
  } catch {
    await interaction.reply({
      content: `❌ Couldn't assign the role — make sure Zeus Bot's role is **above** \`${role.name}\` in Server Settings → Roles.`,
      flags: MessageFlags.Ephemeral,
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

// Officer/Admin gate: Discord server admins always pass; otherwise check
// configured officer role IDs (preferred) and fall back to role-name match
// for guilds that haven't run /setup yet.
function isOfficerOrAdmin(member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;

  const cfg = attendance.loadConfig();
  const ids = cfg.officerRoleIds || [];
  if (ids.length && member.roles?.cache?.some(r => ids.includes(r.id))) return true;

  return member.roles?.cache?.some(r => ATTENDANCE_ADMIN_ROLES.includes(r.name));
}
function isAttendanceAdmin(interaction) {
  return isOfficerOrAdmin(interaction.member);
}

async function handleSetupCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({
      content: '❌ Only **Officers** and **Admins** can run `/setup`.',
      flags: MessageFlags.Ephemeral,
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
  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleCycleStartCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const existing = attendance.getCurrentCycle();
  if (existing) {
    return interaction.reply({
      content: `⚠️ A cycle is already active (\`${existing.cycleId}\`). Run \`/cycle-end\` first.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const faction   = interaction.options.getString('faction');
  const startDate = interaction.options.getString('start-date');
  let state;
  try {
    state = attendance.startCycle(faction, startDate || null);
  } catch (e) {
    return interaction.reply({ content: `❌ ${e.message}`, flags: MessageFlags.Ephemeral });
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
      flags: MessageFlags.Ephemeral,
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
    flags: MessageFlags.Ephemeral,
  });
}

async function handleLeaderboardCommand(interaction) {
  const state = attendance.getCurrentCycle();
  if (!state) {
    return interaction.reply({ content: '⚠️ No active cycle.', flags: MessageFlags.Ephemeral });
  }
  const cfg = attendance.loadConfig();
  const lb  = attendance.buildLeaderboard(state, cfg.officerRoleIds, interaction.guild);

  if (lb.entries.length === 0) {
    return interaction.reply({
      content: '📊 No attendance recorded yet for this cycle.',
      flags: MessageFlags.Ephemeral,
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
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const state = attendance.getCurrentCycle();
  if (!state) {
    return interaction.reply({ content: '⚠️ No active cycle to end.', flags: MessageFlags.Ephemeral });
  }

  // /cycle-end is destructive — it deletes the live state file and assigns
  // award roles. Require an explicit second click so an accidental run
  // can't nuke the cycle. cycleId is encoded in the button id so a stale
  // click after a new cycle start is detected and refused.
  const memberCount = Object.keys(state.attendance || {}).length;
  const start = moment(state.startDate).tz(attendance.TIMEZONE).format('MMM DD, YYYY');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`cycle_end_confirm_${interaction.user.id}_${state.cycleId}`)
      .setLabel('Confirm End Cycle')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`cycle_end_cancel_${interaction.user.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    embeds: [zeusEmbed(
      '⚠️ Confirm Cycle End',
      `**Cycle:** \`${state.cycleId}\`\n` +
      `**Faction:** ${state.faction.toUpperCase()}\n` +
      `**Start date:** ${start}\n` +
      `**Members tracked:** ${memberCount}\n\n` +
      `This will assign cycle award roles, archive the leaderboard to history, and **delete the live state file**.\n\n` +
      `Click **Confirm End Cycle** within 60 seconds to proceed, or **Cancel**.`,
      0xE67E22
    )],
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function executeCycleEnd(interaction) {
  await interaction.deferUpdate();
  try {
    const result = await attendance.endCycle(interaction.guild);
    if (result.error) {
      return interaction.editReply({ content: `❌ ${result.error}`, embeds: [], components: [] });
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
    return interaction.editReply({
      embeds: [zeusEmbed('Cycle Closed ⚡', summary)],
      components: [],
    });
  } catch (err) {
    console.error('[cycle-end] failed:', err);
    return interaction.editReply({ content: `❌ Cycle end failed: ${err.message}`, embeds: [], components: [] });
  }
}

// ─── ATTENDANCE: VOICE & REACTION LISTENERS ──────────────────────────────────
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  attendance.handleVoiceStateUpdate(oldState, newState);
});

client.on(Events.MessageReactionAdd, (reaction, user) => {
  attendance.handleCheckInReaction(reaction, user);
});

// ─── CHAT ACTIVITY (silent, officer-only signal) ─────────────────────────────
// Severity → embed color for security mod-log entries.
const SECURITY_COLORS = {
  log:               0xFFFF00,
  delete:            0xFFA500,
  'delete+timeout':  0xFF6600,
  'purge+timeout':   0xFF0000,
};

const SECURITY_TITLES = {
  log:               '🔍 Security flag (low confidence)',
  delete:            '🛡️ Auto-deleted suspicious message',
  'delete+timeout':  '🛡️ Auto-quarantined member (24h)',
  'purge+timeout':   '🚨 Auto-purged & quarantined — likely compromised account',
};

async function handleSecurityAction(message, result) {
  const log = getChannel(message.guild, CONFIG.modLogChannelName);
  const purge = result.action === 'purge+timeout';
  const shouldDelete = result.action !== 'log';
  const shouldTimeout = result.action === 'delete+timeout' || purge;

  if (shouldDelete) {
    try { await message.delete(); } catch {}
  }

  if (purge) {
    // Sweep the user's recent messages across every channel they posted in.
    const recent = security.getRecentForUser(message.author.id);
    for (const r of recent) {
      if (r.messageId === message.id) continue;
      const ch = message.guild.channels.cache.get(r.channelId);
      if (!ch) continue;
      try {
        const m = await ch.messages.fetch(r.messageId);
        if (m) await m.delete().catch(() => {});
      } catch {}
    }
  }

  if (shouldTimeout && message.member) {
    try {
      await message.member.timeout(24 * 60 * 60 * 1000, `Auto-quarantine (security score ${result.score})`);
    } catch {}
    try {
      await message.author.send({ embeds: [zeusEmbed('⚠️ Your account may be compromised',
        `A message you posted in **${message.guild.name}** was flagged as likely malware/phishing ` +
        `(security score **${result.score}**) and removed. You've been timed out for 24 hours.\n\n` +
        `**If you didn't intend to post a Discord invite or link**, treat this as a compromised-account incident:\n` +
        `1. Change your Discord password.\n` +
        `2. Log out all sessions (User Settings → Devices).\n` +
        `3. Run an antivirus scan.\n` +
        `4. Re-enable 2FA if it was disabled.\n\n` +
        `Once your account is secure, contact a Zeus officer to lift the timeout.`,
        0xFF0000
      )] });
    } catch {}
  }

  if (log) {
    const safeContent = (message.content || '').slice(0, 600).replace(/`/g, 'ʹ');
    log.send({
      content: purge ? '@here Security alert — possible compromised account' : null,
      embeds: [zeusEmbed(
        SECURITY_TITLES[result.action] || '🔍 Security event',
        `**User:** ${message.author.tag} (\`${message.author.id}\`)\n` +
        `**Channel:** <#${message.channel.id}>\n` +
        `**Score:** ${result.score}\n` +
        `**Reasons:** ${result.reasons.join(', ') || '(none)'}\n` +
        `**Content:**\n\`\`\`${safeContent || '(empty)'}\`\`\``,
        SECURITY_COLORS[result.action] || 0xFFFF00
      )],
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }

  security.recordIncident({
    userId: message.author.id,
    userTag: message.author.tag,
    channelId: message.channel.id,
    messageId: message.id,
    score: result.score,
    reasons: result.reasons,
    action: result.action,
    contentSnippet: (message.content || '').slice(0, 240),
  });
}

client.on(Events.MessageCreate, async msg => {
  if (msg.author?.bot) return;
  if (!msg.guild) return;

  // Security scan: skip $-prefix commands so officer commands referencing
  // scam domains (e.g. `$blockdomain dlscord.gg`) aren't self-flagged.
  if (!msg.content?.startsWith(PREFIX)) {
    try {
      security.trackMessage(msg);
      const result = security.evaluate(msg);
      if (result.action !== 'none') {
        await handleSecurityAction(msg, result);
        // Auto-deleted spam shouldn't count as engagement.
        if (result.action !== 'log') return;
      }
    } catch (e) {
      console.log('[security] scan error:', e.message);
    }
  }

  // Skip slash command interactions; those don't fire MessageCreate anyway,
  // but $-prefix commands do. Track them as activity — using the bot is
  // engagement.
  attendance.recordChatMessage(msg.author.id, msg.channel.id);
});

async function handleActivityCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const cfg = attendance.loadConfig();
  // Use the engagement report so officers see chat + voice + war + flags in
  // one place. This replaces the older chat-only view.
  const report = attendance.getEngagementReport(interaction.guild, cfg.officerRoleIds);
  if (!report || report.length === 0) {
    return interaction.reply({
      content: '📊 No activity recorded this cycle. (Cycle may not be active.)',
      flags: MessageFlags.Ephemeral,
    });
  }
  // Re-sort by chat count for the officer "who's talking" view
  const byChat = [...report].sort((a, b) => b.chatCount - a.chatCount);
  const lines = byChat.slice(0, 30).map((e, i) => {
    const off   = e.isOfficer ? ' *(officer)*' : '';
    const last  = e.lastMessage ? moment(e.lastMessage).tz(attendance.TIMEZONE).fromNow() : '—';
    const flags = e.flags.length ? ' ' + e.flags.map(f => FLAG_LABEL[f] || f).join(' ') : '';
    return `\`${String(i + 1).padStart(2)}\` **${e.username}** — 💬${e.chatCount} ` +
           `· 🎙️${e.warVoiceMin}m war / ${e.globalVoiceMin}m total ` +
           `· score \`${e.score}\` (last msg: ${last})${off}${flags}`;
  });
  const totalMsgs = report.reduce((s, e) => s + e.chatCount, 0);
  return interaction.reply({
    embeds: [zeusEmbed(
      'Activity — Officer View',
      `Showing **${Math.min(30, byChat.length)}** of **${report.length}** active members ` +
      `(${totalMsgs} total messages this cycle).\n\n` +
      lines.join('\n') +
      `\n\n🚩 = drive-by credit · 🔇 = no chat 7d · 👻 = no chat & no voice 14d. ` +
      `Use \`/engagement\` for the public score view.`
    )],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /engagement — public engagement leaderboard (separate from war awards) ─
const FLAG_LABEL = {
  drive_by:   '🚩 drive-by',
  silent:     '🔇 silent',
  ghost:      '👻 ghost',
};
async function handleEngagementCommand(interaction) {
  const cfg = attendance.loadConfig();
  const report = attendance.getEngagementReport(interaction.guild, cfg.officerRoleIds);
  if (!report || report.length === 0) {
    return interaction.reply({
      content: '📊 No engagement data yet this cycle. Make sure a cycle is active and members are chatting / joining voice.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const callerId = interaction.user.id;
  const callerEntry = report.find(e => e.userId === callerId);
  const top = report.slice(0, 15);
  const fmtRow = (e, i) => {
    const off   = e.isOfficer ? ' *(officer)*' : '';
    const flags = e.flags.length ? ' ' + e.flags.map(f => FLAG_LABEL[f] || f).join(' ') : '';
    const me    = e.userId === callerId ? ' ⬅️' : '';
    return `\`${String(i + 1).padStart(2)}\` **${e.username}** — \`${e.score}\`  ` +
           `(⚔️${e.attendance} · 💬${e.chatCount} · 🎙️${e.warVoiceMin}m war / ${e.globalVoiceMin}m total)${off}${flags}${me}`;
  };
  const lines = top.map(fmtRow);

  let myLine = '';
  if (callerEntry && !top.some(e => e.userId === callerId)) {
    const idx = report.findIndex(e => e.userId === callerId);
    myLine = `\n\n— Your rank —\n${fmtRow(callerEntry, idx)}`;
  }

  const legend =
    `\n\n**Score:** chat ×1 · channel breadth ×5 · global voice ×0.5/min · ` +
    `war voice ×2/min · attendance ×50 · recency bonus.\n` +
    `**Flags:** 🚩 drive-by = avg <5 min in war voice · 🔇 silent = no chat 7d · 👻 ghost = no chat & no voice 14d.\n` +
    `*This is separate from the cycle MVP / Storm Bearer / Lightning Striker awards (those are war attendance only).*`;

  return interaction.reply({
    embeds: [zeusEmbed(
      'Engagement Leaderboard ⚡',
      `Showing top **${top.length}** of **${report.length}** active members this cycle.\n\n` +
      lines.join('\n') + myLine + legend
    )],
  });
}

// ─── /cycle-edit — change the active cycle's start date ────────────────────
async function handleCycleEditCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const newDate = interaction.options.getString('start-date');
  const result = attendance.editCycleStartDate(newDate);
  if (result.error) {
    return interaction.reply({ content: `❌ ${result.error}`, flags: MessageFlags.Ephemeral });
  }
  const start = moment(result.state.startDate).tz(attendance.TIMEZONE).format('MMM DD, YYYY');
  return interaction.reply({
    embeds: [zeusEmbed(
      'Cycle Date Updated ⚡',
      `**Cycle ID:** \`${result.state.cycleId}\`\n` +
      `**New start date:** ${start}\n\n` +
      `Attendance, voice, and chat data preserved. Week numbering recalculated from the new start.`
    )],
    flags: MessageFlags.Ephemeral,
  });
}

// ─── /cycle-restore — restore the active cycle from a backup ───────────────
async function handleCycleRestoreCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const backups = attendance.listBackups();
  if (backups.length === 0) {
    return interaction.reply({ content: '⚠️ No backups available.', flags: MessageFlags.Ephemeral });
  }
  const which = interaction.options.getString('backup');
  // No filename given → restore the most recent (after confirming what's in it)
  const filename = which || backups[0];
  if (!backups.includes(filename)) {
    return interaction.reply({
      content: `❌ Backup not found: \`${filename}\`\n\nAvailable (newest first):\n` +
        backups.slice(0, 10).map(f => `• \`${f}\``).join('\n'),
      flags: MessageFlags.Ephemeral,
    });
  }
  const restored = attendance.restoreFromBackup(filename);
  if (!restored) {
    return interaction.reply({ content: `❌ Failed to restore backup \`${filename}\`.`, flags: MessageFlags.Ephemeral });
  }
  const start = moment(restored.startDate).tz(attendance.TIMEZONE).format('MMM DD, YYYY');
  const attCount = Object.keys(restored.attendance || {}).length;
  return interaction.reply({
    embeds: [zeusEmbed(
      'Cycle Restored ⚡',
      `**Backup:** \`${filename}\`\n` +
      `**Cycle ID:** \`${restored.cycleId}\`\n` +
      `**Start date:** ${start}\n` +
      `**Faction:** ${restored.faction.toUpperCase()}\n` +
      `**Members with attendance:** ${attCount}\n\n` +
      `*${backups.length} backup(s) total. Use \`/cycle-restore backup:<filename>\` to pick a different one.*`
    )],
    flags: MessageFlags.Ephemeral,
  });
}

// Probe whether DATA_DIR is a real persistent mount or just a directory on
// the container's ephemeral filesystem. A real mount has a different `dev`
// (device id) from its parent — same `dev` means same filesystem = ephemeral.
function inspectDataMount() {
  const envSet = !!process.env.DATA_DIR;
  try {
    const dataStat   = fs.statSync(DATA_DIR);
    const parentStat = fs.statSync(path.dirname(DATA_DIR));
    const realMount  = dataStat.dev !== parentStat.dev;
    return { envSet, realMount, dev: dataStat.dev, parentDev: parentStat.dev };
  } catch (e) {
    return { envSet, realMount: false, error: e.code || e.message };
  }
}

// ─── /data-debug — list files on the persistent volume (Officer+) ─────────
async function handleDataDebugCommand(interaction) {
  if (!isAttendanceAdmin(interaction)) {
    return interaction.reply({ content: '❌ Officer/Admin only.', flags: MessageFlags.Ephemeral });
  }
  const mount = inspectDataMount();
  let modeLabel;
  if (mount.error)        modeLabel = `error: ${mount.error} ⚠️`;
  else if (mount.realMount) modeLabel = mount.envSet ? 'real mount ✅' : 'real mount (env unset)';
  else                    modeLabel = mount.envSet ? 'ephemeral ⚠️ (env set, but no volume mounted)' : 'ephemeral ⚠️';
  const lines = [
    `**DATA_DIR:** \`${DATA_DIR}\``,
    `\n**Mount status:** ${modeLabel}`,
  ];

  function listDir(label, dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.length === 0) return `\n\n**${label}:** *(empty)*`;
      const rows = entries.map(e => {
        const full = path.join(dir, e.name);
        let info = '';
        try {
          const st = fs.statSync(full);
          const mtime = new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
          info = e.isFile() ? `${st.size}b · ${mtime}` : `<dir> · ${mtime}`;
        } catch {}
        return `• \`${e.name}\` ${info}`;
      });
      return `\n\n**${label}** (${entries.length}):\n${rows.join('\n')}`;
    } catch (e) {
      return `\n\n**${label}:** *(${e.code || e.message})*`;
    }
  }
  lines.push(listDir(DATA_DIR, DATA_DIR));
  const backupsDir       = path.join(DATA_DIR, 'backups');
  const configBackupsDir = path.join(DATA_DIR, 'config-backups');
  lines.push(listDir(backupsDir, backupsDir));
  lines.push(listDir(configBackupsDir, configBackupsDir));

  // Also include the cycle state shape if present
  const state = attendance.loadState();
  if (state) {
    lines.push(`\n\n**.attendance.json:** cycleId=\`${state.cycleId}\` faction=${state.faction} ` +
               `members=${Object.keys(state.attendance || {}).length}`);
  } else {
    lines.push(`\n\n**.attendance.json:** *(missing or unparseable — getCurrentCycle returns null)*`);
  }
  const cfg = attendance.loadConfig();
  const cfgFmt = id => id ? `set` : '`unset`';
  lines.push(
    `\n\n**.attendance_config.json:** ` +
    `checkIn=${cfgFmt(cfg.checkInChannelId)} · ` +
    `warVoiceCat=${cfgFmt(cfg.warVoiceCategoryId)} · ` +
    `leaderboard=${cfgFmt(cfg.leaderboardChannelId)}`
  );

  return interaction.reply({ content: lines.join(''), flags: MessageFlags.Ephemeral });
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

// ─── CRON CATCH-UP ───────────────────────────────────────────────────────────
// node-cron does not re-fire missed jobs after a restart, so a deploy landing
// during a war window silently drops the alert. We persist a "last fired"
// timestamp per job; on boot, runMissedAlerts re-fires any job whose
// scheduled time was in the last CATCHUP_WINDOW_MIN minutes and that hasn't
// already been fired today.
const LAST_FIRED_FILE = dataPath('.last_fired.json');
const CATCHUP_WINDOW_MIN = 10;
function markFired(jobId) {
  const log = safeReadJSON(LAST_FIRED_FILE, {});
  log[jobId] = new Date().toISOString();
  try { atomicWriteJSONSync(LAST_FIRED_FILE, log); } catch {}
}
async function runJob(jobId, fn) {
  // If catchup just fired this same job moments ago (e.g. boot lands at the
  // exact cron minute), skip the cron tick to avoid a double-post.
  const log = safeReadJSON(LAST_FIRED_FILE, {});
  const lastFired = log[jobId] ? new Date(log[jobId]).getTime() : 0;
  if (Date.now() - lastFired < 30 * 1000) {
    console.log(`[cron ${jobId}] skipped (catchup fired ${Math.floor((Date.now() - lastFired)/1000)}s ago)`);
    return;
  }
  try { await fn(); }
  finally { markFired(jobId); }
}
function getCatchupTargets() {
  // dow: 0=Sun .. 6=Sat. fn must be idempotent-safe at the minute level.
  return [
    { id: 'thu-core',           dow: 4, hour: 18, minute: 45, fn: () => client.guilds.cache.forEach(g => sendCoreEarlyAlert(g, 'Thursday')) },
    { id: 'thu-warn30',         dow: 4, hour: 19, minute: 0,  fn: () => client.guilds.cache.forEach(g => sendWarWarning(g, 'Thursday')) },
    { id: 'thu-final',          dow: 4, hour: 19, minute: 25, fn: () => client.guilds.cache.forEach(g => sendFinalCall(g)) },
    { id: 'shadow-war-checkin', dow: 4, hour: 19, minute: 30, fn: runShadowWarCheckin },
    { id: 'sat-core',           dow: 6, hour: 18, minute: 45, fn: () => client.guilds.cache.forEach(g => sendCoreEarlyAlert(g, 'Saturday')) },
    { id: 'sat-warn30',         dow: 6, hour: 19, minute: 0,  fn: () => client.guilds.cache.forEach(g => sendWarWarning(g, 'Saturday')) },
    { id: 'sat-final',          dow: 6, hour: 19, minute: 25, fn: () => client.guilds.cache.forEach(g => sendFinalCall(g)) },
    // Saturday also has a check-in at 19:30, same id as Thursday — but we
    // dedupe by scheduled-time comparison so today's run is independent.
    { id: 'shadow-war-checkin', dow: 6, hour: 19, minute: 30, fn: runShadowWarCheckin },
    { id: 'vob-checkin',        dow: 0, hour: 20, minute: 0,  fn: runVobCheckin },
  ];
}
function runMissedAlerts() {
  const log = safeReadJSON(LAST_FIRED_FILE, {});
  const now = moment().tz(TIMEZONE);
  for (const t of getCatchupTargets()) {
    if (now.day() !== t.dow) continue;
    const scheduled = moment().tz(TIMEZONE).hour(t.hour).minute(t.minute).second(0).millisecond(0);
    if (now.isBefore(scheduled)) continue;
    if (now.diff(scheduled, 'minutes') > CATCHUP_WINDOW_MIN) continue;
    const lastFired = log[t.id] ? moment(log[t.id]) : null;
    if (lastFired && lastFired.isSameOrAfter(scheduled)) continue;
    console.log(`[catchup] firing missed ${t.id} (${now.diff(scheduled, 'minutes')}m late)`);
    Promise.resolve()
      .then(() => t.fn())
      .then(() => markFired(t.id))
      .catch(e => console.log(`[catchup ${t.id}] error:`, e.message));
  }
}

// ─── ATTENDANCE: EVENT-START CRON ────────────────────────────────────────────
// Each scheduled job is named via runJob() so we record a "last fired" stamp,
// which lets runMissedAlerts() catch up after a deploy that landed mid-window.
function runShadowWarCheckin() {
  const state = attendance.getCurrentCycle();
  if (!state || state.faction !== 'shadows') return;
  return attendance.postCheckInMessage(client, 'shadow_war').catch(e =>
    console.log('[Attendance] check-in post error:', e.message)
  );
}
function runVobCheckin() {
  const state = attendance.getCurrentCycle();
  if (!state) return;
  return attendance.postCheckInMessage(client, 'vob').catch(e =>
    console.log('[Attendance] check-in post error:', e.message)
  );
}
function scheduleAttendanceCheckIns() {
  safeCron('30 19 * * 4,6', () => runJob('shadow-war-checkin', runShadowWarCheckin), { timezone: TIMEZONE });
  safeCron('0 20 * * 0',    () => runJob('vob-checkin',         runVobCheckin),       { timezone: TIMEZONE });
  console.log('✅ Attendance check-in cron scheduled (Thu/Sat 19:30 + Sun 20:00 PHT)');
}

// Process-level safety net — never crash on a stray rejection.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  console.log(`\n⚡ Zeus Bot v3.0 online! Logged in as ${client.user.tag}`);
  console.log(`📅 Timezone: Asia/Manila (PHT)`);
  // Real-mount probe + boot inventory of /data so any future data-loss
  // incident leaves clear evidence in deploy logs.
  const mount = inspectDataMount();
  console.log(`💾 DATA_DIR=${DATA_DIR} | env=${mount.envSet} | realMount=${mount.realMount}${mount.error ? ` | error=${mount.error}` : ''}`);
  if (mount.envSet && !mount.realMount) {
    console.log('⚠️  DATA_DIR env is set but /data is NOT a real mount — writes will be lost on next redeploy! Check Railway volume attachment.');
  }
  try {
    const entries = fs.readdirSync(DATA_DIR);
    console.log(`💾 /data inventory (${entries.length}): ${entries.join(', ') || '(empty)'}`);
  } catch (e) {
    console.log(`💾 /data inventory: error ${e.code || e.message}`);
  }
  // Self-heal: if live state/config files were wiped but rolling backups
  // survived, restore from the newest one before any cron or handler runs.
  try {
    const rec = attendance.autoRecoverFromBackups();
    if (rec.stateRecovered)  console.log(`💾 Auto-recovered .attendance.json from ${rec.stateRecovered}`);
    if (rec.configRecovered) console.log(`💾 Auto-recovered .attendance_config.json from ${rec.configRecovered}`);
  } catch (e) { console.log('[autorecover] error:', e.message); }
  console.log(`🆕 v3.1 Features: Slash command /announce with modal form | RSS Patch Tracker | DM Role Menu`);
  console.log(`✨ ENHANCED: Rich Announcement Embeds with Interactive Buttons\n`);
  client.user.setActivity('⚔️ Shadow War | /announce', { type: ActivityType.Playing });
  scheduleReminders();
  // Patch Tracker disabled — Blizzard RSS feed produces stale/delayed
  // posts. Re-enable by uncommenting the line below.
  // schedulePatchTracker();
  scheduleAttendanceCheckIns();
  // Re-arm any in-flight check-in close timers that were lost on shutdown.
  try { attendance.rearmPendingCheckIns(); } catch (e) {
    console.log('[Attendance] rearm error:', e.message);
  }
  // Drop any voice sessions left "open" by the previous process — their
  // joinedAt is no longer trustworthy after a restart.
  try { attendance.clearStaleVoiceSessions(); } catch (e) {
    console.log('[Attendance] clearStaleVoiceSessions error:', e.message);
  }
  // Catch up on any war alerts / check-ins missed during deploy downtime.
  try { runMissedAlerts(); } catch (e) {
    console.log('[catchup] runMissedAlerts error:', e.message);
  }
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

      // ── /engagement — public engagement leaderboard (any member) ─────────
      new SlashCommandBuilder()
        .setName('engagement')
        .setDescription('Show the engagement leaderboard for the current cycle'),

      // ── /cycle-edit — fix start date without losing data (Officer+) ──────
      new SlashCommandBuilder()
        .setName('cycle-edit')
        .setDescription('Edit the active cycle\'s start date (preserves attendance)')
        .addStringOption(o =>
          o.setName('start-date').setDescription('YYYY-MM-DD').setRequired(true)
        ),

      // ── /cycle-restore — restore cycle from backup (Officer+) ────────────
      new SlashCommandBuilder()
        .setName('cycle-restore')
        .setDescription('Restore the cycle from a backup (defaults to most recent)')
        .addStringOption(o =>
          o.setName('backup').setDescription('Backup filename (omit for newest)').setRequired(false)
        ),

      // ── /data-debug — inspect /data volume contents (Officer+) ───────────
      new SlashCommandBuilder()
        .setName('data-debug')
        .setDescription('Show what files exist on the persistent volume (officer diagnostic)'),

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
      console.log(`✅ Slash commands registered to guild ${guild.name} (instant): /announce, /setup, /cycle-start, /cycle-status, /leaderboard, /cycle-end, /cycle-edit, /cycle-restore, /activity, /engagement, /officers`);
    } else {
      await client.application.commands.set(commands);
      console.log('✅ Slash commands registered globally (may take up to 1h): /announce, /setup, /cycle-start, /cycle-status, /leaderboard, /cycle-end, /cycle-edit, /cycle-restore, /activity, /engagement, /officers');
    }
  } catch (err) {
    console.error('[Slash Commands] Error registering:', err);
  }
}

// ─── PATCH TRACKER SCHEDULE ───────────────────────────────────────────────────
function schedulePatchTracker() {
  // Check every 3 hours
  safeCron('0 */3 * * *', () => {
    client.guilds.cache.forEach(guild => checkForNewPatch(guild));
  }, { timezone: TIMEZONE });

  // Initial check 15 seconds after boot
  setTimeout(() => {
    client.guilds.cache.forEach(guild => checkForNewPatch(guild));
  }, 15000);

  console.log('✅ Patch Tracker: active — checking every 3 hours');
}

// ─── SCHEDULED REMINDERS ─────────────────────────────────────────────────────
// safeCron wraps every callback in try/catch so a network blip in one
// scheduled send doesn't bubble up as an unhandledRejection.
function safeCron(pattern, fn, opts) {
  return cron.schedule(pattern, async () => {
    try { await fn(); }
    catch (e) { console.log(`[cron ${pattern}] error:`, e.message); }
  }, opts);
}

function scheduleReminders() {
  const guilds = () => client.guilds.cache;

  // Monday 9 AM — sign-ups open (all war roles)
  safeCron('0 9 * * 1', () => {
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
  safeCron('45 18 * * 4', () => runJob('thu-core',    () => guilds().forEach(g => sendCoreEarlyAlert(g, 'Thursday'))), { timezone: TIMEZONE });
  safeCron('0 19 * * 4',  () => runJob('thu-warn30',  () => guilds().forEach(g => sendWarWarning(g, 'Thursday'))),     { timezone: TIMEZONE });
  safeCron('25 19 * * 4', () => runJob('thu-final',   () => guilds().forEach(g => sendFinalCall(g))),                  { timezone: TIMEZONE });

  // ── SATURDAY ──
  safeCron('45 18 * * 6', () => runJob('sat-core',    () => guilds().forEach(g => sendCoreEarlyAlert(g, 'Saturday'))), { timezone: TIMEZONE });
  safeCron('0 19 * * 6',  () => runJob('sat-warn30',  () => guilds().forEach(g => sendWarWarning(g, 'Saturday'))),     { timezone: TIMEZONE });
  safeCron('25 19 * * 6', () => runJob('sat-final',   () => guilds().forEach(g => sendFinalCall(g))),                  { timezone: TIMEZONE });

  // Sunday 7:30 PM — Rite of Exile warning
  safeCron('30 19 * * 0', () => {
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
  safeCron('0 10 * * 5', () => {
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

// ─── MESSAGE HANDLER — DMs (stat form) + guild commands ─────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // DMs route to stat session handler only
  if (message.channel.type === 1) { // 1 = DM channel
    await stats.handleStatDMResponse(message);
    return;
  }

  // Trivia answer check (before prefix check)
  if (activeTriviaQuestion && !message.content.startsWith(PREFIX) &&
      message.channel.id === activeTriviaQuestion.channelId) {
    const answer = activeTriviaQuestion.answer;
    if (message.content.toLowerCase().trim().includes(answer.toLowerCase())) {
      activeTriviaQuestion = null;
      return message.reply({ embeds: [zeusEmbed('🎉 Correct!',
        `**${message.author.username}** got it right!\nAnswer: **${answer}**\n\n⚡ Zeus is proud!`, 0x00FF00
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
      `\`/leaderboard\` — Current attendance standings (war attendance only)\n` +
      `\`/engagement\` — Engagement leaderboard (chat + voice + war, separate scale)\n` +
      `\`/cycle-start\` — Start a new 7-week cycle (Officer+)\n` +
      `\`/cycle-end\` — Close cycle, assign awards, archive (Officer+)\n` +
      `\`/cycle-edit\` — Fix the active cycle's start date (Officer+)\n` +
      `\`/cycle-restore\` — Restore cycle from backup if data is lost (Officer+)\n` +
      `\`/activity\` — Officer view: activity + quality flags (Officer+)\n` +
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
      `**🔒 Security (anti-spam / anti-virus)**\n` +
      `\`$scan @user\` — list a user's recent tracked messages\n` +
      `\`$scan <text|url>\` — score a sample without acting\n` +
      `\`$quarantine @user [reason]\` — 7-day timeout\n` +
      `\`$unquarantine @user\` — lift timeout\n` +
      `\`$blockdomain [domain]\` — block (or list) a malicious domain\n` +
      `\`$trustdomain [domain]\` — allowlist (or list) a safe domain\n` +
      `\`$unblockdomain <d>\` · \`$untrustdomain <d>\`\n` +
      `\`$incidents [@user]\` — recent auto-flagged events\n` +
      `_Auto-defense runs on every message: lookalike Discord links, scam keywords, crossposts, and new-account spam are deleted and the poster is auto-quarantined for 24h._\n\n` +
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
    try { atomicWriteJSONSync(PATCH_CACHE_FILE, { lastHash: null, lastTitle: null }); } catch {}

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

  // ── $scan — manually evaluate text/url, or list a user's recent messages ──
  if (command === 'scan') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    const target = message.mentions.members.first();
    if (target) {
      const recent = security.getRecentForUser(target.id);
      if (recent.length === 0)
        return message.reply(`No recent messages tracked for **${target.user.tag}** (10-minute window).`);
      const lines = recent.slice(-10).map(r =>
        `• <#${r.channelId}> — ${moment(r.ts).tz(TIMEZONE).format('HH:mm:ss')}`
      );
      return message.reply({ embeds: [zeusEmbed(
        `Recent messages — ${target.user.tag}`,
        lines.join('\n')
      )] });
    }
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `$scan @user` or `$scan <text or url>`');
    const probe = {
      content: text,
      author: { id: '0', tag: 'probe', createdTimestamp: Date.now() },
      member: { joinedTimestamp: Date.now() },
      mentions: { everyone: false },
      channel: { id: '0' },
      id: '0',
    };
    const result = security.evaluate(probe);
    const color = result.score >= 80 ? 0xFF0000 : result.score >= 50 ? 0xFFA500 : result.score >= 25 ? 0xFFFF00 : 0x00FF00;
    return message.reply({ embeds: [zeusEmbed(
      `🔍 Scan — score ${result.score}`,
      `**Action that would trigger:** \`${result.action}\`\n` +
      `**URLs:** ${result.urls.length ? result.urls.map(u => `\`${u}\``).join(', ') : '(none)'}\n` +
      `**Reasons:** ${result.reasons.length ? result.reasons.join(', ') : '(none)'}`,
      color
    )] });
  }

  // ── $quarantine — 7-day timeout for officers ──────────────────────────────
  if (command === 'quarantine') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ Need **Moderate Members** permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$quarantine @user [reason]`');
    const reason = args.slice(1).join(' ') || 'Manual quarantine (officer)';
    try {
      await target.timeout(7 * 24 * 60 * 60 * 1000, reason);
    } catch (e) {
      return message.reply(`❌ Couldn't quarantine: ${e.message}`);
    }
    const embed = zeusEmbed('🛡️ Quarantined (7d)', `**${target.user.tag}** — ${reason}`, 0xFF6600);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $unquarantine ─────────────────────────────────────────────────────────
  if (command === 'unquarantine') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return message.reply('❌ Need **Moderate Members** permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$unquarantine @user`');
    try { await target.timeout(null); }
    catch (e) { return message.reply(`❌ Couldn't lift quarantine: ${e.message}`); }
    const embed = zeusEmbed('✅ Unquarantined', `**${target.user.tag}** is back.`, 0x00FF00);
    const log = getChannel(message.guild, CONFIG.modLogChannelName);
    if (log) log.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $blockdomain / $unblockdomain / $trustdomain / $untrustdomain ─────────
  if (command === 'blockdomain') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    if (!args[0]) {
      const lists = security.loadDomainLists();
      return message.reply({ embeds: [zeusEmbed('🚫 Blocked domains',
        lists.blocked.length ? lists.blocked.map(d => `• \`${d}\``).join('\n') : '_(none)_')] });
    }
    const ok = security.addBlockDomain(args[0]);
    return message.reply(ok ? `✅ Added \`${args[0]}\` to blocklist.` : `⚠️ \`${args[0]}\` already blocked.`);
  }
  if (command === 'unblockdomain') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    if (!args[0]) return message.reply('❌ Usage: `$unblockdomain <domain>`');
    const ok = security.removeBlockDomain(args[0]);
    return message.reply(ok ? `✅ Removed \`${args[0]}\` from blocklist.` : `⚠️ \`${args[0]}\` wasn't blocked.`);
  }
  if (command === 'trustdomain') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    if (!args[0]) {
      const lists = security.loadDomainLists();
      return message.reply({ embeds: [zeusEmbed('✅ Trusted domains',
        lists.trusted.length ? lists.trusted.map(d => `• \`${d}\``).join('\n') : '_(none)_')] });
    }
    const ok = security.addTrustDomain(args[0]);
    return message.reply(ok ? `✅ Added \`${args[0]}\` to trust list.` : `⚠️ \`${args[0]}\` already trusted.`);
  }
  if (command === 'untrustdomain') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    if (!args[0]) return message.reply('❌ Usage: `$untrustdomain <domain>`');
    const ok = security.removeTrustDomain(args[0]);
    return message.reply(ok ? `✅ Removed \`${args[0]}\` from trust list.` : `⚠️ \`${args[0]}\` wasn't trusted.`);
  }

  // ── $incidents — recent flagged events (optionally per user) ──────────────
  if (command === 'incidents') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages))
      return message.reply('❌ Need **Manage Messages** permission.');
    const target = message.mentions.users.first();
    const all = security.loadIncidents();
    const filtered = target ? all.filter(i => i.userId === target.id) : all;
    const last = filtered.slice(-15).reverse();
    if (last.length === 0)
      return message.reply(target ? `No incidents recorded for **${target.tag}**.` : 'No incidents recorded yet.');
    const lines = last.map(i =>
      `• \`${i.action}\` score **${i.score}** — **${i.userTag}** — ${moment(i.ts).tz(TIMEZONE).format('MMM DD HH:mm')}\n` +
      `  ${i.reasons.slice(0, 4).join(', ')}`
    );
    return message.reply({ embeds: [zeusEmbed(
      target ? `Incidents — ${target.tag}` : 'Recent security incidents',
      lines.join('\n')
    )] });
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
