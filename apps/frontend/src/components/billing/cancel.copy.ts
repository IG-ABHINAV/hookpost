import dayjs from 'dayjs';
import {
  freePlanEndDateLabel,
  MEDIA_KEPT_LINE,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/**
 * What Billing says around Cancel. A trial cancelled before its first charge
 * keeps working until the date that charge was due, and is never charged
 * (handleCancelled on the backend). After that, a workspace created before the
 * trial cutoff moves to the Free plan and one in the new cohort is paused
 * (freePlanAvailable from /user/self, trial.policy.ts on the backend).
 *
 * While FREE_PLAN_SUNSET_AT is ahead, that Free plan itself ends on that date
 * (freePlanSunsetAt from /user/self, passed here as freePlanEndsAt): a plan
 * that ends before it is on Free until then, and one that ends on or after it
 * pauses. Once the date has passed, /user/self already sends freePlanAvailable
 * false for such a workspace, so the copy says it pauses.
 */

/** The sunset, when one is set and still ahead. */
const sunsetOf = (freePlanEndsAt?: string | null): dayjs.Dayjs | null => {
  if (!freePlanEndsAt) return null;
  const d = dayjs(freePlanEndsAt);
  return d.isValid() && d.isAfter(dayjs()) ? d : null;
};

/** "27 October 2026", the date the sunset email and notice print. */
const sunsetLabel = (sunset: dayjs.Dayjs) => freePlanEndDateLabel(sunset.toDate());

/** After "moves to the Free plan" when that Free plan ends: " until ...". */
export const freePlanUntil = (freePlanEndsAt?: string | null): string => {
  const sunset = sunsetOf(freePlanEndsAt);
  return sunset
    ? ` until ${sunsetLabel(sunset)}, when the Free plan ends and the workspace pauses`
    : '';
};

/** What follows a plan or trial that ends at `end`: Free, Free until the sunset, or a pause. */
const afterEnd = (
  freePlan: boolean,
  end: dayjs.Dayjs,
  freePlanEndsAt?: string | null
) => {
  if (!freePlan) return 'then the workspace pauses';
  const sunset = sunsetOf(freePlanEndsAt);
  if (sunset && !end.isBefore(sunset)) {
    return `then the workspace pauses, as the Free plan ends on ${sunsetLabel(sunset)}`;
  }
  return `then moves to the Free plan${freePlanUntil(freePlanEndsAt)}`;
};

const fmt = (date: dayjs.Dayjs) => date.format('D MMM YYYY');

/**
 * Within a day of a trial's first charge the bank may already have the debit
 * (it reached the bank about a day early on live trials, which is why every
 * trial page says "at least 24 hours before"). Cancelling then cannot promise
 * "no charge"; it says the debit may go through and is refunded in full,
 * which /refund-policy promises. FIRST_DEBIT_LEAD_SEC on the backend.
 */
const FIRST_DEBIT_LEAD_HOURS = 24;

export const firstDebitMayBeUnderway = (
  firstChargeAt: dayjs.Dayjs,
  now: dayjs.Dayjs = dayjs()
): boolean => firstChargeAt.diff(now, 'minute') < FIRST_DEBIT_LEAD_HOURS * 60;

const LATE_CANCEL_LINE =
  'Your bank may already have started the first debit; if it goes through, we refund it in full.';

/** The confirm dialog before Cancel is sent. */
export const cancelDialogCopy = (p: {
  isTrial: boolean;
  trialEndsAt?: string | null;
  freePlan: boolean;
  tierName?: string | null;
  /** freePlanSunsetAt from /user/self: when the Free plan itself ends. */
  freePlanEndsAt?: string | null;
  /**
   * A charge on the plan was refunded (GET /billing/cancel/quote), so Cancel
   * ends it now rather than at the end of the period.
   */
  refunded?: boolean;
}): string => {
  if (p.isTrial) {
    const until = p.trialEndsAt ? dayjs(p.trialEndsAt) : null;
    if (until && until.isAfter(dayjs().add(1, 'minute'))) {
      if (firstDebitMayBeUnderway(until)) {
        return `Your trial is cancelled now. ${LATE_CANCEL_LINE} You keep access until ${fmt(
          until
        )}, ${afterEnd(p.freePlan, until, p.freePlanEndsAt)}.`;
      }
      return `Your trial is cancelled now and you won't be charged. You keep access until ${fmt(
        until
      )}, ${afterEnd(p.freePlan, until, p.freePlanEndsAt)}.`;
    }
    return p.freePlan
      ? `Your free trial ends now and this workspace moves to the Free plan${freePlanUntil(
          p.freePlanEndsAt
        )}. You won't be charged.`
      : `Your free trial ends now and the workspace pauses; ${MEDIA_KEPT_LINE}. You won't be charged.`;
  }
  if (p.refunded) {
    return `Your payment was refunded, so ${
      p.tierName || 'your plan'
    } ends now and ${
      p.freePlan
        ? `this workspace moves to the Free plan${freePlanUntil(
            p.freePlanEndsAt
          )}`
        : `the workspace pauses; ${MEDIA_KEPT_LINE}`
    }. You won't be charged again.`;
  }
  // The end of the paid period is not known here, so with a sunset ahead
  // both outcomes are named.
  const sunset = sunsetOf(p.freePlanEndsAt);
  return `You keep ${
    p.tierName || 'your plan'
  } until the end of the period you've paid for, ${
    !p.freePlan
      ? `then the workspace pauses; ${MEDIA_KEPT_LINE}`
      : sunset
      ? `then the workspace pauses (if your period ends before ${sunsetLabel(
          sunset
        )}, it is on the Free plan until then); ${MEDIA_KEPT_LINE}`
      : 'then this workspace moves to the Free plan'
  }. You won't be charged again.`;
};

/** The toast once Cancel went through; `cancelAt` is the server's answer. */
export const cancelledToastCopy = (p: {
  cancelAt: string | Date;
  isTrial: boolean;
  freePlan: boolean;
  tierName?: string | null;
  /** freePlanSunsetAt from /user/self: when the Free plan itself ends. */
  freePlanEndsAt?: string | null;
}): string => {
  const until = dayjs(p.cancelAt);
  if (until.isAfter(dayjs().add(1, 'minute'))) {
    if (p.isTrial && firstDebitMayBeUnderway(until)) {
      return `Trial cancelled. ${LATE_CANCEL_LINE} Access until ${fmt(
        until
      )}, ${afterEnd(p.freePlan, until, p.freePlanEndsAt)}.`;
    }
    return p.isTrial
      ? `Trial cancelled. No charge. Access until ${fmt(until)}, ${afterEnd(
          p.freePlan,
          until,
          p.freePlanEndsAt
        )}.`
      : `Cancelled. ${p.tierName || 'Your plan'} stays active until ${fmt(
          until
        )}, and you won't be charged again.`;
  }
  return p.freePlan
    ? `Cancelled. This workspace moves to the Free plan${freePlanUntil(
        p.freePlanEndsAt
      )}, and you won't be charged again.`
    : `Cancelled. The workspace is paused until you choose a plan, and you won't be charged again.`;
};

/**
 * The status line under the plans while a cancelled trial runs out. In its
 * last day it no longer says "No charge": the line cannot tell whether the
 * trial was cancelled before the bank had the debit, so it says what happens
 * if one goes through.
 */
export const trialCancelledLine = (
  endsAt: dayjs.Dayjs,
  freePlan: boolean,
  freePlanEndsAt?: string | null
): string =>
  firstDebitMayBeUnderway(endsAt)
    ? `Trial cancelled. Access until ${fmt(endsAt)}, ${afterEnd(
        freePlan,
        endsAt,
        freePlanEndsAt
      )}. If a first debit your bank had already started goes through, we refund it in full.`
    : `Trial cancelled. No charge. Access until ${fmt(endsAt)}, ${afterEnd(
        freePlan,
        endsAt,
        freePlanEndsAt
      )}.`;
