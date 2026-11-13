import {
  FIRST_MONTH_OFFER_CAP_INR,
  FIRST_MONTH_OFFER_PERCENT,
  firstMonthOfferApplies,
  firstMonthOfferDetail,
  firstMonthOfferFor,
  firstMonthOfferHeadline,
  firstMonthOfferIds,
  firstMonthOfferTerms,
  firstMonthPrice,
  formatRupees,
  OfferCheckout,
  pickOfferMethod,
  pricingPageOfferLine,
} from '@hookpost/nestjs-libraries/services/first.month.offer';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// The live ids are only in the server's .env; these have the same shape.
const UPI = 'offer_UpiTest0000001';
const CARD = 'offer_CardTest000001';
const BOTH = {
  RAZORPAY_OFFER_FIRST_MONTH_UPI: UPI,
  RAZORPAY_OFFER_FIRST_MONTH_CARD: CARD,
};

/** A new rupee monthly plan charged at checkout: the one case that gets it. */
const eligible: OfferCheckout = {
  currency: 'INR',
  period: 'MONTHLY',
  coupon: false,
  startsLater: false,
  newSubscription: true,
};

describe('first-month offer: the ids', () => {
  it('reads both methods from the environment', () => {
    expect(firstMonthOfferIds(BOTH)).toEqual({ upi: UPI, card: CARD });
  });

  it('unset, blank or malformed means no offer for that method', () => {
    expect(firstMonthOfferIds({})).toEqual({});
    expect(firstMonthOfferIds({ RAZORPAY_OFFER_FIRST_MONTH_UPI: '  ' })).toEqual({});
    // Razorpay answers 400 "The offer id must be 20 characters" to these, which
    // would fail every eligible checkout, so they are ignored instead.
    expect(
      firstMonthOfferIds({
        RAZORPAY_OFFER_FIRST_MONTH_UPI: 'offer_short',
        RAZORPAY_OFFER_FIRST_MONTH_CARD: 'plan_CardTest000001',
      })
    ).toEqual({});
    expect(firstMonthOfferIds({ RAZORPAY_OFFER_FIRST_MONTH_CARD: ` ${CARD} ` })).toEqual({
      card: CARD,
    });
  });
});

describe('first-month offer: which checkouts get it', () => {
  it('a new rupee monthly plan charged now, with no coupon', () => {
    expect(firstMonthOfferApplies(eligible)).toBe(true);
  });

  it.each<[string, Partial<OfferCheckout>]>([
    ['yearly', { period: 'YEARLY' }],
    ['dollars', { currency: 'USD' }],
    ['euros', { currency: 'EUR' }],
    ['a coupon (an affiliate code included): offers do not combine, the coupon wins', { coupon: true }],
    ['a trial: Razorpay refuses an offer on a subscription with a start_at', { startsLater: true }],
    ['a plan change or upgrade', { newSubscription: false }],
    ['a workspace whose people already had a paid plan or the offer (once per person)', { usedBefore: true }],
  ])('not on %s', (_name, change) => {
    expect(firstMonthOfferApplies({ ...eligible, ...change })).toBe(false);
  });

  it('usedBefore false or not asked: the offer as before', () => {
    expect(firstMonthOfferApplies({ ...eligible, usedBefore: false })).toBe(true);
    expect(firstMonthOfferFor({ ...eligible, usedBefore: true }, BOTH)).toBeNull();
    expect(firstMonthOfferFor({ ...eligible, usedBefore: false }, BOTH)).toEqual({ offerId: UPI, method: 'upi' });
  });

  it('ignores the case of currency and period', () => {
    expect(firstMonthOfferApplies({ ...eligible, currency: 'inr', period: 'monthly' })).toBe(true);
  });
});

