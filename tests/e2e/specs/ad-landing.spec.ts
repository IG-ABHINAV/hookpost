/**
 * The paid ads' landing pages, /claude, /cli and /start, from the production
 * build as an anonymous visitor gets them: public (no login wall), the ads'
 * headline, the video files served, one call to action whose terms sit under
 * it, and an ad's utm tags carried through to the sign-up.
 */
import { expect, test } from '@playwright/test';
import { FREE_POST_LIMIT } from '../../../libraries/nestjs-libraries/src/database/prisma/subscriptions/trial.policy';
import { FIRST_MONTH_OFFER_PERCENT } from '../../../libraries/nestjs-libraries/src/services/first.month.offer';
import { PASSWORD, control, failOnServerErrors, uniqueEmail, visitFrom } from './support';

const PAGES = ['/claude', '/cli', '/start'];

test.describe('ad landing pages', () => {
  for (const path of PAGES) {
    test(`${path}: public, the ads' headline, one CTA with the free-posts terms under it`, async ({ page, request }) => {
      const errors = failOnServerErrors(page);
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<link rel="canonical" href="https://hookpost.hookstep.in${path}"/>`);

      await visitFrom(page, 'IN');
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'We gave Claude one sentence. It drafted a week of posts.'
      );
      const ctas = page.getByTestId('trial-cta');
      // New sign-ups get FREE_POST_LIMIT free posts, then pay at checkout with
      // the first-month offer; no time trial (28 Oct 2026, trial-offer.ts).
      await expect(ctas.first()).toHaveText(`Get ${FREE_POST_LIMIT} free posts`);
      const terms = page.getByTestId('trial-terms');
      await expect(terms).toContainText(
        `${FREE_POST_LIMIT} free posts, no card needed. Then first month ${FIRST_MONTH_OFFER_PERCENT}% off (new customers) on a monthly plan`
      );
      await expect(terms).toContainText('Nothing is charged until you choose a plan, and the payment is taken at checkout.');
      await expect(terms).not.toContainText(/₹0 today|\d+-day trial/);
      // One billing story: monthly unless yearly, in the terms and the price table.
      await expect(page.getByTestId('trial-terms')).toContainText('billed monthly unless you choose yearly at checkout');
      await expect(page.getByTestId('price-table')).toContainText('billed monthly');
      expect(await page.content()).not.toMatch(/month to month/i);
      // The video waits for a tap.
      await expect(page.locator('video')).toHaveAttribute('preload', 'none');
      errors.assertNone();
    });
  }

  test('the video and its poster are served', async ({ request }) => {
    const mp4 = await request.get('/video/hookpost-claude-run-9x16.mp4', { headers: { range: 'bytes=0-1023' } });
    expect([200, 206]).toContain(mp4.status());
    expect(mp4.headers()['content-type']).toContain('video/mp4');
    const poster = await request.get('/video/hookpost-claude-run-9x16.jpg');
    expect(poster.status()).toBe(200);
    expect(poster.headers()['content-type']).toContain('image/jpeg');
  });

  test('listed in the sitemap and llms.txt', async ({ request }) => {
    const sitemap = await (await request.get('/sitemap.xml')).text();
    const llms = await (await request.get('/llms.txt')).text();
    for (const path of PAGES) {
      expect(sitemap).toContain(`<loc>https://hookpost.hookstep.in${path}</loc>`);
      expect(llms).toContain(`(https://hookpost.hookstep.in${path})`);
    }
  });

  test("from /claude to /cli: Start trial carries the utm tags, not the earlier click id, and the 200-character fbclid still reaches the workspace whole", async ({ page }) => {
    // As long as real Meta click ids (up to 201 characters in production's log).
    const fbclid = `IwZXh0bgNhZW0BMABhZGlk_e2e_cli_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);
    await visitFrom(page, 'IN');
    await page.goto(`/claude?utm_source=meta&utm_campaign=e2e_long_click&fbclid=${fbclid}`);
    // The visitor moves on; this URL has no tags, so the button reads the
    // first touch for its utm tags only: a click id in a fresh /auth URL
    // would look like a new click to Meta's pixel.
    await page.goto('/cli');
    const cta = page.getByTestId('trial-cta').first();
    await expect(cta).toHaveAttribute('href', '/auth?utm_source=meta&utm_campaign=e2e_long_click');
    await cta.click();
    await page.waitForURL(/\/auth\?/);
    expect(new URL(page.url()).searchParams.get('fbclid')).toBeNull();
    await page.waitForLoadState('networkidle');

    const email = uniqueEmail('ad-long-click');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);
    await expect.poll(() => control.attribution(email)).not.toBeNull();
    // The sign-up reads the click from the first-touch cookie, whole.
    expect(await control.attribution(email)).toMatchObject({
      utmCampaign: 'e2e_long_click',
      fbclid,
      landingPath: '/claude',
    });
    expect((await control.attribution(email))!.fbc).toMatch(new RegExp(`^fb\\.1\\.\\d+\\.${fbclid}$`));
  });

  test("a click id in the page's own URL goes to /auth whole", async ({ page }) => {
    const fbclid = `IwZXh0bgNhZW0BMABhZGlk_e2e_start_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);
    await visitFrom(page, 'IN');
    await page.goto(`/start?utm_source=meta&fbclid=${fbclid}`);
    const cta = page.getByTestId('trial-cta').first();
    await expect(cta).toHaveAttribute('href', /fbclid=/);
    expect(new URL((await cta.getAttribute('href'))!, 'http://x').searchParams.get('fbclid')).toBe(fbclid);
  });

  test("an ad's utm tags go with the sign-up: /claude → Start trial → the workspace's attribution", async ({ page }) => {
    await visitFrom(page, 'IN');
    await page.goto('/claude?utm_source=meta&utm_medium=paid_social&utm_campaign=e2e_claude_ad&utm_content=face_9x16');
    const cta = page.getByTestId('trial-cta').first();
    await expect(cta).toHaveAttribute(
      'href',
      '/auth?utm_source=meta&utm_medium=paid_social&utm_campaign=e2e_claude_ad&utm_content=face_9x16'
    );
    await cta.click();
    await page.waitForURL(/\/auth\?utm_source=meta/);
    await page.waitForLoadState('networkidle');

    const email = uniqueEmail('ad-claude');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);
    await expect.poll(() => control.attribution(email)).not.toBeNull();
    expect(await control.attribution(email)).toMatchObject({
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmCampaign: 'e2e_claude_ad',
      utmContent: 'face_9x16',
      landingPath: '/claude',
    });
  });
});
