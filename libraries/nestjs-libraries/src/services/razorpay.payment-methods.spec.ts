import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import {
  buildPlanKey,
  firstChargeNeverLanded,
  isTrialSubscription,
  mandateMethod,
  mandateRules,
  UNPAID_MANDATE_SETTLE_MS,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import {
  subscriptionCancelledEmail,
  subscriptionWelcomeEmail,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

// Every way a Razorpay subscription can be paid: card (domestic and
// international), UPI Autopay, bank e-mandate (netbanking, debit card,
// Aadhaar) and anything Razorpay may report later. What each one allows is in
// docs/billing-payment-methods.md; this pins the paths that differ by method:
// a plan change (only an international card is re-planned in place), a
// mandate the customer pauses in their UPI app or bank, and an e-mandate
// whose first debit never lands. Razorpay, Redis, Resend and the database are
// fakes; nothing leaves the machine.

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

// Redis with real SET NX semantics, so every send-once is exercised.
const redisData = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => redisData.get(key) ?? null),
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
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const invoices: any[] = [];
const payments = new Map<string, any>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
let clock = nowSec() - 400 * DAY;
const tick = () => (clock += 60);
/** Set to make PATCH /subscriptions/:id fail; it may apply the change first. */
let patchFault: null | ((sub: any, body: any) => never) = null;
let refuseCancel = false;

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
    const newestFirst = [...subs.values()].sort((a, b) => b.created_at - a.created_at);
    return { items: newestFirst.slice(0, Math.min(Number(q.get('count') || 10), 100)) };
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
    if (refuseCancel) throw new Error(`Razorpay POST ${path} failed (400): cannot cancel`);
    if (sub.status === 'cancelled') {
      throw new Error(`Razorpay POST ${path} failed (400): Subscription is already cancelled`);
    }
    sub.status = 'cancelled';
    sub.ended_at = nowSec();
    return { ...sub };
  }
  const pendingOf = base.match(/^\/subscriptions\/([^/]+)\/retrieve_scheduled_changes$/);
  if (method === 'GET' && pendingOf) {
    const sub = subs.get(pendingOf[1]);
    return { ...sub, plan_id: sub?.pendingPlan || sub?.plan_id };
  }
  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'GET') {
    const sub = subs.get(one[1]);
    if (!sub) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return { ...sub };
  }
  if (one && method === 'PATCH') {
    const sub = subs.get(one[1]);
    if (patchFault) patchFault(sub, body);
    // As the live API: the Update API takes no notes.
    if (body.notes) {
      throw new Error(`Razorpay PATCH ${path} failed (400): notes is/are not required and should not be sent`);
    }
    // As the live API: UPI and e-mandates cannot be updated at all, and a
    // domestic card only its offer.
    if (sub?.payment_method !== 'card' || !sub.internationalCard) {
      throw new Error(
        `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is ${sub?.payment_method}`
      );
    }
    Object.assign(
      sub,
      body.schedule_change_at === 'now'
        ? { plan_id: body.plan_id }
        : { has_scheduled_changes: true, pendingPlan: body.plan_id }
    );
    return { ...sub };
  }
  if (method === 'GET' && base === '/invoices') {
    const subId = q.get('subscription_id');
    return {
      items: invoices.filter(
        (i) => (!subId || i.subscription_id === subId) && (!q.get('customer_id') || i.customer_id === q.get('customer_id'))
      ),
    };
  }
  const pay = base.match(/^\/payments\/([^/]+)$/);
  if (method === 'GET' && pay) {
    const p = payments.get(pay[1]);
    if (!p) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return p;
  }
  if (method === 'GET' && base === '/refunds') return { items: [] };
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

/**
 * A paying Hookpost Standard subscription, mid-cycle, paid with `method`, its
 * last charge on file as an invoice and a payment (international for an
 * international card).
 */
