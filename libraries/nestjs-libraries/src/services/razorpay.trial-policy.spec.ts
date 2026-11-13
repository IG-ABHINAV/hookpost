import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { formatBillingDateTime } from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

// PR-2 of the trial plan in RazorpayService: a cancelled trial keeps working
// until the date its first charge was due and then ends (the hourly sweep,
// run here with an injected `now`), the trial reminder email, the welcome
// email's charge disclosure, and the emails' "paused" line for the new cohort.
// Razorpay, Redis (SET NX semantics), Resend and the database are fakes.
//   pnpm exec jest -c apps/backend/jest.config.ts razorpay.trial-policy

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);

// The sweeps await a dynamic import('resend') per email; under a full
// parallel run that alone has taken over 5 s (22 Oct 2026).
jest.setTimeout(30_000);

const redisData = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      await new Promise((r) => setImmediate(r));
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
  },
}));

const sent: any[] = [];
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: {
      send: jest.fn(async (msg: any) => {
        sent.push(msg);
        return { data: { id: `email_${sent.length}` }, error: null };
      }),
    },
  })),
}));

const ORG = 'org-chai';
const CUSTOMER = 'cust_1';
const DAY = 86400;
const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
let clock = nowSec() - 30 * DAY;

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base] = path.split('?');
  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return plan;
  }
  if (method === 'GET' && base === '/plans') return { items: [...plans.values()] };
  if (method === 'GET' && base === '/subscriptions') {
    return { items: [...subs.values()].sort((a, b) => b.created_at - a.created_at) };
  }
  if (method === 'POST' && base === '/subscriptions') {
    const sub = {
      id: `sub_new_${subs.size + 1}`,
      created_at: (clock += 60),
      status: 'created',
      plan_id: body.plan_id,
      customer_id: body.customer_id,
      start_at: body.start_at,
      paid_count: 0,
      notes: body.notes,
    };
    subs.set(sub.id, sub);
    return sub;
  }
  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const sub = subs.get(cancel[1]);
    if (!sub || sub.status === 'cancelled') {
      throw new Error(`Razorpay POST ${path} failed (400): Subscription is already cancelled`);
    }
    sub.status = 'cancelled';
    sub.ended_at = nowSec();
    return { ...sub };
  }
  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'GET') {
    const sub = subs.get(one[1]);
    if (!sub) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return { ...sub };
  }
  if (method === 'GET' && base === '/invoices') return { items: [] };
  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

function putPlan(id: string, billing: string, amount: number) {
  plans.set(id, {
    id,
    period: 'monthly',
    item: { amount, currency: 'INR' },
    notes: { hookpost_key: buildPlanKey(billing, 'MONTHLY', amount, 'INR') },
  });
}

