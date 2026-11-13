import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { formatBillingDate } from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

// The owner's sale alert from every Razorpay path that moves money: which
// event says what, exactly once per event, never for another product's
// event, never in the way of the webhook, and never with card or UPI
// details. RazorpayService and OwnerSalesAlertService are real; Razorpay,
// Redis, Resend and the database are fakes. Nothing leaves the machine.

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

// Redis with real SET NX semantics and a round trip, so racing callers interleave.
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
let resendDown: false | 'error' | 'throw' = false;
const mockSend = jest.fn(async (msg: any) => {
  if (resendDown === 'throw') throw new Error('connect ETIMEDOUT api.resend.com');
  if (resendDown === 'error') return { data: null, error: { message: 'Service unavailable' } };
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

const mockRequest = jest.fn(async (method: string, path: string, _body?: any) => {
  const [base, query] = path.split('?');
  const q = new URLSearchParams(query || '');
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
  const inv = base.match(/^\/invoices\/([^/]+)$/);
  if (inv && method === 'GET') {
    const i = invoices.get(inv[1]);
    if (!i) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return i;
  }
  if (method === 'GET' && base === '/invoices') {
    const sub = q.get('subscription_id');
    return { items: [...invoices.values()].filter((i) => i.subscription_id === sub) };
  }
  const pay = base.match(/^\/payments\/([^/]+)$/);
  if (pay && method === 'GET') {
    const p = payments.get(pay[1]);
    if (!p) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return p;
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

/**
 * sub_TrORHomuXcb1gG as the live account returned it on 25 Oct 2026 (a
 * Standard UPI trial, first charge on 26 Oct), with the ids kept and the
 * customer's details replaced.
 */
function putTrial(id = 'sub_TrORHomuXcb1gG', extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'authenticated',
    plan_id: 'plan_Td8GtJPijo5TQF',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    start_at: nowSec() + 3 * DAY,
    charge_at: nowSec() + 3 * DAY,
    current_start: null,
    current_end: null,
    paid_count: 0,
    end_at: nowSec() + 3650 * DAY,
    notes: {
      service: 'hookpost',
      billing: 'STANDARD',
      period: 'MONTHLY',
      currency: 'INR',
      orgId: ORG,
      userId: 'user-testpayer',
      id: 'vzELUEQQnL',
      ud: 'DEl3N87QwU',
    },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

function live(id = 'sub_live', extra: any = {}) {
  return putTrial(id, {
    status: 'active',
    current_start: nowSec() - DAY,
    current_end: nowSec() + 29 * DAY,
    paid_count: 1,
    ...extra,
  });
}

/**
 * A payment as Razorpay's webhook carries it, with every field the owner's
 * email must never repeat.
 */
function payment(id: string, amount = 59900, extra: any = {}) {
  const p = {
    id,
    entity: 'payment',
    amount,
    currency: 'INR',
    status: 'captured',
    method: 'upi',
    invoice_id: `inv_${id}`,
    email: CUSTOMER_EMAIL,
    contact: '+919000000002',
    vpa: 'test.k@upi',
    card: { last4: '4242', network: 'Visa', name: 'TEST K', issuer: 'HDFC' },
    bank: 'HDFC',
    token_id: 'token_secret_abc',
    acquirer_data: { rrn: '000000000003', upi_transaction_id: 'UPI-SECRET-1' },
    notes: {},
    created_at: nowSec(),
    ...extra,
  };
  payments.set(id, p);
  return p;
}

function setup(row: any, opts: { ownerAlerts?: boolean } = {}) {
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
  const subscriptions = {
    getSubscription: jest.fn(async () => stored),
    // The once-per-person check at approval (trial switch on only).
    refuseTrialAtApproval: jest.fn(async () => false),
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      stored && stored.identifier === id ? stored : null
    ),
    createOrUpdateSubscription: jest.fn(
      async (
        _trial: boolean,
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
          isLifetime: false,
          cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        };
      }
    ),
    scheduleCancellation: jest.fn(async (_org: string, identifier: string, at: Date | null) => {
      if (stored?.identifier === identifier) stored = { ...stored, cancelAt: at };
    }),
    updateCustomerId: jest.fn(async () => undefined),
    deleteSubscriptionByOrg: jest.fn(async () => {
      stored = null;
    }),
    redeemCouponByCode: jest.fn(async () => undefined),
    getPolicyOrg: jest.fn(async () => ({ platformAdmin: false })),
    // As SubscriptionRepository: only this org's row with this identifier,
    // and a marker already on file keeps its own date.
    markPaymentFailing: jest.fn(async (org: string, identifier: string, since: Date) => {
      if (stored?.organizationId !== org || stored?.identifier !== identifier) return 0;
      if (stored.paymentFailingSince) return 0;
      stored = { ...stored, paymentFailingSince: since };
      return 1;
    }),
    clearPaymentFailing: jest.fn(async (identifier: string) => {
      if (stored?.identifier !== identifier || !stored.paymentFailingSince) return 0;
      stored = { ...stored, paymentFailingSince: null };
      return 1;
    }),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({ id, name: "Test Payer's workspace", paymentId: CUSTOMER })),
    getTeam: jest.fn(async () => ({ users: [{ user: { id: 'user-testpayer', email: CUSTOMER_EMAIL } }] })),
  };
  const orgRepository = {
    getSaleAlertFacts: jest.fn(async () => ({
      attribution: { method: 'google', utmSource: 'google', utmCampaign: 'in-search', country: 'IN' },
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
            isSuperAdmin: false,
            deletedAt: null,
          },
        },
      ],
    })),
  };
  const attribution = {
    markPaid: jest.fn(async () => undefined),
    markTrialStarted: jest.fn(async () => undefined),
  };
  const ownerAlerts = new OwnerSalesAlertService(orgRepository as any);
  ownerAlerts.retryDelaysMs = [0, 1, 1];
  const track = { track: jest.fn(async () => undefined) };
  const affiliates = { recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined) };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    track as any,
    affiliates as any,
    attribution as any,
    opts.ownerAlerts === false ? undefined : ownerAlerts
  );
  return { razorpay, subscriptions, ownerAlerts, row: () => stored };
}

