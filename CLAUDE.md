# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # Start bot with hot-reload (watch mode)
bun run start        # Start bot in production mode
bun run lint         # Check code style with Biome
bun run lint:fix     # Auto-fix linting issues
bun run typecheck    # TypeScript type checking

# Database migrations (Drizzle Kit)
npx drizzle-kit generate   # Generate migration from schema changes
npx drizzle-kit migrate    # Apply pending migrations
npx drizzle-kit studio     # Open Drizzle Studio GUI
```

## Architecture

This is a Discord bot that awards currency to message authors when their messages receive reactions.

### Core Flow
1. User reacts to a message → `events/reactionAdd.ts` fires
2. Reaction is recorded in `reactions` table, author's balance incremented in `users` table
3. Users check balances via `/balance`, view rankings via `/leaderboard`

### Directory Structure
- `src/commands/` - Slash commands (balance, leaderboard, backfill). Each exports `data` (SlashCommandBuilder) and `execute` function
- `src/events/` - Discord event handlers (reactionAdd, reactionRemove)
- `src/db/schema.ts` - Drizzle ORM table definitions (users, reactions, backfill_progress)
- `src/database.ts` - Database operations (addReaction, removeReaction, getBalance, getLeaderboard, etc.)
- `src/index.ts` - Bot entry point, registers event handlers and routes interactions

### Interaction Handling
- Slash commands: Routed via `interaction.isChatInputCommand()` in index.ts
- Button interactions: Routed via `interaction.isButton()` with custom ID prefixes (e.g., `leaderboard:next:0`)

### Database
- PostgreSQL via `postgres` driver + Drizzle ORM
- Schema in `src/db/schema.ts`, migrations in `drizzle/`
- Key tables: `users` (discord_id, balance), `reactions` (message_id, reactor_id, author_id, emoji)

### Environment Variables
Required in `.env`: `BOT_TOKEN`, `CLIENT_ID`, `DATABASE_URL`
