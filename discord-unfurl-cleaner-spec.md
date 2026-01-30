# Discord Unfurl Cleaner Bot

## Project Overview

A Discord bot that intercepts links posted by users, suppresses Discord's native (often cluttered) unfurl previews, and replaces them with clean, minimal embeds showing only: source link, author/poster, and core content.

## Core Behavior

1. User posts a message containing a supported link
2. Bot detects the link, deletes the original message
3. Bot fetches clean metadata from the source
4. Bot posts via webhook (preserving user's name/avatar) with a minimal embed
5. If fetch fails, bot reposts original message unchanged (graceful degradation)

## Tiered Fetch Architecture

The bot uses a 3-tier fallback system. Start cheap/fast, escalate only when needed.

```
┌─────────────────────────────────────────────────────────────────┐
│                     URL RECEIVED                                 │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  TIER 1: Native API                                              │
│  - Bluesky (AT Protocol API)                                     │
│  - Mastodon (ActivityPub API)                                    │
│  - Twitter → fxtwitter proxy                                     │
│                                                                  │
│  Success? → Done                                                 │
│  Not a known platform? → Tier 2                                  │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  TIER 2: Simple Fetch + OG Parse                                 │
│  - HTTP GET with browser-like User-Agent                         │
│  - Parse OpenGraph/Twitter Card meta tags                        │
│  - Extract: title, description, image, site name                 │
│                                                                  │
│  Success (has title + description)? → Done                       │
│  Empty/blocked/JS-rendered? → Tier 3                             │
└─────────────────────┬───────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  TIER 3: Playwright Headless Browser                             │
│  - Full browser with stealth plugin                              │
│  - Wait for JS render                                            │
│  - Re-attempt OG parse                                           │
│  - If still empty: extract visible headline + first paragraph    │
│                                                                  │
│  Success? → Done                                                 │
│  Still blocked? → Return minimal embed (just URL + domain)       │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Order Matters

| Tier | Latency | Resource Cost | Success Rate |
|------|---------|---------------|--------------|
| 1 - API | 50-200ms | Minimal | 99% (for supported platforms) |
| 2 - Fetch | 200-500ms | Minimal | ~70% of random sites |
| 3 - Playwright | 2-5 seconds | Heavy (spawns browser) | +20% more sites |

Most links will resolve at Tier 1 or 2. Playwright is the expensive fallback.

### Platform-Specific Routing

| Platform | Tier | Method |
|----------|------|--------|
| Bluesky | 1 | AT Protocol public API |
| Mastodon | 1 | Instance API |
| Twitter/X | 1 | fxtwitter.com proxy (don't fight their bot detection) |
| Reddit | 1 | old.reddit.com + OG parse |
| YouTube | 2 | OG tags are solid |
| News sites | 2 → 3 | Try OG first, Playwright if blocked |
| Bloomberg | 3 | Skip to Playwright (always blocks simple fetch) |
| Everything else | 2 → 3 | Tiered fallback |

## Tech Stack

- **Runtime:** Node.js 20+
- **Discord:** discord.js v14
- **Scraping:** Playwright (better stealth than Puppeteer)
- **HTTP:** Got or Axios for API calls
- **Parsing:** Cheerio for HTML parsing
- **Config:** dotenv for secrets

## File Structure

```
discord-unfurl-cleaner/
├── src/
│   ├── index.js              # Bot entry point
│   ├── bot.js                # Discord client setup
│   ├── fetcher.js            # Tiered fetch orchestrator
│   ├── handlers/
│   │   ├── tier1/
│   │   │   ├── bluesky.js    # Bluesky API handler
│   │   │   ├── mastodon.js   # Mastodon handler
│   │   │   ├── twitter.js    # Twitter → fxtwitter proxy
│   │   │   └── reddit.js     # Reddit handler
│   │   ├── tier2/
│   │   │   └── opengraph.js  # Simple fetch + OG parse
│   │   └── tier3/
│   │       └── playwright.js # Headless browser fallback
│   ├── services/
│   │   ├── webhook.js        # Webhook creation/caching
│   │   └── embed.js          # Embed builder utility
│   └── utils/
│       ├── urlMatcher.js     # Regex patterns for routing
│       ├── ogParser.js       # OpenGraph meta tag parser
│       └── logger.js         # Simple logging
├── config/
│   └── sites.json            # Per-site config and overrides
├── .env.example
├── package.json
├── Dockerfile
└── README.md
```

## Detailed Component Specs

### 1. Tiered Fetch Orchestrator (`src/fetcher.js`)

The brain of the system. Routes URLs through tiers.

```javascript
const tier1 = require('./handlers/tier1');
const tier2 = require('./handlers/tier2/opengraph');
const tier3 = require('./handlers/tier3/playwright');
const { identifyPlatform, getDomain } = require('./utils/urlMatcher');
const config = require('../config/sites.json');
const logger = require('./utils/logger');

async function fetchCleanData(url) {
  const platform = identifyPlatform(url);
  const domain = getDomain(url);
  
  // Tier 1: Known platform with native API
  if (platform && tier1[platform]) {
    try {
      logger.debug(`Tier 1: Trying ${platform} handler for ${url}`);
      const data = await tier1[platform].fetch(url);
      if (data) return data;
    } catch (err) {
      logger.warn(`Tier 1 failed for ${platform}: ${err.message}`);
    }
  }
  
  // Skip straight to Tier 3 for known hard sites
  if (config.skipToPlaywright.includes(domain)) {
    logger.debug(`Tier 3: Skipping to Playwright for ${domain}`);
    return await tier3.fetch(url);
  }
  
  // Tier 2: Simple fetch + OG parse
  try {
    logger.debug(`Tier 2: Trying OG parse for ${url}`);
    const data = await tier2.fetch(url);
    if (data && data.title && data.content) {
      return data;
    }
    logger.debug('Tier 2: Insufficient OG data, escalating');
  } catch (err) {
    logger.warn(`Tier 2 failed: ${err.message}`);
  }
  
  // Tier 3: Playwright headless browser
  try {
    logger.debug(`Tier 3: Playwright for ${url}`);
    return await tier3.fetch(url);
  } catch (err) {
    logger.error(`Tier 3 failed: ${err.message}`);
  }
  
  // All tiers failed - return minimal data
  return {
    platform: 'Link',
    title: domain,
    content: null,
    images: [],
    originalUrl: url
  };
}

module.exports = { fetchCleanData };
```

### 2. URL Matcher (`src/utils/urlMatcher.js`)

```javascript
const patterns = {
  bluesky: /https?:\/\/(bsky\.app|bsky\.social)\/profile\/[^/]+\/post\/[a-zA-Z0-9]+/,
  mastodon: /https?:\/\/([^/]+)\/@([^/]+)\/(\d+)/,
  twitter: /https?:\/\/(twitter\.com|x\.com)\/[^/]+\/status\/\d+/,
  reddit: /https?:\/\/(www\.)?(reddit\.com|old\.reddit\.com)\/r\/[^/]+\/comments\/[^/]+/,
};

function identifyPlatform(url) {
  for (const [platform, regex] of Object.entries(patterns)) {
    if (regex.test(url)) return platform;
  }
  return null; // Not a known platform, use generic flow
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace('www.', '');
  } catch {
    return null;
  }
}

