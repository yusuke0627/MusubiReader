import defaultPacks from '../../../assets/catalog/default-packs.json';
import {
  MY_RSS_PACK_ID,
  resolveActiveFeeds,
  validateRemoteCatalog,
} from '../catalog-merge';
import type {
  CustomFeed,
  RemoteCatalog,
  UserFeedOverride,
  UserPackSetting,
} from '../types';

function makeCatalog(overrides: Partial<RemoteCatalog> = {}): RemoteCatalog {
  return {
    schemaVersion: 1,
    updatedAt: '2026-11-21T00:00:00Z',
    packs: [
      {
        packId: 'pack-1',
        name: 'Pack 1',
        description: 'Primary pack',
        defaultEnabled: true,
        feeds: [
          {
            packId: 'pack-1',
            siteId: 'site-1',
            name: 'Site 1',
            rssUrl: 'https://example.com/site-1/new.rdf',
            category: 'IT',
            deprecated: false,
          },
          {
            packId: 'pack-1',
            siteId: 'site-2',
            name: 'Site 2',
            rssUrl: 'https://example.com/site-2/rss.xml',
            category: 'News',
            deprecated: false,
          },
        ],
      },
      {
        packId: 'pack-2',
        name: 'Pack 2',
        description: 'Secondary pack',
        defaultEnabled: true,
        feeds: [
          {
            packId: 'pack-2',
            siteId: 'site-3',
            name: 'Site 3',
            rssUrl: 'https://example.com/site-3/atom.xml',
            category: 'Tech',
            deprecated: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('resolveActiveFeeds', () => {
  test('updates rssUrl from remote catalog while preserving user mute and pack toggle', () => {
    const updatedCatalog = makeCatalog();
    const packSettings: UserPackSetting[] = [
      { packId: 'pack-2', enabled: false, updatedAt: 1_000 },
    ];
    const feedOverrides: UserFeedOverride[] = [
      { siteId: 'site-1', muted: true, updatedAt: 1_000 },
    ];
    const customFeeds: CustomFeed[] = [
      {
        siteId: 'custom-1',
        name: 'My Blog',
        rssUrl: 'https://myblog.example.jp/feed.xml',
        category: '個人ブログ',
        muted: false,
        createdAt: 500,
      },
    ];

    const resolved = resolveActiveFeeds(
      updatedCatalog,
      packSettings,
      feedOverrides,
      customFeeds
    );

    expect(resolved).toEqual([
      {
        packId: 'pack-1',
        siteId: 'site-1',
        name: 'Site 1',
        rssUrl: 'https://example.com/site-1/new.rdf',
        category: 'IT',
        enabled: true,
        muted: true,
        isCustom: false,
      },
      {
        packId: 'pack-1',
        siteId: 'site-2',
        name: 'Site 2',
        rssUrl: 'https://example.com/site-2/rss.xml',
        category: 'News',
        enabled: true,
        muted: false,
        isCustom: false,
      },
      {
        packId: 'pack-2',
        siteId: 'site-3',
        name: 'Site 3',
        rssUrl: 'https://example.com/site-3/atom.xml',
        category: 'Tech',
        enabled: false,
        muted: false,
        isCustom: false,
      },
      {
        packId: MY_RSS_PACK_ID,
        siteId: 'custom-1',
        name: 'My Blog',
        rssUrl: 'https://myblog.example.jp/feed.xml',
        category: '個人ブログ',
        enabled: true,
        muted: false,
        isCustom: true,
      },
    ]);
  });

  test('excludes deprecated remote feeds without touching custom feeds', () => {
    const catalog = makeCatalog({
      packs: [
        {
          packId: 'pack-1',
          name: 'Pack 1',
          description: 'Primary pack',
          defaultEnabled: true,
          feeds: [
            {
              packId: 'pack-1',
              siteId: 'site-active',
              name: 'Active Site',
              rssUrl: 'https://example.com/active.xml',
              category: 'IT',
              deprecated: false,
            },
            {
              packId: 'pack-1',
              siteId: 'site-old',
              name: 'Deprecated Site',
              rssUrl: 'https://example.com/old.xml',
              category: 'IT',
              deprecated: true,
            },
          ],
        },
      ],
    });
    const customFeeds: CustomFeed[] = [
      {
        siteId: 'custom-keep',
        name: 'Custom Keep',
        rssUrl: 'https://custom.example.com/rss',
        category: 'Custom',
        muted: true,
        createdAt: 100,
      },
    ];

    const resolved = resolveActiveFeeds(catalog, [], [], customFeeds);

    expect(resolved.map((f) => f.siteId)).toEqual(['site-active', 'custom-keep']);
    expect(resolved[1]).toEqual({
      packId: 'my-rss',
      siteId: 'custom-keep',
      name: 'Custom Keep',
      rssUrl: 'https://custom.example.com/rss',
      category: 'Custom',
      enabled: true,
      muted: true,
      isCustom: true,
    });
  });

  test('uses pack defaultEnabled when no UserPackSetting exists and respects UserPackSetting for my-rss', () => {
    const catalog = makeCatalog({
      packs: [
        {
          packId: 'pack-disabled-default',
          name: 'Opt-in Pack',
          description: 'Disabled by default',
          defaultEnabled: false,
          feeds: [
            {
              packId: 'pack-disabled-default',
              siteId: 'site-opt',
              name: 'Opt Site',
              rssUrl: 'https://example.com/opt.xml',
              category: 'Tech',
              deprecated: false,
            },
          ],
        },
      ],
    });
    const packSettings: UserPackSetting[] = [
      { packId: 'my-rss', enabled: false, updatedAt: 2_000 },
    ];
    const customFeeds: CustomFeed[] = [
      {
        siteId: 'custom-1',
        name: 'Custom Feed',
        rssUrl: 'https://custom.example.com/feed',
        category: 'My',
        muted: false,
        createdAt: 1_000,
      },
    ];

    const resolved = resolveActiveFeeds(catalog, packSettings, [], customFeeds);

    expect(resolved).toEqual([
      expect.objectContaining({
        packId: 'pack-disabled-default',
        siteId: 'site-opt',
        enabled: false,
        isCustom: false,
      }),
      expect.objectContaining({
        packId: 'my-rss',
        siteId: 'custom-1',
        enabled: false,
        isCustom: true,
      }),
    ]);
  });

  test('uses most recent setting or override by updatedAt when duplicates exist', () => {
    const catalog = makeCatalog({
      packs: [
        {
          packId: 'pack-1',
          name: 'Pack 1',
          description: 'Primary',
          defaultEnabled: true,
          feeds: [
            {
              packId: 'pack-1',
              siteId: 'site-1',
              name: 'Site 1',
              rssUrl: 'https://example.com/1.xml',
              category: 'IT',
              deprecated: false,
            },
          ],
        },
      ],
    });
    const packSettings: UserPackSetting[] = [
      { packId: 'pack-1', enabled: false, updatedAt: 200 },
      { packId: 'pack-1', enabled: true, updatedAt: 100 },
    ];
    const feedOverrides: UserFeedOverride[] = [
      { siteId: 'site-1', muted: true, updatedAt: 300 },
      { siteId: 'site-1', muted: false, updatedAt: 150 },
    ];

    const resolved = resolveActiveFeeds(catalog, packSettings, feedOverrides, []);

    expect(resolved[0].enabled).toBe(false);
    expect(resolved[0].muted).toBe(true);
  });
});

describe('validateRemoteCatalog', () => {
  test('returns null on malformed JSON payload', () => {
    expect(validateRemoteCatalog({ broken: true })).toBeNull();
    expect(validateRemoteCatalog(null)).toBeNull();
    expect(validateRemoteCatalog(undefined)).toBeNull();
    expect(validateRemoteCatalog('not-an-object')).toBeNull();
    expect(validateRemoteCatalog([])).toBeNull();
  });

  test('returns null when schemaVersion, updatedAt, packs, or feeds are invalid', () => {
    const valid = makeCatalog();

    expect(validateRemoteCatalog({ ...valid, schemaVersion: 0 })).toBeNull();
    expect(validateRemoteCatalog({ ...valid, schemaVersion: '1' })).toBeNull();
    expect(validateRemoteCatalog({ ...valid, updatedAt: '' })).toBeNull();
    expect(validateRemoteCatalog({ ...valid, packs: 'invalid' })).toBeNull();

    expect(
      validateRemoteCatalog({
        ...valid,
        packs: [{ ...valid.packs[0], defaultEnabled: 'yes' }],
      })
    ).toBeNull();

    expect(
      validateRemoteCatalog({
        ...valid,
        packs: [
          {
            ...valid.packs[0],
            feeds: [{ ...valid.packs[0].feeds[0], rssUrl: 'ftp://bad.example/feed' }],
          },
        ],
      })
    ).toBeNull();

    expect(
      validateRemoteCatalog({
        ...valid,
        packs: [
          {
            ...valid.packs[0],
            feeds: [{ ...valid.packs[0].feeds[0], deprecated: 'false' }],
          },
        ],
      })
    ).toBeNull();
  });

  test('returns typed RemoteCatalog for valid payloads including bundled default-packs.json', () => {
    const valid = makeCatalog();
    expect(validateRemoteCatalog(valid)).toEqual(valid);
    expect(validateRemoteCatalog(defaultPacks)).toEqual(defaultPacks);
  });
});
