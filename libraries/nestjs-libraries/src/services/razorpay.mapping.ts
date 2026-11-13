/**
 * Pure mapping helpers for Razorpay plan and subscription entities.
 *
 * Deliberately free of NestJS and Prisma imports so it can be reasoned about --
 * and tested -- without standing up the DI graph.
 */
import { createHash } from 'crypto';
import {
  CURRENCY_MINOR_MULTIPLIER,
  getCurrencyConfig,
} from '../database/prisma/subscriptions/pricing';
import { TRIAL_MIN_LEAD_MS } from '../database/prisma/subscriptions/trial.policy';
import {
  DUNNING_STATES,
  normaliseCurrencyCode,
  SUBSCRIPTION_CURRENCY,
} from './billing.currency';

/** Razorpay subscription states in which the customer is currently paying. */
export const LIVE_STATES = [
  'active',
  'authenticated',
  'pending',
  'halted',
  'created',
];

/**
 * Live states in which the customer has approved the mandate. `created` is a
 * checkout nobody completed: it cannot charge, so it never stands for the
 * workspace's plan.
 */
export const AUTHORISED_STATES = LIVE_STATES.filter((s) => s !== 'created');

/** States from which a subscription will never bill again. */
export const TERMINAL_STATES = ['cancelled', 'completed', 'expired'];

/**
 * States in which Razorpay can still take money.
 *
 * `halted` is left out: Razorpay has given up retrying and attempts no further
 * auto-charge, so it cannot debit on its own. `created` was never approved.
 */
export const CHARGEABLE_STATES = ['active', 'authenticated', 'pending'];

/**
 * Was this subscription opened by Hookpost's checkout for this workspace?
 *
 * The Razorpay account and its customers are shared with other products, and
 * one customer (one email) can own several workspaces, so neither the account
 * nor customer_id says whose subscription it is. notes.service and
 * notes.orgId are stamped by our own checkout and say exactly that.
 */
export function isOrgSubscription(
  subscription: any,
  organizationId: string
): boolean {
  return (
    !!organizationId &&
    subscription?.notes?.service === 'hookpost' &&
    subscription?.notes?.orgId === organizationId
  );
}

/**
 * Where a replacement mandate's paid time ends, in unix seconds, or 0.
 *
 * Reactivate and Change payment method (startReplacementMandate) open a new
 * subscription tagged notes.replaces, whose first charge (start_at) is set to
 * where the plan it replaces was paid until. Until that charge it is
 * `authenticated` with no current_end, which looks exactly like a trial, but
 * the time up to start_at has been paid for on the old plan. Once it has
 * charged, current_end governs and this returns 0. A trial (no
 * notes.replaces) also returns 0: nothing was paid for. So does a mandate
 * that replaced a trial (notes.trial): its start_at is the trial's end.
 *
 * Reads no clock; callers decide whether the date is still ahead.
 */
export function replacementPaidUntil(subscription: any): number {
  if (
    !subscription?.notes?.replaces ||
    subscription.notes.trial === '1' ||
    subscription.current_end
  ) {
    return 0;
  }
  return Number(subscription.start_at || subscription.charge_at || 0);
}

/**
 * Has Razorpay started a billing cycle on this subscription that was never
 * paid? A renewal that failed (pending, halted, or cancelled from there)
 * already has current_start and current_end on the new cycle, though nothing
 * was paid for it.
 *
 * Razorpay books a cycle off remaining_count when it starts (when the
 * subscription is created, for one charged on approval) and paid_count counts
 * the cycles paid, so more cycles booked than paid means the current one is
 * unpaid. Live on 20 Oct 2026: sub_TYd1D4gZnW0EP2, halted on its second
 * cycle (12 Oct - 12 Nov), had total_count 120, remaining_count 118 and
 * paid_count 1; the active sub_TXvoILk8Rch2Wo had 120, 118 and 2.
 *
 * `active` is paid up by definition. A payload without all three counts says
 * nothing, and is never read as unpaid.
 */
export function currentCycleUnpaid(subscription: any): boolean {
  if (!subscription || subscription.status === 'active') return false;
  const { total_count, remaining_count, paid_count } = subscription;
  if ([total_count, remaining_count, paid_count].some((n) => n == null)) {
    return false;
  }
  const booked = Number(total_count) - Number(remaining_count);
  return Number.isFinite(booked) && booked > Number(paid_count);
}

/**
 * Where the time paid for on a subscription ends, in unix seconds, or 0 when
 * no billing cycle is on it: current_end, except when the current cycle was
 * never paid (currentCycleUnpaid), where the paid time stopped at the start
 * of that cycle. Reads no clock.
 */
export function paidThrough(subscription: any): number {
  if (currentCycleUnpaid(subscription)) {
    return Number(subscription.current_start || 0);
  }
  return Number(subscription?.current_end || 0);
}

/**
 * May the end date saved on a workspace's plan be lifted, because this
 * subscription is paid well past it and renewing? Only ever true for the
 * end set for a renewal that halted and was then paid
 * (scheduleHaltedRenewalEnd), never for a cancellation the customer made:
 * Razorpay says `active`, nothing is scheduled to end it, and the time paid
 * for runs more than a day past the saved date. A cycle-end cancel is saved
 * as current_end itself, so it never qualifies, even when Razorpay's end_at
 * does not show the cancel; a renewal paid after a halt runs to the end of a
 * cycle weeks past the grace. Reads no clock.
 */
export function paidPastSavedEnd(
  subscription: any,
  savedEnd: Date | string | null | undefined
): boolean {
  if (!savedEnd || subscription?.status !== 'active') return false;
  if (scheduledCancelAt(subscription)) return false;
  const saved = new Date(savedEnd).getTime();
  return (
    Number.isFinite(saved) && paidThrough(subscription) * 1000 > saved + 86400_000
  );
}

/**
 * Is this subscription a free trial: approved, first charge still ahead, and
 * nothing paid for yet?
 *
 * `authenticated` alone does not say so. A Reactivate or Change payment
 * method mandate (notes.replaces) is `authenticated` until its first charge
 * too, but runs on time paid for on the plan it replaced. One opened during
 * a trial is stamped notes.trial, and is still the trial.
 */
