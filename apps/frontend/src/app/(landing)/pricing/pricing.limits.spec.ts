/**
 * /pricing shows every limit a plan has, from pricing.ts, on the cards and in
 * the table: channels, posts a month, who can use it ("Up to 15 team members"
 * on the one plan, Hookpost, since 8 Nov 2026), AI credits, the API
 * with the MCP server and CLI, and webhooks. And it says what new users get: in
 * the free-posts build (28 Oct 2026) FREE_POST_LIMIT free posts with no card
 * and then the flat monthly price, never an "N-day trial", a first-month
 * discount or a yearly price. Rendered the way the
 * production build does
 * (TRIAL_REQUIRED_SINCE_IN set, dollar switches on), as a visitor would read it:
 * the plan at $7 for everyone, no rupee figure for it anywhere.
 *   pnpm exec jest -c apps/frontend/jest.config.ts pricing.limits
 */
import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import {
  AI_CREDIT_COST,
  HOOKPOST_PRICE,
  pricingINR,
  pricingUSD,
  MARKETED_TIERS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  planFeatureLabel,
  planLimitItems,
} from '@hookpost/frontend/components/billing/plan.features';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { htmlSegments } = require('../../../../../../scripts/check-free-claims.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkText } = require('../../../../../../scripts/check-trial-days.js');
const trialDaysHits = (html: string) =>
  checkText('pricing', htmlSegments(html)).map((h: any) => h.sentence);

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('../site-nav', () => ({ SiteNav: () => null }));
jest.mock('../PricingPlans', () => ({ PricingPlans: () => null }));
jest.mock('@hookpost/frontend/components/billing/holiday.offer.banner', () => ({
  HolidayOfferStrip: () => null,
  FestivalPill: () => null,
  HeroGlow: () => null,
  useFestiveCard: () => ({ cardClass: '', cardStyle: undefined, decoration: null }),
}));

const KEYS = ['TRIAL_REQUIRED_SINCE_IN', 'USD_CHECKOUT', 'GST_LUT_ARN'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** The page as a build with these keys renders it, as plain text. */
function pricingPageText(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let Page: any;
  jest.isolateModules(() => {
    Page = require('./page').default;
  });
  const { container } = render(React.createElement(Page));
  const html = container.innerHTML;
  cleanup();
  return html;
}

const textOf = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

const TRIAL_BUILD = {
  TRIAL_REQUIRED_SINCE_IN: '2026-10-20T00:00:00Z',
  USD_CHECKOUT: 'on',
  GST_LUT_ARN: 'AD0000000000000',
};

describe('/pricing, the table', () => {
  it('has a column for every limit, team members and the API, MCP and CLI included', () => {
    const text = textOf(pricingPageText(TRIAL_BUILD));
    for (const head of [
      'Channels',
      'Posts / month',
      'Team members (you included)',
      'AI credits / month',
      'AI images',
      'Public API, MCP server & CLI',
      'Webhooks',
    ]) {
      expect(text).toContain(head);
    }
  });

  it('Hookpost is one row, up to 15 team members, with the figures pricing.ts enforces', () => {
    const html = pricingPageText(TRIAL_BUILD);
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => textOf(c[1]).trim())
    );
    const row = (name: string) => rows.find((r) => r[0] === name)!;
    const h = pricingUSD.HOOKPOST;
    expect(row('Hookpost')).toEqual([
      'Hookpost',
      `$${HOOKPOST_PRICE.displayUsd}`,
      String(h.channel),
      h.posts_per_month.toLocaleString('en-US'),
      `Up to ${h.team_member_limit}`,
      `${h.ai_credits} AI credits`,
      `${AI_CREDIT_COST.ai_images} credits each`,
      'Yes',
      String(h.webhooks),
    ]);
    // One shared pool of AI credits, not separate text and image counts.
    expect(row('Hookpost').join(' ')).not.toMatch(/₹|\b500\b|\b599\b|\b699\b/);
    expect(rows.find((r) => r[0] === 'Standard' || r[0] === 'Pro')).toBeUndefined();
    // No Free row once new workspaces start with the trial.
    expect(rows.find((r) => r[0] === 'Free')).toBeUndefined();
  });

  it('the structured data lists the same limits as the cards', () => {
    const html = pricingPageText(TRIAL_BUILD);
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const offers = ld['@graph'][0].offers;
    const inr = Array.isArray(offers) ? offers[0] : offers;
    const plan = inr.offers.find((o: any) => o.name === 'Hookpost plan');
    expect(plan.description).toBe(
      `${planLimitItems(pricingINR.HOOKPOST).map((f) => planFeatureLabel(f)).join('; ')}.`
    );
    expect(plan.description).toContain(`${pricingINR.HOOKPOST.ai_credits} AI credits/month`);
    expect(plan.description).toContain(`${pricingINR.HOOKPOST.x_posts_per_month} X posts/month`);
    expect(plan.description).not.toMatch(/500 AI|20 AI images|50 X posts|3 with a link/);
    expect(plan.description).toContain('Up to 15 team members');
    expect(plan.description).toContain('Public API, MCP server and CLI');
    expect(inr.offers.map((o: any) => o.name)).not.toEqual(expect.arrayContaining(['Standard plan']));
  });

  it('the structured data prices the plan at $7 (HOOKPOST_PRICE) in USD only: no INR offer, no region split', () => {
    for (const env of [TRIAL_BUILD, {}]) {
      const html = pricingPageText(env);
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
      const raw = ld['@graph'][0].offers;
      // One AggregateOffer, not a list with a second currency beside it.
      expect(Array.isArray(raw)).toBe(false);
      expect(raw.priceCurrency).toBe('USD');
      const shown = String(HOOKPOST_PRICE.displayUsd);
      for (const tier of MARKETED_TIERS) {
        const name = `${tier.charAt(0)}${tier.slice(1).toLowerCase()} plan`;
        const o = raw.offers.find((x: any) => x.name === name);
        if (!o) continue; // Free is left out of the trial build
        expect(o.price).toBe(tier === 'FREE' ? '0' : shown);
        expect(o.priceCurrency).toBe('USD');
      }
      expect(raw.highPrice).toBe(shown);
      expect(raw.lowPrice).toBe(env === TRIAL_BUILD ? shown : '0');
      // One plan, billed monthly only: no yearly price anywhere in the data.
      const json = JSON.stringify(ld);
      expect(json).not.toMatch(/two months free|annual billing|monthly or annual|\/year|\$0\/year/i);
      expect(json).not.toMatch(/Hookpost Standard|\bHookpost Pro\b|₹5,990|₹19,990|\$190|\$290/);
      expect(json).not.toMatch(/"INR"|eligibleRegion|ineligibleRegion|₹\s?(599|699)/);
      const faq = ld['@graph'].find((g: any) => g['@type'] === 'FAQPage');
      const yearly = faq.mainEntity.find((q: any) => q.name === 'Is there a yearly plan?');
      expect(yearly.acceptedAnswer.text).toContain(`No. Hookpost is billed monthly only, at $${shown} a month`);
      expect(yearly.acceptedAnswer.text).toContain('There is no yearly price and no first-month discount.');
      expect(yearly.acceptedAnswer.text).not.toMatch(/-day trial|₹|in India|outside India/);
    }
  });

  it('says there is no yearly price: Hookpost is billed monthly only', () => {
    expect(pricingINR.HOOKPOST.year_price).toBe(0);
    for (const env of [TRIAL_BUILD, {}]) {
      const text = textOf(pricingPageText(env));
      expect(text).toContain('It is billed monthly, with no yearly price.');
      expect(text).toContain('Is there a yearly plan?');
      expect(text).not.toMatch(/₹19,990|₹5,990|Paying yearly/);
    }
  });

  it('a build with no cutoff names no trial of Hookpost either; any "N-day trial" is a named competitor’s', () => {
    const html = pricingPageText({});
    expect(html).not.toMatch(/\b3-day trial/);
    // The same check the build runs (scripts/check-trial-days.js).
    expect(trialDaysHits(html)).toEqual([]);
  });

  it('the free-posts build names no "N-day trial" of Hookpost, only Postiz’s own', () => {
    const html = pricingPageText(TRIAL_BUILD);
    const text = textOf(html);
    expect(trialDaysHits(html)).toEqual([]);
    expect(html).not.toContain('3-day trial');
    // Every "-day trial" left is a competitor's: Postiz's 7 days.
    expect([...html.matchAll(/(\d+)[- ]day trial/g)].map((m) => m[1]).filter((n) => n !== '7')).toEqual([]);
    expect(text).toContain('3 free posts, no card needed. Then $7/month.');
    expect(text).not.toMatch(/₹\s?(599|699)|in India, or|elsewhere/);
    expect(text).toContain('Can I try Hookpost before paying?');
    expect(text).toContain('When is my card or UPI charged?');
    // No discount anywhere on the page.
    expect(text).not.toMatch(/20% off|first month/i);
    // The FAQPage structured data says the same.
    const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)![1]);
    const faq = ld['@graph'].find((g: any) => g['@type'] === 'FAQPage');
    const trial = faq.mainEntity.find((q: any) => q.name === 'Can I try Hookpost before paying?');
    expect(trial.acceptedAnswer.text).toContain('3 free posts, no card needed. Then $7/month.');
    expect(JSON.stringify(ld)).not.toMatch(/\b3-day trial|₹0 today|24 hours before the first charge/);
  });

  it('compares with Buffer, Hootsuite and Postiz in figures, Postiz’s 7-day trial as Postiz’s', () => {
    const text = textOf(pricingPageText(TRIAL_BUILD));
    expect(text).toContain('How does this compare with Buffer, Hootsuite and Postiz?');
    expect(text).toContain('Buffer charges per channel, $5 a channel a month billed yearly, so 20 channels cost $100 a month');
    expect(text).toContain('Hootsuite charges per user: ₹1,999 a user a month billed yearly in India, for up to 10 accounts.');
    expect(text).toContain('Postiz Standard is $23 a month billed yearly for 5 channels, after a 7-day trial.');
    expect(text).toContain(
      `Hookpost is $7 a month for 20 channels and up to 15 team members, after 3 free posts.`
    );
  });
});

