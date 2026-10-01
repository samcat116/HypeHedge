import {
	type ChatInputCommandInteraction,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { formatUnits } from "../accounting.js";
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
	const { balanceUnits, lockedUnits, availableUnits } = await getBalance(
		targetUser.id,
	);

	const isSelf = targetUser.id === interaction.user.id;
	const prefix = isSelf ? "You have" : `${targetUser.displayName} has`;

	let content = `${prefix} **${formatUnits(balanceUnits)}** coins.`;
	if (lockedUnits > 0) {
		content += `\n  Available: **${formatUnits(availableUnits)}** | Locked: **${formatUnits(lockedUnits)}**`;
	}

	await interaction.reply({
		content,
		flags: MessageFlags.Ephemeral,
	});
}
