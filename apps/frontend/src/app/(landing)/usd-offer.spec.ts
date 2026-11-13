/**
 * There is no separate dollar rail on the pages any more (the owner, 8 Nov
 * 2026): the one plan shows as $7 to every visitor, India included, and every
 * purchase is charged on one INR plan. Whatever USD_CHECKOUT and GST_LUT_ARN
 * say, USD_MARKETED stays false, the structured data carries no second offer
 * list, and no page prints a rupee price for the plan.
 *   pnpm exec jest -c apps/frontend/jest.config.ts usd-offer
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
// The nav and the plan cards are client components with their own specs;
// rendered here they would only add noise to the page text.
jest.mock('./site-nav', () => ({ SiteNav: () => null }));
jest.mock('./PricingPlans', () => ({ PricingPlans: () => null }));
jest.mock('@hookpost/frontend/components/billing/holiday.offer.banner', () => ({
  HolidayOfferStrip: () => null,
  FestivalPill: () => null,
  HeroGlow: () => null,
  useFestiveCard: () => ({ cardClass: '', cardStyle: undefined, decoration: null }),
}));

import { PricingPlansClient } from './PricingPlans.client';
import {
  AI_CREDIT_COST,
  HOOKPOST_PRICE,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  authorisationNote,
  trialButtonLabel,
} from '@hookpost/frontend/components/billing/razorpay.billing';
import {
  CHARGE_CURRENCY_NOTE,
  PricingContext,
  paymentMethodsFor,
} from '@hookpost/frontend/components/billing/use.pricing.context';

type UsdOffer = typeof import('./usd-offer');

const KEYS = [
  'USD_CHECKOUT',
  'GST_LUT_ARN',
  'USD_EXCLUDED_COUNTRIES',
  'USD_ALLOWLIST',
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** usd-offer.ts as a fresh build would evaluate it with these values. */
function load(env: Partial<Record<(typeof KEYS)[number], string>>): UsdOffer {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let mod!: UsdOffer;
  jest.isolateModules(() => {
    mod = require('./usd-offer');
  });
  return mod;
}

const LUT = 'AD0910260000000';

