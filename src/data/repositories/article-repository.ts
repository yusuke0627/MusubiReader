import {
  curatePickupArticles,
  isArticleBlocked,
} from '../../domain/curation';
import type { planPurge } from '../../domain/purge-policy';
import type {
  Article,
  CacheEntry,
  NgWord,
  ReadHistoryEntry,
} from '../../domain/types';
import type { SQLiteDatabaseLike } from '../database';
import {
  buildInPlaceholders,
  chunkItems,
  fromSqlBool,
  queryCustomFeeds,
  queryFeedOverrides,
  queryWordRules,
  toSqlBool,
} from './sql-helpers';

export type PurgePlan = ReturnType<typeof planPurge>;

interface ArticleRow {
  id: string;
  pack_id: string;
  site_id: string;
  site_name: string;
  category: string;
  title: string;
  url: string;
  summary: string;
  tags_json: string;
  published_at: number;
  fetched_at: number;
  is_saved: number;
  is_read: number;
  is_prefetched: number;
}

interface ReadHistoryRow {
  id: string;
  article_id: string;
  category: string;
  read_at: number;
}

interface CacheEntryRow {
  article_id: string;
  local_path: string;
  size_bytes: number;
  cached_at: number;
  last_accessed_at: number;
}

const ARTICLE_SELECT_COLUMNS = `
  id, pack_id, site_id, site_name, category, title, url, summary,
  tags_json, published_at, fetched_at, is_saved, is_read, is_prefetched
`;

let readHistorySeq = 0;

function parseTagsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function mapArticleRow(row: ArticleRow): Article {
  return {
    id: row.id,
    packId: row.pack_id,
    siteId: row.site_id,
    siteName: row.site_name,
    category: row.category,
    title: row.title,
    url: row.url,
    summary: row.summary,
    tags: parseTagsJson(row.tags_json),
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    isSaved: fromSqlBool(row.is_saved),
    isRead: fromSqlBool(row.is_read),
    isPrefetched: fromSqlBool(row.is_prefetched),
  };
}

/**
 * Persists fetched articles, curates Pickup/blocked views, tracks read history,
 * and executes cache/metadata purge plans while protecting saved articles.
 */
export class ArticleRepository {
  constructor(private readonly db: SQLiteDatabaseLike) {}

  async upsertArticles(items: readonly Article[]): Promise<void> {
    if (items.length === 0) {
      return;
    }

    await this.db.withTransactionAsync(async () => {
      for (const item of items) {
        await this.db.runAsync(
          `INSERT INTO articles (
             id, pack_id, site_id, site_name, category, title, url, summary,
             tags_json, published_at, fetched_at, is_saved, is_read, is_prefetched
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pack_id = excluded.pack_id,
             site_id = excluded.site_id,
             site_name = excluded.site_name,
             category = excluded.category,
             title = excluded.title,
             url = excluded.url,
             summary = excluded.summary,
             tags_json = excluded.tags_json,
             published_at = excluded.published_at,
             fetched_at = excluded.fetched_at,
             is_saved = MAX(articles.is_saved, excluded.is_saved),
             is_read = MAX(articles.is_read, excluded.is_read),
             is_prefetched = MAX(articles.is_prefetched, excluded.is_prefetched)`,
          [
            item.id,
            item.packId,
            item.siteId,
            item.siteName,
            item.category,
            item.title,
            item.url,
            item.summary,
            JSON.stringify(item.tags),
            item.publishedAt,
            item.fetchedAt,
            toSqlBool(item.isSaved),
            toSqlBool(item.isRead),
            toSqlBool(item.isPrefetched ?? false),
          ]
        );
      }
    });
  }

  async listByPackAndCategory(
    packId: string,
    category?: string
  ): Promise<Article[]> {
    const sql =
      category !== undefined
        ? `SELECT ${ARTICLE_SELECT_COLUMNS} FROM articles
           WHERE pack_id = ? AND category = ?
           ORDER BY published_at DESC, fetched_at DESC, id ASC`
        : `SELECT ${ARTICLE_SELECT_COLUMNS} FROM articles
           WHERE pack_id = ?
           ORDER BY published_at DESC, fetched_at DESC, id ASC`;

    const params = category !== undefined ? [packId, category] : [packId];
    const [rows, blocking] = await Promise.all([
      this.db.getAllAsync<ArticleRow>(sql, params),
      this.loadBlockingContext(),
    ]);

    return rows
      .map(mapArticleRow)
      .filter(
        (article) =>
          !isArticleBlocked(article, blocking.ngWords, blocking.mutedSiteIds)
      );
  }

  async listPickup(): Promise<
    Array<{ article: Article; matchedKeywords: string[] }>
  > {
    const [articles, keywords, blocking] = await Promise.all([
      this.listAllArticles(),
      queryWordRules(this.db, 'interest_keywords'),
      this.loadBlockingContext(),
    ]);

    return curatePickupArticles(
      articles,
      keywords,
      blocking.ngWords,
      blocking.mutedSiteIds
    );
  }

  async listSaved(): Promise<Article[]> {
    const rows = await this.db.getAllAsync<ArticleRow>(
      `SELECT ${ARTICLE_SELECT_COLUMNS} FROM articles
       WHERE is_saved = 1
       ORDER BY published_at DESC, fetched_at DESC, id ASC`,
      []
    );
    return rows.map(mapArticleRow);
  }

