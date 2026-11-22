import iconv from 'iconv-lite';

export const CHARSET_ALIASES: Record<string, string> = {
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
  'iso-2022-jp': 'iso-2022-jp',
  'csiso2022jp': 'iso-2022-jp',
  'utf-8': 'utf-8',
  'utf8': 'utf-8',
  'iso-8859-1': 'iso-8859-1',
  'latin1': 'iso-8859-1',
};

export function normalizeCharset(rawCharset: string | undefined): string | null {
  if (!rawCharset) {
    return null;
  }
  const lowered = rawCharset.trim().toLowerCase();
  const mapped = CHARSET_ALIASES[lowered] ?? lowered;
  return iconv.encodingExists(mapped) ? mapped : null;
}

export function readAsciiPrefix(bytes: Uint8Array, maxBytes = 512): string {
  const length = Math.min(bytes.length, maxBytes);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

export function detectBomOrHeaderCharset(
  bytes: Uint8Array,
  contentType?: string
): string | null {
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

  return null;
}