/** A Standard UPI trial, approved, its first charge `aheadSec` from now. */
function putTrial(id = 'sub_trial', aheadSec = 5 * DAY, extra: any = {}) {
  const sub = {
    id,
    created_at: (clock += 60),
    status: 'authenticated',
    plan_id: 'plan_std',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    start_at: nowSec() + aheadSec,
    charge_at: nowSec() + aheadSec,
    current_start: null,
    current_end: null,
    paid_count: 0,
    end_at: nowSec() + 3650 * DAY,
    notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'MONTHLY' },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

function setup(
  row: any,
  opts: { newCohort?: boolean; orgId?: string; sunsetAt?: Date; platformAdmin?: boolean } = {}
) {
  let stored: any = row
    ? { organizationId: opts.orgId || ORG, cancelAt: null, isLifetime: false, period: 'MONTHLY', ...row }
    : null;
  let trialing = !!row;
  const subscriptions = {
    getSubscription: jest.fn(async () => stored),
    // The once-per-person check at approval (trial switch on only).
    refuseTrialAtApproval: jest.fn(async () => false),
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      stored && stored.identifier === id ? stored : null
    ),
    createOrUpdateSubscription: jest.fn(
      async (
        isTrailing: boolean,
        identifier: string,
        _customer: string,
        _channels: number,
        billing: string,
        period: string,
        cancelAt: number | null
      ) => {
        trialing = isTrailing;
        stored = {
          ...stored,
          organizationId: ORG,
          identifier,
          subscriptionTier: billing,
          period,
          isLifetime: false,
          cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        };
      }
    ),
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date) => {
      if (stored?.identifier === identifier) stored = { ...stored, cancelAt: at };
    }),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    getLapsedCancellations: jest.fn(async (now: Date) =>
      stored?.cancelAt && stored.cancelAt.getTime() < now.getTime() ? [stored] : []
    ),
    getTrialingRows: jest.fn(async () =>
      stored && trialing && !stored.cancelAt ? [stored] : []
    ),
    getEndingRows: jest.fn(async (from: Date, to: Date) =>
      stored?.cancelAt &&
      stored.cancelAt.getTime() >= from.getTime() &&
      stored.cancelAt.getTime() <= to.getTime()
        ? [stored]
        : []
    ),
    getPolicyOrg: jest.fn(async (id: string) => ({
      id,
      createdAt: new Date(),
      platformAdmin: !!opts.platformAdmin,
    })),
    // A grandfathered workspace is in the cohort once FREE_PLAN_SUNSET_AT has
    // passed at the moment asked about (trial.policy.ts inTrialCohort).
    inNewCohort: jest.fn(
      async (_org: string, at?: Date) =>
        !!opts.newCohort ||
        (!!opts.sunsetAt && (at ?? new Date()).getTime() >= opts.sunsetAt.getTime())
    ),
    getFreePlanSunsetAt: jest.fn(async () =>
      opts.sunsetAt && opts.sunsetAt.getTime() > Date.now() ? opts.sunsetAt : null
    ),
    updateCustomerId: jest.fn(async () => undefined),
    redeemCouponByCode: jest.fn(async () => undefined),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: 'Chai Point Social',
      paymentId: CUSTOMER,
      isTrailing: trialing,
    })),
    getTeam: jest.fn(async () => ({
      users: [{ user: { id: 'user-1', email: 'priya@chaipoint.in' } }],
    })),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    { track: jest.fn(async () => undefined) } as any,
    { recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined) } as any
  );
  return { razorpay, subscriptions, row: () => stored, trialing: () => trialing };
}

const webhook = (razorpay: RazorpayService, event: string, sub: any) =>
  razorpay.handleWebhook({ event, payload: { subscription: { entity: { ...sub } } } });

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const subjects = () => sent.map((m) => m.subject);
const subscriptionReads = () =>
  calls.filter((c) => c.method === 'GET' && /^\/subscriptions\/sub_/.test(c.path));

const CUTOFF = '2026-10-20T00:00:00Z';
const ENV = { ...process.env };

beforeEach(() => {
  plans.clear();
  subs.clear();
  calls.length = 0;
  redisData.clear();
  sent.length = 0;
  process.env.RESEND_API_KEY = 're_test';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  delete process.env.TRIAL_REQUIRED_SINCE_IN;
  delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
  delete process.env.FREE_PLAN_SUNSET_AT;
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
  putPlan('plan_std', 'STANDARD', 59900);
});
afterEach(() => settle());
afterAll(() => {
  process.env = ENV;
});

