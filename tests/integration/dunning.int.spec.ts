/**
 * A failing payment, end to end over signed webhooks against the real
 * database (owner's rule, 29 Oct 2026):
 *  - while Razorpay retries (subscription.pending), only AI and X go off;
 *    posting to the other channels, scheduling and the rest keep working;
 *  - a retry that goes through (subscription.charged) brings them back;
 *  - halted (retries over) ends the plan at once, with no grace.
 * Plus the break-it cases: a forged or replayed webhook, a late `pending`
 * after the charge, and an event naming another workspace's plan.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { PermissionsService } from '@hookpost/backend/services/auth/permissions/permissions.service';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import { PAYMENT_FAILING_MESSAGE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

async function eventually<T>(read: () => T[], count: number, ms = 5000): Promise<T[]> {
  const until = Date.now() + ms;
  for (;;) {
    const got = read();
    if (got.length >= count || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('a failing payment (dunning)', () => {
  let t: TestApp;
  let rzp: FakeRazorpay;
  let subscriptions: SubscriptionService;
  const secret = () => process.env.RAZORPAY_WEBHOOK_SECRET!;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    subscriptions = t.app.get(SubscriptionService);
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

  /** A workspace on a paid Standard plan (or a trial), provisioned by webhook. */
  async function paidWorkspace(opts: { trial?: boolean } = {}) {
    const s = await t.api.register();
    const { orgId } = await s.self();
    const res = await s.post('/billing/subscribe', { billing: 'STANDARD', period: 'MONTHLY' });
    if (res.status !== 201) throw new Error(`subscribe ${res.status} ${res.text}`);
    const subId: string = res.body.subscriptionId;
    const sub = rzp.authorise(subId, opts.trial ? { trialDays: 3 } : {});
    await postWebhook(
      opts.trial ? 'subscription.authenticated' : 'subscription.activated',
      { subscription: sub }
    );
    expect(await db().subscription.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
    return { s, orgId, subId };
  }

  const marker = async (orgId: string) =>
    (await db().subscription.findUnique({ where: { organizationId: orgId } }))?.paymentFailingSince ?? null;

  /** What the workspace can do right now. */
  async function can(s: Session, orgId: string, callAi = true) {
    // Only where AI is expected to be refused: an allowed call would reach
    // the AI provider, which tests never do.
    const ai = callAi ? await s.post('/posts/separate-posts', { content: 'x', len: 1 }) : null;
    const x = await subscriptions
      .publishWithinPlan(orgId, async () => 'sent', 'x')
      .then(() => true)
      .catch((e) => e);
    const linkedin = await subscriptions
      .publishWithinPlan(orgId, async () => 'sent', 'linkedin')
      .then(() => true)
      .catch((e) => e);
    const credits = (await s.get('/copilot/credits?type=ai_text')).body;
    return { ai, x, linkedin, credits };
  }

  for (const kind of ['renewal', "trial's first charge"] as const) {
    describe(kind, () => {
      it('pending: AI and X off with the payment-failed message; other channels publish', async () => {
        const { s, orgId, subId } = await paidWorkspace({ trial: kind !== 'renewal' });
        const pending = rzp.failCharge(subId, 'pending');
        expect((await postWebhook('subscription.pending', { subscription: pending })).status).toBe(201);
        expect(await marker(orgId)).toBeInstanceOf(Date);
        expect((await s.self()).tier).toBe('STANDARD');

        const now = await can(s, orgId);
        expect(now.ai!.status).toBe(402);
        expect(now.ai!.body).toMatchObject({ code: 'PAYMENT_FAILING', message: PAYMENT_FAILING_MESSAGE });
        expect(now.x).toMatchObject({ code: 'PLAN_REQUIRED', message: PAYMENT_FAILING_MESSAGE });
        expect(now.linkedin).toBe(true);
        expect(now.credits).toEqual({ credits: 0, paymentFailing: true });

        // The email says AI and X are paused, never that the workspace is.
        const mail = await eventually(() => resendSendsTo(s.email).filter((m) => /didn't go through/i.test(m.subject)), 1);
        expect(mail).toHaveLength(1);
        expect(`${mail[0].text}`).toMatch(/AI writing and (posting to )?X are paused/);
        expect(`${mail[0].text} ${mail[0].html}`).not.toMatch(/workspace is paused/i);

        // A retry goes through: everything is back with nobody doing anything.
        const { sub, payment } = rzp.retrySucceeds(subId);
        await postWebhook('subscription.charged', { subscription: sub, payment });
        expect(await marker(orgId)).toBeNull();
        const back = await can(s, orgId, false);
        expect(
          await t.app
            .get(PermissionsService)
            .check(orgId, new Date(), 'ADMIN', [[AuthorizationActions.Create, Sections.AI]])
            .then((a) => a.can(AuthorizationActions.Create, Sections.AI))
        ).toBe(true);
        expect(back.credits.credits).toBeGreaterThan(0);
        expect(back.x).toBe(true);
        expect(back.credits.paymentFailing).toBeUndefined();
      });
    });
  }

  it('halted renewal: the plan ends now, no grace; no "renewal paused" email beside the ending', async () => {
    const { s, orgId, subId } = await paidWorkspace();
    await postWebhook('subscription.pending', { subscription: rzp.failCharge(subId, 'pending') });
    const halted = rzp.failCharge(subId, 'halted');
    expect((await postWebhook('subscription.halted', { subscription: halted })).status).toBe(201);

    expect(await db().subscription.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(0);
    expect(rzp.subscriptions.get(subId).status).toBe('cancelled');
    const ended = await eventually(() => resendSendsTo(s.email).filter((m) => /ended/i.test(m.subject)), 1);
    expect(ended.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(resendSendsTo(s.email).filter((m) => /renewal paused/i.test(m.subject))).toHaveLength(0);
  });

  it("halted trial's first charge: the trial ends now", async () => {
    const { orgId, subId } = await paidWorkspace({ trial: true });
    await postWebhook('subscription.halted', { subscription: rzp.failCharge(subId, 'halted') });
    expect(await db().subscription.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(0);
  });

  describe('break it', () => {
    it('a forged pending webhook (bad signature) changes nothing', async () => {
      const { orgId, subId } = await paidWorkspace();
      const pending = { ...rzp.subscriptions.get(subId), status: 'pending' };
      const res = await postWebhook('subscription.pending', { subscription: pending }, 'a'.repeat(64));
      expect(res.status).toBe(400);
      expect(await marker(orgId)).toBeNull();
    });

    it('a late pending after the retry went through does not take AI away again', async () => {
      const { orgId, subId } = await paidWorkspace();
      const pending = rzp.failCharge(subId, 'pending');
      await postWebhook('subscription.pending', { subscription: pending });
      const { sub, payment } = rzp.retrySucceeds(subId);
      await postWebhook('subscription.charged', { subscription: sub, payment });
      // Razorpay redelivers the old pending (it retries webhooks for 24 h).
      await postWebhook('subscription.pending', { subscription: pending });
      expect(await marker(orgId)).toBeNull();
    });

    it('an old activated redelivered after the pending does not give AI and X back', async () => {
      const { orgId, subId } = await paidWorkspace();
      const activated = { ...rzp.subscriptions.get(subId) };
      await postWebhook('subscription.pending', { subscription: rzp.failCharge(subId, 'pending') });
      await postWebhook('subscription.activated', { subscription: activated });
      expect(await marker(orgId)).toBeInstanceOf(Date);
    });

    it('replaying the same pending keeps the first "failing since" date', async () => {
      const { orgId, subId } = await paidWorkspace();
      const pending = rzp.failCharge(subId, 'pending');
      await postWebhook('subscription.pending', { subscription: pending });
      const first = await marker(orgId);
      await new Promise((r) => setTimeout(r, 20));
      await postWebhook('subscription.pending', { subscription: pending });
      expect((await marker(orgId))?.getTime()).toBe(first?.getTime());
    });

    it('a pending naming another workspace (notes.orgId) does not touch either plan', async () => {
      const a = await paidWorkspace();
      const b = await paidWorkspace();
      const forged = {
        ...rzp.failCharge(b.subId, 'pending'),
        notes: { ...rzp.subscriptions.get(b.subId).notes, orgId: a.orgId },
      };
      await postWebhook('subscription.pending', { subscription: forged });
      expect(await marker(a.orgId)).toBeNull();
      expect(await marker(b.orgId)).toBeNull();
    });

    it('a charge on another product of the shared account clears nothing here', async () => {
      const { orgId, subId } = await paidWorkspace();
      await postWebhook('subscription.pending', { subscription: rzp.failCharge(subId, 'pending') });
      const { sub, payment } = rzp.retrySucceeds(subId);
      await postWebhook('subscription.charged', {
        subscription: { ...sub, notes: { ...sub.notes, service: 'tablamigo' } },
        payment,
      });
      expect(await marker(orgId)).toBeInstanceOf(Date);
    });
  });
});
