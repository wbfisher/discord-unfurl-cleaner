# Discord Unfurl Cleaner

A Discord bot that intercepts links, suppresses cluttered native previews, and replaces them with clean, minimal embeds.

## Features

- **Tiered fetch architecture**: Starts with fast/cheap API calls, escalates to headless browser only when needed
- **Platform-specific handlers**: Native API support for Bluesky, Mastodon, Twitter (via fxtwitter), and Reddit
- **Webhook impersonation**: Reposts messages as the original user (preserves name/avatar)
- **Rate limiting**: Prevents hitting Discord's rate limits with per-channel queuing
- **Graceful degradation**: If fetch fails, original message stays untouched

## Supported Platforms

| Platform | Method |
|----------|--------|
| Bluesky | AT Protocol API |
| Mastodon | Instance API |
| Twitter/X | fxtwitter.com proxy |
| Reddit | JSON API |
| YouTube | OpenGraph tags |
| News sites | OpenGraph → Playwright fallback |

## Setup

### 1. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Click "New Application" → name it "Unfurl Cleaner"
3. Go to "Bot" tab:
   - Click "Reset Token" and copy it
   - Enable **MESSAGE CONTENT INTENT**
4. Go to "OAuth2" → "URL Generator":
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: select the permission integer below
   - Copy generated URL → open it → authorize to your server

**Permission integer:** `275414829120`

### 2. Local Development

```bash
# Clone and install
git clone <your-repo>
cd discord-unfurl-cleaner
npm install

# Configure
cp .env.example .env
# Edit .env with your bot token and client ID

# Deploy slash commands (one time)
npm run deploy-commands

# Run in development mode
npm run dev
```

### 3. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Yes | Application ID from Discord Developer Portal |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `PLAYWRIGHT_TIMEOUT` | No | Timeout in ms for browser fetches (default: 10000) |
| `DATABASE_PATH` | No | Path to SQLite database (default: `./data/unfurl.db`) |

### 4. Deploy to Railway

1. Push your code to GitHub
2. Go to https://railway.app → sign in with GitHub
3. New Project → "Deploy from GitHub repo"
4. Select the repository
5. Add environment variables:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `NODE_ENV=production`
6. Add a persistent volume mounted at `/app/data`
7. Railway auto-detects and deploys

## Usage

### Slash Commands

- `/unfurl enable` - Enable link cleaning in the current channel
- `/unfurl disable` - Disable link cleaning in the current channel
- `/unfurl status` - Check if link cleaning is enabled

Commands require **Manage Messages** permission.

### Opt-out

Prefix any message with `!raw` to skip processing:

```
!raw https://twitter.com/example/status/123
```

## Architecture

```
URL Received
    │
    ▼
┌─────────────────────────────────────────┐
│  TIER 1: Native API                      │
│  Bluesky, Mastodon, Twitter, Reddit      │
│  Latency: 50-200ms                       │
└─────────────────────────────────────────┘
    │ Not a known platform?
    ▼
┌─────────────────────────────────────────┐
│  TIER 2: OpenGraph Parse                 │
│  Simple HTTP + meta tag extraction       │
│  Latency: 200-500ms                      │
└─────────────────────────────────────────┘
    │ Empty/blocked/JS-rendered?
    ▼
┌─────────────────────────────────────────┐
│  TIER 3: Playwright Browser              │
│  Full headless Chrome                    │
│  Latency: 2-5 seconds                    │
└─────────────────────────────────────────┘
```

## Bot Permissions

The bot needs these permissions:
- Read Messages/View Channels
- Send Messages
- Manage Messages (to delete original)
- Manage Webhooks (to create/use webhooks)
- Embed Links
- Read Message History

## License

MIT
