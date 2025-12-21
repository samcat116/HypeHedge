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
	type MarketWithOutcomes,
	type OutcomeRecord,
	cancelOrder,
	createMarket,
	createOrder,
	executeMarket,
	getGuildMarketsPaginated,
	getGuildOpenMarkets,
	getMarket,
	getMarketOrders,
	getOracleOpenMarkets,
	getUserMarketsWithOrders,
	getUserPositions,
	resolveMarket,
} from "../database.js";
import type { Direction } from "../exchange.js";
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
			.setName("order")
			.setDescription("Place a limit order in a market")
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
					.setDescription("Select the outcome to bet on")
					.setRequired(true)
					.setAutocomplete(true),
			)
			.addStringOption((option) =>
				option
					.setName("direction")
					.setDescription("Buy or sell")
					.setRequired(true)
					.addChoices(
						{ name: "Buy", value: "buy" },
						{ name: "Sell", value: "sell" },
					),
			)
			.addIntegerOption((option) =>
				option
					.setName("quantity")
					.setDescription("Number of contracts")
					.setRequired(true)
					.setMinValue(1)
					.setMaxValue(1000),
			)
			.addNumberOption((option) =>
				option
					.setName("price")
					.setDescription("Price per contract (0.01 to 0.99)")
					.setRequired(true)
					.setMinValue(0.01)
					.setMaxValue(0.99),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("cancel")
			.setDescription("Cancel your active order in a market")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market")
					.setRequired(true)
					.setAutocomplete(true),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("positions")
			.setDescription("View your positions and orders in markets"),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("view")
			.setDescription("View a specific market with order book")
			.addStringOption((option) =>
				option
					.setName("market")
					.setDescription("Select the market")
					.setRequired(true)
					.setAutocomplete(true),
			),
	);

