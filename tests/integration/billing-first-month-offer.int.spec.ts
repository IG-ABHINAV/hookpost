/**
 * 20% off the first month (first.month.offer.ts), end to end through the
 * real backend and an in-memory Razorpay (FakeRazorpay): the offer_id on a
 * new rupee monthly plan charged at checkout, the UPI or card one as the
 * customer chose, and none on a trial (the fake refuses that the way the live
 * account did on 22 Oct 2026), on yearly, with a coupon or on a plan change.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

const UPI_OFFER = process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI!;
const CARD_OFFER = process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD!;

describe('first-month offer', () => {
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

  describe('20% off the first month', () => {
    it('the pricing context says so, signed in and signed out', async () => {
      const s = await t.api.register();
      const signedIn = await s.get('/billing/pricing-context');
      expect(signedIn.body.firstMonthOffer).toEqual({ percent: 20, capInr: 400, methods: ['upi', 'card'] });
      const signedOut = await t.api.request('GET', '/public/pricing-context', {
        headers: { 'cf-ipcountry': 'IN' },
      });
      expect(signedOut.status).toBe(200);
      expect(signedOut.body.firstMonthOffer).toEqual({ percent: 20, capInr: 400, methods: ['upi', 'card'] });
    });

    it('a trial checkout carries no offer: the first charge is days away', async () => {
      const s = await t.api.register();
      const out = await subscribe(s, { payWith: 'upi' });
      const sub = rzp.subscriptions.get(out.subscriptionId);
      expect(sub.start_at).toBeGreaterThan(Date.now() / 1000);
      expect(sub.offer_id).toBeNull();
      expect(out.firstMonthOffer).toBeNull();
    });

    it('trial used, monthly, paid by card: the card offer is on the subscription', async () => {
      const s = await t.api.register();
      const orgId = await trialUsed(s);
      const out = await subscribe(s, { payWith: 'card' });
      const sub = rzp.subscriptions.get(out.subscriptionId);
      expect(out).toMatchObject({ currency: 'INR', startAt: null, firstMonthOffer: 'card' });
      expect(sub.offer_id).toBe(CARD_OFFER);
      expect(sub.start_at).toBeNull();
      expect(sub.notes).toMatchObject({ service: 'hookpost', orgId, offer: 'card', period: 'MONTHLY' });
      expect(rzp.plans.get(sub.plan_id).item).toMatchObject({ amount: 59900, currency: 'INR' });
    });

    it('UPI when chosen, and when the page did not say', async () => {
      const a = await t.api.register();
      await trialUsed(a);
      const chosen = rzp.subscriptions.get((await subscribe(a, { billing: 'PRO', payWith: 'upi' })).subscriptionId);
      expect(chosen.offer_id).toBe(UPI_OFFER);

      const b = await t.api.register();
      await trialUsed(b);
      const unsaid = rzp.subscriptions.get((await subscribe(b, {})).subscriptionId);
      expect(unsaid.offer_id).toBe(UPI_OFFER);
    });

    it('a payWith that is neither UPI nor card is refused (400)', async () => {
      const s = await t.api.register();
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', payWith: 'wallet' });
      expect(res.status).toBe(400);
    });

    it('not on yearly', async () => {
      const s = await t.api.register();
      await trialUsed(s);
      const sub = rzp.subscriptions.get((await subscribe(s, { period: 'YEARLY', payWith: 'upi' })).subscriptionId);
      expect(sub.offer_id).toBeNull();
    });

    it('not with a coupon (an affiliate code): the coupon wins', async () => {
      const s = await t.api.register();
      await trialUsed(s);
      await db().coupon.create({ data: { code: 'OFFERTEST10', percentOff: 10 } });
      const out = await subscribe(s, { coupon: 'OFFERTEST10', payWith: 'upi' });
      const sub = rzp.subscriptions.get(out.subscriptionId);
      expect(sub.offer_id).toBeNull();
      expect(rzp.plans.get(sub.plan_id).item.amount).toBe(53910);
      expect(out.firstMonthOffer).toBeNull();
    });

    it('not on an upgrade: Standard to Pro on a UPI mandate opens a new one without the offer', async () => {
      const s = await t.api.register();
      const orgId = await trialUsed(s);
      const first = await subscribe(s, { payWith: 'upi' });
      const live = rzp.authorise(first.subscriptionId, { method: 'upi' });
      await postWebhook('subscription.activated', { subscription: live });
      expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } })).identifier).toBe(
        first.subscriptionId
      );

      rzp.refuseUpiPatch = true;
      try {
        const upgrade = await subscribe(s, { billing: 'PRO', payWith: 'upi' });
        const sub = rzp.subscriptions.get(upgrade.subscriptionId);
        expect(sub.id).not.toBe(first.subscriptionId);
        expect(sub.offer_id).toBeNull();
        expect(upgrade.firstMonthOffer).toBeNull();
      } finally {
        rzp.refuseUpiPatch = false;
      }
    });

    it('an offer Razorpay does not know: checkout still opens, at the full price', async () => {
      const s = await t.api.register();
      await trialUsed(s);
      rzp.offers.delete(CARD_OFFER);
      try {
        const out = await subscribe(s, { payWith: 'card' });
        expect(out.firstMonthOffer).toBeNull();
        expect(rzp.subscriptions.get(out.subscriptionId).offer_id).toBeNull();
      } finally {
        rzp.offers.add(CARD_OFFER);
      }
    });
  });

});
