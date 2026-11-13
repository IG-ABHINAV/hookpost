import 'reflect-metadata';

// The super-admin refund tool against a fake Razorpay, a fake audit table and
// a fake Redis that honours NX and runs the compare-and-delete release.
// Nothing here reaches Razorpay.

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));

const redisData = new Map<string, string>();
// true: ioRedis is redis.service's in-memory stand-in (no REDIS_URL).
let mockRedisIsMock = false;
const mockRedis = {
  down: false,
  set: jest.fn(async (key: string, value: string, ...args: any[]) => {
    if (mockRedis.down) throw new Error('ECONNREFUSED');
    if (args.includes('NX') && redisData.has(key)) return null;
    redisData.set(key, value);
    return 'OK';
  }),
  del: jest.fn(async (key: string) => (redisData.delete(key) ? 1 : 0)),
  // The release script: deletes the key only while it holds ARGV[1].
  eval: jest.fn(async (_script: string, _keys: number, key: string, token: string) => {
    if (redisData.get(key) !== token) return 0;
    redisData.delete(key);
    return 1;
  }),
};
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: mockRedis,
  get ioRedisIsMock() {
    return mockRedisIsMock;
  },
}));

// Razorpay: GETs read `store`; a refund POST behaves like Razorpay's, including
// X-Refund-Idempotency (same key, same refund) and the amount checks.
const store = new Map<string, any>();
const posts: { path: string; body: any; headers: any }[] = [];
const idempotent = new Map<string, any>();
let failNextPost: string | null = null;
// Runs as a refund POST arrives, before it is answered.
let beforePost: (() => void) | null = null;
// Razorpay accepts the refund (2xx) but creates it as status 'failed'.
let refundsFail = false;
// GET /v1/refunds throws this.
let failRefundList: string | null = null;
// GET /v1/disputes throws this.
let failDisputeList: string | null = null;
const mockRequest = jest.fn(async (method: string, path: string, body?: any, headers?: any) => {
  if (method === 'GET') {
    const key = path.split('?')[0];
    if (key === '/payments') {
      return { items: [...store.values()].filter((v) => v.entity === 'payment') };
    }
    if (key === '/disputes') {
      if (failDisputeList) throw new Error(failDisputeList);
      // Newest first, from/skip/count like Razorpay's GET /v1/disputes (no payment filter).
      const q = new URLSearchParams(path.split('?')[1] || '');
      const from = Number(q.get('from') || 0);
      const skip = Number(q.get('skip') || 0);
      const count = Number(q.get('count') || 10);
      const all = [...store.values()]
        .filter((v) => v.entity === 'dispute' && v.created_at >= from)
        .sort((a, b) => b.created_at - a.created_at);
      return { entity: 'collection', count: Math.min(count, all.length - skip), items: all.slice(skip, skip + count) };
    }
    if (key === '/refunds') {
      if (failRefundList) throw new Error(failRefundList);
      // Newest first, paged by skip/count like Razorpay's GET /v1/refunds.
      const q = new URLSearchParams(path.split('?')[1] || '');
      const skip = Number(q.get('skip') || 0);
      const count = Number(q.get('count') || 10);
      const all = [...store.values()]
        .filter((v) => v.entity === 'refund')
        .sort((a, b) => b.created_at - a.created_at);
      return { entity: 'collection', count: all.length, items: all.slice(skip, skip + count) };
    }
    if (!store.has(key)) {
      throw new Error(`Razorpay GET ${path} failed (400): The id provided does not exist`);
    }
    return store.get(key);
  }
  posts.push({ path, body, headers });
  beforePost?.();
  if (failNextPost) {
    const msg = failNextPost;
    failNextPost = null;
    throw new Error(msg);
  }
  const key = headers?.['X-Refund-Idempotency'];
  if (key && idempotent.has(key)) return idempotent.get(key);
  const paymentId = path.split('/')[2];
  const pay = store.get(`/payments/${paymentId}`);
  if (refundsFail) {
    return {
      id: `rfnd_${posts.length}`,
      entity: 'refund',
      amount: body.amount,
      currency: pay.currency,
      payment_id: paymentId,
      status: 'failed',
    };
  }
  const left = pay.amount - pay.amount_refunded;
  if (left <= 0) {
    throw new Error(`Razorpay POST ${path} failed (400): The payment has been fully refunded already`);
  }
  if (body.amount > left) {
    throw new Error(`Razorpay POST ${path} failed (400): The refund amount provided is greater than amount captured`);
  }
  pay.amount_refunded += body.amount;
  if (pay.amount_refunded >= pay.amount) pay.status = 'refunded';
  const refund = {
    id: `rfnd_${posts.length}`,
    entity: 'refund',
    amount: body.amount,
    currency: pay.currency,
    payment_id: paymentId,
    status: 'pending',
  };
  if (key) idempotent.set(key, refund);
  return refund;
});
jest.mock('@hookpost/nestjs-libraries/services/razorpay.client', () => ({
  RazorpayClient: jest.fn().mockImplementation(() => ({ request: mockRequest })),
}));

import { RefundsService, refundQuote } from './refunds.service';

