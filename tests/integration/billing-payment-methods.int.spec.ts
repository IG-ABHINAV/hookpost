/**
 * Every way a Razorpay subscription can be paid, through the real backend
 * over HTTP and Postgres, an in-memory Razorpay (FakeRazorpay) that refuses
 * what the live API refuses, real HMAC-signed webhooks, Resend recorded.
 *
 * What differs by method (docs/billing-payment-methods.md):
 *   - a plan change: Razorpay re-plans only an international card in place;
 *     UPI, a bank e-mandate, an Indian card and any method it may add later
 *     get a new mandate, the old one stopped once the new one is approved;
 *   - the customer can pause a UPI mandate in the app, or a card's in the
 *     bank's portal (subscription.paused), which charges nothing ever again;
 *   - an e-mandate's first debit lands a banking day after checkout, and a
 *     failed one can leave the subscription `created` with no webhook.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('Billing on every payment method', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;
  const razorpay = () => t.get<RazorpayService>(RazorpayService);

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    return t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
    });
  };
  const row = (orgId: string) => db().subscription.findUnique({ where: { organizationId: orgId } });

  /** A workspace paying Standard monthly with `method`, 10 days into its cycle. */
  async function paying(method: string, international = false): Promise<{ s: Session; orgId: string; email: string; subId: string }> {
    const s = await t.api.register();
    const { orgId, email } = await s.self();
    await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
    const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    const subId = res.body.subscriptionId as string;
    rzp.authorise(subId, { method, international });
    const sub = rzp.subscriptions.get(subId);
    sub.offer_id = null;
    sub.current_start = nowSec() - 10 * DAY;
    sub.current_end = sub.current_start + 30 * DAY;
    sub.charge_at = sub.current_end;
    const payment = rzp.charge(subId, rzp.plans.get(sub.plan_id).item.amount);
    expect((await postWebhook('subscription.charged', { subscription: { ...sub }, payment })).status).toBe(201);
    expect((await row(orgId))?.subscriptionTier).toBe('STANDARD');
    return { s, orgId, email, subId };
  }

  describe('upgrade: only an international card is re-planned in place', () => {
    it.each([
      ['UPI', 'upi'],
      ['an Indian card', 'card'],
      ['a bank e-mandate', 'emandate'],
      ['a method Razorpay may add later', 'wallet'],
    ])('%s: the quote and the change are both a new mandate; no PATCH, the old plan untouched until approval', async (_l, method) => {
      const { s, orgId, subId } = await paying(method);

      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.body).toMatchObject({ direction: 'upgrade', mode: 'new_mandate', chargeToday: 0 });

      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      expect(res.body.subscriptionId).not.toBe(subId);
      expect(rzp.calls.filter((c) => c.method === 'PATCH' && c.path === `/subscriptions/${subId}`)).toEqual([]);
      expect(rzp.subscriptions.get(subId).status).toBe('active');
      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'STANDARD', identifier: subId });
    });

    it('an international card: re-planned in place, Pro at once, one mandate', async () => {
      const { s, orgId, subId } = await paying('card', true);

      const quote = await s.post('/billing/prorate', { billing: 'PRO', period: 'MONTHLY' });
      expect(quote.body).toMatchObject({ direction: 'upgrade', mode: 'in_place' });

      const res = await s.post('/billing/embedded', { billing: 'PRO', period: 'MONTHLY' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });
      expect(await row(orgId)).toMatchObject({ subscriptionTier: 'PRO', identifier: subId });
      expect([...rzp.subscriptions.values()].filter((x) => x.notes?.orgId === orgId)).toHaveLength(1);
    });
  });

  describe('the customer pauses AutoPay outside Hookpost', () => {
    it.each(['upi', 'card'])('%s: Razorpay cancelled now, paid time kept, one email that names the pause', async (method) => {
      const { orgId, email, subId } = await paying(method);
      const sub = rzp.subscriptions.get(subId);
      sub.status = 'paused';

      expect((await postWebhook('subscription.paused', { subscription: { ...sub } })).status).toBe(201);
      await settle();
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      const kept = await row(orgId);
      expect(kept?.identifier).toBe(subId);
      expect(kept?.cancelAt?.getTime()).toBe(sub.current_end * 1000);

      // Redelivered, then Razorpay's own subscription.cancelled: nothing more.
      await postWebhook('subscription.paused', { subscription: { ...sub, status: 'paused' } });
      await postWebhook('subscription.cancelled', { subscription: { ...rzp.subscriptions.get(subId) } });
      await settle();
      const mails = resendSendsTo(email).filter((m) => /plan is cancelled/.test(m.subject));
      expect(mails).toHaveLength(1);
      expect(mails[0].html).toMatch(/paused AutoPay/);
      expect((await row(orgId))?.cancelAt?.getTime()).toBe(sub.current_end * 1000);
    });

    it('the paused webhook is lost: the hourly guard stops it the same way', async () => {
      const { orgId, subId } = await paying('upi');
      rzp.subscriptions.get(subId).status = 'paused';

      const report = await razorpay().reconcileBilling();
      expect(report.stoppedUnpaid).toContain(subId);
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      expect((await row(orgId))?.cancelAt).not.toBeNull();
    });
  });

  describe('bank e-mandate: registered at checkout, debited a banking day later', () => {
    async function emandateCheckout() {
      const s = await t.api.register();
      const { orgId, email } = await s.self();
      await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      const subId = res.body.subscriptionId as string;
      const sub = rzp.subscriptions.get(subId);
      Object.assign(sub, { payment_method: 'emandate', status: 'authenticated' });
      return { s, orgId, email, subId, sub };
    }

    it('waiting for the debit, the workspace has its paid plan, not a trial', async () => {
      const { orgId, subId, sub } = await emandateCheckout();
      expect((await postWebhook('subscription.authenticated', { subscription: { ...sub } })).status).toBe(201);
      expect(await row(orgId)).toMatchObject({ identifier: subId, subscriptionTier: 'STANDARD' });
      expect((await db().organization.findUniqueOrThrow({ where: { id: orgId } })).isTrailing).toBe(false);
    });

    it('the debit failed and the subscription stayed `created` with no webhook: ended by the guard after a week, once', async () => {
      const { orgId, email, subId, sub } = await emandateCheckout();
      await postWebhook('subscription.authenticated', { subscription: { ...sub } });
      // What Razorpay leaves behind a failed first e-mandate debit.
      Object.assign(sub, { status: 'created', paid_count: 0 });

      await razorpay().reconcileBilling();
      expect(await row(orgId)).not.toBeNull();

      sub.created_at = nowSec() - 8 * DAY;
      const report = await razorpay().reconcileBilling();
      await settle();
      expect(report.stoppedUnpaid).toContain(subId);
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      expect(await row(orgId)).toBeNull();
      await razorpay().reconcileBilling();
      await settle();
      expect(resendSendsTo(email).filter((m) => /didn't start/.test(m.subject))).toHaveLength(1);
    });
  });
});
