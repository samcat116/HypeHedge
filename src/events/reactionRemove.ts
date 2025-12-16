import {
	Events,
	type MessageReaction,
	type PartialMessageReaction,
	type PartialUser,
	type User,
} from "discord.js";
import { removeReaction } from "../database.js";

export const name = Events.MessageReactionRemove;

export async function execute(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	try {
		// Fetch partial reaction if needed
		const fullReaction = reaction.partial ? await reaction.fetch() : reaction;

		const emoji = fullReaction.emoji.id ?? fullReaction.emoji.name ?? "unknown";

		await removeReaction(fullReaction.message.id, user.id, emoji);
	} catch (error) {
		console.error("Error handling reaction remove:", error);
	}
}
