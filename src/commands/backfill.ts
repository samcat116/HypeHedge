import {
	ChannelType,
	type ChatInputCommandInteraction,
	MessageFlags,
	PermissionFlagsBits,
	SlashCommandBuilder,
	type TextChannel,
} from "discord.js";
import {
	type ReactionBatchItem,
	addReactionsBatch,
	getGuildBackfillProgress,
	getOrCreateChannelProgress,
	markChannelCompleted,
	resetGuildBackfillProgress,
	resetStaleProgress,
	updateChannelProgress,
} from "../database.js";
import { withSpan } from "../telemetry/index.js";
import { logger } from "../telemetry/logger.js";
import {
	backfillBatchCounter,
	backfillBatchDuration,
	meter,
} from "../telemetry/metrics.js";

export const data = new SlashCommandBuilder()
	.setName("backfill")
	.setDescription(
		"Scan message history and backfill currency from past reactions",
	)
	.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
	.addIntegerOption((option) =>
		option
			.setName("limit")
			.setDescription("Max messages per channel (leave empty for unlimited)")
			.setRequired(false)
			.setMinValue(100),
	)
	.addBooleanOption((option) =>
		option
			.setName("reset")
			.setDescription("Reset progress and start from scratch")
			.setRequired(false),
	)
	.addIntegerOption((option) =>
		option
			.setName("concurrency")
			.setDescription(
				"Number of channels to process in parallel (1-5, default 3)",
			)
			.setRequired(false)
			.setMinValue(1)
			.setMaxValue(5),
	);

// Simple semaphore for concurrency control
class Semaphore {
	private queue: Array<() => void> = [];
	private running = 0;

	constructor(private concurrency: number) {}

	async acquire(): Promise<void> {
		if (this.running < this.concurrency) {
			this.running++;
			return;
		}

		return new Promise((resolve) => {
			this.queue.push(resolve);
		});
	}

	release(): void {
		this.running--;
		const next = this.queue.shift();
		if (next) {
			this.running++;
			next();
		}
	}
}

interface ChannelResult {
	channelId: string;
	channelName: string;
	messagesProcessed: number;
	reactionsAdded: number;
	status: "completed" | "skipped" | "error";
	error?: string;
}

interface ProgressState {
	totalMessages: number;
	totalReactions: number;
	channelsCompleted: number;
	channelsInProgress: Set<string>;
}

