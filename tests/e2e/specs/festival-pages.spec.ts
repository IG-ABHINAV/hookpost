/**
 * The India festival pages, the redirects for URLs assistants guess, and the
 * schema added to /alternatives/mixpost and /guides, as a crawler and a phone
 * get them from the production build. Static pages only: these need the
 * frontend, not the backend.
 */
import { expect, test } from '@playwright/test';
import { FESTIVALS, rowFor } from '../../../apps/frontend/src/app/(landing)/social-media-calendar-india/festivals';

const SITE = 'https://hookpost.hookstep.in';
const HUB = '/social-media-calendar-india';

const jsonLdNodes = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]))
    .flatMap((g) => g['@graph'] ?? [g]);

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

for (const f of FESTIVALS) {
  const path = `${HUB}/${f.slug}`;
  test.describe(path, () => {
    test('server HTML: H1, the DoPT date, canonical to itself, indexable, Article + breadcrumb', async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toMatch(/<h1[^>]*>[\s\S]{10,}?<\/h1>/);
      expect(html).toContain(longDate(rowFor(f.main).date));
      expect(html).toContain(`<title>${f.title.replace(/&/g, '&amp;')}</title>`);

      const canonical = html.match(/<link[^>]+rel="canonical"[^>]*href="([^"]+)"/)?.[1];
      expect(canonical).toBe(`${SITE}${path}`);
      const robots = [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/g)].map((m) => m[0]).join(' ');
      expect(robots).not.toMatch(/noindex/i);

      const nodes = jsonLdNodes(html);
      expect(nodes.find((n) => n['@type'] === 'Article')?.mainEntityOfPage).toBe(`${SITE}${path}`);
      const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList');
      expect(crumbs?.itemListElement?.map((i: { item: string }) => i.item)).toEqual([
        `${SITE}/`,
        `${SITE}${HUB}`,
        `${SITE}${path}`,
      ]);
    });

    test('every internal link on the page answers 200', async ({ request }) => {
      const html = await (await request.get(path)).text();
      const main = html.slice(html.indexOf('<h1'));
      const hrefs = [...new Set([...main.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]))];
      expect(hrefs).toContain(HUB);
      const bad: string[] = [];
      for (const href of hrefs) {
        if (href === '/auth') continue;
        const r = await request.get(href, { maxRedirects: 0 });
        if (r.status() !== 200) bad.push(`${href}: ${r.status()}`);
      }
      expect(bad).toEqual([]);
    });
  });
}

test('the hub links to all five festival pages', async ({ request }) => {
  const html = await (await request.get(HUB)).text();
  for (const f of FESTIVALS) expect(html).toContain(`href="${HUB}/${f.slug}"`);
});

test('an unknown festival slug is a 404, not an empty page', async ({ request }) => {
  for (const slug of ['diwali-2031', 'holi-2027x']) {
    const res = await request.get(`${HUB}/${slug}`, { maxRedirects: 0 });
    expect({ slug, status: res.status() }).toEqual({ slug, status: 404 });
  }
  // Upper case is the site-wide lower-casing redirect to the real page.
  const upper = await request.get(`${HUB}/DIWALI-2026`, { maxRedirects: 0 });
  expect(upper.status()).toBe(308);
  expect(new URL(upper.headers()['location'], SITE).pathname).toBe(`${HUB}/diwali-2026`);
  // An encoded traversal is normalised by Next (a 308 to the lower-case
  // escape) and then still 404s: it never serves another page.
  const res = await request.get(`${HUB}/..%2Fabout`);
  expect(res.status()).toBe(404);
  expect(res.url()).toContain('/social-media-calendar-india/');
});

test('festival pages fit a phone without sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const f of FESTIVALS) {
    await page.goto(`${HUB}/${f.slug}`);
    await expect(page.locator('h1')).toBeVisible();
    const pastEdge = await page.evaluate(() => {
      const vw = window.innerWidth;
      return [...document.querySelectorAll('main *, article *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (!r.width || (r.right <= vw + 1 && r.left >= -1)) return false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const o = getComputedStyle(p).overflowX;
            if (o === 'auto' || o === 'scroll') return false;
          }
          return true;
        })
        .map((el) => el.tagName);
    });
    expect({ slug: f.slug, pastEdge }).toEqual({ slug: f.slug, pastEdge: [] });
  }
});

test.describe('guessed URLs redirect permanently to real pages', () => {
  for (const [from, to] of [
    ['/for-agencies', '/for/agencies'],
    ['/for-b2b-saas', '/for/b2b-saas'],
    ['/docs', '/docs/public-api'],
    ['/blog', '/guides'],
  ]) {
    test(`${from} -> ${to}`, async ({ request }) => {
      const res = await request.get(from, { maxRedirects: 0 });
      expect([301, 308]).toContain(res.status());
      expect(new URL(res.headers()['location'], SITE).pathname).toBe(to);
      expect((await request.get(to, { maxRedirects: 0 })).status()).toBe(200);
    });
  }

  test('a /for- slug that is not a role is still a 404', async ({ request }) => {
    expect((await request.get('/for-nobody', { maxRedirects: 0 })).status()).toBe(404);
  });
});

test('/alternatives/mixpost declares a breadcrumb and an FAQPage that matches its visible FAQ', async ({ request }) => {
  const html = await (await request.get('/alternatives/mixpost')).text();
  const nodes = jsonLdNodes(html);
  expect(nodes.some((n) => n['@type'] === 'BreadcrumbList')).toBe(true);
  const faq = nodes.find((n) => n['@type'] === 'FAQPage');
  expect(faq?.mainEntity?.length).toBeGreaterThan(0);
  for (const q of faq.mainEntity) expect(html).toContain(String(q.name).replace(/'/g, '&#x27;').slice(0, 30));
});

test('/guides declares a CollectionPage whose parts are guides that answer 200', async ({ request }) => {
  const html = await (await request.get('/guides')).text();
  const coll = jsonLdNodes(html).find((n) => n['@type'] === 'CollectionPage');
  expect(coll?.hasPart?.length).toBeGreaterThan(0);
  for (const part of coll.hasPart) {
    const url = new URL(part.url ?? part['@id']);
    expect(url.pathname.startsWith('/guides/')).toBe(true);
    expect((await request.get(url.pathname, { maxRedirects: 0 })).status()).toBe(200);
  }
});

test('the overstated claims are gone from /about and the homepage', async ({ request }) => {
  const about = await (await request.get('/about')).text();
  expect(about).not.toContain('Unlike Western tools');
  expect(about).toContain('Hookpost bills in rupees through Razorpay');
  const home = await (await request.get('/')).text();
  expect(home).not.toContain('multi-agent AI social media management');
  expect(home).not.toContain('Direct Answer &amp; Technical Specifications');
});
