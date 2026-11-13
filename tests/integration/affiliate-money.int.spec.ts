/**
 * The affiliate programme end to end, before payouts are automated: the real
 * backend and Postgres (its unique indexes decide the races), an in-memory
 * Razorpay, and webhooks signed the way Razorpay signs them. Attribution by
 * ?ref cookie and by coupon, commission on a signed subscription.charged
 * only, redeliveries and races, refunds, paused affiliates, dollars, and the
 * admin's mark-paid with its UTR.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('affiliate money, end to end', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let admin: Session;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    admin = await t.api.register({ company: 'Hookpost HQ' });
    await makeSuperAdmin((await admin.self()).id);
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const signed = (event: string, entities: Record<string, any>) => FakeRazorpay.signedEvent(event, entities, secret());
  const postRaw = (raw: string, signature?: string) =>
    t.api.request('POST', '/razorpay/webhook', {
      raw,
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined ? { 'x-razorpay-signature': signature } : {}),
      },
    });
  const postWebhook = (event: string, entities: Record<string, any>) => {
    const s = signed(event, entities);
    return postRaw(s.raw, s.signature);
  };

  async function newAffiliate() {
    const s = await t.api.register();
    const res = await s.post('/affiliates/join', {});
    expect(res.status).toBe(201);
    const row = await db().affiliate.findFirstOrThrow({ where: { email: s.email } });
    return { session: s, affiliate: row, code: row.code };
  }

  /** A workspace that has had its trial: its plan is charged at checkout. */
  async function customer(opts: { ref?: string } = {}) {
    const s = await t.api.register();
    const self = opts.ref
      ? (await s.get('/user/self', { cookies: { hp_ref: opts.ref } })).body
      : await s.self();
    await db().organization.update({ where: { id: self.orgId }, data: { allowTrial: false } });
    return { s, orgId: self.orgId as string, userId: self.id as string };
  }

  async function paidSubscription(s: Session, body: Record<string, any> = {}) {
    const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', ...body });
    if (res.status !== 201) throw new Error(`embedded ${res.status} ${res.text}`);
    const live = rzp.authorise(res.body.subscriptionId, { method: 'upi' });
    return { live, subscriptionId: res.body.subscriptionId as string };
  }

  const commissions = (organizationId: string) =>
    db().affiliateCommission.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });

  // ---------------------------------------------------------------------------

  describe('attribution', () => {
    it('the ?ref cookie credits a new workspace, and its first charge earns 30%', async () => {
      const { affiliate, code } = await newAffiliate();
      const c = await customer({ ref: code.toUpperCase() });
      expect(await db().affiliateReferral.findUnique({ where: { organizationId: c.orgId } })).toMatchObject({
        affiliateId: affiliate.id,
      });

      const { live, subscriptionId } = await paidSubscription(c.s);
      const payment = rzp.charge(subscriptionId, 59900);
      expect((await postWebhook('subscription.charged', { subscription: live, payment })).status).toBeLessThan(300);
      expect(await commissions(c.orgId)).toEqual([
        expect.objectContaining({ paymentId: payment.id, amount: 59900, commission: 17970, currency: 'INR', status: 'PENDING' }),
      ]);
    });

    it('a workspace older than 7 days is not credited by a link', async () => {
      const { code } = await newAffiliate();
      const s = await t.api.register();
      const { orgId } = await s.self();
      await db().organization.update({ where: { id: orgId }, data: { createdAt: new Date(Date.now() - 8 * 86400_000) } });
      await s.get('/user/self', { cookies: { hp_ref: code } });
      expect(await db().affiliateReferral.findUnique({ where: { organizationId: orgId } })).toBeNull();
    });

    it('no self-referral: the affiliate\'s own link on their own workspace credits nobody', async () => {
      const { session, code } = await newAffiliate();
      const { orgId } = await session.self();
      await session.get('/user/self', { cookies: { hp_ref: code } });
      expect(await db().affiliateReferral.findUnique({ where: { organizationId: orgId } })).toBeNull();
    });

    it('one referral per workspace: a second link, and a burst of page loads, change nothing', async () => {
      const first = await newAffiliate();
      const second = await newAffiliate();
      const s = await t.api.register();
      const { orgId } = await s.self();
      await Promise.all([
        s.get('/user/self', { cookies: { hp_ref: first.code } }),
        s.get('/user/self', { cookies: { hp_ref: second.code } }),
        s.get('/user/self', { cookies: { hp_ref: first.code } }),
        s.get('/user/self', { cookies: { hp_ref: second.code } }),
      ]);
      const rows = await db().affiliateReferral.findMany({ where: { organizationId: orgId } });
      expect(rows).toHaveLength(1);
      await s.get('/user/self', { cookies: { hp_ref: rows[0].affiliateId === first.affiliate.id ? second.code : first.code } });
      expect(await db().affiliateReferral.findMany({ where: { organizationId: orgId } })).toEqual(rows);
    });

    it('the code typed as a coupon credits the workspace and earns 30% of the discounted charge', async () => {
      const { affiliate, code } = await newAffiliate();
      const c = await customer();
      const { live, subscriptionId } = await paidSubscription(c.s, { coupon: code.toUpperCase() });
      expect(live.notes.coupon).toBe(code.toUpperCase());
      const payment = rzp.charge(subscriptionId);
      await postWebhook('subscription.charged', { subscription: live, payment });

      expect(await db().affiliateReferral.findUnique({ where: { organizationId: c.orgId } })).toMatchObject({
        affiliateId: affiliate.id,
      });
      expect(await commissions(c.orgId)).toEqual([
        expect.objectContaining({ amount: payment.amount, commission: Math.round(payment.amount * 0.3) }),
      ]);
    });

    it('an affiliate cannot use their own code as a coupon', async () => {
      const { session, code } = await newAffiliate();
      const res = await session.get(`/billing/coupon/validate?code=${code.toUpperCase()}`);
      expect(res.body?.valid).not.toBe(true);
    });
  });

  // ---------------------------------------------------------------------------

  describe('webhooks', () => {
    async function referredCharge() {
      const { affiliate, code } = await newAffiliate();
      const c = await customer({ ref: code });
      const { live, subscriptionId } = await paidSubscription(c.s);
      const payment = rzp.charge(subscriptionId, 59900);
      return { affiliate, c, live, subscriptionId, payment };
    }

    it('a redelivered charge is paid once; five deliveries at the same moment, once', async () => {
      const { c, live, payment } = await referredCharge();
      const s = signed('subscription.charged', { subscription: live, payment });
      await postRaw(s.raw, s.signature);
      await postRaw(s.raw, s.signature);
      expect(await commissions(c.orgId)).toHaveLength(1);

      const { c: c2, live: live2, payment: payment2 } = await referredCharge();
      const s2 = signed('subscription.charged', { subscription: live2, payment: payment2 });
      const results = await Promise.all(Array.from({ length: 5 }, () => postRaw(s2.raw, s2.signature)));
      expect(await commissions(c2.orgId)).toEqual([expect.objectContaining({ commission: 17970 })]);
      // A delivery that lost the subscription row's own upsert race answers
      // 500 and Razorpay redelivers it: the redelivery pays nothing more.
      for (const r of results.filter((x) => x.status >= 300)) {
        expect(r.status).toBe(500);
        expect((await postRaw(s2.raw, s2.signature)).status).toBeLessThan(300);
      }
      expect(await commissions(c2.orgId)).toHaveLength(1);
    });

    it('forged or tampered webhooks are refused (400) and record nothing', async () => {
      const { c, live, payment } = await referredCharge();
      const s = signed('subscription.charged', { subscription: live, payment });
      const inflated = s.raw.replace('"amount":59900', '"amount":5990000');
      expect(inflated).not.toBe(s.raw);
      const forged = FakeRazorpay.signedEvent('subscription.charged', { subscription: live, payment }, 'guessed-secret');

      expect((await postRaw(inflated, s.signature)).status).toBe(400);
      expect((await postRaw(forged.raw, forged.signature)).status).toBe(400);
      expect((await postRaw(s.raw)).status).toBe(400);
      expect((await postRaw(s.raw, '')).status).toBe(400);
      expect((await postRaw(s.raw, s.signature.slice(1))).status).toBe(400);
      expect(await commissions(c.orgId)).toHaveLength(0);
    });

    it('zero and negative charges, and charges not captured, earn nothing', async () => {
      const { c, live, subscriptionId } = await referredCharge();
      const base = rzp.charge(subscriptionId, 59900);
      await postWebhook('subscription.charged', { subscription: live, payment: { ...base, id: 'pay_zero_' + Date.now(), amount: 0 } });
      await postWebhook('subscription.charged', { subscription: live, payment: { ...base, id: 'pay_neg_' + Date.now(), amount: -59900 } });
      await postWebhook('subscription.charged', { subscription: live, payment: { ...base, id: 'pay_fail_' + Date.now(), status: 'failed' } });
      expect(await commissions(c.orgId)).toHaveLength(0);
    });

    it('a charge on another product\'s subscription earns nothing', async () => {
      const { c, live, payment } = await referredCharge();
      await postWebhook('subscription.charged', {
        subscription: { ...live, notes: { ...live.notes, service: 'tablamigo' } },
        payment,
      });
      expect(await commissions(c.orgId)).toHaveLength(0);
    });

    it('a dollar charge is recorded in cents, in USD, apart from rupees', async () => {
      const { affiliate, c, live, payment } = await referredCharge();
      await postWebhook('subscription.charged', { subscription: live, payment: { ...payment, amount: 1900, currency: 'USD' } });
      expect(await commissions(c.orgId)).toEqual([expect.objectContaining({ amount: 1900, commission: 570, currency: 'USD' })]);
      const overview = await admin.get('/affiliates/admin');
      const row = overview.body.affiliates.find((a: any) => a.id === affiliate.id);
      expect(row.pending).toEqual({ USD: 570 });
      expect(row.payoutDue).toBe(false);
    });

    it('a refund voids the commission, and a redelivered refund or charge does not bring it back', async () => {
      const { c, live, payment } = await referredCharge();
      await postWebhook('subscription.charged', { subscription: live, payment });
      const refund = rzp.refund(payment.id, 59900);
      expect((await postWebhook('refund.processed', { refund, payment: rzp.payments.get(payment.id) })).status).toBeLessThan(300);
      expect(await commissions(c.orgId)).toEqual([expect.objectContaining({ status: 'VOID', paidNote: `refund ${refund.id}` })]);

      await postWebhook('refund.processed', { refund, payment: rzp.payments.get(payment.id) });
      await postWebhook('subscription.charged', { subscription: live, payment });
      expect((await commissions(c.orgId)).map((x) => x.status)).toEqual(['VOID']);
    });

    it('a chargeback voids the commission only once it is lost', async () => {
      const { c, live, payment } = await referredCharge();
      await postWebhook('subscription.charged', { subscription: live, payment });
      const d = rzp.dispute(payment.id);
      await postWebhook('payment.dispute.created', { dispute: d, payment });
      expect((await commissions(c.orgId)).map((x) => x.status)).toEqual(['PENDING']);

      const lost = rzp.setDisputeStatus(d.id, 'lost');
      expect((await postWebhook('payment.dispute.lost', { dispute: lost, payment })).status).toBeLessThan(300);
      expect(await commissions(c.orgId)).toEqual([expect.objectContaining({ status: 'VOID', paidNote: `chargeback ${d.id}` })]);
      await postWebhook('payment.dispute.closed', { dispute: rzp.setDisputeStatus(d.id, 'closed'), payment });
      expect((await commissions(c.orgId)).map((x) => x.status)).toEqual(['VOID']);
    });

    it('a chargeback the merchant wins leaves the commission owed', async () => {
      const { c, live, payment } = await referredCharge();
      await postWebhook('subscription.charged', { subscription: live, payment });
      const d = rzp.dispute(payment.id);
      await postWebhook('payment.dispute.won', { dispute: rzp.setDisputeStatus(d.id, 'won'), payment });
      expect((await commissions(c.orgId)).map((x) => x.status)).toEqual(['PENDING']);
    });

    it('a dollar affiliate is due at $12 on the admin overview', async () => {
      const { affiliate, c, live, subscriptionId } = await referredCharge();
      const usd = (amount: number) => ({ ...rzp.charge(subscriptionId, amount), currency: 'USD' });
      await postWebhook('subscription.charged', { subscription: live, payment: usd(3900) });
      const row = async () =>
        (await admin.get('/affiliates/admin')).body.affiliates.find((a: any) => a.id === affiliate.id);
      expect(await row()).toMatchObject({ pending: { USD: 1170 }, payoutDue: false });
      await postWebhook('subscription.charged', { subscription: live, payment: usd(100) });
      expect(await row()).toMatchObject({ pending: { USD: 1200 }, payoutDue: true });
      expect(c.orgId).toBeTruthy();
    });

    it('a paused affiliate earns nothing while paused, and earns again once resumed', async () => {
      const { affiliate, c, live, subscriptionId, payment } = await referredCharge();
      const pause = await admin.post(`/affiliates/admin/${affiliate.id}/active`, { active: false });
      expect(pause.status).toBe(201);
      await postWebhook('subscription.charged', { subscription: live, payment });
      expect(await commissions(c.orgId)).toHaveLength(0);

      await admin.post(`/affiliates/admin/${affiliate.id}/active`, { active: true });
      const next = rzp.charge(subscriptionId, 59900);
      await postWebhook('subscription.charged', { subscription: live, payment: next });
      expect((await commissions(c.orgId)).map((x) => x.paymentId)).toEqual([next.id]);
    });

    it('a 12-month deal stops earning at 12 months', async () => {
      const { affiliate, c, live, subscriptionId, payment } = await referredCharge();
      await db().affiliate.update({ where: { id: affiliate.id }, data: { commissionMonths: 12 } });
      const inside = new Date();
      inside.setUTCMonth(inside.getUTCMonth() - 11);
      await db().affiliateReferral.update({ where: { organizationId: c.orgId }, data: { createdAt: inside } });
      await postWebhook('subscription.charged', { subscription: live, payment });
      expect(await commissions(c.orgId)).toHaveLength(1);

      const outside = new Date();
      outside.setUTCMonth(outside.getUTCMonth() - 12);
      outside.setUTCMinutes(outside.getUTCMinutes() - 1);
      await db().affiliateReferral.update({ where: { organizationId: c.orgId }, data: { createdAt: outside } });
      await postWebhook('subscription.charged', { subscription: live, payment: rzp.charge(subscriptionId, 59900) });
      expect(await commissions(c.orgId)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------

  describe('admin mark-paid', () => {
    async function owed(n: number) {
      const a = await newAffiliate();
      const c = await customer({ ref: a.code });
      const { live, subscriptionId } = await paidSubscription(c.s);
      for (let i = 0; i < n; i++) {
        await postWebhook('subscription.charged', { subscription: live, payment: rzp.charge(subscriptionId, 59900) });
      }
      const ids = (await commissions(c.orgId)).map((x) => x.id);
      expect(ids).toHaveLength(n);
      return { ...a, ids };
    }
    const markPaid = (s: Session, body: any) => s.post('/affiliates/admin/commissions/paid', body);
    const statuses = async (ids: string[]) =>
      (await db().affiliateCommission.findMany({ where: { id: { in: ids } } })).map((x) => x.status);

    it('the minimum payout: ₹898.50 owed is not due, ₹1,078.20 is', async () => {
      const a = await owed(5);
      const find = async () =>
        (await admin.get('/affiliates/admin')).body.affiliates.find((x: any) => x.id === a.affiliate.id);
      expect(await find()).toMatchObject({ pending: { INR: 89850 }, payoutDue: false });
      const c = await db().affiliateReferral.findFirstOrThrow({ where: { affiliateId: a.affiliate.id } });
      const sub = [...rzp.subscriptions.values()].find((s: any) => s.notes?.orgId === c.organizationId);
      await postWebhook('subscription.charged', { subscription: sub, payment: rzp.charge(sub.id, 59900) });
      expect(await find()).toMatchObject({ pending: { INR: 107820 }, payoutDue: true });
    });

    it('only a super admin, and only as JSON', async () => {
      const a = await owed(1);
      expect((await markPaid(a.session, { ids: a.ids, note: '412345678901' })).status).toBe(403);
      const form = await admin.request('POST', '/affiliates/admin/commissions/paid', {
        raw: `ids=${a.ids[0]}&note=412345678901`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(form.status).toBeGreaterThanOrEqual(400);
      expect(await statuses(a.ids)).toEqual(['PENDING']);
    });

    it('refused without a valid UTR', async () => {
      const a = await owed(1);
      for (const note of [undefined, '', 'paid', 'UTR 12345', 'A'.repeat(23)]) {
        const res = await markPaid(admin, { ids: a.ids, ...(note === undefined ? {} : { note }) });
        expect(res.status).toBe(400);
      }
      expect((await markPaid(admin, { ids: [] , note: '412345678901' })).status).toBe(400);
      expect(await statuses(a.ids)).toEqual(['PENDING']);
    });

    it('with a UTR: paid, stamped, and a second press changes nothing', async () => {
      const a = await owed(2);
      const first = await markPaid(admin, { ids: a.ids, note: ' hdfcn5202611 0312 ' });
      expect(first.status).toBe(201);
      expect(first.body).toEqual({ count: 2 });
      const rows = await db().affiliateCommission.findMany({ where: { id: { in: a.ids } } });
      expect(rows.map((r) => [r.status, r.paidNote])).toEqual([
        ['PAID', 'HDFCN52026110312'],
        ['PAID', 'HDFCN52026110312'],
      ]);

      const again = await markPaid(admin, { ids: a.ids, note: 'HDFCN52026110312' });
      expect(again.body).toEqual({ count: 0 });
      const after = await db().affiliateCommission.findMany({ where: { id: { in: a.ids } } });
      expect(after.map((r) => r.paidAt?.getTime())).toEqual(rows.map((r) => r.paidAt?.getTime()));
    });

    it('two presses at once still pay each commission once', async () => {
      const a = await owed(2);
      const results = await Promise.all([
        markPaid(admin, { ids: a.ids, note: '512345678901' }),
        markPaid(admin, { ids: a.ids, note: '512345678901' }),
      ]);
      const total = results.reduce((n, r) => n + (r.body?.count || 0), 0);
      expect(total).toBe(2);
      expect(await statuses(a.ids)).toEqual(['PAID', 'PAID']);
    });

    it('one transfer cannot pay two affiliates, and a UTR cannot be reused for someone else', async () => {
      const a = await owed(1);
      const b = await owed(1);
      expect((await markPaid(admin, { ids: [...a.ids, ...b.ids], note: '612345678901' })).status).toBe(400);
      expect(await statuses([...a.ids, ...b.ids])).toEqual(['PENDING', 'PENDING']);

      expect((await markPaid(admin, { ids: a.ids, note: '612345678901' })).status).toBe(201);
      expect((await markPaid(admin, { ids: b.ids, note: '612345678901' })).status).toBe(400);
      expect(await statuses(b.ids)).toEqual(['PENDING']);
    });

    it('a paid commission cannot be voided, and a refund after payout leaves it PAID', async () => {
      const a = await owed(1);
      await markPaid(admin, { ids: a.ids, note: '712345678901' });
      const res = await admin.post(`/affiliates/admin/commissions/${a.ids[0]}/void`, { note: 'refunded' });
      expect(res.body).toEqual({ count: 0 });
      const row = await db().affiliateCommission.findUniqueOrThrow({ where: { id: a.ids[0] } });
      const refund = rzp.refund(row.paymentId, row.amount);
      await postWebhook('refund.processed', { refund, payment: rzp.payments.get(row.paymentId) });
      expect(await statuses(a.ids)).toEqual(['PAID']);
    });
  });
});