async function processChannel(
	textChannel: TextChannel,
	guildId: string,
	limit: number | null,
	progress: ProgressState,
	updateProgress: () => void,
): Promise<ChannelResult> {
	return withSpan(
		"backfill.channel",
		{
			"backfill.channel_id": textChannel.id,
			"backfill.channel_name": textChannel.name,
			"backfill.guild_id": guildId,
		},
		async (channelSpan) => {
			const result: ChannelResult = {
				channelId: textChannel.id,
				channelName: textChannel.name,
				messagesProcessed: 0,
				reactionsAdded: 0,
				status: "completed",
			};

			try {
				// Get or create progress record
				const channelProgress = await getOrCreateChannelProgress(
					guildId,
					textChannel.id,
				);

				// Skip if already completed
				if (channelProgress.status === "completed") {
					result.messagesProcessed = channelProgress.messagesProcessed;
					result.reactionsAdded = channelProgress.reactionsAdded;
					result.status = "skipped";
					channelSpan.addEvent("channel_skipped", {
						reason: "already_completed",
					});
					return result;
				}

				// Resume from last checkpoint
				let lastMessageId: string | undefined =
					channelProgress.lastMessageId ?? undefined;
				let channelMessages = channelProgress.messagesProcessed;
				let channelReactions = channelProgress.reactionsAdded;

				progress.channelsInProgress.add(textChannel.name);
				updateProgress();

				while (true) {
					if (limit !== null && channelMessages >= limit) break;

					const fetchLimit =
						limit !== null ? Math.min(100, limit - channelMessages) : 100;

					const batchStartTime = performance.now();

					// Each batch gets its own span (short-lived)
					const batchResult = await withSpan(
						"backfill.batch",
						{
							"backfill.batch_size": fetchLimit,
							"backfill.channel_id": textChannel.id,
						},
						async (batchSpan) => {
							const messages = await textChannel.messages.fetch({
								limit: fetchLimit,
								...(lastMessageId && { before: lastMessageId }),
							});

							if (messages.size === 0) {
								batchSpan.addEvent("no_more_messages");
								return { done: true, messagesCount: 0, reactionsCount: 0 };
							}

							// Collect reactions for batch insert
							const reactionBatch: ReactionBatchItem[] = [];

							for (const [, message] of messages) {
								if (message.author.bot) continue;

								for (const [, reaction] of message.reactions.cache) {
									const emoji =
										reaction.emoji.id ?? reaction.emoji.name ?? "unknown";

									try {
										const users = await reaction.users.fetch();

										for (const [, user] of users) {
											if (user.id === message.author.id) continue; // Skip self-reactions
											if (user.bot) continue;

											reactionBatch.push({
												messageId: message.id,
												reactorId: user.id,
												authorId: message.author.id,
												emoji,
											});
										}
									} catch {
										// Reaction may have been removed, continue
									}
								}

								channelMessages++;
							}

							// Batch insert reactions
							const added = await addReactionsBatch(reactionBatch);
							channelReactions += added;

							lastMessageId = messages.last()?.id;

							// Update checkpoint after each batch
							if (lastMessageId) {
								await updateChannelProgress(
									guildId,
									textChannel.id,
									lastMessageId,
									messages.size,
									added,
								);
							}

							batchSpan.setAttributes({
								"backfill.messages_in_batch": messages.size,
								"backfill.reactions_added": added,
							});

							return {
								done: false,
								messagesCount: messages.size,
								reactionsCount: added,
							};
						},
					);

					const batchDuration = performance.now() - batchStartTime;
					backfillBatchDuration.record(batchDuration, {
						channel_id: textChannel.id,
					});
					backfillBatchCounter.add(1, { channel_id: textChannel.id });

					if (batchResult.done) break;

					// Update shared progress state
					progress.totalMessages += batchResult.messagesCount;
					progress.totalReactions += batchResult.reactionsCount;
					updateProgress();

					// Record span event for progress
					channelSpan.addEvent("batch_completed", {
						messages_processed: channelMessages,
						reactions_added: channelReactions,
					});
				}

				// Mark channel as completed
				await markChannelCompleted(guildId, textChannel.id);

				result.messagesProcessed = channelMessages;
				result.reactionsAdded = channelReactions;

				channelSpan.setAttributes({
					"backfill.total_messages": channelMessages,
					"backfill.total_reactions": channelReactions,
				});
			} catch (error) {
				result.status = "error";
				result.error = error instanceof Error ? error.message : String(error);
				logger.error(`Error processing channel ${textChannel.name}`, {
					channelId: textChannel.id,
					error: result.error,
				});
				throw error;
			} finally {
				progress.channelsInProgress.delete(textChannel.name);
			}

			return result;
		},
	);
}

