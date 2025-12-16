import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from "discord.js";
import { getLeaderboard } from "../database.js";

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the top reaction currency earners");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const entries = await getLeaderboard(10);

  if (entries.length === 0) {
    await interaction.reply({
      content: "No one has earned any coins yet!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = await Promise.all(
    entries.map(async (entry) => {
      try {
        const user = await interaction.client.users.fetch(entry.discord_id);
        return `**${entry.rank}.** ${user.displayName} - ${entry.balance} coins`;
      } catch {
        return `**${entry.rank}.** Unknown User - ${entry.balance} coins`;
      }
    })
  );

  await interaction.reply({
    content: `**Leaderboard**\n\n${lines.join("\n")}`,
  });
}
