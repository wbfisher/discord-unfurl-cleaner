import { config } from 'dotenv';

// Load environment variables first
config();

import { createClient } from './bot.js';
import { logger } from './utils/logger.js';

const token = process.env.DISCORD_TOKEN;

if (!token) {
  logger.error('DISCORD_TOKEN is required in environment variables');
  process.exit(1);
}

const client = createClient();

// Handle uncaught errors
process.on('unhandledRejection', (error) => {
  logger.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error);
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`);

  try {
    client.destroy();
    logger.info('Discord client destroyed');
  } catch (error) {
    logger.error('Error during shutdown:', error);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Start the bot
logger.info('Starting Unfurl Cleaner bot...');
client.login(token).catch((error) => {
  logger.error('Failed to login:', error);
  process.exit(1);
});
