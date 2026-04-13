# ⚡ ZEUS BOT — Full Setup Guide
## Diablo Immortal Clan Bot | SEA Bloodraven

---

## 📦 WHAT'S INCLUDED

| Feature | Commands |
|---|---|
| ⚔️ Shadow War Reminders | Automatic — every Thu & Sat |
| 📢 Clan Announcements | `$announce`, `$ping` |
| 🛡️ Moderation | `$kick`, `$ban`, `$mute`, `$warn`, `$clear` |
| 🎮 Fun | `$roll`, `$flip`, `$8ball`, `$trivia` |
| 👤 Roles | `$roles`, `$giverole`, `$rank` |
| 👋 Welcome | Auto-welcome new members |
| 🎵 Music | Ready to activate (see Step 6) |

---

## ✅ STEP 1 — Create Your Bot on Discord

1. Go to **https://discord.com/developers/applications**
2. Click **"New Application"** → Name it **"Zeus Bot"**
3. Go to the **"Bot"** tab on the left
4. Click **"Add Bot"** → Confirm
5. Under **Privileged Gateway Intents**, turn ON:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
   - ✅ Presence Intent
6. Click **"Save Changes"**
7. Click **"Reset Token"** → Copy the token (keep it secret!)

---

## ✅ STEP 2 — Invite the Bot to Your Server

1. Go to **OAuth2 → URL Generator** in the left menu
2. Under **Scopes**, check: `bot`
3. Under **Bot Permissions**, check:
   - ✅ Send Messages
   - ✅ Embed Links
   - ✅ Read Message History
   - ✅ Manage Messages
   - ✅ Kick Members
   - ✅ Ban Members
   - ✅ Moderate Members (for mute/timeout)
   - ✅ Manage Roles
   - ✅ Connect (for future music)
   - ✅ Speak (for future music)
4. Copy the generated URL at the bottom
5. Paste it in your browser → Select your Zeus clan server → Authorize

---

## ✅ STEP 3 — Create Required Discord Channels

Make sure these channels exist in your server (Zeus Bot uses them):

| Channel Name | Purpose |
|---|---|
| `#clan-announcements` | Clan-wide announcements |
| `#shadow-war-alerts` | Shadow War reminders & pings |
| `#welcome` | Auto-welcome new members |
| `#mod-log` | Moderation action logs |
| `#music-commands` | Music commands |

> **Note:** Channel names must match exactly (all lowercase, hyphens).

---

## ✅ STEP 4 — Set Up the .env File

1. In the `zeus-bot` folder, find the file named `.env.example`
2. Make a copy and rename it to `.env` (just `.env`, no `.example`)
3. Open it and replace the placeholder with your bot token:

```
DISCORD_TOKEN=paste_your_actual_token_here
```

> ⚠️ Never share your `.env` file or token with anyone!

---

## ✅ STEP 5 — Choose a Hosting Option

### 🆓 Option A: Railway (Recommended — Free Tier)
**Best for beginners. No credit card required for basic use.**

1. Go to **https://railway.app** and sign up with GitHub
2. Click **"New Project" → "Deploy from GitHub repo"**
3. Upload your zeus-bot folder to a GitHub repo first:
   - Go to **https://github.com** → New Repository → "zeus-bot"
   - Upload all files from the zeus-bot folder
4. In Railway, connect your repo
5. Go to **Variables** tab → Add:
   - Key: `DISCORD_TOKEN` | Value: your token
6. Railway will auto-deploy. Your bot stays online 24/7! ✅

---

### 🆓 Option B: Render (Free Tier)
1. Go to **https://render.com** → Sign up
2. New → **Web Service** → Connect your GitHub repo
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Add environment variable: `DISCORD_TOKEN = your_token`
5. Deploy ✅

---

### 🆓 Option C: Run on Your Own PC (Testing only)
> ⚠️ Bot goes offline when you turn off your PC

**Requirements:**
- Install **Node.js** from https://nodejs.org (version 18 or higher)

**Steps:**
1. Open a terminal / command prompt
2. Navigate to the zeus-bot folder:
   ```
   cd path/to/zeus-bot
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Create your `.env` file with your token
5. Start the bot:
   ```
   npm start
   ```
6. You'll see: `⚡ Zeus Bot is online!`

---

### 💰 Option D: VPS (Best for 24/7 reliability)
**~$5/month on DigitalOcean, Vultr, or Linode**

1. Create an Ubuntu VPS
2. SSH into it and run:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   npm install -g pm2
   ```
3. Upload your zeus-bot folder via SFTP
4. Inside the zeus-bot folder:
   ```bash
   npm install
   cp .env.example .env
   nano .env   # paste your token
   pm2 start index.js --name zeus-bot
   pm2 save
   pm2 startup
   ```
5. Bot runs 24/7 and auto-restarts if it crashes ✅

---

## ✅ STEP 6 — Enable Music (Optional)

Music requires extra libraries. After hosting:

```bash
npm install @discordjs/voice ytdl-core ffmpeg-static
```

Then tell me and I'll send you the music module code to add!

---

## 🗓️ AUTOMATIC REMINDER SCHEDULE

All times in **Philippine Time (PHT)**:

| Day | Time | Reminder |
|---|---|---|
| Monday | 9:00 AM | Sign-ups are OPEN |
| Thursday | 7:00 PM | ⚠️ 30-min warning |
| Thursday | 7:25 PM | 🔥 5-min warning |
| Saturday | 7:00 PM | ⚠️ 30-min warning |
| Saturday | 7:25 PM | 🔥 5-min warning |
| Sunday | 7:30 PM | 👑 Rite of Exile warning |
| Friday | 10:00 AM | 📢 Weekly clan update |

> These are **fully automatic** — no manual work needed once the bot is running!

---

## 💬 ALL COMMANDS

```
$help          — Show all commands
$war           — Next Shadow War countdown
$schedule      — Full weekly schedule
$signup        — Sign-up instructions
$announce      — Post clan announcement (Admin)
$ping          — Ping a role with message (Admin)
$kick          — Kick a member (Mod)
$ban           — Ban a member (Mod)
$mute          — Timeout a member (Mod)
$clear         — Delete messages (Mod)
$warn          — Warn a member (Mod)
$roll          — Roll a dice
$flip          — Flip a coin
$8ball         — Ask magic 8-ball
$trivia        — Diablo Immortal trivia
$rank          — Show your Zeus profile
$roles         — List available roles
$giverole      — Assign a role (Admin)
```

---

## ⚡ NEED HELP?

If anything doesn't work, come back and tell me:
- Which hosting option you chose
- What error message you see

Zeus Bot was built just for you — I'll help you get it running! 🛡️
