# MusubiReader v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build MusubiReader v1 for iPhone 16 dogfooding and App Store release — an Expo (React Native + TypeScript) RSS & 5ch/2ch matome reader with zero-config initial matome packs, pack-separated home browsing, cross-pack keyword curation with local notifications, Wi-Fi priority prefetch with automatic purging, and a thin Swift `WKWebView` + `WKContentRuleList` ad-blocking module.

**Architecture:** On-device-first serverless architecture (`expo-sqlite` + `expo-file-system` + `expo-background-task`) with two externally hosted static JSON files (preset packs catalog and `WKContentRuleList` ad-block rules) backed by bundled fallbacks. Pure TypeScript domain modules (`src/domain/*`) isolate RSS parsing, curation, catalog merging, and purge policies for full unit testability and future Web reuse, while a thin Expo Swift module (`modules/musubi-webview`) provides native Apple `WKContentRuleList` ad-blocking.

**Tech Stack:** Expo (CNG / Development Build), React Native, TypeScript, Expo Router, `expo-sqlite`, `expo-file-system`, `expo-network`, `expo-background-task`, `expo-notifications`, `fast-xml-parser`, `iconv-lite`, Jest (`jest-expo`), Swift (`WKWebView`, `WKContentRuleListStore`), EAS Update.

**Spec:** `docs/superpowers/specs/2026-11-21-musubireader-design.md`

## Global Constraints

- Platform target: iOS (iPhone 16 dogfooding first, App Store release next); Expo Development Build (not Expo Go).
- Architecture: On-device only (no backend crawl server, no user login/cloud sync); external hosting limited to static JSON (preset packs & ad-block rules) with bundled fallbacks.
- Ad blocking: Must use Apple official `WKContentRuleList` via `WKWebView` (no fragile JS-only ad removal, no destructive HTML rewriting that breaks matome styling).
- Navigation & UX: 3-tab structure (`ホーム` / `ピックアップ` / `ソース・設定`); zero-config instant matome browsing on first launch; no mysterious icon clutter.
- Home vs Pickup separation: Home switches by Pack (`5chまとめ` / `Tech` / `マイRSS`); Pickup aggregates keyword matches across all enabled packs and custom RSS, with a segment toggle for `保存済み`.
- Prefetch & Purge defaults: Wi-Fi-only priority prefetch for top 2–3 most-read categories (last 14 days) and keyword-matched articles; online speed + simple offline fallback (HTML + primary images, no local HTTP proxy); unread cache purged after 72 hours (3 days), unread metadata after 14 days, 200 MB LRU cap; saved articles exempt from auto-purge with separate 50 MB cache cap.
- Curation scope (v1): Registered interest keywords matched against RSS/Atom metadata (title, summary, category tags) sorted by freshness; NG words and muted sites always exclude matches.
- Git workflow (user rule): Issue-driven development, Japanese for conversation/issues/PRs, English for commit messages, minimal diffs with tests, PR closes issue via `closes #<id>`.

## Review Focus

1. **Legacy Japanese encodings & malformed RSS 1.0/2.0/Atom feeds** (Shift_JIS/EUC-JP/unescaped `&`/missing CDATA): parser must decode without mojibake and isolate single-feed failures so one broken matome site never aborts sync. (Pinned in Task 2 & Task 7)
2. **Non-destructive catalog updates**: updating remote preset JSON (`rssUrl` change, new site, `deprecated: true`) must never wipe user pack toggles, site mutes, or custom RSS feeds. (Pinned in Task 4 & Task 6)
3. **Japanese/case/full-width keyword normalization & NG/mute precedence**: `Tech`, `tech`, `Ｔｅｃｈ` must match equivalently via NFKC + lowercase, and NG words or muted sites must always override an interest keyword match for both Pickup and notifications. (Pinned in Task 3)
4. **Saved-article protection under purge & LRU cap pressure**: 72-hour cache purge, 14-day metadata purge, and 200 MB LRU eviction must never delete saved articles' metadata and must enforce the separate 50 MB saved-cache budget independently. (Pinned in Task 5 & Task 6)
5. **Offline / corrupt remote static JSON fallback**: network failure or invalid remote JSON for preset packs or ad-block rules must fall back cleanly to bundled defaults so first launch works immediately without crashing. (Pinned in Task 6 & Task 8)

