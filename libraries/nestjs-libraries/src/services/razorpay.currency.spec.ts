import 'reflect-metadata';
import {
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { buildPlanKey } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { resetUsdCheckoutWarnings } from '@hookpost/nestjs-libraries/services/billing.currency';

// The server, not the browser, decides what a checkout charges. Razorpay,
// Redis and the database are fakes: nothing leaves the machine.

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
const NOW = Date.now();

// Fake Razorpay account. `failSubscriptionGet` simulates Razorpay being
// unreachable for a single-subscription read.
const plans = new Map<string, any>();
const subs = new Map<string, any>();
const payments = new Map<string, any>();
let failSubscriptionGet: 'none' | '500' | '404' = 'none';
/** The workspace's creator, as SubscriptionService.getCurrencyFacts reads it. */
let ownerFacts: { ownerCountry: string | null; ownerEmail: string | null } | null = {
  ownerCountry: null,
  ownerEmail: 'owner@chai.example',
};

const mockRequest = jest.fn(async (method: string, path: string, body?: any) => {
  const [base, query] = path.split('?');

  if (method === 'POST' && base === '/customers') return { id: CUSTOMER };
  if (method === 'GET' && base === '/plans') return { items: [...plans.values()] };
  if (method === 'POST' && base === '/plans') {
    const plan = { id: `plan_${plans.size + 1}`, ...body };
    plans.set(plan.id, plan);
    return plan;
  }
  if (method === 'GET' && base.startsWith('/plans/')) {
    const plan = plans.get(base.slice('/plans/'.length));
    if (!plan) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return plan;
  }

  if (method === 'GET' && base === '/subscriptions') {
    // As live Razorpay: no customer filter (400 if one is sent).
    const q = new URLSearchParams(query || '');
    if (q.has('customer_id')) {
      throw new Error(
        `Razorpay GET ${path} failed (400): customer_id is/are not required and should not be sent`
      );
    }
    const skip = Number(q.get('skip') || 0);
    return { items: [...subs.values()].slice(skip, skip + 100) };
  }
  if (method === 'POST' && base === '/subscriptions') {
    const sub = {
      id: `sub_new_${subs.size + 1}`,
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
    sub.status = 'cancelled';
    return sub;
  }

  const one = base.match(/^\/subscriptions\/([^/]+)$/);
  if (one && method === 'GET') {
    if (failSubscriptionGet === '500') {
      throw new Error(`Razorpay GET ${path} failed (500): server error`);
    }
    const sub = subs.get(one[1]);
    if (!sub || failSubscriptionGet === '404') {
      throw new Error(`Razorpay GET ${path} failed (404): The id provided does not exist`);
    }
    return sub;
  }
  // The card behind a mandate: its newest invoice's payment.
  if (method === 'GET' && base === '/invoices') {
    const subId = new URLSearchParams(query || '').get('subscription_id') || '';
    return { items: payments.has(`pay_${subId}`) ? [{ id: `inv_${subId}`, payment_id: `pay_${subId}` }] : [] };
  }
  const pay = base.match(/^\/payments\/([^/]+)$/);
  if (pay && method === 'GET') {
    const p = payments.get(decodeURIComponent(pay[1]));
    if (!p) throw new Error(`Razorpay GET ${path} failed (404): not found`);
    return p;
  }

  if (one && method === 'PATCH') {
    const sub = subs.get(one[1]);
    if (sub?.payment_method === 'upi') {
      throw new Error('Razorpay 400: subscriptions cannot be updated when payment mode is upi');
    }
    Object.assign(sub, { plan_id: body.plan_id });
    return sub;
  }

  throw new Error(`unexpected Razorpay call ${method} ${path}`);
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

function putPlan(id: string, currency: string, amount: number) {
  plans.set(id, {
    id,
    period: 'monthly',
    item: { amount, currency },
    notes: { hookpost_key: buildPlanKey('STANDARD', 'MONTHLY', amount, currency) },
  });
}

/** A Hookpost subscription on the fake account; a paying INR one by default. */
/**
 * `intlCard` puts the payment of a card issued outside India behind it,
 * which is the only card Razorpay re-plans in place (mandateRules).
 */
function putSub(id: string, extra: any = {}) {
  if (extra.intlCard) {
    payments.set(`pay_${id}`, { id: `pay_${id}`, method: 'card', international: true });
  }
  subs.set(id, {
    id,
    status: 'active',
    plan_id: 'plan_inr',
    customer_id: CUSTOMER,
    payment_method: 'card',
    notes: { service: 'hookpost', orgId: ORG },
    ...extra,
  });
}

function setup(localRow: any | null) {
  const subscriptions = {
    getSubscription: jest.fn(async () => localRow),
    trialDaysFor: jest.fn(async (_org: string, base: number = 3) => base),
    getSubscriptionByIdentifier: jest.fn(async () => null),
    validateCoupon: jest.fn(),
    createOrUpdateSubscription: jest.fn(),
    updateCustomerId: jest.fn(),
    getCurrencyFacts: jest.fn(async () => ownerFacts),
  };
  const organizations = {
    getOrgById: jest.fn(async (id: string) => ({ id, name: 'Chai Point', paymentId: CUSTOMER })),
    getTeam: jest.fn(async () => ({ users: [] })),
  };
  const razorpay = new RazorpayService(
    subscriptions as any,
    organizations as any,
    {} as any,
    { track: jest.fn() } as any,
    {} as any
  );
  return { razorpay, subscriptions };
}

const row = (identifier: string, extra: any = {}) => ({
  organizationId: ORG,
  identifier,
  subscriptionTier: 'STANDARD',
  period: 'MONTHLY',
  isLifetime: false,
  deletedAt: null,
  cancelAt: null,
  ...extra,
});

const checkout = (razorpay: RazorpayService, body: any = {}) =>
  razorpay.embedded(
    'ud-1',
    ORG,
    'user-1',
    { billing: 'STANDARD', period: 'MONTHLY', ...body },
    false
  );

const writes = () =>
  mockRequest.mock.calls
    .filter(([method]) => method !== 'GET')
    .map(([method, path]) => `${method} ${path}`);

const createdPlans = () =>
  mockRequest.mock.calls
    .filter(([method, path]) => method === 'POST' && path === '/plans')
    .map(([, , body]) => body);

beforeEach(() => {
  plans.clear();
  subs.clear();
  failSubscriptionGet = 'none';
  mockRequest.mockClear();
  payments.clear();
  ownerFacts = { ownerCountry: null, ownerEmail: 'owner@chai.example' };
  putPlan('plan_inr', 'INR', 59900);
  // A legacy USD plan at $15, from before the USD rail's $19.
  putPlan('plan_usd', 'USD', 1500);
  delete process.env.RAZORPAY_OFFER_ID;
  delete process.env.INTL_CHECKOUT;
  delete process.env.USD_CHECKOUT;
  delete process.env.USD_ALLOWLIST;
  delete process.env.USD_EXCLUDED_COUNTRIES;
  delete process.env.GST_LUT_ARN;
  resetUsdCheckoutWarnings();
});

describe('subscribe()/embedded(): the client never picks the currency', () => {
  it.each([['INR'], ['inr'], [undefined]])(
    'a request saying %p is charged in INR',
    async (asked) => {
      const { razorpay } = setup(null);

      const result: any = await checkout(razorpay, asked ? { currency: asked } : {});

      const created = subs.get(result.subscriptionId);
      expect(plans.get(created.plan_id).item).toEqual({ amount: 59900, currency: 'INR' });
      expect(created.notes.currency).toBe('INR');
      // The modal is told what the subscription charges, not what was asked.
      expect(result.currency).toBe('INR');
      expect(createdPlans().every((p) => p.item.currency === 'INR')).toBe(true);
    }
  );

  // Only a tab opened before the deploy sends a currency. If it is showing
  // dollars, its labels no longer match what checkout charges.
  it('a stale page asking for USD is told to reload, and nothing is created', async () => {
    const { razorpay } = setup(null);

    const err = await checkout(razorpay, { currency: 'USD' }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      statusCode: 409,
      code: 'CURRENCY_CHANGED',
      message: 'Prices on this page are out of date. Please reload.',
    });
    expect(writes()).toEqual([]);
  });

  it('prorate prices in INR whatever the page sends', async () => {
    putSub('sub_inr');
    const { razorpay } = setup(row('sub_inr'));
    const asked = await razorpay.prorate(ORG, {
      billing: 'PRO',
      period: 'MONTHLY',
      currency: 'USD',
    } as any);
    const plain = await razorpay.prorate(ORG, { billing: 'PRO', period: 'MONTHLY' } as any);
    // nextChargeAt is "a cycle from now", read a moment apart.
    const { nextChargeAt: askedAt, ...askedRest } = asked as any;
    const { nextChargeAt: plainAt, ...plainRest } = plain as any;
    expect(askedRest).toEqual(plainRest);
    expect(Math.abs(askedAt.getTime() - plainAt.getTime())).toBeLessThan(1000);
    // ₹1,999 less the unused part of ₹599: well above any dollar figure.
    expect(asked.price).toBeGreaterThan(1300);
  });
});

describe('the currency lock', () => {
  // PR-4: a live plan holds the workspace to its currency, and a USD one is
  // now a currency checkout sells, so it is kept in dollars instead of being
  // refused. 0 USD subscriptions were ever authorised, so no workspace had one.
  it.each([['active'], ['authenticated']])(
    'a live USD plan in %s keeps dollars: a page asking for rupees is told to reload, and nothing is created',
    async (status) => {
      putSub('sub_usd', { status, plan_id: 'plan_usd' });
      const { razorpay } = setup(row('sub_usd'));

      const err = await checkout(razorpay, { currency: 'INR' }).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ statusCode: 409, code: 'CURRENCY_CHANGED' });
      expect(writes()).toEqual([]);
    }
  );

  it('a live USD plan changes plan in dollars, in place, with USD_CHECKOUT off', async () => {
    putSub('sub_usd', { plan_id: 'plan_usd', intlCard: true });
    const { razorpay } = setup(row('sub_usd'));

    const result: any = await checkout(razorpay, { billing: 'PRO' });

    expect(result.currency).toBe('USD');
    expect(writes()).toContain('PATCH /subscriptions/sub_usd');
    expect(plans.get(subs.get('sub_usd').plan_id).item).toEqual(
      expect.objectContaining({ amount: 2900, currency: 'USD' })
    );
    expect(createdPlans().every((p) => p.item.currency === 'USD')).toBe(true);
  });

  it('a cancelled USD plan still running until a future cancelAt keeps dollars too', async () => {
    putSub('sub_usd', { status: 'cancelled', plan_id: 'plan_usd' });
    const { razorpay } = setup(
      row('sub_usd', { cancelAt: new Date(NOW + 10 * 86400 * 1000) })
    );

    // A change of plan: the same plan again goes through Reactivate now.
    const result: any = await checkout(razorpay, { billing: 'PRO' });

    expect(result.currency).toBe('USD');
    expect(createdPlans().every((p) => p.item.currency === 'USD')).toBe(true);
  });

  it('a live plan in a currency no checkout sells is refused with 409, creating nothing', async () => {
    putPlan('plan_eur', 'EUR', 1500);
    putSub('sub_eur', { plan_id: 'plan_eur' });
    const { razorpay } = setup(row('sub_eur'));

    const err = await checkout(razorpay).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: 'CURRENCY_LOCKED', lockedCurrency: 'EUR' });
    expect(writes()).toEqual([]);
  });

  it('the currency comes from the plan, not the subscription notes', async () => {
    putSub('sub_usd', { plan_id: 'plan_usd', notes: { service: 'hookpost', currency: 'INR' } });
    const { razorpay } = setup(row('sub_usd'));
    expect(await razorpay.liveEntitlementCurrency(ORG)).toBe('USD');
  });

  it.each([['halted'], ['pending']])(
    'a USD plan in %s does not lock: a new INR checkout opens, and the old plan is not moved across currencies',
    async (status) => {
      putSub('sub_usd', { status, plan_id: 'plan_usd' });
      const { razorpay } = setup(row('sub_usd'));

      const result: any = await checkout(razorpay);

      expect(result.currency).toBe('INR');
      expect(result.subscriptionId).toMatch(/^sub_new_/);
      expect(writes()).not.toContain('PATCH /subscriptions/sub_usd');
      // Left for createSubscription to retire once the new one is authorised.
      expect(subs.get('sub_usd').status).toBe(status);
    }
  );

  it('an org on a live INR plan paid by a foreign card can still change plan in place', async () => {
    putSub('sub_inr', { intlCard: true });
    const { razorpay } = setup(row('sub_inr'));

    const result: any = await checkout(razorpay, { billing: 'PRO' });

    expect(result).toMatchObject({ currency: 'INR' });
    expect(writes()).toContain('PATCH /subscriptions/sub_inr');
    expect(plans.get(subs.get('sub_inr').plan_id).item.currency).toBe('INR');
  });

  it('an INR plan on an Indian card opens a new mandate: Razorpay updates only the offer of a domestic card', async () => {
    putSub('sub_inr');
    const { razorpay } = setup(row('sub_inr'));

    const result: any = await checkout(razorpay, { billing: 'PRO' });

    expect(result).toMatchObject({ currency: 'INR' });
    expect(result.subscriptionId).toMatch(/^sub_new_/);
    expect(writes()).not.toContain('PATCH /subscriptions/sub_inr');
  });

  it('a stale page asking for USD never moves a live INR plan', async () => {
    putSub('sub_inr');
    const { razorpay } = setup(row('sub_inr'));
    const before = subs.get('sub_inr').plan_id;

    const err = await checkout(razorpay, { currency: 'USD' }).catch((e) => e);

    expect(err.getResponse()).toMatchObject({ code: 'CURRENCY_CHANGED' });
    expect(writes()).toEqual([]);
    expect(subs.get('sub_inr').plan_id).toBe(before);
  });

  it('a lifetime plan never locks and is never looked up', async () => {
    const { razorpay } = setup(row('LIFETIME-CODE', { isLifetime: true }));
    expect(await razorpay.liveEntitlementCurrency(ORG)).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('a subscription Razorpay does not know (404) holds nothing', async () => {
    const { razorpay } = setup(row('sub_from_test_mode'));
    expect(await razorpay.liveEntitlementCurrency(ORG)).toBeNull();
    const result: any = await checkout(razorpay);
    expect(result.currency).toBe('INR');
  });

  it('when Razorpay cannot be read, checkout answers 503 instead of guessing', async () => {
    putSub('sub_usd', { plan_id: 'plan_usd' });
    failSubscriptionGet = '500';
    const { razorpay } = setup(row('sub_usd'));

    const err = await checkout(razorpay).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: 'CURRENCY_LOCK_UNKNOWN' });
    expect(writes()).toEqual([]);
  });
});

