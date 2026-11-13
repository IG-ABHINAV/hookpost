/**
 * The ad landing pages /claude, /cli and /start, rendered as the production
 * build makes them (free posts for new users, one $7 price for everyone): the
 * ads' headline, the real-run video, one call to action with the free-posts
 * terms at the one $7 price, the networks that published, competitor
 * prices from competitor-facts.ts only, structured data that matches
 * pricing.ts, and the page in the sitemap, llms.txt and the proxy's
 * allowlist.
 *   pnpm exec jest -c apps/frontend/jest.config.ts ad-landing
 */
import fs from 'fs';
import path from 'path';
import { cleanup, render } from '@testing-library/react';
import { ATTRIBUTION_CAPTURE_SCRIPT } from '@hookpost/helpers/utils/attribution';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('../site-nav', () => ({ SiteNav: () => null }));

const KEYS = ['USD_CHECKOUT', 'GST_LUT_ARN', 'TRIAL_REQUIRED_SINCE_IN', 'TRIAL_REQUIRED_SINCE_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = (global as any).fetch;
afterEach(() => {
  cleanup();
  while (views.length) views.pop()!.unmount();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (global as any).fetch = realFetch;
  document.cookie = 'hp_attr=; Path=/; Max-Age=0';
});

const CUT = '2026-10-20T00:00:00Z';
const PRODUCTION = { USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0910260000000', TRIAL_REQUIRED_SINCE_IN: CUT, TRIAL_REQUIRED_SINCE_GLOBAL: CUT };
const RUPEES_ONLY = { TRIAL_REQUIRED_SINCE_IN: CUT };

const PUBLIC = path.resolve(__dirname, '../../../../public');
const SRC = path.resolve(__dirname, '../../..');

type Mods = {
  landing: typeof import('./ad-landing');
  pages: typeof import('./ad-pages');
  pricing: typeof import('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing');
  facts: typeof import('../compare/competitor-facts');
  networks: typeof import('../channels/published-networks');
  // React and Testing Library from the same module registry as the page, or
  // the page's hooks run against another copy of React.
  React: typeof import('react');
  rtl: typeof import('@testing-library/react');
};

function load(env: Record<string, string>): Mods {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let out!: Mods;
  jest.isolateModules(() => {
    out = {
      landing: require('./ad-landing'),
      pages: require('./ad-pages'),
      pricing: require('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing'),
      facts: require('../compare/competitor-facts'),
      networks: require('../channels/published-networks'),
      React: require('react'),
      rtl: require('@testing-library/react/pure'),
    };
  });
  return out;
}

/** Answers /api/public/pricing-context with this currency. */
const pricingContext = (chargeCurrency: 'INR' | 'USD') => {
  const inIndia = chargeCurrency === 'INR';
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      displayCurrency: chargeCurrency,
      chargeCurrency,
      lockedCurrency: null,
      checkoutAllowed: true,
      region: { country: inIndia ? 'IN' : 'US', tzSaysIndia: inIndia, ipSaysIndia: inIndia },
      prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 }, HOOKPOST: { month: 7, year: 0 } },
    }),
  }));
};

const SLUGS = ['claude', 'cli', 'start'] as const;
const pageOf = (m: Mods, slug: (typeof SLUGS)[number]) =>
  ({ claude: m.pages.CLAUDE_PAGE, cli: m.pages.CLI_PAGE, start: m.pages.START_PAGE })[slug];

const views: Array<{ unmount: () => void }> = [];
const renderPage = async (m: Mods, slug: (typeof SLUGS)[number]) => {
  let view!: ReturnType<typeof render>;
  await m.rtl.act(async () => {
    view = m.rtl.render(m.React.createElement(m.landing.AdLanding, { page: pageOf(m, slug) }));
  });
  views.push(view);
  return view;
};

