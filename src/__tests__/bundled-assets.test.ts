import defaultPacks from '../../assets/catalog/default-packs.json';
import defaultRules from '../../assets/adblock/default-rules.json';

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
