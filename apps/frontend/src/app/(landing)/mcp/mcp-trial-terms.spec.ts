/**
 * /mcp, where the paid ads land: the free-posts terms beside the price, in the
 * visitor's currency only (and both, scoped, for readers that run no
 * JavaScript), and a CLI block whose commands the published CLI actually has.
 *   pnpm exec jest -c apps/frontend/jest.config.ts mcp-trial-terms
 */
import React from 'react';
import fs from 'fs';
import path from 'path';
import { act, render, waitFor } from '@testing-library/react';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('../site-nav', () => ({ SiteNav: () => null }));

import { TrialTerms, VisitorCurrencyProvider } from './trial-terms.client';
import { RUPEE_NOTE, type PricingContext } from '@hookpost/frontend/components/billing/use.pricing.context';
import { HOOKPOST_PRICE, pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

type Terms = typeof import('./trial-terms');

const KEYS = [
  'USD_CHECKOUT',
  'GST_LUT_ARN',
  'USD_EXCLUDED_COUNTRIES',
  'USD_ALLOWLIST',
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = (global as any).fetch;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (global as any).fetch = realFetch;
});

const CUT = '2026-10-20T00:00:00Z';
const LUT = 'AD0910260000000';
// What production builds with: the free-posts copy (the "trial" branch of
// offer(), 28 Oct 2026) for new users, and dollars sold outside India.
const DOLLARS = {
  USD_CHECKOUT: 'on',
  GST_LUT_ARN: LUT,
  TRIAL_REQUIRED_SINCE_IN: CUT,
  TRIAL_REQUIRED_SINCE_GLOBAL: CUT,
};

const LANDING = path.resolve(__dirname, '..');
const source = (rel: string) => fs.readFileSync(path.join(LANDING, rel), 'utf8');

/** A module as a fresh build with these keys would evaluate it. */
function loadWith<T>(env: Record<string, string>, mod: string): T {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let out!: T;
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.isolateModules(() => {
    out = require(mod);
  });
  error.mockRestore();
  return out;
}

/** Sentences stating a rupee-only term without scoping it to India or rupees (as usd-offer.spec). */
const unscoped = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /₹0 today|₹5(?![\d,.])|\bUPI\b|\b20% off\b/.test(s))
    .filter((s) => !/\bIndian?\b|\brupees?\b|\bINR\b/i.test(s));

const MONTHLY_ONLY = 'billed monthly';
const CHARGED = 'Nothing is charged until you choose a plan, and the payment is taken at checkout.';