function buildMarketsListEmbed(
	markets: MarketWithOutcomes[],
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
				const outcomesList = m.outcomes.map((o) => o.description).join(", ");
				const statusText =
					m.status === "resolved" && m.winningOutcomeId
						? "Resolved"
						: m.status.charAt(0).toUpperCase() + m.status.slice(1);
				return `**#${m.number}** ${truncatedDesc}\nOutcomes: ${outcomesList}\nOracle: <@${m.oracleUserId}> | Status: ${statusText}`;
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
	} else if (subcommand === "order") {
		await handleOrder(interaction);
	} else if (subcommand === "cancel") {
		await handleCancel(interaction);
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

		const marketId = interaction.options.getString("market", true);
		const market = await getMarket(marketId);

		if (!market) {
			await interaction.reply({
				content: "Market not found.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (market.oracleUserId !== interaction.user.id) {
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

		const options = market.outcomes.map((o) => ({
			label: o.description,
			value: o.id,
		}));

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
				{ name: "Market #", value: `${market.number}`, inline: true },
				{
					name: "Outcomes",
					value: market.outcomes.map((o) => o.description).join(", "),
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

async function handleOrder(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({
			content: "This command can only be used in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const marketId = interaction.options.getString("market", true);
	const outcomeId = interaction.options.getString("outcome", true);
	const direction = interaction.options.getString(
		"direction",
		true,
	) as Direction;
	const quantity = interaction.options.getInteger("quantity", true);
	const price = interaction.options.getNumber("price", true);

	// Get market for display
	const market = await getMarket(marketId);
	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const outcome = market.outcomes.find((o) => o.id === outcomeId);
	if (!outcome) {
		await interaction.reply({
			content: "Outcome not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Create the order
	const result = await createOrder(
		interaction.user.id,
		marketId,
		outcomeId,
		direction,
		quantity,
		price,
	);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to create order.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Run matching engine
	const execResult = await executeMarket(marketId);

	const embed = new EmbedBuilder()
		.setTitle("Order Placed")
		.setColor(direction === "buy" ? 0x00ff00 : 0xff9900)
		.setDescription(market.description)
		.addFields(
			{ name: "Market #", value: `${market.number}`, inline: true },
			{ name: "Outcome", value: outcome.description, inline: true },
			{ name: "Direction", value: direction.toUpperCase(), inline: true },
			{ name: "Quantity", value: `${quantity}`, inline: true },
			{ name: "Price", value: `${(price * 100).toFixed(0)}%`, inline: true },
			{
				name: "Escrow",
				value: `${result.order?.escrowAmount.toFixed(2)} coins`,
				inline: true,
			},
		)
		.setTimestamp();

	if (execResult.executions.length > 0) {
		embed.addFields({
			name: "Matched!",
			value: `${execResult.executions.length} execution(s) occurred`,
		});
	}

	await interaction.reply({ embeds: [embed] });
}

async function handleCancel(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guildId) {
		await interaction.reply({
			content: "This command can only be used in servers.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const marketId = interaction.options.getString("market", true);

	const market = await getMarket(marketId);
	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const result = await cancelOrder(interaction.user.id, marketId);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to cancel order.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const embed = new EmbedBuilder()
		.setTitle("Order Cancelled")
		.setColor(0x888888)
		.setDescription(market.description)
		.addFields({ name: "Market #", value: `${market.number}`, inline: true })
		.setTimestamp();

	await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
			content: "You have no positions or orders in any markets.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const positionLines = positions.map((p) => {
		const holdingsText = Object.entries(p.holdings)
			.map(([outcomeId, qty]) => `${qty} contracts`)
			.join(", ");

		const orderText = p.order
			? `\nOrder: ${p.order.direction.toUpperCase()} ${p.order.quantity} @ ${(p.order.price * 100).toFixed(0)}%`
			: "";

		const statusEmoji = p.marketStatus === "open" ? "" : " (resolved)";

		const truncatedDesc =
			p.marketDescription.length > 40
				? `${p.marketDescription.slice(0, 37)}...`
				: p.marketDescription;

		return `**#${p.marketNumber}** ${truncatedDesc}${statusEmoji}\nHoldings: ${holdingsText || "None"}${orderText}`;
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

	const marketId = interaction.options.getString("market", true);
	const market = await getMarket(marketId);

	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Get order book
	const marketOrders = await getMarketOrders(marketId);

	// Group orders by outcome
	const ordersByOutcome = new Map<
		string,
		{ buys: typeof marketOrders; sells: typeof marketOrders }
	>();
	for (const outcome of market.outcomes) {
		ordersByOutcome.set(outcome.id, { buys: [], sells: [] });
	}
	for (const order of marketOrders) {
		const group = ordersByOutcome.get(order.outcomeId);
		if (group) {
			if (order.direction === "buy") {
				group.buys.push(order);
			} else {
				group.sells.push(order);
			}
		}
	}

	// Build order book display
	const orderBookLines: string[] = [];
	for (const outcome of market.outcomes) {
		const group = ordersByOutcome.get(outcome.id);
		if (!group) continue;

		// Sort buys by price descending, sells by price ascending
		group.buys.sort((a, b) => b.price - a.price);
		group.sells.sort((a, b) => a.price - b.price);

		const bestBuy = group.buys[0];
		const bestSell = group.sells[0];

		const buyText = bestBuy
			? `${bestBuy.quantity} @ ${(bestBuy.price * 100).toFixed(0)}%`
			: "—";
		const sellText = bestSell
			? `${bestSell.quantity} @ ${(bestSell.price * 100).toFixed(0)}%`
			: "—";

		orderBookLines.push(
			`**${outcome.description}**\nBest Bid: ${buyText} | Best Ask: ${sellText}`,
		);
	}

	const embed = new EmbedBuilder()
		.setTitle(`Market #${market.number}`)
		.setDescription(market.description)
		.addFields(
			{ name: "Oracle", value: `<@${market.oracleUserId}>`, inline: true },
			{
				name: "Status",
				value: market.status === "resolved" ? "Resolved" : "Open",
				inline: true,
			},
			{ name: "Order Book", value: orderBookLines.join("\n\n") || "No orders" },
		)
		.setTimestamp();

	// Add quick order buttons if market is open
	if (market.status === "open") {
		const rows: ActionRowBuilder<ButtonBuilder>[] = [];

		// Create a row for each outcome (max 5 outcomes per market due to button limits)
		for (const outcome of market.outcomes.slice(0, 5)) {
			const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
				new ButtonBuilder()
					.setCustomId(`market:quickorder:${market.id}:${outcome.id}`)
					.setLabel(`Order: ${outcome.description}`)
					.setStyle(ButtonStyle.Primary),
			);
			rows.push(row);
		}

		await interaction.reply({ embeds: [embed], components: rows });
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
				oracleUserId: oracleId,
				description,
				outcomeDescriptions: ["Yes", "No"],
			});

			const embed = new EmbedBuilder()
				.setTitle("Market Created")
				.setDescription(description)
				.addFields(
					{ name: "Market #", value: `${market.number}`, inline: true },
					{ name: "Type", value: "Yes/No", inline: true },
					{ name: "Oracle", value: `<@${oracleId}>`, inline: true },
					{
						name: "Outcomes",
						value: market.outcomes
							.map((o) => `${o.number}. ${o.description}`)
							.join("\n"),
					},
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
				oracleUserId: oracleId,
				description,
				outcomeDescriptions: options,
			});

			const embed = new EmbedBuilder()
				.setTitle("Market Created")
				.setDescription(description)
				.addFields(
					{ name: "Market #", value: `${market.number}`, inline: true },
					{ name: "Type", value: "Multiple Choice", inline: true },
					{ name: "Oracle", value: `<@${oracleId}>`, inline: true },
					{
						name: "Outcomes",
						value: market.outcomes
							.map((o) => `${o.number}. ${o.description}`)
							.join("\n"),
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
			const marketId = interaction.options.getString("market");
			if (!marketId) {
				await interaction.respond([]);
				return;
			}

			const market = await getMarket(marketId);

			if (!market) {
				await interaction.respond([]);
				return;
			}

			const focusedValue = focusedOption.value.toLowerCase();
			const options = market.outcomes
				.filter((outcome) =>
					outcome.description.toLowerCase().includes(focusedValue),
				)
				.map((outcome) => ({
					name: outcome.description,
					value: outcome.id,
				}));

			await interaction.respond(options);
		} else if (focusedOption.name === "market") {
			const focusedValue = focusedOption.value.toLowerCase();

			let marketsToShow: MarketWithOutcomes[];

			if (subcommand === "resolve") {
				// For resolve, show only oracle's markets
				marketsToShow = await getOracleOpenMarkets(
					interaction.guildId,
					interaction.user.id,
				);
			} else if (subcommand === "cancel") {
				// For cancel, show only markets where user has an order
				marketsToShow = await getUserMarketsWithOrders(
					interaction.user.id,
					interaction.guildId,
				);
			} else {
				// order, view - show all open markets
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
						name: `#${m.number} - ${truncatedDesc}`,
						value: m.id,
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
	const marketId = parts[2];

	const market = await getMarket(marketId);

	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	if (market.oracleUserId !== interaction.user.id) {
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

	const selectedOutcomeId = interaction.values[0];

	// Validate the outcome belongs to this market
	const selectedOutcome = market.outcomes.find(
		(o) => o.id === selectedOutcomeId,
	);
	if (!selectedOutcome) {
		await interaction.reply({
			content: "Invalid resolution option.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	try {
		const result = await resolveMarket(marketId, selectedOutcomeId);

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
				.map((p) => `<@${p.userId}>: ${p.payout} coins (${p.shares} contracts)`)
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
				{ name: "Market #", value: `${resolved.number}`, inline: true },
				{
					name: "Winning Outcome",
					value: selectedOutcome.description,
					inline: true,
				},
				{ name: "Oracle", value: `<@${resolved.oracleUserId}>`, inline: true },
				{ name: "Winners", value: `${winnerCount}`, inline: true },
				{ name: "Total Payout", value: `${totalPayout} coins`, inline: true },
				{ name: "Payouts", value: payoutSummary },
			)
			.setTimestamp();

		await interaction.update({
			content: "Market resolved!",
			embeds: [],
			components: [],
		});

		await interaction.followUp({
			embeds: [embed],
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

export async function handleMarketQuickOrderButton(
	interaction: ButtonInteraction,
): Promise<void> {
	// Parse custom ID: market:quickorder:{marketId}:{outcomeId}
	const parts = interaction.customId.split(":");
	const marketId = parts[2];
	const outcomeId = parts[3];

	const market = await getMarket(marketId);
	if (!market) {
		await interaction.reply({
			content: "Market not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const outcome = market.outcomes.find((o) => o.id === outcomeId);
	if (!outcome) {
		await interaction.reply({
			content: "Outcome not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Show a modal to get order details
	const modal = new ModalBuilder()
		.setCustomId(`market:quickorder:confirm:${marketId}:${outcomeId}`)
		.setTitle(`Order: ${outcome.description}`);

	const directionInput = new TextInputBuilder()
		.setCustomId("direction")
		.setLabel("Direction (buy or sell)")
		.setPlaceholder("buy")
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMinLength(3)
		.setMaxLength(4);

	const quantityInput = new TextInputBuilder()
		.setCustomId("quantity")
		.setLabel("Quantity (1-1000)")
		.setPlaceholder("e.g., 10")
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMinLength(1)
		.setMaxLength(4);

	const priceInput = new TextInputBuilder()
		.setCustomId("price")
		.setLabel("Price (0.01-0.99)")
		.setPlaceholder("e.g., 0.50")
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMinLength(1)
		.setMaxLength(4);

	modal.addComponents(
		new ActionRowBuilder<TextInputBuilder>().addComponents(directionInput),
		new ActionRowBuilder<TextInputBuilder>().addComponents(quantityInput),
		new ActionRowBuilder<TextInputBuilder>().addComponents(priceInput),
	);

	await interaction.showModal(modal);
}

export async function handleMarketQuickOrderModalSubmit(
	interaction: ModalSubmitInteraction,
): Promise<void> {
	// Parse custom ID: market:quickorder:confirm:{marketId}:{outcomeId}
	const parts = interaction.customId.split(":");
	const marketId = parts[3];
	const outcomeId = parts[4];

	const directionStr = interaction.fields
		.getTextInputValue("direction")
		.toLowerCase();
	const quantityStr = interaction.fields.getTextInputValue("quantity");
	const priceStr = interaction.fields.getTextInputValue("price");

	// Validate direction
	if (directionStr !== "buy" && directionStr !== "sell") {
		await interaction.reply({
			content: "Direction must be 'buy' or 'sell'.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	const direction = directionStr as Direction;

	// Validate quantity
	const quantity = Number.parseInt(quantityStr, 10);
	if (Number.isNaN(quantity) || quantity < 1 || quantity > 1000) {
		await interaction.reply({
			content: "Quantity must be between 1 and 1000.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Validate price
	const price = Number.parseFloat(priceStr);
	if (Number.isNaN(price) || price <= 0 || price >= 1) {
		await interaction.reply({
			content: "Price must be between 0.01 and 0.99.",
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

	const outcome = market.outcomes.find((o) => o.id === outcomeId);
	if (!outcome) {
		await interaction.reply({
			content: "Outcome not found.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Create the order
	const result = await createOrder(
		interaction.user.id,
		marketId,
		outcomeId,
		direction,
		quantity,
		price,
	);

	if (!result.success) {
		await interaction.reply({
			content: result.error ?? "Failed to create order.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// Run matching engine
	const execResult = await executeMarket(marketId);

	const embed = new EmbedBuilder()
		.setTitle("Order Placed")
		.setColor(direction === "buy" ? 0x00ff00 : 0xff9900)
		.setDescription(market.description)
		.addFields(
			{ name: "Market #", value: `${market.number}`, inline: true },
			{ name: "Outcome", value: outcome.description, inline: true },
			{ name: "Direction", value: direction.toUpperCase(), inline: true },
			{ name: "Quantity", value: `${quantity}`, inline: true },
			{ name: "Price", value: `${(price * 100).toFixed(0)}%`, inline: true },
			{
				name: "Escrow",
				value: `${result.order?.escrowAmount.toFixed(2)} coins`,
				inline: true,
			},
		)
		.setTimestamp();

	if (execResult.executions.length > 0) {
		embed.addFields({
			name: "Matched!",
			value: `${execResult.executions.length} execution(s) occurred`,
		});
	}

	await interaction.reply({ embeds: [embed] });
}
