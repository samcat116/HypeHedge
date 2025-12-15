import { Database } from "bun:sqlite";
import path from "path";

const dbPath = path.join(import.meta.dir, "..", "data.db");
const db = new Database(dbPath);

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      discord_id TEXT PRIMARY KEY,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      reactor_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, reactor_id, emoji)
    );

    CREATE INDEX IF NOT EXISTS idx_reactions_author ON reactions(author_id);
  `);
}

export function addReaction(
  messageId: string,
  reactorId: string,
  authorId: string,
  emoji: string
): boolean {
  const insertReaction = db.prepare(`
    INSERT OR IGNORE INTO reactions (message_id, reactor_id, author_id, emoji)
    VALUES (?, ?, ?, ?)
  `);

  const upsertUser = db.prepare(`
    INSERT INTO users (discord_id, balance)
    VALUES (?, 1)
    ON CONFLICT(discord_id) DO UPDATE SET balance = balance + 1
  `);

  const result = insertReaction.run(messageId, reactorId, authorId, emoji);

  if (result.changes > 0) {
    upsertUser.run(authorId);
    return true;
  }

  return false;
}

export function removeReaction(
  messageId: string,
  reactorId: string,
  emoji: string
): boolean {
  const getReaction = db.prepare(`
    SELECT author_id FROM reactions
    WHERE message_id = ? AND reactor_id = ? AND emoji = ?
  `);

  const deleteReaction = db.prepare(`
    DELETE FROM reactions
    WHERE message_id = ? AND reactor_id = ? AND emoji = ?
  `);

  const decrementBalance = db.prepare(`
    UPDATE users SET balance = balance - 1
    WHERE discord_id = ? AND balance > 0
  `);

  const reaction = getReaction.get(messageId, reactorId, emoji) as
    | { author_id: string }
    | undefined;

  if (reaction) {
    deleteReaction.run(messageId, reactorId, emoji);
    decrementBalance.run(reaction.author_id);
    return true;
  }

  return false;
}

export function getBalance(userId: string): number {
  const stmt = db.prepare(`SELECT balance FROM users WHERE discord_id = ?`);
  const result = stmt.get(userId) as { balance: number } | undefined;
  return result?.balance ?? 0;
}

export interface LeaderboardEntry {
  discord_id: string;
  balance: number;
  rank: number;
}

export function getLeaderboard(limit: number = 10): LeaderboardEntry[] {
  const stmt = db.prepare(`
    SELECT discord_id, balance,
           ROW_NUMBER() OVER (ORDER BY balance DESC) as rank
    FROM users
    WHERE balance > 0
    ORDER BY balance DESC
    LIMIT ?
  `);

  return stmt.all(limit) as LeaderboardEntry[];
}
