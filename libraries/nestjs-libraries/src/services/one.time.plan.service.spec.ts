/**
 * One-time checkout for the single plan (one.time.plan.service.ts), tried
 * the ways it can break: a webhook delivered twice, the page and the
 * webhook racing, amount tampering, currency mismatch, an expired order, a
 * customer paying twice, an existing subscription that must stay untouched,
 * and refunds.
 */
import 'reflect-metadata';
import { createHmac } from 'crypto';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service',
  () => ({ AffiliateService: class {} })
);

const redisStore = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes('NX') && redisStore.has(key)) return null;
      redisStore.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => {
      redisStore.delete(key);
      return 1;
    }),
  },
}));

const mockRequest = jest.fn();
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  ...jest.requireActual('@hookpost/nestjs-libraries/services/razorpay.client'),
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

import { OneTimePlanService } from './one.time.plan.service';
import { addOneMonth } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';

const SECRET = 'rzp_test_secret';
const NOW = new Date('2026-11-08T10:00:00.000Z');
const DAY = 86_400_000;
const sign = (orderId: string, paymentId: string) =>
  createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

type Row = {
  identifier: string;
  cancelAt: Date | null;
  deletedAt?: Date | null;
  isLifetime?: boolean;
} | null;

function setup(opts: { row?: Row; ownerCountry?: string | null } = {}) {
  redisStore.clear();
  let row: Row = opts.row ?? null;
  const claims = new Set<string>();
  const subscriptions = {
    getSubscription: jest.fn(async () => (row ? { ...row } : null)),
    getCurrencyFacts: jest.fn(async () => ({
      ownerCountry: opts.ownerCountry ?? null,
      ownerEmail: 'o@example.com',
    })),
    claimOrderPayment: jest.fn(async (_org: string, _order: string, pay: string) => {
      if (claims.has(pay)) return false;
      claims.add(pay);
      return true;
    }),
    releaseOrderPayment: jest.fn(async (_org: string, pay: string) => {
      claims.delete(pay);
    }),
    findOrderPayment: jest.fn(async (pay: string) =>
      claims.has(pay) ? { organizationId: 'org1', subscriptionId: 'order_x' } : null
    ),
    applyOneTimePlan: jest.fn(
      async (_org: string, plan: { identifier: string; cancelAt: Date }) => {
        row = { identifier: plan.identifier, cancelAt: plan.cancelAt };
      }
    ),
    endOneTimePlan: jest.fn(async () => {
      row = null;
      return true;
    }),
  };
  const affiliates = { recordCommission: jest.fn(async () => undefined) };
  const service = new OneTimePlanService(subscriptions as any, affiliates as any);

  // A Razorpay account in memory: orders the service creates, and the
  // payments a test makes on them.
  const orders = new Map<string, any>();
  const payments = new Map<string, any>();
  let seq = 0;
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (method: string, path: string, body: any) => {
    if (method === 'POST' && path === '/orders') {
      const id = `order_T${++seq}`;
      const o = { id, status: 'created', created_at: Math.floor(NOW.getTime() / 1000), ...body };
      orders.set(id, o);
      return o;
    }
    const o = path.match(/^\/orders\/([^/]+)$/);
    if (method === 'GET' && o) return orders.get(decodeURIComponent(o[1]));
    const capture = path.match(/^\/payments\/([^/]+)\/capture$/);
    if (method === 'POST' && capture) {
      const p = payments.get(decodeURIComponent(capture[1]));
      if (body.amount !== p.amount || body.currency !== p.currency) throw new Error('capture mismatch');
      p.status = 'captured';
      return p;
    }
    const p = path.match(/^\/payments\/([^/]+)$/);
    if (method === 'GET' && p) return payments.get(decodeURIComponent(p[1]));
    throw new Error(`unexpected ${method} ${path}`);
  });

  const pay = (orderId: string, over: any = {}) => {
    const order = orders.get(orderId);
    const id = `pay_P${++seq}`;
    const p = {
      id,
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      status: 'captured',
      amount_refunded: 0,
      ...over,
    };
    payments.set(id, p);
    order.status = 'paid';
    return p;
  };
  const handshake = (orderId: string, paymentId: string) => ({
    razorpay_order_id: orderId,
    razorpay_payment_id: paymentId,
    razorpay_signature: sign(orderId, paymentId),
  });
  const webhook = (type: string, payment: any, withOrder = true) => ({
    event: type,
    payload: {
      payment: { entity: payment },
      ...(withOrder ? { order: { entity: orders.get(payment.order_id) } } : {}),
    },
  });

  return {
    service,
    subscriptions,
    affiliates,
    orders,
    payments,
    pay,
    handshake,
    webhook,
    row: () => row,
  };
}

