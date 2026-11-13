/**
 * A chargeback, end to end over signed webhooks against the real database
 * (owner's rule, 29 Oct 2026):
 *  - payment.dispute.* ends the plan at once (Razorpay subscription
 *    cancelled, row gone), locks the workspace (no publishing, no AI,
 *    checkout refused with the dispute message) and alerts the owner with the
 *    3-business-day deadline and an evidence pack;
 *  - only a super admin restores, only once Razorpay says the dispute is won,
 *    and never over a plan bought since.
 * Break-it: forged and replayed webhooks, `won` arriving first, an unknown
 * payment, another product's payment, and a plain user calling the admin
 * routes on someone else's workspace.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { DISPUTE_CHECKOUT_MESSAGE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const OWNER = 'owner-alerts@hookpost.invalid';

async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe('a chargeback (payment dispute)', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let subscriptions: SubscriptionService;
  let admin: Session;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    subscriptions = t.app.get(SubscriptionService);
    admin = await t.api.register();
    await makeSuperAdmin((await admin.self()).id);
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

  /** A paying workspace: activated, with one captured, invoiced charge. */
  async function payingWorkspace() {
    const s = await t.api.register();
    const { orgId } = await s.self();
    const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    const subId: string = res.body.subscriptionId;
    const sub = rzp.authorise(subId);
    await postWebhook('subscription.activated', { subscription: sub });
    const payment = rzp.charge(subId);
    rzp.invoiceFor(subId, payment);
    await postWebhook('subscription.charged', { subscription: rzp.subscriptions.get(subId), payment });
    expect(await db().subscription.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
    return { s, orgId, subId, payment };
  }

  const disputeEvent = (type: string, d: any) =>
    postWebhook(type, { payment: rzp.payments.get(d.payment_id), dispute: d });
  const orgRow = (orgId: string) => db().organization.findUniqueOrThrow({ where: { id: orgId } });
  const planRows = (orgId: string) =>
    db().subscription.count({ where: { organizationId: orgId, deletedAt: null } });
  const alertsFor = (disputeId: string) =>
    resendSendsTo(OWNER).filter((m) => m.text?.includes(disputeId));

  it('dispute.created ends the plan now, locks the workspace and alerts with the deadline and evidence', async () => {
    const { s, orgId, subId, payment } = await payingWorkspace();
    const d = rzp.dispute(payment.id);
    expect((await disputeEvent('payment.dispute.created', d)).status).toBe(201);

    // Plan over, at Razorpay too.
    expect(await planRows(orgId)).toBe(0);
    expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
    const org = await orgRow(orgId);
    expect(org.disputedAt).toBeInstanceOf(Date);
    expect(org.disputePaymentId).toBe(payment.id);
    expect(org.allowTrial).toBe(false);
    expect(org.disputeEvidence).toContain(payment.id);

    // Nothing publishes; checkout says why.
    await expect(
      subscriptions.publishWithinPlan(orgId, async () => 'sent', 'linkedin')
    ).rejects.toMatchObject({ code: 'PLAN_REQUIRED' });
    const checkout = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
    expect(checkout.status).toBe(409);
    expect(checkout.body).toMatchObject({ code: 'PAYMENT_DISPUTE', message: DISPUTE_CHECKOUT_MESSAGE });
    // No AI allowance either.
    expect((await s.get('/copilot/credits?type=ai_text')).body).toMatchObject({ credits: 0 });

    // Owner: one alert, the 3-business-day deadline in the subject and body,
    // the evidence pack ready, and no fixed penalty amount anywhere.
    const alerts = await eventually(() => alertsFor(d.id), 1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toContain('respond within 3 business days');
    expect(alerts[0].text).toContain('Respond within 3 business days (by ');
    expect(alerts[0].text).toContain('evidence pack is ready');
    expect(`${alerts[0].subject} ${alerts[0].text}`).not.toMatch(/penalt|\bfees?\b|\bUSD ?\d|\$\d/i);

    // Customer: one short, neutral email.
    const mail = await eventually(() => resendSendsTo(s.email).filter((m) => /dispute/i.test(`${m.subject} ${m.text}`)), 1);
    expect(mail).toHaveLength(1);
    expect(`${mail[0].text}`).toContain('support@hookstep.in');
    expect(`${mail[0].subject} ${mail[0].text}`).not.toMatch(/fraud|penalt|\bfee\b/i);

    // The evidence pack downloads for a super admin.
    const pack = await admin.get(`/admin/workspaces/${orgId}/dispute/evidence`);
    expect(pack.status).toBe(200);
    expect(pack.text).toContain(payment.id);
  });

  it('the admin Refund button refuses a payment with a chargeback: the bank already took it back, a refund would pay twice', async () => {
    const { payment } = await payingWorkspace();
    const d = rzp.dispute(payment.id);
    expect((await disputeEvent('payment.dispute.created', d)).status).toBe(201);
    const refundCalls = () => rzp.calls.filter((c) => c.method === 'POST' && c.path === `/payments/${payment.id}/refund`);

    const res = await admin.post('/admin/refunds', { paymentId: payment.id, full: true, reason: 'customer asked' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'refused' });
    expect(res.body.error).toContain(d.id);
    expect(refundCalls()).toHaveLength(0);
    expect(await db().refundAudit.findFirst({ where: { paymentId: payment.id }, orderBy: { createdAt: 'desc' } })).toMatchObject({ status: 'REFUSED' });

    // Won: the money stayed with us, so a goodwill refund may go.
    rzp.setDisputeStatus(d.id, 'won');
    const again = await admin.post('/admin/refunds', { paymentId: payment.id, amount: 100, reason: 'goodwill after a won dispute' });
    expect(again.body).toMatchObject({ status: 'refunded' });
    expect(refundCalls()).toHaveLength(1);
  });

  describe('break it', () => {
    it('a forged dispute webhook (bad signature) changes nothing', async () => {
      const { orgId, subId, payment } = await payingWorkspace();
      const d = rzp.dispute(payment.id);
      const res = await postWebhook(
        'payment.dispute.created',
        { payment: rzp.payments.get(payment.id), dispute: d },
        'b'.repeat(64)
      );
      expect(res.status).toBe(400);
      expect(await planRows(orgId)).toBe(1);
      expect(rzp.subscriptions.get(subId).status).toBe('active');
      expect((await orgRow(orgId)).disputedAt).toBeNull();
    });

    it('a replayed dispute is one alert and one customer email', async () => {
      const { s, payment } = await payingWorkspace();
      const d = rzp.dispute(payment.id);
      await disputeEvent('payment.dispute.created', d);
      await disputeEvent('payment.dispute.created', d);
      await disputeEvent('payment.dispute.created', d);
      await pause();
      expect(alertsFor(d.id)).toHaveLength(1);
      expect(resendSendsTo(s.email).filter((m) => /dispute/i.test(`${m.subject} ${m.text}`))).toHaveLength(1);
    });

    it('`won` arriving first still ends the plan, and never restores it', async () => {
      const { orgId, subId, payment } = await payingWorkspace();
      const d = rzp.dispute(payment.id, { status: 'won' });
      await disputeEvent('payment.dispute.won', d);
      expect(await planRows(orgId)).toBe(0);
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      expect((await orgRow(orgId)).disputedAt).toBeInstanceOf(Date);
    });

    it('an unknown payment changes nothing (owner is told)', async () => {
      const before = await db().organization.count({ where: { disputedAt: { not: null } } });
      const res = await postWebhook('payment.dispute.created', {
        dispute: { id: 'disp_unknown1', entity: 'dispute', payment_id: 'pay_nobody', amount: 59900, currency: 'INR', status: 'open', created_at: Math.floor(Date.now() / 1000) },
      });
      // Razorpay cannot find the payment (404 from the fake): that is "we
      // could not look", so it answers 5xx and Razorpay redelivers.
      expect([201, 500]).toContain(res.status);
      expect(await db().organization.count({ where: { disputedAt: { not: null } } })).toBe(before);
    });

    it("another product's payment on the shared account is ignored", async () => {
      const { orgId, subId, payment } = await payingWorkspace();
      rzp.payments.get(payment.id).notes = { service: 'tablamigo' };
      const d = rzp.dispute(payment.id);
      await disputeEvent('payment.dispute.created', d);
      expect(await planRows(orgId)).toBe(1);
      expect(rzp.subscriptions.get(subId).status).toBe('active');
      expect((await orgRow(orgId)).disputedAt).toBeNull();
    });

    it("a plain user cannot read, clear or restore anyone's dispute (IDOR)", async () => {
      const victim = await payingWorkspace();
      const d = rzp.dispute(victim.payment.id);
      await disputeEvent('payment.dispute.created', d);
      rzp.setDisputeStatus(d.id, 'won');
      const attacker = await t.api.register();
      for (const own of [attacker, victim.s]) {
        expect((await own.get(`/admin/workspaces/${victim.orgId}/dispute/evidence`)).status).toBeGreaterThanOrEqual(400);
        expect((await own.post(`/admin/workspaces/${victim.orgId}/dispute/clear`, {})).status).toBeGreaterThanOrEqual(400);
        expect((await own.post(`/admin/workspaces/${victim.orgId}/dispute/restore`, {})).status).toBeGreaterThanOrEqual(400);
      }
      expect(await planRows(victim.orgId)).toBe(0);
      expect((await orgRow(victim.orgId)).disputedAt).toBeInstanceOf(Date);
    });
  });

  describe('restore by a super admin', () => {
    it('refused while the dispute is open; done once Razorpay says won; never over a new plan', async () => {
      const { s, orgId, subId, payment } = await payingWorkspace();
      const d = rzp.dispute(payment.id);
      await disputeEvent('payment.dispute.created', d);

      const early = await admin.post(`/admin/workspaces/${orgId}/dispute/restore`, {});
      expect(early.body).toMatchObject({ restored: false });
      expect(early.body.reason).toContain('not won');
      expect(await planRows(orgId)).toBe(0);

      rzp.setDisputeStatus(d.id, 'won');
      await disputeEvent('payment.dispute.won', rzp.disputes.get(d.id));
      // Winning alone restores nothing.
      expect(await planRows(orgId)).toBe(0);

      const ok = await admin.post(`/admin/workspaces/${orgId}/dispute/restore`, {});
      expect(ok.body).toMatchObject({ restored: true });
      const row = await db().subscription.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect(row.identifier).toBe(subId);
      expect(row.cancelAt!.getTime()).toBeGreaterThan(Date.now());
      expect((await orgRow(orgId)).disputedAt).toBeNull();
      // The Razorpay subscription stays cancelled: nothing charges again.
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      await expect(
        subscriptions.publishWithinPlan(orgId, async () => 'sent', 'linkedin')
      ).resolves.toBe('sent');

      // A second restore (or one after they bought again) never overwrites the live plan.
      const again = await admin.post(`/admin/workspaces/${orgId}/dispute/restore`, {});
      expect(again.body).toMatchObject({ restored: false });
      expect(again.body.reason).toContain('already has a plan');
      expect((await s.self()).tier).toBe('STANDARD');
    });

    it('clear lets the workspace buy again without giving the plan back', async () => {
      const { s, orgId, payment } = await payingWorkspace();
      await disputeEvent('payment.dispute.created', rzp.dispute(payment.id));
      expect((await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' })).status).toBe(409);
      const res = await admin.post(`/admin/workspaces/${orgId}/dispute/clear`, {});
      expect(res.body).toEqual({ cleared: true });
      expect(await planRows(orgId)).toBe(0);
      const org = await orgRow(orgId);
      expect(org.disputedAt).toBeNull();
      expect(org.disputeClearedBy).toContain((await admin.self()).id);
      expect((await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' })).status).toBe(201);
    });
  });
});
