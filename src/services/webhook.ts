import {
  TextChannel,
  Webhook,
  Client,
  EmbedBuilder,
  GuildMember,
  User,
  NewsChannel,
  WebhookClient,
} from 'discord.js';
import { logger } from '../utils/logger.js';

type WebhookableChannel = TextChannel | NewsChannel;
type CachedWebhook = Webhook;

const webhookCache = new Map<string, CachedWebhook>();

export async function getOrCreateWebhook(
  channel: WebhookableChannel,
  client: Client
): Promise<CachedWebhook | null> {
  // Check cache first
  if (webhookCache.has(channel.id)) {
    const cached = webhookCache.get(channel.id)!;
    // Verify webhook still exists by trying to use it
    // We'll validate on use instead of pre-fetching
    return cached;
  }

  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner?.id === client.user?.id);

    if (!webhook) {
      webhook = await channel.createWebhook({
        name: 'Unfurl Cleaner',
        avatar: client.user?.displayAvatarURL(),
        reason: 'Required for clean link previews',
      });
      logger.info(`Created webhook in channel ${channel.id}`);
    }

    webhookCache.set(channel.id, webhook);
    return webhook;
  } catch (error) {
    logger.error(`Failed to get/create webhook in ${channel.id}: ${error}`);
    return null;
  }
}

export async function sendAsUser(
  channel: WebhookableChannel,
  user: GuildMember | User,
  content: string | null,
  embeds: EmbedBuilder[],
  client: Client
): Promise<boolean> {
  const webhook = await getOrCreateWebhook(channel, client);
  if (!webhook) {
    return false;
  }

  try {
    let displayName: string;
    if (user instanceof GuildMember) {
      displayName = user.displayName;
    } else {
      displayName = user.username;
    }

    await webhook.send({
      content: content || undefined,
      embeds,
      username: displayName,
      avatarURL: user.displayAvatarURL(),
    });
    return true;
  } catch (error) {
    // If webhook was deleted, remove from cache and retry once
    if (error instanceof Error && error.message.includes('Unknown Webhook')) {
      webhookCache.delete(channel.id);
      logger.warn(`Webhook was deleted, will recreate on next message`);
    } else {
      logger.error(`Failed to send webhook message: ${error}`);
    }
    return false;
  }
}

export function clearWebhookCache(): void {
  webhookCache.clear();
}
