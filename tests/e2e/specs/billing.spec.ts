/**
 * The paywall and Billing, with Razorpay's checkout.js replaced by a stand-in
 * (support.ts) and the backend on an in-memory Razorpay account: what the
 * browser does with the checkout, the signed handshake (/razorpay/verify) and
 * the plan the backend then provisions are all real.
 */
import { expect, Page, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi, skipConnectStep, stubRazorpayCheckout, visitFrom } from './support';

/**
 * An Indian workspace on the paywall (a grandfathered one the Free plan
 * sunset reached, needs_trial: the E2E backend's default for a fresh
 * workspace, E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts), as it is left once
 * it passes the connect step ("Skip for now"; connect-first.spec.ts covers the
 * step itself).
 */
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

test.describe('trial paywall', () => {
  test('shows the trial terms: nothing today, then the Standard price on a date', async ({ page }) => {
    await onPaywall(page);
    await page.goto('/launches');
    await expect(page.getByText(/\d+-day trial, ₹0 today/).first()).toBeVisible();
    await expect(page.getByText(/Then ₹599 on \d{1,2} \w{3} \d{4}, charged automatically/).first()).toBeVisible();
    await expect(page.getByText(/at least 24 hours before/).first()).toBeVisible();
    // No way around the paywall for the new cohort.
    await expect(page.getByRole('button', { name: 'Create Post' })).toHaveCount(0);
  });

  test('Start trial: checkout opens for this workspace, the handshake provisions the plan, onboarding continues', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const { auth, email } = await onPaywall(page);
    const checkout = await startTrial(page);

    await expect(page.getByText('Connect Your Channels')).toBeVisible();
    expect(checkout.opened).toHaveLength(1);
    const { subscriptions } = await control.get<{ subscriptions: any[] }>('/razorpay');
    const sub = subscriptions.find((s) => s.id === checkout.opened[0]);
    expect(sub.status).toBe('authenticated');

    const billing = await api(auth, 'GET', '/billing');
    expect(billing.body).toMatchObject({ subscriptionTier: 'STANDARD', identifier: sub.id });
    const self = await api(auth, 'GET', '/user/self');
    expect(self.body.planState).not.toBe('needs_trial');

    // One welcome email to the owner, through Resend (recorded, never sent).
    await expect.poll(async () => (await control.resendTo(email)).map((m) => m.subject)).toEqual([
      'Your Hookpost Standard trial has started',
    ]);
    const [welcome] = await control.resendTo(email);
    expect(`${welcome.text} ${welcome.html}`).toMatch(/\d+-day/);
    errors.assertNone();
  });

  test('closing the checkout keeps the paywall and provisions nothing', async ({ page }) => {
    const { auth } = await onPaywall(page);
    await stubRazorpayCheckout(page, { outcome: 'dismiss' });
    await page.goto('/launches');
    await page.getByRole('button', { name: /Start \d+-Day Free Trial/ }).click();
    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeEnabled();
    expect((await api(auth, 'GET', '/user/self')).body.planState).toBe('needs_trial');
  });
});