export function isTrialSubscription(subscription: any): boolean {
  return (
    subscription?.status === 'authenticated' &&
    (!subscription.notes?.replaces || subscription.notes?.trial === '1') &&
    // A checkout that charges at once has no start_at. It is `authenticated`
    // only until its first debit lands: a moment on a card or UPI, but a day
    // or more on a bank e-mandate, where Razorpay registers the mandate first
    // and debits it on a later banking day. That customer is paying now, not
    // trialling. A switch during a trial keeps notes.trial.
    (subscription.notes?.trial === '1' || startsLater(subscription))
  );
}

/**
 * Was this subscription opened to take its first payment later (a trial, a
 * free-months coupon): a start_at more than TRIAL_MIN_LEAD_MS after it was
 * created? A payload without created_at is judged on start_at alone.
 */
export function startsLater(subscription: any): boolean {
  const startAt = Number(subscription?.start_at || 0);
  if (!startAt) return false;
  const createdAt = Number(subscription?.created_at || 0);
  return !createdAt || (startAt - createdAt) * 1000 > TRIAL_MIN_LEAD_MS;
}

/** trial.policy.ts TRIAL_MIN_LEAD_MS: a first charge closer than this is no trial. */
export { TRIAL_MIN_LEAD_MS };

/**
 * When Razorpay takes the first payment, in unix seconds, or 0: start_at for
 * a subscription created with a trial or a coupon delay, else charge_at.
 */
export function firstChargeAtSeconds(subscription: any): number {
  return Number(subscription?.start_at || subscription?.charge_at || 0);
}

/**
 * Did authorising this subscription start a new free trial? A trial opened by
 * Hookpost's own checkout, not a replacement mandate: a Reactivate or Change
 * payment method mandate, or a plan switch during a trial (notes.replaces),
 * continues a trial or plan that already started. This is what StartTrial
 * counts, once per subscription.
 *
 * `authenticated` is not enough on its own: a checkout that charges at once
 * (no trial: a workspace whose trial is used, or RAZORPAY_TRIAL_DAYS=0) is
 * `authenticated` too until it activates, and counting it would report a
 * paying customer as a trial start. So nothing may have been paid
 * (paid_count 0) and the first charge must be more than TRIAL_MIN_LEAD_MS
 * after `now`. A payload without paid_count is not read as unpaid.
 */
export function startsNewTrial(
  subscription: any,
  now: number = Date.now()
): boolean {
  if (
    subscription?.notes?.service !== 'hookpost' ||
    !isTrialSubscription(subscription) ||
    subscription.notes?.replaces
  ) {
    return false;
  }
  const paid = subscription.paid_count;
  if (paid === undefined || paid === null || Number(paid) !== 0) return false;
  return firstChargeAtSeconds(subscription) * 1000 - now > TRIAL_MIN_LEAD_MS;
}

/**
 * A trial subscription that has never taken a payment: Razorpay says
 * paid_count 0, and it is not a mandate that continues paid time (a
 * Reactivate or Change payment method mandate, notes.replaces without
 * notes.trial). Once its first charge is attempted Razorpay can set a
 * current_end on it although nothing was paid, so that is not paid time.
 *
 * paid_count must be present: a payload without it says nothing, and is
 * never read as unpaid.
 */
export function isUnpaidTrial(subscription: any): boolean {
  if (
    subscription?.paid_count === undefined ||
    subscription?.paid_count === null ||
    Number(subscription.paid_count) !== 0
  ) {
    return false;
  }
  return !subscription.notes?.replaces || subscription.notes?.trial === '1';
}

/**
 * Until when a trial that has been cancelled keeps its access, in unix
 * seconds: its start_at, the date its first charge was due. 0 when this is
 * not a trial with nothing paid on it. Reads no clock; callers check that the
 * date is still ahead.
 *
 * Razorpay refuses a cycle-end cancel on a trial ("no billing cycle is going
 * on"), so a trial is always cancelled at once, and the customer would lose
 * the days they were promised. The workspace keeps the trial until start_at
 * instead, with no charge.
 *
 * Only a trial whose first charge has not been attempted: still
 * `authenticated`, or `cancelled` from there, with no billing cycle started
 * (no current_start or current_end) and nothing paid (paid_count 0, or
 * absent, which with no cycle started means the same). Once Razorpay has
 * tried the first debit (pending, halted, or a cycle on the payload), the
 * trial is over and ends now, as before; start_at is in the past then
 * anyway. A Reactivate or Change payment method mandate of a paid plan
 * (notes.replaces without notes.trial) is not a trial; replacementPaidUntil
 * covers it. A plan switch during a trial (notes.trial) still is.
 */
export function trialAccessUntil(subscription: any): number {
  if (!subscription) return 0;
  if (subscription.notes?.replaces && subscription.notes?.trial !== '1') {
    return 0;
  }
  if (!['authenticated', 'cancelled'].includes(subscription.status)) return 0;
  if (subscription.current_start || subscription.current_end) return 0;
  const paidCount = subscription.paid_count;
  if (
    paidCount !== undefined &&
    paidCount !== null &&
    Number(paidCount) !== 0
  ) {
    return 0;
  }
  return Number(subscription.start_at || 0);
}

/**
 * subscription.halted for a Hookpost trial whose first charge never went
 * through: Razorpay retried the day-7 debit and gave up. A halted renewal of
 * a plan that has been paid for is not this.
 */
export function isHaltedUnpaidTrial(subscription: any): boolean {
  return (
    subscription?.status === 'halted' &&
    subscription?.notes?.service === 'hookpost' &&
    isUnpaidTrial(subscription)
  );
}

/**
 * Is `candidate` older than `keep`, by Razorpay's created_at? A replacement is
 * always newer than what it replaces, so only older subscriptions are ever
 * retired in favour of `keep`. When either side has no created_at there is
 * nothing to compare, and the candidate counts as older.
 */
export function isOlderThan(candidate: any, keep: any): boolean {
  const keepAt = Number(keep?.created_at || 0);
  if (!keepAt) return true;
  return Number(candidate?.created_at || 0) <= keepAt;
}

/**
 * Work out whether a subscription is actually scheduled to stop, in unix
 * seconds, or null if it will keep renewing.
 *
 * This is NOT simply Razorpay's `end_at`. Unlike Stripe's `cancel_at`, which is
 * null unless a cancellation is pending, Razorpay always populates `end_at` with
 * the point at which all `total_count` cycles complete -- roughly ten years out
 * for a monthly plan. Persisting that verbatim would make every healthy
 * subscriber appear to be cancelling a decade from now.
 *
 * A stop is genuinely scheduled when either:
 *   - the subscription has already terminated (`ended_at` is set), or
 *   - it will not renew past the current cycle, i.e. `end_at` is at or before
 *     `current_end` -- which is what cancel_at_cycle_end=1 produces.
 *
 * Reads no clock, so it is deterministic and safe to unit test.
 */
