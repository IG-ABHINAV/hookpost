/**
 * The first-month offer as the billing screens show it: when the paywall
 * offers 20% off the first month (firstMonthOfferOf + firstMonthOfferApplies,
 * as first.billing and main.billing call them), and the UPI / card choice.
 *   pnpm exec jest -c apps/frontend/jest.config.ts first.month.offer
 */
import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { firstMonthOfferApplies } from '@hookpost/nestjs-libraries/services/first.month.offer';
import {
  firstMonthOfferOf,
  PricingContext,
} from '@hookpost/frontend/components/billing/use.pricing.context';
import {
  checkoutDroppedOffer,
  FirstMonthOffer,
  FirstMonthOfferNotApplied,
} from '@hookpost/frontend/components/billing/first.month.offer';

afterEach(cleanup);

const TERMS = { percent: 20, capInr: 400, methods: ['upi', 'card'] as Array<'upi' | 'card'> };
const ctx = (over: Partial<PricingContext> = {}): PricingContext => ({
  displayCurrency: 'INR',
  chargeCurrency: 'INR',
  lockedCurrency: null,
  checkoutAllowed: true,
  region: { country: 'IN', tzSaysIndia: true, ipSaysIndia: true },
  prices: { STANDARD: { month: 599, year: 5990 }, PRO: { month: 1999, year: 19990 } },
  firstMonthOffer: TERMS,
  ...over,
});

/** What the paywall (first.billing) decides for a workspace. */
const paywallShowsOffer = (
  c: PricingContext,
  w: { period: 'MONTHLY' | 'YEARLY'; coupon?: boolean; allowTrial: boolean }
) => {
  const terms = firstMonthOfferOf(c);
  return (
    !!terms &&
    firstMonthOfferApplies({
      currency: c.chargeCurrency,
      period: w.period,
      coupon: !!w.coupon,
      startsLater: w.allowTrial,
      newSubscription: true,
    })
  );
};

describe('firstMonthOfferOf: the terms the pages may use', () => {
  it('rupees with the offer on', () => {
    expect(firstMonthOfferOf(ctx())).toEqual(TERMS);
  });

  it('none from an older backend, with it off, with no method, or in dollars', () => {
    expect(firstMonthOfferOf(ctx({ firstMonthOffer: undefined }))).toBeNull();
    expect(firstMonthOfferOf(ctx({ firstMonthOffer: null }))).toBeNull();
    expect(firstMonthOfferOf(ctx({ firstMonthOffer: { ...TERMS, methods: [] } }))).toBeNull();
    expect(firstMonthOfferOf(ctx({ chargeCurrency: 'USD', displayCurrency: 'USD' }))).toBeNull();
    expect(firstMonthOfferOf(null)).toBeNull();
  });
});

describe('the paywall offers 20% off the first month only where Razorpay applies it', () => {
  it('a workspace whose trial is used, buying monthly in rupees', () => {
    expect(paywallShowsOffer(ctx(), { period: 'MONTHLY', allowTrial: false })).toBe(true);
  });

  it('not with a trial ahead (a trial cannot carry the offer): the trial wording stays as it is', () => {
    expect(paywallShowsOffer(ctx(), { period: 'MONTHLY', allowTrial: true })).toBe(false);
  });

  it('not yearly, not with a coupon, not in dollars', () => {
    expect(paywallShowsOffer(ctx(), { period: 'YEARLY', allowTrial: false })).toBe(false);
    expect(paywallShowsOffer(ctx(), { period: 'MONTHLY', coupon: true, allowTrial: false })).toBe(false);
    expect(
      paywallShowsOffer(ctx({ chargeCurrency: 'USD', displayCurrency: 'USD' }), {
        period: 'MONTHLY',
        allowTrial: false,
      })
    ).toBe(false);
  });
});

describe('<FirstMonthOffer>', () => {
  it('the headline, the UPI / card choice and what the first month costs that way', () => {
    const onChange = jest.fn();
    const { container, getByRole } = render(
      React.createElement(FirstMonthOffer, {
        terms: TERMS,
        monthPrice: 599,
        payWith: 'upi',
        onPayWithChange: onChange,
      })
    );
    const text = container.textContent!;
    expect(text).toContain('First month 20% off (new customers), up to ₹400');
    expect(text).toContain('Pay by UPI and your first month is ₹479.20, then ₹599 a month.');
    expect(text).toContain('Paying another way is charged ₹599.');
    expect(getByRole('radio', { name: 'Pay with UPI' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(getByRole('radio', { name: 'Pay with card' }));
    expect(onChange).toHaveBeenCalledWith('card');
  });

  it('one method configured: no choice, and the line names it', () => {
    const { container, queryAllByRole } = render(
      React.createElement(FirstMonthOffer, {
        terms: { ...TERMS, methods: ['card'] },
        monthPrice: 1999,
        payWith: 'upi',
        onPayWithChange: () => undefined,
      })
    );
    expect(queryAllByRole('radio')).toHaveLength(0);
    expect(container.textContent).toContain('Pay by card and your first month is ₹1,599.20');
  });
});

// subscribe() answers with firstMonthOffer: the method whose offer the
// subscription carries, or null when it has none (Razorpay refused it and
// checkout fell back to the full price). A plan change on file never has it.
describe('checkoutDroppedOffer: the page stops promising a discount checkout did not apply', () => {
  const opened = { subscriptionId: 'sub_1', startAt: null };

  it('the offer was shown and checkout came back without it: dropped', () => {
    expect(checkoutDroppedOffer(true, { ...opened, firstMonthOffer: null })).toBe(true);
    // A plan change answers without the field at all.
    expect(checkoutDroppedOffer(true, opened)).toBe(true);
  });

  it('checkout carries the offer, the offer was never shown, or no checkout opened: nothing changes', () => {
    expect(checkoutDroppedOffer(true, { ...opened, firstMonthOffer: 'upi' })).toBe(false);
    expect(checkoutDroppedOffer(true, { ...opened, firstMonthOffer: 'card' })).toBe(false);
    expect(checkoutDroppedOffer(false, { ...opened, firstMonthOffer: null })).toBe(false);
    expect(checkoutDroppedOffer(true, { blocked: true, subscriptionId: 'sub_1' })).toBe(false);
    expect(checkoutDroppedOffer(true, { statusCode: 500 } as any)).toBe(false);
    expect(checkoutDroppedOffer(true, null)).toBe(false);
  });

  it('the line that replaces the offer names no discount', () => {
    const { container, getByTestId } = render(React.createElement(FirstMonthOfferNotApplied));
    expect(getByTestId('first-month-offer-not-applied')).toBeTruthy();
    expect(container.textContent).toContain('could not be applied');
    expect(container.textContent).not.toMatch(/20%|₹479/);
  });
});