const webhook = (razorpay: RazorpayService, event: string, sub: any, pay?: any) =>
  razorpay.handleWebhook({
    event,
    payload: {
      subscription: { entity: { ...sub } },
      ...(pay ? { payment: { entity: pay } } : {}),
    },
  });

/** Let the fire-and-forget alerts and emails land. */
const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
};

const toOwner = () => sent.filter((m) => [m.to].flat().includes(OWNER));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ioRedis: mockRedis } = require('@hookpost/nestjs-libraries/redis/redis.service');
/** The EX a key was claimed with, in seconds. */
const claimedTtl = (key: string) => {
  const call = (mockRedis.set as jest.Mock).mock.calls.find((c: any[]) => c[0] === `owner-sales-alert:${key}`);
  return call ? Number(call[call.indexOf('EX') + 1]) : null;
};
const toCustomer = () => sent.filter((m) => [m.to].flat().includes(CUSTOMER_EMAIL));

beforeEach(() => {
  plans.clear();
  subs.clear();
  invoices.clear();
  payments.clear();
  redisData.clear();
  redisList.length = 0;
  sent.length = 0;
  resendDown = false;
  mockSend.mockClear();
  mockRequest.mockClear();
  process.env.RESEND_API_KEY = 're_test';
  process.env.OWNER_SALES_ALERT_EMAIL = OWNER;
  process.env.RAZORPAY_KEY_ID = 'rzp_live_unit';
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
  putPlan('plan_Td8GtJPijo5TQF', 'STANDARD', 59900);
  putPlan('plan_pro', 'PRO', 199900);
  putPlan('plan_pro_y', 'PRO', 1999000, 'YEARLY');
});

afterEach(() => settle());

afterAll(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.OWNER_SALES_ALERT_EMAIL;
  delete process.env.RAZORPAY_KEY_ID;
});

describe('a trial starts', () => {
  it('webhook, its retry and the checkout callback at once: one alert to the owner, the welcome to the customer', async () => {
    const trial = putTrial();
    const { razorpay } = setup(null);

    await Promise.all([
      webhook(razorpay, 'subscription.authenticated', trial),
      webhook(razorpay, 'subscription.authenticated', trial),
      razorpay.syncSubscriptionById(trial.id),
    ]);
    await settle();

    expect(toOwner()).toHaveLength(1);
    const [alert] = toOwner();
    const first = formatBillingDate(new Date(trial.start_at * 1000));
    expect(alert.subject).toBe(
      `Trial started: Standard monthly, ₹599 · Test Payer`
    );
    expect(alert.text).not.toMatch(/Test mode/);
    expect(alert.text).toContain('Razorpay subscription: sub_TrORHomuXcb1gG');
    expect(alert.text).toContain(`Workspace id: ${ORG}`);
    expect(alert.text).toContain('utm_campaign=in-search');
    // The customer's own email goes to the customer, and only there.
    expect(toCustomer().map((m) => m.subject)).toEqual(['Your Hookpost Standard trial has started']);
    expect(toCustomer()[0].to).not.toContain(OWNER);
    expect([alert.to].flat()).toEqual([OWNER]);
  });

  it("the Rs 5 mandate check on authenticated is not a charge: no 'First charge' alert", async () => {
    const trial = putTrial();
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', trial, payment('pay_check', 500));
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Trial started']);
  });

  it('a test Razorpay key says TEST', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', putTrial());
    await settle();
    expect(toOwner()[0].subject.startsWith('Trial started')).toBe(true);
  });
});

