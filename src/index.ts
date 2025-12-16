import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import { config } from "./config.js";
import { initDatabase } from "./database.js";
import { registerCommands, commands } from "./commands/index.js";
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
    (cmd) => cmd.data.name === interaction.commandName
  );

  if (!command) {
    console.error(`Unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction as ChatInputCommandInteraction);
  } catch (error) {
    console.error(`Error executing command ${interaction.commandName}:`, error);

    const reply = {
      content: "There was an error executing this command.",
      flags: MessageFlags.Ephemeral,
    };

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
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