const audits: any[] = [];
let auditTableMissing = false;
const repository = {
  createAudit: jest.fn(async (data: any) => {
    if (auditTableMissing) throw new Error('relation "RefundAudit" does not exist');
    const row = { id: `audit_${audits.length + 1}`, ...data };
    audits.push(row);
    return row;
  }),
  finishAudit: jest.fn(async (id: string, data: any) => {
    Object.assign(audits.find((a) => a.id === id), data);
  }),
  listAudit: jest.fn(async () => {
    if (auditTableMissing) throw new Error('relation "RefundAudit" does not exist');
    return audits;
  }),
  auditByRefundIds: jest.fn(async (ids: string[]) => {
    if (auditTableMissing) throw new Error('relation "RefundAudit" does not exist');
    return audits.filter((a) => a.refundId && ids.includes(a.refundId));
  }),
  organizationNames: jest.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, name: `Workspace ${id}` }))
  ),
};

const ADMIN = { id: 'u-admin', email: 'owner@hookstep.in' };
// Razorpay ids are pay_ + 14 characters.
const PAY = 'pay_TqFWpXxKSIObH8';
const SUB_CHARGE = 'pay_SubCharge00001';
const VETNOW = 'pay_VetNowPay00001';
const UNTAGGED = 'pay_Untagged000001';

const payment = (id: string, over: any = {}) =>
  store.set(`/payments/${id}`, {
    id,
    entity: 'payment',
    amount: 59900,
    amount_refunded: 0,
    currency: 'INR',
    status: 'captured',
    method: 'upi',
    email: 'buyer@example.com',
    invoice_id: null,
    notes: [],
    created_at: Math.floor(Date.now() / 1000) - 3600,
    ...over,
  });

const corrections: any[] = [];
const accountCorrection = {
  notify: jest.fn(async (correction: any) => {
    corrections.push(correction);
    return 'sent';
  }),
};

function service() {
  const s = new RefundsService(repository as any, accountCorrection as any);
  (s as any).bulkDelayMs = 0;
  return s;
}

beforeEach(() => {
  store.clear();
  posts.length = 0;
  idempotent.clear();
  audits.length = 0;
  corrections.length = 0;
  redisData.clear();
  mockRedis.down = false;
  mockRedisIsMock = false;
  auditTableMissing = false;
  failNextPost = null;
  beforePost = null;
  refundsFail = false;
  failRefundList = null;
  failDisputeList = null;
  jest.clearAllMocks();

  // The owner's $1 USD test link: notes.service = 'hookpost-test' (live data, 20 Oct).
  payment(PAY, {
    amount: 100,
    currency: 'USD',
    method: 'card',
    notes: { purpose: 'usd-card-test-2026-10-20', service: 'hookpost-test' },
  });
  // A Hookpost subscription charge: no notes of its own, found through its invoice.
  payment(SUB_CHARGE, { invoice_id: 'inv_1' });
  store.set('/invoices/inv_1', { id: 'inv_1', subscription_id: 'sub_hp' });
  store.set('/subscriptions/sub_hp', { id: 'sub_hp', notes: { service: 'hookpost', orgId: 'org-1' } });
  // Another product on the same Razorpay account.
  payment(VETNOW, { invoice_id: 'inv_vet' });
  store.set('/invoices/inv_vet', { id: 'inv_vet', subscription_id: 'sub_vet' });
  store.set('/subscriptions/sub_vet', { id: 'sub_vet', notes: { service: 'vetnow' } });
  // Nothing says whose it is (the Rs 5 mandate check looks like this).
  payment(UNTAGGED, { amount: 500 });
});