---

## File Structure

- `assets/catalog/default-packs.json` — Bundled fallback preset packs (`matome-5ch`, `tech-jp`) with immutable `packId`/`siteId` and schema version.
- `assets/adblock/default-rules.json` — Bundled fallback `WKContentRuleList` JSON rules for common matome ad networks.
- `src/domain/types.ts` — Shared immutable domain types (`RemoteCatalog`, `PackDefinition`, `FeedDefinition`, `UserPackSetting`, `UserFeedOverride`, `CustomFeed`, `ResolvedFeed`, `Article`, `InterestKeyword`, `NgWord`, `CacheEntry`).
- `src/domain/rss-parser.ts` — Pure TS parser for RSS 1.0 (RDF), RSS 2.0, and Atom with encoding detection (`UTF-8`, `Shift_JIS`, `EUC-JP`).
- `src/domain/curation.ts` — Pure TS NFKC+lowercase keyword matching, NG/mute filtering, and freshness-sorted Pickup curation.
- `src/domain/catalog-merge.ts` — Pure TS non-destructive merge between remote catalog and local user overrides/custom feeds.
- `src/domain/purge-policy.ts` — Pure TS top-category calculator (14-day window, top 2–3), priority prefetch selector, and 72h/14d/200MB LRU + 50MB saved-budget purge planner.
- `src/data/database.ts` — `expo-sqlite` schema creation and versioned migrations.
- `src/data/repositories/catalog-repository.ts` — Remote static JSON fetch with fallback, catalog persistence, and resolved feed queries.
- `src/data/repositories/article-repository.ts` — Article upsert, pack/category queries, Pickup & Saved queries, read-history logging, and purge execution.
- `src/data/repositories/settings-repository.ts` — Interest keywords, NG words, pack toggles, site mutes, and custom RSS CRUD.
- `src/services/sync-service.ts` — Concurrency-limited RSS sync, new keyword-hit detection, and local notification dispatch (`expo-notifications`).
- `src/services/prefetch-service.ts` — Wi-Fi check (`expo-network`), HTML + primary image download to `expo-file-system`, and purge execution.
- `src/services/background-tasks.ts` — `expo-background-task` registration for background feed refresh and Wi-Fi prefetch/purge.
- `modules/musubi-webview/` — Expo Modules API Swift native module wrapping `WKWebView` + `WKContentRuleListStore` + cached HTML offline fallback.
- `app/_layout.tsx` & `app/(tabs)/_layout.tsx` — App bootstrap and 3-tab navigation (`ホーム`, `ピックアップ`, `ソース・設定`).
- `app/(tabs)/index.tsx` — Home screen (pack switcher, category tabs, article list, long-press/swipe for save & mute).
- `app/(tabs)/pickup.tsx` — Pickup screen (`キーワード一致` / `保存済み` segment toggle, keyword chips & add modal).
- `app/(tabs)/sources.tsx` — Sources & Settings screen (pack ON/OFF, custom RSS URL add, NG word/mute management, prefetch & cache controls).
- `app/article/[id].tsx` — Article reader screen (`MusubiWebView`, save toggle, share, offline indicator).

---

### Task 1: Project Scaffolding, Test Harness & Bundled Static Fallbacks

**Files:**
- Create: `package.json`, `app.json`, `tsconfig.json`, `jest.config.js`
- Create: `assets/catalog/default-packs.json`
- Create: `assets/adblock/default-rules.json`
- Test: `src/__tests__/bundled-assets.test.ts`