describe('a trial cancelled before its first charge keeps working until that date', () => {
  it('the subscription.cancelled webhook keeps it, the email says trial and no charge, then the sweep ends it', async () => {
    const trial = putTrial();
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    // Cancelled from the Razorpay dashboard or the customer's UPI app.
    subs.get('sub_trial').status = 'cancelled';
    subs.get('sub_trial').ended_at = nowSec();
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));

    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);
    expect(subjects()).toEqual(['Your Hookpost Standard trial is cancelled']);
    expect(sent[0].text).toContain("you won't be charged");
    expect(sent[0].text).toContain('After that the workspace moves to the Free plan');
    expect(sent[0].html + sent[0].text).not.toMatch(/JR Consulting|stripe/i);

    // The sweep, an hour before the date: nothing ends.
    const hourBefore = new Date((trial.start_at - HOUR) * 1000);
    expect(await razorpay.endLapsedCancellations(hourBefore)).toEqual({ checked: 0, ended: 0 });
    // Even with the row's date already passed (a clock skew, an old row),
    // Razorpay's start_at decides: still not ended.
    await subscriptions.scheduleCancellation(ORG, 'sub_trial', new Date(hourBefore.getTime() - 1000));
    expect(await razorpay.endLapsedCancellations(hourBefore)).toEqual({ checked: 1, ended: 0 });
    expect(row()).not.toBeNull();

    // An hour after: it ends.
    const hourAfter = new Date((trial.start_at + HOUR) * 1000);
    expect(await razorpay.endLapsedCancellations(hourAfter)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('a new-cohort workspace is told it will be paused, not moved to Free', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    putTrial();
    const { razorpay } = setup(
      { identifier: 'sub_trial', subscriptionTier: 'STANDARD' },
      { newCohort: true }
    );
    subs.get('sub_trial').status = 'cancelled';
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));

    expect(sent[0].text).toContain('After that your workspace is paused; your channels and posts are kept, and their media files for 30 days.');
    expect(sent[0].text).not.toMatch(/Free plan/);
  });

  describe('with FREE_PLAN_SUNSET_AT ahead, a grandfathered workspace', () => {
    const cancelTrialWithSunsetIn = async (sunsetInSec: number) => {
      const sunsetAt = new Date((nowSec() + sunsetInSec) * 1000);
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = sunsetAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
      const trial = putTrial(); // first charge in 5 days
      const { razorpay, subscriptions } = setup(
        { identifier: 'sub_trial', subscriptionTier: 'STANDARD' },
        { sunsetAt }
      );
      subs.get('sub_trial').status = 'cancelled';
      await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
      return { trial, subscriptions };
    };

    it('whose trial runs past the sunset is told it will be paused, not moved to Free', async () => {
      const { trial, subscriptions } = await cancelTrialWithSunsetIn(2 * DAY);
      // Asked about the day the trial ends, not today.
      expect(subscriptions.inNewCohort).toHaveBeenCalledWith(ORG, new Date(trial.start_at * 1000));
      expect(sent[0].text).toContain('After that your workspace is paused; your channels and posts are kept, and their media files for 30 days.');
      expect(sent[0].text).not.toMatch(/Free plan/);
    });

    it('whose trial ends first is told Free, and the date that Free plan ends', async () => {
      await cancelTrialWithSunsetIn(9 * DAY);
      expect(sent[0].text).toContain('After that the workspace moves to the Free plan');
      expect(sent[0].text).toMatch(/The Free plan itself ends on \d{1,2} \w+ 2026; from then the workspace is paused/);
    });
  });

  it('a trial whose first charge was already attempted (a cycle on it) ends now, as before', async () => {
    putTrial('sub_trial', -2 * DAY, {
      status: 'cancelled',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
    });
    const { razorpay, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('a later subscription.updated for the cancelled trial neither ends it early nor stops it being a trial', async () => {
    const trial = putTrial();
    const { razorpay, row, trialing } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);

    await webhook(razorpay, 'subscription.updated', subs.get('sub_trial'));
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);
    expect(trialing()).toBe(true);
  });

  it('Reactivate before the date: a new mandate that is still the trial, first charge on the same date, nothing today', async () => {
    const trial = putTrial();
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);

    const res: any = await razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate');
    const body = calls.find((c) => c.method === 'POST' && c.path === '/subscriptions')!.body;
    expect(body).toMatchObject({
      start_at: trial.start_at,
      notes: { replaces: 'sub_trial', trial: '1', reason: 'reactivate' },
    });
    expect(res).toMatchObject({ chargeToday: 0, unpaid: false });
  });
});

