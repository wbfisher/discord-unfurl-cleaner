import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import { data as unfurlCommand } from './commands/unfurl.js';

config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment variables');
  process.exit(1);
}

const commands = [unfurlCommand.toJSON()];

const rest = new REST().setToken(token);

async function deployCommands() {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    const data = await rest.put(
      Routes.applicationCommands(clientId as string),
      { body: commands },
    );

    console.log(`Successfully reloaded ${(data as unknown[]).length} application (/) commands.`);
  } catch (error) {
    console.error('Error deploying commands:', error);
    process.exit(1);
  }
}

deployCommands();