describe('the free-posts terms', () => {
  it('3 free posts, no card, the one plan at $7 a month, no discount, no yearly price and no rupee figure, charged at checkout', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    expect(t.MCP_TRIAL_TERMS_INR).toBe(
      `3 free posts, no card needed. Then Hookpost, $${HOOKPOST_PRICE.displayUsd} a month, billed monthly. ${CHARGED}`
    );
    expect(t.MCP_TRIAL_TERMS_INR).not.toMatch(/₹|\b599\b|\b699\b|in India/);
  });

  it('dollars: card only, the one price, and never a discount, "$0 today", UPI or rupees', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    expect(t.MCP_TRIAL_TERMS_USD).toBe(
      `3 free posts, no card needed. Then Hookpost, $7 a month, paid by card, billed monthly. ${CHARGED}`
    );
    expect(t.MCP_TRIAL_TERMS_USD).not.toMatch(/\$0|today|UPI|₹|20%|first month/);
  });

  it('the version for every visitor is the sitewide sentence, with the one price, and when the charge lands', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    expect(t.MCP_TRIAL_TERMS_EITHER).toBe(
      `3 free posts, no card needed. Then $${HOOKPOST_PRICE.displayUsd}/month. ${CHARGED}`
    );
    expect(unscoped(t.MCP_TRIAL_TERMS_EITHER)).toEqual([]);
    expect(t.MCP_TRIAL_TERMS_EITHER).not.toMatch(/\$0\b|₹|in India|elsewhere/);
    // USD_EXCLUDED_COUNTRIES narrows nothing any more: there is no "elsewhere".
    const narrowed = loadWith<Terms>({ ...DOLLARS, USD_EXCLUDED_COUNTRIES: 'NP' }, './trial-terms');
    expect(narrowed.MCP_TRIAL_TERMS_EITHER).toBe(t.MCP_TRIAL_TERMS_EITHER);
  });

  it('promises no time trial, no ₹0-today card step, and says when the charge lands', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    for (const terms of [t.MCP_TRIAL_TERMS_INR, t.MCP_TRIAL_TERMS_USD, t.MCP_TRIAL_TERMS_EITHER]) {
      expect(terms).not.toMatch(/-day|trial(?!-limited)|₹0 today|₹5 check|24 hours|bank may/i);
      expect(terms).toContain(CHARGED);
    }
    for (const terms of [t.MCP_TRIAL_TERMS_INR, t.MCP_TRIAL_TERMS_USD]) {
      // Billed monthly only; never "month to month" and no yearly price.
      expect(terms).toContain(MONTHLY_ONLY);
      expect(terms).not.toMatch(/month to month|yearly|a year|5,990|19,990|\$190|\$290|20%|first month/i);
    }
    // The prices are pricing.ts's.
    expect(t.MCP_TRIAL_TERMS_INR).toContain(`$${HOOKPOST_PRICE.displayUsd} a month`);
    expect(pricingINR.HOOKPOST.year_price).toBe(0);
    expect(t.MCP_TRIAL_TERMS_INR).not.toContain('₹');
    expect(t.MCP_TRIAL_TERMS_USD).not.toContain('₹');
  });

  it('what each build passes to the page', () => {
    // The dollar switches change nothing: one version, no per-currency split.
    const both = loadWith<Terms>(DOLLARS, './trial-terms');
    expect(both.MCP_TRIAL_TERMS).toEqual({ inr: both.MCP_TRIAL_TERMS_INR });
    const rupees = loadWith<Terms>({ TRIAL_REQUIRED_SINCE_IN: CUT }, './trial-terms');
    expect(rupees.MCP_TRIAL_TERMS).toEqual({ inr: rupees.MCP_TRIAL_TERMS_INR });
    // No cutoff: the page offers the Free plan and names no free-posts offer.
    expect(loadWith<Terms>({}, './trial-terms').MCP_TRIAL_TERMS).toBeNull();
  });

  it('passes the free-claims check', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkText, loadAllow } = require('../../../../../../scripts/check-free-claims.js');
    expect(
      checkText(
        'mcp',
        [t.MCP_TRIAL_TERMS_INR, `${t.MCP_TRIAL_TERMS_INR} ${RUPEE_NOTE}`, t.MCP_TRIAL_TERMS_USD, t.MCP_TRIAL_TERMS_EITHER],
        loadAllow()
      )
    ).toEqual([]);
  });
});

