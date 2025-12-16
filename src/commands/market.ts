import {
	ActionRowBuilder,
	type ChatInputCommandInteraction,
	ComponentType,
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	SlashCommandBuilder,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
} from "discord.js";
import { createMarket } from "../database.js";
import { logger } from "../telemetry/logger.js";

export const data = new SlashCommandBuilder()
	.setName("market")
	.setDescription("Create and manage prediction markets")
	.addSubcommandGroup((group) =>
		group
			.setName("create")
			.setDescription("Create a new prediction market")
			.addSubcommand((subcommand) =>
				subcommand
					.setName("binary")
					.setDescription("Create a Yes/No prediction market"),
			)
			.addSubcommand((subcommand) =>
				subcommand
					.setName("multi")
					.setDescription("Create a multiple choice prediction market"),
			),
	);

function buildBinaryModal(): ModalBuilder {
	const modal = new ModalBuilder()
		.setCustomId("market:create:binary")
		.setTitle("Create Binary Market");

	const descriptionInput = new TextInputBuilder()
		.setCustomId("description")
		.setPlaceholder("e.g., Will it rain tomorrow?")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(500);

	const oracleSelect = new UserSelectMenuBuilder()
		.setCustomId("oracle")
		.setPlaceholder("Select oracle (defaults to you)")
		.setRequired(false);

	const oracleLabel = new LabelBuilder()
		.setLabel("Oracle")
		.setDescription("User who can resolve this market")
		.setUserSelectMenuComponent(oracleSelect);

	modal.addLabelComponents(
		new LabelBuilder()
			.setLabel("Prediction")
			.setDescription("Describe what you are predicting")
			.setTextInputComponent(descriptionInput),
		oracleLabel,
	);

	return modal;
}

function buildMultiModal(): ModalBuilder {
	const modal = new ModalBuilder()
		.setCustomId("market:create:multi")
		.setTitle("Create Multiple Choice Market");

	const descriptionInput = new TextInputBuilder()
		.setCustomId("description")
		.setPlaceholder("e.g., Who will win the game?")
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(500);

	const optionsInput = new TextInputBuilder()
		.setCustomId("options")
		.setPlaceholder("e.g., Team A, Team B, Team C")
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(500);

	const oracleSelect = new UserSelectMenuBuilder()
		.setCustomId("oracle")
		.setPlaceholder("Select oracle (defaults to you)")
		.setRequired(false);

	const oracleLabel = new LabelBuilder()
		.setLabel("Oracle")
		.setDescription("User who can resolve this market")
		.setUserSelectMenuComponent(oracleSelect);

	modal.addLabelComponents(
		new LabelBuilder()
			.setLabel("Prediction")
			.setDescription("Describe what you are predicting")
			.setTextInputComponent(descriptionInput),
		new LabelBuilder()
			.setLabel("Options")
			.setDescription("Comma-separated list of choices (min 2)")
			.setTextInputComponent(optionsInput),
		oracleLabel,
	);

	return modal;
}

export async function execute(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const subcommandGroup = interaction.options.getSubcommandGroup();
	const subcommand = interaction.options.getSubcommand();

	if (subcommandGroup === "create") {
		if (subcommand === "binary") {
			await interaction.showModal(buildBinaryModal());
		} else if (subcommand === "multi") {
			await interaction.showModal(buildMultiModal());
		}
	}
}

function parseOptions(optionsInput: string): string[] {
	return optionsInput
		.split(",")
		.map((opt) => opt.trim())
		.filter((opt) => opt.length > 0);
}

export async function handleMarketModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	const [, , marketType] = interaction.customId.split(":");

	if (!interaction.guildId) {
		await interaction.reply({
			content: "Markets can only be created in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const description = interaction.fields.getTextInputValue("description");

	// Get oracle from user select, default to creator
	const oracleField = interaction.fields.getField("oracle");
	let oracleId = interaction.user.id;
	if (
		oracleField.type === ComponentType.UserSelect &&
		oracleField.values.length > 0
	) {
		oracleId = oracleField.values[0];
	}

	if (marketType === "binary") {
		try {
			const market = await createMarket({
				guildId: interaction.guildId,
				creatorId: interaction.user.id,
				oracleId,
				description,
				outcomeType: "binary",
			});

			const embed = new EmbedBuilder()
				.setTitle("Market Created")
				.setDescription(description)
				.addFields(
					{ name: "Market ID", value: `#${market.id}`, inline: true },
					{ name: "Type", value: "Yes/No", inline: true },
					{ name: "Oracle", value: `<@${oracleId}>`, inline: true },
					{ name: "Status", value: "Open", inline: true },
				)
				.setTimestamp();

			await interaction.reply({
				embeds: [embed],
			});
		} catch (error) {
			logger.error("Failed to create binary market", {
				error: error instanceof Error ? error.message : String(error),
				userId: interaction.user.id,
				guildId: interaction.guildId,
			});
			await interaction.reply({
				content: "Failed to create market. Please try again.",
				flags: MessageFlags.Ephemeral,
			});
		}
	} else if (marketType === "multi") {
		const optionsInput = interaction.fields.getTextInputValue("options");
		const options = parseOptions(optionsInput);

		if (options.length < 2) {
			await interaction.reply({
				content: "Multiple choice markets require at least 2 options.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		try {
			const market = await createMarket({
				guildId: interaction.guildId,
				creatorId: interaction.user.id,
				oracleId,
				description,
				outcomeType: "multi",
				options,
			});

			const embed = new EmbedBuilder()
				.setTitle("Market Created")
				.setDescription(description)
				.addFields(
					{ name: "Market ID", value: `#${market.id}`, inline: true },
					{ name: "Type", value: "Multiple Choice", inline: true },
					{ name: "Oracle", value: `<@${oracleId}>`, inline: true },
					{
						name: "Options",
						value: options.map((opt, i) => `${i + 1}. ${opt}`).join("\n"),
					},
					{ name: "Status", value: "Open", inline: true },
				)
				.setTimestamp();

			await interaction.reply({
				embeds: [embed],
			});
		} catch (error) {
			logger.error("Failed to create multi market", {
				error: error instanceof Error ? error.message : String(error),
				userId: interaction.user.id,
				guildId: interaction.guildId,
			});
			await interaction.reply({
				content: "Failed to create market. Please try again.",
				flags: MessageFlags.Ephemeral,
			});
		}
	}
}
