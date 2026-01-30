import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';

interface RedditPost {
  url?: string;
  is_gallery?: boolean;
  media_metadata?: Record<string, { s?: { u?: string } }>;
  preview?: {
    images?: Array<{ source?: { url?: string } }>;
  };
  thumbnail?: string;
  subreddit_name_prefixed?: string;
  subreddit?: string;
  author?: string;
  title?: string;
  selftext?: string;
}

interface RedditResponse {
  data?: {
    children?: Array<{ data?: RedditPost }>;
  };
}

export async function fetch(url: string): Promise<FetchedData | null> {
  // Convert to old.reddit.com for better scraping, add .json for API access
  const jsonUrl = url
    .replace('www.reddit.com', 'old.reddit.com')
    .replace(/\/?$/, '.json');

  try {
    const response = await globalThis.fetch(jsonUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn(`Reddit API returned ${response.status} for ${url}`);
      return null;
    }

    const data = await response.json() as RedditResponse[];
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    const images: string[] = [];

    // Handle direct image posts
    if (post.url && /\.(jpg|jpeg|png|gif|webp)$/i.test(post.url)) {
      images.push(post.url);
    }

    // Handle Reddit gallery
    if (post.is_gallery && post.media_metadata) {
      for (const item of Object.values(post.media_metadata) as Array<{ s?: { u?: string } }>) {
        if (item.s?.u) {
          // Reddit escapes URLs in metadata
          images.push(item.s.u.replace(/&amp;/g, '&'));
        }
      }
    }

    // Handle preview images
    if (images.length === 0 && post.preview?.images?.[0]?.source?.url) {
      images.push(post.preview.images[0].source.url.replace(/&amp;/g, '&'));
    }

    // Handle thumbnail as last resort
    if (images.length === 0 && post.thumbnail && post.thumbnail.startsWith('http')) {
      images.push(post.thumbnail);
    }

    const subreddit = post.subreddit_name_prefixed || `r/${post.subreddit}`;

    return {
      platform: 'Reddit',
      authorName: subreddit,
      authorHandle: `u/${post.author}`,
      authorAvatar: null,
      title: post.title,
      content: post.selftext || null,
      images,
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`Reddit fetch error: ${error}`);
    return null;
  }
}