describe('each visitor reads the version for their currency', () => {
  const COPY = { inr: 'RUPEE TERMS.', usd: 'DOLLAR TERMS.', either: 'BOTH TERMS.' };
  const ctx = (chargeCurrency: string, inIndia = chargeCurrency === 'INR'): PricingContext => ({
    displayCurrency: chargeCurrency,
    chargeCurrency,
    lockedCurrency: null,
    checkoutAllowed: true,
    region: { country: inIndia ? 'IN' : 'NP', tzSaysIndia: inIndia, ipSaysIndia: inIndia },
    prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 }, HOOKPOST: { month: 7, year: 0 } },
  });

  /** A fetch that answers when release() is called. */
  function deferredFetch() {
    let release: (body: any, ok?: boolean) => void = () => undefined;
    const fetchMock = jest.fn(
      () =>
        new Promise((resolve) => {
          release = (body, ok = true) => resolve({ ok, json: async () => body });
        })
    );
    (global as any).fetch = fetchMock;
    return {
      fetchMock,
      // The request leaves from a task of its own after mount
      // (use.pricing.context.ts), so wait for it before answering.
      release: async (body: any, ok?: boolean) => {
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        release(body, ok);
      },
    };
  }

  // The page's shape: two places, one provider; the hero reserves its lines,
  // the Plans note says the fact that holds for everyone meanwhile.
  const page = (copy: typeof COPY | { inr: string }) =>
    React.createElement(
      VisitorCurrencyProvider,
      { ask: 'usd' in copy && !!copy.usd },
      React.createElement(
        'p',
        { 'data-testid': 'hero' },
        React.createElement(TrialTerms, { ...copy, lines: [6, 4, 3] }, ' HOW TO CANCEL')
      ),
      React.createElement(
        'p',
        { 'data-testid': 'plans' },
        React.createElement(TrialTerms, { ...copy, pending: 'NEW WORKSPACES GET FREE POSTS.' })
      )
    );

  it('until the answer: a skeleton the height of the terms in the hero, the plain fact under Plans', async () => {
    const { release } = deferredFetch();
    const { container, getByTestId, queryAllByTestId } = render(page(COPY));
    const skeletons = queryAllByTestId('trial-terms-skeleton');
    expect(skeletons).toHaveLength(1);
    expect(getByTestId('hero').contains(skeletons[0])).toBe(true);
    expect(skeletons[0].getAttribute('aria-hidden')).toBe('true');
    expect(skeletons[0].hasAttribute('data-trial-terms-skeleton')).toBe(true);
    // 20px lines: six on a phone, four from sm, three from md.
    const rows = [...skeletons[0].children].map((el) => el.className.split(' '));
    expect(rows).toHaveLength(6);
    expect(rows.filter((c) => c.includes('h-5'))).toHaveLength(6);
    expect(rows.filter((c) => c.includes('block'))).toHaveLength(6);
    expect(rows.filter((c) => c.includes('sm:block'))).toHaveLength(4);
    expect(rows.filter((c) => c.includes('md:block'))).toHaveLength(3);
    // The last bar at each size is the short one.
    const bars = [...skeletons[0].children].map((el) => el.firstElementChild!.className.split(' '));
    expect(bars.findIndex((c) => c.includes('w-2/3'))).toBe(5);
    expect(bars.findIndex((c) => c.includes('sm:w-2/3'))).toBe(3);
    expect(bars.findIndex((c) => c.includes('md:w-2/3'))).toBe(2);
    expect(getByTestId('plans').textContent).toBe('NEW WORKSPACES GET FREE POSTS.');
    // The browser renders no <noscript> content: that is in the server HTML only.
    expect(container.querySelectorAll('noscript')).toHaveLength(2);
    expect(container.textContent).toBe('NEW WORKSPACES GET FREE POSTS.');
    await act(async () => release(ctx('USD')));
  });

  it('then dollars only, from one request', async () => {
    const { fetchMock, release } = deferredFetch();
    const { container, getByTestId, queryAllByTestId } = render(page(COPY));
    await act(async () => release(ctx('USD')));
    await waitFor(() => expect(getByTestId('hero').textContent).toBe('DOLLAR TERMS. HOW TO CANCEL'));
    expect(getByTestId('plans').textContent).toBe('DOLLAR TERMS.');
    expect(container.textContent).not.toMatch(/RUPEE|BOTH|EACH PLAN/);
    expect(queryAllByTestId('trial-terms-skeleton')).toHaveLength(0);
    expect(container.querySelectorAll('noscript')).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a visitor billed in rupees in India reads the rupee terms only', async () => {
    const { release } = deferredFetch();
    const { container, getByTestId } = render(page(COPY));
    await act(async () => release(ctx('INR')));
    await waitFor(() => expect(getByTestId('plans').textContent).toBe('RUPEE TERMS.'));
    expect(container.textContent).not.toMatch(/DOLLAR|BOTH/);
    expect(container.textContent).not.toContain(RUPEE_NOTE);
  });

  it('a visitor billed in rupees outside India also reads the rupee note, as on /pricing', async () => {
    const { release } = deferredFetch();
    const { getByTestId } = render(page(COPY));
    await act(async () => release(ctx('INR', false)));
    await waitFor(() => expect(getByTestId('plans').textContent).toBe(`RUPEE TERMS. ${RUPEE_NOTE}`));
    expect(getByTestId('hero').textContent).toBe(`RUPEE TERMS. ${RUPEE_NOTE} HOW TO CANCEL`);
  });

  it('no answer: both rails rather than a guess or a skeleton forever', async () => {
    const { release, fetchMock } = deferredFetch();
    const { getByTestId, queryAllByTestId } = render(page(COPY));
    await act(async () => release({ statusCode: 500 }, false));
    // Asked once more (a deploy can 502 for a moment), then it gives up.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3000 });
    await act(async () => release({ statusCode: 500 }, false));
    await waitFor(() => expect(getByTestId('plans').textContent).toBe('BOTH TERMS.'));
    expect(getByTestId('hero').textContent).toBe('BOTH TERMS. HOW TO CANCEL');
    expect(queryAllByTestId('trial-terms-skeleton')).toHaveLength(0);
  });

  it('rupees only: the terms from the first render, and nothing is fetched', () => {
    const { fetchMock } = deferredFetch();
    const { container, getByTestId, queryAllByTestId } = render(page({ inr: 'RUPEE TERMS.' }));
    expect(queryAllByTestId('trial-terms-skeleton')).toHaveLength(0);
    expect(container.querySelectorAll('noscript')).toHaveLength(0);
    expect(getByTestId('hero').textContent).toBe('RUPEE TERMS. HOW TO CANCEL');
    expect(getByTestId('plans').textContent).toBe('RUPEE TERMS.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the /mcp page', () => {
  /** Visible text of some HTML, a line per block, without scripts or styles. */
  function textOf(html: string): string {
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('script,style').forEach((el) => el.remove());
    div.querySelectorAll('p,li,h1,h2,h3,dt,dd,td,th,pre,div,section').forEach((el) => el.append('\n'));
    return div.textContent || '';
  }

  /** The page with these keys, as the browser renders it: visible text and its JSON-LD. */
  function prerender(env: Record<string, string>) {
    // The client parts ask for the visitor's currency; the prerender never hears back.
    (global as any).fetch = jest.fn(() => new Promise(() => undefined));
    // The page, React and the renderer from one module registry: the page's
    // client parts use hooks, which fail against a second copy of React.
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    let mod: any, R: any, rtl: any;
    jest.isolateModules(() => {
      mod = require('./page');
      R = require('react');
      // pure: the plain entry would register cleanup hooks inside a test.
      rtl = require('@testing-library/react/pure');
    });
    const { container, unmount } = rtl.render(R.createElement(mod.default));
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent || '{}');
    const text = textOf(container.innerHTML);
    const pre = [...container.querySelectorAll('pre')].map((el) => (el as HTMLElement).textContent || '');
    const hrefs = [...container.querySelectorAll('a')].map((a) => (a as HTMLElement).getAttribute('href'));
    unmount();
    return { text, ld, pre, hrefs };
  }

  /**
   * The HTML the server sends, which NGINX and Cloudflare cache for every
   * visitor: what it shows without JavaScript outside <noscript>, and each
   * <noscript>'s HTML.
   */
  function serverHtml(env: Record<string, string>) {
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, env);
    let mod: any, R: any, server: any;
    jest.isolateModules(() => {
      mod = require('./page');
      R = require('react');
      server = require('react-dom/server.node');
    });
    const html: string = server.renderToStaticMarkup(R.createElement(mod.default));
    const noscripts = [...html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map((m) => m[1]);
    const outside = textOf(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, ''));
    return { html, noscripts, outside };
  }

  it('the cached HTML with the dollar switches on: the one $7 version in the hero and under Plans, no <noscript>, no skeleton', () => {
    const t = loadWith<Terms>(DOLLARS, './trial-terms');
    const { html, outside } = serverHtml(DOLLARS);
    expect(outside.split(t.MCP_TRIAL_TERMS_INR).length - 1).toBe(2);
    expect(outside).toContain('Then Hookpost, $7 a month, billed monthly.');
    expect(outside).not.toMatch(/\b3-day trial/);
    expect(unscoped(outside)).toEqual([]);
    expect(outside).not.toMatch(/\$0\b|₹|\bin India\b/);
    expect(html).not.toContain('<noscript>');
    expect(html).not.toContain('data-trial-terms-skeleton');
    expect(html).toContain('href="/cancellation-policy"');
  });

  it('as the browser renders it before any answer: the same terms, and nothing is fetched', () => {
    const { text } = prerender(DOLLARS);
    expect(text).toContain('Then Hookpost, $7 a month, billed monthly.');
    expect(text).toContain(CHARGED);
    expect(text).not.toMatch(/\b3-day trial/);
    expect(unscoped(text)).toEqual([]);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('a rupee-only trial build shows the rupee terms in the hero and under Plans, with no <noscript>', () => {
    const terms = loadWith<Terms>({ TRIAL_REQUIRED_SINCE_IN: CUT }, './trial-terms').MCP_TRIAL_TERMS_INR;
    const { html, outside } = serverHtml({ TRIAL_REQUIRED_SINCE_IN: CUT });
    expect(outside.split(terms).length - 1).toBe(2);
    expect(html).not.toContain('<noscript>');
    expect(html).not.toContain('data-trial-terms-skeleton');
    expect(html).toContain('href="/cancellation-policy"');
  });

  it('spells UPI AutoPay one way in the Plans note', () => {
    for (const env of [DOLLARS, { TRIAL_REQUIRED_SINCE_IN: CUT }]) {
      const { outside } = serverHtml(env);
      const note = outside.split('\n').find((l) => l.includes('All limits'))!;
      expect(note).toContain('UPI AutoPay');
      expect(note).not.toMatch(/UPI Autopay/);
    }
  });

  it('the FAQ JSON-LD is the visible FAQ, word for word', () => {
    const { text, ld } = prerender(DOLLARS);
    const faq = ld['@graph'].find((g: any) => g['@type'] === 'FAQPage');
    expect(faq.mainEntity.length).toBeGreaterThan(0);
    for (const q of faq.mainEntity) {
      expect(text).toContain(q.name);
      expect(text).toContain(q.acceptedAnswer.text);
    }
  });

  it('shows the CLI: install, sign in and a one-line post, with the npm link', () => {
    const { pre, hrefs, text } = prerender(DOLLARS);
    const cli = pre.find((p) => p.includes('npm install -g hookpost'));
    expect(cli).toBeDefined();
    expect(cli).toMatch(/^hookpost auth login$/m);
    expect(cli).toMatch(/^hookpost post "[^"]+" --channel abc123$/m);
    expect(hrefs).toContain('https://www.npmjs.com/package/hookpost');
    expect(hrefs).toContain('#cli');
    expect(text).toContain('next free slot');
  });

  it('says what auth login asks for, the key and then the host, and names no Settings tab', () => {
    const { pre, text } = prerender(DOLLARS);
    const cli = pre.find((p) => p.includes('npm install -g hookpost'))!;
    // Commands only: a comment-only line breaks a paste into macOS zsh, and
    // auth login would read the next pasted lines as the key and host.
    expect(cli.split('\n').every((l) => !l.trim().startsWith('#') && !l.includes(' #'))).toBe(true);
    expect(text).toMatch(/auth login\s*asks for your API key, then\s*the API host \(press Enter to keep the default\)/);
    // The CLI does ask both, in that order.
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../../cli/src/index.ts'), 'utf8');
    expect(src.indexOf("ask('API key")).toBeGreaterThan(-1);
    expect(src.indexOf('ask(`API host [${DEFAULT_HOST}]: `)')).toBeGreaterThan(src.indexOf("ask('API key"));
    expect(text).not.toMatch(/Public API/);
  });

  it('fits a 375px phone: no CLI line is longer than 38 characters', () => {
    const { pre } = prerender(DOLLARS);
    const cli = pre.find((p) => p.includes('npm install -g hookpost'))!;
    // text-xs mono is about 7.2px a character, and the block has 301px for
    // text at 375px (20px gutters, 1px borders, 16px padding).
    for (const line of cli.split('\n')) expect(line.length).toBeLessThanOrEqual(38);
  });

  it('every CLI command shown is one the CLI handles, as written', () => {
    const { pre } = prerender(DOLLARS);
    const cli = pre.find((p) => p.includes('npm install -g hookpost'))!;
    const src = fs.readFileSync(path.resolve(__dirname, '../../../../../cli/src/index.ts'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../../cli/package.json'), 'utf8'));
    expect(pkg.name).toBe('hookpost');
    expect(Object.keys(pkg.bin)).toEqual(['hookpost']);
    let commands = 0;
    for (const line of cli.split('\n').map((l) => l.replace(/(^|\s+)#.*$/, '').trim())) {
      if (!line || line.startsWith('npm ')) continue;
      commands++;
      const [bin, cmd, sub] = line.split(/\s+/);
      expect(bin).toBe('hookpost');
      expect(src).toContain(`cmd === '${cmd}'`);
      if (cmd === 'auth') expect(src).toContain(`sub === '${sub}'`);
      for (const flag of line.match(/--[a-z]+/g) || []) {
        expect(src).toMatch(new RegExp(`flags?\\(argv, '${flag.slice(2)}'\\)`));
      }
    }
    expect(commands).toBe(3);
    // Without --at a scheduled post asks for the next free slot.
    expect(src).toMatch(/type === 'schedule' && !date[\s\S]{0,300}find-slot/);
  });
});
