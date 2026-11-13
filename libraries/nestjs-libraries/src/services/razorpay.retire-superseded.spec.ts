import 'reflect-metadata';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';

// Which subscriptions get cancelled when a customer opens a new checkout, and
// which when that checkout is completed. Razorpay, Redis and the database are
// all fakes: nothing leaves the machine.

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
const CUSTOMER = 'cust_1';

// Fake Razorpay account: plans and subscriptions held in memory, with the
// behaviour this code depends on. A UPI mandate refuses a plan PATCH, exactly
// as the live API does.
const plans = new Map<string, any>();
const subs = new Map<string, any>();
const cancels: Array<{ id: string; body: any }> = [];
// Razorpay's created_at, in the order things are made.
let clock = 1_790_000_000;
const tick = () => (clock += 60);

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  const [base, query] = path.split('?');

  if (method === 'GET' && base === '/plans') return { items: [...plans.values()] };
  if (method === 'POST' && base === '/plans') {
    const plan = { id: `plan_${plans.size + 1}`, ...body };
    plans.set(plan.id, plan);
    return plan;
  }
  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`404 ${path}`);
    return plan;
  }

  if (method === 'GET' && base === '/subscriptions') {
    // As live Razorpay: no customer filter (400 if one is sent), 100 a page,
    // newest first.
    const q = new URLSearchParams(query || '');
    if (q.has('customer_id')) {
      throw new Error(
        `Razorpay GET ${path} failed (400): customer_id is/are not required and should not be sent`
      );
    }
    const count = Math.min(Number(q.get('count') || 10), 100);
    const skip = Number(q.get('skip') || 0);
    const newestFirst = [...subs.values()].sort(
      (a, b) => (b.created_at || 0) - (a.created_at || 0)
    );
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
      notes: body.notes,
      short_url: 'https://rzp.io/i/checkout',
    };
    subs.set(sub.id, sub);
    return sub;
  }

  const cancel = base.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    const sub = subs.get(cancel[1]);
    if (!sub) throw new Error(`404 ${path}`);
    cancels.push({ id: sub.id, body });
    sub.status = 'cancelled';
    return sub;
  }

  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'PATCH') {
    const sub = subs.get(one[1]);
    if (sub?.payment_method === 'upi') {
      throw new Error(
        'Razorpay 400: subscriptions cannot be updated when payment mode is upi'
      );
    }
    Object.assign(sub, { plan_id: body.plan_id });
    return sub;
  }
  if (one && method === 'GET') {
    const sub = subs.get(one[1]);
    if (!sub) throw new Error(`404 ${path}`);
    return sub;
  }

  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

/** Put a subscription on the fake account; defaults to a paying Hookpost one. */
function putSub(id: string, extra: any = {}) {
  const sub = {
    id,
    entity: 'subscription',
    created_at: tick(),
    status: 'active',
    plan_id: 'plan_std',
    customer_id: CUSTOMER,
    payment_method: 'upi',
    notes: { service: 'hookpost', orgId: ORG, billing: 'STANDARD' },
    ...extra,
  };
  subs.set(id, sub);
  return sub;
}

/** The Standard monthly INR plan the paying customer is on. */
function putStandardPlan() {
  plans.set('plan_std', {
    id: 'plan_std',
    period: 'monthly',
    item: { amount: 59900, currency: 'INR' },
    notes: { hookpost_key: buildPlanKey('STANDARD', 'MONTHLY', 59900, 'INR') },
  });
}

function setup(localIdentifier: string | null) {
  let row: any = localIdentifier
    ? {
        organizationId: ORG,
        identifier: localIdentifier,
        subscriptionTier: 'STANDARD',
        period: 'MONTHLY',
        cancelAt: null,
      }
    : null;

  const subscriptions = {
    getSubscription: jest.fn(async () => row),
    // The once-per-person check at approval (trial switch on only).
    refuseTrialAtApproval: jest.fn(async () => false),
    getSubscriptionByIdentifier: jest.fn(async (id: string) =>
      row && row.identifier === id ? row : null
    ),
    createOrUpdateSubscription: jest.fn(
      async (
        _trialing: boolean,
        identifier: string,
        _customer: string,
        _channels: number,
        billing: string,
        period: string
      ) => {
        row = {
          organizationId: ORG,
          identifier,
          subscriptionTier: billing,
          period,
          cancelAt: null,
        };
      }
    ),
    updateCustomerId: jest.fn(async () => undefined),
    deleteSubscriptionByOrg: jest.fn(async () => {
      row = null;
    }),
    scheduleCancellation: jest.fn(async () => undefined),
    redeemCouponByCode: jest.fn(async () => undefined),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({
      id,
      name: 'Chai Point Social',
      paymentId: CUSTOMER,
    })),
    getTeam: jest.fn(async () => ({
      users: [{ user: { id: 'user-1', email: 'priya@chaipoint.in' } }],
    })),
  };
  const track = { track: jest.fn(async () => undefined) };
  const affiliates = {
    recordCommission: jest.fn(async () => undefined), voidForRefund: jest.fn(async () => undefined),
    attributeByCoupon: jest.fn(async () => undefined),
  };

  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    track as any,
    affiliates as any
  );
  return { razorpay, subscriptions, row: () => row };
}

