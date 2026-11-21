import type { Article, InterestKeyword, NgWord } from './types';

/**
 * Normalizes text for Japanese/ASCII keyword and NG-word matching using
 * Unicode NFKC normalization, lowercasing, and trimming.
 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').toLowerCase().trim();
}

function extractSearchableFields(
  article: Pick<Article, 'title' | 'summary' | 'tags'>
): string[] {
  return [
    normalizeText(article.title),
    normalizeText(article.summary),
    ...article.tags.map(normalizeText),
  ];
}

function fieldsContainNormalizedWord(
  normalizedFields: readonly string[],
  normalizedWord: string
): boolean {
  if (normalizedWord.length === 0) {
    return false;
  }
  return normalizedFields.some((field) => field.includes(normalizedWord));
}

/**
 * Returns enabled interest keywords that match the article's title, summary, or tags.
 */
export function matchInterestKeywords(
  article: Pick<Article, 'title' | 'summary' | 'tags'>,
  keywords: InterestKeyword[]
): string[] {
  if (keywords.length === 0) {
    return [];
  }

  const fields = extractSearchableFields(article);
  const seenNormalized = new Set<string>();
  const matched: string[] = [];

  for (const keyword of keywords) {
    if (!keyword.enabled) {
      continue;
    }

    const normalizedWord = normalizeText(keyword.word);
    if (normalizedWord.length === 0 || seenNormalized.has(normalizedWord)) {
      continue;
    }

    if (fieldsContainNormalizedWord(fields, normalizedWord)) {
      seenNormalized.add(normalizedWord);
      matched.push(keyword.word);
    }
  }

  return matched;
}

/**
 * Determines whether an article is blocked by a muted site or any enabled NG word.
 */
export function isArticleBlocked(
  article: Pick<Article, 'siteId' | 'title' | 'summary' | 'tags'>,
  ngWords: NgWord[],
  mutedSiteIds: ReadonlySet<string>
): boolean {
  if (mutedSiteIds.has(article.siteId)) {
    return true;
  }

  if (ngWords.length === 0) {
    return false;
  }

  const fields = extractSearchableFields(article);
  return ngWords.some(
    (ngWord) =>
      ngWord.enabled &&
      fieldsContainNormalizedWord(fields, normalizeText(ngWord.word))
  );
}

/**
 * Curates Pickup articles matching enabled interest keywords while strictly
 * excluding NG-word hits and muted sites, sorted newest publishedAt first.
 */
export function curatePickupArticles(
  articles: Article[],
  keywords: InterestKeyword[],
  ngWords: NgWord[],
  mutedSiteIds: ReadonlySet<string>
): Array<{ article: Article; matchedKeywords: string[] }> {
  const curated: Array<{ article: Article; matchedKeywords: string[] }> = [];

  for (const article of articles) {
    // Evaluate blocking rules first so NG words and muted sites always override keyword matches.
    if (isArticleBlocked(article, ngWords, mutedSiteIds)) {
      continue;
    }

    const matchedKeywords = matchInterestKeywords(article, keywords);
    if (matchedKeywords.length === 0) {
      continue;
    }

    curated.push({ article, matchedKeywords });
  }

  curated.sort((a, b) => b.article.publishedAt - a.article.publishedAt);
  return curated;
}
