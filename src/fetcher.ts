import { tier1Handlers } from './handlers/tier1/index.js';
import * as tier2 from './handlers/tier2/opengraph.js';
import * as tier3 from './handlers/tier3/playwright.js';
import { identifyPlatform, getDomain, shouldSkipToPlaywright } from './utils/urlMatcher.js';
import { logger } from './utils/logger.js';
import type { FetchedData } from './types.js';

export async function fetchCleanData(url: string): Promise<FetchedData | null> {
  const platform = identifyPlatform(url);
  const domain = getDomain(url);

  // Tier 1: Known platform with native API
  if (platform && platform in tier1Handlers) {
    try {
      logger.debug(`Tier 1: Trying ${platform} handler for ${url}`);
      const handler = tier1Handlers[platform as keyof typeof tier1Handlers];
      const data = await handler.fetch(url);
      if (data && (data.content || data.title)) {
        logger.info(`Tier 1 success: ${platform} for ${url}`);
        return data;
      }
    } catch (err) {
      logger.warn(`Tier 1 failed for ${platform}: ${err}`);
    }
  }

  // For known difficult sites with Browserless configured, try Playwright first
  // Browserless has better bot detection avoidance
  const hasBrowserless = !!process.env.BROWSERLESS_TOKEN;

  if (shouldSkipToPlaywright(url)) {
    if (hasBrowserless) {
      // With Browserless, go straight to Playwright (better success rate)
      logger.debug(`Tier 3 (Browserless): Trying Playwright for paywalled site ${domain}`);
      try {
        const data = await tier3.fetch(url);
        if (data && (data.content || data.title)) {
          logger.info(`Tier 3 success: Browserless for ${url}`);
          return data;
        }
      } catch (err) {
        logger.error(`Tier 3 (Browserless) failed for ${domain}: ${err}`);
      }
    }

    // Try Tier 2 (API-based extraction)
    logger.debug(`Tier 2: Trying OG/API parse for paywalled site ${domain}`);
    try {
      const data = await tier2.fetch(url);
      if (data) {
        logger.debug(`Tier 2 returned: title="${data.title}", content="${data.content?.slice(0, 50)}...", platform="${data.platform}"`);
        if (data.title && (data.content || data.images.length > 0)) {
          logger.info(`Tier 2 success: OG parse for paywalled site ${url}`);
          return data;
        }
        // If we have a title but no content, still use it (better than nothing)
        if (data.title) {
          logger.info(`Tier 2 partial success (title only): ${url}`);
          return data;
        }
      }
    } catch (err) {
      logger.warn(`Tier 2 failed for paywalled site: ${err}`);
    }

    // Fall back to local Playwright if no Browserless
    if (!hasBrowserless) {
      logger.debug(`Tier 3: Falling back to local Playwright for ${domain}`);
      try {
        const data = await tier3.fetch(url);
        if (data && (data.content || data.title)) {
          logger.info(`Tier 3 success: Playwright for ${url}`);
          return data;
        }
      } catch (err) {
        logger.error(`Tier 3 failed for ${domain}: ${err}`);
      }
    }

    return createMinimalData(url, domain);
  }

  // Tier 2: Simple fetch + OG parse
  try {
    logger.debug(`Tier 2: Trying OG parse for ${url}`);
    const data = await tier2.fetch(url);
    if (data && data.title && data.content) {
      logger.info(`Tier 2 success: OpenGraph for ${url}`);
      return data;
    }
    if (data && data.title) {
      // Got title but no description - might be enough
      logger.debug('Tier 2: Partial data, checking if sufficient');
      // For some sites, title alone is good enough
      if (data.images.length > 0) {
        logger.info(`Tier 2 partial success: OpenGraph for ${url}`);
        return data;
      }
    }
    logger.debug('Tier 2: Insufficient OG data, escalating to Tier 3');
  } catch (err) {
    logger.warn(`Tier 2 failed: ${err}`);
  }

  // Tier 3: Playwright headless browser
  try {
    logger.debug(`Tier 3: Playwright for ${url}`);
    const data = await tier3.fetch(url);
    if (data && (data.content || data.title)) {
      logger.info(`Tier 3 success: Playwright for ${url}`);
      return data;
    }
  } catch (err) {
    logger.error(`Tier 3 failed: ${err}`);
  }

  // All tiers failed - return minimal data
  logger.warn(`All tiers failed for ${url}, returning minimal data`);
  return createMinimalData(url, domain);
}

function createMinimalData(url: string, domain: string | null): FetchedData {
  // Try to extract a title from the URL slug
  let title = domain || 'Link';
  let platform = 'Link';

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(p => p && p.length > 10);
    const slug = pathParts[pathParts.length - 1];

    if (slug) {
      // Remove date patterns and convert to title case
      const cleanSlug = slug.replace(/^\d{4}-\d{2}-\d{2}-?/, '');
      const extractedTitle = cleanSlug
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();

      if (extractedTitle && extractedTitle.length >= 10) {
        title = extractedTitle;
      }
    }

    // Map common domains to nice names
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

    if (domain && platformNames[domain]) {
      platform = platformNames[domain];
    } else if (domain) {
      platform = domain;
    }
  } catch {
    // URL parsing failed, use defaults
  }

  logger.debug(`createMinimalData: platform="${platform}", title="${title}"`);

  return {
    platform,
    title,
    content: null,
    images: [],
    originalUrl: url,
  };
}
