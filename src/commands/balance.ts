import {
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { getBalance } from "../database.js";

export const data = new SlashCommandBuilder()
	.setName("balance")
	.setDescription("Check your reaction currency balance")
	.addUserOption((option) =>
		option
			.setName("user")
			.setDescription("User to check balance for (optional)")
			.setRequired(false),
	);

export async function execute(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const targetUser = interaction.options.getUser("user") ?? interaction.user;
	const { balance, locked, available } = await getBalance(targetUser.id);

	const isSelf = targetUser.id === interaction.user.id;
	const prefix = isSelf ? "You have" : `${targetUser.displayName} has`;

	let content = `${prefix} **${balance.toFixed(0)}** coins.`;
	if (locked > 0) {
		content += `\n  Available: **${available.toFixed(0)}** | Locked: **${locked.toFixed(0)}**`;
	}

	await interaction.reply({
		content,
		flags: MessageFlags.Ephemeral,
	});
}
