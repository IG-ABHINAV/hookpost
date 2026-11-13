import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

// A bank reported a dispute (chargeback) on a payment: the plan ends at once,
// exactly as a refund ends it, and the workspace is locked out of checkout
// until the owner clears it (RazorpayService.handleDispute, the owner's rule
// of 29 Oct 2026). RazorpayService and OwnerSalesAlertService are real;
// Razorpay, Redis, Resend and the database are fakes. Nothing leaves the
// machine, and no money moves.
//
// The dispute entities below are Razorpay's own documented payload
// (razorpay.com/docs/webhooks/disputes): payload.dispute.entity with
// payment_id, amount, currency, amount_deducted, reason_code, respond_by,
// status, phase and created_at, beside a payload.payment.entity whose
// invoice_id is null and whose notes are an empty array.

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
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service',
  () => ({ SignupAttributionService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);

// Redis with real SET NX semantics, so a redelivered event races the first.
const redisData = new Map<string, string>();
const redisList: string[] = [];
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      await new Promise((r) => setImmediate(r));
      if (args.includes('NX') && redisData.has(key)) return null;
      redisData.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
    get: jest.fn(async (key: string) => redisData.get(key) ?? null),
    rpush: jest.fn(async (_key: string, value: string) => redisList.push(value)),
    lpop: jest.fn(async () => redisList.shift() ?? null),
    expire: jest.fn(async () => 1),
  },
}));

const OWNER = 'owner@example.com';
const CUSTOMER_EMAIL = 'testpayer@example.in';
const sent: any[] = [];
const mockSend = jest.fn(async (msg: any) => {
  sent.push(msg);
  return { data: { id: `email_${sent.length}` }, error: null };
});
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })),
}));

const ORG = 'org-02c7';
const CUSTOMER = 'cust_TrORHaB3MerOdN';
const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

const plans = new Map<string, any>();
const subs = new Map<string, any>();
const invoices = new Map<string, any>();
const payments = new Map<string, any>();
let clock = nowSec() - 30 * DAY;
const tick = () => (clock += 60);

/** Subscription ids Razorpay refuses to answer GET for (an outage). */
const unreadableSubs = new Set<string>();
/** Subscription ids whose POST /cancel Razorpay refuses. */
const cancelRefused = new Set<string>();
const calls: Array<{ method: string; path: string; body?: any }> = [];
/** Every dispute on the account, as GET /disputes lists them. */
const disputesOnAccount: any[] = [];
/** GET /disputes answers 5xx (an outage). */
let disputeListFails = false;

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  calls.push({ method, path, body });
  const [base, query] = path.split('?');
  const q = new URLSearchParams(query || '');

  if (method === 'GET' && base === '/disputes') {
    if (disputeListFails) throw new Error(`Razorpay GET ${path} failed (502): bad gateway`);
    const from = Number(q.get('from') || 0);
    const to = Number(q.get('to') || Infinity);
    const count = Math.min(Number(q.get('count') || 10), 100);
    const skip = Number(q.get('skip') || 0);
    const items = disputesOnAccount
      .filter((d) => d.created_at >= from && d.created_at <= to)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(skip, skip + count);
    // The live API leaves items out when there are none.
    return items.length
      ? { entity: 'collection', count: items.length, items }
      : { entity: 'collection', has_more: false };
  }
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
  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const sub = subs.get(cancel[1]);
    if (!sub) throw new Error(`Razorpay POST ${path} failed (404): not found`);
    if (cancelRefused.has(sub.id)) {
      throw new Error(`Razorpay POST ${path} failed (500): we are down`);
    }
    // The live API takes one cancel per subscription and nothing after it.
    if (sub.status === 'cancelled') {
      throw new Error(
        `Razorpay POST ${path} failed (400): Subscription is already cancelled`
      );
    }
    sub.status = 'cancelled';
    sub.ended_at = nowSec();
    return { ...sub };
  }
  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'GET') {
    if (unreadableSubs.has(one[1])) {
      throw new Error(`Razorpay GET ${path} failed (500): we are down`);
    }
    const sub = subs.get(one[1]);
    if (!sub) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return { ...sub };
  }
  const inv = base.match(/^\/invoices\/([^/]+)$/);
  if (inv && method === 'GET') {
    const i = invoices.get(inv[1]);
    if (!i) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return { ...i };
  }
  const pay = base.match(/^\/payments\/([^/]+)$/);
  if (pay && method === 'GET') {
    const p = payments.get(pay[1]);
    if (!p) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return { ...p };
  }
  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

