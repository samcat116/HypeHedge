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
			const messages = await textChannel.messages.fetch({
				limit: fetchLimit,
				...(lastMessageId && { before: lastMessageId }),
			});

			if (messages.size === 0) break;

			// Collect reactions for batch insert
			const reactionBatch: ReactionBatchItem[] = [];

			for (const [, message] of messages) {
				if (message.author.bot) continue;

				for (const [, reaction] of message.reactions.cache) {
					const emoji = reaction.emoji.id ?? reaction.emoji.name ?? "unknown";

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

			// Update shared progress state
			progress.totalMessages += messages.size;
			progress.totalReactions += added;
			updateProgress();
		}

		// Mark channel as completed
		await markChannelCompleted(guildId, textChannel.id);

		result.messagesProcessed = channelMessages;
		result.reactionsAdded = channelReactions;
	} catch (error) {
		result.status = "error";
		result.error = error instanceof Error ? error.message : String(error);
		console.error(`Error processing channel ${textChannel.name}:`, error);
	} finally {
		progress.channelsInProgress.delete(textChannel.name);
	}

	return result;
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

	// Debounced progress updates
	let lastUpdate = 0;
	const UPDATE_INTERVAL = 5000; // 5 seconds

	const updateProgress = async () => {
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
				updateProgress,
			);
			if (result.status !== "skipped") {
				progress.channelsCompleted++;
			}
			results.push(result);
			updateProgress();
			return result;
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

	await interaction.editReply({
		content: `Backfill complete!\n- Channels scanned: ${progress.channelsCompleted}\n- Messages scanned: ${progress.totalMessages.toLocaleString()}\n- Reactions added: ${progress.totalReactions.toLocaleString()}${errorText}`,
	});
}
