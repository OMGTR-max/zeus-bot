// ⚡ ZEUS BOT v2.0 — Clan Bot for Diablo Immortal | Zeus Clan
// Server: SEA Bloodraven | Timezone: Asia/Manila | Prefix: $
// NEW in v2: Patch Tracker | Role DM Menu | Tiered Shadow War Pings | Welcome Banner

const {
  Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, Events
} = require('discord.js');
const cron   = require('node-cron');
const moment = require('moment-timezone');
const axios  = require('axios');
const cheerio = require('cheerio');
const stats  = require('./stats');

const TIMEZONE = 'Asia/Manila';
const PREFIX   = '$';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CONFIG = {
  announcementChannelName: 'clan-announcements',
  shadowWarChannelName:    'shadow-war-alerts',
  welcomeChannelName:      'welcome',
  modLogChannelName:       'mod-log',
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
let lastSeenPatchTitle = null;

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
    GatewayIntentBits.DirectMessages,
  ],
  partials: ['CHANNEL'],
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

// ─── WELCOME BANNER ───────────────────────────────────────────────────────────
// Creates a rich embed card that acts as the welcome banner.
// To use a real image banner, upload one to Imgur and paste the URL below.
const BANNER_URL = ''; // Optional: paste your banner image URL here e.g. 'https://i.imgur.com/XXXXX.png'

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

// ─── BUTTON HANDLER ───────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  const { customId, user } = interaction;
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
async function checkForNewPatch(guild) {
  try {
    // Try Blizzard news page
    const urls = [
      'https://diabloimmortal.blizzard.com/en-us/news',
      'https://news.blizzard.com/en-us/diablo-immortal',
    ];

    let latestTitle = null;
    let latestLink  = null;

    for (const url of urls) {
      try {
        const { data } = await axios.get(url, {
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZeusBot/2.0)' },
        });
        const $ = cheerio.load(data);

        // Try various heading selectors Blizzard uses
        const selectors = ['h3', 'h2', '.ArticleListItem-title', '.news-title', '[class*="title"]'];
        for (const sel of selectors) {
          const el = $(sel).first();
          if (el.length && el.text().trim().length > 5) {
            latestTitle = el.text().trim();
            const href = el.closest('a').attr('href') || $('a').filter((i, a) => $(a).text().includes(latestTitle.slice(0, 20))).first().attr('href');
            if (href) latestLink = href.startsWith('http') ? href : `https://diabloimmortal.blizzard.com${href}`;
            break;
          }
        }
        if (latestTitle) break;
      } catch { continue; }
    }

    if (!latestTitle || latestTitle === lastSeenPatchTitle) return;
    lastSeenPatchTitle = latestTitle;
    console.log(`🎮 New DI content detected: ${latestTitle}`);

    const channel = getChannel(guild, CONFIG.announcementChannelName);
    if (!channel) return;

    const isPatch = /patch|update|hotfix|fix|maintenance|balance|season/i.test(latestTitle);
    const stronkRole = getStronkMention(guild);

    const embed = new EmbedBuilder()
      .setColor(isPatch ? 0xFF4500 : 0x00BFFF)
      .setTitle(`⚡ ${isPatch ? '🔧 New Patch / Update!' : '📰 New DI News!'}`)
      .setDescription(
        `**${latestTitle}**\n\n` +
        `${isPatch
          ? '🔧 A new game update has been detected for **Diablo Immortal**!\nUpdate your game before the next Shadow War to avoid issues.'
          : '📣 New content or announcement from Blizzard!'
        }\n\n` +
        `${latestLink ? `🔗 [Read Full Article](${latestLink})` : '🔗 Check the official Diablo Immortal site for details.'}\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *Always update before **Thu & Sat @ 7:30 PM PHT** Shadow War!*`
      )
      .setFooter({ text: 'Zeus Clan Patch Tracker | Auto-monitored via Blizzard News' })
      .setTimestamp();

    await channel.send({ content: stronkRole, embeds: [embed] });
  } catch (err) {
    console.log('Patch check error (will retry next cycle):', err.message);
  }
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`\n⚡ Zeus Bot v2.0 online! Logged in as ${client.user.tag}`);
  console.log(`📅 Timezone: Asia/Manila (PHT)`);
  console.log(`🆕 v2 Features: Patch Tracker | DM Role Menu | Tiered War Pings | Welcome Banner\n`);
  client.user.setActivity('⚔️ Shadow War | $help', { type: 0 });
  scheduleReminders();
  schedulePatchTracker();
});

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
    return message.reply({ embeds: [zeusEmbed('Zeus Bot v2.0 Commands',
      `**📊 Clan Stats**\n` +
      `\`$updatestats\` — Update your stats via DM form\n` +
      `\`$mystats\` — View your current stats\n` +
      `\`$roster\` — View full clan roster (sorted by Resonance)\n` +
      `\`$roster [class]\` — Filter roster by class\n\n` +
      `\`$war\` — Countdown to next war\n` +
      `\`$schedule\` — Full weekly schedule\n` +
      `\`$signup\` — How to sign up\n\n` +
      `**🎭 Roles**\n` +
      `\`$myroles\` — Open your private role menu (DM)\n` +
      `\`$roles\` — List available roles\n` +
      `\`$giverole @user [role]\` — Assign role (Admin)\n\n` +
      `**📢 Announcements**\n` +
      `\`$announce [msg]\` — Post announcement (Admin)\n` +
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
    const reply = await message.reply('🔍 Checking Blizzard news for new patches...');
    const oldTitle = lastSeenPatchTitle;
    lastSeenPatchTitle = null; // force re-check
    await checkForNewPatch(message.guild);
    if (lastSeenPatchTitle && lastSeenPatchTitle !== oldTitle) {
      reply.edit('✅ New patch found and posted to `#clan-announcements`!');
    } else if (lastSeenPatchTitle === oldTitle) {
      lastSeenPatchTitle = oldTitle;
      reply.edit('✅ No new patches since last check.');
    } else {
      reply.edit('⚠️ Check complete — couldn\'t parse the Blizzard page (it may have changed).');
    }
  }

  // ── $announce ─────────────────────────────────────────────────────────────
  if (command === 'announce') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply('❌ Need **Manage Messages** permission.');
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `$announce [message]`');
    const ch = getChannel(message.guild, CONFIG.announcementChannelName);
    if (!ch) return message.reply('❌ `#clan-announcements` not found.');
    await ch.send({ embeds: [zeusEmbed('📢 Clan Announcement', text, 0x00BFFF)] });
    return message.reply('✅ Posted!');
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
