import { chromium, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { getDomain } from '../../utils/urlMatcher.js';

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

const TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '15000', 10);
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  // Use Browserless.io if token is configured (better for paywalled sites)
  if (BROWSERLESS_TOKEN) {
    browserLaunchPromise = chromium.connect(
      `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}&stealth=true`
    );
    try {
      browser = await browserLaunchPromise;
      logger.info('Connected to Browserless.io');
      return browser;
    } catch (error) {
      logger.error(`Browserless connection failed: ${error}`);
      browserLaunchPromise = null;
      // Fall through to local browser
    }
  }

  // Fall back to local Playwright
  browserLaunchPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    browser = await browserLaunchPromise;
    logger.info('Playwright local browser launched');
    return browser;
  } finally {
    browserLaunchPromise = null;
  }
}

async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Playwright browser closed');
  }
}

export async function fetch(url: string): Promise<FetchedData | null> {
  let context: BrowserContext | null = null;

  try {
    const browserInstance = await getBrowser();

    // More realistic browser context with stealth settings
    context = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      // Pretend to be a real browser
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
      },
    });

    const page = await context.newPage();

    // Block unnecessary resources to speed up loading
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['media', 'font', 'websocket'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    logger.debug(`Playwright navigating to ${url}`);

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: TIMEOUT,
    });

    // Wait a bit more for any late JS
    await page.waitForTimeout(1500);

    const html = await page.content();
    const $ = cheerio.load(html);

    const getMeta = (property: string): string | undefined => {
      return (
        $(`meta[property="${property}"]`).attr('content') ||
        $(`meta[name="${property}"]`).attr('content') ||
        undefined
      );
    };

    let title = getMeta('og:title') || getMeta('twitter:title') || $('title').text().trim();
    let content = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
    const image = getMeta('og:image') || getMeta('twitter:image') || getMeta('twitter:image:src');
    const siteName = getMeta('og:site_name') || getDomain(url) || 'Link';
    const author = getMeta('author') || getMeta('article:author') || getMeta('twitter:creator');

    logger.debug(`Playwright extracted - title: "${title?.slice(0, 50)}...", content: "${content?.slice(0, 50)}...", image: ${image ? 'yes' : 'no'}`);

    // Fallback: scrape visible content if OG is empty
    if (!content) {
      // Try multiple selectors for article content
      const selectors = [
        'article p',
        '[class*="article-body"] p',
        '[class*="story-body"] p',
        '[class*="content"] p',
        'main p',
        '.body p',
        'p',
      ];

      for (const selector of selectors) {
        const text = $(selector).first().text().trim();
        if (text && text.length > 50) {
          content = text.slice(0, 500);
          logger.debug(`Playwright fallback content from ${selector}: "${content.slice(0, 50)}..."`);
          break;
        }
      }
    }

    // Fallback for title
    if (!title) {
      title = $('h1').first().text().trim() || getDomain(url) || 'Link';
    }

    // Resolve relative image URLs
    let resolvedImage = image;
    if (image && !image.startsWith('http')) {
      try {
        resolvedImage = new URL(image, url).href;
      } catch {
        resolvedImage = undefined;
      }
    }

    // If we still have nothing useful, log it
    if (!title && !content) {
      logger.warn(`Playwright got no useful content for ${url}`);
    }

    return {
      platform: siteName,
      authorName: author || null,
      authorHandle: null,
      authorAvatar: null,
      title,
      content: content || null,
      images: resolvedImage ? [resolvedImage] : [],
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`Playwright fetch error for ${url}: ${error}`);

    // If browser crashed, reset it
    if (error instanceof Error && error.message.includes('Browser')) {
      await closeBrowser();
    }

    return null;
  } finally {
    if (context) {
      await context.close();
    }
  }
}

// Cleanup handlers
process.on('exit', () => {
  browser?.close();
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

export { closeBrowser };
