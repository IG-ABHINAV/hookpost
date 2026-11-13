/**
 * Marketing pages on phones: nothing runs off the right edge, and the
 * header's two buttons stay on screen. Runs in the phone projects
 * (playwright.config.ts: iphone, iphone-se, android).
 *
 * Found on 31 Oct 2026 at 320px: a header copied into 22 pages was 2px too
 * wide (its button text wrapped instead), and the /mcp server cards ran 36px
 * off screen because an unbreakable URL in <code> set their width.
 */
import { expect, test } from '@playwright/test';

const ROUTES = [
  '/',
  '/pricing',
  '/mcp',
  '/about',
  '/alternatives',
  '/alternatives/buffer',
  '/channels',
  '/docs/public-api',
  '/docs/oauth',
  '/download',
  '/for',
  '/privacy',
  '/terms',
  '/vs/buffer',
];

test.describe('marketing pages on a phone', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'phone projects only');
  });

  for (const path of ROUTES) {
    test(`${path}: nothing off the right edge`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(400);
      const offscreen = await page.evaluate(() => {
        const vw = window.innerWidth;
        // Inside a box that itself fits and clips or scrolls (a code block,
        // a carousel) is fine.
        const contained = (el: Element) => {
          for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== 'visible') {
              return p.getBoundingClientRect().right <= vw + 1;
            }
          }
          return false;
        };
        return [...document.querySelectorAll('body *')]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.right > vw + 1 && !contained(el);
          })
          .slice(0, 5)
          .map((el) => `${el.tagName} "${(el.textContent || '').trim().slice(0, 40)}" ${Math.round(el.getBoundingClientRect().right)}`);
      });
      expect(offscreen).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()!.width
      );
    });
  }

  test('the shared page header keeps Log In and the sign-up button on screen', async ({ page }) => {
    await page.goto('/about');
    const vw = page.viewportSize()!.width;
    for (const href of ['/auth/login', '/auth']) {
      const box = (await page.locator(`a[href="${href}"]`).first().boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(vw);
      // One line: the button text used to wrap at 375px.
      expect(box.height).toBeLessThan(48);
    }
    await expect(page.getByRole('link', { name: 'Hookpost home' }).first()).toBeVisible();
  });
});
