import { Events, MessageReaction, User, PartialMessageReaction, PartialUser } from "discord.js";
import { removeReaction } from "../database.js";

export const name = Events.MessageReactionRemove;

export async function execute(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
): Promise<void> {
  try {
    // Fetch partial reaction if needed
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }

    const emoji = reaction.emoji.id ?? reaction.emoji.name ?? "unknown";

    removeReaction(reaction.message.id, user.id, emoji);
  } catch (error) {
    console.error("Error handling reaction remove:", error);
  }
}