/** The customer picks Pro monthly on the billing page. */
const choosePro = (razorpay: RazorpayService) =>
  razorpay.subscribe(
    'ud-1',
    ORG,
    'user-1',
    { billing: 'PRO', period: 'MONTHLY', currency: 'INR' } as any,
    false
  );

/** Razorpay reports the new mandate as authorised (checkout completed). */
const authenticated = (razorpay: RazorpayService, subId: string) => {
  const sub = subs.get(subId);
  sub.status = 'authenticated';
  return razorpay.handleWebhook({
    event: 'subscription.authenticated',
    payload: { subscription: { entity: sub } },
  });
};

const cancelledIds = () => cancels.map((c) => c.id).sort();

beforeAll(() => {
  // No welcome email: sendSubscriptionWelcomeEmail returns early without a key.
  delete process.env.RESEND_API_KEY;
  delete process.env.RAZORPAY_OFFER_ID;
});

beforeEach(() => {
  plans.clear();
  subs.clear();
  cancels.length = 0;
  mockRequest.mockClear();
  putStandardPlan();
});

describe('subscribe(): opening a new checkout', () => {
  it('cancels only earlier `created` checkouts, never a live plan', async () => {
    putSub('sub_paid'); // the plan they pay for today, on a UPI mandate
    putSub('sub_abandoned', { status: 'created' }); // a checkout they closed
    putSub('sub_auth', { status: 'authenticated' });
    putSub('sub_pending', { status: 'pending' });
    putSub('sub_halted', { status: 'halted' });
    putSub('sub_expired', { status: 'expired' });
    // Same customer on the shared Razorpay account, another product.
    putSub('sub_vetnow', {
      status: 'created',
      notes: { service: 'vetnow', orgId: ORG },
    });
    const { razorpay } = setup('sub_paid');

    const result: any = await choosePro(razorpay);

    // UPI cannot be re-planned in place (mandateRules), so no PATCH is even
    // tried: a fresh checkout was opened.
    expect(mockRequest).not.toHaveBeenCalledWith(
      'PATCH',
      '/subscriptions/sub_paid',
      expect.anything()
    );
    expect(result.subscriptionId).toMatch(/^sub_new_/);
    expect(result.url).toBe('https://rzp.io/i/checkout');

    expect(cancels).toEqual([
      { id: 'sub_abandoned', body: { cancel_at_cycle_end: 0 } },
    ]);
    expect(subs.get('sub_paid').status).toBe('active');
    expect(subs.get('sub_auth').status).toBe('authenticated');
    expect(subs.get('sub_pending').status).toBe('pending');
    expect(subs.get('sub_halted').status).toBe('halted');
    expect(subs.get('sub_vetnow').status).toBe('created');
    expect(subs.get(result.subscriptionId).status).toBe('created');
  });

  it.each(['active', 'authenticated'])(
    'leaves a subscription in %s alone',
    async (status) => {
      // `authenticated` here is a trial, as on the live account: its first
      // charge (start_at) is days away.
      putSub('sub_current', {
        status,
        ...(status === 'authenticated'
          ? { start_at: Math.floor(Date.now() / 1000) + 5 * 86400 }
          : {}),
      });
      const { razorpay } = setup('sub_current');

      await choosePro(razorpay);

      expect(cancels).toEqual([]);
      expect(subs.get('sub_current').status).toBe(status);
    }
  );

  // A renewal Razorpay is retrying (pending) or has given up on (halted).
  // Since the plan-change policy of 29 Oct 2026 the price cannot be moved
  // while a charge on it is unsettled: the move would open a second mandate
  // beside a debit that can still land, and an unpaid cycle would otherwise
  // buy a credit on the new plan. Razorpay refuses it too ("You can only
  // update Subscriptions in the authenticated and active states").
  it.each(['pending', 'halted'])(
    'refuses to change plan while a charge is failing (%s), and creates nothing',
    async (status) => {
      putSub('sub_current', { status });
      const { razorpay } = setup('sub_current');
      const before = subs.size;

      await expect(choosePro(razorpay)).rejects.toMatchObject({
        response: { code: 'PLAN_CHANGE_DUNNING' },
      });

      expect(cancels).toEqual([]);
      expect(subs.size).toBe(before);
      expect(subs.get('sub_current').status).toBe(status);
    }
  );

  // Buying the SAME plan again is not a plan change, and it is how a
  // workspace whose renewal failed pays. It must never be refused.
  it.each(['pending', 'halted'])(
    'still lets a workspace in %s pay for the plan it is already on',
    async (status) => {
      putSub('sub_current', { status });
      const { razorpay } = setup('sub_current');

      const result: any = await razorpay.subscribe(
        'ud-1',
        ORG,
        'user-1',
        { billing: 'STANDARD', period: 'MONTHLY' } as any,
        false
      );

      expect(result.subscriptionId).toMatch(/^sub_new_/);
      expect(cancels).toEqual([]);
      expect(subs.get('sub_current').status).toBe(status);
    }
  );

  it('still clears an earlier abandoned checkout on a first purchase', async () => {
    putSub('sub_abandoned', { status: 'created' });
    const { razorpay } = setup(null);

    const result: any = await choosePro(razorpay);

    expect(cancelledIds()).toEqual(['sub_abandoned']);
    expect(subs.get(result.subscriptionId).status).toBe('created');
  });
});

