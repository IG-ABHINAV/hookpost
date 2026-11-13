/**
 * How the comparison pages (/compare/*, /vs/*, /alternatives) state the way
 * Hookpost bills: one plan, monthly only (pricing.ts has no yearly price for
 * it), so no page offers a yearly Hookpost price or says "billed monthly
 * unless you choose yearly". Competitors' own
 * "month to month" rates (from competitor-facts.ts) are left as they are.
 * Rendered with both builds: rupees only, and dollars sold outside India.
 *   pnpm exec jest -c apps/frontend/jest.config.ts comparison-billing-copy
 */
import fs from 'fs';
import path from 'path';
import { cleanup } from '@testing-library/react';
import { HOOKPOST_PRICE, pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('./site-nav', () => ({ SiteNav: () => null }));

const KEYS = ['USD_CHECKOUT', 'GST_LUT_ARN', 'TRIAL_REQUIRED_SINCE_IN', 'TRIAL_REQUIRED_SINCE_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  cleanup();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CUT = '2026-10-20T00:00:00Z';
const BUILDS = {
  'rupees only': { TRIAL_REQUIRED_SINCE_IN: CUT },
  'dollar switches on (USD_CHECKOUT, GST_LUT_ARN): still only $7': {
    USD_CHECKOUT: 'on',
    GST_LUT_ARN: 'AD0910260000000',
    TRIAL_REQUIRED_SINCE_IN: CUT,
    TRIAL_REQUIRED_SINCE_GLOBAL: CUT,
  },
};

const SHOWN = `$${HOOKPOST_PRICE.displayUsd}`;
const { HOOKPOST } = pricingINR;

type Mods = {
  compare: typeof import('./compare/[pair]/page');
  vs: typeof import('./vs/[competitor]/page');
  hub: typeof import('./alternatives/page');
  facts: typeof import('./compare/competitor-facts');
  React: typeof import('react');
  rtl: typeof import('@testing-library/react');
};

function load(env: Record<string, string>): Mods {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let out!: Mods;
  jest.isolateModules(() => {
    out = {
      compare: require('./compare/[pair]/page'),
      vs: require('./vs/[competitor]/page'),
      hub: require('./alternatives/page'),
      facts: require('./compare/competitor-facts'),
      React: require('react'),
      rtl: require('@testing-library/react/pure'),
    };
  });
  return out;
}

/** The page's text, structured data included. */
function textOf(m: Mods, element: any): string {
  const view = m.rtl.render(element);
  const scripts = Array.from(view.container.querySelectorAll('script')).map((s) => s.textContent || '');
  const text = [view.container.textContent || '', ...scripts].join('\n');
  view.unmount();
  return text;
}

/** Hookpost's own monthly prices followed by "month to month". */
const HOOKPOST_MONTH_TO_MONTH = new RegExp(
  [
    `${SHOWN} month to month`,
    'in rupees, month to month',
    'in US dollars, month to month',
    'is the month-to-month price',
  ]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
  'i'
);

describe.each(Object.entries(BUILDS))('comparison pages, %s', (_build, env) => {
  it('/compare/*: Hookpost is billed monthly only, never "month to month" and never yearly', async () => {
    const m = load(env);
    let named = 0;
    for (const pair of m.facts.PAIRS) {
      const el = await m.compare.default({ params: Promise.resolve({ pair }) });
      const text = textOf(m, el);
      expect([pair, text.match(HOOKPOST_MONTH_TO_MONTH)?.[0]]).toEqual([pair, undefined]);
      expect([pair, text.match(/unless you choose yearly/i)?.[0]]).toEqual([pair, undefined]);
      if (text.includes('billed monthly')) named++;
    }
    // The per-channel and plan-fit answers carry the wording.
    expect(named).toBeGreaterThan(0);
  });

  it('/vs/*: the Hookpost column gives the monthly price from pricing.ts and no yearly one', async () => {
    const m = load(env);
    for (const competitor of m.facts.VS_SLUGS) {
      const el = await m.vs.default({ params: Promise.resolve({ competitor }) });
      const text = textOf(m, el);
      expect([competitor, text.match(HOOKPOST_MONTH_TO_MONTH)?.[0]]).toEqual([competitor, undefined]);
      expect([competitor, text.includes(`${SHOWN} a month`)]).toEqual([competitor, true]);
      // No rupee figure for the plan, whichever build.
      expect([competitor, text.match(/₹\s?(599|699)/)?.[0]]).toEqual([competitor, undefined]);
      expect([competitor, text.match(/₹5,990|₹19,990|\bPro\b is|Hookpost Standard/)?.[0]]).toEqual([competitor, undefined]);
    }
  });

  it('/alternatives: the monthly price, and no yearly one', () => {
    const m = load(env);
    const text = textOf(m, m.React.createElement(m.hub.default));
    expect(text).not.toMatch(HOOKPOST_MONTH_TO_MONTH);
    expect(text).toContain(`${SHOWN} is the price billed monthly, and there is no yearly price.`);
    expect(text).not.toMatch(/₹\s?(599|699)/);
    expect(HOOKPOST.year_price).toBe(0);
  });
});

// 28 Oct 2026: new workspaces get 3 free posts with no card, then the one plan
// at its flat price (no first-month discount since 8 Nov 2026), and no time
// trial. These builds are the free-posts copy, so no comparison page may still
// sell Hookpost "a 3-day trial" or "₹0 today" (a competitor's own trial, 14 or
// 30 days, is theirs), and none may promise a first-month discount.
describe.each(Object.entries(BUILDS))('comparison pages, %s: free posts, no time trial', (build, env) => {
  const ALTERNATIVES = fs
    .readdirSync(path.join(__dirname, 'alternatives'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(__dirname, 'alternatives', e.name, 'page.tsx')))
    .map((e) => e.name);

  const assertFreePosts = (where: string, text: string) => {
    expect([where, text.match(/\b3-day (free )?trial|₹0 today|Start 3-day/i)?.[0]]).toEqual([where, undefined]);
    expect([where, text.match(/first month 20% off/i)?.[0]]).toEqual([where, undefined]);
  };

  it('/alternatives, and every /alternatives/<competitor>: the canonical sentence, no 3-day trial', () => {
    const m = load(env);
    const hub = textOf(m, m.React.createElement(m.hub.default));
    assertFreePosts('/alternatives', hub);
    expect(hub).toContain(`3 free posts, no card needed. Then ${SHOWN}/month`);
    expect(hub).not.toMatch(/₹\s?(599|699)/);
    expect(ALTERNATIVES.length).toBeGreaterThan(5);
    for (const slug of ALTERNATIVES) {
      let page: any;
      jest.isolateModules(() => {
        page = require(`./alternatives/${slug}/page`);
      });
      const text = textOf(m, m.React.createElement(page.default));
      assertFreePosts(`/alternatives/${slug}`, text);
      // Every competitor page states the offer, if only in its closing call to action.
      expect([slug, text.includes('3 free posts, no card needed')]).toEqual([slug, true]);
    }
  });

  it('/compare/* and /vs/*: no 3-day trial', async () => {
    const m = load(env);
    for (const pair of m.facts.PAIRS) {
      const el = await m.compare.default({ params: Promise.resolve({ pair }) });
      assertFreePosts(`/compare/${pair}`, textOf(m, el));
    }
    for (const competitor of m.facts.VS_SLUGS) {
      const el = await m.vs.default({ params: Promise.resolve({ competitor }) });
      assertFreePosts(`/vs/${competitor}`, textOf(m, el));
    }
  });
});