function putPaying(id: string, method: string | null, extra: any = {}) {
  const international = method === 'card-intl';
  const paymentMethod = method === 'card-intl' ? 'card' : method;
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'active',
    plan_id: 'plan_std',
    customer_id: CUSTOMER,
    payment_method: paymentMethod,
    internationalCard: international,
    current_start: nowSec() - 10 * DAY,
    current_end: nowSec() + 20 * DAY,
    charge_at: nowSec() + 20 * DAY,
    end_at: nowSec() + 3650 * DAY,
    total_count: 120,
    remaining_count: 118,
    paid_count: 2,
    notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'MONTHLY' },
    ...extra,
  };
  subs.set(id, sub);
  const paymentId = `pay_${id}`;
  payments.set(paymentId, {
    id: paymentId,
    entity: 'payment',
    amount: 59900,
    currency: 'INR',
    status: 'captured',
    method: paymentMethod || 'upi',
    international,
    ...(paymentMethod === 'card' ? { card: { international, network: 'Visa' } } : {}),
  });
  invoices.push({
    id: `inv_${id}`,
    entity: 'invoice',
    subscription_id: id,
    customer_id: CUSTOMER,
    payment_id: paymentId,
    status: 'paid',
    amount: 59900,
    billing_start: sub.current_start,
    billing_end: sub.current_end,
    paid_at: sub.current_start,
    created_at: sub.current_start,
  });
  return sub;
}

function setup(row: any) {
  let stored: any = row
    ? { organizationId: ORG, cancelAt: null, isLifetime: false, period: 'MONTHLY', paymentFailingSince: null, ...row }
    : null;
  let trialing = false;
  const subscriptions = {
    getSubscription: jest.fn(async () => stored),
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
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date | null) => {
      if (stored?.identifier === identifier) stored = { ...stored, cancelAt: at };
    }),
    getLapsedCancellations: jest.fn(async (now: Date) =>
      stored?.cancelAt && stored.cancelAt.getTime() < now.getTime() ? [stored] : []
    ),
    getRazorpayPlanRows: jest.fn(async () =>
      stored ? [{ ...stored, organization: { deletedAt: null } }] : []
    ),
    updateCustomerId: jest.fn(async () => undefined),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    redeemCouponByCode: jest.fn(async () => undefined),
    markPaymentFailing: jest.fn(async () => 1),
    clearPaymentFailing: jest.fn(async () => 0),
    trialDaysFor: jest.fn(async (_org: string, base: number) => base),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: 'Chai Point Social',
      paymentId: CUSTOMER,
      isTrailing: trialing,
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
  return { razorpay, subscriptions, row: () => stored, trialing: () => trialing };
}

const webhook = (razorpay: RazorpayService, event: string, sub: any) =>
  razorpay.handleWebhook({ event, payload: { subscription: { entity: { ...sub } } } });
const patches = () => calls.filter((c) => c.method === 'PATCH');
const created = () => calls.filter((c) => c.method === 'POST' && c.path === '/subscriptions');
const cancels = () =>
  calls.filter((c) => c.method === 'POST' && /\/cancel$/.test(c.path)).map((c) => c.path.split('/')[2]);
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

beforeAll(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
});

beforeEach(() => {
  plans.clear();
  subs.clear();
  invoices.length = 0;
  payments.clear();
  calls.length = 0;
  redisData.clear();
  sent.length = 0;
  patchFault = null;
  refuseCancel = false;
  mockRequest.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  delete process.env.RAZORPAY_OFFER_ID;
  putPlan('plan_std', 'STANDARD', 59900);
  putPlan('plan_pro', 'PRO', 199900);
});

afterEach(() => settle());

afterAll(() => {
  delete process.env.RESEND_API_KEY;
});