describe('a paying customer who never completes the new checkout', () => {
  it('keeps their active plan, in Razorpay and in the database', async () => {
    putSub('sub_paid');
    const { razorpay, subscriptions, row } = setup('sub_paid');

    // Opens Pro checkout and closes it. Then tries again and closes it again.
    const first: any = await choosePro(razorpay);
    const second: any = await choosePro(razorpay);

    // The only thing cancelled is the first unpaid checkout, when the second
    // one opened.
    expect(cancels).toEqual([
      { id: first.subscriptionId, body: { cancel_at_cycle_end: 0 } },
    ]);
    expect(subs.get('sub_paid').status).toBe('active');
    expect(subs.get(second.subscriptionId).status).toBe('created');

    // No webhook ever arrives, so the stored plan is untouched.
    expect(subscriptions.createOrUpdateSubscription).not.toHaveBeenCalled();
    expect(subscriptions.deleteSubscriptionByOrg).not.toHaveBeenCalled();
    expect(row()).toMatchObject({
      identifier: 'sub_paid',
      subscriptionTier: 'STANDARD',
    });
  });
});

describe('createSubscription(): the webhook path is unchanged', () => {
  it('retires every other live Hookpost subscription once the replacement is authorised', async () => {
    putSub('sub_paid');
    putSub('sub_abandoned', { status: 'created' });
    putSub('sub_auth', { status: 'authenticated' });
    putSub('sub_pending', { status: 'pending' });
    putSub('sub_halted', { status: 'halted' });
    putSub('sub_expired', { status: 'expired' });
    putSub('sub_cancelled', { status: 'cancelled' });
    putSub('sub_vetnow', {
      status: 'active',
      notes: { service: 'vetnow', orgId: ORG },
    });
    putSub('sub_replacement', { status: 'created' });
    const { razorpay, row } = setup('sub_paid');

    await authenticated(razorpay, 'sub_replacement');

    expect(cancelledIds()).toEqual([
      'sub_abandoned',
      'sub_auth',
      'sub_halted',
      'sub_paid',
      'sub_pending',
    ]);
    for (const c of cancels) {
      expect(c.body).toEqual({ cancel_at_cycle_end: 0 });
    }
    expect(subs.get('sub_replacement').status).toBe('authenticated');
    expect(subs.get('sub_vetnow').status).toBe('active');
    expect(row()).toMatchObject({ identifier: 'sub_replacement' });
  });

  it('a completed plan switch retires the old plan only when the new one is authorised', async () => {
    putSub('sub_paid');
    const { razorpay, row } = setup('sub_paid');

    const opened: any = await choosePro(razorpay);
    expect(cancels).toEqual([]);
    expect(subs.get('sub_paid').status).toBe('active');

    await authenticated(razorpay, opened.subscriptionId);

    expect(cancels).toEqual([
      { id: 'sub_paid', body: { cancel_at_cycle_end: 0 } },
    ]);
    expect(row()).toMatchObject({
      identifier: opened.subscriptionId,
      subscriptionTier: 'PRO',
    });
  });
});
