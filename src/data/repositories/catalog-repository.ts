import defaultPacksJson from '../../../assets/catalog/default-packs.json';
import {
  resolveActiveFeeds,
  validateRemoteCatalog,
} from '../../domain/catalog-merge';
import type {
  FeedDefinition,
  PackDefinition,
  RemoteCatalog,
  ResolvedFeed,
} from '../../domain/types';
import type { SQLiteDatabaseLike } from '../database';
import {
  fromSqlBool,
  queryCustomFeeds,
  queryFeedOverrides,
  queryPackSettings,
  toSqlBool,
} from './sql-helpers';

interface CatalogMetadataRow {
  schema_version: number;
  updated_at: string;
  fetched_at: number;
}

interface RemotePackRow {
  pack_id: string;
  name: string;
  description: string;
  default_enabled: number;
  sort_order: number;
}

interface RemoteFeedRow {
  site_id: string;
  pack_id: string;
  name: string;
  rss_url: string;
  category: string;
  deprecated: number;
  sort_order: number;
}

function getBundledDefaultCatalog(): RemoteCatalog {
  const validated = validateRemoteCatalog(defaultPacksJson);
  if (!validated) {
    throw new Error('Bundled default-packs.json failed RemoteCatalog validation');
  }
  return validated;
}

/**
 * Persists and merges the remote feed catalog with local user overrides and custom feeds.
 */
export class CatalogRepository {
  constructor(private readonly db: SQLiteDatabaseLike) {}

  /**
   * Returns the currently persisted remote catalog, seeding from bundled
   * `default-packs.json` on first run if no catalog has been stored yet.
   */
  async getEffectiveCatalog(): Promise<RemoteCatalog> {
    const existing = await this.readStoredCatalog();
    if (existing) {
      return existing;
    }

    const fallback = getBundledDefaultCatalog();
    await this.saveCatalog(fallback);
    return fallback;
  }

  /**
   * Fetches and validates a remote catalog JSON. On network, HTTP, parse, or
   * schema errors, preserves the stored catalog (or seeds bundled defaults on
   * an empty database) and reports `usedFallback: true`.
   */
  async refreshFromRemote(
    url: string,
    fetcher: typeof fetch = fetch
  ): Promise<{ updated: boolean; usedFallback: boolean }> {
    try {
      const response = await fetcher(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw: unknown = await response.json();
      const validated = validateRemoteCatalog(raw);
      if (!validated) {
        throw new Error('Invalid remote catalog schema');
      }

      await this.saveCatalog(validated);
      return { updated: true, usedFallback: false };
    } catch {
      const existing = await this.readStoredCatalog();
      if (!existing) {
        await this.saveCatalog(getBundledDefaultCatalog());
      }
      return { updated: false, usedFallback: true };
    }
  }

  /**
   * Merges the effective remote catalog with user pack toggles, per-site mute
   * overrides, and user-added custom feeds.
   */
  async getResolvedFeeds(): Promise<ResolvedFeed[]> {
    const [catalog, packSettings, feedOverrides, customFeeds] = await Promise.all([
      this.getEffectiveCatalog(),
      queryPackSettings(this.db),
      queryFeedOverrides(this.db),
      queryCustomFeeds(this.db),
    ]);

    return resolveActiveFeeds(catalog, packSettings, feedOverrides, customFeeds);
  }

  private async readStoredCatalog(): Promise<RemoteCatalog | null> {
    const meta = await this.db.getFirstAsync<CatalogMetadataRow>(
      'SELECT schema_version, updated_at, fetched_at FROM catalog_metadata WHERE id = 1',
      []
    );
    if (!meta) {
      return null;
    }

    const packRows = await this.db.getAllAsync<RemotePackRow>(
      'SELECT pack_id, name, description, default_enabled, sort_order FROM remote_packs ORDER BY sort_order ASC, pack_id ASC',
      []
    );
    if (packRows.length === 0) {
      return null;
    }

    const feedRows = await this.db.getAllAsync<RemoteFeedRow>(
      'SELECT site_id, pack_id, name, rss_url, category, deprecated, sort_order FROM remote_feeds ORDER BY sort_order ASC, site_id ASC',
      []
    );

    const feedsByPack = new Map<string, FeedDefinition[]>();
    for (const row of feedRows) {
      const list = feedsByPack.get(row.pack_id) ?? [];
      list.push({
        packId: row.pack_id,
        siteId: row.site_id,
        name: row.name,
        rssUrl: row.rss_url,
        category: row.category,
        deprecated: fromSqlBool(row.deprecated),
      });
      feedsByPack.set(row.pack_id, list);
    }

    const packs: PackDefinition[] = packRows.map((row) => ({
      packId: row.pack_id,
      name: row.name,
      description: row.description,
      defaultEnabled: fromSqlBool(row.default_enabled),
      feeds: feedsByPack.get(row.pack_id) ?? [],
    }));

    return {
      schemaVersion: meta.schema_version,
      updatedAt: meta.updated_at,
      packs,
    };
  }

  private async saveCatalog(catalog: RemoteCatalog): Promise<void> {
    const fetchedAt = Date.now();
    await this.db.withTransactionAsync(async () => {
      // Replace remote catalog rows only; user_pack_settings, user_feed_overrides,
      // and custom_feeds live in independent tables and are preserved.
      await this.db.runAsync('DELETE FROM remote_feeds', []);
      await this.db.runAsync('DELETE FROM remote_packs', []);
      await this.db.runAsync(
        `INSERT INTO catalog_metadata (id, schema_version, updated_at, fetched_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at,
           fetched_at = excluded.fetched_at`,
        [catalog.schemaVersion, catalog.updatedAt, fetchedAt]
      );

      for (let packIndex = 0; packIndex < catalog.packs.length; packIndex++) {
        const pack = catalog.packs[packIndex];
        await this.db.runAsync(
          `INSERT INTO remote_packs (pack_id, name, description, default_enabled, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
          [
            pack.packId,
            pack.name,
            pack.description,
            toSqlBool(pack.defaultEnabled),
            packIndex,
          ]
        );

        for (let feedIndex = 0; feedIndex < pack.feeds.length; feedIndex++) {
          const feed = pack.feeds[feedIndex];
          await this.db.runAsync(
            `INSERT INTO remote_feeds (site_id, pack_id, name, rss_url, category, deprecated, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              feed.siteId,
              pack.packId,
              feed.name,
              feed.rssUrl,
              feed.category,
              toSqlBool(feed.deprecated),
              feedIndex,
            ]
          );
        }
      }
    });
  }
}
