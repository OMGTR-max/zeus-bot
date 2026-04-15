// ⚡ ZEUS BOT — Stats Tracker Module v2
// Uses Discord User ID for matching — works with any name, special characters included
// Sheet: Zeus | Columns: No. | Name | Class | Resonance | Armor | ArmorPen | Potency | Resistance | DiscordID

const { EmbedBuilder } = require('discord.js');
const { google }       = require('googleapis');

// ─── GOOGLE SHEET CONFIG ──────────────────────────────────────────────────────
const SHEET_ID  = '1qa7hwxIj6hbgQ_j1x8ygwqAQ-V4FhXicP4EVLVSfeKg';
const SHEET_TAB = 'Zeus';
const DATA_RANGE = `${SHEET_TAB}!A:J`; // A through J (includes DiscordID)

// Column positions (1-indexed to match Sheets API)
// No. | Name | Class | Resonance | CR | Armor | ArmorPen | Potency | Resistance | DiscordID
const COL = {
  NO:          1,  // A
  NAME:        2,  // B
  CLASS:       3,  // C
  RESONANCE:   4,  // D
  CR:          5,  // E ← Combat Rating
  ARMOR:       6,  // F
  ARMOR_PEN:   7,  // G
  POTENCY:     8,  // H
  RESISTANCE:  9,  // I
  DISCORD_ID:  10, // J ← bulletproof matching
};

// ─── VALID CLASSES ────────────────────────────────────────────────────────────
const VALID_CLASSES = [
  'Barbarian', 'Crusader', 'Demon Hunter', 'Monk',
  'Necromancer', 'Wizard', 'Blood Knight', 'Tempest',
];

// ─── ACTIVE SESSIONS ──────────────────────────────────────────────────────────
// Key: Discord userId → Value: session object
const activeSessions = new Map();

// ─── FORM STEPS ───────────────────────────────────────────────────────────────
const STEPS = [
  {
    key:   'class',
    label: 'Class',
    prompt:
      `**Step 1/7 — Class** 🎮\n\n` +
      `What is your current class?\n\n` +
      `${VALID_CLASSES.map((c, i) => `\`${i + 1}.\` ${c}`).join('\n')}\n\n` +
      `Type the class name or its number:`,
    validate(val) {
      const num = parseInt(val);
      if (num >= 1 && num <= VALID_CLASSES.length) return VALID_CLASSES[num - 1];
      return VALID_CLASSES.find(c => c.toLowerCase() === val.toLowerCase()) || null;
    },
    errorMsg:
      `❌ Invalid class. Please type one of:\n` +
      VALID_CLASSES.map((c, i) => `\`${i + 1}.\` ${c}`).join('\n'),
  },
  {
    key:      'resonance',
    label:    'Resonance',
    prompt:   `**Step 2/7 — Resonance** 💎\n\nEnter your current **Resonance**:\n\n*Example: \`15000\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`15000\`)`,
  },
  {
    key:      'armor',
    label:    'Armor',
    prompt:   `**Step 3/7 — Armor** 🛡️\n\nEnter your current **Armor** value:\n\n*Example: \`45000\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`45000\`)`,
  },
  {
    key:      'armorPen',
    label:    'Armor Penetration',
    prompt:   `**Step 4/7 — Armor Penetration** ⚔️\n\nEnter your current **Armor Pen** value:\n\n*Example: \`1200\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`1200\`)`,
  },
  {
    key:      'potency',
    label:    'Potency',
    prompt:   `**Step 5/7 — Potency** ✨\n\nEnter your current **Potency** value:\n\n*Example: \`900\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`900\`)`,
  },
  {
    key:      'resistance',
    label:    'Resistance',
    prompt:   `**Step 6/7 — Resistance** 🔮\n\nEnter your current **Resistance** value:\n\n*Example: \`700\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`700\`)`,
  },
  {
    key:      'cr',
    label:    'Combat Rating',
    prompt:   `**Step 7/7 — Combat Rating** ⚡\n\nEnter your current **Combat Rating (CR)**:\n\n*Example: \`5800\`*`,
    validate: numValidator,
    errorMsg: `❌ Please enter a valid number (e.g. \`5800\`)`,
  },
];

function numValidator(val) {
  const n = parseInt(val.toString().replace(/,/g, ''));
  return (!isNaN(n) && n >= 0) ? n : null;
}