test.describe('Billing page', () => {
  test('shows the current plan and both plans in rupees', async ({ page }) => {
    await onPaywall(page);
    await startTrial(page);
    await page.goto('/billing');
    await expect(page.getByText('Current Plan')).toBeVisible();
    await expect(page.getByText('₹599').first()).toBeVisible();
    await expect(page.getByText('₹1,999').first()).toBeVisible();
    await expect(page.getByText('Up to 15 team members')).toBeVisible();
  });

  test('Cancel: confirm, give feedback, and the plan ends at the period end (not today)', async ({ page }) => {
    const { auth } = await onPaywall(page);
    const checkout = await startTrial(page);
    await page.goto('/billing');
    await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.locator('textarea').last().fill('Testing the cancel flow from the nightly E2E suite.');
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();

    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.cancelAt).toBeTruthy();
    const billing = (await api(auth, 'GET', '/billing')).body;
    expect(new Date(billing.cancelAt).getTime()).toBeGreaterThan(Date.now());
    // The plan is kept until then.
    expect(billing.subscriptionTier).toBe('STANDARD');
    const { subscriptions } = await control.get<{ subscriptions: any[] }>('/razorpay');
    // The mandate is stopped at Razorpay at once; this row alone keeps access.
    expect(subscriptions.find((s) => s.id === checkout.opened[0])?.status).toBe('cancelled');
    // A trial cancelled before its first charge: nothing was paid, so AI
    // stops at once; the exact timer at its end date is armed.
    expect((await api(auth, 'GET', '/copilot/credits?type=ai_text')).body).toEqual({ credits: 0 });
    const self = (await api(auth, 'GET', '/user/self')).body;
    expect(await control.workflows()).toContainEqual({ workflow: 'planEndWorkflow', id: `plan-end-${self.orgId}` });
  });

  test('Cancel a paid plan: Razorpay stops at once, the plan and the page keep the paid time, one "works until" email', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const { auth, email } = await onPaywall(page);
    await control.trialUsed(email);
    const checkout = await stubRazorpayCheckout(page);
    await page.goto('/launches');
    await page.getByRole('button', { name: /^Subscribe for ₹599$/ }).click();
    await expect.poll(() => checkout.opened.length).toBe(1);
    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.identifier).toBe(checkout.opened[0]);
    const paid = (await control.razorpay()).subscriptions.find((s) => s.id === checkout.opened[0]);
    expect(paid.status).toBe('active');

    await page.goto('/billing');
    await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.locator('textarea').last().fill('E2E: paid plan cancel stops Razorpay at once.');
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();

    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.cancelAt).toBeTruthy();
    const billing = (await api(auth, 'GET', '/billing')).body;
    // Kept to the end of the paid cycle, not ended today.
    expect(Math.abs(new Date(billing.cancelAt).getTime() / 1000 - paid.current_end)).toBeLessThan(5);
    expect(billing.subscriptionTier).toBe('STANDARD');
    const after = (await control.razorpay()).subscriptions.find((s) => s.id === checkout.opened[0]);
    expect(after.status).toBe('cancelled');

    // Reload: the plan is still on until the paid end, Cancel does not come
    // back, and Reactivate (a new mandate from that date) is offered.
    await page.reload();
    await expect(page.getByText(/Standard is active until \d{1,2} \w{3} \d{4}/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reactivate subscription' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel subscription', exact: true })).toHaveCount(0);

    await expect
      .poll(async () => (await control.resendTo(email)).filter((m) => /plan is cancelled/.test(m.subject)).length)
      .toBe(1);
    const mail = (await control.resendTo(email)).find((m) => /plan is cancelled/.test(m.subject))!;
    expect(mail.text).toMatch(/until/i);
    errors.assertNone();
  });

  // The owner, 29 Oct 2026: a customer who paid for the month and cancels
  // keeps everything until the end of it, AI and X included, and the plan
  // ends at that second (an exact timer), not at the next hourly sweep.
  test('Cancel a paid plan: everything, AI included, stays until the paid end, and the end is timed', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const account = await signUpViaApi(page.context(), { country: 'IN' });
    const paidEnd = Math.floor(Date.now() / 1000) + 20 * 86400;
    const { organizationId } = await control.post<{ organizationId: string }>('/billing-fixture', {
      email: account.email,
      org: { isTrailing: false, allowTrial: false },
      plan: { tier: 'STANDARD' },
      razorpay: { status: 'active', paid_count: 1, current_start: paidEnd - 30 * 86400, current_end: paidEnd, charge_at: paidEnd },
    });
    await visitFrom(page, 'IN');
    await page.goto('/billing');
    await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.locator('textarea').last().fill('Testing a paid cancel from the E2E suite.');
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();

    await expect.poll(async () => (await api(account.auth, 'GET', '/billing')).body?.cancelAt).toBeTruthy();
    const self = (await api(account.auth, 'GET', '/user/self')).body;
    expect(self.planState).toBe('cancelling');
    const credits = (await api(account.auth, 'GET', '/copilot/credits?type=ai_text')).body;
    expect(credits.credits).toBeGreaterThan(0);
    expect(await control.workflows()).toContainEqual({ workflow: 'planEndWorkflow', id: `plan-end-${organizationId}` });
    errors.assertNone();
  });
});