export function scheduledCancelAt(subscription: any): number | null {
  if (subscription?.ended_at) return subscription.ended_at;

  const endAt = subscription?.end_at;
  const currentEnd = subscription?.current_end;
  if (!endAt) return null;
  if (currentEnd && endAt <= currentEnd) return endAt;
  if (TERMINAL_STATES.includes(subscription?.status)) return endAt;

  return null;
}

/**
 * Does the subscription itself prove it will take no further payment?
 *
 * Razorpay's cancel API accepts cancel_at_cycle_end=1, but nothing on the
 * subscription records that it was accepted: the status stays `active`,
 * `end_at` keeps the far-future point where all total_count cycles complete,
 * `charge_at` keeps the next renewal date, and `has_scheduled_changes` /
 * `change_scheduled_at` describe a pending *update* (the Update API's
 * schedule_change_at), never a pending cancel. Razorpay's own docs say the
 * status "changes to cancelled only at the end of the current billing cycle",
 * so until that moment the entity is indistinguishable from one that will
 * renew. Verified live on 29 Oct 2026 on sub_TXvoILk8Rch2Wo, where a
 * cycle-end cancel posted the day before left status=active, charge_at on the
 * renewal date and end_at ten years out.
 *
 * So this is only ever true once Razorpay has really stopped it
 * (scheduledCancelAt), and a cycle-end cancel is never taken on trust. Reads
 * no clock.
 */
export function cancelProvenAtRazorpay(subscription: any): boolean {
  return scheduledCancelAt(subscription) !== null;
}

/**
 * When Razorpay would next debit this subscription, in unix seconds, or 0.
 */
export function chargeAtSeconds(subscription: any): number {
  return Number(subscription?.charge_at || 0);
}

/**
 * Can Razorpay still take money off this subscription?
 *
 * A chargeable status, nothing on it proving it will stop
 * (cancelProvenAtRazorpay), and a debit still to come: `charge_at` at or
 * ahead of `nowSec`, or `pending`, where a failed charge is being retried now
 * and the date may already have passed.
 *
 * The second the charge is due counts as still to come. That second is the
 * whole point: in the 11 Nov incident `charge_at` and the saved end fell on
 * the same instant, so a sweep landing exactly on it must not decide the
 * money has already moved.
 */
export function canStillCharge(subscription: any, nowSec: number): boolean {
  if (!subscription || !CHARGEABLE_STATES.includes(subscription.status)) {
    return false;
  }
  if (cancelProvenAtRazorpay(subscription)) return false;
  return (
    chargeAtSeconds(subscription) >= nowSec || subscription.status === 'pending'
  );
}

/** How close a charge has to be before the guard cancels at Razorpay. */
export const PRE_CHARGE_GUARD_MS = 48 * 3600 * 1000;

/**
 * Is Razorpay about to debit this subscription, within PRE_CHARGE_GUARD_MS?
 *
 * `pending` counts whatever `charge_at` says: a failed charge is being
 * retried now, and the date it was due may already have passed.
 */
export function chargeIsNear(subscription: any, nowSec: number): boolean {
  if (subscription?.status === 'pending') return true;
  const chargeAt = chargeAtSeconds(subscription) * 1000;
  return !!chargeAt && chargeAt - nowSec * 1000 <= PRE_CHARGE_GUARD_MS;
}

/**
 * What the pre-charge guard should do about one workspace whose plan the
 * database says is ending, in unix-second terms.
 *
 * `cancel` means: cancel at Razorpay now (cancel_at_cycle_end 0). The
 * workspace keeps the paid access its row already grants until `cancelAt`,
 * because the row -- not Razorpay -- is what gives access.
 *
 * Only two cases ever act, both of which mean money is about to move for time
 * the customer will not get:
 *   - the saved end has passed, so the plan is already over here, and
 *   - the next debit is within PRE_CHARGE_GUARD_MS, which covers the race the
 *     11 Nov incident turned on: charge_at and cancelAt fall on the same
 *     instant, and the hourly sweep that ends the plan can only run at or
 *     after it.
 *
 * Anything further out is left alone and looked at again next hour, so a
 * customer whose plan still has weeks to run is never touched.
 *
 * `recheck` means: the row and the subscription disagree about whether the
 * time ahead is paid for, and only the refunds can settle it, so the caller
 * must look before anything happens.
 *
 * A subscription whose current cycle was never paid (currentCycleUnpaid: a
 * renewal that failed and is being retried, or that halted and had its end
 * set by scheduleHaltedRenewalEnd) is never cancelled either. Its saved end
 * is that date, not a cancellation, and the charge the guard would stop is
 * the customer paying what they already owe -- cancelling it would take their
 * plan away for trying to pay.
 *
 * Reads no clock: the caller passes `nowSec`.
 */
export function preChargeVerdict(input: {
  subscription: any;
  cancelAt: Date | string;
  nowSec: number;
}): { cancel: boolean; reason: string; recheck?: boolean } {
  const { subscription, cancelAt, nowSec } = input;
  if (!canStillCharge(subscription, nowSec)) {
    return { cancel: false, reason: 'Razorpay cannot charge it' };
  }
  if (currentCycleUnpaid(subscription)) {
    return {
      cancel: false,
      reason: 'the current cycle is unpaid, so a charge would settle it',
    };
  }
  const endsAt = new Date(cancelAt).getTime();
  if (!Number.isFinite(endsAt)) {
    return { cancel: false, reason: 'no readable end date' };
  }
  // The subscription is paid well past the date the row ends on, so the two
  // cannot both be right and the row is the one in doubt. The hourly sweep
  // reads this the same way and lifts the end date (paidPastSavedEnd): a
  // renewal that halted, had its end set, and was then paid after all. The
  // guard must not cancel the mandate of a customer the sweep is about to
  // carry on. The one reading where the row is right is a refunded charge,
  // which only the refunds can tell, so the caller is asked to look.
  if (paidPastSavedEnd(subscription, cancelAt)) {
    return {
      cancel: false,
      recheck: true,
      reason: 'it is paid past the end saved here',
    };
  }
  if (endsAt <= nowSec * 1000) {
    return {
      cancel: true,
      reason: 'the plan ended here but Razorpay could still charge',
    };
  }
  if (chargeIsNear(subscription, nowSec)) {
    return {
      cancel: true,
      reason: 'the next charge is due within 48 hours and the plan is ending',
    };
  }
  return { cancel: false, reason: 'the next charge is more than 48 hours away' };
}

