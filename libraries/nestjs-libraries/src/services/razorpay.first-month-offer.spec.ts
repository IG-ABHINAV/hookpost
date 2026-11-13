/**
 * subscribe() and the first-month offer (first.month.offer.ts): which
 * subscriptions carry an offer_id, which offer, and that checkout still opens
 * when Razorpay refuses the offer.
 */
import 'reflect-metadata';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository',
  () => ({ SubscriptionRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
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

const mockRequest = jest.fn();
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

const UPI = 'offer_UpiTest0000001';
const CARD = 'offer_CardTest000001';
const ENV_KEYS = [
  'RAZORPAY_OFFER_FIRST_MONTH_UPI',
  'RAZORPAY_OFFER_FIRST_MONTH_CARD',
  'RAZORPAY_OFFER_ID',
  'RAZORPAY_TRIAL_DAYS',
  'USD_CHECKOUT',
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI = UPI;
  process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD = CARD;
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/**
 * `current`: the subscription row the workspace already has (a plan change),
 * with the live Razorpay subscription behind it.
 * `refuse`: Razorpay answers POST /subscriptions with an offer_id with this.
 */
const setup = (
  opts: {
    current?: any;
    refuse?: string;
    coupon?: any;
    /** What personHadBefore answers (default: nobody had anything). */
    prior?: any;
    /** Subscriptions on the Razorpay account (GET /subscriptions?count=...). */
    listed?: any[];
  } = {}
) => {
  const repo = {
    findCouponByCode: jest.fn(async () => opts.coupon ?? null),
    countCouponRedemptions: jest.fn(async () => 0),
    hasRedeemedCoupon: jest.fn(async () => false),
    getSubscription: jest.fn(async () => opts.current?.row ?? null),
    updateCustomerId: jest.fn(),
  };
  const subscriptions = new SubscriptionService(repo as any, {} as any, {} as any, {} as any);
  const personHadBefore = jest
    .spyOn(subscriptions, 'personHadBefore')
    .mockImplementation(async () =>
      opts.prior instanceof Error
        ? Promise.reject(opts.prior)
        : opts.prior ?? { had: false, by: null, related: [] }
    );
  const recordBillingIdentities = jest
    .spyOn(subscriptions, 'recordBillingIdentities')
    .mockResolvedValue(undefined);
  const workspacesPaidWithMethod = jest
    .spyOn(subscriptions, 'workspacesPaidWithMethod')
    .mockResolvedValue([]);
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({ id, paymentId: `cust_${id}` })),
  };
  const razorpay = new RazorpayService(
    subscriptions,
    organizations as any,
    {} as any,
    {} as any,
    {} as any
  );

  const posted: any[] = [];
  const cancelled: string[] = [];
  const plans = new Map<string, any>();
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (method: string, path: string, body: any) => {
    if (method === 'GET' && path.startsWith('/plans?')) return { items: [...plans.values()] };
    const plan = path.match(/^\/plans\/([^/?]+)$/);
    if (method === 'GET' && plan) return plans.get(plan[1]) ?? opts.current?.plan;
    if (method === 'POST' && path === '/plans') {
      const created = { id: `plan_${plans.size + 1}`, ...body };
      plans.set(created.id, created);
      return created;
    }
    if (method === 'POST' && path === '/subscriptions') {
      posted.push(body);
      if (body.offer_id && opts.refuse) {
        throw new Error(`Razorpay POST /subscriptions failed (400): ${opts.refuse}`);
      }
      return { id: `sub_new${posted.length}`, short_url: 'https://rzp.io/i/x', created_at: 2e9 };
    }
    const one = path.match(/^\/subscriptions\/([^/?]+)$/);
    if (method === 'GET' && one) return opts.current?.remote;
    if (method === 'PATCH' && one) {
      // Every payment this account has taken was UPI.
      throw new Error(
        `Razorpay PATCH ${path} failed (400): subscriptions cannot be updated when payment mode is upi`
      );
    }
    const cancel = path.match(/^\/subscriptions\/([^/?]+)\/cancel$/);
    if (method === 'POST' && cancel) {
      cancelled.push(cancel[1]);
      return { id: cancel[1], status: 'cancelled' };
    }
    if (method === 'GET' && path.startsWith('/subscriptions')) return { items: opts.listed ?? [] };
    throw new Error(`unexpected Razorpay call ${method} ${path}`);
  });

  // subscribe() returns a union: a plan change (in place, or during a trial)
  // has no firstMonthOffer at all, which the frontend reads as "no offer"
  // (checkoutDroppedOffer). out.firstMonthOffer does not type-check on that
  // union, so the specs assert it with toHaveProperty (key present, value).
  const subscribe = (body: Record<string, any>, allowTrial: boolean) =>
    razorpay.subscribe(
      'ud-1',
      'org-1',
      'user-1',
      { billing: 'STANDARD', period: 'MONTHLY', ...body } as any,
      allowTrial
    );

  return {
    subscribe,
    posted,
    cancelled,
    razorpay,
    personHadBefore,
    recordBillingIdentities,
    workspacesPaidWithMethod,
  };
};

