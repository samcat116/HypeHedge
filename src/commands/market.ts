import {
	ActionRowBuilder,
	type AutocompleteInteraction,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChatInputCommandInteraction,
	ComponentType,
	EmbedBuilder,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	type ModalSubmitInteraction,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	type StringSelectMenuInteraction,
	TextInputBuilder,
	TextInputStyle,
	UserSelectMenuBuilder,
} from "discord.js";
import {
	type MarketRecord,
	buyShares,
	createMarket,
	getGuildMarketsPaginated,
	getGuildOpenMarkets,
	getMarket,
	getMarketPrices,
	getOracleOpenMarkets,
	getUserPositions,
	resolveMarket,
	sellShares,
} from "../database.js";
import { logger } from "../telemetry/logger.js";

const PAGE_SIZE = 5;

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
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("list")
			.setDescription("List all prediction markets")
			.addStringOption((option) =>
				option
					.setName("status")
					.setDescription("Filter by market status")
					.setRequired(false)
					.addChoices(
						{ name: "All", value: "all" },
						{ name: "Open", value: "open" },
						{ name: "Resolved", value: "resolved" },
					),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("resolve")
			.setDescription("Resolve a market you are the oracle for")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market to resolve")
					.setRequired(true)
					.setAutocomplete(true),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("buy")
			.setDescription("Buy shares in a market outcome")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market")
					.setRequired(true)
					.setAutocomplete(true),
			)
			.addStringOption((option) =>
				option
					.setName("outcome")
					.setDescription("Outcome to buy (Yes/No or option name)")
					.setRequired(true)
					.setAutocomplete(true),
			)
			.addIntegerOption((option) =>
				option
					.setName("shares")
					.setDescription("Number of shares to buy")
					.setRequired(true)
					.setMinValue(1)
					.setMaxValue(1000),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("sell")
			.setDescription("Sell shares back to the market")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market")
					.setRequired(true)
					.setAutocomplete(true),
			)
			.addStringOption((option) =>
				option
					.setName("outcome")
					.setDescription("Outcome to sell")
					.setRequired(true)
					.setAutocomplete(true),
			)
			.addIntegerOption((option) =>
				option
					.setName("shares")
					.setDescription("Number of shares to sell")
					.setRequired(true)
					.setMinValue(1),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("positions")
			.setDescription("View your positions in markets"),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("view")
			.setDescription("View a specific market with current prices")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market")
					.setRequired(true)
					.setAutocomplete(true),
			),
	);

function buildMarketsListEmbed(
	markets: MarketRecord[],
	page: number,
	totalCount: number,
): EmbedBuilder {
	const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

	let description: string;
	if (markets.length === 0) {
		description = "No markets found.";
	} else {
		description = markets
			.map((m) => {
				const truncatedDesc =
					m.description.length > 80
						? `${m.description.slice(0, 77)}...`
						: m.description;
				const statusText =
					m.status === "resolved" && m.resolution
						? `Resolved (${m.resolution})`
						: m.status.charAt(0).toUpperCase() + m.status.slice(1);
				return `**#${m.id}** ${truncatedDesc}\nOracle: <@${m.oracleId}> | Status: ${statusText}`;
			})
			.join("\n\n");
	}

	return new EmbedBuilder()
		.setTitle("Markets")
		.setDescription(description)
		.setFooter({ text: `Page ${page + 1} of ${totalPages}` });
}

