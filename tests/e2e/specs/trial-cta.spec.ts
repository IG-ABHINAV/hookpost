/**
 * The way to the trial for a workspace without a plan (27 Oct 2026: twelve
 * sign-ups from the Claude connector, none started the trial). The connect
 * step and the app carry "Start your N-day trial to publish posts" with a
 * Start free trial button to the paywall; with a plan there is none. The
 * composer's main button becomes "Start trial to schedule". A platform admin
 * impersonating such a workspace sees what its owner sees, not the calendar.
 * The OAuth consent page's side is in oauth-consent.spec.ts.
 *
 * "Without a plan" here is a grandfathered workspace the Free plan sunset
 * reached (needs_trial), which is what the E2E backend makes of a fresh
 * workspace by default (E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts). A
 * sign-up after the cutoff is free_posts since 28 Oct 2026: no paywall
 * (free-posts.spec.ts).
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi, visitFrom } from './support';

const START_TRIAL_PLAN = /Start \d+-Day Free Trial/;
const BANNER_TEXT = /Start your \d+-day trial to publish posts\./;

async function noPlanWorkspace(context: BrowserContext, page: Page) {
  const account = await signUpViaApi(context, { country: 'IN' });
  await visitFrom(page, 'IN');
  return account;
}

test.describe('Start free trial, without a plan', () => {
  test('the connect step says the trial comes next, and its button opens the paywall in rupees', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await noPlanWorkspace(context, page);
    expect((await api(auth, 'GET', '/user/self')).body.planState).toBe('needs_trial');

    await page.goto('/launches');
    await expect(page.getByRole('heading', { name: 'Connect your first channel' })).toBeVisible();
    const banner = page.getByTestId('trial-required-banner');
    await expect(banner).toHaveText(BANNER_TEXT);
    // Not dismissible: no close button.
    await expect(banner.getByRole('button')).toHaveCount(0);

    await banner.getByRole('link', { name: 'Start free trial' }).click();
    await page.waitForURL(/\/billing$/);
    // The paywall: the plans and the checkout button, in rupees for India.
    await expect(page.getByRole('button', { name: START_TRIAL_PLAN })).toBeVisible();
    await expect(page.getByText('₹').first()).toBeVisible();
    errors.assertNone();
  });

  test('with a plan: no banner, and the composer keeps Add to calendar', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email } = await noPlanWorkspace(context, page);
    await control.givePlan(email, 'STANDARD');
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');

    await page.goto('/launches');
    await expect(page.getByText('E2E Bluesky').first()).toBeVisible();
    await expect(page.getByTestId('trial-required-banner')).toHaveCount(0);
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(page.getByTestId('composer-start-trial')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Check the circles above|Add to calendar/ })).toBeVisible();
    errors.assertNone();
  });

  // The owner of a no-plan workspace (no platform admin in it) never reaches
  // the composer: with a channel connected, every app page is the paywall.
  // The composer's "Start trial to schedule" button (trial.cta.ts) was only
  // reachable by a platform admin in their own workspace, which is now
  // internal and keeps the Free plan (next test); trial.cta.spec.ts covers it.
  test('a workspace without a plan and a channel: the paywall on every page, no composer, nothing posted', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await noPlanWorkspace(context, page);
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    expect((await api(auth, 'GET', '/user/self')).body).toMatchObject({ admin: false, impersonate: false, planState: 'needs_trial' });

    for (const path of ['/launches', '/settings', '/analytics']) {
      await page.goto(path);
      await expect(page.getByText(/Your Bluesky is connected\. Start your \d+-day trial to schedule your first post\./), path).toBeVisible();
      await expect(page.getByRole('button', { name: START_TRIAL_PLAN }), path).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create Post' }), path).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Add to calendar' }), path).toHaveCount(0);
    }
    expect(await control.posts(email)).toEqual([]);
    errors.assertNone();
  });

  // A workspace a platform super admin belongs to is one of our own
  // (internalWorkspace in trial.policy.ts): it keeps the Free plan after the
  // Free plan sunset, so with no plan it is 'free', not needs_trial. Until
  // 28 Oct 2026 a new workspace reached the paywall through the trial cutoff,
  // which does not exempt it; since then needs_trial is only the sunset's.
  test('a platform admin in their own workspace without a plan keeps the Free plan: no banner, and the composer keeps Add to calendar', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { email, auth } = await noPlanWorkspace(context, page);
    await control.makeSuperAdmin(email);
    await control.addChannel(email, 'bluesky', 'E2E Bluesky');
    expect((await api(auth, 'GET', '/user/self')).body).toMatchObject({ admin: true, impersonate: false, planState: 'free' });

    for (const path of ['/launches', '/settings', '/analytics']) {
      await page.goto(path);
      // Loaded, as the admin (the super-admin bar), before checking for no banner.
      await expect(page.getByTestId('admin-bar'), path).toBeVisible();
      await expect(page.getByTestId('trial-required-banner'), path).toHaveCount(0);
    }

    await page.goto('/launches');
    await expect(page.getByText('E2E Bluesky').first()).toBeVisible();
    await page.getByRole('button', { name: 'Create Post' }).click();
    await expect(page.getByRole('button', { name: /Check the circles above|Add to calendar/ })).toBeVisible();
    await expect(page.getByTestId('composer-start-trial')).toHaveCount(0);
    errors.assertNone();
  });

  test('an admin impersonating a workspace without a plan sees its connect step and banner, not the calendar', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    const elsewhere = await browser.newContext();
    const customer = await signUpViaApi(elsewhere, { country: 'IN' });
    await elsewhere.close();

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);

    await page.goto('/admin/users');
    await page.getByPlaceholder('Search by email, name, workspace or source...').fill(customer.email);
    await page
      .getByRole('row')
      .filter({ hasText: customer.email })
      .getByRole('button', { name: 'Impersonate' })
      .click();
    await expect(page.getByText('Currently Impersonating')).toBeVisible();

    await page.goto('/launches');
    await expect(page.getByText('Currently Impersonating')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect your first channel' })).toBeVisible();
    await expect(page.getByTestId('trial-required-banner')).toHaveText(BANNER_TEXT);
    await expect(page.getByRole('button', { name: 'Create Post' })).toHaveCount(0);

    // And the way out still works.
    await page.getByRole('button', { name: 'Stop impersonating' }).click();
    await expect(page.getByText('Currently Impersonating')).toHaveCount(0);
    errors.assertNone();
  });

  test('on a phone: the banner and its button fit the screen on the connect step', async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await noPlanWorkspace(context, page);
    await page.goto('/launches');
    const button = page.getByTestId('trial-required-banner').getByRole('link', { name: 'Start free trial' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
});
