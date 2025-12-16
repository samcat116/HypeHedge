import {
	Events,
	type MessageReaction,
	type PartialMessageReaction,
	type PartialUser,
	type User,
} from "discord.js";
import { addReaction } from "../database.js";

export const name = Events.MessageReactionAdd;

export async function execute(
	reaction: MessageReaction | PartialMessageReaction,
	user: User | PartialUser,
): Promise<void> {
	try {
		// Fetch partial reaction if needed
		const fullReaction = reaction.partial ? await reaction.fetch() : reaction;

		// Fetch partial user if needed
		const fullUser = user.partial ? await user.fetch() : user;

		const message = fullReaction.message;

		// Fetch message if partial to get author
		if (message.partial) {
			await message.fetch();
		}

		const authorId = message.author?.id;

		// Skip if no author (shouldn't happen, but be safe)
		if (!authorId) {
			return;
		}

		// Skip self-reactions
		if (fullUser.id === authorId) {
			return;
		}

		// Skip bot messages
		if (message.author?.bot) {
			return;
		}

		const emoji = fullReaction.emoji.id ?? fullReaction.emoji.name ?? "unknown";

		await addReaction(message.id, fullUser.id, authorId, emoji);
	} catch (error) {
		console.error("Error handling reaction add:", error);
	}
}
