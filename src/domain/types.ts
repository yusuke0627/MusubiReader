/**
 * Pure TypeScript domain types for MusubiReader.
 * Keep free of React Native / Expo native imports for Jest & Web portability.
 */

export interface FeedDefinition {
  readonly packId: string;
  readonly siteId: string;
  readonly name: string;
  readonly rssUrl: string;
  readonly category: string;
  readonly deprecated: boolean;
}

export interface PackDefinition {
  readonly packId: string;
  readonly name: string;
  readonly description: string;
  readonly defaultEnabled: boolean;
  readonly feeds: readonly FeedDefinition[];
}

export interface RemoteCatalog {
  readonly schemaVersion: number;
  readonly updatedAt: string;
  readonly packs: readonly PackDefinition[];
}

export interface UserPackSetting {
  readonly packId: string;
  readonly enabled: boolean;
  readonly updatedAt: number;
}

export interface UserFeedOverride {
  readonly siteId: string;
  readonly muted: boolean;
  readonly updatedAt: number;
}

export interface CustomFeed {
  readonly siteId: string;
  readonly name: string;
  readonly rssUrl: string;
  readonly category: string;
  readonly muted: boolean;
  readonly createdAt: number;
}

export interface ResolvedFeed {
  readonly packId: string;
  readonly siteId: string;
  readonly name: string;
  readonly rssUrl: string;
  readonly category: string;
  readonly enabled: boolean;
  readonly muted: boolean;
  readonly isCustom: boolean;
}

export interface ParsedFeedItem {
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly publishedAt: number;
  readonly categories: readonly string[];
}

export interface Article {
  readonly id: string;
  readonly packId: string;
  readonly siteId: string;
  readonly siteName: string;
  readonly category: string;
  readonly title: string;
  readonly url: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly publishedAt: number;
  readonly fetchedAt: number;
  readonly isSaved: boolean;
  readonly isRead: boolean;
  readonly isPrefetched?: boolean;
}

export interface InterestKeyword {
  readonly id: string;
  readonly word: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface NgWord {
  readonly id: string;
  readonly word: string;
  readonly enabled: boolean;
  readonly createdAt: number;
}

export interface ReadHistoryEntry {
  readonly id?: string;
  readonly articleId: string;
  readonly category: string;
  readonly readAt: number;
}

export interface CacheEntry {
  readonly articleId: string;
  readonly localPath: string;
  readonly sizeBytes: number;
  readonly cachedAt: number;
  readonly lastAccessedAt: number;
}
