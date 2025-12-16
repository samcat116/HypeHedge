import {
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	Partials,
} from "discord.js";
import { commands, registerCommands } from "./commands/index.js";
import { config } from "./config.js";
import { initDatabase } from "./database.js";
import * as reactionAdd from "./events/reactionAdd.js";
import * as reactionRemove from "./events/reactionRemove.js";

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
	console.error("Failed to initialize database:", err);
	process.exit(1);
});

// Register event handlers
client.on(reactionAdd.name, reactionAdd.execute);
client.on(reactionRemove.name, reactionRemove.execute);

// Handle slash commands
client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	const command = commands.find(
		(cmd) => cmd.data.name === interaction.commandName,
	);

	if (!command) {
		console.error(`Unknown command: ${interaction.commandName}`);
		return;
	}

	try {
		await command.execute(interaction as ChatInputCommandInteraction);
	} catch (error) {
		console.error(`Error executing command ${interaction.commandName}:`, error);

		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: "There was an error executing this command.",
				ephemeral: true,
			});
		} else {
			await interaction.reply({
				content: "There was an error executing this command.",
				ephemeral: true,
			});
		}
	}
});

// Ready event
client.once(Events.ClientReady, async (readyClient) => {
	console.log(`Logged in as ${readyClient.user.tag}`);

	// Register slash commands
	await registerCommands();
});

// Login
client.login(config.botToken);
