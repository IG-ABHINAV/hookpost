/**
 * The marketing copy switch (PR-3 of local-assets/trial-usd-plan-2026-10-18.md):
 * the same cutoffs and the same strict parse as the backend's gate, any valid
 * value (past or future) means the free-posts copy (the "trial" branch of
 * offer()), anything else the Free copy.
 *   pnpm exec jest -c apps/frontend/jest.config.ts trial-offer
 */
import fs from 'fs';
import path from 'path';
import { FREE_POST_LIMIT } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

type Offer = typeof import('./trial-offer');

const KEYS = [
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'USD_CHECKOUT',
  'GST_LUT_ARN',
  'TRIAL_CHECKOUT',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** trial-offer.ts as a fresh build would evaluate it with these values. */
function load(env: Partial<Record<(typeof KEYS)[number], string>>): Offer {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let mod!: Offer;
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.isolateModules(() => {
    mod = require('./trial-offer');
  });
  error.mockRestore();
  return mod;
}

describe('which copy a build gets', () => {
  it.each([
    ['unset', {}],
    ['empty', { TRIAL_REQUIRED_SINCE_IN: '', TRIAL_REQUIRED_SINCE_GLOBAL: '' }],
    ['not a timestamp', { TRIAL_REQUIRED_SINCE_IN: 'yes' }],
    ['a date that does not exist', { TRIAL_REQUIRED_SINCE_IN: '2026-13-01T00:00:00Z' }],
    ['before the floor', { TRIAL_REQUIRED_SINCE_IN: '2026-01-01T00:00:00Z' }],
    ['a local time, not UTC', { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T11:00:00+05:30' }],
    // GLOBAL only counts while the dollar checkout sells, as on the backend.
    ['global only, dollars not sold', { TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z' }],
    [
      'global only, USD on without an LUT',
      { TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z', USD_CHECKOUT: 'on' },
    ],
  ])('%s: the Free copy, exactly as before PR-3', (_name, env) => {
    const o = load(env);
    expect(o.TRIAL_ONLY).toBe(false);
    expect(o.offer('free', 'trial')).toBe('free');
    expect(o.LANDING_TIERS).toEqual(['FREE', 'HOOKPOST']);
    expect(o.trialTermsDate('day-month')).toBe('');
  });

  it.each([
    ['India, in the past', { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z' }],
    // Copy first: a cutoff still ahead already switches the pages, so they
    // stop offering Free before the first new workspace is gated.
    ['India, in the future', { TRIAL_REQUIRED_SINCE_IN: '2030-01-01T00:00:00Z' }],
    [
      'global only, dollars sold',
      {
        TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z',
        USD_CHECKOUT: 'on',
        GST_LUT_ARN: 'AD0910260000000',
      },
    ],
    ['with +00:00', { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00+00:00' }],
  ])('%s: the trial copy', (_name, env) => {
    const o = load(env);
    expect(o.TRIAL_ONLY).toBe(true);
    expect(o.offer('free', 'trial')).toBe('trial');
    expect(o.LANDING_TIERS).toEqual(['HOOKPOST']);
  });
});

describe('the free-posts wording', () => {
  // The "trial" names are kept (about 90 files import them) but there is no time
  // trial for new users: 3 free posts with no card, then the one paid plan at its
  // flat monthly price (no first-month discount since 8 Nov 2026, the owner's call).
  it('is the canonical sentence, word for word, built from the constants: $7, no rupee figure', () => {
    const o = load({ TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z' });
    expect(FREE_POST_LIMIT).toBe(3);
    expect(o.TRIAL_SENTENCE).toBe(`3 free posts, no card needed. Then $${HOOKPOST_PRICE.displayUsd}/month.`);
    expect(o.TRIAL_SENTENCE).not.toMatch(/₹/);
    expect(o.TRIAL_SENTENCE_IN).toBe(o.TRIAL_SENTENCE);
    expect(o.TRIAL_SENTENCE).toBe(
      `${FREE_POST_LIMIT} free posts, no card needed. Then ${o.TRIAL_PRICE_AFTER}/month.`
    );
    expect(o.TRIAL_PRICE_AFTER).toBe(`$${HOOKPOST_PRICE.displayUsd}`);
    expect(o.TRIAL_ROW).toBe('3 free posts, no card needed');
    expect(o.TRIAL_CTA).toBe('Get 3 free posts');
    expect(o.FREE_POSTS).toBe('3 free posts');
    expect((o as Record<string, unknown>).FIRST_MONTH_OFFER).toBeUndefined();
    // no trial wording in public copy (owner, 9 Nov 2026)
    expect(o.TRIAL_FAQ_ANSWER).toBe(o.TRIAL_SENTENCE);
  });

  it('with dollars sold (USD_CHECKOUT on, LUT set), still one sentence: $7, no second rail, no discount', () => {
    const o = load({
      TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z',
      TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z',
      USD_CHECKOUT: 'on',
      GST_LUT_ARN: 'AD0910260000000',
    });
    expect(o.TRIAL_SENTENCE).toBe('3 free posts, no card needed. Then $7/month.');
    expect(o.TRIAL_SENTENCE_IN).toBe(o.TRIAL_SENTENCE);
    // The price is HOOKPOST_PRICE's, and there is no discount or rupee figure anywhere.
    expect(o.TRIAL_SENTENCE).toContain(`$${HOOKPOST_PRICE.displayUsd}/month`);
    expect(o.TRIAL_SENTENCE).not.toMatch(/% off|first month|₹|in India|elsewhere/i);
  });

  it('promises no time trial, no card step and no old length', () => {
    for (const env of [
      { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z' },
      {
        TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T05:30:00Z',
        USD_CHECKOUT: 'on',
        GST_LUT_ARN: 'AD0910260000000',
      },
    ]) {
      const o = load(env);
      for (const text of [o.TRIAL_SENTENCE, o.TRIAL_SENTENCE_IN, o.TRIAL_ROW, o.TRIAL_CTA, o.TRIAL_FAQ_ANSWER]) {
        expect(text).not.toMatch(/-day|day trial|days|₹0 today|AutoPay|24 hours/i);
      }
    }
  });

  it('dates the legal pages from the 28 Oct change to free posts, or a later cutoff, in India', () => {
    // The live cutoffs (19 and 20 Oct) predate the change to free posts.
    const o = load({
      TRIAL_REQUIRED_SINCE_IN: '2026-10-19T00:00:00Z',
      TRIAL_REQUIRED_SINCE_GLOBAL: '2026-10-20T17:35:00Z',
      USD_CHECKOUT: 'on',
      GST_LUT_ARN: 'AD0910260000000',
    });
    expect(o.trialTermsDate('day-month')).toBe('28 October 2026');
    expect(o.trialTermsDate('month-day')).toBe('October 28, 2026');
    // A first cutoff after that is the date; 20:00 UTC on 30 Nov is 1 Dec in India.
    const later = load({ TRIAL_REQUIRED_SINCE_IN: '2026-11-30T20:00:00Z' });
    expect(later.trialTermsDate('day-month')).toBe('1 December 2026');
  });

  it('passes the free-claims check it is written for, and the check still bites on a Free plan', () => {
    const o = load({ TRIAL_REQUIRED_SINCE_IN: '2026-10-20T05:30:00Z' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkText, loadAllow } = require('../../../../../scripts/check-free-claims.js');
    expect(
      checkText(
        'copy',
        [o.TRIAL_SENTENCE, o.TRIAL_ROW, o.TRIAL_CTA, o.TRIAL_FAQ_ANSWER],
        loadAllow()
      )
    ).toEqual([]);
    expect(
      checkText('copy', ['Free plan: 2 channels and 30 posts a month, no card needed.'], loadAllow())
    ).not.toEqual([]);
  });
});

describe('the trial switch (TRIAL_CHECKOUT) at build time', () => {
  const CUT = { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T00:00:00Z' };

  it('off (production): the free posts, then the flat monthly price, and no time-limited trial', () => {
    for (const off of [{}, { TRIAL_CHECKOUT: 'off' }, { TRIAL_CHECKOUT: '' }]) {
      const o = load({ ...CUT, ...off });
      expect(o.TRIAL_AFTER_FREE_POSTS).toBe(false);
      expect(o.TRIAL_SENTENCE_IN).toBe(`${FREE_POST_LIMIT} free posts, no card needed. Then ${o.TRIAL_PRICE_AFTER}/month.`);
      expect(o.TRIAL_SENTENCE_IN).not.toMatch(/% off|first month/i);
      expect(o.TRIAL_FAQ_ANSWER).toBe(o.TRIAL_SENTENCE);
      expect(o.TRIAL_FAQ_ANSWER).not.toMatch(/trial/i);
      expect(o.FIRST_PAYMENT_WHEN).toBe('The first payment is taken at checkout once you choose a plan.');
      expect(o.NO_TIME_TRIAL).toBe('');
    }
  });

  it('on: the free posts, then the card or UPI trial of TRIAL_DAYS; no first-month offer, no "no trial"', () => {
    const o = load({ ...CUT, TRIAL_CHECKOUT: 'on' });
    expect(o.TRIAL_AFTER_FREE_POSTS).toBe(true);
    expect(o.TRIAL_SENTENCE_IN).toBe(
      `${FREE_POST_LIMIT} free posts, no card needed. Then a ${o.TRIAL_DAYS}-day trial on your card or UPI: nothing is charged until it ends, cancel any time before.`
    );
    for (const text of [o.TRIAL_SENTENCE_IN, o.TRIAL_SENTENCE, o.TRIAL_FAQ_ANSWER, o.FIRST_PAYMENT_WHEN]) {
      expect(text).not.toMatch(/% off|no time-limited trial|taken at checkout/);
    }
    expect(o.TRIAL_FAQ_ANSWER).toMatch(/^Yes, after your free posts\. /);
    expect(o.NO_TIME_TRIAL).toBe('');
  });

  it('on, with dollars sold too: one sentence for everyone', () => {
    const o = load({ ...CUT, TRIAL_CHECKOUT: 'on', USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0910260000000' });
    expect(o.TRIAL_SENTENCE).toBe(o.TRIAL_SENTENCE_IN);
    expect(o.TRIAL_SENTENCE).not.toMatch(/% off/);
  });
});

describe('no page aimed at new users says "N-day trial"', () => {
  // TRIAL_DAYS is the length of the trial that workspaces already on one keep.
  // It may still be printed by: the legal pages (they govern those trials), the
  // Free-plan branch of /pricing's FAQ (the copy for a
  // build with no cutoff, where a paid plan still starts with a trial), and the
  // trial helpers themselves.
  const ROOT = path.resolve(__dirname, '..');
  const ALLOWED = [
    'terms/page.tsx',
    'refund-policy/page.tsx',
    'cancellation-policy/page.tsx',
    'pricing/page.tsx',
    // Comments only: what the demo video's cut says.
    'hero-demo.ts',
    'hero-demo.facts.ts',
    '(landing)/trial-offer.ts',
  ].map((f) => f.replace(/\//g, path.sep));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.spec\./.test(e.name)) files.push(full);
    }
  };
  walk(ROOT);

  it('only the allowed files read TRIAL_DAYS', () => {
    const readers = files
      .filter((f) => /\bTRIAL_DAYS\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f))
      .filter((f) => !ALLOWED.some((a) => f.endsWith(a)));
    expect(readers).toEqual([]);
  });

  it('no file types a Hookpost "3-day trial" by hand, except the notes on what the demo video says', () => {
    const typed = files.flatMap((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${path.relative(ROOT, f)}:${i + 1}` }))
        .filter(
          ({ line }) =>
            /\b3[- ]day (free )?trial\b/i.test(line) &&
            // Another vendor's trial, named on the same line.
            !/predis|Buffer|Hootsuite|Later|Planoly|Sprout|Agorapulse|SocialPilot|Postiz|Mixpost|Metricool|Publer/i.test(line)
        )
        .map(({ line, at }) => `${at}: ${line.trim().slice(0, 100)}`)
    );
    // Comments recording the cut's own words (hero-demo.ts, hero-demo.facts.ts).
    // The homepage, its transcript and its VideoObject print no trial.
    expect(typed.filter((t) => !/^\(landing\)[\\/]hero-demo(\.facts)?\.ts:/.test(t))).toEqual([]);
  });
});

describe('client components never read the cutoff', () => {
  // In the browser process.env.TRIAL_REQUIRED_* is undefined, so a client
  // component importing trial-offer.ts would hydrate back to the Free copy.
  // They take the copy as props from a server wrapper instead.
  const SRC = path.resolve(__dirname, '../..');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.spec\./.test(e.name)) files.push(full);
    }
  };
  walk(SRC);

  it('no "use client" module imports trial-offer, usd-offer or the llms module', () => {
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(f, 'utf8');
      return (
        /^\s*['"]use client['"]/.test(text) &&
        /from\s+['"][^'"]*(trial-offer|usd-offer|\/llms\/llms)['"]/.test(text)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('the nav and the pricing cards are server wrappers around client parts', () => {
    const nav = fs.readFileSync(path.join(__dirname, 'site-nav.tsx'), 'utf8');
    const cards = fs.readFileSync(path.join(__dirname, 'PricingPlans.tsx'), 'utf8');
    expect(nav).not.toMatch(/use client/);
    expect(cards).not.toMatch(/use client/);
    expect(nav).toMatch(/from '\.\/trial-offer'/);
    expect(cards).toMatch(/from '\.\/trial-offer'/);
  });
});
