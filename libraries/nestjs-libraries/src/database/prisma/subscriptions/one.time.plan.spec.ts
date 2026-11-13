import { createHmac } from 'crypto';
import {
  addOneMonth,
  isOrderIdentifier,
  nextPaidUntil,
  oneTimePlanAmountMinor,
  oneTimePlanCheckout,
  oneTimePlanChargeLabel,
  oneTimePlanPriceLabel,
  orderCurrencyFor,
  paidOrderRefusal,
  renewalReminderDue,
  ONE_TIME_PLAN_PRICE,
} from './one.time.plan';
import { HOOKPOST_PRICE } from './pricing';
import { orderSignatureValid } from '@hookpost/nestjs-libraries/services/razorpay.client';

const NOW = new Date('2026-11-08T10:00:00.000Z');
const day = 86_400_000;

describe('one-time plan pricing', () => {
  it('shows $7 to everyone and charges Rs 699 (69900 paise), one constant', () => {
    expect(HOOKPOST_PRICE).toEqual({ displayUsd: 7, chargeInrPaise: 69900 });
    expect(ONE_TIME_PLAN_PRICE).toEqual({ INR: 699 });
    expect(oneTimePlanAmountMinor('inr')).toBe(69900);
    expect(oneTimePlanPriceLabel('USD')).toBe('$7');
    expect(oneTimePlanPriceLabel('INR')).toBe('$7');
    expect(oneTimePlanChargeLabel()).toBe('₹699');
  });

  it('prices no other currency, USD included (no USD plan for new purchases)', () => {
    expect(oneTimePlanAmountMinor('USD')).toBeNull();
    expect(oneTimePlanAmountMinor('EUR')).toBeNull();
    expect(oneTimePlanAmountMinor('')).toBeNull();
    expect(oneTimePlanAmountMinor(undefined)).toBeNull();
  });

  it('charges rupees everywhere, India or not, unknown included', () => {
    for (const c of ['IN', 'in', 'US', 'GB', 'DE', 'AE', 'ZA', null, undefined, '']) {
      expect(orderCurrencyFor(c as any)).toBe('INR');
    }
  });
});

describe('paid months', () => {
  it('adds a calendar month, clamping to the month end', () => {
    expect(addOneMonth(new Date('2026-01-31T05:00:00Z')).toISOString()).toBe(
      '2026-02-28T05:00:00.000Z'
    );
    expect(addOneMonth(new Date('2026-11-08T10:00:00Z')).toISOString()).toBe(
      '2026-12-08T10:00:00.000Z'
    );
    expect(addOneMonth(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-15T00:00:00.000Z'
    );
  });

  it('a renewal paid early adds a month after the time already paid for', () => {
    const end = new Date(NOW.getTime() + 2 * day);
    expect(nextPaidUntil(end, NOW)).toEqual(addOneMonth(end));
  });

  it('a renewal after the month ran out starts now', () => {
    expect(nextPaidUntil(new Date(NOW.getTime() - 5 * day), NOW)).toEqual(addOneMonth(NOW));
    expect(nextPaidUntil(null, NOW)).toEqual(addOneMonth(NOW));
  });
});

describe('oneTimePlanCheckout', () => {
  it('lets a workspace with no plan buy', () => {
    expect(oneTimePlanCheckout(null, NOW)).toEqual({ ok: true, renew: false });
    expect(oneTimePlanCheckout({ identifier: 'sub_x', deletedAt: NOW }, NOW)).toEqual({
      ok: true,
      renew: false,
    });
  });

  it('refuses a second payment while more than 3 days are paid for', () => {
    const v = oneTimePlanCheckout(
      { identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 10 * day) },
      NOW
    );
    expect(v).toMatchObject({ ok: false, code: 'ALREADY_PAID' });
  });

  it('opens the renewal 3 days before the end and after it', () => {
    expect(
      oneTimePlanCheckout({ identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 3 * day) }, NOW)
    ).toEqual({ ok: true, renew: true });
    expect(
      oneTimePlanCheckout({ identifier: 'order_A', cancelAt: new Date(NOW.getTime() - day) }, NOW)
    ).toEqual({ ok: true, renew: true });
  });

  it('never opens an order beside an existing subscription, Gumroad, lifetime or gift plan', () => {
    for (const row of [
      { identifier: 'sub_live' },
      { identifier: 'sub_cancelling', cancelAt: new Date(NOW.getTime() + 20 * day) },
      { identifier: 'gumroad:sale1' },
      { identifier: 'sub_admin_lifetime', isLifetime: true },
      { identifier: 'restored-abc', cancelAt: new Date(NOW.getTime() + 20 * day) },
      { identifier: 'apimkt:x' },
    ]) {
      expect(oneTimePlanCheckout(row, NOW)).toEqual({ ok: false, code: 'HAS_PLAN' });
    }
  });

  it('a lifetime plan with an odd past date is still a plan', () => {
    expect(
      oneTimePlanCheckout({ identifier: 'x', isLifetime: true, cancelAt: new Date(0) }, NOW)
    ).toEqual({ ok: false, code: 'HAS_PLAN' });
  });
});

