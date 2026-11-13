import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';

/**
 * The pre-charge guard (RazorpayService.reconcileBilling): the database and
 * Razorpay must never disagree about whether a customer will be charged.
 *
 * Razorpay, Redis and the database are fakes that behave like the live API
 * where it matters: a cycle-end cancel leaves the subscription looking exactly
 * like one that will renew (no field records it, verified live on
 * sub_TXvoILk8Rch2Wo on 29 Oct 2026), the listing takes no customer filter,
 * Razorpay takes one cancel per subscription, and it refuses a cycle-end
 * cancel when no billing cycle is running.
 *
 * What must never happen here is cancelling a customer who is paying, so the
 * cases that prove the guard stands back matter as much as the ones that
 * prove it acts.
 */

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

/** Redis, with the claim keys the guard and the emails set. */
const redis = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
    get: jest.fn(async (key: string) => redis.get(key) ?? null),
    sadd: jest.fn(async (key: string, member: string) => {
      const set = new Set<string>(JSON.parse(redis.get(key) || '[]'));
      set.add(member);
      redis.set(key, JSON.stringify([...set]));
      return 1;
    }),
    srem: jest.fn(async (key: string, member: string) => {
      const set = new Set<string>(JSON.parse(redis.get(key) || '[]'));
      set.delete(member);
      redis.set(key, JSON.stringify([...set]));
      return 1;
    }),
    smembers: jest.fn(async (key: string) => JSON.parse(redis.get(key) || '[]')),
    eval: jest.fn(async (_script: string, _n: number, key: string, token: string) => {
      if (redis.get(key) === token) redis.delete(key);
      return 1;
    }),
  },
  // RefundsService refuses to refund on the in-memory stand-in; this fake
  // keeps NX and expiry semantics, so it counts as real Redis here.
  ioRedisIsMock: false,
}));