test.describe('a charge after cancel', () => {
  test('is refunded in full by itself: one email, the plan still cancelled and running to its date, and the refund on the admin page', async ({
    page,
    browser,
  }) => {
    const errors = failOnServerErrors(page);
    const { auth, email } = await onPaywall(page);
    await control.trialUsed(email);
    const checkout = await stubRazorpayCheckout(page);
    await page.goto('/launches');
    await page.getByRole('button', { name: /^Subscribe for ₹599$/ }).click();
    await expect.poll(() => checkout.opened.length).toBe(1);
    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.identifier).toBe(checkout.opened[0]);

    await page.goto('/billing');
    await page.getByRole('button', { name: 'Cancel subscription', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, cancel' }).click();
    await page.locator('textarea').last().fill('E2E: a charge after cancel is refunded by itself.');
    await page.getByRole('button', { name: 'Cancel Subscription', exact: true }).click();
    await expect.poll(async () => (await api(auth, 'GET', '/billing')).body?.cancelAt).toBeTruthy();
    const cancelAt = (await api(auth, 'GET', '/billing')).body.cancelAt;

    // The bank debits the renewal it was told about before Cancel.
    const payment = await control.post<{ id: string; amount: number }>('/razorpay/late-charge', { id: checkout.opened[0] });

    await expect
      .poll(async () => (await control.resendTo(email)).filter((m) => /^We refunded/.test(m.subject)).map((m) => m.subject))
      .toEqual(['We refunded ₹599: your plan stays cancelled']);
    const billing = (await api(auth, 'GET', '/billing')).body;
    expect(billing.cancelAt).toBe(cancelAt);
    expect(billing.subscriptionTier).toBe('STANDARD');
    await page.reload();
    await expect(page.getByText(/Standard is active until \d{1,2} \w{3} \d{4}/)).toBeVisible();

    // The admin's Refunds page names it as the automatic refund.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const admin = await signUpViaApi(adminContext);
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    await adminPage.goto('/admin/refunds');
    const row = adminPage.getByRole('row').filter({ hasText: payment.id }).filter({ hasText: 'This tool' });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('auto-refund (charged after cancel)');
    await expect(row).toContainText('₹599.00');
    await adminContext.close();
    errors.assertNone();
  });
});

// 22 Oct 2026: 20% off the first month (first.month.offer.ts) and Standard
// yearly at ₹5,990. The offer ids are test-env.ts's; FakeRazorpay refuses an
// offer on a subscription with a start_at, as the live account did.
test.describe('20% off the first month', () => {
  test('a workspace that has had its trial: the paywall offers it, and the card offer goes on the subscription', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const { email } = await onPaywall(page);
    await control.trialUsed(email);
    const checkout = await stubRazorpayCheckout(page);
    await page.goto('/launches');

    const box = page.getByTestId('first-month-offer');
    await expect(box).toContainText('First month 20% off (new customers), up to ₹400');
    await expect(box).toContainText('Pay by UPI and your first month is ₹479.20, then ₹599 a month.');
    await page.getByRole('radio', { name: 'Pay with card' }).click();
    await expect(box).toContainText('Pay by card and your first month is ₹479.20');
    await page.getByRole('button', { name: /^Subscribe for ₹599$/ }).click();

    await expect.poll(() => checkout.opened.length).toBe(1);
    const { subscriptions } = await control.razorpay();
    const sub = subscriptions.find((s) => s.id === checkout.opened[0]);
    expect(sub.offer_id).toBe('offer_IntCard0000001');
    expect(sub.start_at).toBeNull();
    expect(sub.notes).toMatchObject({ offer: 'card', period: 'MONTHLY' });
    errors.assertNone();
  });

  test('an offer Razorpay refuses: checkout opens at the full price and the page stops promising the discount', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const { email } = await onPaywall(page);
    await control.trialUsed(email);
    // The customer looks at the payment window and closes it.
    await stubRazorpayCheckout(page, { outcome: 'dismiss' });
    // The card offer was disabled in the dashboard.
    await control.razorpayOffers({ remove: 'offer_IntCard0000001' });
    try {
      await page.goto('/launches');
      await page.getByRole('radio', { name: 'Pay with card' }).click();
      await expect(page.getByTestId('first-month-offer')).toContainText('₹479.20');
      await page.getByRole('button', { name: /^Subscribe for ₹599$/ }).click();

      const opened = () =>
        page.evaluate(() => (window as any).__e2eRazorpayOptions?.subscription_id as string | undefined);
      await expect.poll(opened).toBeTruthy();
      const { subscriptions } = await control.razorpay();
      const id = await opened();
      expect(subscriptions.find((s) => s.id === id)).toMatchObject({ offer_id: null, notes: { period: 'MONTHLY' } });
      await expect(page.getByTestId('first-month-offer-not-applied')).toBeVisible();
      await expect(page.getByTestId('first-month-offer')).toHaveCount(0);
      await expect(page.getByText(/₹479\.20/)).toHaveCount(0);
      errors.assertNone();
    } finally {
      await control.razorpayOffers({ add: 'offer_IntCard0000001' });
    }
  });

  test('a new workspace starting its trial is promised no offer, and its trial carries none', async ({ page }) => {
    await onPaywall(page);
    await page.goto('/launches');
    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeVisible();
    await expect(page.getByTestId('first-month-offer')).toHaveCount(0);
    await expect(page.getByText(/20% off/)).toHaveCount(0);

    const checkout = await startTrial(page);
    const { subscriptions } = await control.razorpay();
    expect(subscriptions.find((s) => s.id === checkout.opened[0]).offer_id).toBeNull();
  });
});