/** An offer checkout of another workspace on the Razorpay account. */
const offerSub = (id: string, orgId: string, status: string, extra: any = {}) => ({
  id,
  status,
  offer_id: UPI,
  paid_count: 0,
  created_at: 1.9e9,
  notes: { service: 'hookpost', orgId },
  ...extra,
});

describe('subscribe(): the single plan (HOOKPOST)', () => {
  it('autopay at Rs 699 a month on its own Razorpay INR plan, flat: no offer, never yearly', async () => {
    const { subscribe, posted } = setup();
    const out = await subscribe({ billing: 'HOOKPOST', period: 'YEARLY', payWith: 'upi' }, false);
    expect(posted).toHaveLength(1);
    expect(posted[0].offer_id).toBeUndefined();
    expect(posted[0].notes).toMatchObject({ service: 'hookpost', billing: 'HOOKPOST', period: 'MONTHLY' });
    expect(out).toHaveProperty('firstMonthOffer', null);
    const planCall = mockRequest.mock.calls.find((c) => c[0] === 'POST' && c[1] === '/plans');
    expect(planCall?.[2]).toMatchObject({
      period: 'monthly',
      item: { amount: 69900, currency: 'INR' },
      notes: { hookpost_key: 'HOOKPOST|MONTHLY|69900|INR' },
    });
  });
});