  async listAllArticles(): Promise<Article[]> {
    const rows = await this.db.getAllAsync<ArticleRow>(
      `SELECT ${ARTICLE_SELECT_COLUMNS} FROM articles
       ORDER BY published_at DESC, fetched_at DESC, id ASC`,
      []
    );
    return rows.map(mapArticleRow);
  }

  async toggleSaved(articleId: string): Promise<boolean> {
    let nextSaved = false;
    await this.db.withTransactionAsync(async () => {
      const existing = await this.db.getFirstAsync<{ is_saved: number }>(
        'SELECT is_saved FROM articles WHERE id = ?',
        [articleId]
      );
      if (!existing) {
        throw new Error(`Article not found: ${articleId}`);
      }
      nextSaved = !fromSqlBool(existing.is_saved);
      await this.db.runAsync('UPDATE articles SET is_saved = ? WHERE id = ?', [
        toSqlBool(nextSaved),
        articleId,
      ]);
    });
    return nextSaved;
  }

  async recordRead(
    articleId: string,
    category: string,
    nowMs: number
  ): Promise<void> {
    const historyId = `${nowMs}-${++readHistorySeq}-${articleId}`;
    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync('UPDATE articles SET is_read = 1 WHERE id = ?', [
        articleId,
      ]);
      await this.db.runAsync(
        'INSERT INTO read_history (id, article_id, category, read_at) VALUES (?, ?, ?, ?)',
        [historyId, articleId, category, nowMs]
      );
    });
  }

  async listReadHistory(sinceMs?: number): Promise<ReadHistoryEntry[]> {
    const rows =
      sinceMs !== undefined
        ? await this.db.getAllAsync<ReadHistoryRow>(
            'SELECT id, article_id, category, read_at FROM read_history WHERE read_at >= ? ORDER BY read_at DESC',
            [sinceMs]
          )
        : await this.db.getAllAsync<ReadHistoryRow>(
            'SELECT id, article_id, category, read_at FROM read_history ORDER BY read_at DESC',
            []
          );

    return rows.map((row) => ({
      id: row.id,
      articleId: row.article_id,
      category: row.category,
      readAt: row.read_at,
    }));
  }

  async upsertCacheEntry(entry: CacheEntry): Promise<void> {
    await this.db.withTransactionAsync(async () => {
      await this.db.runAsync(
        `INSERT INTO prefetch_cache (article_id, local_path, size_bytes, cached_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(article_id) DO UPDATE SET
           local_path = excluded.local_path,
           size_bytes = excluded.size_bytes,
           cached_at = excluded.cached_at,
           last_accessed_at = excluded.last_accessed_at`,
        [
          entry.articleId,
          entry.localPath,
          entry.sizeBytes,
          entry.cachedAt,
          entry.lastAccessedAt,
        ]
      );
      await this.db.runAsync(
        'UPDATE articles SET is_prefetched = 1 WHERE id = ?',
        [entry.articleId]
      );
    });
  }

  async listCacheEntries(): Promise<CacheEntry[]> {
    const rows = await this.db.getAllAsync<CacheEntryRow>(
      'SELECT article_id, local_path, size_bytes, cached_at, last_accessed_at FROM prefetch_cache ORDER BY last_accessed_at ASC',
      []
    );
    return rows.map((row) => ({
      articleId: row.article_id,
      localPath: row.local_path,
      sizeBytes: row.size_bytes,
      cachedAt: row.cached_at,
      lastAccessedAt: row.last_accessed_at,
    }));
  }

  async applyPurgePlan(plan: PurgePlan): Promise<void> {
    if (
      plan.deleteCacheArticleIds.length === 0 &&
      plan.deleteMetadataArticleIds.length === 0
    ) {
      return;
    }

    await this.db.withTransactionAsync(async () => {
      for (const batch of chunkItems(plan.deleteCacheArticleIds)) {
        const placeholders = buildInPlaceholders(batch.length);
        await this.db.runAsync(
          `DELETE FROM prefetch_cache WHERE article_id IN (${placeholders})`,
          batch
        );
        await this.db.runAsync(
          `UPDATE articles SET is_prefetched = 0 WHERE id IN (${placeholders})`,
          batch
        );
      }

      for (const batch of chunkItems(plan.deleteMetadataArticleIds)) {
        const placeholders = buildInPlaceholders(batch.length);
        // Defense-in-depth: never purge metadata for saved articles even if a plan is stale.
        await this.db.runAsync(
          `DELETE FROM articles WHERE id IN (${placeholders}) AND is_saved = 0`,
          batch
        );
        await this.db.runAsync(
          `DELETE FROM prefetch_cache
           WHERE article_id IN (${placeholders})
             AND article_id NOT IN (SELECT id FROM articles WHERE is_saved = 1)`,
          batch
        );
      }
    });
  }

  private async loadBlockingContext(): Promise<{
    ngWords: NgWord[];
    mutedSiteIds: Set<string>;
  }> {
    const [ngWords, overrides, customFeeds] = await Promise.all([
      queryWordRules(this.db, 'ng_words'),
      queryFeedOverrides(this.db),
      queryCustomFeeds(this.db),
    ]);

    const mutedSiteIds = new Set<string>();
    for (const override of overrides) {
      if (override.muted) {
        mutedSiteIds.add(override.siteId);
      }
    }
    for (const custom of customFeeds) {
      if (custom.muted) {
        mutedSiteIds.add(custom.siteId);
      }
    }

    return { ngWords, mutedSiteIds };
  }
}
