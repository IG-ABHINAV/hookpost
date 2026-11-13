/**
 * The admin Refund button (owner, 29 Oct 2026): a refund is at our discretion
 * and is the payment less Razorpay's fee, GST included, unless the admin
 * ticks Full (our mistake: a charge after cancel, a double charge). Through
 * the real backend, with Redis for the refund lock and an in-memory Razorpay.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { FakeRazorpay } from './setup/fake.razorpay';

describe('admin refunds deduct the Razorpay fee by default', () => {
  let t: TestApp;
  let admin: Session;
  let customer: Session;
  let rzp: FakeRazorpay;
  let orgId: string;
  let seq = 0;

  beforeAll(async () => {
    rzp = new FakeRazorpay().install();
    t = await startApp();
    admin = await t.api.register({ company: 'Hookpost HQ' });
    await makeSuperAdmin((await admin.self()).id);
    customer = await t.api.register({ company: 'Customer Co' });
    orgId = (await customer.self()).orgId;
    await givePlan(orgId, 'STANDARD');
  });
  afterAll(async () => {
    rzp.uninstall();
    await t?.close();
    await disconnectDb();
  });

  /** A captured Hookpost payment with Razorpay's fee on it (fee includes GST). */
  const paid = (over: any = {}) => {
    const id = `pay_FeeInt${String(++seq).padStart(8, '0')}`;
    rzp.payments.set(id, {
      id,
      entity: 'payment',
      amount: 59900,
      amount_refunded: 0,
      currency: 'INR',
      status: 'captured',
      method: 'upi',
      email: 'buyer@example.com',
      notes: { service: 'hookpost', orgId },
      fee: 1414,
      tax: 216,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      ...over,
    });
    return id;
  };

  it('the payments list shows the fee, its GST and the amount less the fee', async () => {
    const id = paid();
    const res = await admin.get(`/admin/refunds/payments?paymentId=${id}`);
    expect(res.status).toBe(200);
    expect(res.body.payments[0]).toMatchObject({ id, fee: 1414, tax: 216, refundable: 59900, refundableAfterFee: 58486 });
  });

  it('Refund with no amount sends Rs 599 less the Rs 14.14 fee: Rs 584.86', async () => {
    const id = paid();
    const res = await admin.post('/admin/refunds', { paymentId: id, reason: 'customer asked' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'refunded', amount: 58486, currency: 'INR' });
    expect(rzp.payments.get(id).amount_refunded).toBe(58486);
    const audit = await db().refundAudit.findFirst({ where: { paymentId: id, status: 'SUCCESS' } });
    expect(audit?.amount).toBe(58486);
  });

  it('USD: $20 less a $0.88 fee', async () => {
    const id = paid({ amount: 2000, currency: 'USD', method: 'card', fee: 88, tax: 0 });
    const res = await admin.post('/admin/refunds', { paymentId: id });
    expect(res.body).toMatchObject({ status: 'refunded', amount: 1912, currency: 'USD' });
  });

  it('full: true refunds all of it (our mistake)', async () => {
    const id = paid();
    const res = await admin.post('/admin/refunds', { paymentId: id, full: true, reason: 'charged after cancel' });
    expect(res.body).toMatchObject({ status: 'refunded', amount: 59900 });
  });

  it('bulk deducts the fee from each, unless full', async () => {
    const a = paid();
    const b = paid();
    const less = await admin.post('/admin/refunds/bulk', { paymentIds: [a, b] });
    expect(less.body.summary.refundedTotals).toEqual({ INR: 58486 * 2 });
    const c = paid();
    const full = await admin.post('/admin/refunds/bulk', { paymentIds: [c], full: true });
    expect(full.body.summary.refundedTotals).toEqual({ INR: 59900 });
  });

  it('a customer can neither refund nor read the fee figures (no self-serve refund)', async () => {
    const id = paid();
    expect((await customer.post('/admin/refunds', { paymentId: id })).status).toBeGreaterThanOrEqual(400);
    expect((await customer.post('/admin/refunds', { paymentId: id, full: true })).status).toBeGreaterThanOrEqual(400);
    expect((await customer.get(`/admin/refunds/payments?paymentId=${id}`)).status).toBeGreaterThanOrEqual(400);
    expect(rzp.payments.get(id).amount_refunded).toBe(0);
  });
});