describe('the trial reminder (hourly sweep)', () => {
  it('with both cutoffs empty it reads and sends nothing', async () => {
    putTrial('sub_trial', 48 * HOUR);
    const { razorpay, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    expect(await razorpay.sendTrialReminders()).toEqual({ checked: 0, sent: 0 });
    expect(subscriptions.getTrialingRows).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['12 hours ahead: none (the debit may already be set up)', 12 * HOUR, 0],
    ['25 hours ahead: one email', 25 * HOUR, 1],
    ['47 hours ahead: one email (day 2 of a 3-day trial)', 47 * HOUR, 1],
    ['48 hours ahead: one email', 48 * HOUR, 1],
    // A 3-day trial is 72 hours from its charge when it starts: the "your
    // trial ends" email must not arrive in its first hour.
    ['71 hours ahead: none yet (a 3-day trial that just started)', 71 * HOUR, 0],
    ['80 hours ahead: none yet (a later sweep sends it)', 80 * HOUR, 0],
  ])('first charge %s', async (_label, ahead, expected) => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    putTrial('sub_trial', ahead);
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    expect((await razorpay.sendTrialReminders()).sent).toBe(expected);
    expect(sent).toHaveLength(expected);
  });

  it('states the date, the amount, how to cancel and that UPI AutoPay can be revoked; once per subscription', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    putTrial('sub_trial', 48 * HOUR);
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await razorpay.sendTrialReminders();
    await razorpay.sendTrialReminders(new Date(Date.now() + HOUR));
    await razorpay.sendTrialReminders(new Date(Date.now() + 2 * HOUR));

    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^Your Hookpost Standard trial ends on /);
    expect(sent[0].text).toContain('₹599');
    expect(sent[0].text).toContain('at least 24 hours before');
    expect(sent[0].text).toContain('UPI AutoPay mandate can also be revoked from your UPI app');
    expect(sent[0].html).toContain('/billing');
    expect(sent[0].html + sent[0].text).not.toMatch(/JR Consulting|stripe|free plan/i);
  });

  it('no reminder for a trial that is cancelled, already charged, or not this workspace’s', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    for (const extra of [
      { status: 'cancelled' },
      { status: 'active', paid_count: 1 },
      { notes: { service: 'vetnow', orgId: ORG } },
      { notes: { service: 'hookpost', orgId: 'org-other' } },
    ]) {
      subs.clear();
      putTrial('sub_trial', 48 * HOUR, extra);
      const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
      expect((await razorpay.sendTrialReminders()).sent).toBe(0);
    }
    expect(sent).toHaveLength(0);
  });

  it('when the plan’s amount cannot be read nothing is sent, and a later sweep tries again', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    putTrial('sub_trial', 48 * HOUR, { plan_id: 'plan_gone' });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    expect((await razorpay.sendTrialReminders()).sent).toBe(0);
    expect(redisData.has('razorpay:customer-email:trial-reminder:sub_trial')).toBe(false);

    putPlan('plan_gone', 'STANDARD', 59900);
    expect((await razorpay.sendTrialReminders()).sent).toBe(1);
  });
});

describe('the welcome email on a new trial', () => {
  it('while the trial policy is on: amount, first-charge date, cancel link and UPI revoke', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const trial = putTrial('sub_trial', 7 * DAY);
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', trial);
    await settle();

    expect(subjects()).toEqual(['Your Hookpost Standard trial has started']);
    expect(sent[0].text).toContain('₹599/month');
    expect(sent[0].text).toContain('at least 24 hours before');
    expect(sent[0].text).toContain('UPI AutoPay mandate can also be revoked from your UPI app');
  });

  it('with both cutoffs empty it is the email it was', async () => {
    const trial = putTrial('sub_trial', 7 * DAY);
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', trial);
    await settle();

    expect(subjects()).toEqual(['Your Hookpost Standard trial has started']);
    expect(sent[0].text).not.toContain('₹599/month');
    expect(sent[0].text).not.toContain('at least 24 hours before');
  });
});

describe('trialEndsAt (for /user/self)', () => {
  it('a running trial: its first charge date, read once and cached', async () => {
    const trial = putTrial('sub_trial', 3 * DAY);
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    expect((await razorpay.trialEndsAt(ORG))?.getTime()).toBe(trial.start_at * 1000);
    expect((await razorpay.trialEndsAt(ORG))?.getTime()).toBe(trial.start_at * 1000);
    expect(subscriptionReads()).toHaveLength(1);
  });

  it('a cancelled trial: the date it keeps working until, with no Razorpay read', async () => {
    const until = new Date(Date.now() + 2 * DAY * 1000);
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD', cancelAt: until });
    expect(await razorpay.trialEndsAt(ORG)).toEqual(until);
    expect(calls).toHaveLength(0);
  });

  it('a paid plan: null', async () => {
    putTrial('sub_live', -20 * DAY, { status: 'active', paid_count: 1, current_end: nowSec() + 10 * DAY });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    expect(await razorpay.trialEndsAt(ORG)).toBeNull();
  });
});