describe('which build sells dollars', () => {
  it.each([
    ['unset', {}],
    ['off', { USD_CHECKOUT: 'off', GST_LUT_ARN: LUT }],
    ['on without an LUT', { USD_CHECKOUT: 'on' }],
    ['allowlist', { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co', GST_LUT_ARN: LUT }],
    // The backend switches no longer reach the pages: one price for everyone.
    ['on with an LUT', { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT, USD_EXCLUDED_COUNTRIES: 'GB, FR' }],
  ])('%s: no separate dollar rail marketed, nothing added', (_label, env) => {
    const o = load(env);
    expect(o.USD_MARKETED).toBe(false);
    expect(o.usdOffers(['FREE', 'HOOKPOST'])).toEqual([]);
    expect(o.usdAggregateOffer(['HOOKPOST'], 'u', () => '')).toBeNull();
    expect(o.usdCopy('rupees', 'both')).toBe('rupees');
  });

  it.each([
    ['off', {}],
    ['USD_CHECKOUT on with an LUT', { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT }],
  ])('plan prices in page copy are $7 alone, no rupee figure (%s)', (_label, env) => {
    const o = load(env);
    const shown = `$${HOOKPOST_PRICE.displayUsd}`;
    expect(o.HOOKPOST_DISPLAY_PRICE).toBe(shown);
    expect(o.planPrice('HOOKPOST', ' a month')).toBe(`${shown} a month`);
    expect(o.planPrice('HOOKPOST', '/mo')).toBe(`${shown}/mo`);
    expect(o.planPrice()).toBe(shown);
    expect(o.USD_HOOKPOST_MONTH).toBe(shown);
    expect(o.planPriceInParens('HOOKPOST', ' a month')).toBe(`${shown} a month`);
    expect(o.planPriceInParens()).toBe(shown);
    // One plan, billed monthly only: no yearly price exists to print.
    expect(Object.keys(o)).not.toEqual(expect.arrayContaining(['USD_STANDARD_YEAR']));
    for (const text of [o.planPrice(), o.planPriceInParens(), o.BILLED]) {
      expect(text).not.toMatch(/₹|\bin India\b/);
    }
    // Every purchase is charged in INR at checkout; the pages say so.
    expect(o.BILLED).toBe('charged in Indian rupees (INR) at checkout, by UPI, cards or NetBanking');
    expect(o.BILLED).not.toMatch(/US dollars|by card, or/);
  });

  it('the metered allowances read from pricing.ts: AI credits and X posts', () => {
    const o = load({});
    expect(o.HOOKPOST_AI_CREDITS).toBe(`${pricingUSD.HOOKPOST.ai_credits} AI credits/month`);
    expect(o.HOOKPOST_AI_CREDITS).toBe('100 AI credits/month');
    expect(o.HOOKPOST_X_POSTS).toBe(`${pricingUSD.HOOKPOST.x_posts_per_month} X posts/month`);
    expect(o.HOOKPOST_AI_CREDITS_DETAIL).toContain(`an image ${AI_CREDIT_COST.ai_images}`);
    expect(o.HOOKPOST_X_POSTS_DETAIL).toMatch(/without links/);
    // cents, never "$0.xx" (reads as free to check-free-claims.js)
    expect(o.HOOKPOST_DISPLAY_PER_CHANNEL).toBe('35¢');
  });

  it('the free-posts line names the $7 price and never "$0 today", UPI or the 20%', () => {
    const o = load({ USD_CHECKOUT: 'on', GST_LUT_ARN: LUT });
    expect(o.USD_TRIAL_SENTENCE).toBe(
      '3 free posts, no card needed. Then $7/month for Hookpost, charged to your card.'
    );
    expect(o.USD_TRIAL_SENTENCE).not.toMatch(/\$0|today|UPI|free plan|20%|first month|-day|trial/i);
  });
});

describe('the checkout button and the note under it', () => {
  it('rupees: unchanged, ₹0 today and the ₹5 check', () => {
    expect(trialButtonLabel('INR', '₹599')).toBe('Start 3-Day Free Trial (₹0 Today, then ₹599)');
    expect(trialButtonLabel(undefined)).toBe('Start 3-Day Free Trial (₹0 Today, then ₹599)');
    expect(authorisationNote('INR', true)).toBe(
      'A ₹5 check is taken now and refunded straight away; your bank may take 5-7 working days to show it.'
    );
  });

  it('dollars: the price, and no "$0 today", no amount for the check, no UPI', () => {
    expect(trialButtonLabel('USD', '$19')).toBe('Start 3-Day Free Trial (then $19)');
    expect(trialButtonLabel('USD')).toBe('Start 3-Day Free Trial (then $19)');
    const note = authorisationNote('USD', true)!;
    expect(note).not.toMatch(/\$|₹|UPI|refund/);
    expect(note).toContain('at least 24 hours before');
  });

  it('no trial, no note', () => {
    expect(authorisationNote('INR', false)).toBeNull();
    expect(authorisationNote('USD', undefined)).toBeNull();
  });

  it('a dollar plan is never offered UPI', () => {
    expect(paymentMethodsFor('INR')).toContain('UPI');
    expect(paymentMethodsFor(null)).toContain('UPI');
    expect(paymentMethodsFor('USD')).not.toMatch(/UPI|NetBanking/);
  });
});

describe('the pricing cards', () => {
  const ctx = (over: Partial<PricingContext>): PricingContext => ({
    displayCurrency: 'INR',
    chargeCurrency: 'INR',
    lockedCurrency: null,
    checkoutAllowed: true,
    region: { country: 'US', tzSaysIndia: false, ipSaysIndia: false },
    prices: { STANDARD: { month: 599, year: 5990 }, PRO: { month: 1999, year: 19990 }, HOOKPOST: { month: 699, year: 0 } },
    ...over,
  });

  const answer = (body: any, ok = true) => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok, json: async () => body });
  };

  const props = {
    usdMarketed: true,
    trialOnly: true,
    trialNote: '3 free posts, no card needed. Then $7/month.',
    trialCta: 'Get 3 free posts',
  };

  const IN = ctx({ region: { country: 'IN', tzSaysIndia: true, ipSaysIndia: true } });
  const US = ctx({
    displayCurrency: 'USD',
    chargeCurrency: 'USD',
    prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 }, HOOKPOST: { month: 7, year: 0 } },
  });

  it.each([
    ['a visitor in the US', US, true],
    ['a visitor in India', IN, true],
    ['a failed context call', { statusCode: 500 }, false],
  ])('%s: $7, no currency pill, the charge note, never a skeleton or a rupee figure', async (_who, body, ok) => {
    answer(body, ok as boolean);
    const { container, queryAllByTestId } = render(React.createElement(PricingPlansClient, props));
    // From the first render, whatever the context says (or never says).
    expect(queryAllByTestId('price-skeleton')).toHaveLength(0);
    expect(queryAllByTestId('currency-skeleton')).toHaveLength(0);
    expect(container.textContent).toContain('$7');
    await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container.textContent).toContain('$7');
    expect(container.textContent).not.toContain('Prices in'); // one shown price, no currency pill
    expect(container.textContent).toContain(props.trialNote);
    expect(queryAllByTestId('charge-currency-note')[0].textContent).toBe(CHARGE_CURRENCY_NOTE);
    expect(container.textContent).not.toMatch(/₹|\b599\b|\b699\b|\bin India\b/);
    expect(queryAllByTestId('price-skeleton')).toHaveLength(0);
  });

  it('rupees only (how it ships): the same $7 from the first render, never a skeleton', async () => {
    answer(ctx({}));
    const { container, queryAllByTestId } = render(
      React.createElement(PricingPlansClient, { trialOnly: false })
    );
    expect(queryAllByTestId('price-skeleton')).toHaveLength(0);
    expect(container.textContent).toContain('$7');
    expect(container.textContent).toContain('$0');
    expect(container.textContent).toContain('Pay by UPI, NetBanking or cards.');
    expect(container.textContent).not.toMatch(/₹/);
  });
});