describe('mandateRules(): what each payment method allows', () => {
  it('names every method Razorpay reports, and anything else is unknown', () => {
    expect(mandateMethod('card')).toBe('card');
    expect(mandateMethod('UPI')).toBe('upi');
    expect(mandateMethod('emandate')).toBe('emandate');
    expect(mandateMethod('nach')).toBe('emandate');
    for (const other of ['wallet', 'netbanking', 'paylater', '', null, undefined]) {
      expect(mandateMethod(other)).toBe('unknown');
    }
  });

  it('only an international card is re-planned in place; a domestic or unproven card, UPI, e-mandate and unknown are not', () => {
    expect(mandateRules('card', { internationalCard: true }).replanInPlace).toBe(true);
    expect(mandateRules('card', { internationalCard: false }).replanInPlace).toBe(false);
    expect(mandateRules('card', { internationalCard: null }).replanInPlace).toBe(false);
    expect(mandateRules('card').replanInPlace).toBe(false);
    for (const m of ['upi', 'emandate', 'nach', 'wallet', null]) {
      expect(mandateRules(m, { internationalCard: true }).replanInPlace).toBe(false);
    }
  });

  it('says how each mandate is stopped outside Hookpost', () => {
    expect(mandateRules('upi').stopOutside).toMatch(/UPI app/);
    expect(mandateRules('card').stopOutside).toMatch(/card portal/);
    expect(mandateRules('emandate').stopOutside).toMatch(/through your bank/);
    expect(mandateRules('wallet').stopOutside).toBeNull();
  });
});

describe('isTrialSubscription(): a plan paid at once is never a trial, whatever the method', () => {
  const t0 = nowSec();
  const base = { status: 'authenticated', created_at: t0, paid_count: 0, notes: { service: 'hookpost' } };

  it('an e-mandate checkout waiting a banking day for its first debit (no start_at) is not a trial', () => {
    expect(isTrialSubscription({ ...base, payment_method: 'emandate', start_at: null })).toBe(false);
    expect(isTrialSubscription({ ...base, payment_method: 'emandate', start_at: t0 + 60 })).toBe(false);
  });

  it('a trial (start_at days after creation), and a switch during one (notes.trial), still are', () => {
    expect(isTrialSubscription({ ...base, start_at: t0 + 7 * DAY })).toBe(true);
    expect(isTrialSubscription({ ...base, start_at: null, notes: { replaces: 'sub_x', trial: '1' } })).toBe(true);
    // An older payload without created_at is judged on start_at alone, as before.
    expect(isTrialSubscription({ ...base, created_at: undefined, start_at: t0 + 7 * DAY })).toBe(true);
    // A Reactivate / Change payment method mandate is not.
    expect(isTrialSubscription({ ...base, start_at: t0 + 20 * DAY, notes: { replaces: 'sub_x' } })).toBe(false);
  });
});

describe('firstChargeNeverLanded(): an e-mandate whose first debit failed', () => {
  const t0 = nowSec();
  const created = (extra: any = {}) => ({
    status: 'created',
    paid_count: 0,
    created_at: t0 - UNPAID_MANDATE_SETTLE_MS / 1000 - 3600,
    notes: { service: 'hookpost' },
    ...extra,
  });

  it('is true only for a never-paid `created` subscription older than the settle time', () => {
    expect(firstChargeNeverLanded(created(), t0)).toBe(true);
    expect(firstChargeNeverLanded(created({ created_at: t0 - 2 * DAY }), t0)).toBe(false);
    expect(firstChargeNeverLanded(created({ paid_count: 1 }), t0)).toBe(false);
    expect(firstChargeNeverLanded(created({ status: 'authenticated' }), t0)).toBe(false);
    expect(firstChargeNeverLanded(created({ notes: { replaces: 'sub_old' } }), t0)).toBe(false);
    expect(firstChargeNeverLanded(created({ created_at: 0 }), t0)).toBe(false);
    // A trial or free-months coupon whose first charge is still ahead has not failed.
    expect(firstChargeNeverLanded(created({ start_at: t0 + DAY }), t0)).toBe(false);
    expect(firstChargeNeverLanded(created({ start_at: t0 - DAY }), t0)).toBe(true);
  });
});

