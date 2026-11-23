export type SQLiteBindValue =
  | string
  | number
  | null
  | boolean
  | Uint8Array;

export type SQLiteBindParams =
  | Record<string, SQLiteBindValue>
  | SQLiteBindValue[];

export interface SQLiteRunResultLike {
  changes: number;
  lastInsertRowId: number;
}

/**
 * Minimal async SQLite interface compatible with expo-sqlite's SQLiteDatabase
 * and in-memory test adapters.
 */
export interface SQLiteDatabaseLike {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SQLiteBindParams): Promise<SQLiteRunResultLike>;
  runAsync(source: string, ...params: SQLiteBindValue[]): Promise<SQLiteRunResultLike>;
  getAllAsync<T>(source: string, params: SQLiteBindParams): Promise<T[]>;
  getAllAsync<T>(source: string, ...params: SQLiteBindValue[]): Promise<T[]>;
  getFirstAsync<T>(source: string, params: SQLiteBindParams): Promise<T | null>;
  getFirstAsync<T>(source: string, ...params: SQLiteBindValue[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export const DEFAULT_DATABASE_NAME = 'musubireader.db';
export const SCHEMA_VERSION = 1;

const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_packs (
  pack_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_enabled INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS remote_feeds (
  site_id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES remote_packs(pack_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rss_url TEXT NOT NULL,
  category TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_remote_feeds_pack_id
  ON remote_feeds (pack_id, sort_order);

CREATE TABLE IF NOT EXISTS user_pack_settings (
  pack_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_feed_overrides (
  site_id TEXT PRIMARY KEY,
  muted INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_feeds (
  site_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rss_url TEXT NOT NULL,
  category TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  site_name TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  is_saved INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  is_prefetched INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_articles_pack_category_published
  ON articles (pack_id, category, published_at DESC);

CREATE INDEX IF NOT EXISTS idx_articles_is_saved
  ON articles (is_saved);

CREATE TABLE IF NOT EXISTS interest_keywords (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ng_words (
  id TEXT PRIMARY KEY,
  word TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS read_history (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  category TEXT NOT NULL,
  read_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_read_history_read_at
  ON read_history (read_at DESC);

CREATE TABLE IF NOT EXISTS prefetch_cache (
  article_id TEXT PRIMARY KEY,
  local_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  cached_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/**
 * Applies idempotent schema migrations and enables SQLite foreign keys.
 */
export async function runMigrations(db: SQLiteDatabaseLike): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  await db.withTransactionAsync(async () => {
    await db.execAsync(MIGRATION_V1_SQL);
    await db.runAsync(
      'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      [SCHEMA_VERSION, Date.now()]
    );
  });
}

/**
 * Opens the SQLite database (or wraps a provided SQLiteDatabaseLike instance)
 * and ensures all schema migrations have been applied.
 */
export async function openDatabase(
  db?: SQLiteDatabaseLike
): Promise<SQLiteDatabaseLike> {
  let targetDb = db;
  if (!targetDb) {
    const SQLite = await import('expo-sqlite');
    targetDb = await SQLite.openDatabaseAsync(DEFAULT_DATABASE_NAME);
  }
  await runMigrations(targetDb);
  return targetDb;
}
