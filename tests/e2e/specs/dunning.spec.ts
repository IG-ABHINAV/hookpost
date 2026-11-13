/**
 * A failing payment in the browser (owner's rule, 29 Oct 2026): while
 * Razorpay retries, the app shows the payment-failed banner saying AI and X
 * are paused, AI is refused with the payment-failed 402 (its dialog pays from
 * another account), posting carries on; a retry that goes through takes the
 * banner away and gives AI back. The webhooks are signed exactly as Razorpay
 * signs them, against the E2E backend's fake Razorpay account.
 */
import { expect, test } from '@playwright/test';
import { createHmac } from 'crypto';
import { api, BACKEND, control, failOnServerErrors, signUpViaApi } from './support';

/** RAZORPAY_WEBHOOK_SECRET of the test backend (tests/integration/setup/test-env.ts). */
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

test('payment failing: banner, AI refused with the pay link; a retry restores everything', async ({
  page,
  context,
}) => {
  const errors = failOnServerErrors(page);
  const { email, auth } = await signUpViaApi(context, { country: 'IN' });
  const { organizationId } = await control.billingFixture({
    email,
    country: 'IN',
    plan: { tier: 'STANDARD' },
    razorpay: {
      status: 'active',
      paid_count: 1,
      total_count: 120,
      remaining_count: 119,
      current_start: now() - 30 * 86400,
      current_end: now(),
    },
  });
  const sub = (await control.razorpay()).subscriptions.find((s: any) => s.notes?.orgId === organizationId);
  expect(sub).toBeTruthy();

  await webhook('subscription.pending', { subscription: await control.razorpayFailCharge(sub.id, 'pending') });

  await page.goto('/launches');
  const banner = page.getByTestId('payment-failed-banner');
  await expect(banner).toContainText('AI and X are paused');
  await expect(banner.getByRole('link', { name: 'Pay from a different account' })).toHaveAttribute(
    'href',
    '/billing?pay=another-account'
  );

  const ai = await api(auth, 'POST', '/posts/separate-posts', { content: 'x', len: 1 });
  expect(ai.status).toBe(402);
  expect(ai.body).toMatchObject({ code: 'PAYMENT_FAILING' });
  expect((await api(auth, 'GET', '/copilot/credits?type=ai_text')).body).toEqual({ credits: 0, paymentFailing: true });

  // The retry goes through.
  const { sub: paid, payment } = await control.razorpayRetrySucceeds(sub.id);
  await webhook('subscription.charged', { subscription: paid, payment });
  await page.reload();
  await expect(page.getByTestId('payment-failed-banner')).toHaveCount(0);
  const credits = (await api(auth, 'GET', '/copilot/credits?type=ai_text')).body;
  expect(credits.credits).toBeGreaterThan(0);
  expect(credits.paymentFailing).toBeUndefined();
  errors.assertNone();
});
