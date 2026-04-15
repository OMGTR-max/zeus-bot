// ⚡ ZEUS BOT — Stats Tracker Module v3
// Fixes: session timeout | confirmation step | correct step order (CR after Resonance)
// New: Zeus-themed embeds | pagination for 98+ members | officer $updatestats @user
// Sheet: Zeus | A:No. B:Name C:Class D:Resonance E:CR F:Armor G:ArmorPen H:Potency I:Resistance J:DiscordID K:LastUpdated

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = require('discord.js');
const { google } = require('googleapis');

// ─── SHEET CONFIG ─────────────────────────────────────────────────────────────
const SHEET_ID   = '1nZz5j4b_g0kihZDFINmUOeK_i1Sb15AwyOAC3MmHR60';
const SHEET_TAB  = 'Zeus';
const DATA_RANGE = `${SHEET_TAB}!A:K`; // now includes LastUpdated in K

const COL = {
  NO:          1,  // A
  NAME:        2,  // B
  CLASS:       3,  // C
  RESONANCE:   4,  // D
  CR:          5,  // E
  ARMOR:       6,  // F
  ARMOR_PEN:   7,  // G
  POTENCY:     8,  // H
  RESISTANCE:  9,  // I
  DISCORD_ID:  10, // J
  LAST_UPDATED:11, // K ← new: timestamp of last stat update
};

const PAGE_SIZE      = 15;  // members per roster page
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes in ms

// ─── ZEUS THEME ───────────────────────────────────────────────────────────────
const THEME = {
  gold:    0xFFD700,
  purple:  0x9B59B6,
  red:     0xFF0000,
  orange:  0xFF6600,
  green:   0x00C853,
  blue:    0x00BFFF,
  dark:    0x2C2F33,
  // Zeus lightning bolt banner — hosted image
  // Replace this URL with your own banner if you want a custom one
  // Recommended size: 1024x256px, dark background with gold lightning
  bannerUrl: 'https://i.imgur.com/ZEUS_BANNER_PLACEHOLDER.png',
  footer:  'Zeus Clan ⚡ SEA Bloodraven | Diablo Immortal',
  icon:    '⚡',
};

// Class emojis for visual flair
const CLASS_EMOJI = {
  'Barbarian':    '🪓',
  'Crusader':     '🛡️',
  'Demon Hunter': '🏹',
  'Monk':         '👊',
  'Necromancer':  '💀',
  'Wizard':       '🔮',
  'Blood Knight': '🩸',
  'Tempest':      '🌪️',
};

// ─── VALID CLASSES ────────────────────────────────────────────────────────────
const VALID_CLASSES = [
  'Barbarian', 'Crusader', 'Demon Hunter', 'Monk',
  'Necromancer', 'Wizard', 'Blood Knight', 'Tempest',
];

// ─── ACTIVE SESSIONS ──────────────────────────────────────────────────────────
// Key: userId → { step, data, userId, name, guildId, timeoutHandle, confirmPending }
const activeSessions = new Map();

// Pagination state for $roster
// Key: messageId → { members, page, filterClass, requesterId }
const rosterPages = new Map();

