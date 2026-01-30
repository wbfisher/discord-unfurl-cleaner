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

  // Skip straight to Tier 3 for known difficult sites
  if (shouldSkipToPlaywright(url)) {
    logger.debug(`Tier 3: Skipping to Playwright for ${domain}`);
    try {
      const data = await tier3.fetch(url);
      if (data && (data.content || data.title)) {
        logger.info(`Tier 3 success: Playwright for ${url}`);
        return data;
      }
    } catch (err) {
      logger.error(`Tier 3 failed for ${domain}: ${err}`);
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
  return {
    platform: 'Link',
    title: domain || 'Link',
    content: null,
    images: [],
    originalUrl: url,
  };
}