function putPlan(id: string, billing: string, amount: number, period = 'MONTHLY') {
  plans.set(id, {
    id,
    period: period === 'YEARLY' ? 'yearly' : 'monthly',
    item: { amount, currency: 'INR' },
    notes: { hookpost_key: buildPlanKey(billing, period, amount, 'INR') },
  });
}

/** A live, paid Hookpost subscription of ORG. */
function live(id = 'sub_live', extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'active',
    plan_id: 'plan_Td8GtJPijo5TQF',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    current_start: nowSec() - DAY,
    current_end: nowSec() + 29 * DAY,
    paid_count: 1,
    end_at: nowSec() + 3650 * DAY,
    notes: {
      service: 'hookpost',
      billing: 'STANDARD',
      period: 'MONTHLY',
      currency: 'INR',
      orgId: ORG,
      userId: 'user-testpayer',
    },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

/**
 * A captured payment of `sub`, with the invoice that ties the two together:
 * the only road from a disputed payment back to its subscription, because
 * Razorpay's dispute webhook carries the payment with notes [].
 */
function paymentOf(
  subId: string | null,
  id: string,
  amount = 59900,
  extra: any = {}
) {
  const invoiceId = subId ? `inv_${id}` : null;
  if (subId && invoiceId) {
    invoices.set(invoiceId, {
      id: invoiceId,
      entity: 'invoice',
      subscription_id: subId,
      payment_id: id,
    });
  }
  const p = {
    id,
    entity: 'payment',
    amount,
    currency: 'INR',
    status: 'captured',
    method: 'card',
    invoice_id: invoiceId,
    email: CUSTOMER_EMAIL,
    contact: '+919900000000',
    card: { last4: '4242', network: 'Visa', name: 'TEST K', issuer: 'HDFC' },
    bank: 'HDFC',
    token_id: 'token_secret_abc',
    acquirer_data: { rrn: '000000000004' },
    amount_refunded: 0,
    refund_status: null,
    notes: {},
    created_at: nowSec() - 2 * DAY,
    ...extra,
  };
  payments.set(id, p);
  return p;
}

/** Razorpay's documented dispute entity. */
function dispute(paymentId: string, extra: any = {}) {
  return {
    id: 'disp_EsIAlDcoUr8CaQ',
    entity: 'dispute',
    payment_id: paymentId,
    amount: 59900,
    currency: 'INR',
    amount_deducted: 0,
    reason_code: 'processed_invalid_expired_card',
    respond_by: nowSec() + 7 * DAY,
    status: 'open',
    phase: 'chargeback',
    created_at: nowSec(),
    evidence: { amount: 59900, summary: null, submitted_at: null },
    ...extra,
  };
}

/**
 * The webhook as Razorpay posts it: the dispute and the payment, and never a
 * subscription entity. The payment it carries has invoice_id null and notes
 * [], so the handler has to read the payment back from the API.
 */
const disputeWebhook = (
  razorpay: RazorpayService,
  event: string,
  disp: any,
  payOverrides: any = {}
) =>
  razorpay.handleWebhook({
    entity: 'event',
    account_id: 'acc_CFvOKjkTwf3GQy',
    event,
    contains: ['payment', 'dispute'],
    payload: {
      payment: {
        entity: {
          ...(payments.get(disp.payment_id) || { id: disp.payment_id }),
          invoice_id: null,
          notes: [],
          ...payOverrides,
        },
      },
      dispute: { entity: disp },
    },
    created_at: nowSec(),
  });

function setup(
  row: any,
  opts: { internal?: boolean; markThrows?: boolean } = {}
) {
  let stored: any = row
    ? {
        organizationId: ORG,
        cancelAt: null,
        isLifetime: false,
        period: 'MONTHLY',
        ...row,
      }
    : null;
  /** Organization.disputedAt and friends, as markDisputed writes them. */
  let disputed: {
    disputedAt: Date;
    disputeReason: string;
    disputePaymentId: string;
  } | null = null;
  /** What the admin's clear leaves behind (OrganizationRepository.clearDispute). */
  let cleared: { disputeClearedAt: Date; disputePaymentId: string } | null = null;

  const subscriptions = {
    getSubscription: jest.fn(async () => stored),
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      stored && stored.identifier === id ? stored : null
    ),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    scheduleCancellation: jest.fn(async () => undefined),
    createOrUpdateSubscription: jest.fn(async () => undefined),
    updateCustomerId: jest.fn(async () => undefined),
    getPolicyOrg: jest.fn(async () => ({ platformAdmin: !!opts.internal })),
    inNewCohort: jest.fn(async () => false),
    getFreePlanSunsetAt: jest.fn(async () => null),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: "Test Payer's workspace",
      paymentId: CUSTOMER,
    })),
    getTeam: jest.fn(async () => ({
      users: [{ user: { id: 'user-testpayer', email: CUSTOMER_EMAIL } }],
    })),
    // The real repository's updateMany({ where: { disputedAt: null } }):
    // the first dispute wins and a second event changes nothing.
    markDisputed: jest.fn(
      async (
        _orgId: string,
        d: { reason: string; paymentId: string; at: Date }
      ) => {
        if (opts.markThrows) throw new Error('database is down');
        if (disputed) return false;
        disputed = {
          disputedAt: d.at,
          disputeReason: d.reason,
          disputePaymentId: d.paymentId,
        };
        return true;
      }
    ),
    getDispute: jest.fn(async () =>
      disputed
        ? { ...disputed, disputeClearedAt: null }
        : cleared
        ? { disputedAt: null, ...cleared }
        : { disputedAt: null, disputePaymentId: null, disputeClearedAt: null }
    ),
    clearDispute: jest.fn(async (_orgId?: string, _by?: string) => {
      if (!disputed) return false;
      cleared = { disputeClearedAt: new Date(), disputePaymentId: disputed.disputePaymentId };
      disputed = null;
      return true;
    }),
  };
  const orgRepository = {
    getSaleAlertFacts: jest.fn(async () => ({
      attribution: { method: 'google', utmSource: 'google', country: 'IN' },
      id: ORG,
      name: "Test Payer's workspace",
      createdAt: new Date('2026-10-23T15:05:00Z'),
      users: [
        {
          role: 'SUPERADMIN',
          user: {
            id: 'user-testpayer',
            email: CUSTOMER_EMAIL,
            name: 'Test',
            lastName: 'Payer',
            signupCountry: 'IN',
            isSuperAdmin: !!opts.internal,
            deletedAt: null,
          },
        },
      ],
    })),
  };
  const ownerAlerts = new OwnerSalesAlertService(orgRepository as any);
  ownerAlerts.retryDelaysMs = [0, 1, 1];
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    { track: jest.fn(async () => undefined) } as any,
    { recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined) } as any,
    { markPaid: jest.fn(async () => undefined) } as any,
    ownerAlerts
  );
  return {
    razorpay,
    subscriptions,
    organizations,
    row: () => stored,
    dispute: () => disputed,
    /** The workspace buys a plan again (after the admin cleared it). */
    setRow: (r: any) => {
      stored = r ? { organizationId: ORG, cancelAt: null, isLifetime: false, period: 'MONTHLY', ...r } : null;
    },
  };
}