export async function execute(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (!interaction.guild) {
		await interaction.reply({
			content: "This command can only be used in a server.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const limit = interaction.options.getInteger("limit") ?? null;
	const reset = interaction.options.getBoolean("reset") ?? false;
	const concurrency = interaction.options.getInteger("concurrency") ?? 3;

	const guild = interaction.guild;
	const guildId = guild.id;

	logger.info("Starting backfill", {
		guildId,
		limit,
		reset,
		concurrency,
	});

	// Handle reset flag
	if (reset) {
		await resetGuildBackfillProgress(guildId);
	}

	// Check for existing progress
	const existingProgress = await getGuildBackfillProgress(guildId);
	const hasExistingProgress = existingProgress.some(
		(p) => p.status === "in_progress" || p.status === "completed",
	);
	const completedChannels = existingProgress.filter(
		(p) => p.status === "completed",
	).length;
	const previousMessages = existingProgress.reduce(
		(sum, p) => sum + p.messagesProcessed,
		0,
	);
	const previousReactions = existingProgress.reduce(
		(sum, p) => sum + p.reactionsAdded,
		0,
	);

	// Reset stale in_progress records (crashed runs)
	await resetStaleProgress(guildId);

	// Get accessible text channels
	const channels = guild.channels.cache.filter(
		(channel) => channel.type === ChannelType.GuildText,
	);
	const accessibleChannels: TextChannel[] = [];

	for (const [, channel] of channels) {
		const textChannel = channel as TextChannel;
		const botMember = guild.members.me;
		if (!botMember) continue;
		const permissions = textChannel.permissionsFor(botMember);
		if (
			permissions?.has("ViewChannel") &&
			permissions?.has("ReadMessageHistory")
		) {
			accessibleChannels.push(textChannel);
		}
	}

	// Initial reply
	if (hasExistingProgress && !reset) {
		await interaction.reply({
			content: `Resuming backfill from previous run...\nPreviously: ${completedChannels} channels done, ${previousMessages.toLocaleString()} messages, ${previousReactions.toLocaleString()} reactions\nProcessing ${accessibleChannels.length} channels with concurrency ${concurrency}`,
			flags: MessageFlags.Ephemeral,
		});
	} else {
		await interaction.reply({
			content: limit
				? `Starting backfill... Scanning up to ${limit} messages per channel.\nProcessing ${accessibleChannels.length} channels with concurrency ${concurrency}`
				: `Starting backfill... Scanning all message history.\nProcessing ${accessibleChannels.length} channels with concurrency ${concurrency}`,
			flags: MessageFlags.Ephemeral,
		});
	}

	// Shared progress state
	const progress: ProgressState = {
		totalMessages: previousMessages,
		totalReactions: previousReactions,
		channelsCompleted: completedChannels,
		channelsInProgress: new Set(),
	};

	// Register observable gauges for real-time progress
	// Note: These gauges are created per-backfill run and observe current progress state
	// The callbacks remain active but will just report final values after completion
	const channelsGauge = meter.createObservableGauge(
		"backfill.channels.completed",
		{
			description: "Number of channels completed in current backfill",
			unit: "1",
		},
	);
	const messagesGauge = meter.createObservableGauge(
		"backfill.messages.processed",
		{
			description: "Number of messages processed in current backfill",
			unit: "1",
		},
	);
	const reactionsGauge = meter.createObservableGauge(
		"backfill.reactions.added",
		{
			description: "Number of reactions added in current backfill",
			unit: "1",
		},
	);

	channelsGauge.addCallback((result) => {
		result.observe(progress.channelsCompleted, { guild_id: guildId });
	});
	messagesGauge.addCallback((result) => {
		result.observe(progress.totalMessages, { guild_id: guildId });
	});
	reactionsGauge.addCallback((result) => {
		result.observe(progress.totalReactions, { guild_id: guildId });
	});

	// Debounced progress updates
	let lastUpdate = 0;
	const UPDATE_INTERVAL = 5000; // 5 seconds

	const updateProgressFn = async () => {
		const now = Date.now();
		if (now - lastUpdate < UPDATE_INTERVAL) return;
		lastUpdate = now;

		const inProgressText =
			progress.channelsInProgress.size > 0
				? `\nProcessing: ${[...progress.channelsInProgress].map((c) => `#${c}`).join(", ")}`
				: "";

		try {
			await interaction.editReply({
				content: `Backfill in progress...\nChannels: ${progress.channelsCompleted}/${accessibleChannels.length} completed${inProgressText}\nMessages scanned: ${progress.totalMessages.toLocaleString()}\nReactions added: ${progress.totalReactions.toLocaleString()}`,
			});
		} catch {
			// Ignore edit errors
		}
	};

	// Process channels with limited concurrency
	const semaphore = new Semaphore(concurrency);
	const results: ChannelResult[] = [];

	const promises = accessibleChannels.map(async (channel) => {
		await semaphore.acquire();
		try {
			const result = await processChannel(
				channel,
				guildId,
				limit,
				progress,
				updateProgressFn,
			);
			if (result.status !== "skipped") {
				progress.channelsCompleted++;
			}
			results.push(result);
			updateProgressFn();
			return result;
		} catch (error) {
			// Error already logged in processChannel, just collect the result
			results.push({
				channelId: channel.id,
				channelName: channel.name,
				messagesProcessed: 0,
				reactionsAdded: 0,
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			semaphore.release();
		}
	});

	await Promise.all(promises);

	// Final summary
	const errors = results.filter((r) => r.status === "error");
	const errorText =
		errors.length > 0
			? `\n\nErrors in ${errors.length} channel(s):\n${errors
					.map((e) => `- #${e.channelName}: ${e.error}`)
					.join("\n")}`
			: "";

	logger.info("Backfill complete", {
		guildId,
		channelsScanned: progress.channelsCompleted,
		messagesScanned: progress.totalMessages,
		reactionsAdded: progress.totalReactions,
		errorCount: errors.length,
	});

	await interaction.editReply({
		content: `Backfill complete!\n- Channels scanned: ${progress.channelsCompleted}\n- Messages scanned: ${progress.totalMessages.toLocaleString()}\n- Reactions added: ${progress.totalReactions.toLocaleString()}${errorText}`,
	});
}
