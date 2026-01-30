import type { FetchedData } from '../../types.js';
import { logger } from '../../utils/logger.js';

interface MastodonStatus {
  content: string;
  account: {
    display_name?: string;
    username: string;
    acct: string;
    avatar?: string;
  };
  media_attachments?: Array<{
    type: string;
    url: string;
  }>;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export async function fetch(url: string): Promise<FetchedData | null> {
  const match = url.match(/https?:\/\/([^/]+)\/@([^/]+)\/(\d+)/);
  if (!match) return null;

  const [, instance, , statusId] = match;
  const apiUrl = `https://${instance}/api/v1/statuses/${statusId}`;

  try {
    const response = await globalThis.fetch(apiUrl, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      logger.warn(`Mastodon API returned ${response.status} for ${url}`);
      return null;
    }

    const status = await response.json() as MastodonStatus;

    const content = stripHtml(status.content || '');

    const images = (status.media_attachments || [])
      .filter((m: { type: string }) => m.type === 'image')
      .map((m: { url: string }) => m.url);

    return {
      platform: 'Mastodon',
      authorName: status.account.display_name || status.account.username,
      authorHandle: `@${status.account.acct}`,
      authorAvatar: status.account.avatar,
      content,
      images,
      originalUrl: url,
    };
  } catch (error) {
    logger.error(`Mastodon fetch error: ${error}`);
    return null;
  }
}