/** Customer emails the service sends through Resend. */
const sentEmails: any[] = [];
const mockResendSend = jest.fn(async (msg: any) => {
  sentEmails.push(msg);
  return { data: { id: `email_${sentEmails.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockResendSend } })),
}));

const ORG = 'org-chai';
const DAY = 86400;
const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
let created = nowSec() - 400 * DAY;
const tick = () => (created += 60);
/** Subscription ids Razorpay will not return (a 500 on GET). */
const unreadable = new Set<string>();
/** Subscription ids whose cancel Razorpay refuses. */
const cancelRefused = new Set<string>();
/** Subscription ids with a refunded charge on them. */
const refunded = new Set<string>();
/** Workspaces the database says were deleted, and ones it no longer holds. */
const deletedOrgs = new Set<string>();
const missingOrgs = new Set<string>();
/** The database will not say whether the workspace exists. */
let orgReadFails = false;
let listingDown = false;
/** Real-looking payments (pay_ + 14 chars), invoices and refunds. */
const payments = new Map<string, any>();
const invoicesById = new Map<string, any>();
const refundsMade: any[] = [];
/** Payment ids whose refund Razorpay refuses (400) or answers with a 500. */
const refundRefused = new Set<string>();
const refundTimesOut = new Set<string>();

/** Chargebacks GET /disputes lists. */
const disputes: any[] = [];
const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base, query] = path.split('?');
  const q = new URLSearchParams(query || '');

  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return plan;
  }

  // The chargebacks on this account (RefundsService.disputeOn reads them).
  if (method === 'GET' && base === '/disputes') {
    return { entity: 'collection', count: disputes.length, items: disputes };
  }

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

  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const sub = subs.get(cancel[1]);
    if (!sub) throw new Error(`Razorpay POST ${path} failed (404): not found`);
    if (cancelRefused.has(cancel[1])) {
      throw new Error(`Razorpay POST ${path} failed (500): down`);
    }
    if (sub.status === 'cancelled') {
      throw new Error(
        `Razorpay POST ${path} failed (400): Subscription is not cancellable in cancelled status.`
      );
    }
    if (body.cancel_at_cycle_end === 1) {
      if (sub.status !== 'active') {
        throw new Error(
          `Razorpay POST ${path} failed (400): Subscription cannot be cancelled since no billing cycle is going on`
        );
      }
      // Live behaviour: nothing on the entity changes, so nothing proves it.
      sub.cycleEndCancelRequested = true;
      return sub;
    }
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

  const inv = base.match(/^\/invoices\/([^/]+)$/);
  if (method === 'GET' && inv) {
    const found = invoicesById.get(inv[1]);
    if (!found) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return found;
  }
  const refundOf = base.match(/^\/payments\/([^/]+)\/refund$/);
  if (method === 'POST' && refundOf) {
    const p = payments.get(refundOf[1]);
    if (!p) throw new Error(`Razorpay POST ${path} failed (404): not found`);
    if (refundRefused.has(p.id)) throw new Error(`Razorpay POST ${path} failed (400): refund not allowed`);
    if (refundTimesOut.has(p.id)) throw new Error(`Razorpay POST ${path} failed (504): timeout`);
    const left = p.amount - (p.amount_refunded || 0);
    if (body.amount > left) throw new Error(`Razorpay POST ${path} failed (400): amount too high`);
    const refund = { id: `rfnd_${refundsMade.length + 1}`, entity: 'refund', amount: body.amount, currency: p.currency, payment_id: p.id, notes: body.notes, status: 'processed', created_at: nowSec() };
    refundsMade.push(refund);
    p.amount_refunded = (p.amount_refunded || 0) + body.amount;
    if (p.amount_refunded >= p.amount) p.status = 'refunded';
    return refund;
  }
  const realPay = base.match(/^\/payments\/(pay_[A-Za-z0-9]{14})$/);
  if (method === 'GET' && realPay && payments.has(realPay[1])) {
    return { ...payments.get(realPay[1]) };
  }

  if (method === 'GET' && base === '/invoices') {
    const subId = q.get('subscription_id') || '';
    const real = [...invoicesById.values()].filter((i) => i.subscription_id === subId);
    if (real.length) return { items: real };
    return { items: subs.has(subId) ? [{ payment_id: `pay_${subId}` }] : [] };
  }

  const payment = base.match(/^\/payments\/pay_(.+)$/);
  if (method === 'GET' && payment) {
    const refund = refunded.has(payment[1]);
    return {
      id: `pay_${payment[1]}`,
      amount: 69900,
      status: refund ? 'refunded' : 'captured',
      captured: true,
      amount_refunded: refund ? 69300 : 0,
    };
  }

  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

/** A paying Hookpost subscription on a UPI mandate, mid-cycle. */
function putSub(id: string, extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'active',
    plan_id: 'plan_std_699',
    customer_id: 'cust_1',
    payment_method: 'upi',
    current_start: nowSec() - 5 * DAY,
    current_end: nowSec() + 25 * DAY,
    charge_at: nowSec() + 25 * DAY,
    // Razorpay fills end_at on every subscription: where all cycles finish.
    end_at: nowSec() + 3650 * DAY,
    total_count: 120,
    remaining_count: 118,
    paid_count: 2,
    notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD' },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

/** One plan row as the database holds it. */
function putRow(identifier: string, extra: any = {}) {
  return {
    organizationId: ORG,
    identifier,
    cancelAt: null,
    isLifetime: false,
    subscriptionTier: 'STANDARD',
    period: 'MONTHLY',
    ...extra,
  };
}

function setup(rows: any[]) {
  const store = [...rows];
  const subscriptions = {
    getRazorpayPlanRows: jest.fn(async () => store),
    getSubscription: jest.fn(async () => store[0] || null),
    getSubscriptionByIdentifier: jest.fn(
      async (id: string) => store.find((r) => r.identifier === id) || null
    ),
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date | null) => {
      const row = store.find((r) => r.identifier === identifier);
      if (row) row.cancelAt = at;
    }),
    deleteSubscriptionByOrg: jest.fn(async () => undefined),
    createOrUpdateSubscription: jest.fn(
      async (_t: boolean, identifier: string, _c: string, _n: number, billing: string, period: string, cancelAt: number | null) => {
        const row = store.find((r) => r.identifier === identifier);
        if (row) Object.assign(row, { subscriptionTier: billing, period, cancelAt: cancelAt ? new Date(cancelAt * 1000) : null });
      }
    ),
    updateCustomerId: jest.fn(async () => undefined),
    redeemCouponByCode: jest.fn(async () => undefined),
    getLapsedCancellations: jest.fn(async () => []),
    getPolicyOrg: jest.fn(async () => ({ platformAdmin: false })),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => {
      if (orgReadFails) throw new Error('the database is down');
      return missingOrgs.has(id)
        ? null
        : {
            id,
            name: 'Chai Point Social',
            deletedAt: deletedOrgs.has(id) ? new Date() : null,
          };
    }),
    getTeam: jest.fn(async () => ({
      users: [{ user: { id: 'user-1', email: 'priya@chaipoint.in' } }],
    })),
  };
  const ownerAlerts = {
    notify: jest.fn(async () => 'sent' as const),
    mark: jest.fn(async () => undefined),
    unmark: jest.fn(async () => undefined),
    isMarked: jest.fn(async () => false),
  };
  const audits: any[] = [];
  const refundsRepo = {
    createAudit: jest.fn(async (data: any) => {
      const row = { id: `audit_${audits.length + 1}`, ...data };
      audits.push(row);
      return row;
    }),
    finishAudit: jest.fn(async (id: string, data: any) => {
      Object.assign(audits.find((a) => a.id === id) || {}, data);
    }),
    listAudit: jest.fn(async () => audits),
    auditByRefundIds: jest.fn(async () => []),
    organizationNames: jest.fn(async () => []),
  };
  const refunds = new RefundsService(refundsRepo as any, {
    notify: jest.fn(async () => 'sent'),
  } as any);
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    { track: jest.fn(async () => undefined) } as any,
    { recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined) } as any,
    undefined,
    ownerAlerts as any,
    refunds
  );
  return { razorpay, subscriptions, ownerAlerts, rows: () => store, audits };
}

const cancelCalls = () =>
  calls
    .filter((c) => c.method === 'POST' && /\/cancel$/.test(c.path))
    .map((c) => ({ id: c.path.split('/')[2], body: c.body }));

const alertsOf = (ownerAlerts: any, event: string) =>
  ownerAlerts.notify.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.event === event);

beforeAll(() => {
  delete process.env.RESEND_API_KEY;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
});

beforeEach(() => {
  plans.clear();
  subs.clear();
  calls.length = 0;
  redis.clear();
  unreadable.clear();
  cancelRefused.clear();
  refunded.clear();
  deletedOrgs.clear();
  missingOrgs.clear();
  orgReadFails = false;
  listingDown = false;
  payments.clear();
  invoicesById.clear();
  refundsMade.length = 0;
  refundRefused.clear();
  refundTimesOut.clear();
  mockRequest.mockClear();
  disputes.length = 0;
  sentEmails.length = 0;
  plans.set('plan_std_699', {
    id: 'plan_std_699',
    period: 'monthly',
    item: { amount: 69900, currency: 'INR' },
    notes: { hookpost_key: buildPlanKey('STANDARD', 'MONTHLY', 69900, 'INR') },
  });
});

describe('the pre-charge guard: a plan ending here that Razorpay can still charge', () => {
  it('cancels at Razorpay when the charge and the saved end fall on the same instant, two days out', async () => {
    // The 11 Nov incident: a cycle-end cancel was posted, Razorpay shows
    // nothing for it, and charge_at is the very instant the plan ends here.
    const at = nowSec() + 2 * DAY - HOUR;
    const sub = putSub('sub_race', { current_end: at, charge_at: at });
    const { razorpay, ownerAlerts, rows } = setup([
      putRow('sub_race', { cancelAt: new Date(at * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(cancelCalls()).toEqual([{ id: 'sub_race', body: { cancel_at_cycle_end: 0 } }]);
    expect(sub.status).toBe('cancelled');
    expect(report.cancelled).toHaveLength(1);
    expect(report.cancelled[0]).toMatchObject({
      subscriptionId: 'sub_race',
      organizationId: ORG,
      reason: 'the next charge is due within 48 hours and the plan is ending',
    });
    // The customer keeps every day they paid for: the row is untouched.
    expect(rows()[0].cancelAt?.getTime()).toBe(at * 1000);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')[0].notes.join(' ')).toContain(
      'keeps their plan here until'
    );
  });

  it('cancels a mandate waiting to charge for a plan that has already ended here', async () => {
    // A replacement mandate (Reactivate, Change payment method) that has
    // taken nothing yet and is set to start charging days from now, left
    // behind by a plan that ended an hour ago.
    const sub = putSub('sub_lapsed', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      charge_at: nowSec() + 10 * DAY,
      paid_count: 0,
      remaining_count: 120,
    });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_lapsed', { cancelAt: new Date((nowSec() - HOUR) * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('cancelled');
    expect(report.cancelled[0].reason).toBe(
      'the plan ended here but Razorpay could still charge'
    );
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
  });

  it('leaves a plan whose next charge is weeks away, and takes it the hour it comes close', async () => {
    const soon = nowSec() + 5 * DAY;
    putSub('sub_later', { current_end: soon, charge_at: soon });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_later', { cancelAt: new Date(soon * 1000) }),
    ]);

    expect((await razorpay.reconcileBilling()).cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();

    // Three days later the charge is inside the 48-hour window.
    const report = await razorpay.reconcileBilling({
      now: new Date((nowSec() + 3 * DAY) * 1000),
    });
    expect(report.cancelled).toHaveLength(1);
    expect(subs.get('sub_later').status).toBe('cancelled');
  });

  it('does nothing for a plan with no end date on it', async () => {
    putSub('sub_happy', { charge_at: nowSec() + HOUR });
    const { razorpay, ownerAlerts } = setup([putRow('sub_happy')]);

    const report = await razorpay.reconcileBilling();

    expect(report.endingChecked).toBe(0);
    expect(cancelCalls()).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('never cancels a subscription Razorpay already proves is stopping', async () => {
    const at = nowSec() + HOUR;
    // A cancel Razorpay really registered: end_at is at the cycle end.
    putSub('sub_proven', { current_end: at, charge_at: at, end_at: at });
    const { razorpay } = setup([putRow('sub_proven', { cancelAt: new Date(at * 1000) })]);

    expect((await razorpay.reconcileBilling()).cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
  });

  it('never cancels one Razorpay has already cancelled', async () => {
    const at = nowSec() + HOUR;
    putSub('sub_done', { status: 'cancelled', ended_at: nowSec(), current_end: at });
    const { razorpay } = setup([putRow('sub_done', { cancelAt: new Date(at * 1000) })]);

    expect((await razorpay.reconcileBilling()).cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
  });

  it('cancels a card subscription the same way as a UPI one', async () => {
    const at = nowSec() + HOUR;
    putSub('sub_card', {
      payment_method: 'card',
      current_end: at,
      charge_at: at,
    });
    const { razorpay } = setup([putRow('sub_card', { cancelAt: new Date(at * 1000) })]);

    const report = await razorpay.reconcileBilling();

    expect(cancelCalls()).toEqual([{ id: 'sub_card', body: { cancel_at_cycle_end: 0 } }]);
    expect(report.cancelled).toHaveLength(1);
  });

  it('cancels a cancelled trial whose first charge is about to be taken anyway', async () => {
    // A trial cancelled at Razorpay would be `cancelled`; this is one where
    // that never registered, so the first debit is still coming.
    const at = nowSec() + HOUR;
    putSub('sub_trial', {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      start_at: at,
      charge_at: at,
      paid_count: 0,
      remaining_count: 120,
    });
    const { razorpay, rows } = setup([
      putRow('sub_trial', { cancelAt: new Date(at * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(cancelCalls()).toEqual([{ id: 'sub_trial', body: { cancel_at_cycle_end: 0 } }]);
    expect(report.cancelled).toHaveLength(1);
    // The trial still runs to the day it would have been charged.
    expect(rows()[0].cancelAt?.getTime()).toBe(at * 1000);
  });

  it('never cancels a renewal that failed and is being retried: that charge is the customer paying', async () => {
    // scheduleHaltedRenewalEnd puts a date on the row while the customer still
    // has time to pay. Cancelling here would take the plan away for trying.
    const grace = nowSec() + HOUR;
    putSub('sub_retry', {
      status: 'pending',
      current_start: nowSec() - DAY,
      current_end: nowSec() + 29 * DAY,
      charge_at: nowSec() + HOUR,
      paid_count: 2,
      remaining_count: 117,
    });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_retry', { cancelAt: new Date(grace * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(cancelCalls()).toEqual([]);
    expect(report.cancelled).toEqual([]);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toEqual([]);
    expect(subs.get('sub_retry').status).toBe('pending');
  });

  it('never cancels a halted renewal before its paid end either', async () => {
    const grace = nowSec() + HOUR;
    putSub('sub_halted', {
      status: 'halted',
      charge_at: nowSec() + HOUR,
      paid_count: 2,
      remaining_count: 117,
    });
    const { razorpay } = setup([
      putRow('sub_halted', { cancelAt: new Date(grace * 1000) }),
    ]);

    expect((await razorpay.reconcileBilling()).cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
  });
});

describe('the guard and a refunded period', () => {
  it('cancels at Razorpay for a plan a refund ended now', async () => {
    // handleRefund sets the row to end now; Razorpay could not be cancelled
    // at the time (it was down), so the mandate is still live. The cycle is
    // paid well past that date, so only the refund says the row is right.
    putSub('sub_refunded');
    refunded.add('sub_refunded');
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_refunded', { cancelAt: new Date((nowSec() - 60) * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(cancelCalls()).toEqual([{ id: 'sub_refunded', body: { cancel_at_cycle_end: 0 } }]);
    expect(report.cancelled[0].reason).toBe(
      'a charge on it was refunded and the plan ended here'
    );
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
  });

  it('never cancels a halted renewal that was paid after all', async () => {
    // scheduleHaltedRenewalEnd saved an end date, the customer then paid the
    // pending invoice and Razorpay went back to active with the next cycle
    // paid for. The grace sweep lifts the date in this same run; the guard
    // must not have cancelled the mandate first.
    const sub = putSub('sub_recovered', {
      current_end: nowSec() + 25 * DAY,
      charge_at: nowSec() + 25 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_recovered', { cancelAt: new Date((nowSec() - HOUR) * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(report.cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(sub.status).toBe('active');
    // The owner still hears about it: a date got onto the row somehow.
    expect(report.mismatches).toEqual([
      expect.objectContaining({
        subscriptionId: 'sub_recovered',
        kind: 'paid_past_saved_end',
      }),
    ]);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toEqual([]);
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')[0].notes.join(' ')).toContain(
      'Nothing was cancelled'
    );
  });

  it('never cancels a recovered renewal whose next charge is hours away', async () => {
    // The same, with the charge inside the 48-hour window: the window must
    // not override the fact that the time ahead is paid for.
    const sub = putSub('sub_recovered_soon', {
      current_end: nowSec() + 20 * DAY,
      charge_at: nowSec() + 2 * HOUR,
    });
    const { razorpay } = setup([
      putRow('sub_recovered_soon', { cancelAt: new Date((nowSec() + HOUR) * 1000) }),
    ]);

    expect((await razorpay.reconcileBilling()).cancelled).toEqual([]);
    expect(sub.status).toBe('active');
  });
});

describe('the guard and rows with no Razorpay subscription', () => {
  it('ignores lifetime, Gumroad and marketplace plans entirely', async () => {
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_none', { isLifetime: true, cancelAt: new Date((nowSec() - DAY) * 1000) }),
      putRow('gumroad:12345', { cancelAt: new Date((nowSec() - DAY) * 1000) }),
      putRow('appsumo-lifetime', { cancelAt: new Date((nowSec() - DAY) * 1000) }),
      putRow(null as any, { cancelAt: new Date((nowSec() - DAY) * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(report.endingChecked).toBe(0);
    expect(calls.filter((c) => c.path.startsWith('/subscriptions/'))).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });
});

describe('the guard when Razorpay misbehaves', () => {
  it('never cancels on a read that failed, and tries again the next hour', async () => {
    const at = nowSec() + HOUR;
    const sub = putSub('sub_down', { current_end: at, charge_at: at });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_down', { cancelAt: new Date(at * 1000) }),
    ]);
    unreadable.add('sub_down');

    const first = await razorpay.reconcileBilling();

    expect(first.unreadable).toBe(1);
    expect(first.cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
    expect(sub.status).toBe('active');

    // Razorpay comes back, and the next run does the work.
    unreadable.clear();
    const second = await razorpay.reconcileBilling();
    expect(second.cancelled).toHaveLength(1);
    expect(sub.status).toBe('cancelled');
  });

  it('a refused cancel is reported as nothing done, and the next hour tries again', async () => {
    const at = nowSec() + HOUR;
    const sub = putSub('sub_refuse', { current_end: at, charge_at: at });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_refuse', { cancelAt: new Date(at * 1000) }),
    ]);
    cancelRefused.add('sub_refuse');

    const first = await razorpay.reconcileBilling();

    expect(first.cancelled).toEqual([]);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toEqual([]);
    expect(sub.status).toBe('active');

    cancelRefused.clear();
    const second = await razorpay.reconcileBilling();
    expect(second.cancelled).toHaveLength(1);
    expect(sub.status).toBe('cancelled');
  });

  it('treats "already cancelled" as done and still tells the owner', async () => {
    // Another process cancelled it between the read and the write.
    const at = nowSec() + HOUR;
    const sub = putSub('sub_rac2', { current_end: at, charge_at: at });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_rac2', { cancelAt: new Date(at * 1000) }),
    ]);
    const original = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string, body?: any) => {
      if (method === 'POST' && path === '/subscriptions/sub_rac2/cancel') {
        sub.status = 'cancelled';
        sub.ended_at = nowSec();
        calls.push({ method, path, body });
        throw new Error(
          `Razorpay POST ${path} failed (400): Subscription is not cancellable in cancelled status.`
        );
      }
      return original(method, path, body);
    });

    const report = await razorpay.reconcileBilling();

    expect(report.cancelled).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
    mockRequest.mockImplementation(original);
  });

  it('does not crash or cancel anything when the account listing is down', async () => {
    putSub('sub_ok');
    const { razorpay } = setup([putRow('sub_ok')]);
    listingDown = true;

    const report = await razorpay.reconcileBilling();

    expect(report.listingFailed).toBe(true);
    expect(report.mismatches).toEqual([]);
    expect(cancelCalls()).toEqual([]);
  });
});

describe('a refunded charge whose plan is still on and still charging', () => {
  it('ends the plan and cancels at Razorpay when the next charge is close', async () => {
    // The 11 Oct half of the incident: the renewal was refunded, the refund
    // webhook's cancel did not get through, and the plan and the mandate both
    // stayed on. There is no end date on the row, so nothing else looks at it.
    const sub = putSub('sub_back', { charge_at: nowSec() + DAY });
    refunded.add('sub_back');
    const { razorpay, ownerAlerts, subscriptions } = setup([putRow('sub_back')]);

    const report = await razorpay.reconcileBilling();

    expect(report.refundedEnded).toEqual(['sub_back']);
    expect(cancelCalls()).toEqual([{ id: 'sub_back', body: { cancel_at_cycle_end: 0 } }]);
    expect(sub.status).toBe('cancelled');
    // Refunded, so there is no paid time to keep: the plan ends now.
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')[0].notes.join(' ')).toContain(
      'was refunded'
    );
  });

  it('leaves a refunded plan whose charge is still weeks away to the next hour', async () => {
    const sub = putSub('sub_slow', { charge_at: nowSec() + 20 * DAY });
    refunded.add('sub_slow');
    const { razorpay, subscriptions } = setup([putRow('sub_slow')]);

    expect((await razorpay.reconcileBilling()).refundedEnded).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(sub.status).toBe('active');
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
  });

  it('never ends a plan that was paid and not refunded', async () => {
    putSub('sub_paid', { charge_at: nowSec() + HOUR });
    const { razorpay, ownerAlerts, subscriptions } = setup([putRow('sub_paid')]);

    const report = await razorpay.reconcileBilling();

    expect(report.refundedEnded).toEqual([]);
    expect(cancelCalls()).toEqual([]);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('does not look for refunds on a subscription Razorpay has already stopped', async () => {
    putSub('sub_over', { status: 'cancelled', ended_at: nowSec() });
    refunded.add('sub_over');
    const { razorpay } = setup([putRow('sub_over')]);

    expect((await razorpay.reconcileBilling()).refundedEnded).toEqual([]);
    expect(calls.some((c) => c.path.startsWith('/invoices'))).toBe(false);
  });

  it('ends it once however many runs overlap', async () => {
    putSub('sub_twice', { charge_at: nowSec() + DAY });
    refunded.add('sub_twice');
    const { razorpay, ownerAlerts } = setup([putRow('sub_twice')]);

    const reports = await Promise.all([
      razorpay.reconcileBilling(),
      razorpay.reconcileBilling(),
    ]);

    expect(cancelCalls()).toHaveLength(1);
    expect(reports.reduce((n, r) => n + r.refundedEnded.length, 0)).toBe(1);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
  });

  it('reports it in a dry run and changes nothing', async () => {
    const sub = putSub('sub_dryref', { charge_at: nowSec() + DAY });
    refunded.add('sub_dryref');
    const { razorpay, ownerAlerts, subscriptions } = setup([putRow('sub_dryref')]);

    const report = await razorpay.reconcileBilling({ dryRun: true });

    expect(report.refundedEnded).toEqual(['sub_dryref']);
    expect(cancelCalls()).toEqual([]);
    expect(sub.status).toBe('active');
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });
});

describe('a workspace that is gone while Razorpay can still charge it', () => {
  it('cancels at Razorpay when the workspace was deleted', async () => {
    const sub = putSub('sub_closed', {
      created_at: nowSec() - 60 * DAY,
      charge_at: nowSec() + 20 * DAY,
    });
    deletedOrgs.add(ORG);
    const { razorpay, ownerAlerts } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('cancelled');
    expect(report.cancelled[0]).toMatchObject({
      subscriptionId: 'sub_closed',
      reason: 'the workspace was deleted and Razorpay could still charge it',
    });
    // It is an action, not a disagreement left for the owner to sort out.
    expect(report.mismatches).toEqual([]);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toEqual([]);
  });

  it('cancels when the deleted workspace still holds its plan row', async () => {
    // Deleting the account left the row behind, and the grace sweep passes
    // over a deleted workspace, so nothing else would ever reach this.
    const sub = putSub('sub_leftover', { charge_at: nowSec() + 20 * DAY });
    const { razorpay } = setup([
      putRow('sub_leftover', { organization: { deletedAt: new Date() } }),
    ]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('cancelled');
    expect(report.cancelled[0].reason).toBe(
      'the workspace was deleted and Razorpay could still charge it'
    );
  });

  it('cancels when the workspace is no longer in the database at all', async () => {
    const sub = putSub('sub_purged', {
      created_at: nowSec() - 60 * DAY,
      charge_at: nowSec() + 20 * DAY,
    });
    missingOrgs.add(ORG);
    const { razorpay } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('cancelled');
    expect(report.cancelled[0].reason).toBe(
      'the workspace no longer exists and Razorpay could still charge it'
    );
  });

  it('only reports it while the workspace is alive', async () => {
    const sub = putSub('sub_alive', {
      created_at: nowSec() - 60 * DAY,
      charge_at: nowSec() + 20 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('active');
    expect(report.cancelled).toEqual([]);
    expect(report.mismatches).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toHaveLength(1);
  });

  it('never treats a workspace it could not read as deleted', async () => {
    const sub = putSub('sub_dbdown', {
      created_at: nowSec() - 60 * DAY,
      charge_at: nowSec() + 20 * DAY,
    });
    orgReadFails = true;
    const { razorpay } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(sub.status).toBe('active');
    expect(report.cancelled).toEqual([]);
    expect(cancelCalls()).toEqual([]);
  });
});

describe('the guard runs in several processes at once', () => {
  it('cancels once and alerts once however many runs overlap', async () => {
    const at = nowSec() + HOUR;
    putSub('sub_once', { current_end: at, charge_at: at });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_once', { cancelAt: new Date(at * 1000) }),
    ]);

    const [a, b, c] = await Promise.all([
      razorpay.reconcileBilling(),
      razorpay.reconcileBilling(),
      razorpay.reconcileBilling(),
    ]);

    expect(cancelCalls()).toHaveLength(1);
    expect([a, b, c].reduce((n, r) => n + r.cancelled.length, 0)).toBe(1);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
  });

  it('a later run of the same hour changes nothing', async () => {
    const at = nowSec() + HOUR;
    putSub('sub_idem', { current_end: at, charge_at: at });
    const { razorpay } = setup([putRow('sub_idem', { cancelAt: new Date(at * 1000) })]);

    await razorpay.reconcileBilling();
    const before = cancelCalls().length;
    await razorpay.reconcileBilling();
    await razorpay.reconcileBilling();

    expect(cancelCalls()).toHaveLength(before);
  });
});

describe('dry run', () => {
  it('reads everything, changes nothing and sends nothing', async () => {
    const at = nowSec() + HOUR;
    const sub = putSub('sub_dry', { current_end: at, charge_at: at });
    putSub('sub_orphan', { created_at: nowSec() - 30 * DAY, charge_at: nowSec() + DAY });
    const { razorpay, ownerAlerts, rows } = setup([
      putRow('sub_dry', { cancelAt: new Date(at * 1000) }),
    ]);

    const report = await razorpay.reconcileBilling({ dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.cancelled).toHaveLength(1);
    expect(report.mismatches).toHaveLength(1);
    // Nothing moved.
    expect(cancelCalls()).toEqual([]);
    expect(sub.status).toBe('active');
    expect(rows()[0].cancelAt?.getTime()).toBe(at * 1000);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
    expect(redis.size).toBe(0);
  });
});

// Red team, 2 Nov 2026: the customer revokes the mandate in their UPI app, or
// the renewal halts, and Razorpay's webhook never lands (24 hours of failed
// deliveries, or a webhook secret that stopped matching after a move). The
// plan row had no end date, so the plan ran on for free, for good: the
// guard only told the owner about a cancelled one, and said nothing about a
// halted one.
describe('a webhook that never arrived: the guard handles it as the webhook would have', () => {
  it('a mandate revoked mid-cycle: the plan runs out the time paid for, one "cancelled" email, no mismatch alert', async () => {
    const sub = putSub('sub_revoked', {
      status: 'cancelled',
      ended_at: nowSec() - 2 * DAY,
      created_at: nowSec() - 90 * DAY,
    });
    const { razorpay, ownerAlerts, rows } = setup([putRow('sub_revoked')]);

    const report = await razorpay.reconcileBilling();

    expect(report.missedWebhooks).toEqual(['sub_revoked']);
    expect(rows()[0].cancelAt?.getTime()).toBe(sub.current_end * 1000);
    expect(cancelCalls()).toEqual([]);
    expect(report.mismatches).toEqual([]);
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toHaveLength(0);
    expect(alertsOf(ownerAlerts, 'CANCELLED')).toHaveLength(1);

    // The next hour finds the end on the row: nothing again.
    await razorpay.reconcileBilling();
    expect(alertsOf(ownerAlerts, 'CANCELLED')).toHaveLength(1);
  });

  it('a renewal that halted unpaid: the plan ends now and the mandate is stopped', async () => {
    // 2 cycles booked, 1 paid: nothing is paid for past current_start.
    putSub('sub_halted_lost', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
      charge_at: nowSec() + 28 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 1,
    });
    const { razorpay, subscriptions } = setup([putRow('sub_halted_lost')]);
    (subscriptions as any).markPaymentFailing = jest.fn(async () => true);

    const report = await razorpay.reconcileBilling();

    expect(report.missedWebhooks).toEqual(['sub_halted_lost']);
    expect(cancelCalls()).toEqual([
      { id: 'sub_halted_lost', body: { cancel_at_cycle_end: 0 } },
    ]);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('a completed subscription ends its plan, as subscription.completed does', async () => {
    putSub('sub_done', {
      status: 'completed',
      ended_at: nowSec() - 3 * DAY,
      remaining_count: 0,
    });
    const { razorpay, subscriptions } = setup([putRow('sub_done')]);

    expect((await razorpay.reconcileBilling()).missedWebhooks).toEqual(['sub_done']);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledWith(ORG);
  });

  it('cancelled minutes ago: left to its webhook, and no mismatch alert meanwhile', async () => {
    putSub('sub_just', { status: 'cancelled', ended_at: nowSec() - 600 });
    const { razorpay, ownerAlerts, subscriptions } = setup([putRow('sub_just')]);

    const report = await razorpay.reconcileBilling();

    expect(report.missedWebhooks).toEqual([]);
    expect(report.mismatches).toEqual([]);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('dry run: reported, nothing changed', async () => {
    putSub('sub_revoked', { status: 'cancelled', ended_at: nowSec() - DAY });
    const { razorpay, subscriptions, ownerAlerts } = setup([putRow('sub_revoked')]);

    const report = await razorpay.reconcileBilling({ dryRun: true });

    expect(report.missedWebhooks).toEqual(['sub_revoked']);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('a newer mandate already approved (its webhook late too): never ended here, reported instead', async () => {
    putSub('sub_old_pm', {
      status: 'cancelled',
      ended_at: nowSec() - DAY,
    });
    putSub('sub_new_pm', {
      status: 'authenticated',
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', replaces: 'sub_old_pm' },
    });
    const { razorpay, subscriptions, ownerAlerts } = setup([putRow('sub_old_pm')]);
    jest.spyOn(razorpay, 'getCustomerByOrganizationId').mockResolvedValue('cust_1');

    const report = await razorpay.reconcileBilling();

    expect(report.missedWebhooks).toEqual([]);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    // Both halves go to the owner: the new mandate with no row yet, and the
    // plan still on the old one.
    expect(report.mismatches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subscriptionId: 'sub_old_pm', kind: 'plan_without_subscription' }),
        expect.objectContaining({ subscriptionId: 'sub_new_pm', kind: 'charging_without_plan' }),
      ])
    );
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toHaveLength(2);
  });

  it('a replay that fails is still reported, and tried again next hour', async () => {
    putSub('sub_revoked', { status: 'cancelled', ended_at: nowSec() - DAY });
    const { razorpay, subscriptions } = setup([putRow('sub_revoked')]);
    subscriptions.scheduleCancellation.mockRejectedValueOnce(new Error('the database is down'));

    const first = await razorpay.reconcileBilling();
    expect(first.missedWebhooks).toEqual([]);
    expect(first.mismatches).toEqual([
      expect.objectContaining({ subscriptionId: 'sub_revoked', kind: 'plan_without_subscription' }),
    ]);

    const second = await razorpay.reconcileBilling();
    expect(second.missedWebhooks).toEqual(['sub_revoked']);
  });

  it('an ended subscription with no ended_at cannot be timed: reported, never acted on', async () => {
    putSub('sub_untimed', { status: 'cancelled' });
    const { razorpay, subscriptions } = setup([putRow('sub_untimed')]);

    const report = await razorpay.reconcileBilling();

    expect(report.missedWebhooks).toEqual([]);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(report.mismatches).toEqual([
      expect.objectContaining({ subscriptionId: 'sub_untimed', kind: 'plan_without_subscription' }),
    ]);
  });

  it("another workspace's subscription on the row is never touched", async () => {
    putSub('sub_foreign', {
      status: 'cancelled',
      ended_at: nowSec() - DAY,
      notes: { service: 'hookpost', orgId: 'org-other', billing: 'STANDARD' },
    });
    const { razorpay, subscriptions } = setup([putRow('sub_foreign')]);

    expect((await razorpay.reconcileBilling()).missedWebhooks).toEqual([]);
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
  });
});

describe('the other direction: reported to the owner, never acted on', () => {
  it('reports a subscription that can still charge with no plan row behind it', async () => {
    putSub('sub_orphan', {
      created_at: nowSec() - 30 * DAY,
      charge_at: nowSec() + 3 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(report.mismatches).toEqual([
      expect.objectContaining({
        subscriptionId: 'sub_orphan',
        kind: 'charging_without_plan',
        organizationId: ORG,
      }),
    ]);
    // Reported only. A customer who just paid must never be cancelled by a
    // sweep that cannot see their row yet.
    expect(cancelCalls()).toEqual([]);
    expect(subs.get('sub_orphan').status).toBe('active');
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')[0].notes.join(' ')).toContain(
      'Nothing was cancelled'
    );
  });

  it('says nothing about a checkout that was approved moments ago', async () => {
    // Its webhook has not landed yet, so there is no row. This is the case
    // that makes acting here unsafe.
    putSub('sub_fresh', {
      created_at: nowSec() - 120,
      status: 'authenticated',
      charge_at: nowSec() + 7 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([]);

    expect((await razorpay.reconcileBilling()).mismatches).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('reports a plan with no end date whose subscription it could not read on its own', async () => {
    putSub('sub_gone', {
      status: 'cancelled',
      ended_at: nowSec() - DAY,
      created_at: nowSec() - 90 * DAY,
    });
    unreadable.add('sub_gone');
    const { razorpay, ownerAlerts, subscriptions } = setup([putRow('sub_gone')]);

    const report = await razorpay.reconcileBilling();

    expect(report.mismatches).toEqual([
      expect.objectContaining({
        subscriptionId: 'sub_gone',
        kind: 'plan_without_subscription',
      }),
    ]);
    // Nothing is acted on from the listing alone.
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(alertsOf(ownerAlerts, 'BILLING_MISMATCH')).toHaveLength(1);
  });

  it('says nothing about a cancelled subscription whose plan is running out its paid time', async () => {
    putSub('sub_cancelling', {
      status: 'cancelled',
      ended_at: nowSec(),
      created_at: nowSec() - 90 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_cancelling', { cancelAt: new Date((nowSec() + 10 * DAY) * 1000) }),
    ]);

    expect((await razorpay.reconcileBilling()).mismatches).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('ignores another product on the same Razorpay account', async () => {
    putSub('sub_vet', {
      created_at: nowSec() - 90 * DAY,
      notes: { service: 'vetnow', orgId: ORG },
      charge_at: nowSec() + DAY,
    });
    const { razorpay, ownerAlerts } = setup([]);

    const report = await razorpay.reconcileBilling();

    expect(report.listed).toBe(0);
    expect(report.mismatches).toEqual([]);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('reports the same mismatch once, not every hour', async () => {
    putSub('sub_orphan', {
      created_at: nowSec() - 30 * DAY,
      charge_at: nowSec() + 3 * DAY,
    });
    const { razorpay, ownerAlerts } = setup([]);

    await razorpay.reconcileBilling();
    await razorpay.reconcileBilling();

    // Both runs report it; OwnerSalesAlertService claims the key, so the
    // owner is emailed once. The key must be the same both times.
    const keys = alertsOf(ownerAlerts, 'BILLING_MISMATCH').map((a: any) => a.key);
    expect(new Set(keys).size).toBe(1);
  });
});

describe('"we stopped a charge": the customer is told once', () => {
  const STOPPED = 'We stopped a charge';
  const stoppedEmails = () =>
    sentEmails.filter((m) => String(m.subject).startsWith(STOPPED));

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it('a cancel that did not stick: one email, with the date the plan still works until', async () => {
    const at = nowSec() + DAY;
    putSub('sub_stuck', { current_end: at, charge_at: at });
    const { razorpay } = setup([putRow('sub_stuck', { cancelAt: new Date(at * 1000) })]);

    await razorpay.reconcileBilling();
    // Another process finds it after the guard's claim ran out: Razorpay
    // says it is already cancelled, which counts as done, and the email is
    // not sent a second time.
    redis.delete('razorpay:guard:guard-cancel:sub_stuck');
    await razorpay.reconcileBilling();

    expect(stoppedEmails()).toHaveLength(1);
    expect(stoppedEmails()[0].to).toBe('priya@chaipoint.in');
    expect(stoppedEmails()[0].text).toContain('Works until');
    expect(stoppedEmails()[0].text).toContain("You won't be charged again");
  });

  it('a plan already over here that Razorpay would still charge: one email saying it has ended', async () => {
    // Razorpay never flipped the old cycle-end cancel: still active, still
    // set to charge, with the paid cycle ending where the row ends.
    putSub('sub_over', { current_end: nowSec() - HOUR, charge_at: nowSec() + 3 * DAY });
    const { razorpay } = setup([
      putRow('sub_over', { cancelAt: new Date((nowSec() - HOUR) * 1000) }),
    ]);

    await razorpay.reconcileBilling();

    expect(stoppedEmails()).toHaveLength(1);
    expect(stoppedEmails()[0].text).toContain('Ended');
    expect(stoppedEmails()[0].text).not.toContain('Works until');
  });

  it('Razorpay\'s subscription.cancelled for the guard\'s own cancel sends no "cancelled" email, and the owner alert for it is held back first', async () => {
    putSub('sub_over', { current_end: nowSec() - HOUR, charge_at: nowSec() + 3 * DAY });
    const { razorpay, ownerAlerts } = setup([
      putRow('sub_over', { cancelAt: new Date((nowSec() - HOUR) * 1000) }),
    ]);

    await razorpay.reconcileBilling();
    // The mark is set before the cancel reaches Razorpay.
    const markAt = ownerAlerts.mark.mock.invocationCallOrder[ownerAlerts.mark.mock.calls.findIndex((c: any[]) => c[0] === 'cancel:sub_over')];
    const cancelAt = mockRequest.mock.invocationCallOrder[mockRequest.mock.calls.findIndex((c: any[]) => c[0] === 'POST' && c[1] === '/subscriptions/sub_over/cancel')];
    expect(markAt).toBeLessThan(cancelAt);
    await razorpay.handleWebhook({
      event: 'subscription.cancelled',
      payload: { subscription: { entity: { ...subs.get('sub_over') } } },
    });

    expect(stoppedEmails()).toHaveLength(1);
    expect(sentEmails.filter((m) => /cancelled/i.test(m.subject))).toHaveLength(0);
  });

  it('a refunded plan still set to renew: one email, and no "cancelled" email beside it', async () => {
    putSub('sub_back', { charge_at: nowSec() + DAY });
    refunded.add('sub_back');
    const { razorpay } = setup([putRow('sub_back')]);

    await razorpay.reconcileBilling();
    await razorpay.reconcileBilling();

    expect(stoppedEmails()).toHaveLength(1);
    expect(sentEmails).toHaveLength(1);
  });

  it('nothing for a dry run, a deleted workspace, or a plan whose charge is still far away', async () => {
    putSub('sub_far', { charge_at: nowSec() + 20 * DAY });
    putSub('sub_near', { charge_at: nowSec() + DAY, notes: { service: 'hookpost', orgId: 'org-gone', billing: 'STANDARD' } });
    deletedOrgs.add('org-gone');
    const { razorpay } = setup([
      putRow('sub_far', { cancelAt: new Date((nowSec() + 20 * DAY) * 1000) }),
      putRow('sub_near', { organizationId: 'org-gone', organization: { deletedAt: new Date() } }),
    ]);

    await razorpay.reconcileBilling({ dryRun: true });
    expect(sentEmails).toHaveLength(0);

    const report = await razorpay.reconcileBilling();
    expect(report.cancelled.map((c) => c.subscriptionId)).toEqual(['sub_near']);
    expect(sentEmails).toHaveLength(0);
  });

  it('a cancel Razorpay keeps refusing: no customer email and no owner alert, a retry is booked, the row is untouched', async () => {
    const at = nowSec() + DAY;
    putSub('sub_refuse', { current_end: at, charge_at: at });
    cancelRefused.add('sub_refuse');
    const { razorpay, ownerAlerts, rows } = setup([
      putRow('sub_refuse', { cancelAt: new Date(at * 1000) }),
    ]);

    const first = await razorpay.reconcileBilling();
    const second = await razorpay.reconcileBilling();

    expect(first.cancelled).toEqual([]);
    expect(second.cancelled).toEqual([]);
    expect(sentEmails).toHaveLength(0);
    // The owner is not asked to do anything: the retries and, failing them,
    // the automatic refund cover it.
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
    expect(rows()[0].cancelAt?.getTime()).toBe(at * 1000);
    const rec = await razorpay.readGuardRetry('sub_refuse');
    expect(rec).toMatchObject({ attempts: 0, organizationId: ORG });
    expect(rec!.nextAt - rec!.firstFailedAt).toBe(5 * 60_000);
    // The second hourly run leaves it to the retry sweep: one cancel call.
    expect(cancelCalls()).toHaveLength(1);

    // Razorpay comes back: the retry cancels it and the customer is told once.
    cancelRefused.delete('sub_refuse');
    const swept = await razorpay.retryFailedGuardCancels(rec!.nextAt);
    expect(swept.cancelled).toBe(1);
    expect(stoppedEmails()).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'GUARD_CANCELLED')).toHaveLength(1);
  });

  it('review: a refused guard cancel holds nothing back; the customer who then stops it themselves gets the "cancelled" email', async () => {
    const at = nowSec() + DAY;
    putSub('sub_refuse', { current_end: at, charge_at: at });
    cancelRefused.add('sub_refuse');
    const { razorpay, ownerAlerts } = setup([putRow('sub_refuse', { cancelAt: new Date(at * 1000) })]);
    await razorpay.reconcileBilling();
    expect(ownerAlerts.unmark).toHaveBeenCalledWith('cancel:sub_refuse');

    // The customer revokes AutoPay in the UPI app; Razorpay says cancelled.
    Object.assign(subs.get('sub_refuse'), { status: 'cancelled', ended_at: nowSec() });
    const rec = await razorpay.readGuardRetry('sub_refuse');
    await razorpay.retryFailedGuardCancels(rec!.nextAt);
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: { ...subs.get('sub_refuse') } } } });
    expect(sentEmails.filter((m) => /cancelled/i.test(m.subject))).toHaveLength(1);
  });

  it('review: when the "stopped a charge" email cannot go out, Razorpay\'s "cancelled" webhook may still tell the customer', async () => {
    putSub('sub_over', { current_end: nowSec() - HOUR, charge_at: nowSec() + 3 * DAY });
    const { razorpay } = setup([putRow('sub_over', { cancelAt: new Date((nowSec() - HOUR) * 1000) })]);
    mockResendSend.mockImplementationOnce(async () => ({ data: null, error: { message: 'Resend is down' } }) as any);
    await razorpay.reconcileBilling();
    expect(stoppedEmails()).toHaveLength(0);
    await razorpay.handleWebhook({ event: 'subscription.cancelled', payload: { subscription: { entity: { ...subs.get('sub_over') } } } });
    expect(sentEmails.filter((m) => /cancelled|ended/i.test(m.subject))).toHaveLength(1);
  });
});

describe('guard cancel retries: 5 min, 30 min, 2 h, 6 h, never within 6 h of the charge', () => {
  const MIN = 60_000;

  it('the schedule, and where it stops', () => {
    const now = 1_800_000_000_000;
    const far = now + 10 * 86400_000;
    expect(RazorpayService.nextGuardRetryAt(0, now, far)).toBe(now + 5 * MIN);
    expect(RazorpayService.nextGuardRetryAt(1, now, far)).toBe(now + 30 * MIN);
    expect(RazorpayService.nextGuardRetryAt(2, now, far)).toBe(now + 120 * MIN);
    expect(RazorpayService.nextGuardRetryAt(3, now, far)).toBe(now + 360 * MIN);
    expect(RazorpayService.nextGuardRetryAt(4, now, far)).toBe(0);
    // Inside the last 6 h before the charge: no more tries.
    expect(RazorpayService.nextGuardRetryAt(3, now, now + 11 * 3600_000)).toBe(0);
    expect(RazorpayService.nextGuardRetryAt(0, now, now + 6 * 3600_000)).toBe(0);
  });

  it('walks the backoff while Razorpay refuses, then stops, and nobody is alerted', async () => {
    const at = nowSec() + 2 * DAY;
    putSub('sub_down', { current_end: at, charge_at: at });
    cancelRefused.add('sub_down');
    const { razorpay, ownerAlerts } = setup([putRow('sub_down', { cancelAt: new Date(at * 1000) })]);
    await razorpay.reconcileBilling();

    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const rec = await razorpay.readGuardRetry('sub_down');
      if (!rec?.nextAt) break;
      const before = rec.nextAt;
      await razorpay.retryFailedGuardCancels(before);
      const after = await razorpay.readGuardRetry('sub_down');
      if (after?.nextAt) gaps.push(after.nextAt - before);
    }
    expect(gaps).toEqual([30 * MIN, 120 * MIN, 360 * MIN]);
    const done = await razorpay.readGuardRetry('sub_down');
    expect(done).toMatchObject({ attempts: 4, nextAt: 0 });
    // A sweep after the end does nothing.
    const calls = cancelCalls().length;
    await razorpay.retryFailedGuardCancels(Date.now() + DAY * 1000);
    expect(cancelCalls().length).toBe(calls);
    expect(ownerAlerts.notify).not.toHaveBeenCalled();
  });

  it('two processes sweeping at once cancel once', async () => {
    const at = nowSec() + 2 * DAY;
    putSub('sub_twice', { current_end: at, charge_at: at });
    cancelRefused.add('sub_twice');
    const { razorpay } = setup([putRow('sub_twice', { cancelAt: new Date(at * 1000) })]);
    await razorpay.reconcileBilling();
    cancelRefused.delete('sub_twice');
    const rec = await razorpay.readGuardRetry('sub_twice');
    const before = cancelCalls().length;
    const [a, b] = await Promise.all([
      razorpay.retryFailedGuardCancels(rec!.nextAt),
      razorpay.retryFailedGuardCancels(rec!.nextAt),
    ]);
    expect(a.cancelled + b.cancelled).toBe(1);
    expect(cancelCalls().length - before).toBe(1);
  });

  it('a subscription stopped some other way is done with, without a cancel call', async () => {
    const at = nowSec() + 2 * DAY;
    const sub = putSub('sub_gone', { current_end: at, charge_at: at });
    cancelRefused.add('sub_gone');
    const { razorpay } = setup([putRow('sub_gone', { cancelAt: new Date(at * 1000) })]);
    await razorpay.reconcileBilling();
    Object.assign(sub, { status: 'cancelled', ended_at: nowSec() });
    const rec = await razorpay.readGuardRetry('sub_gone');
    const before = cancelCalls().length;
    await razorpay.retryFailedGuardCancels(rec!.nextAt);
    expect(cancelCalls().length).toBe(before);
    expect((await razorpay.readGuardRetry('sub_gone'))!.nextAt).toBe(0);
  });
});

describe('a charge after cancel is refunded in full, automatically', () => {
  const PAY = 'pay_LateCharge0001';
  const charged = (razorpay: RazorpayService, sub: any, payment: any) =>
    razorpay.handleWebhook({
      event: 'subscription.charged',
      payload: { subscription: { entity: sub }, payment: { entity: payment } },
    });
  const refundWebhook = (razorpay: RazorpayService, refund: any) =>
    razorpay.handleWebhook({ event: 'refund.processed', payload: { refund: { entity: refund } } });

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  /** A plan cancelled at once, then a UPI debit Razorpay takes anyway. */
  function lateCharge(over: { payment?: any; invoice?: any; sub?: any } = {}) {
    const end = nowSec() + HOUR;
    const cancelledAt = nowSec() - 2 * HOUR;
    const sub = putSub('sub_late', {
      status: 'cancelled',
      ended_at: cancelledAt,
      paid_count: 3,
      remaining_count: 117,
      current_start: end,
      current_end: end + 30 * DAY,
      charge_at: null,
      ...over.sub,
    });
    invoicesById.set('inv_late1', { id: 'inv_late1', entity: 'invoice', subscription_id: 'sub_late', payment_id: PAY, ...over.invoice });
    const payment = {
      id: PAY,
      entity: 'payment',
      amount: 69900,
      amount_refunded: 0,
      currency: 'INR',
      status: 'captured',
      captured: true,
      method: 'upi',
      invoice_id: 'inv_late1',
      created_at: nowSec() - HOUR,
      notes: [],
      ...over.payment,
    };
    payments.set(PAY, payment);
    const ctx = setup([putRow('sub_late', { cancelAt: new Date(end * 1000) })]);
    return { ...ctx, sub, payment, end };
  }
  const refundEmails = () => sentEmails.filter((m) => /^We refunded/.test(m.subject));

  it('refunds the captured amount once, audits it, emails the customer once, tells the owner (info), keeps the plan end', async () => {
    const { razorpay, sub, payment, end, ownerAlerts, audits, rows } = lateCharge();

    await charged(razorpay, sub, payment);
    // Razorpay redelivers the webhook, and the guard runs too.
    await charged(razorpay, sub, payment);
    await razorpay.reconcileBilling();
    // The refund webhook for our own refund.
    await refundWebhook(razorpay, refundsMade[0]);

    expect(refundsMade).toHaveLength(1);
    expect(refundsMade[0]).toMatchObject({ amount: 69900, payment_id: PAY });
    expect(refundsMade[0].notes).toMatchObject({ auto: 'charged_after_cancel' });
    expect(audits.filter((a) => a.status === 'SUCCESS')).toHaveLength(1);
    expect(audits[0]).toMatchObject({ adminUserId: 'system:auto-refund', paymentId: PAY, amount: 69900 });
    expect(refundEmails()).toHaveLength(1);
    expect(refundEmails()[0].subject).toBe('We refunded ₹699: your plan stays cancelled');
    expect(refundEmails()[0].text).toContain('works until');
    // No second "refund on its way" email from the webhook.
    expect(sentEmails.filter((m) => /refund/i.test(m.subject))).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'AUTO_REFUNDED')).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toEqual([]);
    // The refund webhook did not end the plan early.
    expect(rows()[0].cancelAt?.getTime()).toBe(end * 1000);
  });

  it('a missed charged webhook: the guard finds and refunds it', async () => {
    const { razorpay, ownerAlerts } = lateCharge();
    const report = await razorpay.reconcileBilling();
    expect(report.autoRefunds).toEqual([expect.objectContaining({ paymentId: PAY, outcome: 'refunded' })]);
    expect(refundsMade).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'AUTO_REFUNDED')).toHaveLength(1);
    await razorpay.reconcileBilling();
    expect(refundsMade).toHaveLength(1);
  });

  it('a dry run refunds nothing', async () => {
    lateCharge();
    const { razorpay } = setup([putRow('sub_late', { cancelAt: new Date((nowSec() + HOUR) * 1000) })]);
    const report = await razorpay.reconcileBilling({ dryRun: true });
    expect(report.autoRefunds[0]).toMatchObject({ outcome: 'would_check' });
    expect(refundsMade).toEqual([]);
  });

  it('tampered webhook: a payment that belongs to another subscription is never refunded', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge({ invoice: { subscription_id: 'sub_someone_else' } });
    await charged(razorpay, sub, payment);
    expect(refundsMade).toEqual([]);
    // Nothing was taken after the cancel on this subscription: nothing to ask.
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toEqual([]);
  });

  it('tampered webhook: the amount comes from Razorpay, capped at what was captured', async () => {
    const { razorpay, sub, payment } = lateCharge();
    await charged(razorpay, sub, { ...payment, amount: 9_999_900 });
    expect(refundsMade).toHaveLength(1);
    expect(refundsMade[0].amount).toBe(69900);
  });

  it('a partly refunded payment: only what is left goes back', async () => {
    const { razorpay, sub, payment } = lateCharge({ payment: { amount_refunded: 20000 } });
    await charged(razorpay, sub, payment);
    expect(refundsMade[0].amount).toBe(49900);
  });

  it('a payment made before the cancel is never refunded by this', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge({ payment: { created_at: nowSec() - 3 * HOUR } });
    await charged(razorpay, sub, payment);
    expect(refundsMade).toEqual([]);
    // A legitimate earlier renewal (a redelivered webhook): no false alarm.
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toEqual([]);
  });

  it('a UPI debit started before Cancel but paid after it is refunded (the invoice says when it was paid)', async () => {
    const { razorpay, sub, payment } = lateCharge({
      payment: { created_at: nowSec() - 3 * HOUR },
      invoice: { paid_at: nowSec() - HOUR },
    });
    await charged(razorpay, sub, payment);
    expect(refundsMade).toHaveLength(1);
  });

  it('a refund call that throws frees the claim, so the next run refunds it', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge();
    const refunds = (razorpay as any)._refunds;
    const real = refunds.refund.bind(refunds);
    refunds.refund = jest.fn(async () => {
      throw new Error('audit table down');
    });
    await charged(razorpay, sub, payment);
    expect(refundsMade).toEqual([]);
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toHaveLength(1);
    refunds.refund = real;
    await razorpay.reconcileBilling();
    expect(refundsMade).toHaveLength(1);
  });

  it('a payment that is not captured is never refunded', async () => {
    const { razorpay, sub, payment } = lateCharge({ payment: { status: 'authorized', captured: false } });
    await charged(razorpay, sub, payment);
    expect(refundsMade).toEqual([]);
  });

  it('another workspace’s subscription is never refunded through this one', async () => {
    const { razorpay, sub, payment } = lateCharge({ sub: { notes: { service: 'hookpost', orgId: 'org-other', billing: 'STANDARD' } } });
    await charged(razorpay, { ...sub, notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD' } }, payment);
    expect(refundsMade).toEqual([]);
  });

  it('Razorpay refuses the refund: the owner is asked to act, and the next guard run tries again', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge();
    refundRefused.add(PAY);
    await charged(razorpay, sub, payment);
    expect(refundsMade).toEqual([]);
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toHaveLength(1);
    refundRefused.delete(PAY);
    await razorpay.reconcileBilling();
    expect(refundsMade).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'AUTO_REFUNDED')).toHaveLength(1);
  });

  it('a charge after cancel that the customer also disputed with the bank: never refunded on top, the owner is asked to act', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge();
    disputes.push({ id: 'disp_late1', entity: 'dispute', payment_id: PAY, status: 'open', created_at: nowSec() });
    await charged(razorpay, sub, payment);
    await razorpay.reconcileBilling();
    expect(refundsMade).toEqual([]);
    expect(refundEmails()).toHaveLength(0);
    // One alert key (OwnerSalesAlertService sends a key once), naming the chargeback.
    const asked = alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL');
    expect(new Set(asked.map((a: any) => a.key))).toEqual(new Set([`charged-after-cancel:${PAY}`]));
    expect(asked[0].notes.join(' ')).toContain('chargeback (disp_late1, open)');
    expect(alertsOf(ownerAlerts, 'AUTO_REFUNDED')).toHaveLength(0);
  });

  it('a refund whose answer was lost is never sent again', async () => {
    const { razorpay, sub, payment, ownerAlerts } = lateCharge();
    refundTimesOut.add(PAY);
    await charged(razorpay, sub, payment);
    refundTimesOut.delete(PAY);
    await charged(razorpay, sub, payment);
    await razorpay.reconcileBilling();
    expect(refundsMade).toEqual([]);
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toHaveLength(1);
  });

  it('two webhook deliveries at the same instant refund once', async () => {
    const { razorpay, sub, payment } = lateCharge();
    await Promise.all([charged(razorpay, sub, payment), charged(razorpay, sub, payment), razorpay.reconcileBilling()]);
    expect(refundsMade).toHaveLength(1);
  });

  it('every guard retry failed and the renewal landed on the still-live mandate: the end stays, it is cancelled and refunded', async () => {
    const at = nowSec() + 2 * DAY;
    const sub = putSub('sub_stuck2', { current_end: at, charge_at: at });
    cancelRefused.add('sub_stuck2');
    const { razorpay, rows, ownerAlerts } = setup([putRow('sub_stuck2', { cancelAt: new Date(at * 1000) })]);
    await razorpay.reconcileBilling();
    expect(await razorpay.readGuardRetry('sub_stuck2')).not.toBeNull();
    // The first refusal was an hour ago; the renewal lands now.
    const key = 'razorpay:guard-retry:sub_stuck2';
    redis.set(key, JSON.stringify({ ...JSON.parse(redis.get(key)!), firstFailedAt: Date.now() - 3600_000 }));

    // Razorpay renews it anyway.
    const PAY2 = 'pay_StuckCharge001';
    Object.assign(sub, { paid_count: 3, remaining_count: 117, current_start: at, current_end: at + 30 * DAY, charge_at: at + 30 * DAY });
    invoicesById.set('inv_stuck2', { id: 'inv_stuck2', subscription_id: 'sub_stuck2', payment_id: PAY2 });
    // Taken a few seconds before the webhook's own cancel goes through, so
    // the subscription's ended_at is later than the payment.
    const payment = { id: PAY2, entity: 'payment', amount: 69900, currency: 'INR', status: 'captured', captured: true, method: 'upi', invoice_id: 'inv_stuck2', created_at: nowSec() - 5, notes: [] };
    payments.set(PAY2, payment);
    cancelRefused.delete('sub_stuck2');
    await charged(razorpay, sub, payment);

    expect(rows()[0].cancelAt?.getTime()).toBe(at * 1000);
    expect(sub.status).toBe('cancelled');
    expect(refundsMade).toHaveLength(1);
    expect(alertsOf(ownerAlerts, 'CHARGED_AFTER_CANCEL')).toEqual([]);
  });
});

// Big-company practice (Stripe "upcoming renewal" emails, Zoho before every
// renewal) and California's auto-renewal law (Bus. & Prof. Code 17602: a
// notice 15 to 45 days before a plan of a year or longer renews): a yearly
// plan is told about its renewal 30 days ahead, once per renewal.
describe('yearly renewal reminder', () => {
  const YEARLY = 'plan_std_yearly';
  const reminders = () => sentEmails.filter((m) => /renews on/.test(m.subject));
  const yearly = (id: string, chargeInDays: number, extra: any = {}) =>
    putSub(id, {
      plan_id: YEARLY,
      current_start: nowSec() - (365 - chargeInDays) * DAY,
      current_end: nowSec() + chargeInDays * DAY,
      charge_at: nowSec() + chargeInDays * DAY,
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'YEARLY' },
      ...extra,
    });
  const yearlyRow = (id: string, extra: any = {}) => putRow(id, { period: 'YEARLY', ...extra });

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key';
    plans.set(YEARLY, {
      id: YEARLY,
      period: 'yearly',
      item: { amount: 599000, currency: 'INR' },
      notes: { hookpost_key: buildPlanKey('STANDARD', 'YEARLY', 599000, 'INR') },
    });
  });
  afterEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it('30 days before a yearly renewal: one email with the date, the amount per year and how to stop it', async () => {
    const sub = yearly('sub_year', 30);
    const { razorpay } = setup([yearlyRow('sub_year')]);

    expect(await razorpay.sendRenewalReminders()).toEqual({ checked: 1, sent: 1 });
    const [mail] = reminders();
    const date = new Date(sub.charge_at * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    expect(mail.subject).toBe(`Your Hookpost Standard plan renews on ${date}`);
    expect(mail.to).toBe('priya@chaipoint.in');
    expect(mail.text).toContain('₹5,990/year');
    expect(mail.text).toContain(date);
    expect(mail.text).toMatch(/Cancel/);
    expect(mail.text).toMatch(/keep(s)? every feature until/i);
  });

  it('once per renewal: the next hours send nothing, next year\'s renewal is told again', async () => {
    const sub = yearly('sub_year', 30);
    const { razorpay } = setup([yearlyRow('sub_year')]);
    await razorpay.sendRenewalReminders();
    await razorpay.sendRenewalReminders(new Date(Date.now() + HOUR * 1000));
    await razorpay.sendRenewalReminders(new Date(Date.now() + 5 * DAY * 1000));
    expect(reminders()).toHaveLength(1);

    // Renewed: the next charge is a year on.
    sub.charge_at += 365 * DAY;
    sub.current_end += 365 * DAY;
    await razorpay.sendRenewalReminders(new Date((sub.charge_at - 30 * DAY) * 1000));
    expect(reminders()).toHaveLength(2);
  });

  it('a renewal still more than 30 days away waits; one found late (deploy day) is still told, down to 3 days before', async () => {
    yearly('sub_far', 31);
    yearly('sub_late', 10);
    yearly('sub_tomorrow', 2);
    const { razorpay } = setup([yearlyRow('sub_far'), yearlyRow('sub_late'), yearlyRow('sub_tomorrow')]);
    expect((await razorpay.sendRenewalReminders()).sent).toBe(1);
    expect(reminders()).toHaveLength(1);
  });

  it('never for a monthly plan, a plan set to end, a renewal Razorpay will not take, or another product', async () => {
    putSub('sub_month', { charge_at: nowSec() + 20 * DAY });
    yearly('sub_ending', 30);
    yearly('sub_halted', 30, { status: 'halted' });
    yearly('sub_cycle_end', 30, { has_scheduled_changes: false, end_at: nowSec() + 30 * DAY, remaining_count: 0 });
    yearly('sub_other', 30, { notes: { service: 'vetnow', orgId: ORG } });
    const { razorpay } = setup([
      putRow('sub_month'),
      yearlyRow('sub_ending', { cancelAt: new Date((nowSec() + 30 * DAY) * 1000) }),
      yearlyRow('sub_halted'),
      yearlyRow('sub_cycle_end'),
      yearlyRow('sub_other'),
    ]);
    await razorpay.sendRenewalReminders();
    expect(reminders()).toHaveLength(0);
  });

  it('break it (review): a yearly plan moved to a new mandate (Change payment method) is told too; a trial mandate is not', async () => {
    const at = nowSec() + 30 * DAY;
    yearly('sub_moved', 30, {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      paid_count: 0,
      start_at: at,
      charge_at: at,
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'YEARLY', replaces: 'sub_old_year' },
    });
    yearly('sub_trial_year', 30, {
      status: 'authenticated',
      current_start: null,
      current_end: null,
      paid_count: 0,
      start_at: at,
      charge_at: at,
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'YEARLY', replaces: 'sub_x', trial: '1' },
    });
    const { razorpay } = setup([yearlyRow('sub_moved'), yearlyRow('sub_trial_year')]);
    expect((await razorpay.sendRenewalReminders()).sent).toBe(1);
    expect(reminders()).toHaveLength(1);
  });

  it('break it: a plan change scheduled for the renewal is not announced at the old price', async () => {
    yearly('sub_down', 30, { has_scheduled_changes: true, change_scheduled_at: nowSec() + 30 * DAY });
    const { razorpay } = setup([yearlyRow('sub_down')]);
    await razorpay.sendRenewalReminders();
    expect(reminders()).toHaveLength(0);
  });

  it('never for a deleted workspace or an internal one', async () => {
    yearly('sub_year', 30);
    deletedOrgs.add(ORG);
    const { razorpay } = setup([yearlyRow('sub_year', { organization: { deletedAt: new Date() } })]);
    await razorpay.sendRenewalReminders();
    expect(reminders()).toHaveLength(0);
  });

  it('an amount it cannot read is not guessed: nothing sent, the next hour tries again', async () => {
    yearly('sub_year', 30);
    plans.delete(YEARLY);
    const { razorpay } = setup([yearlyRow('sub_year')]);
    expect((await razorpay.sendRenewalReminders()).sent).toBe(0);
    plans.set(YEARLY, { id: YEARLY, period: 'yearly', item: { amount: 599000, currency: 'INR' }, notes: { hookpost_key: buildPlanKey('STANDARD', 'YEARLY', 599000, 'INR') } });
    expect((await razorpay.sendRenewalReminders()).sent).toBe(1);
  });

  it('a Razorpay read that fails sends nothing and never throws', async () => {
    yearly('sub_year', 30);
    unreadable.add('sub_year');
    const { razorpay } = setup([yearlyRow('sub_year')]);
    expect(await razorpay.sendRenewalReminders()).toEqual({ checked: 1, sent: 0 });
  });

  it('a dollar plan is told in dollars', async () => {
    plans.set('plan_pro_usd_y', { id: 'plan_pro_usd_y', period: 'yearly', item: { amount: 49000, currency: 'USD' }, notes: { hookpost_key: buildPlanKey('PRO', 'YEARLY', 49000, 'USD') } });
    yearly('sub_usd', 30, { plan_id: 'plan_pro_usd_y', payment_method: 'card' });
    const { razorpay } = setup([yearlyRow('sub_usd', { subscriptionTier: 'PRO' })]);
    await razorpay.sendRenewalReminders();
    expect(reminders()[0].text).toContain('$490/year');
    expect(reminders()[0].subject).toContain('Pro plan');
  });
});