// ─── FORM STEPS (reordered to match game UI) ─────────────────────────────────
// Order: Class → Resonance → CR → Armor → ArmorPen → Potency → Resistance
const STEPS = [
  {
    key:   'class',
    label: 'Class',
    emoji: '🎮',
    prompt:
      `What is your current class?\n\n` +
      `${VALID_CLASSES.map((c, i) => `${CLASS_EMOJI[c] || '•'} \`${i + 1}.\` **${c}**`).join('\n')}\n\n` +
      `Type the **class name** or its **number**:`,
    validate(val) {
      const num = parseInt(val);
      if (num >= 1 && num <= VALID_CLASSES.length) return VALID_CLASSES[num - 1];
      return VALID_CLASSES.find(c => c.toLowerCase() === val.toLowerCase()) || null;
    },
    errorMsg:
      `❌ Invalid class! Type the name or number:\n` +
      VALID_CLASSES.map((c, i) => `${CLASS_EMOJI[c]} \`${i + 1}.\` ${c}`).join('\n'),
  },
  {
    key:      'resonance',
    label:    'Resonance',
    emoji:    '💎',
    prompt:   `What is your current **Resonance**?\n\n*Example: \`15000\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`15000\`)`,
  },
  {
    key:      'cr',
    label:    'Combat Rating',
    emoji:    '⚡',
    prompt:   `What is your current **Combat Rating (CR)**?\n\n*Example: \`5800\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`5800\`)`,
  },
  {
    key:      'armor',
    label:    'Armor',
    emoji:    '🛡️',
    prompt:   `What is your current **Armor** value?\n\n*Example: \`45000\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`45000\`)`,
  },
  {
    key:      'armorPen',
    label:    'Armor Penetration',
    emoji:    '⚔️',
    prompt:   `What is your current **Armor Penetration** value?\n\n*Example: \`1200\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`1200\`)`,
  },
  {
    key:      'potency',
    label:    'Potency',
    emoji:    '✨',
    prompt:   `What is your current **Potency** value?\n\n*Example: \`900\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`900\`)`,
  },
  {
    key:      'resistance',
    label:    'Resistance',
    emoji:    '🔮',
    prompt:   `What is your current **Resistance** value?\n\n*Example: \`700\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter numbers only (e.g. \`700\`)`,
  },
];

function numValidator(val) {
  const n = parseInt(val.toString().replace(/,/g, '').replace(/\./g, ''));
  return (!isNaN(n) && n >= 0) ? n : null;
}

// ─── EMBED BUILDERS ───────────────────────────────────────────────────────────

function zeusEmbed(title, description, color = THEME.gold) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${THEME.icon} ${title}`)
    .setDescription(description)
    .setFooter({ text: THEME.footer })
    .setTimestamp();
}

function formStepEmbed(session, step) {
  const total    = STEPS.length;
  const current  = session.step + 1;
  const barFill  = '█'.repeat(current);
  const barEmpty = '░'.repeat(total - current);

  return new EmbedBuilder()
    .setColor(THEME.purple)
    .setAuthor({ name: `⚡ Zeus Clan — Stat Update Form` })
    .setTitle(`${step.emoji} Step ${current}/${total} — ${step.label}`)
    .setDescription(
      `**Progress:** \`[${barFill}${barEmpty}]\` ${current}/${total}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      step.prompt +
      `\n\n━━━━━━━━━━━━━━━━━━━━━━━━`
    )
    .setFooter({ text: 'Type your answer below  •  Type "cancel" to stop  •  Type "back" to redo previous' })
    .setTimestamp();
}

function confirmEmbed(session) {
  const d = session.data;
  const cls = d.class || '?';
  return new EmbedBuilder()
    .setColor(THEME.orange)
    .setAuthor({ name: '⚡ Zeus Clan — Confirm Your Stats' })
    .setTitle(`${CLASS_EMOJI[cls] || '🎮'} Review Before Saving`)
    .setDescription(
      `**${session.name}**, please check your stats below.\n` +
      `If everything looks correct, type \`confirm\`.\n` +
      `To start over, type \`restart\`.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🎮 **Class:** ${cls}\n` +
      `💎 **Resonance:** ${Number(d.resonance).toLocaleString()}\n` +
      `⚡ **Combat Rating:** ${Number(d.cr).toLocaleString()}\n` +
      `🛡️ **Armor:** ${Number(d.armor).toLocaleString()}\n` +
      `⚔️ **Armor Pen:** ${Number(d.armorPen).toLocaleString()}\n` +
      `✨ **Potency:** ${Number(d.potency).toLocaleString()}\n` +
      `🔮 **Resistance:** ${Number(d.resistance).toLocaleString()}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Type \`confirm\` to save  •  \`restart\` to start over`
    )
    .setFooter({ text: THEME.footer })
    .setTimestamp();
}