describe('ownership: only positively Hookpost payments are refundable by default', () => {
  it('identifies by payment notes, then by invoice -> subscription notes; untagged is not ours', async () => {
    const s = service();
    const owner = async (id: string) => s.ownerOf(store.get(`/payments/${id}`));
    expect(await owner(PAY)).toMatchObject({ hookpost: true, service: 'hookpost-test' });
    expect(await owner(SUB_CHARGE)).toMatchObject({
      hookpost: true,
      service: 'hookpost',
      organizationId: 'org-1',
      subscriptionId: 'sub_hp',
    });
    expect(await owner(VETNOW)).toMatchObject({ hookpost: false, service: 'vetnow' });
    expect(await owner(UNTAGGED)).toMatchObject({ hookpost: false, service: null });
  });

  it("refuses another product's payment without the confirmation flag, sends nothing, audits it", async () => {
    const s = service();
    for (const id of [VETNOW, UNTAGGED]) {
      const res = await s.refund(ADMIN, { paymentId: id });
      expect(res.status).toBe('refused');
      expect(res.error).toMatch(/Not a Hookpost payment/);
    }
    expect(posts).toHaveLength(0);
    expect(audits.map((a) => [a.paymentId, a.status, a.foreign])).toEqual([
      [VETNOW, 'REFUSED', true],
      [UNTAGGED, 'REFUSED', true],
    ]);
  });

  it('refunds a foreign payment only when confirmed, and records that it was', async () => {
    const res = await service().refund(ADMIN, { paymentId: VETNOW, confirmForeign: true });
    expect(res).toMatchObject({ status: 'refunded', amount: 59900, currency: 'INR' });
    expect(audits[0]).toMatchObject({ paymentId: VETNOW, foreign: true, status: 'SUCCESS' });
  });

  it('lists only Hookpost payments unless all is asked for, with the workspace name', async () => {
    const s = service();
    const mine = await s.listPayments({});
    expect(mine.payments.map((p: any) => p.id).sort()).toEqual([PAY, SUB_CHARGE].sort());
    const charge = mine.payments.find((p: any) => p.id === SUB_CHARGE);
    expect(charge).toMatchObject({
      organizationName: 'Workspace org-1',
      refundable: 59900,
      email: 'buyer@example.com',
    });
    const all = await s.listPayments({ all: true });
    expect(all.payments).toHaveLength(4);
    // A pasted id is shown whoever it belongs to, flagged.
    const one = await s.listPayments({ paymentId: VETNOW });
    expect(one.payments).toEqual([expect.objectContaining({ id: VETNOW, hookpost: false })]);
    // An unknown or malformed id is a 400 with Razorpay's words, not an outage.
    await expect(s.listPayments({ paymentId: 'pay_DoesNotExist00' })).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/does not exist/),
    });
    await expect(s.listPayments({ paymentId: 'nope' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('refund one payment', () => {
  it('a full refund of the $1 test payment through the Refund API', async () => {
    const res = await service().refund(ADMIN, { paymentId: PAY, reason: 'owner test' });
    expect(res).toEqual({
      paymentId: PAY,
      status: 'refunded',
      amount: 100,
      currency: 'USD',
      refundId: 'rfnd_1',
      refundStatus: 'pending',
    });
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/payments/${PAY}/refund`);
    expect(posts[0].body).toEqual({
      amount: 100,
      speed: 'normal',
      receipt: `${PAY}-0-100`,
      notes: { source: 'hookpost-admin', refunded_by: 'owner@hookstep.in', reason: 'owner test' },
    });
    expect(posts[0].headers).toEqual({ 'X-Refund-Idempotency': `${PAY}-0-100` });
    expect(audits).toEqual([
      expect.objectContaining({
        adminUserId: 'u-admin',
        adminEmail: 'owner@hookstep.in',
        paymentId: PAY,
        amount: 100,
        currency: 'USD',
        status: 'SUCCESS',
        refundId: 'rfnd_1',
        foreign: false,
      }),
    ]);
    // An ordinary refund tells the customer nothing beyond Razorpay's own mail.
    expect(corrections).toHaveLength(0);
  });

  it('a refund marked as a duplicate charge tells the workspace it was refunded', async () => {
    await service().refund(ADMIN, {
      paymentId: SUB_CHARGE,
      reason: 'charged twice on the upgrade',
      duplicate: true,
    });
    expect(corrections).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        reference: 'rfnd_1',
        reason: 'charged twice on the upgrade',
        by: 'owner@hookstep.in',
        currency: 'INR',
        amount: 599,
        facts: expect.objectContaining({
          event: 'DUPLICATE_CHARGE_REFUNDED',
          amount: 599,
          refundId: 'rfnd_1',
          paymentId: SUB_CHARGE,
        }),
      }),
    ]);
  });

  it('a duplicate refund Razorpay refuses tells nobody anything', async () => {
    refundsFail = true;
    expect(
      await service().refund(ADMIN, { paymentId: SUB_CHARGE, duplicate: true })
    ).toMatchObject({ status: 'failed' });
    expect(corrections).toHaveLength(0);
  });

  it('a mail provider outage does not turn a finished duplicate refund into a failure', async () => {
    accountCorrection.notify.mockRejectedValueOnce(new Error('Resend is down'));
    expect(
      await service().refund(ADMIN, { paymentId: SUB_CHARGE, duplicate: true })
    ).toMatchObject({ status: 'refunded', refundId: 'rfnd_1' });
  });

  it('an admin request cannot mark its refund as the automatic one (that would keep a refunded plan on)', async () => {
    await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true, auto: 'charged_after_cancel' } as any);
    expect(posts[0].body.notes).not.toHaveProperty('auto');
  });

  it('the system actor stamps notes.auto, so the refund webhook knows its own refund', async () => {
    await service().refund({ id: 'system:auto-refund', email: 'auto-refund (charged after cancel)' }, {
      paymentId: SUB_CHARGE,
      full: true,
      auto: 'charged_after_cancel',
    });
    expect(posts[0].body.notes).toMatchObject({ auto: 'charged_after_cancel' });
    expect(posts[0].body.amount).toBe(59900);
  });

  it('never refunds more than is left: over the cap is refused; a partial refund lowers the cap', async () => {
    const s = service();
    expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount: 59901 })).toMatchObject({
      status: 'refused',
      error: expect.stringMatching(/more than the 59900 still refundable/),
    });
    expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount: 10000 })).toMatchObject({
      status: 'refunded',
      amount: 10000,
    });
    redisData.clear(); // a minute later
    expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount: 50000 })).toMatchObject({
      status: 'refused',
      error: expect.stringMatching(/more than the 49900/),
    });
    // No amount: everything still refundable.
    expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE })).toMatchObject({
      status: 'refunded',
      amount: 49900,
    });
    redisData.clear();
    expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE })).toMatchObject({
      status: 'refused',
      error: 'Already fully refunded.',
    });
    expect(posts.map((p) => p.body.amount)).toEqual([10000, 49900]);
  });

  it('refuses an amount that is not a whole number of paise/cents', async () => {
    const s = service();
    for (const amount of [0, -5, 1.5]) {
      expect(await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount })).toMatchObject({
        status: 'refused',
        error: expect.stringMatching(/whole number/),
      });
    }
    expect(posts).toHaveLength(0);
    // Still audited; an amount the Int column cannot hold is kept as 0.
    expect(audits.map((a) => a.amount)).toEqual([0, -5, 0]);
  });

  it('a double click refunds once: the second request is refused by the lock', async () => {
    const s = service();
    const [a, b] = await Promise.all([
      s.refund(ADMIN, { paymentId: PAY }),
      s.refund(ADMIN, { paymentId: PAY }),
    ]);
    expect([a.status, b.status].sort()).toEqual(['refunded', 'refused']);
    expect(posts).toHaveLength(1);
    // Also a click after the first finished, even for a partial amount.
    const partial = await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount: 100 });
    const again = await s.refund(ADMIN, { paymentId: SUB_CHARGE, amount: 100 });
    expect(partial.status).toBe('refunded');
    expect(again).toMatchObject({ status: 'refused', error: expect.stringMatching(/less than a minute ago/) });
    expect(posts).toHaveLength(2);
  });

  it('a resent request with the same state carries the same idempotency key, so Razorpay returns the same refund', async () => {
    const s = service();
    // The first POST reaches Razorpay but the answer is lost (no status).
    failNextPost = 'fetch failed: socket hang up';
    const lost = await s.refund(ADMIN, { paymentId: PAY });
    expect(lost.status).toBe('failed');
    expect(lost.error).toMatch(/may still have gone through/);
    // The lock stays after an unknown outcome.
    expect((await s.refund(ADMIN, { paymentId: PAY })).status).toBe('refused');
    redisData.clear();
    // The retry reads the same state, so it sends the same key and body.
    const retry = await s.refund(ADMIN, { paymentId: PAY });
    expect(retry.status).toBe('refunded');
    expect(posts.map((p) => p.headers['X-Refund-Idempotency'])).toEqual([
      `${PAY}-0-100`,
      `${PAY}-0-100`,
    ]);
    expect(posts[0].body).toEqual(posts[1].body);
  });

  it('a Razorpay refusal changes nothing locally, shows its message and frees the payment', async () => {
    const s = service();
    failNextPost = `Razorpay POST /payments/${PAY}/refund failed (400): Refund is not allowed for this payment`;
    const res = await s.refund(ADMIN, { paymentId: PAY });
    expect(res).toMatchObject({ status: 'failed', error: expect.stringMatching(/Refund is not allowed/) });
    expect(store.get(`/payments/${PAY}`).amount_refunded).toBe(0);
    expect(audits[0]).toMatchObject({ status: 'FAILED', error: expect.stringMatching(/not allowed/) });
    // A 4xx means nothing moved, so it can be retried straight away.
    expect(redisData.size).toBe(0);
  });

  it('a refund Razorpay creates as failed (a payment over six months old) is a failure, not a success', async () => {
    refundsFail = true;
    const s = service();
    const res = await s.refund(ADMIN, { paymentId: PAY });
    expect(res).toMatchObject({
      status: 'failed',
      refundId: 'rfnd_1',
      refundStatus: 'failed',
      error: expect.stringMatching(/could not process refund rfnd_1 .*Nothing was refunded/),
    });
    expect(audits[0]).toMatchObject({ status: 'FAILED', refundId: 'rfnd_1', error: res.error });
    // Razorpay made a refund entity, so the lock stays like after any refund.
    expect((await s.refund(ADMIN, { paymentId: PAY })).status).toBe('refused');
    // A bulk call does not count it as refunded.
    const bulk = await s.refundBulk(ADMIN, [SUB_CHARGE]);
    expect(bulk.summary).toMatchObject({ refunded: 0, failed: 1, refundedTotals: {} });
  });

  it('a 409 (same idempotency key still being processed) keeps the lock and says to check first', async () => {
    const s = service();
    failNextPost = `Razorpay POST /payments/${PAY}/refund failed (409): A request with this idempotency key is already being processed`;
    const res = await s.refund(ADMIN, { paymentId: PAY });
    expect(res).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(
        /may be in progress: check the audit log and the payment in Razorpay before retrying/
      ),
    });
    expect(audits[0]).toMatchObject({ status: 'FAILED', error: res.error });
    expect(redisData.has(`razorpay:admin-refund:${PAY}`)).toBe(true);
    expect((await s.refund(ADMIN, { paymentId: PAY })).status).toBe('refused');
    expect(posts).toHaveLength(1);
  });

  it('a request slower than the lock does not free the lock a newer request took', async () => {
    const s = service();
    const key = `razorpay:admin-refund:${PAY}`;
    beforePost = () => {
      // 60 s pass at Razorpay: the lock expires and a newer request takes it.
      redisData.set(key, 'second@hookstep.in:another-token');
    };
    failNextPost = `Razorpay POST /payments/${PAY}/refund failed (400): Refund is not allowed for this payment`;
    expect((await s.refund(ADMIN, { paymentId: PAY })).status).toBe('failed');
    expect(redisData.get(key)).toBe('second@hookstep.in:another-token');
    expect(mockRedis.del).not.toHaveBeenCalled();
    // The release names this request's own token.
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      key,
      expect.stringMatching(/^owner@hookstep\.in:/)
    );
  });

  it('refuses every refund without REDIS_URL, where the in-memory stand-in ignores NX', async () => {
    mockRedisIsMock = true;
    const res = await service().refund(ADMIN, { paymentId: PAY });
    expect(res).toMatchObject({ status: 'refused', error: expect.stringMatching(/REDIS_URL is not set/) });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ paymentId: PAY, status: 'REFUSED' });
  });

  it('redis.service flags its in-memory stand-in when REDIS_URL is unset', () => {
    const url = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      jest.isolateModules(() => {
        const actual = jest.requireActual('@hookpost/nestjs-libraries/redis/redis.service');
        expect(actual.ioRedisIsMock).toBe(true);
      });
    } finally {
      if (url !== undefined) process.env.REDIS_URL = url;
    }
  });

  it('an unknown payment id fails with Razorpay\'s message and sends nothing', async () => {
    const res = await service().refund(ADMIN, { paymentId: 'pay_DoesNotExist00' });
    expect(res).toMatchObject({ status: 'failed', error: expect.stringMatching(/does not exist/) });
    expect(posts).toHaveLength(0);
  });

  it('refuses a malformed id, an uncaptured payment, and anything while Redis is down', async () => {
    const s = service();
    expect((await s.refund(ADMIN, { paymentId: '../orders/x' })).status).toBe('refused');
    payment('pay_Authorized0001', { status: 'authorized', notes: { service: 'hookpost' } });
    expect(await s.refund(ADMIN, { paymentId: 'pay_Authorized0001' })).toMatchObject({
      status: 'refused',
      error: expect.stringMatching(/only a captured payment/),
    });
    mockRedis.down = true;
    expect(await s.refund(ADMIN, { paymentId: PAY })).toMatchObject({
      status: 'refused',
      error: expect.stringMatching(/refund lock/),
    });
    expect(posts).toHaveLength(0);
  });

  it('no audit row, no refund: with the table missing nothing is sent', async () => {
    auditTableMissing = true;
    const s = service();
    const res = await s.refund(ADMIN, { paymentId: PAY });
    expect(res).toMatchObject({ status: 'refused', error: expect.stringMatching(/audit record/) });
    expect(posts).toHaveLength(0);
    expect(await s.listAudit()).toEqual({ available: false, rows: [] });
  });
});

describe('a payment with a chargeback is never refunded on top (Razorpay takes the disputed amount when the dispute opens)', () => {
  const dispute = (id: string, paymentId: string, status: string, ago = 60) =>
    store.set(`/disputes/${id}`, {
      id,
      entity: 'dispute',
      payment_id: paymentId,
      amount: 59900,
      currency: 'INR',
      status,
      phase: 'chargeback',
      created_at: Math.floor(Date.now() / 1000) - ago,
    });

  it.each(['open', 'under_review', 'lost', 'closed'])('a %s dispute: refused, nothing sent, audited', async (status) => {
    dispute('disp_1', SUB_CHARGE, status);
    const res = await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true });
    expect(res).toMatchObject({ status: 'refused' });
    expect(res.error).toMatch(/chargeback/i);
    expect(res.error).toContain('disp_1');
    expect(posts).toHaveLength(0);
    expect(audits.at(-1)).toMatchObject({ paymentId: SUB_CHARGE, status: 'REFUSED', organizationId: 'org-1' });
  });

  it('the system actor (automatic refund of a charge after cancel) is refused the same way', async () => {
    dispute('disp_2', SUB_CHARGE, 'open');
    const res = await service().refund({ id: 'system:auto-refund', email: 'system' }, { paymentId: SUB_CHARGE, full: true, auto: 'after-cancel' });
    expect(res.status).toBe('refused');
    expect(posts).toHaveLength(0);
  });

  it('a dispute the merchant won does not block a refund; another payment\'s dispute does not either', async () => {
    dispute('disp_won', SUB_CHARGE, 'won');
    dispute('disp_other', PAY, 'open');
    const res = await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true });
    expect(res.status).toBe('refunded');
    expect(posts).toHaveLength(1);
  });

  it('finds a dispute past the first page of the listing', async () => {
    for (let i = 0; i < 120; i++) dispute(`disp_x${i}`, `pay_Other${String(i).padStart(9, '0')}`, 'open', i);
    dispute('disp_old', SUB_CHARGE, 'open', 500);
    const res = await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true });
    expect(res.status).toBe('refused');
    expect(res.error).toContain('disp_old');
  });

  it('Razorpay unreadable for disputes: refused, nothing sent (never refund blind), the lock is freed', async () => {
    failDisputeList = 'Razorpay GET /disputes failed (503): Service Unavailable';
    const res = await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true });
    expect(res.status).toBe('refused');
    expect(res.error).toMatch(/could not check/i);
    expect(posts).toHaveLength(0);
    failDisputeList = null;
    expect((await service().refund(ADMIN, { paymentId: SUB_CHARGE, full: true })).status).toBe('refunded');
  });
});

describe('bulk refunds', () => {
  it('refunds each in full, keeps going past refusals, and adds it up per currency', async () => {
    payment('pay_SecondCharge01', { notes: { service: 'hookpost', orgId: 'org-2' }, amount: 199900 });
    const res = await service().refundBulk(ADMIN, [
      PAY,
      SUB_CHARGE,
      VETNOW,
      'pay_SecondCharge01',
      SUB_CHARGE, // listed twice: refunded once
      'pay_DoesNotExist00',
    ]);
    expect(res.results.map((r) => [r.paymentId, r.status])).toEqual([
      [PAY, 'refunded'],
      [SUB_CHARGE, 'refunded'],
      [VETNOW, 'refused'],
      ['pay_SecondCharge01', 'refunded'],
      ['pay_DoesNotExist00', 'failed'],
    ]);
    expect(res.summary).toEqual({
      requested: 5,
      refunded: 3,
      refused: 1,
      failed: 1,
      refundedTotals: { USD: 100, INR: 59900 + 199900 },
    });
    expect(posts).toHaveLength(3);
    expect(audits).toHaveLength(5);
  });

  it('confirmForeign applies to the whole batch', async () => {
    const res = await service().refundBulk(ADMIN, [VETNOW, UNTAGGED, PAY], { confirmForeign: true });
    expect(res.summary).toMatchObject({ refunded: 3, refused: 0 });
    // The audit says which ones were not Hookpost's, not just that the box was ticked.
    expect(audits.map((a) => [a.paymentId, a.foreign])).toEqual([
      [VETNOW, true],
      [UNTAGGED, true],
      [PAY, false],
    ]);
  });

  it('refuses more than 50 ids, or none, before touching Razorpay', async () => {
    const s = service();
    const ids = Array.from({ length: 51 }, (_, i) => `pay_Bulk${String(i).padStart(10, '0')}`);
    await expect(s.refundBulk(ADMIN, ids)).rejects.toThrow(/At most 50/);
    await expect(s.refundBulk(ADMIN, [])).rejects.toThrow(/No payment ids/);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe("the default refund is the payment less Razorpay's fee (owner, 29 Oct 2026)", () => {
  // Razorpay's `fee` already includes GST (`tax` is the GST part of it):
  // https://razorpay.com/docs/api/payments/fetch-with-id
  const INR_FEE = 'pay_InrWithFee0001';
  const USD_FEE = 'pay_UsdWithFee0001';
  beforeEach(() => {
    payment(INR_FEE, { notes: { service: 'hookpost', orgId: 'org-1' }, amount: 59900, fee: 1414, tax: 216 });
    payment(USD_FEE, { notes: { service: 'hookpost', orgId: 'org-1' }, amount: 2000, currency: 'USD', method: 'card', fee: 88, tax: 0 });
  });

  it('refundQuote: INR Rs 599 with a Rs 14.14 fee (Rs 2.16 GST inside it) refunds Rs 584.86, GST not taken twice', () => {
    expect(refundQuote({ status: 'captured', amount: 59900, fee: 1414, tax: 216, amount_refunded: 0 })).toEqual({
      amount: 59900,
      fee: 1414,
      tax: 216,
      refundedBefore: 0,
      full: 59900,
      afterFee: 58486,
    });
  });

  it('refundQuote: USD $20 with a $0.88 fee refunds $19.12', () => {
    expect(refundQuote({ status: 'captured', amount: 2000, fee: 88, tax: 0 }).afterFee).toBe(1912);
  });

  it('refundQuote: the fee is taken once across partial refunds, and never more than is left', () => {
    const partly = { status: 'captured', amount: 59900, fee: 1414, tax: 216, amount_refunded: 20000 };
    expect(refundQuote(partly)).toMatchObject({ full: 39900, afterFee: 59900 - 1414 - 20000 });
    const almostAll = { status: 'captured', amount: 59900, fee: 1414, amount_refunded: 59000 };
    expect(refundQuote(almostAll)).toMatchObject({ full: 900, afterFee: 0 });
  });

  it('refundQuote: no fee on the entity (not settled yet) deducts nothing; junk never goes negative', () => {
    expect(refundQuote({ status: 'captured', amount: 59900 }).afterFee).toBe(59900);
    expect(refundQuote({ status: 'captured', amount: 59900, fee: -50, tax: 'x' })).toMatchObject({ fee: 0, tax: 0, afterFee: 59900 });
    expect(refundQuote({ status: 'refunded', amount: 59900, fee: 1414, amount_refunded: 59900 })).toMatchObject({ full: 0, afterFee: 0 });
  });

  it('with no amount, the button sends the payment less the fee', async () => {
    const res = await service().refund(ADMIN, { paymentId: INR_FEE, reason: 'customer asked' });
    expect(res).toMatchObject({ status: 'refunded', amount: 58486, currency: 'INR' });
    expect(posts[0].body.amount).toBe(58486);
  });

  it('in dollars too', async () => {
    const res = await service().refund(ADMIN, { paymentId: USD_FEE });
    expect(res).toMatchObject({ status: 'refunded', amount: 1912, currency: 'USD' });
  });

  it('full: true refunds everything, fee included (our mistake: a charge after cancel, a double charge)', async () => {
    const res = await service().refund(ADMIN, { paymentId: INR_FEE, full: true, reason: 'charged after cancel' });
    expect(res).toMatchObject({ status: 'refunded', amount: 59900 });
  });

  it('an explicit amount is sent as typed, fee or no fee', async () => {
    const res = await service().refund(ADMIN, { paymentId: INR_FEE, amount: 10000 });
    expect(res).toMatchObject({ status: 'refunded', amount: 10000 });
  });

  it('when nothing is left after the fee, the default is refused and says how to override it', async () => {
    payment('pay_AlmostRefund01', {
      notes: { service: 'hookpost', orgId: 'org-1' },
      amount: 59900,
      fee: 1414,
      amount_refunded: 59000,
    });
    const res = await service().refund(ADMIN, { paymentId: 'pay_AlmostRefund01' });
    expect(res.status).toBe('refused');
    expect(res.error).toMatch(/Nothing is left after Razorpay's fee/);
    expect(posts).toHaveLength(0);
    const full = await service().refund(ADMIN, { paymentId: 'pay_AlmostRefund01', full: true });
    expect(full).toMatchObject({ status: 'refunded', amount: 900 });
  });

  it('bulk deducts the fee from each payment by default, and full applies to the whole batch', async () => {
    const less = await service().refundBulk(ADMIN, [INR_FEE, USD_FEE]);
    expect(less.summary.refundedTotals).toEqual({ INR: 58486, USD: 1912 });
  });

  it('bulk with full refunds every payment in full', async () => {
    const all = await service().refundBulk(ADMIN, [INR_FEE, USD_FEE], { full: true });
    expect(all.summary.refundedTotals).toEqual({ INR: 59900, USD: 2000 });
  });

  it('the payments list shows the fee, its GST and the default before anything is confirmed', async () => {
    const res: any = await service().listPayments({ paymentId: INR_FEE } as any);
    expect(res.payments[0]).toMatchObject({ amount: 59900, fee: 1414, tax: 216, refundableAfterFee: 58486, refundable: 59900 });
  });
});

describe('request validation (DTOs)', () => {
  const { validate } = require('class-validator');
  const { plainToInstance } = require('class-transformer');
  const {
    AdminRefundDto,
    AdminBulkRefundDto,
  } = require('@hookpost/nestjs-libraries/dtos/billing/admin.refund.dto');
  const errors = async (cls: any, body: any) =>
    (await validate(plainToInstance(cls, body))).map((e: any) => e.property);

  it('one refund: a real payment id, a whole positive amount, a boolean confirmation', async () => {
    expect(await errors(AdminRefundDto, { paymentId: PAY })).toEqual([]);
    expect(await errors(AdminRefundDto, { paymentId: PAY, amount: 50, confirmForeign: true })).toEqual([]);
    expect(await errors(AdminRefundDto, { paymentId: 'order_123' })).toEqual(['paymentId']);
    expect(await errors(AdminRefundDto, { paymentId: PAY, amount: 0 })).toEqual(['amount']);
    expect(await errors(AdminRefundDto, { paymentId: PAY, amount: 9.5 })).toEqual(['amount']);
    expect(await errors(AdminRefundDto, { paymentId: PAY, confirmForeign: 'yes' })).toEqual(['confirmForeign']);
    expect(await errors(AdminRefundDto, { paymentId: PAY, full: true })).toEqual([]);
    expect(await errors(AdminRefundDto, { paymentId: PAY, full: 'yes' })).toEqual(['full']);
  });

  it('bulk: 1 to 50 real payment ids', async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `pay_Bulk${String(i).padStart(10, '0')}`);
    expect(await errors(AdminBulkRefundDto, { paymentIds: ids(50) })).toEqual([]);
    expect(await errors(AdminBulkRefundDto, { paymentIds: ids(51) })).toEqual(['paymentIds']);
    expect(await errors(AdminBulkRefundDto, { paymentIds: [] })).toEqual(['paymentIds']);
    expect(await errors(AdminBulkRefundDto, { paymentIds: [PAY, 'pay_x'] })).toEqual(['paymentIds']);
  });
});

describe('refund history (GET /v1/refunds, read-only)', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const refund = (id: string, paymentId: string, over: any = {}) =>
    store.set(`/refunds/${id}`, {
      id,
      entity: 'refund',
      amount: 59300,
      currency: 'INR',
      payment_id: paymentId,
      notes: [],
      receipt: null,
      acquirer_data: { rrn: null },
      created_at: NOW - 60,
      batch_id: null,
      status: 'processed',
      speed_processed: 'normal',
      speed_requested: 'normal',
      ...over,
    });

  beforeEach(() => {
    // Shaped like the live ones (21 Oct): the dashboard's refund form stores
    // notes.comment, Razorpay's automatic refund of the Rs 5 mandate check has
    // no notes, this tool's carry notes.source.
    refund('rfnd_Dashboard0001', SUB_CHARGE, {
      notes: { comment: '' },
      created_at: NOW - 100,
      acquirer_data: { rrn: '529412345678' },
    });
    refund('rfnd_ThisTool00001', PAY, {
      amount: 100,
      currency: 'USD',
      status: 'pending',
      notes: { source: 'hookpost-admin', refunded_by: 'owner@hookstep.in', reason: 'owner test' },
      created_at: NOW - 50,
    });
    audits.push({
      id: 'audit_x',
      refundId: 'rfnd_ThisTool00001',
      adminEmail: 'second@hookstep.in',
      reason: 'from the audit',
      status: 'SUCCESS',
    });
    refund('rfnd_VetNowRef0001', VETNOW, { notes: { comment: 'customer asked' }, created_at: NOW - 200 });
    refund('rfnd_MandateAuto01', UNTAGGED, { amount: 500, created_at: NOW - 300 });
    refund('rfnd_NoPayment0001', 'pay_DoesNotExist00', { created_at: NOW - 400 });
  });

  it("shows Hookpost's refunds wherever they were made, with customer, product and where they came from", async () => {
    const page = await service().listRefunds({});
    // A refund whose payment Razorpay would not return may be Hookpost's: shown, never hidden.
    expect(page.refunds.map((r) => r.id)).toEqual([
      'rfnd_ThisTool00001',
      'rfnd_Dashboard0001',
      'rfnd_NoPayment0001',
    ]);
    expect(page.refunds[2]).toMatchObject({ paymentFound: false, hookpost: false, email: null });
    expect(page.refunds[1]).toEqual({
      id: 'rfnd_Dashboard0001',
      paymentId: SUB_CHARGE,
      amount: 59300,
      currency: 'INR',
      status: 'processed',
      createdAt: new Date((NOW - 100) * 1000).toISOString(),
      reference: '529412345678',
      paymentFound: true,
      paymentAmount: 59900,
      email: 'buyer@example.com',
      description: null,
      madeFrom: 'dashboard',
      madeBy: null,
      reason: null,
      hookpost: true,
      service: 'hookpost',
      organizationId: 'org-1',
      organizationName: 'Workspace org-1',
      subscriptionId: 'sub_hp',
    });
    // The audit row is what names who made it here.
    expect(page.refunds[0]).toMatchObject({
      madeFrom: 'tool',
      madeBy: 'second@hookstep.in',
      reason: 'from the audit',
      currency: 'USD',
      status: 'pending',
      service: 'hookpost-test',
    });
    // The other two are another product's or unidentified: counted, not dropped silently.
    expect(page.hidden).toBe(2);
    expect(page.scanned).toBe(5);
    // Read-only: nothing is ever POSTed.
    expect(posts).toHaveLength(0);
    expect(mockRequest.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('all products: every refund, tagged with its product the same way payments are', async () => {
    const page = await service().listRefunds({ all: true });
    expect(page.hidden).toBe(0);
    const by = new Map(page.refunds.map((r) => [r.id, r]));
    expect(by.get('rfnd_VetNowRef0001')).toMatchObject({
      hookpost: false,
      service: 'vetnow',
      madeFrom: 'dashboard',
      reason: 'customer asked',
      organizationId: null,
    });
    expect(by.get('rfnd_MandateAuto01')).toMatchObject({
      hookpost: false,
      service: null,
      madeFrom: 'other',
      amount: 500,
    });
    // A payment Razorpay will not return still shows its refund.
    expect(by.get('rfnd_NoPayment0001')).toMatchObject({
      paymentFound: false,
      paymentAmount: null,
      email: null,
      hookpost: false,
      currency: 'INR',
    });
  });

  it('this tool is recognised from the notes when there is no audit row (or no audit table)', async () => {
    refund('rfnd_OldImperson01', SUB_CHARGE, {
      notes: { orgId: 'org-1', reason: 'hookpost_admin_refund' },
      created_at: NOW - 10,
    });
    auditTableMissing = true;
    const page = await service().listRefunds({});
    const by = new Map(page.refunds.map((r) => [r.id, r]));
    expect(by.get('rfnd_ThisTool00001')).toMatchObject({
      madeFrom: 'tool',
      madeBy: 'owner@hookstep.in',
      reason: 'owner test',
    });
    // The impersonation bar's refunds before 21 Oct.
    expect(by.get('rfnd_OldImperson01')).toMatchObject({ madeFrom: 'tool', madeBy: null });
    expect(by.get('rfnd_Dashboard0001')).toMatchObject({ madeFrom: 'dashboard' });
  });

  it("pages through Razorpay with skip/count inside a pinned 180-day window", async () => {
    const s = service();
    const first = await s.listRefunds({ all: true, count: 2 });
    expect(first.refunds.map((r) => r.id)).toEqual(['rfnd_ThisTool00001', 'rfnd_Dashboard0001']);
    expect(first).toMatchObject({ nextSkip: 2, hasMore: true });
    expect(first.to - first.from).toBe(180 * 86400);

    const second = await s.listRefunds({ all: true, count: 2, skip: first.nextSkip, to: first.to });
    expect(second.refunds.map((r) => r.id)).toEqual(['rfnd_VetNowRef0001', 'rfnd_MandateAuto01']);
    const third = await s.listRefunds({ all: true, count: 2, skip: second.nextSkip, to: first.to });
    expect(third.refunds.map((r) => r.id)).toEqual(['rfnd_NoPayment0001']);
    expect(third).toMatchObject({ nextSkip: 5, hasMore: false });

    const listed = mockRequest.mock.calls
      .map(([, path]) => path as string)
      .filter((path) => path.startsWith('/refunds?'));
    expect(listed).toEqual([
      `/refunds?from=${first.from}&to=${first.to}&count=2&skip=0`,
      `/refunds?from=${first.from}&to=${first.to}&count=2&skip=2`,
      `/refunds?from=${first.from}&to=${first.to}&count=2&skip=4`,
    ]);

    // Razorpay's page size tops out at 100.
    await s.listRefunds({ count: 500, to: first.to });
    expect(
      mockRequest.mock.calls.some(([, path]) => path === `/refunds?from=${first.from}&to=${first.to}&count=100&skip=0`)
    ).toBe(true);
  });

  it('reads each payment once across reloads; one Razorpay would not return is asked again', async () => {
    const s = service();
    await s.listRefunds({ all: true });
    await s.listRefunds({ all: true });
    const reads = (id: string) =>
      mockRequest.mock.calls.filter(([, path]) => path === `/payments/${id}`).length;
    expect(reads(SUB_CHARGE)).toBe(1);
    expect(reads(PAY)).toBe(1);
    expect(reads('pay_DoesNotExist00')).toBe(2);
  });

  it('payments the payments list already read are not read again for the history', async () => {
    const s = service();
    await s.listPayments({ all: true });
    const before = mockRequest.mock.calls.length;
    await s.listRefunds({ all: true });
    const reads = mockRequest.mock.calls
      .slice(before)
      .map(([, path]) => path as string)
      .filter((path) => path.startsWith('/payments/'));
    // Only the one the list could not have had.
    expect(reads).toEqual(['/payments/pay_DoesNotExist00']);
  });

  it('two audit rows for one refund: the newest names who made it', async () => {
    audits.push({
      id: 'audit_y',
      refundId: 'rfnd_ThisTool00001',
      adminEmail: 'third@hookstep.in',
      reason: 'newest',
      status: 'SUCCESS',
    });
    const page = await service().listRefunds({});
    expect(page.refunds.find((r) => r.id === 'rfnd_ThisTool00001')).toMatchObject({
      madeBy: 'third@hookstep.in',
      reason: 'newest',
    });
  });

  it("Razorpay down is a 503, Razorpay refusing the request is a 400 with its words", async () => {
    const s = service();
    failRefundList = 'fetch failed: ECONNRESET';
    await expect(s.listRefunds({})).rejects.toMatchObject({ status: 503 });
    failRefundList = 'Razorpay GET /refunds failed (400): from must be an integer';
    await expect(s.listRefunds({})).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/from must be an integer/),
    });
  });
});
