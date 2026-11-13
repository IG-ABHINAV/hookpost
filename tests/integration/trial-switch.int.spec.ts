/**
 * Trials behind their switch (owner, 29 Oct 2026: trials stay off, but must
 * be complete so they can be switched on at any time). With TRIAL_CHECKOUT=on
 * a free_posts workspace that picks a plan gets a card or UPI AutoPay trial of
 * TRIAL_DAYS instead of a charge at once, and every case decided on 29 Oct
 * holds (trial.policy.ts "TRIALS BEHIND A SWITCH"):
 *
 *  - card or UPI upfront, nothing charged until the trial ends; the welcome
 *    email states the charge; the owner is alerted
 *  - once per person: the workspace itself, its owner's email identity, its
 *    channels
 *  - the first charge fails: only AI and X off while Razorpay retries, back
 *    on a retry that goes through; halted ends the trial now
 *  - cancel during the trial: Razorpay stopped at once, access to the trial's
 *    end with AI and X off at once, then locked; a mandate revoked in the UPI
 *    app is the same cancel
 *  - a refund or a chargeback on the first charge ends the plan now
 *  - upgrade or downgrade during the trial: a new mandate from the same
 *    first-charge date, nothing charged early
 *
 * With the switch off nothing changes: the free_posts checkout charges at
 * once with the first-month offer (free-posts.int.spec.ts has the rest).
 * Real backend, Postgres and Redis; Razorpay is FakeRazorpay, webhooks are
 * signed with the test secret.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { PermissionsService } from '@hookpost/backend/services/auth/permissions/permissions.service';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import {
  PAYMENT_FAILING_MESSAGE,
  TRIAL_DAYS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const CUTOFF = '2026-10-19T00:00:00Z';
const OWNER = 'owner-alerts@hookpost.invalid';
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

let accounts = 0;
const gmail = (local: string) => `${local}${Date.now().toString(36)}${accounts++}@gmail.com`;

describe('trials behind their switch (TRIAL_CHECKOUT)', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let subscriptions: SubscriptionService;
  let razorpay: RazorpayService;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    subscriptions = t.app.get(SubscriptionService);
    razorpay = t.app.get(RazorpayService);
  });
  beforeEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    process.env.TRIAL_CHECKOUT = 'on';
  });
  afterEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    delete process.env.TRIAL_CHECKOUT;
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

  /** A new Indian sign-up after the cutoff: free_posts. */
  async function newWorkspace(email?: string) {
    const s = await t.api.register(email ? { email } : {});
    const self = await s.self();
    await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
    return { s, orgId: self.orgId as string };
  }

  async function checkout(s: Session, billing = 'STANDARD', body: Record<string, any> = {}) {
    const res = await s.post('/billing/subscribe', { billing, period: 'MONTHLY', ...body });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    return { res: res.body, sub: rzp.subscriptions.get(res.body.subscriptionId) };
  }

  /** A free_posts workspace whose trial has started (mandate approved). */
  async function trialWorkspace(email?: string) {
    const w = await newWorkspace(email);
    const { sub } = await checkout(w.s);
    const approved = rzp.authorise(sub.id, { trialDays: TRIAL_DAYS });
    expect((await postWebhook('subscription.authenticated', { subscription: approved })).status).toBe(201);
    return { ...w, subId: sub.id as string, chargeAt: approved.start_at as number };
  }

  const row = (orgId: string) => db().subscription.findUnique({ where: { organizationId: orgId } });
  const org = (orgId: string) => db().organization.findUniqueOrThrow({ where: { id: orgId } });

  /** What the workspace can do right now; AI is read from the permission, never called. */
  async function can(orgId: string) {
    const ai = await t.app
      .get(PermissionsService)
      .check(orgId, new Date(), 'ADMIN', [[AuthorizationActions.Create, Sections.AI]])
      .then((a) => a.can(AuthorizationActions.Create, Sections.AI));
    const x = await subscriptions
      .publishWithinPlan(orgId, async () => 'sent', 'x')
      .then(() => true)
      .catch((e) => e);
    const linkedin = await subscriptions
      .publishWithinPlan(orgId, async () => 'sent', 'linkedin')
      .then(() => true)
      .catch((e) => e);
    return { ai, x, linkedin };
  }

  describe('the switch', () => {
    it('off (production): a free_posts checkout charges at once with the first-month offer, no trial', async () => {
      process.env.TRIAL_CHECKOUT = 'off';
      const { s } = await newWorkspace();
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'free_posts', allowTrial: false });
      const { res, sub } = await checkout(s, 'STANDARD', { payWith: 'upi' });
      expect(sub.start_at).toBeNull();
      expect(res.firstMonthOffer).toBe('upi');
    });

    it('on: /user/self offers the trial, and checkout opens the mandate with the first charge TRIAL_DAYS away, no offer', async () => {
      const { s } = await newWorkspace();
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'free_posts', allowTrial: true, trialDays: TRIAL_DAYS });
      // Free posts are still there while the trial is not started.
      expect(self.freePosts).toMatchObject({ limit: 3, left: 3 });
      const { res, sub } = await checkout(s, 'STANDARD', { payWith: 'upi' });
      expect(Math.abs(sub.start_at - (nowSec() + TRIAL_DAYS * DAY))).toBeLessThan(120);
      expect(sub.offer_id).toBeNull();
      expect(res.firstMonthOffer ?? null).toBeNull();
      // Nothing charged at checkout.
      expect([...rzp.payments.values()].some((p) => p.invoice_id && rzp.invoices.find((i) => i.id === p.invoice_id)?.subscription_id === sub.id)).toBe(false);
    });

    it('break-it: a client cannot ask for a trial the server would not give (switch off, tampered body)', async () => {
      process.env.TRIAL_CHECKOUT = 'off';
      const { s } = await newWorkspace();
      const res = await s.post('/billing/subscribe', {
        billing: 'STANDARD', period: 'MONTHLY', trial: true, allowTrial: true, startAt: nowSec() + 30 * DAY, start_at: nowSec() + 30 * DAY,
      });
      expect([201, 400]).toContain(res.status);
      if (res.status === 201) expect(rzp.subscriptions.get(res.body.subscriptionId).start_at).toBeNull();
    });

    it('on: a sign-up from a disposable email domain gets no trial', async () => {
      const { s } = await newWorkspace(`trial${Date.now().toString(36)}@mailinator.com`);
      expect((await s.self()).allowTrial).toBe(false);
      expect((await checkout(s)).sub.start_at).toBeNull();
    });

    it('on: the embedded checkout is the same', async () => {
      const { s } = await newWorkspace();
      const res = await s.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY', payWith: 'card' });
      expect(res.status).toBe(201);
      expect(rzp.subscriptions.get(res.body.subscriptionId).start_at).toBeGreaterThan(nowSec() + DAY);
    });
  });

  describe('the trial starts (mandate approved, card or UPI)', () => {
    it('trialing: the plan and AI and X on, the trial used, the welcome states the charge, the owner is told', async () => {
      const { s, orgId, subId, chargeAt } = await trialWorkspace();
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'trialing', tier: 'STANDARD', allowTrial: false, freePosts: null });
      expect(new Date(self.trialEndsAt).getTime() / 1000).toBeCloseTo(chargeAt, -2);
      expect((await org(orgId)).allowTrial).toBe(false);
      expect(await can(orgId)).toEqual({ ai: true, x: true, linkedin: true });

      const welcome = await eventually(
        () => resendSendsTo(s.email).filter((m) => m.subject === 'Your Hookpost Standard trial has started'),
        1
      );
      expect(welcome).toHaveLength(1);
      const owner = await eventually(() => resendSendsTo(OWNER).filter((m) => `${m.subject}\n${m.text}`.includes(subId)), 1);
      expect(owner.map((m) => m.subject).join('\n')).toMatch(/trial/i);
    });

    it('a replayed authenticated webhook changes nothing and sends nothing twice', async () => {
      const { s, subId } = await trialWorkspace();
      await postWebhook('subscription.authenticated', { subscription: rzp.subscriptions.get(subId) });
      await new Promise((r) => setTimeout(r, 300));
      expect(resendSendsTo(s.email).filter((m) => /trial has started/.test(m.subject))).toHaveLength(1);
    });
  });

  describe('once per person', () => {
    it('the same workspace never gets a second trial (allowTrial is gone)', async () => {
      const { s, orgId, subId } = await trialWorkspace();
      // The trial is cancelled and has run out.
      const cancelled = { ...rzp.subscriptions.get(subId), status: 'cancelled', ended_at: nowSec() };
      rzp.subscriptions.set(subId, cancelled);
      await postWebhook('subscription.cancelled', { subscription: cancelled });
      // Time passes: the trial's end is behind us, at Razorpay and on the row.
      const ran = rzp.subscriptions.get(subId);
      ran.start_at = ran.charge_at = nowSec() - 60;
      await db().subscription.update({ where: { organizationId: orgId }, data: { cancelAt: new Date(Date.now() - 60_000) } });
      await razorpay.endLapsedCancellations(new Date(), orgId);
      expect((await s.self()).planState).toBe('locked');
      const { sub } = await checkout(s);
      expect(sub.start_at).toBeNull();
    });

    it("the owner's email under another spelling had a trial in another workspace: no trial", async () => {
      const first = gmail('trial.person');
      const local = first.split('@')[0];
      // Both workspaces exist before either starts a trial, so sign-up
      // could not tell; checkout does.
      const a = await newWorkspace(first);
      const b = await newWorkspace(`${local.replace(/\./g, '')}+second@googlemail.com`);
      expect((await b.s.self()).allowTrial).toBe(true);
      const { sub } = await checkout(a.s);
      await postWebhook('subscription.authenticated', { subscription: rzp.authorise(sub.id, { trialDays: TRIAL_DAYS }) });

      expect((await b.s.self()).allowTrial).toBe(false);
      const second = await checkout(b.s, 'STANDARD', { payWith: 'upi' });
      expect(second.sub.start_at).toBeNull();
      // The first-month offer is the other worker's rule; the charge is today either way.
    });

    it('a channel that had a trial in another workspace: no trial', async () => {
      const a = await trialWorkspace();
      const internalId = `li-person-${Date.now()}`;
      await addChannel(a.orgId, 'linkedin', { internalId });
      const b = await newWorkspace();
      await addChannel(b.orgId, 'linkedin', { internalId });
      expect((await b.s.self()).allowTrial).toBe(false);
      expect((await checkout(b.s)).sub.start_at).toBeNull();
    });

    it('break-it: two checkouts side by side (same person) both pass checkout; the one approved second is refused, nothing charged', async () => {
      const first = gmail('race.person');
      const local = first.split('@')[0];
      const a = await newWorkspace(first);
      const b = await newWorkspace(`${local.replace(/\./g, '')}+tab2@gmail.com`);
      const subA = (await checkout(a.s)).sub;
      const subB = (await checkout(b.s)).sub;
      // Both were offered a trial: neither had one when it checked out.
      expect(subA.start_at).toBeGreaterThan(nowSec());
      expect(subB.start_at).toBeGreaterThan(nowSec());

      await postWebhook('subscription.authenticated', { subscription: rzp.authorise(subA.id, { trialDays: TRIAL_DAYS }) });
      expect((await a.s.self()).planState).toBe('trialing');

      const approvedB = rzp.authorise(subB.id, { trialDays: TRIAL_DAYS });
      expect((await postWebhook('subscription.authenticated', { subscription: approvedB })).status).toBe(201);
      // Stopped at Razorpay at once: the first debit can never come.
      expect(rzp.subscriptions.get(subB.id).status).toBe('cancelled');
      expect(await row(b.orgId)).toBeNull();
      expect(await b.s.self()).toMatchObject({ planState: 'locked', allowTrial: false });
      const told = await eventually(() => resendSendsTo(b.s.email).filter((m) => m.subject === 'Your Hookpost trial did not start'), 1);
      expect(told).toHaveLength(1);

      // A redelivery (the payload still says authenticated) changes nothing.
      await postWebhook('subscription.authenticated', { subscription: approvedB });
      expect(await row(b.orgId)).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
      expect(resendSendsTo(b.s.email).filter((m) => m.subject === 'Your Hookpost trial did not start')).toHaveLength(1);
      // The first workspace keeps its trial.
      expect((await a.s.self()).planState).toBe('trialing');
    });

    it('break-it: a payment taken at once is never refused, though it is `authenticated` for a moment', async () => {
      const first = gmail('pays.person');
      const local = first.split('@')[0];
      await trialWorkspace(first);
      const b = await newWorkspace(`${local.replace(/\./g, '')}+pays@gmail.com`);
      const { sub } = await checkout(b.s);
      expect(sub.start_at).toBeNull();
      // What Razorpay sends first for a mandate charged on approval.
      const momentary = { ...sub, status: 'authenticated', paid_count: 0, charge_at: nowSec(), payment_method: 'upi' };
      rzp.subscriptions.set(sub.id, momentary);
      await postWebhook('subscription.authenticated', { subscription: momentary });
      expect(rzp.subscriptions.get(sub.id).status).toBe('authenticated');
      expect(await row(b.orgId)).not.toBeNull();
      expect(resendSendsTo(b.s.email).filter((m) => m.subject === 'Your Hookpost trial did not start')).toHaveLength(0);
    });

    it("an employee later made a member of a paying client's workspace keeps their own trial (owners only count)", async () => {
      // (Sign-up itself, PR #66, counts any member for the free posts; this
      // is the checkout's own check, which counts owners.)
      const employee = gmail('agency.employee');
      const own = await newWorkspace(employee);
      const client = await newWorkspace();
      const { givePlan } = await import('./setup/db');
      await givePlan(client.orgId);
      const me = await db().user.findFirstOrThrow({ where: { email: employee } });
      await db().userOrganization.create({ data: { userId: me.id, organizationId: client.orgId, role: 'USER' } });
      expect((await own.s.self()).allowTrial).toBe(true);
      const subscriptions = t.app.get(SubscriptionService);
      expect(await subscriptions.checkoutAllowsTrial(own.orgId, true)).toBe(true);
    });

    it('with the switch off, a trial mandate is never refused at approval (production unchanged)', async () => {
      const first = gmail('off.person');
      const local = first.split('@')[0];
      const a = await trialWorkspace(first);
      process.env.TRIAL_CHECKOUT = 'off';
      // A grandfathered-style trial mandate on a second workspace of the same
      // person, opened while the switch was on, approved after it went off.
      const b = await newWorkspace(`${local.replace(/\./g, '')}+later@gmail.com`);
      process.env.TRIAL_CHECKOUT = 'on';
      const subB = (await checkout(b.s)).sub;
      process.env.TRIAL_CHECKOUT = 'off';
      await postWebhook('subscription.authenticated', { subscription: rzp.authorise(subB.id, { trialDays: TRIAL_DAYS }) });
      expect(rzp.subscriptions.get(subB.id).status).toBe('authenticated');
      expect(await row(b.orgId)).not.toBeNull();
      expect(a.orgId).not.toBe(b.orgId);
    });

    it('the same UPI ID approving a second trial in an unrelated-looking workspace: refused at approval', async () => {
      const vpa = `same${Date.now().toString(36)}@okaxis`;
      const authPayment = (id: string) => ({ id, entity: 'payment', amount: 100, currency: 'INR', method: 'upi', vpa, status: 'refunded', created_at: nowSec() });
      const a = await newWorkspace();
      const subA = (await checkout(a.s)).sub;
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subA.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_a${Date.now()}`),
      });
      expect((await a.s.self()).planState).toBe('trialing');

      // Another email, no shared channel: checkout cannot know the UPI ID yet.
      const b = await newWorkspace();
      const subB = (await checkout(b.s)).sub;
      expect(subB.start_at).toBeGreaterThan(nowSec());
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subB.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_b${Date.now()}`),
      });
      expect(rzp.subscriptions.get(subB.id).status).toBe('cancelled');
      expect(await row(b.orgId)).toBeNull();
      expect((await b.s.self()).planState).toBe('locked');
    });

    it('a percent-off coupon does not get a second trial past the approval check', async () => {
      const vpa = `cpn${Date.now().toString(36)}@okaxis`;
      const authPayment = (id: string) => ({ id, entity: 'payment', amount: 100, currency: 'INR', method: 'upi', vpa, status: 'refunded', created_at: nowSec() });
      const a = await newWorkspace();
      const subA = (await checkout(a.s)).sub;
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subA.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_ca${Date.now()}`),
      });
      expect((await a.s.self()).planState).toBe('trialing');

      const code = `TEN${Date.now().toString(36)}`.toUpperCase();
      await db().coupon.create({ data: { code, percentOff: 10 } });
      const b = await newWorkspace();
      const subB = (await checkout(b.s, 'STANDARD', { coupon: code })).sub;
      expect(subB.notes.coupon).toBe(code);
      expect(subB.start_at).toBeGreaterThan(nowSec());
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subB.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_cb${Date.now()}`),
      });
      expect(rzp.subscriptions.get(subB.id).status).toBe('cancelled');
      expect(await row(b.orgId)).toBeNull();
    });

    it("a free-months coupon's later start is not a trial, so it is never refused as a second one", async () => {
      const vpa = `fm${Date.now().toString(36)}@okaxis`;
      const authPayment = (id: string) => ({ id, entity: 'payment', amount: 100, currency: 'INR', method: 'upi', vpa, status: 'refunded', created_at: nowSec() });
      const a = await newWorkspace();
      const subA = (await checkout(a.s)).sub;
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subA.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_fa${Date.now()}`),
      });

      const code = `FREE${Date.now().toString(36)}`.toUpperCase();
      await db().coupon.create({ data: { code, freeMonths: 1 } });
      const b = await newWorkspace();
      const subB = (await checkout(b.s, 'STANDARD', { coupon: code })).sub;
      expect(subB.notes.free_months).toBe('1');
      await postWebhook('subscription.authenticated', {
        subscription: rzp.authorise(subB.id, { trialDays: TRIAL_DAYS }),
        payment: authPayment(`pay_auth_fb${Date.now()}`),
      });
      expect(rzp.subscriptions.get(subB.id).status).toBe('authenticated');
      expect(await row(b.orgId)).not.toBeNull();
    });

    it('a channel only used for free posts elsewhere does not cost the trial', async () => {
      const a = await newWorkspace();
      const internalId = `li-free-${Date.now()}`;
      const ch = await addChannel(a.orgId, 'linkedin', { internalId });
      const day = new Date(Date.now() + DAY).toISOString();
      const saved = await a.s.post('/posts', {
        type: 'draft', shortLink: false, date: day, tags: [],
        posts: [{ integration: { id: ch.id }, group: 'g1', value: [{ content: 'hello', image: [] }], settings: {} }],
      });
      expect(saved.status).toBe(201);
      const b = await newWorkspace();
      await addChannel(b.orgId, 'linkedin', { internalId });
      expect((await b.s.self()).allowTrial).toBe(true);
    });
  });

  describe("the trial's first charge", () => {
    it('fails: only AI and X off while Razorpay retries; a retry that goes through brings them back', async () => {
      const { orgId, subId } = await trialWorkspace();
      await postWebhook('subscription.pending', { subscription: rzp.failCharge(subId, 'pending') });
      const failing = await can(orgId);
      expect(failing.ai).toBe(false);
      expect(failing.x).toMatchObject({ message: PAYMENT_FAILING_MESSAGE });
      expect(failing.linkedin).toBe(true);

      const { sub, payment } = rzp.retrySucceeds(subId);
      await postWebhook('subscription.charged', { subscription: sub, payment });
      expect(await can(orgId)).toEqual({ ai: true, x: true, linkedin: true });
      expect((await org(orgId)).isTrailing).toBe(false);
    });

    it('halted (every retry failed): the trial ends now, the workspace is locked, one email says so', async () => {
      const { s, orgId, subId } = await trialWorkspace();
      await postWebhook('subscription.pending', { subscription: rzp.failCharge(subId, 'pending') });
      await postWebhook('subscription.halted', { subscription: rzp.failCharge(subId, 'halted') });
      const r = await row(orgId);
      expect(!r || !!r.deletedAt).toBe(true);
      expect((await s.self()).planState).toBe('locked');
      // Never a second trial after it.
      expect((await checkout(s)).sub.start_at).toBeNull();
    });

    it('goes through: a paying customer, no longer trialing', async () => {
      const { s, orgId, subId } = await trialWorkspace();
      const { sub, payment } = rzp.retrySucceeds(subId);
      await postWebhook('subscription.charged', { subscription: sub, payment });
      expect((await s.self()).planState).toBe('active');
      expect((await org(orgId)).isTrailing).toBe(false);
    });
  });

  describe('cancel during the trial', () => {
    it('Billing Cancel: Razorpay stopped at once, nothing charged, access to the trial end with AI and X off, then locked', async () => {
      const { s, orgId, subId, chargeAt } = await trialWorkspace();
      const res = await s.post('/billing/cancel', { feedback: 'just looking' });
      expect(res.status).toBeLessThan(300);
      // At once, not at the cycle's end: the first debit can never happen.
      expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
      expect(rzp.calls.some((c) => c.path === `/subscriptions/${subId}/cancel` && !c.body?.cancel_at_cycle_end)).toBe(true);

      const r = await row(orgId);
      expect(r?.cancelAt?.getTime()).toBe(chargeAt * 1000);
      expect((await s.self()).planState).toBe('cancelling');
      const now = await can(orgId);
      expect(now.ai).toBe(false);
      expect(now.x).not.toBe(true);
      expect(now.linkedin).toBe(true);

      // The trial's end passes: the sweep (or the exact timer) ends it.
      await razorpay.endLapsedCancellations(new Date((chargeAt + 60) * 1000), orgId);
      expect((await s.self()).planState).toBe('locked');
      expect([...rzp.payments.values()].filter((p) => rzp.invoices.find((i) => i.id === p.invoice_id)?.subscription_id === subId)).toHaveLength(0);
    });

    it('a mandate revoked in the UPI app is the same cancel: access to the trial end, AI and X off, one email', async () => {
      const { s, orgId, subId, chargeAt } = await trialWorkspace();
      const revoked = { ...rzp.subscriptions.get(subId), status: 'cancelled', ended_at: nowSec() };
      rzp.subscriptions.set(subId, revoked);
      expect((await postWebhook('subscription.cancelled', { subscription: revoked })).status).toBe(201);
      await postWebhook('subscription.cancelled', { subscription: revoked });
      expect((await row(orgId))?.cancelAt?.getTime()).toBe(chargeAt * 1000);
      expect((await can(orgId)).ai).toBe(false);
      await new Promise((r) => setTimeout(r, 300));
      const mails = resendSendsTo(s.email).filter((m) => /cancel/i.test(m.subject));
      expect(mails).toHaveLength(1);
    });
  });

  describe('refund or chargeback on the first charge', () => {
    async function converted() {
      const w = await trialWorkspace();
      const { sub, payment } = rzp.retrySucceeds(w.subId);
      await postWebhook('subscription.charged', { subscription: sub, payment });
      return { ...w, payment };
    }

    it('a refund ends the plan now', async () => {
      const { s, orgId, payment } = await converted();
      const refund = rzp.refund(payment.id, payment.amount);
      expect((await postWebhook('refund.processed', { refund, payment: rzp.payments.get(payment.id) })).status).toBe(201);
      const r = await row(orgId);
      expect(!r || !!r.deletedAt || (r.cancelAt && r.cancelAt.getTime() <= Date.now() + 60_000)).toBeTruthy();
      expect((await s.self()).planState).toBe('locked');
    });

    it('a chargeback ends the plan now and locks the workspace: no trial, no checkout', async () => {
      const { s, orgId, subId, payment } = await converted();
      rzp.invoiceFor(subId, payment);
      const d = rzp.dispute(payment.id);
      expect((await postWebhook('payment.dispute.created', { payment: rzp.payments.get(payment.id), dispute: d })).status).toBe(201);
      expect((await org(orgId)).disputedAt).toBeInstanceOf(Date);
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'locked', allowTrial: false });
      const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('plan change during the trial', () => {
    for (const [from, to] of [['STANDARD', 'PRO'], ['PRO', 'STANDARD']] as const) {
      it(`${from} -> ${to}: a new mandate from the same first-charge date, nothing charged now`, async () => {
        const w = await newWorkspace();
        const { sub } = await checkout(w.s, from);
        const approved = rzp.authorise(sub.id, { trialDays: TRIAL_DAYS });
        await postWebhook('subscription.authenticated', { subscription: approved });
        const paymentsBefore = rzp.payments.size;

        const change = await w.s.post('/billing/subscribe', { billing: to, period: 'MONTHLY' });
        expect(change.status).toBe(201);
        const next = rzp.subscriptions.get(change.body.subscriptionId);
        expect(next.id).not.toBe(sub.id);
        expect(next.start_at).toBe(approved.start_at);
        expect(next.notes).toMatchObject({ replaces: sub.id, trial: '1' });
        expect(rzp.payments.size).toBe(paymentsBefore);

        // Approving the new mandate retires the old one and keeps the trial.
        await postWebhook('subscription.authenticated', { subscription: rzp.authorise(next.id, { trialDays: TRIAL_DAYS }) });
        expect((await w.s.self()).planState).toBe('trialing');
        expect((await row(w.orgId))?.subscriptionTier).toBe(to);
      });
    }
  });
});