/**
 * A new subscription is `authenticated` or `active` at Razorpay before our
 * webhook has written its plan row, so one that has only just been approved
 * is not yet a workspace paying for nothing. Anything older than this with no
 * row behind it is worth the owner's attention.
 */
export const MISMATCH_SETTLE_MS = 6 * 3600 * 1000;

/**
 * How long a subscription may stay `created` after Checkout before its first
 * debit counts as never coming. A bank e-mandate is registered at Checkout
 * and debited a banking day later (earlier or later around bank holidays,
 * and the bank can take 1-2 days to answer); a debit that fails leaves the
 * subscription `created`, with no webhook at all.
 */
export const UNPAID_MANDATE_SETTLE_MS = 7 * 86400 * 1000;

/**
 * Did this subscription's first payment never land, and never will without
 * the customer: still `created`, nothing paid, not a replacement mandate,
 * and older than UNPAID_MANDATE_SETTLE_MS. A workspace's plan on one was
 * granted at Checkout (/razorpay/verify) for a debit that then failed.
 * Reads no clock: the caller passes `nowSec`.
 */
export function firstChargeNeverLanded(subscription: any, nowSec: number): boolean {
  if (subscription?.status !== 'created' || subscription.notes?.replaces) return false;
  if (Number(subscription.paid_count || 0) !== 0) return false;
  // A first charge still ahead (a trial, a free-months coupon) has not failed.
  if (Number(subscription.start_at || 0) > nowSec) return false;
  const createdAt = Number(subscription.created_at || 0);
  return createdAt > 0 && (nowSec - createdAt) * 1000 > UNPAID_MANDATE_SETTLE_MS;
}

/**
 * How long after Razorpay ended a subscription (`ended_at`) its own
 * subscription.cancelled / .completed / .expired webhook is given to arrive
 * before the guard handles it in its place. Razorpay delivers in seconds and
 * retries for 24 hours; an hour keeps the guard off a webhook in flight and
 * off a Cancel press that is still saving its end date.
 */
export const MISSED_WEBHOOK_SETTLE_MS = 3600 * 1000;

export type MissedEndEvent =
  | 'subscription.cancelled'
  | 'subscription.completed'
  | 'subscription.expired'
  | 'subscription.halted';

/**
 * The webhook a plan row with no end date has missed, or null: its own
 * subscription is cancelled, completed or expired at Razorpay (ended more
 * than MISSED_WEBHOOK_SETTLE_MS ago), or halted. Each of those webhooks ends
 * the plan or sets its end date, so a row still without one never got it.
 * Halted has no timestamp; its handler is safe to run beside a late webhook.
 * An ended one without `ended_at` cannot be timed, so it is never handled
 * here (it stays in the mismatch report). The caller has checked the
 * subscription is this workspace's own and the row's identifier. Reads no
 * clock: the caller passes `nowSec`.
 */
export function missedEndEvent(
  subscription: any,
  nowSec: number
): MissedEndEvent | null {
  const status = String(subscription?.status || '');
  if (status === 'halted') return 'subscription.halted';
  if (!TERMINAL_STATES.includes(status)) return null;
  const endedAt = Number(subscription?.ended_at || 0);
  if (!endedAt || (nowSec - endedAt) * 1000 < MISSED_WEBHOOK_SETTLE_MS) {
    return null;
  }
  return `subscription.${status}` as MissedEndEvent;
}

/**
 * The two ways the database and Razorpay can disagree that the guard only
 * reports, never acts on, because acting on either could take a plan from
 * someone who is paying for it:
 *
 *   - `charging_without_plan`: Razorpay can still charge (canStillCharge) and
 *     no live plan row stands behind it. Usually a plan Hookpost ended, or a
 *     webhook that never landed. Never cancelled automatically: a checkout
 *     finished seconds ago looks exactly like this until its webhook arrives,
 *     and cancelling it would end a plan the customer just paid for. Only
 *     counted once the subscription is older than MISMATCH_SETTLE_MS.
 *   - `plan_without_subscription`: the workspace holds a plan with no end
 *     date while Razorpay has already finished with the subscription, so
 *     nothing will renew it. Reported only when the guard could not handle
 *     it as a missed webhook (missedEndEvent) in the same run: the
 *     subscription could not be read on its own, say.
 *
 * `null` when the two agree. Reads no clock: the caller passes `nowSec`.
 */
export function planMismatch(input: {
  subscription: any;
  /** The workspace's live plan row for this subscription, or null. */
  row: { cancelAt?: Date | string | null } | null;
  nowSec: number;
}): 'charging_without_plan' | 'plan_without_subscription' | null {
  const { subscription, row, nowSec } = input;
  if (!subscription) return null;

  if (!row) {
    if (!canStillCharge(subscription, nowSec)) return null;
    const age = nowSec * 1000 - Number(subscription.created_at || 0) * 1000;
    return age > MISMATCH_SETTLE_MS ? 'charging_without_plan' : null;
  }

  if (!row.cancelAt && TERMINAL_STATES.includes(subscription.status)) {
    return 'plan_without_subscription';
  }
  return null;
}

/**
 * Build the stable identity we stamp onto a Razorpay plan's notes.
 *
 * The amount and currency are part of the key on purpose: Razorpay plans are
 * immutable, so a price change must provision a NEW plan rather than silently
 * reprice existing subscribers. Including the amount makes that automatic.
 */
export function buildPlanKey(
  billing: string,
  period: string,
  amountMinor: number,
  currency: string
): string {
  return `${billing}|${period}|${amountMinor}|${currency}`;
}

/**
 * Parse a plan key back into its tier and period.
 *
 * This is how webhook reconciliation learns which tier a subscription is really
 * on. It must be preferred over the subscription's own `notes`: on an upgrade we
 * change the subscription's plan_id, but Razorpay keeps the original notes, so
 * trusting notes would under-entitle a customer who just paid for a higher tier.
 *
 * Returns null for anything unparseable rather than guessing.
 */
export function parsePlanKey(
  key: string | undefined | null
): { billing: string; period: string } | null {
  if (!key) return null;
  const parts = String(key).split('|');
  if (parts.length < 2) return null;
  const [billing, period] = parts;
  if (!billing || !period) return null;
  return { billing: billing.toUpperCase(), period: period.toUpperCase() };
}

