/**
 * ONE PLAN, PAID ONE MONTH AT A TIME (the owner, 8 Nov 2026).
 *
 * New purchases are a single plan, paid with a one-time Razorpay order (UPI,
 * card, international card), not a subscription mandate: recurring rails on
 * this account are India-only, which is why foreign cards and UPI AutoPay
 * checkouts failed. Each paid order gives the workspace one calendar month
 * of the plan. At the end of the paid month the workspace drops back to its
 * free-posts state (trial.policy.ts planState) and sees "Renew for another
 * month", another one-time order. Auto-renew may come later.
 *
 * - Price: pricing.ts HOOKPOST_PRICE. Shown as $7 everywhere; charged
 *   Rs 699 in INR to every buyer, India or not (orderCurrencyFor); a foreign
 *   card pays it through Razorpay's currency conversion. The server computes
 *   the amount; nothing the browser sends is trusted. Orders created in USD
 *   before this still verify: the amount is checked against the order's own
 *   notes, not today's price.
 * - Entitlements: the HOOKPOST tier (pricing.ts TIER_LIMITS.HOOKPOST).
 * - A paid order is written as a Subscription row with identifier
 *   `order_...` and cancelAt at the end of the paid month (planSource
 *   'order'). planLapsed ends it at that second; the plan-end timer and the
 *   hourly sweep tidy the row.
 * - Existing Razorpay subscriptions, Gumroad, lifetime and gifted plans are
 *   untouched: they cannot buy an order beside their plan (oneTimePlanCheckout).
 *
 * Pure: no Nest, Prisma, Razorpay or Node imports, so specs, scripts and the
 * frontend can all import it (the order signature check is in razorpay.client.ts).
 */
import { HOOKPOST_PRICE, ONE_TIME_PLAN_PRICE } from './pricing';

/** The tier every new purchase grants, autopay or a paid month (pricing.ts TIER_LIMITS.HOOKPOST). */
export const ONE_TIME_PLAN_TIER = 'HOOKPOST' as const;

/** What the plan is called on every page. */
export const ONE_TIME_PLAN_NAME = 'Hookpost';

/** The flat monthly price: pricing.ts ONE_TIME_PLAN_PRICE, the one line to change. */
export { ONE_TIME_PLAN_PRICE };

export type OrderCurrency = keyof typeof ONE_TIME_PLAN_PRICE;

export const ORDER_CURRENCIES = Object.keys(ONE_TIME_PLAN_PRICE) as OrderCurrency[];

/** The renewal checkout and the in-app reminder open this long before the end. */
export const RENEW_WINDOW_DAYS = 3;

/**
 * An order nobody paid within this long is not paid through the app's own
 * confirmation any more (verifyOneTimePayment refuses ORDER_EXPIRED). A
 * payment Razorpay does capture on it later still counts: the money was taken.
 */
export const ORDER_MAX_AGE_MS = 24 * 3600 * 1000;

/** Razorpay order notes that mark one of ours. */
export const ORDER_KIND = 'one_time_plan';

/** BillingIdentity kind of the row that records a payment as granted. */
export const ORDER_PAYMENT_IDENTITY = 'ORDER_PAYMENT';

/** Whether a plan identifier is a paid one-time order. */
export function isOrderIdentifier(identifier: string | null | undefined): boolean {
  return typeof identifier === 'string' && identifier.startsWith('order_');
}

/**
 * The currency an order charges: rupees, for every country (the owner,
 * 8 Nov 2026). `country` is kept so callers need not change; it no longer
 * decides anything.
 */
export function orderCurrencyFor(_country?: string | null): OrderCurrency {
  return 'INR';
}

/** The order amount in minor units (paise, cents), or null for any other currency. */
export function oneTimePlanAmountMinor(currency: string | null | undefined): number | null {
  const code = (currency || '').trim().toUpperCase() as OrderCurrency;
  if (!Object.prototype.hasOwnProperty.call(ONE_TIME_PLAN_PRICE, code)) return null;
  return ONE_TIME_PLAN_PRICE[code] * 100;
}

/** "$7": the price every page shows, whatever the order is charged in. */
export function oneTimePlanPriceLabel(_currency?: string | null): string {
  return `$${HOOKPOST_PRICE.displayUsd}`;
}

/** "₹699": what the order is charged (the Razorpay checkout shows it). */
export function oneTimePlanChargeLabel(): string {
  return `₹${ONE_TIME_PLAN_PRICE.INR.toLocaleString('en-IN')}`;
}

/**
 * One calendar month after `from`, the day clamped to the month's end
 * (31 Jan -> 28/29 Feb), at the same time of day, in UTC.
 */
export function addOneMonth(from: Date): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Where a paid month ends: one month after the later of now and the end
 * already paid for, so a renewal paid early (or a second payment) adds a
 * whole month and never overlaps the time already bought.
 */
export function nextPaidUntil(currentEnd: Date | string | null | undefined, now: Date): Date {
  const end = currentEnd ? new Date(currentEnd).getTime() : NaN;
  const start = Number.isFinite(end) && end > now.getTime() ? new Date(end) : now;
  return addOneMonth(start);
}

export interface PlanRowLike {
  identifier?: string | null;
  cancelAt?: Date | string | null;
  deletedAt?: Date | string | null;
  isLifetime?: boolean | null;
}