const savedSecret = process.env.RAZORPAY_KEY_SECRET;
beforeAll(() => {
  process.env.RAZORPAY_KEY_SECRET = SECRET;
});
afterAll(() => {
  if (savedSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = savedSecret;
});

describe('createOrder: the server sets the price', () => {
  it('charges Rs 699 in INR to a workspace outside India (shown as $7)', async () => {
    const t = setup({ ownerCountry: 'US' });
    const o = await t.service.createOrder('org1', 'u1', {}, NOW);
    expect(o).toMatchObject({ amount: 69900, currency: 'INR', label: '$7', renew: false });
    const sent = mockRequest.mock.calls.find((c) => c[1] === '/orders')![2];
    expect(sent).toMatchObject({
      amount: 69900,
      currency: 'INR',
      notes: { service: 'hookpost', kind: 'one_time_plan', orgId: 'org1', amount: '69900', currency: 'INR' },
    });
    expect(sent.receipt.length).toBeLessThanOrEqual(40);
  });

  it('charges the same Rs 699 to an Indian owner and when nothing says where', async () => {
    for (const ownerCountry of ['IN', null]) {
      const t = setup({ ownerCountry });
      const o = await t.service.createOrder('org1', 'u1', { requestCountry: 'US' }, NOW);
      expect(o).toMatchObject({ amount: 69900, currency: 'INR' });
    }
  });

  it('refuses an order beside a live Razorpay subscription, and touches nothing', async () => {
    const t = setup({ row: { identifier: 'sub_live', cancelAt: null } });
    await expect(t.service.createOrder('org1', 'u1', {}, NOW)).rejects.toMatchObject({
      response: { code: 'HAS_PLAN' },
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(t.row()).toEqual({ identifier: 'sub_live', cancelAt: null });
  });

  it('refuses a second order while more than 3 days are paid for', async () => {
    const t = setup({ row: { identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 20 * DAY) } });
    await expect(t.service.createOrder('org1', 'u1', {}, NOW)).rejects.toMatchObject({
      response: { code: 'ALREADY_PAID' },
    });
  });

  it('opens the renewal in the last 3 days', async () => {
    const t = setup({ row: { identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 2 * DAY) } });
    expect((await t.service.createOrder('org1', 'u1', {}, NOW)).renew).toBe(true);
  });

  it('a double click gets a 409, not two orders', async () => {
    const t = setup();
    redisStore.set('razorpay:order-lock:org1', '1');
    await expect(t.service.createOrder('org1', 'u1', {}, NOW)).rejects.toMatchObject({
      response: { code: 'ORDER_IN_PROGRESS' },
    });
    expect(t.orders.size).toBe(0);
  });
});

describe('verify: the page reports a payment', () => {
  it('gives one month for a captured payment', async () => {
    const t = setup({ ownerCountry: 'US' });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    const r = await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(r).toMatchObject({ ok: true, granted: true });
    expect(t.row()).toEqual({ identifier: orderId, cancelAt: addOneMonth(NOW) });
    expect(t.affiliates.recordCommission).toHaveBeenCalledWith('org1', expect.objectContaining({ id: p.id }));
  });

  it('refuses a forged signature', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await expect(
      t.service.verify('org1', { ...t.handshake(orderId, p.id), razorpay_signature: 'a'.repeat(64) }, NOW)
    ).rejects.toMatchObject({ response: { code: 'INVALID_SIGNATURE' } });
    expect(t.row()).toBeNull();
  });

  it('refuses another workspace\'s order', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await expect(t.service.verify('org2', t.handshake(orderId, p.id), NOW)).rejects.toMatchObject({
      response: { code: 'WRONG_WORKSPACE' },
    });
  });

  it('refuses a tampered amount (a payment smaller than the order)', async () => {
    const t = setup({ ownerCountry: 'US' });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId, { amount: 100 });
    await expect(t.service.verify('org1', t.handshake(orderId, p.id), NOW)).rejects.toMatchObject({
      response: { code: 'AMOUNT_MISMATCH' },
    });
    expect(t.row()).toBeNull();
  });

  it('refuses a currency mismatch', async () => {
    const t = setup({ ownerCountry: 'US' });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId, { currency: 'USD' });
    await expect(t.service.verify('org1', t.handshake(orderId, p.id), NOW)).rejects.toMatchObject({
      response: { code: 'CURRENCY_MISMATCH' },
    });
  });

  it('captures an authorized payment for exactly the order amount', async () => {
    const t = setup({ ownerCountry: 'US' });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId, { status: 'authorized' });
    const r = await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(r.granted).toBe(true);
    expect(mockRequest).toHaveBeenCalledWith('POST', `/payments/${p.id}/capture`, {
      amount: 69900,
      currency: 'INR',
    });
  });

  it('does not capture on an expired order', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId, { status: 'authorized' });
    const later = new Date(NOW.getTime() + 2 * DAY);
    await expect(t.service.verify('org1', t.handshake(orderId, p.id), later)).rejects.toMatchObject({
      response: { code: 'ORDER_EXPIRED' },
    });
    expect(t.payments.get(p.id).status).toBe('authorized');
    expect(t.row()).toBeNull();
  });

  it('a payment Razorpay captured on an old order still counts: the money was taken', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    const later = new Date(NOW.getTime() + 2 * DAY);
    expect((await t.service.verify('org1', t.handshake(orderId, p.id), later)).granted).toBe(true);
  });

  it('an unpaid (failed) payment gives nothing', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId, { status: 'failed' });
    await expect(t.service.verify('org1', t.handshake(orderId, p.id), NOW)).rejects.toMatchObject({
      response: { code: 'NOT_CAPTURED' },
    });
  });
});

