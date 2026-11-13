import { checkoutSummary, istTime, signupRows, sourceCell } from './signup.source.view';
import { adminSearchMatches } from './admin.search';

const MARKETPLACES = [
  { id: 'DIRECT', label: 'Direct' },
  { id: 'API_MARKET', label: 'api.market' },
];

describe('sourceCell: the Source column on /admin/users', () => {
  it('a Claude-directory sign-up shows the referrer host, the landing path and Direct', () => {
    const cell = sourceCell(
      {
        source: 'DIRECT',
        signupSource: { label: 'claude.ai', kind: 'referral', campaign: null, landingPath: '/auth' },
      },
      MARKETPLACES
    );
    expect(cell).toMatchObject({
      primary: 'claude.ai',
      known: true,
      detail: '/auth',
      marketplace: 'Direct',
      viaMarketplace: false,
    });
    expect(cell.title).toBe('Source: claude.ai · landed on /auth · workspace: Direct');
  });

  it('an ad sign-up shows source / campaign with the landing path as the detail', () => {
    const cell = sourceCell({
      signupSource: {
        label: 'meta / hp_in_sales_23oct',
        kind: 'utm',
        campaign: 'hp_in_sales_23oct',
        landingPath: '/mcp',
      },
    });
    expect(cell.primary).toBe('meta / hp_in_sales_23oct');
    expect(cell.detail).toBe('/mcp');
    // No source field (older API): Direct.
    expect(cell.marketplace).toBe('Direct');
  });

  it('no attribution is "unknown", never "direct"', () => {
    const cell = sourceCell({ source: 'DIRECT', signupSource: null });
    expect(cell).toMatchObject({ primary: 'unknown', known: false, detail: null });
    expect(cell.title).toContain('No sign-up attribution recorded');
    expect(sourceCell(undefined).primary).toBe('unknown');
  });

  it('a marketplace workspace names its marketplace, or its id when the list lacks it', () => {
    expect(sourceCell({ source: 'API_MARKET' }, MARKETPLACES)).toMatchObject({
      marketplace: 'api.market',
      viaMarketplace: true,
    });
    expect(sourceCell({ source: 'RAPIDAPI' }, MARKETPLACES).marketplace).toBe('RAPIDAPI');
  });
});

describe('adminSearchMatches: by sign-up source', () => {
  const claudeUser = {
    id: 'u1',
    email: 'someone@example.com',
    organizations: [
      {
        organization: {
          id: 'o1',
          name: 'Workspace',
          signupSource: { label: 'claude.ai', campaign: null },
        },
      },
    ],
  };
  const adUser = {
    id: 'u2',
    email: 'ads@example.com',
    organizations: [
      {
        organization: {
          id: 'o2',
          name: 'Ads',
          signupSource: { label: 'meta / paid_social', campaign: 'hp_in_sales_23oct' },
        },
      },
    ],
  };

  it('finds users by source label or campaign', () => {
    expect(adminSearchMatches(claudeUser, 'claude.ai')).toBe(true);
    expect(adminSearchMatches(adUser, 'claude.ai')).toBe(false);
    expect(adminSearchMatches(adUser, 'paid_social')).toBe(true);
    expect(adminSearchMatches(adUser, 'HP_IN_SALES')).toBe(true);
  });

  it('a user without a source is still found by email', () => {
    expect(
      adminSearchMatches({ id: 'u3', email: 'x@y.z', organizations: [{ organization: { id: 'o3' } }] }, 'x@y')
    ).toBe(true);
  });
});

