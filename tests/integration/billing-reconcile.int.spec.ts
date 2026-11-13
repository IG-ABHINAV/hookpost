/**
 * Cancel stops Razorpay at once, the database keeps the paid access, and the
 * pre-charge guard (RazorpayService.reconcileBilling) makes sure the two never
 * disagree about whether a customer will be charged. The real backend over
 * HTTP and Postgres, an in-memory Razorpay (FakeRazorpay), real HMAC-signed
 * webhooks, Resend recorded (fake.resend.ts).
 *
 * Owner decision, 29 Oct 2026: Cancel (paid, no refund) cancels at Razorpay
 * with cancel_at_cycle_end 0; the row alone keeps access until the paid end;
 * the subscription.cancelled webhook Razorpay sends right after must not end
 * the plan early; "cancelled, works until <date>" at press time, "plan ended"
 * at the date; Reactivate opens a new mandate starting at the old paid end.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

const OWNER = 'owner-alerts@hookpost.invalid';
const HOUR = 3600;
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('Cancel at once, paid access kept here, and the pre-charge guard', () => {
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

  async function paidWorkspace(): Promise<{ s: Session; orgId: string; sub: any }> {
    const s = await t.api.register();
    const { orgId } = await s.self();
    const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    const sub = rzp.authorise(res.body.subscriptionId);
    await postWebhook('subscription.activated', { subscription: sub });
    return { s, orgId, sub };
  }
  const row = (orgId: string) => db().subscription.findUnique({ where: { organizationId: orgId } });
  const cancelledMails = (email: string) =>
    resendSendsTo(email).filter((m) => /plan is cancelled/.test(m.subject));
  const subjects = (email: string) => resendSendsTo(email).map((m) => m.subject);

  it('Cancel: Razorpay stops now, the plan runs to current_end, one "works until" email', async () => {
    const { s, orgId, sub } = await paidWorkspace();

    const res = await s.post('/billing/cancel');
    expect(res.status).toBe(201);

    const calls = rzp.calls.filter((c) => c.path === `/subscriptions/${sub.id}/cancel`);
    expect(calls.map((c) => c.body)).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
    const saved = (await row(orgId))!;
    expect(Math.abs(saved.cancelAt!.getTime() / 1000 - sub.current_end)).toBeLessThan(5);
    expect((await s.self()).tier).toBe('STANDARD');

    const mails = await eventually(() => cancelledMails(s.email), 1);
    await settle();
    expect(cancelledMails(s.email)).toHaveLength(1);
    expect(`${mails[0].text}`).toMatch(/until/i);
  });

  it('the subscription.cancelled Razorpay sends straight after, delivered twice, neither ends the plan early nor emails again', async () => {
    const { s, orgId, sub } = await paidWorkspace();
    await s.post('/billing/cancel');
    const before = (await row(orgId))!.cancelAt!.getTime();
    await eventually(() => cancelledMails(s.email), 1);

    const cancelled = { ...rzp.subscriptions.get(sub.id) };
    expect((await postWebhook('subscription.cancelled', { subscription: cancelled })).status).toBe(201);
    expect((await postWebhook('subscription.cancelled', { subscription: cancelled })).status).toBe(201);
    await settle();

    expect((await row(orgId))!.cancelAt!.getTime()).toBe(before);
    expect((await s.self()).tier).toBe('STANDARD');
    expect(cancelledMails(s.email)).toHaveLength(1);
  });

  it('a double-submitted Cancel: both answer, the paid end is kept, one email', async () => {
    const { s, orgId, sub } = await paidWorkspace();
    const [a, b] = await Promise.all([s.post('/billing/cancel'), s.post('/billing/cancel')]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
    const saved = (await row(orgId))!;
    expect(Math.abs(saved.cancelAt!.getTime() / 1000 - sub.current_end)).toBeLessThan(5);
    await eventually(() => cancelledMails(s.email), 1);
    await settle();
    expect(cancelledMails(s.email)).toHaveLength(1);
  });

  it('a forged subscription.cancelled changes nothing', async () => {
    const { orgId, sub } = await paidWorkspace();
    const forged = { ...sub, status: 'cancelled', ended_at: nowSec(), current_end: nowSec() - 60 };
    const signed = FakeRazorpay.signedEvent('subscription.cancelled', { subscription: forged }, 'not-the-secret');
    await t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signed.signature },
    });
    const kept = (await row(orgId))!;
    expect(kept.identifier).toBe(sub.id);
    expect(kept.cancelAt).toBeNull();
  });

  it('Reactivate after Cancel: a new mandate whose first charge is the old paid end, nothing today', async () => {
    const { s, orgId, sub } = await paidWorkspace();
    await s.post('/billing/cancel');
    const paidEnd = Math.floor((await row(orgId))!.cancelAt!.getTime() / 1000);

    const quote = await s.get('/billing/reactivate/quote');
    expect(quote.status).toBe(200);
    expect(quote.body.chargeToday).toBe(0);

    const res = await s.post('/billing/reactivate');
    expect(res.status).toBe(201);
    const created = rzp.subscriptions.get(res.body.subscriptionId)!;
    expect(created.start_at).toBe(paidEnd);
    expect(created.notes.replaces).toBe(sub.id);
    // The old plan is untouched until the new mandate is approved.
    expect((await row(orgId))!.identifier).toBe(sub.id);
  });

  it('at the paid end the sweep ends the plan and sends "plan ended" once, with no Razorpay call', async () => {
    const { s, orgId } = await paidWorkspace();
    await s.post('/billing/cancel');
    const end = (await row(orgId))!.cancelAt!;
    await eventually(() => cancelledMails(s.email), 1);
    const cancelsBefore = rzp.calls.filter((c) => c.path.endsWith('/cancel')).length;

    const after = new Date(end.getTime() + HOUR * 1000);
    await razorpay().endLapsedCancellations(after);
    await razorpay().endLapsedCancellations(after);

    expect(await row(orgId)).toBeNull();
    const ended = () => resendSendsTo(s.email).filter((m) => /has ended/.test(m.subject));
    await eventually(ended, 1);
    await settle();
    expect(ended()).toHaveLength(1);
    expect(rzp.calls.filter((c) => c.path.endsWith('/cancel')).length).toBe(cancelsBefore);
  });

  it('the guard stops a legacy cycle-end cancel Razorpay never proved, at the 11 Nov race (charge_at == cancelAt), keeps access, emails once, alerts the owner', async () => {
    const { s, orgId, sub } = await paidWorkspace();
    // The state the 28 Oct cancel left: cancel_at_cycle_end 1 posted, the
    // entity still active and set to charge on the instant the plan ends here.
    const at = nowSec() + DAY;
    await rzp.handle('POST', `/subscriptions/${sub.id}/cancel`, { cancel_at_cycle_end: 1 });
    Object.assign(rzp.subscriptions.get(sub.id)!, {
      status: 'active',
      current_end: at,
      charge_at: at,
      has_scheduled_changes: false,
    });
    await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(at * 1000) } });

    const report = await razorpay().reconcileBilling();
    const again = await razorpay().reconcileBilling();

    expect(report.cancelled.map((c) => c.subscriptionId)).toEqual([sub.id]);
    expect(again.cancelled).toEqual([]);
    expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
    expect(rzp.calls.filter((c) => c.path === `/subscriptions/${sub.id}/cancel`).map((c) => c.body)).toEqual([
      { cancel_at_cycle_end: 1 },
      { cancel_at_cycle_end: 0 },
    ]);
    // The row is what grants access: untouched.
    expect((await row(orgId))!.cancelAt!.getTime()).toBe(at * 1000);
    expect((await s.self()).tier).toBe('STANDARD');

    const stopped = () => subjects(s.email).filter((x) => /stopped a charge/.test(x));
    await eventually(stopped, 1);
    await settle();
    expect(stopped()).toHaveLength(1);
    const alerts = await eventually(
      () =>
        resendSendsTo(OWNER).filter(
          (m) => `${m.subject}\n${m.text}`.includes(sub.id) && /pre-charge guard/i.test(`${m.subject}\n${m.text}`)
        ),
      1
    );
    expect(alerts.length).toBe(1);
  });

  it('the guard never touches a paying customer with no end date, nor one whose charge is weeks away', async () => {
    const paying = await paidWorkspace();
    const ending = await paidWorkspace();
    await db().subscription.update({
      where: { organizationId: ending.orgId },
      data: { cancelAt: new Date((nowSec() + 20 * DAY) * 1000) },
    });
    Object.assign(rzp.subscriptions.get(ending.sub.id)!, { current_end: nowSec() + 20 * DAY, charge_at: nowSec() + 20 * DAY });

    const report = await razorpay().reconcileBilling();

    const ids = report.cancelled.map((c) => c.subscriptionId);
    expect(ids).not.toContain(paying.sub.id);
    expect(ids).not.toContain(ending.sub.id);
    expect(rzp.subscriptions.get(paying.sub.id)?.status).toBe('active');
    expect(rzp.subscriptions.get(ending.sub.id)?.status).toBe('active');
  });

  it('refund, then Cancel days later with the refund webhook missed: the plan ends at once', async () => {
    const { s, orgId, sub } = await paidWorkspace();
    const pay = rzp.charge(sub.id);
    rzp.invoices.push({ id: 'inv_r1', entity: 'invoice', subscription_id: sub.id, customer_id: sub.customer_id, payment_id: pay.id, status: 'paid', amount: pay.amount, created_at: nowSec() });
    rzp.refund(pay.id, pay.amount);

    const res = await s.post('/billing/cancel');
    expect(res.status).toBe(201);
    expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
    expect(await row(orgId)).toBeNull();
  });

  describe('a charge after cancel is refunded in full automatically', () => {
    const lateCharge = async () => {
      const { s, orgId, sub } = await paidWorkspace();
      await s.post('/billing/cancel');
      const end = (await row(orgId))!.cancelAt!;
      await eventually(() => cancelledMails(s.email), 1);
      // The bank debits the renewal it was told about before Cancel.
      const live = rzp.subscriptions.get(sub.id)!;
      const payment = rzp.charge(sub.id);
      Object.assign(live, {
        paid_count: (live.paid_count || 1) + 1,
        current_start: live.current_end,
        current_end: Number(live.current_end) + 30 * DAY,
      });
      return { s, orgId, sub: { ...live }, payment, end };
    };
    const refundMails = (email: string) => resendSendsTo(email).filter((m) => /^We refunded/.test(m.subject));

    it('webhook: refunds the captured amount once, records it, emails once, tells the owner (info), keeps the plan end', async () => {
      const { s, orgId, sub, payment, end } = await lateCharge();

      await postWebhook('subscription.charged', { subscription: sub, payment });
      await postWebhook('subscription.charged', { subscription: sub, payment });
      await razorpay().reconcileBilling();

      const refunds = [...rzp.refunds.values()].filter((r) => r.payment_id === payment.id);
      expect(refunds).toHaveLength(1);
      expect(refunds[0].amount).toBe(payment.amount);
      expect(refunds[0].notes).toMatchObject({ auto: 'charged_after_cancel' });
      const audit = await db().refundAudit.findMany({ where: { paymentId: payment.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ status: 'SUCCESS', adminUserId: 'system:auto-refund', amount: payment.amount, organizationId: orgId });

      // Razorpay's refund webhook for it: the plan keeps its end, no second email.
      expect((await postWebhook('refund.processed', { refund: { ...refunds[0], status: 'processed' }, payment: rzp.payments.get(payment.id) })).status).toBe(201);
      await settle();
      expect((await row(orgId))!.cancelAt!.getTime()).toBe(end.getTime());
      expect((await s.self()).tier).toBe('STANDARD');
      const mails = await eventually(() => refundMails(s.email), 1);
      await settle();
      expect(refundMails(s.email)).toHaveLength(1);
      expect(mails[0].subject).toMatch(/your plan stays cancelled/);
      expect(resendSendsTo(s.email).filter((m) => /refund/i.test(m.subject))).toHaveLength(1);
      const alerts = await eventually(
        () => resendSendsTo(OWNER).filter((m) => `${m.subject}\n${m.text}`.includes(payment.id) && /refunded automatically/i.test(`${m.subject}\n${m.text}`)),
        1
      );
      expect(alerts).toHaveLength(1);
      expect(resendSendsTo(OWNER).filter((m) => /automatic refund failed/i.test(m.subject) && m.text.includes(payment.id))).toHaveLength(0);
    });

    it('a lost charged webhook: the hourly guard finds and refunds it, once', async () => {
      const { payment } = await lateCharge();
      const first = await razorpay().reconcileBilling();
      await razorpay().reconcileBilling();
      expect(first.autoRefunds).toContainEqual(expect.objectContaining({ paymentId: payment.id, outcome: 'refunded' }));
      expect([...rzp.refunds.values()].filter((r) => r.payment_id === payment.id)).toHaveLength(1);
    });

    it('a forged webhook naming another subscription’s payment refunds nothing', async () => {
      const victim = await paidWorkspace();
      const victimPayment = rzp.charge(victim.sub.id);
      const { sub } = await lateCharge();
      await postWebhook('subscription.charged', { subscription: sub, payment: victimPayment });
      expect([...rzp.refunds.values()].filter((r) => r.payment_id === victimPayment.id)).toHaveLength(0);
    });

    it('an ordinary renewal of a plan nobody cancelled is never refunded', async () => {
      const { sub } = await paidWorkspace();
      const payment = rzp.charge(sub.id);
      await postWebhook('subscription.charged', { subscription: rzp.subscriptions.get(sub.id), payment });
      await razorpay().reconcileBilling();
      expect([...rzp.refunds.values()].filter((r) => r.payment_id === payment.id)).toHaveLength(0);
    });
  });

  describe('a guard cancel Razorpay refuses is retried, not handed to the owner', () => {
    it('no alert, a retry 5 minutes on that succeeds, and one "we stopped a charge" email', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      const at = nowSec() + DAY;
      Object.assign(rzp.subscriptions.get(sub.id)!, { current_end: at, charge_at: at });
      await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(at * 1000) } });
      rzp.refuseCancel.add(sub.id);
      const ownerBefore = resendSendsTo(OWNER).filter((m) => m.text.includes(sub.id)).length;

      await razorpay().reconcileBilling();
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('active');
      const rec = await razorpay().readGuardRetry(sub.id);
      expect(rec?.nextAt).toBeGreaterThan(Date.now());
      await settle();
      expect(resendSendsTo(OWNER).filter((m) => m.text.includes(sub.id)).length).toBe(ownerBefore);

      rzp.refuseCancel.delete(sub.id);
      await razorpay().retryFailedGuardCancels(rec!.nextAt);
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      expect((await row(orgId))!.cancelAt!.getTime()).toBe(at * 1000);
      await eventually(() => resendSendsTo(s.email).filter((m) => /stopped a charge/.test(m.subject)), 1);
      await settle();
      expect(resendSendsTo(s.email).filter((m) => /stopped a charge/.test(m.subject))).toHaveLength(1);
    });
  });

  describe('a refund ends the plan even when its webhook is late or never comes', () => {
    const refundMails = (email: string) =>
      resendSendsTo(email).filter((m) => /refund/i.test(m.subject));

    it('Razorpay down while refund.processed is handled: 500, so Razorpay redelivers, and the redelivery ends the plan', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      const payment = rzp.charge(sub.id);
      const refund = rzp.refund(payment.id, payment.amount);
      rzp.unavailable.add(`GET /payments/${payment.id}`);

      expect((await postWebhook('refund.processed', { refund })).status).toBe(500);
      expect((await row(orgId))?.identifier).toBe(sub.id);
      await settle();
      expect(refundMails(s.email)).toHaveLength(0);

      rzp.unavailable.clear();
      expect((await postWebhook('refund.processed', { refund })).status).toBe(201);
      expect(await row(orgId)).toBeNull();
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      await eventually(() => refundMails(s.email), 1);
    });

    it('the admin Refund button: Razorpay refunds, and its refund.processed ends the plan; a partial refund too', async () => {
      const admin = await t.api.register({ company: 'Hookpost HQ' });
      await makeSuperAdmin((await admin.self()).id);
      const { s, orgId, sub } = await paidWorkspace();
      const payment = rzp.charge(sub.id);

      // ₹1 of it: any amount ends the plan.
      const res = await admin.post('/admin/refunds', { paymentId: payment.id, amount: 100, reason: 'customer asked' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'refunded', amount: 100 });
      const refund = [...rzp.refunds.values()].find((r) => r.payment_id === payment.id)!;
      // Pending at Razorpay: the plan is still on until it is processed.
      expect((await row(orgId))?.identifier).toBe(sub.id);

      refund.status = 'processed';
      expect((await postWebhook('refund.processed', { refund })).status).toBe(201);
      expect(await row(orgId)).toBeNull();
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      await eventually(() => refundMails(s.email), 1);
      await settle();
      expect(refundMails(s.email)).toHaveLength(1);
    });

    it('a dashboard refund whose webhook never arrives: the hourly sweep ends the plan, and a late webhook changes nothing more', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      const payment = rzp.charge(sub.id);
      const refund = rzp.refund(payment.id, 100, { notes: { comment: 'goodwill' } });

      await razorpay().sweepMissedRefunds();

      expect(await row(orgId)).toBeNull();
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      expect((await s.self()).tier).not.toBe('STANDARD');
      await eventually(() => refundMails(s.email), 1);

      // Razorpay's webhook turns up after all, and the next hour's sweep runs.
      expect((await postWebhook('refund.processed', { refund, payment })).status).toBe(201);
      await razorpay().sweepMissedRefunds();
      await settle();
      expect(refundMails(s.email)).toHaveLength(1);
      expect(rzp.calls.filter((c) => c.path === `/subscriptions/${sub.id}/cancel`)).toHaveLength(1);
    });
  });
  // Owner, 29 Oct 2026 (pending-owner-msgs items 2, 3 and 17): refund then
  // Cancel days later, with the refund webhook delivered and missed; and the
  // three "charge roka" cases, each caught, stopped, emailed once and alerted.
  describe('refund then Cancel days later, and the three "charge roka" cases', () => {
    const stoppedMails = (email: string) => subjects(email).filter((x) => /stopped a charge/.test(x));
    const ownerAlertsFor = (subId: string, pattern: RegExp) =>
      resendSendsTo(OWNER).filter((m) => `${m.subject}\n${m.text}`.includes(subId) && pattern.test(`${m.subject}\n${m.text}`));
    const cancelCalls = (subId: string) => rzp.calls.filter((c) => c.path === `/subscriptions/${subId}/cancel`);
    const onPlan = async (s: Session) => ['active', 'cancelling', 'dunning', 'trialing'].includes((await s.self()).planState);
    const refundMails = (email: string) => subjects(email).filter((x) => /^Your refund/.test(x));

    async function refundedDaysAgo() {
      const w = await paidWorkspace();
      const pay = rzp.charge(w.sub.id);
      pay.created_at = nowSec() - 5 * DAY;
      // Two days back: inside the missed-refund sweep's 3-day look-back, not on its edge.
      const refund = rzp.refund(pay.id, 100, { created_at: nowSec() - 2 * DAY });
      return { ...w, pay, refund };
    }

    it('refund webhook delivered: the plan ended with the refund; Cancel days later finds nothing to charge and sends nothing more', async () => {
      const { s, orgId, sub, refund, pay } = await refundedDaysAgo();
      expect((await postWebhook('refund.processed', { refund, payment: pay })).status).toBe(201);
      expect(await row(orgId)).toBeNull();
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      await eventually(() => resendSendsTo(s.email).filter((m) => /refund/i.test(m.subject)), 1);
      const mailsBefore = resendSendsTo(s.email).length;
      const callsBefore = cancelCalls(sub.id).length;

      // Days on, the customer presses Cancel.
      expect((await s.get('/billing/cancel/quote')).body).toEqual({ endsNow: false });
      const res = await s.post('/billing/cancel');
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/no paid plan to cancel/);
      expect(cancelCalls(sub.id)).toHaveLength(callsBefore);
      expect(await onPlan(s)).toBe(false);
      await settle();
      expect(resendSendsTo(s.email)).toHaveLength(mailsBefore);
    });

    it('refund webhook missed: Cancel days later reads the refund at Razorpay and ends the plan at once, one email, one owner alert', async () => {
      const { s, orgId, sub } = await refundedDaysAgo();
      // No webhook, and the hourly sweeps have not run: the plan is still on.
      expect((await row(orgId))?.identifier).toBe(sub.id);

      expect((await s.get('/billing/cancel/quote')).body).toEqual({ endsNow: true });
      const res = await s.post('/billing/cancel');
      expect(res.status).toBe(201);
      expect(res.body.immediate).toBe(true);
      expect(cancelCalls(sub.id).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: 0 }]);
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      const ended = await row(orgId);
      expect(!ended || ended.cancelAt!.getTime() <= Date.now()).toBe(true);
      expect(await onPlan(s)).toBe(false);

      await eventually(() => cancelledMails(s.email), 1);
      await eventually(() => ownerAlertsFor(sub.id, /^Cancellation requested/), 1);
      // The hourly jobs run afterwards and add nothing.
      await razorpay().reconcileBilling();
      await razorpay().sweepMissedRefunds();
      await razorpay().endLapsedCancellations();
      await settle();
      // One "cancelled" email; the refund the webhook never announced is
      // announced once by the sweep; never "we stopped a charge".
      expect(cancelledMails(s.email)).toHaveLength(1);
      expect(refundMails(s.email)).toHaveLength(1);
      expect(stoppedMails(s.email)).toHaveLength(0);
      // The owner: the Cancel, saying the refund ended it now, and the refund itself. Once each.
      const cancelAlert = ownerAlertsFor(sub.id, /^Cancellation requested/);
      expect(cancelAlert).toHaveLength(1);
      expect(cancelAlert[0].text).toMatch(/refunded, so the plan ended now/);
      expect(resendSendsTo(OWNER).filter((m) => /^Refund: /.test(m.subject) && m.text.includes(s.email))).toHaveLength(1);
      expect(cancelCalls(sub.id)).toHaveLength(1);
    });

    it('charge roka 1, refunded but Razorpay still live (webhook missed, nobody pressed Cancel): the guard ends the plan before the next charge, emails once, alerts the owner once', async () => {
      const { s, orgId, sub } = await refundedDaysAgo();
      Object.assign(rzp.subscriptions.get(sub.id)!, { charge_at: nowSec() + DAY, current_end: nowSec() + DAY });

      const report = await razorpay().reconcileBilling();
      const again = await razorpay().reconcileBilling();
      expect((await postWebhook('subscription.cancelled', { subscription: { ...rzp.subscriptions.get(sub.id) } })).status).toBe(201);
      await razorpay().sweepMissedRefunds();

      expect(report.refundedEnded).toEqual([sub.id]);
      expect(again.refundedEnded).toEqual([]);
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      expect(cancelCalls(sub.id).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: 0 }]);
      expect(await row(orgId)).toBeNull();
      expect(await onPlan(s)).toBe(false);
      await eventually(() => stoppedMails(s.email), 1);
      await eventually(() => ownerAlertsFor(sub.id, /pre-charge guard/i), 1);
      await settle();
      expect(stoppedMails(s.email)).toHaveLength(1);
      expect(refundMails(s.email)).toHaveLength(1);
      const guardAlert = ownerAlertsFor(sub.id, /pre-charge guard/i);
      expect(guardAlert).toHaveLength(1);
      expect(guardAlert[0].text).toMatch(/was refunded but the plan was still on/);
      expect(cancelledMails(s.email)).toHaveLength(0);
      expect(ownerAlertsFor(sub.id, /^Subscription cancelled/)).toHaveLength(0);
    });

    it('charge roka 2, a Cancel that did not stick at Razorpay, at the 11 Nov race (charge_at == cancelAt): stopped before the charge, access kept to the paid end, one email, one owner alert', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      expect((await s.post('/billing/cancel')).status).toBe(201);
      const end = nowSec() + DAY;
      await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(end * 1000) } });
      // Razorpay answered the cancel but the subscription is live again and
      // set to charge on the very second the plan ends here.
      const live = rzp.subscriptions.get(sub.id)!;
      delete live.ended_at;
      Object.assign(live, { status: 'active', current_end: end, charge_at: end, has_scheduled_changes: false });

      const mailsBefore = cancelledMails(s.email).length;
      const report = await razorpay().reconcileBilling();
      await razorpay().reconcileBilling();
      // Razorpay's own subscription.cancelled for the guard's cancel, twice.
      for (let i = 0; i < 2; i++) {
        expect((await postWebhook('subscription.cancelled', { subscription: { ...rzp.subscriptions.get(sub.id) } })).status).toBe(201);
      }

      expect(report.cancelled.map((c) => c.subscriptionId)).toEqual([sub.id]);
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      expect(cancelCalls(sub.id).map((c) => c.body)).toEqual([{ cancel_at_cycle_end: 0 }, { cancel_at_cycle_end: 0 }]);
      expect((await row(orgId))!.cancelAt!.getTime()).toBe(end * 1000);
      expect((await s.self()).planState).toBe('cancelling');
      await eventually(() => stoppedMails(s.email), 1);
      await eventually(() => ownerAlertsFor(sub.id, /pre-charge guard/i), 1);
      await settle();
      expect(stoppedMails(s.email)).toHaveLength(1);
      expect(ownerAlertsFor(sub.id, /pre-charge guard/i)).toHaveLength(1);
      // The webhook adds no "cancelled" email and no second owner alert.
      expect(cancelledMails(s.email)).toHaveLength(mailsBefore);
      expect(ownerAlertsFor(sub.id, /^Subscription cancelled/)).toHaveLength(0);
      expect((await row(orgId))!.cancelAt!.getTime()).toBe(end * 1000);

      // At the end: the plan ends with one "plan ended" email, and nothing was charged.
      await razorpay().endLapsedCancellations(new Date((end + HOUR) * 1000));
      expect(await row(orgId)).toBeNull();
      expect([...rzp.payments.values()].filter((p) => p.created_at >= end)).toHaveLength(0);
    });

    it('break it (sandbox s13): a mandate nobody cancelled here, stopped by the guard; Razorpay\'s subscription.cancelled after it adds no "cancelled" email and no second owner alert', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      // The plan ended here without a Cancel (e.g. a newer mandate took over
      // and the row was ended), while Razorpay is still set to charge.
      const endedAt = nowSec() - HOUR;
      await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(endedAt * 1000) } });
      Object.assign(rzp.subscriptions.get(sub.id)!, { current_end: endedAt, charge_at: nowSec() + 2 * HOUR });

      expect((await razorpay().reconcileBilling()).cancelled.map((c) => c.subscriptionId)).toEqual([sub.id]);
      for (let i = 0; i < 2; i++) {
        expect((await postWebhook('subscription.cancelled', { subscription: { ...rzp.subscriptions.get(sub.id) } })).status).toBe(201);
      }
      await eventually(() => stoppedMails(s.email), 1);
      await eventually(() => ownerAlertsFor(sub.id, /pre-charge guard/i), 1);
      await settle();
      expect(stoppedMails(s.email)).toHaveLength(1);
      expect(cancelledMails(s.email)).toHaveLength(0);
      expect(ownerAlertsFor(sub.id, /^Subscription cancelled/)).toHaveLength(0);
      expect(ownerAlertsFor(sub.id, /pre-charge guard/i)).toHaveLength(1);
    });

    it('charge roka 3, the plan ended here but Razorpay will still charge: stopped, one email, one owner alert, then the sweep ends it', async () => {
      const { s, orgId, sub } = await paidWorkspace();
      expect((await s.post('/billing/cancel')).status).toBe(201);
      const endedAt = nowSec() - HOUR;
      await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(endedAt * 1000) } });
      const live = rzp.subscriptions.get(sub.id)!;
      delete live.ended_at;
      // The cycle closed when the plan did; the debit for the next one is a little behind it.
      Object.assign(live, { status: 'active', current_end: endedAt, charge_at: nowSec() + 2 * HOUR, has_scheduled_changes: false });
      // The gates already say the plan is over.
      expect(await onPlan(s)).toBe(false);

      const mailsBefore = cancelledMails(s.email).length;
      const report = await razorpay().reconcileBilling();
      await razorpay().reconcileBilling();
      expect((await postWebhook('subscription.cancelled', { subscription: { ...rzp.subscriptions.get(sub.id) } })).status).toBe(201);

      expect(report.cancelled.map((c) => c.subscriptionId)).toEqual([sub.id]);
      expect(report.cancelled[0].reason).toMatch(/ended here/);
      expect(rzp.subscriptions.get(sub.id)?.status).toBe('cancelled');
      await eventually(() => stoppedMails(s.email), 1);
      await eventually(() => ownerAlertsFor(sub.id, /pre-charge guard/i), 1);

      await razorpay().endLapsedCancellations();
      expect(await row(orgId)).toBeNull();
      await settle();
      expect(stoppedMails(s.email)).toHaveLength(1);
      expect(ownerAlertsFor(sub.id, /pre-charge guard/i)).toHaveLength(1);
      expect(cancelledMails(s.email)).toHaveLength(mailsBefore);
      expect(ownerAlertsFor(sub.id, /^Subscription cancelled/)).toHaveLength(0);
    });
  });
  // Big-company practice (Stripe, Zoho) and California's auto-renewal law: a
  // yearly plan is told 30 days before it renews, once per renewal.
  describe('yearly renewal reminder', () => {
    const reminders = (email: string) => subjects(email).filter((x) => /renews on/.test(x));

    it('a yearly plan 30 days from renewal gets one email; a monthly one and a cancelled yearly one get none', async () => {
      const year = async () => {
        const s = await t.api.register();
        const { orgId } = await s.self();
        const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'YEARLY' });
        if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
        const sub = rzp.authorise(res.body.subscriptionId);
        await postWebhook('subscription.activated', { subscription: sub });
        Object.assign(rzp.subscriptions.get(sub.id)!, { charge_at: nowSec() + 30 * DAY - HOUR, current_end: nowSec() + 30 * DAY - HOUR });
        return { s, orgId, sub };
      };
      const renewing = await year();
      const cancelled = await year();
      expect((await cancelled.s.post('/billing/cancel')).status).toBe(201);
      const monthly = await paidWorkspace();
      Object.assign(rzp.subscriptions.get(monthly.sub.id)!, { charge_at: nowSec() + 20 * DAY });

      await razorpay().sendRenewalReminders();
      await razorpay().sendRenewalReminders();

      const got = await eventually(() => reminders(renewing.s.email), 1);
      await settle();
      expect(reminders(renewing.s.email)).toHaveLength(1);
      const mail = resendSendsTo(renewing.s.email).find((m) => /renews on/.test(m.subject))!;
      expect(got[0]).toMatch(/^Your Hookpost Standard plan renews on /);
      expect(mail.text).toMatch(/\/year/);
      expect(mail.text).toMatch(/Press Cancel in Billing/);
      expect(reminders(cancelled.s.email)).toHaveLength(0);
      expect(reminders(monthly.s.email)).toHaveLength(0);
    });
  });
});
