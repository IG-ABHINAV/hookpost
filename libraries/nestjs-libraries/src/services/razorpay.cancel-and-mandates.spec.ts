import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

// The billing page's Cancel, Reactivate, Change payment method, Invoices and
// "Pay today" preview, plus the subscription listing the plan-change cleanup
// depends on. Razorpay, Redis and the database are fakes that behave like the
// live API where it matters: no customer filter on /subscriptions, one cancel
// per subscription, no cycle-end cancel on a trial, and end_at populated ten
// years out on every subscription.

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
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

const ORG = 'org-chai';
const OTHER_ORG = 'org-other'; // same owner, same Razorpay customer
const CUSTOMER = 'cust_1';
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const invoices: any[] = [];
const payments = new Map<string, any>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
let clock = nowSec() - 400 * DAY;
const tick = () => (clock += 60);
let listingDown = false;
const unreadable = new Set<string>();
let orgTrialing = false;
/** Set to make PATCH /subscriptions/:id fail; it may apply the change first. */
let patchFault: null | ((sub: any, body: any) => never) = null;
/**
 * Whether a cycle-end cancel shows in end_at (end_at = current_end). Not
 * verified against the live API, so nothing that keeps a customer's
 * cancellation may depend on it: tests that care run with it off too.
 */
let cycleEndCancelShowsEndAt = true;

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base, query] = path.split('?');
  const q = new URLSearchParams(query || '');

  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return plan;
  }
  if (method === 'GET' && base === '/plans') return { items: [...plans.values()] };

  if (method === 'GET' && base === '/subscriptions') {
    if (listingDown) throw new Error(`Razorpay GET ${path} failed (500): down`);
    if (q.has('customer_id')) {
      throw new Error(
        `Razorpay GET ${path} failed (400): customer_id is/are not required and should not be sent`
      );
    }
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
      total_count: body.total_count,
      end_at: nowSec() + 3650 * DAY,
      notes: body.notes,
      short_url: 'https://rzp.io/i/checkout',
    };
    subs.set(sub.id, sub);
    return sub;
  }

  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const sub = subs.get(cancel[1]);
    if (!sub) throw new Error(`Razorpay POST ${path} failed (404): not found`);
    if (sub.cancelRequested || sub.status === 'cancelled') {
      throw new Error(
        `Razorpay POST ${path} failed (400): Subscription is already cancelled`
      );
    }
    if (body.cancel_at_cycle_end === 1) {
      if (sub.status !== 'active') {
        throw new Error(
          `Razorpay POST ${path} failed (400): Subscription cannot be cancelled since no billing cycle is going on`
        );
      }
      sub.cancelRequested = true;
      if (cycleEndCancelShowsEndAt) sub.end_at = sub.current_end;
      return sub;
    }
    sub.cancelRequested = true;
    sub.status = 'cancelled';
    sub.ended_at = nowSec();
    return sub;
  }

  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'GET') {
    if (unreadable.has(one[1])) throw new Error(`Razorpay GET ${path} failed (500): down`);
    const sub = subs.get(one[1]);
    if (!sub) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return sub;
  }
  if (one && method === 'PATCH') {
    const sub = subs.get(one[1]);
    if (patchFault) patchFault(sub, body);
    if (sub?.payment_method !== 'card') {
      throw new Error(
        `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is upi`
      );
    }
    Object.assign(sub, body);
    return sub;
  }

  if (method === 'GET' && base === '/invoices') {
    return {
      items: invoices.filter((i) =>
        q.has('subscription_id')
          ? i.subscription_id === q.get('subscription_id')
          : i.customer_id === q.get('customer_id')
      ),
    };
  }
  const pay = base.match(/^\/payments\/([^/]+)$/);
  if (method === 'GET' && pay) {
    const p = payments.get(pay[1]);
    if (!p) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return p;
  }

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

/** A paying Hookpost Standard subscription on a UPI mandate, mid-cycle. */
function putSub(id: string, extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'active',
    plan_id: 'plan_std_699',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    current_start: nowSec() - 5 * DAY,
    current_end: nowSec() + 25 * DAY,
    // Razorpay fills end_at on every subscription: where all cycles finish.
    end_at: nowSec() + 3650 * DAY,
    total_count: 120,
    notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD' },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

/** Fill the account with other products' subscriptions, newer than ours. */
function putForeign(n: number) {
  for (let i = 0; i < n; i++) {
    putSub(`sub_vet_${i}`, { customer_id: `cust_v${i}`, notes: { service: 'vetnow' } });
  }
}

function setup(row: any) {
  let stored: any = row ? { organizationId: ORG, cancelAt: null, isLifetime: false, period: 'MONTHLY', ...row } : null;
  const subscriptions = {
    getSubscription: jest.fn(async () => stored),
    // The once-per-person check at approval (trial switch on only).
    refuseTrialAtApproval: jest.fn(async () => false),
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      stored && stored.identifier === id ? stored : null
    ),
    createOrUpdateSubscription: jest.fn(
      async (
        _trialing: boolean,
        identifier: string,
        _customer: string,
        _channels: number,
        billing: string,
        period: string,
        cancelAt: number | null
      ) => {
        stored = {
          ...stored,
          organizationId: ORG,
          identifier,
          subscriptionTier: billing,
          period,
          cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        };
      }
    ),
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date) => {
      if (stored?.identifier === identifier) stored = { ...stored, cancelAt: at };
    }),
    updateCustomerId: jest.fn(async () => undefined),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    getLapsedCancellations: jest.fn(async (now: Date) =>
      stored?.cancelAt && stored.cancelAt.getTime() < now.getTime() ? [stored] : []
    ),
    redeemCouponByCode: jest.fn(async () => undefined),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: 'Chai Point Social',
      paymentId: CUSTOMER,
      isTrailing: orgTrialing,
    })),
    getTeam: jest.fn(async () => ({ users: [{ user: { id: 'user-1', email: 'priya@chaipoint.in' } }] })),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    { track: jest.fn(async () => undefined) } as any,
    { recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined), attributeByCoupon: jest.fn(async () => undefined) } as any
  );
  return { razorpay, subscriptions, row: () => stored };
}

