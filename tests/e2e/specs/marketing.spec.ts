/**
 * The public site as an anonymous visitor (or a crawler) gets it from the
 * production build: every sitemap URL, the pricing page against the plan
 * limits the backend enforces, the free tools, the crawler files, and the
 * redirects that keep the signed-in app out of search results.
 */
import { expect, test } from '@playwright/test';
import { pricingINR } from '../../../libraries/nestjs-libraries/src/database/prisma/subscriptions/pricing';
import { FREE_POST_LIMIT, MEDIA_RETENTION_POLICY } from '../../../libraries/nestjs-libraries/src/database/prisma/subscriptions/trial.policy';
import { FIRST_MONTH_OFFER_PERCENT } from '../../../libraries/nestjs-libraries/src/services/first.month.offer';
import { failOnServerErrors } from './support';

const CANONICAL = 'https://hookpost.hookstep.in';
// /download: the hero shows one of its five platform buttons, plus four platform sign-up links (Mac, Windows, phone, web).
const DOWNLOAD_SIGNUP_BUTTONS = 5;

test.describe('sitemap: every URL is indexable', () => {
  test('each sitemap URL answers 200 with a title, no noindex, canonical to itself, valid JSON-LD', async ({
    request,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    const urls = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(80);

    const problems: string[] = [];
    for (const url of urls) {
      const path = url.replace(CANONICAL, '') || '/';
      const res = await request.get(path, { maxRedirects: 0 });
      if (res.status() !== 200) {
        problems.push(`${path}: HTTP ${res.status()} ${res.headers()['location'] || ''}`);
        continue;
      }
      const html = await res.text();
      if (!/<title>[^<]{3,}<\/title>/.test(html)) problems.push(`${path}: no <title>`);
      const robots = [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/g)].map((m) => m[0]).join(' ');
      if (/noindex/i.test(robots)) problems.push(`${path}: noindex`);
      const canonical = html.match(/<link[^>]+rel="canonical"[^>]*href="([^"]+)"/)?.[1];
      if (canonical && canonical.replace(/\/$/, '') !== url.replace(/\/$/, '')) {
        problems.push(`${path}: canonical is ${canonical}`);
      }
      for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
        try {
          JSON.parse(m[1]);
        } catch {
          problems.push(`${path}: JSON-LD does not parse`);
        }
      }
    }
    expect(problems, `checked ${urls.length} URLs on ${baseURL}`).toEqual([]);
  });
});

test.describe('pricing page', () => {
  test('prices, limits and seat numbers are the ones the backend enforces', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await page.goto('/pricing');
    const table = page.locator('table').filter({ hasText: 'Team members' }).first();
    await expect(table).toBeVisible();
    const rows = await table.locator('tr').evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => (c.textContent || '').trim()))
    );
    const header = rows[0];
    const col = (name: string) => header.findIndex((h) => h.toLowerCase().startsWith(name.toLowerCase()));
    const num = (s: string) => Number(s.replace(/[^\d]/g, ''));
    for (const tier of ['STANDARD', 'PRO'] as const) {
      const plan = pricingINR[tier];
      const row = rows.find((r) => r[0].toUpperCase() === tier);
      expect(row, `${tier} row`).toBeDefined();
      expect(num(row![col('Price')])).toBe(plan.month_price);
      expect(num(row![col('Channels')])).toBe(plan.channel);
      expect(num(row![col('Posts')])).toBe(plan.posts_per_month);
      expect(num(row![col('AI text')])).toBe(plan.ai_generation_count);
      expect(num(row![col('AI images')])).toBe(plan.image_generation_count);
      expect(num(row![col('Webhooks')])).toBe(plan.webhooks);
      expect(num(row![col('Team members')])).toBe(plan.team_member_limit);
    }
    // Pro has a seat cap; "unlimited" was printed once and had to be refunded.
    await expect(page.getByText(`Up to ${pricingINR.PRO.team_member_limit} team members`).first()).toBeVisible();
    await expect(page.getByText(/unlimited team members/i)).toHaveCount(0);

    // The structured data offers the same prices.
    const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).join(' ');
    expect(ld).toContain(`"price":"${pricingINR.STANDARD.month_price}"`);
    expect(ld).toContain(`"price":"${pricingINR.PRO.month_price}"`);
    errors.assertNone();
  });

  test('the free-posts build offers the free posts, never a Free plan or a time trial, and links to sign-up', async ({ page }) => {
    await page.goto('/pricing');
    // New sign-ups: FREE_POST_LIMIT free posts, then pay (trial-offer.ts, TRIAL_CTA).
    const cta = page.getByRole('link', { name: `Get ${FREE_POST_LIMIT} free posts`, exact: true }).first();
    await expect(cta).toHaveAttribute('href', '/auth');
    await expect(page.getByRole('link', { name: /Start \d+-day trial/i })).toHaveCount(0);

    // Hookpost's own offer only: the competitor FAQ rightly says Buffer "also
    // has a free plan", so the whole page cannot be searched for the words.
    const table = page.locator('table').filter({ hasText: 'Team members' }).first();
    const plans = (await table.locator('tbody th[scope="row"]').allTextContents()).map((s) => s.trim());
    expect(plans.length).toBeGreaterThan(0);
    expect(plans.filter((p) => /free/i.test(p))).toEqual([]);
    await expect(table.getByText(/^Free$/)).toHaveCount(0);

    const graph = (await page.locator('script[type="application/ld+json"]').allTextContents()).flatMap(
      (t) => (JSON.parse(t)['@graph'] as any[]) ?? []
    );
    const product = graph.find((n) => n['@type'] === 'Product');
    const aggregates = [product?.offers].flat().filter(Boolean);
    expect(aggregates.length).toBeGreaterThan(0);
    for (const agg of aggregates) {
      expect(Number(agg.lowPrice)).toBeGreaterThan(0);
      for (const o of agg.offers) {
        expect(Number(o.price), o.name).toBeGreaterThan(0);
        expect(o.name).not.toMatch(/free/i);
      }
    }
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    const questions: string[] = (faq?.mainEntity ?? []).map((q: any) => q.name);
    expect(questions.length).toBeGreaterThan(0);
    expect(questions.filter((q) => /free plan/i.test(q))).toEqual([]);
  });
});