test.describe('Standard yearly, ₹5,990', () => {
  test('Yearly on the paywall: the trial starts on the ₹5,990 yearly plan and the workspace is on YEARLY', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await onPaywall(page);
    const checkout = await stubRazorpayCheckout(page, { trialDays: 7 });
    await page.goto('/launches');
    // Monthly until Yearly is chosen; Yearly says what it saves, from pricing.ts.
    await expect(page.getByRole('button', { name: /Start \d+-Day Free Trial \(₹0 Today, then ₹599\)/ })).toBeVisible();
    await expect(page.getByText('2 months free', { exact: true })).toBeVisible();
    await expect(page.getByText(/20%/)).toHaveCount(0);
    await page.getByText('Yearly', { exact: true }).click();
    await expect(page.getByText(/Then ₹5,990\/year on \d{1,2} \w{3} \d{4}, charged automatically/).first()).toBeVisible();
    const start = page.getByRole('button', { name: /Start \d+-Day Free Trial \(₹0 Today, then ₹5,990\/year\)/ });
    await start.click();
    await page.waitForURL(/trialStart=true/);

    const { subscriptions, plans } = await control.razorpay();
    const sub = subscriptions.find((s) => s.id === checkout.opened[0]);
    const plan = plans.find((p) => p.id === sub.plan_id);
    expect(plan).toMatchObject({ period: 'yearly', item: { amount: 599000, currency: 'INR' } });
    expect(sub.total_count).toBe(10);
    expect(sub.offer_id).toBeNull();
    const billing = await api(auth, 'GET', '/billing');
    expect(billing.body).toMatchObject({ subscriptionTier: 'STANDARD', period: 'YEARLY', identifier: sub.id });
    errors.assertNone();
  });
});