**Interfaces:**
- Produces:
  - Expo TypeScript project configured with Expo Router, Jest (`npm test`), and EAS Update fields in `app.json`.
  - Valid JSON schema in `assets/catalog/default-packs.json` (`schemaVersion: 1`, `packs: [...]` including `packId: "matome-5ch"` enabled by default and `packId: "tech-jp"`).
  - Valid `WKContentRuleList` JSON array in `assets/adblock/default-rules.json`.

- [ ] **Step 1: Initialize Expo TypeScript project with Expo Router and dependencies**

Run: `npx create-expo-app@latest . --template tabs --yes` (or initialize cleanly preserving `docs/`) and install:
`npx expo install expo-sqlite expo-file-system expo-network expo-background-task expo-notifications`
`npm install fast-xml-parser iconv-lite`
`npm install -D jest jest-expo @types/jest ts-jest`

- [ ] **Step 2: Write the failing asset validation test in `src/__tests__/bundled-assets.test.ts`**

```ts
import defaultPacks from '../../assets/catalog/default-packs.json';
import defaultRules from '../../assets/adblock/default-rules.json';

test('bundled catalog has schemaVersion 1, matome-5ch pack, and unique siteIds', () => {
  expect(defaultPacks.schemaVersion).toBe(1);
  const matome = defaultPacks.packs.find((p: any) => p.packId === 'matome-5ch');
  expect(matome).toBeDefined();
  expect(matome.defaultEnabled).toBe(true);
  expect(matome.feeds.length).toBeGreaterThanOrEqual(5);
  const ids = defaultPacks.packs.flatMap((p: any) => p.feeds.map((f: any) => f.siteId));
  expect(new Set(ids).size).toBe(ids.length);
});

test('bundled adblock rules conform to WKContentRuleList trigger/action shape', () => {
  expect(Array.isArray(defaultRules)).toBe(true);
  expect(defaultRules.length).toBeGreaterThanOrEqual(5);
  for (const rule of defaultRules) {
    expect(typeof rule.trigger?.['url-filter']).toBe('string');
    expect(typeof rule.action?.type).toBe('string');
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/__tests__/bundled-assets.test.ts`
Expected: FAIL with missing module errors for `default-packs.json` and `default-rules.json`.

- [ ] **Step 4: Create `assets/catalog/default-packs.json` and `assets/adblock/default-rules.json`**

Include safe, App Store-compliant initial `matome-5ch` feeds (e.g., IT/gadget, news, lifestyle categories with `packId`, `siteId`, `name`, `rssUrl`, `category`, `deprecated: false`) plus `tech-jp` pack (`defaultEnabled: false`) and common Japanese ad-network `WKContentRuleList` block/css-display-none rules.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/__tests__/bundled-assets.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold expo app, jest harness, and bundled fallback assets"
```

---

### Task 2: Domain Types & Resilient RSS/Atom Parser

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/rss-parser.ts`
- Test: `src/domain/__tests__/rss-parser.test.ts`

**Interfaces:**
- Produces:
  - `src/domain/types.ts`: `RemoteCatalog`, `PackDefinition`, `FeedDefinition`, `UserPackSetting`, `UserFeedOverride`, `CustomFeed`, `ResolvedFeed`, `ParsedFeedItem`, `Article`, `InterestKeyword`, `NgWord`, `ReadHistoryEntry`, `CacheEntry`.
  - `parseFeedBytes(bytes: Uint8Array, contentType?: string): ParsedFeedItem[]` in `src/domain/rss-parser.ts`.

- [ ] **Step 1: Write the failing tests in `src/domain/__tests__/rss-parser.test.ts`**