describe.each(SLUGS)('/%s', (slug) => {
  it('opens on the ads\' outcome, with the real-run video loaded only on play', async () => {
    const m = load(RUPEES_ONLY);
    const { container } = await renderPage(m, slug);
    expect(container.querySelector('h1')!.textContent).toBe('We gave Claude one sentence. It drafted a week of posts.');
    const video = container.querySelector('video')!;
    expect(video.getAttribute('preload')).toBe('none');
    expect(video.getAttribute('poster')).toBe('/video/hookpost-claude-run-9x16.jpg');
    expect(container.querySelector('video source')!.getAttribute('src')).toBe('/video/hookpost-claude-run-9x16.mp4');
    expect(container.querySelector('figcaption')!.textContent).toContain('replayed from its log');
  });

  it('one call to action, "Get 3 free posts", carrying the ad\'s utm tags to /auth', async () => {
    const m = load(RUPEES_ONLY);
    window.history.replaceState({}, '', `/${slug}?utm_source=meta&utm_campaign=hp_ww&fbclid=IwAR1&x=keep-out`);
    const { getAllByTestId } = await renderPage(m, slug);
    const ctas = getAllByTestId('trial-cta');
    expect(new Set(ctas.map((a) => a.textContent))).toEqual(new Set(['Get 3 free posts']));
    for (const a of ctas) {
      expect(a.getAttribute('href')).toBe('/auth?utm_source=meta&utm_campaign=hp_ww&fbclid=IwAR1');
    }
    window.history.replaceState({}, '', '/');
  });

  it('a click id in this URL goes to /auth whole (a 200-character fbclid)', async () => {
    const m = load(RUPEES_ONLY);
    const fbclid = `IwZXh0bgNhZW0BMABhZGlk_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);
    window.history.replaceState({}, '', `/${slug}?utm_source=meta&fbclid=${fbclid}`);
    const { getAllByTestId } = await renderPage(m, slug);
    for (const a of getAllByTestId('trial-cta')) {
      expect(new URL(a.getAttribute('href')!, 'https://hookpost.hookstep.in').searchParams.get('fbclid')).toBe(fbclid);
    }
    window.history.replaceState({}, '', '/');
  });

  it('from the first touch (hp_attr) only the utm tags go to /auth, never its click ids', async () => {
    const m = load(RUPEES_ONLY);
    // The ad opened /claude; the visitor moved on to this page, whose URL has no tags.
    window.history.replaceState(
      {},
      '',
      '/claude?utm_source=meta&utm_campaign=hp_ww&fbclid=IwAR-earlier&gclid=G-earlier&ttclid=T-earlier&msclkid=M-earlier'
    );
    // eslint-disable-next-line no-new-func
    new Function(ATTRIBUTION_CAPTURE_SCRIPT)();
    expect(document.cookie).toContain('fbclid');
    window.history.replaceState({}, '', `/${slug}`);
    const { getAllByTestId } = await renderPage(m, slug);
    for (const a of getAllByTestId('trial-cta')) {
      expect(a.getAttribute('href')).toBe('/auth?utm_source=meta&utm_campaign=hp_ww');
    }
    window.history.replaceState({}, '', '/');
  });

  it("a tagged URL's own tags go to /auth as one set: nothing mixed in from the first touch", async () => {
    const m = load(RUPEES_ONLY);
    window.history.replaceState({}, '', '/claude?utm_source=meta&utm_campaign=first&fbclid=IwAR-earlier');
    // eslint-disable-next-line no-new-func
    new Function(ATTRIBUTION_CAPTURE_SCRIPT)();
    // A Google click now: Meta's utm_source from the first touch must not ride along.
    window.history.replaceState({}, '', `/${slug}?utm_campaign=second&gclid=G-now`);
    const { getAllByTestId } = await renderPage(m, slug);
    for (const a of getAllByTestId('trial-cta')) {
      expect(a.getAttribute('href')).toBe('/auth?utm_campaign=second&gclid=G-now');
    }
    window.history.replaceState({}, '', '/');
  });

  it('a URL with only a click id carries just that click id', async () => {
    const m = load(RUPEES_ONLY);
    window.history.replaceState({}, '', '/claude?utm_source=meta&utm_campaign=first');
    // eslint-disable-next-line no-new-func
    new Function(ATTRIBUTION_CAPTURE_SCRIPT)();
    window.history.replaceState({}, '', `/${slug}?gclid=G-only`);
    const { getAllByTestId } = await renderPage(m, slug);
    for (const a of getAllByTestId('trial-cta')) {
      expect(a.getAttribute('href')).toBe('/auth?gclid=G-only');
    }
    window.history.replaceState({}, '', '/');
  });

  it('the terms sit right under the button: $7, billed monthly, no rupee figure', async () => {
    const m = load(RUPEES_ONLY);
    const { getByTestId } = await renderPage(m, slug);
    const shown = `$${m.pricing.HOOKPOST_PRICE.displayUsd}`;
    expect(getByTestId('trial-terms').textContent).toContain(
      `3 free posts, no card needed. Then Hookpost, ${shown} a month, billed monthly.`
    );
    expect(getByTestId('trial-terms').textContent).not.toMatch(/₹|in India/);
  });

  it.each(['INR', 'USD'] as const)(
    'with the dollar switches on, a visitor the context bills in %s reads the same $7 terms, at once',
    async (currency) => {
      const m = load(PRODUCTION);
      pricingContext(currency);
      const { getByTestId, queryAllByTestId } = await renderPage(m, slug);
      // No waiting on the context and no skeleton: one version for everyone.
      expect(queryAllByTestId('trial-terms-skeleton')).toHaveLength(0);
      expect(getByTestId('trial-terms').textContent).toContain('3 free posts, no card needed. Then Hookpost, $7 a month');
      expect(getByTestId('trial-terms').textContent).not.toMatch(/₹|UPI|20%|first month|in India/);
    }
  );

  it('names only the networks that published, and the competitor prices in competitor-facts.ts', async () => {
    const m = load(PRODUCTION);
    const { getByTestId } = await renderPage(m, slug);
    expect(getByTestId('published-networks').textContent).toContain(
      `In the 30 days to ${m.networks.PUBLISHED_CHECKED}, Hookpost published posts to ${m.networks.publishedList}.`
    );
    const rows = [...getByTestId('price-table').querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((c) => c.textContent)
    );
    const f = m.facts.COMPETITOR_FACTS;
    expect(rows).toEqual([
      ['Hootsuite', f.hootsuite.cheapestPaid!.name, '$99 per user a month, billed yearly', '10'],
      ['Sprout Social', f['sprout-social'].cheapestPaid!.name, '$79 per user a month, billed yearly', '5'],
      ['Buffer', f.buffer.cheapestPaid!.name, '$5 per channel a month, billed yearly', '1'],
      ['Postiz', f.postiz.cheapestPaid!.name, '$23 a month, billed yearly', '5'],
      ['Hookpost', 'Hookpost', '$7 a month, billed monthly', '20'],
    ]);
    expect(rows[0][2]).toContain(String(f.hootsuite.cheapestPaid!.price));
    expect(rows[4][2]).toContain(`$${m.pricing.HOOKPOST_PRICE.displayUsd}`);
    expect(rows[4][2]).not.toMatch(/₹|in India/);
    expect(rows[4][2]).not.toMatch(/a year/);
    expect(rows[4][3]).toBe(String(m.pricing.pricingINR.HOOKPOST.channel));
  });

  it('one billing story on the page: billed monthly only, in the table and in the terms under the button', async () => {
    const m = load(PRODUCTION);
    pricingContext('INR');
    const { container, getByTestId } = await renderPage(m, slug);
    await m.rtl.waitFor(() => expect(getByTestId('trial-terms').textContent).toContain('Hookpost, $7 a month'));
    expect(container.textContent).not.toMatch(/month to month/i);
    expect(getByTestId('price-table').textContent).toContain('billed monthly');
    expect(getByTestId('trial-terms').textContent).toContain('billed monthly');
    // No yearly price anywhere on the page.
    expect(getByTestId('price-table').textContent).not.toMatch(/a year\b.*Hookpost|₹5,990/);
    expect(getByTestId('trial-terms').textContent).not.toMatch(/a year|yearly/i);
    // The dollar switches change nothing: the same row either way.
    const r = load(RUPEES_ONLY);
    expect(r.landing.priceRows()[4].price).toBe('$7 a month, billed monthly');
    expect(m.landing.priceRows()[4].price).toBe('$7 a month, billed monthly');
  });

  it('structured data: the video, and one offer at the HOOKPOST_PRICE $7, no rupee offer', () => {
    const m = load(PRODUCTION);
    const ld = m.landing.adJsonLd(pageOf(m, slug));
    const node = (type: string) => ld['@graph'].find((n: any) => n['@type'] === type) as any;
    expect(node('WebPage').url).toBe(`https://hookpost.hookstep.in/${slug}`);
    expect(node('VideoObject')).toMatchObject({
      contentUrl: 'https://hookpost.hookstep.in/video/hookpost-claude-run-9x16.mp4',
      thumbnailUrl: 'https://hookpost.hookstep.in/video/hookpost-claude-run-9x16.jpg',
      duration: 'PT27S',
    });
    const offers = node('SoftwareApplication').offers;
    expect(offers).toEqual(
      expect.objectContaining({ price: String(m.pricing.HOOKPOST_PRICE.displayUsd), priceCurrency: 'USD' })
    );
    expect(JSON.stringify(offers)).not.toMatch(/INR|ineligibleRegion|eligibleRegion/);
  });

  it('metadata: canonical to itself, the poster as its image', () => {
    const m = load(PRODUCTION);
    const meta = m.landing.adMetadata(pageOf(m, slug)) as any;
    expect(meta.alternates.canonical).toBe(`https://hookpost.hookstep.in/${slug}`);
    expect(meta.openGraph.url).toBe(`https://hookpost.hookstep.in/${slug}`);
    expect(meta.openGraph.images[0].url).toBe('https://hookpost.hookstep.in/video/hookpost-claude-run-9x16.jpg');
  });

  it('says nothing it may not: no ChatGPT, no open source, no "I built" or unattributed "I", no "N-day" length, no free plan offer', async () => {
    const m = load(PRODUCTION);
    pricingContext('INR');
    const { container } = await renderPage(m, slug);
    await m.rtl.waitFor(() => expect(container.textContent).toContain('3 free posts, no card needed'));
    // A line break after every block, so a heading and the paragraph after it
    // are not read as one sentence (check-free-claims reads built HTML that way).
    container
      .querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,div,section,summary,dt,dd,td,th,a,button,figcaption')
      .forEach((el) => el.append('\n'));
    const text = [container.textContent, JSON.stringify(m.landing.adJsonLd(pageOf(m, slug))), pageOf(m, slug).description].join(' ');
    expect(text).not.toMatch(/ChatGPT|open[- ]source|\bI built\b|Stripe/i);
    // The page names no one as "I" (the site credits Mohan Bhanushali).
    expect(text).not.toMatch(/(^|[\s"“(])I (gave|built|made|asked|wrote|ran)\b/);
    // No time trial for new users (28 Oct 2026): no "3-day trial" or any other.
    expect(text.match(/\b\d+-day\b/g) || []).toEqual([]);
    expect(text).toContain('3 free posts, no card needed');
    expect(text).not.toMatch(/₹0 today|24 hours before/);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkText, loadAllow } = require('../../../../../../scripts/check-free-claims.js');
    expect(checkText(slug, text.split(/\n+|(?<=[.!?])\s+/), loadAllow())).toEqual([]);
  });

  it('is listed in the sitemap, llms.txt and the proxy\'s public routes', () => {
    expect(fs.readFileSync(path.join(SRC, 'app/sitemap.ts'), 'utf8')).toContain(`page('/${slug}',`);
    expect(fs.readFileSync(path.join(SRC, 'llms/llms.txt'), 'utf8')).toContain(`(https://hookpost.hookstep.in/${slug})`);
    expect(fs.readFileSync(path.join(SRC, 'proxy.ts'), 'utf8')).toContain(`nextUrl.pathname.startsWith('/${slug}')`);
  });
});

describe('the video files', () => {
  it('ship as small static files', () => {
    const video = fs.statSync(path.join(PUBLIC, 'video/hookpost-claude-run-9x16.mp4')).size;
    const poster = fs.statSync(path.join(PUBLIC, 'video/hookpost-claude-run-9x16.jpg')).size;
    expect(video).toBeLessThan(2.5 * 1024 * 1024);
    expect(poster).toBeLessThan(60 * 1024);
  });
});