function extractUrls(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  return text.match(urlRegex) || [];
}

module.exports = { identifyPlatform, getDomain, extractUrls, patterns };
```

### 3. Bluesky Handler (`src/handlers/tier1/bluesky.js`)

```javascript
async function fetch(url) {
  const match = url.match(/\/profile\/([^/]+)\/post\/([a-zA-Z0-9]+)/);
  if (!match) return null;
  
  const [, handle, rkey] = match;
  const atUri = `at://${handle}/app.bsky.feed.post/${rkey}`;
  const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`;
  
  const response = await globalThis.fetch(apiUrl, {
    headers: { 'Accept': 'application/json' }
  });
  
  if (!response.ok) return null;
  
  const data = await response.json();
  const post = data?.thread?.post;
  if (!post) return null;
  
  const images = [];
  if (post.embed?.images) {
    images.push(...post.embed.images.map(img => img.fullsize || img.thumb));
  }
  
  return {
    platform: 'Bluesky',
    authorName: post.author.displayName || post.author.handle,
    authorHandle: `@${post.author.handle}`,
    authorAvatar: post.author.avatar,
    content: post.record.text,
    images,
    originalUrl: url
  };
}

module.exports = { fetch };
```

### 4. Twitter Handler (`src/handlers/tier1/twitter.js`)

Uses fxtwitter API - don't fight Twitter's bot detection.

```javascript
async function fetch(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
  if (!match) return null;
  
  const [, username, statusId] = match;
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${statusId}`;
  
  const response = await globalThis.fetch(apiUrl);
  if (!response.ok) return null;
  
  const data = await response.json();
  const tweet = data?.tweet;
  if (!tweet) return null;
  
  const images = [];
  if (tweet.media?.photos) {
    images.push(...tweet.media.photos.map(p => p.url));
  }
  
  return {
    platform: 'Twitter',
    authorName: tweet.author.name,
    authorHandle: `@${tweet.author.screen_name}`,
    authorAvatar: tweet.author.avatar_url,
    content: tweet.text,
    images,
    originalUrl: url
  };
}