```ts
import iconv from 'iconv-lite';
import { parseFeedBytes } from '../rss-parser';

test('parses RSS 2.0 items with title, url, summary, publishedAt, and categories', () => { /* asserts exact fields */ });
test('parses RSS 1.0 (RDF) matome feeds with dc:date and content:encoded', () => { /* asserts exact fields */ });
test('parses Atom feeds with entry link href and updated timestamp', () => { /* asserts exact fields */ });
test('decodes Shift_JIS encoded Japanese RSS without mojibake', () => {
  const sjis = iconv.encode('<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><item><title>テスト記事</title><link>https://example.com/1</link></item></channel></rss>', 'shift_jis');
  const items = parseFeedBytes(new Uint8Array(sjis), 'application/xml; charset=Shift_JIS');
  expect(items[0].title).toBe('テスト記事');
});
test('handles unescaped ampersands and returns empty array on unrecoverable XML without throwing', () => {
  const broken = new TextEncoder().encode('<not-xml<<<');
  expect(parseFeedBytes(broken)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/__tests__/rss-parser.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/domain/types.ts` and `parseFeedBytes(bytes: Uint8Array, contentType?: string): ParsedFeedItem[]` in `src/domain/rss-parser.ts`**

Detect charset from `contentType` header or XML `encoding="..."` declaration (`Shift_JIS`/`EUC-JP`/`UTF-8`), decode via `iconv-lite`, sanitize bare `&`, parse with `fast-xml-parser`, normalize RSS 1.0 (`rdf:RDF`), RSS 2.0 (`rss.channel.item`), and Atom (`feed.entry`), and return `[]` on unrecoverable input.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/__tests__/rss-parser.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/types.ts src/domain/rss-parser.ts src/domain/__tests__/rss-parser.test.ts
git commit -m "feat: add domain types and resilient Japanese RSS/Atom parser"
```

---

### Task 3: Keyword Curation & NG/Mute Filter Engine

**Files:**
- Create: `src/domain/curation.ts`
- Test: `src/domain/__tests__/curation.test.ts`

**Interfaces:**
- Consumes: `Article`, `InterestKeyword`, `NgWord` from `src/domain/types.ts`.
- Produces:
  - `normalizeText(input: string): string`
  - `matchInterestKeywords(article: Pick<Article, 'title' | 'summary' | 'tags'>, keywords: InterestKeyword[]): string[]`
  - `isArticleBlocked(article: Pick<Article, 'siteId' | 'title' | 'summary' | 'tags'>, ngWords: NgWord[], mutedSiteIds: ReadonlySet<string>): boolean`
  - `curatePickupArticles(articles: Article[], keywords: InterestKeyword[], ngWords: NgWord[], mutedSiteIds: ReadonlySet<string>): Array<{ article: Article; matchedKeywords: string[] }>`

- [ ] **Step 1: Write the failing tests in `src/domain/__tests__/curation.test.ts`**

```ts
import { curatePickupArticles, isArticleBlocked, matchInterestKeywords, normalizeText } from '../curation';

test('normalizeText applies NFKC and lowercases full-width and ASCII text', () => {
  expect(normalizeText('Ｔｅｃｈ News　AI')).toBe('tech news ai');
});

test('matchInterestKeywords matches across title, summary, and tags case-insensitively', () => {
  const hits = matchInterestKeywords(
    { title: '新型iPhoneレビュー', summary: 'Ｔｅｃｈ業界で話題', tags: ['ガジェット'] },
    [{ id: '1', word: 'tech', enabled: true, createdAt: 0 }]
  );
  expect(hits).toEqual(['tech']);
});