// ─── GOOGLE AUTH ──────────────────────────────────────────────────────────────
function getGoogleAuth() {
  if (!process.env.GOOGLE_CREDENTIALS) {
    throw new Error('GOOGLE_CREDENTIALS environment variable is not set in Railway!');
  }
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = getGoogleAuth();
  return google.sheets({ version: 'v4', auth });
}

// ─── SHEET HELPERS ────────────────────────────────────────────────────────────

// Fetch all rows (includes header at index 0)
async function getAllRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         DATA_RANGE,
  });
  return res.data.values || [];
}

// Find member row by Discord ID (column I) — ignores name entirely
// Falls back to name match for existing rows that don't have an ID yet
function findRowByDiscordId(rows, userId, displayName) {
  for (let i = 1; i < rows.length; i++) {
    const idCell = (rows[i][COL.DISCORD_ID - 1] || '').trim();
    if (idCell === userId) {
      return { rowIndex: i + 1, rowData: rows[i] }; // 1-based for Sheets API
    }
  }
  // Fallback: name match for old rows that predate the DiscordID column
  if (displayName) {
    for (let i = 1; i < rows.length; i++) {
      const nameCell = (rows[i][COL.NAME - 1] || '').toLowerCase().trim();
      if (nameCell === displayName.toLowerCase().trim()) {
        return { rowIndex: i + 1, rowData: rows[i], needsIdBackfill: true };
      }
    }
  }
  return null;
}

// Write stats + Discord ID to an existing row (columns B through J)
async function updateRow(sheets, rowIndex, displayName, userId, data) {
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SHEET_ID,
    range:            `${SHEET_TAB}!B${rowIndex}:J${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        displayName,     // B — refresh display name
        data.class,      // C
        data.resonance,  // D
        data.cr,         // E ← CR now between Resonance and Armor
        data.armor,      // F
        data.armorPen,   // G
        data.potency,    // H
        data.resistance, // I
        userId,          // J — Discord ID
      ]],
    },
  });
}

// Append a brand new row for a member not yet in the sheet
async function addRow(sheets, rows, displayName, userId, data) {
  const nextNo = rows.length;
  await sheets.spreadsheets.values.append({
    spreadsheetId:    SHEET_ID,
    range:            DATA_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        nextNo,          // A — No.
        displayName,     // B — Name
        data.class,      // C
        data.resonance,  // D
        data.cr,         // E ← CR between Resonance and Armor
        data.armor,      // F
        data.armorPen,   // G
        data.potency,    // H
        data.resistance, // I
        userId,          // J — Discord ID
      ]],
    },
  });
}

// ─── START STAT FORM ──────────────────────────────────────────────────────────
async function startStatForm(member, triggerChannel) {
  const userId = member.user.id;

  // Reset any existing session for this user
  activeSessions.delete(userId);

  activeSessions.set(userId, {
    step:    0,
    data:    {},
    userId,
    name:    member.displayName || member.user.username,
    guildId: member.guild.id,
    triggerChannelId: triggerChannel?.id || null,
  });

  try {
    await member.send({ embeds: [new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('⚡ Zeus Clan — Stat Update Form')
      .setDescription(
        `Hey **${member.displayName}**! Let's update your stats. 💪\n\n` +
        `I'll ask you **7 questions** one at a time.\n` +
        `Just type your answer after each prompt.\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 **Stats we'll collect:**\n` +
        `\`1.\` Class\n` +
        `\`2.\` Resonance\n` +
        `\`3.\` Armor\n` +
        `\`4.\` Armor Penetration\n` +
        `\`5.\` Potency\n` +
        `\`6.\` Resistance\n` +
        `\`7.\` Combat Rating\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Type \`cancel\` at any time to stop.\n\nLet's go! ⚡`
      )
      .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
    ]});

    await sendNextStep(member.user, userId);

  } catch {
    activeSessions.delete(userId);
    triggerChannel?.send(
      `> ⚠️ **${member.displayName}** — I couldn't DM you!\n` +
      `> Enable **Allow direct messages from server members** in Privacy Settings, then try \`$updatestats\` again.`
    );
  }
}