const cancelCalls = () =>
  calls
    .filter((c) => c.method === 'POST' && /\/cancel$/.test(c.path))
    .map((c) => ({ id: c.path.split('/')[2], body: c.body }));
const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions');

const webhook = (razorpay: RazorpayService, event: string, sub: any) =>
  razorpay.handleWebhook({ event, payload: { subscription: { entity: sub } } });

beforeAll(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RAZORPAY_OFFER_ID;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
});

beforeEach(() => {
  plans.clear();
  subs.clear();
  invoices.length = 0;
  payments.clear();
  calls.length = 0;
  listingDown = false;
  unreadable.clear();
  orgTrialing = false;
  patchFault = null;
  cycleEndCancelShowsEndAt = true;
  mockRequest.mockClear();
  // The owner's real plan is a legacy Rs 699 Standard, not today's Rs 599.
  putPlan('plan_std_699', 'STANDARD', 69900);
  putPlan('plan_pro', 'PRO', 199900);
});

describe('getOrgSubscriptions()', () => {
  it('never sends customer_id, pages past 100, and keeps only this workspace’s Hookpost subscriptions', async () => {
    const mine = putSub('sub_mine');
    putSub('sub_other_org', { notes: { service: 'hookpost', orgId: OTHER_ORG } });
    putSub('sub_vet_same_customer', { notes: { service: 'vetnow', orgId: ORG } });
    putForeign(150); // pushes ours onto the second page
    const { razorpay } = setup({ identifier: 'sub_mine', subscriptionTier: 'STANDARD' });

    const res = await razorpay.getOrgSubscriptions(ORG);

    expect(res.items.map((s: any) => s.id)).toEqual([mine.id]);
    const listings = calls.filter((c) => c.path.startsWith('/subscriptions?'));
    expect(listings.map((c) => c.path)).toEqual([
      '/subscriptions?count=100&skip=0',
      '/subscriptions?count=100&skip=100',
    ]);
  });
});

describe('plan change: the old plan is retired once the new one is approved', () => {
  it('cancels the old plan even when it sits on the second page of the account', async () => {
    putSub('sub_std');
    putForeign(120);
    const pro = putSub('sub_pro', { status: 'authenticated', plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG, billing: 'PRO' } });
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.authenticated', pro);

    expect(cancelCalls()).toEqual([{ id: 'sub_std', body: { cancel_at_cycle_end: 0 } }]);
    expect(row()).toMatchObject({ identifier: 'sub_pro', subscriptionTier: 'PRO' });
  });

  it('cancels the plan the workspace was on even if the account listing fails', async () => {
    putSub('sub_std');
    const pro = putSub('sub_pro', { status: 'authenticated', plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG } });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    listingDown = true;

    await webhook(razorpay, 'subscription.authenticated', pro);

    expect(cancelCalls()).toEqual([{ id: 'sub_std', body: { cancel_at_cycle_end: 0 } }]);
  });

  it('never retires a subscription of another workspace or another product on the same customer', async () => {
    putSub('sub_std');
    putSub('sub_other_org', { notes: { service: 'hookpost', orgId: OTHER_ORG } });
    putSub('sub_vet', { notes: { service: 'vetnow', orgId: ORG } });
    const pro = putSub('sub_pro', { status: 'authenticated', plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG } });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    await webhook(razorpay, 'subscription.authenticated', pro);

    expect(cancelCalls().map((c) => c.id)).toEqual(['sub_std']);
  });

  it('a late renewal webhook for the old plan neither cancels the new plan nor takes the workspace back', async () => {
    const std = putSub('sub_std');
    putSub('sub_pro', { plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG } });
    // The workspace already moved to Pro; Standard's renewal webhook lands late.
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_pro', subscriptionTier: 'PRO' });

    await webhook(razorpay, 'subscription.charged', std);

    expect(subscriptions.createOrUpdateSubscription).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ identifier: 'sub_pro', subscriptionTier: 'PRO' });
    // The old plan should already have been cancelled; it is now.
    expect(cancelCalls()).toEqual([{ id: 'sub_std', body: { cancel_at_cycle_end: 0 } }]);
    expect(subs.get('sub_pro').status).toBe('active');
  });

  it('even when the new plan cannot be read, an old plan’s webhook never cancels the newer one', async () => {
    const std = putSub('sub_std');
    putSub('sub_pro', { plan_id: 'plan_pro', notes: { service: 'hookpost', orgId: ORG } });
    const { razorpay } = setup({ identifier: 'sub_pro', subscriptionTier: 'PRO' });
    unreadable.add('sub_pro');

    await webhook(razorpay, 'subscription.charged', std);

    expect(cancelCalls().map((c) => c.id)).not.toContain('sub_pro');
    expect(subs.get('sub_pro').status).toBe('active');
  });

  it('ignores an ended subscription that is not the workspace’s plan', async () => {
    const old = putSub('sub_old', { status: 'cancelled', ended_at: nowSec() });
    const { razorpay, subscriptions } = setup(null);

    await webhook(razorpay, 'subscription.updated', old);

    expect(subscriptions.createOrUpdateSubscription).not.toHaveBeenCalled();
  });
});