/** Let the fire-and-forget alerts and emails land. */
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const toOwner = () => sent.filter((m) => [m.to].flat().includes(OWNER));
const toCustomer = () => sent.filter((m) => [m.to].flat().includes(CUSTOMER_EMAIL));
const cancelsOf = (id: string) =>
  calls.filter((c) => c.method === 'POST' && c.path === `/subscriptions/${id}/cancel`);

beforeEach(() => {
  plans.clear();
  subs.clear();
  invoices.clear();
  payments.clear();
  redisData.clear();
  redisList.length = 0;
  sent.length = 0;
  calls.length = 0;
  unreadableSubs.clear();
  cancelRefused.clear();
  disputesOnAccount.length = 0;
  disputeListFails = false;
  mockSend.mockClear();
  mockRequest.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  process.env.OWNER_SALES_ALERT_EMAIL = OWNER;
  process.env.RAZORPAY_KEY_ID = 'rzp_live_unit';
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
  putPlan('plan_Td8GtJPijo5TQF', 'STANDARD', 59900);
  putPlan('plan_pro', 'PRO', 199900);
});

afterEach(() => settle());

afterAll(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_SALES_ALERT_EMAIL;
  delete process.env.RAZORPAY_KEY_ID;
});

describe('a dispute ends the plan, like a refund', () => {
  it('payment.dispute.created: Razorpay cancelled now, plan row gone, workspace disputed, owner and customer told', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', d);
    await settle();

    // Cancelled at Razorpay with no paid time kept.
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(cancelsOf('sub_live')[0].body).toEqual({ cancel_at_cycle_end: 0 });
    expect(subs.get('sub_live').status).toBe('cancelled');
    // The plan row is gone: no grace, no access.
    expect(row()).toBeNull();
    // The workspace is marked, with the reason and the payment.
    expect(mark()).toMatchObject({
      disputeReason: 'processed_invalid_expired_card',
      disputePaymentId: 'pay_EFtmUsbwpXwBHI',
    });
    expect(mark()!.disputedAt.getTime()).toBe(d.created_at * 1000);
  });

  it("the owner's alert carries the amount, the reason code, the respond-by date and the links", async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(toOwner()).toHaveLength(1);
    const [m] = toOwner();
    expect(m.subject).toContain('Payment dispute');
    expect(m.subject).toContain('Payment dispute: Standard monthly, ₹599, disputed, respond within');
    expect(m.text).toMatch(/Amount: ₹599, disputed, respond within/);
    expect(m.text).toContain('Reason code processed_invalid_expired_card');
    expect(m.text).toContain('Respond within 3 business days (by ');
    // The deadline is in the subject while the dispute awaits our answer.
    expect(m.subject).toContain('respond within 3 business days (by ');
    expect(m.text).toContain('Dispute open, phase chargeback');
    expect(m.text).toContain('Razorpay dispute: disp_EsIAlDcoUr8CaQ');
    expect(m.text).toContain(
      'https://dashboard.razorpay.com/app/disputes/disp_EsIAlDcoUr8CaQ'
    );
    expect(m.text).toContain(`Workspace id: ${ORG}`);
    expect(m.text).toContain('The plan ended now and the subscription is cancelled at Razorpay.');
    // Never the customer's card or bank details.
    expect(m.text).not.toContain('4242');
    expect(m.text).not.toContain('token_secret_abc');
  });

  it('the customer gets one short neutral note, and never an invitation to buy again', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(toCustomer().map((m) => m.subject)).toEqual(['Your Hookpost plan has ended']);
    const [m] = toCustomer();
    expect(m.text).toContain('dispute');
    expect(m.text).toContain('pay_EFtmUsbwpXwBHI');
    expect(m.text).toContain('support@hookstep.in');
    // Neutral: it never accuses the customer of fraud, and never sells.
    expect(m.text.toLowerCase()).not.toContain('fraud');
    expect(m.text.toLowerCase()).not.toContain('resubscribe');
    expect([m.to].flat()).toEqual([CUSTOMER_EMAIL]);
  });

  it('a dollar (international) payment goes down the same road: the rail is the same Razorpay one', async () => {
    const sub = live('sub_usd', {
      notes: { ...live('sub_seed').notes, currency: 'USD', orgId: ORG },
    });
    subs.delete('sub_seed');
    paymentOf(sub.id, 'pay_usd', 1200, { currency: 'USD' });
    const { razorpay, row } = setup({ identifier: 'sub_usd', subscriptionTier: 'STANDARD' });

    await disputeWebhook(
      razorpay,
      'payment.dispute.created',
      dispute('pay_usd', { amount: 1200, currency: 'USD' })
    );
    await settle();

    expect(subs.get('sub_usd').status).toBe('cancelled');
    expect(row()).toBeNull();
    expect(toOwner()[0].subject).toContain('$12, disputed, respond within 3 business days');
  });
});

