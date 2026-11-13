/**
 * Sign-up attribution through a real browser: an ad's utm tags and click id,
 * recorded by the marketing page's inline script into the hp_attr cookie,
 * reach the new workspace's SignupAttribution row whether the visitor signs
 * up with email or with Google (the redirect flow; the backend fakes
 * Google's code exchange for "e2e-google-" codes).
 */
import { expect, test } from '@playwright/test';
import { BACKEND, PASSWORD, control, gotoForm, uniqueEmail, visitFrom } from './support';

/**
 * A Meta click id as long as real ones: 44 of 61 fbclids in production's
 * access log of 19-22 Oct were longer than 150 characters, up to 201. It
 * must reach the workspace and Meta whole.
 */
const FBCLID = `IwZXh0bgNhZW0BMABhZGlk_e2e_email_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);

const firstTouch = async (page: import('@playwright/test').Page) => {
  const c = (await page.context().cookies()).find((x) => x.name === 'hp_attr');
  expect(c, 'the landing page wrote hp_attr').toBeDefined();
  return JSON.parse(decodeURIComponent(c!.value));
};

test.describe('sign-up attribution', () => {
  test('email: the landing page\'s utm and its whole fbclid (200 characters) reach the workspace', async ({ page }) => {
    await visitFrom(page, 'IN');
    await page.goto(
      `/pricing?utm_source=meta&utm_medium=paid_social&utm_campaign=e2e_email&utm_content=face&fbclid=${FBCLID}`
    );
    const touch = await firstTouch(page);
    expect(touch).toMatchObject({ utm_campaign: 'e2e_email', landing_path: '/pricing', fbclid: FBCLID });

    // A second, different ad later does not replace the first touch.
    await page.goto('/?utm_source=google&utm_campaign=e2e_later&gclid=G-later');
    expect((await firstTouch(page)).utm_campaign).toBe('e2e_email');

    const email = uniqueEmail('attr-email');
    await gotoForm(page, '/auth');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    // The page navigates on to the app straight after the response, so its
    // body (with eventId) is read from the row below, not from the browser.
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);

    await expect.poll(() => control.attribution(email)).not.toBeNull();
    expect(await control.attribution(email)).toMatchObject({
      method: 'LOCAL',
      utmSource: 'meta',
      utmMedium: 'paid_social',
      utmCampaign: 'e2e_email',
      utmContent: 'face',
      fbclid: FBCLID,
      fbc: `fb.1.${touch.first_seen_at}.${FBCLID}`,
      landingPath: '/pricing',
      device: 'desktop',
      inApp: null,
      country: 'IN',
    });
    const row = (await control.attribution(email))!;
    // The id Meta gets from the server and the pixel gets from the response.
    expect(row.eventId).toBe(`reg_${row.userId}`);
  });

  test('Google: the same first touch reaches a workspace made with Google', async ({ page }) => {
    await page.goto('/mcp?utm_source=google&utm_medium=cpc&utm_campaign=e2e_google&gclid=G-e2e-google');
    expect((await firstTouch(page)).gclid).toBe('G-e2e-google');

    // "Continue with Google": the backend sets the oauth_state cookie and
    // hands back Google's consent URL; Google would then send the browser
    // back to /auth with a code and that state.
    const consent = await page.evaluate(async (backend) => {
      const res = await fetch(`${backend}/auth/oauth/GOOGLE`, { credentials: 'include' });
      return res.text();
    }, BACKEND);
    const state = new URL(consent.replace(/^"|"$/g, '')).searchParams.get('state');
    expect(state).toMatch(/^login-/);

    const id = `attr${Date.now().toString(36)}`;
    await page.goto(`/auth?provider=GOOGLE&code=e2e-google-${id}&state=${state}`);
    await page.waitForLoadState('networkidle');
    const registered = page.waitForResponse((r) => r.url().endsWith('/auth/register'));
    await page.getByRole('button', { name: 'Create Account' }).click();
    expect((await registered).status()).toBe(200);
    await page.waitForURL(/\/launches/);

    const email = `${id}@gmail-e2e.invalid`;
    await expect.poll(() => control.attribution(email)).not.toBeNull();
    expect(await control.attribution(email)).toMatchObject({
      method: 'GOOGLE',
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: 'e2e_google',
      gclid: 'G-e2e-google',
      landingPath: '/mcp',
    });
  });
});
