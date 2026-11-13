/**
 * The Razorpay webhook's side of the affiliate programme: only a signed
 * subscription.charged on a Hookpost subscription records a commission, and a
 * processed refund voids it. Razorpay is a fake; nothing leaves the machine.
 */
import 'reflect-metadata';
import { createHmac } from 'crypto';

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
  ioRedis: { set: jest.fn(async () => 'OK'), get: jest.fn(async () => null), del: jest.fn(async () => 1) },
}));

import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

const SECRET = 'whsec_affiliate_tests';

function service() {
  const affiliates = {
    recordCommission: jest.fn(async () => undefined),
    voidForRefund: jest.fn(async () => undefined),
    attributeByCoupon: jest.fn(async () => undefined),
  };
  const razorpay = new RazorpayService({} as any, {} as any, {} as any, {} as any, affiliates as any);
  const r = razorpay as any;
  // The plan side of these events is covered elsewhere; here only the money.
  r.createSubscription = jest.fn(async () => ({ ok: true }));
  r.clearPaymentFailing = jest.fn(async () => undefined);
  r.recordCouponRedemption = jest.fn(async () => undefined);
  r.recordBillingIdentities = jest.fn(async () => undefined);
  r.client = { request: jest.fn(async () => null), verifyWebhook: r.client.verifyWebhook.bind(r.client) };
  return { razorpay, affiliates };
}

const sub = (notes: Record<string, any>) => ({ id: 'sub_1', status: 'active', notes });
const pay = { id: 'pay_1', amount: 59900, currency: 'INR', status: 'captured' };
const event = (name: string, payload: Record<string, any>) => ({
  event: name,
  payload: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, { entity: v }])),
});

describe('which webhooks record a commission', () => {
  it('subscription.charged on a Hookpost subscription: once, for the workspace in its notes', async () => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(
      event('subscription.charged', { subscription: sub({ service: 'hookpost', orgId: 'org-1' }), payment: pay })
    );
    expect(affiliates.recordCommission).toHaveBeenCalledTimes(1);
    expect(affiliates.recordCommission).toHaveBeenCalledWith('org-1', pay);
  });

  it.each([
    ['another product on the shared account', { service: 'tablamigo', orgId: 'org-1' }],
    ['no service note at all', { orgId: 'org-1' }],
    ['a service note in other case', { service: 'HOOKPOST', orgId: 'org-1' }],
  ])('not for %s', async (_label, notes) => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event('subscription.charged', { subscription: sub(notes), payment: pay }));
    expect(affiliates.recordCommission).not.toHaveBeenCalled();
  });

  it.each(['subscription.authenticated', 'subscription.activated', 'subscription.updated', 'payment.captured'])(
    'not for %s, even with a payment on it (the Rs 5 mandate check)',
    async (name) => {
      const { razorpay, affiliates } = service();
      await razorpay.handleWebhook(
        event(name, {
          subscription: sub({ service: 'hookpost', orgId: 'org-1' }),
          payment: { ...pay, amount: 500 },
        })
      );
      expect(affiliates.recordCommission).not.toHaveBeenCalled();
    }
  );
});

describe('refund webhooks void the commission', () => {
  const refund = (over: Record<string, any> = {}) => ({
    id: 'rfnd_1',
    payment_id: 'pay_1',
    amount: 59900,
    status: 'processed',
    notes: [],
    ...over,
  });

  it.each(['refund.processed', 'refund.created'])('%s (processed) voids the payment\'s commission', async (name) => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event(name, { refund: refund(), payment: pay }));
    expect(affiliates.voidForRefund).toHaveBeenCalledWith('pay_1', 'rfnd_1');
  });

  it('a partial refund voids it too (any refund ends the plan)', async () => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event('refund.processed', { refund: refund({ amount: 100 }), payment: pay }));
    expect(affiliates.voidForRefund).toHaveBeenCalledWith('pay_1', 'rfnd_1');
  });

  it('a refund.created still pending, or a refund with no payment, voids nothing yet', async () => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event('refund.created', { refund: refund({ status: 'pending' }) }));
    await razorpay.handleWebhook(event('refund.processed', { refund: refund({ payment_id: undefined }) }));
    expect(affiliates.voidForRefund).not.toHaveBeenCalled();
  });
});