describe('redelivered and out-of-order events', () => {
  it('the same event twice, at the same moment: one cancel, one alert, one customer email', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await Promise.all([
      disputeWebhook(razorpay, 'payment.dispute.created', d),
      disputeWebhook(razorpay, 'payment.dispute.created', d),
    ]);
    await settle();

    expect(row()).toBeNull();
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);
  });

  it('a redelivery a day later, when the plan is already gone, changes nothing and does not throw', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', d);
    await settle();
    const firstMarkedAt = mark()!.disputedAt.getTime();
    sent.length = 0;

    await expect(
      disputeWebhook(razorpay, 'payment.dispute.created', d)
    ).resolves.toEqual({ ok: true });
    await settle();

    expect(row()).toBeNull();
    // The first dispute's date stands: a redelivery never moves it.
    expect(mark()!.disputedAt.getTime()).toBe(firstMarkedAt);
    expect(toCustomer()).toHaveLength(0);
  });

  it('the states that follow each get their own alert, and only the first ends anything', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();
    await disputeWebhook(
      razorpay,
      'payment.dispute.under_review',
      dispute('pay_EFtmUsbwpXwBHI', { status: 'under_review' })
    );
    await settle();
    await disputeWebhook(
      razorpay,
      'payment.dispute.lost',
      dispute('pay_EFtmUsbwpXwBHI', { status: 'lost', amount_deducted: 59900 })
    );
    await settle();

    expect(toOwner()).toHaveLength(3);
    expect(toOwner()[1].subject).toContain('disputed, under_review');
    expect(toOwner()[2].subject).toContain('disputed, lost');
    expect(toOwner()[2].text).toContain('Already deducted ₹599 INR');
    // Only the first one had a plan to cancel.
    expect(cancelsOf('sub_live')).toHaveLength(1);
    // And the customer heard it once, on the event that ended the plan.
    expect(toCustomer()).toHaveLength(1);
  });

  it('out of order: `won` arrives first, so it still ends the plan, and says it is not restored', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(
      razorpay,
      'payment.dispute.won',
      dispute('pay_EFtmUsbwpXwBHI', { status: 'won' })
    );
    await settle();

    expect(row()).toBeNull();
    expect(mark()).not.toBeNull();
    expect(toOwner()[0].text).toContain(
      'Nothing is restored automatically'
    );
  });

  it('winning later never clears the workspace or gives the plan back by itself', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();
    await disputeWebhook(
      razorpay,
      'payment.dispute.won',
      dispute('pay_EFtmUsbwpXwBHI', { status: 'won' })
    );
    await settle();

    expect(row()).toBeNull();
    expect(mark()).not.toBeNull();
    expect(toOwner().at(-1).text).toContain('We won this dispute');
  });
});

