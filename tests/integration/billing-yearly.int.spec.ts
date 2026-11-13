/**
 * Standard yearly at ₹5,990 (owner's approval, 22 Oct 2026), end to end
 * through the real backend and an in-memory Razorpay (FakeRazorpay): the
 * plan Razorpay already holds is found, the webhook provisions YEARLY, the
 * paid period runs a year, Cancel keeps it to the end of that year, and an
 * affiliate earns 30% of the yearly charge.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('Standard yearly plan', () => {
  // The yearly plan the live account already holds (plan_TTGNFILvSBTGvD,
  // STANDARD|YEARLY|599000|INR), there before any checkout of this file.
  const HELD_YEARLY = {
    id: 'plan_heldyearly5990',
    entity: 'plan',
    period: 'yearly',
    interval: 1,
    item: { amount: 599000, currency: 'INR', name: 'Hookpost STANDARD YEARLY (INR)' },
    notes: { hookpost_key: 'STANDARD|YEARLY|599000|INR', billing: 'STANDARD', period: 'YEARLY' },
  };

  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    rzp.plans.set(HELD_YEARLY.id, HELD_YEARLY);
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

  /** A workspace that has had its trial: its next plan is charged at checkout. */
  async function trialUsed(session: Session) {
    const { orgId } = await session.self();
    await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
    return orgId;
  }

  async function subscribe(session: Session, body: Record<string, any>) {
    const res = await session.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', ...body });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    return res.body as {
      subscriptionId: string;
      currency: string;
      startAt: number | null;
      firstMonthOffer: 'upi' | 'card' | null;
      keyId: string;
    };
  }

  describe('Standard yearly, ₹5,990', () => {
    it('checkout finds the plan Razorpay already holds and asks for ten yearly cycles', async () => {
      const held = HELD_YEARLY;
      const a = await t.api.register();
      const b = await t.api.register();
      const subA = rzp.subscriptions.get((await subscribe(a, { period: 'YEARLY' })).subscriptionId);
      const subB = rzp.subscriptions.get((await subscribe(b, { period: 'YEARLY' })).subscriptionId);
      expect(subA.plan_id).toBe(held.id);
      expect(subB.plan_id).toBe(held.id);
      expect(subA.total_count).toBe(10);
      expect(subA.notes).toMatchObject({ billing: 'STANDARD', period: 'YEARLY', currency: 'INR' });
      expect([...rzp.plans.values()].filter((p) => p.item.amount === 599000)).toHaveLength(1);
    });

    it('paid: the webhook provisions YEARLY, the paid period runs a year, and an affiliate earns ₹1,797', async () => {
      const affiliateOwner = await t.api.register();
      const joined = await affiliateOwner.post('/affiliates/join', {});
      expect(joined.status).toBe(201);
      const affiliateId = (await db().affiliate.findFirstOrThrow({ where: { email: affiliateOwner.email } })).id;

      const s = await t.api.register();
      const orgId = await trialUsed(s);
      await db().affiliateReferral.create({ data: { affiliateId, organizationId: orgId } });

      const out = await subscribe(s, { period: 'YEARLY' });
      const live = rzp.authorise(out.subscriptionId, { method: 'upi' });
      const payment = rzp.charge(out.subscriptionId);
      expect(payment.amount).toBe(599000);
      const res = await postWebhook('subscription.charged', { subscription: live, payment });
      expect(res.status).toBe(201);

      const row = await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(row).toMatchObject({ subscriptionTier: 'STANDARD', period: 'YEARLY', identifier: out.subscriptionId });
      expect((await s.self()).tier).toBe('STANDARD');
      // Razorpay renews it a year out.
      expect(live.current_end - Date.now() / 1000).toBeGreaterThan(360 * 86400);

      const commissions = await db().affiliateCommission.findMany({ where: { organizationId: orgId } });
      expect(commissions).toHaveLength(1);
      expect(commissions[0]).toMatchObject({ amount: 599000, commission: 179700, currency: 'INR', status: 'PENDING' });

      // What the billing page shows this workspace pays.
      const ctx = await s.get('/billing/pricing-context');
      expect(ctx.body.currentPlan).toMatchObject({ billing: 'STANDARD', period: 'YEARLY', currency: 'INR', amount: 5990 });

      // Cancel keeps it to the end of the paid year.
      const cancel = await s.post('/billing/cancel');
      expect(cancel.status).toBe(201);
      const kept = await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(Math.abs(kept.cancelAt!.getTime() / 1000 - live.current_end)).toBeLessThan(5);
    });
  });

});
