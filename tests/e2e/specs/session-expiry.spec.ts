/**
 * Login sessions last 30 days, renewed while in use. A token without exp is
 * signed out once, and a password reset signs out every other session. Through the real browser,
 * the frontend proxy and the backend, with the session in the httpOnly cookie
 * as in production.
 */
import { Browser, BrowserContext, Page, expect, test } from '@playwright/test';
import {
  PASSWORD,
  addChannelButton,
  control,
  failOnServerErrors,
  gotoForm,
  signInContext,
  signUpViaApi,
} from './support';

const DAY = 24 * 60 * 60;

const authCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((c) => c.name === 'auth' && c.value);
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

/** The paths of every page (document) the tab loads, redirects included. */
function documents(page: Page) {
  const paths: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'document') paths.push(new URL(r.url()).pathname);
  });
  return paths;
}

/** Another browser (another device), with the suite's settings. */
const newBrowser = (browser: Browser) => {
  const { baseURL, timezoneId, locale, viewport, userAgent, deviceScaleFactor } = test.info().project.use;
  return browser.newContext({ baseURL, timezoneId, locale, viewport, userAgent, deviceScaleFactor });
};

async function signIn(page: Page, email: string, password: string) {
  await gotoForm(page, '/auth/login');
  await page.getByPlaceholder('Email Address').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Lands on the login form and stays there: no bounce back into the app. */
async function expectSignedOut(page: Page, context: BrowserContext) {
  await expect(page).toHaveURL(/\/auth\/login(\?|$)/);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/auth\/login(\?|$)/);
  expect(await authCookie(context)).toBeUndefined();
}

test.describe('session expiry', () => {
  for (const [label, opts] of [
    ['past its exp (issued 31 days ago)', { issuedSecondsAgo: 31 * DAY }],
    ['without exp', { legacy: true }],
  ] as const) {
    test(`a session ${label} lands once on the login form, and signing in again works`, async ({ page, context }) => {
      const errors = failOnServerErrors(page);
      const { email } = await signUpViaApi(context);
      await control.givePlan(email);
      await page.goto('/launches');
      await expect(addChannelButton(page)).toBeVisible();

      await signInContext(context, await control.session(email, opts));
      const loaded = documents(page);
      await page.goto('/launches');
      await expectSignedOut(page, context);
      // Straight there: /launches answered with the redirect, no app shell, no loop.
      expect(loaded).toEqual(['/launches', '/auth/login']);
      errors.assertNone();

      await page.getByPlaceholder('Email Address').fill(email);
      await page.getByPlaceholder('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL(/\/launches/);
      await expect(addChannelButton(page)).toBeVisible();
      const fresh = await authCookie(context);
      expect(claims(fresh!.value).exp - claims(fresh!.value).iat).toBe(30 * DAY);
    });
  }

  test('a session in use is renewed: a 29-day-old one opens the app and comes back with 30 new days', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email } = await signUpViaApi(context);
    await control.givePlan(email);
    const old = await control.session(email, { issuedSecondsAgo: 29 * DAY });
    await signInContext(context, old);

    await page.goto('/launches');
    await expect(addChannelButton(page)).toBeVisible();
    await expect.poll(async () => (await authCookie(context))?.value).not.toBe(old);

    const renewed = (await authCookie(context))!;
    const c = claims(renewed.value);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(c.iat - now)).toBeLessThan(120);
    expect(c.exp - c.iat).toBe(30 * DAY);
    expect(renewed).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
    // The cookie lives as long as the session inside it.
    expect(Math.abs(renewed.expires - (now + 30 * DAY))).toBeLessThan(120);
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/(^|;\s*)auth=/);

    await page.reload();
    await expect(addChannelButton(page)).toBeVisible();
    errors.assertNone();
  });

  test('a password reset signs out every other session; the new password signs in', async ({ page, context, browser }) => {
    // Device A: signed up. Device B: signed in with the form.
    const { email } = await signUpViaApi(context);
    await control.givePlan(email);
    await page.goto('/launches');
    await expect(addChannelButton(page)).toBeVisible();

    const deviceB = await newBrowser(browser);
    const pageB = await deviceB.newPage();
    await signIn(pageB, email, PASSWORD);
    await pageB.waitForURL(/\/launches/);
    await expect(addChannelButton(pageB)).toBeVisible();
    const errorsA = failOnServerErrors(page);
    const errorsB = failOnServerErrors(pageB);

    // The reset, from a third browser: the form, the emailed link, a new password.
    const deviceC = await newBrowser(browser);
    const pageC = await deviceC.newPage();
    await gotoForm(pageC, '/auth/forgot');
    const input = pageC.getByPlaceholder('Email Address');
    await expect(async () => {
      await input.fill(email);
      await expect(input).toHaveValue(email, { timeout: 500 });
    }).toPass();
    await pageC.getByRole('button', { name: 'Send Password Reset Email' }).click();
    const resetMail = () =>
      control.emails().then((all) => all.find((m) => m.to === email && /reset/i.test(m.subject)));
    await expect.poll(resetMail).toBeTruthy();
    const link = (await resetMail())!.html.match(/href="(http:\/\/localhost:\d+\/auth\/forgot\/[^"]+)"/)![1];
    await gotoForm(pageC, link);
    const NEW = 'Brand-New-Pass-7';
    await pageC.getByPlaceholder('Password', { exact: true }).fill(NEW);
    await pageC.getByPlaceholder('Repeat Password').fill(NEW);
    await pageC.getByRole('button', { name: 'Change Password' }).click();
    await expect(pageC.getByText('We successfully reset your password')).toBeVisible();

    // Both earlier sessions are over: the next page load ends on the login form.
    await page.goto('/launches');
    await expectSignedOut(page, context);
    await pageB.reload();
    await expectSignedOut(pageB, deviceB);
    errorsA.assertNone();
    errorsB.assertNone();

    // The old password no longer works; the new one does.
    await signIn(pageB, email, PASSWORD);
    await expect(pageB.getByText(/invalid|wrong|incorrect/i).first()).toBeVisible();
    await signIn(page, email, NEW);
    await page.waitForURL(/\/launches/);
    await expect(addChannelButton(page)).toBeVisible();

    await deviceB.close();
    await deviceC.close();
  });
});