describe('charges', () => {
  it('the first charge, delivered twice: one alert with the amount and payment id', async () => {
    const sub = live();
    const pay = payment('pay_599');
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.charged', sub, pay);
    await webhook(razorpay, 'subscription.charged', sub, pay);
    await settle();

    expect(toOwner()).toHaveLength(1);
    const [m] = toOwner();
    expect(m.subject).toBe(`First charge: Standard monthly, ₹599 · Test Payer`);
    expect(m.text).toContain('Razorpay payment: pay_599');
    expect(m.text).toContain('Charge number 1 on this subscription');
    expect(m.text).toContain('Payment method: UPI');
  });

  it('a renewal (paid_count 3) is a renewal', async () => {
    const sub = live('sub_live', { paid_count: 3 });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.charged', sub, payment('pay_r3'));
    await settle();
    expect(toOwner().map((m) => m.subject)).toEqual([
      `Renewal charged: Standard monthly, ₹599 · Test Payer`,
    ]);
  });

  it('the first charge of a Reactivate mandate continues a paid plan: a renewal', async () => {
    const sub = live('sub_react', {
      notes: { ...putTrial().notes, replaces: 'sub_old', reason: 'reactivate' },
    });
    const { razorpay } = setup({ identifier: 'sub_react', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.charged', sub, payment('pay_react'));
    await settle();
    expect(toOwner()[0].subject).toMatch(/^Renewal charged/);
  });

  it('the first charge of a UPI plan change (a new mandate beside the old plan) is not a new customer', async () => {
    const sub = live('sub_new_pro', {
      plan_id: 'plan_pro',
      notes: { ...putTrial('sub_z').notes, previous_plan: 'sub_old' },
    });
    subs.delete('sub_z');
    // The authenticated webhook already put it on file.
    const { razorpay } = setup({ identifier: 'sub_new_pro', subscriptionTier: 'PRO' });
    await webhook(razorpay, 'subscription.charged', sub, payment('pay_up', 199900));
    await settle();
    expect(toOwner().map((m) => m.subject)).toEqual([
      `Charged on a new plan: Pro monthly, ₹1,999 · Test Payer`,
    ]);
    expect(toOwner()[0].text).toContain('Replaced subscription: sub_old');
  });

  it('a charge on a plan a newer subscription already replaced: the owner is told to check for a refund', async () => {
    live('sub_new', { created_at: tick() + 3600 });
    const late = live('sub_old_late', { created_at: tick() - 3600, paid_count: 3 });
    const { razorpay } = setup({ identifier: 'sub_new', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.charged', late, payment('pay_late'));
    await settle();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/^Renewal charged/);
    expect(toOwner()[0].text).toContain('already replaced by sub_new and is being cancelled: check whether this charge should be refunded');
  });

  it('never repeats card, UPI, phone, bank or token details', async () => {
    const sub = live();
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.charged', sub, payment('pay_secret'));
    await settle();
    const all = toOwner().map((m) => `${m.subject}\n${m.text}\n${m.html || ''}`).join('\n');
    expect(all).toContain('pay_secret');
    for (const secret of ['4242', 'Visa', 'TEST K', 'test.k@upi', '9000000002', 'HDFC', 'token_secret_abc', '000000000003', 'UPI-SECRET-1']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('plan changes', () => {
  it('an in-place upgrade (subscription.updated with the Pro plan): Plan changed, once', async () => {
    const sub = live('sub_live', { plan_id: 'plan_pro' });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD', period: 'MONTHLY' });
    await webhook(razorpay, 'subscription.updated', sub);
    await webhook(razorpay, 'subscription.updated', sub);
    await settle();
    expect(toOwner().map((m) => m.subject)).toEqual([
      `Plan changed: Standard monthly → Pro monthly, ₹1,999 · Test Payer`,
    ]);
  });

  it('a new mandate for another plan (UPI cannot be patched): Plan changed, not a new trial', async () => {
    live('sub_old');
    const next = putTrial('sub_new_pro', { plan_id: 'plan_pro_y', created_at: tick() + 3600 });
    const { razorpay } = setup({ identifier: 'sub_old', subscriptionTier: 'STANDARD', period: 'MONTHLY' });
    await webhook(razorpay, 'subscription.authenticated', next);
    await settle();
    const subjects = toOwner().map((m) => m.subject);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatch(/^Plan changed: Standard monthly → Pro yearly, ₹19,990/);
    expect(toOwner()[0].text).toContain('Replaced subscription: sub_old');
  });

  it('a plan switch during the trial says so', async () => {
    putTrial('sub_trial_std');
    const next = putTrial('sub_trial_pro', {
      plan_id: 'plan_pro',
      created_at: tick() + 3600,
      notes: { ...putTrial('sub_x').notes, replaces: 'sub_trial_std', reason: 'plan_change', trial: '1' },
    });
    subs.delete('sub_x');
    const { razorpay } = setup({ identifier: 'sub_trial_std', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.authenticated', next);
    await settle();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/Plan changed: Standard monthly → Pro monthly/);
    expect(toOwner()[0].text).toMatch(/Switched during the trial; first charge \d/);
  });

  it('Reactivate (same plan, new mandate): one "New mandate" alert, no trial alert', async () => {
    const mandate = putTrial('sub_reactivate', {
      notes: { ...putTrial('sub_y').notes, replaces: 'sub_live', reason: 'reactivate' },
    });
    subs.delete('sub_y');
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.authenticated', mandate);
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['New mandate on the same plan']);
    expect(toOwner()[0].text).toContain('Reactivated a plan that was set to end');
  });
});

describe('reactivations', () => {
  it('a cancelled trial reactivated (notes.trial): one "New mandate" alert saying so', async () => {
    const mandate = putTrial('sub_back', {
      notes: { ...putTrial('sub_w').notes, replaces: 'sub_trial', reason: 'reactivate', trial: '1' },
    });
    subs.delete('sub_w');
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.authenticated', mandate);
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['New mandate on the same plan']);
    expect(toOwner()[0].text).toContain('Reactivated a cancelled trial');
  });

  it('a payment-method change during a trial is not news', async () => {
    const mandate = putTrial('sub_pm', {
      notes: { ...putTrial('sub_v').notes, replaces: 'sub_trial', reason: 'payment_method', trial: '1' },
    });
    subs.delete('sub_v');
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.authenticated', mandate);
    await settle();
    expect(toOwner()).toHaveLength(0);
  });
});

describe('cancellations', () => {
  it('Cancel in Billing: one alert with the reason, and none again when Razorpay confirms', async () => {
    const sub = live('sub_live', { created_at: tick() });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG, {
      userId: 'user-testpayer',
      feedback: 'Too expensive\nfor now',
    });
    await settle();
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get(sub.id) });
    await settle();

    expect(toOwner()).toHaveLength(1);
    const [m] = toOwner();
    expect(m.subject).toMatch(/^Cancellation requested: Standard monthly/);
    expect(m.text).toContain('Reason given: Too expensive for now');
    expect(m.text).toMatch(/Access until \d{1,2} \w{3} \d{4}, no further charges/);
  });

  it("a trial's subscription.cancelled racing Billing's Cancel: the one alert still has the reason", async () => {
    const trial = putTrial('sub_race', { created_at: tick() });
    const { razorpay } = setup({ identifier: 'sub_race', subscriptionTier: 'STANDARD' });
    // Razorpay cancels a trial at once and its webhook arrives before our
    // cancel call has returned.
    const original = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string) => {
      const out = await original(method, path);
      if (method === 'POST' && path === `/subscriptions/${trial.id}/cancel`) {
        await webhook(razorpay, 'subscription.cancelled', { ...subs.get(trial.id) });
        await settle();
      }
      return out;
    });
    try {
      await razorpay.cancelAtPeriodEnd(ORG, { userId: 'user-testpayer', feedback: 'Not for me' });
      await settle();
    } finally {
      mockRequest.mockImplementation(original);
    }
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/Cancellation requested/);
    expect(toOwner()[0].text).toContain('Reason given: Not for me');
    expect(toOwner()[0].text).toContain('Cancelled during the trial; nothing was charged');
  });

  it('the database failing after Razorpay took the cancel: the owner is still told, with the reason', async () => {
    live('sub_live', { created_at: tick() });
    const { razorpay, subscriptions } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    subscriptions.scheduleCancellation.mockRejectedValueOnce(new Error('db down'));
    await expect(razorpay.cancelAtPeriodEnd(ORG, { feedback: 'Bye' })).rejects.toThrow('db down');
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Cancellation requested']);
    expect(toOwner()[0].text).toContain('Reason given: Bye');
  });

  it("Razorpay refusing the cancel clears the mark, so a later cancellation is still reported", async () => {
    live('sub_live', { created_at: tick() });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    const original = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string) => {
      if (method === 'POST' && /\/cancel$/.test(path)) throw new Error(`Razorpay POST ${path} failed (500): down`);
      return original(method, path);
    });
    try {
      await expect(razorpay.cancelAtPeriodEnd(ORG, { feedback: 'x' })).rejects.toThrow(/didn't accept/);
    } finally {
      mockRequest.mockImplementation(original);
    }
    expect(redisData.has('owner-sales-alert:mark:cancel:sub_live')).toBe(false);
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get('sub_live'), status: 'cancelled', ended_at: nowSec() });
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Subscription cancelled']);
  });

  it('a yearly cycle-end cancel keeps its key past the cycle end, so the confirmation months later is not a second email', async () => {
    putPlan('plan_std_y', 'STANDARD', 599000, 'YEARLY');
    live('sub_year', { plan_id: 'plan_std_y', current_end: nowSec() + 300 * DAY, created_at: tick() });
    const { razorpay } = setup({ identifier: 'sub_year', subscriptionTier: 'STANDARD', period: 'YEARLY' });
    await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    expect(claimedTtl('cancel:sub_year')).toBeGreaterThan(300 * DAY);
    expect(toOwner()).toHaveLength(1);
  });

  it('cancelled outside Hookpost (UPI app, dashboard), delivered twice: one alert', async () => {
    const sub = live('sub_live', { status: 'cancelled', ended_at: nowSec() });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.cancelled', sub);
    await webhook(razorpay, 'subscription.cancelled', sub);
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Subscription cancelled']);
  });

  it('the old mandate of a plan switch being cancelled is not a cancellation', async () => {
    const old = live('sub_old', { status: 'cancelled', ended_at: nowSec(), created_at: tick() });
    putTrial('sub_new', { status: 'active', created_at: tick() + 60 });
    const { razorpay } = setup({ identifier: 'sub_old', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.cancelled', old);
    await settle();
    expect(toOwner()).toHaveLength(0);
  });

  it("another product's cancellation is ignored", async () => {
    const other = live('sub_vetnow', {
      status: 'cancelled',
      notes: { service: 'vetnow', orgId: ORG },
    });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.cancelled', other);
    await settle();
    expect(toOwner()).toHaveLength(0);
  });
});

