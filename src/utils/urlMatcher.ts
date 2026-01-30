import config from '../../config/sites.json' with { type: 'json' };

export type Platform = 'bluesky' | 'mastodon' | 'twitter' | 'reddit' | 'youtube';

const patterns: Record<Platform, RegExp> = {
  bluesky: /https?:\/\/(bsky\.app|bsky\.social)\/profile\/[^/]+\/post\/[a-zA-Z0-9]+/,
  mastodon: /https?:\/\/([^/]+)\/@([^/]+)\/(\d+)/,
  twitter: /https?:\/\/(twitter\.com|x\.com)\/[^/]+\/status\/\d+/,
  reddit: /https?:\/\/(www\.)?(reddit\.com|old\.reddit\.com)\/r\/[^/]+\/comments\/[^/]+/,
  youtube: /https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts\/)/,
};

export function identifyPlatform(url: string): Platform | null {
  // Check explicit patterns first
  for (const [platform, regex] of Object.entries(patterns)) {
    if (regex.test(url)) {
      return platform as Platform;
    }
  }

  // Check if it's a known Mastodon instance
  try {
    const hostname = new URL(url).hostname;
    if (config.mastodonInstances.includes(hostname)) {
      // Verify it matches Mastodon URL pattern (/@user/id)
      if (patterns.mastodon.test(url)) {
        return 'mastodon';
      }
    }
  } catch {
    // Invalid URL, ignore
  }

  return null;
}

export function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function extractUrls(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const matches = text.match(urlRegex) || [];

  // Clean up trailing punctuation that might have been captured
  return matches.map(url => url.replace(/[.,;:!?)]+$/, ''));
}

/**
 * Remove tracking parameters from URLs
 * - YouTube: ?si=
 * - General: utm_*, fbclid, gclid, etc.
 */
export function cleanTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);
    const paramsToRemove = [
      'si',           // YouTube
      'utm_source',   // UTM tracking
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',       // Facebook
      'gclid',        // Google
      'ref',          // Various
      'ref_src',
      'ref_url',
    ];

    for (const param of paramsToRemove) {
      parsed.searchParams.delete(param);
    }

    // If no params left, remove the ? entirely
    return parsed.toString();
  } catch {
    return url;
  }
}

export function shouldSkipToPlaywright(url: string): boolean {
  const domain = getDomain(url);
  if (!domain) return false;
  return config.skipToPlaywright.includes(domain);
}

/**
 * Check if URL has tracking parameters that need cleaning
 */
export function hasTrackingParams(url: string): boolean {
  try {
    const parsed = new URL(url);
    const trackingParams = ['si', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    return trackingParams.some(param => parsed.searchParams.has(param));
  } catch {
    return false;
  }
}

/**
 * Platforms where we should use Discord's native unfurl instead of custom embed
 */
export function shouldUseNativeUnfurl(url: string): boolean {
  const platform = identifyPlatform(url);
  return platform === 'youtube';
}

export { patterns };
