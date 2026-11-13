import 'reflect-metadata';

// TikTok approved the app on 9 Oct 2026, but the Content Posting API audit is
// a separate step that has not been filed. Until it passes, TikTok refuses
// every direct post except "Only me" from a private account
// (unaudited_client_can_only_post_to_private_accounts): 4 of 14 TikTok posts
// in the 21 days to 19 Oct failed that way.
//   pnpm exec jest -c apps/backend/jest.config.ts tiktok.provider

const AUDITED = process.env.TIKTOK_DIRECT_POST_AUDITED;
afterEach(() => {
  if (AUDITED === undefined) delete process.env.TIKTOK_DIRECT_POST_AUDITED;
  else process.env.TIKTOK_DIRECT_POST_AUDITED = AUDITED;
  jest.restoreAllMocks();
});

// The @Rules text is fixed when the module loads, so each case loads its own
// copy with the env it needs.
const load = (audited?: 'true') => {
  if (audited) process.env.TIKTOK_DIRECT_POST_AUDITED = audited;
  else delete process.env.TIKTOK_DIRECT_POST_AUDITED;
  let mod: typeof import('./tiktok.provider');
  jest.isolateModules(() => {
    mod = require('./tiktok.provider');
  });
  return mod!;
};

const rulesOf = (mod: typeof import('./tiktok.provider')) =>
  Reflect.getMetadata('custom:rules:description', mod.TiktokProvider) as string;

// The body TikTok sent for the 18 Oct 15:12 UTC failure (public account,
// DIRECT_POST, PUBLIC_TO_EVERYONE).
const unauditedBody = JSON.stringify({
  error: {
    code: 'unaudited_client_can_only_post_to_private_accounts',
    message:
      'Please review our integration guidelines at https://developers.tiktok.com/doc/content-sharing-guidelines/',
  },
});

describe('TiktokProvider while the Content Posting audit is pending', () => {
  it('tells the user what to do instead of "contact support"', () => {
    const { TiktokProvider } = load();
    const result = new TiktokProvider().handleErrors(unauditedBody);

    expect(result?.type).toBe('bad-body');
    expect(result?.value).not.toMatch(/contact support/i);
    expect(result?.value).toContain('"Only me"');
    expect(result?.value).toContain(
      'Upload content to TikTok without posting it'
    );
  });

  it('treats an unset TIKTOK_DIRECT_POST_AUDITED as unaudited', () => {
    expect(load().tiktokDirectPostAudited()).toBe(false);
    expect(load('true').tiktokDirectPostAudited()).toBe(true);
  });

  it('reports the audit state to the composer with creator_info', async () => {
    const { TiktokProvider } = load();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({
        data: {
          creator_username: 'hookpost_ai',
          privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
        },
        error: { code: 'ok' },
      }),
    } as any);

    const info = await new TiktokProvider().creatorInfo('tok');

    expect(info).toMatchObject({
      creator_username: 'hookpost_ai',
      privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
      hookpost_direct_post_audited: false,
    });
    expect(info).not.toHaveProperty('error_code');
  });

  it('tells the MCP/API agent to send an inbox upload, not a direct post', () => {
    const rules = rulesOf(load());

    expect(rules).toContain('use content_posting_method=UPLOAD');
    expect(rules).not.toContain('Use DIRECT_POST unless');
  });
});

describe('TiktokProvider once TikTok confirms the audit', () => {
  it('reports audited to the composer', async () => {
    const { TiktokProvider } = load('true');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      json: async () => ({ data: {}, error: { code: 'ok' } }),
    } as any);

    expect(await new TiktokProvider().creatorInfo('tok')).toMatchObject({
      hookpost_direct_post_audited: true,
    });
  });

  it('goes back to recommending DIRECT_POST to the agent', () => {
    const rules = rulesOf(load('true'));

    expect(rules).toContain('Use DIRECT_POST unless');
    expect(rules).not.toContain('has not passed TikTok');
  });
});

