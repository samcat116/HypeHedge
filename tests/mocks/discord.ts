import type {
	ButtonInteraction,
	ChatInputCommandInteraction,
	MessageReaction,
	User,
} from "discord.js";
import { vi } from "vitest";

export function createMockUser(overrides: Partial<User> = {}): Partial<User> {
	return {
		id: "123456789",
		username: "testuser",
		displayName: "Test User",
		bot: false,
		...overrides,
	};
}

export function createMockChatInputInteraction(
	overrides: Partial<ChatInputCommandInteraction> = {},
): Partial<ChatInputCommandInteraction> {
	const mockUser = createMockUser();

	return {
		user: mockUser as User,
		guildId: "987654321",
		channelId: "111222333",
		commandName: "test",
		replied: false,
		deferred: false,
		reply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn().mockResolvedValue(undefined),
		editReply: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
		options: {
			getSubcommand: vi.fn().mockReturnValue("test"),
			getSubcommandGroup: vi.fn().mockReturnValue(null),
			getString: vi.fn().mockReturnValue(null),
			getInteger: vi.fn().mockReturnValue(null),
			getNumber: vi.fn().mockReturnValue(null),
			getUser: vi.fn().mockReturnValue(null),
			getBoolean: vi.fn().mockReturnValue(null),
		},
		isChatInputCommand: () => true,
		isButton: () => false,
		isModalSubmit: () => false,
		isStringSelectMenu: () => false,
		isAutocomplete: () => false,
		...overrides,
	} as unknown as Partial<ChatInputCommandInteraction>;
}

export function createMockButtonInteraction(
	customId: string,
	overrides: Partial<ButtonInteraction> = {},
): Partial<ButtonInteraction> {
	return {
		customId,
		user: createMockUser() as User,
		guildId: "987654321",
		update: vi.fn().mockResolvedValue(undefined),
		reply: vi.fn().mockResolvedValue(undefined),
		deferUpdate: vi.fn().mockResolvedValue(undefined),
		isButton: () => true,
		...overrides,
	} as unknown as Partial<ButtonInteraction>;
}

export function createMockMessageReaction(
	overrides: Partial<MessageReaction> = {},
): Partial<MessageReaction> {
	return {
		partial: false,
		emoji: { id: null, name: "👍" },
		message: {
			id: "444555666",
			channelId: "111222333",
			guildId: "987654321",
			partial: false,
			author: createMockUser(),
			fetch: vi.fn(),
		},
		fetch: vi.fn(),
		...overrides,
	} as unknown as Partial<MessageReaction>;
}
