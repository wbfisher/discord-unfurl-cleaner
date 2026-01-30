import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';
import type { ChannelConfig } from '../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/unfurl.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
    logger.info(`Database initialized at ${DB_PATH}`);
  }
  return db;
}

function initSchema(): void {
  const database = getDb();
  database.exec(`
    CREATE TABLE IF NOT EXISTS channel_config (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_guild ON channel_config(guild_id);
  `);
}

export function isChannelEnabled(channelId: string): boolean {
  const database = getDb();
  const row = database
    .prepare('SELECT enabled FROM channel_config WHERE channel_id = ?')
    .get(channelId) as { enabled: number } | undefined;

  // Default to disabled if not configured
  return row?.enabled === 1;
}

export function enableChannel(channelId: string, guildId: string): void {
  const database = getDb();
  const now = Date.now();

  database
    .prepare(`
      INSERT INTO channel_config (channel_id, guild_id, enabled, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        enabled = 1,
        updated_at = excluded.updated_at
    `)
    .run(channelId, guildId, now, now);

  logger.info(`Channel ${channelId} enabled in guild ${guildId}`);
}

export function disableChannel(channelId: string, guildId: string): void {
  const database = getDb();
  const now = Date.now();

  database
    .prepare(`
      INSERT INTO channel_config (channel_id, guild_id, enabled, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(channel_id) DO UPDATE SET
        enabled = 0,
        updated_at = excluded.updated_at
    `)
    .run(channelId, guildId, now, now);

  logger.info(`Channel ${channelId} disabled in guild ${guildId}`);
}

export function getChannelConfig(channelId: string): ChannelConfig | null {
  const database = getDb();
  const row = database
    .prepare('SELECT channel_id, guild_id, enabled, created_at, updated_at FROM channel_config WHERE channel_id = ?')
    .get(channelId) as {
      channel_id: string;
      guild_id: string;
      enabled: number;
      created_at: number;
      updated_at: number;
    } | undefined;

  if (!row) return null;

  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getEnabledChannelsForGuild(guildId: string): string[] {
  const database = getDb();
  const rows = database
    .prepare('SELECT channel_id FROM channel_config WHERE guild_id = ? AND enabled = 1')
    .all(guildId) as Array<{ channel_id: string }>;

  return rows.map(row => row.channel_id);
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database closed');
  }
}

// Ensure database is closed on exit
process.on('exit', closeDatabase);
process.on('SIGINT', () => {
  closeDatabase();
  process.exit(0);
});
process.on('SIGTERM', () => {
  closeDatabase();
  process.exit(0);
});
