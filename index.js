// ⚡ ZEUS BOT — Clan Bot for Diablo Immortal | Zeus Clan
// Server: SEA Bloodraven | Timezone: Asia/Manila
// Prefix: $

const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits, Collection } = require('discord.js');
const cron = require('node-cron');
const moment = require('moment-timezone');

const TIMEZONE = 'Asia/Manila';
const PREFIX = '$';
const SHADOW_WAR_ROLE = 'shadow war'; // matches your existing Dyno role name (case-insensitive match)

// ─── CLIENT SETUP ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ─── CONFIG (edit these after adding bot to server) ──────────────────────────
const CONFIG = {
  announcementChannelName: 'clan-announcements',  // channel for clan announcements
  shadowWarChannelName: 'shadow-war-alerts',       // channel for shadow war pings
  welcomeChannelName: 'welcome',                   // channel to greet new members
  modLogChannelName: 'mod-log',                    // channel for mod action logs
  musicChannelName: 'music-commands',              // channel for music commands
};

// ─── TRIVIA QUESTIONS ────────────────────────────────────────────────────────
const triviaQuestions = [
  { q: "Who is the Zeus member that has reptile pets?", a: "Pandapple" },
  { q: "What day does Rite of Exile take place?", a: "sunday" },
  { q: "How many members minimum does a clan need to sign up for Shadow War?", a: "30" },
  { q: "What is the favorite drink of NaliBullet?", a: "Redhorse" },
  { q: "What item do you need to gift someone to invite them to the Shadows?", a: "akeba's signet" },
  { q: "Who is the best Pokemon?", a: "Pikachu" },
  { q: "What is the max team size in Shadow War?", a: "96" },
  { q: "Which NPC do you visit to try the Shadows lottery in Westmarch?", a: "mysterious patron" },
  { q: "What legendary item can you earn by winning Shadow War matches?", a: "legendary crest" },
  { q: "What level do you need to reach to join the Shadows faction?", a: "43" },
];

let activeTriviaQuestion = null;

// ─── HELPER: Find channel by name ────────────────────────────────────────────
function getChannel(guild, name) {
  return guild.channels.cache.find(
    c => c.name.toLowerCase() === name.toLowerCase() && c.isTextBased()
  );
}

// ─── HELPER: Zeus embed builder ──────────────────────────────────────────────
function zeusEmbed(title, description, color = 0xFFD700) {
  return new EmbedBuilder()
    .setTitle(`⚡ ${title}`)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
    .setTimestamp();
}

// ─── HELPER: Get Shadow War role mention ─────────────────────────────────────
function getShadowWarMention(guild) {
 // Replace these numbers with your actual Role IDs from Discord
  const role1 = '1492377915839742043'; // ID for 'shadow war'
  const role2 = '1492380088103211159'; // ID for 'shadow war core'

  return `<@&${role1}> <@&${role2}>`;
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`\n⚡ Zeus Bot is online! Logged in as ${client.user.tag}`);
  console.log(`📅 Timezone: ${TIMEZONE}`);
  console.log(`🎮 Server: SEA Bloodraven | Diablo Immortal\n`);
  client.user.setActivity('⚔️ Shadow War | $help', { type: 0 });
  scheduleReminders();
});

// ─── WELCOME NEW MEMBERS ──────────────────────────────────────────────────────
client.on('guildMemberAdd', member => {
  const channel = getChannel(member.guild, CONFIG.welcomeChannelName);
  if (!channel) return;

  const embed = zeusEmbed(
    'Welcome to Zeus Clan!',
    `⚡ Hail, **${member.user.username}**! You have entered the realm of Zeus.\n\n` +
    `🔱 We are a **Diablo Immortal** clan on the **SEA Bloodraven** server.\n\n` +
    `**Getting Started:**\n` +
    `• Check <#clan-rules> for clan rules\n` +
    `• Assign yourself roles with \`$roles\`\n` +
    `• Type \`$help\` to see all bot commands\n` +
    `• Join us for **Shadow War** every 🗓️ **Thursday & Saturday at 7:30 PM PHT**\n\n` +
    `May the lightning strike your enemies down! ⚡`,
    0x00BFFF
  ).setThumbnail(member.user.displayAvatarURL());

  channel.send({ embeds: [embed] });
});

