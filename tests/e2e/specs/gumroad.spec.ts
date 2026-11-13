/**
 * Plans bought on Gumroad, in the browser against a production build: the
 * buyer enters the license key from the Gumroad receipt and the workspace is
 * on the plan. The E2E backend answers Gumroad's license and sales API from
 * FakeGumroad (tests/integration/setup/fake.gumroad.ts); the redeem, the
 * plan it writes and the pages that read it are all real.
 *
 * Runs in two modes. By default the Gumroad variables are set on the
 * backend and the frontend; with E2E_GUMROAD=off they are unset, as in
 * production until the owner sets them: no redeem field, and /redeem is 404.
 *   E2E_GUMROAD=off pnpm exec playwright test -c tests/e2e/playwright.config.ts gumroad billing
 */
import { expect, Page, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi, skipConnectStep, visitFrom } from './support';

const GUMROAD_ON = process.env.E2E_GUMROAD !== 'off';
const REDEEM_LINK = 'Bought on Gumroad? Enter your license key';

async function enterKey(page: Page, key: string) {
  await page.getByRole('button', { name: REDEEM_LINK }).click();
  await page.getByLabel('Gumroad license key').fill(key);
  await page.getByRole('button', { name: 'Redeem', exact: true }).click();
}

test.describe('Bought on Gumroad? Enter your license key', () => {
  test.skip(!GUMROAD_ON, 'Gumroad is off in this run (E2E_GUMROAD=off)');

  test('on Billing: the key puts the workspace on Pro, and Billing shows the plan as billed through Gumroad', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    // A workspace outside India keeps the Free plan; "Start free" takes it
    // past the plans screen to the app, where Billing is.
    const { auth } = await signUpViaApi(page.context(), { country: 'US' });
    expect((await api(auth, 'POST', '/user/free-plan')).status).toBeLessThan(300);
    const { key } = await control.gumroadLicense({ tier: 'PRO' });

    await page.goto('/billing');
    await expect(page.getByText('Prices in', { exact: false }).first()).toBeVisible();
    await enterKey(page, key);

    await expect(page.getByText('Pro plan, billed through Gumroad')).toBeVisible();
    await expect(
      page.getByText('To cancel or change it, open your Gumroad library.')
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open my Gumroad library' })).toHaveAttribute(
      'href',
      'https://app.gumroad.com/library'
    );
    // What Pro includes, from pricing.ts, and no Razorpay checkout or Cancel.
    await expect(page.getByText('20 channels')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);

    const self = (await api(auth, 'GET', '/user/self')).body;
    expect(self).toMatchObject({ planState: 'active', tier: 'PRO' });
    expect((await api(auth, 'GET', '/billing')).body).toMatchObject({
      subscriptionTier: 'PRO',
      identifier: expect.stringMatching(/^gumroad:/),
    });
    errors.assertNone();
  });

  test('on the trial paywall: the key takes the paywall away', async ({ page }) => {
    const { auth } = await signUpViaApi(page.context(), { country: 'IN' });
    await visitFrom(page, 'IN');
    // Past the connect step a new workspace sees first (connect-first.spec.ts).
    await skipConnectStep(page, auth);
    const { key } = await control.gumroadLicense({ tier: 'STANDARD', recurrence: 'yearly' });

    await page.goto('/launches');
    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeVisible();
    await enterKey(page, key);

    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toHaveCount(0);
    expect((await api(auth, 'GET', '/user/self')).body).toMatchObject({
      planState: 'active',
      tier: 'STANDARD',
    });
    expect((await api(auth, 'GET', '/billing')).body).toMatchObject({ period: 'YEARLY' });
  });

  test('a key that is already in use says so, and changes nothing', async ({ page, browser }) => {
    const { key } = await control.gumroadLicense({ tier: 'PRO' });
    // The first workspace redeems it through the API.
    const otherContext = await browser.newContext();
    const first = await signUpViaApi(otherContext, { country: 'US' });
    expect((await api(first.auth, 'POST', '/billing/gumroad/redeem', { licenseKey: key })).status).toBe(201);
    await otherContext.close();

    const { auth } = await signUpViaApi(page.context(), { country: 'US' });
    await api(auth, 'POST', '/user/free-plan');
    await page.goto('/billing');
    await enterKey(page, key);
    await expect(
      page.getByRole('alert').filter({ hasText: 'already in use' })
    ).toHaveText(
      'This license key is already in use on another workspace. To move it, email support@hookstep.in.'
    );
    expect((await api(auth, 'GET', '/user/self')).body.tier).toBe('FREE');
  });
});

test.describe('Gumroad off (E2E_GUMROAD=off): nothing of it shows', () => {
  test.skip(GUMROAD_ON, 'Gumroad is on in this run');

  test('no redeem field on Billing or the paywall, and the endpoint answers 404', async ({ page, browser }) => {
    const { auth } = await signUpViaApi(page.context(), { country: 'US' });
    await api(auth, 'POST', '/user/free-plan');
    await page.goto('/billing');
    await expect(page.getByText('Prices in', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: REDEEM_LINK })).toHaveCount(0);
    expect((await api(auth, 'GET', '/user/self')).body.gumroadRedeem).toBe(false);
    const redeem = await api(auth, 'POST', '/billing/gumroad/redeem', {
      licenseKey: 'ABCDEF12-ABCDEF12-ABCDEF12-ABCDEF12',
    });
    expect(redeem.status).toBe(404);
    expect(redeem.body).toMatchObject({ code: 'GUMROAD_OFF' });

    const paywall = await browser.newContext();
    const paywallPage = await paywall.newPage();
    const blocked = await signUpViaApi(paywall, { country: 'IN' });
    await visitFrom(paywallPage, 'IN');
    await skipConnectStep(paywallPage, blocked.auth);
    await paywallPage.goto('/launches');
    await expect(paywallPage.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeVisible();
    await expect(paywallPage.getByRole('button', { name: REDEEM_LINK })).toHaveCount(0);
    await paywall.close();
  });
});

test.describe('/redeem', () => {
  test(GUMROAD_ON
    ? 'renders for an anonymous visitor, with the steps and what each plan includes'
    : 'is a 404 while Gumroad is off', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const res = await page.goto('/redeem');

    if (!GUMROAD_ON) {
      expect(res?.status()).toBe(404);
      await expect(
        page.getByRole('heading', { name: 'Redeem a Hookpost plan bought on Gumroad' })
      ).toHaveCount(0);
      await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);
      await context.close();
      return;
    }

    const errors = failOnServerErrors(page);
    expect(res?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/redeem');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Redeem a Hookpost plan bought on Gumroad' })
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '1. Find your license key' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/auth');
    await expect(page.getByRole('heading', { name: 'Standard', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pro', exact: true })).toBeVisible();
    await expect(page.getByText('20 channels')).toBeVisible();
    // A how-to for buyers: not indexed.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    errors.assertNone();
    await context.close();
  });
});