function successEmbed(session, isUpdate) {
  const d   = session.data;
  const cls = d.class || '?';
  return new EmbedBuilder()
    .setColor(THEME.green)
    .setAuthor({ name: '⚡ Zeus Clan — Stats Saved!' })
    .setTitle(`✅ ${isUpdate ? 'Stats Updated!' : 'Welcome to the Roster!'}`)
    .setDescription(
      `Your stats are now live on the **Zeus Clan roster**! 🔱\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${CLASS_EMOJI[cls] || '🎮'} **Class:** ${cls}\n` +
      `💎 **Resonance:** ${Number(d.resonance).toLocaleString()}\n` +
      `⚡ **Combat Rating:** ${Number(d.cr).toLocaleString()}\n` +
      `🛡️ **Armor:** ${Number(d.armor).toLocaleString()}\n` +
      `⚔️ **Armor Pen:** ${Number(d.armorPen).toLocaleString()}\n` +
      `✨ **Potency:** ${Number(d.potency).toLocaleString()}\n` +
      `🔮 **Resistance:** ${Number(d.resistance).toLocaleString()}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${isUpdate ? '🔄 Entry updated!' : '🆕 Added to roster!'} Use \`$mystats\` to check anytime.\n\n` +
      `For Zeus! ⚡🔱`
    )
    .setFooter({ text: THEME.footer })
    .setTimestamp();
}

// ─── GOOGLE AUTH ──────────────────────────────────────────────────────────────
function getGoogleAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS not set in Railway environment variables!');
  }
  return new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getGoogleAuth() });
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────
async function getAllRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         DATA_RANGE,
  });
  return res.data.values || [];
}

function findRowByDiscordId(rows, userId, displayName) {
  // Primary: match by Discord ID (column J)
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][COL.DISCORD_ID - 1] || '').trim() === userId) {
      return { rowIndex: i + 1, rowData: rows[i] };
    }
  }
  // Fallback: name match for pre-existing rows without an ID
  if (displayName) {
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][COL.NAME - 1] || '').toLowerCase().trim() === displayName.toLowerCase().trim()) {
        return { rowIndex: i + 1, rowData: rows[i], needsIdBackfill: true };
      }
    }
  }
  return null;
}

async function updateRow(sheets, rowIndex, displayName, userId, data) {
  const now = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SHEET_ID,
    range:            `${SHEET_TAB}!B${rowIndex}:K${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        displayName,     // B
        data.class,      // C
        data.resonance,  // D
        data.cr,         // E
        data.armor,      // F
        data.armorPen,   // G
        data.potency,    // H
        data.resistance, // I
        userId,          // J
        now,             // K — LastUpdated
      ]],
    },
  });
}

async function addRow(sheets, rows, displayName, userId, data) {
  const now = new Date().toLocaleDateString('en-PH', {
    timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId:    SHEET_ID,
    range:            DATA_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        rows.length,     // A — No.
        displayName,     // B
        data.class,      // C
        data.resonance,  // D
        data.cr,         // E
        data.armor,      // F
        data.armorPen,   // G
        data.potency,    // H
        data.resistance, // I
        userId,          // J
        now,             // K
      ]],
    },
  });
}

// ─── SESSION TIMEOUT ──────────────────────────────────────────────────────────
function clearSessionTimeout(userId) {
  const session = activeSessions.get(userId);
  if (session?.timeoutHandle) clearTimeout(session.timeoutHandle);
}

function resetSessionTimeout(userId, user) {
  clearSessionTimeout(userId);
  const handle = setTimeout(async () => {
    if (activeSessions.has(userId)) {
      activeSessions.delete(userId);
      try {
        await user.send({ embeds: [zeusEmbed(
          '⏰ Session Timed Out',
          `Your stat update session expired after **10 minutes** of inactivity.\n\n` +
          `Use \`$updatestats\` in the server to start again. ⚡`,
          THEME.orange
        )]});
      } catch {}
    }
  }, SESSION_TIMEOUT);

  const session = activeSessions.get(userId);
  if (session) session.timeoutHandle = handle;
}

