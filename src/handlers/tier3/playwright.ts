import { chromium, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { getDomain } from '../../utils/urlMatcher.js';

let browser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

const TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '15000', 10);
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

/**
 * Use Browserless BrowserQL for advanced scraping with bot detection bypass
 */
async function fetchWithBrowserQL(url: string): Promise<FetchedData | null> {
  if (!BROWSERLESS_TOKEN) return null;

  const apiUrl = `https://chrome.browserless.io/chromium/bql?token=${BROWSERLESS_TOKEN}`;

  // BrowserQL query to extract OG metadata
  const query = `
    mutation ExtractMetadata {
      goto(url: "${url}", waitUntil: networkIdle, timeout: 20000) {
        status
        url
      }

      title: text(selector: "title") {
        text
      }

      ogTitle: text(selector: "meta[property='og:title']") {
        attribute(name: "content")
      }
      ogDescription: text(selector: "meta[property='og:description']") {
        attribute(name: "content")
      }
      ogImage: text(selector: "meta[property='og:image']") {
        attribute(name: "content")
      }
      ogSiteName: text(selector: "meta[property='og:site_name']") {
        attribute(name: "content")
      }

      twitterTitle: text(selector: "meta[name='twitter:title']") {
        attribute(name: "content")
      }
      twitterDescription: text(selector: "meta[name='twitter:description']") {
        attribute(name: "content")
      }
      twitterImage: text(selector: "meta[name='twitter:image']") {
        attribute(name: "content")
      }

      author: text(selector: "meta[name='author']") {
        attribute(name: "content")
      }
      description: text(selector: "meta[name='description']") {
        attribute(name: "content")
      }

      h1: text(selector: "h1") {
        text
      }
      articleText: text(selector: "article p") {
        text
      }
    }
  `;

  try {
    logger.debug(`Fetching via BrowserQL: ${url}`);

    const response = await globalThis.fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.debug(`BrowserQL returned ${response.status}: ${errorText.slice(0, 200)}`);
      return null;
    }

    interface BQLTextResponse {
      text?: string;
      attribute?: string;
    }

    const json = await response.json() as {
      data?: {
        goto?: { status?: number; url?: string };
        title?: BQLTextResponse;
        ogTitle?: BQLTextResponse;
        ogDescription?: BQLTextResponse;
        ogImage?: BQLTextResponse;
        ogSiteName?: BQLTextResponse;
        twitterTitle?: BQLTextResponse;
        twitterDescription?: BQLTextResponse;
        twitterImage?: BQLTextResponse;
        author?: BQLTextResponse;
        description?: BQLTextResponse;
        h1?: BQLTextResponse;
        articleText?: BQLTextResponse;
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      logger.debug(`BrowserQL errors: ${json.errors.map(e => e.message).join(', ')}`);
      return null;
    }

    const data = json.data;
    if (!data) {
      logger.debug('BrowserQL returned no data');
      return null;
    }

    // Helper to extract value from BQL response
    const getValue = (field: BQLTextResponse | undefined): string | undefined => {
      return field?.attribute || field?.text || undefined;
    };

    // Extract the best available data
    const title = getValue(data.ogTitle) || getValue(data.twitterTitle) || getValue(data.h1) || getValue(data.title);
    const description = getValue(data.ogDescription) || getValue(data.twitterDescription) || getValue(data.description) || getValue(data.articleText);
    const image = getValue(data.ogImage) || getValue(data.twitterImage);
    const siteName = getValue(data.ogSiteName) || getDomain(url) || 'Link';
    const author = getValue(data.author);

    // Check for robot page indicators
    const robotIndicators = ['robot', 'captcha', 'verify', 'blocked', 'denied'];
    const titleLower = (title || '').toLowerCase();
    const descLower = (description || '').toLowerCase();

    if (robotIndicators.some(r => titleLower.includes(r) || descLower.includes(r))) {
      logger.debug(`BrowserQL got robot page for ${url}`);
      return null;
    }

    if (!title) {
      logger.debug('BrowserQL got no title');
      return null;
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

    logger.info(`BrowserQL success for ${url}`);

    return {
      platform: siteName,
      authorName: author || null,
      authorHandle: null,
      authorAvatar: null,
      title,
      content: description?.slice(0, 500) || null,
      images: resolvedImage ? [resolvedImage] : [],
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`BrowserQL error: ${error}`);
    return null;
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) {
    return browser;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  // Local Playwright only (Browserless uses REST API now)
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

function isRobotPage(html: string): boolean {
  const lowerHtml = html.toLowerCase();
  return (
    lowerHtml.includes('are you a robot') ||
    lowerHtml.includes('captcha') ||
    lowerHtml.includes('verify you are human') ||
    lowerHtml.includes('please verify') ||
    lowerHtml.includes('access denied') ||
    lowerHtml.includes('blocked')
  );
}

function parseHtml(html: string, url: string): FetchedData | null {
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

  // Fallback: scrape visible content if OG is empty
  if (!content) {
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

  if (!title && !content) {
    return null;
  }

  return {
    platform: siteName,
    authorName: author || null,
    authorHandle: null,
    authorAvatar: null,
    title: title || null,
    content: content || null,
    images: resolvedImage ? [resolvedImage] : [],
    originalUrl: url,
  };
}

export async function fetch(url: string): Promise<FetchedData | null> {
  // Try Browserless BrowserQL first if available (best for paywalled sites)
  if (BROWSERLESS_TOKEN) {
    const result = await fetchWithBrowserQL(url);
    if (result) {
      return result;
    }
  }

  // Fall back to local Playwright
  let context: BrowserContext | null = null;

  try {
    const browserInstance = await Promise.race([
      getBrowser(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Browser connection timeout')), 30000)
      ),
    ]);

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

    // Check for robot/captcha page
    if (isRobotPage(html)) {
      logger.warn(`Playwright got robot check for ${url}`);
      return null;
    }

    const result = parseHtml(html, url);
    if (result) {
      logger.debug(`Playwright extracted - title: "${result.title?.slice(0, 50)}...", image: ${result.images.length > 0 ? 'yes' : 'no'}`);
    }
    return result;
  } catch (error) {
    logger.error(`Playwright fetch error for ${url}: ${error}`);

    // Reset browser on any connection/crash error
    if (error instanceof Error &&
        (error.message.includes('Browser') ||
         error.message.includes('timeout') ||
         error.message.includes('Target closed') ||
         error.message.includes('connection'))) {
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