// With USD_CHECKOUT=on and an LUT set, the pages must still read exactly as
// they do without: $7 for the one plan, no rupee price for it, no "in India"
// price copy and no second rail. The rupee-only terms (UPI, the old ₹5 check)
// survive only on the legal pages that still govern workspaces on a trial.
describe('a build with the dollar switches on still shows only $7', () => {
  const CUT = '2026-10-20T00:00:00Z';
  const DOLLARS = {
    USD_CHECKOUT: 'on',
    GST_LUT_ARN: LUT,
    TRIAL_REQUIRED_SINCE_IN: CUT,
    TRIAL_REQUIRED_SINCE_GLOBAL: CUT,
  };

  /** Price copy of the old two-rail pages: a rupee plan price, or "in India" beside a dollar one. */
  const OLD_RAIL = /₹\s?599|₹\s?699|\b599\b|\b699\b|in India, or|\$7\/month elsewhere|in most other countries|rupees or US dollars|US dollars by card|paid in US dollars/;

  /** A module as a fresh build with these keys would evaluate it. */
  function loadWith<T>(env: Record<string, string>, path: string): T {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    let mod!: T;
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.isolateModules(() => {
      mod = require(path);
    });
    error.mockRestore();
    return mod;
  }

  /** A server page as prerendered with these keys: its visible text and JSON-LD. */
  function pageText(env: Record<string, string>, path: string): string {
    const page = loadWith<any>(env, path);
    // A plain (synchronous) server component renders like any other.
    const { container, unmount } = render(React.createElement(page.default));
    const ld = [...container.querySelectorAll('script[type="application/ld+json"]')]
      .map((el) => el.textContent || '')
      .join('\n');
    container.querySelectorAll('script').forEach((el) => el.remove());
    // A line break after every block, so a heading and the paragraph after
    // it are not read as one sentence.
    container
      .querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,div,section,summary,dt,dd,td,th')
      .forEach((el) => el.append('\n'));
    const text = container.textContent || '';
    unmount();
    const description = String(page.metadata?.description ?? '');
    return [text, ld, description].join('\n');
  }

  it('the trial sentence on every marketing page is the one-price sentence', () => {
    const o = loadWith<typeof import('./trial-offer')>(DOLLARS, './trial-offer');
    expect(o.TRIAL_SENTENCE).toBe('3 free posts, no card needed. Then $7/month.');
    expect(o.TRIAL_SENTENCE).toBe(o.TRIAL_SENTENCE_IN);
    expect(o.TRIAL_SENTENCE).not.toMatch(OLD_RAIL);
    expect(o.TRIAL_SENTENCE).not.toMatch(/\$0|% off/);
  });

  it('USD_EXCLUDED_COUNTRIES changes nothing: no "in most other countries"', () => {
    const o = loadWith<typeof import('./trial-offer')>(
      { ...DOLLARS, USD_EXCLUDED_COUNTRIES: 'EU27, GB' },
      './trial-offer'
    );
    expect(o.TRIAL_SENTENCE).toBe(o.TRIAL_SENTENCE_IN);
    expect(o.TRIAL_SENTENCE).not.toContain('most other countries');
  });

  it('rupees only (how it ships): the same sentence', () => {
    const o = loadWith<typeof import('./trial-offer')>(
      { TRIAL_REQUIRED_SINCE_IN: CUT },
      './trial-offer'
    );
    expect(o.TRIAL_SENTENCE).toBe(o.TRIAL_SENTENCE_IN);
    expect(o.TRIAL_SENTENCE).toBe('3 free posts, no card needed. Then $7/month.');
  });

  it('the landing FAQ (and the sitewide FAQPage JSON-LD built from it)', () => {
    const faq = loadWith<typeof import('./LandingFaq')>(DOLLARS, './LandingFaq');
    const text = faq.FAQ_DATA.map((f: any) => `${f.q}\n${f.a}`).join('\n');
    expect(text).toContain('Then $7/month.');
    expect(text).not.toMatch(OLD_RAIL);
  });

  it.each([
    ['/terms', './terms/page'],
    ['/refund-policy', './refund-policy/page'],
    ['/pricing', './pricing/page'],
  ])('%s', (_name, path) => {
    const text = pageText(DOLLARS, path);
    // The legal pages still govern the trials already running; /pricing says no
    // trial to new users.
    if (path === './pricing/page') {
      expect(text).toContain('3 free posts');
      expect(text).not.toMatch(/\b3-day trial/);
      expect(text).toContain('$7');
    } else {
      expect(text).toMatch(/3-day trial/);
      expect(text).toContain('3 posts');
    }
    expect(text).not.toMatch(OLD_RAIL);
    expect(text).not.toMatch(/\$0\b/);
  });

  it('the pricing meta description names no second currency', () => {
    const description = String(loadWith<any>(DOLLARS, './pricing/page').metadata.description);
    expect(description).not.toMatch(OLD_RAIL);
    expect(description).toContain('$7');
  });

  it('llms.txt and llms-full.txt say $7 and rupees only as the charge currency', () => {
    const llms = loadWith<typeof import('../../llms/llms')>(DOLLARS, '../../llms/llms');
    for (const file of ['llms.txt', 'llms-full.txt'] as const) {
      const text = llms.llmsText(file);
      expect(text).toContain('$7');
      expect(text).toMatch(/Indian rupees/);
      expect(text).not.toMatch(OLD_RAIL);
      expect(text).not.toMatch(/\$0\b/);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { checkText, loadAllow } = require('../../../../../scripts/check-free-claims.js');
      expect(checkText(file, text.split('\n'), loadAllow())).toEqual([]);
    }
  });

  it('the checker bites: the old two-rail copy fails it', () => {
    expect('Then ₹599/month in India, or $7/month elsewhere.').toMatch(OLD_RAIL);
    expect('(₹599 in India)').toMatch(OLD_RAIL);
    expect('3 free posts, no card needed. Then $7/month.').not.toMatch(OLD_RAIL);
  });
});
