/**
 * Paid plans end to end, with an in-memory Razorpay (FakeRazorpay): checkout
 * creates a subscription for the workspace, the signed webhook (or the
 * checkout's /razorpay/verify) provisions the plan in the database, the plan
 * lifts the Free limits, and Cancel keeps the plan to the end of what was
 * paid for. Signature checks are real HMACs over the raw body.
 */
import { createHmac } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { apiKeyOf, db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';

/** Polls `read` until it returns `count` items (emails go out after the response). */
async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('billing with Razorpay', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = (event: string, entities: Record<string, any>, signature?: string) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    return t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature ?? signed.signature,
      },
    });
  };

  async function checkout(session: Session, billing = 'STANDARD', period = 'MONTHLY') {
    const res = await session.post('/billing/subscribe', { billing, period });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    return res.body as { subscriptionId: string; url: string; currency: string };
  }

  describe('checkout', () => {
    it('GET /user/subscription/tiers lists the plans in rupees', async () => {
      const s = await t.api.register();
      const res = await s.get('/user/subscription/tiers');
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).toContain('599');
      expect(text).toContain('1999');
    });

    it('GET /billing/pricing-context: INR for a signed-in workspace', async () => {
      const s = await t.api.register();
      const res = await s.get('/billing/pricing-context');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.stringify(res.body)).toContain('INR');
    });

    it('POST /billing/subscribe creates a customer, the plan and a subscription for this workspace', async () => {
      const s = await t.api.register({ company: 'Checkout Co' });
      const { orgId } = await s.self();
      const out = await checkout(s);
      expect(out.currency).toBe('INR');
      const sub = rzp.subscriptions.get(out.subscriptionId);
      expect(sub.notes).toMatchObject({ service: 'hookpost', orgId, billing: 'STANDARD', period: 'MONTHLY' });
      const plan = rzp.plans.get(sub.plan_id);
      expect(plan.item).toMatchObject({ amount: 59900, currency: 'INR' });

      const org = await db().organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org.paymentId).toBe(sub.customer_id);
      // Nothing is provisioned until Razorpay confirms.
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('a first plan starts with a trial: the first charge is days away', async () => {
      const s = await t.api.register({ company: 'Trial Checkout Co' });
      const out = await checkout(s);
      const sub = rzp.subscriptions.get(out.subscriptionId);
      const days = (sub.start_at - Date.now() / 1000) / 86400;
      expect(days).toBeGreaterThan(1);
      expect(days).toBeLessThanOrEqual(8);
    });

    it('the same plan is reused, never created twice', async () => {
      const a = await t.api.register();
      const b = await t.api.register();
      await checkout(a, 'PRO');
      await checkout(b, 'PRO');
      const proPlans = [...rzp.plans.values()].filter((p) => p.item.amount === 199900);
      expect(proPlans).toHaveLength(1);
    });
  });

  describe('webhook', () => {
    it('refuses a bad signature with 400 and changes nothing', async () => {
      const s = await t.api.register();
      const out = await checkout(s);
      const sub = rzp.authorise(out.subscriptionId, { trialDays: 7 });
      const res = await postWebhook('subscription.authenticated', { subscription: sub }, 'f'.repeat(64));
      expect(res.status).toBe(400);
      const { orgId } = await s.self();
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('refuses a missing signature', async () => {
      const res = await t.api.request('POST', '/razorpay/webhook', {
        raw: JSON.stringify({ event: 'subscription.activated', payload: {} }),
        headers: { 'content-type': 'application/json' },
      });
      expect(res.status).toBe(400);
    });

    it('subscription.authenticated provisions the plan; the workspace leaves Free', async () => {
      const s = await t.api.register({ company: 'Webhook Co' });
      const { orgId } = await s.self();
      const out = await checkout(s);
      const sub = rzp.authorise(out.subscriptionId, { trialDays: 7 });

      const res = await postWebhook('subscription.authenticated', { subscription: sub });
      expect(res.status).toBe(201);

      const row = await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(row).toMatchObject({ subscriptionTier: 'STANDARD', period: 'MONTHLY', identifier: out.subscriptionId });
      const self = await s.self();
      expect(self.tier).toBe('STANDARD');

      // The plan is real everywhere: the public API now accepts the key.
      const key = await apiKeyOf(orgId);
      expect((await t.api.publicApi(key, 'GET', '/is-connected')).status).toBe(200);
    });

    it('a redelivered webhook is idempotent, and the trial welcome is sent once', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const sub = rzp.authorise((await checkout(s)).subscriptionId, { trialDays: 7 });
      await postWebhook('subscription.authenticated', { subscription: sub });
      await postWebhook('subscription.authenticated', { subscription: sub });
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(1);

      // Through Resend (recorded by fake.resend.ts), to the workspace owner.
      const sent = await eventually(() => resendSendsTo(s.email), 1);
      await new Promise((r) => setTimeout(r, 300)); // a second send would land by now
      expect(resendSendsTo(s.email).map((m) => m.subject)).toEqual(['Your Hookpost Standard trial has started']);
      expect(`${sent[0].text} ${sent[0].html}`).toMatch(/\d+-day/);
    });

    it('an event for another product on the shared account is ignored', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const sub = rzp.authorise((await checkout(s)).subscriptionId);
      const foreign = { ...sub, notes: { ...sub.notes, service: 'tablamigo' } };
      const res = await postWebhook('subscription.activated', { subscription: foreign });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('subscription.cancelled after the paid period ends the plan', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const sub = rzp.authorise((await checkout(s)).subscriptionId);
      await postWebhook('subscription.activated', { subscription: sub });
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(1);

      const ended = { ...sub, status: 'cancelled', ended_at: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) - 60 };
      rzp.subscriptions.set(sub.id, ended);
      const res = await postWebhook('subscription.cancelled', { subscription: ended });
      expect(res.status).toBe(201);
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(0);
    });
  });

  describe('POST /razorpay/verify (checkout handshake)', () => {
    const sign = (subscriptionId: string, paymentId: string) =>
      createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
        .update(`${paymentId}|${subscriptionId}`)
        .digest('hex');

    it('refuses a signature Razorpay did not make', async () => {
      const res = await t.api.post('/razorpay/verify', {
        razorpay_subscription_id: 'sub_x',
        razorpay_payment_id: 'pay_x',
        razorpay_signature: 'nope',
      });
      expect(res.status).toBe(400);
    });

    it('a valid handshake provisions the plan at once', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const out = await checkout(s, 'PRO');
      rzp.authorise(out.subscriptionId, { trialDays: 7 });
      const res = await t.api.post('/razorpay/verify', {
        razorpay_subscription_id: out.subscriptionId,
        razorpay_payment_id: 'pay_test1',
        razorpay_signature: sign(out.subscriptionId, 'pay_test1'),
      });
      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } })).subscriptionTier).toBe('PRO');
    });
  });

  describe('managing the plan', () => {
    async function paidWorkspace() {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const sub = rzp.authorise((await checkout(s)).subscriptionId);
      await postWebhook('subscription.activated', { subscription: sub });
      return { s, orgId, sub };
    }

    it('GET /billing shows the current plan', async () => {
      const { s, sub } = await paidWorkspace();
      const res = await s.get('/billing');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ subscriptionTier: 'STANDARD', identifier: sub.id });
    });

    it('Cancel stops the mandate at Razorpay at once and keeps the plan here to the end of the paid period', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      const res = await s.post('/billing/cancel');
      expect(res.status).toBe(201);
      expect(res.body.immediate).toBe(false);

      const cancelCall = rzp.calls.find((c) => c.path === `/subscriptions/${sub.id}/cancel`);
      expect(cancelCall?.body).toEqual({ cancel_at_cycle_end: 0 });
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      const row = await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(row.cancelAt).not.toBeNull();
      expect(Math.abs(row.cancelAt!.getTime() / 1000 - sub.current_end)).toBeLessThan(5);
      expect((await s.self()).tier).toBe('STANDARD');

      // A second click does not cancel twice.
      const again = await s.post('/billing/cancel');
      expect(again.body.alreadyScheduled).toBe(true);
    });

    it('Cancel on a workspace without a plan says so (400)', async () => {
      const s = await t.api.register();
      const res = await s.post('/billing/cancel');
      expect(res.status).toBe(400);
    });

    it('GET /billing/invoices answers for a paid workspace', async () => {
      const { s } = await paidWorkspace();
      const res = await s.get('/billing/invoices');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('a USER member cannot cancel the plan', async () => {
      const { s, orgId } = await paidWorkspace();
      await db().subscription.update({ where: { organizationId: orgId }, data: { subscriptionTier: 'PRO' } });
      const invite = await s.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      member.showorg = orgId;
      const res = await member.post('/billing/cancel');
      expect(res.status).toBe(402);
      expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } })).cancelAt).toBeNull();
    });

    // Red team, 2 Nov 2026: finish-trial charges the owner's mandate now, and
    // it was the one billing POST any member could send.
    it('a USER member cannot bring the trial charge forward (finish-trial)', async () => {
      const { s, orgId } = await paidWorkspace();
      await db().subscription.update({ where: { organizationId: orgId }, data: { subscriptionTier: 'PRO' } });
      const invite = await s.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      member.showorg = orgId;
      await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
      const res = await member.post('/billing/finish-trial');
      expect(res.status).toBe(402);
      expect((await db().organization.findUniqueOrThrow({ where: { id: orgId } })).isTrailing).toBe(true);
    });

    it('finish-trial without a Razorpay customer does nothing', async () => {
      const s = await t.api.register();
      const res = await s.post('/billing/finish-trial');
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ finish: false });
    });

    it('an unknown coupon is refused', async () => {
      const s = await t.api.register();
      const res = await s.get('/billing/coupon/validate?code=NOT-A-REAL-CODE');
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).toMatch(/false|invalid|not/i);
    });
  });
});