describe('the awkward payments', () => {
  it('a dispute on a payment that was already refunded still ends the plan', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI', 59900, {
      amount_refunded: 59900,
      refund_status: 'full',
      status: 'refunded',
    });
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(row()).toBeNull();
    expect(mark()).not.toBeNull();
  });

  it("a dispute on an old cycle's payment ends today's plan and cancels the old subscription too", async () => {
    const old = live('sub_old', { status: 'cancelled', paid_count: 4 });
    const current = live('sub_current');
    paymentOf(old.id, 'pay_old');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_current',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_old'));
    await settle();

    // A dispute is a fraud signal whichever cycle it lands on.
    expect(row()).toBeNull();
    expect(mark()).not.toBeNull();
    expect(subs.get('sub_current').status).toBe('cancelled');
    expect(current.status).toBe('cancelled');
    // The old one was cancelled already: never cancelled twice.
    expect(cancelsOf('sub_old')).toHaveLength(0);
  });

  it('a dispute on a payment of a plan the customer already cancelled still ends the grace', async () => {
    live('sub_live', { status: 'cancelled', ended_at: nowSec() - DAY });
    paymentOf('sub_live', 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
      // Still on file, running out its paid time.
      cancelAt: new Date(Date.now() + 10 * DAY * 1000),
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(row()).toBeNull();
    expect(mark()).not.toBeNull();
    // Razorpay was never asked to cancel what it had already cancelled.
    expect(cancelsOf('sub_live')).toHaveLength(0);
  });

  it('a workspace with no paid plan at all is still marked, and nothing is cancelled', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, dispute: mark } = setup(null);

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(mark()).not.toBeNull();
    expect(toOwner()[0].text).toContain('The workspace had no paid plan.');
    expect(toCustomer()).toHaveLength(0);
  });
});

