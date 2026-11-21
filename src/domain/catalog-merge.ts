import type {
  CustomFeed,
  FeedDefinition,
  PackDefinition,
  RemoteCatalog,
  ResolvedFeed,
  UserFeedOverride,
  UserPackSetting,
} from './types';

export const MY_RSS_PACK_ID = 'my-rss';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isValidHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidFeedDefinition(value: unknown): value is FeedDefinition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.packId) &&
    isNonEmptyString(value.siteId) &&
    isNonEmptyString(value.name) &&
    isValidHttpUrl(value.rssUrl) &&
    typeof value.category === 'string' &&
    typeof value.deprecated === 'boolean'
  );
}

function isValidPackDefinition(value: unknown): value is PackDefinition {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isNonEmptyString(value.packId) &&
    isNonEmptyString(value.name) &&
    typeof value.description === 'string' &&
    typeof value.defaultEnabled === 'boolean' &&
    Array.isArray(value.feeds) &&
    value.feeds.every(isValidFeedDefinition)
  );
}

/**
 * Validates an untrusted JSON payload against the RemoteCatalog schema.
 * Returns null if any required field or nested pack/feed entry is malformed.
 */
export function validateRemoteCatalog(raw: unknown): RemoteCatalog | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.schemaVersion !== 'number' ||
    !Number.isInteger(raw.schemaVersion) ||
    raw.schemaVersion < 1
  ) {
    return null;
  }
  if (!isNonEmptyString(raw.updatedAt)) {
    return null;
  }
  if (!Array.isArray(raw.packs) || !raw.packs.every(isValidPackDefinition)) {
    return null;
  }
  return raw as unknown as RemoteCatalog;
}

function indexLatestByKey<T extends { readonly updatedAt: number }>(
  items: readonly T[],
  getKey: (item: T) => string
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = getKey(item);
    const existing = map.get(key);
    // Keep the newest record by updatedAt (tie-break in favor of later entries).
    if (!existing || item.updatedAt >= existing.updatedAt) {
      map.set(key, item);
    }
  }
  return map;
}

/**
 * Non-destructively merges a remote catalog with local user pack settings,
 * per-site mute overrides, and user-added custom feeds under the "my-rss" pack.
 * Deprecated remote feeds are omitted while user overrides and custom feeds are preserved.
 */
export function resolveActiveFeeds(
  catalog: RemoteCatalog,
  packSettings: UserPackSetting[],
  feedOverrides: UserFeedOverride[],
  customFeeds: CustomFeed[]
): ResolvedFeed[] {
  const packSettingMap = indexLatestByKey(packSettings, (s) => s.packId);
  const feedOverrideMap = indexLatestByKey(feedOverrides, (o) => o.siteId);

  const resolved: ResolvedFeed[] = [];

  for (const pack of catalog.packs) {
    const packSetting = packSettingMap.get(pack.packId);
    const packEnabled = packSetting ? packSetting.enabled : pack.defaultEnabled;

    for (const feed of pack.feeds) {
      if (feed.deprecated) {
        continue;
      }

      const override = feedOverrideMap.get(feed.siteId);
      resolved.push({
        packId: pack.packId,
        siteId: feed.siteId,
        name: feed.name,
        rssUrl: feed.rssUrl,
        category: feed.category,
        enabled: packEnabled,
        muted: override ? override.muted : false,
        isCustom: false,
      });
    }
  }

  const myRssSetting = packSettingMap.get(MY_RSS_PACK_ID);
  const myRssEnabled = myRssSetting ? myRssSetting.enabled : true;

  for (const custom of customFeeds) {
    resolved.push({
      packId: MY_RSS_PACK_ID,
      siteId: custom.siteId,
      name: custom.name,
      rssUrl: custom.rssUrl,
      category: custom.category,
      enabled: myRssEnabled,
      muted: custom.muted,
      isCustom: true,
    });
  }

  return resolved;
}
