import { XMLParser } from 'fast-xml-parser';
import iconv from 'iconv-lite';
import type { ParsedFeedItem } from './types';

const CHARSET_ALIASES: Record<string, string> = {
  'shift_jis': 'shift_jis',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  'x-sjis': 'shift_jis',
  'ms_kanji': 'shift_jis',
  'windows-31j': 'cp932',
  'cp932': 'cp932',
  'ms932': 'cp932',
  'euc-jp': 'euc-jp',
  'euc_jp': 'euc-jp',
  'eucjp': 'euc-jp',
  'x-euc-jp': 'euc-jp',
  'utf-8': 'utf-8',
  'utf8': 'utf-8',
};

const CDATA_SPLIT_REGEX = /(<!\[CDATA\[[\s\S]*?\]\]>)/g;
const BARE_AMP_REGEX = /&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g;
const HTML_TAG_REGEX = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+[^<>]*)?\/?>/g;

const HTML_NAMED_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  processEntities: true,
  isArray: (tagName) =>
    tagName === 'item' ||
    tagName === 'entry' ||
    tagName === 'category' ||
    tagName === 'dc:subject' ||
    tagName === 'link',
});

function normalizeCharset(rawCharset: string | undefined): string | null {
  if (!rawCharset) {
    return null;
  }
  const lowered = rawCharset.trim().toLowerCase();
  const mapped = CHARSET_ALIASES[lowered] ?? lowered;
  return iconv.encodingExists(mapped) ? mapped : null;
}

function readAsciiPrefix(bytes: Uint8Array, maxBytes = 512): string {
  const length = Math.min(bytes.length, maxBytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function detectEncoding(bytes: Uint8Array, contentType?: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be';
  }

  if (contentType) {
    const headerMatch = /charset\s*=\s*["']?([a-zA-Z0-9._-]+)["']?/i.exec(contentType);
    const headerCharset = normalizeCharset(headerMatch?.[1]);
    if (headerCharset) {
      return headerCharset;
    }
  }

  const head = readAsciiPrefix(bytes);
  const xmlDeclMatch = /<\?xml[^>]*encoding\s*=\s*["']([a-zA-Z0-9._-]+)["']/i.exec(head);
  const xmlCharset = normalizeCharset(xmlDeclMatch?.[1]);
  if (xmlCharset) {
    return xmlCharset;
  }

  return 'utf-8';
}

function sanitizeXml(xml: string): string {
  return xml
    .split(CDATA_SPLIT_REGEX)
    .map((segment) =>
      segment.startsWith('<![CDATA[')
        ? segment
        : segment.replace(BARE_AMP_REGEX, '&amp;')
    )
    .join('');
}

function extractText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = extractText(entry);
      if (text) {
        return text;
      }
    }
    return '';
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('#text' in record) {
      return extractText(record['#text']);
    }
    if ('__cdata' in record) {
      return extractText(record.__cdata);
    }
  }
  return '';
}

function decodeHtmlText(raw: string): string {
  if (!raw) {
    return '';
  }
  const stripped = raw.replace(HTML_TAG_REGEX, ' ');
  const decoded = stripped
    .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/gi, (entity) => {
      return HTML_NAMED_ENTITIES[entity.toLowerCase()] ?? entity;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    });

  return decoded.replace(/\s+/g, ' ').trim();
}

function parseTimestamp(value: unknown): number {
  const raw = extractText(value);
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractCategories(...sources: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }
    const list = Array.isArray(source) ? source : [source];
    for (const entry of list) {
      let category = '';
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        category = extractText(record['@_term'] ?? record['@_label'] ?? record['#text']);
      } else {
        category = extractText(entry);
      }
      if (category && !seen.has(category)) {
        seen.add(category);
        result.push(category);
      }
    }
  }

  return result;
}

