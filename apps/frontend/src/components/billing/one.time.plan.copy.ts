import {
  RENEW_WINDOW_DAYS,
  ONE_TIME_PLAN_NAME,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';

/** What GET /billing/order/quote answers (OneTimePlanService.quote). */
export interface OneTimePlanQuote {
  name: string;
  tier: string;
  currency: 'INR' | 'USD';
  price: number;
  label: string;
  canBuy: boolean;
  renew: boolean;
  refusal: 'HAS_PLAN' | 'ALREADY_PAID' | null;
  paidUntil: string | null;
}

/** "8 Dec 2026", the date every billing line prints. */
export function planDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The words on the one-time checkout (Billing and the plan screen): the
 * status line, the button, and the note under it. Never "lifetime",
 * "free forever" or "trial": it is one month, paid once.
 */
export function oneTimePlanCopy(q: Pick<OneTimePlanQuote, 'label' | 'canBuy' | 'renew' | 'refusal' | 'paidUntil'>) {
  const status = q.paidUntil
    ? `${ONE_TIME_PLAN_NAME} is paid until ${planDate(q.paidUntil)}.`
    : null;
  const button = q.renew
    ? `Renew for another month (${q.label})`
    : `Pay ${q.label} for one month`;
  const note = `One-time payment of ${q.label}. Nothing renews by itself: when the month ends, your workspace goes back to its free posts and you can renew for another month here.`;
  const refusal =
    q.refusal === 'ALREADY_PAID'
      ? `You can renew ${RENEW_WINDOW_DAYS} days before your month ends.`
      : q.refusal === 'HAS_PLAN'
      ? 'Your workspace already has a plan, which stays as it is.'
      : null;
  return { status, button, note, refusal };
}

/**
 * The in-app reminder, RENEW_WINDOW_DAYS before a paid month ends (no email:
 * the owner, 8 Nov 2026). Null when it should not show.
 */
export function renewalReminder(
  endsAt: string | null | undefined,
  now: Date = new Date()
): string | null {
  if (!endsAt) return null;
  const end = new Date(endsAt).getTime();
  if (!Number.isFinite(end)) return null;
  const left = end - now.getTime();
  if (left <= 0 || left > RENEW_WINDOW_DAYS * 86_400_000) return null;
  return `Your ${ONE_TIME_PLAN_NAME} month ends on ${planDate(endsAt)}. Renew for another month to keep posting without interruption.`;
}