describe('/pricing, the plan cards', () => {
  const OFFER = { percent: 20, capInr: 400, methods: ['upi', 'card'] };
  function answeredFetch(extra: Record<string, unknown> = {}) {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        displayCurrency: 'INR',
        chargeCurrency: 'INR',
        lockedCurrency: null,
        checkoutAllowed: true,
        region: { country: 'IN', tzSaysIndia: true, ipSaysIndia: true },
        prices: {
          STANDARD: { month: 599, year: 5990 },
          PRO: { month: 1999, year: 19990 },
          HOOKPOST: { month: 599, year: 0 },
        },
        ...extra,
      }),
    }));
  }

  async function cardsText(props: Record<string, unknown>) {
    const { PricingPlansClient } = require('../PricingPlans.client');
    const { container } = render(
      React.createElement(PricingPlansClient, {
        trialOnly: true,
        trialCta: 'Get 3 free posts',
        ...props,
      })
    );
    // Until the pricing context has answered and the cards re-rendered.
    await waitFor(() => expect((global as any).fetch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(container.textContent).toContain('$7'));
    const text = container.textContent!;
    cleanup();
    return text;
  }

  it('the card for the one plan says no yearly price, and the retired plans are not on it', async () => {
    answeredFetch();
    const text = await cardsText({});
    expect(text).toContain('Hookpost');
    expect(text).toContain('$7');
    expect(text).not.toMatch(/\/year|2 months free|19,990|5,990|1,999|\bStandard\b|\bPro\b|₹/);
  });

  it('a visitor the context bills in dollars sees the same cards: no yearly line, and the price is $7', async () => {
    answeredFetch({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      prices: {
        STANDARD: { month: 19, year: 190 },
        PRO: { month: 29, year: 290 },
        HOOKPOST: { month: 7, year: 0 },
      },
    });
    const { PricingPlansClient } = require('../PricingPlans.client');
    const { container } = render(React.createElement(PricingPlansClient, {}));
    await waitFor(() => expect(container.textContent).toContain('$7'));
    expect(container.textContent).not.toMatch(/\/year|\$19\b|\$29\b|\$190|\$290|₹/);
    cleanup();
  });

  it('/pricing, free-posts build: the cards say the free posts and the flat price, with no first-month offer', async () => {
    answeredFetch({ firstMonthOffer: OFFER });
    const text = await cardsText({
      trialNote: '3 free posts, no card needed. Then $7/month.',
    });
    expect(text).toContain('3 free posts, no card needed. Then $7/month.');
    expect(text).not.toMatch(/first month|% off/i);
    expect(text).not.toContain('Already had your trial?');
  });

  it('every card lists every limit of its plan, in the app’s words', async () => {
    answeredFetch();
    const { PricingPlansClient } = require('../PricingPlans.client');
    const { container } = render(
      React.createElement(PricingPlansClient, { trialOnly: true, trialCta: 'Get 3 free posts' })
    );
    await act(async () => undefined);
    await waitFor(() => expect(container.textContent).toContain('$7'));
    const cards = [...container.querySelectorAll('h3')].map((h) => h.closest('div')!);
    expect(cards.map((c) => c.querySelector('h3')!.textContent)).toEqual(['Hookpost']);
    MARKETED_TIERS.forEach((tier, i) => {
      const items = [...cards[i].querySelectorAll('li')].map((li) => li.textContent!.replace('✓', '').trim());
      expect(items).toEqual(planLimitItems(pricingUSD[tier]).map((f) => planFeatureLabel(f)));
    });
    const text = container.textContent!;
    expect(text).toContain('Up to 15 team members');
    expect(text).toContain('Public API, MCP server and CLI');
    expect(text).toContain(`${pricingUSD.HOOKPOST.ai_credits} AI credits/month`);
    expect(text).toContain(`${pricingUSD.HOOKPOST.x_posts_per_month} X posts/month`);
    expect(text).not.toMatch(/500 AI|20 AI images|50 X posts|3 with a link/);
    expect(text).toContain('Get 3 free posts');
    expect(text).not.toMatch(/-day trial/);
  });
});