describe('cancelAtPeriodEnd(): the Cancel subscription button', () => {
  it('stops an active plan at Razorpay now and keeps the paid access here until current_end', async () => {
    const std = putSub('sub_std');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG);

    // end_at was populated (ten years out) and used to be read as "already
    // cancelled", which opened a new subscription and cancelled nothing.
    expect(created()).toEqual([]);
    // Never a cycle-end cancel: nothing on the subscription would prove it
    // registered, so the mandate goes now and this row holds the access.
    expect(cancelCalls()).toEqual([{ id: 'sub_std', body: { cancel_at_cycle_end: 0 } }]);
    expect(subs.get('sub_std')).toMatchObject({ status: 'cancelled' });
    expect(res).toMatchObject({ immediate: false, alreadyScheduled: false });
    expect(res.cancel_at?.getTime()).toBe(std.current_end * 1000);
    expect(row().cancelAt?.getTime()).toBe(std.current_end * 1000);
  });

  it('a second click reports the saved date and does not call Razorpay again', async () => {
    putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const first = await razorpay.cancelAtPeriodEnd(ORG);
    const second = await razorpay.cancelAtPeriodEnd(ORG);

    expect(cancelCalls()).toHaveLength(1);
    expect(second).toMatchObject({ alreadyScheduled: true });
    expect(second.cancel_at?.getTime()).toBe(first.cancel_at?.getTime());
  });

  it('a later webhook for the same subscription keeps the saved cancellation', async () => {
    const std = putSub('sub_std');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);

    // Razorpay's entity does not show the cancellation in end_at here.
    await webhook(razorpay, 'subscription.updated', { ...std, end_at: nowSec() + 3650 * DAY });

    expect(row().cancelAt?.getTime()).toBe(std.current_end * 1000);
  });

  it("the subscription.cancelled Razorpay sends straight back does not end the paid access early", async () => {
    const std = putSub('sub_std', { remaining_count: 118, paid_count: 2 });
    const { razorpay, row, subscriptions } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);
    const paidUntil = std.current_end * 1000;

    // The mandate really is gone, and `ended_at` is today -- weeks before the
    // customer's paid time runs out. Every later event for it carries that
    // date, and none of them may bring the plan's end forward.
    expect(subs.get('sub_std')).toMatchObject({ status: 'cancelled' });
    expect(row().cancelAt?.getTime()).toBe(paidUntil);

    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_std'));
    await webhook(razorpay, 'subscription.updated', subs.get('sub_std'));
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_std'));

    expect(row().cancelAt?.getTime()).toBe(paidUntil);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
  });

  it('a renewal that halted ends now when the customer revokes the mandate: an unpaid cycle is not paid time', async () => {
    // Break-it: the row's date is the halted-renewal grace
    // (scheduleHaltedRenewalEnd), not time anyone paid for. The customer then
    // revokes the mandate in their UPI app, and Razorpay's
    // subscription.cancelled must not be read as "keep the date on the row".
    const halted = putSub('sub_std', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
      total_count: 120,
      remaining_count: 117,
      paid_count: 2,
    });
    const { razorpay, subscriptions } = setup({
      identifier: 'sub_std',
      subscriptionTier: 'STANDARD',
      cancelAt: new Date((nowSec() + 5 * DAY) * 1000),
    });

    await webhook(razorpay, 'subscription.cancelled', {
      ...halted,
      status: 'cancelled',
      ended_at: nowSec(),
    });

    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('the sweep keeps a cancellation whose date has passed while Razorpay still shows the plan active, and ends it once Razorpay cancels it', async () => {
    // A row left by the old cycle-end cancel: a date on file, and a
    // subscription Razorpay still reports as active and renewing.
    const std = putSub('sub_std', { remaining_count: 118, paid_count: 2 });
    const { razorpay, subscriptions, row } = setup({
      identifier: 'sub_std',
      subscriptionTier: 'STANDARD',
      cancelAt: new Date(std.current_end * 1000),
    });
    const after = new Date((std.current_end + 3600) * 1000);

    // The date has passed and Razorpay has not flipped it to cancelled: the
    // date stays, so a lost subscription.cancelled cannot leave the plan on
    // for free.
    expect(await razorpay.endLapsedCancellations(after)).toEqual({ checked: 1, ended: 0 });
    expect(row()).toMatchObject({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    expect(row().cancelAt?.getTime()).toBe(std.current_end * 1000);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalledWith(ORG, 'sub_std', null);

    // Razorpay ends it; its webhook is lost, and the sweep ends the plan.
    Object.assign(subs.get('sub_std'), { status: 'cancelled', ended_at: std.current_end });
    expect(await razorpay.endLapsedCancellations(after)).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('stops a trial’s mandate now (Razorpay refuses a cycle-end cancel when no cycle is running), and the trial keeps working until its first charge was due', async () => {
    const trial = putSub('sub_trial', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      start_at: nowSec() + 5 * DAY,
    });
    const { razorpay, row, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG);

    expect(cancelCalls()).toEqual([{ id: 'sub_trial', body: { cancel_at_cycle_end: 0 } }]);
    expect(res.immediate).toBe(false);
    expect(res.cancel_at!.getTime()).toBe(trial.start_at * 1000);
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);

    // Razorpay's subscription.cancelled agrees, and nothing ends early.
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row().cancelAt.getTime()).toBe(trial.start_at * 1000);
  });

  it('also voids a stray unpaid checkout and a second plan left running, but nothing of another workspace', async () => {
    putSub('sub_std');
    putSub('sub_checkout', { status: 'created', plan_id: 'plan_pro' });
    putSub('sub_second', { plan_id: 'plan_pro' });
    putSub('sub_other_org', { status: 'created', notes: { service: 'hookpost', orgId: OTHER_ORG } });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    await razorpay.cancelAtPeriodEnd(ORG);

    // Every one of them stops now: a stray left to stop at the end of its
    // cycle would still be able to charge, with nothing on it to prove it
    // will not.
    expect(cancelCalls()).toEqual(
      expect.arrayContaining([
        { id: 'sub_std', body: { cancel_at_cycle_end: 0 } },
        { id: 'sub_checkout', body: { cancel_at_cycle_end: 0 } },
        { id: 'sub_second', body: { cancel_at_cycle_end: 0 } },
      ])
    );
    expect(cancelCalls().map((c) => c.id)).not.toContain('sub_other_org');
  });

  it('a refused cancel is an error with Razorpay’s reason, and nothing is saved', async () => {
    putSub('sub_std');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    const original = mockRequest.getMockImplementation()!;
    let refusedOnce = false;
    mockRequest.mockImplementation(async (method: string, path: string, body?: any) => {
      if (!refusedOnce && method === 'POST' && path === '/subscriptions/sub_std/cancel') {
        refusedOnce = true;
        throw new Error('Razorpay POST /subscriptions/sub_std/cancel failed (502): gateway timeout');
      }
      return original(method, path, body);
    });

    try {
      const attempt = razorpay.cancelAtPeriodEnd(ORG);
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow(/gateway timeout/);
    } finally {
      mockRequest.mockImplementation(original);
    }
    expect(row().cancelAt).toBeNull();
  });

  it('a plan already cancelled from the Razorpay dashboard is reported, not failed', async () => {
    putSub('sub_std', { cancelRequested: true });
    subs.get('sub_std').end_at = subs.get('sub_std').current_end;
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG);

    expect(res.alreadyScheduled).toBe(true);
    expect(res.cancel_at?.getTime()).toBe(subs.get('sub_std').current_end * 1000);
  });

  it('refuses a lifetime plan', async () => {
    const { razorpay } = setup({ identifier: 'CODE-123', isLifetime: true, subscriptionTier: 'PRO' });
    await expect(razorpay.cancelAtPeriodEnd(ORG)).rejects.toThrow(/lifetime/);
  });
});

