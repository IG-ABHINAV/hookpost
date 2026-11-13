/**
 * A chargeback in the browser (owner's rule, 29 Oct 2026): the signed
 * payment.dispute.created webhook ends the plan and locks the workspace;
 * checkout refuses with the dispute message; the super admin sees the
 * chargeback on the Workspaces list, downloads the evidence pack, is refused
 * a restore while the dispute is open, and restores once Razorpay says won.
 */
import { expect, test } from '@playwright/test';
import { createHmac } from 'crypto';
import { api, BACKEND, control, failOnServerErrors, signUpViaApi } from './support';

const WEBHOOK_SECRET = 'integration-webhook-secret';
const now = () => Math.floor(Date.now() / 1000);

async function webhook(event: string, payload: Record<string, any>) {
  const body: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload)) body[k] = { entity: v };
  const raw = JSON.stringify({ entity: 'event', event, contains: Object.keys(payload), payload: body, created_at: now() });
  const res = await fetch(`${BACKEND}/razorpay/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
    },
    body: raw,
  });
  expect(res.status).toBe(201);
}

test('chargeback: plan ends, checkout refuses, admin downloads the evidence and restores once won', async ({
  page,
  browser,
}) => {
  const errors = failOnServerErrors(page);
  const ctx = await browser.newContext();
  const customer = await signUpViaApi(ctx, { country: 'IN' });
  await ctx.close();
  await control.billingFixture({
    email: customer.email,
    country: 'IN',
    plan: { tier: 'STANDARD' },
    razorpay: { status: 'active', paid_count: 1, total_count: 120, remaining_count: 119, current_start: now(), current_end: now() + 30 * 86400 },
  });

  const { payment, dispute, subscriptionId } = await control.razorpayDispute(customer.email);
  await webhook('payment.dispute.created', { payment, dispute });

  expect((await control.razorpay()).subscriptions.find((s: any) => s.id === subscriptionId).status).toBe('cancelled');
  const checkout = await api(customer.auth, 'POST', '/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
  expect(checkout.status).toBe(409);
  expect(checkout.body.message).toBe('Your account has a payment dispute. Contact support@hookstep.in');

  // The super admin's Workspaces list.
  const admin = await signUpViaApi(page.context());
  await control.givePlan(admin.email, 'STANDARD');
  await control.makeSuperAdmin(admin.email);
  await page.goto('/admin/users');
  await page.getByTestId('users-source-DIRECT').click();
  const list = page.getByTestId('workspaces-list');
  await list.getByPlaceholder(/Search workspace/).fill(customer.email);
  const row = list.getByTestId('workspace-row');
  await expect(row).toHaveCount(1);
  const box = row.getByTestId('workspace-dispute');
  await expect(box).toContainText('Chargeback');

  const download = page.waitForEvent('download');
  await box.getByRole('button', { name: 'Evidence pack' }).click();
  const file = await download;
  const text = await (await file.createReadStream())!.toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toContain(payment.id);

  page.on('dialog', (d) => d.accept());
  await box.getByRole('button', { name: 'Restore plan (won)' }).click();
  await expect(box.getByTestId('workspace-dispute-note')).toContainText('not won');

  await control.razorpayDisputeStatus(dispute.id, 'won');
  await box.getByRole('button', { name: 'Restore plan (won)' }).click();
  await expect(row.getByTestId('workspace-dispute')).toHaveCount(0);
  const self = await api(customer.auth, 'GET', '/user/self');
  expect(self.body.tier?.current || self.body.tier).toBeTruthy();
  errors.assertNone();
});