describe('plans this dispute did not pay for are left alone', () => {
  it.each([
    ['a lifetime deal', { isLifetime: true, identifier: 'lifetime-abc' }],
    ['a Gumroad membership', { identifier: 'gumroad:sale_123' }],
  ])('%s: the plan stays, the workspace is still marked and the owner told', async (_label, over) => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row, dispute: mark } = setup({
      subscriptionTier: 'STANDARD',
      ...over,
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    // The entitlement this dispute did not pay for is untouched: it is the
    // owner's to end, and the alert tells them so.
    expect(row()).not.toBeNull();
    expect(row().identifier).toBe(over.identifier);
    expect(mark()).not.toBeNull();
    expect(toOwner()[0].text).toContain('The plan is paid elsewhere');
    expect(toCustomer()).toHaveLength(0);
    // The stray Razorpay mandate whose payment was charged back is still
    // cancelled: left running it would keep charging a disputing customer.
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(subs.get('sub_live').status).toBe('cancelled');
  });

  it('a marketplace plan is left alone the same way', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup({
      subscriptionTier: 'STANDARD',
      identifier: 'apimkt:acct-9',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(row()).not.toBeNull();
    expect(toOwner()[0].text).toContain('The plan is paid elsewhere');
  });
});

describe('payments that are not ours', () => {
  it("another product's payment on the shared Razorpay account is ignored completely", async () => {
    paymentOf(null, 'pay_tablamigo', 49900, {
      notes: { service: 'tablamigo', orgId: 'tbl-1' },
    });
    const { razorpay, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_tablamigo'));
    await settle();

    expect(mark()).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a payment no workspace can be found for: the owner is told, and nothing is changed', async () => {
    paymentOf(null, 'pay_orphan');
    const { razorpay, dispute: mark, row } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_orphan'));
    await settle();

    expect(mark()).toBeNull();
    expect(row()).not.toBeNull();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].text).toContain('No Hookpost workspace could be found');
    expect(toCustomer()).toHaveLength(0);
  });

  it('an unknown dispute without a payment id is dropped quietly', async () => {
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await expect(
      razorpay.handleWebhook({
        event: 'payment.dispute.created',
        payload: { dispute: { entity: { id: 'disp_x' } } },
      })
    ).resolves.toEqual({ ok: true });
    await settle();
    expect(sent).toHaveLength(0);
  });
});

describe('our own workspaces', () => {
  it('an internal workspace gets the owner alert and no customer email', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup(
      { identifier: 'sub_live', subscriptionTier: 'STANDARD' },
      { internal: true }
    );

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(row()).toBeNull();
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(0);
  });
});

describe('when something is down, nothing is half-done', () => {
  it("Razorpay cannot be read for the workspace's own subscription: the row stays and Razorpay is asked to redeliver", async () => {
    // The dispute is on an older cycle's subscription, so the handler has to
    // read the one the workspace is on now, and that read is the one failing.
    const old = live('sub_old', { status: 'cancelled', paid_count: 4 });
    live('sub_current');
    paymentOf(old.id, 'pay_old');
    unreadableSubs.add('sub_current');
    const { razorpay, row } = setup({
      identifier: 'sub_current',
      subscriptionTier: 'STANDARD',
    });

    await expect(
      disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_old'))
    ).rejects.toThrow(/disp_EsIAlDcoUr8CaQ/);
    await settle();

    // Never delete a plan whose subscription may still be charging.
    expect(row()).not.toBeNull();
    expect(toOwner().at(-1).text).toContain('A chargeback could not be applied');
  });

  it('Razorpay is down for the payment lookup: not written off as an unknown payment', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    unreadableSubs.add('sub_live');
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    // The webhook's own payment entity carries invoice_id null and notes [],
    // so with Razorpay down there is no road to the workspace. Answering
    // "unknown payment, nothing changed" here would drop a real chargeback,
    // because Razorpay only redelivers on a 5xx.
    await expect(
      disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'))
    ).rejects.toThrow();
    await settle();

    expect(mark()).toBeNull();
    expect(row()).not.toBeNull();
    expect(toOwner().at(-1).text).toContain('A chargeback could not be applied');
    expect(
      toOwner().some((m) => m.text.includes('No Hookpost workspace could be found'))
    ).toBe(false);
  });

  it('Razorpay refuses the cancel: the row stays, and the owner is told to do it by hand', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    cancelRefused.add('sub_live');
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await expect(
      disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'))
    ).rejects.toThrow();
    await settle();

    expect(row()).not.toBeNull();
    expect(subs.get('sub_live').status).toBe('active');
    expect(toOwner().at(-1).text).toContain('cancel the subscription in the dashboard');
  });

  it('the cancel is refused because Razorpay has already cancelled it: that counts, and the plan ends', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    // The customer's own cancel landed between the read and our cancel.
    const original = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string, body?: any) => {
      if (method === 'POST' && path === '/subscriptions/sub_live/cancel') {
        subs.get('sub_live').status = 'cancelled';
        calls.push({ method, path, body });
        throw new Error(
          `Razorpay POST ${path} failed (400): Subscription is already cancelled`
        );
      }
      return original(method, path, body);
    });

    await disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();

    expect(row()).toBeNull();
    mockRequest.mockImplementation(original);
  });

  it('the workspace cannot be marked: nothing is cancelled and Razorpay is asked to redeliver', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup(
      { identifier: 'sub_live', subscriptionTier: 'STANDARD' },
      { markThrows: true }
    );

    await expect(
      disputeWebhook(razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'))
    ).rejects.toThrow();
    await settle();

    // The plan must never end while the lock that goes with it failed.
    expect(row()).not.toBeNull();
    expect(cancelsOf('sub_live')).toHaveLength(0);
  });
});