describe('getPricingContext()', () => {
  const US = { 'cf-ipcountry': 'US' };

  it('anonymous: never asks Razorpay, and quotes INR to a US visitor', async () => {
    const { razorpay, subscriptions } = setup(row('sub_usd'));
    const ctx = await razorpay.getPricingContext({ headers: US, tz: 'America/New_York' });
    expect(ctx).toMatchObject({
      displayCurrency: 'INR',
      chargeCurrency: 'INR',
      checkoutAllowed: true,
      lockedCurrency: null,
      region: { country: 'US', ipSaysIndia: false, tzSaysIndia: false },
      prices: { STANDARD: { month: 599, year: 5990 } },
    });
    expect(subscriptions.getSubscription).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('signed in on a live USD plan: shown in USD, locked, and still allowed to change plan', async () => {
    putSub('sub_usd', { plan_id: 'plan_usd' });
    const { razorpay } = setup(row('sub_usd'));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG, headers: US });
    expect(ctx).toMatchObject({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      lockedCurrency: 'USD',
      checkoutAllowed: true,
      prices: { STANDARD: { month: 19, year: 190 } },
      // What the legacy plan itself charges.
      currentPlan: { currency: 'USD', amount: 15 },
    });
  });

  it('signed in, Razorpay unreachable: falls back to INR rather than failing the page', async () => {
    putSub('sub_usd', { plan_id: 'plan_usd' });
    failSubscriptionGet = '500';
    const { razorpay } = setup(row('sub_usd'));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG, headers: US });
    expect(ctx).toMatchObject({ chargeCurrency: 'INR', lockedCurrency: null });
  });

  it('ignores x-country and treats XX as no country', async () => {
    const { razorpay } = setup(null);
    const ctx = await razorpay.getPricingContext({
      headers: { 'x-country': 'IN', 'cf-ipcountry': 'XX' },
      tz: 'Europe/Berlin',
    });
    expect(ctx.region).toEqual({ country: null, ipSaysIndia: false, tzSaysIndia: false });
  });

  it('reads USD_CHECKOUT on every call, and ignores INTL_CHECKOUT', async () => {
    const { razorpay } = setup(null);
    const usVisitor = () => razorpay.getPricingContext({ headers: US, tz: 'America/New_York' });

    process.env.INTL_CHECKOUT = 'usd';
    process.env.GST_LUT_ARN = 'AD0910260000000';
    expect((await usVisitor()).chargeCurrency).toBe('INR');

    process.env.USD_CHECKOUT = 'on';
    const on = await usVisitor();
    expect(on).toMatchObject({ chargeCurrency: 'USD', displayCurrency: 'USD' });
    expect(on.prices.STANDARD.month).toBe(19);

    process.env.USD_CHECKOUT = 'off';
    expect((await usVisitor()).chargeCurrency).toBe('INR');
  });
});

