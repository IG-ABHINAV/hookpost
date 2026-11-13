import {
  buildPricingContext,
  currencyCountry,
  currencyNeedsSubject,
  decideCheckoutCurrency,
  entitlementLocks,
  headerValue,
  onUsdAllowlist,
  resetUsdCheckoutWarnings,
  resolveRegion,
  trustedCountry,
  usdCheckoutMode,
  usdOnForEveryone,
} from '@hookpost/nestjs-libraries/services/billing.currency';
import { pricingINR, pricingUSD } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// The pure rules behind /pricing-context and checkout (PR-4 of
// local-assets/trial-usd-plan-2026-10-18.md). No Nest, no Razorpay.

const NOW = new Date('2026-10-12T06:00:00Z');
const DAY = 86400 * 1000;
const LUT = 'AD0910260000000';
const quiet = () => undefined;

beforeEach(() => resetUsdCheckoutWarnings());

describe('trustedCountry: cf-ipcountry only', () => {
  it('reads the Cloudflare header', () => {
    expect(trustedCountry({ 'cf-ipcountry': 'IN' })).toBe('IN');
    expect(trustedCountry({ 'cf-ipcountry': 'us' })).toBe('US');
  });

  it.each(['XX', 'T1', 'xx', '', '   ', 'USA', '1N'])(
    'treats %p as missing',
    (value) => {
      expect(trustedCountry({ 'cf-ipcountry': value })).toBeNull();
    }
  );

  it('never reads x-country, which the client controls', () => {
    expect(trustedCountry({ 'x-country': 'IN' })).toBeNull();
    expect(trustedCountry({ 'x-country': 'IN', 'cf-ipcountry': 'US' })).toBe('US');
    expect(trustedCountry({ 'x-country': 'US', 'cf-ipcountry': 'XX' })).toBeNull();
  });

  it('copes with a repeated header and no headers at all', () => {
    expect(trustedCountry({ 'cf-ipcountry': ['IN', 'US'] })).toBe('IN');
    expect(trustedCountry(undefined)).toBeNull();
  });

  it('headerValue keeps the sign-up geo behaviour auth.middleware relied on', () => {
    expect(headerValue({ 'cf-ipcity': 'New%20Delhi' }, 'cf-ipcity')).toBe('New Delhi');
    expect(headerValue({ 'cf-ipcity': '%E0%A4' }, 'cf-ipcity')).toBe('%E0%A4');
    expect(headerValue({ 'cf-region': 'x'.repeat(200) }, 'cf-region')).toHaveLength(80);
    expect(headerValue({ 'cf-ipcountry': 'T1' }, 'cf-ipcountry')).toBeUndefined();
  });
});

describe('resolveRegion', () => {
  it('reports each signal separately', () => {
    expect(resolveRegion({ 'cf-ipcountry': 'IN' }, 'America/New_York')).toEqual({
      country: 'IN',
      ipSaysIndia: true,
      tzSaysIndia: false,
    });
    expect(resolveRegion({ 'cf-ipcountry': 'US' }, 'Asia/Kolkata')).toEqual({
      country: 'US',
      ipSaysIndia: false,
      tzSaysIndia: true,
    });
    expect(resolveRegion({}, 'Asia/Calcutta').tzSaysIndia).toBe(true);
    expect(resolveRegion({ 'cf-ipcountry': 'XX' }, '')).toEqual({
      country: null,
      ipSaysIndia: false,
      tzSaysIndia: false,
    });
  });

  it('ignores a timezone that is not a string', () => {
    expect(resolveRegion({}, ['Asia/Kolkata']).tzSaysIndia).toBe(false);
    expect(resolveRegion({}, { tz: 'Asia/Kolkata' }).tzSaysIndia).toBe(false);
  });
});