/** What a workspace's Razorpay plan charges, each period it renews. */
export interface ChargedPlanTerms {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  currency: string;
  /** Major units (rupees, not paise); null when the plan has no readable amount. */
  amount: number | null;
}

/**
 * The tier, period, currency and amount of the plan a subscription is on.
 *
 * Razorpay plans are immutable and a UPI mandate can't be moved to another
 * price, so this is what the subscriber signed up at, whatever pricing.ts says
 * today. The Change payment method / Reactivate quote states these terms and
 * the billing page's current plan card shows them, so both read them here.
 *
 * The plan decides; the stored row only fills in what the plan doesn't say.
 * `tier` is resolveTierFromPlan's answer for the plan (null for one Hookpost
 * didn't create), and `plan` is null when it could not be read.
 */
export function chargedPlanTerms(input: {
  plan: any;
  tier: { billing: string; period: string } | null;
  row: { subscriptionTier?: string | null; period?: string | null } | null;
  subscriptionNotes?: any;
}): ChargedPlanTerms {
  const { plan, tier, row, subscriptionNotes } = input;
  const billing = String(tier?.billing || row?.subscriptionTier || '');
  const period = (tier?.period || row?.period || 'MONTHLY') as
    | 'MONTHLY'
    | 'YEARLY';
  const currency = (
    normaliseCurrencyCode(plan?.item?.currency) ||
    normaliseCurrencyCode(subscriptionNotes?.currency) ||
    SUBSCRIPTION_CURRENCY
  ).toUpperCase();
  const mult =
    getCurrencyConfig(currency).minorMultiplier || CURRENCY_MINOR_MULTIPLIER;
  const minor = Number(plan?.item?.amount);
  return {
    billing,
    period,
    currency,
    amount: Number.isFinite(minor) && minor > 0 ? minor / mult : null,
  };
}

// -----------------------------------------------------------------------------
// Plan changes (owner's policy, 29 Oct 2026)
// -----------------------------------------------------------------------------

/**
 * An upgrade takes effect at once and the unused days of the cycle already
 * paid for are credited against the new plan; a downgrade takes effect at the
 * next billing cycle. These are the sums behind both. They read no clock and
 * touch no network, so every boundary below is a plain unit test
 * (razorpay.plan-change.spec.ts).
 */

/** One billing cycle, in seconds. Razorpay's monthly plans bill every 30 days. */
const MONTH_SECONDS = 30 * 86400;
const YEAR_SECONDS = 365 * 86400;

/**
 * How long the plan's cycle is, in seconds. Only the two periods Hookpost
 * sells exist; anything else is read as monthly, the shorter and so the
 * safer of the two to price a credit against.
 */
export function cycleSecondsFor(period: string | null | undefined): number {
  return String(period || '').toUpperCase() === 'YEARLY'
    ? YEAR_SECONDS
    : MONTH_SECONDS;
}

/**
 * The tiers in price order. TEAM and ULTIMATE are no longer sold
 * (PURCHASABLE_TIERS) but there are live rows on both, and they must rank
 * where their price puts them so an existing TEAM customer moving to PRO is
 * an upgrade.
 */
const TIER_RANK: Record<string, number> = {
  FREE: 0,
  STANDARD: 1,
  TEAM: 2,
  PRO: 3,
  ULTIMATE: 4,
};

export interface PlanIdentity {
  billing: string;
  period: string;
}

export type PlanChangeDirection = 'upgrade' | 'downgrade' | 'same';

/**
 * Is moving from one plan to another an upgrade or a downgrade?
 *
 * The tier decides first, then the period: a higher tier is an upgrade
 * however the period moves (Standard yearly -> Pro monthly is more product,
 * so it starts now), and on the same tier monthly -> yearly is the upgrade.
 * This is the comparison every large subscription business makes, and the
 * one the pricing page, the billing page and the emails all state.
 *
 * A tier this function does not know - a plan from another product on the
 * shared Razorpay account - is never called an upgrade, so it can never
 * charge anyone: it reads as no change at all.
 */
export function planChangeDirection(
  from: PlanIdentity,
  to: PlanIdentity
): PlanChangeDirection {
  const fromRank = TIER_RANK[String(from?.billing || '').toUpperCase()];
  const toRank = TIER_RANK[String(to?.billing || '').toUpperCase()];
  if (fromRank === undefined || toRank === undefined) return 'same';
  if (toRank !== fromRank) return toRank > fromRank ? 'upgrade' : 'downgrade';

  const fromYearly = String(from?.period || '').toUpperCase() === 'YEARLY';
  const toYearly = String(to?.period || '').toUpperCase() === 'YEARLY';
  if (fromYearly === toYearly) return 'same';
  return toYearly ? 'upgrade' : 'downgrade';
}

/** What a workspace actually paid for the billing cycle it is in. */
export interface PaidCycle {
  /** Minor units (paise, cents) taken for this cycle. Never the list price. */
  paidMinor: number;
  /** Unix seconds. */
  cycleStart: number;
  /** Unix seconds. */
  cycleEnd: number;
}

/**
 * The unused share of what was paid for the cycle in progress, in minor
 * units.
 *
 * Priced on what was actually taken, never on pricing.ts: a first-month
 * offer or a coupon means the customer paid less than the list price, and
 * crediting the list price would hand them money they never spent.
 *
 * Rounded down to a whole paise, and clamped to [0, paidMinor], so a credit
 * is never negative, never invented and never larger than the payment it
 * comes from - whatever the clock, the cycle dates or a Razorpay field say.
 */
export function unusedCreditMinor(cycle: PaidCycle, nowSec: number): number {
  const paid = Number(cycle?.paidMinor);
  const start = Number(cycle?.cycleStart);
  const end = Number(cycle?.cycleEnd);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;

  const length = end - start;
  if (length <= 0) return 0;

  const remaining = Math.min(Math.max(end - Number(nowSec), 0), length);
  return Math.min(paid, Math.floor((paid * remaining) / length));
}

/**
 * How much of the new plan a credit buys, in seconds.
 *
 * The credit is not refunded and is not handed over as a discount Razorpay
 * cannot apply to a UPI mandate: it is converted into time on the new plan at
 * that plan's own rate. A rupee of Standard buys more seconds of Standard
 * yearly than of Pro monthly, which is exactly right - the customer gets the
 * value they paid for and not a day more.
 */