describe('startReplacementMandate(): Reactivate and Change payment method', () => {
  it('reactivate: same plan, first charge when the paid period ends, old plan untouched until approval', async () => {
    const std = putSub('sub_std');
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);
    calls.length = 0;

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate');

    expect(created()).toHaveLength(1);
    expect(created()[0].body).toMatchObject({
      plan_id: 'plan_std_699', // the Rs 699 plan it is on, not today's Rs 599
      customer_id: CUSTOMER,
      start_at: std.current_end,
      notes: { service: 'hookpost', orgId: ORG, replaces: 'sub_std', reason: 'reactivate' },
    });
    expect(res).toMatchObject({ amount: 699, chargeToday: 0, currency: 'INR', billing: 'STANDARD', keyId: 'rzp_test_key' });
    expect(res.startAt?.getTime()).toBe(std.current_end * 1000);
    expect(cancelCalls()).toEqual([]);

    // The customer approves it: the workspace moves onto it, it is not a
    // trial, and the cancellation is gone.
    const replacement = subs.get(res.subscriptionId);
    replacement.status = 'authenticated';
    await webhook(razorpay, 'subscription.authenticated', replacement);

    expect(subscriptions.createOrUpdateSubscription).toHaveBeenLastCalledWith(
      false,
      res.subscriptionId,
      CUSTOMER,
      expect.any(Number),
      'STANDARD',
      'MONTHLY',
      null,
      undefined,
      ORG
    );
    expect(row()).toMatchObject({ identifier: res.subscriptionId, cancelAt: null });
  });

  it('change payment method on an active plan: nothing today, old mandate retired only after approval', async () => {
    const std = putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    expect(res.chargeToday).toBe(0);
    expect(created()[0].body.start_at).toBe(std.current_end);
    expect(cancelCalls()).toEqual([]);

    const replacement = subs.get(res.subscriptionId);
    replacement.status = 'authenticated';
    await webhook(razorpay, 'subscription.authenticated', replacement);

    expect(cancelCalls()).toEqual([{ id: 'sub_std', body: { cancel_at_cycle_end: 0 } }]);
  });

  it('change payment method after a failed renewal: charged on approval, since that period was never paid', async () => {
    putSub('sub_std', { status: 'pending' });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');

    expect(created()[0].body.start_at).toBeUndefined();
    expect(res).toMatchObject({ chargeToday: 699, startAt: null, unpaid: true });
  });

  it.each([
    ['its renewal is minutes away', { current_end: nowSec() + 5 * 60, charge_at: nowSec() + 5 * 60 }, /next payment is being taken/],
    ['its renewal debit is still processing', { current_end: nowSec() - 60, charge_at: nowSec() - 60 }, /next payment is being taken/],
    [
      'its trial ends in minutes',
      { status: 'authenticated', current_start: null, current_end: null, start_at: nowSec() + 5 * 60 },
      /trial is ending/,
    ],
  ])('change payment method is refused while %s: charging on approval would bill that period twice', async (_label, extra, says) => {
    putSub('sub_std', extra);
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const err = await razorpay
      .startReplacementMandate(ORG, 'user-1', 'payment_method')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(says);
    expect(created()).toEqual([]);
  });

  it('reactivate in the last minutes of a plan set to end: says it is ending, not that a payment is being taken', async () => {
    putSub('sub_std', { current_end: nowSec() + 5 * 60, charge_at: nowSec() + 5 * 60 });
    const { razorpay } = setup({
      identifier: 'sub_std',
      subscriptionTier: 'STANDARD',
      cancelAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const err = await razorpay
      .startReplacementMandate(ORG, 'user-1', 'reactivate')
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/ends in a few minutes/);
    expect(err.message).not.toMatch(/payment is being taken/);
    expect(created()).toEqual([]);
  });

  it('reactivate in a cancelled plan’s last minutes: charged on approval, and not called an unpaid renewal', async () => {
    putSub('sub_std', { status: 'cancelled', ended_at: nowSec(), current_end: nowSec() + 5 * 60 });
    const { razorpay } = setup({
      identifier: 'sub_std',
      subscriptionTier: 'STANDARD',
      cancelAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate');

    expect(created()[0].body.start_at).toBeUndefined();
    expect(res).toMatchObject({ chargeToday: 699, startAt: null, unpaid: false });
  });

  it('reactivate refuses a plan that is not set to end', async () => {
    putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    await expect(
      razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate')
    ).rejects.toThrow(/not set to end/);
    expect(created()).toEqual([]);
  });

  it('refuses a plan that has already ended', async () => {
    putSub('sub_std', { status: 'cancelled', ended_at: nowSec() - DAY, current_end: nowSec() - DAY });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD', cancelAt: new Date(Date.now() - DAY * 1000) });

    await expect(
      razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate')
    ).rejects.toThrow(/already ended/);
  });
});

describe('quoteReplacementMandate(): the terms before anything is created', () => {
  const writes = () => calls.filter((c) => c.method !== 'GET');
  const termsOf = (res: any) => ({
    currency: res.currency,
    billing: res.billing,
    period: res.period,
    amount: res.amount,
    startAt: res.startAt,
    chargeToday: res.chargeToday,
    unpaid: res.unpaid,
  });

  it('reactivate: the same terms the create then gives, from reads only', async () => {
    const std = putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);
    calls.length = 0;

    const quote = await razorpay.quoteReplacementMandate(ORG, 'reactivate');

    expect(writes()).toEqual([]);
    expect(quote).toEqual({
      currency: 'INR',
      billing: 'STANDARD',
      period: 'MONTHLY',
      amount: 699,
      startAt: new Date(std.current_end * 1000),
      chargeToday: 0,
      unpaid: false,
    });
    expect(quote).not.toHaveProperty('subscriptionId');

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate');
    expect(created()).toHaveLength(1);
    expect(termsOf(res)).toEqual(quote);
  });

  it('change payment method after a failed renewal: quoted as charged on approval, unpaid', async () => {
    putSub('sub_std', { status: 'pending' });
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const quote = await razorpay.quoteReplacementMandate(ORG, 'payment_method');

    expect(writes()).toEqual([]);
    expect(quote).toMatchObject({ amount: 699, startAt: null, chargeToday: 699, unpaid: true });
  });

  it('a trial: quoted with its first charge at the trial end', async () => {
    const trial = putSub('sub_trial', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      start_at: nowSec() + 5 * DAY,
    });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const quote = await razorpay.quoteReplacementMandate(ORG, 'payment_method');

    expect(quote.startAt?.getTime()).toBe(trial.start_at * 1000);
    expect(quote.chargeToday).toBe(0);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['a plan that is not set to end (reactivate)', 'reactivate', {}, null, /not set to end/],
    ['a renewal being taken now', 'payment_method', { current_end: nowSec() + 5 * 60, charge_at: nowSec() + 5 * 60 }, null, /next payment is being taken/],
    ['a plan that has already ended', 'reactivate', { status: 'cancelled', ended_at: nowSec() - DAY, current_end: nowSec() - DAY }, new Date(Date.now() - DAY * 1000), /already ended/],
  ])('refuses %s exactly as the create would, and writes nothing', async (_label, reason, extra, cancelAt, says) => {
    putSub('sub_std', extra);
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD', cancelAt });

    await expect(
      razorpay.quoteReplacementMandate(ORG, reason as any)
    ).rejects.toThrow(says);
    await expect(
      razorpay.startReplacementMandate(ORG, 'user-1', reason as any)
    ).rejects.toThrow(says);
    expect(writes()).toEqual([]);
  });

  it('no Razorpay plan to update: refused', async () => {
    const { razorpay } = setup({ identifier: 'CODE-123', isLifetime: true, subscriptionTier: 'PRO' });
    await expect(
      razorpay.quoteReplacementMandate(ORG, 'payment_method')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });
});

describe('discardReplacementMandate(): a mandate turned down before checkout', () => {
  async function openReplacement() {
    putSub('sub_std');
    const ctx = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    const res = await ctx.razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    calls.length = 0;
    return { ...ctx, res };
  }

  it('cancels the unapproved replacement now, and nothing else', async () => {
    const { razorpay, res } = await openReplacement();

    await expect(
      razorpay.discardReplacementMandate(ORG, res.subscriptionId)
    ).resolves.toEqual({ discarded: true });

    expect(cancelCalls()).toEqual([
      { id: res.subscriptionId, body: { cancel_at_cycle_end: 0 } },
    ]);
    expect(subs.get('sub_std').status).toBe('active');
  });

  it('leaves one the customer has already approved', async () => {
    const { razorpay, res } = await openReplacement();
    subs.get(res.subscriptionId).status = 'authenticated';

    await expect(
      razorpay.discardReplacementMandate(ORG, res.subscriptionId)
    ).resolves.toEqual({ discarded: false });
    expect(cancelCalls()).toEqual([]);
  });

  it('leaves another workspace’s, an ordinary checkout, and the workspace’s own plan', async () => {
    const { razorpay } = await openReplacement();
    putSub('sub_other', { status: 'created', notes: { service: 'hookpost', orgId: OTHER_ORG, replaces: 'sub_x' } });
    putSub('sub_checkout', { status: 'created', notes: { service: 'hookpost', orgId: ORG } });

    for (const id of ['sub_other', 'sub_checkout', 'sub_std', 'sub_missing']) {
      await expect(razorpay.discardReplacementMandate(ORG, id)).resolves.toEqual({
        discarded: false,
      });
    }
    expect(cancelCalls()).toEqual([]);
  });

  it('refuses an id that is not a Razorpay subscription id', async () => {
    const { razorpay } = await openReplacement();
    await expect(
      razorpay.discardReplacementMandate(ORG, '../plans/plan_std_699')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });
});

describe('Change payment method during a free trial', () => {
  const putTrial = () =>
    putSub('sub_trial', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      start_at: nowSec() + 5 * DAY,
    });

  async function changeAndApprove(razorpay: RazorpayService) {
    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    const replacement = subs.get(res.subscriptionId);
    Object.assign(replacement, { status: 'authenticated', current_start: null, current_end: null });
    await webhook(razorpay, 'subscription.authenticated', replacement);
    return { res, replacement };
  }

  it('the new mandate is still the trial: first charge at the trial end, workspace still trialing', async () => {
    const trial = putTrial();
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const { res } = await changeAndApprove(razorpay);

    expect(created()[0].body).toMatchObject({
      start_at: trial.start_at,
      notes: { replaces: 'sub_trial', trial: '1' },
    });
    expect(res).toMatchObject({ chargeToday: 0, unpaid: false });
    expect(row().identifier).toBe(res.subscriptionId);
    expect(subscriptions.createOrUpdateSubscription).toHaveBeenLastCalledWith(
      true, // still on trial
      res.subscriptionId,
      CUSTOMER,
      expect.any(Number),
      'STANDARD',
      'MONTHLY',
      null,
      undefined,
      ORG
    );

    // A second change keeps it a trial.
    calls.length = 0;
    await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    expect(created()[0].body.notes).toMatchObject({ replaces: res.subscriptionId, trial: '1' });
  });

  it('another plan’s preview calls it a trial with nothing paid, and Cancel keeps it to the trial’s end, never charging', async () => {
    const trial = putTrial();
    const { razorpay, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    const { res } = await changeAndApprove(razorpay);

    const preview: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(preview).toMatchObject({ currentIsTrial: true, currentIsPaid: false });

    const cancel = await razorpay.cancelAtPeriodEnd(ORG);
    expect(cancel.immediate).toBe(false);
    expect(cancel.cancel_at!.getTime()).toBe(trial.start_at * 1000);
    await webhook(razorpay, 'subscription.cancelled', subs.get(res.subscriptionId));
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();

    // The hourly sweep ends it once the date has passed, and not before.
    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 0, ended: 0 });
    expect(
      await razorpay.endLapsedCancellations(new Date((trial.start_at + 3600) * 1000))
    ).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('Finish the trial still applies to it', async () => {
    putTrial();
    orgTrialing = true;
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    const { replacement } = await changeAndApprove(razorpay);
    replacement.payment_method = 'card';
    calls.length = 0;

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: true });
    expect(calls.some((c) => c.method === 'PATCH' && c.path === `/subscriptions/${replacement.id}`)).toBe(true);
  });
});

