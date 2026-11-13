/**
 * The owner's sale alert from the customer's side of the screen: a real
 * browser starts a trial and cancels it in Billing (Razorpay's checkout.js
 * stood in for, the backend on an in-memory Razorpay, Resend recorded), and
 * the owner (OWNER_SALES_ALERT_EMAIL, tests/integration/setup/test-env.ts)
 * gets one email for each, while the customer gets only their own. Then the
 * alert's admin link opens the super-admin users page on that workspace.
 */
import { expect, Page, test } from '@playwright/test';
import {
  api,
  control,
  failOnServerErrors,
  signUpViaApi,
  skipConnectStep,
  stubRazorpayCheckout,
  visitFrom,
} from './support';

const OWNER = 'owner-alerts@hookpost.invalid';

async function onPaywall(page: Page) {
  const account = await signUpViaApi(page.context(), { country: 'IN' });
  await visitFrom(page, 'IN');
  await skipConnectStep(page, account.auth);
  return account;
}

async function startTrial(page: Page) {
  const checkout = await stubRazorpayCheckout(page, { trialDays: 7 });
  await page.goto('/launches');
  await page.getByRole('button', { name: /Start \d+-Day Free Trial/ }).click();
  await page.waitForURL(/trialStart=true/);
  return checkout;
}

/** The owner's alerts about one subscription. */
const alertsFor = async (subscriptionId: string) =>
  (await control.resendTo(OWNER)).filter((m) => `${m.text}`.includes(subscriptionId));

test.describe("the owner's sale alert", () => {
  test('a trial started in the browser: one alert to the owner, the welcome only to the customer', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email } = await onPaywall(page);
    const checkout = await startTrial(page);
    const subscriptionId = checkout.opened[0];

    await expect.poll(async () => (await alertsFor(subscriptionId)).length).toBe(1);
    // A second one would have landed by now (the checkout callback and the
    // webhook both saw the new subscription).
    await page.waitForTimeout(500);
    const [alert] = await alertsFor(subscriptionId);
    expect(alert.subject).toMatch(/^Trial started: Standard monthly, ₹599 · /);
    expect(alert.text).toContain('Test mode: Razorpay test key');
    expect(alert.text).toContain(`Email: ${email}`);
    expect([alert.to].flat()).toEqual([OWNER]);

    await expect.poll(async () => (await control.resendTo(email)).map((m) => m.subject)).toEqual([
      'Your Hookpost Standard trial has started',
    ]);
    errors.assertNone();
  });

  test('Cancel in Billing: the owner is told once, with the reason the customer typed', async ({ page }) => {
    const { auth } = await onPaywall(page);
    const checkout = await startTrial(page);
    const subscriptionId = checkout.opened[0];
    await page.goto('/billing');
    await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.locator('textarea').last().fill('Owner alert E2E: switching tools');
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.cancelAt).toBeTruthy();

    await expect
      .poll(async () => (await alertsFor(subscriptionId)).filter((m) => /Cancellation requested/.test(m.subject)).length)
      .toBe(1);
    const cancel = (await alertsFor(subscriptionId)).find((m) => /Cancellation requested/.test(m.subject))!;
    expect(cancel.text).toContain('Reason given: Owner alert E2E: switching tools');
  });

  test("the alert's admin link opens the users page on that workspace", async ({ page, browser }) => {
    // The customer, in their own browser.
    const elsewhere = await browser.newContext();
    const customerPage = await elsewhere.newPage();
    const customer = await onPaywall(customerPage);
    const checkout = await startTrial(customerPage);
    await elsewhere.close();
    await expect.poll(async () => (await alertsFor(checkout.opened[0])).length).toBe(1);
    const [alert] = await alertsFor(checkout.opened[0]);
    const link = /Open in admin: (\S+)/.exec(alert.text || '')![1];
    const orgId = new URL(link).searchParams.get('q')!;
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);

    // The owner, signed in as a super admin, follows it.
    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    const url = new URL(link);
    await page.goto(`${url.pathname}${url.search}`);
    await expect(page.getByPlaceholder('Search by email, name, workspace or source...')).toHaveValue(orgId);
    await expect(page.getByRole('row').filter({ hasText: customer.email })).toHaveCount(1);
    await expect(page.getByRole('row').filter({ hasText: admin.email })).toHaveCount(0);
  });
});