// The two emails at the end of a cancelled trial (owner's call, 22 Oct 2026):
// a day or two before access ends, "reactivate to keep it", while Billing
// still allows a Reactivate (it refuses one in the last 24 hours); and when
// the sweep pauses a workspace that has no Free plan, "pick a plan".
describe('a cancelled trial: the "your access ends" email (hourly sweep)', () => {
  const cancelledTrial = (
    aheadSec: number,
    extra: any = {},
    opts: { newCohort?: boolean; platformAdmin?: boolean } = { newCohort: true }
  ) => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const trial = putTrial('sub_trial', aheadSec, {
      status: 'cancelled',
      ended_at: nowSec() - 13 * HOUR,
      ...extra,
    });
    const env = setup(
      {
        identifier: 'sub_trial',
        subscriptionTier: 'STANDARD',
        cancelAt: new Date(trial.start_at * 1000),
      },
      opts
    );
    return { trial, ...env };
  };

  it('with both cutoffs empty it reads and sends nothing', async () => {
    const { razorpay, subscriptions } = cancelledTrial(40 * HOUR);
    delete process.env.TRIAL_REQUIRED_SINCE_IN;
    expect(await razorpay.sendCancelledTrialReminders()).toEqual({ checked: 0, sent: 0 });
    expect(subscriptions.getEndingRows).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('a paused-after workspace: when access ends, the last moment Reactivate works, nothing charged; once', async () => {
    const { trial, razorpay } = cancelledTrial(40 * HOUR);
    const end = new Date(trial.start_at * 1000);

    expect(await razorpay.sendCancelledTrialReminders()).toEqual({ checked: 1, sent: 1 });
    await razorpay.sendCancelledTrialReminders(new Date(Date.now() + HOUR));
    await razorpay.sendCancelledTrialReminders(new Date(Date.now() + 2 * HOUR));
    expect(sent).toHaveLength(1);

    const [mail] = sent;
    expect(mail.subject).toMatch(
      /^Your Hookpost access ends (today|tomorrow|on \d{1,2} \w{3} \d{4}): reactivate to keep it$/
    );
    expect(mail.text).toContain('so nothing will be charged');
    expect(mail.text).toContain(formatBillingDateTime(end));
    // Reactivate is refused inside the last 24 hours, so the email names
    // the moment before that.
    expect(mail.text).toContain(
      `Reactivate from Billing by ${formatBillingDateTime(new Date(end.getTime() - DAY * 1000))}`
    );
    expect(mail.text).toContain('₹599/month');
    expect(mail.text).toContain('After that your workspace is paused; your channels and posts are kept, and their media files for 30 days.');
    expect(mail.html).toContain('/billing');
    expect(mail.html + mail.text).not.toMatch(/JR Consulting|stripe|free plan|one tap/i);
  });

  it('a workspace that moves to the Free plan is told the trial ends, not its access', async () => {
    cancelledTrial(40 * HOUR, {}, { newCohort: false });
    const { razorpay } = setup(
      { identifier: 'sub_trial', subscriptionTier: 'STANDARD', cancelAt: new Date(subs.get('sub_trial').start_at * 1000) },
      { newCohort: false }
    );
    expect((await razorpay.sendCancelledTrialReminders()).sent).toBe(1);
    expect(sent[0].subject).toMatch(/^Your Hookpost Standard trial ends .*: reactivate to keep it$/);
    expect(sent[0].text).toContain('After that the workspace moves to the Free plan');
  });

  it.each([
    ['access ends in 20 hours: none (Reactivate is refused by then)', 20 * HOUR, {}],
    ['access ends in 60 hours: none yet (a later sweep sends it)', 60 * HOUR, {}],
    ['cancelled 2 hours ago: none (the cancellation email just went out)', 40 * HOUR, { ended_at: nowSec() - 2 * HOUR }],
    ['a trial that was charged: none', 40 * HOUR, { paid_count: 1 }],
    ['still authenticated (not cancelled): none', 40 * HOUR, { status: 'authenticated' }],
    ['another workspace’s subscription: none', 40 * HOUR, { notes: { service: 'hookpost', orgId: 'org-other' } }],
  ])('%s', async (_label, ahead, extra) => {
    const { razorpay } = cancelledTrial(ahead as number, extra);
    expect((await razorpay.sendCancelledTrialReminders()).sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('a newer mandate the customer approved (they reactivated or switched): none', async () => {
    const { razorpay } = cancelledTrial(40 * HOUR);
    putTrial('sub_new', 40 * HOUR, { notes: { service: 'hookpost', orgId: ORG, replaces: 'sub_trial', trial: '1' } });
    expect((await razorpay.sendCancelledTrialReminders()).sent).toBe(0);
  });

  it('internal workspaces get none: a platform super admin member, or FREE_PLAN_SUNSET_EXEMPT_ORGS', async () => {
    const admin = cancelledTrial(40 * HOUR, {}, { newCohort: true, platformAdmin: true });
    expect((await admin.razorpay.sendCancelledTrialReminders()).sent).toBe(0);

    subs.clear();
    process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `org-x, ${ORG}`;
    const exempt = cancelledTrial(40 * HOUR);
    expect((await exempt.razorpay.sendCancelledTrialReminders()).sent).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('without the plan’s amount it still goes out, naming no amount', async () => {
    const { razorpay } = cancelledTrial(40 * HOUR, { plan_id: 'plan_gone' });
    expect((await razorpay.sendCancelledTrialReminders()).sent).toBe(1);
    expect(sent[0].text).not.toMatch(/₹|\$/);
  });
});

describe('a cancelled trial runs out: the "workspace is paused" email', () => {
  const runOut = (opts: { newCohort?: boolean; platformAdmin?: boolean } = { newCohort: true }) => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    const trial = putTrial('sub_trial', 3 * DAY, { status: 'cancelled', ended_at: nowSec() });
    const env = setup(
      { identifier: 'sub_trial', subscriptionTier: 'STANDARD', cancelAt: new Date(trial.start_at * 1000) },
      opts
    );
    const after = new Date((trial.start_at + HOUR) * 1000);
    return { trial, after, ...env };
  };

  it('a new-cohort workspace: paused, channels and posts kept, pick a plan; once', async () => {
    const { trial, after, razorpay, subscriptions } = runOut();
    expect(await razorpay.endLapsedCancellations(after)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    await settle();

    expect(subjects()).toEqual(['Your Hookpost workspace is paused: pick a plan to continue']);
    const [mail] = sent;
    expect(mail.text).toContain('Your workspace is paused; your channels and posts are kept, and their media files for 30 days. Choose a plan to keep everything.');
    // No charge claim: a late debit could make it false (f00c7a5cf).
    expect(mail.text).not.toContain('nothing was charged');
    expect(mail.text).toContain('Nothing is published while it is paused.');
    expect(mail.text).toContain('₹599/month');
    expect(mail.text).toContain('charged when you pick it');
    expect(mail.text).toContain(formatBillingDateTime(new Date(trial.start_at * 1000)).split(',')[0]);
    expect(mail.html).toContain('/billing');

    // The row is gone; a second sweep (another process) sends nothing more.
    expect(await razorpay.endLapsedCancellations(after)).toEqual({ checked: 0, ended: 0 });
    expect(sent).toHaveLength(1);
  });

  it('the same subscription is never emailed twice, even if two processes end it', async () => {
    const a = runOut();
    const b = setup(
      { identifier: 'sub_trial', subscriptionTier: 'STANDARD', cancelAt: new Date(a.trial.start_at * 1000) },
      { newCohort: true }
    );
    await Promise.all([a.razorpay.endLapsedCancellations(a.after), b.razorpay.endLapsedCancellations(a.after)]);
    await settle();
    expect(subjects()).toEqual(['Your Hookpost workspace is paused: pick a plan to continue']);
  });

  it('a workspace that moves to the Free plan gets no paused email', async () => {
    const { after, razorpay } = runOut({ newCohort: false });
    expect((await razorpay.endLapsedCancellations(after)).ended).toBe(1);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('an internal workspace gets none', async () => {
    const { after, razorpay } = runOut({ newCohort: true, platformAdmin: true });
    expect((await razorpay.endLapsedCancellations(after)).ended).toBe(1);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('a paid plan that ran out is not a trial: no paused email from this sweep', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    putTrial('sub_live', -40 * DAY, {
      status: 'cancelled',
      paid_count: 1,
      current_start: nowSec() - 31 * DAY,
      current_end: nowSec() - HOUR,
    });
    const { razorpay } = setup(
      { identifier: 'sub_live', subscriptionTier: 'STANDARD', cancelAt: new Date((nowSec() - HOUR) * 1000) },
      { newCohort: true }
    );
    await razorpay.endLapsedCancellations(new Date());
    await settle();
    expect(subjects()).not.toContain('Your Hookpost workspace is paused: pick a plan to continue');
  });
});
