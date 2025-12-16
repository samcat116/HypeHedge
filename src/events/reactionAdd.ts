import {
	Events,
	type MessageReaction,
	type PartialMessageReaction,
	type PartialUser,
	type User,
} from "discord.js";
import { addReaction } from "../database.js";
import { withSpan } from "../telemetry/index.js";
import { logger } from "../telemetry/logger.js";
import {
	botReactionsSkippedCounter,
	reactionProcessingDuration,
	reactionsAddedCounter,
	selfReactionsSkippedCounter,
} from "../telemetry/metrics.js";

export const name = Events.MessageReactionAdd;

export async function execute(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	const startTime = performance.now();

	try {
		await withSpan(
			"reaction.add",
			{
				"discord.event": "MessageReactionAdd",
				"discord.guild_id": reaction.message.guildId ?? "dm",
				"discord.channel_id": reaction.message.channelId,
			},
			async (span) => {
				// Fetch partial reaction if needed
				const fullReaction = reaction.partial
					? await reaction.fetch()
					: reaction;

				// Fetch partial user if needed
				const fullUser = user.partial ? await user.fetch() : user;

				const message = fullReaction.message;

				// Fetch message if partial to get author
				if (message.partial) {
					await message.fetch();
				}

				const authorId = message.author?.id;
				const emoji =
					fullReaction.emoji.id ?? fullReaction.emoji.name ?? "unknown";

				span.setAttributes({
					"discord.message_id": message.id,
					"discord.reactor_id": fullUser.id,
					"discord.emoji": emoji,
				});

				// Skip if no author (shouldn't happen, but be safe)
				if (!authorId) {
					span.addEvent("skipped", { reason: "no_author" });
					return;
				}

				span.setAttribute("discord.author_id", authorId);

				// Skip self-reactions
				if (fullUser.id === authorId) {
					selfReactionsSkippedCounter.add(1, { emoji });
					span.addEvent("skipped", { reason: "self_reaction" });
					return;
				}

				// Skip bot messages
				if (message.author?.bot) {
					botReactionsSkippedCounter.add(1, { emoji });
					span.addEvent("skipped", { reason: "bot_message" });
					return;
				}

				const added = await addReaction(
					message.id,
					fullUser.id,
					authorId,
					emoji,
				);

				if (added) {
					reactionsAddedCounter.add(1, {
						emoji,
						guild_id: reaction.message.guildId ?? "dm",
					});
					span.addEvent("reaction_recorded");
				} else {
					span.addEvent("duplicate_reaction");
				}
			},
		);
	} catch (error) {
		logger.error("Error handling reaction add", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		const duration = performance.now() - startTime;
		reactionProcessingDuration.record(duration, { event: "add" });
	}
}
