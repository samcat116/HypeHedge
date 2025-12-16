import { type ChatInputCommandInteraction, REST, Routes } from "discord.js";
import { config } from "../config.js";
import { withSpan } from "../telemetry/index.js";
import { logger } from "../telemetry/logger.js";
import {
	commandDuration,
	commandErrorsCounter,
	commandInvocationsCounter,
} from "../telemetry/metrics.js";
import * as backfill from "./backfill.js";
import * as balance from "./balance.js";
import * as leaderboard from "./leaderboard.js";
import * as market from "./market.js";

export const commands = [balance, leaderboard, backfill, market];

const commandData = commands.map((cmd) => cmd.data.toJSON());

export async function registerCommands(): Promise<void> {
	const rest = new REST().setToken(config.botToken);

	logger.info("Registering slash commands...");

	await rest.put(Routes.applicationCommands(config.clientId), {
		body: commandData,
	});

	logger.info("Slash commands registered.");
}

export async function executeWithTelemetry(
	commandName: string,
	interaction: ChatInputCommandInteraction,
	executeFn: (interaction: ChatInputCommandInteraction) => Promise<void>,
): Promise<void> {
	const startTime = performance.now();

	commandInvocationsCounter.add(1, { command: commandName });

	await withSpan(
		`command.${commandName}`,
		{
			"discord.command": commandName,
			"discord.user_id": interaction.user.id,
			"discord.guild_id": interaction.guildId ?? "dm",
			"discord.channel_id": interaction.channelId,
		},
		async () => {
			try {
				await executeFn(interaction);

				logger.info(`Command executed: ${commandName}`, {
					userId: interaction.user.id,
					guildId: interaction.guildId,
				});
			} catch (error) {
				commandErrorsCounter.add(1, { command: commandName });
				logger.error(`Command failed: ${commandName}`, {
					error: error instanceof Error ? error.message : String(error),
					userId: interaction.user.id,
				});

				// Send error response to user
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
			} finally {
				const duration = performance.now() - startTime;
				commandDuration.record(duration, { command: commandName });
			}
		},
	);
}
