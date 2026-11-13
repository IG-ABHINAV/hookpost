/**
 * Page weight of the production build. /auth, where every ad ends, was
 * 1.09MB of HTML: Next inlines a route's CSS twice (inlineCss), and the
 * (app) root layout gave it the whole app's sheet, a dead Blueprint 5 copy
 * and Uppy included. It now has its own sheet; the signed-in app still gets
 * the full one.
 */
import { expect, test } from '@playwright/test';
import { control, signUpViaApi } from './support';

const LIMIT = 200_000;

test.describe('page weight', () => {
  for (const path of ['/auth', '/auth/login', '/auth/forgot']) {
    test(`${path} HTML is under ${LIMIT / 1000} KB and carries no editor or uploader CSS`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(200);
      const html = await res.body();
      expect(html.byteLength).toBeLessThan(LIMIT);
      const text = html.toString('utf8');
      expect(text).not.toContain('.bp5-');
      expect(text).not.toContain('uppy-Dashboard');
      expect(text).not.toContain('--copilot-kit-primary-color');
      // Still styled: the theme's colour variables are inlined.
      expect(text).toContain('--new-bgColor');
    });
  }

  test('the signed-in app still loads the app stylesheets', async ({ page, context }) => {
    const { email } = await signUpViaApi(context);
    await control.givePlan(email);
    await page.goto('/launches');
    await page.waitForLoadState('networkidle');
    const css = await page.evaluate(() =>
      [...document.styleSheets]
        .map((s) => {
          try {
            return [...s.cssRules].map((r) => r.cssText).join('\n');
          } catch {
            return '';
          }
        })
        .join('\n')
    );
    // global.scss, react-tooltip and CopilotKit, via (app)/app-styles.ts.
    expect(css).toContain('.react-tags');
    expect(css).toContain('--rt-color-white');
    expect(css).toContain('--copilot-kit-primary-color');
  });
});
