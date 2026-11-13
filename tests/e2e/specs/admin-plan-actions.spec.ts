/**
 * The super admin's "End plan now" and "Restore plan" on Admin > Users: the
 * dialog needs a reason, ends or restores the plan through the same code the
 * app uses, and the customer gets the account-correction email (Resend,
 * recorded by the E2E backend).
 */
import { expect, test } from '@playwright/test';
import { control, failOnServerErrors, signUpViaApi } from './support';

test('End plan now, then Restore plan: reason required, plan changes, the customer is emailed each time', async ({ page, browser }) => {
  const errors = failOnServerErrors(page);
  const custCtx = await browser.newContext();
  const customer = await signUpViaApi(custCtx);
  await custCtx.close();
  await control.givePlan(customer.email, 'STANDARD');

  const admin = await signUpViaApi(page.context());
  await control.givePlan(admin.email, 'STANDARD');
  await control.makeSuperAdmin(admin.email);

  await page.goto('/admin/users');
  const row = page.getByRole('row').filter({ hasText: customer.email });
  await row.getByRole('button', { name: 'End plan now' }).click();

  const send = page.getByRole('button', { name: 'End plan now' }).last();
  await expect(send).toBeDisabled();
  await page.getByPlaceholder(/Trial cancelled at Razorpay/).fill('Trial cancelled at Razorpay, never charged (E2E)');
  await page.getByRole('combobox').filter({ hasText: 'Our records showed a plan that had ended' }).selectOption('PLAN_CORRECTED_ENDED');
  await expect(send).toBeEnabled();
  await send.click();

  await expect.poll(async () => (await control.resendTo(customer.email)).length).toBe(1);
  await page.reload();
  const again = page.getByRole('row').filter({ hasText: customer.email });
  await again.getByRole('button', { name: 'Restore plan' }).click();
  await page.getByPlaceholder(/Ended by the sweep on bad facts/).fill('Ended by mistake in the E2E run');
  await page.getByRole('button', { name: 'Restore plan' }).last().click();
  await expect.poll(async () => (await control.resendTo(customer.email)).length).toBe(2);
  errors.assertNone();
});