describe('getPricingContext(): what the current plan card shows', () => {
  const DAY_MS = 86400 * 1000;
  const reads = () =>
    mockRequest.mock.calls
      .filter(([method]) => method === 'GET')
      .map(([, path]) => path);

  /** Standard monthly at Rs 699: the price before 6dae2e4c cut it to Rs 599. */
  function putOldPlan(id = 'plan_std_699', period: 'MONTHLY' | 'YEARLY' = 'MONTHLY', amount = 69900) {
    plans.set(id, {
      id,
      period: period === 'YEARLY' ? 'yearly' : 'monthly',
      item: { amount, currency: 'INR' },
      notes: { hookpost_key: buildPlanKey('STANDARD', period, amount, 'INR') },
    });
  }

  it('a subscriber on the older Rs 699 plan is told Rs 699; the list price stays Rs 599', async () => {
    putOldPlan();
    putSub('sub_old', { plan_id: 'plan_std_699' });
    const { razorpay } = setup(row('sub_old'));

    const ctx = await razorpay.getPricingContext({ organizationId: ORG });

    expect(ctx.currentPlan).toEqual({
      billing: 'STANDARD',
      period: 'MONTHLY',
      currency: 'INR',
      amount: 699,
    });
    expect(ctx.prices.STANDARD).toEqual({ month: 599, year: 5990 });
    // The same two reads the currency check already made, and nothing else.
    expect(reads()).toEqual(['/subscriptions/sub_old', '/plans/plan_std_699']);
  });

  it('says the same price as the Change payment method quote', async () => {
    putOldPlan();
    putSub('sub_old', {
      plan_id: 'plan_std_699',
      current_end: Math.floor(NOW / 1000) + 20 * 86400,
    });
    const { razorpay } = setup(row('sub_old'));

    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    const quote = await razorpay.quoteReplacementMandate(ORG, 'payment_method');

    expect(quote).toMatchObject({
      billing: ctx.currentPlan!.billing,
      period: ctx.currentPlan!.period,
      currency: ctx.currentPlan!.currency,
      amount: ctx.currentPlan!.amount,
    });
  });

  it('reads the plan once; later page loads take it from the cache', async () => {
    putOldPlan();
    putSub('sub_old', { plan_id: 'plan_std_699' });
    const { razorpay } = setup(row('sub_old'));

    await razorpay.getPricingContext({ organizationId: ORG });
    await razorpay.getPricingContext({ organizationId: ORG });

    expect(reads().filter((p) => p.startsWith('/plans/'))).toEqual([
      '/plans/plan_std_699',
    ]);
  });

  it('a subscriber at the list price gets the list price back', async () => {
    putSub('sub_inr');
    const { razorpay } = setup(row('sub_inr'));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    expect(ctx.currentPlan).toEqual({
      billing: 'STANDARD',
      period: 'MONTHLY',
      currency: 'INR',
      amount: 599,
    });
  });

  it('a yearly plan is reported as yearly, at its yearly amount', async () => {
    putOldPlan('plan_std_6990_y', 'YEARLY', 699000);
    putSub('sub_year', { plan_id: 'plan_std_6990_y' });
    const { razorpay } = setup(row('sub_year', { period: 'YEARLY' }));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    expect(ctx.currentPlan).toEqual({
      billing: 'STANDARD',
      period: 'YEARLY',
      currency: 'INR',
      amount: 6990,
    });
  });

  it('a plan set to end still shows its price until it ends (Reactivate keeps it)', async () => {
    putOldPlan();
    putSub('sub_old', { status: 'cancelled', plan_id: 'plan_std_699' });
    const { razorpay } = setup(
      row('sub_old', { cancelAt: new Date(NOW + 10 * DAY_MS) })
    );
    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    expect(ctx.currentPlan?.amount).toBe(699);
  });

  it.each([
    ['ended', { status: 'cancelled' }, {}],
    ['never approved', { status: 'created' }, {}],
    ['not opened by Hookpost for this workspace', { notes: { service: 'hookpost', orgId: 'org-other' } }, {}],
  ])('no price for a plan that is %s: the card keeps the list price', async (_label, sub, extraRow) => {
    putOldPlan();
    putSub('sub_old', { plan_id: 'plan_std_699', ...sub });
    const { razorpay } = setup(row('sub_old', extraRow));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    expect(ctx.currentPlan).toBeNull();
    expect(ctx.prices.STANDARD.month).toBe(599);
  });

  it('a plan Razorpay will not hand over: list prices, and no second attempt', async () => {
    putSub('sub_old', {
      plan_id: 'plan_gone',
      notes: { service: 'hookpost', orgId: ORG, currency: 'INR' },
    });
    const { razorpay } = setup(row('sub_old'));

    const ctx = await razorpay.getPricingContext({ organizationId: ORG });

    expect(ctx).toMatchObject({ chargeCurrency: 'INR', currentPlan: null });
    expect(reads().filter((p) => p.startsWith('/plans/'))).toEqual(['/plans/plan_gone']);
  });

  it('Razorpay unreachable: list prices, and the page still loads', async () => {
    putOldPlan();
    putSub('sub_old', { plan_id: 'plan_std_699' });
    failSubscriptionGet = '500';
    const { razorpay } = setup(row('sub_old'));
    const ctx = await razorpay.getPricingContext({ organizationId: ORG });
    expect(ctx).toMatchObject({ chargeCurrency: 'INR', currentPlan: null });
  });

  it('lifetime and free workspaces have no plan price, and Razorpay is not asked', async () => {
    const lifetime = setup(row('LIFETIME-CODE', { isLifetime: true }));
    expect((await lifetime.razorpay.getPricingContext({ organizationId: ORG })).currentPlan).toBeNull();
    const free = setup(null);
    expect((await free.razorpay.getPricingContext({ organizationId: ORG })).currentPlan).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('the public pricing context carries no plan price at all', async () => {
    const { razorpay } = setup(row('sub_inr'));
    const ctx = await razorpay.getPricingContext({ headers: { 'cf-ipcountry': 'IN' } });
    expect('currentPlan' in ctx).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PR-4: the USD rail (ships off). local-assets/trial-usd-plan-2026-10-18.md.
// ---------------------------------------------------------------------------

describe('the USD rail', () => {
  const LUT = 'AD0910260000000';
  const US = { 'cf-ipcountry': 'US' };
  const IN = { 'cf-ipcountry': 'IN' };

  /** The live account's USD Standard plan, which checkout must reuse. */
  function putLiveUsdStandard() {
    plans.set('plan_TcvgEaf5Av5gBI', {
      id: 'plan_TcvgEaf5Av5gBI',
      period: 'monthly',
      item: { amount: 1900, currency: 'USD' },
      notes: { hookpost_key: 'STANDARD|MONTHLY|1900|USD' },
    });
  }

  const usdOn = () => {
    process.env.USD_CHECKOUT = 'on';
    process.env.GST_LUT_ARN = LUT;
  };

  const embeddedWith = (
    razorpay: RazorpayService,
    hints: { requestCountry?: string | null; tz?: string | null },
    body: any = {},
    allowTrial = true
  ) =>
    razorpay.embedded(
      'ud-1',
      ORG,
      'user-1',
      { billing: 'STANDARD', period: 'MONTHLY', ...body },
      allowTrial,
      hints
    );

  describe('shipped off', () => {
    it('a US workspace is charged rupees and its creator is never read', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: 'owner@chai.example' };
      process.env.GST_LUT_ARN = LUT; // an LUT alone changes nothing
      const { razorpay, subscriptions } = setup(null);

      const result: any = await embeddedWith(razorpay, { requestCountry: 'US' });

      expect(result.currency).toBe('INR');
      expect(plans.get(subs.get(result.subscriptionId).plan_id).item).toEqual({
        amount: 59900,
        currency: 'INR',
      });
      expect(subscriptions.getCurrencyFacts).not.toHaveBeenCalled();
    });

    it('an allowlist with USD_CHECKOUT off does nothing', async () => {
      process.env.USD_ALLOWLIST = 'owner@chai.example';
      ownerFacts = { ownerCountry: 'US', ownerEmail: 'owner@chai.example' };
      const { razorpay } = setup(null);
      expect(((await embeddedWith(razorpay, {})) as any).currency).toBe('INR');
    });
  });

  describe('USD_CHECKOUT=on with an LUT', () => {
    beforeEach(usdOn);

    it('a US creator gets the live $19 Standard plan, reused, not recreated', async () => {
      putLiveUsdStandard();
      ownerFacts = { ownerCountry: 'US', ownerEmail: 'owner@chai.example' };
      const { razorpay } = setup(null);

      const result: any = await embeddedWith(razorpay, { requestCountry: 'US' });

      const created = subs.get(result.subscriptionId);
      expect(result.currency).toBe('USD');
      expect(created.plan_id).toBe('plan_TcvgEaf5Av5gBI');
      expect(created.notes).toMatchObject({ currency: 'USD', billing: 'STANDARD', orgId: ORG });
      expect(createdPlans()).toEqual([]);
    });

    it('Pro has no USD plan yet, so the first checkout creates PRO|MONTHLY|2900|USD', async () => {
      ownerFacts = { ownerCountry: 'GB', ownerEmail: 'owner@chai.example' };
      const { razorpay } = setup(null);

      const result: any = await embeddedWith(razorpay, {}, { billing: 'PRO' });

      expect(result.currency).toBe('USD');
      expect(createdPlans()).toEqual([
        expect.objectContaining({
          period: 'monthly',
          item: expect.objectContaining({ amount: 2900, currency: 'USD' }),
          notes: expect.objectContaining({ hookpost_key: 'PRO|MONTHLY|2900|USD' }),
        }),
      ]);
      // And a second checkout finds it instead of making another.
      await embeddedWith(razorpay, {}, { billing: 'PRO' });
      expect(createdPlans()).toHaveLength(1);
    });

    it('yearly is $190 and $290', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: null };
      const { razorpay } = setup(null);
      await embeddedWith(razorpay, {}, { period: 'YEARLY' });
      await embeddedWith(razorpay, {}, { billing: 'PRO', period: 'YEARLY' });
      expect(createdPlans().map((p) => p.notes.hookpost_key)).toEqual([
        'STANDARD|YEARLY|19000|USD',
        'PRO|YEARLY|29000|USD',
      ]);
    });

    it('a percentOff coupon in USD buys its own discounted dollar plan', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: null };
      const { razorpay, subscriptions } = setup(null);
      subscriptions.validateCoupon.mockResolvedValue({
        ok: true,
        coupon: { id: 'c1', code: 'LAUNCH10', percentOff: 10, freeMonths: null },
      });

      const result: any = await embeddedWith(razorpay, {}, { coupon: 'LAUNCH10' });

      const created = subs.get(result.subscriptionId);
      expect(result.currency).toBe('USD');
      expect(plans.get(created.plan_id).item).toEqual(
        expect.objectContaining({ amount: 1710, currency: 'USD' })
      );
      expect(plans.get(created.plan_id).notes.hookpost_key).toBe('STANDARD|MONTHLY|1710|USD');
      expect(created.notes.coupon).toBe('LAUNCH10');
      // The list-price plan is untouched by the coupon.
      expect(createdPlans().map((p) => p.item.amount)).toEqual([1710]);
    });

    it('an Indian creator stays on rupees, wherever the request comes from', async () => {
      ownerFacts = { ownerCountry: 'IN', ownerEmail: null };
      const { razorpay } = setup(null);
      const result: any = await embeddedWith(razorpay, { requestCountry: 'US', tz: 'America/New_York' });
      expect(result.currency).toBe('INR');
    });

    it('an account with no signup country follows the request, and a Kolkata clock means India', async () => {
      ownerFacts = { ownerCountry: null, ownerEmail: null };
      const { razorpay } = setup(null);
      expect(((await embeddedWith(razorpay, { requestCountry: 'US' })) as any).currency).toBe('USD');
      expect(
        ((await embeddedWith(razorpay, { requestCountry: 'US' }, { tz: 'Asia/Kolkata' })) as any).currency
      ).toBe('INR');
    });

    it('an excluded country is charged rupees (T13)', async () => {
      process.env.USD_EXCLUDED_COUNTRIES = 'EU27,EEA,GB';
      ownerFacts = { ownerCountry: 'DE', ownerEmail: null };
      const { razorpay } = setup(null);
      expect(((await embeddedWith(razorpay, { requestCountry: 'DE' })) as any).currency).toBe('INR');
    });

    it('an INR plan whose renewal is being retried keeps the workspace on rupees', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: null };
      putSub('sub_inr', { status: 'halted' });
      const { razorpay } = setup(row('sub_inr'));

      const result: any = await embeddedWith(razorpay, { requestCountry: 'US' });

      expect(result.currency).toBe('INR');
      expect(createdPlans().every((p) => p.item.currency === 'INR')).toBe(true);
    });

    it('a live INR plan is never moved to dollars', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: null };
      putSub('sub_inr');
      const { razorpay } = setup(row('sub_inr'));

      const result: any = await embeddedWith(razorpay, { requestCountry: 'US' }, { billing: 'PRO' });

      expect(result.currency).toBe('INR');
      expect(plans.get(subs.get('sub_inr').plan_id).item.currency).toBe('INR');
    });

    it('creator facts that cannot be read leave the request to decide, not a failure', async () => {
      const { razorpay, subscriptions } = setup(null);
      subscriptions.getCurrencyFacts.mockRejectedValue(new Error('db down'));
      expect(((await embeddedWith(razorpay, { requestCountry: 'IN' })) as any).currency).toBe('INR');
      expect(((await embeddedWith(razorpay, { requestCountry: 'US' })) as any).currency).toBe('USD');
    });
  });

  describe('USD_CHECKOUT=allowlist (the L2 card test)', () => {
    beforeEach(() => {
      process.env.USD_CHECKOUT = 'allowlist';
      process.env.USD_ALLOWLIST = 'cardholder@abroad.example, org-listed';
    });

    it('the allowlisted creator email gets dollars, whatever the geo and without an LUT', async () => {
      putLiveUsdStandard();
      for (const country of ['US', 'IN', null]) {
        ownerFacts = { ownerCountry: country, ownerEmail: 'CardHolder@abroad.example' };
        const { razorpay } = setup(null);
        const result: any = await embeddedWith(razorpay, { requestCountry: country });
        expect(result.currency).toBe('USD');
        expect(subs.get(result.subscriptionId).plan_id).toBe('plan_TcvgEaf5Av5gBI');
      }
    });

    it('anyone else is charged as before', async () => {
      ownerFacts = { ownerCountry: 'US', ownerEmail: 'someone@else.example' };
      const { razorpay } = setup(null);
      expect(((await embeddedWith(razorpay, { requestCountry: 'US' })) as any).currency).toBe('INR');
    });
  });

  describe('what the page shows is what checkout charges', () => {
    const scenarios: Array<{
      label: string;
      env: Record<string, string>;
      owner: { ownerCountry: string | null; ownerEmail: string | null };
      headers: Record<string, string>;
      tz: string;
    }> = [
      { label: 'off, US', env: {}, owner: { ownerCountry: 'US', ownerEmail: null }, headers: US, tz: 'America/New_York' },
      { label: 'on, US', env: { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT }, owner: { ownerCountry: 'US', ownerEmail: null }, headers: US, tz: 'America/New_York' },
      { label: 'on, no LUT', env: { USD_CHECKOUT: 'on' }, owner: { ownerCountry: 'US', ownerEmail: null }, headers: US, tz: 'America/New_York' },
      { label: 'on, IN', env: { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT }, owner: { ownerCountry: 'IN', ownerEmail: null }, headers: IN, tz: 'Asia/Kolkata' },
      { label: 'on, DE excluded', env: { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT, USD_EXCLUDED_COUNTRIES: 'DE' }, owner: { ownerCountry: 'DE', ownerEmail: null }, headers: { 'cf-ipcountry': 'DE' }, tz: 'Europe/Berlin' },
      { label: 'on, unknown owner, US IP, Kolkata clock', env: { USD_CHECKOUT: 'on', GST_LUT_ARN: LUT }, owner: { ownerCountry: null, ownerEmail: null }, headers: US, tz: 'Asia/Kolkata' },
      { label: 'allowlisted', env: { USD_CHECKOUT: 'allowlist', USD_ALLOWLIST: 'a@b.co' }, owner: { ownerCountry: 'IN', ownerEmail: 'a@b.co' }, headers: IN, tz: 'Asia/Kolkata' },
    ];

    it.each(scenarios.map((s) => [s.label, s] as const))('%s', async (_label, sc) => {
      Object.assign(process.env, sc.env);
      ownerFacts = sc.owner;
      const { razorpay } = setup(null);

      const ctx = await razorpay.getPricingContext({
        organizationId: ORG,
        headers: sc.headers,
        tz: sc.tz,
      });
      const result: any = await embeddedWith(
        razorpay,
        { requestCountry: sc.headers['cf-ipcountry'] },
        { tz: sc.tz }
      );
      const plan = plans.get(subs.get(result.subscriptionId).plan_id);

      expect(ctx.displayCurrency).toBe(ctx.chargeCurrency);
      expect(result.currency).toBe(ctx.chargeCurrency);
      expect(plan.item.currency).toBe(ctx.chargeCurrency);
      expect(plan.item.amount).toBe(ctx.prices.STANDARD.month * 100);
    });
  });

  describe('/razorpay/verify: a foreign card on a rupee mandate is logged, never refused', () => {
    const warnings = (razorpay: RazorpayService) =>
      jest.spyOn((razorpay as any).logger, 'warn').mockImplementation(() => undefined);

    it('logs an INR authorisation by an international card', async () => {
      payments.set('pay_intl', {
        id: 'pay_intl',
        currency: 'INR',
        method: 'card',
        international: true,
        card: { network: 'Visa', type: 'credit', international: true, last4: '4242', name: 'A Person' },
      });
      const { razorpay } = setup(null);
      const warn = warnings(razorpay);

      expect(await razorpay.noteInternationalInrAuth('sub_1', 'pay_intl')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('International card on an INR mandate');
      expect(warn.mock.calls[0][0]).toContain('sub_1');
      // No cardholder details in the log.
      expect(warn.mock.calls[0][0]).not.toMatch(/4242|A Person/);
      // Read-only: nothing was written to Razorpay.
      expect(writes()).toEqual([]);
    });

    it.each([
      ['a domestic card', { currency: 'INR', international: false, card: { international: false } }],
      ['UPI', { currency: 'INR', method: 'upi', international: false }],
      ['a USD authorisation', { currency: 'USD', international: true, card: { international: true } }],
    ])('says nothing for %s', async (_label, payment) => {
      payments.set('pay_x', { id: 'pay_x', ...payment });
      const { razorpay } = setup(null);
      const warn = warnings(razorpay);
      expect(await razorpay.noteInternationalInrAuth('sub_1', 'pay_x')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('a payment it cannot read is not an error', async () => {
      const { razorpay } = setup(null);
      warnings(razorpay);
      await expect(razorpay.noteInternationalInrAuth('sub_1', 'pay_missing')).resolves.toBe(false);
      await expect(razorpay.noteInternationalInrAuth('sub_1', '')).resolves.toBe(false);
    });
  });
});