describe('plan change by payment method: the preview and the change take the same route', () => {
  const upgrade = { billing: 'PRO', period: 'MONTHLY' } as any;

  it.each([
    ['UPI', 'upi'],
    ['bank e-mandate', 'emandate'],
    ['domestic card', 'card'],
    ['a method Razorpay may add later', 'wallet'],
    ['no method reported yet', null],
  ])('%s: a new mandate, never a PATCH', async (_label, method) => {
    putPaying('sub_std', method);
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const quote: any = await razorpay.prorate(ORG, upgrade);
    expect(quote.mode).toBe('new_mandate');

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(patches()).toHaveLength(0);
    expect(created()).toHaveLength(1);
    expect(created()[0].body.notes).toMatchObject({ replaces: 'sub_std', change: 'upgrade' });
    expect(res.subscriptionId || res.id).toBeTruthy();
    // The old mandate stays until the new one is approved: never two charges
    // for the same days, never a workspace without a mandate.
    expect(cancels()).toEqual([]);
  });

  it('international card: re-planned in place, no second mandate', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const quote: any = await razorpay.prorate(ORG, upgrade);
    expect(quote.mode).toBe('in_place');

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(res).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });
    expect(patches()).toHaveLength(1);
    expect(created()).toHaveLength(0);
    expect(row()).toMatchObject({ identifier: 'sub_std', subscriptionTier: 'PRO' });
  });

  it('international card, PATCH times out after Razorpay applied it: read back, done, no second mandate', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    patchFault = (sub, body) => {
      sub.plan_id = body.plan_id;
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed: socket hang up');
    };

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(res).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });
    expect(created()).toHaveLength(0);
    expect(row().subscriptionTier).toBe('PRO');
  });

  it('international card, a 5xx with nothing applied: refused for now, and no second mandate is opened', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (502): bad gateway');
    };

    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toMatchObject({
      response: { code: 'RAZORPAY_NO_ANSWER' },
    });
    expect(created()).toHaveLength(0);
    expect(row().subscriptionTier).toBe('STANDARD');
  });

  it('international card downgrade, PATCH times out after Razorpay scheduled it: read from the pending update, done', async () => {
    putPlan('plan_pro_live', 'PRO', 199900);
    putPaying('sub_pro', 'card-intl', { plan_id: 'plan_pro_live' });
    const { razorpay } = setup({ identifier: 'sub_pro', subscriptionTier: 'PRO' });
    patchFault = (sub, body) => {
      sub.has_scheduled_changes = true;
      sub.pendingPlan = body.plan_id;
      throw new Error('Razorpay PATCH /subscriptions/sub_pro failed: ETIMEDOUT');
    };

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', { billing: 'STANDARD', period: 'MONTHLY' } as any, false);
    expect(res).toMatchObject({ direction: 'downgrade', effectiveAt: 'cycle_end' });
    expect(created()).toHaveLength(0);
  });

  it('international card downgrade, a 5xx and an older change pending: not mistaken for this one, refused', async () => {
    putPlan('plan_pro_live', 'PRO', 199900);
    putPaying('sub_pro', 'card-intl', { plan_id: 'plan_pro_live', has_scheduled_changes: true, pendingPlan: 'plan_somewhere_else' });
    const { razorpay } = setup({ identifier: 'sub_pro', subscriptionTier: 'PRO' });
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_pro failed (503): unavailable');
    };

    await expect(
      razorpay.subscribe('u1', ORG, 'user-1', { billing: 'STANDARD', period: 'MONTHLY' } as any, false)
    ).rejects.toMatchObject({ response: { code: 'RAZORPAY_NO_ANSWER' } });
    expect(created()).toHaveLength(0);
  });

  it('international card, a 408 (Razorpay: ask again later) with nothing applied: refused, no second mandate', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (408): request timeout');
    };

    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toMatchObject({
      response: { code: 'RAZORPAY_NO_ANSWER' },
    });
    expect(created()).toHaveLength(0);
  });

  it('the retry after a no-answer finds the earlier PATCH landed late: done, no second PATCH or charge', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    let landed = '';
    patchFault = (_sub, body) => {
      landed = body.plan_id;
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (502): bad gateway');
    };
    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toBeTruthy();
    // It lands after the read-back; the customer presses the button again.
    subs.get('sub_std').plan_id = landed;
    patchFault = null;
    calls.length = 0;

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(res).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });
    expect(patches()).toHaveLength(0);
    expect(created()).toHaveLength(0);
    expect(row().subscriptionTier).toBe('PRO');
  });

  it('a PATCH Razorpay keeps failing (test mode: 500 on a foreign card): nothing re-sent for 2 minutes, then the new-mandate route', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (500): The server encountered an error');
    };
    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toMatchObject({
      response: { code: 'RAZORPAY_NO_ANSWER' },
    });
    expect(patches()).toHaveLength(1);

    // Pressed again at once: the first may still land, so nothing is sent.
    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toMatchObject({
      response: { code: 'RAZORPAY_NO_ANSWER' },
    });
    expect(patches()).toHaveLength(1);
    expect(created()).toHaveLength(0);

    // Three minutes on, still on Standard: it never landed. Quote and change
    // both take the new-mandate route.
    redisData.set('razorpay:patch-no-answer:sub_std', String(Date.now() - 3 * 60_000));
    expect(((await razorpay.prorate(ORG, upgrade)) as any).mode).toBe('new_mandate');
    await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(patches()).toHaveLength(1);
    expect(created()).toHaveLength(1);
    expect(created()[0].body.notes).toMatchObject({ replaces: 'sub_std', change: 'upgrade' });
  });

  it('a PATCH with no answer that lands after the 2 minutes: found on the mandate, never a new mandate beside it', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    let landed = '';
    patchFault = (_sub, body) => {
      landed = body.plan_id;
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (504): gateway timeout');
    };
    await expect(razorpay.subscribe('u1', ORG, 'user-1', upgrade, false)).rejects.toBeTruthy();
    subs.get('sub_std').plan_id = landed;
    redisData.set('razorpay:patch-no-answer:sub_std', String(Date.now() - 5 * 60_000));
    patchFault = null;

    const res: any = await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(res).toMatchObject({ direction: 'upgrade', effectiveAt: 'now' });
    expect(created()).toHaveLength(0);
    expect(patches()).toHaveLength(1);
    expect(row().subscriptionTier).toBe('PRO');
    expect(redisData.has('razorpay:patch-no-answer:sub_std')).toBe(false);
  });

  it('international card that Razorpay refuses anyway (4xx): nothing moved, so a new mandate is opened', async () => {
    putPaying('sub_std', 'card-intl');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    patchFault = () => {
      throw new Error('Razorpay PATCH /subscriptions/sub_std failed (400): not allowed');
    };

    await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(created()).toHaveLength(1);
  });

  it('a card whose payment cannot be read is not assumed international', async () => {
    putPaying('sub_std', 'card-intl');
    payments.clear();
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    expect(((await razorpay.prorate(ORG, upgrade)) as any).mode).toBe('new_mandate');
    await razorpay.subscribe('u1', ORG, 'user-1', upgrade, false);
    expect(patches()).toHaveLength(0);
  });
});

