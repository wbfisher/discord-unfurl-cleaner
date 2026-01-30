import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';

interface BlueskyPost {
  author: {
    displayName?: string;
    handle: string;
    avatar?: string;
  };
  record: {
    text: string;
  };
  embed?: {
    images?: Array<{ fullsize?: string; thumb?: string }>;
    media?: {
      images?: Array<{ fullsize?: string; thumb?: string }>;
    };
  };
}

interface BlueskyResponse {
  thread?: {
    post?: BlueskyPost;
  };
}

export async function fetch(url: string): Promise<FetchedData | null> {
  const match = url.match(/\/profile\/([^/]+)\/post\/([a-zA-Z0-9]+)/);
  if (!match) return null;

  const [, handle, rkey] = match;
  const atUri = `at://${handle}/app.bsky.feed.post/${rkey}`;
  const apiUrl = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(atUri)}&depth=0`;

  try {
    const response = await globalThis.fetch(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn(`Bluesky API returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as BlueskyResponse;
    const post = data?.thread?.post;
    if (!post) return null;

    const images: string[] = [];

    // Handle embedded images
    if (post.embed?.images) {
      for (const img of post.embed.images) {
        const imgUrl = img.fullsize || img.thumb;
        if (imgUrl) images.push(imgUrl);
      }
    }

    // Handle embedded media in record embeds
    if (post.embed?.media?.images) {
      for (const img of post.embed.media.images) {
        const imgUrl = img.fullsize || img.thumb;
        if (imgUrl) images.push(imgUrl);
      }
    }

    return {
      platform: 'Bluesky',
      authorName: post.author.displayName || post.author.handle,
      authorHandle: `@${post.author.handle}`,
      authorAvatar: post.author.avatar,
      content: post.record.text,
      images,
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`Bluesky fetch error: ${error}`);
    return null;
  }
}
