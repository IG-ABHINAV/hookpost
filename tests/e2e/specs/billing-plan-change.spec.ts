/**
 * Plan changes on the Billing page (owner's policy, 29 Oct 2026), in a real
 * browser against the real backend and the in-memory Razorpay:
 *
 *   - a foreign card's upgrade quotes Razorpay's prorated amount under the
 *     plan, takes effect at once, and Razorpay is asked for exactly that plan;
 *   - a foreign card's downgrade waits for the end of the cycle: the plan
 *     stays, the page says when it changes, and "Keep my current plan" calls
 *     it off;
 *   - an Indian card cannot be re-planned (Razorpay updates only the offer of
 *     a domestic card), so it gets the new-mandate route, as UPI does.
 */
import { BrowserContext, expect, test } from '@playwright/test';
import { api, control, failOnServerErrors, signUpViaApi, visitFrom } from './support';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

/**
 * A workspace paying monthly by card, `daysIn` days into a 30-day cycle; a
 * card issued outside India unless `indian`.
 */
async function payingByCard(context: BrowserContext, tier: 'STANDARD' | 'PRO', daysIn: number, indian = false) {
  const account = await signUpViaApi(context, { country: 'IN' });
  const start = now() - daysIn * DAY;
  await control.billingFixture({
    email: account.email,
    country: 'IN',
    org: { isTrailing: false, allowTrial: false },
    plan: { tier },
    razorpay: {
      status: 'active',
      paid_count: 1,
      payment_method: 'card',
      card_international: !indian,
      current_start: start,
      current_end: start + 30 * DAY,
      charge_at: start + 30 * DAY,
      amount: tier === 'PRO' ? 199900 : 59900,
    },
  });
  return account;
}

test.describe('plan changes on the Billing page', () => {
  test('Indian card upgrade, Standard -> Pro on day 16: nothing today, the unused days are credited, a new mandate', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const account = await payingByCard(page.context(), 'STANDARD', 15, true);
    await visitFrom(page, 'IN');
    await page.goto('/billing');

    await expect(page.getByText(/Pro starts now\. Nothing to pay today: the ₹29\d(\.\d+)? left on your Standard is credited/)).toBeVisible();
    await expect(page.getByText(/on your saved card/)).toHaveCount(0);
    expect((await api(account.auth, 'GET', '/billing')).body.subscriptionTier).toBe('STANDARD');
    errors.assertNone();
  });

  test('foreign card upgrade, Standard -> Pro on day 16: the page quotes ₹700, Pro starts at once', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const account = await payingByCard(page.context(), 'STANDARD', 15);
    await visitFrom(page, 'IN');
    await page.goto('/billing');

    // (1999 - 599) x 15 / 30, Razorpay's proration.
    await expect(page.getByText(/Pro starts now on your saved card\. Pay ₹700 today/)).toBeVisible();
    await page.getByRole('button', { name: 'Switch to this plan' }).click();
    await expect(page.getByText('Subscription updated successfully')).toBeVisible();

    await expect.poll(async () => (await api(account.auth, 'GET', '/billing')).body?.subscriptionTier).toBe('PRO');
    const { subscriptions, plans } = await control.razorpay();
    const billing = (await api(account.auth, 'GET', '/billing')).body;
    const sub = subscriptions.find((s) => s.id === billing.identifier);
    expect(plans.find((p) => p.id === sub.plan_id)?.item.amount).toBe(199900);
    errors.assertNone();
  });

  test('foreign card downgrade, Pro -> Standard: Pro stays, the date is shown, and Keep my current plan undoes it', async ({
    page,
  }) => {
    const errors = failOnServerErrors(page);
    const account = await payingByCard(page.context(), 'PRO', 5);
    await visitFrom(page, 'IN');
    await page.goto('/billing');

    await expect(page.getByText(/You keep Pro until .*Nothing to pay today/)).toBeVisible();
    await page.getByRole('button', { name: 'Switch to this plan' }).click();
    // Standard has no team: the confirm says what happens to members, and when.
    await expect(page.getByText(/team members lose access when the new plan takes effect.*nobody is removed/)).toBeVisible();
    await page.getByRole('button', { name: 'Yes, continue' }).click();
    await expect(page.getByText(/Your plan changes at the end of this billing cycle/)).toBeVisible();
    await expect(page.getByText(/Changes to Standard monthly on \d{1,2} \w{3} \d{4}/)).toBeVisible();
    expect((await api(account.auth, 'GET', '/billing')).body.subscriptionTier).toBe('PRO');

    await page.getByRole('button', { name: 'Keep my current plan' }).click();
    await expect(page.getByText(/Changes to Standard monthly/)).toHaveCount(0);
    expect((await api(account.auth, 'GET', '/billing')).body.subscriptionTier).toBe('PRO');
    errors.assertNone();
  });
});
