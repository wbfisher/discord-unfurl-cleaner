import * as cheerio from 'cheerio';
import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';
import { getDomain } from '../../utils/urlMatcher.js';

export async function fetch(url: string): Promise<FetchedData | null> {
  try {
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