test('NG word and muted site always override interest keyword matches in curatePickupArticles', () => {
  // 1) article matching both "tech" and NG word "炎上" -> excluded
  // 2) article from muted site matching "tech" -> excluded
  // 3) two valid matches -> sorted newest publishedAt first
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/__tests__/curation.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/domain/curation.ts`**

Apply `.normalize('NFKC').toLowerCase().trim()` consistently; ignore disabled keywords; evaluate `isArticleBlocked` before returning Pickup results; sort descending by `publishedAt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/__tests__/curation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/curation.ts src/domain/__tests__/curation.test.ts
git commit -m "feat: add NFKC keyword curation and NG/mute filter engine"
```

---

### Task 4: Non-Destructive Catalog Merge Logic

**Files:**
- Create: `src/domain/catalog-merge.ts`
- Test: `src/domain/__tests__/catalog-merge.test.ts`

**Interfaces:**
- Consumes: `RemoteCatalog`, `UserPackSetting`, `UserFeedOverride`, `CustomFeed`, `ResolvedFeed` from `src/domain/types.ts`.
- Produces:
  - `resolveActiveFeeds(catalog: RemoteCatalog, packSettings: UserPackSetting[], feedOverrides: UserFeedOverride[], customFeeds: CustomFeed[]): ResolvedFeed[]`
  - `validateRemoteCatalog(raw: unknown): RemoteCatalog | null`

- [ ] **Step 1: Write the failing tests in `src/domain/__tests__/catalog-merge.test.ts`**

```ts
import { resolveActiveFeeds, validateRemoteCatalog } from '../catalog-merge';

test('updates rssUrl from remote catalog while preserving user mute and pack toggle', () => {
  // remote updates site-1 rssUrl; user muted site-1 and disabled pack-2; custom feed exists
  // asserts: site-1 stays muted with new rssUrl, pack-2 stays disabled, custom feed remains in "my-rss" pack
});

test('excludes deprecated remote feeds without touching custom feeds', () => { /* asserts deprecated: true is omitted */ });
test('validateRemoteCatalog returns null on malformed JSON payload', () => {
  expect(validateRemoteCatalog({ broken: true })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/__tests__/catalog-merge.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/domain/catalog-merge.ts`**

Join remote feeds by immutable `packId`/`siteId` against `UserPackSetting` and `UserFeedOverride`, filter out `deprecated: true`, and append `CustomFeed` entries under `packId: "my-rss"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/__tests__/catalog-merge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/catalog-merge.ts src/domain/__tests__/catalog-merge.test.ts
git commit -m "feat: add non-destructive remote catalog merge and validation"
```

---

### Task 5: Priority Prefetch Selector & Auto-Purge Policy

**Files:**
- Create: `src/domain/purge-policy.ts`
- Test: `src/domain/__tests__/purge-policy.test.ts`

**Interfaces:**
- Consumes: `Article`, `ReadHistoryEntry`, `CacheEntry` from `src/domain/types.ts`.
- Produces:
  - Constants: `UNREAD_CACHE_TTL_MS = 72 * 60 * 60 * 1000`, `UNREAD_METADATA_TTL_MS = 14 * 24 * 60 * 60 * 1000`, `UNREAD_CACHE_MAX_BYTES = 200 * 1024 * 1024`, `SAVED_CACHE_MAX_BYTES = 50 * 1024 * 1024`, `TOP_CATEGORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000`, `TOP_CATEGORY_LIMIT = 3`.
  - `getTopReadCategories(history: ReadHistoryEntry[], nowMs: number, limit?: number): string[]`
  - `selectPrefetchCandidates(articles: Article[], topCategories: ReadonlySet<string>, matchedArticleIds: ReadonlySet<string>, cachedIds: ReadonlySet<string>, maxBatch?: number): Article[]`
  - `planPurge(articles: Article[], cacheEntries: CacheEntry[], nowMs: number): { deleteCacheArticleIds: string[]; deleteMetadataArticleIds: string[] }`

- [ ] **Step 1: Write the failing tests in `src/domain/__tests__/purge-policy.test.ts`**

```ts
import { getTopReadCategories, planPurge, selectPrefetchCandidates, UNREAD_CACHE_MAX_BYTES, SAVED_CACHE_MAX_BYTES } from '../purge-policy';

test('getTopReadCategories ranks categories within last 14 days and returns top 3', () => { /* asserts order and ignores >14d entries */ });
test('selectPrefetchCandidates prioritizes keyword-matched articles then top-category unread articles', () => { /* asserts priority order and skips already-cached */ });
test('planPurge deletes unread cache >72h and unread metadata >14d while NEVER deleting saved article metadata', () => { /* asserts saved metadata preserved */ });
test('planPurge enforces 200MB unread LRU cap and separate 50MB saved cache cap independently', () => { /* asserts oldest unread evicted without touching saved under 50MB, and oldest saved cache evicted only when saved >50MB */ });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/domain/__tests__/purge-policy.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/domain/purge-policy.ts`**

Implement deterministic pure functions using `nowMs` injection so all TTL and LRU boundaries are unit-tested without real clocks.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/domain/__tests__/purge-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/purge-policy.ts src/domain/__tests__/purge-policy.test.ts
git commit -m "feat: add priority prefetch selector and auto-purge LRU policy"
```

---

### Task 6: SQLite Schema & Repositories (Catalog, Articles, Settings)

**Files:**
- Create: `src/data/database.ts`
- Create: `src/data/repositories/catalog-repository.ts`
- Create: `src/data/repositories/article-repository.ts`
- Create: `src/data/repositories/settings-repository.ts`
- Test: `src/data/__tests__/repositories.test.ts`

**Interfaces:**
- Consumes: `src/domain/types.ts`, `src/domain/catalog-merge.ts`, `src/domain/curation.ts`, `src/domain/purge-policy.ts`, `assets/catalog/default-packs.json`.
- Produces:
  - `openDatabase(db?: SQLiteDatabaseLike): Promise<SQLiteDatabaseLike>` & `runMigrations(db)` in `src/data/database.ts`.
  - `CatalogRepository`: `getEffectiveCatalog()`, `refreshFromRemote(url: string, fetcher?: typeof fetch): Promise<{ updated: boolean; usedFallback: boolean }>`, `getResolvedFeeds()`.
  - `ArticleRepository`: `upsertArticles(items)`, `listByPackAndCategory(packId, category?)`, `listPickup()`, `listSaved()`, `toggleSaved(articleId)`, `recordRead(articleId, category, nowMs)`, `applyPurgePlan(plan)`.
  - `SettingsRepository`: CRUD for `interest_keywords`, `ng_words`, `user_pack_settings`, `user_feed_overrides`, `custom_feeds`.

- [ ] **Step 1: Write the failing repository tests in `src/data/__tests__/repositories.test.ts`**

Use an in-memory SQLite adapter (or mockable `SQLiteDatabaseLike` interface) to test:
- Initial seed falls back to `default-packs.json` when remote fetch fails or returns invalid JSON.
- Remote catalog refresh updates a feed's `rssUrl` without losing `user_feed_overrides` (muted) or `custom_feeds`.
- `toggleSaved` protects an article from `applyPurgePlan` metadata deletion.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/data/__tests__/repositories.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `src/data/database.ts` and the three repositories**

Create separate tables (`remote_packs`, `remote_feeds`, `user_pack_settings`, `user_feed_overrides`, `custom_feeds`, `articles`, `interest_keywords`, `ng_words`, `read_history`, `prefetch_cache`) with indexes on `(pack_id, category, published_at DESC)` and `is_saved`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/data/__tests__/repositories.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data/
git commit -m "feat: add sqlite schema, migrations, and data repositories"
```

---

### Task 7: Async Feed Sync, Local Notifications, Wi-Fi Prefetch & Background Tasks

**Files:**
- Create: `src/services/sync-service.ts`
- Create: `src/services/prefetch-service.ts`
- Create: `src/services/background-tasks.ts`
- Test: `src/services/__tests__/sync-and-prefetch.test.ts`

**Interfaces:**
- Consumes: Repositories (Task 6), `parseFeedBytes` (Task 2), `curatePickupArticles` (Task 3), `getTopReadCategories` / `selectPrefetchCandidates` / `planPurge` (Task 5).
- Produces:
  - `syncAllFeeds(deps): Promise<{ fetchedFeeds: number; failedFeeds: number; newArticles: number; newKeywordMatches: Article[] }>`
  - `runWifiPrefetchAndPurge(deps): Promise<{ skippedNotWifi: boolean; prefetchedCount: number; purgedCacheCount: number; purgedMetadataCount: number }>`
  - `registerBackgroundTasks(): Promise<void>` in `src/services/background-tasks.ts`.

- [ ] **Step 1: Write the failing service tests in `src/services/__tests__/sync-and-prefetch.test.ts`**

Test via injected dependencies (`fetcher`, `networkState`, `fileStore`, `notifier`):
- One failing feed URL does not abort syncing the remaining feeds; only newly inserted keyword-matched articles (excluding NG/muted) trigger local notification.
- `runWifiPrefetchAndPurge` skips network downloads when `networkState.type !== 'WIFI'` (`skippedNotWifi: true`), and when on Wi-Fi downloads HTML + up to 5 primary images for prioritized candidates and deletes files listed in `planPurge`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/services/__tests__/sync-and-prefetch.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `sync-service.ts`, `prefetch-service.ts`, and `background-tasks.ts`**

Limit feed fetch concurrency (e.g., 4 parallel requests), enforce per-request timeout (10s), store prefetched assets under `${FileSystem.cacheDirectory}musubi-prefetch/${articleId}/`, and register `BGAppRefreshTask` / `BGProcessingTask` equivalents via `expo-background-task`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/services/__tests__/sync-and-prefetch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/
git commit -m "feat: add async sync, notifications, wifi prefetch, and background tasks"
```

---

### Task 8: Thin Swift Native Module `musubi-webview` (`WKContentRuleList` Ad-Block)

**Files:**
- Create: `modules/musubi-webview/expo-module.config.json`
- Create: `modules/musubi-webview/package.json`
- Create: `modules/musubi-webview/ios/MusubiWebViewModule.swift`
- Create: `modules/musubi-webview/ios/MusubiWebView.swift`
- Create: `modules/musubi-webview/src/MusubiWebView.tsx`
- Create: `modules/musubi-webview/src/index.ts`
- Test: `modules/musubi-webview/__tests__/adblock-rules.test.ts`

**Interfaces:**
- Consumes: `assets/adblock/default-rules.json` (and cached remote rules JSON string).
- Produces:
  - `compileAdBlockRules(rulesJson: string): Promise<{ compiled: boolean; usedFallback: boolean }>`
  - `<MusubiWebView url={string} offlineHtmlPath={string | null} adBlockEnabled={boolean} onLoadStart={...} onLoadEnd={...} />`

- [ ] **Step 1: Write the failing JS wrapper & fallback test in `modules/musubi-webview/__tests__/adblock-rules.test.ts`**

Test that `resolveAdBlockRulesJson(remoteJson: string | null)` validates JSON array structure and falls back to `assets/adblock/default-rules.json` when remote JSON is null or malformed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest modules/musubi-webview/__tests__/adblock-rules.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the Expo Module Swift & TypeScript files**

In `MusubiWebViewModule.swift` and `MusubiWebView.swift`:
- Compile JSON via `WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "musubi-adblock", encodedContentRuleList: json)` and attach to `WKWebViewConfiguration.userContentController`.
- When offline or `url` fails to load and `offlineHtmlPath` exists, load local cached HTML via `webView.loadHTMLString(html, baseURL: URL(string: url))` for simple offline reading.
- Expose clean TypeScript props and Web fallback stub (`iframe` / link-out placeholder) so Jest and future Web builds stay clean.

- [ ] **Step 4: Run JS tests & iOS native compilation check (when Xcode is available)**

Run: `npx jest modules/musubi-webview/__tests__/adblock-rules.test.ts`
Expected: PASS. (Native Swift build verified in Task 10 `expo prebuild --platform ios` / `xcodebuild`.)

- [ ] **Step 5: Commit**

```bash
git add modules/musubi-webview/
git commit -m "feat: add swift WKContentRuleList ad-blocking webview module"
```

---

### Task 9: Modern 3-Tab UI (Home, Pickup, Sources & Settings)

**Files:**
- Modify/Create: `app/_layout.tsx`
- Modify/Create: `app/(tabs)/_layout.tsx`
- Create: `app/(tabs)/index.tsx` (Home)
- Create: `app/(tabs)/pickup.tsx` (Pickup & Saved)
- Create: `app/(tabs)/sources.tsx` (Sources & Settings)
- Create: `src/components/ArticleRow.tsx`, `src/components/PackSwitcher.tsx`, `src/components/CategoryBar.tsx`
- Test: `src/components/__tests__/ui-smoke.test.tsx`

**Interfaces:**
- Consumes: Repositories (Task 6), `syncAllFeeds` & `runWifiPrefetchAndPurge` (Task 7), `registerBackgroundTasks` (Task 7).
- Produces:
  - 3-tab modern UI with zero mysterious icons:
    - `ホーム`: Top pack switcher (`5chまとめ`, enabled packs, `マイRSS`), horizontal category bar, pull-to-refresh + automatic background sync on launch, clean article cards with prefetched badge and safe action menu (`後で読む` / `このサイトを非表示`).
    - `ピックアップ`: Top segmented control (`キーワード一致` / `保存済み`), interest keyword chips + simple add/delete UI, cross-pack matched article list.
    - `ソース・設定`: Preset pack ON/OFF toggles, add custom RSS URL form, NG words & muted sites list (with undo/unmute), Wi-Fi prefetch status & manual cache clear.

- [ ] **Step 1: Write failing component/behavior tests in `src/components/__tests__/ui-smoke.test.tsx`**

Verify pack switching updates displayed category/article scope, Pickup segment toggles between `キーワード一致` and `保存済み`, and `ArticleRow` renders title, site name, relative time, and optional prefetched indicator without mystery icons.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/components/__tests__/ui-smoke.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `app/_layout.tsx`, `app/(tabs)/*`, and `src/components/*`**

Keep typography, spacing, and native iOS feel crisp and calm; ensure first launch immediately loads bundled `matome-5ch` pack and triggers background sync without blocking the user with an empty screen.

- [ ] **Step 4: Run all tests**

Run: `npx jest`
Expected: PASS (all unit & component tests).

- [ ] **Step 5: Commit**

```bash
git add app/ src/components/
git commit -m "feat: implement modern 3-tab UI for home, pickup, and sources"
```

---

### Task 10: Article Reader Screen, EAS Update Config & iPhone 16 Dogfooding Verification

**Files:**
- Create: `app/article/[id].tsx`
- Create: `eas.json`
- Modify: `app.json` (iOS bundleIdentifier, `UIBackgroundModes: ["fetch", "processing"]`, `BGTaskSchedulerPermittedIdentifiers`, EAS Update runtimeVersion)
- Test: Full suite `npx jest` + `npx tsc --noEmit` + `npx expo prebuild --platform ios`

**Interfaces:**
- Consumes: `MusubiWebView` (Task 8), `ArticleRepository` (Task 6).
- Produces:
  - Full article reader screen with `WKContentRuleList` ad-blocking enabled, save (`後で読む`) toggle, share sheet, offline fallback indicator, and read-history recording on open.
  - Configured `eas.json` with `development`, `preview` (internal iPhone 16 dogfooding), and `production` profiles + OTA update channels.

- [ ] **Step 1: Implement `app/article/[id].tsx`**

Load article metadata and any local prefetched HTML path; record read event via `ArticleRepository.recordRead`; render `MusubiWebView` with minimal bottom/top toolbar (`戻る`・`後で読む`・`共有`・`Safariで開く`).

- [ ] **Step 2: Configure `app.json` and `eas.json` for iOS BackgroundTasks and EAS Update**

Add `BGTaskSchedulerPermittedIdentifiers`, `UIBackgroundModes`, `NSUserNotificationUsageDescription`, and `eas.json` profiles.

- [ ] **Step 3: Run full verification suite**

Run: `npx tsc --noEmit && npx jest`
Expected: 0 TypeScript errors, all tests PASS.

- [ ] **Step 4: Run iOS prebuild and verify Swift module compiles cleanly**

Run: `npx expo prebuild --platform ios --clean` and verify iOS build succeeds for iPhone 16 simulator/device.

- [ ] **Step 5: Commit**

```bash
git add app/article/ app.json eas.json
git commit -m "feat: add ad-blocked article reader and iOS dogfooding config"
```