describe('failing charges', () => {
  it('a renewal failing (pending), delivered twice: one alert', async () => {
    const sub = live('sub_live', { status: 'pending', paid_count: 2 });
    const failed = payment('pay_fail', 59900, { status: 'failed', error_description: 'Insufficient funds\r\nin account' });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.pending', sub, failed);
    await webhook(razorpay, 'subscription.pending', sub, failed);
    await settle();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/^Payment failing: Standard monthly, ₹599 · /);
    expect(toOwner()[0].text).toContain('Amount: ₹599, not collected');
    expect(toOwner()[0].text).toContain('Bank said: Insufficient funds in account');
  });

  it('a halted renewal with nothing paid for past today: the alerts say the plan ended now', async () => {
    // Razorpay has booked the unpaid cycle: 2 booked, 1 paid, so the time
    // paid for stopped at current_start and there is no grace on top of it
    // (a halt has no grace since 29 Oct 2026).
    const sub = live('sub_live', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 1,
      halted_at: nowSec() - 3600,
    });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.halted', sub);
    await settle();
    const halted = toOwner().find((m: any) => /^Renewal paused/.test(m.subject));
    expect(halted.text).toContain('Nothing was paid for past today, so the plan ended now');
    expect(halted.text).not.toMatch(/Plan kept until/);
    // The plan ending is its own alert, as for any cancellation.
    const cancelled = toOwner().find((m: any) => /Subscription cancelled/.test(m.subject));
    expect(cancelled.text).toContain('the renewal stayed unpaid and the time paid for had run out');
  });

  it('a halted renewal inside a cycle that was paid for: the alert gives the date it runs to', async () => {
    // 2 booked, 2 paid: the customer keeps the cycle they paid for.
    const sub = live('sub_live', {
      status: 'halted',
      current_start: nowSec() - 2 * DAY,
      current_end: nowSec() + 28 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 2,
      halted_at: nowSec() - 3600,
    });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.halted', sub);
    await settle();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/^Renewal paused/);
    expect(toOwner()[0].text).toContain(
      `Plan kept until ${formatBillingDate(new Date(sub.current_end * 1000))}`
    );
  });

  it("a trial whose first charge halted is ended: one 'cancelled' alert saying why", async () => {
    const sub = putTrial('sub_trial', {
      status: 'halted',
      current_start: nowSec() - 4 * DAY,
      current_end: nowSec() + 26 * DAY,
      paid_count: 0,
    });
    const { razorpay } = setup({ identifier: 'sub_trial', subscriptionTier: 'STANDARD' });
    await webhook(razorpay, 'subscription.halted', sub);
    await settle();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Subscription cancelled']);
    expect(toOwner()[0].text).toContain("Hookpost ended it: the trial's first charge failed on every retry");
  });

  it("a failing subscription that is not Hookpost's: nothing", async () => {
    const sub = live('sub_tm', { status: 'pending', notes: { service: 'tablamigo' } });
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.pending', sub);
    await settle();
    expect(toOwner()).toHaveLength(0);
  });
});

