/**
 * In-app browsers, by user agent: Instagram on Android, LinkedIn on iPhone,
 * and a normal desktop Chrome for contrast. Inside the app the marketing
 * page shows "Open in your browser" with the ad's link and Copy link, and on
 * Android an Open in Chrome link that nothing follows by itself; /auth hides
 * Google (it fails there) and leads with the email form, which signs up and
 * records the in-app browser and the phone with the workspace.
 */
import { expect, test } from '@playwright/test';
import { PASSWORD, control, gotoForm, uniqueEmail } from './support';

const INSTAGRAM_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android';
const LINKEDIN_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1456';
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

test.describe("Instagram's browser on Android", () => {
  test.use({ userAgent: INSTAGRAM_ANDROID, ...PHONE });

  test('a landing page offers "Open in your browser" with the ad link, and never redirects', async ({ page }) => {
    const landing = '/pricing?utm_source=meta&utm_medium=paid_social&utm_campaign=e2e_inapp&fbclid=IwAR_inapp';
    await page.goto(landing);
    const bar = page.getByTestId('open-in-browser');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("Instagram's built-in browser");

    const address = await page.getByLabel('Link to this page').inputValue();
    expect(new URL(address).searchParams.get('utm_campaign')).toBe('e2e_inapp');
    expect(new URL(address).searchParams.get('fbclid')).toBe('IwAR_inapp');

    const chrome = page.getByTestId('open-in-chrome');
    await expect(chrome).toHaveAttribute('href', /^intent:\/\/localhost:\d+\/pricing\?utm_source=meta&.*package=com\.android\.chrome/);
    // Only a tap opens Chrome: the page stays where it is.
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe('/pricing');

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByRole('button', { name: 'Link copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);
  });

  test('/auth leads with email (Google hidden), and the sign-up records Instagram and the phone', async ({ page }) => {
    await page.goto('/mcp?utm_source=meta&utm_campaign=e2e_inapp_signup');
    await gotoForm(page, '/auth');
    const card = page.getByTestId('open-in-browser');
    await expect(card).toContainText('Sign up with your email below');
    expect(new URL(await page.getByLabel('Link to this page').inputValue()).searchParams.get('utm_campaign')).toBe(
      'e2e_inapp_signup'
    );
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);

    const email = uniqueEmail('inapp');
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create Account' }).click();
    await page.waitForURL(/\/launches/);
    await expect.poll(() => control.attribution(email)).not.toBeNull();
    expect(await control.attribution(email)).toMatchObject({
      method: 'LOCAL',
      inApp: 'instagram',
      device: 'mobile',
      utmCampaign: 'e2e_inapp_signup',
    });
  });

  test('/auth/login hides Google only: the other ways in stay', async ({ page }) => {
    await gotoForm(page, '/auth/login');
    await expect(page.getByTestId('open-in-browser')).toContainText('Google sign-in won’t work here');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
    // Billing is on here as in production, so the wallet sign-in is offered:
    // the card names Google, the one provider that is hidden.
    await expect(page.getByText('Continue With', { exact: true })).toBeVisible();
  });
});

test.describe("LinkedIn's browser on iPhone", () => {
  test.use({ userAgent: LINKEDIN_IOS, ...PHONE });

  test('the prompt shows the ••• route and no Chrome link', async ({ page }) => {
    await page.goto('/pricing?utm_source=linkedin&utm_campaign=e2e_li');
    const bar = page.getByTestId('open-in-browser');
    await expect(bar).toContainText("LinkedIn's built-in browser");
    await expect(bar).toContainText('tap •••');
    await expect(page.getByTestId('open-in-chrome')).toHaveCount(0);
  });
});

test.describe('a normal browser', () => {
  test('no prompt on the landing page, and Google is offered on /auth', async ({ page }) => {
    await page.goto('/pricing?utm_source=meta&utm_campaign=e2e_desktop');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('open-in-browser')).toHaveCount(0);
    await gotoForm(page, '/auth');
    await expect(page.getByTestId('open-in-browser')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  });
});