describe('idempotency', () => {
  it('a webhook delivered twice gives one month', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    expect(await t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_1', NOW)).toBe(true);
    expect(await t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_1', NOW)).toBe(true);
    expect(t.subscriptions.applyOneTimePlan).toHaveBeenCalledTimes(1);
    expect(t.row()!.cancelAt).toEqual(addOneMonth(NOW));
  });

  it('order.paid, payment.captured and the page for one payment give one month', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_a', NOW);
    await t.service.handleWebhook('payment.captured', t.webhook('payment.captured', p, false), 'evt_b', NOW);
    const r = await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(r).toMatchObject({ granted: false, reason: 'ALREADY_GRANTED' });
    expect(t.subscriptions.applyOneTimePlan).toHaveBeenCalledTimes(1);
    expect(t.row()!.cancelAt).toEqual(addOneMonth(NOW));
  });

  it('the page and the webhook at the same moment give one month', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await Promise.all([
      t.service.verify('org1', t.handshake(orderId, p.id), NOW),
      t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_c', NOW),
    ]);
    expect(t.subscriptions.applyOneTimePlan).toHaveBeenCalledTimes(1);
  });

  it('a user who pays twice (two tabs) gets two months, back to back', async () => {
    const t = setup();
    const a = await t.service.createOrder('org1', 'u1', {}, NOW);
    const b = await t.service.createOrder('org1', 'u1', {}, NOW);
    const pa = t.pay(a.orderId);
    const pb = t.pay(b.orderId);
    await Promise.all([
      t.service.verify('org1', t.handshake(a.orderId, pa.id), NOW),
      t.service.verify('org1', t.handshake(b.orderId, pb.id), NOW),
    ]);
    expect(t.row()!.cancelAt).toEqual(addOneMonth(addOneMonth(NOW)));
  });

  it('a renewal paid in the last 3 days adds a month after the current one', async () => {
    const end = new Date(NOW.getTime() + 2 * DAY);
    const t = setup({ row: { identifier: 'order_A', cancelAt: end } });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(t.row()).toEqual({ identifier: 'order_A', cancelAt: addOneMonth(end) });
  });

  it('a renewal after the month ran out starts from now, on the new order', async () => {
    const t = setup({ row: { identifier: 'order_A', cancelAt: new Date(NOW.getTime() - 3 * DAY) } });
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(t.row()).toEqual({ identifier: orderId, cancelAt: addOneMonth(NOW) });
  });

  it('a failed plan write is not remembered, so Razorpay\'s retry grants it', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    t.subscriptions.applyOneTimePlan.mockRejectedValueOnce(new Error('db down'));
    await expect(
      t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_r', NOW)
    ).rejects.toThrow('db down');
    expect(await t.service.handleWebhook('order.paid', t.webhook('order.paid', p), 'evt_r', NOW)).toBe(true);
    expect(t.row()!.cancelAt).toEqual(addOneMonth(NOW));
  });
});