describe('chargebacks void the commission once lost', () => {
  const dispute = (status: string) => ({ id: 'disp_1', payment_id: 'pay_1', amount: 59900, status });

  it('payment.dispute.lost voids the payment\'s commission as a chargeback', async () => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event('payment.dispute.lost', { dispute: dispute('lost'), payment: pay }));
    expect(affiliates.voidForRefund).toHaveBeenCalledWith('pay_1', 'disp_1', 'chargeback');
  });

  it.each([
    ['payment.dispute.created', 'open'],
    ['payment.dispute.under_review', 'under_review'],
    ['payment.dispute.action_required', 'open'],
    ['payment.dispute.won', 'won'],
    ['payment.dispute.closed', 'closed'],
  ])('%s (%s) leaves it alone: the money may still come back', async (name, status) => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event(name, { dispute: dispute(status), payment: pay }));
    expect(affiliates.voidForRefund).not.toHaveBeenCalled();
  });

  it('a dispute with no payment voids nothing', async () => {
    const { razorpay, affiliates } = service();
    await razorpay.handleWebhook(event('payment.dispute.lost', { dispute: { id: 'disp_2', status: 'lost' } }));
    expect(affiliates.voidForRefund).not.toHaveBeenCalled();
  });
});

describe('forged and tampered webhooks are refused before anything is recorded', () => {
  const signed = (body: any, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body));
    return { raw, signature: createHmac('sha256', secret).update(raw).digest('hex') };
  };
  const charged = event('subscription.charged', {
    subscription: sub({ service: 'hookpost', orgId: 'org-1' }),
    payment: pay,
  });

  it('a correctly signed body is accepted and parsed', () => {
    const { razorpay } = service();
    const { raw, signature } = signed(charged);
    expect(razorpay.validateRequest(raw, signature, SECRET)).toEqual(charged);
  });

  it('the amount changed after signing', () => {
    const { razorpay } = service();
    const { signature } = signed(charged);
    const tampered = Buffer.from(JSON.stringify(charged).replace('59900', '5990000'));
    expect(() => razorpay.validateRequest(tampered, signature, SECRET)).toThrow(/signature/i);
  });

  it('the workspace changed after signing (paying someone else\'s affiliate)', () => {
    const { razorpay } = service();
    const { signature } = signed(charged);
    const tampered = Buffer.from(JSON.stringify(charged).replace('org-1', 'org-2'));
    expect(() => razorpay.validateRequest(tampered, signature, SECRET)).toThrow(/signature/i);
  });

  it.each([
    ['signed with another secret', () => signed(charged, 'guessed-secret').signature],
    ['no signature', () => ''],
    ['a truncated signature', () => signed(charged).signature.slice(0, 32)],
    ['the signature in upper case', () => signed(charged).signature.toUpperCase()],
    ['a base64 signature of the right HMAC', () =>
      createHmac('sha256', SECRET).update(Buffer.from(JSON.stringify(charged))).digest('base64')],
    ['the HMAC of an empty body', () => createHmac('sha256', SECRET).update('').digest('hex')],
  ])('%s', (_label, makeSignature) => {
    const { razorpay } = service();
    const raw = Buffer.from(JSON.stringify(charged));
    expect(() => razorpay.validateRequest(raw, makeSignature(), SECRET)).toThrow();
  });

  it('no webhook secret configured: nothing is trusted', () => {
    const { razorpay } = service();
    const { raw, signature } = signed(charged, '');
    expect(() => razorpay.validateRequest(raw, signature, '')).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });
});