function buildMarketsPaginationButtons(
	page: number,
	hasMore: boolean,
	status?: string,
): ActionRowBuilder<ButtonBuilder> {
	const statusSuffix = status && status !== "all" ? `:${status}` : "";
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`markets:prev:${page}${statusSuffix}`)
			.setLabel("Previous")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(page === 0),
		new ButtonBuilder()
			.setCustomId(`markets:next:${page}${statusSuffix}`)
			.setLabel("Next")
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!hasMore),
	);
}

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
	} else if (subcommand === "buy") {
		await handleBuy(interaction);
	} else if (subcommand === "sell") {
		await handleSell(interaction);
	} else if (subcommand === "positions") {
		await handlePositions(interaction);
	} else if (subcommand === "view") {
		await handleView(interaction);
	} else if (subcommand === "list") {
		if (!interaction.guildId) {
			await interaction.reply({
				content: "This command can only be used in servers.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const statusOption = interaction.options.getString("status");
		const status =
			statusOption === "open" || statusOption === "resolved"
				? statusOption
				: undefined;

		const { markets, totalCount, hasMore } = await getGuildMarketsPaginated(
			interaction.guildId,
			0,
			PAGE_SIZE,
			status,
		);

		const embed = buildMarketsListEmbed(markets, 0, totalCount);
		const buttons = buildMarketsPaginationButtons(
			0,
			hasMore,
			statusOption ?? undefined,
		);

		await interaction.reply({
			embeds: [embed],
			components: [buttons],
			flags: MessageFlags.Ephemeral,
		});
	} else if (subcommand === "resolve") {
		if (!interaction.guildId) {
			await interaction.reply({
				content: "This command can only be used in servers.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const marketIdStr = interaction.options.getString("market", true);
		const marketId = Number.parseInt(marketIdStr, 10);

		if (Number.isNaN(marketId)) {
			await interaction.reply({
				content: "Invalid market selection.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const market = await getMarket(marketId);

		if (!market) {
			await interaction.reply({
				content: "Market not found.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (market.oracleId !== interaction.user.id) {
			await interaction.reply({
				content: "You are not the oracle for this market.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (market.status !== "open") {
			await interaction.reply({
				content: "This market has already been resolved.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const options =
			market.outcomeType === "binary"
				? [
						{ label: "Yes", value: "Yes" },
						{ label: "No", value: "No" },
					]
				: (market.options ?? []).map((opt) => ({ label: opt, value: opt }));

		const selectMenu = new StringSelectMenuBuilder()
			.setCustomId(`market:resolve:${market.id}`)
			.setPlaceholder("Select the resolution outcome")
			.addOptions(options);

		const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
			selectMenu,
		);

		const embed = new EmbedBuilder()
			.setTitle("Resolve Market")
			.setDescription(market.description)
			.addFields(
				{ name: "Market ID", value: `#${market.id}`, inline: true },
				{
					name: "Type",
					value: market.outcomeType === "binary" ? "Yes/No" : "Multiple Choice",
					inline: true,
				},
			);

		await interaction.reply({
			embeds: [embed],
			components: [row],
			flags: MessageFlags.Ephemeral,
		});
	}
}

function parseOptions(optionsInput: string): string[] {
	return optionsInput
		.split(",")
		.map((opt) => opt.trim())
		.filter((opt) => opt.length > 0);
}

async function handleBuy(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({
			content: "This command can only be used in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const marketIdStr = interaction.options.getString("market", true);
	const marketId = Number.parseInt(marketIdStr, 10);
	const outcome = interaction.options.getString("outcome", true);
	const shares = interaction.options.getInteger("shares", true);

	if (Number.isNaN(marketId)) {
		await interaction.reply({
			content: "Invalid market selection.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Execute buy
	const result = await buyShares(
		marketId,
		interaction.user.id,
		outcome,
		shares,
	);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to buy shares.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);

	const embed = new EmbedBuilder()
		.setTitle("Shares Purchased")
		.setColor(0x00ff00)
		.setDescription(market?.description ?? `Market #${marketId}`)
		.addFields(
			{ name: "Outcome", value: outcome, inline: true },
			{ name: "Shares", value: `${shares}`, inline: true },
			{ name: "Total Cost", value: `${result.cost} coins`, inline: true },
			{
				name: "Price per Share",
				value: `${result.newPrice.toFixed(2)} coins`,
				inline: true,
			},
		)
		.setTimestamp();

	await interaction.reply({ embeds: [embed] });
}

async function handleSell(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({
			content: "This command can only be used in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const marketIdStr = interaction.options.getString("market", true);
	const marketId = Number.parseInt(marketIdStr, 10);
	const outcome = interaction.options.getString("outcome", true);
	const shares = interaction.options.getInteger("shares", true);

	if (Number.isNaN(marketId)) {
		await interaction.reply({
			content: "Invalid market selection.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Execute sell
	const result = await sellShares(
		marketId,
		interaction.user.id,
		outcome,
		shares,
	);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to sell shares.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);

	const embed = new EmbedBuilder()
		.setTitle("Shares Sold")
		.setColor(0xff9900)
		.setDescription(market?.description ?? `Market #${marketId}`)
		.addFields(
			{ name: "Outcome", value: outcome, inline: true },
			{ name: "Shares", value: `${shares}`, inline: true },
			{ name: "Proceeds", value: `${result.cost} coins`, inline: true },
			{
				name: "Price per Share",
				value: `${result.newPrice.toFixed(2)} coins`,
				inline: true,
			},
		)
		.setTimestamp();

	await interaction.reply({ embeds: [embed] });
}

async function handlePositions(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const positions = await getUserPositions(
		interaction.user.id,
		interaction.guildId ?? undefined,
	);

	if (positions.length === 0) {
		await interaction.reply({
			content: "You have no positions in any markets.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const positionLines = positions.map((p) => {
		const totalCost = p.shares * p.avgCostBasis;
		const currentValue = Math.round((p.shares * p.currentPrice) / 100);
		const pnl = currentValue - totalCost;
		const pnlStr = pnl >= 0 ? `+${pnl}` : `${pnl}`;
		const statusEmoji = p.marketStatus === "open" ? "" : " (resolved)";

		const truncatedDesc =
			p.marketDescription.length > 40
				? `${p.marketDescription.slice(0, 37)}...`
				: p.marketDescription;

		return `**#${p.marketId}** ${truncatedDesc}${statusEmoji}\n${p.outcome}: ${p.shares} shares @ ${p.avgCostBasis}c avg | Now: ${p.currentPrice}% (${pnlStr}c)`;
	});

	const embed = new EmbedBuilder()
		.setTitle("Your Positions")
		.setDescription(positionLines.join("\n\n"))
		.setTimestamp();

	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleView(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({
			content: "This command can only be used in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const marketIdStr = interaction.options.getString("market", true);
	const marketId = Number.parseInt(marketIdStr, 10);

	if (Number.isNaN(marketId)) {
		await interaction.reply({
			content: "Invalid market selection.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);
	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const prices = await getMarketPrices(marketId);

	const pricesText = prices
		? Object.entries(prices)
				.map(([outcome, price]) => `${outcome}: ${Math.round(price * 100)}%`)
				.join("\n")
		: "N/A";

	const embed = new EmbedBuilder()
		.setTitle(`Market #${marketId}`)
		.setDescription(market.description)
		.addFields(
			{ name: "Oracle", value: `<@${market.oracleId}>`, inline: true },
			{
				name: "Type",
				value: market.outcomeType === "binary" ? "Yes/No" : "Multiple Choice",
				inline: true,
			},
			{
				name: "Status",
				value:
					market.status === "resolved"
						? `Resolved: ${market.resolution}`
						: "Open",
				inline: true,
			},
			{ name: "Current Prices", value: pricesText },
		)
		.setTimestamp();

	// Add buy buttons for quick access if market is open
	if (market.status === "open" && prices) {
		const outcomes = Object.keys(prices);
		const row = new ActionRowBuilder<ButtonBuilder>();

		for (const outcome of outcomes.slice(0, 5)) {
			// Max 5 buttons per row
			row.addComponents(
				new ButtonBuilder()
					.setCustomId(`market:quickbuy:${marketId}:${outcome}`)
					.setLabel(`Buy ${outcome} (${Math.round(prices[outcome] * 100)}%)`)
					.setStyle(ButtonStyle.Primary),
			);
		}

		await interaction.reply({ embeds: [embed], components: [row] });
	} else {
		await interaction.reply({ embeds: [embed] });
	}
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

export async function handleMarketsListButton(
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		return;
	}

	// Parse custom ID: markets:action:page or markets:action:page:status
	const parts = interaction.customId.split(":");
	const action = parts[1];
	const currentPage = Number.parseInt(parts[2], 10);
	const status = parts[3] as "open" | "resolved" | undefined;

	const newPage = action === "next" ? currentPage + 1 : currentPage - 1;

	const { markets, totalCount, hasMore } = await getGuildMarketsPaginated(
		interaction.guildId,
		newPage,
		PAGE_SIZE,
		status,
	);

	const embed = buildMarketsListEmbed(markets, newPage, totalCount);
	const buttons = buildMarketsPaginationButtons(newPage, hasMore, status);

	await interaction.update({
		embeds: [embed],
		components: [buttons],
	});
}

export async function handleMarketAutocomplete(
	interaction: AutocompleteInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.respond([]);
		return;
	}

	const focusedOption = interaction.options.getFocused(true);
	const subcommand = interaction.options.getSubcommand();

	try {
		if (focusedOption.name === "outcome") {
			// Autocomplete for outcome selection
			const marketIdStr = interaction.options.getString("market");
			if (!marketIdStr) {
				await interaction.respond([]);
				return;
			}

			const marketId = Number.parseInt(marketIdStr, 10);
			const market = await getMarket(marketId);

			if (!market) {
				await interaction.respond([]);
				return;
			}

			const outcomes =
				market.outcomeType === "binary"
					? ["Yes", "No"]
					: (market.options ?? []);

			const prices = await getMarketPrices(marketId);

			const focusedValue = focusedOption.value.toLowerCase();
			const options = outcomes
				.filter((outcome) => outcome.toLowerCase().includes(focusedValue))
				.map((outcome) => ({
					name: prices
						? `${outcome} (${Math.round(prices[outcome] * 100)}%)`
						: outcome,
					value: outcome,
				}));

			await interaction.respond(options);
		} else if (focusedOption.name === "market") {
			const focusedValue = focusedOption.value.toLowerCase();

			// For resolve command, show only oracle's markets
			// For buy/sell/view, show all open markets in the guild
			let marketsToShow: MarketRecord[];

			if (subcommand === "resolve") {
				marketsToShow = await getOracleOpenMarkets(
					interaction.guildId,
					interaction.user.id,
				);
			} else {
				// buy, sell, view - show all open markets
				marketsToShow = await getGuildOpenMarkets(interaction.guildId);
			}

			const filtered = marketsToShow
				.filter((m) => m.description.toLowerCase().includes(focusedValue))
				.slice(0, 25)
				.map((m) => {
					const truncatedDesc =
						m.description.length > 80
							? `${m.description.slice(0, 77)}...`
							: m.description;
					return {
						name: `#${m.id} - ${truncatedDesc}`,
						value: m.id.toString(),
					};
				});

			await interaction.respond(filtered);
		} else {
			await interaction.respond([]);
		}
	} catch (error) {
		logger.error("Failed to fetch markets for autocomplete", {
			error: error instanceof Error ? error.message : String(error),
			userId: interaction.user.id,
			guildId: interaction.guildId,
		});
		await interaction.respond([]);
	}
}

export async function handleMarketResolveSelect(
	interaction: StringSelectMenuInteraction,
): Promise<void> {
	// Parse custom ID: market:resolve:{marketId}
	const parts = interaction.customId.split(":");
	const marketId = Number.parseInt(parts[2], 10);

	if (Number.isNaN(marketId)) {
		await interaction.reply({
			content: "Invalid market selection.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);

	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (market.oracleId !== interaction.user.id) {
		await interaction.reply({
			content: "You are not the oracle for this market.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (market.status !== "open") {
		await interaction.reply({
			content: "This market has already been resolved.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const selectedValue = interaction.values[0];

	// Validate the resolution is a valid option
	const validOptions =
		market.outcomeType === "binary" ? ["Yes", "No"] : (market.options ?? []);

	if (!validOptions.includes(selectedValue)) {
		await interaction.reply({
			content: "Invalid resolution option.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		const result = await resolveMarket(marketId, selectedValue);

		if (!result) {
			await interaction.reply({
				content: "Failed to resolve market. It may have already been resolved.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const { market: resolved, payouts, totalPayout, winnerCount } = result;

		// Build payout summary
		let payoutSummary: string;
		if (winnerCount === 0) {
			payoutSummary = "No winners to pay out.";
		} else if (winnerCount <= 5) {
			// Show individual payouts for small number of winners
			payoutSummary = payouts
				.map((p) => `<@${p.userId}>: ${p.payout} coins (${p.shares} shares)`)
				.join("\n");
		} else {
			// Summarize for many winners
			const topPayouts = payouts
				.sort((a, b) => b.payout - a.payout)
				.slice(0, 3);
			payoutSummary = topPayouts
				.map((p) => `<@${p.userId}>: ${p.payout} coins`)
				.join("\n");
			payoutSummary += `\n...and ${winnerCount - 3} more winners`;
		}

		const embed = new EmbedBuilder()
			.setTitle("Market Resolved")
			.setColor(0x00ff00)
			.setDescription(resolved.description)
			.addFields(
				{ name: "Market ID", value: `#${resolved.id}`, inline: true },
				{ name: "Winning Outcome", value: selectedValue, inline: true },
				{ name: "Oracle", value: `<@${resolved.oracleId}>`, inline: true },
				{ name: "Winners", value: `${winnerCount}`, inline: true },
				{ name: "Total Payout", value: `${totalPayout} coins`, inline: true },
				{ name: "Payouts", value: payoutSummary },
			)
			.setTimestamp();

		await interaction.update({
			embeds: [embed],
			components: [],
		});
	} catch (error) {
		logger.error("Failed to resolve market", {
			error: error instanceof Error ? error.message : String(error),
			marketId,
			userId: interaction.user.id,
		});
		await interaction.reply({
			content: "Failed to resolve market. Please try again.",
			flags: MessageFlags.Ephemeral,
		});
	}
}

export async function handleMarketQuickBuyButton(
	interaction: ButtonInteraction,
): Promise<void> {
	// Parse custom ID: market:quickbuy:{marketId}:{outcome}
	const parts = interaction.customId.split(":");
	const marketId = Number.parseInt(parts[2], 10);
	const outcome = parts[3];

	if (Number.isNaN(marketId) || !outcome) {
		await interaction.reply({
			content: "Invalid button data.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);
	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Show a modal to get the number of shares
	const modal = new ModalBuilder()
		.setCustomId(`market:quickbuy:confirm:${marketId}:${outcome}`)
		.setTitle(`Buy ${outcome} Shares`);

	const sharesInput = new TextInputBuilder()
		.setCustomId("shares")
		.setLabel("Number of shares to buy")
		.setPlaceholder("e.g., 10")
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMinLength(1)
		.setMaxLength(4);

	modal.addComponents(
		new ActionRowBuilder<TextInputBuilder>().addComponents(sharesInput),
	);

	await interaction.showModal(modal);
}

export async function handleMarketQuickBuyModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	// Parse custom ID: market:quickbuy:confirm:{marketId}:{outcome}
	const parts = interaction.customId.split(":");
	const marketId = Number.parseInt(parts[3], 10);
	const outcome = parts[4];

	if (Number.isNaN(marketId) || !outcome) {
		await interaction.reply({
			content: "Invalid modal data.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const sharesStr = interaction.fields.getTextInputValue("shares");
	const shares = Number.parseInt(sharesStr, 10);

	if (Number.isNaN(shares) || shares < 1 || shares > 1000) {
		await interaction.reply({
			content: "Please enter a valid number of shares (1-1000).",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Execute buy
	const result = await buyShares(
		marketId,
		interaction.user.id,
		outcome,
		shares,
	);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to buy shares.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const market = await getMarket(marketId);

	const embed = new EmbedBuilder()
		.setTitle("Shares Purchased")
		.setColor(0x00ff00)
		.setDescription(market?.description ?? `Market #${marketId}`)
		.addFields(
			{ name: "Outcome", value: outcome, inline: true },
			{ name: "Shares", value: `${shares}`, inline: true },
			{ name: "Total Cost", value: `${result.cost} coins`, inline: true },
			{
				name: "Price per Share",
				value: `${result.newPrice.toFixed(2)} coins`,
				inline: true,
			},
		)
		.setTimestamp();

	await interaction.reply({ embeds: [embed] });
}
