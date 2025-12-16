import { Events, MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import { addReaction } from "../database.js";

export const name = Events.MessageReactionAdd;

export async function execute(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  try {
    // Fetch partial reaction if needed
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }

    // Fetch partial user if needed
    if (user.partial) {
      user = await user.fetch();
    }

    const message = reaction.message;

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
    if (user.id === authorId) {
      return;
    }

    // Skip bot messages
    if (message.author?.bot) {
      return;
    }

    const emoji = reaction.emoji.id ?? reaction.emoji.name ?? "unknown";

    await addReaction(message.id, user.id, authorId, emoji);
  } catch (error) {
    console.error("Error handling reaction add:", error);
  }
}
