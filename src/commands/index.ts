import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../config.js";
import * as balance from "./balance.js";
import * as leaderboard from "./leaderboard.js";
import * as backfill from "./backfill.js";

export const commands = [balance, leaderboard, backfill];

const commandData = commands.map((cmd) => cmd.data.toJSON());

export async function registerCommands(): Promise<void> {
  const rest = new REST().setToken(config.botToken);

  console.log("Registering slash commands...");

  await rest.put(Routes.applicationCommands(config.clientId), {
    body: commandData,
  });

  console.log("Slash commands registered.");
}
