import {
  curatePickupArticles,
  isArticleBlocked,
  matchInterestKeywords,
  normalizeText,
} from '../curation';
import type { Article, InterestKeyword, NgWord } from '../types';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 'art-1',
    packId: 'pack-tech',
    siteId: 'site-a',
    siteName: 'Site A',
    category: 'tech',
    title: 'Default Title',
    url: 'https://example.com/1',
    summary: 'Default Summary',
    tags: [],
    publishedAt: 1_000,
    fetchedAt: 2_000,
    isSaved: false,
    isRead: false,
    ...overrides,
  };
}

describe('normalizeText', () => {
  test('applies NFKC and lowercases full-width and ASCII text', () => {
    expect(normalizeText('Ｔｅｃｈ News　AI')).toBe('tech news ai');
  });

  test('trims leading and trailing ASCII and full-width whitespace', () => {
    expect(normalizeText('　  ＡＩ　ニュース  　')).toBe('ai ニュース');
  });
});

describe('matchInterestKeywords', () => {
  test('matches across title, summary, and tags case-insensitively', () => {
    const hits = matchInterestKeywords(
      { title: '新型iPhoneレビュー', summary: 'Ｔｅｃｈ業界で話題', tags: ['ガジェット'] },
      [{ id: '1', word: 'tech', enabled: true, createdAt: 0 }]
    );
    expect(hits).toEqual(['tech']);
  });

  test('matches keywords in title and tags with NFKC normalization', () => {
    const keywords: InterestKeyword[] = [
      { id: '1', word: 'iphone', enabled: true, createdAt: 0 },
      { id: '2', word: 'ガジェット', enabled: true, createdAt: 0 },
      { id: '3', word: '未一致', enabled: true, createdAt: 0 },
    ];
    const hits = matchInterestKeywords(
      { title: '新型ｉＰｈｏｎｅレビュー', summary: '詳細記事', tags: ['ｶﾞｼﾞｪｯﾄ'] },
      keywords
    );
    expect(hits).toEqual(['iphone', 'ガジェット']);
  });

  test('ignores disabled and blank keywords and deduplicates equivalent normalized keywords', () => {
    const keywords: InterestKeyword[] = [
      { id: '1', word: 'Tech', enabled: true, createdAt: 0 },
      { id: '2', word: 'ｔｅｃｈ', enabled: true, createdAt: 1 },
      { id: '3', word: 'AI', enabled: false, createdAt: 2 },
      { id: '4', word: '  　 ', enabled: true, createdAt: 3 },
    ];
    const hits = matchInterestKeywords(
      { title: 'AI and Tech news', summary: '', tags: [] },
      keywords
    );
    expect(hits).toEqual(['Tech']);
  });
});

describe('isArticleBlocked', () => {
  test('returns true when siteId is in mutedSiteIds', () => {
    const blocked = isArticleBlocked(
      { siteId: 'site-muted', title: 'Good news', summary: '', tags: [] },
      [],
      new Set(['site-muted'])
    );
    expect(blocked).toBe(true);
  });

  test('matches enabled NG words across title, summary, and tags with NFKC normalization', () => {
    const ngWords: NgWord[] = [
      { id: 'ng-1', word: '炎上', enabled: true, createdAt: 0 },
      { id: 'ng-2', word: 'ＳＰＡＭ', enabled: true, createdAt: 0 },
      { id: 'ng-3', word: 'ネタバレ', enabled: false, createdAt: 0 },
      { id: 'ng-4', word: '   ', enabled: true, createdAt: 0 },
    ];

    expect(
      isArticleBlocked(
        { siteId: 'site-a', title: 'SNSで炎上中', summary: '', tags: [] },
        ngWords,
        new Set()
      )
    ).toBe(true);

    expect(
      isArticleBlocked(
        { siteId: 'site-a', title: '普通の見出し', summary: 'spam対策の話', tags: [] },
        ngWords,
        new Set()
      )
    ).toBe(true);

    expect(
      isArticleBlocked(
        { siteId: 'site-a', title: '映画レビュー', summary: 'ネタバレ注意', tags: ['映画'] },
        ngWords,
        new Set()
      )
    ).toBe(false);

    expect(
      isArticleBlocked(
        { siteId: 'site-a', title: '映画レビュー', summary: '', tags: ['炎上'] },
        ngWords,
        new Set()
      )
    ).toBe(true);
  });
});

describe('curatePickupArticles', () => {
  test('NG word and muted site always override interest keyword matches and sorts newest first', () => {
    const keywords: InterestKeyword[] = [
      { id: 'k1', word: 'tech', enabled: true, createdAt: 0 },
      { id: 'k2', word: 'AI', enabled: true, createdAt: 0 },
    ];
    const ngWords: NgWord[] = [
      { id: 'n1', word: '炎上', enabled: true, createdAt: 0 },
    ];
    const mutedSiteIds = new Set(['site-muted']);

    const ngArticle = makeArticle({
      id: 'art-ng',
      siteId: 'site-a',
      title: 'Tech業界で大炎上',
      publishedAt: 5_000,
    });
    const mutedArticle = makeArticle({
      id: 'art-muted',
      siteId: 'site-muted',
      title: 'Tech最新情報',
      publishedAt: 6_000,
    });
    const olderValid = makeArticle({
      id: 'art-old',
      siteId: 'site-a',
      title: 'Ｔｅｃｈ解説',
      publishedAt: 1_000,
    });
    const newerValid = makeArticle({
      id: 'art-new',
      siteId: 'site-b',
      title: 'TechとＡＩの融合',
      publishedAt: 3_000,
    });
    const unmatched = makeArticle({
      id: 'art-none',
      siteId: 'site-a',
      title: '今日の天気',
      publishedAt: 9_000,
    });

    const input = [olderValid, ngArticle, mutedArticle, newerValid, unmatched];
    const result = curatePickupArticles(input, keywords, ngWords, mutedSiteIds);

    expect(result).toEqual([
      { article: newerValid, matchedKeywords: ['tech', 'AI'] },
      { article: olderValid, matchedKeywords: ['tech'] },
    ]);
    // Ensure input array was not mutated
    expect(input.map((a) => a.id)).toEqual([
      'art-old',
      'art-ng',
      'art-muted',
      'art-new',
      'art-none',
    ]);
  });
});