describe('existing plans stay untouched', () => {
  it('an order paid after a subscription started gives no month and leaves the subscription', async () => {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    // A subscription activated between opening checkout and paying.
    await t.subscriptions.applyOneTimePlan('org1', { identifier: 'sub_live', cancelAt: null as any });
    t.subscriptions.applyOneTimePlan.mockClear();
    const p = t.pay(orderId);
    const r = await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    expect(r).toMatchObject({ granted: false, reason: 'HAS_PLAN' });
    expect(t.subscriptions.applyOneTimePlan).not.toHaveBeenCalled();
    expect(t.row()!.identifier).toBe('sub_live');
  });
});

describe('webhooks that are not ours', () => {
  it('ignores a subscription charge and another product\'s order', async () => {
    const t = setup();
    expect(
      await t.service.handleWebhook(
        'payment.captured',
        { payload: { payment: { entity: { id: 'pay_s', invoice_id: 'inv_1', order_id: 'order_s' } } } },
        'e1',
        NOW
      )
    ).toBe(false);
    t.orders.set('order_tab', {
      id: 'order_tab',
      amount: 100,
      currency: 'INR',
      notes: { service: 'tablamigo' },
    });
    expect(
      await t.service.handleWebhook(
        'payment.captured',
        { payload: { payment: { entity: { id: 'pay_t', order_id: 'order_tab', status: 'captured' } } } },
        'e2',
        NOW
      )
    ).toBe(false);
    expect(await t.service.handleWebhook('subscription.charged', {}, 'e3', NOW)).toBe(false);
    expect(t.subscriptions.applyOneTimePlan).not.toHaveBeenCalled();
  });
});

describe('refunds', () => {
  async function paidOnce() {
    const t = setup();
    const { orderId } = await t.service.createOrder('org1', 'u1', {}, NOW);
    const p = t.pay(orderId);
    await t.service.verify('org1', t.handshake(orderId, p.id), NOW);
    return { t, p };
  }

  it('a full refund of the only month ends the plan', async () => {
    const { t, p } = await paidOnce();
    p.amount_refunded = p.amount;
    expect(await t.service.handleRefund({ payment_id: p.id }, p, NOW)).toBe(true);
    expect(t.subscriptions.endOneTimePlan).toHaveBeenCalledTimes(1);
    expect(t.row()).toBeNull();
    // Delivered again: nothing more.
    expect(await t.service.handleRefund({ payment_id: p.id }, p, NOW)).toBe(true);
    expect(t.subscriptions.endOneTimePlan).toHaveBeenCalledTimes(1);
  });

  it('a goodwill refund under 90% keeps the month', async () => {
    const { t, p } = await paidOnce();
    p.amount_refunded = Math.floor(p.amount * 0.5);
    expect(await t.service.handleRefund({ payment_id: p.id }, p, NOW)).toBe(true);
    expect(t.subscriptions.endOneTimePlan).not.toHaveBeenCalled();
    expect(t.row()!.cancelAt).toEqual(addOneMonth(NOW));
  });

  it('a refund of a payment that gave no month is left to the subscription rules', async () => {
    const t = setup();
    expect(await t.service.handleRefund({ payment_id: 'pay_unknown' }, undefined, NOW)).toBe(false);
  });
});

describe('quote', () => {
  it('says what the page shows', async () => {
    const t = setup({ ownerCountry: 'GB' });
    expect(await t.service.quote('org1', {}, NOW)).toMatchObject({
      name: 'Hookpost',
      tier: 'HOOKPOST',
      currency: 'INR',
      price: 699,
      label: '$7',
      canBuy: true,
      renew: false,
      paidUntil: null,
    });
    const end = new Date(NOW.getTime() + 10 * DAY);
    const t2 = setup({ ownerCountry: 'IN', row: { identifier: 'order_A', cancelAt: end } });
    expect(await t2.service.quote('org1', {}, NOW)).toMatchObject({
      currency: 'INR',
      price: 699,
      canBuy: false,
      refusal: 'ALREADY_PAID',
      paidUntil: end.toISOString(),
    });
  });
});

