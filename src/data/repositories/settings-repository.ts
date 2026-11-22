import type {
  CustomFeed,
  InterestKeyword,
  NgWord,
  UserFeedOverride,
  UserPackSetting,
} from '../../domain/types';
import type { SQLiteDatabaseLike } from '../database';
import {
  mapCustomFeedRow,
  mapFeedOverrideRow,
  mapPackSettingRow,
  queryCustomFeeds,
  queryFeedOverrides,
  queryPackSettings,
  queryWordRules,
  toSqlBool,
  type WordRuleTable,
} from './sql-helpers';

/**
 * Manages user-owned settings and curation rules: interest keywords, NG words,
 * pack toggles, per-site mute overrides, and custom RSS feeds.
 */
export class SettingsRepository {
  constructor(private readonly db: SQLiteDatabaseLike) {}

  // --- interest_keywords ---

  async listInterestKeywords(): Promise<InterestKeyword[]> {
    return queryWordRules(this.db, 'interest_keywords');
  }

  async upsertInterestKeyword(keyword: InterestKeyword): Promise<void> {
    await this.upsertWordRule('interest_keywords', keyword);
  }

  async setInterestKeywordEnabled(id: string, enabled: boolean): Promise<void> {
    await this.setWordRuleEnabled('interest_keywords', id, enabled);
  }

  async deleteInterestKeyword(id: string): Promise<void> {
    await this.deleteWordRule('interest_keywords', id);
  }

  // --- ng_words ---

  async listNgWords(): Promise<NgWord[]> {
    return queryWordRules(this.db, 'ng_words');
  }

  async upsertNgWord(ngWord: NgWord): Promise<void> {
    await this.upsertWordRule('ng_words', ngWord);
  }

  async setNgWordEnabled(id: string, enabled: boolean): Promise<void> {
    await this.setWordRuleEnabled('ng_words', id, enabled);
  }

  async deleteNgWord(id: string): Promise<void> {
    await this.deleteWordRule('ng_words', id);
  }

  // --- user_pack_settings ---

  async listPackSettings(): Promise<UserPackSetting[]> {
    return queryPackSettings(this.db);
  }

  async getPackSetting(packId: string): Promise<UserPackSetting | null> {
    const row = await this.db.getFirstAsync<{
      pack_id: string;
      enabled: number;
      updated_at: number;
    }>(
      'SELECT pack_id, enabled, updated_at FROM user_pack_settings WHERE pack_id = ?',
      [packId]
    );
    return row ? mapPackSettingRow(row) : null;
  }

  async upsertPackSetting(setting: UserPackSetting): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO user_pack_settings (pack_id, enabled, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(pack_id) DO UPDATE SET
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [setting.packId, toSqlBool(setting.enabled), setting.updatedAt]
    );
  }

  async deletePackSetting(packId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM user_pack_settings WHERE pack_id = ?', [
      packId,
    ]);
  }

  // --- user_feed_overrides ---

  async listFeedOverrides(): Promise<UserFeedOverride[]> {
    return queryFeedOverrides(this.db);
  }

  async getFeedOverride(siteId: string): Promise<UserFeedOverride | null> {
    const row = await this.db.getFirstAsync<{
      site_id: string;
      muted: number;
      updated_at: number;
    }>(
      'SELECT site_id, muted, updated_at FROM user_feed_overrides WHERE site_id = ?',
      [siteId]
    );
    return row ? mapFeedOverrideRow(row) : null;
  }

  async upsertFeedOverride(override: UserFeedOverride): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO user_feed_overrides (site_id, muted, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET
         muted = excluded.muted,
         updated_at = excluded.updated_at`,
      [override.siteId, toSqlBool(override.muted), override.updatedAt]
    );
  }

  async deleteFeedOverride(siteId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM user_feed_overrides WHERE site_id = ?', [
      siteId,
    ]);
  }

  // --- custom_feeds ---

  async listCustomFeeds(): Promise<CustomFeed[]> {
    return queryCustomFeeds(this.db);
  }

  async getCustomFeed(siteId: string): Promise<CustomFeed | null> {
    const row = await this.db.getFirstAsync<{
      site_id: string;
      name: string;
      rss_url: string;
      category: string;
      muted: number;
      created_at: number;
    }>(
      'SELECT site_id, name, rss_url, category, muted, created_at FROM custom_feeds WHERE site_id = ?',
      [siteId]
    );
    return row ? mapCustomFeedRow(row) : null;
  }

  async upsertCustomFeed(feed: CustomFeed): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO custom_feeds (site_id, name, rss_url, category, muted, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET
         name = excluded.name,
         rss_url = excluded.rss_url,
         category = excluded.category,
         muted = excluded.muted`,
      [
        feed.siteId,
        feed.name,
        feed.rssUrl,
        feed.category,
        toSqlBool(feed.muted),
        feed.createdAt,
      ]
    );
  }

  async setCustomFeedMuted(siteId: string, muted: boolean): Promise<void> {
    await this.db.runAsync(
      'UPDATE custom_feeds SET muted = ? WHERE site_id = ?',
      [toSqlBool(muted), siteId]
    );
  }

  async deleteCustomFeed(siteId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM custom_feeds WHERE site_id = ?', [
      siteId,
    ]);
  }

  // --- shared helpers ---

  private async upsertWordRule(
    table: WordRuleTable,
    rule: InterestKeyword | NgWord
  ): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO ${table} (id, word, enabled, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         word = excluded.word,
         enabled = excluded.enabled`,
      [rule.id, rule.word, toSqlBool(rule.enabled), rule.createdAt]
    );
  }

  private async setWordRuleEnabled(
    table: WordRuleTable,
    id: string,
    enabled: boolean
  ): Promise<void> {
    await this.db.runAsync(`UPDATE ${table} SET enabled = ? WHERE id = ?`, [
      toSqlBool(enabled),
      id,
    ]);
  }

  private async deleteWordRule(table: WordRuleTable, id: string): Promise<void> {
    await this.db.runAsync(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
}