describe('first-month offer: which offer goes on the subscription', () => {
  it('the method the customer chose', () => {
    expect(firstMonthOfferFor({ ...eligible, payWith: 'card' }, BOTH)).toEqual({
      offerId: CARD,
      method: 'card',
    });
    expect(firstMonthOfferFor({ ...eligible, payWith: 'upi' }, BOTH)).toEqual({
      offerId: UPI,
      method: 'upi',
    });
  });

  it('UPI when the page did not say (an older tab)', () => {
    expect(firstMonthOfferFor(eligible, BOTH)).toEqual({ offerId: UPI, method: 'upi' });
    expect(firstMonthOfferFor({ ...eligible, payWith: 'netbanking' }, BOTH)?.method).toBe('upi');
  });

  it('the only configured one when the other is unset', () => {
    expect(
      firstMonthOfferFor(
        { ...eligible, payWith: 'upi' },
        { RAZORPAY_OFFER_FIRST_MONTH_CARD: CARD }
      )
    ).toEqual({ offerId: CARD, method: 'card' });
  });

  it('none when no id is set, or the checkout does not qualify', () => {
    expect(firstMonthOfferFor(eligible, {})).toBeNull();
    expect(firstMonthOfferFor({ ...eligible, startsLater: true }, BOTH)).toBeNull();
    expect(firstMonthOfferFor({ ...eligible, period: 'YEARLY' }, BOTH)).toBeNull();
  });

  it('pickOfferMethod: asked if offered, else the first', () => {
    expect(pickOfferMethod(['upi', 'card'], 'card')).toBe('card');
    expect(pickOfferMethod(['card'], 'upi')).toBe('card');
    expect(pickOfferMethod([], 'upi')).toBeNull();
  });
});

describe('first-month offer: terms and prices', () => {
  it('terms only for rupees, and only with an id', () => {
    expect(firstMonthOfferTerms('INR', BOTH)).toEqual({
      percent: 20,
      capInr: 400,
      methods: ['upi', 'card'],
    });
    expect(firstMonthOfferTerms('USD', BOTH)).toBeNull();
    expect(firstMonthOfferTerms('INR', {})).toBeNull();
    expect(firstMonthOfferTerms('INR', { RAZORPAY_OFFER_FIRST_MONTH_UPI: UPI })?.methods).toEqual([
      'upi',
    ]);
  });

  it('20% capped at ₹400, the dashboard offers', () => {
    expect(FIRST_MONTH_OFFER_PERCENT).toBe(20);
    expect(FIRST_MONTH_OFFER_CAP_INR).toBe(400);
  });

  it('Standard ₹599 -> ₹479.20, what Razorpay checkout offered live (47920 paise)', () => {
    expect(firstMonthPrice(pricingINR.STANDARD.month_price)).toBe(479.2);
    expect(formatRupees(firstMonthPrice(599))).toBe('₹479.20');
  });

  it('Pro ₹1,999 -> ₹1,599.20 (₹399.80 off, under the cap)', () => {
    expect(firstMonthPrice(pricingINR.PRO.month_price)).toBe(1599.2);
  });

  it('the cap holds above ₹2,000 a month', () => {
    expect(firstMonthPrice(4499)).toBe(4099);
  });

  it('copy', () => {
    const terms = firstMonthOfferTerms('INR', BOTH)!;
    expect(firstMonthOfferHeadline(terms)).toBe('First month 20% off (new customers), up to ₹400');
    expect(firstMonthOfferDetail({ terms, method: 'upi', monthPrice: 599 })).toBe(
      'Pay by UPI and your first month is ₹479.20, then ₹599 a month. Paying another way is charged ₹599.'
    );
    expect(firstMonthOfferDetail({ terms, method: 'card', monthPrice: 1999 })).toContain(
      'Pay by card and your first month is ₹1,599.20, then ₹1,999 a month.'
    );
    // No amount where several plans are listed.
    expect(firstMonthOfferDetail({ terms, method: 'upi' })).not.toMatch(/₹/);
    expect(pricingPageOfferLine(terms)).toBe(
      'First month 20% off (new customers), up to ₹400, on a monthly plan paid by UPI or card.'
    );
    expect(
      pricingPageOfferLine(firstMonthOfferTerms('INR', { RAZORPAY_OFFER_FIRST_MONTH_UPI: UPI })!)
    ).toMatch(/paid by UPI\.$/);
  });
});