describe('saved card for one-click renewal (Razorpay tokens only)', () => {
  const tokens = (items: any[]) => {
    const base = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (method: string, path: string, body: any) => {
      if (method === 'GET' && path === '/customers/cust_1/tokens') return { items };
      if (method === 'DELETE' && path.startsWith('/customers/cust_1/tokens/')) {
        const id = path.split('/').pop();
        items.splice(items.findIndex((t) => t.id === id), 1);
        return { deleted: true };
      }
      return base(method, path, body);
    });
  };
  const card = (over: any = {}) => ({
    id: 'token_A',
    method: 'card',
    card: { last4: '4242', network: 'Visa' },
    created_at: 1,
    expired_at: Math.floor(NOW.getTime() / 1000) + 365 * 86_400,
    ...over,
  });

  it('no token: checkout asks for a card, as on a first payment', async () => {
    const t = setup();
    tokens([]);
    expect((await t.service.quote('org1', {}, NOW, 'cust_1')).savedCard).toBeNull();
    const o = await t.service.createOrder('org1', 'u1', {}, NOW, 'cust_1');
    expect(o).toMatchObject({ customerId: 'cust_1', savedCard: null });
  });

  it('no Razorpay customer yet: no saved card, and nothing is asked of Razorpay for it', async () => {
    const t = setup();
    expect((await t.service.quote('org1', {}, NOW, null)).savedCard).toBeNull();
    expect(mockRequest.mock.calls.some((c) => String(c[1]).includes('/tokens'))).toBe(false);
  });

  it('a live token: the renewal names the card, never stores its number', async () => {
    const t = setup();
    tokens([card()]);
    const q = await t.service.quote('org1', {}, NOW, 'cust_1');
    expect(q.savedCard).toEqual({ id: 'token_A', last4: '4242', network: 'Visa', expired: false });
    expect(JSON.stringify(q)).not.toMatch(/\d{12,}/);
  });

  it('an expired token is reported as expired; a live one is preferred over it', async () => {
    const t = setup();
    tokens([card({ expired_at: Math.floor(NOW.getTime() / 1000) - 10 })]);
    expect((await t.service.quote('org1', {}, NOW, 'cust_1')).savedCard).toMatchObject({ expired: true });
    tokens([
      card({ id: 'token_OLD', expired_at: Math.floor(NOW.getTime() / 1000) - 10, created_at: 5 }),
      card({ id: 'token_NEW', created_at: 2 }),
    ]);
    expect((await t.service.quote('org1', {}, NOW, 'cust_1')).savedCard).toMatchObject({
      id: 'token_NEW',
      expired: false,
    });
  });

  it('the user removes the saved card: Razorpay deletes the token, the next checkout has none', async () => {
    const t = setup();
    const items = [card()];
    tokens(items);
    expect(await t.service.removeSavedCard('cust_1', 'token_A')).toEqual({ removed: true });
    expect(mockRequest).toHaveBeenCalledWith('DELETE', '/customers/cust_1/tokens/token_A');
    expect((await t.service.quote('org1', {}, NOW, 'cust_1')).savedCard).toBeNull();
  });

  it('refuses to delete a token that is not this customer\'s', async () => {
    const t = setup();
    tokens([card()]);
    await expect(t.service.removeSavedCard('cust_1', 'token_SOMEONE')).rejects.toMatchObject({
      response: { code: 'NO_SAVED_CARD' },
    });
    expect(mockRequest.mock.calls.some((c) => c[0] === 'DELETE')).toBe(false);
  });

  it('Razorpay down: the page still opens, just without a saved card', async () => {
    const t = setup();
    const base = mockRequest.getMockImplementation()!;
    mockRequest.mockImplementation(async (m: string, p: string, b: any) => {
      if (p.includes('/tokens')) throw new Error('Razorpay GET failed (502)');
      return base(m, p, b);
    });
    expect((await t.service.quote('org1', {}, NOW, 'cust_1')).savedCard).toBeNull();
  });
});