describe('listInvoices(): the Invoices list', () => {
  const invoice = (id: string, subId: string | null, extra: any = {}) =>
    invoices.push({
      id,
      entity: 'invoice',
      customer_id: CUSTOMER,
      subscription_id: subId,
      status: 'paid',
      amount: 69900,
      currency: 'INR',
      issued_at: nowSec() - 30 * DAY,
      paid_at: nowSec() - 30 * DAY,
      billing_start: nowSec() - 30 * DAY,
      billing_end: nowSec(),
      short_url: `https://rzp.io/i/${id}`,
      ...extra,
    });

  it('lists this workspace’s paid and due invoices, newest first, in rupees', async () => {
    putSub('sub_std', { status: 'pending' });
    putSub('sub_abandoned', { status: 'created', plan_id: 'plan_pro' });
    putSub('sub_vet', { notes: { service: 'vetnow' } });
    putSub('sub_other_org', { notes: { service: 'hookpost', orgId: OTHER_ORG } });
    invoice('inv_sep', 'sub_std', { paid_at: nowSec() - 30 * DAY });
    invoice('inv_oct_due', 'sub_std', { status: 'issued', paid_at: null, issued_at: nowSec() - DAY });
    invoice('inv_checkout', 'sub_abandoned', { status: 'issued', amount: 199900, paid_at: null });
    invoice('inv_vet', 'sub_vet');
    invoice('inv_other_org', 'sub_other_org');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const list = await razorpay.listInvoices(ORG);

    expect(list.map((i) => i.id)).toEqual(['inv_oct_due', 'inv_sep']);
    expect(list[1]).toMatchObject({
      amount: 699,
      currency: 'INR',
      status: 'paid',
      url: 'https://rzp.io/i/inv_sep',
      billing: 'STANDARD',
      period: 'MONTHLY',
    });
    expect(calls.some((c) => c.path.startsWith('/invoices?customer_id=cust_1'))).toBe(true);
  });

  it('turns a Razorpay outage into a clear error instead of an empty list', async () => {
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    mockRequest.mockImplementationOnce(async () => {
      throw new Error('Razorpay GET /invoices failed (500): down');
    });
    await expect(razorpay.listInvoices(ORG)).rejects.toThrow(/could not load your invoices/);
  });
});