export function creditCoveredSeconds(
  creditMinor: number,
  newAmountMinor: number,
  newCycleSeconds: number
): number {
  const credit = Number(creditMinor);
  const amount = Number(newAmountMinor);
  const cycle = Number(newCycleSeconds);
  if (!Number.isFinite(credit) || credit <= 0) return 0;
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  if (!Number.isFinite(cycle) || cycle <= 0) return 0;
  return Math.floor((credit * cycle) / amount);
}

/**
 * A credit worth less than this buys no time worth deferring a charge for:
 * the new plan simply starts now at its full price. It also keeps start_at
 * clear of the moment Razorpay reads the request ("start_at cannot be lesser
 * than the current time").
 */
export const MIN_CREDIT_LEAD_SECONDS = 3600;

export interface NewMandateUpgradeInput {
  nowSec: number;
  cycle: PaidCycle;
  /** The new plan's price in minor units. */
  newAmountMinor: number;
  newPeriod: string;
  /** A refunded cycle has no unused days to credit: the money went back. */
  refunded?: boolean;
}

export interface NewMandateUpgradeTerms {
  /**
   * Unix seconds for the new subscription's start_at, or null to let it
   * start on approval. A future start_at with no upfront addon makes the
   * authentication transaction the Rs 5 mandate check Razorpay refunds, so
   * nothing is charged today.
   */
  startAt: number | null;
  /** The unused value carried over, in minor units. */
  creditMinor: number;
  /** What that credit buys on the new plan, in seconds. */
  coveredSeconds: number;
  /** What the authentication transaction takes, in minor units. */
  chargeNowMinor: number;
}

/**
 * The terms of an upgrade Razorpay cannot make in place.
 *
 * A UPI Autopay or e-mandate cannot be re-planned ("subscriptions cannot be
 * updated when payment mode is upi"), and every payment this account has
 * taken so far was UPI, so the upgrade has to open a new mandate. Until now
 * that mandate charged the full price of the new plan on approval and the
 * plan it replaced was cancelled with no credit for its unused days: a
 * customer upgrading on day 2 of a month paid for 28 days twice.
 *
 * Instead the unused days are converted into time on the new plan (start_at)
 * rather than money:
 *
 *   - the customer is on the new tier the moment the mandate is approved;
 *   - nothing is charged today (future start_at, no upfront addon: Razorpay
 *     takes the Rs 5 mandate check and refunds it);
 *   - the new plan's first full charge lands when the credit runs out;
 *   - the old subscription is cancelled at once, with no further charge.
 *
 * Nothing is refunded and no free days are given: the money already paid is
 * worth exactly as many seconds of the new plan as its price buys. The same
 * sum works for every pair of periods, including monthly -> yearly and a
 * yearly cycle carried onto a monthly plan, because both sides are reduced
 * to a rate.
 *
 * A card mandate does not come through here: Razorpay prorates that one
 * itself (PATCH schedule_change_at 'now'), charging the difference and
 * keeping the renewal date. Both routes honour the same promise - the unused
 * days are credited, never lost - but only the card route can keep the
 * original renewal date, because only Razorpay can re-plan a live mandate.
 */
export function newMandateUpgradeTerms(
  input: NewMandateUpgradeInput
): NewMandateUpgradeTerms {
  const amount = Math.max(0, Math.floor(Number(input.newAmountMinor) || 0));
  const creditMinor = input.refunded
    ? 0
    : unusedCreditMinor(input.cycle, input.nowSec);
  const coveredSeconds = creditCoveredSeconds(
    creditMinor,
    amount,
    cycleSecondsFor(input.newPeriod)
  );

  if (coveredSeconds < MIN_CREDIT_LEAD_SECONDS) {
    return { startAt: null, creditMinor, coveredSeconds, chargeNowMinor: amount };
  }

  return {
    startAt: Math.floor(input.nowSec) + coveredSeconds,
    creditMinor,
    coveredSeconds,
    chargeNowMinor: 0,
  };
}

export interface PlanChangeRefusalInput {
  direction: PlanChangeDirection;
  /** The Razorpay subscription's status. */
  status: string | null | undefined;
  /** The current plan is billed in another currency than the new one. */
  crossCurrency: boolean;
  isLifetime: boolean;
}

/**
 * Why a plan change must not go ahead, or null when it may.
 *
 * Kept out of the Razorpay calls so each refusal is a unit test rather than
 * an integration one, and so the preview (POST /billing/prorate) and the
 * change itself (POST /billing/subscribe) can never disagree about it.
 */
export function planChangeRefusal(
  input: PlanChangeRefusalInput
): { code: string; message: string } | null {
  if (input.isLifetime) {
    return {
      code: 'PLAN_CHANGE_LIFETIME',
      message:
        'This is a lifetime plan. Email support@hookstep.in to change what it includes.',
    };
  }

  // A renewal Razorpay is still retrying (pending) or has given up on
  // (halted). Changing the plan here would open a second mandate beside a
  // charge that can still land, and would let an unpaid cycle buy a credit
  // on the new plan. Settle the charge first.
  if (DUNNING_STATES.includes(String(input.status || ''))) {
    return {
      code: 'PLAN_CHANGE_DUNNING',
      message:
        "There's a payment on this plan that hasn't gone through. Pay it first, then you can change plan.",
    };
  }

  // Credits do not cross currencies: the unused days of a rupee plan are not
  // worth a fixed number of dollars, and converting them would put Hookpost
  // on the wrong side of the rate either way. A currency change is a fresh
  // subscription, bought when the current one ends.
  if (input.crossCurrency) {
    return {
      code: 'PLAN_CHANGE_CURRENCY',
      message:
        'This plan is billed in a different currency. Cancel it and subscribe again in the new one when it ends, so nothing is charged twice.',
    };
  }

  return null;
}

/**
 * The plan a workspace keeps until a scheduled downgrade lands, or null.
 *
 * A downgrade takes effect at the next billing cycle: the customer approves
 * the mandate today, but its first charge is on the date the cycle they paid
 * for runs out (start_at), and until then they keep the plan they paid for.
 * Reading the tier off this subscription's own plan would drop them to the
 * cheaper one the moment they approved it, so the mandate carries the plan
 * it is leaving (notes.from_billing) and that is what the workspace runs on
 * until the charge lands.
 *
 * Null once the subscription has a cycle of its own (the downgrade has
 * happened), and for every mandate that is not a scheduled downgrade.
 */
