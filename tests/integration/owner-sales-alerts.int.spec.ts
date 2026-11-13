/**
 * The owner's sale alert end to end: the real backend (AppModule) over HTTP
 * against Postgres and Redis, an in-memory Razorpay (FakeRazorpay), Resend
 * recorded (fake.resend.ts). Real HMAC signatures over the raw body.
 *
 * - every money event emails OWNER_SALES_ALERT_EMAIL once, however often
 *   Razorpay delivers it, and the customer's own emails still go only to the
 *   customer;
 * - a forged, unsigned or tampered webhook changes nothing and alerts nobody;
 * - Resend being down never fails the webhook; the alert is queued and sent
 *   once Resend is back;
 * - the alert carries no card, UPI, phone or token detail, and says TEST
 *   when Razorpay runs on a test key (the suite's rzp_test_ key).
 */
import { createHmac } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo, setResendFailure } from './setup/fake.resend';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';

const OWNER = 'owner-alerts@hookpost.invalid';

/** Polls `read` until it returns `count` items (alerts go out after the response). */
async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** Long enough for a second, unwanted alert to land. */
const quiet = () => new Promise((r) => setTimeout(r, 400));

const ownerAlerts = () => resendSendsTo(OWNER);
const ownerAlertsAbout = (needle: string) =>
  ownerAlerts().filter((m) => `${m.subject}\n${m.text}`.includes(needle));

