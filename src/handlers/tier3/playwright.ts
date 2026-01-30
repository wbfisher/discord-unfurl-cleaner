import { chromium, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { getDomain } from '../../utils/urlMatcher.js';

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

const TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '10000', 10);

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

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
    logger.info('Playwright browser launched');
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
    context = await browserInstance.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
    });

    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });

    // Wait for JavaScript to render
    await page.waitForTimeout(2000);

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
    let content = getMeta('og:description') || getMeta('twitter:description');
    const image = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || getDomain(url) || 'Link';
    const author = getMeta('author') || getMeta('article:author');

    // Fallback: scrape visible content if OG is empty
    if (!content) {
      const articleText =
        $('article p').first().text().trim() ||
        $('[class*="article"] p').first().text().trim() ||
        $('main p').first().text().trim() ||
        $('p').first().text().trim();

      if (articleText) {
        content = articleText.slice(0, 500);
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