module.exports = { fetch };
```

### 5. Mastodon Handler (`src/handlers/tier1/mastodon.js`)

```javascript
async function fetch(url) {
  const match = url.match(/https?:\/\/([^/]+)\/@([^/]+)\/(\d+)/);
  if (!match) return null;
  
  const [, instance, , statusId] = match;
  const apiUrl = `https://${instance}/api/v1/statuses/${statusId}`;
  
  const response = await globalThis.fetch(apiUrl, {
    headers: { 'Accept': 'application/json' }
  });
  
  if (!response.ok) return null;
  
  const status = await response.json();
  
  // Strip HTML from content
  const content = status.content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
  
  const images = status.media_attachments
    ?.filter(m => m.type === 'image')
    .map(m => m.url) || [];
  
  return {
    platform: 'Mastodon',
    authorName: status.account.display_name || status.account.username,
    authorHandle: `@${status.account.acct}`,
    authorAvatar: status.account.avatar,
    content,
    images,
    originalUrl: url
  };
}

module.exports = { fetch };
```

### 6. OpenGraph Handler - Tier 2 (`src/handlers/tier2/opengraph.js`)

```javascript
const cheerio = require('cheerio');

async function fetch(url) {
  const response = await globalThis.fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  
  if (!response.ok) return null;
  
  const html = await response.text();
  const $ = cheerio.load(html);
  
  const getMeta = (property) => 
    $(`meta[property="${property}"]`).attr('content') ||
    $(`meta[name="${property}"]`).attr('content');
  
  const title = getMeta('og:title') || getMeta('twitter:title') || $('title').text();
  const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
  const image = getMeta('og:image') || getMeta('twitter:image');
  const siteName = getMeta('og:site_name') || new URL(url).hostname;
  const author = getMeta('author') || getMeta('article:author');
  
  if (!title) return null;
  
  return {
    platform: siteName,
    authorName: author,
    authorHandle: null,
    authorAvatar: null,
    title,
    content: description,
    images: image ? [image] : [],
    originalUrl: url
  };
}

module.exports = { fetch };
```

### 7. Playwright Handler - Tier 3 (`src/handlers/tier3/playwright.js`)

For Bloomberg, WSJ, and other bot-resistant sites.

```javascript
const { chromium } = require('playwright');
const cheerio = require('cheerio');

let browser = null;

async function getBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

async function fetch(url) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  
  const page = await context.newPage();
  
  try {
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: parseInt(process.env.PLAYWRIGHT_TIMEOUT) || 10000 
    });
    
    // Wait for JS to render
    await page.waitForTimeout(2000);
    
    const html = await page.content();
    const $ = cheerio.load(html);
    
    const getMeta = (property) => 
      $(`meta[property="${property}"]`).attr('content') ||
      $(`meta[name="${property}"]`).attr('content');
    
    let title = getMeta('og:title') || getMeta('twitter:title') || $('title').text();
    let content = getMeta('og:description') || getMeta('twitter:description');
    const image = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || new URL(url).hostname;
    
    // Fallback: scrape visible content if OG empty
    if (!content) {
      const articleText = $('article p').first().text() ||
                         $('[class*="article"] p').first().text() ||
                         $('main p').first().text() ||
                         $('p').first().text();
      content = articleText?.slice(0, 300);
    }
    
    if (!title) {
      title = $('h1').first().text() || new URL(url).hostname;
    }
    
    return {
      platform: siteName,
      authorName: getMeta('author'),
      authorHandle: null,
      authorAvatar: null,
      title,
      content,
      images: image ? [image] : [],
      originalUrl: url
    };
    
  } finally {
    await context.close();
  }
}