// ─── SEND NEXT STEP ───────────────────────────────────────────────────────────
async function sendNextStep(user, userId) {
  const session = activeSessions.get(userId);
  if (!session) return;

  const step = STEPS[session.step];

  await user.send({ embeds: [new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle(`📋 Stat Update — ${step.label}`)
    .setDescription(
      `📊 **Progress: ${session.step}/${STEPS.length} complete**\n\n${step.prompt}`
    )
    .setFooter({ text: 'Type your answer below | Type "cancel" to stop' })
  ]});
}

// ─── HANDLE DM RESPONSE ───────────────────────────────────────────────────────
async function handleStatDMResponse(message) {
  const userId  = message.author.id;
  const session = activeSessions.get(userId);
  if (!session) return false; // not in a session — ignore DM

  const input = message.content.trim();

  // ── Cancel ────────────────────────────────────────────────────────────────
  if (input.toLowerCase() === 'cancel') {
    activeSessions.delete(userId);
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xFF6600)
      .setTitle('❌ Stat Update Cancelled')
      .setDescription('No problem! Use `$updatestats` in the server anytime to try again. ⚡')
    ]});
    return true;
  }

  // ── Validate input ────────────────────────────────────────────────────────
  const step      = STEPS[session.step];
  const validated = step.validate(input);

  if (validated === null) {
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('⚠️ Invalid Input')
      .setDescription(`${step.errorMsg}\n\nPlease try again:`)
    ]});
    return true;
  }

  // ── Save and advance ──────────────────────────────────────────────────────
  session.data[step.key] = validated;
  session.step++;

  if (session.step < STEPS.length) {
    await sendNextStep(message.author, userId);
    return true;
  }

  // ── All done — sync to Google Sheet ───────────────────────────────────────
  activeSessions.delete(userId);

  await message.reply({ embeds: [new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('⏳ Saving your stats...')
    .setDescription('Syncing to the Zeus Clan Google Sheet. One moment! ⚡')
  ]});

  try {
    const sheets  = await getSheetsClient();
    const allRows = await getAllRows(sheets);
    const found   = findRowByDiscordId(allRows, session.userId, session.name);

    if (found) {
      // Update existing row — also writes Discord ID if it was missing (backfill)
      await updateRow(sheets, found.rowIndex, session.name, session.userId, session.data);
    } else {
      // Brand new member — add a row
      await addRow(sheets, allRows, session.name, session.userId, session.data);
    }

    await message.author.send({ embeds: [new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ Stats Saved Successfully!')
      .setDescription(
        `Your stats are now live on the **Zeus Clan roster**! 🔱\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**📊 ${session.name}'s Stats:**\n\n` +
        `🎮 **Class:** ${session.data.class}\n` +
        `💎 **Resonance:** ${session.data.resonance.toLocaleString()}\n` +
        `⚡ **Combat Rating:** ${session.data.cr.toLocaleString()}\n` +
        `🛡️ **Armor:** ${session.data.armor.toLocaleString()}\n` +
        `⚔️ **Armor Pen:** ${session.data.armorPen.toLocaleString()}\n` +
        `✨ **Potency:** ${session.data.potency.toLocaleString()}\n` +
        `🔮 **Resistance:** ${session.data.resistance.toLocaleString()}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `${found ? '🔄 Entry updated!' : '🆕 New entry added to roster!'}\n` +
        `Use \`$mystats\` in the server to check anytime. ⚡`
      )
      .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
      .setTimestamp()
    ]});

  } catch (err) {
    console.error('Google Sheets sync error:', err.message);
    // Send error DM with their answers preserved so nothing is lost
    await message.author.send({ embeds: [new EmbedBuilder()
      .setColor(0xFF0000)
      .setTitle('❌ Sync Failed — Save these manually!')
      .setDescription(
        `Couldn't save to the sheet. Please screenshot this and send to an officer!\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `**${session.name}'s Stats:**\n` +
        `Class: ${session.data.class}\n` +
        `Resonance: ${session.data.resonance}\n` +
        `CR: ${session.data.cr}\n` +
        `Armor: ${session.data.armor}\n` +
        `Armor Pen: ${session.data.armorPen}\n` +
        `Potency: ${session.data.potency}\n` +
        `Resistance: ${session.data.resistance}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `**Error:** ${err.message}`
      )
    ]});
  }

  return true;
}

// ─── $roster COMMAND ──────────────────────────────────────────────────────────
async function showRoster(message, filterClass = null) {
  try {
    const sheets = await getSheetsClient();
    const rows   = await getAllRows(sheets);

    if (rows.length <= 1) {
      return message.reply(
        '📋 The roster is empty! Members can use `$updatestats` to add their stats.'
      );
    }

    // Skip header, require a name in column B
    let members = rows.slice(1).filter(r => r[COL.NAME - 1]);

    if (filterClass) {
      members = members.filter(r =>
        (r[COL.CLASS - 1] || '').toLowerCase().includes(filterClass.toLowerCase())
      );
    }

    if (members.length === 0) {
      return message.reply(
        `📋 No members found${filterClass ? ` with class **${filterClass}**` : ''}.`
      );
    }

    // Sort by Resonance descending
    members.sort((a, b) => {
      const parse = r => parseInt((r[COL.RESONANCE - 1] || '0').toString().replace(/,/g, '')) || 0;
      return parse(b) - parse(a);
    });

    // Show top 20 (Discord embed limit)
    const display = members.slice(0, 20);

    const header  = `${'Name'.padEnd(16)} ${'Class'.padEnd(13)} ${'Res'.padStart(7)} ${'CR'.padStart(6)} ${'Armor'.padStart(7)}`;
    const divider = '─'.repeat(52);
    const body    = display.map(r => {
      const name  = (r[COL.NAME - 1]      || '?').slice(0, 15).padEnd(16);
      const cls   = (r[COL.CLASS - 1]     || '?').slice(0, 12).padEnd(13);
      const res   = (r[COL.RESONANCE - 1] || '-').toString().padStart(7);
      const cr    = (r[COL.CR - 1]        || '-').toString().padStart(6);
      const armor = (r[COL.ARMOR - 1]     || '-').toString().padStart(7);
      return `${name} ${cls} ${res} ${cr} ${armor}`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle(`⚡ Zeus Clan Roster${filterClass ? ` — ${filterClass}` : ''}`)
      .setDescription(
        `**${members.length} member(s)** | Sorted by Resonance\n\n` +
        `\`\`\`\n${header}\n${divider}\n${body}\n\`\`\`` +
        (members.length > 20
          ? `\n\n*Showing top 20 of ${members.length}. Use \`$roster [class]\` to filter.*`
          : '')
      )
      .setFooter({ text: 'Zeus Clan | Use $updatestats to update your entry' })
      .setTimestamp();

    return message.reply({ embeds: [embed] });

  } catch (err) {
    console.error('Roster fetch error:', err.message);
    return message.reply(`❌ Couldn't fetch the roster.\n**Error:** ${err.message}`);
  }
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
        `📋 You don't have stats on the roster yet!\nUse \`$updatestats\` to add yours. ⚡`
      );
    }

    const r = found.rowData;

    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(0x9B59B6)
      .setTitle(`📊 ${r[COL.NAME - 1] || name}'s Zeus Clan Stats`)
      .setDescription(
        `━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🎮 **Class:** ${r[COL.CLASS - 1]       || 'N/A'}\n` +
        `💎 **Resonance:** ${r[COL.RESONANCE - 1]   || 'N/A'}\n` +
        `⚡ **Combat Rating:** ${r[COL.CR - 1]       || 'N/A'}\n` +
        `🛡️ **Armor:** ${r[COL.ARMOR - 1]       || 'N/A'}\n` +
        `⚔️ **Armor Pen:** ${r[COL.ARMOR_PEN - 1]   || 'N/A'}\n` +
        `✨ **Potency:** ${r[COL.POTENCY - 1]    || 'N/A'}\n` +
        `🔮 **Resistance:** ${r[COL.RESISTANCE - 1]  || 'N/A'}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
        `Use \`$updatestats\` to update anytime! ⚡`
      )
      .setThumbnail(message.author.displayAvatarURL())
      .setFooter({ text: 'Zeus Clan | SEA Bloodraven | Diablo Immortal' })
      .setTimestamp()
    ]});

  } catch (err) {
    console.error('MyStats error:', err.message);
    return message.reply(`❌ Couldn't fetch your stats.\n**Error:** ${err.message}`);
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
module.exports = {
  activeSessions,
  startStatForm,
  handleStatDMResponse,
  showRoster,
  showMyStats,
};
