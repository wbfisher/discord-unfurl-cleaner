import { EmbedBuilder, ColorResolvable } from 'discord.js';
import type { FetchedData } from '../types.js';

function truncate(str: string | null | undefined, max: number): string | null {
  if (!str) return null;
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

const platformColors: Record<string, ColorResolvable> = {
  Bluesky: 0x0085ff,
  Mastodon: 0x6364ff,
  Twitter: 0x1da1f2,
  Reddit: 0xff4500,
  Bloomberg: 0x472a91,
  'Bloomberg.com': 0x472a91,
  'The New York Times': 0x000000,
  'WSJ': 0x0274b6,
  'The Washington Post': 0x000000,
  Link: 0x808080,
};

function getPlatformColor(platform: string): ColorResolvable {
  return platformColors[platform] || 0x5865f2;
}

export function buildCleanEmbed(data: FetchedData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(getPlatformColor(data.platform))
    .setFooter({ text: data.platform });

  // Social media posts: show author prominently
  if (data.authorName && data.authorHandle) {
    embed.setAuthor({
      name: `${data.authorName} (${data.authorHandle})`,
      iconURL: data.authorAvatar || undefined,
      url: data.originalUrl,
    });

    if (data.content) {
      embed.setDescription(truncate(data.content, 4096)!);
    }
  }
  // Reddit: show subreddit as author, title prominently
  else if (data.platform === 'Reddit' && data.title) {
    if (data.authorName) {
      embed.setAuthor({
        name: `${data.authorName} • ${data.authorHandle || ''}`.trim(),
        url: data.originalUrl,
      });
    }
    embed.setTitle(truncate(data.title, 256)!);
    embed.setURL(data.originalUrl);

    if (data.content) {
      embed.setDescription(truncate(data.content, 4096)!);
    }
  }
  // News/articles: show title + description
  else if (data.title) {
    embed.setTitle(truncate(data.title, 256)!);
    embed.setURL(data.originalUrl);

    if (data.content) {
      embed.setDescription(truncate(data.content, 4096)!);
    }

    if (data.authorName) {
      embed.setAuthor({ name: data.authorName });
    }
  }
  // Fallback: just show the URL
  else {
    embed.setDescription(data.originalUrl);
  }

  // Add first image only
  if (data.images.length > 0) {
    embed.setImage(data.images[0]);
  }

  return embed;
}
