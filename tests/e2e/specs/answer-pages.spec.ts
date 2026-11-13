/**
 * The answer pages (apps/frontend/src/app/(landing)/guides/_answer) as a
 * crawler and a phone get them from the production build: the H1, the direct
 * answer and the FAQPage JSON-LD are in the server HTML before any JavaScript
 * runs, the page is indexable and canonical to itself, every internal link on
 * it answers 200, and nothing scrolls sideways at 375px.
 *
 * Static pages only: these need the frontend, not the backend.
 */
import { expect, test } from '@playwright/test';
import { ANSWER_PAGES, SITE } from '../../../apps/frontend/src/app/(landing)/guides/_answer/answer-pages';

for (const { path } of ANSWER_PAGES) {
  test.describe(path, () => {
    test('server HTML has the H1, the answer, a dated "Last updated" and FAQPage JSON-LD', async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      const html = await res.text();

      expect(html).toMatch(/<h1[^>]*>[^<]{10,}<\/h1>/);
      const answer = html.match(/<p[^>]*data-answer[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
      expect(answer.replace(/<[^>]+>/g, '')).toContain('Hookpost by Hookstep');
      expect(html).toMatch(/<time dateTime="\d{4}-\d{2}-\d{2}">Last updated \d{1,2} \w+ \d{4}<\/time>/);

      const canonical = html.match(/<link[^>]+rel="canonical"[^>]*href="([^"]+)"/)?.[1];
      expect(canonical).toBe(`${SITE}${path}`);
      const robots = [...html.matchAll(/<meta[^>]+name="robots"[^>]*>/g)].map((m) => m[0]).join(' ');
      expect(robots).not.toMatch(/noindex|nosnippet/i);
      expect(res.headers()['x-robots-tag'] ?? '').not.toMatch(/noindex|nosnippet/i);

      const graphs = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) =>
        JSON.parse(m[1])
      );
      const nodes = graphs.flatMap((g) => g['@graph'] ?? [g]);
      const faq = nodes.find((n) => n['@type'] === 'FAQPage');
      expect(faq?.mainEntity?.length).toBeGreaterThanOrEqual(5);
      const article = nodes.find((n) => n['@type'] === 'TechArticle');
      expect(article?.url).toBe(`${SITE}${path}`);
      // Every FAQ question in the markup is on the page too.
      for (const q of faq.mainEntity) expect(html).toContain(String(q.name).replace(/'/g, '&#x27;').slice(0, 30));
    });

    test('every internal link on the page answers 200', async ({ request }) => {
      const html = await (await request.get(path)).text();
      const main = html.slice(html.indexOf('<article'));
      const hrefs = [...new Set([...main.matchAll(/href="(\/[^"#?]*)/g)].map((m) => m[1]))];
      expect(hrefs.length).toBeGreaterThan(4);
      const bad: string[] = [];
      for (const href of hrefs) {
        if (href === '/auth') continue; // the sign-up button, outside the marketing site
        const res = await request.get(href, { maxRedirects: 0 });
        if (res.status() !== 200) bad.push(`${href}: ${res.status()}`);
      }
      expect(bad).toEqual([]);
    });

    test('no sideways scroll on a phone', async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      // The landing layout clips sideways overflow, so the page's scrollWidth
      // would hide a too-wide block. Check each element instead: nothing in
      // the article may reach past the viewport unless it sits in its own
      // scroll box (the comparison tables and code blocks).
      const pastEdge = await page.evaluate(() => {
        const vw = window.innerWidth;
        return [...document.querySelectorAll('article *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || (r.right <= vw + 1 && r.left >= -1)) return false;
            for (let a = el.parentElement; a && a.tagName !== 'ARTICLE'; a = a.parentElement) {
              const o = getComputedStyle(a).overflowX;
              if (o === 'auto' || o === 'scroll') return false;
            }
            return true;
          })
          .map((el) => `${el.tagName} ${(el.textContent || '').slice(0, 40)}`);
      });
      expect(pastEdge).toEqual([]);
    });
  });
}