export function pendingDowngradeTier(
  subscription: any,
  nowMs: number = Date.now()
): { billing: string; period: string } | null {
  if (subscription?.notes?.change !== 'downgrade') return null;
  if (subscription.status !== 'authenticated') return null;
  if (subscription.current_start || subscription.current_end) return null;
  const at = Number(subscription.start_at || 0);
  if (!at || at * 1000 <= nowMs) return null;
  const billing = String(subscription.notes.from_billing || '').toUpperCase();
  const period = String(subscription.notes.from_period || '').toUpperCase();
  if (!isSellableTier(billing) || !isPeriod(period)) return null;
  return { billing, period };
}

/**
 * The plan change a card mandate is holding for the end of its cycle, or
 * null, for the billing page's "Changes to <plan> on <date>" line.
 *
 * Only an international card mandate can carry one: Razorpay re-plans it in
 * place (PATCH schedule_change_at 'cycle_end') and reports it back as
 * has_scheduled_changes, without saying which plan it is to. The caller
 * (RazorpayService.scheduledChangeFor) reads that plan from
 * retrieve_scheduled_changes into notes.scheduled_*; the PATCH itself can
 * carry no notes. Every other mandate schedules a downgrade as a second
 * subscription instead (pendingDowngradeTier).
 */
export function scheduledPlanChange(
  subscription: any,
  nowMs: number = Date.now()
): { billing: string; period: string; at: Date } | null {
  if (!subscription?.has_scheduled_changes) return null;
  // cancel_at_cycle_end sets has_scheduled_changes too: that is a
  // cancellation, not a plan change, and it has no target plan.
  if (subscription.cancel_at_cycle_end) return null;
  const at = Number(
    subscription.change_scheduled_at || subscription.current_end || 0
  );
  if (!at || at * 1000 <= nowMs) return null;
  const billing = String(subscription.notes?.scheduled_billing || '').toUpperCase();
  const period = String(subscription.notes?.scheduled_period || '').toUpperCase();
  if (!isSellableTier(billing) || !isPeriod(period)) return null;
  return { billing, period, at: new Date(at * 1000) };
}

/**
 * The plan change a subscription is holding for a future date, whichever way
 * Razorpay is carrying it out, for the billing page's "Changes to <plan> on
 * <date>" line and the undo behind it.
 *
 * `how` says what undoing it costs:
 *   - `in_place`: Razorpay re-planned the card mandate at cycle_end and can
 *     drop the pending update on its own
 *     (POST /subscriptions/:id/cancel_scheduled_changes). Nothing is charged
 *     either way.
 *   - `new_mandate`: a second subscription holds the new plan, because a UPI
 *     Autopay or e-mandate cannot be re-planned. Razorpay has no way to turn
 *     that back into the old mandate, so undoing it means approving a mandate
 *     for the plan being kept - which is what Reactivate already does.
 *
 * Reads no clock beyond `nowMs`, so every boundary is a unit test.
 */
export function scheduledChangeOf(
  subscription: any,
  nowMs: number = Date.now()
): {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  at: Date;
  how: 'in_place' | 'new_mandate';
} | null {
  const inPlace = scheduledPlanChange(subscription, nowMs);
  if (inPlace) {
    return {
      ...inPlace,
      period: inPlace.period as 'MONTHLY' | 'YEARLY',
      how: 'in_place',
    };
  }

  // The mandate a downgrade opened: it carries the plan it is leaving in
  // from_* (pendingDowngradeTier) and the plan it is going to in its own
  // notes, and charges for the first time on the date it lands.
  if (!pendingDowngradeTier(subscription, nowMs)) return null;
  const billing = String(subscription.notes?.billing || '').toUpperCase();
  const period = String(subscription.notes?.period || '').toUpperCase();
  if (!isSellableTier(billing) || !isPeriod(period)) return null;
  return {
    billing,
    period: period as 'MONTHLY' | 'YEARLY',
    at: new Date(Number(subscription.start_at) * 1000),
    how: 'new_mandate',
  };
}

/** A tier a subscription can be on. FREE is never one Razorpay bills for. */
function isSellableTier(billing: string): boolean {
  return billing !== 'FREE' && TIER_RANK[billing] !== undefined;
}

function isPeriod(period: string): boolean {
  return period === 'MONTHLY' || period === 'YEARLY';
}

export interface InPlaceChangeInput {
  /** The current plan's amount x quantity, in minor units (Razorpay prices it off the plan). */
  oldAmountMinor: number;
  /** The new plan's amount x quantity, in minor units. */
  newAmountMinor: number;
  /** The current cycle, unix seconds (current_start, current_end). */
  cycleStart: number;
  cycleEnd: number;
  nowSec: number;
  /** Both plans bill on the same interval (monthly -> monthly). */
  sameFrequency: boolean;
}

/**
 * What Razorpay charges (positive) or refunds (negative) when a card mandate
 * is re-planned with schedule_change_at 'now', in minor units: Razorpay's own
 * proration, as documented at
 * https://razorpay.com/docs/payments/subscriptions/update/ ("Proration"):
 *
 *   per-day        = plan amount x quantity / frequency in days
 *   days charged   = plan change day - 1 (the change day itself is not used)
 *   remaining days = frequency in days - days charged
 *   credit         = old per-day x remaining days
 *   new charge     = new per-day x remaining days   (same frequency)
 *                  = the new plan's full amount     (frequency changes; the
 *                    new interval starts on the day of the change)
 *   amount         = new charge - credit
 *
 * The spec reproduces the three worked examples on that page to the rupee,
 * so the figure the billing page shows before an upgrade is the figure
 * Razorpay takes. Only upgrades are made 'now' (downgrades wait for
 * cycle_end), so in practice this is always a charge.
 */
export function inPlaceChangeMinor(input: InPlaceChangeInput): {
  amountMinor: number;
  creditMinor: number;
  remainingDays: number;
} {
  const oldAmount = Math.max(0, Number(input.oldAmountMinor) || 0);
  const newAmount = Math.max(0, Number(input.newAmountMinor) || 0);
  const start = Number(input.cycleStart);
  const end = Number(input.cycleEnd);
  const frequencyDays = Math.round((end - start) / 86400);
  if (!Number.isFinite(frequencyDays) || frequencyDays <= 0) {
    return { amountMinor: newAmount, creditMinor: 0, remainingDays: 0 };
  }
  const changeDay = Math.min(
    Math.max(Math.floor((Number(input.nowSec) - start) / 86400) + 1, 1),
    frequencyDays
  );
  const remainingDays = frequencyDays - (changeDay - 1);
  const creditMinor = Math.round((oldAmount * remainingDays) / frequencyDays);
  const newCharge = input.sameFrequency
    ? Math.round((newAmount * remainingDays) / frequencyDays)
    : newAmount;
  return { amountMinor: newCharge - creditMinor, creditMinor, remainingDays };
}

