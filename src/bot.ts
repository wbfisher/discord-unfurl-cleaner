import {
  Client,
  GatewayIntentBits,
  Events,
  Message,
  TextChannel,
  NewsChannel,
  ChannelType,
} from 'discord.js';
import { extractUrls, cleanTrackingParams, hasTrackingParams, shouldUseNativeUnfurl } from './utils/urlMatcher.js';
import { fetchCleanData } from './fetcher.js';
import { sendAsUser } from './services/webhook.js';
import { buildCleanEmbed } from './services/embed.js';
import { isChannelEnabled } from './services/database.js';
import { enqueue } from './services/rateLimit.js';
import { logger } from './utils/logger.js';
import { execute as executeUnfurlCommand } from './commands/unfurl.js';

// Track processed messages to avoid loops
const processedMessages = new Set<string>();

// Clear processed messages every hour
setInterval(() => {
  const size = processedMessages.size;
  processedMessages.clear();
  if (size > 0) {
    logger.debug(`Cleared ${size} processed message IDs`);
  }
}, 60 * 60 * 1000);

export function createClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.ClientReady, (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);
    logger.info(`Serving ${readyClient.guilds.cache.size} guild(s)`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'unfurl') {
      try {
        await executeUnfurlCommand(interaction);
      } catch (error) {
        logger.error(`Error executing unfurl command: ${error}`);
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: 'An error occurred while executing this command.',
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: 'An error occurred while executing this command.',
            ephemeral: true,
          });
        }
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    await handleMessage(message, client);
  });

  return client;
}

async function handleMessage(message: Message, client: Client): Promise<void> {
  // Ignore bots, DMs
  if (message.author.bot) return;
  if (!message.guild) return;

  // Check if already processed
  if (processedMessages.has(message.id)) return;

  // Check channel type
  if (message.channel.type !== ChannelType.GuildText && message.channel.type !== ChannelType.GuildAnnouncement) {
    return;
  }

  // Check if channel is enabled
  if (!isChannelEnabled(message.channel.id)) return;

  // Check for !raw prefix (opt-out)
  if (message.content.startsWith('!raw ')) {
    return;
  }

  // Extract URLs
  const urls = extractUrls(message.content);
  if (urls.length === 0) return;

  const rawUrl = urls[0];
  const cleanUrl = cleanTrackingParams(rawUrl);

  // For YouTube: only process if it has tracking params to strip
  // Otherwise let Discord's native unfurl handle it
  if (shouldUseNativeUnfurl(rawUrl)) {
    if (!hasTrackingParams(rawUrl)) {
      // No tracking params, let Discord handle it natively
      return;
    }
    // Has tracking params - we'll strip them and repost for native unfurl
    processedMessages.add(message.id);
    try {
      await enqueue(message.channel.id, async () => {
        await processYouTubeMessage(message, cleanUrl, client);
      });
    } catch (error) {
      logger.error(`Error processing YouTube message ${message.id}: ${error}`);
      processedMessages.delete(message.id);
    }
    return;
  }

  // Process first URL only, clean tracking params
  const url = cleanUrl;
  processedMessages.add(message.id);

  // Enqueue processing with rate limiting
  try {
    await enqueue(message.channel.id, async () => {
      await processMessage(message, url, client);
    });
  } catch (error) {
    logger.error(`Error processing message ${message.id}: ${error}`);
    processedMessages.delete(message.id);
  }
}

async function processMessage(
  message: Message,
  url: string,
  client: Client
): Promise<void> {
  const channel = message.channel as TextChannel | NewsChannel;

  try {
    // Fetch clean metadata via tiered system
    const data = await fetchCleanData(url);

    if (!data || (!data.content && !data.title)) {
      // Fetch failed completely, leave original message alone
      logger.warn(`No data fetched for ${url}, leaving original`);
      processedMessages.delete(message.id);
      return;
    }

    // Build embed
    const embed = buildCleanEmbed(data);

    // Get non-URL content from original message
    // Remove the original URL (before cleaning) and any surrounding whitespace
    const allUrls = extractUrls(message.content);
    let textContent = message.content.replace(allUrls[0], '').trim();

    // If there were multiple URLs, add them back wrapped in <> to suppress Discord unfurl
    if (allUrls.length > 1) {
      const remainingUrls = allUrls.slice(1).map(u => `<${cleanTrackingParams(u)}>`).join('\n');
      textContent = textContent ? `${textContent}\n${remainingUrls}` : remainingUrls;
    }

    // Try to delete original message
    try {
      await message.delete();
      logger.debug(`Deleted original message ${message.id}`);
    } catch (deleteError) {
      // Log the actual error for debugging
      logger.warn(`Could not delete message ${message.id}: ${deleteError}`);
      processedMessages.delete(message.id);
      return;
    }

    // Send via webhook
    const success = await sendAsUser(
      channel,
      message.member || message.author,
      textContent || null,
      [embed],
      client
    );

    if (success) {
      logger.info(`Processed ${url} via ${data.platform}`);
    } else {
      logger.warn(`Failed to send webhook for ${url}`);
    }
  } catch (error) {
    logger.error(`Failed to process ${url}: ${error}`);
    processedMessages.delete(message.id);
  }
}

/**
 * Special handler for YouTube - strips tracking params but lets Discord unfurl natively
 */
async function processYouTubeMessage(
  message: Message,
  cleanUrl: string,
  client: Client
): Promise<void> {
  const channel = message.channel as TextChannel | NewsChannel;

  try {
    // Get non-URL content from original message
    const allUrls = extractUrls(message.content);
    let textContent = message.content.replace(allUrls[0], '').trim();

    // Add the clean YouTube URL (Discord will unfurl it)
    textContent = textContent ? `${textContent}\n${cleanUrl}` : cleanUrl;

    // If there were multiple URLs, add them back wrapped in <> to suppress Discord unfurl
    if (allUrls.length > 1) {
      const remainingUrls = allUrls.slice(1).map(u => `<${cleanTrackingParams(u)}>`).join('\n');
      textContent = `${textContent}\n${remainingUrls}`;
    }

    // Try to delete original message
    try {
      await message.delete();
      logger.debug(`Deleted original YouTube message ${message.id}`);
    } catch (deleteError) {
      logger.warn(`Could not delete YouTube message ${message.id}: ${deleteError}`);
      processedMessages.delete(message.id);
      return;
    }

    // Send via webhook with just the clean URL (no embed - let Discord unfurl)
    const success = await sendAsUser(
      channel,
      message.member || message.author,
      textContent,
      [], // No embeds - let Discord create native unfurl
      client
    );

    if (success) {
      logger.info(`Processed YouTube link (stripped tracking): ${cleanUrl}`);
    } else {
      logger.warn(`Failed to send webhook for YouTube: ${cleanUrl}`);
    }
  } catch (error) {
    logger.error(`Failed to process YouTube ${cleanUrl}: ${error}`);
    processedMessages.delete(message.id);
  }
}