describe('TiktokProvider connect URL', () => {
  it('always shows the TikTok consent page, even if already authorized', async () => {
    const { TiktokProvider } = load();
    const { url, state } = await new TiktokProvider().generateAuthUrl();
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe(
      'https://www.tiktok.com/v2/auth/authorize/'
    );
    expect(parsed.searchParams.get('disable_auto_auth')).toBe('1');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('state')).toBe(state);
  });
});

// The composer's two commercial-content options have to arrive at TikTok as
// post_info.brand_organic_toggle ("Your brand" / Promotional content) and
// post_info.brand_content_toggle ("Branded content" / Paid partnership).
describe('TiktokProvider commercial content disclosure', () => {
  const postInfoFor = (settings: Record<string, unknown>) => {
    const { TiktokProvider } = load('true');
    const provider = new TiktokProvider() as any;
    return provider.buildTikokPostInfoBody({
      id: 'post-1',
      message: 'hello',
      media: [{ path: 'https://cdn.test/a.mp4' }],
      settings: {
        content_posting_method: 'DIRECT_POST',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        ...settings,
      },
    }).post_info;
  };

  it('sends "Your brand" as brand_organic_toggle', () => {
    expect(
      postInfoFor({
        disclose: true,
        brand_organic_toggle: true,
        brand_content_toggle: false,
      })
    ).toMatchObject({
      brand_organic_toggle: true,
      brand_content_toggle: false,
    });
  });

  it('sends "Branded content" as brand_content_toggle', () => {
    expect(
      postInfoFor({
        disclose: true,
        brand_organic_toggle: false,
        brand_content_toggle: true,
      })
    ).toMatchObject({
      brand_organic_toggle: false,
      brand_content_toggle: true,
    });
  });

  it('sends both when the creator picks both', () => {
    expect(
      postInfoFor({
        disclose: true,
        brand_organic_toggle: true,
        brand_content_toggle: true,
      })
    ).toMatchObject({
      brand_organic_toggle: true,
      brand_content_toggle: true,
    });
  });

  // Disclosure switched off means neither label, whatever is still stored.
  it('sends neither toggle when disclosure is off', () => {
    expect(
      postInfoFor({
        disclose: false,
        brand_organic_toggle: true,
        brand_content_toggle: true,
      })
    ).toMatchObject({
      brand_organic_toggle: false,
      brand_content_toggle: false,
    });
  });

  it('always sends both keys, so TikTok never has to guess', () => {
    const postInfo = postInfoFor({});
    expect(Object.keys(postInfo)).toEqual(
      expect.arrayContaining(['brand_organic_toggle', 'brand_content_toggle'])
    );
    expect(postInfo.brand_organic_toggle).toBe(false);
    expect(postInfo.brand_content_toggle).toBe(false);
  });

  // An inbox draft carries no post_info at all for a video; TikTok discards
  // every setting but the title.
  it('sends no post_info for an inbox video draft', () => {
    const { TiktokProvider } = load('true');
    const provider = new TiktokProvider() as any;
    expect(
      provider.buildTikokPostInfoBody({
        id: 'post-1',
        message: 'hello',
        media: [{ path: 'https://cdn.test/a.mp4' }],
        settings: {
          content_posting_method: 'UPLOAD',
          disclose: true,
          brand_content_toggle: true,
        },
      })
    ).toEqual({});
  });
});

describe('tiktokExpiresIn (2-hour tokens from 1 Dec 2026)', () => {
  const { tiktokExpiresIn } = load();
  it('uses the lifetime TikTok returns, 5 minutes early', () => {
    expect(tiktokExpiresIn(7200)).toBe(6900);
    expect(tiktokExpiresIn(86400)).toBe(86100);
  });
  it('assumes 2 hours when TikTok sends nothing usable', () => {
    expect(tiktokExpiresIn(undefined)).toBe(6900);
    expect(tiktokExpiresIn('abc')).toBe(6900);
    expect(tiktokExpiresIn(0)).toBe(6900);
  });
  it('never goes below a minute', () => {
    expect(tiktokExpiresIn(100)).toBe(60);
  });
});