describe('subscription.paused: the customer paused AutoPay in their UPI app or bank', () => {
  it.each(['upi', 'card', 'card-intl'])(
    '%s: cancelled at Razorpay now, the time paid for is kept, one email naming the pause, one owner alert',
    async (method) => {
      const sub = putPaying('sub_std', method);
      const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
      sub.status = 'paused';

      await webhook(razorpay, 'subscription.paused', sub);
      await settle();

      expect(cancels()).toEqual(['sub_std']);
      expect(subs.get('sub_std').status).toBe('cancelled');
      expect(row()).toMatchObject({ identifier: 'sub_std' });
      expect(row().cancelAt.getTime()).toBe(sub.current_end * 1000);
      const mails = sent.filter((m) => /cancelled/i.test(m.subject));
      expect(mails).toHaveLength(1);
      expect(mails[0].html).toMatch(/paused AutoPay/);

      // Redelivered, and the subscription.cancelled that follows: nothing more.
      await webhook(razorpay, 'subscription.paused', sub);
      await webhook(razorpay, 'subscription.cancelled', subs.get('sub_std'));
      await settle();
      expect(cancels()).toEqual(['sub_std']);
      expect(sent.filter((m) => /cancelled/i.test(m.subject))).toHaveLength(1);
      expect(row().cancelAt.getTime()).toBe(sub.current_end * 1000);
    }
  );

  it('a resume in the app afterwards charges nothing: the mandate is cancelled', async () => {
    const sub = putPaying('sub_std', 'upi');
    const { razorpay } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    sub.status = 'paused';
    await webhook(razorpay, 'subscription.paused', sub);
    expect(await webhook(razorpay, 'subscription.resumed', { ...sub, status: 'active' })).toEqual({ ok: true });
    expect(subs.get('sub_std').status).toBe('cancelled');
  });

  it('a pause that has since been undone, another workspace’s or another product’s does nothing', async () => {
    const sub = putPaying('sub_std', 'upi');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    // Webhook says paused, Razorpay now says active again.
    await webhook(razorpay, 'subscription.paused', { ...sub, status: 'paused' });
    const other = putPaying('sub_other', 'upi', { notes: { service: 'hookpost', orgId: 'org-other' }, status: 'paused' });
    await webhook(razorpay, 'subscription.paused', other);
    const foreign = putPaying('sub_vet', 'upi', { notes: { service: 'vetnow' }, status: 'paused' });
    await webhook(razorpay, 'subscription.paused', foreign);

    expect(cancels()).toEqual([]);
    expect(row().cancelAt).toBeNull();
  });

  it('Razorpay refuses the cancel: the plan ends when the paid time does, and the sweep stops the mandate then', async () => {
    const sub = putPaying('sub_std', 'upi');
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });
    sub.status = 'paused';
    refuseCancel = true;

    await webhook(razorpay, 'subscription.paused', sub);
    expect(row().cancelAt.getTime()).toBe(sub.current_end * 1000);
    expect(sub.status).toBe('paused');

    // The paid time runs out, still paused: cancelled and ended.
    refuseCancel = false;
    const later = new Date((sub.current_end + 60) * 1000);
    jest.useFakeTimers({ now: later, doNotFake: ['setImmediate', 'nextTick'] });
    try {
      await razorpay.endLapsedCancellations(later);
    } finally {
      jest.useRealTimers();
    }
    expect(subs.get('sub_std').status).toBe('cancelled');
    expect(row()).toBeNull();
  });

  it('the paused webhook never arrived: the hourly guard finds the paused mandate and stops it the same way', async () => {
    putPaying('sub_std', 'upi', { status: 'paused' });
    const { razorpay, row } = setup({ identifier: 'sub_std', subscriptionTier: 'STANDARD' });

    const dry = await razorpay.reconcileBilling({ dryRun: true });
    expect(dry.stoppedUnpaid).toEqual(['sub_std']);
    expect(cancels()).toEqual([]);

    const report = await razorpay.reconcileBilling();
    expect(report.stoppedUnpaid).toEqual(['sub_std']);
    expect(cancels()).toEqual(['sub_std']);
    expect(row().cancelAt).not.toBeNull();
  });
});