// ─── START STAT FORM ──────────────────────────────────────────────────────────
async function startStatForm(member, triggerChannel) {
  const userId = member.user.id;

  // Clear any existing session
  clearSessionTimeout(userId);
  activeSessions.delete(userId);

  activeSessions.set(userId, {
    step:           0,
    data:           {},
    userId,
    name:           member.displayName || member.user.username,
    guildId:        member.guild.id,
    confirmPending: false,
    timeoutHandle:  null,
    triggerChannelId: triggerChannel?.id || null,
  });

  try {
    // Welcome DM
    await member.send({ embeds: [new EmbedBuilder()
      .setColor(THEME.gold)
      .setAuthor({ name: '⚡ Zeus Clan — Stat Update Form' })
      .setTitle(`Welcome, ${member.displayName}! Let's update your stats. 💪`)
      .setDescription(
        `I'll ask you **7 quick questions** one at a time.\n` +
        `Just type your answer after each prompt.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎮 Class  💎 Resonance  ⚡ Combat Rating\n` +
        `🛡️ Armor  ⚔️ Armor Pen  ✨ Potency  🔮 Resistance\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Useful commands during the form:**\n` +
        `• \`back\` — redo the previous question\n` +
        `• \`cancel\` — stop and discard\n` +
        `• \`confirm\` / \`restart\` — at the review step\n\n` +
        `Starting now! ⚡`
      )
      .setFooter({ text: THEME.footer })
      .setTimestamp()
    ]});

    await sendNextStep(member.user, userId);
    resetSessionTimeout(userId, member.user);

  } catch {
    activeSessions.delete(userId);
    triggerChannel?.send(
      `> ⚠️ **${member.displayName}** — I couldn't DM you!\n` +
      `> Please enable **Allow direct messages from server members** in your Privacy Settings, then run \`$updatestats\` again.`
    );
  }
}

// ─── SEND NEXT STEP ───────────────────────────────────────────────────────────
async function sendNextStep(user, userId) {
  const session = activeSessions.get(userId);
  if (!session) return;
  const step = STEPS[session.step];
  await user.send({ embeds: [formStepEmbed(session, step)] });
}

// ─── HANDLE DM RESPONSE ───────────────────────────────────────────────────────
async function handleStatDMResponse(message) {
  const userId  = message.author.id;
  const session = activeSessions.get(userId);
  if (!session) return false;

  const input = message.content.trim();
  resetSessionTimeout(userId, message.author); // reset timeout on any activity

  // ── Confirmation step ────────────────────────────────────────────────────
  if (session.confirmPending) {
    if (input.toLowerCase() === 'confirm') {
      session.confirmPending = false;
      clearSessionTimeout(userId);
      activeSessions.delete(userId);
      await saveToSheet(message, session);

    } else if (input.toLowerCase() === 'restart') {
      session.confirmPending = false;
      session.step           = 0;
      session.data           = {};
      await message.reply({ embeds: [zeusEmbed(
        '🔄 Starting Over',
        `No problem! Let\'s go through the questions again. ⚡`,
        THEME.orange
      )]});
      await sendNextStep(message.author, userId);

    } else {
      await message.reply({ embeds: [zeusEmbed(
        '⚠️ Waiting for Confirmation',
        `Please type \`confirm\` to save or \`restart\` to start over.`,
        THEME.red
      )]});
    }
    return true;
  }

  // ── Cancel ───────────────────────────────────────────────────────────────
  if (input.toLowerCase() === 'cancel') {
    clearSessionTimeout(userId);
    activeSessions.delete(userId);
    await message.reply({ embeds: [zeusEmbed(
      '❌ Stat Update Cancelled',
      `No problem! Use \`$updatestats\` in the server anytime to try again. ⚡`,
      THEME.orange
    )]});
    return true;
  }

  // ── Back (redo previous step) ─────────────────────────────────────────────
  if (input.toLowerCase() === 'back') {
    if (session.step === 0) {
      await message.reply({ embeds: [zeusEmbed(
        '⚠️ Already at First Step',
        `You\'re already on the first question! Type \`cancel\` to stop.`,
        THEME.orange
      )]});
    } else {
      session.step--;
      const prevKey = STEPS[session.step].key;
      delete session.data[prevKey];
      await message.reply({ embeds: [zeusEmbed(
        '↩️ Going Back',
        `Re-asking the previous question...`,
        THEME.purple
      )]});
      await sendNextStep(message.author, userId);
    }
    return true;
  }

  // ── Validate current step ────────────────────────────────────────────────
  const step      = STEPS[session.step];
  const validated = step.validate(input);

  if (validated === null) {
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor(THEME.red)
      .setTitle('⚠️ Invalid Input')
      .setDescription(`${step.errorMsg}\n\nPlease try again:`)
      .setFooter({ text: 'Type "cancel" to stop' })
    ]});
    return true;
  }

  // ── Save step and advance ─────────────────────────────────────────────────
  session.data[step.key] = validated;
  session.step++;

  // More steps
  if (session.step < STEPS.length) {
    await sendNextStep(message.author, userId);
    return true;
  }

  // ── All steps done — show confirmation ───────────────────────────────────
  session.confirmPending = true;
  await message.author.send({ embeds: [confirmEmbed(session)] });
  return true;
}