/**
 * ok with renew (a renewal of a paid month), or not ok with a code. One
 * shape rather than a union: the backend builds without strictNullChecks,
 * which does not narrow a union on ok.
 */
export interface CheckoutVerdict {
  ok: boolean;
  renew?: boolean;
  code?: 'HAS_PLAN' | 'ALREADY_PAID';
  paidUntil?: Date;
}

/**
 * Whether a workspace may open a one-time checkout now.
 *
 * - No plan, or a plan whose end has passed: yes (a first purchase, or a
 *   renewal after the month ran out).
 * - A paid order with RENEW_WINDOW_DAYS or less left: yes, a renewal that
 *   adds a month after the current one.
 * - A paid order with more left: no (ALREADY_PAID), so nobody pays twice by
 *   accident.
 * - Any other live plan (a Razorpay subscription, Gumroad, lifetime, a gift,
 *   a marketplace plan): no (HAS_PLAN). It stays exactly as it is.
 */
export function oneTimePlanCheckout(
  row: PlanRowLike | null | undefined,
  now: Date
): CheckoutVerdict {
  if (!row || row.deletedAt) return { ok: true, renew: false };
  const end = row.cancelAt ? new Date(row.cancelAt).getTime() : NaN;
  const ended = !row.isLifetime && Number.isFinite(end) && end <= now.getTime();
  if (isOrderIdentifier(row.identifier)) {
    if (ended) return { ok: true, renew: true };
    if (!Number.isFinite(end)) return { ok: false, code: 'ALREADY_PAID' };
    return end - now.getTime() <= RENEW_WINDOW_DAYS * 86_400_000
      ? { ok: true, renew: true }
      : { ok: false, code: 'ALREADY_PAID', paidUntil: new Date(end) };
  }
  if (ended) return { ok: true, renew: false };
  return { ok: false, code: 'HAS_PLAN' };
}

/** Whether the in-app "renew" reminder shows: a paid order ending within RENEW_WINDOW_DAYS. */
export function renewalReminderDue(row: PlanRowLike | null | undefined, now: Date): boolean {
  if (!row || row.deletedAt || !isOrderIdentifier(row.identifier) || !row.cancelAt) return false;
  const left = new Date(row.cancelAt).getTime() - now.getTime();
  return left > 0 && left <= RENEW_WINDOW_DAYS * 86_400_000;
}

export type PaidOrderRefusal =
  | 'NOT_OURS'
  | 'WRONG_WORKSPACE'
  | 'PAYMENT_NOT_FOR_ORDER'
  | 'NOT_CAPTURED'
  | 'AMOUNT_MISMATCH'
  | 'CURRENCY_MISMATCH';

/**
 * Whether a Razorpay order and payment, as Razorpay itself returns them,
 * pay for one month of the plan for `organizationId`. Everything is read
 * from Razorpay's copies, never from the browser:
 *
 * - the order is ours (notes.service hookpost, notes.kind one_time_plan) and
 *   for this workspace (notes.orgId);
 * - the payment belongs to the order;
 * - it is captured, or `authorizedOk` and authorized (the caller captures
 *   it for exactly the order's amount);
 * - order amount, payment amount and the price the server set on the order
 *   (notes.amount, written by createOrder from ONE_TIME_PLAN_PRICE) agree,
 *   in a currency the plan is sold in. The order is created on the server,
 *   so its amount is the price at the time; a price change afterwards does
 *   not refuse a payment already made on it.
 */
export function paidOrderRefusal(input: {
  order: any;
  payment: any;
  organizationId?: string | null;
  authorizedOk?: boolean;
}): PaidOrderRefusal | null {
  const { order, payment } = input;
  const notes = order?.notes || {};
  if (notes.service !== 'hookpost' || notes.kind !== ORDER_KIND || !notes.orgId) {
    return 'NOT_OURS';
  }
  if (input.organizationId && notes.orgId !== input.organizationId) {
    return 'WRONG_WORKSPACE';
  }
  if (!payment?.id || payment.order_id !== order.id) return 'PAYMENT_NOT_FOR_ORDER';
  const status = payment.status;
  if (!(status === 'captured' || (input.authorizedOk && status === 'authorized'))) {
    return 'NOT_CAPTURED';
  }
  const currency = String(order.currency || '').toUpperCase();
  if (
    String(payment.currency || '').toUpperCase() !== currency ||
    String(notes.currency || '').toUpperCase() !== currency
  ) {
    return 'CURRENCY_MISMATCH';
  }
  // A currency an order of ours was ever created in: USD orders from before
  // 8 Nov 2026 still verify (the amount is the order's own, in its notes).
  const sold = currency === 'INR' || currency === 'USD';
  const noted = Number(notes.amount);
  if (
    !sold ||
    !Number.isInteger(order.amount) ||
    payment.amount !== order.amount ||
    noted !== order.amount ||
    order.amount <= 0
  ) {
    return 'AMOUNT_MISMATCH';
  }
  return null;
}

/**
 * Take one paid month back off an end date (a full refund of one of the
 * payments): the inverse of addOneMonth, the day clamped the same way.
 */
export function removeOneMonth(end: Date): Date {
  const d = new Date(end.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * A payment counts as refunded once this share of it is, as for a
 * subscription's period (razorpay.service.ts refundedInFull): a small
 * goodwill refund keeps the month.
 */
export const ORDER_FULL_REFUND_SHARE = 0.9;
