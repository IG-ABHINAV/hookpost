import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { formatBillingDate } from '@hookpost/nestjs-libraries/emails/templates/billing.emails';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';

// Razorpay webhook bodies as the live account sends them, replayed against
// RazorpayService: what is reported to the ads pixel, what is emailed, and
// what happens to the workspace's plan. Razorpay, Redis, Resend and the
// database are fakes; nothing leaves the machine.

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
// The real AffiliateService runs on an in-memory repository below.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);

// Redis with real SET NX semantics, so sendOnce is exercised.
const redisData = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      // Yield first, like a network round trip, so two callers interleave.
      await new Promise((r) => setImmediate(r));
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
  },
}));

const sent: any[] = [];
const mockSend = jest.fn(async (msg: any) => {
  sent.push(msg);
  return { data: { id: `email_${sent.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const ORG = 'org-chai';
const CUSTOMER = 'cust_1';
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
let clock = nowSec() - 30 * DAY;
const tick = () => (clock += 60);
/** Razorpay refusing every cancel, for the paths that have to survive it. */
let refuseCancel = false;

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base, query] = path.split('?');
  const q = new URLSearchParams(query || '');

  if (method === 'GET' && base === '/plans') return { items: [...plans.values()] };
  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return plan;
  }
  if (method === 'GET' && base === '/subscriptions') {
    const count = Math.min(Number(q.get('count') || 10), 100);
    const skip = Number(q.get('skip') || 0);
    const newestFirst = [...subs.values()].sort((a, b) => b.created_at - a.created_at);
    return { items: newestFirst.slice(skip, skip + count) };
  }
  if (method === 'POST' && base === '/subscriptions') {
    const sub = {
      id: `sub_new_${subs.size + 1}`,
      entity: 'subscription',
      created_at: tick(),
      status: 'created',
      plan_id: body.plan_id,
      customer_id: body.customer_id,
      start_at: body.start_at,
      charge_at: body.start_at,
      paid_count: 0,
      notes: body.notes,
      short_url: 'https://rzp.io/i/checkout',
    };
    subs.set(sub.id, sub);
    return sub;
  }
  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    if (refuseCancel) {
      throw new Error(`Razorpay POST ${path} failed (500): down`);
    }
    const sub = subs.get(cancel[1]);
    if (!sub) throw new Error(`Razorpay POST ${path} failed (404): not found`);
    if (sub.status === 'cancelled') {
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
  if (one && method === 'PATCH') {
    throw new Error(
      `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is upi`
    );
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

/** A Standard UPI trial as Razorpay reports it once the mandate is approved. */
function putTrial(id = 'sub_trial', extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'authenticated',
    plan_id: 'plan_std',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    start_at: nowSec() + 7 * DAY,
    charge_at: nowSec() + 7 * DAY,
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

function setup(row: any) {
  let stored: any = row
    ? {
        organizationId: ORG,
        cancelAt: null,
        isLifetime: false,
        period: 'MONTHLY',
        paymentFailingSince: null,
        ...row,
      }
    : null;
  let trialing = false;
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
          // As the repository's upsert: null clears it.
          cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        };
      }
    ),
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date | null) => {
      if (stored?.identifier === identifier) stored = { ...stored, cancelAt: at };
    }),
    getLapsedCancellations: jest.fn(async (now: Date) =>
      stored?.cancelAt && stored.cancelAt < now && String(stored.identifier).startsWith('sub_')
        ? [{ organizationId: ORG, identifier: stored.identifier, cancelAt: stored.cancelAt }]
        : []
    ),
    updateCustomerId: jest.fn(async () => undefined),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    redeemCouponByCode: jest.fn(async () => undefined),
    // As SubscriptionRepository.setPaymentFailing: only this org's row with
    // this identifier, and a marker already on file keeps its own date.
    markPaymentFailing: jest.fn(async (org: string, identifier: string, since: Date) => {
      if (stored?.organizationId !== org || stored?.identifier !== identifier) return 0;
      if (stored.paymentFailingSince) return 0;
      stored = { ...stored, paymentFailingSince: since };
      return 1;
    }),
    // As clearPaymentFailingByIdentifier: by identifier, whichever workspace.
    clearPaymentFailing: jest.fn(async (identifier: string) => {
      if (stored?.identifier !== identifier || !stored.paymentFailingSince) return 0;
      stored = { ...stored, paymentFailingSince: null };
      return 1;
    }),
    // A new checkout's trial length: the advertised one.
    trialDaysFor: jest.fn(async (_org: string, base: number) => base),
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
  const track = { track: jest.fn(async () => undefined) };
  const commissions: any[] = [];
  const affiliates = new AffiliateService({
    findReferral: jest.fn(async () => ({
      createdAt: new Date(),
      affiliate: { id: 'aff_1', active: true, commissionMonths: 12, commissionPercent: 30 },
    })),
    findCommissionByPayment: jest.fn(async (paymentId: string) =>
      commissions.find((c) => c.paymentId === paymentId) || null
    ),
    createCommission: jest.fn(async (data: any) => {
      commissions.push(data);
      return data;
    }),
  } as any);
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    track as any,
    affiliates
  );
  return {
    razorpay,
    subscriptions,
    track,
    commissions,
    row: () => stored,
    trialing: () => trialing,
  };
}

const webhook = (razorpay: RazorpayService, event: string, sub: any, payment?: any) =>
  razorpay.handleWebhook({
    event,
    payload: {
      subscription: { entity: { ...sub } },
      ...(payment ? { payment: { entity: payment } } : {}),
    },
  });

/** Let fire-and-forget work (the welcome email) finish. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const tracked = (track: any, kind: TrackEnum) =>
  track.track.mock.calls.filter((c: any[]) => c[3] === kind);
const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions');
const cancelled = () =>
  calls.filter((c) => c.method === 'POST' && /\/cancel$/.test(c.path)).map((c) => c.path.split('/')[2]);
const subjects = () => sent.map((m) => m.subject);

beforeEach(() => {
  plans.clear();
  subs.clear();
  calls.length = 0;
  redisData.clear();
  refuseCancel = false;
  sent.length = 0;
  mockSend.mockClear();
  mockRequest.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.RAZORPAY_OFFER_ID;
  delete process.env.INTL_CHECKOUT;
  putPlan('plan_std', 'STANDARD', 59900);
  putPlan('plan_pro', 'PRO', 199900);
});

// The welcome email is not awaited by the webhook; let it land before the
// next test clears the outbox.
afterEach(() => settle());

afterAll(() => {
  delete process.env.RESEND_API_KEY;
});

describe('subscription.authenticated: a trial starts', () => {
  it('without a payment entity: StartTrial once with the subscription id, no Purchase', async () => {
    const trial = putTrial();
    const { razorpay, track, commissions } = setup(null);

    await webhook(razorpay, 'subscription.authenticated', trial);
    await webhook(razorpay, 'subscription.authenticated', trial); // Razorpay retry

    expect(tracked(track, TrackEnum.Purchase)).toHaveLength(0);
    const starts = tracked(track, TrackEnum.StartTrial);
    expect(starts).toHaveLength(1);
    expect(starts[0][0]).toBe('trial_sub_trial');
    expect(commissions).toHaveLength(0);
  });

  it('with the Rs 5 mandate check as its payment entity: still no Purchase, no commission', async () => {
    const trial = putTrial();
    const { razorpay, track, commissions } = setup(null);
    const check = {
      id: 'pay_check',
      entity: 'payment',
      amount: 500,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      invoice_id: null,
    };

    await webhook(razorpay, 'subscription.authenticated', trial, check);
    await webhook(razorpay, 'subscription.activated', trial, check);

    expect(tracked(track, TrackEnum.Purchase)).toHaveLength(0);
    expect(tracked(track, TrackEnum.StartTrial)).toHaveLength(1);
    expect(commissions).toHaveLength(0);
  });

  it('a checkout that charges now, still `authenticated`: no StartTrial, and verify says no trial', async () => {
    // A workspace whose trial is used (allowTrial false) subscribes: no
    // start_at, so the plan is charged on authorisation, and Razorpay reports
    // it `authenticated` with paid_count 0 until it activates.
    const paying = putTrial('sub_now', {
      start_at: undefined,
      charge_at: nowSec(),
      paid_count: 0,
    });
    const { razorpay, track } = setup(null);

    await webhook(razorpay, 'subscription.authenticated', paying);
    const synced = await razorpay.syncSubscriptionById('sub_now');
    await settle();

    expect(tracked(track, TrackEnum.StartTrial)).toHaveLength(0);
    expect(synced.trial).toBe(false);
    // Nor is it welcomed as a trial.
    expect(subjects().filter((t) => /trial/i.test(t))).toEqual([]);
  });

  it('start_at set to now (no trial days) is not a trial either', async () => {
    const paying = putTrial('sub_now2', { start_at: nowSec(), charge_at: nowSec() });
    const { razorpay, track } = setup(null);

    await webhook(razorpay, 'subscription.authenticated', paying);
    const synced = await razorpay.syncSubscriptionById('sub_now2');

    expect(tracked(track, TrackEnum.StartTrial)).toHaveLength(0);
    expect(synced.trial).toBe(false);
  });

  it('a plan that starts today (no trial) reports no StartTrial', async () => {
    const paid = putTrial('sub_paid', {
      status: 'active',
      start_at: nowSec() - 60,
      current_start: nowSec() - 60,
      current_end: nowSec() + 30 * DAY,
      paid_count: 1,
    });
    const { razorpay, track } = setup(null);

    await webhook(razorpay, 'subscription.activated', paid);

    expect(tracked(track, TrackEnum.StartTrial)).toHaveLength(0);
  });
});

describe('subscription.charged', () => {
  it('delivered twice: one Purchase event id, one affiliate commission', async () => {
    const sub = putTrial('sub_live', {
      status: 'active',
      current_start: nowSec(),
      current_end: nowSec() + 30 * DAY,
      paid_count: 1,
    });
    const charge = {
      id: 'pay_599',
      entity: 'payment',
      amount: 59900,
      currency: 'INR',
      status: 'captured',
      invoice_id: 'inv_1',
    };
    const { razorpay, track, commissions } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.charged', sub, charge);
    await webhook(razorpay, 'subscription.charged', sub, charge);

    const purchases = tracked(track, TrackEnum.Purchase);
    expect(purchases.length).toBeGreaterThan(0);
    expect(new Set(purchases.map((c: any[]) => c[0]))).toEqual(new Set(['purchase_pay_599']));
    expect(purchases[0][4]).toEqual({ value: 599, currency: 'INR' });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({ paymentId: 'pay_599', amount: 59900 });
  });
});

describe('checkout callback and webhook at the same moment', () => {
  it('send one welcome email; every StartTrial carries the same event id', async () => {
    const trial = putTrial();
    const { razorpay, track } = setup(null);

    const [synced] = await Promise.all([
      razorpay.syncSubscriptionById('sub_trial'),
      webhook(razorpay, 'subscription.authenticated', trial),
    ]);
    await settle();

    expect(synced.trial).toBe(true);
    const welcomes = sent.filter((m) => /trial has started/.test(m.subject));
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].to).toBe('priya@chaipoint.in');
    expect(sent).toHaveLength(1);
    const ids = tracked(track, TrackEnum.StartTrial).map((c: any[]) => c[0]);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(['trial_sub_trial']));
  });

  it('a send Resend refuses frees the claim instead of marking the email sent', async () => {
    const trial = putTrial();
    const { razorpay } = setup(null);
    mockSend.mockImplementationOnce(
      async () => ({ data: null, error: { message: 'rate limited' } }) as any
    );

    await webhook(razorpay, 'subscription.authenticated', trial);
    await settle();

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(redisData.has('razorpay:customer-email:welcome:sub_trial')).toBe(false);
  });
});

describe('subscription.halted', () => {
  it('paid_count 0: the trial is cancelled at Razorpay and ends now, with a "trial has ended" email', async () => {
    // Razorpay tried the day-7 debit, so the first cycle has a current_end;
    // nothing was paid for it.
    const halted = putTrial('sub_trial', {
      status: 'halted',
      current_start: nowSec() - 4 * DAY,
      current_end: nowSec() + 26 * DAY,
      paid_count: 0,
    });
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual(['sub_trial']);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(row()).toBeNull();
    expect(subjects()).toEqual(['Your Hookpost Standard trial has ended']);
    expect(sent[0].text).toContain("You won't be charged");
    expect(sent[0].text).toContain('Hookpost by Hookstep');
    expect(sent[0].html + sent[0].text).not.toMatch(/JR Consulting|renewal paused/i);

    // Razorpay's own subscription.cancelled follows: nothing more happens.
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    expect(sent).toHaveLength(1);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledTimes(1);
  });

  // No free service while a payment is failing (29 Oct 2026, the owner's
  // call): a halt has no grace, so a halt with nothing paid for past
  // today ends the plan here instead of a week later.
  it('paid_count 1: an unpaid renewal that halted ends the plan now, with the "plan has ended" email', async () => {
    // Razorpay has booked the unpaid cycle: 2 booked, 1 paid, so the time
    // paid for stopped at current_start.
    const halted = putTrial('sub_live', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 1,
      halted_at: nowSec() - 3600,
    });
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual(['sub_live']);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(row()).toBeNull();
    // Only the cancellation email: a second "renewal paused, pay to keep
    // posting" beside it would contradict a plan that has already ended.
    expect(subjects()).toEqual(['Your Hookpost Standard plan has ended']);
    expect(sent[0].text).toContain('the period you had paid for has run out');
    expect(sent[0].text).toContain("You won't be charged");
  });

  it('paid_count 0 on a Change payment method mandate: kept to the time paid for on the plan it replaces', async () => {
    // A replacement mandate has no current_end of its own; its start_at is
    // where the plan it replaces was paid until (replacementPaidUntil).
    const halted = putTrial('sub_pm', {
      status: 'halted',
      paid_count: 0,
      notes: { service: 'hookpost', orgId: ORG, replaces: 'sub_old', reason: 'payment_method' },
    });
    const { razorpay, row } = setup({ identifier: 'sub_pm', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual([]);
    expect(row()).toMatchObject({ identifier: 'sub_pm' });
    expect(row().cancelAt).toEqual(new Date(halted.start_at * 1000));
    expect(subjects()).toEqual(['Action needed: Hookpost renewal paused']);
    expect(sent[0].text).toContain(formatBillingDate(new Date(halted.start_at * 1000)));
  });

  it('paid_count 0 but not the plan the workspace is on: left alone', async () => {
    const halted = putTrial('sub_old_trial', { status: 'halted', paid_count: 0 });
    const { razorpay, row } = setup({ identifier: 'sub_other', subscriptionTier: 'PRO' });

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual([]);
    expect(row()).toMatchObject({ identifier: 'sub_other', subscriptionTier: 'PRO', cancelAt: null });
  });

  it('a payload without paid_count is never read as unpaid: the plan keeps its cycle', async () => {
    const halted = putTrial('sub_live', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
    });
    delete (halted as any).paid_count;
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual([]);
    expect(row()).toMatchObject({ identifier: 'sub_live' });
    expect(row().cancelAt).toEqual(new Date(halted.current_end * 1000));
  });
});

describe('a halted renewal of a paid plan (sub_TYd1D4gZnW0EP2, Oct 2026)', () => {
  // Standard Rs 599 on UPI, paid once (13 Sep - 12 Oct); the 12 Oct renewal
  // failed on every retry. Razorpay has already moved current_start and
  // current_end onto the unpaid cycle and booked it off remaining_count.
  const putHalted = (extra: any = {}) =>
    putTrial('sub_live', {
      status: 'halted',
      start_at: nowSec() - 37 * DAY,
      current_start: nowSec() - 8 * DAY,
      current_end: nowSec() + 22 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 1,
      halted_at: nowSec() - 60,
      ...extra,
    });
  const stdRow = { identifier: 'sub_live', subscriptionTier: 'STANDARD' };
  const at = (days: number) => new Date(Date.now() + days * DAY * 1000);

  it('the webhook cancels it at Razorpay and ends the plan at once, once', async () => {
    const halted = putHalted();
    const { razorpay, subscriptions, row } = setup(stdRow);

    await webhook(razorpay, 'subscription.halted', halted);

    expect(cancelled()).toEqual(['sub_live']);
    expect(calls.find((c) => /\/cancel$/.test(c.path))?.body).toEqual({ cancel_at_cycle_end: 0 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(row()).toBeNull();
    expect(subjects()).toEqual(['Your Hookpost Standard plan has ended']);
    expect(sent[0].text).toContain("You won't be charged");
    expect(sent[0].html + sent[0].text).not.toMatch(/Cancelled by mistake/);

    // Razorpay's own subscription.cancelled follows, and the sweep runs:
    // nothing more happens.
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_live'));
    expect(await razorpay.endLapsedCancellations(at(9))).toEqual({ checked: 0, ended: 0 });
    expect(sent).toHaveLength(1);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledTimes(1);
  });

  it('halted_at is not read any more: a halt with no paid time left ends the plan now either way', async () => {
    const halted = putHalted({ halted_at: undefined });
    const { razorpay, row } = setup(stdRow);

    await webhook(razorpay, 'subscription.halted', halted);

    expect(row()).toBeNull();
    expect(cancelled()).toEqual(['sub_live']);
  });

  it('a halted subscription whose current cycle was paid keeps all of it: the plan ends at current_end', async () => {
    // 2 cycles booked, 2 paid (paidThrough is current_end).
    const halted = putHalted({ paid_count: 2 });
    const { razorpay, row } = setup(stdRow);

    await webhook(razorpay, 'subscription.halted', halted);

    expect(row().cancelAt).toEqual(new Date(halted.current_end * 1000));
  });

  it('an end date saved short of time that was paid for: the sweep cancels at Razorpay but keeps the plan to current_end', async () => {
    // A row whose saved date fell before the end of a cycle that was paid
    // (2 booked, 2 paid): ending it must not take back paid time.
    const halted = putHalted({ paid_count: 2 });
    const { razorpay, subscriptions, row } = setup({ ...stdRow, cancelAt: at(-1) });

    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 1, ended: 1 });

    expect(cancelled()).toEqual(['sub_live']);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    expect(row().cancelAt).toEqual(new Date(halted.current_end * 1000));
  });

  it('a redelivered halted webhook does not push the end date back', async () => {
    // A cycle that was paid for (2 booked, 2 paid), so there is a date on
    // file to push: an unpaid one has already ended by now.
    const halted = putHalted({ paid_count: 2 });
    const { razorpay, row } = setup(stdRow);
    await webhook(razorpay, 'subscription.halted', halted);
    const first = row().cancelAt;

    await webhook(razorpay, 'subscription.halted', {
      ...halted,
      current_end: halted.current_end + 30 * DAY,
    });

    expect(row().cancelAt).toEqual(first);
  });

  it('a late halted webhook for a renewal Razorpay already shows paid starts no grace', async () => {
    const halted = putHalted();
    subs.set('sub_live', { ...halted, status: 'active', paid_count: 2, halted_at: null });
    const { razorpay, row } = setup(stdRow);

    await webhook(razorpay, 'subscription.halted', halted);

    expect(row().cancelAt).toBeNull();
  });

  it('paid while the paid-for time still ran: the charge lifts the end date and the sweep leaves the plan alone', async () => {
    const halted = putHalted({ paid_count: 2 });
    const { razorpay, subscriptions, row } = setup(stdRow);
    await webhook(razorpay, 'subscription.halted', halted);
    expect(row().cancelAt).toBeInstanceOf(Date);
    expect(row().paymentFailingSince).toBeInstanceOf(Date);

    // The retry goes through and Razorpay moves on to the next cycle.
    const paid = {
      ...halted,
      status: 'active',
      paid_count: 3,
      current_start: halted.current_end,
      current_end: halted.current_end + 30 * DAY,
      halted_at: null,
    };
    subs.set('sub_live', paid);
    await webhook(razorpay, 'subscription.charged', paid, {
      id: 'pay_late',
      entity: 'payment',
      amount: 59900,
      currency: 'INR',
      status: 'captured',
      invoice_id: 'inv_late',
    });

    expect(row()).toMatchObject({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
      cancelAt: null,
      // The workspace is paying again, so AI and X come back by themselves.
      paymentFailingSince: null,
    });
    expect(await razorpay.endLapsedCancellations(at(8))).toEqual({ checked: 0, ended: 0 });
    expect(cancelled()).toEqual([]);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
  });

  it('paid but the date was never lifted: the sweep lifts it instead of ending a plan Razorpay is billing', async () => {
    putHalted({ status: 'active', paid_count: 2, halted_at: null });
    const { razorpay, subscriptions, row } = setup({ ...stdRow, cancelAt: at(-1) });

    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 1, ended: 0 });

    expect(cancelled()).toEqual([]);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ identifier: 'sub_live', cancelAt: null });
  });

  it('a charge webhook never lifts a cancellation the customer made (Razorpay still shows it)', async () => {
    // A copy: the fake's cancel changes the stored entity in place.
    const live = {
      ...putTrial('sub_live', {
        status: 'active',
        current_start: nowSec() - DAY,
        current_end: nowSec() + 29 * DAY,
        total_count: 120,
        remaining_count: 118,
        paid_count: 2,
      }),
    };
    const { razorpay, row } = setup(stdRow);
    await razorpay.cancelAtPeriodEnd(ORG);
    // The fake cancels outright; Razorpay keeps an active plan to the cycle
    // end and says so in end_at.
    subs.set('sub_live', { ...live, end_at: live.current_end });
    const saved = row().cancelAt;

    // A stale payload that does not show the cancellation.
    await webhook(razorpay, 'subscription.charged', live, {
      id: 'pay_2',
      entity: 'payment',
      amount: 59900,
      currency: 'INR',
      status: 'captured',
      invoice_id: 'inv_2',
    });

    expect(row().cancelAt).toEqual(saved);
  });

  it('Razorpay refuses the cancel: the plan keeps its past end date and the next sweep tries again', async () => {
    const halted = putHalted();
    const { razorpay, row } = setup(stdRow);
    refuseCancel = true;

    await webhook(razorpay, 'subscription.halted', halted);

    // The date is on file and already past, so the plan is not left running:
    // the hourly sweep ends it as soon as Razorpay takes the cancel.
    expect(row()).toMatchObject({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    expect(row().cancelAt.getTime()).toBeLessThanOrEqual(Date.now());
    // The customer is told the renewal failed, with no date to promise.
    expect(subjects()).toEqual(['Action needed: Hookpost renewal paused']);

    refuseCancel = false;
    expect(await razorpay.endLapsedCancellations(at(1))).toEqual({ checked: 1, ended: 1 });
    expect(row()).toBeNull();
  });

  it('cancelled by hand while halted: ends now, not at the end of the unpaid cycle', async () => {
    // What happened live on 20 Oct: the row was kept to 12 Nov.
    putHalted();
    const { razorpay, subscriptions, row } = setup(stdRow);

    const res = await razorpay.cancelAtPeriodEnd(ORG);
    expect(res.immediate).toBe(true);
    expect(cancelled()).toEqual(['sub_live']);

    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_live'));
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(row()).toBeNull();
  });

  it('cancelled from the Razorpay dashboard while halted: the webhook ends it now too', async () => {
    putHalted({ status: 'cancelled', ended_at: nowSec(), halted_at: null });
    const { razorpay, subscriptions } = setup(stdRow);

    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_live'));

    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('a lifetime workspace or another workspace’s plan is never given a grace', async () => {
    const halted = putHalted();
    const lifetime = setup({ ...stdRow, isLifetime: true });
    await webhook(lifetime.razorpay, 'subscription.halted', halted);
    expect(lifetime.row().cancelAt).toBeNull();

    const other = setup({ identifier: 'sub_other', subscriptionTier: 'PRO' });
    await webhook(other.razorpay, 'subscription.halted', halted);
    expect(other.row()).toMatchObject({ identifier: 'sub_other', cancelAt: null });
  });
});

describe('subscription.pending', () => {
  const trialPending = () =>
    putTrial('sub_trial', {
      status: 'pending',
      current_start: nowSec() - DAY,
      current_end: nowSec() + 29 * DAY,
      paid_count: 0,
    });

  it("a trial's first charge failing: AI and X go off and the email says so", async () => {
    const pending = trialPending();
    const { razorpay, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.pending', pending, {
      id: 'pay_fail',
      amount: 59900,
      currency: 'INR',
      error_description: 'Payment declined by the bank',
    });

    // The marker is what takes AI and X off: trial.policy.ts planState reads
    // paymentFailingSince as `dunning`, so the entitlement checks refuse them
    // without asking Razorpay.
    expect(row()).toMatchObject({ identifier: 'sub_trial' });
    expect(row().paymentFailingSince).toBeInstanceOf(Date);
    expect(subjects()).toEqual([
      "Your first Hookpost payment didn't go through yet",
    ]);
    expect(sent[0].text).toContain('Razorpay will retry it automatically');
    expect(sent[0].text).toContain('AI writing and posting to X are paused');
    // It must not claim the workspace is shut: the other channels publish.
    expect(sent[0].text).not.toMatch(/workspace is paused/i);
    expect(sent[0].text).toContain('your scheduled posts go out to your other channels');
    expect(sent[0].text).toContain('₹599');
    expect(sent[0].text).not.toMatch(/renew/i);
    // The plan is left on file: Razorpay is still retrying it.
    expect(cancelled()).toEqual([]);
  });

  it('a retry that goes through clears the marker, so AI and X come back by themselves', async () => {
    const pending = trialPending();
    const { razorpay, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.pending', pending);
    expect(row().paymentFailingSince).toBeInstanceOf(Date);

    const paid = { ...pending, status: 'active', paid_count: 1 };
    subs.set('sub_trial', paid);
    await webhook(razorpay, 'subscription.charged', paid, {
      id: 'pay_retry',
      entity: 'payment',
      amount: 59900,
      currency: 'INR',
      status: 'captured',
      invoice_id: 'inv_retry',
    });

    expect(row()).toMatchObject({ identifier: 'sub_trial', paymentFailingSince: null });
  });

  it('every retry marks the same moment: "failing since" is never pushed forward', async () => {
    const pending = trialPending();
    const { razorpay, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.pending', pending);
    const first = row().paymentFailingSince;
    await new Promise((r) => setTimeout(r, 5));
    await webhook(razorpay, 'subscription.pending', pending);

    expect(row().paymentFailingSince).toEqual(first);
  });

  it('a pending webhook redelivered after the charge went through leaves the paid plan alone', async () => {
    const pending = trialPending();
    // Razorpay retries a webhook for up to 24 hours; by now it is paid.
    subs.set('sub_trial', { ...pending, status: 'active', paid_count: 1 });
    const { razorpay, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.pending', pending);

    expect(row()).toMatchObject({ identifier: 'sub_trial', paymentFailingSince: null });
  });

  it('a paid renewal failing keeps the usual email, and marks the plan as failing', async () => {
    const pending = putTrial('sub_live', { status: 'pending', paid_count: 3 });
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.pending', pending);

    // dunning: ordinary publishing carries on, AI and X stop.
    expect(row().paymentFailingSince).toBeInstanceOf(Date);
    expect(row().cancelAt).toBeNull();
    expect(subjects()).toEqual(["Your Hookpost payment didn't go through"]);
    expect(sent[0].text).toContain('AI writing and posting to X are paused');
    expect(sent[0].text).toContain('keep working meanwhile');
  });

  it('a lifetime plan has no charge to fail: never marked', async () => {
    const pending = putTrial('sub_live', { status: 'pending', paid_count: 3 });
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD', isLifetime: true });

    await webhook(razorpay, 'subscription.pending', pending);

    expect(row().paymentFailingSince).toBeNull();
  });

  it("another workspace's plan is never marked", async () => {
    const pending = putTrial('sub_old', { status: 'pending', paid_count: 3 });
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.pending', pending);

    expect(row()).toMatchObject({ identifier: 'sub_live', paymentFailingSince: null });
  });

  it('Cancel on a trial whose first charge is still being retried ends it now', async () => {
    putTrial('sub_trial', {
      status: 'pending',
      current_start: nowSec() - DAY,
      current_end: nowSec() + 29 * DAY,
      paid_count: 0,
    });
    const { razorpay, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG);
    expect(res.immediate).toBe(true);

    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });
});

describe('Cancel near the end of a trial', () => {
  const cancelEmail = () => sent.find((m) => /trial is cancelled/.test(m.subject));

  it('within a day of the first charge: the email says the debit may still land and is refunded in full', async () => {
    putTrial('sub_trial', { start_at: nowSec() + 12 * 3600, charge_at: nowSec() + 12 * 3600 });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await razorpay.cancelAtPeriodEnd(ORG);
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    await settle();

    const email = cancelEmail();
    expect(email).toBeDefined();
    expect(email.html).toContain('we refund it in full');
    expect(email.html).not.toMatch(/won&#39;t be charged|won't be charged/);
  });

  it('days ahead: no charge, as before', async () => {
    putTrial('sub_trial');
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await razorpay.cancelAtPeriodEnd(ORG);
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    await settle();

    const email = cancelEmail();
    expect(email).toBeDefined();
    expect(email.html).toMatch(/won&#39;t be charged|won't be charged/);
    expect(email.html).not.toContain('already under way');
  });
});

describe('plan change during a trial', () => {
  it('keeps start_at: no PATCH, no charge today, the trial mandate retired on approval', async () => {
    const trial = putTrial();
    const { razorpay, subscriptions, track, row, trialing } = setup({
      identifier: 'sub_trial',
      subscriptionTier: 'STANDARD',
    });

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview).toMatchObject({ chargeToday: 0, recurring: 1999, currentIsTrial: true });
    expect(preview.nextChargeAt.getTime()).toBe(trial.start_at * 1000);

    calls.length = 0;
    const res: any = await razorpay.subscribe(
      'ud-1',
      ORG,
      'user-1',
      { billing: 'PRO', period: 'MONTHLY' } as any,
      false
    );

    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(created()).toHaveLength(1);
    expect(created()[0].body).toMatchObject({
      plan_id: 'plan_pro',
      start_at: trial.start_at,
      customer_id: CUSTOMER,
      notes: {
        service: 'hookpost',
        orgId: ORG,
        billing: 'PRO',
        replaces: 'sub_trial',
        reason: 'plan_change',
        trial: '1',
      },
    });
    expect(res).toMatchObject({ currency: 'INR', url: 'https://rzp.io/i/checkout' });
    expect(cancelled()).toEqual([]); // nothing retired before approval

    // The customer approves the new mandate.
    const replacement = subs.get(res.subscriptionId);
    Object.assign(replacement, { status: 'authenticated' });
    const synced = await razorpay.syncSubscriptionById(res.subscriptionId);
    await webhook(razorpay, 'subscription.authenticated', replacement);
    await settle();

    expect(synced.trial).toBe(false); // the page reloads, no second StartTrial
    expect(row()).toMatchObject({ identifier: res.subscriptionId, subscriptionTier: 'PRO' });
    expect(trialing()).toBe(true);
    expect(subscriptions.createOrUpdateSubscription).toHaveBeenLastCalledWith(
      true,
      res.subscriptionId,
      CUSTOMER,
      expect.any(Number),
      'PRO',
      'MONTHLY',
      null,
      undefined,
      ORG
    );
    expect(cancelled()).toEqual(['sub_trial']);
    expect(tracked(track, TrackEnum.StartTrial)).toHaveLength(0);
    expect(tracked(track, TrackEnum.Purchase)).toHaveLength(0);
    expect(sent).toHaveLength(0); // no welcome for a continuation
  });

  it('in the trial’s last minutes it is refused, and nothing is created', async () => {
    putTrial('sub_trial', { start_at: nowSec() + 5 * 60, charge_at: nowSec() + 5 * 60 });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    await expect(
      razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(created()).toHaveLength(0);
  });

  it('within a day of the first charge (debit may be at the bank) it is refused, preview included, and nothing is created', async () => {
    putTrial('sub_trial', { start_at: nowSec() + 12 * 3600, charge_at: nowSec() + 12 * 3600 });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview.refusal).toMatch(/your bank may already have started it/);
    expect(preview.chargeToday).toBeNull();

    calls.length = 0;
    const attempt = razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(
      razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false)
    ).rejects.toThrow(preview.refusal);
    expect(created()).toHaveLength(0);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('just over a day out a switch still goes through, with nothing today', async () => {
    const trial = putTrial('sub_trial', { start_at: nowSec() + 25 * 3600, charge_at: nowSec() + 25 * 3600 });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview).toMatchObject({ chargeToday: 0 });
    expect(preview.refusal).toBeUndefined();
    const res: any = await razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false);
    expect(created()).toHaveLength(1);
    expect(res.startAt).toBe(trial.start_at);
  });

  it('a cancelled trial in its last day: no new plan beside it (not charged at once either)', async () => {
    const trial = putTrial('sub_trial', { start_at: nowSec() + 6 * 3600, charge_at: nowSec() + 6 * 3600 });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);
    expect(subs.get('sub_trial').status).toBe('cancelled');

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview.refusal).toMatch(/Your trial ends on/);

    calls.length = 0;
    await expect(
      razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(created()).toHaveLength(0);
    expect(trial.start_at).toBeGreaterThan(nowSec());
  });

  it('after Cancel the trial still runs, and a switch then continues it from the same date: nothing today', async () => {
    const trial = putTrial();
    const { razorpay, row, trialing, subscriptions } = setup({
      identifier: 'sub_trial',
      subscriptionTier: 'STANDARD',
    });

    const cancel = await razorpay.cancelAtPeriodEnd(ORG);
    expect(cancel).toMatchObject({ immediate: false });
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview).toMatchObject({ chargeToday: 0, recurring: 1999, currentIsTrial: true, currentIsPaid: false });
    expect(preview.nextChargeAt.getTime()).toBe(trial.start_at * 1000);

    calls.length = 0;
    const res: any = await razorpay.subscribe(
      'ud-1',
      ORG,
      'user-1',
      { billing: 'PRO', period: 'MONTHLY' } as any,
      false
    );
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(created()).toHaveLength(1);
    expect(created()[0].body).toMatchObject({
      plan_id: 'plan_pro',
      start_at: trial.start_at,
      notes: { replaces: 'sub_trial', reason: 'plan_change', trial: '1' },
    });

    // Approved: the workspace is on Pro, still trialing, and no longer set
    // to end (the repository writes cancelAt as given: null).
    const replacement = subs.get(res.subscriptionId);
    Object.assign(replacement, { status: 'authenticated' });
    await webhook(razorpay, 'subscription.authenticated', replacement);
    await settle();
    expect(row()).toMatchObject({ identifier: res.subscriptionId, subscriptionTier: 'PRO' });
    expect(subscriptions.createOrUpdateSubscription).toHaveBeenLastCalledWith(
      true,
      res.subscriptionId,
      CUSTOMER,
      expect.any(Number),
      'PRO',
      'MONTHLY',
      null,
      undefined,
      ORG
    );
    expect(trialing()).toBe(true);
  });

  it('a paying customer still switches the way they did', async () => {
    putTrial('sub_live', {
      status: 'active',
      current_start: nowSec() - 5 * DAY,
      current_end: nowSec() + 25 * DAY,
      paid_count: 2,
    });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, false);

    // No PATCH (Razorpay cannot re-plan UPI, mandateRules), but a mandate for
    // the new plan whose first charge is pushed out by what the 25 unused
    // days are worth on it (the owner's plan-change policy, 29 Oct 2026).
    // Nothing is charged today, and the mandate is marked a continuation
    // rather than a trial.
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(created()).toHaveLength(1);
    expect(created()[0].body.start_at).toBeGreaterThan(nowSec());
    expect(created()[0].body.notes.replaces).toBe('sub_live');
    expect(created()[0].body.notes.change).toBe('upgrade');
    // For the owner's sale alert: its first charge is a plan change, not a
    // new customer (razorpay.owner-alerts.spec.ts).
    expect(created()[0].body.notes.previous_plan).toBe('sub_live');
  });

  it('a new customer (no plan on file) gets no previous_plan note', async () => {
    const { razorpay } = setup(null);
    await razorpay.subscribe('ud-1', ORG, 'user-1', { billing: 'PRO', period: 'MONTHLY' } as any, true);
    expect(created()).toHaveLength(1);
    expect(created()[0].body.notes).not.toHaveProperty('previous_plan');
  });
});

// ₹5,990 a year for Standard (owner's approval, 22 Oct 2026). Razorpay already
// holds that plan, plan_TTGNFILvSBTGvD, under STANDARD|YEARLY|599000|INR.
describe('Standard yearly, ₹5,990', () => {
  const YEARLY_PLAN = 'plan_TTGNFILvSBTGvD';
  const putYearlyPlan = () =>
    plans.set(YEARLY_PLAN, {
      id: YEARLY_PLAN,
      period: 'yearly',
      interval: 1,
      item: { amount: 599000, currency: 'INR' },
      notes: { hookpost_key: buildPlanKey('STANDARD', 'YEARLY', 599000, 'INR') },
    });
  const putYearly = (extra: any = {}) =>
    putTrial('sub_year', {
      plan_id: YEARLY_PLAN,
      status: 'active',
      start_at: null,
      current_start: nowSec(),
      current_end: nowSec() + 365 * DAY,
      charge_at: nowSec() + 365 * DAY,
      paid_count: 1,
      // Stale on purpose: the plan decides the period, not the notes.
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'MONTHLY' },
      ...extra,
    });
  const yearlyCharge = {
    id: 'pay_5990',
    entity: 'payment',
    amount: 599000,
    currency: 'INR',
    status: 'captured',
    invoice_id: 'inv_y1',
  };
  const OFFERS = ['RAZORPAY_OFFER_FIRST_MONTH_UPI', 'RAZORPAY_OFFER_FIRST_MONTH_CARD'];
  afterEach(() => OFFERS.forEach((k) => delete process.env[k]));

  it('checkout reuses the yearly plan Razorpay holds: ten yearly cycles, the trial, no offer', async () => {
    putYearlyPlan();
    process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI = 'offer_UpiTest0000001';
    process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD = 'offer_CardTest000001';
    const { razorpay } = setup(null);

    const trial: any = await razorpay.subscribe(
      'ud-1',
      ORG,
      'user-1',
      { billing: 'STANDARD', period: 'YEARLY', payWith: 'upi' } as any,
      true
    );
    const paidNow: any = await razorpay.subscribe(
      'ud-1',
      ORG,
      'user-1',
      { billing: 'STANDARD', period: 'YEARLY', payWith: 'card' } as any,
      false
    );

    expect(calls.some((c) => c.method === 'POST' && c.path === '/plans')).toBe(false);
    expect(created()).toHaveLength(2);
    for (const c of created()) {
      expect(c.body).toMatchObject({
        plan_id: YEARLY_PLAN,
        total_count: 10,
        notes: { service: 'hookpost', billing: 'STANDARD', period: 'YEARLY', currency: 'INR' },
      });
      // The first-month offer is for monthly plans only.
      expect(c.body).not.toHaveProperty('offer_id');
    }
    expect(created()[0].body.start_at).toBeGreaterThan(nowSec());
    expect(created()[1].body.start_at).toBeUndefined();
    expect(trial.firstMonthOffer).toBeNull();
    expect(paidNow.firstMonthOffer).toBeNull();
  });

  it('the activation webhook stores YEARLY from the plan, renewing a year out', async () => {
    putYearlyPlan();
    const sub = putYearly();
    const { razorpay, subscriptions, row } = setup(null);

    await webhook(razorpay, 'subscription.activated', sub);
    await settle();

    expect(row()).toMatchObject({
      identifier: 'sub_year',
      subscriptionTier: 'STANDARD',
      period: 'YEARLY',
      cancelAt: null,
    });
    expect(subscriptions.createOrUpdateSubscription).toHaveBeenLastCalledWith(
      false,
      'sub_year',
      CUSTOMER,
      5,
      'STANDARD',
      'YEARLY',
      null,
      undefined,
      ORG
    );
  });

  it('a yearly charge: one Purchase of ₹5,990 and the affiliate’s 30%, ₹1,797', async () => {
    putYearlyPlan();
    const sub = putYearly();
    const { razorpay, track, commissions } = setup({
      identifier: 'sub_year',
      subscriptionTier: 'STANDARD',
      period: 'YEARLY',
    });

    await webhook(razorpay, 'subscription.charged', sub, yearlyCharge);
    await webhook(razorpay, 'subscription.charged', sub, yearlyCharge); // retry

    const purchases = tracked(track, TrackEnum.Purchase);
    expect(new Set(purchases.map((c: any[]) => c[0]))).toEqual(new Set(['purchase_pay_5990']));
    expect(purchases[0][4]).toEqual({ value: 5990, currency: 'INR' });
    expect(commissions).toHaveLength(1);
    expect(commissions[0]).toMatchObject({
      paymentId: 'pay_5990',
      amount: 599000,
      commission: 179700,
      currency: 'INR',
    });
  });

  it('cancelled mid-year: the plan is kept until the paid year ends', async () => {
    putYearlyPlan();
    const sub = putYearly();
    const { razorpay, row } = setup({
      identifier: 'sub_year',
      subscriptionTier: 'STANDARD',
      period: 'YEARLY',
    });
    const ended = { ...sub, status: 'cancelled', ended_at: nowSec() };
    subs.set('sub_year', ended);

    await webhook(razorpay, 'subscription.cancelled', ended);
    await settle();

    const keptUntil = new Date(row().cancelAt).getTime() / 1000;
    expect(Math.abs(keptUntil - sub.current_end)).toBeLessThan(5);
    expect(keptUntil - nowSec()).toBeGreaterThan(360 * DAY);
  });
});
