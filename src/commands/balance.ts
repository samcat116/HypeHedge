import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { getBalance } from "../database.js";

export const data = new SlashCommandBuilder()
  .setName("balance")
  .setDescription("Check your reaction currency balance")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("User to check balance for (optional)")
      .setRequired(false)
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const targetUser = interaction.options.getUser("user") ?? interaction.user;
  const balance = getBalance(targetUser.id);

  if (targetUser.id === interaction.user.id) {
    await interaction.reply({
      content: `You have **${balance}** coins.`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: `${targetUser.displayName} has **${balance}** coins.`,
      ephemeral: true,
    });
  }
}
