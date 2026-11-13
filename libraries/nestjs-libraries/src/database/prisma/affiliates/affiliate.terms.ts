/**
 * The affiliate programme's terms, in one place: the backend records
 * commissions with them, and the pages that state them (/affiliates, the
 * /affiliate dashboard, the ?ref cookie) read them from here, so a change is
 * one edit. Pure constants and functions, safe in the browser.
 *
 * 27 Sep 2026: 30% of every payment for 12 months, 60-day cookie, ₹1,000
 * minimum payout, a 10% coupon for the audience.
 * 22 Oct 2026 (owner's approval): the commission runs for the lifetime of
 * the referred subscription. Cookie, minimum payout and coupon unchanged.
 *
 * 3 Nov 2026: per-affiliate deals. A standard affiliate who joins from now
 * on gets 30% for 12 months (AFFILIATE_DEFAULT_COMMISSION_MONTHS); an admin
 * can give any affiliate another percent or duration in /admin/affiliates,
 * including "while partner active" (0: no end date, for as long as the
 * customer pays and the affiliate is not paused).
 *
 * Terms are fixed per referral when it is made (AffiliateReferral
 * .commissionPercent / .commissionMonths), so changing an affiliate's deal
 * applies to the customers they refer from then on and never cuts a
 * customer already referred. Affiliates who joined on lifetime terms keep
 * them.
 */

/** Share of every captured payment from a referred workspace. */
export const AFFILIATE_COMMISSION_PERCENT = 30;

/**
 * commissionMonths meaning "while partner active": no end date, for as long
 * as the customer pays and the affiliate is not paused.
 */
export const AFFILIATE_COMMISSION_LIFETIME = 0;

/** How long a standard affiliate who joins now earns from each customer. */
export const AFFILIATE_DEFAULT_COMMISSION_MONTHS = 12;

/** Limits on a deal an admin sets, so a typo cannot promise 300%. */
export const AFFILIATE_MAX_COMMISSION_PERCENT = 50;
export const AFFILIATE_MAX_COMMISSION_MONTHS = 120;

/** How long a ?ref= link is remembered (the hp_ref cookie). */
export const AFFILIATE_COOKIE_DAYS = 60;

/** Payouts are sent once what is owed passes this many rupees. */
export const AFFILIATE_MIN_PAYOUT_INR = 1000;

/** The minimum payout for dollar commissions, the equivalent of ₹1,000. */
export const AFFILIATE_MIN_PAYOUT_USD = 12;

/**
 * Whether what an affiliate is owed has reached the minimum payout.
 * `pending` is per currency, in the smallest unit (paise, cents). Each
 * currency is judged against its own floor (₹1,000, $12) and never converted,
 * so ₹999 and $11 together are not due.
 */
export const payoutDue = (pending: Record<string, number> | null | undefined) =>
  Number(pending?.INR || 0) >= AFFILIATE_MIN_PAYOUT_INR * 100 ||
  Number(pending?.USD || 0) >= AFFILIATE_MIN_PAYOUT_USD * 100;

/** Every affiliate code is also a checkout coupon for this much off. */
export const AFFILIATE_COUPON_PERCENT = 10;

/** Whether a stored window is the lifetime one. */
export const isLifetimeCommission = (months: number | null | undefined) =>
  !(Number(months) > 0);

/**
 * Whether a payment `now` still earns commission on a referral made at
 * `referredAt`, for an affiliate whose window is `months`.
 */
export function commissionWindowOpen(
  months: number | null | undefined,
  referredAt: Date | string,
  now: Date = new Date()
): boolean {
  if (isLifetimeCommission(months)) return true;
  const from = new Date(referredAt);
  // Whole calendar months since the referral, then the part of the current one.
  let monthsIn =
    (now.getUTCFullYear() - from.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - from.getUTCMonth());
  const anchor = new Date(from);
  anchor.setUTCMonth(from.getUTCMonth() + monthsIn);
  if (anchor.getTime() > now.getTime()) monthsIn -= 1;
  return monthsIn < Number(months);
}

/**
 * The commission in words: "30% of every payment for the first 12 months",
 * or "30% of every payment, for as long as the customer pays, while the
 * partnership is active" for a no-end-date deal.
 */
export function commissionTerm(
  percent: number = AFFILIATE_COMMISSION_PERCENT,
  months: number | null | undefined = AFFILIATE_DEFAULT_COMMISSION_MONTHS
): string {
  return isLifetimeCommission(months)
    ? `${percent}% of every payment, for as long as the customer pays, while the partnership is active`
    : `${percent}% of every payment for the first ${months} months`;
}