describe('renewalReminderDue', () => {
  it('shows only for a paid order ending within 3 days', () => {
    expect(renewalReminderDue({ identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 2 * day) }, NOW)).toBe(true);
    expect(renewalReminderDue({ identifier: 'order_A', cancelAt: new Date(NOW.getTime() + 4 * day) }, NOW)).toBe(false);
    expect(renewalReminderDue({ identifier: 'order_A', cancelAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(false);
    expect(renewalReminderDue({ identifier: 'sub_A', cancelAt: new Date(NOW.getTime() + day) }, NOW)).toBe(false);
    expect(isOrderIdentifier('order_A')).toBe(true);
    expect(isOrderIdentifier('sub_A')).toBe(false);
  });
});

describe('orderSignatureValid', () => {
  const secret = 'test_secret';
  const sign = (s: string) => createHmac('sha256', secret).update(s).digest('hex');

  it('accepts order_id|payment_id signed with the key secret', () => {
    expect(orderSignatureValid('order_1', 'pay_1', sign('order_1|pay_1'), secret)).toBe(true);
  });

  it('refuses the subscription operand order, another order, a bad or empty signature', () => {
    expect(orderSignatureValid('order_1', 'pay_1', sign('pay_1|order_1'), secret)).toBe(false);
    expect(orderSignatureValid('order_2', 'pay_1', sign('order_1|pay_1'), secret)).toBe(false);
    expect(orderSignatureValid('order_1', 'pay_1', 'deadbeef', secret)).toBe(false);
    expect(orderSignatureValid('order_1', 'pay_1', '', secret)).toBe(false);
    expect(orderSignatureValid('order_1', 'pay_1', sign('order_1|pay_1'), '')).toBe(false);
  });
});

describe('paidOrderRefusal', () => {
  const order = (over: any = {}) => ({
    id: 'order_1',
    amount: 700,
    currency: 'USD',
    status: 'paid',
    notes: { service: 'hookpost', kind: 'one_time_plan', orgId: 'org1', currency: 'USD', amount: '700' },
    ...over,
  });
  const payment = (over: any = {}) => ({
    id: 'pay_1',
    order_id: 'order_1',
    amount: 700,
    currency: 'USD',
    status: 'captured',
    ...over,
  });

  it('accepts a captured payment of the order, for its workspace', () => {
    expect(paidOrderRefusal({ order: order(), payment: payment(), organizationId: 'org1' })).toBeNull();
  });

  it('accepts a Rs 699 INR order', () => {
    const inr = order({ amount: 69900, currency: 'INR', notes: { ...order().notes, currency: 'INR', amount: '69900' } });
    expect(
      paidOrderRefusal({ order: inr, payment: payment({ amount: 69900, currency: 'INR' }), organizationId: 'org1' })
    ).toBeNull();
  });

  it('refuses an order of another product or another workspace', () => {
    expect(paidOrderRefusal({ order: order({ notes: { service: 'tablamigo' } }), payment: payment() })).toBe('NOT_OURS');
    expect(paidOrderRefusal({ order: order(), payment: payment(), organizationId: 'org2' })).toBe('WRONG_WORKSPACE');
  });

  it('refuses a payment of another order', () => {
    expect(paidOrderRefusal({ order: order(), payment: payment({ order_id: 'order_9' }) })).toBe('PAYMENT_NOT_FOR_ORDER');
  });

  it('refuses an uncaptured payment unless authorized is allowed', () => {
    expect(paidOrderRefusal({ order: order(), payment: payment({ status: 'failed' }) })).toBe('NOT_CAPTURED');
    expect(paidOrderRefusal({ order: order(), payment: payment({ status: 'authorized' }) })).toBe('NOT_CAPTURED');
    expect(
      paidOrderRefusal({ order: order(), payment: payment({ status: 'authorized' }), authorizedOk: true })
    ).toBeNull();
  });

  it('refuses amount tampering', () => {
    expect(paidOrderRefusal({ order: order(), payment: payment({ amount: 100 }) })).toBe('AMOUNT_MISMATCH');
    expect(
      paidOrderRefusal({ order: order({ amount: 100 }), payment: payment({ amount: 100 }) })
    ).toBe('AMOUNT_MISMATCH');
  });

  it('refuses a currency mismatch', () => {
    expect(paidOrderRefusal({ order: order(), payment: payment({ currency: 'INR' }) })).toBe('CURRENCY_MISMATCH');
    expect(
      paidOrderRefusal({
        order: order({ currency: 'EUR', notes: { ...order().notes, currency: 'EUR' } }),
        payment: payment({ currency: 'EUR' }),
      })
    ).toBe('AMOUNT_MISMATCH');
  });
});