// ─── SAVE TO GOOGLE SHEET ─────────────────────────────────────────────────────
async function saveToSheet(message, session) {
  await message.author.send({ embeds: [zeusEmbed(
    '⏳ Saving your stats...',
    `Syncing to the Zeus Clan Google Sheet. One moment! ⚡`,
    THEME.gold
  )]});

  try {
    const sheets  = await getSheetsClient();
    const allRows = await getAllRows(sheets);
    const found   = findRowByDiscordId(allRows, session.userId, session.name);

    if (found) {
      await updateRow(sheets, found.rowIndex, session.name, session.userId, session.data);
    } else {
      await addRow(sheets, allRows, session.name, session.userId, session.data);
    }

    await message.author.send({ embeds: [successEmbed(session, !!found)] });

  } catch (err) {
    console.error('Sheet sync error:', err.message);
    await message.author.send({ embeds: [new EmbedBuilder()
      .setColor(THEME.red)
      .setTitle('❌ Sync Failed — Screenshot This!')
      .setDescription(
        `Couldn\'t save to the sheet. Screenshot this and send to an officer!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**${session.name}\'s Stats:**\n` +
        `Class: ${session.data.class} | Resonance: ${session.data.resonance}\n` +
        `CR: ${session.data.cr} | Armor: ${session.data.armor}\n` +
        `Armor Pen: ${session.data.armorPen} | Potency: ${session.data.potency}\n` +
        `Resistance: ${session.data.resistance}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Error:** \`${err.message}\``
      )
      .setFooter({ text: THEME.footer })
    ]});
  }
}

