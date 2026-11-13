/**
 * WHERE A PLAN ENDS, FOR THE POSTS AROUND IT (the owner's question, 29 Oct
 * 2026: "plan ended at 14:30 -> the 14:29 post went out, the 14:31 post does
 * not go and stops with 'Choose a plan to continue'; posts are kept, not
 * deleted").
 *
 * Proven against the real backend, a real Postgres and an in-memory Razorpay,
 * on the path a post really takes: the orchestrator's own PostActivity
 * (publishLikeTheWorkflow), so the plan check before every publish
 * (SubscriptionService.publishWithinPlan -> trial.policy.ts planState) is the
 * one production runs. Nothing reaches a network: the provider's `post` is a
 * spy, and every assertion about a refused post also asserts the spy was
 * never called.
 *
 * The cutoff is the moment the publish runs, not the moment on the calendar:
 * a post whose turn came while the plan was alive goes out, one whose turn
 * comes after it does not. Three ways a plan ends at T are each run through
 * the same five steps:
 *
 *   (a) the owner refunds a charge (refund.processed), which ends the plan now
 *   (b) an immediate cancel (subscription.cancelled with no paid time left)
 *   (c) a cycle-end cancel with no refund: the plan stays `cancelling` and
 *       keeps publishing until cancelAt, and the hourly sweep
 *       (endLapsedCancellations) closes it once that date has passed
 *   (d) a dispute or chargeback has no Razorpay handler on main (only
 *       Gumroad's purchase flags), so there is nothing to test; see the
 *       "no Razorpay dispute handler" test below, which pins that.
 *
 * Then what the owner asked on 17:04: the workspace pays again at T+2 days,
 * the post dated T+10 days publishes normally, the post whose time passed
 * while the plan was off stays stopped until the user reschedules it on the
 * calendar (PUT /posts/:id/date), and its media is still there, because the
 * 7-day video purge (scripts/cleanup-expired-media.js) only reaches published
 * posts and keeps any file a stopped one still uses.
 *
 * And the window the hourly sweep leaves: between cancelAt and the sweep that
 * deletes the row, the plan is already over for every gate (planLapsed), so
 * the cutoff is the date on the plan, never the minute a cron happened to run.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts plan-end-cutoff
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';
import { resendSendsTo } from './setup/fake.resend';
import { publishLikeTheWorkflow } from './setup/publish';
import { BillingActivity } from '@hookpost/orchestrator/activities/billing.activity';
import { planEndWorkflowId } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.end.timer';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { PLAN_GATE_MESSAGES } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { pendingPostsUsing } = require('../../scripts/cleanup-expired-media.js');

const MINUTE = 60_000;
const DAY = 86_400_000;
/** The earliest cutoff trial.policy.ts accepts (TRIAL_CUTOFF_FLOOR). */
const CUTOFF = '2026-10-19T00:00:00Z';
const POLICY_ENV = [
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'FREE_PLAN_SUNSET_AT',
  'FREE_PLAN_SUNSET_EXEMPT_ORGS',
];
/** What the stopped post's error says, word for word. */
const STOPPED = PLAN_GATE_MESSAGES.PLAN_REQUIRED;
const sec = (ms: number) => Math.floor(ms / 1000);