// ─── SCHEDULED SHADOW WAR REMINDERS ─────────────────────────────────────────
function scheduleReminders() {
  const guilds = client.guilds.cache;

  // ── Monday 9:00 AM PHT — Sign-up reminder
  cron.schedule('0 9 * * 1', () => {
    guilds.forEach(guild => {
      const channel = getChannel(guild, CONFIG.shadowWarChannelName);
      if (!channel) return;
      const mention = getShadowWarMention(guild);
      const embed = zeusEmbed(
        'Shadow War Sign-Ups Are OPEN!',
        `${mention}\n\n` +
        `📋 **Sign-up window is now open!**\n\n` +
        `• Head to the **Shadows Hideout** in-game\n` +
        `• Register your name for this week's war\n` +
        `• Sign-ups close **Tuesday 9:00 PM** server time\n\n` +
        `⚔️ Battles: **Thursday & Saturday at 7:30 PM PHT**\n` +
        `🏆 Top 10 clans advance to Rite of Exile!\n\n` +
        `Don't miss your chance to fight for Zeus! ⚡`,
        0xFFD700
      );
      channel.send({ embeds: [embed] });
    });
  }, { timezone: TIMEZONE });

  // ── Thursday 7:00 PM PHT — 30-min warning
  cron.schedule('0 19 * * 4', () => {
    guilds.forEach(guild => sendShadowWarWarning(guild, 'Thursday'));
  }, { timezone: TIMEZONE });

  // ── Saturday 7:00 PM PHT — 30-min warning
  cron.schedule('0 19 * * 6', () => {
    guilds.forEach(guild => sendShadowWarWarning(guild, 'Saturday'));
  }, { timezone: TIMEZONE });

  // ── Thursday 7:25 PM PHT — 5-min warning
  cron.schedule('25 19 * * 4', () => {
    guilds.forEach(guild => sendShadowWarFinal(guild));
  }, { timezone: TIMEZONE });

  // ── Saturday 7:25 PM PHT — 5-min warning
  cron.schedule('25 19 * * 6', () => {
    guilds.forEach(guild => sendShadowWarFinal(guild));
  }, { timezone: TIMEZONE });

  // ── Sunday 7:30 PM PHT — Rite of Exile reminder
  cron.schedule('30 19 * * 0', () => {
    guilds.forEach(guild => {
      const channel = getChannel(guild, CONFIG.shadowWarChannelName);
      if (!channel) return;
      const mention = getShadowWarMention(guild);
      const embed = zeusEmbed(
        '👑 RITE OF EXILE — 30 Minutes!',
        `${mention}\n\n` +
        `🔥 **Rite of Exile begins in 30 minutes!**\n\n` +
        `This is it — the top 10 clans battle for the throne!\n` +
        `⏰ **Starts at 8:00 PM PHT**\n\n` +
        `Log in NOW and prepare. Zeus does not lose! ⚡`,
        0xFF4500
      );
      channel.send({ embeds: [embed] });
    });
  }, { timezone: TIMEZONE });

  // ── Weekly clan announcement — Friday 10:00 AM PHT
  cron.schedule('0 10 * * 5', () => {
    guilds.forEach(guild => {
      const channel = getChannel(guild, CONFIG.announcementChannelName);
      if (!channel) return;
      const now = moment().tz(TIMEZONE);
      const embed = zeusEmbed(
        `Weekly Clan Update — Week of ${now.format('MMM DD, YYYY')}`,
        `⚡ **Zeus Clan Weekly Reminder**\n\n` +
        `📅 **This Week's Schedule:**\n` +
        `• 🗡️ Shadow War: **Thursday & Saturday @ 7:30 PM PHT**\n` +
        `• 📋 Sign-ups open: **Monday – Tuesday 9 PM**\n` +
        `• 👑 Rite of Exile (if qualified): **Sunday @ 8:00 PM PHT**\n\n` +
        `💪 Stay active, stay strong. For Zeus! ⚡\n` +
        `Type \`$war\` anytime to see the next Shadow War time.`,
        0x9B59B6
      );
      channel.send({ embeds: [embed] });
    });
  }, { timezone: TIMEZONE });

  console.log('✅ All scheduled reminders are active.');
}

function sendShadowWarWarning(guild, day) {
  const channel = getChannel(guild, CONFIG.shadowWarChannelName);
  if (!channel) return;
  const mention = getShadowWarMention(guild);
  const embed = zeusEmbed(
    `⚔️ Shadow War in 30 Minutes! (${day})`,
    `${mention}\n\n` +
    `🚨 **Shadow War starts at 7:30 PM PHT — 30 minutes away!**\n\n` +
    `✅ **Pre-War Checklist:**\n` +
    `• Log into Diablo Immortal NOW\n` +
    `• Head to the Rite of Exile entrance\n` +
    `• Coordinate with your team leader\n` +
    `• High-level players → Main Battle\n` +
    `• Lower-level players → Support Battles\n\n` +
    `⚡ Zeus clan does not fall. Let's go! ⚡`,
    0xFF6600
  );
  channel.send({ embeds: [embed] });
}