describe('prorate(): the "Pay today" line on another plan', () => {
  it('UPI: the full new price today, a new cycle from today, and the current plan named', async () => {
    putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);

    // It used to say Rs 1414 (1999 minus unused Standard days at list
    // price), which nothing ever charged.
    expect(res).toMatchObject({
      mode: 'new_mandate',
      price: 1999,
      chargeToday: 1999,
      recurring: 1999,
      currency: 'INR',
      currentTier: 'STANDARD',
      currentStatus: 'active',
    });
    const days = (res.nextChargeAt.getTime() - Date.now()) / (DAY * 1000);
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('after Change payment method the plan is reported as paid, not as a trial', async () => {
    putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    const mandate = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    const replacement = subs.get(mandate.subscriptionId);
    Object.assign(replacement, { status: 'authenticated', current_end: null });
    await webhook(razorpay, 'subscription.authenticated', replacement);

    const res: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);

    expect(res).toMatchObject({
      currentTier: 'STANDARD',
      currentStatus: 'authenticated',
      currentIsTrial: false,
      currentIsPaid: true,
    });
  });

  it('a trial is reported as a trial with nothing paid', async () => {
    putSub('sub_trial', { status: 'authenticated', current_start: null, current_end: null, start_at: nowSec() + 5 * DAY });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);

    expect(res).toMatchObject({ currentIsTrial: true, currentIsPaid: false });
  });

  /** The card payment behind sub_std, international or Indian. */
  const cardPayment = (international: boolean) => {
    payments.set('pay_std', { id: 'pay_std', method: 'card', international });
    invoices.push({ id: 'inv_std', subscription_id: 'sub_std', customer_id: CUSTOMER, payment_id: 'pay_std' });
  };

  it("international card: switched in place, quotes Razorpay's own prorated amount, renews on the current date", async () => {
    const std = putSub('sub_std', { payment_method: 'card' });
    cardPayment(true);
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);

    // Day 6 of a 30-day cycle on the Rs 699 plan: 25 days left.
    // (1999 - 699) x 25 / 30 = Rs 1,083.33 (Razorpay's proration, inPlaceChangeMinor).
    expect(res).toMatchObject({ mode: 'in_place', chargeToday: 1083.33, creditApplied: 582.5, recurring: 1999 });
    expect(res.nextChargeAt.getTime()).toBe(std.current_end * 1000);
  });

  it('Indian card: a new mandate like UPI, since Razorpay updates only the offer of a domestic card', async () => {
    putSub('sub_std', { payment_method: 'card' });
    cardPayment(false);
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res: any = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    expect(res.mode).toBe('new_mandate');
  });
});