test.describe('home and landing pages', () => {
  test('home: a sign-up CTA and a login link, no server errors', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await page.goto('/');
    await expect(page).toHaveTitle(/Hookpost/);
    await expect(
      page.getByRole('link', { name: `Get ${FREE_POST_LIMIT} free posts`, exact: true }).first()
    ).toHaveAttribute('href', '/auth');
    await expect(page.getByRole('link', { name: /Start \d+-day trial/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Log in' }).first()).toHaveAttribute('href', '/auth/login');
    errors.assertNone();
  });

  test('legal pages Razorpay and Play review need are public', async ({ request }) => {
    for (const path of ['/privacy', '/terms', '/refund-policy', '/cancellation-policy', '/shipping-policy', '/data-deletion', '/contact']) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status(), path).toBe(200);
    }
  });

  test('privacy, terms and cancellation policy state the media retention rule the run carries out', async ({ page }) => {
    for (const path of ['/privacy', '/terms', '/cancellation-policy']) {
      await page.goto(path);
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      expect(body, path).toContain(MEDIA_RETENTION_POLICY);
    }
  });
});

test.describe('free tools', () => {
  test('character counter counts as you type, the way X counts', async ({ page }) => {
    await page.goto('/tools/character-counter');
    const box = page.getByPlaceholder('Write your post here...');
    await box.fill('Hello 👋 https://hookstep.in');
    await expect(page.getByText(/^\s*\d+ characters/).first()).toBeVisible();
    // 6 + emoji (2) + space (1) + link (23) = 32 on X: 248 left of 280.
    await expect(page.getByText('248', { exact: false }).first()).toBeVisible();
  });

  test('thread splitter splits a long text into numbered posts', async ({ page }) => {
    await page.goto('/tools/thread-splitter');
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    await page.locator('textarea').first().fill(text);
    await expect(page.getByText(/\b1\/[2-9]\b/).first()).toBeVisible();
  });
});

test.describe('India calendar downloads', () => {
  test('the CSV and the .ics linked from the page download', async ({ page, request }) => {
    await page.goto('/social-media-calendar-india');
    for (const ext of ['csv', 'ics']) {
      const href = await page.locator(`a[href$=".${ext}"]`).first().getAttribute('href');
      const res = await request.get(href!);
      expect(res.status(), href!).toBe(200);
      const body = await res.text();
      expect(body).toContain(ext === 'csv' ? 'Date,Weekday,Occasion' : 'BEGIN:VCALENDAR');
    }
  });
});