describe('refunds', () => {
  const refund = (id: string, paymentId: string, amount: number) => ({
    id,
    entity: 'refund',
    amount,
    currency: 'INR',
    payment_id: paymentId,
    status: 'processed',
    created_at: nowSec(),
  });

  it('refund.created then refund.processed (twice): one alert, and the plan ends', async () => {
    live('sub_live');
    const pay = payment('pay_1');
    invoices.set('inv_pay_1', { id: 'inv_pay_1', subscription_id: 'sub_live' });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    const r = refund('rfnd_1', 'pay_1', 59900);
    for (const event of ['refund.created', 'refund.processed', 'refund.processed']) {
      await razorpay.handleWebhook({ event, payload: { refund: { entity: r }, payment: { entity: pay } } });
    }
    await settle();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toBe(
      `Refund: Standard monthly, ₹599 · Test Payer`
    );
    expect(toOwner()[0].text).toContain('Razorpay refund: rfnd_1');
    expect(toOwner()[0].text).toContain(
      'Refunded, so the plan ended now and the subscription is cancelled at Razorpay'
    );
  });

  it('the Rs 5 mandate-check refund (no invoice, no notes): nothing', async () => {
    const pay = payment('pay_check', 500, { invoice_id: null });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await razorpay.handleWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: refund('rfnd_check', 'pay_check', 500) }, payment: { entity: pay } },
    });
    await settle();
    expect(toOwner()).toHaveLength(0);
  });

  it("another product's refund: nothing", async () => {
    const pay = payment('pay_tm', 49900, { invoice_id: null, notes: { service: 'tablamigo', orgId: ORG } });
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await razorpay.handleWebhook({
      event: 'refund.processed',
      payload: { refund: { entity: refund('rfnd_tm', 'pay_tm', 49900) }, payment: { entity: pay } },
    });
    await settle();
    expect(toOwner()).toHaveLength(0);
  });
});

/**
 * sub_TXvoILk8Rch2Wo (org a8bed6eb) as it stood on 28 Oct 2026, ids kept: a
 * Rs 699 Standard UPI renewal paid on 10 Oct (pay_Tly6Lxw7JizHcy) and
 * refunded Rs 693 on 11 Oct, still active with the next charge on 10 Nov.
 * Any refund of any size ends the plan now (owner's decision, 29 Oct 2026).
 */
