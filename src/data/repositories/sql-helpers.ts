import type {
  CustomFeed,
  InterestKeyword,
  NgWord,
  UserFeedOverride,
  UserPackSetting,
} from '../../domain/types';
import type { SQLiteDatabaseLike } from '../database';

export type WordRuleTable = 'interest_keywords' | 'ng_words';

interface PackSettingRow {
  pack_id: string;
  enabled: number;
  updated_at: number;
}

interface FeedOverrideRow {
  site_id: string;
  muted: number;
  updated_at: number;
}

interface CustomFeedRow {
  site_id: string;
  name: string;
  rss_url: string;
  category: string;
  muted: number;
  created_at: number;
}

interface WordRuleRow {
  id: string;
  word: string;
  enabled: number;
  created_at: number;
}

export function toSqlBool(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

export function fromSqlBool(value: number | boolean): boolean {
  return value === 1 || value === true;
}

export function chunkItems<T>(items: readonly T[], size = 500): T[][] {
  if (items.length === 0) {
    return [];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function buildInPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

export function mapPackSettingRow(row: PackSettingRow): UserPackSetting {
  return {
    packId: row.pack_id,
    enabled: fromSqlBool(row.enabled),
    updatedAt: row.updated_at,
  };
}

export function mapFeedOverrideRow(row: FeedOverrideRow): UserFeedOverride {
  return {
    siteId: row.site_id,
    muted: fromSqlBool(row.muted),
    updatedAt: row.updated_at,
  };
}

export function mapCustomFeedRow(row: CustomFeedRow): CustomFeed {
  return {
    siteId: row.site_id,
    name: row.name,
    rssUrl: row.rss_url,
    category: row.category,
    muted: fromSqlBool(row.muted),
    createdAt: row.created_at,
  };
}

export function mapWordRuleRow(row: WordRuleRow): InterestKeyword & NgWord {
  return {
    id: row.id,
    word: row.word,
    enabled: fromSqlBool(row.enabled),
    createdAt: row.created_at,
  };
}

export async function queryPackSettings(
  db: SQLiteDatabaseLike
): Promise<UserPackSetting[]> {
  const rows = await db.getAllAsync<PackSettingRow>(
    'SELECT pack_id, enabled, updated_at FROM user_pack_settings ORDER BY pack_id ASC',
    []
  );
  return rows.map(mapPackSettingRow);
}

export async function queryFeedOverrides(
  db: SQLiteDatabaseLike
): Promise<UserFeedOverride[]> {
  const rows = await db.getAllAsync<FeedOverrideRow>(
    'SELECT site_id, muted, updated_at FROM user_feed_overrides ORDER BY site_id ASC',
    []
  );
  return rows.map(mapFeedOverrideRow);
}

export async function queryCustomFeeds(
  db: SQLiteDatabaseLike
): Promise<CustomFeed[]> {
  const rows = await db.getAllAsync<CustomFeedRow>(
    'SELECT site_id, name, rss_url, category, muted, created_at FROM custom_feeds ORDER BY created_at ASC, site_id ASC',
    []
  );
  return rows.map(mapCustomFeedRow);
}

export async function queryWordRules(
  db: SQLiteDatabaseLike,
  table: WordRuleTable
): Promise<Array<InterestKeyword & NgWord>> {
  const rows = await db.getAllAsync<WordRuleRow>(
    `SELECT id, word, enabled, created_at FROM ${table} ORDER BY created_at ASC, id ASC`,
    []
  );
  return rows.map(mapWordRuleRow);
}