describe('bank e-mandate: the first debit lands a banking day after checkout', () => {
  /** A Standard e-mandate checkout, approved, its debit not yet taken. */
  const putEmandate = (status: string, ageSec: number) => {
    const sub = {
      id: 'sub_nach',
      entity: 'subscription',
      created_at: nowSec() - ageSec,
      status,
      plan_id: 'plan_std',
      customer_id: CUSTOMER,
      payment_method: 'emandate',
      start_at: null,
      charge_at: nowSec() - ageSec + DAY,
      current_start: null,
      current_end: null,
      total_count: 120,
      remaining_count: 120,
      paid_count: 0,
      end_at: nowSec() + 3650 * DAY,
      notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD', period: 'MONTHLY' },
    };
    subs.set(sub.id, sub);
    return sub;
  };

  it('waiting for the debit, the workspace is on its paid plan, not a trial', async () => {
    const sub = putEmandate('authenticated', 3600);
    const { razorpay, row, trialing } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', sub);
    expect(row()).toMatchObject({ identifier: 'sub_nach', subscriptionTier: 'STANDARD' });
    expect(trialing()).toBe(false);
    // Its first debit is about a day out, but the welcome is a plan's, not a trial's.
    await settle();
    expect(sent.map((m) => m.subject)).toEqual(['Welcome to Hookpost Standard']);
  });

  it('the debit failed on every retry (halted): ended, and told the plan did not start, not that a trial ended', async () => {
    const sub = putEmandate('halted', 5 * DAY);
    const { razorpay, row } = setup({ identifier: 'sub_nach', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.halted', sub);
    await settle();
    expect(row()).toBeNull();
    const subjects = sent.map((m) => m.subject);
    expect(subjects.some((s) => /didn't start/.test(s))).toBe(true);
    expect(subjects.some((s) => /trial/i.test(s))).toBe(false);
  });

  it('the debit failed and Razorpay left it `created` with no webhook: the guard ends it once it is a week old', async () => {
    putEmandate('created', 2 * DAY);
    const { razorpay, row } = setup({ identifier: 'sub_nach', subscriptionTier: 'STANDARD' });
    expect((await razorpay.reconcileBilling()).stoppedUnpaid).toEqual([]);
    expect(row()).not.toBeNull();

    subs.get('sub_nach').created_at = nowSec() - 8 * DAY;
    const report = await razorpay.reconcileBilling();
    await settle();
    expect(report.stoppedUnpaid).toEqual(['sub_nach']);
    expect(cancels()).toEqual(['sub_nach']);
    expect(row()).toBeNull();
    expect(sent.filter((m) => /didn't start/.test(m.subject))).toHaveLength(1);

    // Next hour: nothing left to do, nothing sent again.
    await razorpay.reconcileBilling();
    await settle();
    expect(sent.filter((m) => /didn't start/.test(m.subject))).toHaveLength(1);
  });
});

describe('the emails name the right way to stop each mandate', () => {
  it.each([
    ['upi', /revoked from your UPI app/],
    ['card', /card portal/],
    ['emandate', /cancelled through your bank/],
  ])('a %s trial is told how to stop that mandate', (paymentMethod, line) => {
    const html = subscriptionWelcomeEmail({
      orgName: 'Chai',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
      trialDays: 7,
      firstChargeAt: new Date(Date.now() + 7 * 86400_000),
      charge: { amount: 599, currency: 'INR', period: 'MONTHLY', paymentMethod },
    }).html;
    expect(html).toMatch(line);
  });

  it('a dollar trial names no rupee mandate', () => {
    const html = subscriptionWelcomeEmail({
      orgName: 'Chai',
      billing: 'STANDARD',
      channels: 5,
      period: 'MONTHLY',
      isTrial: true,
      trialDays: 7,
      firstChargeAt: new Date(Date.now() + 7 * 86400_000),
      charge: { amount: 19, currency: 'USD', period: 'MONTHLY', paymentMethod: 'card' },
    }).html;
    expect(html).not.toMatch(/UPI app|card portal|through your bank/);
  });

  it('a pause is named in the cancel email; an ordinary cancel is not', () => {
    const base = { orgName: 'Chai', billing: 'STANDARD', accessUntil: new Date(Date.now() + 9 * 86400_000) };
    expect(subscriptionCancelledEmail({ ...base, pausedByCustomer: true }).html).toMatch(/paused AutoPay/);
    expect(subscriptionCancelledEmail(base).html).not.toMatch(/paused AutoPay/);
  });
});