describe('any refund ends the plan (sub_TXvoILk8Rch2Wo, Oct 2026)', () => {
  const SUB = 'sub_TXvoILk8Rch2Wo';
  const PAY = 'pay_Tly6Lxw7JizHcy';

  function refundedRenewal(opts: { refunded?: number; periodEnd?: number } = {}) {
    putPlan('plan_TTE4XbxhSc8Q8Z', 'STANDARD', 69900);
    const periodEnd = opts.periodEnd ?? nowSec() + 12 * DAY;
    live(SUB, {
      plan_id: 'plan_TTE4XbxhSc8Q8Z',
      created_at: tick(),
      current_start: nowSec() - 19 * DAY,
      current_end: nowSec() + 12 * DAY,
      charge_at: nowSec() + 12 * DAY,
      total_count: 120,
      remaining_count: 118,
      paid_count: 2,
    });
    invoices.set(`inv_${PAY}`, {
      id: `inv_${PAY}`,
      entity: 'invoice',
      subscription_id: SUB,
      payment_id: PAY,
      billing_start: periodEnd - 31 * DAY,
      billing_end: periodEnd,
    });
    return payment(PAY, 69900, {
      captured: true,
      amount_refunded: opts.refunded ?? 69300,
      refund_status: (opts.refunded ?? 69300) === 69900 ? 'full' : 'partial',
    });
  }

  const refund = (id: string, amount: number, status = 'processed') => ({
    id,
    entity: 'refund',
    amount,
    currency: 'INR',
    payment_id: PAY,
    status,
    created_at: nowSec(),
  });
  const refundEvent = (razorpay: RazorpayService, event: string, r: any, pay: any) =>
    razorpay.handleWebhook({ event, payload: { refund: { entity: r }, payment: { entity: pay } } });
  const cancels = () =>
    mockRequest.mock.calls
      .filter(([method, path]) => method === 'POST' && path === `/subscriptions/${SUB}/cancel`)
      .map((c) => c[2]);

  it('Cancel on a refunded plan ends it now (cancel_at_cycle_end 0), and both emails say why', async () => {
    refundedRenewal();
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG, { userId: 'user-testpayer', feedback: 'Testing' });
    await settle();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(res).toMatchObject({ immediate: true, alreadyScheduled: false });
    expect(res.cancel_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row()).toBeNull();

    // Razorpay's subscription.cancelled for it adds nothing.
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get(SUB) });
    await settle();

    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/^Cancellation requested: Standard monthly/);
    expect(toOwner()[0].text).toContain('A charge on it was refunded, so the plan ended now');
    expect(toOwner()[0].text).not.toContain('Access until');
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].subject).toBe('Your Hookpost plan is cancelled');
    expect(toCustomer()[0].text).toContain(
      'Your payment was refunded, so the plan ended now rather than at the end of the period.'
    );
    expect(toCustomer()[0].text).not.toContain('Paid access until');
  });

  it('Cancel with nothing refunded stops the mandate now and keeps the plan to current_end', async () => {
    const pay = refundedRenewal({ refunded: 0 });
    expect(pay.amount_refunded).toBe(0);
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });

    const res = await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(res).toMatchObject({ immediate: false });
    expect(res.cancel_at.getTime()).toBe(subs.get(SUB).current_end * 1000);
    expect(row()).toMatchObject({ identifier: SUB, cancelAt: res.cancel_at });
    expect(toOwner()[0].text).toMatch(/Access until \d{1,2} \w{3} \d{4}, no further charges/);
    // The customer hears at once that it is cancelled and how long it runs,
    // instead of waiting weeks for Razorpay's subscription.cancelled.
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].subject).toBe('Your Hookpost plan is cancelled');
    expect(toCustomer()[0].text).toContain('Paid access until');
  });

  /** One refund event of `amount` paise ends the plan, cancelled at Razorpay now. */
  async function expectRefundEndsPlan(amount: number, opts: { periodEnd?: number } = {}) {
    const pay = refundedRenewal({ refunded: amount, periodEnd: opts.periodEnd });
    const { razorpay, row, subscriptions } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const r = refund(`rfnd_${amount}`, amount);

    await refundEvent(razorpay, 'refund.created', r, pay);
    await refundEvent(razorpay, 'refund.processed', r, pay);
    await refundEvent(razorpay, 'refund.processed', r, pay);
    await settle();
    // And Razorpay's subscription.cancelled for the cancel we sent.
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get(SUB) });
    await settle();

    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(subscriptions.deleteSubscriptionByOrg).toHaveBeenCalledTimes(1);
    expect(row()).toBeNull();
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].subject).toMatch(/^Refund: Standard monthly, ₹[\d,.]+ · /);
    expect(toOwner()[0].text).toContain(
      'Refunded, so the plan ended now and the subscription is cancelled at Razorpay'
    );
    expect(toOwner()[0].text).not.toContain('next charge');
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].text).toContain('Your plan: Standard · cancelled');
    expect(toCustomer()[0].text).toContain(
      'Because this payment was refunded, your plan has ended now.'
    );
    expect(toCustomer()[0].text).not.toContain('still active');
  }

  it('a 1% refund (Rs 6.99 of Rs 699) cancels at Razorpay now and ends the plan; refund.created + refund.processed act once', async () => {
    await expectRefundEndsPlan(699);
  });

  it('a 99% refund (Rs 693, the 11 Oct refund) ends the plan the same way', async () => {
    await expectRefundEndsPlan(69300);
    expect(toCustomer()[0].subject).toBe('Your refund of ₹693 is on its way');
  });

  it('a 100% refund ends the plan the same way', async () => {
    await expectRefundEndsPlan(69900);
  });

  it('a refund of an earlier period ends the plan the same way', async () => {
    await expectRefundEndsPlan(69900, { periodEnd: nowSec() - 19 * DAY });
  });

  it('refund.created and refund.processed at the same moment still end it once, with one email each way', async () => {
    const pay = refundedRenewal();
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const r = refund('rfnd_TmQ2', 69300);
    await Promise.all([
      refundEvent(razorpay, 'refund.created', r, pay),
      refundEvent(razorpay, 'refund.processed', r, pay),
    ]);
    await settle();
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get(SUB) });
    await settle();
    expect(row()).toBeNull();
    expect(cancels().every((b) => b?.cancel_at_cycle_end === 0)).toBe(true);
    expect(toOwner()).toHaveLength(1);
    expect(toCustomer()).toHaveLength(1);
  });

  it('a refund on a superseded subscription leaves the current plan alone, and the owner is told which one was refunded', async () => {
    const pay = refundedRenewal({ refunded: 69900 });
    // A plan change left SUB running beside the workspace's current one.
    live('sub_current', { plan_id: 'plan_TTE4XbxhSc8Q8Z', created_at: tick() });
    const { razorpay, row, subscriptions } = setup({ identifier: 'sub_current', subscriptionTier: 'STANDARD' });
    await refundEvent(razorpay, 'refund.processed', refund('rfnd_dup', 69900), pay);
    await settle();

    expect(mockRequest.mock.calls.filter(([m, path]) => m === 'POST' && /\/cancel$/.test(path))).toEqual([]);
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ identifier: 'sub_current', cancelAt: null });
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].text).toContain(
      `${SUB} is not the workspace's current subscription (sub_current): the current plan is unaffected`
    );
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].text).toContain('Your plan: Standard · still active');
    expect(toCustomer()[0].text).not.toContain('renews on');
  });

  it('a payment Razorpay never captured is not a charge for the period: the plan stays', async () => {
    const pay = refundedRenewal({ refunded: 69900 });
    pay.captured = false;
    pay.status = 'refunded';
    payments.set(PAY, { ...pay, status: 'authorized' });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    await refundEvent(razorpay, 'refund.processed', refund('rfnd_auth', 69900), { ...pay, status: 'authorized' });
    await settle();
    expect(cancels()).toEqual([]);
    expect(row()).toMatchObject({ identifier: SUB });
  });

  /** Make Razorpay refuse every cancel while `fn` runs. */
  async function cancelsRefused(fn: () => Promise<void>) {
    const original = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string, body?: any) => {
      if (method === 'POST' && /\/cancel$/.test(path)) throw new Error(`Razorpay POST ${path} failed (500): down`);
      return original(method, path, body);
    });
    try {
      await fn();
    } finally {
      mockRequest.mockImplementation(original);
    }
  }

  it('Razorpay refusing the cancel keeps the plan, tells the owner, emails the customer nothing yet, and leaves the cancelled email free', async () => {
    const pay = refundedRenewal();
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    await cancelsRefused(async () => {
      await refundEvent(razorpay, 'refund.processed', refund('rfnd_down', 69300), pay);
      await settle();
    });
    expect(row()).toMatchObject({ identifier: SUB, cancelAt: null });
    expect(toOwner()).toHaveLength(1);
    expect(toOwner()[0].text).toContain('Razorpay refused the cancel: cancel it in the dashboard');
    expect(toOwner()[0].text).not.toContain('next charge');
    // Never "your plan renews" for a period that was refunded.
    expect(toCustomer()).toHaveLength(0);
    expect(redisData.has(`owner-sales-alert:mark:cancel:${SUB}`)).toBe(false);

    // Cancelled by hand afterwards: reported, and the customer is told why.
    await webhook(razorpay, 'subscription.cancelled', { ...subs.get(SUB), status: 'cancelled', ended_at: nowSec() });
    await settle();
    expect(row()).toBeNull();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toContain('Subscription cancelled');
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].subject).toBe('Your Hookpost plan is cancelled');
    expect(toCustomer()[0].text).toContain('was refunded, so the plan ended now');
  });

  it('refused on refund.created, accepted on refund.processed: the plan ends and both emails say so', async () => {
    const pay = refundedRenewal();
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const r = refund('rfnd_retry', 69300);
    await cancelsRefused(async () => {
      await refundEvent(razorpay, 'refund.created', r, pay);
      await settle();
    });
    await refundEvent(razorpay, 'refund.processed', r, pay);
    await settle();

    expect(row()).toBeNull();
    expect(toOwner().map((m) => m.text.includes('the plan ended now'))).toEqual([false, true]);
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].text).toContain('Your plan: Standard · cancelled');
  });

  it('a refund after the customer cancelled ends the plan now, even if Razorpay will not take a second cancel', async () => {
    const pay = refundedRenewal({ refunded: 0 });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    // Cancel already told the customer the plan runs to the end of the period.
    expect(toCustomer()).toHaveLength(1);
    expect(toCustomer()[0].text).toContain('Paid access until');
    expect(row()?.cancelAt).toBeTruthy();

    // Then the renewal is refunded, and Razorpay refuses a second cancel.
    pay.amount_refunded = 69300;
    await cancelsRefused(async () => {
      await refundEvent(razorpay, 'refund.processed', refund('rfnd_after', 69300), pay);
      await settle();
    });
    expect(row()).toBeNull();
    expect(toCustomer()).toHaveLength(2);
    expect(toCustomer()[1].text).toContain('Your plan: Standard · cancelled');
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual([
      'Cancellation requested',
      'Refund',
    ]);
  });

  it('Cancel after a small refund (Rs 6.99) ends the plan now too', async () => {
    refundedRenewal({ refunded: 699 });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const res = await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(res).toMatchObject({ immediate: true });
    expect(row()).toBeNull();
  });

  it('Cancel after a refund of an earlier period ends the plan now too', async () => {
    refundedRenewal({ refunded: 69900, periodEnd: nowSec() - 19 * DAY });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const res = await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(res).toMatchObject({ immediate: true });
    expect(row()).toBeNull();
  });

  it('refund webhook delivered, then Cancel days later: the plan already ended, nothing is cancelled twice, nothing more is sent', async () => {
    const pay = refundedRenewal({ refunded: 0 });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    pay.amount_refunded = 699;
    await refundEvent(razorpay, 'refund.processed', refund('rfnd_days_ago', 699), pay);
    await settle();
    expect(row()).toBeNull();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    const sent = [toCustomer().length, toOwner().length];

    await expect(razorpay.cancelAtPeriodEnd(ORG, { feedback: 'three days later' })).rejects.toThrow(
      'no paid plan to cancel'
    );
    await settle();
    expect(cancels()).toHaveLength(1);
    expect([toCustomer().length, toOwner().length]).toEqual(sent);
  });

  it('Cancel on a halted renewal with an earlier refund ends the plan now, not at the end of the time paid before it', async () => {
    refundedRenewal({ refunded: 699 });
    // The renewal after the refunded charge failed and Razorpay stopped retrying.
    Object.assign(subs.get(SUB), { status: 'halted', current_start: nowSec() + 12 * DAY - 31 * DAY });
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    await expect(razorpay.cancelQuote(ORG)).resolves.toEqual({ endsNow: true });

    const res = await razorpay.cancelAtPeriodEnd(ORG, { feedback: 'later' });
    await settle();
    expect(cancels()).toEqual([{ cancel_at_cycle_end: 0 }]);
    expect(res).toMatchObject({ immediate: true });
    expect(row()).toBeNull();
    expect(toOwner()[0].text).toContain('A charge on it was refunded, so the plan ended now');
  });

  it('the cancel quote says "ends now" for any refund, and not without one or once it is set to end', async () => {
    refundedRenewal({ refunded: 699 });
    const { razorpay } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    await expect(razorpay.cancelQuote(ORG)).resolves.toEqual({ endsNow: true });
    expect(cancels()).toEqual([]);

    payments.get(PAY).amount_refunded = 0;
    await expect(razorpay.cancelQuote(ORG)).resolves.toEqual({ endsNow: false });

    payments.get(PAY).amount_refunded = 699;
    subs.get(SUB).end_at = subs.get(SUB).current_end;
    await expect(razorpay.cancelQuote(ORG)).resolves.toEqual({ endsNow: false });
  });

  it('refund.created whose invoice could not be read waits for refund.processed, which ends the plan', async () => {
    const pay = refundedRenewal();
    const { razorpay, row } = setup({ identifier: SUB, subscriptionTier: 'STANDARD' });
    const r = refund('rfnd_blind', 69300);
    const inv = invoices.get(`inv_${PAY}`);
    invoices.delete(`inv_${PAY}`);
    await refundEvent(razorpay, 'refund.created', r, pay);
    await settle();
    expect(toOwner()).toHaveLength(0);
    expect(toCustomer()).toHaveLength(0);
    expect(row()).toMatchObject({ identifier: SUB });

    invoices.set(`inv_${PAY}`, inv);
    await refundEvent(razorpay, 'refund.processed', r, pay);
    await settle();
    expect(row()).toBeNull();
    expect(toCustomer()).toHaveLength(1);
  });
});