describe('the user panel: plain-words sign-up details', () => {
  const claude = {
    workspaceId: 'org-1',
    source: { label: 'claude.ai', kind: 'referral' as const, campaign: null, landingPath: '/auth' },
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    referrerHost: 'claude.ai',
    landingPath: '/auth',
    country: 'IN',
    city: null,
    device: 'desktop',
    inApp: null,
    method: 'GOOGLE_ONE_TAP',
    signedUpAt: '2026-10-27T04:49:00.000Z',
    firstChannelAt: '2026-10-27T04:49:40.000Z',
    trialStartedAt: null,
    paidAt: null,
    channels: 1,
    posts: 0,
  };

  it('istTime is IST whatever the browser zone', () => {
    expect(istTime('2026-10-27T04:49:00.000Z')).toBe('27 Oct 2026, 10:19 IST');
    expect(istTime('2026-10-26T20:00:00.000Z')).toBe('27 Oct 2026, 01:30 IST');
    expect(istTime(null)).toBeNull();
    expect(istTime('nope')).toBeNull();
  });

  it('every row the owner asked for, in order and in plain words', () => {
    const rows = Object.fromEntries(
      signupRows(claude, { checkoutsOpened: 1, currencies: ['INR'], lastOpenedAt: '2026-10-27T04:49:50.000Z', authenticated: false, payments: [] }, true)
    );
    expect(rows).toEqual({
      Source: 'claude.ai',
      'UTM (source / medium / campaign)': 'None',
      'Came from (referrer)': 'claude.ai',
      'First page': '/auth',
      Country: 'IN',
      Device: 'desktop',
      'Signed up with': 'GOOGLE_ONE_TAP',
      'Signed up at': '27 Oct 2026, 10:19 IST',
      'First channel connected': '27 Oct 2026, 10:19 IST',
      'Card or UPI added': 'No',
      Paid: 'No',
      'Channels / posts': '1 channel, 0 posts',
      'Last checkout': '27 Oct 2026, 10:19 IST — opened checkout, did not finish (INR)',
    });
  });

  it('an ad sign-up in an in-app browser with no attribution gaps', () => {
    const rows = Object.fromEntries(
      signupRows(
        {
          ...claude,
          source: { label: 'meta / hp_in_sales_23oct', kind: 'utm', campaign: 'hp_in_sales_23oct', landingPath: '/mcp' },
          utmSource: 'meta',
          utmMedium: 'paid_social',
          utmCampaign: 'hp_in_sales_23oct',
          referrerHost: null,
          device: 'mobile',
          inApp: 'facebook',
          city: 'Pune',
          firstChannelAt: null,
          channels: 0,
          posts: 2,
        },
        undefined,
        true
      )
    );
    expect(rows['UTM (source / medium / campaign)']).toBe('meta / paid_social / hp_in_sales_23oct');
    expect(rows['Came from (referrer)']).toBe('No referrer (typed in, app or bookmark)');
    expect(rows.Device).toBe('mobile, inside the facebook app');
    expect(rows.Country).toBe('IN (Pune)');
    expect(rows['First channel connected']).toBe('Never');
    expect(rows['Channels / posts']).toBe('0 channels, 2 posts');
    expect(rows['Last checkout']).toBe('Never opened checkout');
  });

  it('no attribution at all says unknown, not direct', () => {
    const rows = Object.fromEntries(
      signupRows({ ...claude, source: null, referrerHost: null, landingPath: null, device: null, method: null, country: null }, undefined, false)
    );
    expect(rows.Source).toBe('Unknown (no attribution recorded)');
    expect(rows['First page']).toBe('Not recorded');
    expect(rows.Device).toBe('Not recorded');
    expect(rows['Last checkout']).toBe('Not known (Razorpay not read)');
  });

  it('checkout results: failed charge, trial started, paid', () => {
    const base = { checkoutsOpened: 1, currencies: ['INR'], lastOpenedAt: '2026-10-23T15:06:00.000Z', authenticated: true, payments: [] as any[] };
    expect(
      checkoutSummary(
        {
          ...base,
          pastDue: true,
          payments: [
            { status: 'refunded', amount: 5, currency: 'INR', at: '2026-10-23T15:07:00.000Z', error: null },
            { status: 'failed', amount: 599, currency: 'INR', at: '2026-10-25T15:21:00.000Z', error: 'Insufficient balance' },
          ],
        },
        true
      )
    ).toBe('25 Oct 2026, 20:51 IST — payment of ₹599 failed: Insufficient balance (INR)');
    expect(
      checkoutSummary(
        { ...base, payments: [{ status: 'refunded', amount: 5, currency: 'INR', at: '2026-10-23T15:07:00.000Z', error: null }] },
        true
      )
    ).toBe('23 Oct 2026, 20:37 IST — card/UPI check of ₹5 passed and was refunded (card or UPI added) (INR)');
    expect(checkoutSummary({ ...base, payments: [] }, true)).toBe('23 Oct 2026, 20:36 IST — card or UPI added (INR)');
    expect(
      checkoutSummary(
        { ...base, checkoutsOpened: 2, currencies: ['USD'], payments: [{ status: 'captured', amount: 19, currency: 'USD', at: '2026-10-30T10:00:00.000Z', error: null }] },
        true
      )
    ).toBe('30 Oct 2026, 15:30 IST — paid $19 (USD) · 2 checkouts');
  });
});
