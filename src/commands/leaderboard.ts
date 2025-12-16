import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { getLeaderboardPaginated } from "../database.js";

const PAGE_SIZE = 10;

export const data = new SlashCommandBuilder()
  .setName("leaderboard")
  .setDescription("View the top reaction currency earners");

function buildLeaderboardEmbed(
  entries: { discord_id: string; balance: number; rank: number }[],
  page: number,
  totalCount: number,
): EmbedBuilder {
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  const description =
    entries.length > 0
      ? entries
          .map((e) => `**${e.rank}.** <@${e.discord_id}> - ${e.balance} coins`)
          .join("\n")
      : "No one has earned any coins yet!";

  return new EmbedBuilder()
    .setTitle("Leaderboard")
    .setDescription(description)
    .setFooter({ text: `Page ${page + 1} of ${totalPages}` });
}

function buildPaginationButtons(
  page: number,
  hasMore: boolean,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`leaderboard:prev:${page}`)
      .setLabel("Previous")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`leaderboard:next:${page}`)
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasMore),
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const { entries, totalCount, hasMore } = await getLeaderboardPaginated(0);

  if (entries.length === 0) {
    await interaction.reply({
      content: "No one has earned any coins yet!",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = buildLeaderboardEmbed(entries, 0, totalCount);
  const buttons = buildPaginationButtons(0, hasMore);

  await interaction.reply({
    embeds: [embed],
    components: [buttons],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleLeaderboardButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, action, pageStr] = interaction.customId.split(":");
  const currentPage = Number.parseInt(pageStr, 10);
  const newPage = action === "next" ? currentPage + 1 : currentPage - 1;

  const { entries, totalCount, hasMore } =
    await getLeaderboardPaginated(newPage);

  const embed = buildLeaderboardEmbed(entries, newPage, totalCount);
  const buttons = buildPaginationButtons(newPage, hasMore);

  await interaction.update({
    embeds: [embed],
    components: [buttons],
  });
}
