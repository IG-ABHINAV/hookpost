/**
 * The yearly price as the public pages state it: "Standard: ₹5,990/year
 * (2 months free)". Read from pricing.ts, never typed, so a price change
 * there changes every page and the structured data together.
 *
 * Standard yearly in rupees is a plan Razorpay already holds
 * (STANDARD|YEARLY|599000|INR, the key findOrCreatePlan looks up), well
 * under UPI AutoPay's ₹15,000 limit. Pro yearly (₹19,990) is over that
 * limit (checkout.notes.ts), so the public pages name only Standard's; Pro
 * yearly stays a choice on the billing page.
 */
import {
  pricingINR,
  PricingInnerInterface,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { groupDigits } from './group.digits';

/** Whole months a year saves against twelve monthly payments: 2 for 5,990 vs 599. */
export function monthsFree(
  plan: Pick<PricingInnerInterface, 'month_price' | 'year_price'>
): number {
  if (!(plan.month_price > 0) || !(plan.year_price > 0)) return 0;
  return Math.max(0, Math.round(12 - plan.year_price / plan.month_price));
}

// Not toLocaleString: these lines are built at module load in the homepage's
// pricing cards, and a first Intl call loads ICU mid-hydration (group.digits.ts).
const rupees = (n: number) => `₹${groupDigits(n, 'en-IN')}`;

/** "2 months free", or "" when a year saves nothing. */
const monthsFreeText = (
  plan: Pick<PricingInnerInterface, 'month_price' | 'year_price'>
) => {
  const free = monthsFree(plan);
  return free ? `${free} month${free === 1 ? '' : 's'} free` : '';
};

/** "₹5,990/year (2 months free)", or "₹5,990/year" when a year saves nothing. */
export function yearlyPriceText(
  plan: Pick<PricingInnerInterface, 'month_price' | 'year_price'>,
  money: (n: number) => string = rupees
): string {
  const free = monthsFreeText(plan);
  return `${money(plan.year_price)}/year${free ? ` (${free})` : ''}`;
}

/** "Standard: ₹5,990/year (2 months free)" */
export const STANDARD_YEARLY_LINE = `Standard: ${yearlyPriceText(
  pricingINR.STANDARD
)}`;

/**
 * How every plan is billed, as the paywall sells it: its period toggle starts
 * on Monthly, and Yearly is the other choice (both tiers, either currency).
 * Pages that state a monthly price say this next to it, so "a month" is never
 * read as the only way to pay, nor "month to month" as no yearly plan.
 */
export const BILLED_MONTHLY_UNLESS_YEARLY =
  'billed monthly unless you choose yearly at checkout';

/**
 * "Standard: ₹5,990 a year, 2 months free": STANDARD_YEARLY_LINE's figures
 * without brackets, for a sentence that already has them (the trial terms).
 */
export const STANDARD_YEARLY_CLAUSE = `Standard: ${rupees(
  pricingINR.STANDARD.year_price
)} a year${
  monthsFreeText(pricingINR.STANDARD)
    ? `, ${monthsFreeText(pricingINR.STANDARD)}`
    : ''
}`;