// ─── BUILD ROSTER PAGE ────────────────────────────────────────────────────────
function buildRosterPage(members, page, filterClass, totalCount) {
  const totalPages = Math.ceil(members.length / PAGE_SIZE);
  const start      = page * PAGE_SIZE;
  const pageData   = members.slice(start, start + PAGE_SIZE);

  const header  = `${'#'.padStart(2)} ${'Name'.padEnd(16)} ${'Class'.padEnd(13)} ${'Res'.padStart(7)} ${'CR'.padStart(6)} ${'Armor'.padStart(7)}`;
  const divider = '─'.repeat(55);
  const body    = pageData.map((r, i) => {
    const rank  = (start + i + 1).toString().padStart(2);
    const name  = (r[COL.NAME - 1]      || '?').slice(0, 15).padEnd(16);
    const cls   = (r[COL.CLASS - 1]     || '?').slice(0, 12).padEnd(13);
    const res   = (r[COL.RESONANCE - 1] || '-').toString().padStart(7);
    const cr    = (r[COL.CR - 1]        || '-').toString().padStart(6);
    const armor = (r[COL.ARMOR - 1]     || '-').toString().padStart(7);
    return `${rank} ${name} ${cls} ${res} ${cr} ${armor}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setColor(THEME.gold)
    .setAuthor({ name: '⚡ Zeus Clan — SEA Bloodraven' })
    .setTitle(`🔱 Zeus Clan Roster${filterClass ? ` — ${filterClass}` : ''}`)
    .setDescription(
      `**${totalCount} warrior(s)** | Sorted by Resonance | Page **${page + 1}/${totalPages}**\n\n` +
      `\`\`\`\n${header}\n${divider}\n${body}\n\`\`\``
    )
    .setFooter({ text: `${THEME.footer}  •  Use $updatestats to update your entry` })
    .setTimestamp();

  return { embed, totalPages };
}

function buildRosterButtons(page, totalPages) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('roster_prev')
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId('roster_page')
      .setLabel(`Page ${page + 1} / ${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('roster_next')
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
}

// ─── $roster COMMAND ──────────────────────────────────────────────────────────
async function showRoster(message, filterClass = null) {
  try {
    const sheets = await getSheetsClient();
    const rows   = await getAllRows(sheets);

    if (rows.length <= 1) {
      return message.reply('📋 The roster is empty! Members can use `$updatestats` to add their stats.');
    }

    let members = rows.slice(1).filter(r => r[COL.NAME - 1]);

    if (filterClass) {
      members = members.filter(r =>
        (r[COL.CLASS - 1] || '').toLowerCase().includes(filterClass.toLowerCase())
      );
    }

    if (members.length === 0) {
      return message.reply(`📋 No members found${filterClass ? ` with class **${filterClass}**` : ''}.`);
    }

    // Sort by Resonance descending
    members.sort((a, b) => {
      const parse = r => parseInt((r[COL.RESONANCE - 1] || '0').toString().replace(/,/g, '')) || 0;
      return parse(b) - parse(a);
    });

    const page = 0;
    const { embed, totalPages } = buildRosterPage(members, page, filterClass, members.length);

    // Only add buttons if more than one page
    const components = totalPages > 1 ? [buildRosterButtons(page, totalPages)] : [];
    const sent = await message.reply({ embeds: [embed], components });

    if (totalPages > 1) {
      // Store pagination state keyed by the sent message ID
      rosterPages.set(sent.id, {
        members,
        page,
        filterClass,
        requesterId: message.author.id,
      });

      // Auto-cleanup after 5 minutes
      setTimeout(() => {
        rosterPages.delete(sent.id);
        sent.edit({ components: [] }).catch(() => {});
      }, 5 * 60 * 1000);
    }

  } catch (err) {
    console.error('Roster error:', err.message);
    message.reply(`❌ Couldn\'t fetch the roster.\n**Error:** ${err.message}`);
  }
}

// ─── ROSTER PAGINATION BUTTONS ────────────────────────────────────────────────
async function handleRosterButton(interaction) {
  if (!interaction.isButton()) return false;
  if (!['roster_prev', 'roster_next'].includes(interaction.customId)) return false;

  const state = rosterPages.get(interaction.message.id);
  if (!state) {
    await interaction.reply({ content: '⌛ This roster has expired. Run `$roster` again.', ephemeral: true });
    return true;
  }

  // Any member can paginate (not just the requester)
  const newPage    = interaction.customId === 'roster_next' ? state.page + 1 : state.page - 1;
  const totalPages = Math.ceil(state.members.length / PAGE_SIZE);

  if (newPage < 0 || newPage >= totalPages) {
    await interaction.reply({ content: '⚠️ No more pages.', ephemeral: true });
    return true;
  }

  state.page = newPage;
  const { embed } = buildRosterPage(state.members, newPage, state.filterClass, state.members.length);
  const buttons   = buildRosterButtons(newPage, totalPages);

  await interaction.update({ embeds: [embed], components: [buttons] });
  return true;
}

