import defaultPacks from '../../assets/catalog/default-packs.json';
import defaultRules from '../../assets/adblock/default-rules.json';

declare function require(id: string): unknown;
declare const __dirname: string;

const fs = require('node:fs') as {
  readFileSync(filePath: string): Uint8Array;
  readFileSync(filePath: string, encoding: 'utf8'): string;
};
const path = require('node:path') as {
  resolve(...paths: string[]): string;
  join(...paths: string[]): string;
};

test('bundled catalog has schemaVersion 1, matome-5ch pack, tech-jp pack, and unique siteIds', () => {
  expect(defaultPacks.schemaVersion).toBe(1);

  const matome = defaultPacks.packs.find((p) => p.packId === 'matome-5ch');
  expect(matome).toBeDefined();
  expect(matome?.defaultEnabled).toBe(true);
  expect(matome?.feeds.length).toBeGreaterThanOrEqual(5);

  const techJp = defaultPacks.packs.find((p) => p.packId === 'tech-jp');
  expect(techJp).toBeDefined();
  expect(techJp?.defaultEnabled).toBe(false);
  expect(techJp?.feeds.length).toBeGreaterThanOrEqual(3);

  const ids = defaultPacks.packs.flatMap((p) => p.feeds.map((f) => f.siteId));
  expect(new Set(ids).size).toBe(ids.length);

  for (const pack of defaultPacks.packs) {
    expect(typeof pack.packId).toBe('string');
    expect(typeof pack.name).toBe('string');
    for (const feed of pack.feeds) {
      expect(feed.packId).toBe(pack.packId);
      expect(typeof feed.siteId).toBe('string');
      expect(typeof feed.name).toBe('string');
      expect(feed.rssUrl).toMatch(/^https?:\/\//);
      expect(typeof feed.category).toBe('string');
      expect(feed.deprecated).toBe(false);
    }
  }
});

test('bundled adblock rules conform to WKContentRuleList trigger/action shape', () => {
  expect(Array.isArray(defaultRules)).toBe(true);
  expect(defaultRules.length).toBeGreaterThanOrEqual(5);

  const validActionTypes = new Set([
    'block',
    'block-cookies',
    'css-display-none',
    'ignore-previous-rules',
    'make-https',
  ]);

  for (const rule of defaultRules) {
    expect(typeof rule.trigger?.['url-filter']).toBe('string');
    expect(rule.trigger['url-filter'].length).toBeGreaterThan(0);
    expect(typeof rule.action?.type).toBe('string');
    expect(validActionTypes.has(rule.action.type)).toBe(true);
    if (rule.action.type === 'css-display-none') {
      expect(typeof (rule.action as { selector?: string }).selector).toBe('string');
    }
  }
});

test('app icon is a 1024x1024 opaque RGB PNG meeting App Store requirements', () => {
  const iconPath = path.resolve(__dirname, '../../assets/images/icon.png');
  const bytes = fs.readFileSync(iconPath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  expect(Array.from(bytes.slice(0, 8))).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  // IHDR chunk width/height at bytes 16..24, colorType at byte 25 (2 = RGB, no alpha)
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  const colorType = view.getUint8(25);
  expect(width).toBe(1024);
  expect(height).toBe(1024);
  expect(colorType).toBe(2);
});

test('GitHub Pages site includes index, privacy policy, and support pages', () => {
  const siteDir = path.resolve(__dirname, '../../docs/site');
  const indexHtml = fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8');
  const privacyHtml = fs.readFileSync(path.join(siteDir, 'privacy.html'), 'utf8');
  const supportHtml = fs.readFileSync(path.join(siteDir, 'support.html'), 'utf8');

  expect(indexHtml).toContain('MusubiReader');
  expect(privacyHtml).toContain('プライバシーポリシー');
  expect(privacyHtml).toContain('Privacy Policy');
  expect(supportHtml).toContain('サポート・お問い合わせ');
});
