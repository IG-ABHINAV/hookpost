/**
 * The yearly price as the public pages state it, "Standard: ₹5,990/year
 * (2 months free)" (yearly.copy.ts), and the note for a plan over UPI
 * AutoPay's ₹15,000 limit (checkout.notes.ts).
 *   pnpm exec jest -c apps/frontend/jest.config.ts yearly.copy
 */
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  monthsFree,
  STANDARD_YEARLY_LINE,
  yearlyPriceText,
} from '@hookpost/frontend/components/billing/yearly.copy';
import { upiCapNote } from '@hookpost/frontend/components/billing/checkout.notes';

describe('the yearly price', () => {
  it('Standard: ₹5,990/year (2 months free), from pricing.ts', () => {
    expect(pricingINR.STANDARD.year_price).toBe(5990);
    expect(monthsFree(pricingINR.STANDARD)).toBe(2);
    expect(STANDARD_YEARLY_LINE).toBe('Standard: ₹5,990/year (2 months free)');
  });

  it('no "months free" when a year saves nothing; one month in the singular', () => {
    expect(yearlyPriceText({ month_price: 100, year_price: 1200 })).toBe('₹1,200/year');
    expect(yearlyPriceText({ month_price: 100, year_price: 1100 })).toBe('₹1,100/year (1 month free)');
  });
});

describe('UPI AutoPay limit note', () => {
  it('Pro yearly (₹19,990) is over ₹15,000: card or NetBanking', () => {
    expect(upiCapNote('INR', pricingINR.PRO.year_price, 'Pro yearly')).toBe(
      'UPI AutoPay covers payments up to ₹15,000, so Pro yearly is paid by card or NetBanking. A card asks you to approve each renewal.'
    );
  });

  it('nothing for Standard yearly, monthly plans or dollars', () => {
    expect(upiCapNote('INR', pricingINR.STANDARD.year_price)).toBeNull();
    expect(upiCapNote('INR', pricingINR.PRO.month_price)).toBeNull();
    expect(upiCapNote('USD', 29000)).toBeNull();
  });
});