describe('currencyCountry: the creator first, then any sign of India', () => {
  it.each([
    // owner, request, tz, expected
    ['US', 'IN', 'Asia/Kolkata', 'US'], // the creator's signup country wins
    ['IN', 'US', 'America/New_York', 'IN'], // an Indian owner abroad keeps rupees
    [null, 'US', 'Asia/Kolkata', 'IN'], // a VPN moves the IP, not the clock
    [null, 'IN', 'America/New_York', 'IN'],
    [null, 'DE', 'Europe/Berlin', 'DE'],
    [null, null, 'Europe/Berlin', null],
    [null, 'XX', '', null],
    ['T1', 'GB', '', 'GB'], // a meaningless owner country is no country
    ['xx', null, 'Asia/Calcutta', 'IN'],
  ])('owner %p, request %p, tz %p -> %p', (owner, request, tz, expected) => {
    expect(
      currencyCountry({ ownerCountry: owner, requestCountry: request, tz })
    ).toBe(expected);
  });
});

describe('usdCheckoutMode: off unless exactly allowlist or on', () => {
  it.each([
    [{}, 'off'],
    [{ USD_CHECKOUT: '' }, 'off'],
    [{ USD_CHECKOUT: 'off' }, 'off'],
    [{ USD_CHECKOUT: 'true' }, 'off'],
    [{ USD_CHECKOUT: 'usd' }, 'off'],
    [{ USD_CHECKOUT: ' On ' }, 'on'],
    [{ USD_CHECKOUT: 'ALLOWLIST' }, 'allowlist'],
    // The switch it replaced is not read at all.
    [{ INTL_CHECKOUT: 'usd', GST_LUT_ARN: LUT }, 'off'],
  ])('%p -> %p', (env, mode) => {
    expect(usdCheckoutMode(env as any, quiet)).toBe(mode);
  });

  it('warns once about an unknown value and once about INTL_CHECKOUT', () => {
    const warn = jest.fn();
    usdCheckoutMode({ USD_CHECKOUT: 'yes' }, warn);
    usdCheckoutMode({ USD_CHECKOUT: 'yes' }, warn);
    usdCheckoutMode({ INTL_CHECKOUT: 'usd' }, warn);
    usdCheckoutMode({ INTL_CHECKOUT: 'usd' }, warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('treating it as off');
    expect(warn.mock.calls[1][0]).toContain('INTL_CHECKOUT is no longer read');
  });

  it('on sells dollars only with an LUT, and says so once', () => {
    const warn = jest.fn();
    expect(usdOnForEveryone({ USD_CHECKOUT: 'on' }, warn)).toBe(false);
    expect(usdOnForEveryone({ USD_CHECKOUT: 'on', GST_LUT_ARN: '  ' }, warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('GST_LUT_ARN');
    expect(usdOnForEveryone({ USD_CHECKOUT: 'on', GST_LUT_ARN: LUT }, warn)).toBe(true);
    expect(usdOnForEveryone({ USD_CHECKOUT: 'allowlist', GST_LUT_ARN: LUT }, warn)).toBe(false);
  });

  it('reads process.env at call time, not at import', () => {
    const saved = { ...process.env };
    try {
      delete process.env.USD_CHECKOUT;
      expect(usdCheckoutMode(undefined, quiet)).toBe('off');
      process.env.USD_CHECKOUT = 'allowlist';
      expect(usdCheckoutMode(undefined, quiet)).toBe('allowlist');
      process.env.USD_CHECKOUT = '';
      expect(usdCheckoutMode(undefined, quiet)).toBe('off');
    } finally {
      process.env = saved;
    }
  });

  it('only reads who the workspace is when the switch can use it', () => {
    expect(currencyNeedsSubject({})).toBe(false);
    expect(currencyNeedsSubject({ USD_CHECKOUT: 'allowlist' })).toBe(false); // empty list
    expect(currencyNeedsSubject({ USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co' })).toBe(true);
    expect(currencyNeedsSubject({ USD_CHECKOUT: 'on' })).toBe(true);
  });
});

describe('USD_ALLOWLIST', () => {
  const env = { USD_ALLOWLIST: ' Card.Holder@Example.com, org-us-1;\norg-uk-2 ' };

  it('matches the workspace id or its creator email, any case, any separator', () => {
    expect(onUsdAllowlist({ country: null, ownerEmail: 'card.holder@example.COM' }, env)).toBe(true);
    expect(onUsdAllowlist({ country: null, orgId: 'org-us-1' }, env)).toBe(true);
    expect(onUsdAllowlist({ country: null, orgId: 'ORG-UK-2' }, env)).toBe(true);
    expect(onUsdAllowlist({ country: null, orgId: 'org-other', ownerEmail: 'x@y.z' }, env)).toBe(false);
    expect(onUsdAllowlist({ country: null }, env)).toBe(false);
    expect(onUsdAllowlist({ country: null, ownerEmail: '' }, { USD_ALLOWLIST: ' , ' })).toBe(false);
  });
});

/**
 * The plan's matrix: USD_CHECKOUT off, allowlist and on; the country IN, US,
 * DE or unknown; no plan, a live INR plan or a live USD plan; the LUT set or
 * not. The allowlisted workspace is the one in each allowlist row.
 */
describe('decideCheckoutCurrency: the matrix', () => {
  type Mode = 'off' | 'allowlist' | 'on';
  type Lock = null | 'INR' | 'USD';
  const MODES: Mode[] = ['off', 'allowlist', 'on'];
  const COUNTRIES: (string | null)[] = ['IN', 'US', 'DE', null];
  const LOCKS: Lock[] = [null, 'INR', 'USD'];
  const LUTS = [true, false];

  /** What the plan's rules say, written out independently of the code. */
  function expected(mode: Mode, country: string | null, lock: Lock, lut: boolean, excludeDE: boolean) {
    if (lock) return lock; // 1. the live plan
    if (mode === 'allowlist') return 'USD'; // 2. allowlisted, whatever the geo
    if (country === 'IN') return 'INR'; // 3. India
    if (mode === 'on' && lut && !(excludeDE && country === 'DE')) return 'USD'; // 4.
    return 'INR'; // 5.
  }

  const cases: Array<[Mode, string | null, Lock, boolean, boolean]> = [];
  for (const mode of MODES)
    for (const country of COUNTRIES)
      for (const lock of LOCKS)
        for (const lut of LUTS)
          for (const excludeDE of [false, true]) cases.push([mode, country, lock, lut, excludeDE]);

  it.each(cases)(
    'mode %p, country %p, live plan %p, LUT %p, DE excluded %p',
    (mode, country, lock, lut, excludeDE) => {
      const env: Record<string, string> = {
        USD_CHECKOUT: mode,
        USD_ALLOWLIST: 'owner@abroad.example',
        ...(lut ? { GST_LUT_ARN: LUT } : {}),
        ...(excludeDE ? { USD_EXCLUDED_COUNTRIES: 'EU27, GB' } : {}),
      };
      const decision = decideCheckoutCurrency({
        lockedCurrency: lock,
        subject: { orgId: 'org-1', ownerEmail: 'owner@abroad.example', country },
        env,
        warn: quiet,
      });
      expect(decision.chargeCurrency).toBe(expected(mode, country, lock, lut, excludeDE));
      expect(decision.allowed).toBe(true);
      expect(decision.lockedCurrency).toBe(lock);
    }
  );

  it('a workspace not on the allowlist follows its country in allowlist mode', () => {
    const env = { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'someone@else.example', GST_LUT_ARN: LUT };
    for (const country of ['IN', 'US', 'DE', null]) {
      expect(
        decideCheckoutCurrency({
          subject: { orgId: 'org-1', ownerEmail: 'owner@abroad.example', country },
          env,
          warn: quiet,
        })
      ).toMatchObject({ chargeCurrency: 'INR', reason: country === 'IN' ? 'india' : 'default' });
    }
  });

  it('shipped as it is (nothing set), everyone is charged rupees', () => {
    for (const country of ['IN', 'US', 'DE', 'GB', null]) {
      expect(
        decideCheckoutCurrency({ subject: { country }, env: {}, warn: quiet })
      ).toEqual({ chargeCurrency: 'INR', lockedCurrency: null, allowed: true, reason: country === 'IN' ? 'india' : 'default' });
    }
  });

  it('says why', () => {
    const on = { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT };
    expect(decideCheckoutCurrency({ lockedCurrency: 'inr', env: on, warn: quiet }).reason).toBe('plan');
    expect(decideCheckoutCurrency({ subject: { country: 'IN' }, env: on, warn: quiet }).reason).toBe('india');
    expect(decideCheckoutCurrency({ subject: { country: 'US' }, env: on, warn: quiet }).reason).toBe('usd');
    expect(
      decideCheckoutCurrency({
        subject: { country: 'IN', ownerEmail: 'a@b.co' },
        env: { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co' },
        warn: quiet,
      }).reason
    ).toBe('allowlist');
  });

  it('an INR plan being retried keeps the workspace on rupees; a USD one does not pin dollars', () => {
    const on = { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT };
    expect(
      decideCheckoutCurrency({ dunningCurrency: 'INR', subject: { country: 'US' }, env: on, warn: quiet })
    ).toMatchObject({ chargeCurrency: 'INR', lockedCurrency: null, reason: 'plan' });
    expect(
      decideCheckoutCurrency({ dunningCurrency: 'USD', subject: { country: 'IN' }, env: on, warn: quiet })
    ).toMatchObject({ chargeCurrency: 'INR', reason: 'india' });
  });

  it('a live plan in a currency no checkout sells is shown and refused', () => {
    expect(decideCheckoutCurrency({ lockedCurrency: 'EUR', env: {}, warn: quiet })).toEqual({
      chargeCurrency: 'EUR',
      lockedCurrency: 'EUR',
      allowed: false,
      reason: 'plan',
    });
  });

  it('accepts the CA-style group names in USD_EXCLUDED_COUNTRIES', () => {
    const env = { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT, USD_EXCLUDED_COUNTRIES: 'eea uk' };
    for (const country of ['NO', 'IS', 'FR', 'GR', 'GB']) {
      expect(decideCheckoutCurrency({ subject: { country }, env, warn: quiet }).chargeCurrency).toBe('INR');
    }
    for (const country of ['US', 'CA', 'AU', 'CH']) {
      expect(decideCheckoutCurrency({ subject: { country }, env, warn: quiet }).chargeCurrency).toBe('USD');
    }
  });
});

describe('entitlementLocks: what holds an org to its plan currency', () => {
  const row = (extra: any = {}) => ({
    identifier: 'sub_live',
    isLifetime: false,
    deletedAt: null,
    cancelAt: null,
    ...extra,
  });

  it.each(['active', 'authenticated'])('%s locks', (status) => {
    expect(entitlementLocks({ row: row(), remoteStatus: status, now: NOW })).toBe(true);
  });

  it.each(['halted', 'pending', 'created', 'cancelled', 'expired', 'completed', null])(
    '%p does not lock on its own',
    (status) => {
      expect(entitlementLocks({ row: row(), remoteStatus: status, now: NOW })).toBe(false);
    }
  );

  it('a cancellation scheduled for the future locks until that date', () => {
    const future = row({ cancelAt: new Date(NOW.getTime() + 5 * DAY) });
    expect(entitlementLocks({ row: future, remoteStatus: 'cancelled', now: NOW })).toBe(true);
    // cancelAt arrives as an ISO string from JSON too
    const asString = row({ cancelAt: new Date(NOW.getTime() + DAY).toISOString() });
    expect(entitlementLocks({ row: asString, remoteStatus: 'halted', now: NOW })).toBe(true);
  });

  it('a cancellation already past does not lock', () => {
    const past = row({ cancelAt: new Date(NOW.getTime() - DAY) });
    expect(entitlementLocks({ row: past, remoteStatus: 'cancelled', now: NOW })).toBe(false);
  });

  it('no row, a deleted row, a lifetime plan or no identifier never lock', () => {
    expect(entitlementLocks({ row: null, remoteStatus: 'active', now: NOW })).toBe(false);
    expect(entitlementLocks({ row: row({ deletedAt: NOW }), remoteStatus: 'active', now: NOW })).toBe(false);
    expect(entitlementLocks({ row: row({ isLifetime: true }), remoteStatus: 'active', now: NOW })).toBe(false);
    expect(entitlementLocks({ row: row({ identifier: null }), remoteStatus: 'active', now: NOW })).toBe(false);
  });
});

describe('buildPricingContext: what is shown is what is charged', () => {
  const region = resolveRegion({ 'cf-ipcountry': 'US' }, 'America/New_York');

  it('rupees: the INR list prices', () => {
    const ctx = buildPricingContext({
      decision: decideCheckoutCurrency({ subject: { country: 'US' }, env: {}, warn: quiet }),
      region,
    });
    expect(ctx).toEqual({
      displayCurrency: 'INR',
      chargeCurrency: 'INR',
      lockedCurrency: null,
      checkoutAllowed: true,
      region: { country: 'US', ipSaysIndia: false, tzSaysIndia: false },
      prices: {
        STANDARD: { month: 599, year: 5990 },
        PRO: { month: 1999, year: 19990 },
        HOOKPOST: { month: 699, year: 0 },
      },
    });
  });

  it('dollars: $19 and $29 a month, $190 and $290 a year', () => {
    const ctx = buildPricingContext({
      decision: decideCheckoutCurrency({
        subject: { country: 'US' },
        env: { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT },
        warn: quiet,
      }),
      region,
    });
    expect(ctx.displayCurrency).toBe('USD');
    expect(ctx.chargeCurrency).toBe('USD');
    expect(ctx.prices).toEqual({
      STANDARD: { month: 19, year: 190 },
      PRO: { month: 29, year: 290 },
      HOOKPOST: { month: 7, year: 0 },
    });
  });

  it('display always equals charge, and prices are always that currency\'s table', () => {
    const envs = [
      {},
      { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co' },
      { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT },
      { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT, USD_EXCLUDED_COUNTRIES: 'DE' },
    ];
    for (const env of envs)
      for (const country of ['IN', 'US', 'DE', null])
        for (const lock of [null, 'INR', 'USD'])
          for (const email of ['a@b.co', 'c@d.co']) {
            const decision = decideCheckoutCurrency({
              lockedCurrency: lock,
              subject: { country, ownerEmail: email },
              env,
              warn: quiet,
            });
            const ctx = buildPricingContext({ decision, region });
            const table = ctx.chargeCurrency === 'USD' ? pricingUSD : pricingINR;
            expect(ctx.displayCurrency).toBe(decision.chargeCurrency);
            expect(ctx.chargeCurrency).toBe(decision.chargeCurrency);
            expect(ctx.prices.STANDARD.month).toBe(table.STANDARD.month_price);
            expect(ctx.prices.PRO.year).toBe(table.PRO.year_price);
          }
  });

  it('a refused legacy currency says so', () => {
    const ctx = buildPricingContext({
      decision: decideCheckoutCurrency({ lockedCurrency: 'EUR', env: {}, warn: quiet }),
      region,
    });
    expect(ctx).toMatchObject({ chargeCurrency: 'EUR', lockedCurrency: 'EUR', checkoutAllowed: false });
  });

  it('never quotes a retired tier', () => {
    const ctx = buildPricingContext({
      decision: decideCheckoutCurrency({ env: {}, warn: quiet }),
      region: resolveRegion({}, ''),
    });
    expect(Object.keys(ctx.prices).sort()).toEqual(['HOOKPOST', 'PRO', 'STANDARD']);
  });
});