describe('finishTrial()', () => {
  it('brings a trial’s first charge forward, found by the stored identifier', async () => {
    putSub('sub_trial', { status: 'authenticated', payment_method: 'card', start_at: nowSec() + 5 * DAY });
    orgTrialing = true;
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: true });
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/subscriptions/sub_trial')).toBe(true);
  });

  it('a UPI trial: Razorpay refuses to move the charge, so the trial goes on and its first charge date is returned', async () => {
    const trial = putSub('sub_trial', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      start_at: nowSec() + 5 * DAY,
    });
    orgTrialing = true;
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res = await razorpay.finishTrial(ORG);

    expect(res.ok).toBe(false);
    expect(res.startAt?.getTime()).toBe(trial.start_at * 1000);
    expect(subs.get('sub_trial').start_at).toBe(trial.start_at);
  });

  const cardTrial = () =>
    putSub('sub_trial', {
      status: 'authenticated',
      payment_method: 'card',
      current_start: null,
      current_end: null,
      start_at: nowSec() + 5 * DAY,
    });

  it('the connection drops after Razorpay applied the change: read back, it went through', async () => {
    cardTrial();
    orgTrialing = true;
    patchFault = (sub, body) => {
      Object.assign(sub, body);
      throw new TypeError('fetch failed');
    };
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: true });
    expect(calls.some((c) => c.method === 'GET' && c.path === '/subscriptions/sub_trial')).toBe(true);
  });

  it('a Razorpay 5xx with the trial unchanged is unknown, never "nothing was charged" with a first charge date', async () => {
    const trial = cardTrial();
    orgTrialing = true;
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_trial failed (502): Bad Gateway');
    };
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res = await razorpay.finishTrial(ORG);

    expect(res).toEqual({ ok: false, unknown: true });
    expect(res.startAt).toBeUndefined();
    expect(subs.get('sub_trial').start_at).toBe(trial.start_at);
  });

  it('a timeout and the subscription unreadable afterwards is unknown too', async () => {
    cardTrial();
    orgTrialing = true;
    patchFault = () => {
      unreadable.add('sub_trial');
      throw new Error('The operation was aborted due to timeout');
    };
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: false, unknown: true });
  });

  it('leaves a plan that is already charging alone', async () => {
    putSub('sub_std');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: false });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('does nothing for a workspace that is not on a trial', async () => {
    putSub('sub_auth', { status: 'authenticated', payment_method: 'card' });
    const { razorpay } = setup({ identifier: 'sub_auth', subscriptionTier: 'STANDARD' });

    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: false });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('never brings forward the first charge of a Change payment method mandate: that period is already paid', async () => {
    const std = putSub('sub_std', { payment_method: 'card' });
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    const replacement = subs.get(res.subscriptionId);
    Object.assign(replacement, { status: 'authenticated', payment_method: 'card', current_end: null });
    await webhook(razorpay, 'subscription.authenticated', replacement);
    expect(row().identifier).toBe(res.subscriptionId);
    calls.length = 0;

    // /billing?finishTrial=true opened on this workspace, even with a stale
    // trial flag on the org.
    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: false });
    orgTrialing = true;
    expect(await razorpay.finishTrial(ORG)).toEqual({ ok: false });

    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(replacement.start_at).toBe(std.current_end);
  });
});