describe('the hourly sweep: a dispute whose webhook never came', () => {
  it('ends the plan exactly as the webhook would, and the next hour changes nothing', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(dispute('pay_EFtmUsbwpXwBHI', { created_at: nowSec() - 3600 }));
    const { razorpay, row, dispute: mark } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await expect(razorpay.sweepMissedDisputes()).resolves.toEqual({ seen: 1, failed: 0 });
    await settle();

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(cancelsOf('sub_live')[0].body).toEqual({ cancel_at_cycle_end: 0 });
    expect(row()).toBeNull();
    expect(mark()).toMatchObject({ disputePaymentId: 'pay_EFtmUsbwpXwBHI' });
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);

    await razorpay.sweepMissedDisputes();
    await settle();
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);
  });

  it('a dispute the webhook already settled: no second cancel, alert or email', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(d);
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await disputeWebhook(razorpay, 'payment.dispute.created', d);
    await settle();

    await razorpay.sweepMissedDisputes();
    await settle();

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);
  });

  it('a later status (lost) seen only by the sweep alerts the owner once more and restores nothing', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(d);
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await razorpay.sweepMissedDisputes();
    await settle();

    d.status = 'lost';
    d.amount_deducted = 59900;
    await razorpay.sweepMissedDisputes();
    await razorpay.sweepMissedDisputes();
    await settle();

    expect(toOwner()).toHaveLength(2);
    expect(toOwner()[1].subject).toContain('disputed, lost');
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);
    expect(row()).toBeNull();
  });

  it('the backend and the orchestrator sweeping at the same moment cancel once', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(dispute('pay_EFtmUsbwpXwBHI'));
    const { razorpay, subscriptions } = setup({
      identifier: 'sub_live',
      subscriptionTier: 'STANDARD',
    });

    await Promise.all([razorpay.sweepMissedDisputes(), razorpay.sweepMissedDisputes()]);
    await settle();

    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledTimes(1);
    expect(toCustomer()).toHaveLength(1);
  });

  it('Razorpay down: the sweep never throws, and a dispute it could not settle is tried again next hour', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(dispute('pay_EFtmUsbwpXwBHI'));
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    disputeListFails = true;
    await expect(razorpay.sweepMissedDisputes()).resolves.toEqual({ seen: 0, failed: 0 });
    disputeListFails = false;

    // The listing works, but the workspace's subscription cannot be read.
    unreadableSubs.add('sub_live');
    await expect(razorpay.sweepMissedDisputes()).resolves.toEqual({ seen: 1, failed: 1 });
    await settle();
    expect(row()).not.toBeNull();
    expect(cancelsOf('sub_live')).toHaveLength(0);

    unreadableSubs.clear();
    await razorpay.sweepMissedDisputes();
    await settle();
    expect(cancelsOf('sub_live')).toHaveLength(1);
    expect(row()).toBeNull();
  });

  it('a dispute older than the look-back window is not read, and an empty account answers cleanly', async () => {
    const sub = live();
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const { razorpay, row } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });

    await expect(razorpay.sweepMissedDisputes()).resolves.toEqual({ seen: 0, failed: 0 });

    disputesOnAccount.push(dispute('pay_EFtmUsbwpXwBHI', { created_at: nowSec() - 90 * DAY }));
    await razorpay.sweepMissedDisputes();
    await settle();

    expect(calls.some((c) => c.path.startsWith('/payments/'))).toBe(false);
    expect(row()).not.toBeNull();
  });
});

