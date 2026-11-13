/**
 * The super-admin Users & Billing page (/admin/users): one colour-coded
 * billing badge per row with its date, a filter chip per state whose count is
 * the rows it shows, a new sign-up showing as "Free posts", and the Free rows
 * (grandfathered, created before the cutoff) turning into Needs trial once
 * FREE_PLAN_SUNSET_AT passes, with exempt workspaces staying "Free (exempt)".
 *
 * The admin is a test account made here (signUpViaApi + makeSuperAdmin);
 * every customer is a test account too, put in its state through the E2E
 * backend's /billing-fixture.
 */
import { Browser, expect, Page, test } from '@playwright/test';
import { control, failOnServerErrors, signUpViaApi } from './support';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const OLD = '2026-09-01T00:00:00Z';
// The cutoff production runs: a workspace made now is after it (free_posts),
// OLD is before it (grandfathered). The E2E backend's own default is another
// one (E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts), put back afterwards.
const PRODUCTION_CUTOFF = '2026-10-19T00:00:00Z';
const DEFAULT_POLICY = {
  TRIAL_REQUIRED_SINCE_IN: '2099-01-01T00:00:00Z',
  FREE_PLAN_SUNSET_AT: '2026-10-20T00:00:00Z',
  FREE_PLAN_SUNSET_EXEMPT_ORGS: '',
};

async function customer(browser: Browser, fixture: Record<string, any> = {}) {
  const context = await browser.newContext();
  const { email } = await signUpViaApi(context, { country: 'IN' });
  await context.close();
  const { organizationId } = await control.billingFixture({ email, country: 'IN', ...fixture });
  return { email, organizationId };
}

const rowOf = (page: Page, email: string) => page.getByRole('row').filter({ hasText: email });
const badgeOf = (page: Page, email: string) => rowOf(page, email).getByTestId('billing-state').first();

test.describe('admin users page: billing states', () => {
  test.afterAll(async () => {
    await control.setPolicyEnv(DEFAULT_POLICY);
  });

  test('one badge per row, chips that match, and the sunset switching Free to Needs trial', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    await control.setPolicyEnv({
      TRIAL_REQUIRED_SINCE_IN: PRODUCTION_CUTOFF,
      FREE_PLAN_SUNSET_AT: '2099-10-27T18:29:59Z',
      FREE_PLAN_SUNSET_EXEMPT_ORGS: '',
    });

    const paying = await customer(browser, {
      org: { isTrailing: false },
      plan: { tier: 'STANDARD' },
      razorpay: { status: 'active', paid_count: 2, charge_at: now() + 10 * DAY, current_end: now() + 10 * DAY, amount: 69900 },
    });
    const trial = await customer(browser, {
      plan: { tier: 'STANDARD' },
      razorpay: { status: 'authenticated', paid_count: 0, start_at: now() + 3 * DAY, charge_at: now() + 3 * DAY, amount: 59900 },
    });
    const cancelled = await customer(browser, {
      plan: { tier: 'STANDARD', cancelAt: new Date(Date.now() + 5 * DAY * 1000).toISOString() },
      razorpay: { status: 'cancelled', paid_count: 0, amount: 59900 },
    });
    const failed = await customer(browser, {
      org: { isTrailing: false },
      plan: { tier: 'STANDARD' },
      razorpay: { status: 'halted', paid_count: 3, amount: 69900 },
    });
    const lifetime = await customer(browser, { plan: { tier: 'TEAM', isLifetime: true } });
    const free = await customer(browser, { org: { createdAt: OLD } });
    const exempt = await customer(browser, { org: { createdAt: OLD } });
    const freePosts = await customer(browser);
    await control.setPolicyEnv({ FREE_PLAN_SUNSET_EXEMPT_ORGS: exempt.organizationId });

    // The admin: a test account with a plan (so the app opens) made super admin.
    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    await page.goto('/admin/users');
    await expect(rowOf(page, paying.email)).toBeVisible();

    const expectBadge = async (email: string, state: string, label: RegExp) => {
      const badge = badgeOf(page, email);
      await expect(badge).toHaveAttribute('data-state', state);
      await expect(badge.getByTestId('billing-label')).toHaveText(label);
    };
    await expectBadge(paying.email, 'paying', /^Paying — renews \d{1,2} [A-Z][a-z]{2,3}/);
    await expect(badgeOf(page, paying.email).getByTestId('billing-detail')).toHaveText('Standard monthly · ₹699/mo');
    await expectBadge(trial.email, 'trial', /^Trial — first charge ₹599 on \d{1,2} [A-Z][a-z]{2,3}/);
    await expectBadge(cancelled.email, 'cancelled', /^Cancelled — access until /);
    await expectBadge(failed.email, 'payment_failed', /^Payment failed — halted$/);
    await expectBadge(lifetime.email, 'lifetime', /^Lifetime \(internal\)$/);
    await expectBadge(free.email, 'free', /^Free \(ends 27 Oct 2099\)$/);
    await expectBadge(exempt.email, 'free_exempt', /^Free \(exempt\)$/);
    await expectBadge(freePosts.email, 'free_posts', /^Free posts$/);

    // Paying and cancelled no longer look alike (the 26 Oct confusion).
    const color = async (email: string) =>
      badgeOf(page, email).locator('span[title]').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await color(paying.email)).not.toBe(await color(cancelled.email));

    // The header cards name what they count.
    await expect(page.getByTestId('metric-users')).toContainText('Users');
    await expect(page.getByTestId('metric-workspaces')).toContainText('with users');

    // Each chip's count is exactly the rows it shows.
    for (const state of ['cancelled', 'paying', 'trial', 'free', 'free_posts']) {
      const chip = page.getByTestId(`state-chip-${state}`);
      const n = Number(await chip.getByTestId('state-chip-count').innerText());
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('tbody tr')).toHaveCount(n);
      await chip.click();
      await expect(chip).toHaveAttribute('aria-pressed', 'false');
    }
    await page.getByTestId('state-chip-cancelled').click();
    await expect(rowOf(page, cancelled.email)).toBeVisible();
    await expect(rowOf(page, paying.email)).toHaveCount(0);
    await page.getByTestId('filter-all').click();
    await expect(page.getByTestId('state-chip-free')).toContainText('Free (ends 27 Oct)');

    // FREE_PLAN_SUNSET_AT passes: no restart, no manual step.
    await control.setPolicyEnv({ FREE_PLAN_SUNSET_AT: '2026-10-20T00:00:00Z' });
    await page.reload();
    await expectBadge(free.email, 'needs_trial', /^Needs trial$/);
    await expect(badgeOf(page, free.email).getByTestId('billing-detail')).toHaveText(/Free plan ended 20 Oct/);
    await expectBadge(exempt.email, 'free_exempt', /^Free \(exempt\)$/);
    await expectBadge(paying.email, 'paying', /^Paying — renews /);
    // A new sign-up is not reached by the sunset.
    await expectBadge(freePosts.email, 'free_posts', /^Free posts$/);

    errors.assertNone();
  });
});
