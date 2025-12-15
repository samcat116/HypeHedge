import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  TextChannel,
  ChannelType,
} from "discord.js";
import { addReaction } from "../database.js";

export const data = new SlashCommandBuilder()
  .setName("backfill")
  .setDescription("Scan message history and backfill currency from past reactions")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addIntegerOption((option) =>
    option
      .setName("limit")
      .setDescription("Max messages per channel (leave empty for unlimited)")
      .setRequired(false)
      .setMinValue(100)
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const limit = interaction.options.getInteger("limit") ?? null;

  await interaction.reply({
    content: limit
      ? `Starting backfill... Scanning up to ${limit} messages per channel. This may take a while.`
      : `Starting backfill... Scanning all message history. This may take a long time.`,
    ephemeral: true,
  });

  const guild = interaction.guild;
  const channels = guild.channels.cache.filter(
    (channel) => channel.type === ChannelType.GuildText
  );

  let totalMessages = 0;
  let totalReactions = 0;
  let channelsProcessed = 0;

  for (const [, channel] of channels) {
    const textChannel = channel as TextChannel;

    // Check if bot can read the channel
    if (!textChannel.permissionsFor(guild.members.me!)?.has("ReadMessageHistory")) {
      continue;
    }

    try {
      let lastMessageId: string | undefined;
      let channelMessages = 0;
      let lastProgressUpdate = Date.now();

      while (true) {
        // If limit is set, respect it
        if (limit !== null && channelMessages >= limit) break;

        const fetchLimit = limit !== null ? Math.min(100, limit - channelMessages) : 100;
        const messages = await textChannel.messages.fetch({
          limit: fetchLimit,
          ...(lastMessageId && { before: lastMessageId }),
        });

        if (messages.size === 0) break;

        for (const [, message] of messages) {
          // Skip bot messages
          if (message.author.bot) continue;

          // Process reactions on this message
          for (const [, reaction] of message.reactions.cache) {
            const emoji = reaction.emoji.id ?? reaction.emoji.name ?? "unknown";

            // Fetch users who reacted
            try {
              const users = await reaction.users.fetch();

              for (const [, user] of users) {
                // Skip self-reactions
                if (user.id === message.author.id) continue;
                // Skip bot reactions
                if (user.bot) continue;

                const added = addReaction(message.id, user.id, message.author.id, emoji);
                if (added) totalReactions++;
              }
            } catch {
              // May fail if reaction was removed, continue
            }
          }

          channelMessages++;
          totalMessages++;
        }

        lastMessageId = messages.last()?.id;

        // Update progress every 10 seconds
        if (Date.now() - lastProgressUpdate > 10000) {
          await interaction.editReply({
            content: `Backfill in progress... ${channelsProcessed}/${channels.size} channels done, scanning #${textChannel.name} (${channelMessages} messages), ${totalMessages} total messages, ${totalReactions} reactions added.`,
          });
          lastProgressUpdate = Date.now();
        }

        // Small delay to avoid rate limits
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      channelsProcessed++;

      // Update after each channel completes
      await interaction.editReply({
        content: `Backfill in progress... ${channelsProcessed}/${channels.size} channels done, ${totalMessages} messages scanned, ${totalReactions} reactions added.`,
      });
    } catch (error) {
      console.error(`Error processing channel ${textChannel.name}:`, error);
    }
  }

  await interaction.editReply({
    content: `Backfill complete!\n- Channels scanned: ${channelsProcessed}\n- Messages scanned: ${totalMessages}\n- Reactions added: ${totalReactions}`,
  });
}