describe('subscribe(): the first-month offer', () => {
  it('a new rupee monthly plan charged now gets the UPI offer by default', async () => {
    const { subscribe, posted } = setup();
    const out = await subscribe({}, false);
    expect(posted).toHaveLength(1);
    expect(posted[0].offer_id).toBe(UPI);
    expect(posted[0].start_at).toBeUndefined();
    expect(posted[0].notes).toMatchObject({ service: 'hookpost', offer: 'upi', period: 'MONTHLY' });
    expect(out).toHaveProperty('firstMonthOffer', 'upi');
  });

  it('the card offer when the customer chose card; Pro too', async () => {
    const { subscribe, posted } = setup();
    const out = await subscribe({ billing: 'PRO', payWith: 'card' }, false);
    expect(posted[0].offer_id).toBe(CARD);
    expect(posted[0].notes.offer).toBe('card');
    expect(out).toHaveProperty('firstMonthOffer', 'card');
  });

  it('not on a trial: Razorpay refuses an offer on a subscription with a start_at', async () => {
    const { subscribe, posted } = setup();
    const out = await subscribe({ payWith: 'card' }, true);
    expect(posted[0].start_at).toBeGreaterThan(Date.now() / 1000);
    expect(posted[0]).not.toHaveProperty('offer_id');
    expect(posted[0].notes).not.toHaveProperty('offer');
    expect(out).toHaveProperty('firstMonthOffer', null);
  });

  it('not on yearly', async () => {
    const { subscribe, posted } = setup();
    await subscribe({ period: 'YEARLY' }, false);
    expect(posted[0]).not.toHaveProperty('offer_id');
  });

  it('not with a percentOff coupon (an affiliate code): the coupon wins', async () => {
    const { subscribe, posted } = setup({
      coupon: {
        id: 'c1',
        code: 'asha123',
        active: true,
        percentOff: 10,
        freeMonths: null,
        maxRedemptions: null,
        expiresAt: null,
      },
    });
    await subscribe({ coupon: 'asha123' }, false);
    expect(posted[0]).not.toHaveProperty('offer_id');
    expect(posted[0].notes.coupon).toBe('asha123');
  });

  it('not on a plan change: the workspace already has a subscription', async () => {
    const { subscribe, posted } = setup({
      current: {
        row: {
          identifier: 'sub_old',
          organizationId: 'org-1',
          subscriptionTier: 'STANDARD',
          period: 'MONTHLY',
          isLifetime: false,
          cancelAt: null,
          deletedAt: null,
        },
        remote: {
          id: 'sub_old',
          status: 'active',
          plan_id: 'plan_old',
          paid_count: 3,
          notes: { service: 'hookpost', orgId: 'org-1', currency: 'INR' },
          created_at: 1.7e9,
        },
        plan: {
          id: 'plan_old',
          period: 'monthly',
          item: { amount: 59900, currency: 'INR' },
          notes: { hookpost_key: 'STANDARD|MONTHLY|59900|INR' },
        },
      },
    });
    // Standard -> Pro: the PATCH is refused on UPI and a fresh mandate opens.
    await subscribe({ billing: 'PRO', payWith: 'upi' }, false);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toHaveProperty('offer_id');
  });

  it('not when no offer id is configured: checkout exactly as before', async () => {
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI;
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD;
    const { subscribe, posted } = setup();
    const out = await subscribe({ payWith: 'upi' }, false);
    expect(posted[0]).not.toHaveProperty('offer_id');
    expect(out).toHaveProperty('firstMonthOffer', null);
  });

  it('the old RAZORPAY_OFFER_ID is never attached (it would break every trial checkout)', async () => {
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI;
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD;
    process.env.RAZORPAY_OFFER_ID = 'offer_Legacy00000001';
    const { subscribe, posted } = setup();
    await subscribe({}, true);
    await subscribe({}, false);
    expect(posted.every((b) => !('offer_id' in b))).toBe(true);
  });

  it.each([
    'Offer not applicable for this subscription',
    'Offer Not Found',
    'The offer has expired',
  ])('Razorpay refuses the offer (%s): the same checkout opens at the full price', async (why) => {
    const { subscribe, posted } = setup({ refuse: why });
    const out = await subscribe({ payWith: 'card' }, false);
    expect(posted).toHaveLength(2);
    expect(posted[0].offer_id).toBe(CARD);
    expect(posted[1]).not.toHaveProperty('offer_id');
    expect(posted[1].notes).not.toHaveProperty('offer');
    expect(posted[1].plan_id).toBe(posted[0].plan_id);
    expect(out.subscriptionId).toBe('sub_new2');
    expect(out).toHaveProperty('firstMonthOffer', null);
  });
});

describe('pricing context: the first-month offer terms', () => {
  it('none even with the offer configured: the single plan on sale is a flat price (8 Nov 2026)', async () => {
    const { razorpay } = setup();
    const ctx = await razorpay.getPricingContext({ headers: { 'cf-ipcountry': 'IN' } });
    expect(ctx.chargeCurrency).toBe('INR');
    expect(ctx.firstMonthOffer).toBeNull();
  });

  it('null with no offer configured', async () => {
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_UPI;
    delete process.env.RAZORPAY_OFFER_FIRST_MONTH_CARD;
    const { razorpay } = setup();
    const ctx = await razorpay.getPricingContext({ headers: { 'cf-ipcountry': 'IN' } });
    expect(ctx.firstMonthOffer).toBeNull();
  });
});