describe('a dispute the owner already cleared', () => {
  it('neither the sweep nor a later status webhook locks the workspace again or ends the plan it bought since', async () => {
    const sub = live('sub_old');
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const d = dispute('pay_EFtmUsbwpXwBHI');
    disputesOnAccount.push(d);
    const ctx = setup({ identifier: 'sub_old', subscriptionTier: 'STANDARD' });
    await disputeWebhook(ctx.razorpay, 'payment.dispute.created', d);
    await settle();
    expect(ctx.row()).toBeNull();
    expect(toCustomer()).toHaveLength(1);

    // The owner clears it in Admin, and the customer buys a new plan.
    await ctx.organizations.clearDispute(ORG, 'owner');
    live('sub_new');
    ctx.setRow({ identifier: 'sub_new', subscriptionTier: 'PRO' });

    await ctx.razorpay.sweepMissedDisputes();
    d.status = 'won';
    await disputeWebhook(ctx.razorpay, 'payment.dispute.won', d);
    await ctx.razorpay.sweepMissedDisputes();
    await settle();

    expect(cancelsOf('sub_new')).toHaveLength(0);
    expect(ctx.row()).toMatchObject({ identifier: 'sub_new' });
    expect(ctx.dispute()).toBeNull();
    expect(toCustomer()).toHaveLength(1);
    // The owner still hears that the dispute moved on.
    expect(toOwner().some((m) => m.subject.includes('disputed, won'))).toBe(true);
  });

  it('two disputes both cleared: a later status of the first one still changes nothing', async () => {
    const sub = live('sub_old');
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const first = dispute('pay_EFtmUsbwpXwBHI', { created_at: nowSec() - 10 * DAY });
    disputesOnAccount.push(first);
    const ctx = setup({ identifier: 'sub_old', subscriptionTier: 'STANDARD' });
    await disputeWebhook(ctx.razorpay, 'payment.dispute.created', first);
    await settle();
    await ctx.organizations.clearDispute(ORG, 'owner');

    const second = live('sub_mid');
    paymentOf(second.id, 'pay_SecondPay00001');
    ctx.setRow({ identifier: 'sub_mid', subscriptionTier: 'STANDARD' });
    await disputeWebhook(
      ctx.razorpay,
      'payment.dispute.created',
      dispute('pay_SecondPay00001', { id: 'disp_Second000000001', created_at: nowSec() + 60 })
    );
    expect(cancelsOf('sub_mid')).toHaveLength(1);
    await settle();
    await ctx.organizations.clearDispute(ORG, 'owner');

    live('sub_new');
    ctx.setRow({ identifier: 'sub_new', subscriptionTier: 'PRO' });
    first.status = 'lost';
    await ctx.razorpay.sweepMissedDisputes();
    await settle();

    expect(cancelsOf('sub_new')).toHaveLength(0);
    expect(ctx.row()).toMatchObject({ identifier: 'sub_new' });
    expect(ctx.dispute()).toBeNull();
  });

  it('a different payment disputed after the clear still ends the plan', async () => {
    const sub = live('sub_old');
    paymentOf(sub.id, 'pay_EFtmUsbwpXwBHI');
    const ctx = setup({ identifier: 'sub_old', subscriptionTier: 'STANDARD' });
    await disputeWebhook(ctx.razorpay, 'payment.dispute.created', dispute('pay_EFtmUsbwpXwBHI'));
    await settle();
    await ctx.organizations.clearDispute(ORG, 'owner');

    const fresh = live('sub_new');
    paymentOf(fresh.id, 'pay_SecondPay00001');
    ctx.setRow({ identifier: 'sub_new', subscriptionTier: 'PRO' });
    // Raised after the clear.
    await disputeWebhook(
      ctx.razorpay,
      'payment.dispute.created',
      dispute('pay_SecondPay00001', { id: 'disp_Second000000001', created_at: nowSec() + 60 })
    );
    await settle();

    expect(cancelsOf('sub_new')).toHaveLength(1);
    expect(ctx.row()).toBeNull();
    expect(ctx.dispute()).toMatchObject({ disputePaymentId: 'pay_SecondPay00001' });
  });
});