/**
 * ONCE PER PERSON (29 Oct 2026, the owner's call): the first-month offer, and
 * the trial when it is switched on, go to a person once, however many
 * workspaces or email spellings they use. What stands for a person, besides
 * the owner's emailIdentity and the channels the workspace connects, is the
 * payment method a Razorpay payment was made with. SubscriptionService
 * keeps these as BillingIdentity rows (personHadBefore, recordBillingIdentities).
 *
 * kind WORKSPACE is the workspace itself (its id), so a workspace that has
 * had a plan is on record even with no owner email or method to go by.
 */
export type BillingIdentityKind = 'WORKSPACE' | 'EMAIL' | 'UPI' | 'CARD';

/**
 * What the workspace had: PAID (a charge on a plan), OFFER (the first-month
 * offer's discounted charge), TRIAL (a trial started), or ATTEMPT (a payment
 * that made nothing: its method is the workspace's own, and claims nothing).
 */
export type BillingIdentitySource = 'PAID' | 'OFFER' | 'TRIAL' | 'ATTEMPT';

/** What the first-month offer counts: a person who has paid, or had the offer. */
export const OFFER_ONCE_SOURCES: readonly BillingIdentitySource[] = ['PAID', 'OFFER'];
/**
 * What a trial is given once against (trial.policy.ts "TRIALS BEHIND A
 * SWITCH"): a trial, a paid plan or the first-month offer, here or elsewhere.
 */
export const TRIAL_ONCE_SOURCES: readonly BillingIdentitySource[] = ['PAID', 'OFFER', 'TRIAL'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The stored form of one identity: never the address, VPA or card itself, so
 * a row outlives a deleted account without keeping its details.
 */
export function billingIdentityHash(kind: BillingIdentityKind, value: string): string {
  return sha256(`${kind}:${value}`);
}

/**
 * The ways a Razorpay subscription can be paid (its `payment_method`), from
 * https://razorpay.com/docs/payments/subscriptions/supported-payment-methods/
 * and the Subscriptions FAQ. Anything else Razorpay reports, or nothing yet,
 * is `unknown` and gets the safe path everywhere.
 */
export type MandateMethod = 'card' | 'upi' | 'emandate' | 'unknown';

export function mandateMethod(paymentMethod: unknown): MandateMethod {
  const method = String(paymentMethod || '').trim().toLowerCase();
  if (method === 'card' || method === 'upi') return method;
  // Razorpay has named eNACH both ways.
  if (method === 'emandate' || method === 'nach') return 'emandate';
  return 'unknown';
}

/**
 * What each payment method allows, in one place, so no path assumes card
 * and UPI are the only two (docs/billing-payment-methods.md has the table):
 *
 *   - `replanInPlace`: Razorpay re-plans the mandate it holds (PATCH
 *     plan_id), keeping the cycle. Only an international card: "You can only
 *     update a Subscription authorised using cards and not via UPI and
 *     Emandate", and "for Subscriptions created using domestic cards, you can
 *     update only the offer". Everything else, an unknown method and a card
 *     we could not show to be international included, takes the safe path: a
 *     new mandate, the old one cancelled once it is approved, nothing charged
 *     twice.
 *   - `stopOutside`: how the customer can stop paying without Hookpost, for
 *     the emails. A UPI mandate is revoked or paused in the UPI app, a card's
 *     standing instruction in the bank's card portal; an e-mandate cannot be
 *     touched by the customer at all, only cancelled through their bank, and
 *     the next debit then fails.
 *
 * `internationalCard` is whether the card behind the mandate was issued
 * outside India (payment.international); null or left out when unknown.
 */
export function mandateRules(
  paymentMethod: unknown,
  opts: { internationalCard?: boolean | null } = {}
): { method: MandateMethod; replanInPlace: boolean; stopOutside: string | null } {
  const method = mandateMethod(paymentMethod);
  return {
    method,
    replanInPlace: method === 'card' && opts.internationalCard === true,
    stopOutside:
      method === 'upi'
        ? 'A UPI AutoPay mandate can also be revoked from your UPI app.'
        : method === 'card'
        ? "A card mandate can also be cancelled from your bank's card portal."
        : method === 'emandate'
        ? 'A bank e-mandate can also be cancelled through your bank.'
        : null,
  };
}

/**
 * The payment method of a Razorpay payment entity, as identities: the UPI VPA
 * (lower case), and for a card its network, last4, issuer and a hash of the
 * cardholder's name. Razorpay sends the VPA as payment.vpa, or under
 * payment.upi for UPI AutoPay. A card without a network, four digits or the
 * name identifies nobody (network, issuer and last four alone are shared by
 * strangers, and refusing a genuine new customer is the worse mistake) and
 * is left out; so is anything else (netbanking, wallets, emandate).
 */
export function paymentMethodKeys(
  payment: any
): Array<{ kind: 'UPI' | 'CARD'; value: string }> {
  if (!payment || typeof payment !== 'object') return [];
  const keys: Array<{ kind: 'UPI' | 'CARD'; value: string }> = [];
  const vpa = String(payment.vpa || payment.upi?.vpa || '')
    .trim()
    .toLowerCase();
  if (/^[^@\s]+@[^@\s]+$/.test(vpa)) keys.push({ kind: 'UPI', value: vpa });
  const card = payment.card;
  const last4 = String(card?.last4 || '').trim();
  const network = String(card?.network || '')
    .trim()
    .toLowerCase();
  const name = String(card?.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (/^\d{4}$/.test(last4) && network && name) {
    const issuer = String(card.issuer || '')
      .trim()
      .toUpperCase();
    keys.push({ kind: 'CARD', value: [network, last4, issuer, sha256(name)].join('|') });
  }
  return keys;
}

/**
 * Which source a charge on `subscription` records: OFFER for the charge
 * the first-month offer discounted (its first), PAID for any other.
 */
export function chargeSource(subscription: any): 'PAID' | 'OFFER' {
  return subscription?.offer_id && Number(subscription?.paid_count || 0) <= 1
    ? 'OFFER'
    : 'PAID';
}