describe('Cancel after Reactivate or Change payment method keeps the time already paid for', () => {
  // After either flow the workspace runs on the replacement mandate: it is
  // `authenticated` with start_at on the old plan's current_end and no
  // current_end of its own until that first charge.
  async function approve(razorpay: RazorpayService, subscriptionId: string) {
    const replacement = subs.get(subscriptionId);
    Object.assign(replacement, { status: 'authenticated', current_start: null, current_end: null });
    await webhook(razorpay, 'subscription.authenticated', replacement);
    return replacement;
  }

  async function cancelAndExpectPaidTimeKept(
    razorpay: RazorpayService,
    subscriptions: any,
    row: () => any,
    replacementId: string,
    paidUntil: number
  ) {
    calls.length = 0;
    const res = await razorpay.cancelAtPeriodEnd(ORG);

    // Razorpay refuses a cycle-end cancel on an `authenticated` mandate, so
    // the mandate stops now, but the plan runs to the paid end.
    expect(cancelCalls()).toEqual([{ id: replacementId, body: { cancel_at_cycle_end: 0 } }]);
    expect(res).toMatchObject({ immediate: false, alreadyScheduled: false });
    expect(res.cancel_at?.getTime()).toBe(paidUntil * 1000);
    expect(row()).toMatchObject({ identifier: replacementId, subscriptionTier: 'STANDARD' });
    expect(row().cancelAt?.getTime()).toBe(paidUntil * 1000);

    // Razorpay's subscription.cancelled for the mandate: no current_end.
    const cancelled = subs.get(replacementId);
    expect(cancelled).toMatchObject({ status: 'cancelled', current_end: null });
    await webhook(razorpay, 'subscription.cancelled', cancelled);

    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ identifier: replacementId, subscriptionTier: 'STANDARD' });
    expect(row().cancelAt?.getTime()).toBe(paidUntil * 1000);

    // The hourly sweep leaves it alone until the paid end, then ends it.
    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 0, ended: 0 });
    expect(
      await razorpay.endLapsedCancellations(new Date((paidUntil - DAY) * 1000))
    ).toEqual({ checked: 0, ended: 0 });
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(
      await razorpay.endLapsedCancellations(new Date((paidUntil + DAY) * 1000))
    ).toEqual({ checked: 1, ended: 1 });
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  }

  it('Change payment method, approve, Cancel: Standard stays until the old current_end', async () => {
    const std = putSub('sub_std'); // paid until current_end, 25 days out
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    await approve(razorpay, res.subscriptionId);
    expect(row().identifier).toBe(res.subscriptionId);
    expect(subs.get('sub_std').status).toBe('cancelled'); // old mandate retired

    await cancelAndExpectPaidTimeKept(razorpay, subscriptions, row, res.subscriptionId, std.current_end);
  });

  it('Reactivate, approve, Cancel again: Standard stays until the old current_end', async () => {
    const std = putSub('sub_std');
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG);

    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'reactivate');
    await approve(razorpay, res.subscriptionId);
    expect(row()).toMatchObject({ identifier: res.subscriptionId, cancelAt: null });

    await cancelAndExpectPaidTimeKept(razorpay, subscriptions, row, res.subscriptionId, std.current_end);
  });

  it('the sweep keeps a cancelled replacement until its start_at even when the row’s date is earlier', async () => {
    const std = putSub('sub_std');
    const { razorpay, subscriptions, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    const res = await razorpay.startReplacementMandate(ORG, 'user-1', 'payment_method');
    const replacement = await approve(razorpay, res.subscriptionId);
    // Cancelled outside the Cancel button, with a date on the row that has
    // already passed (a click saved before this fix, say).
    Object.assign(replacement, { status: 'cancelled', ended_at: nowSec() });
    await subscriptions.scheduleCancellation(ORG, res.subscriptionId, new Date(Date.now() - 60_000));

    expect(await razorpay.endLapsedCancellations(new Date())).toEqual({ checked: 1, ended: 0 });
    expect(row()).toMatchObject({ identifier: res.subscriptionId });
    expect(
      await razorpay.endLapsedCancellations(new Date((std.current_end + DAY) * 1000))
    ).toEqual({ checked: 1, ended: 1 });
  });

  it('a trial runs to its first charge date, not further: nothing was paid for', async () => {
    const trial = putSub('sub_trial', { status: 'authenticated', current_start: null, current_end: null, start_at: nowSec() + 5 * DAY });
    const { razorpay, subscriptions } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG);
    expect(res.immediate).toBe(false);
    expect(res.cancel_at!.getTime()).toBe(trial.start_at * 1000);
    await webhook(razorpay, 'subscription.cancelled', subs.get('sub_trial'));
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(
      await razorpay.endLapsedCancellations(new Date((trial.start_at + 120) * 1000))
    ).toEqual({ checked: 1, ended: 1 });
  });
});
