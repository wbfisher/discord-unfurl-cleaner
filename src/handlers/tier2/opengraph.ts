import * as cheerio from 'cheerio';
import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { getDomain } from '../../utils/urlMatcher.js';

// Sites that need special handling
const PAYWALLED_DOMAINS = [
  'bloomberg.com',
  'wsj.com',
  'nytimes.com',
  'washingtonpost.com',
  'ft.com',
  'economist.com',
  'reuters.com',
  'apnews.com',
];

function isPaywalledSite(url: string): boolean {
  const domain = getDomain(url);
  return domain ? PAYWALLED_DOMAINS.some(d => domain.includes(d)) : false;
}

export async function fetch(url: string): Promise<FetchedData | null> {
  // For paywalled sites, try metadata API first (they handle bot detection)
  if (isPaywalledSite(url)) {
    logger.debug(`Trying Microlink API for paywalled site: ${url}`);
    const apiResult = await fetchFromMicrolinkAPI(url);
    if (apiResult) {
      return apiResult;
    }

    // Fall back to extracting what we can from the URL itself
    logger.debug(`Microlink failed, extracting from URL for ${url}`);
    const urlExtracted = extractFromUrl(url);
    if (urlExtracted) {
      return urlExtracted;
    }
  }

  return fetchDirect(url);
}

/**
 * Extract title from URL slug as last resort
 * e.g., /news/articles/2024-01-29/stock-market-today-dow-s-p-live-updates
 * becomes "Stock Market Today Dow S P Live Updates"
 */
function extractFromUrl(url: string): FetchedData | null {
  try {
    const parsed = new URL(url);
    const domain = getDomain(url);

    // Get the last meaningful path segment
    const pathParts = parsed.pathname.split('/').filter(p => p && p.length > 10);
    const slug = pathParts[pathParts.length - 1];

    if (!slug) {
      return null;
    }

    // Remove date patterns like 2024-01-29
    const cleanSlug = slug.replace(/^\d{4}-\d{2}-\d{2}-?/, '');

    // Convert slug to title case
    const title = cleanSlug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();

    if (!title || title.length < 10) {
      return null;
    }

    // Map domain to nice platform name
    const platformNames: Record<string, string> = {
      'bloomberg.com': 'Bloomberg',
      'wsj.com': 'Wall Street Journal',
      'nytimes.com': 'The New York Times',
      'washingtonpost.com': 'The Washington Post',
      'ft.com': 'Financial Times',
      'economist.com': 'The Economist',
      'reuters.com': 'Reuters',
      'apnews.com': 'Associated Press',
    };

    const platform = (domain && platformNames[domain]) || domain || 'News';

    logger.info(`Extracted from URL: "${title}" for ${url}`);

    return {
      platform,
      authorName: null,
      authorHandle: null,
      authorAvatar: null,
      title,
      content: null,
      images: [],
      originalUrl: url,
    };
  } catch {
    return null;
  }
}

function isRobotContent(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('are you a robot') ||
    lower.includes('captcha') ||
    lower.includes('verify you are human') ||
    lower.includes('please verify') ||
    lower.includes('access denied') ||
    lower.includes('enable javascript') ||
    lower.includes('browser is not supported')
  );
}

async function fetchFromMicrolinkAPI(originalUrl: string): Promise<FetchedData | null> {
  const apiUrl = `https://api.microlink.io?url=${encodeURIComponent(originalUrl)}`;

  try {
    const response = await globalThis.fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      logger.debug(`Microlink API returned ${response.status}`);
      return null;
    }

    const json = await response.json() as {
      status: string;
      data?: {
        title?: string;
        description?: string;
        image?: { url?: string };
        publisher?: string;
        author?: string;
        logo?: { url?: string };
      };
    };

    if (json.status !== 'success' || !json.data) {
      logger.debug(`Microlink API returned status: ${json.status}`);
      return null;
    }

    const data = json.data;

    // Check if Microlink returned a robot/captcha page
    if (isRobotContent(data.title) || isRobotContent(data.description)) {
      logger.debug(`Microlink returned robot page content for ${originalUrl}`);
      return null;
    }

    if (!data.title) {
      return null;
    }

    logger.info(`Microlink API success for ${originalUrl}`);

    return {
      platform: data.publisher || getDomain(originalUrl) || 'Link',
      authorName: data.author || null,
      authorHandle: null,
      authorAvatar: null,
      title: data.title,
      content: data.description || null,
      images: data.image?.url ? [data.image.url] : [],
      originalUrl: originalUrl,
    };
  } catch (error) {
    logger.debug(`Microlink API error: ${error}`);
    return null;
  }
}