function extractAtomLink(links: unknown): string {
  if (!links) {
    return '';
  }
  const list = Array.isArray(links) ? links : [links];

  for (const link of list) {
    if (link && typeof link === 'object') {
      const record = link as Record<string, unknown>;
      const rel = extractText(record['@_rel']);
      const href = extractText(record['@_href']);
      if (href && (!rel || rel === 'alternate')) {
        return href;
      }
    }
  }

  for (const link of list) {
    if (link && typeof link === 'object') {
      const href = extractText((link as Record<string, unknown>)['@_href']);
      if (href) {
        return href;
      }
    }
    const text = extractText(link);
    if (text) {
      return text;
    }
  }

  return '';
}

function extractRssLink(item: Record<string, unknown>): string {
  const link = extractText(item.link);
  if (link) {
    return link;
  }
  const guid = extractText(item.guid);
  if (guid.startsWith('http://') || guid.startsWith('https://')) {
    return guid;
  }
  return extractText(item['@_rdf:about']);
}

function buildParsedItem(fields: {
  rawTitle: unknown;
  url: string;
  rawSummary: string;
  rawDate: unknown;
  categorySources: unknown[];
}): ParsedFeedItem | null {
  const title = decodeHtmlText(extractText(fields.rawTitle));
  if (!title && !fields.url) {
    return null;
  }
  return {
    title,
    url: fields.url,
    summary: decodeHtmlText(fields.rawSummary),
    publishedAt: parseTimestamp(fields.rawDate),
    categories: extractCategories(...fields.categorySources),
  };
}

function normalizeRssItems(rawItems: unknown): ParsedFeedItem[] {
  if (!Array.isArray(rawItems)) {
    return [];
  }

  const items: ParsedFeedItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const item = raw as Record<string, unknown>;
    const normalized = buildParsedItem({
      rawTitle: item.title,
      url: extractRssLink(item),
      rawSummary: extractText(item.description) || extractText(item['content:encoded']),
      rawDate: item.pubDate ?? item['dc:date'],
      categorySources: [item.category, item['dc:subject']],
    });
    if (normalized) {
      items.push(normalized);
    }
  }

  return items;
}

function normalizeAtomEntries(rawEntries: unknown): ParsedFeedItem[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const items: ParsedFeedItem[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const normalized = buildParsedItem({
      rawTitle: entry.title,
      url: extractAtomLink(entry.link),
      rawSummary: extractText(entry.summary) || extractText(entry.content),
      rawDate: entry.updated ?? entry.published,
      categorySources: [entry.category],
    });
    if (normalized) {
      items.push(normalized);
    }
  }

  return items;
}

/**
 * Parses RSS 1.0 (RDF), RSS 2.0, or Atom bytes into normalized feed items.
 * Handles Japanese charsets (UTF-8, Shift_JIS, EUC-JP), bare ampersands,
 * and returns an empty array on unrecoverable input without throwing.
 */
export function parseFeedBytes(bytes: Uint8Array, contentType?: string): ParsedFeedItem[] {
  if (!bytes || bytes.length === 0) {
    return [];
  }

  try {
    const encoding = detectEncoding(bytes, contentType);
    const decoded = iconv.decode(bytes, encoding).trim();
    if (!decoded || !decoded.includes('<')) {
      return [];
    }

    const sanitized = sanitizeXml(decoded);
    const parsed = xmlParser.parse(sanitized) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== 'object') {
      return [];
    }

    // RSS 2.0
    const rss = parsed.rss as Record<string, unknown> | undefined;
    const channel = rss?.channel as Record<string, unknown> | undefined;
    if (channel && 'item' in channel) {
      return normalizeRssItems(channel.item);
    }

    // RSS 1.0 (RDF)
    const rdf = (parsed['rdf:RDF'] ?? parsed.RDF) as Record<string, unknown> | undefined;
    if (rdf && 'item' in rdf) {
      return normalizeRssItems(rdf.item);
    }

    // Atom
    const feed = parsed.feed as Record<string, unknown> | undefined;
    if (feed && 'entry' in feed) {
      return normalizeAtomEntries(feed.entry);
    }

    return [];
  } catch {
    return [];
  }
}