test.describe('routing for anonymous visitors and crawlers', () => {
  test('an unknown URL is a 404 page, not a redirect to sign-up', async ({ request }) => {
    const res = await request.get('/no-such-page-e2e', { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });

  test('the signed-in app sends a visitor to /auth; /billing comes back after login', async ({ request }) => {
    const launches = await request.get('/launches', { maxRedirects: 0 });
    expect(launches.status()).toBe(307);
    expect(launches.headers()['location']).toMatch(/\/auth/);
    const billing = await request.get('/billing', { maxRedirects: 0 });
    expect(billing.headers()['location']).toMatch(/\/auth\/login\?returnUrl=%2Fbilling$/);
  });

  test('a capitalised marketing URL redirects once to the lowercase page', async ({ request }) => {
    const res = await request.get('/Pricing', { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers()['location']).toMatch(/\/pricing$/);
  });

  test('robots.txt, sitemap.xml, llms.txt and assetlinks.json are served', async ({ request }) => {
    const robots = await (await request.get('/robots.txt')).text();
    expect(robots).toContain('Sitemap: https://hookpost.hookstep.in/sitemap.xml');
    expect(robots).toContain('Disallow: /launches');
    expect((await request.get('/llms.txt')).status()).toBe(200);
    const links = await request.get('/.well-known/assetlinks.json');
    expect(links.status()).toBe(200);
    expect((await links.json())[0].target.package_name).toBe('in.hookstep.hookpost.twa');
  });

  // What AI assistants read about Hookpost, as this build serves it (a trial
  // cutoff set, rupees only, like production before the dollar rail). Prices
  // and limits are pricing.ts's; on 24 Oct 2026 an edit shipped Standard
  // "$9", Pro "$19", "unlimited channels", a Free plan and "Stripe/Paddle".
  test('llms.txt and llms-full.txt state pricing.ts prices and limits, and nothing false', async ({ request }) => {
    const { STANDARD, PRO } = pricingINR;
    const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;
    const llms = await request.get('/llms.txt');
    const full = await request.get('/llms-full.txt');
    expect(llms.status()).toBe(200);
    expect(full.status()).toBe(200);
    expect(llms.headers()['content-type']).toContain('text/plain');
    const llmsText = await llms.text();
    const fullText = await full.text();

    expect(llmsText).toContain(`Standard ${rupees(STANDARD.month_price)}, Pro ${rupees(PRO.month_price)}`);
    expect(llmsText).toContain(`Standard covers ${STANDARD.channel} channels and Pro covers ${PRO.channel}.`);
    expect(fullText).toContain(
      `- Standard (${rupees(STANDARD.month_price)}/month, or ${rupees(STANDARD.year_price)}/year): ${STANDARD.channel} channels,`
    );
    expect(fullText).toContain(`- Pro (${rupees(PRO.month_price)}/month): ${PRO.channel} channels,`);

    for (const text of [llmsText, fullText]) {
      // New workspaces: the free posts, then the first-month offer; no time trial.
      expect(text).toContain(
        `${FREE_POST_LIMIT} free posts, no card needed, then first month ${FIRST_MONTH_OFFER_PERCENT}% off (new customers) on a monthly plan`
      );
      expect(text).toMatch(/no time-limited trial/);
      // An "N-day trial" left is a competitor's (Hootsuite and Later's 14 days).
      for (const line of text.split('\n').filter((l) => /\d+[- ]day trial/.test(l))) {
        expect(line).toMatch(/Hootsuite and Later have no free plan \(\d+-day trials\)/);
      }
      expect(text).toMatch(/no free plan for new workspaces/);
      expect(text).not.toMatch(/There is a free plan|Free \(₹0\)|Free plan/);
      expect(text).not.toMatch(/unlimited/i);
      expect(text).not.toMatch(/Stripe|Paddle/i);
      expect(text).not.toMatch(/\$9\b|\branked\b/);
      expect(text).toMatch(/Razorpay/);
      // Since 26 Oct 2026: how ChatGPT connects, and that it was not yet
      // checked inside a ChatGPT account.
      expect(text).toContain('ChatGPT: add it as a custom MCP server');
      expect(text).toContain('https://hookpost.hookstep.in/mcp-oauth');
      expect(text).toMatch(/not yet inside a ChatGPT account/);
      expect(text).toContain('TikTok posts go out as private posts or TikTok inbox drafts');
      // Rupees only in this build: every dollar figure is a competitor's own
      // (Buffer's per-channel price, and since 28 Oct the Planable / Buffer /
      // Hootsuite comparison page's line), named just before it.
      const dollars = [...text.matchAll(/([^\n]{0,40})\$\d+/g)].map((m) => m[0]);
      for (const figure of dollars) expect(figure).toMatch(/(Buffer|Planable|Hootsuite)\b[^$]*\$\d+$/);
    }
  });
});

// 22 Oct 2026: 20% off the first month, said on /pricing for a visitor
// billed in rupees. Not on the homepage cards. In the free-posts build (a
// cutoff set, as in production) the free-posts note above the cards states
// it, so the separate offer line is not shown (PricingPlans.client.tsx:
// offerTerms is null when trialOnly).
test.describe('first-month offer', () => {
  test('/pricing: the free-posts note states the first-month offer, with no separate offer line', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await page.goto('/pricing');
    await expect(
      page.getByText(
        `${FREE_POST_LIMIT} free posts, no card needed. Then first month ${FIRST_MONTH_OFFER_PERCENT}% off (new customers).`,
        { exact: true }
      )
    ).toBeVisible();
    await expect(page.getByTestId('first-month-offer-line')).toHaveCount(0);
    errors.assertNone();
  });

  test('the homepage cards carry no offer line', async ({ page }) => {
    const answered = page.waitForResponse((r) => r.url().includes('/public/pricing-context'));
    await page.goto('/');
    await answered;
    await expect(page.getByText('Most chosen').first()).toBeVisible();
    await expect(page.getByTestId('first-month-offer-line')).toHaveCount(0);
  });
});

// 22 Oct 2026: Standard yearly at ₹5,990, from pricing.ts, on /pricing (cards,
// intro and FAQ) and in the homepage FAQ. Pro yearly is not advertised.
test.describe('yearly price', () => {
  test('/pricing: Standard yearly in rupees, on the card, in the intro and in the FAQ', async ({ page }) => {
    const errors = failOnServerErrors(page);
    await page.goto('/pricing');
    await expect(page.getByTestId('yearly-price')).toHaveText(
      `or ₹${pricingINR.STANDARD.year_price.toLocaleString('en-IN')}/year (2 months free)`
    );
    await expect(page.getByText('Paying yearly in rupees? Standard: ₹5,990/year (2 months free).')).toBeVisible();
    await expect(page.getByText('Is there a yearly plan?')).toBeVisible();
    expect(await page.content()).not.toContain('19,990');
    errors.assertNone();
  });

  // Billing sandbox s2 (rupees) and s14 (dollars): cancel stops Razorpay at
  // once and the plan keeps its paid time, so the cards can say it.
  test('/pricing: the cards say Cancel anytime and what it means', async ({ page }) => {
    await page.goto('/pricing');
    await expect(
      page.getByText('Cancel anytime: your plan runs to the end of the period you paid for.')
    ).toBeVisible();
  });

  test('the homepage FAQ names Standard yearly, and no longer says "billed month to month"', async ({ page }) => {
    await page.goto('/');
    const html = await page.content();
    expect(html).toContain('Paying yearly? Standard: ₹5,990/year (2 months free).');
    expect(html).not.toContain('billed month to month');
  });
});

// 22 Oct 2026: the affiliate commission runs for the lifetime of the referred
// subscription (affiliate.terms.ts); cookie, payout floor and coupon unchanged.
test.describe('affiliate terms', () => {
  test('/affiliates: 30% for the lifetime of the subscription, no 12-month limit', async ({ page }) => {
    await page.goto('/affiliates');
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    expect(text).toContain('of every payment, for the lifetime of the subscription');
    expect(text).toContain('for as long as they stay subscribed');
    expect(text).toContain('60 days');
    expect(text).toMatch(/₹1,000/);
    expect(text).toContain('10% off');
    expect(text).not.toMatch(/12 months|for a year|first \d+ months/);
  });

  test('llms.txt states the lifetime terms', async ({ request }) => {
    const body = await (await request.get('/llms.txt')).text();
    expect(body).toContain('[Affiliate programme](https://hookpost.hookstep.in/affiliates): 30% of every payment, for the lifetime of each subscription you refer');
  });
});

// 2 Nov 2026 UI sweep: every button on /download went to /auth/signup, a
// route that does not exist (404 in production). They go to /auth, like every
// other marketing CTA; the visit's landing_path already records /download.
test.describe('/download', () => {
  test('no link to /auth/signup; the sign-up buttons open /auth, which exists', async ({ page, request }) => {
    await page.goto('/download');
    await expect(page.locator('a[href^="/auth/signup"]')).toHaveCount(0);
    // The platform hero's button plus the four platform links.
    await expect(page.locator('main a[href="/auth"]')).toHaveCount(DOWNLOAD_SIGNUP_BUTTONS);
    expect((await request.get('/auth', { maxRedirects: 0 })).status()).toBeLessThan(400);
  });
});
