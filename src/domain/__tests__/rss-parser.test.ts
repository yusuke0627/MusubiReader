import iconv from 'iconv-lite';
import { parseFeedBytes } from '../rss-parser';

describe('parseFeedBytes', () => {
  test('parses RSS 2.0 items with title, url, summary, publishedAt, and categories', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>Sample RSS 2.0</title>
          <item>
            <title>新型ガジェット発表</title>
            <link>https://example.com/rss2/1</link>
            <description><![CDATA[<p>注目の新製品が発売されました。</p>]]></description>
            <pubDate>Sat, 21 Nov 2026 10:00:00 +0900</pubDate>
            <category>IT</category>
            <category>ガジェット</category>
          </item>
          <item>
            <title>単一カテゴリ記事</title>
            <link>https://example.com/rss2/2</link>
            <description>シンプル要約</description>
            <pubDate>Sat, 21 Nov 2026 09:00:00 +0900</pubDate>
            <category>ニュース</category>
          </item>
        </channel>
      </rss>`;

    const items = parseFeedBytes(new TextEncoder().encode(xml), 'application/rss+xml; charset=utf-8');

    expect(items).toEqual([
      {
        title: '新型ガジェット発表',
        url: 'https://example.com/rss2/1',
        summary: '注目の新製品が発売されました。',
        publishedAt: Date.parse('Sat, 21 Nov 2026 10:00:00 +0900'),
        categories: ['IT', 'ガジェット'],
      },
      {
        title: '単一カテゴリ記事',
        url: 'https://example.com/rss2/2',
        summary: 'シンプル要約',
        publishedAt: Date.parse('Sat, 21 Nov 2026 09:00:00 +0900'),
        categories: ['ニュース'],
      },
    ]);
  });

  test('parses RSS 1.0 (RDF) matome feeds with dc:date and content:encoded', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rdf:RDF
        xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        xmlns="http://purl.org/rss/1.0/"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:content="http://purl.org/rss/1.0/modules/content/">
        <channel rdf:about="https://matome.example.com/">
          <title>まとめブログ</title>
        </channel>
        <item rdf:about="https://matome.example.com/archives/100.html">
          <title>【速報】5chまとめスレ</title>
          <link>https://matome.example.com/archives/100.html</link>
          <content:encoded><![CDATA[<div>スレの反応まとめです。</div>]]></content:encoded>
          <dc:date>2026-11-21T12:30:00+09:00</dc:date>
          <dc:subject>雑談</dc:subject>
        </item>
      </rdf:RDF>`;

    const items = parseFeedBytes(new TextEncoder().encode(xml));

    expect(items).toEqual([
      {
        title: '【速報】5chまとめスレ',
        url: 'https://matome.example.com/archives/100.html',
        summary: 'スレの反応まとめです。',
        publishedAt: Date.parse('2026-11-21T12:30:00+09:00'),
        categories: ['雑談'],
      },
    ]);
  });

  test('parses Atom feeds with entry link href and updated timestamp', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Tech Atom Feed</title>
        <entry>
          <title type="text">TypeScript実践ガイド</title>
          <link rel="self" href="https://example.com/atom/self/1" />
          <link rel="alternate" type="text/html" href="https://example.com/atom/1" />
          <summary>型安全な開発手法を解説</summary>
          <updated>2026-11-21T08:15:00Z</updated>
          <category term="TypeScript" />
          <category term="開発" />
        </entry>
      </feed>`;

    const items = parseFeedBytes(new TextEncoder().encode(xml), 'application/atom+xml');

    expect(items).toEqual([
      {
        title: 'TypeScript実践ガイド',
        url: 'https://example.com/atom/1',
        summary: '型安全な開発手法を解説',
        publishedAt: Date.parse('2026-11-21T08:15:00Z'),
        categories: ['TypeScript', '開発'],
      },
    ]);
  });

  test('decodes Shift_JIS encoded Japanese RSS without mojibake', () => {
    const sjis = iconv.encode(
      '<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><item><title>テスト記事</title><link>https://example.com/1</link></item></channel></rss>',
      'shift_jis'
    );
    const items = parseFeedBytes(new Uint8Array(sjis), 'application/xml; charset=Shift_JIS');
    expect(items[0].title).toBe('テスト記事');
  });

  test('decodes EUC-JP encoded RSS from XML encoding declaration when contentType omits charset', () => {
    const eucjp = iconv.encode(
      '<?xml version="1.0" encoding="EUC-JP"?><rss version="2.0"><channel><item><title>日本語EUC記事</title><link>https://example.com/euc</link><description>文字化けしないテスト</description></item></channel></rss>',
      'euc-jp'
    );
    const items = parseFeedBytes(new Uint8Array(eucjp), 'application/xml');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('日本語EUC記事');
    expect(items[0].summary).toBe('文字化けしないテスト');
  });

  test('handles unescaped ampersands and returns empty array on unrecoverable XML without throwing', () => {
    const withBareAmp = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Q&A &amp; 解説</title>
            <link>https://example.com/watch?v=1&list=2</link>
            <description>A&Bの比較 &lt;重要&gt;</description>
          </item>
        </channel>
      </rss>`;

    const items = parseFeedBytes(new TextEncoder().encode(withBareAmp));
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Q&A & 解説');
    expect(items[0].url).toBe('https://example.com/watch?v=1&list=2');
    expect(items[0].summary).toBe('A&Bの比較 <重要>');

    const broken = new TextEncoder().encode('<not-xml<<<');
    expect(parseFeedBytes(broken)).toEqual([]);
    expect(parseFeedBytes(new TextEncoder().encode('<html><body>Not a feed</body></html>'))).toEqual([]);
    expect(parseFeedBytes(new Uint8Array())).toEqual([]);
  });

  test('falls back to Atom published/content fields when updated/summary are absent', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <title>Fallback Entry</title>
          <link href="https://example.com/atom/fallback" />
          <content type="html"><![CDATA[<p>本文コンテンツ</p>]]></content>
          <published>2026-11-20T05:00:00Z</published>
        </entry>
      </feed>`;

    const items = parseFeedBytes(new TextEncoder().encode(xml));
    expect(items).toEqual([
      {
        title: 'Fallback Entry',
        url: 'https://example.com/atom/fallback',
        summary: '本文コンテンツ',
        publishedAt: Date.parse('2026-11-20T05:00:00Z'),
        categories: [],
      },
    ]);
  });
});
