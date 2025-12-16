import {
	Events,
	type MessageReaction,
	type PartialMessageReaction,
	type PartialUser,
	type User,
} from "discord.js";
import { removeReaction } from "../database.js";
import { withSpan } from "../telemetry/index.js";
import { logger } from "../telemetry/logger.js";
import {
	reactionProcessingDuration,
	reactionsRemovedCounter,
} from "../telemetry/metrics.js";

export const name = Events.MessageReactionRemove;

export async function execute(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	const startTime = performance.now();

	try {
		await withSpan(
			"reaction.remove",
			{
				"discord.event": "MessageReactionRemove",
				"discord.guild_id": reaction.message.guildId ?? "dm",
				"discord.channel_id": reaction.message.channelId,
				"discord.reactor_id": user.id,
			},
			async (span) => {
				// Fetch partial reaction if needed
				const fullReaction = reaction.partial
					? await reaction.fetch()
					: reaction;

				const emoji =
					fullReaction.emoji.id ?? fullReaction.emoji.name ?? "unknown";

				span.setAttributes({
					"discord.message_id": fullReaction.message.id,
					"discord.emoji": emoji,
				});

				const removed = await removeReaction(
					fullReaction.message.id,
					user.id,
					emoji,
				);

				if (removed) {
					reactionsRemovedCounter.add(1, {
						emoji,
						guild_id: reaction.message.guildId ?? "dm",
					});
					span.addEvent("reaction_removed");
				} else {
					span.addEvent("reaction_not_found");
				}
			},
		);
	} catch (error) {
		logger.error("Error handling reaction remove", {
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		const duration = performance.now() - startTime;
		reactionProcessingDuration.record(duration, { event: "remove" });
	}
}
