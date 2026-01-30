import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { enableChannel, disableChannel, getChannelConfig } from '../services/database.js';

export const data = new SlashCommandBuilder()
  .setName('unfurl')
  .setDescription('Configure the Unfurl Cleaner bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand(subcommand =>
    subcommand
      .setName('enable')
      .setDescription('Enable link cleaning in this channel')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('disable')
      .setDescription('Disable link cleaning in this channel')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('status')
      .setDescription('Check if link cleaning is enabled in this channel')
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const channel = interaction.channel;

  if (!channel || !interaction.guildId) {
    await interaction.reply({
      content: 'This command can only be used in a server channel.',
      ephemeral: true,
    });
    return;
  }

  // Only allow in text channels
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    await interaction.reply({
      content: 'Link cleaning is only available in text channels.',
      ephemeral: true,
    });
    return;
  }

  switch (subcommand) {
    case 'enable': {
      enableChannel(channel.id, interaction.guildId);
      await interaction.reply({
        content: `Link cleaning is now **enabled** in <#${channel.id}>. Links will be cleaned and reposted with minimal embeds.`,
        ephemeral: true,
      });
      break;
    }

    case 'disable': {
      disableChannel(channel.id, interaction.guildId);
      await interaction.reply({
        content: `Link cleaning is now **disabled** in <#${channel.id}>.`,
        ephemeral: true,
      });
      break;
    }

    case 'status': {
      const config = getChannelConfig(channel.id);
      if (!config || !config.enabled) {
        await interaction.reply({
          content: `Link cleaning is **disabled** in <#${channel.id}>.\n\nUse \`/unfurl enable\` to enable it.`,
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `Link cleaning is **enabled** in <#${channel.id}>.\n\nTip: Prefix a message with \`!raw\` to skip processing for that message.`,
          ephemeral: true,
        });
      }
      break;
    }
  }
}