describe('the first-month offer once per person', () => {
  it('no offer, and no offer_id, when the people behind the workspace had a plan or the offer', async () => {
    const { subscribe, posted, personHadBefore } = setup({
      prior: { had: true, by: 'email', related: [] },
    });
    const out = await subscribe({}, false);
    expect(personHadBefore).toHaveBeenCalledWith('org-1', ['PAID', 'OFFER'], { userId: 'user-1' });
    expect(posted[0]).not.toHaveProperty('offer_id');
    expect(out).toHaveProperty('firstMonthOffer', null);
  });

  it('the no-guard path: a new person gets the offer exactly as before', async () => {
    const { subscribe, posted } = setup({ prior: { had: false, by: null, related: [] } });
    const out = await subscribe({}, false);
    expect(posted[0].offer_id).toBe(UPI);
    expect(out).toHaveProperty('firstMonthOffer', 'upi');
  });

  it('is not asked when the checkout would not get the offer anyway (yearly, trial)', async () => {
    const { subscribe, personHadBefore } = setup();
    await subscribe({ period: 'YEARLY' }, false);
    await subscribe({}, true);
    expect(personHadBefore).not.toHaveBeenCalled();
  });

  it('a lookup that fails gives the offer (fails open, logged)', async () => {
    const { subscribe, posted } = setup({ prior: new Error('db down') });
    await subscribe({}, false);
    expect(posted[0].offer_id).toBe(UPI);
  });

  it('two tabs: a tied workspace whose offer subscription Razorpay approved (no webhook yet) refuses the offer', async () => {
    const { subscribe, posted, cancelled } = setup({
      prior: { had: false, by: null, related: ['org-2'] },
      listed: [offerSub('sub_other', 'org-2', 'active', { paid_count: 1 })],
    });
    const out = await subscribe({}, false);
    expect(posted[0]).not.toHaveProperty('offer_id');
    expect(out).toHaveProperty('firstMonthOffer', null);
    expect(cancelled).toEqual([]);
  });

  it("two tabs: the tied workspace's older open offer checkout is cancelled, the new one keeps the offer", async () => {
    const { subscribe, posted, cancelled } = setup({
      prior: { had: false, by: null, related: ['org-2'] },
      listed: [
        offerSub('sub_older', 'org-2', 'created'),
        offerSub('sub_newer', 'org-2', 'created', { created_at: 2.1e9 }),
        offerSub('sub_foreign', 'org-2', 'created', { notes: { orgId: 'org-2' } }),
        { ...offerSub('sub_nooffer', 'org-2', 'created'), offer_id: null },
      ],
    });
    await subscribe({}, false);
    expect(posted[0].offer_id).toBe(UPI);
    // Only ours (notes.service), with an offer, not approved, and older.
    expect(cancelled).toEqual(['sub_older']);
  });

  it('two checkouts in the same second: exactly one survives (the lower id goes)', async () => {
    // The new checkout is sub_new1, created_at 2e9 (the fake's POST /subscriptions).
    const { subscribe, cancelled } = setup({
      prior: { had: false, by: null, related: ['org-2'] },
      listed: [
        offerSub('sub_aaa', 'org-2', 'created', { created_at: 2e9 }),
        offerSub('sub_zzz', 'org-2', 'created', { created_at: 2e9 }),
      ],
    });
    await subscribe({}, false);
    expect(cancelled).toEqual(['sub_aaa']);
  });

  it('no tied workspace: nothing on the account is listed or cancelled', async () => {
    const { subscribe, cancelled } = setup({
      listed: [offerSub('sub_x', 'org-9', 'created')],
    });
    await subscribe({}, false);
    expect(cancelled).toEqual([]);
  });

  it('pricing context: no offer terms, for a workspace that had it or a new one', async () => {
    const had = setup({ prior: { had: true, by: 'channel', related: [] } });
    const ctx = await had.razorpay.getPricingContext({
      organizationId: 'org-1',
      headers: { 'cf-ipcountry': 'IN' },
      includeCurrentPlan: false,
    });
    expect(ctx.firstMonthOffer).toBeNull();

    const fresh = setup();
    const ctx2 = await fresh.razorpay.getPricingContext({
      organizationId: 'org-1',
      headers: { 'cf-ipcountry': 'IN' },
      includeCurrentPlan: false,
    });
    // None for anyone since 8 Nov 2026: the single plan is a flat price.
    expect(ctx2.firstMonthOffer).toBeNull();
    // The pricing page never cancels anything or lists the account.
    expect(fresh.cancelled).toEqual([]);
  });
});