async function fetchFromProxy(proxyUrl: string, originalUrl: string): Promise<FetchedData | null> {
  try {
    const response = await globalThis.fetch(proxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      logger.debug(`Proxy returned ${response.status} for ${originalUrl}`);
      return null;
    }

    const html = await response.text();

    // Check if we got a robot check page
    if (html.includes('robot') || html.includes('captcha') || html.includes('are you human')) {
      logger.debug(`Proxy returned robot check for ${originalUrl}`);
      return null;
    }

    const $ = cheerio.load(html);

    const getMeta = (property: string): string | undefined => {
      return (
        $(`meta[property="${property}"]`).attr('content') ||
        $(`meta[name="${property}"]`).attr('content') ||
        undefined
      );
    };

    const title = getMeta('og:title') || getMeta('twitter:title') || $('title').text().trim();
    const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
    const image = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || getDomain(originalUrl) || 'Link';

    // If no title, try to find it in the page content
    const fallbackTitle = $('h1').first().text().trim() || $('article h1').first().text().trim();
    const finalTitle = title || fallbackTitle;

    if (!finalTitle) {
      return null;
    }

    // For description, try article content if OG is empty
    let finalDescription = description;
    if (!finalDescription) {
      const articleText = $('article p').first().text().trim() ||
                          $('[class*="article"] p').first().text().trim() ||
                          $('p').first().text().trim();
      if (articleText && articleText.length > 30) {
        finalDescription = articleText.slice(0, 300);
      }
    }

    // Resolve relative image URLs
    let resolvedImage = image;
    if (image && !image.startsWith('http')) {
      try {
        resolvedImage = new URL(image, originalUrl).href;
      } catch {
        resolvedImage = undefined;
      }
    }

    logger.info(`Proxy success for ${originalUrl}`);

    return {
      platform: siteName,
      authorName: getMeta('author') || null,
      authorHandle: null,
      authorAvatar: null,
      title: finalTitle,
      content: finalDescription || null,
      images: resolvedImage ? [resolvedImage] : [],
      originalUrl: originalUrl,
    };
  } catch (error) {
    logger.debug(`Proxy error for ${originalUrl}: ${error}`);
    return null;
  }
}

async function fetchFromGoogleCache(originalUrl: string): Promise<FetchedData | null> {
  const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(originalUrl)}&strip=1`;

  try {
    const response = await globalThis.fetch(cacheUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.debug(`Google Cache returned ${response.status} for ${originalUrl}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const getMeta = (property: string): string | undefined => {
      return (
        $(`meta[property="${property}"]`).attr('content') ||
        $(`meta[name="${property}"]`).attr('content') ||
        undefined
      );
    };

    const title = getMeta('og:title') || getMeta('twitter:title') || $('title').text().trim();
    const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
    const image = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || getDomain(originalUrl) || 'Link';

    if (!title) {
      return null;
    }

    // Resolve relative image URLs against the ORIGINAL url
    let resolvedImage = image;
    if (image && !image.startsWith('http')) {
      try {
        resolvedImage = new URL(image, originalUrl).href;
      } catch {
        resolvedImage = undefined;
      }
    }

    logger.info(`Google Cache success for ${originalUrl}`);

    return {
      platform: siteName,
      authorName: getMeta('author') || null,
      authorHandle: null,
      authorAvatar: null,
      title,
      content: description || null,
      images: resolvedImage ? [resolvedImage] : [],
      originalUrl: originalUrl, // Link to original, not cache
    };
  } catch (error) {
    logger.debug(`Google Cache error for ${originalUrl}: ${error}`);
    return null;
  }
}

async function fetchDirect(url: string): Promise<FetchedData | null> {
  try {
    logger.debug(`OG direct fetch for ${url}`);

    const response = await globalThis.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      logger.warn(`OpenGraph fetch returned ${response.status} for ${url}`);
      return null;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      logger.debug(`Non-HTML content type for ${url}: ${contentType}`);
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    const getMeta = (property: string): string | undefined => {
      return (
        $(`meta[property="${property}"]`).attr('content') ||
        $(`meta[name="${property}"]`).attr('content') ||
        undefined
      );
    };

    const title = getMeta('og:title') || getMeta('twitter:title') || $('title').text().trim();
    const description = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
    const image = getMeta('og:image') || getMeta('twitter:image') || getMeta('twitter:image:src');
    const siteName = getMeta('og:site_name') || getDomain(url) || 'Link';
    const author = getMeta('author') || getMeta('article:author');

    if (!title) {
      logger.debug(`No title found for ${url}`);
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

    return {
      platform: siteName,
      authorName: author || null,
      authorHandle: null,
      authorAvatar: null,
      title,
      content: description || null,
      images: resolvedImage ? [resolvedImage] : [],
      originalUrl: url,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      logger.warn(`OpenGraph fetch timed out for ${url}`);
    } else {
      logger.error(`OpenGraph fetch error for ${url}: ${error}`);
    }
    return null;
  }
}
