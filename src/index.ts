// Must be first import to initialize OpenTelemetry SDK
import "./instrumentation.js";

import {
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	Partials,
} from "discord.js";
import {
	commands,
	executeWithTelemetry,
	registerCommands,
} from "./commands/index.js";
import { handleLeaderboardButton } from "./commands/leaderboard.js";
import { config } from "./config.js";
import { initDatabase } from "./database.js";
import * as reactionAdd from "./events/reactionAdd.js";
import * as reactionRemove from "./events/reactionRemove.js";
import { withSpan } from "./telemetry/index.js";
import { logger } from "./telemetry/logger.js";

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
	],
	partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// Initialize database
initDatabase().catch((err) => {
	logger.error("Failed to initialize database", {
		error: err instanceof Error ? err.message : String(err),
	});
	process.exit(1);
});

// Register event handlers
client.on(reactionAdd.name, reactionAdd.execute);
client.on(reactionRemove.name, reactionRemove.execute);

// Handle interactions
client.on(Events.InteractionCreate, async (interaction) => {
	if (interaction.isButton()) {
		if (interaction.customId.startsWith("leaderboard:")) {
			await withSpan(
				"button.leaderboard",
				{
					"discord.interaction_type": "button",
					"discord.custom_id": interaction.customId,
					"discord.user_id": interaction.user.id,
					"discord.guild_id": interaction.guildId ?? "dm",
				},
				async () => {
					await handleLeaderboardButton(interaction);
				},
			);
		}
		return;
	}

	if (!interaction.isChatInputCommand()) return;

	const command = commands.find(
		(cmd) => cmd.data.name === interaction.commandName,
	);

	if (!command) {
		logger.warn("Unknown command", { command: interaction.commandName });
		return;
	}

	await executeWithTelemetry(
		interaction.commandName,
		interaction as ChatInputCommandInteraction,
		command.execute,
	);
});

// Ready event
client.once(Events.ClientReady, async (readyClient) => {
	logger.info("Bot ready", {
		username: readyClient.user.tag,
		guilds: readyClient.guilds.cache.size,
	});

	// Register slash commands
	await registerCommands();
});

// Login
client.login(config.botToken);
