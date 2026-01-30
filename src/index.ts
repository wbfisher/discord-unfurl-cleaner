import { config } from 'dotenv';

// Load environment variables first
config();

import { REST, Routes } from 'discord.js';
import { createClient } from './bot.js';
import { logger } from './utils/logger.js';
import { data as unfurlCommand } from './commands/unfurl.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token) {
  logger.error('DISCORD_TOKEN is required in environment variables');
  process.exit(1);
}

if (!clientId) {
  logger.error('DISCORD_CLIENT_ID is required in environment variables');
  process.exit(1);
}

// Deploy slash commands on startup
async function deployCommands(): Promise<void> {
  const rest = new REST().setToken(token);
  const commands = [unfurlCommand.toJSON()];

  try {
    logger.info('Deploying slash commands...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info('Slash commands deployed successfully');
  } catch (error) {
    logger.error('Failed to deploy slash commands:', error);
  }
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
async function start(): Promise<void> {
  logger.info('Starting Unfurl Cleaner bot...');

  // Deploy commands first
  await deployCommands();

  // Then login
  await client.login(token);
}

start().catch((error) => {
  logger.error('Failed to start:', error);
  process.exit(1);
});