// Cleanup on exit
process.on('exit', () => browser?.close());
process.on('SIGINT', () => { browser?.close(); process.exit(); });

module.exports = { fetch };
```

### 8. Webhook Service (`src/services/webhook.js`)

```javascript
const webhookCache = new Map();

async function getOrCreateWebhook(channel, client) {
  if (webhookCache.has(channel.id)) {
    return webhookCache.get(channel.id);
  }
  
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(wh => wh.owner?.id === client.user.id);
  
  if (!webhook) {
    webhook = await channel.createWebhook({
      name: 'Unfurl Cleaner',
      avatar: client.user.displayAvatarURL()
    });
  }
  
  webhookCache.set(channel.id, webhook);
  return webhook;
}

async function sendAsUser(channel, user, content, embeds, client) {
  const webhook = await getOrCreateWebhook(channel, client);
  return webhook.send({
    content,
    embeds,
    username: user.displayName || user.username,
    avatarURL: user.displayAvatarURL()
  });
}

module.exports = { sendAsUser, getOrCreateWebhook };
```

### 9. Embed Builder (`src/services/embed.js`)

```javascript
const { EmbedBuilder } = require('discord.js');

function truncate(str, max) {
  if (!str) return null;
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function buildCleanEmbed(data) {
  const embed = new EmbedBuilder()
    .setColor(getPlatformColor(data.platform))
    .setFooter({ text: data.platform });
  
  // Social media posts: show author
  if (data.authorName && data.authorHandle) {
    embed.setAuthor({
      name: `${data.authorName} (${data.authorHandle})`,
      iconURL: data.authorAvatar || undefined,
      url: data.originalUrl
    });
    if (data.content) {
      embed.setDescription(truncate(data.content, 4096));
    }
  } 
  // News articles: show title + description
  else if (data.title) {
    embed.setTitle(truncate(data.title, 256));
    embed.setURL(data.originalUrl);
    if (data.content) {
      embed.setDescription(truncate(data.content, 4096));
    }
    if (data.authorName) {
      embed.setAuthor({ name: data.authorName });
    }
  }
  // Fallback
  else {
    embed.setDescription(data.originalUrl);
  }
  
  // Add first image only if present
  if (data.images?.length > 0) {
    embed.setImage(data.images[0]);
  }
  
  return embed;
}

function getPlatformColor(platform) {
  const colors = {
    'Bluesky': 0x0085FF,
    'Mastodon': 0x6364FF,
    'Twitter': 0x1DA1F2,
    'Link': 0x808080
  };
  return colors[platform] || 0x5865F2;
}

module.exports = { buildCleanEmbed };
```

### 10. Main Bot Logic (`src/bot.js`)

```javascript
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { extractUrls } = require('./utils/urlMatcher');
const { fetchCleanData } = require('./fetcher');
const { sendAsUser } = require('./services/webhook');
const { buildCleanEmbed } = require('./services/embed');
const logger = require('./utils/logger');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Track processed messages to avoid loops
const processed = new Set();

client.on(Events.MessageCreate, async (message) => {
  // Ignore bots, DMs, already processed
  if (message.author.bot) return;
  if (!message.guild) return;
  if (processed.has(message.id)) return;
  
  const urls = extractUrls(message.content);
  if (urls.length === 0) return;
  
  // Process first URL only (keep it simple)
  const url = urls[0];
  
  try {
    processed.add(message.id);
    
    // Fetch clean metadata via tiered system
    const data = await fetchCleanData(url);
    
    if (!data || (!data.content && !data.title)) {
      // Fetch failed completely, leave original message alone
      processed.delete(message.id);
      return;
    }
    
    // Build embed
    const embed = buildCleanEmbed(data);
    
    // Get non-URL content from original message
    const textContent = message.content.replace(url, '').trim();
    
    // Delete original and repost
    await message.delete();
    await sendAsUser(
      message.channel,
      message.member || message.author,
      textContent || null,
      [embed]
    );
    
    logger.info(`Processed ${url} via ${data.platform}`);
    
  } catch (error) {
    logger.error(`Failed to process ${url}:`, error.message);
    processed.delete(message.id);
    // Original message remains if we fail
  }
});

client.on(Events.ClientReady, () => {
  logger.info(`Logged in as ${client.user.tag}`);
});

module.exports = client;
```

## Configuration

### `.env.example`

```env
DISCORD_TOKEN=your_bot_token_here

# Optional: For Twitter if using direct API approach
# TWITTER_BEARER_TOKEN=

# Optional: Anthropic for AI summarization of articles
# ANTHROPIC_API_KEY=
```

### `config/sites.json`

```json
{
  "skipToPlaywright": [
    "bloomberg.com",
    "wsj.com",
    "nytimes.com",
    "washingtonpost.com",
    "ft.com",
    "economist.com"
  ],
  "mastodonInstances": [
    "mastodon.social",
    "mas.to",
    "hachyderm.io",
    "infosec.exchange",
    "fosstodon.org"
  ]
}
```

## Bot Permissions Required

Discord bot needs these permissions:
- `Read Messages/View Channels`
- `Send Messages`
- `Manage Messages` (to delete original)
- `Manage Webhooks` (to create/use webhooks)
- `Embed Links`
- `Read Message History`

**Permission integer:** `275414829120`

## Deployment (Railway)

### 1. Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Click "New Application" → name it "Unfurl Cleaner"
3. Go to "Bot" tab:
   - Click "Add Bot"
   - Enable **MESSAGE CONTENT INTENT** (required to read message content)
   - Copy the **Bot Token** → save for later
4. Go to "OAuth2" → "URL Generator":
   - Scopes: `bot`
   - Bot Permissions: 
     - Read Messages/View Channels
     - Send Messages
     - Manage Messages
     - Manage Webhooks
     - Embed Links
     - Read Message History
   - Copy generated URL → open it → authorize to your server

**Permission integer:** `275414829120`

### 2. Railway Setup

1. Go to https://railway.app → sign in with GitHub
2. New Project → "Deploy from GitHub repo"
3. Connect and select the repository
4. Add environment variables:

```
DISCORD_TOKEN=<your_bot_token>
NODE_ENV=production
```

5. Railway auto-detects Node.js and deploys

### 3. railway.json (include in repo)

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS"
  },
  "deploy": {
    "startCommand": "node src/index.js",
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### 4. Playwright on Railway

Railway supports Playwright but needs explicit setup. Add to `package.json`:

```json
{
  "scripts": {
    "postinstall": "npx playwright install chromium --with-deps"
  }
}
```

Or use a `nixpacks.toml`:

```toml
[phases.setup]
nixPkgs = ["chromium"]

[phases.install]
cmds = ["npm ci", "npx playwright install chromium"]
```

### 5. Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `NODE_ENV` | No | Set to `production` |
| `LOG_LEVEL` | No | `debug`, `info`, `warn`, `error` (default: `info`) |
| `PLAYWRIGHT_TIMEOUT` | No | Timeout in ms for browser fetches (default: 10000) |

## Future Enhancements (Out of Scope for V1)

1. **Channel allowlist/blocklist** - Only operate in specific channels
2. **User opt-out** - Let users prefix with `!raw` to skip processing
3. **Multiple images** - Gallery handling for multi-image posts
4. **AI summarization** - For long articles, use Claude to generate 2-sentence summary
5. **Caching** - Redis cache for repeated links
6. **Metrics** - Track success/failure rates per platform

## Commands for Claude Code

```
Build a Discord bot per this spec. Follow this order:

1. Project scaffolding:
   - package.json with dependencies (discord.js, playwright, cheerio)
   - railway.json and nixpacks.toml for deployment
   - config/sites.json
   - src/utils/logger.js (simple console wrapper with levels)

2. URL matching and detection:
   - src/utils/urlMatcher.js

3. Tier 1 handlers (test each independently):
   - src/handlers/tier1/bluesky.js (easiest - start here)
   - src/handlers/tier1/mastodon.js
   - src/handlers/tier1/twitter.js (fxtwitter proxy)

4. Tier 2 handler:
   - src/handlers/tier2/opengraph.js

5. Tier 3 handler:
   - src/handlers/tier3/playwright.js

6. Core orchestration:
   - src/fetcher.js (tiered routing logic)

7. Discord integration:
   - src/services/webhook.js
   - src/services/embed.js
   - src/bot.js
   - src/index.js (entry point)

Test the tiered fetcher with sample URLs before integrating with Discord.
Deploy to Railway once Discord bot loop works locally.
```
