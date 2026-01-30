import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';

interface TwitterResponse {
  tweet?: {
    author: {
      name: string;
      screen_name: string;
      avatar_url?: string;
    };
    text: string;
    media?: {
      photos?: Array<{ url: string }>;
      videos?: Array<{ thumbnail_url?: string }>;
    };
  };
}

export async function fetch(url: string): Promise<FetchedData | null> {
  const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
  if (!match) return null;

  const [, username, statusId] = match;
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${statusId}`;

  try {
    const response = await globalThis.fetch(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn(`fxtwitter API returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as TwitterResponse;
    const tweet = data?.tweet;
    if (!tweet) return null;

    const images: string[] = [];

    // Handle photos
    if (tweet.media?.photos) {
      images.push(...tweet.media.photos.map((p: { url: string }) => p.url));
    }

    // Handle video thumbnails as fallback
    if (images.length === 0 && tweet.media?.videos) {
      for (const v of tweet.media.videos) {
        if (v.thumbnail_url) images.push(v.thumbnail_url);
      }
    }

    return {
      platform: 'Twitter',
      authorName: tweet.author.name,
      authorHandle: `@${tweet.author.screen_name}`,
      authorAvatar: tweet.author.avatar_url,
      content: tweet.text,
      images,
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`Twitter fetch error: ${error}`);
    return null;
  }
}