function sendShadowWarFinal(guild) {
  const channel = getChannel(guild, CONFIG.shadowWarChannelName);
  if (!channel) return;
  const mention = getShadowWarMention(guild);
  const embed = zeusEmbed(
    '🔥 5 MINUTES TO SHADOW WAR!',
    `${mention}\n\n` +
    `⚡ **BATTLE BEGINS IN 5 MINUTES!** ⚡\n\n` +
    `🏹 All warriors to your positions!\n` +
    `Countdown starts NOW at the Rite of Exile entrance.\n\n` +
    `**FOR ZEUS! FOR GLORY! ⚡**`,
    0xFF0000
  );
  channel.send({ embeds: [embed] });
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // ── $help ────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const embed = zeusEmbed(
      'Zeus Bot Commands',
      `**⚔️ Shadow War**\n` +
      `\`$war\` — Next Shadow War countdown\n` +
      `\`$schedule\` — Full weekly schedule\n` +
      `\`$signup\` — Sign-up reminder info\n\n` +
      `**📢 Announcements**\n` +
      `\`$announce [message]\` — Post clan announcement (Admin)\n` +
      `\`$ping @role [message]\` — Ping a role with a message (Admin)\n\n` +
      `**🛡️ Moderation**\n` +
      `\`$kick @user [reason]\` — Kick a member (Mod)\n` +
      `\`$ban @user [reason]\` — Ban a member (Mod)\n` +
      `\`$mute @user [minutes]\` — Timeout a member (Mod)\n` +
      `\`$clear [amount]\` — Delete messages (Mod)\n` +
      `\`$warn @user [reason]\` — Warn a member (Mod)\n\n` +
      `**🎵 Music**\n` +
      `\`$play [YouTube URL]\` — Play audio in voice channel\n` +
      `\`$stop\` — Stop music\n` +
      `\`$skip\` — Skip current track\n\n` +
      `**🎮 Fun**\n` +
      `\`$roll [sides]\` — Roll a dice (default: d20)\n` +
      `\`$flip\` — Flip a coin\n` +
      `\`$trivia\` — DI trivia question\n` +
      `\`$8ball [question]\` — Ask the magic 8-ball\n` +
      `\`$rank\` — Show your Zeus clan rank\n\n` +
      `**⚙️ Roles**\n` +
      `\`$roles\` — List self-assignable roles\n` +
      `\`$giverole @user [role]\` — Assign role (Admin)\n`
    );
    return message.reply({ embeds: [embed] });
  }

  // ── $war ─────────────────────────────────────────────────────────────────
  if (command === 'war') {
    const now = moment().tz(TIMEZONE);
    const dayOfWeek = now.day(); // 0=Sun, 1=Mon...4=Thu, 6=Sat
    const hour = now.hour();
    const minute = now.minute();

    // Find next war day (Thursday=4 or Saturday=6)
    let daysUntil = null;
    let nextWarDay = null;
    for (let i = 1; i <= 7; i++) {
      const checkDay = (dayOfWeek + i) % 7;
      if (checkDay === 4 || checkDay === 6) {
        daysUntil = i;
        nextWarDay = checkDay === 4 ? 'Thursday' : 'Saturday';
        break;
      }
    }
    // If today is war day and before 7:30 PM
    if ((dayOfWeek === 4 || dayOfWeek === 6) && (hour < 19 || (hour === 19 && minute < 30))) {
      daysUntil = 0;
      nextWarDay = dayOfWeek === 4 ? 'Thursday' : 'Saturday';
    }

    const warTime = moment().tz(TIMEZONE).day(dayOfWeek + daysUntil).hour(19).minute(30).second(0);
    const diffMins = warTime.diff(now, 'minutes');
    const hours = Math.floor(diffMins / 60);
    const mins = diffMins % 60;

    const embed = zeusEmbed(
      '⚔️ Next Shadow War',
      `📅 **${nextWarDay}** at **7:30 PM PHT**\n\n` +
      `⏱️ **Time remaining:** ${daysUntil === 0 ? `${hours}h ${mins}m` : `${daysUntil} day(s), ${hours % 24}h ${mins}m`}\n\n` +
      `📍 Meet at the **Rite of Exile entrance**\n` +
      `🔔 30-min warning will be posted in <#shadow-war-alerts>\n\n` +
      `⚡ Get ready, Zeus warriors!`
    );
    return message.reply({ embeds: [embed] });
  }

  // ── $schedule ────────────────────────────────────────────────────────────
  if (command === 'schedule') {
    const embed = zeusEmbed(
      'Zeus Clan Weekly Schedule',
      `🗓️ **All times in PHT (Philippine Time)**\n\n` +
      `**Monday**\n` +
      `• 📋 Shadow War sign-ups OPEN (9:00 AM)\n\n` +
      `**Tuesday**\n` +
      `• ⛔ Sign-ups CLOSE (9:00 PM)\n\n` +
      `**Thursday**\n` +
      `• ⚔️ Shadow War Battle (7:30 PM)\n` +
      `• 🚨 30-min warning posted at 7:00 PM\n\n` +
      `**Saturday**\n` +
      `• ⚔️ Shadow War Battle (7:30 PM)\n` +
      `• 🚨 30-min warning posted at 7:00 PM\n\n` +
      `**Sunday**\n` +
      `• 👑 Rite of Exile (8:00 PM — if qualified)\n\n` +
      `**Every Friday**\n` +
      `• 📢 Weekly clan update posted at 10:00 AM`
    );
    return message.reply({ embeds: [embed] });
  }

  // ── $signup ──────────────────────────────────────────────────────────────
  if (command === 'signup') {
    const embed = zeusEmbed(
      'Shadow War Sign-Up Guide',
      `📋 **How to Sign Up for Shadow War:**\n\n` +
      `1️⃣ Open Diablo Immortal\n` +
      `2️⃣ Go to the **Shadows Hideout**\n` +
      `3️⃣ Look for the **Shadow War** sign-up option\n` +
      `4️⃣ Register before **Tuesday 9:00 PM** server time\n\n` +
      `⚠️ **Requirements:**\n` +
      `• Must be in the **Shadows faction**\n` +
      `• Must be in a **Dark Clan** (Zeus)\n` +
      `• Clan needs minimum **30 members** signed\n` +
      `• Level 43+ required\n\n` +
      `⚡ Sign up early — Zeus marches together!`
    );
    return message.reply({ embeds: [embed] });
  }

  // ── $announce ────────────────────────────────────────────────────────────
  if (command === 'announce') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ You need **Manage Messages** permission to post announcements.');
    }
    const text = args.join(' ');
    if (!text) return message.reply('❌ Usage: `$announce [your message]`');
    const channel = getChannel(message.guild, CONFIG.announcementChannelName);
    if (!channel) return message.reply('❌ Could not find `#clan-announcements` channel.');
    const embed = zeusEmbed('📢 Clan Announcement', text, 0x00BFFF);
    channel.send({ embeds: [embed] });
    return message.reply('✅ Announcement posted!');
  }

  // ── $ping ────────────────────────────────────────────────────────────────
  if (command === 'ping') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ You need **Manage Messages** permission.');
    }
    const roleMention = args.shift();
    const text = args.join(' ');
    if (!roleMention || !text) return message.reply('❌ Usage: `$ping @role [message]`');
    const channel = getChannel(message.guild, CONFIG.announcementChannelName);
    if (!channel) return message.reply('❌ Could not find `#clan-announcements` channel.');
    channel.send({ content: roleMention, embeds: [zeusEmbed('📣 Announcement', text)] });
    return message.reply('✅ Role pinged!');
  }

  // ── $kick ────────────────────────────────────────────────────────────────
  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionFlagsBits.KickMembers)) {
      return message.reply('❌ You need **Kick Members** permission.');
    }
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$kick @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.kick(reason);
    const logChannel = getChannel(message.guild, CONFIG.modLogChannelName);
    const embed = zeusEmbed('🦶 Member Kicked', `**User:** ${target.user.tag}\n**Reason:** ${reason}\n**By:** ${message.author.tag}`, 0xFF6600);
    if (logChannel) logChannel.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $ban ─────────────────────────────────────────────────────────────────
  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionFlagsBits.BanMembers)) {
      return message.reply('❌ You need **Ban Members** permission.');
    }
    const target = message.mentions.members.first();
    if (!target) return message.reply('❌ Usage: `$ban @user [reason]`');
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.ban({ reason });
    const logChannel = getChannel(message.guild, CONFIG.modLogChannelName);
    const embed = zeusEmbed('🔨 Member Banned', `**User:** ${target.user.tag}\n**Reason:** ${reason}\n**By:** ${message.author.tag}`, 0xFF0000);
    if (logChannel) logChannel.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $mute (timeout) ──────────────────────────────────────────────────────
  if (command === 'mute') {
    if (!message.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      return message.reply('❌ You need **Moderate Members** permission.');
    }
    const target = message.mentions.members.first();
    const minutes = parseInt(args[1]) || 10;
    if (!target) return message.reply('❌ Usage: `$mute @user [minutes]`');
    await target.timeout(minutes * 60 * 1000, `Muted by ${message.author.tag}`);
    const embed = zeusEmbed('🔇 Member Muted', `**User:** ${target.user.tag}\n**Duration:** ${minutes} minute(s)\n**By:** ${message.author.tag}`, 0xFFA500);
    const logChannel = getChannel(message.guild, CONFIG.modLogChannelName);
    if (logChannel) logChannel.send({ embeds: [embed] });
    return message.reply({ embeds: [embed] });
  }

  // ── $clear ───────────────────────────────────────────────────────────────
  if (command === 'clear') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ You need **Manage Messages** permission.');
    }
    const amount = Math.min(parseInt(args[0]) || 5, 100);
    await message.channel.bulkDelete(amount + 1, true);
    const reply = await message.channel.send(`✅ Deleted **${amount}** messages.`);
    setTimeout(() => reply.delete().catch(() => {}), 3000);
  }

  // ── $warn ─────────────────────────────────────────────────────────────────
  if (command === 'warn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
      return message.reply('❌ You need **Manage Messages** permission.');
    }
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target) return message.reply('❌ Usage: `$warn @user [reason]`');
    const embed = zeusEmbed('⚠️ Warning Issued', `**User:** ${target.user.tag}\n**Reason:** ${reason}\n**By:** ${message.author.tag}`, 0xFFFF00);
    const logChannel = getChannel(message.guild, CONFIG.modLogChannelName);
    if (logChannel) logChannel.send({ embeds: [embed] });
    try { await target.send({ embeds: [zeusEmbed('⚠️ You have been warned in Zeus Clan', `**Reason:** ${reason}`)] }); } catch {}
    return message.reply({ embeds: [embed] });
  }

  // ── $roll ─────────────────────────────────────────────────────────────────
  if (command === 'roll') {
    const sides = parseInt(args[0]) || 20;
    const result = Math.floor(Math.random() * sides) + 1;
    const embed = zeusEmbed('🎲 Dice Roll', `**${message.author.username}** rolled a **d${sides}**\n\n# ${result} / ${sides}`, 0x9B59B6);
    return message.reply({ embeds: [embed] });
  }

  // ── $flip ─────────────────────────────────────────────────────────────────
  if (command === 'flip') {
    const result = Math.random() < 0.5 ? '🪙 Heads' : '🪙 Tails';
    return message.reply({ embeds: [zeusEmbed('Coin Flip', `**${message.author.username}** flipped: **${result}**`)] });
  }

  // ── $8ball ────────────────────────────────────────────────────────────────
  if (command === '8ball') {
    const responses = [
      '✅ It is certain.', '✅ Without a doubt.', '✅ Yes, definitely.',
      '✅ You may rely on it.', '✅ Most likely.', '🤔 Ask again later.',
      '🤔 Cannot predict now.', '🤔 Concentrate and ask again.',
      '❌ Don\'t count on it.', '❌ My reply is no.', '❌ Very doubtful.',
      '⚡ Zeus says YES.', '⚡ Zeus says NO.', '⚡ The lightning is unclear.'
    ];
    const question = args.join(' ');
    if (!question) return message.reply('❌ Usage: `$8ball [your question]`');
    const answer = responses[Math.floor(Math.random() * responses.length)];
    const embed = zeusEmbed('🎱 Magic 8-Ball', `**Q:** ${question}\n\n**A:** ${answer}`);
    return message.reply({ embeds: [embed] });
  }

  // ── $trivia ───────────────────────────────────────────────────────────────
  if (command === 'trivia') {
    if (activeTriviaQuestion) {
      return message.reply('❌ A trivia question is already active! Answer it first.');
    }
    const q = triviaQuestions[Math.floor(Math.random() * triviaQuestions.length)];
    activeTriviaQuestion = { answer: q.a, channelId: message.channel.id };
    const embed = zeusEmbed(
      '🎮 Diablo Immortal Trivia!',
      `❓ **${q.q}**\n\nType your answer in chat! You have **30 seconds**.\nFirst correct answer wins! ⚡`
    );
    message.channel.send({ embeds: [embed] });

    setTimeout(() => {
      if (activeTriviaQuestion && activeTriviaQuestion.channelId === message.channel.id) {
        activeTriviaQuestion = null;
        message.channel.send({ embeds: [zeusEmbed('⏰ Time\'s Up!', `Nobody got it! The answer was: **${q.a}**`, 0xFF6600)] });
      }
    }, 30000);
    return;
  }

  // ── $rank ─────────────────────────────────────────────────────────────────
  if (command === 'rank') {
    const roles = message.member.roles.cache
      .filter(r => r.name !== '@everyone')
      .map(r => r.name)
      .join(', ') || 'No roles';
    const joinedDate = moment(message.member.joinedAt).tz(TIMEZONE).format('MMM DD, YYYY');
    const embed = zeusEmbed(
      `${message.author.username}'s Zeus Profile`,
      `⚡ **Clan:** Zeus\n` +
      `🎮 **Server:** SEA Bloodraven\n` +
      `📅 **Joined:** ${joinedDate}\n` +
      `🏷️ **Roles:** ${roles}`
    ).setThumbnail(message.author.displayAvatarURL());
    return message.reply({ embeds: [embed] });
  }

  // ── $roles ────────────────────────────────────────────────────────────────
  if (command === 'roles') {
    const embed = zeusEmbed(
      'Self-Assignable Roles',
      `Ask an admin to assign you these roles:\n\n` +
      `⚔️ \`shadow war\` — Get Shadow War reminders\n` +
      `🎵 \`music\` — Music channel access\n` +
      `📢 \`announcements\` — Clan announcement pings\n` +
      `🆕 \`recruit\` — New member tag\n\n` +
      `Contact a **Clan Officer** to assign your role.`
    );
    return message.reply({ embeds: [embed] });
  }

  // ── $giverole ─────────────────────────────────────────────────────────────
  if (command === 'giverole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return message.reply('❌ You need **Manage Roles** permission.');
    }
    const target = message.mentions.members.first();
    const roleName = args.slice(1).join(' ');
    if (!target || !roleName) return message.reply('❌ Usage: `$giverole @user [role name]`');
    const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!role) return message.reply(`❌ Role \`${roleName}\` not found.`);
    await target.roles.add(role);
    return message.reply({ embeds: [zeusEmbed('✅ Role Assigned', `Gave **${role.name}** to **${target.user.tag}**`)] });
  }

  // ── $play ─────────────────────────────────────────────────────────────────
  if (command === 'play') {
    const embed = zeusEmbed(
      '🎵 Music Feature',
      `Music playback requires the bot to be **hosted on your own server** with audio libraries installed.\n\n` +
      `**Setup Instructions:**\n` +
      `1. Follow the hosting guide in \`SETUP.md\`\n` +
      `2. Install: \`npm install @discordjs/voice ytdl-core\`\n` +
      `3. Join a voice channel and use \`$play [YouTube URL]\`\n\n` +
      `This feature is ready to wire up once Zeus Bot is hosted! ⚡`,
      0x1DB954
    );
    return message.reply({ embeds: [embed] });
  }
});

// ─── TRIVIA ANSWER LISTENER ───────────────────────────────────────────────────
client.on('messageCreate', message => {
  if (message.author.bot) return;
  if (!activeTriviaQuestion) return;
  if (message.channel.id !== activeTriviaQuestion.channelId) return;

  const userAnswer = message.content.toLowerCase().trim();
  const correctAnswer = activeTriviaQuestion.answer.toLowerCase();

  if (userAnswer.includes(correctAnswer)) {
    activeTriviaQuestion = null;
    message.reply({ embeds: [zeusEmbed('🎉 Correct!', `**${message.author.username}** got it right!\n\nAnswer: **${correctAnswer}**\n\n⚡ Zeus is proud!`, 0x00FF00)] });
  }
});

// ─── ERROR HANDLING ───────────────────────────────────────────────────────────
client.on('error', err => console.error('Zeus Bot Error:', err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// ─── LOGIN ────────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('❌ ERROR: DISCORD_TOKEN not set in .env file!');
  console.error('Create a .env file with: DISCORD_TOKEN=your_bot_token_here');
  process.exit(1);
}

client.login(TOKEN);