describe('never in the way', () => {
  it('Resend down: the webhook still answers ok, the plan is provisioned, and the alert arrives once Resend is back', async () => {
    resendDown = 'error';
    const trial = putTrial();
    const { razorpay, row, ownerAlerts } = setup(null);
    await expect(webhook(razorpay, 'subscription.authenticated', trial)).resolves.toEqual({ ok: true });
    await settle();
    expect(row()).toMatchObject({ identifier: trial.id, subscriptionTier: 'STANDARD' });
    expect(toOwner()).toHaveLength(0);
    expect(redisList).toHaveLength(1);

    resendDown = false;
    // Razorpay's redelivery and the checkout callback add nothing...
    await webhook(razorpay, 'subscription.authenticated', trial);
    await razorpay.syncSubscriptionById(trial.id);
    await settle();
    // ...and the retry run sends the queued alert, once.
    await ownerAlerts.retryPending();
    await ownerAlerts.retryPending();
    expect(toOwner().map((m) => m.subject.split(':')[0])).toEqual(['Trial started']);
  });

  it('Resend throwing: the charge webhook still resolves ok', async () => {
    resendDown = 'throw';
    const sub = live();
    const { razorpay } = setup({ identifier: 'sub_live', subscriptionTier: 'STANDARD' });
    await expect(webhook(razorpay, 'subscription.charged', sub, payment('pay_x'))).resolves.toEqual({ ok: true });
    await settle();
  });

  it('the alert service failing outright never reaches the webhook', async () => {
    const trial = putTrial();
    const { razorpay } = setup(null);
    (razorpay as any)._ownerAlerts.notify = jest.fn(() => {
      throw new Error('boom');
    });
    await expect(webhook(razorpay, 'subscription.authenticated', trial)).resolves.toEqual({ ok: true });
  });

  it('without the alert service (a spec, a script) nothing changes', async () => {
    const { razorpay } = setup(null, { ownerAlerts: false });
    await expect(webhook(razorpay, 'subscription.authenticated', putTrial())).resolves.toEqual({ ok: true });
    await settle();
    expect(toOwner()).toHaveLength(0);
  });

  it('OWNER_SALES_ALERT_EMAIL unset: no alert, the customer still gets theirs', async () => {
    delete process.env.OWNER_SALES_ALERT_EMAIL;
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', putTrial());
    await settle();
    expect(toOwner()).toHaveLength(0);
    expect(toCustomer()).toHaveLength(1);
  });

  it("a subscription that is not Hookpost's (another product's notes) gets no alert", async () => {
    const foreign = putTrial('sub_foreign', { notes: { service: 'tablamigo', orgId: ORG, billing: 'STANDARD' } });
    const { razorpay } = setup(null);
    await webhook(razorpay, 'subscription.authenticated', foreign);
    await settle();
    expect(toOwner()).toHaveLength(0);
  });
});