describe("the owner's sale alerts", () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
  });
  afterAll(async () => {
    setResendFailure(null);
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });
  afterEach(() => setResendFailure(null));

  const postRaw = (raw: string, signature?: string) =>
    t.api.request('POST', '/razorpay', {
      raw,
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined ? { 'x-razorpay-signature': signature } : {}),
      },
    });
  const postWebhook = (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(event, entities, secret());
    return postRaw(signed.raw, signed.signature);
  };

  async function checkout(session: Session, billing = 'STANDARD', period = 'MONTHLY') {
    const res = await session.post('/billing/subscribe', { billing, period });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    return res.body as { subscriptionId: string };
  }

  /** A workspace on a 3-day trial, provisioned by the authenticated webhook. */
  async function trialWorkspace(company: string) {
    const s = await t.api.register({ company });
    const { orgId } = await s.self();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });
    const res = await postWebhook('subscription.authenticated', { subscription: sub });
    expect(res.status).toBe(201);
    return { s, orgId, sub };
  }

  it('a trial: one alert to the owner for the webhook, its redelivery and the checkout callback; the welcome only to the customer', async () => {
    const s = await t.api.register({ company: 'Alert Trial Co' });
    const { orgId } = await s.self();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });

    // The webhook, Razorpay's redelivery of it and the checkout's own
    // handshake (/razorpay/verify), all at once.
    const verifySignature = createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`pay_handshake|${subscriptionId}`)
      .digest('hex');
    const [a, b, verify] = await Promise.all([
      postWebhook('subscription.authenticated', { subscription: sub }),
      postWebhook('subscription.authenticated', { subscription: sub }),
      t.api.post('/razorpay/verify', {
        razorpay_subscription_id: subscriptionId,
        razorpay_payment_id: 'pay_handshake',
        razorpay_signature: verifySignature,
      }),
    ]);
    // Writers arriving in the same instant can race on the workspace's one
    // Subscription row (unique per workspace, an upsert): the loser answers
    // 500 and Razorpay redelivers it. That is older than the alerts and
    // heals by itself; what matters here is one alert either way.
    const statuses = [a.status, b.status, verify.status];
    expect(statuses.every((x) => x === 201 || x === 500)).toBe(true);
    expect(statuses.filter((x) => x === 201).length).toBeGreaterThanOrEqual(2);
    await postWebhook('subscription.activated', { subscription: sub });
    await quiet();

    const alerts = await eventually(() => ownerAlertsAbout(subscriptionId), 1);
    await quiet();
    expect(ownerAlertsAbout(subscriptionId)).toHaveLength(1);
    const [alert] = alerts;
    expect([alert.to].flat()).toEqual([OWNER]);
    // The suite runs on a Razorpay test key: a "Test mode" badge, a clean subject.
    expect(alert.subject).toMatch(/^Trial started: Standard monthly, ₹599 · /);
    expect(alert.subject).not.toMatch(/[[\]]/);
    expect(alert.text).toContain('Test mode: Razorpay test key');
    expect(alert.html).toContain('Test mode</span>');
    expect(alert.text).toMatch(/Amount: ₹599, first charge on /);
    expect(alert.text).toContain(`Email: ${s.email}`);
    expect(alert.text).toContain('Workspace: Alert Trial Co');
    expect(alert.text).toContain(`Workspace id: ${orgId}`);
    expect(alert.text).toContain(`/admin/users?q=${orgId}`);
    expect(alert.text).toContain(`Razorpay subscription: ${subscriptionId}`);

    // The customer's own email: to the customer, never to the owner.
    const customer = await eventually(() => resendSendsTo(s.email), 1);
    expect(customer.map((m) => m.subject)).toEqual(['Your Hookpost Standard trial has started']);
    expect(ownerAlerts().some((m) => m.subject === 'Your Hookpost Standard trial has started')).toBe(false);
    expect(resendSendsTo(s.email).some((m) => /^\[(TEST\] \[)?Hookpost\]/.test(m.subject))).toBe(false);
  });

  it('a forged, unsigned or tampered webhook: 400, no plan, no alert', async () => {
    const s = await t.api.register();
    const { orgId } = await s.self();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });

    const forged = FakeRazorpay.signedEvent('subscription.authenticated', { subscription: sub }, 'not-the-secret');
    expect((await postRaw(forged.raw, forged.signature)).status).toBe(400);
    expect((await postRaw(forged.raw)).status).toBe(400);
    expect((await postRaw(forged.raw, '')).status).toBe(400);
    // A real signature, over a different body.
    const real = FakeRazorpay.signedEvent('subscription.authenticated', { subscription: sub }, secret());
    const tampered = real.raw.replace('"authenticated"', '"active"');
    expect((await postRaw(tampered, real.signature)).status).toBe(400);
    // A charge with no signature at all.
    const charge = FakeRazorpay.signedEvent(
      'subscription.charged',
      { subscription: { ...sub, status: 'active', paid_count: 1 }, payment: rzp.charge(subscriptionId) },
      'attacker'
    );
    expect((await postRaw(charge.raw)).status).toBe(400);

    await quiet();
    expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(0);
    expect(ownerAlertsAbout(subscriptionId)).toHaveLength(0);
  });

  it('the first charge and a renewal: one alert each, whatever the redeliveries', async () => {
    const { s, sub } = await trialWorkspace('Alert Charge Co');
    const first = rzp.charge(sub.id);
    const charged = { ...sub, status: 'active', paid_count: 1, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86400 };
    for (let i = 0; i < 3; i++) {
      expect((await postWebhook('subscription.charged', { subscription: charged, payment: first })).status).toBe(201);
    }
    const second = rzp.charge(sub.id);
    await postWebhook('subscription.charged', { subscription: { ...charged, paid_count: 2 }, payment: second });
    await postWebhook('subscription.charged', { subscription: { ...charged, paid_count: 2 }, payment: second });

    await eventually(() => ownerAlertsAbout(first.id), 1);
    await eventually(() => ownerAlertsAbout(second.id), 1);
    await quiet();
    expect(ownerAlertsAbout(first.id).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^First charge: Standard monthly, ₹599 · /),
    ]);
    expect(ownerAlertsAbout(second.id).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^Renewal charged: Standard monthly, ₹599 · /),
    ]);
  });

  it('Cancel in Billing: one alert with the reason; Razorpay confirming it adds none', async () => {
    const { s, sub } = await trialWorkspace('Alert Cancel Co');
    await eventually(() => ownerAlertsAbout(sub.id), 1);
    const res = await s.post('/billing/cancel', { feedback: 'Going with a cheaper tool\r\nBcc: x@y.z' });
    expect(res.status).toBe(201);
    const cancelled = { ...rzp.subscriptions.get(sub.id), status: 'cancelled', ended_at: Math.floor(Date.now() / 1000) };
    await postWebhook('subscription.cancelled', { subscription: cancelled });
    await postWebhook('subscription.cancelled', { subscription: cancelled });

    const alerts = await eventually(() => ownerAlertsAbout('Cancellation requested'), 1);
    await quiet();
    const mine = ownerAlerts().filter((m) => m.text?.includes(sub.id) && /Cancel/.test(m.subject));
    expect(mine).toHaveLength(1);
    expect(alerts.find((m) => m.text?.includes(sub.id))!.text).toContain(
      'Reason given: Going with a cheaper tool Bcc: x@y.z'
    );
    expect(mine[0].text!.split('\n').some((l) => l.startsWith('Bcc:'))).toBe(false);
  });

  it('Resend down: the webhook still provisions the plan; the queued alert is sent once Resend is back', async () => {
    const service = t.get<OwnerSalesAlertService>(OwnerSalesAlertService);
    // Three quick attempts instead of the production 0 / 2 s / 10 s.
    const delays = service.retryDelaysMs;
    service.retryDelaysMs = [0, 10, 10];
    try {
      setResendFailure('error');
      const s = await t.api.register({ company: 'Alert Outage Co' });
      const { orgId } = await s.self();
      const { subscriptionId } = await checkout(s);
      const sub = rzp.authorise(subscriptionId, { trialDays: 3 });

      const res = await postWebhook('subscription.authenticated', { subscription: sub });
      expect(res.status).toBe(201);
      expect(await db().subscription.count({ where: { organizationId: orgId } })).toBe(1);
      await quiet();
      expect(ownerAlertsAbout(subscriptionId)).toHaveLength(0);

      setResendFailure(null);
      // A redelivery meanwhile sends nothing more...
      await postWebhook('subscription.authenticated', { subscription: sub });
      await quiet();
      expect(ownerAlertsAbout(subscriptionId)).toHaveLength(0);
      // ...and the retry run sends the queued alert, once.
      await service.retryPending();
      await service.retryPending();
      expect(ownerAlertsAbout(subscriptionId)).toHaveLength(1);
    } finally {
      service.retryDelaysMs = delays;
    }
  });

  it('Resend throwing: the charge webhook still answers 201', async () => {
    const service = t.get<OwnerSalesAlertService>(OwnerSalesAlertService);
    const delays = service.retryDelaysMs;
    service.retryDelaysMs = [0, 10, 10];
    try {
      const { sub } = await trialWorkspace('Alert Throw Co');
      setResendFailure('throw');
      const pay = rzp.charge(sub.id);
      const res = await postWebhook('subscription.charged', {
        subscription: { ...sub, status: 'active', paid_count: 1 },
        payment: pay,
      });
      expect(res.status).toBe(201);
      await quiet();
      expect(ownerAlertsAbout(pay.id)).toHaveLength(0);
    } finally {
      service.retryDelaysMs = delays;
    }
  });

  it('a real payload shape replayed (live sub_TrORHomuXcb1gG, scrubbed): one trial alert, no card or UPI detail, the Rs 5 check not a charge', async () => {
    const s = await t.api.register({ company: "Test Payer's workspace" });
    const { orgId } = await s.self();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });
    // The fields Razorpay's live subscription carried on 23 Oct 2026, with
    // our test ids in place of the customer's.
    const live = {
      ...sub,
      entity: 'subscription',
      status: 'authenticated',
      quantity: 1,
      total_count: 120,
      paid_count: 0,
      remaining_count: 120,
      customer_notify: true,
      payment_method: 'upi',
      has_scheduled_changes: false,
      change_scheduled_at: null,
      source: 'api',
      offer_id: null,
      auth_attempts: 0,
      notes: { ...sub.notes, id: 'vzELUEQQnL', ud: 'DEl3N87QwU' },
    };
    // The Rs 5 mandate check Razorpay attaches to authenticated, with the
    // details a UPI/card payment entity carries.
    const check = {
      id: 'pay_TrOS0000check',
      entity: 'payment',
      amount: 500,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      amount_refunded: 0,
      captured: true,
      description: 'Rs 5 mandate authorisation',
      vpa: 'test.payer@upi',
      email: 'test.payer@example.com',
      contact: '+919000000001',
      token_id: 'token_TrOSsecret',
      card: { last4: '4321', network: 'RuPay', name: 'TEST PAYER' },
      acquirer_data: { rrn: '000000000002', upi_transaction_id: 'AXI0123SECRET' },
      notes: [],
      created_at: Math.floor(Date.now() / 1000),
    };
    const res = await postWebhook('subscription.authenticated', { subscription: live, payment: check });
    expect(res.status).toBe(201);

    const alerts = await eventually(() => ownerAlertsAbout(subscriptionId), 1);
    await quiet();
    expect(ownerAlertsAbout(subscriptionId)).toHaveLength(1);
    expect(alerts[0].subject).toMatch(/Trial started/);
    expect(ownerAlertsAbout('First charge').filter((m) => m.text?.includes(orgId))).toHaveLength(0);
    const all = `${alerts[0].subject}\n${alerts[0].text}\n${alerts[0].html || ''}`;
    for (const hidden of ['test.payer@upi', '9000000001', 'token_TrOSsecret', '4321', 'RuPay', 'TEST PAYER', '000000000002', 'AXI0123SECRET', secret()]) {
      expect(all).not.toContain(hidden);
    }
  });

  it("an untagged event (another product that stamps no notes.service) is never taken for this workspace's", async () => {
    const s = await t.api.register();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });
    // Same Razorpay customer, on another product's own plan, with notes
    // that do not say which product it is.
    const { service, ...notes } = sub.notes;
    expect(service).toBe('hookpost');
    const untagged = {
      ...sub,
      id: 'sub_OtherProduct01',
      plan_id: 'plan_OtherProduct01',
      notes: { orgId: notes.orgId },
    };
    await postWebhook('subscription.authenticated', { subscription: untagged });
    await postWebhook('subscription.charged', {
      subscription: { ...untagged, status: 'active', paid_count: 1 },
      payment: { ...rzp.charge(subscriptionId), notes: {} },
    });
    await postWebhook('subscription.cancelled', { subscription: { ...untagged, status: 'cancelled' } });
    await postWebhook('subscription.halted', { subscription: { ...untagged, status: 'halted' } });
    await quiet();
    expect(ownerAlertsAbout('sub_OtherProduct01')).toHaveLength(0);
  });

  it("another product's events on the shared account: no alert", async () => {
    const s = await t.api.register();
    const { subscriptionId } = await checkout(s);
    const sub = rzp.authorise(subscriptionId, { trialDays: 3 });
    for (const service of ['tablamigo', 'vetnow']) {
      const foreign = { ...sub, notes: { ...sub.notes, service } };
      await postWebhook('subscription.authenticated', { subscription: foreign });
      await postWebhook('subscription.charged', {
        subscription: { ...foreign, status: 'active', paid_count: 1 },
        payment: { ...rzp.charge(subscriptionId), notes: { service } },
      });
    }
    await quiet();
    expect(ownerAlertsAbout(subscriptionId)).toHaveLength(0);
  });
});