describe('where a plan ends, for the posts around it', () => {
  let t: TestApp;
  let razorpay: RazorpayService;
  let subscriptions: SubscriptionService;
  const rzp = new FakeRazorpay();
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of POLICY_ENV) saved[key] = process.env[key];
    rzp.install();
    t = await startApp();
    razorpay = t.get<RazorpayService>(RazorpayService);
    subscriptions = t.get<SubscriptionService>(SubscriptionService);
    // As production runs it: the India cutoff set, so a workspace created
    // after it has no Free plan to fall back to when its plan ends.
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  const postWebhook = (event: string, entities: Record<string, any>) => {
    const signed = FakeRazorpay.signedEvent(
      event,
      entities,
      process.env.RAZORPAY_WEBHOOK_SECRET!
    );
    return t.api.request('POST', '/razorpay/webhook', {
      raw: signed.raw,
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signed.signature,
      },
    });
  };

  interface Workspace {
    s: Session;
    orgId: string;
    userId: string;
    /** The Razorpay subscription the plan is on. */
    sub: any;
  }

  /** Buys a plan for `s`, as the checkout and the webhook do it. */
  async function buyPlan(s: Session): Promise<any> {
    const out = await s.post('/billing/subscribe', {
      billing: 'STANDARD',
      period: 'MONTHLY',
    });
    expect(out.status).toBe(201);
    // Approved and charged at once: an `active` paid plan, not a trial.
    const sub = rzp.authorise(out.body.subscriptionId);
    expect((await postWebhook('subscription.activated', { subscription: sub })).status).toBe(201);
    return sub;
  }

  /**
   * A new-cohort Indian workspace (created after its group's cutoff, so no
   * Free plan) on a paid plan, with one confirmed owner. `channels` are
   * connected as the OAuth callback leaves them.
   */
  async function paidWorkspace(
    channels: string[] = ['bluesky']
  ): Promise<Workspace & { channels: string[] }> {
    const s = await t.api.register({ company: `Cutoff ${randomUUID().slice(0, 8)}` });
    const { id: userId, orgId } = await s.self();
    await db().user.update({
      where: { id: userId },
      data: { signupCountry: 'IN', activated: true },
    });
    const ids: string[] = [];
    for (const provider of channels) ids.push((await addChannel(orgId, provider)).id);
    const sub = await buyPlan(s);
    expect((await s.self()).planState).toBe('active');
    return { s, orgId, userId, sub, channels: ids };
  }

  /** The network's answer to a publish, per provider. Never leaves. */
  const network = (provider: string) => {
    const p: any = t.get<IntegrationManager>(IntegrationManager).getSocialIntegration(provider);
    let n = 0;
    return jest
      .spyOn(p, 'post')
      .mockImplementation(async (_i: any, _t: any, posts: any[]) =>
        posts.map((post) => {
          n++;
          return {
            id: post.id,
            postId: `${provider}-${n}`,
            releaseURL: `https://${provider}.example/p/${n}`,
            status: 'success',
          };
        })
      );
  };

  /**
   * One post in the composer, scheduled, then moved to `at`: every post here
   * is dated around the cutoff, and the composer refuses a date in the past.
   * `media` is attached the way an upload leaves it on the row.
   */
  async function schedulePost(
    w: Workspace & { channels: string[] },
    at: number,
    opts: { channel?: number; media?: string; settings?: Record<string, any> } = {}
  ): Promise<string> {
    const channel = w.channels[opts.channel ?? 0];
    const res = await w.s.post('/posts', {
      type: 'schedule',
      shortLink: false,
      // A minute of its own: the free-post key is a publishDate to the minute.
      date: new Date(Date.now() + 2 * DAY + posted++ * MINUTE)
        .toISOString()
        .slice(0, 16),
      tags: [],
      posts: [
        {
          integration: { id: channel },
          group: randomUUID().slice(0, 10),
          value: [
            {
              content: `<p>Cutoff post ${randomUUID().slice(0, 8)}</p>`,
              image: opts.media ? [{ id: randomUUID(), path: opts.media }] : [],
            },
          ],
          settings: opts.settings ?? {},
        },
      ],
    });
    expect(res.status).toBe(201);
    const id: string = res.body[0].postId;
    await db().post.update({ where: { id }, data: { publishDate: new Date(at) } });
    return id;
  }
  let posted = 0;

  const row = (id: string) => db().post.findUniqueOrThrow({ where: { id } });

  /** Publishes `id` the way the workflow does, with the network stubbed. */
  async function publish(id: string, provider = 'bluesky') {
    const spy = network(provider);
    try {
      const result = await publishLikeTheWorkflow(t, (await row(id)).organizationId, id);
      return { ...result, calls: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  }

  /** The plan row the workspace is on, or null once the plan has ended. */
  const planRow = (orgId: string) =>
    db().subscription.findFirst({ where: { organizationId: orgId, deletedAt: null } });

  // ---------------------------------------------------------------------
  // The three ways a plan ends at T
  // ---------------------------------------------------------------------

  type Ending = 'owner refund' | 'immediate cancel' | 'cycle-end cancel, swept';

  /**
   * Ends `w`'s plan now, the way `how` ends it, and returns with the plan
   * really gone: no live Subscription row, and the workspace `locked`.
   */
  async function endPlanNow(w: Workspace, how: Ending) {
    const nowSec = sec(Date.now());
    if (how === 'owner refund') {
      // The owner refunds the charge in the Razorpay dashboard. Razorpay
      // sends refund.created and refund.processed; the plan ends on either
      // (handleRefund -> endRefundedSubscription -> handleCancelled).
      const payment = rzp.charge(w.sub.id);
      const refund = rzp.refund(payment.id, payment.amount);
      expect(
        (await postWebhook('refund.processed', { refund, payment })).status
      ).toBe(201);
      return;
    }
    if (how === 'immediate cancel') {
      // Cancelled at once (the Razorpay dashboard, or Billing's Cancel on a
      // plan with no paid time left): subscription.cancelled arrives with the
      // paid period already behind it, so handleCancelled keeps nothing.
      const ended = {
        ...rzp.subscriptions.get(w.sub.id),
        status: 'cancelled',
        current_start: nowSec - 30 * 86400,
        current_end: nowSec - 60,
        ended_at: nowSec,
      };
      rzp.subscriptions.set(w.sub.id, ended);
      expect(
        (await postWebhook('subscription.cancelled', { subscription: ended })).status
      ).toBe(201);
      return;
    }
    // A cycle-end cancel, no refund: the plan keeps working until cancelAt.
    const cancel = await w.s.post('/billing/cancel');
    expect(cancel.status).toBe(201);
    expect(cancel.body.immediate).toBe(false);
    const scheduled = await planRow(w.orgId);
    expect(scheduled!.cancelAt).not.toBeNull();
    expect(scheduled!.cancelAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await w.s.self()).planState).toBe('cancelling');

    // The month runs out: Razorpay's own subscription.cancelled is not
    // delivered (a webhook lost, or the account not reachable), so only the
    // hourly sweep is left to close it. Both the saved date and Razorpay's
    // cycle are moved back to make that month "passed".
    await db().subscription.update({
      where: { organizationId: w.orgId },
      data: { cancelAt: new Date(Date.now() - MINUTE) },
    });
    rzp.subscriptions.set(w.sub.id, {
      ...rzp.subscriptions.get(w.sub.id),
      status: 'cancelled',
      current_start: nowSec - 30 * 86400,
      current_end: nowSec - 120,
      ended_at: nowSec - 120,
      cancel_at_cycle_end: false,
      has_scheduled_changes: false,
    });
    const swept = await razorpay.endLapsedCancellations();
    expect(swept.ended).toBeGreaterThanOrEqual(1);
  }

  describe.each<Ending>(['owner refund', 'immediate cancel', 'cycle-end cancel, swept'])(
    'the plan ends at T by %s',
    (how) => {
      // One workspace per ending, walked through the owner's whole story.
      let w: Workspace & { channels: string[] };
      let before: string;
      let after: string;
      let later: string;
      const MEDIA = `https://media.hookstep.in/${randomUUID().slice(0, 10)}.mp4`;

      it('T-1min goes out while the plan is still on', async () => {
        w = await paidWorkspace();
        before = await schedulePost(w, Date.now() - MINUTE);
        after = await schedulePost(w, Date.now() + MINUTE, { media: MEDIA });
        later = await schedulePost(w, Date.now() + 10 * DAY);

        const result = await publish(before);
        expect(result).toMatchObject({ published: true, calls: 1 });
        expect((await row(before)).state).toBe('PUBLISHED');
      });

      it('T+1min is refused with the plan-gate message, sends nothing, and the row is kept', async () => {
        await endPlanNow(w, how);
        // The plan is really off: no live row, and the workspace is paused.
        expect(await planRow(w.orgId)).toBeNull();
        expect((await w.s.self()).planState).toBe('locked');

        const result = await publish(after);
        expect(result).toEqual({ published: false, error: STOPPED, calls: 0 });
        expect(result.error).toBe('Choose a plan to continue.');

        const stopped = await row(after);
        expect(stopped.state).toBe('ERROR');
        expect(stopped.error).toBe(STOPPED);
        expect(stopped.deletedAt).toBeNull();
        expect(stopped.releaseURL).toBeFalsy();
        // Nothing of the workspace was deleted either: all three posts are there.
        expect(
          await db().post.count({ where: { organizationId: w.orgId, deletedAt: null } })
        ).toBe(3);
      });

      it('the stopped post keeps its media: the 7-day purge does not reach it', async () => {
        // scripts/cleanup-expired-media.js only looks at published posts, and
        // keeps any file a post that has not gone out still uses.
        expect(await db().post.count({ where: pendingPostsUsing(MEDIA) })).toBe(1);
        const stopped = await row(after);
        expect(stopped.image).toContain(MEDIA);
      });

      it('after paying again, the post dated T+10 days publishes normally', async () => {
        w.sub = await buyPlan(w.s);
        expect((await w.s.self()).planState).toBe('active');
        expect(await planRow(w.orgId)).not.toBeNull();

        const result = await publish(later);
        expect(result).toMatchObject({ published: true, calls: 1 });
        expect((await row(later)).state).toBe('PUBLISHED');
      });

      it('the post whose time passed stays stopped, and publishes once it is rescheduled', async () => {
        // Paying again does not re-run it: its turn passed while the plan was
        // off, so it is still ERROR and the user moves it on the calendar.
        expect((await row(after)).state).toBe('ERROR');

        const when = new Date(Date.now() + DAY).toISOString().slice(0, 16);
        const moved = await w.s.put(`/posts/${after}/date`, { date: when, action: 'schedule' });
        expect(moved.status).toBe(200);
        const queued = await row(after);
        expect(queued.state).toBe('QUEUE');
        expect(queued.error).toBeNull();
        expect(queued.publishDate.toISOString().slice(0, 16)).toBe(when);
        // Still the same row, with the same media.
        expect(queued.image).toContain(MEDIA);

        const result = await publish(after);
        expect(result).toMatchObject({ published: true, calls: 1 });
        expect((await row(after)).state).toBe('PUBLISHED');
      });
    }
  );

  // ---------------------------------------------------------------------
  // While the plan is set to end: a paid plan keeps everything to cancelAt a cancelled trial loses X and AI at once
  // ---------------------------------------------------------------------

  describe("a plan set to end (`cancelling`) until cancelAt", () => {
    let w: Workspace & { channels: string[] };

    beforeAll(async () => {
      w = await paidWorkspace(['bluesky', 'x']);
      const cancel = await w.s.post('/billing/cancel');
      expect([cancel.status, cancel.body.immediate]).toEqual([201, false]);
      expect((await w.s.self()).planState).toBe('cancelling');
    });

    it('every other channel still publishes, up to cancelAt', async () => {
      const id = await schedulePost(w, Date.now() - MINUTE);
      expect(await publish(id)).toMatchObject({ published: true, calls: 1 });
    });

    // The owner, 29 Oct 2026: a customer who paid for the period and
    // cancelled without a refund keeps every feature until cancelAt.
    it('X still publishes: the time to cancelAt was paid for', async () => {
      const id = await schedulePost(w, Date.now() - MINUTE, {
        channel: 1,
        settings: { who_can_reply_post: 'everyone' },
      });
      expect(await publish(id, 'x')).toMatchObject({ published: true, calls: 1 });
    });

    it('AI still works: the time to cancelAt was paid for', async () => {
      expect((await w.s.get('/copilot/credits?type=ai_text')).body.credits).toBeGreaterThan(0);
      expect((await w.s.get('/copilot/credits?type=ai_images')).body.credits).toBeGreaterThan(0);
    });

    it('a cancelled trial that never charged loses X and AI at once, other channels keep going', async () => {
      const trial = await paidWorkspace(['bluesky', 'x']);
      const cancel = await trial.s.post('/billing/cancel');
      expect(cancel.status).toBe(201);
      // Nothing was charged: the workspace is still trialing.
      await db().organization.update({
        where: { id: trial.orgId },
        data: { isTrailing: true },
      });
      expect((await trial.s.self()).planState).toBe('cancelling');

      const onX = await schedulePost(trial, Date.now() - MINUTE, {
        channel: 1,
        settings: { who_can_reply_post: 'everyone' },
      });
      expect(await publish(onX, 'x')).toEqual({ published: false, error: STOPPED, calls: 0 });
      const stub = jest.fn(async () => 'posted');
      await expect(
        subscriptions.publishWithinPlan(trial.orgId, stub, 'x')
      ).rejects.toBeInstanceOf(PlanRequiredError);
      expect(stub).not.toHaveBeenCalled();

      expect((await trial.s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: 0 });
      const generate = await trial.s.post('/copilot/chat', {
        operationName: 'generateCopilotResponse',
        query: 'mutation generateCopilotResponse { x }',
        variables: {},
      });
      expect(generate.status).toBe(402);

      const other = await schedulePost(trial, Date.now() - MINUTE);
      expect(await publish(other)).toMatchObject({ published: true, calls: 1 });
    });

    it('once cancelAt has passed and the sweep has run, nothing publishes', async () => {
      const id = await schedulePost(w, Date.now() + MINUTE);
      const nowSec = sec(Date.now());
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { cancelAt: new Date(Date.now() - MINUTE) },
      });
      rzp.subscriptions.set(w.sub.id, {
        ...rzp.subscriptions.get(w.sub.id),
        status: 'cancelled',
        current_start: nowSec - 30 * 86400,
        current_end: nowSec - 120,
        ended_at: nowSec - 120,
        cancel_at_cycle_end: false,
        has_scheduled_changes: false,
      });
      await razorpay.endLapsedCancellations();
      expect(await planRow(w.orgId)).toBeNull();

      expect(await publish(id)).toEqual({ published: false, error: STOPPED, calls: 0 });
    });
  });

  // ---------------------------------------------------------------------
  // cancelAt has passed, the hourly sweep has not run yet
  // ---------------------------------------------------------------------

  /**
   * The owner, 29 Oct 2026 17:30: "no hourly-sweep lag". The sweep
   * (endLapsedCancellations) deletes the row at most once an hour, so between
   * cancelAt and the sweep the workspace holds a plan row whose time is up.
   * Nothing may use a plan in that window: the publish gate, the AI features
   * and X all read cancelAt against the moment they run, not the row's
   * existence, and once the sweep does run nothing changes again.
   */
  describe('cancelAt has passed but the hourly sweep has not run yet', () => {
    let w: Workspace & { channels: string[] };
    let ownerEmail: string;
    let before: string;
    let after: string;
    let onX: string;
    let afterSweep: string;

    beforeAll(async () => {
      w = await paidWorkspace(['bluesky', 'x']);
      ownerEmail = (await db().user.findUniqueOrThrow({ where: { id: w.userId } })).email;
      const cancel = await w.s.post('/billing/cancel');
      expect([cancel.status, cancel.body.immediate]).toEqual([201, false]);
      expect((await w.s.self()).planState).toBe('cancelling');
      // Every post is saved while the plan is still on: a workspace whose
      // plan has ended cannot save one (the gate refuses the composer too).
      before = await schedulePost(w, Date.now() - MINUTE);
      after = await schedulePost(w, Date.now() + MINUTE);
      onX = await schedulePost(w, Date.now() + MINUTE, {
        channel: 1,
        settings: { who_can_reply_post: 'everyone' },
      });
      afterSweep = await schedulePost(w, Date.now() + MINUTE);
    });

    it('a post at cancelAt-1min goes out, while the date is still ahead', async () => {
      expect(await publish(before)).toMatchObject({ published: true, calls: 1 });
    });

    /**
     * Only the saved date moves. Razorpay is left as it is, so the sweep
     * would not end this row even if it ran (it only ends one Razorpay says
     * is cancelled): this is the window a late webhook leaves.
     */
    async function cancelAtPasses() {
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { cancelAt: new Date(Date.now() - MINUTE) },
      });
      // The row is still there: nothing has swept it.
      expect(await planRow(w.orgId)).not.toBeNull();
    }

    it('a post at cancelAt+1min is refused, though the plan row is still there', async () => {
      await cancelAtPasses();

      const result = await publish(after);
      expect(result).toEqual({ published: false, error: STOPPED, calls: 0 });
      const stopped = await row(after);
      expect([stopped.state, stopped.error, stopped.deletedAt]).toEqual([
        'ERROR',
        STOPPED,
        null,
      ]);
      // Still on file, so the sweep still has its row to close.
      expect(await planRow(w.orgId)).not.toBeNull();
    });

    it('the app already says the plan has ended', async () => {
      expect((await w.s.self()).planState).toBe('locked');
    });

    it('X is refused too', async () => {
      expect(await publish(onX, 'x')).toEqual({
        published: false,
        error: STOPPED,
        calls: 0,
      });

      const stub = jest.fn(async () => 'posted');
      await expect(
        subscriptions.publishWithinPlan(w.orgId, stub, 'x')
      ).rejects.toBeInstanceOf(PlanRequiredError);
      expect(stub).not.toHaveBeenCalled();
    });

    it('AI is refused too', async () => {
      expect((await w.s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: 0 });
      expect((await w.s.get('/copilot/credits?type=ai_images')).body).toEqual({ credits: 0 });
      const generate = await w.s.post('/copilot/chat', {
        operationName: 'generateCopilotResponse',
        query: 'mutation generateCopilotResponse { x }',
        variables: {},
      });
      expect(generate.status).toBe(402);
    });

    it('once the sweep runs, nothing changes again and nothing is emailed twice', async () => {
      const emailsBefore = resendSendsTo(ownerEmail).length;

      // Razorpay catches up: the subscription is cancelled with its paid
      // month behind it, so this time the sweep closes the row.
      const nowSec = sec(Date.now());
      rzp.subscriptions.set(w.sub.id, {
        ...rzp.subscriptions.get(w.sub.id),
        status: 'cancelled',
        current_start: nowSec - 30 * 86400,
        current_end: nowSec - 120,
        ended_at: nowSec - 120,
        cancel_at_cycle_end: false,
        has_scheduled_changes: false,
      });
      expect((await razorpay.endLapsedCancellations()).ended).toBe(1);
      expect(await planRow(w.orgId)).toBeNull();
      const emailsAfterSweep = resendSendsTo(ownerEmail).length;

      // The same answers as before the sweep, from every gate.
      expect((await w.s.self()).planState).toBe('locked');
      expect(await publish(afterSweep)).toEqual({ published: false, error: STOPPED, calls: 0 });
      expect((await w.s.get('/copilot/credits?type=ai_text')).body).toEqual({ credits: 0 });

      // The row is gone, so a second sweep has nothing to end and sends nothing.
      expect((await razorpay.endLapsedCancellations()).ended).toBe(0);
      expect(resendSendsTo(ownerEmail).length).toBe(emailsAfterSweep);
      // The window itself emailed nobody: the sweep is what tells the user.
      expect(emailsAfterSweep).toBeGreaterThanOrEqual(emailsBefore);
    });
  });

  // ---------------------------------------------------------------------
  // The exact timer at cancelAt (plan.end.timer.ts, planEndWorkflow)
  // ---------------------------------------------------------------------

  /**
   * The owner, 29 Oct 2026 18:38: the plan ends at the second of cancelAt,
   * not at the next hourly sweep. Writing the date arms a durable Temporal
   * timer per workspace; when it wakes it runs the orchestrator's
   * BillingActivity, which is the sweep's own code for that one workspace.
   * The FakeTemporal records the timers; the activity is run here as the
   * workflow would run it.
   */
  describe('the exact timer at cancelAt', () => {
    let w: Workspace & { channels: string[] };
    let other: Workspace & { channels: string[] };
    let activity: BillingActivity;
    let ownerEmail: string;

    const timersFor = (orgId: string) =>
      t.temporal.started.filter(
        (s) => s.workflow === 'planEndWorkflow' && s.options.workflowId === planEndWorkflowId(orgId)
      );
    const cancelledAtRazorpay = (sub: any) => {
      const nowSec = sec(Date.now());
      rzp.subscriptions.set(sub.id, {
        ...rzp.subscriptions.get(sub.id),
        status: 'cancelled',
        current_start: nowSec - 30 * 86400,
        current_end: nowSec - 1,
        ended_at: nowSec - 1,
        cancel_at_cycle_end: false,
        has_scheduled_changes: false,
      });
    };

    beforeAll(async () => {
      activity = new BillingActivity(razorpay);
      w = await paidWorkspace();
      other = await paidWorkspace();
      ownerEmail = (await db().user.findUniqueOrThrow({ where: { id: w.userId } })).email;
      for (const x of [w, other]) {
        expect((await x.s.post('/billing/cancel')).status).toBe(201);
      }
    });

    it('Cancel arms one timer for the workspace, at its cancelAt', async () => {
      const timers = timersFor(w.orgId);
      expect(timers.length).toBeGreaterThanOrEqual(1);
      const last = timers[timers.length - 1].options;
      expect(last.workflowIdConflictPolicy).toBe('TERMINATE_EXISTING');
      expect(last.args).toEqual([{ organizationId: w.orgId, identifier: w.sub.id }]);
      // What the timer reads when it starts: the date on the row.
      const due = await activity.planEndDue(w.orgId);
      expect(due).toEqual({
        identifier: w.sub.id,
        cancelAt: (await planRow(w.orgId))!.cancelAt!.toISOString(),
      });
    });

    it('at cancelAt it ends that plan alone, at that second, not the next sweep', async () => {
      for (const x of [w, other]) {
        await db().subscription.update({
          where: { organizationId: x.orgId },
          data: { cancelAt: new Date() },
        });
        cancelledAtRazorpay(x.sub);
      }
      const emailsBefore = resendSendsTo(ownerEmail).length;

      expect((await activity.endPlanAtCancelAt(w.orgId)).ended).toBe(1);
      expect(await planRow(w.orgId)).toBeNull();
      expect(await planRow(other.orgId)).not.toBeNull();
      expect(await activity.planEndDue(w.orgId)).toBeNull();
      const emailsAfterTimer = resendSendsTo(ownerEmail).length;
      // The one "plan has ended" email goes out from the timer, at cancelAt.
      const ended = () =>
        resendSendsTo(ownerEmail).filter((m: any) => /plan has ended/.test(m.subject));
      expect(ended()).toHaveLength(1);
      expect(emailsAfterTimer).toBe(emailsBefore + 1);

      // The hourly sweep afterwards is the backup: it ends only the plan the
      // timer did not reach, and sends this workspace nothing more.
      expect((await razorpay.endLapsedCancellations()).ended).toBe(1);
      expect(await planRow(other.orgId)).toBeNull();
      expect(resendSendsTo(ownerEmail).length).toBe(emailsAfterTimer);
      // A second firing of the same timer (a duplicate) does nothing.
      expect((await activity.endPlanAtCancelAt(w.orgId)).ended).toBe(0);
      expect(resendSendsTo(ownerEmail).length).toBe(emailsAfterTimer);
      expect(ended()).toHaveLength(1);
    });

    it('a date moved replaces the timer; a date cleared stops it', async () => {
      const x = await paidWorkspace();
      const later = new Date(Date.now() + 9 * DAY);
      await subscriptions.scheduleCancellation(x.orgId, x.sub.id, later);
      const timers = timersFor(x.orgId);
      expect(timers.length).toBe(1);
      expect(timers[0].options.workflowIdConflictPolicy).toBe('TERMINATE_EXISTING');
      expect((await activity.planEndDue(x.orgId))!.cancelAt).toBe(later.toISOString());

      const sooner = new Date(Date.now() + 2 * DAY);
      await subscriptions.scheduleCancellation(x.orgId, x.sub.id, sooner);
      expect(timersFor(x.orgId).length).toBe(2);
      expect((await activity.planEndDue(x.orgId))!.cancelAt).toBe(sooner.toISOString());

      await subscriptions.scheduleCancellation(x.orgId, x.sub.id, null);
      expect(t.temporal.terminated).toContain(planEndWorkflowId(x.orgId));
      expect(await activity.planEndDue(x.orgId)).toBeNull();
      // A timer still asleep wakes to nothing: the plan carries on.
      expect((await activity.endPlanAtCancelAt(x.orgId)).ended).toBe(0);
      expect(await planRow(x.orgId)).not.toBeNull();
    });

    it('the second of cancelAt itself counts as ended, for the gates and the timer alike', async () => {
      const x = await paidWorkspace();
      const at = new Date(Date.now() - 1000);
      await db().subscription.update({ where: { organizationId: x.orgId }, data: { cancelAt: at } });
      // Read exactly at cancelAt: the row the timer wakes for is found
      // (it used to be cancelAt < now, which missed the timer's own second).
      expect((await subscriptions.getLapsedCancellations(at, x.orgId)).length).toBe(1);
      expect((await x.s.self()).planState).toBe('locked');
    });

    it("the sweep re-arms a timer lost while Temporal was down, without replacing running ones", async () => {
      const x = await paidWorkspace();
      await db().subscription.update({
        where: { organizationId: x.orgId },
        data: { cancelAt: new Date(Date.now() + 3 * DAY) },
      });
      expect(timersFor(x.orgId)).toEqual([]);
      await subscriptions.armPlanEndTimers();
      const timers = timersFor(x.orgId);
      expect(timers.length).toBe(1);
      expect(timers[0].options.workflowIdConflictPolicy).toBe('USE_EXISTING');
    });
  });

  // ---------------------------------------------------------------------
  // The other states the owner asked about
  // ---------------------------------------------------------------------

  describe('the states that are not a paid plan', () => {
    /** A new-cohort workspace with no plan and its trial unused: free_posts. */
    async function newWorkspace(): Promise<Workspace & { channels: string[] }> {
      const s = await t.api.register({ company: `New ${randomUUID().slice(0, 8)}` });
      const { id: userId, orgId } = await s.self();
      await db().user.update({
        where: { id: userId },
        data: { signupCountry: 'IN', activated: true },
      });
      const channels = [(await addChannel(orgId, 'bluesky')).id];
      return { s, orgId, userId, sub: null, channels };
    }

    it('free_posts publishes: its limit is held where posts are created, not here', async () => {
      const w = await newWorkspace();
      expect((await w.s.self()).planState).toBe('free_posts');
      const id = await schedulePost(w, Date.now() - MINUTE);
      expect(await publish(id)).toMatchObject({ published: true, calls: 1 });
    });

    // Only a Razorpay plan ends at its date without its sweep: a Gumroad
    // plan's end is the Gumroad sweep's to judge (the buyer may have
    // resubscribed there), and a lifetime plan never ends on a date.
    it.each([
      ['a Gumroad plan', { identifier: 'gumroad:sale_cutoff' }],
      ['a lifetime plan', { isLifetime: true }],
    ])('%s past its cancelAt still publishes until its own sweep says otherwise', async (_name, data) => {
      const w = await paidWorkspace();
      const id = await schedulePost(w, Date.now() + MINUTE);
      await db().subscription.update({
        where: { organizationId: w.orgId },
        data: { ...data, cancelAt: new Date(Date.now() - MINUTE) },
      });
      expect(await publish(id)).toMatchObject({ published: true, calls: 1 });
      expect((await w.s.self()).planState).not.toBe('locked');
    });

    it('locked publishes nothing, with the same message, and keeps the row', async () => {
      const w = await newWorkspace();
      const id = await schedulePost(w, Date.now() + MINUTE);
      // Its free posts or a plan have been used: allowTrial false, no plan.
      await db().organization.update({
        where: { id: w.orgId },
        data: { allowTrial: false },
      });
      expect((await w.s.self()).planState).toBe('locked');

      expect(await publish(id)).toEqual({ published: false, error: STOPPED, calls: 0 });
      const stopped = await row(id);
      expect([stopped.state, stopped.error, stopped.deletedAt]).toEqual([
        'ERROR',
        STOPPED,
        null,
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // (d) dispute / chargeback
  // ---------------------------------------------------------------------

  it('a dispute ends the plan at once: a post due a minute later never reaches the network', async () => {
    // RazorpayService.handleDispute (the chargeback task): the plan ends like
    // a refund, and the workspace is locked until a super admin clears it.
    const w = await paidWorkspace();
    const due = await schedulePost(w, Date.now() - MINUTE);
    const payment = rzp.charge(w.sub.id);
    rzp.invoiceFor(w.sub.id, payment);
    const res = await postWebhook('payment.dispute.created', {
      payment,
      dispute: rzp.dispute(payment.id),
    });
    expect(res.status).toBe(201);
    expect(await planRow(w.orgId)).toBeNull();
    expect((await w.s.self()).planState).toBe('locked');
    expect(await publish(due)).toEqual({ published: false, error: STOPPED, calls: 0 });
  });
});