// ─── $mystats COMMAND ─────────────────────────────────────────────────────────
async function showMyStats(message) {
  try {
    const sheets  = await getSheetsClient();
    const allRows = await getAllRows(sheets);
    const name    = message.member?.displayName || message.author.username;
    const found   = findRowByDiscordId(allRows, message.author.id, name);

    if (!found) {
      return message.reply(
        `📋 You\'re not on the roster yet!\nUse \`$updatestats\` to add your stats. ⚡`
      );
    }

    const r   = found.rowData;
    const cls = r[COL.CLASS - 1] || '?';

    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(THEME.purple)
      .setAuthor({ name: '⚡ Zeus Clan — Member Stats' })
      .setTitle(`${CLASS_EMOJI[cls] || '🎮'} ${r[COL.NAME - 1] || name}\'s Stats`)
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎮 **Class:** ${cls}\n` +
        `💎 **Resonance:** ${r[COL.RESONANCE - 1] || 'N/A'}\n` +
        `⚡ **Combat Rating:** ${r[COL.CR - 1]        || 'N/A'}\n` +
        `🛡️ **Armor:** ${r[COL.ARMOR - 1]       || 'N/A'}\n` +
        `⚔️ **Armor Pen:** ${r[COL.ARMOR_PEN - 1]   || 'N/A'}\n` +
        `✨ **Potency:** ${r[COL.POTENCY - 1]    || 'N/A'}\n` +
        `🔮 **Resistance:** ${r[COL.RESISTANCE - 1]  || 'N/A'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🕐 **Last Updated:** ${r[COL.LAST_UPDATED - 1] || 'Never'}\n\n` +
        `Use \`$updatestats\` to update anytime! ⚡`
      )
      .setThumbnail(message.author.displayAvatarURL())
      .setFooter({ text: THEME.footer })
      .setTimestamp()
    ]});

  } catch (err) {
    console.error('MyStats error:', err.message);
    message.reply(`❌ Couldn\'t fetch your stats.\n**Error:** ${err.message}`);
  }
}

// ─── $getstats @user (officer command) ───────────────────────────────────────
async function getOtherStats(message, targetMember) {
  try {
    const sheets  = await getSheetsClient();
    const allRows = await getAllRows(sheets);
    const name    = targetMember.displayName || targetMember.user.username;
    const found   = findRowByDiscordId(allRows, targetMember.user.id, name);

    if (!found) {
      return message.reply(`📋 **${name}** is not on the roster yet. They can use \`$updatestats\` to add their stats.`);
    }

    const r   = found.rowData;
    const cls = r[COL.CLASS - 1] || '?';

    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(THEME.blue)
      .setAuthor({ name: '⚡ Zeus Clan — Officer Stat Lookup' })
      .setTitle(`${CLASS_EMOJI[cls] || '🎮'} ${r[COL.NAME - 1] || name}\'s Stats`)
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎮 **Class:** ${cls}\n` +
        `💎 **Resonance:** ${r[COL.RESONANCE - 1]  || 'N/A'}\n` +
        `⚡ **Combat Rating:** ${r[COL.CR - 1]         || 'N/A'}\n` +
        `🛡️ **Armor:** ${r[COL.ARMOR - 1]        || 'N/A'}\n` +
        `⚔️ **Armor Pen:** ${r[COL.ARMOR_PEN - 1]    || 'N/A'}\n` +
        `✨ **Potency:** ${r[COL.POTENCY - 1]     || 'N/A'}\n` +
        `🔮 **Resistance:** ${r[COL.RESISTANCE - 1]   || 'N/A'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🕐 **Last Updated:** ${r[COL.LAST_UPDATED - 1] || 'Never'}`
      )
      .setThumbnail(targetMember.user.displayAvatarURL())
      .setFooter({ text: THEME.footer })
      .setTimestamp()
    ]});

  } catch (err) {
    console.error('GetStats error:', err.message);
    message.reply(`❌ Error: ${err.message}`);
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  activeSessions,
  startStatForm,
  handleStatDMResponse,
  handleRosterButton,
  showRoster,
  showMyStats,
  getOtherStats,
};
