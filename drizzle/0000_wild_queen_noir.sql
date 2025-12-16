CREATE TABLE "backfill_progress" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"last_message_id" text,
	"messages_processed" integer DEFAULT 0 NOT NULL,
	"reactions_added" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backfill_progress_guild_id_channel_id_unique" UNIQUE("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "reactions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"reactor_id" text NOT NULL,
	"author_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reactions_message_id_reactor_id_emoji_unique" UNIQUE("message_id","reactor_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"discord_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
