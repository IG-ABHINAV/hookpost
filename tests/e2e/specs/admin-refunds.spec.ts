/**
 * The super-admin Refunds page (/admin/refunds): a refund made in the Razorpay
 * dashboard shows in the refund history and in the payment's badge, and a
 * refund made from the page shows in both at once, then as Razorpay lists it,
 * attributed to the admin who made it.
 *
 * The admin and the customer are test accounts made here (signUpViaApi +
 * makeSuperAdmin); the payment and the dashboard refund are put in the E2E
 * backend's fake Razorpay account (/razorpay/payment, /razorpay/refund).
 *   pnpm exec playwright test -c tests/e2e/playwright.config.ts admin-refunds
 */
import { expect, test } from '@playwright/test';
import { control, failOnServerErrors, signUpViaApi } from './support';

test.describe('admin: Refunds', () => {
  test('dashboard refunds are listed; a refund made here shows at once and stays attributed', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);

    const customerContext = await browser.newContext();
    const customer = await signUpViaApi(customerContext, { country: 'IN' });
    await customerContext.close();
    const payment = await control.razorpayPayment({ email: customer.email, amount: 69900 });
    const dashboard = await control.razorpayRefund({
      paymentId: payment.id,
      amount: 600,
      notes: { comment: 'asked by email' },
    });

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);

    await page.goto('/admin/refunds');
    await expect(page.getByRole('link', { name: '💸 Refunds' })).toHaveClass(/bg-primary/);

    // The dashboard's refund: in the history, and in the payment's badge.
    const dashRow = page.getByTestId(`refund-row-${dashboard.id}`);
    await expect(dashRow).toContainText('Razorpay dashboard');
    await expect(dashRow).toContainText('asked by email');
    await expect(dashRow).toContainText(customer.email);
    await expect(dashRow).toContainText('₹6.00');
    const badge = page.getByTestId(`refund-state-${payment.id}`);
    await expect(badge).toContainText('Partly refunded');
    await expect(badge).toContainText('₹6.00 of ₹699.00 refunded · ₹693.00 left');

    // Refund what is left from the page.
    await page.getByRole('row').filter({ hasText: payment.id }).getByRole('button', { name: 'Refund' }).click();
    await expect(page.getByRole('heading', { name: 'Refund this payment?' })).toBeVisible();
    await page.getByRole('button', { name: 'Refund ₹693.00' }).click();

    // Nothing left to refund: off the refundable list at once.
    await expect(badge).toHaveCount(0);
    const mine = page.getByRole('row').filter({ hasText: payment.id }).filter({ hasText: 'This tool' });
    await expect(mine).toHaveCount(1);
    await expect(mine).toContainText('₹693.00');
    await expect(mine).toContainText(admin.email);

    // After a reload it is Razorpay's row, still named after the admin (the audit row).
    await page.reload();
    const listed = page.getByRole('row').filter({ hasText: payment.id }).filter({ hasText: 'This tool' });
    await expect(listed).toHaveCount(1);
    await expect(listed).toContainText(admin.email);
    await expect(listed).toContainText('Pending');
    await expect(page.getByTestId(`refund-row-${dashboard.id}`)).toBeVisible();

    // With "Only refundable" off, the payment reads as fully refunded.
    await page.getByLabel('Only refundable').uncheck();
    await expect(page.getByTestId(`refund-state-${payment.id}`)).toContainText('Fully refunded');

    errors.assertNone();
  });

  test('the Refund dialog deducts the Razorpay fee by default, and Full refunds it all', async ({ page, browser }) => {
    const errors = failOnServerErrors(page);
    const customerContext = await browser.newContext();
    const customer = await signUpViaApi(customerContext, { country: 'IN' });
    await customerContext.close();
    const less = await control.razorpayPayment({ email: customer.email, amount: 59900, fee: 1414, tax: 216 });
    const full = await control.razorpayPayment({ email: customer.email, amount: 59900, fee: 1414, tax: 216 });

    const admin = await signUpViaApi(page.context());
    await control.givePlan(admin.email, 'STANDARD');
    await control.makeSuperAdmin(admin.email);
    await page.goto('/admin/refunds');

    await page.getByRole('row').filter({ hasText: less.id }).getByRole('button', { name: 'Refund' }).click();
    await expect(page.getByTestId('refund-fee')).toHaveText('₹14.14 (GST ₹2.16 included)');
    await expect(page.getByTestId('refund-after-fee')).toHaveText('₹584.86');
    await page.getByRole('button', { name: 'Refund ₹584.86' }).click();
    await expect(page.getByRole('row').filter({ hasText: less.id }).filter({ hasText: 'This tool' })).toContainText('₹584.86');

    await page.getByRole('row').filter({ hasText: full.id }).getByRole('button', { name: 'Refund' }).click();
    await page.getByLabel('Full refund, our mistake').check();
    await page.getByRole('button', { name: 'Refund ₹599.00' }).click();
    await expect(page.getByRole('row').filter({ hasText: full.id }).filter({ hasText: 'This tool' })).toContainText('₹599.00');

    errors.assertNone();
  });

  test('an ordinary user gets no refund data', async ({ page }) => {
    const user = await signUpViaApi(page.context());
    await control.givePlan(user.email, 'STANDARD');
    await page.goto('/admin/refunds');
    await expect(page.getByText('You are not authorized to view the Super Admin panel.')).toBeVisible();
    await expect(page.getByTestId('refund-history')).toHaveCount(0);
  });
});
