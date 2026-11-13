import { endsOnTimer } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.end.timer';
import { OneTimePlanService } from '@hookpost/nestjs-libraries/services/one.time.plan.service';
import {
  isOrderIdentifier,
  oneTimePlanPriceLabel,
  orderCurrencyFor,
  ONE_TIME_PLAN_NAME,
  ONE_TIME_PLAN_PRICE,
  ONE_TIME_PLAN_TIER,
  OrderCurrency,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';
import { everyAligned, AlignedTimer } from '@hookpost/helpers/utils/timer';
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SignupAttributionService } from '@hookpost/nestjs-libraries/database/prisma/attribution/signup-attribution.service';
import { Organization } from '@prisma/client';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { BillingSubscribeDto } from '@hookpost/nestjs-libraries/dtos/billing/billing.subscribe.dto';
import {
  couponPriceMinor,
  pricing,
  getPricing,
  getCurrencyConfig,
  CURRENCY_MINOR_MULTIPLIER,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  buildPricingContext,
  CheckoutDecision,
  currencyCountry,
  CurrencyHints,
  currencyNeedsSubject,
  CurrencySubject,
  decideCheckoutCurrency,
  DUNNING_STATES,
  entitlementLocks,
  normaliseCurrencyCode,
  PricingContext,
  resolveRegion,
  sanitizeTz,
  SUBSCRIPTION_CURRENCY,
  newPurchaseCurrency,
  trustedCountry,
} from '@hookpost/nestjs-libraries/services/billing.currency';
import { UsersService } from '@hookpost/nestjs-libraries/database/prisma/users/users.service';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  scheduledCancelAt,
  LIVE_STATES,
  AUTHORISED_STATES,
  chargeSource,
  OFFER_ONCE_SOURCES,
  buildPlanKey,
  cancelProvenAtRazorpay,
  canStillCharge,
  chargeAtSeconds,
  chargedPlanTerms,
  chargeIsNear,
  currentCycleUnpaid,
  firstChargeAtSeconds,
  firstChargeNeverLanded,
  inPlaceChangeMinor,
  isHaltedUnpaidTrial,
  isOlderThan,
  isOrgSubscription,
  isTrialSubscription,
  isUnpaidTrial,
  mandateMethod,
  mandateRules,
  MIN_CREDIT_LEAD_SECONDS,
  newMandateUpgradeTerms,
  PaidCycle,
  paidPastSavedEnd,
  paidThrough,
  parsePlanKey,
  planMismatch,
  missedEndEvent,
  MissedEndEvent,
  preChargeVerdict,
  PlanChangeDirection,
  planChangeDirection,
  planChangeRefusal,
  pendingDowngradeTier,
  replacementPaidUntil,
  scheduledChangeOf,
  startsLater,
  startsNewTrial,
  TERMINAL_STATES,
  TRIAL_MIN_LEAD_MS,
  trialAccessUntil,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { RefundsService } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.service';
import { MediaRetentionService } from '@hookpost/nestjs-libraries/database/prisma/media-retention/media.retention.service';
import {
  chargeStoppedEmail,
  refundAfterCancelEmail,
  formatBillingDate,
  formatMoney,
  paymentDisputedEmail,
  paymentFailedEmail,
  planEndedEmail,
  refundEmail,
  secondTrialRefusedEmail,
  subscriptionCancelledEmail,
  subscriptionWelcomeEmail,
  TrialChargeTerms,
  trialAccessEndingEmail,
  trialReminderEmail,
  renewalReminderEmail,
  workspacePausedEmail,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';
import {
  baseTrialDays as policyBaseTrialDays,
  sunsetExemptOrgs,
  trialCutoffs,
  trialPolicyActive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { appUrl, RenderedEmail } from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import {
  adminAlertEmail,
  AlertFact,
} from '@hookpost/nestjs-libraries/emails/templates/admin.alert.email';
import {
  firstMonthOfferFor,
  firstMonthOfferTerms,
} from '@hookpost/nestjs-libraries/services/first.month.offer';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { isGumroadIdentifier } from '@hookpost/nestjs-libraries/services/gumroad.license';
import { isMarketplaceIdentifier } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import {
  buildDisputeEvidence,
  disputeAwaitsResponse,
  respondByNote,
  respondBySubject,
} from '@hookpost/nestjs-libraries/services/dispute.evidence';
import {
  OwnerSalesAlertService,
  razorpayKeyTestReason,
} from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import {
  amountLabel,
  cleanLine,
  defang,
  OwnerSaleAlert,
} from '@hookpost/nestjs-libraries/emails/templates/owner.sales.alert.email';
import dayjs from 'dayjs';

type Billing = 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
type Period = 'MONTHLY' | 'YEARLY';

/**
 * Number of billing cycles we request per subscription. Razorpay requires a
 * finite total_count, so we ask for the maximum sensible horizon rather than
 * letting it lapse: 10 years monthly, 10 years yearly.
 */
const TOTAL_COUNT: Record<Period, number> = { MONTHLY: 120, YEARLY: 10 };

/**
 * When Razorpay will take the first payment on a subscription: start_at for a
 * subscription created with a trial or coupon delay, else charge_at. Null when
 * neither is set.
 */
function firstChargeAt(subscription: any): Date | null {
  const at = firstChargeAtSeconds(subscription);
  return at > 0 ? new Date(at * 1000) : null;
}

/**
 * The billing cycle a failing charge belongs to, in unix seconds: the same
 * on every retry, so the failure email and the owner alert go out once per
 * cycle. A trial's first charge keys on start_at, because Razorpay can set a
 * current_start on it once that charge has been tried.
 */
/**
 * A failing charge is a trial's first one, not a plan charged at once whose
 * first payment failed (a checkout on free posts has no trial): a trial's
 * first charge was set days after the subscription was created.
 */
function isTrialFirstCharge(subscription: any): boolean {
  return (
    isUnpaidTrial(subscription) &&
    (Number(subscription.start_at || 0) - Number(subscription.created_at || 0)) * 1000 >
      TRIAL_MIN_LEAD_MS
  );
}

function failingCycleStart(subscription: any): number {
  const at = isUnpaidTrial(subscription)
    ? subscription?.start_at || subscription?.current_start
    : subscription?.current_start || subscription?.start_at;
  return Number(at || subscription?.charge_at || 0);
}

/**
 * How long before a trial's first charge the bank may already be debiting:
 * on both live trial conversions the debit had reached the bank about a day
 * before start_at, which is why every trial page says "cancel at least 24
 * hours before". Inside this window no new mandate is opened on a trial (a
 * plan switch, a new payment method, a reactivation), because the old
 * mandate's debit can still land beside the new one's, and Cancel says the
 * debit may still go through (and is refunded in full if it does).
 */
const FIRST_DEBIT_LEAD_SEC = 24 * 3600;

/** Razorpay subscription states that will never bill again. */
const ENDED_STATES = TERMINAL_STATES;

/**
 * How long a "this email went out" marker lives. Razorpay retries a webhook
 * for up to 24 hours and sends refund.created and refund.processed for the
 * same refund, so anything well past a day is enough.
 */
const EMAIL_ONCE_TTL_SECONDS = 45 * 86400;

/**
 * Has any of this captured payment been refunded, by earlier refunds
 * (amount_refunded) or this one (`refundAmount`)? Any amount counts: a refund
 * of a subscription charge ends the plan (handleRefund), whatever its size
 * (owner's decision, 29 Oct 2026). Razorpay also refunds, by itself, a
 * payment it never captured; that is no charge.
 */
function hasRefund(pay: any, refundAmount = 0): boolean {
  const amount = Number(pay?.amount || 0);
  const refunded = Math.max(
    Number(refundAmount || 0),
    Number(pay?.amount_refunded || 0)
  );
  const captured =
    pay?.captured === true || ['captured', 'refunded'].includes(pay?.status);
  return amount > 0 && captured && refunded > 0;
}

/** Payments read at once when looking for a refund (subscriptionRefunded). */
const REFUND_READS_AT_ONCE = 5;

/** How often lapsed cancellation grace periods are closed. */
const GRACE_SWEEP_MS = 60 * 60 * 1000;

/*
 * A halted renewal (Razorpay has stopped retrying it, and never cancels a
 * halted subscription on its own) ends the plan at once: no grace on top of
 * the retries, since 29 Oct 2026 (the owner's call). The only time it keeps
 * is time already paid for (paidThrough in scheduleHaltedRenewalEnd), so
 * nobody loses a day they paid for.
 */

/**
 * How long one pre-charge guard action stays claimed in Redis
 * (reconcileBilling). Long enough that the several processes running the
 * sweep do not each cancel the same subscription in the same hour, short
 * enough that a cancel which failed halfway is tried again the same day.
 */
const GUARD_CLAIM_TTL_SECONDS = 6 * 3600;

/**
 * Cancel holds a per-workspace lock this long at most (cancelAtPeriodEnd),
 * and a second, concurrent Cancel waits up to CANCEL_LOCK_WAIT_MS for the
 * first one's result.
 */
const CANCEL_LOCK_TTL_SECONDS = 30;
const CANCEL_LOCK_WAIT_MS = 15_000;

/**
 * A guard cancel Razorpay refused is tried again after these delays, one
 * after another (5 min, 30 min, 2 h, 6 h), by the retry sweep
 * (retryFailedGuardCancels), never later than GUARD_RETRY_STOP_BEFORE_MS
 * before the charge. If the charge still lands, it is refunded in full
 * automatically (refundChargeAfterCancel).
 */
export const GUARD_RETRY_BACKOFF_MS = [
  5 * 60_000,
  30 * 60_000,
  2 * 3600_000,
  6 * 3600_000,
];
export const GUARD_RETRY_STOP_BEFORE_MS = 6 * 3600_000;
/** How often the retry sweep looks for a cancel that is due again. */
const GUARD_RETRY_SWEEP_MS = 5 * 60_000;
/**
 * A plan PATCH that got no answer (subscribe) and has not landed this long
 * after did not happen: Razorpay test mode answers 500 to an international
 * card's prorated update and leaves the plan as it was. From then on the
 * subscription takes the new-mandate route, so the customer is not stuck
 * retrying a PATCH that keeps failing; before then nothing is sent at all.
 */
const PATCH_NO_ANSWER_SETTLE_MS = 2 * 60_000;
const PATCH_NO_ANSWER_TTL_SECONDS = 3600;
/** How long where a mandate's card was issued is remembered (replansInPlace). */
const MANDATE_CARD_TTL_MS = 10 * 60_000;

/**
 * A retry record outlives its last attempt by this much, so a charge that
 * lands after the retries ran out is still known as one the customer was
 * never meant to pay (createSubscription, refundChargeAfterCancel).
 */
const GUARD_RETRY_KEEP_SECONDS = 45 * 86400;
const GUARD_RETRY_INDEX = 'razorpay:guard-retries';

/**
 * One automatic refund per payment, ever: the claim outlives Razorpay's
 * six-month refund window, so no webhook redelivery or guard run can send a
 * second one.
 */
const AUTO_REFUND_CLAIM_SECONDS = 400 * 86400;

/**
 * How far back the hourly refund sweep (sweepMissedRefunds) looks: Razorpay
 * retries a failing webhook for 24 hours, so three days also covers a
 * backend that was down for a day or two. Every refund in the window is
 * handled again each hour, which is safe because handleRefund is idempotent.
 */
const REFUND_SWEEP_LOOKBACK_SECONDS = 3 * 86400;
/** Razorpay's largest page for GET /refunds. */
const REFUND_SWEEP_PAGE = 100;
/** Pages read per sweep at most (10,000 refunds), so a bad answer cannot loop. */
const REFUND_SWEEP_MAX_PAGES = 100;
/** One process handles a refund per sweep; shorter than the hourly slot. */
const REFUND_SWEEP_CLAIM_SECONDS = 10 * 60;
/**
 * How far back the hourly dispute sweep (sweepMissedDisputes) looks. Longer
 * than the refund sweep's because a missed dispute webhook may mean the live
 * webhook was never subscribed to payment.dispute.* at all, and a bank's
 * respond-by date is usually 7 to 10 days out: 45 days catches every dispute
 * still worth answering.
 */
const DISPUTE_SWEEP_LOOKBACK_SECONDS = 45 * 86400;
/**
 * A dispute is handled by the sweep once per status it reaches (open, won,
 * lost...), the way its webhooks would arrive: the claim outlives the window.
 */
const DISPUTE_SWEEP_CLAIM_SECONDS = 60 * 86400;
/** Who the refund audit row names for an automatic refund. */
export const AUTO_REFUND_ACTOR = {
  id: 'system:auto-refund',
  email: 'auto-refund (charged after cancel)',
};
/** notes.auto on a refund Hookpost made because a charge landed after cancel. */
export const AUTO_REFUND_NOTE = 'charged_after_cancel';

/** A failed guard cancel waiting for its next try (retryFailedGuardCancels). */
interface GuardRetry {
  subscriptionId: string;
  organizationId: string;
  subscriptionTier?: string | null;
  period?: string | null;
  cancelAt?: string | null;
  reason: string;
  /** Unix ms of the first refused cancel: anything charged after is refunded. */
  firstFailedAt: number;
  attempts: number;
  /** Unix ms of the next try; 0 once the retries are over. */
  nextAt: number;
  /** Unix ms of the charge the cancel is racing, or 0. */
  chargeAt: number;
  lastError?: string;
}

/**
 * The trial reminder goes out once its first charge is between 24 and 48
 * hours away. The window is wide on purpose: the hourly sweep runs in about
 * four RazorpayService instances (DatabaseModule, ApiModule, PublicApiModule,
 * on the backend and the orchestrator, both with RUN_CRON), and a restart
 * can skip an hour. sendOnce('trial-reminder:<id>') makes it one email.
 *
 * 48 hours, not the 72 it was for the 7-day trial: a 3-day trial's first
 * charge is 72 hours away the moment it starts, so 72 sent the "your trial
 * ends" email within the first hour. 48 sends it on day 2, with a day left
 * before the "cancel at least 24 hours before" line.
 */
const TRIAL_REMINDER_FROM_MS = 24 * 3600 * 1000;
const TRIAL_REMINDER_TO_MS = 48 * 3600 * 1000;
/**
 * A yearly plan is told about its renewal when the charge is this close
 * (sendRenewalReminders): 30 days, inside the 15-45 days California asks of a
 * plan of a year or longer. One found later than that (the day this shipped,
 * or after an outage) is still told, down to 3 days before; closer than that
 * the bank's own pre-debit notice is the reminder.
 */
const RENEWAL_REMINDER_TO_MS = 30 * 86400 * 1000;
const RENEWAL_REMINDER_FROM_MS = 3 * 86400 * 1000;
/**
 * How long Razorpay's subscription.cancelled for a guard cancel stays quiet
 * (quietGuardCancelWebhook): its retries run for up to 24 hours.
 */
const GUARD_WEBHOOK_QUIET_SECONDS = 2 * 86400;

/**
 * The "your access ends" email to a trial the customer cancelled goes out
 * once the date it stops working is between 26 and 48 hours away: before the
 * last 24 hours, inside which Billing refuses Reactivate (FIRST_DEBIT_LEAD_SEC),
 * with at least two hours to use it. Wide for the same reasons as the trial
 * reminder's window; sendOnce('trial-access-ending:<id>') makes it one email.
 */
const TRIAL_ACCESS_ENDING_FROM_MS = 26 * 3600 * 1000;
const TRIAL_ACCESS_ENDING_TO_MS = 48 * 3600 * 1000;
/**
 * Not within this long of the cancellation itself: the cancellation email
 * already gave the date, and a second email in the same hour reads as a
 * push. A trial cancelled later than that gets no reminder.
 */
const TRIAL_ACCESS_ENDING_QUIET_MS = 12 * 3600 * 1000;

/** How long /user/self reuses a trial's first-charge date read from Razorpay. */
const TRIAL_END_CACHE_MS = 5 * 60 * 1000;
/** /user/self does not wait longer than this for that read. */
const TRIAL_END_READ_TIMEOUT_MS = 3000;

function subscriptionSafeId(payment: any) {
  return payment?.order_id || payment?.invoice_id || String(payment?.created_at || '');
}

/**
 * A RazorpayClient error carrying a 4xx: Razorpay read the request and turned
 * it down, so nothing it asked for happened. A network failure has no status
 * and a 5xx does not say whether the change was applied.
 */
function isRazorpayRefusal(e: any): boolean {
  return /failed \(4\d\d\)/.test(String(e?.message || e || ''));
}

/**
 * A 4xx that still answers nothing about the object: 408 (timed out) and 429
 * (rate-limited) say "ask again later", not "it is not there".
 */
function isRazorpayRetryLater(e: any): boolean {
  return /failed \((408|429)\)/.test(String(e?.message || e || ''));
}

/**
 * Did the "charge now" PATCH take, judged by the subscription read back after
 * it: Razorpay has charged it (active), or it is still waiting with its first
 * charge moved from where it was.
 */
function trialChargeBroughtForward(
  startAtBefore: unknown,
  after: any
): boolean {
  if (after?.status === 'active') return true;
  return (
    after?.status === 'authenticated' &&
    Number(after?.start_at || 0) > 0 &&
    Number(after.start_at) !== Number(startAtBefore || 0)
  );
}

/** Razorpay's own reason from a RazorpayClient error, without our prefix. */
function razorpayReason(e: any): string {
  const message = String(e?.message || e || '');
  const match = message.match(/failed \(\d+\): ([\s\S]*)$/);
  return (match ? match[1] : message).trim() || 'no reason given';
}

/**
 * Razorpay could not tell us what the org's current plan charges in. Checkout
 * refuses (503) rather than guess, because a wrong guess opens a second
 * subscription in another currency next to a live one.
 */
export class CurrencyLockUnknownError extends Error {}

/**
 * Razorpay could not be read while a refund was handled, so whether that
 * refund ends a plan is unknown. The webhook fails on it (500) rather than
 * guess, because Razorpay redelivers a failed webhook for up to 24 hours and
 * nothing else goes looking for refunds: a refund dropped here leaves a
 * refunded workspace on a paid plan for good.
 */
export class RefundReadUnknownError extends Error {}

/** The org's stored Razorpay subscription, as Razorpay sees it right now. */
interface CurrentPlan {
  identifier: string;
  status: string | null;
  /** What its plan charges in, or null when that could not be read. */
  currency: string | null;
  /** Whether it holds the org to that currency (see entitlementLocks). */
  locks: boolean;
  /** The stored row it was read for. */
  row: any;
  /** The subscription as Razorpay returned it; null when Razorpay doesn't know it. */
  subscription: any | null;
}

/**
 * What the workspace pays for its plan each period, from its own Razorpay
 * plan (GET /billing/pricing-context, `currentPlan`). Can differ from the
 * list price: a subscriber keeps the price they signed up at.
 */
export interface CurrentPlanPrice {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  currency: string;
  /** Major units (rupees, not paise). */
  amount: number;
}

/**
 * A plan change the workspace has approved for a future date, for the billing
 * page's "Changes to <plan> on <date>" line (GET /billing/pricing-context).
 */
export interface ScheduledPlanChange {
  billing: string;
  period: 'MONTHLY' | 'YEARLY';
  at: Date;
  /**
   * `in_place`: Razorpay holds the change as a pending update on the card
   * mandate and can drop it (undoPlanChange needs no checkout).
   * `new_mandate`: a second subscription holds it, because a UPI Autopay or
   * e-mandate cannot be re-planned; undoing it means approving a mandate for
   * the plan being kept.
   */
  how: 'in_place' | 'new_mandate';
}

/** What POST /billing/cancel did. */
export interface CancelResult {
  id: string;
  /** When the plan stops: the end of the paid period, or now. */
  cancel_at: Date | null;
  /**
   * The plan ends now: no paid time is left (a trial, or a renewal that was
   * not paid). False when it runs until cancel_at.
   */
  immediate: boolean;
  /** A cancellation was already on file; nothing new was sent to Razorpay. */
  alreadyScheduled: boolean;
}

/** One subscription the pre-charge guard cancelled at Razorpay. */
export interface GuardCancellation {
  subscriptionId: string;
  organizationId: string;
  /** Why it was cancelled (preChargeVerdict). */
  reason: string;
  /** Razorpay's status when the guard looked. */
  status: string;
  /** When Razorpay would have charged next, ISO, or null. */
  chargeAt: string | null;
  /** How long the workspace keeps its plan here, ISO, or null when over. */
  accessUntil: string | null;
}

/** One disagreement the guard reports to the owner without acting on it. */
export interface BillingMismatch {
  subscriptionId: string;
  organizationId: string;
  kind:
    | 'charging_without_plan'
    | 'plan_without_subscription'
    | 'paid_past_saved_end';
  status: string;
  chargeAt: string | null;
}

/** What one run of the pre-charge guard found (RazorpayService.reconcileBilling). */
export interface ReconcileReport {
  /** Nothing was changed anywhere. */
  dryRun: boolean;
  /** Plan rows read at Razorpay. */
  checked: number;
  /** Of those, the ones with an end date on the row. */
  endingChecked: number;
  /** Of those, the ones Razorpay would not return; never acted on. */
  unreadable: number;
  /** Plans ended because a charge on them had been refunded. */
  refundedEnded: string[];
  /**
   * Plans stopped because their mandate will never pay: paused by the
   * customer (handlePausedByCustomer) or its first debit never landed
   * (endUnpaidFirstCharge).
   */
  stoppedUnpaid: string[];
  /**
   * Plans whose subscription.cancelled / .completed / .expired / .halted
   * never arrived, handled here as that webhook would have been
   * (missedEndEvent).
   */
  missedWebhooks: string[];
  /** Hookpost subscriptions listed at Razorpay for the reverse check. */
  listed: number;
  /** A page of that listing could not be read, so it is short. */
  listingFailed: boolean;
  cancelled: GuardCancellation[];
  mismatches: BillingMismatch[];
  /** Charges taken after cancel, and what happened to each (refundChargeAfterCancel). */
  autoRefunds: Array<{ subscriptionId: string; paymentId: string; outcome: string; why?: string }>;
}

/** One row of the customer's billing history (GET /billing/invoices). */
export interface BillingInvoice {
  id: string;
  date: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  /** Major units (rupees, not paise). */
  amount: number;
  currency: string;
  /** Razorpay's invoice status: paid, issued (not paid yet), expired, cancelled... */
  status: string;
  /** Razorpay-hosted invoice page, when Razorpay issued one. */
  url: string | null;
  billing: string | null;
  period: string | null;
}

/** Why a new mandate is being opened for the plan the workspace already has. */
export type ReplacementReason =
  | 'reactivate'
  | 'payment_method'
  /**
   * Stay on the current plan instead of the downgrade that is scheduled.
   * Only reachable where that downgrade is a second mandate, which is every
   * payment method Razorpay cannot re-plan (undoPlanChange).
   */
  | 'undo_downgrade';

/**
 * Where the browser asking for a price or a checkout is: Cloudflare's country
 * for the request and the page's timezone. Only from the workspace's own
 * browser requests (billing pages), never MCP or the public API. The
 * creator's signup country, read from the database, comes first.
 */
export type CheckoutHints = Pick<CurrencyHints, 'requestCountry' | 'tz'>;

@Injectable()
export class RazorpayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RazorpayService.name);
  private graceTimer?: AlignedTimer;
  private retryTimer?: NodeJS.Timeout;
  private readonly client = new RazorpayClient();
  /** planId cache, keyed by tier|period|amount so a price change forces a new plan. */
  private planCache = new Map<string, string>();
  /** Reverse map: planId -> the tier/period it represents. */
  private planTierCache = new Map<string, { billing: Billing; period: Period }>();
  /**
   * planId -> the plan as Razorpay returned it. Razorpay plans are immutable,
   * so one read serves its currency, its tier and its price for good.
   */
  private planByIdCache = new Map<string, any>();
  /** subscription id -> its trial's first-charge date, for /user/self. */
  private trialEndCache = new Map<string, { at: number; value: Date | null }>();

  constructor(
    private _subscriptionService: SubscriptionService,
    private _organizationService: OrganizationService,
    private _userService: UsersService,
    private _trackService: TrackService,
    private _affiliateService: AffiliateService,
    // Optional so the many specs that build this service by hand need no
    // change; Nest always provides it (DatabaseModule).
    @Optional() private _attribution?: SignupAttributionService,
    // The owner's sale alerts (OWNER_SALES_ALERT_EMAIL). Optional for the
    // same reason; Nest provides it (DatabaseModule).
    @Optional() private _ownerAlerts?: OwnerSalesAlertService,
    // Automatic full refunds of a charge that landed after cancel
    // (refundChargeAfterCancel). Optional like the two above; Nest provides it.
    @Optional() private _refunds?: RefundsService,
    // The media retention clock: a plan-ended email is its day-0 notice
    // (withMediaKeptUntil). Optional like the three above; Nest provides it.
    @Optional() private _mediaRetention?: MediaRetentionService,
    // One-time orders for the single plan (one.time.plan.service.ts):
    // order.paid, payment.captured and refunds of those payments. Optional
    // like the four above; Nest provides it.
    @Optional() private _oneTimePlan?: OneTimePlanService
  ) {}

  /**
   * The plan on file for this workspace that is set to end, as the exact
   * timer at cancelAt reads it when it wakes (planEndWorkflow): a live,
   * non-lifetime Razorpay row with a date, else null (cleared, ended,
   * replaced by a plan with no date: the timer has nothing to do).
   */
  async planEndDue(
    organizationId: string
  ): Promise<{ identifier: string; cancelAt: string } | null> {
    const row = await this._subscriptionService.getSubscription(organizationId);
    if (
      !row ||
      row.deletedAt ||
      row.isLifetime ||
      !row.cancelAt ||
      !endsOnTimer(row.identifier)
    ) {
      return null;
    }
    return {
      identifier: row.identifier,
      cancelAt: new Date(row.cancelAt).toISOString(),
    };
  }

  /**
   * Stop any subscription Razorpay could still charge although the plan here
   * is ending (reconcileBilling), end any plan whose refund webhook never
   * arrived (sweepMissedRefunds), then close cancellation grace periods once
   * they run out (see handleCancelled) and end halted renewals whose paid time
   * is up (scheduleHaltedRenewalEnd, no grace), then send trial reminders
   * (sendTrialReminders) and the "your access ends" email to cancelled trials
   * (sendCancelledTrialReminders), both only while the trial policy is on.
   *
   * The guard runs first so that a subscription it cancels is ended in-app by
   * the grace sweep in the same run rather than an hour later.
   *
   * Only where RUN_CRON is on, which is the production backend and
   * orchestrator; every sweep is idempotent, so the several processes running
   * them only repeat no-ops.
   */
  onModuleInit() {
    if (process.env.RUN_CRON !== 'true' || process.env.NODE_ENV === 'test') {
      return;
    }
    const run = async () => {
      await this.reconcileBilling().catch((e) =>
        this.logger.error(`Pre-charge guard failed: ${e}`)
      );
      // A refund whose webhook never arrived ends its plan here, before the
      // grace sweep, as the webhook would have.
      await this.sweepMissedRefunds().catch((e) =>
        this.logger.error(`Refund sweep failed: ${e}`)
      );
      // A dispute whose webhook never arrived (or was never subscribed to)
      // ends its plan here, as the webhook would have.
      await this.sweepMissedDisputes().catch((e) =>
        this.logger.error(`Dispute sweep failed: ${e}`)
      );
      await this.endLapsedCancellations().catch((e) =>
        this.logger.error(`Cancellation grace sweep failed: ${e}`)
      );
      // The exact timers at cancelAt (PlanEndTimer): re-arm any that were
      // lost, so the sweep above stays only the backup.
      await this._subscriptionService.armPlanEndTimers().catch((e) =>
        this.logger.error(`Plan-end timer re-arm failed: ${e}`)
      );
      await this.sendTrialReminders().catch((e) =>
        this.logger.error(`Trial reminder sweep failed: ${e}`)
      );
      await this.sendRenewalReminders().catch((e) =>
        this.logger.error(`Renewal reminder sweep failed: ${e}`)
      );
      await this.sendCancelledTrialReminders().catch((e) =>
        this.logger.error(`Cancelled-trial reminder sweep failed: ${e}`)
      );
    };
    setTimeout(run, 2 * 60 * 1000).unref();
    // On the shared hourly slot (DB_SWEEP_SLOT_MS), so Neon wakes once for every sweep.
    this.graceTimer = everyAligned(GRACE_SWEEP_MS, run);
    // Guard cancels Razorpay refused, retried on their backoff.
    this.retryTimer = setInterval(
      () =>
        this.retryFailedGuardCancels().catch((e) =>
          this.logger.error(`Guard cancel retry sweep failed: ${e}`)
        ),
      GUARD_RETRY_SWEEP_MS
    );
    this.retryTimer.unref();
  }

  onModuleDestroy() {
    this.graceTimer?.stop();
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  // ---------------------------------------------------------------------------
  // Webhooks
  // ---------------------------------------------------------------------------

  /**
   * Signature-check an inbound webhook and return the parsed event.
   * Mirrors StripeService.validateRequest so the controller shape is unchanged.
   */
  validateRequest(rawBody: Buffer, signature: string, endpointSecret: string) {
    this.client.verifyWebhook(rawBody, signature, endpointSecret);
    return JSON.parse(rawBody.toString('utf8'));
  }

  /**
   * Razorpay delivers one webhook endpoint for every event, so we branch here
   * rather than in the controller. Returns {ok:true} for events we ignore, so
   * Razorpay does not retry them.
   */
  async handleWebhook(event: any, eventId?: string) {
    const type: string = event?.event || '';
    const subscription = event?.payload?.subscription?.entity;
    const payment = event?.payload?.payment?.entity;

    switch (type) {
      case 'order.paid':
      case 'payment.captured':
        // A one-time order's payment gives its month (once per payment,
        // whichever of these and the page's own confirmation lands first).
        // A subscription's payment.captured is not one: nothing to do, as
        // before (subscription.charged carries it).
        await this._oneTimePlan?.handleWebhook(type, event, eventId);
        return { ok: true };
      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.charged': {
        // The event type goes along so Purchase is reported for a charge
        // only. `authenticated` can carry a payment entity too: the Rs 5
        // mandate check, refunded at once, which is not revenue.
        const result = await this.createSubscription(
          subscription,
          payment,
          type
        );
        // The mandate is approved (or has just charged), so whatever was
        // failing is not any more: AI and X come back by themselves.
        // After createSubscription, so a replacement mandate that has just
        // taken the plan over is cleared under its own id.
        await this.clearPaymentFailing(subscription);
        await this.recordCouponRedemption(subscription);
        await this.recordBillingIdentities(subscription, payment, type);
        // Only a charge carries money; authenticated/activated have no payment.
        // Gated on notes.service like everything else on this shared account.
        if (
          type === 'subscription.charged' &&
          subscription?.notes?.service === 'hookpost'
        ) {
          await this._affiliateService.recordCommission(
            subscription.notes.orgId,
            payment
          );
        }
        return result;
      }
      case 'subscription.updated':
        return this.updateSubscription(subscription);
      case 'subscription.cancelled':
        return this.handleCancelled(subscription);
      case 'subscription.paused':
        // Hookpost never pauses: the customer did, in their UPI app or their
        // bank's card portal. subscription.resumed needs nothing: a paused
        // mandate is cancelled here, and cannot be resumed after that.
        await this.handlePausedByCustomer(subscription);
        return { ok: true };
      case 'subscription.completed':
      case 'subscription.expired':
        return this.deleteSubscription(subscription);
      case 'refund.created':
      case 'refund.processed':
        // A refund of a one-time order's payment takes its month back there;
        // every other refund goes on to the subscription rules below.
        if (
          await this._oneTimePlan?.handleRefund(
            event?.payload?.refund?.entity,
            payment
          )
        ) {
          return { ok: true };
        }
        await this.handleRefund(type, event?.payload?.refund?.entity, payment);
        return { ok: true };
      case 'subscription.halted':
      case 'subscription.pending':
        return this.handlePaymentFailing(type, subscription, payment);
      case 'payment.failed':
        // Never emails: subscription.pending / .halted send the one failure
        // email per cycle (handleFailedSubscriptionPayment).
        await this.handlePaymentFailedWebhook(payment);
        return { ok: true };
      default:
        // Razorpay's dispute events: payment.dispute.created, .won, .lost,
        // .closed, .under_review and .action_required. Matched by prefix, so
        // an event Razorpay adds later still ends the plan rather than being
        // dropped. A chargeback is a refund the customer took by force, so
        // it ends the plan exactly as handleRefund does (handleDispute).
        if (type.startsWith('payment.dispute.')) {
          await this.handleDispute(
            type,
            event?.payload?.dispute?.entity,
            payment
          );
        }
        return { ok: true };
    }
  }

  /**
   * subscription.pending / subscription.halted: a charge is failing. Also
   * run by the pre-charge guard (reconcileBilling) for a halted subscription
   * whose webhook never arrived, so the two cannot disagree. Safe to repeat:
   * an end date already on file stays, and each email goes out once.
   */
  private async handlePaymentFailing(
    type: 'subscription.halted' | 'subscription.pending',
    subscription: any,
    payment?: any
  ) {
    // Payment is failing. Remembered on the plan row, so every
    // entitlement check can see it without asking Razorpay: the workspace
    // loses AI and X at once and keeps publishing to its other channels
    // (trial.policy.ts `dunning`), a trial's first charge and a renewal
    // alike.
    this.logger.warn(
      `Subscription ${subscription?.id} is ${type} - payment retry in progress.`
    );
    await this.markPaymentFailing(subscription, type);
    // Halted means Razorpay has stopped retrying, and it never cancels a
    // halted subscription by itself. A trial whose first charge never
    // went through ends now; a paid plan whose renewal halted ends at
    // once too, never before the time already paid for
    // (scheduleHaltedRenewalEnd).
    let activeUntil: Date | null = null;
    if (type === 'subscription.halted') {
      if (await this.endHaltedUnpaidTrial(subscription)) {
        return { ok: true };
      }
      const halt = await this.scheduleHaltedRenewalEnd(subscription);
      if (halt.ended) {
        // handleCancelled has told the customer their plan ended and why
        // (unpaidRenewalEnded); a second "renewal paused, pay to keep
        // posting" email beside it would contradict it.
        void this.alertOwnerOfFailure(subscription, payment, type, null, true);
        return { ok: true };
      }
      activeUntil = halt.activeUntil;
    }
    await this.handleFailedSubscriptionPayment(
      subscription,
      payment,
      type,
      activeUntil
    );
    void this.alertOwnerOfFailure(subscription, payment, type, activeUntil);
    return { ok: true };
  }

  /**
   * ONCE PER PERSON (razorpay.mapping.ts): what this workspace has now had,
   * for the first-month offer (and the trial) of every later workspace. A
   * charge is PAID, or OFFER for the charge the offer discounted; a trial
   * mandate approved is TRIAL; any other approval that carries a payment
   * (the mandate check) keeps only its method, as ATTEMPT. Idempotent across
   * redelivered webhooks; never throws.
   *
   * An offer charge paid with a method that already paid in another
   * workspace stands (it is made, and the price was the one shown): it is
   * reported here, and the method is now on file against this workspace too.
   */
  private async recordBillingIdentities(subscription: any, payment: any, event: string) {
    const orgId = subscription?.notes?.orgId;
    if (subscription?.notes?.service !== 'hookpost' || !orgId) return;
    const charged = event === 'subscription.charged' && Number(payment?.amount) > 0;
    const source = charged
      ? chargeSource(subscription)
      : isTrialSubscription(subscription)
      ? 'TRIAL'
      : 'ATTEMPT';
    if (source === 'ATTEMPT' && !payment) return;
    try {
      await this._subscriptionService.recordBillingIdentities(orgId, source, {
        payment,
        subscriptionId: subscription.id,
      });
      if (source !== 'OFFER') return;
      const elsewhere = await this._subscriptionService.workspacesPaidWithMethod(
        orgId,
        payment
      );
      if (elsewhere.length) {
        this.logger.warn(
          `First-month offer charged on ${subscription.id} (org ${orgId}, payment ${payment?.id}) with a payment method that already paid in ${elsewhere.join(', ')}. The charge stands; the method is on file, so no later workspace gets the offer with it.`
        );
      }
    } catch (e) {
      // A webhook Razorpay would retry must never fail on what is only a record.
      this.logger.warn(
        `Billing identities not recorded for ${subscription.id} (org ${orgId}): ${e}`
      );
    }
  }

  /**
   * Count a website coupon as used once the customer has actually
   * authenticated the subscription it was applied to. Idempotent (upsert on
   * coupon + org), because Razorpay sends authenticated, activated and charged
   * for the same subscription. Best-effort: a failure here must not make the
   * activation webhook throw and be retried.
   */
  private async recordCouponRedemption(subscription: any) {
    const code = subscription?.notes?.coupon;
    const orgId = subscription?.notes?.orgId;
    if (!code || !orgId || !subscription?.id) return;
    try {
      await this._subscriptionService.redeemCouponByCode(
        code,
        orgId,
        subscription.id
      );
      // An affiliate's code is also a coupon: credit them for this workspace.
      const team = await this._organizationService.getTeam(orgId);
      await this._affiliateService.attributeByCoupon(
        code,
        orgId,
        (team?.users || []).map((u: any) => u.user?.id).filter(Boolean)
      );
    } catch (e) {
      this.logger.warn(
        `Coupon ${code} redemption for ${subscription.id} failed: ${(e as Error).message}`
      );
    }
  }

  /**
   * Cancel, immediately, every Hookpost subscription this org holds except
   * `keepId` whose Razorpay status is in `statuses`.
   *
   * Two callers, with different filters:
   *
   * - createSubscription passes nothing, so `statuses` is LIVE_STATES. It runs
   *   from the subscription.authenticated / activated / charged / updated
   *   webhooks and from the /razorpay/verify checkout callback, i.e. once the
   *   customer has authorised `keepId`. Every other live Hookpost
   *   subscription, including a paid `active` one, is then superseded.
   * - subscribe passes ['created'], right after it opens a new checkout. That
   *   clears earlier checkouts nobody completed and nothing else. `keepId` has
   *   not been authorised at that point and may never be, so a paying
   *   customer's `active` or `authenticated` plan must survive it; the
   *   createSubscription path retires it if the new checkout is completed.
   *
   * Each cancel is best-effort and isolated: one failure must not abort the
   * others or the caller, because a webhook that throws gets retried and would
   * re-run the whole activation.
   *
   * Only subscriptions OLDER than `keep` go. A replacement is always newer
   * than what it replaces, and this runs on every renewal webhook: without the
   * age check, a late webhook for the old plan would cancel the new one.
   *
   * `alsoCheck` names subscriptions to consider even if the account listing
   * misses them, i.e. the identifier the workspace was on before `keep`.
   *
   * Every one stops at once (cancel_at_cycle_end 0), including the paying
   * plan a scheduled downgrade replaces: a cycle-end cancel leaves nothing at
   * Razorpay to prove it will not renew, and the workspace's paid time comes
   * from the new mandate's start_at and pendingDowngradeTier, not from the
   * old mandate staying alive.
   */
  private async retireSupersededSubscriptions(
    organizationId: string,
    keep: { id: string; created_at?: number },
    statuses: readonly string[] = LIVE_STATES,
    alsoCheck: string[] = []
  ) {
    try {
      const all: any[] = [
        ...((await this.getOrgSubscriptions(organizationId))?.items || []),
      ];
      for (const id of alsoCheck) {
        if (!id || id === keep.id || all.some((s) => s?.id === id)) continue;
        const sub = await this.client
          .request('GET', `/subscriptions/${id}`)
          .catch(() => null);
        if (sub?.id) all.push(sub);
      }

      const stale = all.filter(
        (s: any) =>
          s?.id &&
          s.id !== keep.id &&
          statuses.includes(s.status) &&
          isOrgSubscription(s, organizationId) &&
          isOlderThan(s, keep)
      );

      for (const s of stale) {
        await this.client
          .request('POST', `/subscriptions/${s.id}/cancel`, {
            cancel_at_cycle_end: 0,
          })
          .then(() =>
            this.logger.warn(
              `Cancelled superseded subscription ${s.id} for org ${organizationId} (replaced by ${keep.id}).`
            )
          )
          .catch((e: any) =>
            this.logger.error(
              `Failed cancelling superseded subscription ${s.id}: ${e}`
            )
          );
      }
    } catch (e) {
      this.logger.error(
        `retireSupersededSubscriptions failed for ${organizationId}: ${e}`
      );
    }
  }

  /**
   * A subscription became live (first activation, or a renewal charge).
   *
   * `event` is the webhook that delivered it. The checkout callback
   * (syncSubscriptionById) and subscription.updated pass none.
   */
  async createSubscription(subscription: any, payment?: any, event?: string) {
    if (!subscription?.id) return { ok: true };

    const notes = subscription.notes || {};
    const orgId: string | undefined = notes.orgId;

    // Our own checkout stamps notes.service, so this doubles as proof the
    // subscription is ours. It gates the notes fallback below: on a Razorpay
    // account shared with another product, a foreign plan could carry a
    // notes.billing that happens to spell one of our tier names, and trusting
    // it would hand that customer a Hookpost plan they never bought.
    const isOurs = notes.service === 'hookpost';

    // The plan is authoritative; notes can be stale after a plan change.
    const fromPlan = await this.resolveTierFromPlan(subscription.plan_id);
    // A downgrade is approved today and charged when the cycle the customer
    // paid for runs out, and until then they keep the plan they paid for. Its
    // own plan would hand them the cheaper tier the moment they approved the
    // mandate, so the plan it is leaving wins until the charge lands.
    const deferred = isOurs ? pendingDowngradeTier(subscription) : null;
    const billing = (deferred?.billing ||
      fromPlan?.billing ||
      (isOurs ? (notes.billing || '').toUpperCase() : '')) as Billing;
    const period = (deferred?.period ||
      fromPlan?.period ||
      (notes.period || 'MONTHLY').toUpperCase()) as Period;

    if (!pricing[billing]) {
      this.logger.warn(
        `Ignoring subscription ${subscription.id}: could not resolve tier ` +
          `(plan_id=${subscription.plan_id}, notes.billing=${notes.billing}).`
      );
      return { ok: true };
    }

    const customerId = subscription.customer_id;

    // createSubscription runs for authenticated, activated, every monthly
    // charged, updated, and the checkout-callback sync. The welcome email must
    // go out once per subscription, not on each of those, so remember whether
    // this subscription was already on file before the upsert below.
    const knownRow = await this._subscriptionService.getSubscriptionByIdentifier(
      subscription.id
    );
    const alreadyKnown = !!knownRow;

    // A subscription that has already ended never becomes a workspace's plan.
    // subscription.updated can arrive for one (a plan we retired, say), and
    // writing it over the row would hand the workspace a dead plan.
    if (ENDED_STATES.includes(subscription.status) && !alreadyKnown) {
      this.logger.warn(
        `Ignoring ${subscription.id}: it is ${subscription.status} and is not any workspace's current plan.`
      );
      return { ok: true };
    }

    // What the workspace runs on right now, read before the upsert replaces
    // it. Once this subscription is live that one is superseded, and it is
    // retired by id below - the account listing alone is not enough to find it.
    let previousId: string | undefined;
    // A live plan paid on Gumroad (gumroad:<sale>) that this subscription is
    // about to replace: a Razorpay checkout opened before the key was
    // redeemed, and paid after. Razorpay was paid, so the plan follows it,
    // but the Gumroad membership keeps charging: the team is told.
    let replacedGumroadPlan: string | undefined;
    // The plan the workspace had before this one, for the owner's
    // plan-change alert.
    let storedPlan: any = null;
    if (orgId && isOurs) {
      const stored = await this._subscriptionService.getSubscription(orgId);
      storedPlan = stored;
      if (
        isGumroadIdentifier(stored?.identifier) &&
        !ENDED_STATES.includes(subscription.status)
      ) {
        replacedGumroadPlan = stored!.identifier!;
      }
      if (
        stored?.identifier &&
        stored.identifier !== subscription.id &&
        stored.identifier.startsWith('sub_')
      ) {
        previousId = stored.identifier;
        if (await this.isSupersededBy(subscription, previousId, orgId)) {
          // Money taken on a plan that was replaced: the owner may owe a refund.
          if (event === 'subscription.charged') {
            void this.alertOwnerOfCharge({
              subscription,
              payment,
              orgId,
              billing,
              period,
              isReplacement: !!notes.replaces,
              supersededBy: previousId,
            });
          }
          return { ok: true };
        }
      }
    }

    // A mandate opened to reactivate a plan or change how it is paid
    // (startReplacementMandate) is `authenticated` until its first charge on
    // the old plan's renewal date. That is a paying customer, not a trial,
    // unless it was opened during a trial (notes.trial): nothing is paid yet.
    const isReplacement = !!notes.replaces;

    // A trial is given once per person (trial.policy.ts "TRIALS BEHIND A
    // SWITCH"), asked at checkout. Two workspaces of one person checked out
    // side by side both pass that; the one approved second is no trial and
    // no plan: its mandate is stopped now, before anything is charged
    // (SubscriptionService.refuseTrialAtApproval). Only a new trial
    // (startsNewTrial: not a payment taken at once, which is `authenticated`
    // for a moment too), and never a free-months coupon's delayed start
    // (notes.free_months). A percent-off coupon is still a trial.
    if (
      orgId &&
      !alreadyKnown &&
      !(Number(notes.free_months) > 0) &&
      startsNewTrial(subscription) &&
      (await this._subscriptionService.refuseTrialAtApproval(orgId, {
        payment,
        subscriptionId: subscription.id,
      }))
    ) {
      await this.refuseSecondTrial(subscription, orgId);
      return { ok: true };
    }

    // A trial cancelled before its first charge keeps working until that
    // date (handleCancelled). A later webhook for it (subscription.updated)
    // says `cancelled` and carries ended_at, and must neither end the trial
    // there nor stop it counting as a trial.
    const keptTrialEnd = ENDED_STATES.includes(subscription.status)
      ? trialAccessUntil(subscription)
      : 0;
    const keepsTrial = keptTrialEnd * 1000 > Date.now();

    // An end date on file is lifted only when Razorpay says the plan is paid
    // well past it and renewing (paidPastSavedEnd): the grace of a renewal
    // that halted and has since been paid (scheduleHaltedRenewalEnd). A
    // cancellation the customer made always stays.
    // A subscription the guard tried and failed to cancel (a retry record)
    // was meant to stop: a renewal it takes anyway does not lift the end.
    const guardRetry = knownRow?.cancelAt
      ? await this.readGuardRetry(subscription.id)
      : null;
    const keepsEnd =
      !!knownRow?.cancelAt &&
      !keepsTrial &&
      (!!guardRetry ||
        !(await this.renewsPaidUp(subscription, knownRow.cancelAt)));

    // Money taken for time past the end Cancel saved: a UPI AutoPay debit
    // the bank was told about before Cancel, or a renewal the guard could not
    // stop. The plan still ends where Cancel said (the customer asked to
    // stop) and the charge is refunded in full automatically (owner rule: a
    // charge after cancel is our mistake). The owner is asked to act only if
    // that refund cannot be made.
    if (
      event === 'subscription.charged' &&
      keepsEnd &&
      payment?.id &&
      Number(payment.amount) > 0 &&
      (!!guardRetry ||
        paidThrough(subscription) * 1000 >
          new Date(knownRow!.cancelAt!).getTime() + 86400_000)
    ) {
      if (guardRetry && subscription.status !== 'cancelled') {
        // Still live: stop it now, before the next cycle.
        await this.attemptRazorpayCancel(subscription.id);
      }
      await this.settleChargeAfterCancel({
        subscriptionId: subscription.id,
        paymentId: String(payment.id),
        organizationId: knownRow!.organizationId,
        accessUntil: new Date(knownRow!.cancelAt!),
        billing,
        period,
        paymentMethod: subscription.payment_method || payment.method || null,
        userId: notes.userId || null,
      });
    }

    // Where this row says the paid access ends, and where the subscription
    // says it stops. Cancel stops the mandate at Razorpay at once and leaves
    // the paid time on the row, so a cancelled subscription's own date is
    // `ended_at` -- today -- while the customer has paid to the end of the
    // period. Taking Razorpay's date would hand back the weeks they bought,
    // so where the row's date is kept, the later of the two wins.
    const savedEndSec = knownRow?.cancelAt
      ? Math.floor(new Date(knownRow.cancelAt).getTime() / 1000)
      : 0;
    const remoteEndSec = scheduledCancelAt(subscription) ?? 0;

    await this._subscriptionService.createOrUpdateSubscription(
      isTrialSubscription(subscription) || keepsTrial, // treated as trialing
      subscription.id,
      customerId,
      pricing[billing].channel!,
      billing,
      period,
      // A cancellation saved at click time (cancelAtPeriodEnd) stays: Razorpay
      // cannot revoke one, so a later webhook for the same subscription must
      // neither wipe it nor bring it forward.
      keepsTrial
        ? keptTrialEnd
        : keepsEnd
        ? Math.max(savedEndSec, remoteEndSec) || null
        : remoteEndSec || null,
      undefined,
      orgId
    );

    if (orgId && replacedGumroadPlan) {
      await this.alertGumroadPlanReplaced(orgId, replacedGumroadPlan, subscription.id);
    }

    if (orgId && isOurs) {
      // Retire any OTHER live subscription this org still holds.
      //
      // changeSubscription switches plans in place with a PATCH, but Razorpay
      // rejects that outright on a UPI mandate - "subscriptions cannot be
      // updated when payment mode is upi" - and every payment this account has
      // ever taken was UPI. The PATCH failure is caught and we fall through to
      // issuing a fresh mandate, which is the right recovery, except nothing
      // ever cancelled the old one: the customer ended up authorising the new
      // plan while the previous plan kept charging. An upgrade from Standard to
      // Pro billed Rs 599 AND Rs 1,999 every month, forever.
      //
      // Guarded on isOurs and on id inequality: this Razorpay account is shared
      // with other products, and cancelling a foreign subscription here would
      // be far worse than the bug it fixes.
      //
      // Until 13 Oct 2026 this never cancelled anything: the listing it relied
      // on sent customer_id, which Razorpay rejects with a 400, and the error
      // was swallowed. previousId is checked by id as well, so the plan the
      // workspace was on is retired even if the listing misses it.
      await this.retireSupersededSubscriptions(
        orgId,
        subscription,
        LIVE_STATES,
        previousId ? [previousId] : []
      );

      // Report the revenue conversion. TrackService was injected here but never
      // called, so Purchase - the only event that says an ad actually produced
      // money - never fired at all. Without it, ad platforms optimise towards
      // signups and cannot tell a paying customer from a tyre-kicker.
      //
      // Fired server-side from the webhook on purpose: it survives ad blockers
      // and closed tabs, and it is the only place the real charged amount is
      // known. Only on subscription.charged: `authenticated` can carry the
      // Rs 5 mandate check as its payment entity, which is refunded at once
      // and used to be reported as a Purchase.
      if (event === 'subscription.charged') {
        await this.trackPurchase(orgId, payment);
      }

      // The trial conversion, server-side. The browser used to be the only
      // sender and only on `?check=`, which no live flow sets. The event id
      // is the subscription's, so the checkout callback and the authenticated
      // webhook (which can both see this subscription as new) and the
      // browser's own StartTrial collapse into one event at Meta.
      if (!alreadyKnown && startsNewTrial(subscription)) {
        await this.trackStartTrial(orgId, subscription.id);
      }

      // The owner hears about it (OWNER_SALES_ALERT_EMAIL). Not awaited and
      // never throws: an email outage cannot fail this webhook.
      void this.alertOwnerOfSubscription({
        subscription,
        payment,
        event,
        orgId,
        billing,
        period,
        alreadyKnown,
        isReplacement,
        // A paid plan this one replaces: a Razorpay one, or one paid on
        // Gumroad. Not a lifetime or api.market row.
        previous:
          knownRow ??
          (storedPlan?.identifier &&
          storedPlan.identifier !== subscription.id &&
          !storedPlan.isLifetime &&
          (storedPlan.identifier.startsWith('sub_') ||
            isGumroadIdentifier(storedPlan.identifier))
            ? storedPlan
            : null),
      });

      // Keep Organization.paymentId aligned with the Razorpay customer.
      await this._subscriptionService.updateCustomerId(orgId, customerId);
      // A replacement mandate is the same plan continuing, so no welcome
      // (which would also call its future first charge a free trial).
      //
      // Claimed in Redis per subscription: /razorpay/verify and the
      // authenticated webhook run at the same moment, both read "not on file
      // yet" above, and both used to send it.
      if (!alreadyKnown && !isReplacement) {
        this.sendOnce(`welcome:${subscription.id}`, () =>
          this.sendSubscriptionWelcomeEmail(
            orgId,
            billing,
            period,
            firstChargeAt(subscription),
            subscription
          )
        ).catch((e) => {
          this.logger.error(`Failed to send subscription welcome email: ${e}`);
        });
      }
    }

    return { ok: true };
  }

  /**
   * Is `subscription` older than `currentId`, the plan the workspace already
   * runs on, while that one is still live? Then `subscription` was replaced:
   * its webhook arrived late (a renewal charged just before the plan change)
   * or retiring it failed. It must not take the workspace back to the old
   * plan, and if it can still bill it is cancelled now.
   */
  private async isSupersededBy(
    subscription: any,
    currentId: string,
    organizationId: string
  ) {
    const ownCreatedAt = Number(subscription?.created_at || 0);
    if (!ownCreatedAt) return false;

    const current = await this.client
      .request('GET', `/subscriptions/${currentId}`)
      .catch(() => null);
    if (
      !current ||
      !isOrgSubscription(current, organizationId) ||
      !AUTHORISED_STATES.includes(current.status) ||
      Number(current.created_at || 0) <= ownCreatedAt
    ) {
      return false;
    }

    this.logger.warn(
      `Not moving org ${organizationId} back to ${subscription.id}: ${currentId} replaced it.`
    );
    if (LIVE_STATES.includes(subscription.status)) {
      await this.client
        .request('POST', `/subscriptions/${subscription.id}/cancel`, {
          cancel_at_cycle_end: 0,
        })
        .then(() =>
          this.logger.warn(
            `Cancelled superseded subscription ${subscription.id} for org ${organizationId} (replaced by ${currentId}).`
          )
        )
        .catch((e: any) =>
          this.logger.error(
            `Failed cancelling superseded subscription ${subscription.id}: ${e}`
          )
        );
    }
    return true;
  }

  /**
   * Stops a trial mandate that must not start (createSubscription,
   * SubscriptionService.refuseTrialAtApproval): cancelled at Razorpay at once
   * so the first debit never comes, the customer told once, support alerted.
   * A cancel Razorpay refuses is only support's to chase, days before that
   * debit, and the customer is not told "nothing was charged" until it went
   * through; a debit that still lands is a paid plan, never money for nothing.
   * A delivery beside this one finds the same answer (allowTrial false), so
   * the cancel is repeated harmlessly and the emails go out once (sendOnce).
   */
  private async refuseSecondTrial(subscription: any, orgId: string) {
    this.logger.warn(
      `Trial ${subscription.id} for org ${orgId} refused at approval: someone behind it has had a trial.`
    );
    const failed = await this.attemptRazorpayCancel(subscription.id);
    if (!failed) {
      await this.sendOnce(`second-trial:${subscription.id}`, async () => {
        const org = await this._organizationService.getOrgById(orgId);
        return this.sendCustomerEmail(
          orgId,
          secondTrialRefusedEmail({ orgName: org?.name || 'your workspace' }),
          'Hookpost Billing <support@hookstep.in>'
        );
      });
    }
    await this.sendOnce(`second-trial-alert:${subscription.id}`, () =>
      this.sendSupportAlert({
        subject: failed ? 'Second trial refused, cancel it by hand' : 'Second trial refused',
        headline: failed ? 'Second trial refused: cancel it by hand' : 'Second trial refused',
        summary: `A trial mandate was approved after its owner or a channel had a trial elsewhere. ${
          failed
            ? `It could NOT be cancelled at Razorpay (${failed}): cancel it in the dashboard before its first charge on ${formatBillingDate(new Date(firstChargeAtSeconds(subscription) * 1000))}, then tell the customer.`
            : 'It was cancelled at Razorpay; nothing was charged and the customer was told.'
        } The workspace is locked (allowTrial false).`,
        needsAction: !!failed,
        orgId,
        subscriptionId: subscription.id,
      })
    );
  }

  /**
   * Report a completed payment to the ads pixel, server-side.
   *
   * Never throws: a tracking outage must not fail a webhook Razorpay will
   * otherwise retry, which would double-provision the subscription.
   */
  private async trackPurchase(orgId: string, payment?: any) {
    try {
      if (!payment?.amount) return;
      // The campaign report's "paid": the first real charge.
      await this._attribution?.markPaid(orgId);

      const team = await this._organizationService.getTeam(orgId);
      const user = team?.users?.[0]?.user;

      await this._trackService.track(
        // Deterministic per payment, so a Razorpay webhook retry reports the
        // same event id and Meta collapses it rather than counting twice.
        `purchase_${payment.id || subscriptionSafeId(payment)}`,
        // No client IP or user-agent here on purpose. This runs in a Razorpay
        // webhook, so the only address available is Razorpay's server - sending
        // that would attach the wrong signal to the conversion. The hashed
        // email below is the match key that matters for a purchase.
        '',
        '',
        TrackEnum.Purchase,
        {
          // Razorpay amounts are in the minor unit (paise), the pixel wants
          // the major unit.
          value: payment.amount / 100,
          currency: payment.currency || 'INR',
        },
        undefined,
        user as any
      );
    } catch (e) {
      this.logger.error(`Purchase tracking failed for org ${orgId}: ${e}`);
    }
  }

  /**
   * Report a started trial to the ads pixel, server-side, with the event id
   * the browser uses for the same trial (trial_<subscription id>).
   *
   * Never throws, like trackPurchase.
   */
  private async trackStartTrial(orgId: string, subscriptionId: string) {
    try {
      await this._attribution?.markTrialStarted(orgId);
      const team = await this._organizationService.getTeam(orgId);
      const user = team?.users?.[0]?.user;
      await this._trackService.track(
        `trial_${subscriptionId}`,
        // No IP or user-agent: this runs from a webhook or the checkout
        // callback, and the hashed email is the match key (see trackPurchase).
        '',
        '',
        TrackEnum.StartTrial,
        {},
        undefined,
        user as any
      );
    } catch (e) {
      this.logger.error(`StartTrial tracking failed for org ${orgId}: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Owner sale alerts (OwnerSalesAlertService, OWNER_SALES_ALERT_EMAIL)
  // ---------------------------------------------------------------------------

  /** Hand an alert to the owner's mailer: not awaited, never throws. */
  private alertOwner(alert: OwnerSaleAlert) {
    if (!this._ownerAlerts) return;
    try {
      void this._ownerAlerts.notify(alert).catch(() => undefined);
    } catch (e: any) {
      this.logger.error(`Owner sale alert ${alert.key} failed: ${e?.message || e}`);
    }
  }

  /**
   * createSubscription has written the plan of a subscription Hookpost
   * opened (notes.service): tell the owner what happened. A charge (first or
   * renewal, keyed on the payment id); then at most one of a plan change
   * (the previous paid plan's tier or period differs: an in-place switch, a
   * new mandate for another plan, a plan switch during a trial), a new
   * mandate on the same plan (Reactivate, Change payment method) or a new
   * trial. A subscription that is charged straight away is reported by its
   * first charge. Every key is the provider's id, so authenticated,
   * activated, charged, updated and /razorpay/verify for one subscription
   * give one email each at most. A trial start or a same-plan mandate is
   * reported by the call that first put the subscription on file; if Resend
   * is down then, OwnerSalesAlertService queues it and retries. Never throws.
   */
  private async alertOwnerOfSubscription(input: {
    subscription: any;
    payment?: any;
    event?: string;
    orgId: string;
    billing: Billing;
    period: Period;
    alreadyKnown: boolean;
    isReplacement: boolean;
    previous?: {
      identifier?: string | null;
      subscriptionTier?: string | null;
      period?: string | null;
    } | null;
  }) {
    if (!this._ownerAlerts) return;
    try {
      const { subscription, payment, event, orgId, billing, period } = input;
      const notes = subscription.notes || {};
      const base = {
        source: 'razorpay' as const,
        organizationId: orgId,
        userId: notes.userId || null,
        tier: billing,
        period,
        paymentMethod: subscription.payment_method || payment?.method || null,
      };
      const date = (sec: unknown) =>
        Number(sec) > 0 ? formatBillingDate(new Date(Number(sec) * 1000)) : null;

      if (event === 'subscription.charged') {
        await this.alertOwnerOfCharge({
          subscription,
          payment,
          orgId,
          billing,
          period,
          isReplacement: input.isReplacement,
        });
      }

      const prevTier = input.previous?.subscriptionTier
        ? String(input.previous.subscriptionTier)
        : null;
      const prevPeriod = input.previous?.period
        ? String(input.previous.period)
        : null;
      if (
        prevTier &&
        prevTier !== 'FREE' &&
        (prevTier !== billing || (!!prevPeriod && prevPeriod !== period))
      ) {
        const plan = await this.readPlan(subscription.plan_id).catch(() => null);
        const price = Number(plan?.item?.amount || 0);
        const previousId = input.previous?.identifier;
        await this._ownerAlerts.notify({
          ...base,
          event: 'PLAN_CHANGED',
          key: `plan:${subscription.id}:${prevTier}:${prevPeriod || ''}->${billing}:${period}`,
          previousTier: prevTier,
          previousPeriod: prevPeriod,
          amount: price ? price / 100 : null,
          currency: plan?.item?.currency || notes.currency || null,
          amountNote: price ? `new plan price per ${period === 'YEARLY' ? 'year' : 'month'}` : null,
          ids: {
            subscription: subscription.id,
            previousSubscription:
              previousId && previousId !== subscription.id ? previousId : null,
          },
          notes: [
            notes.trial === '1' && notes.replaces
              ? `Switched during the trial; first charge ${date(subscription.start_at) || 'later'}`
              : null,
          ],
        });
        return;
      }

      // Only from the call that first put this subscription on file (the
      // webhook and the checkout callback can both be that call; the key
      // makes it one email). A later delivery cannot tell a new trial from
      // a paid plan's next mandate, so it sends nothing.
      if (input.alreadyKnown) return;

      // A Reactivate counts whether or not it was a trial (a cancelled
      // trial reactivated carries notes.trial); a payment-method change
      // during a trial is no news.
      if (
        input.isReplacement &&
        (notes.trial !== '1' || notes.reason === 'reactivate')
      ) {
        const why =
          notes.reason === 'reactivate'
            ? notes.trial === '1'
              ? 'Reactivated a cancelled trial'
              : 'Reactivated a plan that was set to end'
            : notes.reason === 'payment_method'
            ? 'Changed how the plan is paid'
            : null;
        await this._ownerAlerts.notify({
          ...base,
          event: 'NEW_MANDATE',
          key: `mandate:${subscription.id}`,
          ids: {
            subscription: subscription.id,
            previousSubscription: notes.replaces ? String(notes.replaces) : null,
          },
          notes: [
            why,
            date(subscription.start_at)
              ? `Next charge on this mandate ${date(subscription.start_at)}`
              : null,
          ],
        });
        return;
      }

      if (startsNewTrial(subscription)) {
        const terms = await this.trialChargeTerms(subscription, billing, period);
        const first = firstChargeAt(subscription);
        const days = first
          ? Math.round((first.getTime() - Date.now()) / 86_400_000)
          : null;
        await this._ownerAlerts.notify({
          ...base,
          event: 'TRIAL_STARTED',
          key: `start:${subscription.id}`,
          amount: terms?.amount ?? null,
          currency: terms?.currency ?? null,
          amountNote: first
            ? `first charge on ${formatBillingDate(first)}`
            : 'first charge after the trial',
          ids: { subscription: subscription.id },
          notes: [
            days ? `${days}-day trial, nothing charged yet (the Rs 5 mandate check is refunded by Razorpay)` : null,
          ],
        });
      }
    } catch (e: any) {
      this.logger.error(
        `Owner sale alert for ${input.subscription?.id} failed: ${e?.message || e}`
      );
    }
  }

  /**
   * subscription.charged with money taken: the first charge of a
   * subscription, the first charge of a mandate opened while the workspace
   * already had a plan (notes.previous_plan, a UPI plan change), or a
   * renewal (a later charge, or a Reactivate / Change payment method mandate
   * continuing a paid plan). Keyed on the payment id. `supersededBy`: the
   * charge landed on a plan another subscription had already replaced.
   * Never throws.
   */
  private async alertOwnerOfCharge(input: {
    subscription: any;
    payment?: any;
    orgId: string;
    billing: Billing;
    period: Period;
    isReplacement: boolean;
    supersededBy?: string;
  }) {
    if (!this._ownerAlerts) return;
    try {
      const { subscription, payment, orgId, billing, period } = input;
      if (!payment?.id || !(Number(payment.amount) > 0)) return;
      const notes = subscription.notes || {};
      const paidCount = Number(subscription.paid_count || 0);
      // A Reactivate or Change payment method mandate continues a plan
      // already paid for, so its first charge is a renewal; one opened
      // during a trial (notes.trial) is the trial converting.
      const continuing = input.isReplacement && notes.trial !== '1';
      const first = !continuing && paidCount <= 1;
      const until =
        Number(subscription.current_end) > 0
          ? formatBillingDate(new Date(Number(subscription.current_end) * 1000))
          : null;
      await this._ownerAlerts.notify({
        event: first
          ? notes.previous_plan && notes.trial !== '1'
            ? 'NEW_PLAN_CHARGE'
            : 'FIRST_CHARGE'
          : 'RENEWAL',
        key: `charge:${payment.id}`,
        source: 'razorpay',
        organizationId: orgId,
        userId: notes.userId || null,
        tier: billing,
        period,
        amount: Number(payment.amount) / 100,
        currency: payment.currency || 'INR',
        paymentMethod: payment.method || subscription.payment_method || null,
        ids: {
          payment: payment.id,
          subscription: subscription.id,
          previousSubscription:
            first && notes.previous_plan ? String(notes.previous_plan) : null,
        },
        notes: [
          paidCount ? `Charge number ${paidCount} on this subscription` : null,
          until ? `Paid until ${until}` : null,
          input.supersededBy
            ? `This subscription was already replaced by ${input.supersededBy} and is being cancelled: check whether this charge should be refunded`
            : null,
        ],
      });
    } catch (e: any) {
      this.logger.error(
        `Owner charge alert for ${input.subscription?.id} failed: ${e?.message || e}`
      );
    }
  }

  /**
   * subscription.pending / subscription.halted for a subscription that is
   * positively Hookpost's (its own stored row, or notes.service with an
   * orgId): the owner hears that a charge is failing, once per billing cycle.
   */
  private async alertOwnerOfFailure(
    subscription: any,
    payment: any,
    type: string,
    activeUntil: Date | null,
    /** The halt ended the plan here and now (scheduleHaltedRenewalEnd). */
    endedNow = false
  ) {
    if (!this._ownerAlerts || !subscription?.id) return;
    try {
      const notes = subscription.notes || {};
      const row = await this._subscriptionService
        .getSubscriptionByIdentifier(subscription.id)
        .catch(() => null);
      const orgId: string | undefined =
        row?.organizationId ||
        (notes.service === 'hookpost' && notes.orgId ? notes.orgId : undefined);
      if (!orgId) return;

      const halted = type === 'subscription.halted';
      const fromPlan = await this.resolveTierFromPlan(subscription.plan_id).catch(
        () => null
      );
      const plan = payment?.amount
        ? null
        : await this.readPlan(subscription.plan_id).catch(() => null);
      const amount = payment?.amount
        ? Number(payment.amount) / 100
        : plan?.item?.amount
        ? Number(plan.item.amount) / 100
        : null;
      const cycle = failingCycleStart(subscription);
      const unpaidTrial = isTrialFirstCharge(subscription);
      this.alertOwner({
        event: halted ? 'HALTED' : 'PAYMENT_FAILING',
        key: `${halted ? 'halted' : 'failing'}:${subscription.id}:${cycle}`,
        source: 'razorpay',
        organizationId: orgId,
        userId: notes.userId || null,
        tier: fromPlan?.billing || row?.subscriptionTier || notes.billing || null,
        period: fromPlan?.period || row?.period || notes.period || null,
        amount,
        currency: payment?.currency || plan?.item?.currency || notes.currency || null,
        amountNote: 'not collected',
        paymentMethod: subscription.payment_method || payment?.method || null,
        ids: { subscription: subscription.id, payment: payment?.id || null },
        notes: [
          unpaidTrial
            ? "The trial's first charge failed; AI and X are off until a retry goes through"
            : halted
            ? 'Razorpay stopped retrying this renewal'
            : 'A renewal charge failed; Razorpay is retrying, and AI and X are off meanwhile',
          payment?.error_description
            ? `Bank said: ${cleanLine(payment.error_description, 160)}`
            : null,
          endedNow
            ? 'Nothing was paid for past today, so the plan ended now'
            : activeUntil
            ? `Plan kept until ${formatBillingDate(activeUntil)}, then Hookpost ends it unless it is paid`
            : null,
        ],
      });
    } catch (e: any) {
      this.logger.error(
        `Owner failure alert for ${subscription?.id} failed: ${e?.message || e}`
      );
    }
  }

  /**
   * What a trial's first charge will be: its own plan's amount and currency
   * (a subscriber keeps the price they signed up at), and how it is paid.
   * Null when the amount cannot be read, so no email names a wrong amount.
   */
  private async trialChargeTerms(
    subscription: any,
    billing?: Billing | string | null,
    period?: Period | string | null
  ): Promise<TrialChargeTerms | null> {
    try {
      const plan = await this.readPlan(subscription?.plan_id);
      const terms = chargedPlanTerms({
        plan,
        tier: await this.resolveTierFromPlan(subscription?.plan_id),
        row: { subscriptionTier: billing || null, period: period || null },
        subscriptionNotes: subscription?.notes,
      });
      if (!terms.amount) return null;
      return {
        amount: terms.amount,
        currency: terms.currency,
        period: terms.period,
        paymentMethod: subscription?.payment_method || null,
      };
    } catch (e) {
      this.logger.warn(`Could not read the trial's charge for ${subscription?.id}: ${e}`);
      return null;
    }
  }

  /**
   * `firstCharge` is when Razorpay will take the first payment. More than half
   * a day away means the customer is in a free trial (TRIAL_DAYS by default,
   * plus any free-months coupon), and the email states the real length and
   * date rather than assuming one. `status === 'authenticated'` is not a trial
   * signal: a paid-upfront subscription is also `authenticated` for a moment.
   */
  async sendSubscriptionWelcomeEmail(
    orgId: string,
    billing: Billing,
    period: Period,
    firstCharge: Date | null,
    subscription?: any
  ): Promise<boolean> {
    try {
      const org = await this._organizationService.getOrgById(orgId);
      const orgName = org?.name || 'Your Team';

      const channels = pricing[billing]?.channel || 10;
      const msUntilCharge = firstCharge ? firstCharge.getTime() - Date.now() : 0;
      // A first charge days away is a trial only on a subscription opened to
      // charge later: a bank e-mandate paid at once has its first debit a
      // banking day out too, and is not one.
      const isTrial =
        msUntilCharge > TRIAL_MIN_LEAD_MS &&
        (!subscription || subscription.notes?.trial === '1' || startsLater(subscription));
      // While the trial policy is on, a trial's welcome states what will be
      // charged and how to stop it (amount, date, cancel link, UPI revoke).
      const charge =
        isTrial && subscription && trialPolicyActive()
          ? await this.trialChargeTerms(subscription, billing, period)
          : null;
      // sendCustomerEmail reports false on a failed send, so sendOnce frees
      // the welcome:<id> claim and a redelivered webhook can try again.
      return await this.sendCustomerEmail(
        orgId,
        subscriptionWelcomeEmail({
          orgName,
          billing,
          channels,
          period,
          isTrial,
          trialDays: isTrial ? Math.round(msUntilCharge / 86_400_000) : undefined,
          firstChargeAt: isTrial ? firstCharge! : undefined,
          charge,
        }),
        'Hookpost Support <support@hookstep.in>'
      );
    } catch (err) {
      this.logger.error(`Error sending subscription welcome email: ${err}`);
      return false;
    }
  }

  async sendPaymentFailedEmail(
    orgId: string,
    details: {
      billing?: Billing;
      period?: Period;
      amount?: number;
      currency?: string;
      reason?: string;
      isHalted?: boolean;
      firstChargeRetrying?: boolean;
      /** A halted renewal: the plan keeps working until then (scheduleHaltedRenewalEnd). */
      activeUntil?: Date | null;
    }
  ): Promise<boolean> {
    try {
      const apiKey = process.env.RESEND_API_KEY || '';
      if (!apiKey) return false;

      const team = await this._organizationService.getTeam(orgId);
      const user = team?.users?.[0]?.user;
      const email = user?.email;
      const org = await this._organizationService.getOrgById(orgId);
      const orgName = org?.name || 'Your Team';

      if (!email || !email.includes('@')) return false;

      const { Resend } = await import('resend');
      const resend = new Resend(apiKey);

      const { subject, html, text } = paymentFailedEmail({
        orgName,
        billing: details.billing,
        amount: details.amount,
        currency: details.currency,
        reason: details.reason,
        isHalted: details.isHalted,
        firstChargeRetrying: details.firstChargeRetrying,
        activeUntil: details.activeUntil,
      });

      // Resend answers a refused send with { error } rather than throwing;
      // false frees the sendOnce claim so the next retry's webhook can send.
      const res: any = await resend.emails.send({
        from: 'Hookpost Billing <support@hookstep.in>',
        to: email,
        reply_to: 'support@hookstep.in',
        subject,
        html,
        text,
      });
      if (res?.error) {
        this.logger.error(
          `Payment failed email for org ${orgId} was refused: ${res.error.message || res.error}`
        );
        return false;
      }

      this.logger.log(
        `Payment failed notification email sent to ${email} for org ${orgId}`
      );
      return true;
    } catch (err) {
      this.logger.error(`Error sending payment failed email: ${err}`);
      return false;
    }
  }

  private async handleFailedSubscriptionPayment(
    subscription: any,
    payment?: any,
    type?: string,
    activeUntil?: Date | null
  ) {
    try {
      if (!subscription?.id) return;
      const notes = subscription.notes || {};
      let orgId: string | undefined = notes.orgId;

      if (!orgId) {
        const subRecord = await this._subscriptionService.getSubscriptionByIdentifier(subscription.id);
        orgId = subRecord?.organizationId;
      }
      if (!orgId && subscription.customer_id) {
        const org = await this._organizationService.getOrgByCustomerId(subscription.customer_id);
        orgId = org?.id;
      }

      if (!orgId) {
        this.logger.warn(`Cannot resolve orgId for failing subscription ${subscription.id}`);
        return;
      }

      const fromPlan = await this.resolveTierFromPlan(subscription.plan_id);
      const billing = fromPlan?.billing || (notes.billing ? notes.billing.toUpperCase() : undefined);
      const period = fromPlan?.period || (notes.period ? notes.period.toUpperCase() : undefined);

      // A webhook's subscription carries only plan_id, and pending can come
      // without a payment: read the plan for the amount and currency, as the
      // owner alert does, so a dollar plan is never told about UPI or rupees.
      const plan = payment?.amount
        ? null
        : await this.readPlan(subscription.plan_id).catch(() => null);
      const amount = payment?.amount
        ? Number(payment.amount) / 100
        : plan?.item?.amount
        ? Number(plan.item.amount) / 100
        : undefined;
      const currency =
        payment?.currency || plan?.item?.currency || notes.currency || 'INR';
      // No bank reason: the email picks a card or UPI line by currency.
      const halted = type === 'subscription.halted';
      const reason =
        payment?.error_description ||
        (halted ? 'Bank retries exhausted — subscription renewal halted' : undefined);
      // One email per billing cycle while Razorpay retries: it fires
      // subscription.pending again on every failed attempt. A halt is its
      // own email (the renewal is paused, and the date the plan ends).
      const orgIdForEmail = orgId;
      await this.sendOnce(
        `payment-failed:${subscription.id}:${failingCycleStart(subscription)}${
          halted ? ':halted' : ''
        }`,
        () =>
          this.sendPaymentFailedEmail(orgIdForEmail, {
            billing,
            period,
            amount,
            currency,
            reason,
            isHalted: halted,
            // A trial's first charge failing is not a lapsed renewal: Razorpay
            // retries it over the next days, and both live trials that
            // converted were captured on such a retry.
            firstChargeRetrying:
              type === 'subscription.pending' && isTrialFirstCharge(subscription),
            activeUntil,
          })
      );
    } catch (err) {
      this.logger.error(`Error handling failed subscription payment for ${subscription?.id}: ${err}`);
    }
  }

  /**
   * payment.failed. Sends nothing to the customer:
   * - A payment on a Hookpost subscription's invoice: Razorpay also fires
   *   subscription.pending (or .halted) for it, which sends the one failure
   *   email for the cycle. Emailing here too sent two contradicting emails
   *   per attempt.
   * - Anything else (the Rs 5 mandate check abandoned at checkout, another
   *   product's payment on this shared account): the customer was never
   *   charged for a Hookpost plan, so there is nothing to tell them.
   * So nothing is looked up either; the log names the invoice, if any.
   */
  private async handlePaymentFailedWebhook(payment: any) {
    this.logger.log(
      `payment.failed ${payment?.id || '(no id)'}${
        payment?.invoice_id ? ` (invoice ${payment.invoice_id})` : ' (no invoice)'
      }: no email; subscription.pending / halted sends the failure email.`
    );
  }

  /**
   * Directly fetch subscription details from Razorpay and provision entitlements.
   * Useful when verifying subscription payment immediately from checkout callback.
   *
   * `trial` is true when this checkout started a new trial (startsNewTrial),
   * which is when the page sends the customer on to /launches and reports
   * StartTrial. A plan switch or a new payment method during a trial
   * continues the trial already counted, so it is false there.
   */
  async syncSubscriptionById(
    subscriptionId: string
  ): Promise<{ ok: boolean; subscription?: any; trial: boolean }> {
    if (!subscriptionId) return { ok: false, trial: false };
    try {
      const subscription = await this.client.request(
        'GET',
        `/subscriptions/${subscriptionId}`
      );
      if (subscription?.id) {
        await this.createSubscription(subscription);
        return {
          ok: true,
          subscription,
          trial: startsNewTrial(subscription),
        };
      }
    } catch (e) {
      this.logger.error(`syncSubscriptionById failed for ${subscriptionId}: ${e}`);
    }
    return { ok: false, trial: false };
  }

  async updateSubscription(subscription: any) {
    // Razorpay sends the full entity on update, so activation and update
    // converge on the same reconciliation path.
    return this.createSubscription(subscription);
  }

  /**
   * Cancel/complete/expire. This must positively identify the subscription as
   * ours before touching anything.
   *
   * Razorpay customers are account-level, and one Razorpay account can serve
   * several products, each with its own webhook subscribed to the same events.
   * So a cancellation raised by a *different* product is delivered here too,
   * carrying a customer_id that may well match a paying Hookpost organization.
   * Keying the downgrade off customer_id alone would strip that organization's
   * plan because of an event that had nothing to do with Hookpost.
   *
   * The subscription id is the thing that is unambiguously ours or not: we
   * store it as Subscription.identifier when the plan is created. No stored
   * row, no action - and the downgrade is then scoped to the organization that
   * actually owns that row rather than to every org sharing the customer.
   */
  async deleteSubscription(subscription: any) {
    if (!subscription?.id) return { ok: true };

    const known = await this._subscriptionService.getSubscriptionByIdentifier(
      subscription.id
    );

    if (!known) {
      this.logger.warn(
        `Ignoring ${subscription.id}: no Hookpost subscription with that ` +
          `identifier (customer ${subscription.customer_id}). Likely another ` +
          `product on the same Razorpay account.`
      );
      return { ok: true };
    }

    await this._subscriptionService.deleteSubscriptionByOrg(
      known.organizationId
    );
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Cancellation and refund emails
  // ---------------------------------------------------------------------------

  /**
   * subscription.cancelled, from the customer or from the Razorpay dashboard.
   *
   * Razorpay only sends this once the subscription has actually stopped: at
   * the end of the cycle for a scheduled cancellation, straight away for an
   * immediate one. An immediate cancel mid-cycle leaves current_end in the
   * future, and the customer has paid for that time - the cancellation policy
   * promises they keep it. So the plan stays until current_end (the hourly
   * endLapsedCancellations sweep closes it), unless a charge on the
   * subscription was refunded (subscriptionRefunded), in which case it ends
   * now.
   *
   * A replacement mandate (Reactivate, Change payment method) has no
   * current_end before its first charge, but the time up to its start_at was
   * paid for on the plan it replaced (notes.replaces), so that is the paid
   * end, and a refund is looked for on that plan.
   *
   * Positively identified like deleteSubscription: no stored Subscription row
   * with this identifier, no action and no email.
   *
   * A trial that never took a payment (isUnpaidTrial) has no paid time, even
   * where Razorpay has set a current_end for the first charge it tried and
   * failed to take. `unpaidTrialEnded` is set by endHaltedUnpaidTrial, where
   * Hookpost ended it rather than the customer.
   *
   * A trial cancelled before its first charge was due (trialAccessUntil, its
   * start_at still ahead) keeps working until that date, with no charge:
   * Razorpay cancels a trial's mandate at once, so without this the customer
   * lost the days they were promised. The hourly sweep ends it on the date.
   * This is for every workspace: one created before the trial cutoff moves to
   * Free on that date instead of straight away, a new-cohort one is paused.
   * A trial whose first charge is overdue (pending, halted) ends now.
   *
   * So does a plan whose last renewal was never paid (paidThrough): Razorpay
   * has already moved current_end to the end of that unpaid cycle, and
   * keeping the plan until then gave away a month (sub_TYd1D4gZnW0EP2,
   * cancelled 20 Oct 2026 after its renewal halted, was kept to 12 Nov).
   * `unpaidRenewalEnded` is set by the sweep that ends a halted renewal once
   * its paid time is up (endHaltedRenewal), where Hookpost ended it rather than the
   * customer. It only changes the email: the plan still runs to the end of
   * any time paid for (paidThrough), as for any other cancellation.
   */
  async handleCancelled(
    subscription: any,
    opts: {
      unpaidTrialEnded?: boolean;
      unpaidRenewalEnded?: boolean;
      /**
       * Hookpost ended a plan whose first debit never landed and that was
       * not a trial (endUnpaidFirstCharge, or a halted first charge of a
       * plan paid at once). Nothing was paid, so nothing is kept.
       */
      unpaidFirstChargeEnded?: boolean;
      /**
       * The customer paused AutoPay outside Hookpost and Hookpost stopped
       * the mandate (handlePausedByCustomer). An ordinary cancel otherwise:
       * the time paid for is kept. Only the wording and the alert differ.
       */
      pausedByCustomer?: boolean;
      // Whether a charge on the subscription was refunded, when the caller
      // has already looked (cancelAtPeriodEnd, handleRefund): `true` it
      // found one, `false` there is none. Left out, this looks for itself.
      endedByRefund?: boolean;
      /**
       * A bank reported a dispute on one of its payments
       * (endDisputedSubscription): the plan ends now, as a refund ends it,
       * and no paid time is kept. Only the wording differs: the customer
       * gets the dispute email, not the refund one.
       */
      endedByDispute?: boolean;
    } = {}
  ) {
    if (!subscription?.id) return { ok: true };

    const known = await this._subscriptionService.getSubscriptionByIdentifier(
      subscription.id
    );
    if (!known) {
      this.logger.warn(
        `Ignoring cancellation of ${subscription.id}: no Hookpost subscription ` +
          `with that identifier (customer ${subscription.customer_id}).`
      );
      return { ok: true };
    }

    const orgId = known.organizationId;
    const trialEndSec = trialAccessUntil(subscription);
    const trialLeft = trialEndSec * 1000 > Date.now() + 60_000;
    const replacementEnd = replacementPaidUntil(subscription);
    const paidEndSec = isUnpaidTrial(subscription)
      ? 0
      : paidThrough(subscription) || replacementEnd;
    const paidEnd = paidEndSec ? new Date(paidEndSec * 1000) : null;
    const periodLeft =
      !trialLeft && !!paidEnd && paidEnd.getTime() > Date.now() + 60_000;
    // Nothing was paid on a trial, so there is no refund to look for (the
    // Rs 5 mandate check is refunded by Razorpay itself and says nothing).
    const refunded = periodLeft
      ? opts.endedByDispute
        ? true
        : opts.endedByRefund ??
          (await this.subscriptionRefunded(
          replacementEnd ? String(subscription.notes.replaces) : subscription.id
        ))
      : false;
    const fromRemote = trialLeft
      ? new Date(trialEndSec * 1000)
      : periodLeft && !refunded
      ? paidEnd
      : null;

    // What the row already says wins, whenever it says more.
    //
    // Cancel (cancelAtPeriodEnd) stops the subscription at Razorpay at once
    // and writes the paid end here; Razorpay's subscription.cancelled then
    // arrives seconds later on a subscription that is `cancelled` with
    // ended_at set to now. Read only from that payload, a customer who has
    // paid to 11 Nov would lose their plan today. The row is what grants
    // access, so a date already saved on it is honoured to the end -- and
    // only ever extended here, never cut short, so a cancel made in the UPI
    // app or the dashboard still ends a plan nothing was paid for.
    //
    // Only when the subscription simply ended. Not when Hookpost is the one
    // ending the plan -- a trial whose first charge never went through
    // (endHaltedUnpaidTrial) or a renewal left unpaid past its paid time
    // (endHaltedRenewal) -- because the date on the row is that end, and
    // the caller has just decided it is up. Not when a charge was refunded
    // either: there is no paid time left to keep, and the refund paths have
    // already set the row to end now.
    //
    // Nor when the current cycle was never paid (currentCycleUnpaid): then
    // the date on the row is the end set for a halted renewal
    // (scheduleHaltedRenewalEnd), not time anybody paid for, and a customer
    // who revokes the mandate in their UPI app must not keep it.
    // A halted first charge reaches here as an unpaid trial; a plan that was
    // to be paid at once (no start_at: a bank e-mandate debits a banking day
    // after checkout) is told its plan did not start, not that a trial ended.
    const firstChargeEnded =
      !!opts.unpaidFirstChargeEnded ||
      (!!opts.unpaidTrialEnded &&
        subscription.notes?.trial !== '1' &&
        !startsLater(subscription));
    const trialEnded = !!opts.unpaidTrialEnded && !firstChargeEnded;
    const hookpostEnded =
      !!opts.unpaidTrialEnded ||
      !!opts.unpaidRenewalEnded ||
      !!opts.unpaidFirstChargeEnded ||
      refunded ||
      currentCycleUnpaid(subscription);
    const savedEnd = known.cancelAt ? new Date(known.cancelAt) : null;
    const savedAhead =
      !hookpostEnded && !!savedEnd && savedEnd.getTime() > Date.now() + 60_000;
    const keepUntil =
      savedAhead && (!fromRemote || savedEnd!.getTime() > fromRemote.getTime())
        ? savedEnd
        : fromRemote;

    if (keepUntil) {
      await this._subscriptionService.scheduleCancellation(
        orgId,
        subscription.id,
        keepUntil
      );
    } else {
      await this._subscriptionService.deleteSubscriptionByOrg(orgId);
    }

    // Changing plan on a UPI mandate issues a new subscription, and the old one
    // is cancelled once the new one is authorised (see createSubscription /
    // retireSupersededSubscriptions). That customer is switching, not
    // leaving, so "your plan is cancelled" would be wrong.
    if (await this.hasReplacementSubscription(orgId, subscription)) {
      this.logger.log(
        `Cancellation of ${subscription.id} is a plan switch for org ${orgId}; no email.`
      );
      return { ok: true };
    }

    // The owner, once per subscription: the same key as the alert sent when
    // the customer pressed Cancel (cancelAtPeriodEnd), so a cancellation
    // made in Billing is reported once, and one made anywhere else (the UPI
    // app, the Razorpay dashboard, Hookpost ending an unpaid plan) here.
    // While Billing's cancel is in flight (marked) its own alert is the one.
    const billingCancelInFlight = await this._ownerAlerts?.isMarked(
      `cancel:${subscription.id}`
    );
    if (!billingCancelInFlight) {
      this.alertOwner({
        event: 'CANCELLED',
        key: `cancel:${subscription.id}`,
        source: 'razorpay',
        organizationId: orgId,
        userId: subscription.notes?.userId || null,
        tier: known.subscriptionTier,
        period: known.period,
        paymentMethod: subscription.payment_method || null,
        ids: { subscription: subscription.id },
        notes: [
          keepUntil
            ? `Access until ${formatBillingDate(keepUntil)}, then the plan ends`
            : 'The plan ended now',
          trialLeft ? 'Cancelled during the trial; nothing was charged' : null,
          opts.endedByDispute
            ? 'A payment on it was disputed (chargeback), so the plan ended now'
            : refunded
            ? 'A charge on it was refunded'
            : null,
          trialEnded
            ? "Hookpost ended it: the trial's first charge failed on every retry"
            : null,
          firstChargeEnded
            ? 'Hookpost ended it: the first debit never went through, so nothing was paid'
            : null,
          opts.pausedByCustomer
            ? 'The customer paused AutoPay in their UPI app or bank, so Hookpost cancelled the mandate'
            : null,
          opts.unpaidRenewalEnded
            ? 'Hookpost ended it: the renewal stayed unpaid and the time paid for had run out'
            : null,
        ],
      });
    }

    await this.sendOnce(`cancelled:${subscription.id}`, async () => {
      const org = await this._organizationService.getOrgById(orgId);
      // Ended now (no paid time left): this email is the day-0 notice too.
      const send = async (mediaKeptUntil: Date | null) =>
        this.sendCustomerEmail(
          orgId,
          subscriptionCancelledEmail({
            orgName: org?.name || 'your workspace',
            billing: known.subscriptionTier,
            period: known.period,
            accessUntil: keepUntil,
            endedAt: subscription.ended_at
              ? new Date(subscription.ended_at * 1000)
              : new Date(),
            unpaidTrialEnded: trialEnded && !keepUntil,
            unpaidRenewalEnded: !!opts.unpaidRenewalEnded && !keepUntil,
            unpaidFirstChargeEnded: firstChargeEnded && !keepUntil,
            pausedByCustomer: !!opts.pausedByCustomer,
            trialCancelled: trialLeft,
            endedByRefund: refunded && !keepUntil && !opts.endedByDispute,
            // Cancelled (ended_at, else now) inside the day before the first
            // charge: the bank may already have that debit.
            firstDebitMayBeUnderway:
              trialLeft &&
              trialEndSec -
                Number(subscription.ended_at || Math.floor(Date.now() / 1000)) <
                FIRST_DEBIT_LEAD_SEC,
            // What it falls back to when the plan ends: at keepUntil, or now.
            ...(await this.freePlanFor(orgId, keepUntil)),
            mediaKeptUntil,
          }),
          'Hookpost Billing <support@hookstep.in>'
        );
      return keepUntil ? send(null) : this.withMediaKeptUntil(orgId, send);
    });
    return { ok: true };
  }

  /**
   * What the workspace falls back to when its plan ends at `at` (now by
   * default), for the billing emails (trial.policy.ts): the Free plan, with
   * the date that Free plan itself ends when FREE_PLAN_SUNSET_AT reaches the
   * workspace, or a pause (freePlanAvailable false). A plan that ends after
   * the sunset is paused, not moved to Free. Every workspace keeps an endless
   * Free plan while the trial policy is off, without reading anything.
   */
  private async freePlanFor(
    orgId: string,
    at?: Date | null
  ): Promise<{ freePlanAvailable: boolean; freePlanEndsAt: Date | null }> {
    const cutoffs = trialCutoffs();
    if (!trialPolicyActive(cutoffs)) {
      return { freePlanAvailable: true, freePlanEndsAt: null };
    }
    const paused = await this._subscriptionService
      .inNewCohort(orgId, at || undefined)
      .catch(() => false);
    if (paused) return { freePlanAvailable: false, freePlanEndsAt: null };
    if (!cutoffs.sunset) return { freePlanAvailable: true, freePlanEndsAt: null };
    let freePlanEndsAt: Date | null = null;
    try {
      freePlanEndsAt = await this._subscriptionService.getFreePlanSunsetAt(orgId);
    } catch {
      // Unreadable: the plain Free line, as before the sunset existed.
    }
    return { freePlanAvailable: true, freePlanEndsAt };
  }

  /**
   * subscription.pending / subscription.halted: remember on the workspace's
   * plan row that its charges are failing, which is what takes AI and X off
   * it (trial.policy.ts `dunning`), a trial's first charge and a renewal
   * alike. Cleared by clearPaymentFailing when a charge goes through.
   *
   * Only the subscription the workspace is actually on, opened by Hookpost
   * for it, and only while Razorpay still says it is failing: a webhook
   * redelivered after the retry succeeded (Razorpay retries a webhook for up
   * to 24 hours) must not take AI off a workspace that has paid. A marker already
   * on file keeps its own date (setPaymentFailing), so the retries that
   * follow do not push it forward. Never throws: the failure email and the
   * owner alert still have to go out.
   */
  private async markPaymentFailing(subscription: any, type: string) {
    const orgId: string | undefined = subscription?.notes?.orgId;
    if (!subscription?.id || !orgId || !isOrgSubscription(subscription, orgId)) {
      return;
    }
    try {
      const stored = await this._subscriptionService.getSubscription(orgId);
      // A lifetime plan has no charge to fail, and a plan the workspace has
      // already moved off is not its plan.
      if (stored?.identifier !== subscription.id || stored?.isLifetime) return;

      const remote = await this.client
        .request('GET', `/subscriptions/${subscription.id}`)
        .catch(() => null);
      // Unreadable: trust the webhook, which Razorpay signed. Readable and
      // no longer failing: this is a late delivery, leave the plan alone.
      if (remote && !DUNNING_STATES.includes(remote.status)) {
        this.logger.log(
          `${type} for ${subscription.id} is stale (Razorpay says ${remote.status}); not marking org ${orgId} as failing.`
        );
        return;
      }

      const marked = await this._subscriptionService.markPaymentFailing(
        orgId,
        subscription.id,
        new Date()
      );
      if (marked) {
        this.logger.warn(
          `Org ${orgId} has a failing payment on ${subscription.id} (${type}).`
        );
      }
    } catch (e: any) {
      this.logger.error(
        `Could not mark ${subscription.id} as failing: ${e?.message || e}`
      );
    }
  }

  /**
   * subscription.authenticated / activated / charged: the mandate is approved
   * and the plan is being paid, so the failing-payment marker goes and the
   * workspace has its AI and X back with nobody doing anything
   * (markPaymentFailing). By identifier, which createSubscription has just
   * written to the row, so a replacement mandate taking a failing plan over
   * clears the marker of the plan it replaced. Never throws.
   *
   * Not while Razorpay still says this subscription is failing: an old
   * authenticated/activated/charged redelivered after a later `pending`
   * (webhooks arrive out of order and are retried for 24 hours) must not
   * give AI and X back to a plan nobody has paid. Unreadable: trust the
   * signed event, as markPaymentFailing does.
   */
  private async clearPaymentFailing(subscription: any) {
    if (!subscription?.id) return;
    try {
      const remote = await this.client
        .request('GET', `/subscriptions/${subscription.id}`)
        .catch(() => null);
      if (remote && DUNNING_STATES.includes(remote.status)) {
        this.logger.log(
          `${subscription.id} is still ${remote.status} at Razorpay; keeping the failing-payment marker.`
        );
        return;
      }
      const cleared = await this._subscriptionService.clearPaymentFailing(
        subscription.id
      );
      if (cleared) {
        this.logger.log(
          `${subscription.id} is paid again; cleared the failing-payment marker.`
        );
      }
    } catch (e: any) {
      this.logger.error(
        `Could not clear the failing-payment marker on ${subscription.id}: ${
          e?.message || e
        }`
      );
    }
  }

  /**
   * subscription.halted for a trial whose first charge never went through
   * (isHaltedUnpaidTrial): cancel it at Razorpay and end it here, the way a
   * cancellation does (handleCancelled). True when it was ended, so the
   * caller skips the "renewal paused, update your payment method" email.
   *
   * Only the subscription the workspace is on (its stored identifier), and
   * only one opened by Hookpost for that workspace. A halted renewal of a
   * paid plan, or a halted subscription the workspace has already moved off,
   * is left alone, as is everything when Razorpay refuses the cancel: then
   * the usual halted email goes out and nothing changes.
   */
  private async endHaltedUnpaidTrial(subscription: any): Promise<boolean> {
    if (!subscription?.id || !isHaltedUnpaidTrial(subscription)) return false;
    const orgId: string | undefined = subscription.notes?.orgId;
    if (!orgId || !isOrgSubscription(subscription, orgId)) return false;

    const stored = await this._subscriptionService.getSubscription(orgId);
    if (stored?.identifier !== subscription.id || stored?.isLifetime) {
      this.logger.warn(
        `Halted trial ${subscription.id} is not org ${orgId}'s current plan; leaving it.`
      );
      return false;
    }

    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${subscription.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      // Razorpay takes one cancel per subscription: it may already be.
      const remote = await this.client
        .request('GET', `/subscriptions/${subscription.id}`)
        .catch(() => null);
      if (remote?.status !== 'cancelled') {
        this.logger.error(
          `Could not end halted unpaid trial ${subscription.id} for org ${orgId}: ${e?.message || e}`
        );
        return false;
      }
      after = remote;
    }

    this.logger.warn(
      `Ended trial ${subscription.id} for org ${orgId}: its first charge failed on every retry.`
    );
    // Straight away rather than waiting for subscription.cancelled: that
    // webhook then finds no row and does nothing, and the email goes out
    // once either way (sendOnce on cancelled:<id>).
    await this.handleCancelled(
      { ...subscription, ...(after?.id ? after : {}), status: 'cancelled' },
      { unpaidTrialEnded: true }
    );
    return true;
  }

  /**
   * subscription.halted for a paid plan's renewal: Razorpay has stopped
   * retrying, and it never cancels a halted subscription by itself. The plan
   * ends at max(now, the end of the time paid for), saved as the plan's end
   * date like a cancellation: the billing page then shows when it ends, with
   * Reactivate, which charges the unpaid period on approval.
   *
   * There is no grace since 29 Oct 2026 (the owner's call), so a
   * halt whose cycle was never paid ends the plan now rather than a week
   * later; this does it here instead of waiting up to an hour for the sweep,
   * and a halt inside a cycle that was paid for still runs to the end of it.
   * Where the date is still ahead the hourly sweep ends it
   * (endLapsedCancellations), and a renewal paid in the meantime lifts the
   * date again (renewsPaidUp). Returns the date the plan keeps working
   * until, for the email, and whether the plan was ended here, in which case
   * handleCancelled has already told the customer.
   *
   * Only the subscription the workspace is on, opened by Hookpost for it, and
   * still halted when read again (a late webhook for a renewal since paid
   * does nothing). An end date already on file stays as it is: a redelivery
   * of this webhook does not push it back.
   */
  private async scheduleHaltedRenewalEnd(
    subscription: any
  ): Promise<{ activeUntil: Date | null; ended: boolean }> {
    const left = { activeUntil: null, ended: false };
    const orgId: string | undefined = subscription?.notes?.orgId;
    if (!subscription?.id || !orgId || !isOrgSubscription(subscription, orgId)) {
      return left;
    }
    try {
      const stored = await this._subscriptionService.getSubscription(orgId);
      if (stored?.identifier !== subscription.id || stored?.isLifetime) {
        return left;
      }
      if (stored.cancelAt) {
        const end = new Date(stored.cancelAt);
        return end.getTime() > Date.now()
          ? { activeUntil: end, ended: false }
          : left;
      }

      const remote = await this.client
        .request('GET', `/subscriptions/${subscription.id}`)
        .catch(() => null);
      if (remote && remote.status !== 'halted') return left;

      // Never before the end of the time paid for: a halted subscription
      // whose current cycle was paid keeps it all (paidThrough), and a
      // Reactivate or Change payment method mandate that halted before its
      // first charge keeps the time paid for on the plan it replaced
      // (replacementPaidUntil), which has no current_end of its own. Read the
      // same way handleCancelled reads it, so the two agree on the date.
      const now = Date.now();
      const billed = remote || subscription;
      const paidEnd = paidThrough(billed) || replacementPaidUntil(billed);
      const until = new Date(
        Math.max(now, paidEnd * 1000)
      );
      await this._subscriptionService.scheduleCancellation(
        orgId,
        subscription.id,
        until
      );
      // Nothing is paid for past this moment: end the plan now rather than
      // leave it running until the next sweep.
      if (until.getTime() <= now) {
        this.logger.warn(
          `Renewal of ${subscription.id} halted for org ${orgId} with nothing paid for; ending the plan now.`
        );
        const ended = await this.endHaltedRenewal(
          { organizationId: orgId, identifier: subscription.id },
          remote || subscription
        );
        // Razorpay refused the cancel: the date is on file (already past), so
        // the next sweep tries again and the customer gets the halted email,
        // which says the plan is ending now rather than naming a date.
        return { activeUntil: null, ended };
      }
      this.logger.warn(
        `Renewal of ${subscription.id} halted for org ${orgId}; the plan ends ${until.toISOString()} unless it is paid.`
      );
      return { activeUntil: until, ended: false };
    } catch (e: any) {
      this.logger.error(
        `Could not end the halted renewal of ${subscription.id}: ${e?.message || e}`
      );
      return left;
    }
  }

  /**
   * May the end date saved for this subscription be lifted? Only when both
   * the payload and a fresh read from Razorpay say it is paid more than a day
   * past that date and renewing (paidPastSavedEnd), so an out-of-date payload
   * never wipes a real cancellation. A cycle-end cancel the customer made is
   * saved as current_end and never qualifies, whether or not Razorpay shows
   * it in end_at; a renewal paid after a halt runs weeks past the end set when it halted.
   */
  private async renewsPaidUp(
    subscription: any,
    savedEnd: Date | string
  ): Promise<boolean> {
    if (!paidPastSavedEnd(subscription, savedEnd)) return false;
    const remote = await this.client
      .request('GET', `/subscriptions/${subscription.id}`)
      .catch(() => null);
    return remote?.id === subscription.id && paidPastSavedEnd(remote, savedEnd);
  }

  /**
   * The end set for a halted renewal has come (scheduleHaltedRenewalEnd) and it
   * is still halted: cancel it at Razorpay now and end the plan here, the
   * way endHaltedUnpaidTrial ends a trial. True when it was ended; when
   * Razorpay refuses, nothing changes and the next sweep tries again.
   */
  private async endHaltedRenewal(row: any, remote: any): Promise<boolean> {
    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${remote.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      // Razorpay takes one cancel per subscription: another process running
      // this sweep may have sent it.
      const again = await this.client
        .request('GET', `/subscriptions/${remote.id}`)
        .catch(() => null);
      if (again?.status !== 'cancelled') {
        this.logger.error(
          `Could not end halted renewal ${remote.id} for org ${row.organizationId}: ${e?.message || e}`
        );
        return false;
      }
      after = again;
    }
    this.logger.warn(
      `Ended ${remote.id} for org ${row.organizationId}: its renewal halted and nothing paid for was left.`
    );
    // Straight away, as in endHaltedUnpaidTrial: the subscription.cancelled
    // webhook then finds no row, and the email goes out once either way. An
    // unpaid cycle ends the plan now; any time that was paid for
    // (paidThrough) is still kept, as handleCancelled always does. A trial
    // lands here only when Razorpay refused endHaltedUnpaidTrial's cancel at
    // the time, and is told its trial ended.
    await this.handleCancelled(
      { ...remote, ...(after?.id ? after : {}), status: 'cancelled' },
      remote.status === 'paused'
        ? { pausedByCustomer: true }
        : isUnpaidTrial(remote)
        ? { unpaidTrialEnded: true }
        : { unpaidRenewalEnded: true }
    );
    return true;
  }

  /**
   * subscription.paused, or a paused mandate the pre-charge guard found.
   * Hookpost never pauses a subscription, so the customer did: in their UPI
   * app, or in their bank's card portal ("cardholders can pause, resume and
   * cancel active Subscriptions from the portal provided by the bank"). A
   * paused mandate is never charged and Hookpost has no paused plan, so left
   * alone the workspace kept its plan for nothing, for good.
   *
   * It is treated as a cancel made outside Hookpost: cancelled at Razorpay
   * now, and handleCancelled keeps the time already paid for, emails the
   * "works until" date once and alerts the owner. Reactivate in Billing opens
   * a new mandate from that date, so nothing is charged twice; a resume in
   * the app after this finds the mandate cancelled and charges nothing.
   * Where Razorpay will not cancel it, the plan is set to end when the paid
   * time does, and endLapsedCancellations stops it then.
   *
   * Only the workspace's own current subscription, still paused when read
   * again. Throws when Razorpay cannot be read, so the webhook is redelivered.
   * True when the plan was stopped or set to end.
   */
  async handlePausedByCustomer(subscription: any): Promise<boolean> {
    const orgId: string | undefined = subscription?.notes?.orgId;
    if (!subscription?.id || !orgId || !isOrgSubscription(subscription, orgId)) {
      return false;
    }
    const stored = await this._subscriptionService.getSubscription(orgId);
    if (stored?.identifier !== subscription.id || stored?.isLifetime) return false;
    const remote = await this.client.request(
      'GET',
      `/subscriptions/${subscription.id}`
    );
    if (remote?.status !== 'paused') return false;

    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${remote.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      const again = await this.client
        .request('GET', `/subscriptions/${remote.id}`)
        .catch(() => null);
      if (again?.status !== 'cancelled') {
        const until = new Date(
          Math.max(
            Date.now(),
            (paidThrough(remote) || replacementPaidUntil(remote)) * 1000
          )
        );
        if (!stored.cancelAt) {
          await this._subscriptionService.scheduleCancellation(orgId, remote.id, until);
        }
        this.logger.error(
          `Could not cancel paused ${remote.id} for org ${orgId}; the plan ends ${until.toISOString()}: ${e?.message || e}`
        );
        this.alertOwner({
          event: 'BILLING_MISMATCH',
          key: `paused:${remote.id}`,
          source: 'razorpay',
          organizationId: orgId,
          userId: remote.notes?.userId || null,
          tier: stored.subscriptionTier,
          period: stored.period,
          paymentMethod: remote.payment_method || null,
          ids: { subscription: String(remote.id) },
          notes: [
            'The customer paused AutoPay in their UPI app or bank, and Razorpay refused the cancel',
            `The plan ends ${formatBillingDate(until)}, when the time paid for does; the hourly sweep cancels the mandate then`,
          ],
        });
        return true;
      }
      after = again;
    }
    this.logger.warn(
      `Cancelled ${remote.id} for org ${orgId}: the customer paused it outside Hookpost.`
    );
    await this.handleCancelled(
      { ...remote, ...(after?.id ? after : {}), status: 'cancelled' },
      { pausedByCustomer: true }
    );
    return true;
  }

  /**
   * The pre-charge guard found the workspace's plan on a subscription that
   * never took its first payment and never will: still `created` well past
   * UNPAID_MANDATE_SETTLE_MS. /razorpay/verify grants the plan when Checkout
   * finishes, but a bank e-mandate is only registered then, its debit runs a
   * banking day later, and a debit that fails leaves the subscription
   * `created` with no pending, halted or cancelled webhook. Cancelled at
   * Razorpay and ended now; nothing was paid, so nothing is kept. True when
   * it was ended; when Razorpay refuses, the next hour tries again.
   */
  private async endUnpaidFirstCharge(row: any, remote: any): Promise<boolean> {
    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${remote.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      const again = await this.client
        .request('GET', `/subscriptions/${remote.id}`)
        .catch(() => null);
      if (!['cancelled', 'expired'].includes(String(again?.status))) {
        this.logger.error(
          `Could not end never-paid ${remote.id} for org ${row.organizationId}: ${e?.message || e}`
        );
        return false;
      }
      after = again;
    }
    this.logger.warn(
      `Ended ${remote.id} for org ${row.organizationId}: its first debit never went through.`
    );
    await this.handleCancelled(
      { ...remote, ...(after?.id ? after : {}), status: 'cancelled' },
      { unpaidFirstChargeEnded: true }
    );
    return true;
  }

  /**
   * refund.processed, and refund.created when Razorpay already reports the
   * refund as processed (a refund.processed for the same refund follows or
   * has already arrived; the email goes out once per refund id either way).
   * Throws only RefundReadUnknownError (Razorpay could not be read on
   * refund.processed), so the webhook answers 500 and Razorpay redelivers;
   * any other failure is logged and swallowed.
   *
   * Only refunds of a Hookpost subscription charge qualify, found through the
   * payment's invoice to a subscription tagged notes.service = 'hookpost'. The
   * Rs 5 mandate-authorisation payment Razorpay refunds by itself at every
   * checkout has no invoice and no notes, so it never produces an email.
   *
   * Any refund of a captured charge on the workspace's current subscription
   * (the one its row holds), of any amount and any period, ends the plan
   * now: cancelled at Razorpay and ended here (endRefundedSubscription). A
   * refund means the plan is not paid for (owner's decision, 29 Oct 2026).
   * If Razorpay refuses that cancel, the owner is told to cancel it by hand
   * and the customer's email waits until the plan is settled.
   *
   * The one exception: a refund on a subscription that is not the
   * workspace's current one (a superseded plan, e.g. a duplicate charge from
   * a plan change) leaves the current plan as it is, and the owner's alert
   * says which subscription was refunded.
   */
  async handleRefund(type: string, refund: any, payment?: any) {
    try {
      if (!refund?.id || !refund.payment_id) return;
      if (type === 'refund.created' && refund.status !== 'processed') return;

      // A refunded payment earns no affiliate commission. Only Hookpost
      // charges have commission rows, so this needs no service check, and it
      // comes before the auto-refund branch, which returns early.
      await this._affiliateService.voidForRefund(refund.payment_id, refund.id);

      // Hookpost's own automatic refund of a charge after cancel
      // (refundChargeAfterCancel): the plan stays cancelled and keeps its
      // saved end, so none of the "a refund ends the plan" handling below
      // applies. The customer's email goes out once under the same key.
      const refundNotes =
        refund.notes && typeof refund.notes === 'object' && !Array.isArray(refund.notes)
          ? refund.notes
          : {};
      if (refundNotes.auto === AUTO_REFUND_NOTE) {
        await this.handleAutoRefundWebhook(refund, payment);
        return;
      }
      // A read Razorpay refused (4xx) is an answer: the object is not there,
      // so there is nothing to act on. One it could not answer (5xx, a
      // timeout, a dropped connection, a 408 or a 429) leaves the refund
      // unknown.
      let unreadable = false;
      const read = async (path: string) =>
        this.client.request('GET', path).catch((e) => {
          if (!isRazorpayRefusal(e) || isRazorpayRetryLater(e)) unreadable = true;
          return null;
        });

      const pay =
        payment?.id === refund.payment_id
          ? payment
          : await read(`/payments/${refund.payment_id}`);
      const payService = pay?.notes?.service;
      if (payService && payService !== 'hookpost') return;

      let sub: any = null;
      let invoice: any = null;
      if (pay?.invoice_id) {
        invoice = await read(`/invoices/${pay.invoice_id}`);
        if (invoice?.subscription_id) {
          sub = await read(`/subscriptions/${invoice.subscription_id}`);
        }
      }

      // A read that failed could hide a refund that ends the plan, and
      // guessing goes the wrong way: the plan stays on and the customer is
      // emailed that it is unchanged. refund.created leaves it to
      // refund.processed, which always follows; refund.processed is the last
      // event there is, so the webhook fails and Razorpay redelivers it.
      if (unreadable) {
        if (type !== 'refund.created') {
          throw new RefundReadUnknownError(
            `Refund ${refund.id}: Razorpay could not be read, so whether it ends a plan is unknown; failing the webhook for a redelivery.`
          );
        }
        this.logger.warn(
          `Refund ${refund.id}: Razorpay could not be read; waiting for refund.processed.`
        );
        return;
      }
      if (
        type === 'refund.created' &&
        pay?.invoice_id &&
        (!invoice || (invoice.subscription_id && !sub))
      ) {
        this.logger.warn(
          `Refund ${refund.id}: could not read its invoice or subscription; waiting for refund.processed.`
        );
        return;
      }

      let orgId: string | undefined;
      if (sub) {
        if (sub.notes?.service !== 'hookpost' || !sub.notes?.orgId) return;
        orgId = sub.notes.orgId;
      } else if (payService === 'hookpost' && pay?.notes?.orgId) {
        orgId = pay.notes.orgId;
      }
      if (!orgId) return;

      const local = await this._subscriptionService.getSubscription(orgId);
      // No row, or a row without a paid tier, means no active plan.
      const localTier: string | null = local?.subscriptionTier
        ? String(local.subscriptionTier)
        : null;
      let billing: string | null =
        (sub && (await this.resolveTierFromPlan(sub.plan_id))?.billing) ||
        localTier;

      // A refund on another subscription than the one the workspace is on.
      const superseded = !!sub && local?.identifier !== sub.id;

      let plan: 'active' | 'cancelled' | 'none' = 'none';
      let endedByRefund = false;
      let endedGrace = false;
      let cancelFailed = false;
      // The emails name the plan the workspace is on, not the refunded one.
      if (superseded && localTier) billing = localTier;
      if (sub && ENDED_STATES.includes(sub.status)) {
        if (!superseded) {
          // The refunded subscription was only still on because of the
          // cancellation grace period. A refund ends that.
          await this._subscriptionService.deleteSubscriptionByOrg(orgId);
          plan = 'cancelled';
          endedGrace = true;
        } else {
          plan = localTier ? 'active' : 'cancelled';
        }
      } else if (sub) {
        // Only the plan the workspace is on is ended by its refund.
        const endsPlan =
          !superseded && !local?.isLifetime && hasRefund(pay, refund.amount);
        if (endsPlan && (await this.endRefundedSubscription(sub, orgId))) {
          plan = 'cancelled';
          endedByRefund = true;
        } else {
          plan = localTier ? 'active' : 'none';
          cancelFailed = endsPlan;
        }
      } else if (localTier) {
        plan = 'active';
      }

      const refundedPlan = sub
        ? await this.resolveTierFromPlan(sub.plan_id).catch(() => null)
        : null;
      this.alertOwner({
        event: 'REFUND',
        // A refused cancel has its own alert, so the one for the refund is
        // still free when a later refund event gets the cancel through.
        key: cancelFailed
          ? `refund-cancel-refused:${refund.id}`
          : `refund:${refund.id}`,
        source: 'razorpay',
        organizationId: orgId,
        userId: sub?.notes?.userId || null,
        tier: billing,
        period: refundedPlan?.period || local?.period || null,
        amount: Number(refund.amount || 0) / 100,
        currency: refund.currency || pay?.currency || 'INR',
        amountNote: 'refunded',
        ids: {
          refund: refund.id,
          payment: refund.payment_id,
          subscription: sub?.id || null,
        },
        notes: [
          pay?.amount
            ? `Original payment ${amountLabel(Number(pay.amount) / 100, pay.currency)}`
            : null,
          endedByRefund
            ? 'Refunded, so the plan ended now and the subscription is cancelled at Razorpay'
            : endedGrace
            ? 'Refunded during the cancellation grace period, so the plan ended now'
            : plan === 'cancelled'
            ? 'The plan has ended'
            : cancelFailed
            ? 'Refunded, so the plan should end, but Razorpay refused the cancel: cancel it in the dashboard'
            : superseded && localTier
            ? `${sub.id} is not the workspace's current subscription (${
                local?.identifier || 'none'
              }): the current plan is unaffected`
            : plan === 'active'
            ? 'Not a subscription charge: the plan is unchanged'
            : 'The workspace has no paid plan',
        ],
      });
      // The customer is told once the plan is settled: by a later refund
      // event that gets the cancel through (this email), or by the
      // cancelled email when it is cancelled by hand. Never "it renews".
      if (cancelFailed) return;

      await this.sendOnce(`refund:${refund.id}`, async () => {
        const org = await this._organizationService.getOrgById(orgId!);
        // The plan ended with this refund: the email is the day-0 notice too.
        const send = async (mediaKeptUntil: Date | null) =>
          this.sendCustomerEmail(
            orgId!,
            refundEmail({
              orgName: org?.name || 'your workspace',
              amount: Number(refund.amount || 0) / 100,
              currency: refund.currency || pay?.currency || 'INR',
              refundId: refund.id,
              paymentId: refund.payment_id,
              refundedAt: new Date(
                (Number(refund.created_at) || Math.floor(Date.now() / 1000)) * 1000
              ),
              billing,
              plan,
              endedByRefund,
              ...(await this.freePlanFor(orgId!)),
              mediaKeptUntil,
            }),
            'Hookpost Billing <support@hookstep.in>'
          );
        return plan === 'cancelled'
          ? this.withMediaKeptUntil(orgId!, send)
          : send(null);
      });
    } catch (e) {
      // The one failure Razorpay must redeliver: see RefundReadUnknownError.
      if (e instanceof RefundReadUnknownError) throw e;
      this.logger.error(`Refund handling failed for ${refund?.id}: ${e}`);
    }
  }

  /**
   * A charge on the workspace's current subscription was refunded
   * (handleRefund): cancel the subscription at Razorpay now and end the plan
   * the way an immediate cancel does (handleCancelled). The refund email and the owner's refund
   * alert say the plan ended, so Razorpay's subscription.cancelled that
   * follows sends neither: the customer's cancelled:<id> email is claimed and
   * the owner's cancel:<id> alert marked before the cancel goes out. True
   * when it was ended; when Razorpay refuses, nothing changes.
   */
  private async endRefundedSubscription(sub: any, orgId: string): Promise<boolean> {
    await this._ownerAlerts?.mark(`cancel:${sub.id}`);
    await this.sendOnce(`cancelled:${sub.id}`, async () => true);
    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${sub.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      // Razorpay takes one cancel per subscription: refund.created and
      // refund.processed may both have sent it, or the customer had already
      // cancelled at the cycle end. Either way it never charges again.
      const remote = await this.client
        .request('GET', `/subscriptions/${sub.id}`)
        .catch(() => null);
      if (remote?.status !== 'cancelled' && !scheduledCancelAt(remote)) {
        this.logger.error(
          `Could not cancel ${sub.id} for org ${orgId} after a refund: ${e?.message || e}`
        );
        await this._ownerAlerts?.unmark(`cancel:${sub.id}`);
        await this.releaseOnce(`cancelled:${sub.id}`);
        return false;
      }
      after = remote;
    }
    this.logger.warn(
      `Cancelled ${sub.id} for org ${orgId}: a charge on it was refunded.`
    );
    await this.handleCancelled(
      { ...sub, ...(after?.id ? after : {}), status: 'cancelled' },
      { endedByRefund: true }
    );
    return true;
  }

  /**
   * The safety net under the refund webhooks: every processed refund on the
   * Razorpay account in the last REFUND_SWEEP_LOOKBACK_SECONDS goes through
   * handleRefund, exactly as its refund.processed webhook would. A webhook
   * that never arrived (Razorpay gave up after 24 hours of failures, or the
   * event was left out of the webhook's list) would otherwise leave a
   * refunded workspace on its paid plan for good: nothing else looks for
   * refunds.
   *
   * A refund already settled by its webhook is a no-op here (the plan row is
   * gone or belongs to a newer subscription, and the email and alerts are
   * claimed once per refund id). A pending refund waits for the sweep after
   * it is processed. A refund Razorpay could not be read for
   * (RefundReadUnknownError) is counted and tried again next hour. Never
   * throws.
   */
  async sweepMissedRefunds(
    now = new Date()
  ): Promise<{ seen: number; unreadable: number }> {
    const report = { seen: 0, unreadable: 0 };
    const to = Math.floor(now.getTime() / 1000);
    const from = to - REFUND_SWEEP_LOOKBACK_SECONDS;
    for (let page = 0; page < REFUND_SWEEP_MAX_PAGES; page++) {
      let items: any[];
      try {
        const res = await this.client.request(
          'GET',
          `/refunds?from=${from}&to=${to}&count=${REFUND_SWEEP_PAGE}&skip=${page * REFUND_SWEEP_PAGE}`
        );
        items = Array.isArray(res?.items) ? res.items : [];
      } catch (e: any) {
        this.logger.error(
          `Refund sweep: Razorpay could not list refunds; trying again next hour: ${e?.message || e}`
        );
        break;
      }
      for (const refund of items) {
        report.seen++;
        if (refund?.status !== 'processed' || !refund.id) continue;
        // The backend and the orchestrator sweep on the same aligned hour:
        // one of them takes each refund. Redis away: go ahead, handleRefund
        // is idempotent and only does the work twice.
        const claimed = await (ioRedis as any)
          .set(`razorpay:refund-sweep:${refund.id}`, '1', 'EX', REFUND_SWEEP_CLAIM_SECONDS, 'NX')
          .then((r: any) => r === 'OK')
          .catch(() => true);
        if (!claimed) continue;
        try {
          await this.handleRefund('refund.processed', refund);
        } catch (e: any) {
          if (!(e instanceof RefundReadUnknownError)) throw e;
          report.unreadable++;
          this.logger.warn(`Refund sweep: ${e.message}`);
        }
      }
      if (items.length < REFUND_SWEEP_PAGE) break;
      if (page === REFUND_SWEEP_MAX_PAGES - 1) {
        this.logger.error(
          `Refund sweep: stopped at ${REFUND_SWEEP_MAX_PAGES} pages; older refunds in the window were not looked at.`
        );
      }
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  // Payment disputes (chargebacks)
  // ---------------------------------------------------------------------------

  /**
   * One dispute as Razorpay holds it now (GET /disputes/:id), or null when
   * Razorpay could not be read. The admin's restore asks this rather than
   * trusting the status saved when the dispute arrived.
   */
  readDispute(disputeId: string): Promise<any | null> {
    return this.client
      .request('GET', `/disputes/${encodeURIComponent(disputeId)}`)
      .catch(() => null);
  }

  /**
   * The hourly backup for payment.dispute.* webhooks, as sweepMissedRefunds
   * is for refunds: every dispute Razorpay lists from the last
   * DISPUTE_SWEEP_LOOKBACK_SECONDS goes through handleDispute, exactly as its
   * webhook would. Without it a chargeback ends nothing if the live webhook
   * misses the event or was never subscribed to the dispute events.
   *
   * Each dispute is taken once per status (a Redis claim that outlives the
   * window), so the owner is not alerted every hour and the backend and the
   * orchestrator never both handle it. handleDispute is idempotent anyway, so
   * a dispute the webhook already settled changes nothing. When
   * handleDispute throws (Razorpay could not be read, the workspace could not
   * be marked), the claim is dropped and the next hour tries again. Never
   * throws.
   */
  async sweepMissedDisputes(
    now = new Date()
  ): Promise<{ seen: number; failed: number }> {
    const report = { seen: 0, failed: 0 };
    const to = Math.floor(now.getTime() / 1000);
    const from = to - DISPUTE_SWEEP_LOOKBACK_SECONDS;
    for (let page = 0; page < REFUND_SWEEP_MAX_PAGES; page++) {
      let items: any[];
      try {
        const res = await this.client.request(
          'GET',
          `/disputes?from=${from}&to=${to}&count=${REFUND_SWEEP_PAGE}&skip=${page * REFUND_SWEEP_PAGE}`
        );
        // An account with no disputes answers without an items array.
        items = Array.isArray(res?.items) ? res.items : [];
      } catch (e: any) {
        this.logger.error(
          `Dispute sweep: Razorpay could not list disputes; trying again next hour: ${e?.message || e}`
        );
        break;
      }
      for (const dispute of items) {
        report.seen++;
        if (!dispute?.id || !dispute.payment_id) continue;
        const status = cleanLine(dispute.status, 40) || 'open';
        const key = `razorpay:dispute-sweep:${dispute.id}:${status}`;
        // Redis away: go ahead, handleDispute is idempotent.
        const claimed = await (ioRedis as any)
          .set(key, '1', 'EX', DISPUTE_SWEEP_CLAIM_SECONDS, 'NX')
          .then((r: any) => r === 'OK')
          .catch(() => true);
        if (!claimed) continue;
        try {
          await this.handleDispute(`payment.dispute.${status}`, dispute);
        } catch (e: any) {
          report.failed++;
          await (ioRedis as any).del(key).catch(() => undefined);
          this.logger.warn(
            `Dispute sweep: ${dispute.id} not settled, trying again next hour: ${e?.message || e}`
          );
        }
      }
      if (items.length < REFUND_SWEEP_PAGE) break;
    }
    return report;
  }

  /**
   * Razorpay's payment.dispute.* webhooks: a bank has reported a dispute
   * (chargeback) on a payment. The owner's rule (29 Oct 2026): a dispute
   * ends the plan at once, exactly like a refund, because the money is being
   * taken back and the workspace is a fraud risk.
   *
   * What every dispute event does, in this order:
   *
   * 1. The workspace is marked disputed (Organization.disputedAt, reason code
   *    and payment id), allowTrial goes false and it is `locked`
   *    (trial.policy.ts): no Free plan, no free posts, no trial, posts due
   *    later refused with the plan-gate message, and checkout refuses with
   *    DISPUTE_CHECKOUT_MESSAGE. Only a super admin's clear lifts it.
   * 2. Its Razorpay plan ends now (endDisputedSubscription): cancelled with
   *    cancel_at_cycle_end 0 and the row deleted, keeping no paid time, the
   *    way endRefundedSubscription ends a refunded plan. A plan paid
   *    somewhere else (lifetime, Gumroad, a marketplace) is left alone:
   *    nothing here owns it. The disputed subscription itself is cancelled
   *    too when it is not the one the workspace is on any more.
   * 3. The owner is alerted for EVERY dispute event, with the amount, the
   *    reason code, the respond-by date and the dashboard link; the customer
   *    gets one short neutral email when the plan actually ended now.
   *
   * Every step is idempotent, so a redelivered or out-of-order event is a
   * no-op: marking keeps the first dispute's date, the cancel tolerates an
   * already-cancelled subscription, and the emails are claimed once per key.
   * The first dispute event seen ends the plan, whichever it is: `won`
   * arriving first still means a bank raised a dispute. Winning later never
   * restores the plan on its own (the owner's call).
   *
   * Only a payment that belongs to a Hookpost subscription qualifies, found
   * through the payment's invoice the way handleRefund finds a refunded one,
   * with the subscription's notes.orgId, else the payment's. A payment that
   * cannot be tied to a workspace is logged and alerted, and nothing else.
   *
   * Throws only when the workspace could not be marked or its plan could not
   * be ended, so Razorpay redelivers and tries again; an alert or email that
   * fails never does.
   */
  async handleDispute(type: string, dispute: any, payment?: any) {
    let retry: string | null = null;
    let orgId: string | undefined;
    /** Razorpay refused one of the reads that lead to the workspace. */
    let lookupFailed: string | null = null;
    const status = cleanLine(dispute?.status || type.split('.').pop(), 40);
    try {
      if (!dispute?.id || !dispute.payment_id) return;
      // A chargeback the merchant lost is money returned, as a refund is:
      // the commission on it is void. Only Hookpost charges have commission
      // rows, so no service check is needed.
      if (status === 'lost') {
        await this._affiliateService.voidForRefund(
          dispute.payment_id,
          dispute.id,
          'chargeback'
        );
      }

      // Always read the payment: the dispute webhook carries it with
      // invoice_id null and notes [] in Razorpay's own documented payload,
      // and the invoice is the only way from a payment to its subscription.
      const pay =
        (await this.client
          .request('GET', `/payments/${dispute.payment_id}`)
          .catch((e: any) => {
            lookupFailed = e?.message || 'the payment could not be read';
            return null;
          })) ||
        (payment?.id === dispute.payment_id ? payment : null);
      const payService = pay?.notes?.service;
      if (payService && payService !== 'hookpost') return;

      let sub: any = null;
      if (pay?.invoice_id) {
        const invoice = await this.client
          .request('GET', `/invoices/${pay.invoice_id}`)
          .catch((e: any) => {
            lookupFailed = e?.message || 'the invoice could not be read';
            return null;
          });
        if (invoice?.subscription_id) {
          sub = await this.client
            .request('GET', `/subscriptions/${invoice.subscription_id}`)
            .catch((e: any) => {
              lookupFailed = e?.message || 'the subscription could not be read';
              return null;
            });
        }
      }
      // Another product on this shared Razorpay account.
      if (sub && sub.notes?.service !== 'hookpost') return;

      orgId = sub?.notes?.orgId || (payService === 'hookpost' ? pay?.notes?.orgId : undefined);
      if (!orgId && lookupFailed) {
        // Razorpay was down, so "no workspace" means "we could not look".
        // Never write that off as an unknown payment: answer 5xx and let
        // Razorpay redeliver, or a real chargeback is dropped on an outage.
        // Thrown so the single retry path below alerts and answers 5xx; the
        // catch keeps this reason because it only fills an empty one.
        retry = `the workspace could not be looked up (${lookupFailed})`;
        throw new Error(retry);
      }
      if (!orgId) {
        // Nothing to end: tell the owner, who can look the payment up.
        this.logger.error(
          `Dispute ${dispute.id} on payment ${dispute.payment_id}: no Hookpost workspace found for it. Check it in the Razorpay dashboard.`
        );
        this.alertOwner({
          event: 'DISPUTE',
          key: `dispute-unknown:${dispute.id}:${status}`,
          source: 'razorpay',
          amount: Number(dispute.amount || 0) / 100,
          currency: dispute.currency || pay?.currency || 'INR',
          amountNote: `disputed, ${status}`,
          ids: { dispute: dispute.id, payment: dispute.payment_id },
          notes: [
            ...this.disputeNotes(dispute),
            'No Hookpost workspace could be found for this payment: nothing was changed. Check it in the Razorpay dashboard.',
          ],
        });
        return;
      }

      // The owner cleared the workspace in Admin after this dispute was
      // raised, so it was settled (it, or a later one that overwrote the
      // payment on the row): a later status of it (won, lost, closed), a
      // redelivery or the hourly sweep must not lock the workspace again or
      // end a plan bought since. The owner is still told it moved on. A
      // dispute raised after the clear goes on as usual. A read that fails
      // goes on as before: marking then fails too and Razorpay redelivers.
      const known = await this._organizationService
        .getDispute(orgId)
        .catch(() => null);
      const raisedAt =
        (Number(dispute.created_at) || Math.floor(Date.now() / 1000)) * 1000;
      if (
        known &&
        !known.disputedAt &&
        known.disputeClearedAt &&
        new Date(known.disputeClearedAt).getTime() >= raisedAt
      ) {
        this.alertOwner({
          event: 'DISPUTE',
          key: `dispute:${dispute.id}:${status}`,
          source: 'razorpay',
          organizationId: orgId,
          amount: Number(dispute.amount || 0) / 100,
          currency: dispute.currency || pay?.currency || 'INR',
          amountNote: `disputed, ${status}`,
          ids: { dispute: dispute.id, payment: dispute.payment_id },
          notes: [
            ...this.disputeNotes(dispute),
            `This dispute was raised before you cleared the workspace in Admin on ${new Date(known.disputeClearedAt).toISOString()}, so nothing was changed on the workspace or its plan. If you did not know about this one, end the plan from Admin.`,
          ],
        });
        return;
      }

      const local = await this._subscriptionService.getSubscription(orgId);
      const localTier: string | null = local?.subscriptionTier
        ? String(local.subscriptionTier)
        : null;
      // A plan Razorpay does not own: a lifetime deal, one paid on Gumroad,
      // one that comes with a marketplace subscription. Cancelling it here
      // would take away a plan this dispute did not pay for.
      const elsewhere =
        !!local &&
        (!!local.isLifetime ||
          isGumroadIdentifier(local.identifier) ||
          isMarketplaceIdentifier(local.identifier));

      // Built before the plan is ended, while the row that says what they
      // paid for still exists. Never fatal: a dispute is still applied when
      // the pack cannot be put together, and the owner is told so.
      const evidence = await this.collectDisputeEvidence(
        orgId,
        dispute,
        pay,
        sub,
        local
      );

      // Marked before the plan is ended, so the plan ends into a workspace
      // that is already locked and cannot buy again in between.
      let marked = false;
      try {
        marked = await this._organizationService.markDisputed(orgId, {
          reason: cleanLine(dispute.reason_code, 120) || 'not given',
          paymentId: String(dispute.payment_id),
          at: new Date(
            (Number(dispute.created_at) || Math.floor(Date.now() / 1000)) * 1000
          ),
          evidence,
        });
      } catch (e: any) {
        retry = `the workspace could not be marked disputed (${e?.message || e})`;
      }

      let plan: 'active' | 'cancelled' | 'none' = localTier ? 'active' : 'none';
      let endedByDispute = false;
      if (!retry && local && !elsewhere) {
        const current =
          sub?.id === local.identifier
            ? sub
            : await this.client
                .request('GET', `/subscriptions/${local.identifier}`)
                .catch(() => null);
        if (!current?.id) {
          // Razorpay could not be read. Never delete the row on that: the
          // subscription would keep charging with nothing left to cancel it.
          retry = `Razorpay did not answer for subscription ${local.identifier}`;
        } else if (!isOrgSubscription(current, orgId)) {
          this.logger.error(
            `Dispute ${dispute.id}: ${local.identifier} on org ${orgId} is not a Hookpost subscription of that workspace; its plan was left alone.`
          );
        } else if (ENDED_STATES.includes(current.status)) {
          // Already cancelled at Razorpay and only still on because of the
          // cancellation grace period. A dispute ends that too.
          await this._subscriptionService.deleteSubscriptionByOrg(orgId);
          plan = 'cancelled';
          endedByDispute = true;
        } else if (await this.endDisputedSubscription(current, orgId)) {
          plan = 'cancelled';
          endedByDispute = true;
        } else {
          retry = `Razorpay refused the cancel of ${current.id}`;
        }
      }

      // The disputed subscription is not the one the workspace is on any
      // more (a plan change): it must still never charge again.
      if (sub?.id && sub.id !== local?.identifier && !ENDED_STATES.includes(sub.status)) {
        await this.client
          .request('POST', `/subscriptions/${sub.id}/cancel`, {
            cancel_at_cycle_end: 0,
          })
          .then(() =>
            this.logger.warn(
              `Cancelled ${sub.id} for org ${orgId}: a payment on it was disputed.`
            )
          )
          .catch((e: any) =>
            this.logger.error(
              `Could not cancel the disputed subscription ${sub.id} for org ${orgId}: ${e?.message || e}`
            )
          );
      }

      this.logger.warn(
        `Dispute ${dispute.id} (${status}) on payment ${dispute.payment_id} for org ${orgId}: workspace marked disputed, plan ${plan}.`
      );

      const disputedPlan = sub
        ? await this.resolveTierFromPlan(sub.plan_id).catch(() => null)
        : null;
      this.alertOwner({
        event: 'DISPUTE',
        // One alert per dispute per status, so a redelivery is one email and
        // created -> under_review -> won each get their own.
        key: `dispute:${dispute.id}:${status}`,
        source: 'razorpay',
        organizationId: orgId,
        userId: sub?.notes?.userId || null,
        tier: localTier || disputedPlan?.billing || null,
        period: local?.period || disputedPlan?.period || null,
        amount: Number(dispute.amount || 0) / 100,
        currency: dispute.currency || pay?.currency || 'INR',
        // In the subject too, while it still needs our answer: a dispute
        // nobody answers within the window is lost.
        amountNote: disputeAwaitsResponse(status)
          ? `disputed, ${respondBySubject(dispute)}`
          : `disputed, ${status}`,
        ids: {
          dispute: dispute.id,
          payment: dispute.payment_id,
          subscription: sub?.id || local?.identifier || null,
        },
        notes: [
          ...this.disputeNotes(dispute),
          pay?.amount
            ? `Original payment ${amountLabel(Number(pay.amount) / 100, pay.currency)}`
            : null,
          marked
            ? 'The workspace is now marked disputed: no free posts, no trial, and checkout refuses until you clear it in Admin.'
            : 'The workspace was already marked disputed.',
          marked && evidence
            ? 'An evidence pack is ready to download in Admin > Users > Workspaces: the payment and how it was authorised, the customer, what they published in the paid period, what we sent them, and our terms.'
            : marked
            ? 'No evidence pack could be built for this one: put the facts together from the Razorpay dashboard.'
            : null,
          endedByDispute
            ? 'The plan ended now and the subscription is cancelled at Razorpay.'
            : elsewhere
            ? `The plan is paid elsewhere (${cleanLine(local?.identifier, 60)}): it was left alone, cancel or refund it by hand if you want it ended.`
            : plan === 'none'
            ? 'The workspace had no paid plan.'
            : null,
          retry
            ? `The plan could NOT be ended: ${retry}. Razorpay will redeliver this event; if it keeps failing, cancel the subscription in the dashboard.`
            : null,
          status === 'won'
            ? 'We won this dispute. Nothing is restored automatically: in Admin you can clear the workspace so it can buy again, and give back the plan for the time it had already paid for.'
            : null,
        ],
      });

      // The customer hears it once, and only when a plan really ended now.
      // Our own workspaces get the owner alert and nothing else.
      if (endedByDispute && !(await this.isInternalWorkspace(orgId))) {
        await this.sendOnce(`dispute:${dispute.id}`, async () => {
          const org = await this._organizationService.getOrgById(orgId!);
          return this.withMediaKeptUntil(orgId!, async (mediaKeptUntil) =>
            this.sendCustomerEmail(
              orgId!,
              paymentDisputedEmail({
                orgName: org?.name || 'your workspace',
                billing: localTier,
                paymentId: String(dispute.payment_id),
                disputedAt: new Date(
                  (Number(dispute.created_at) || Math.floor(Date.now() / 1000)) *
                    1000
                ),
                ...(await this.freePlanFor(orgId!)),
                mediaKeptUntil,
              }),
              'Hookpost Billing <support@hookstep.in>'
            )
          );
        });
      }
    } catch (e: any) {
      retry = retry || `dispute handling failed (${e?.message || e})`;
    }

    if (retry) {
      this.logger.error(
        `Dispute ${dispute?.id} for org ${orgId || 'unknown'}: ${retry}`
      );
      this.alertOwner({
        event: 'DISPUTE',
        key: `dispute-failed:${dispute?.id}:${status}`,
        source: 'razorpay',
        organizationId: orgId || null,
        ids: { dispute: dispute?.id || null, payment: dispute?.payment_id || null },
        notes: [
          `A chargeback could not be applied: ${retry}.`,
          'Razorpay redelivers this webhook for up to 24 hours. If it keeps failing, cancel the subscription in the dashboard and clear or keep the workspace by hand.',
        ],
      });
      // Razorpay redelivers on a 5xx, and every step above is idempotent.
      throw new Error(`Dispute ${dispute?.id}: ${retry}`);
    }
  }

  /** The dispute's own facts, as the owner's alert prints them. */
  private disputeNotes(dispute: any): string[] {
    return [
      `Dispute ${cleanLine(dispute?.status, 40) || 'open'}${
        dispute?.phase ? `, phase ${cleanLine(dispute.phase, 40)}` : ''
      }`,
      `Reason code ${cleanLine(dispute?.reason_code, 120) || 'not given'}`,
      respondByNote(dispute || {}),
      Number(dispute?.amount_deducted || 0) > 0
        ? `Already deducted ${amountLabel(
            Number(dispute.amount_deducted) / 100,
            dispute.currency
          )}`
        : 'Razorpay holds the disputed amount back from settlements while the dispute is open, and returns it if we win',
    ].filter(Boolean) as string[];
  }

  /**
   * The evidence pack for this dispute (dispute.evidence.ts), as JSON for
   * Organization.disputeEvidence, built while the plan row still exists.
   * Null when there is nothing to build from, or when a read failed: the
   * dispute still ends the plan, and the alert says the pack is missing.
   *
   * Only the first dispute event writes it (markDisputed only fills an empty
   * dispute), so it is the state at the moment the chargeback arrived, which
   * is what answering it needs.
   */
  private async collectDisputeEvidence(
    orgId: string,
    dispute: any,
    pay: any,
    sub: any,
    local: any
  ): Promise<string | null> {
    try {
      const seconds = (v: any) =>
        Number(v || 0) > 0 ? new Date(Number(v) * 1000) : null;
      // The period the disputed payment bought: Razorpay's own cycle when we
      // can read it, else from the payment itself.
      const since =
        seconds(sub?.current_start) ||
        seconds(pay?.created_at) ||
        (local?.createdAt ? new Date(local.createdAt) : null) ||
        new Date(0);
      const facts = await this._organizationService.getDisputeEvidenceFacts(
        orgId,
        since
      );
      if (!facts) return null;
      const pack = buildDisputeEvidence({
        dispute,
        payment: pay,
        facts,
        plan: local
          ? {
              tier: local.subscriptionTier ?? null,
              period: local.period ?? null,
              identifier: local.identifier ?? null,
              totalChannels: local.totalChannels ?? null,
              startedAt: since,
              periodEnd:
                seconds(sub?.current_end) ||
                (local.cancelAt ? new Date(local.cancelAt) : null),
            }
          : null,
      });
      return JSON.stringify(pack);
    } catch (e: any) {
      this.logger.error(
        `Dispute ${dispute?.id}: the evidence pack for org ${orgId} could not be built (${
          e?.message || e
        }). The dispute itself is unaffected.`
      );
      return null;
    }
  }

  /**
   * A payment of this subscription was disputed (handleDispute): cancel it at
   * Razorpay now and end the plan the way a refund ends it
   * (endRefundedSubscription). No paid time is kept: the money for it is
   * being taken back. The dispute's own alert and email say the plan ended,
   * so Razorpay's subscription.cancelled that follows sends neither. True
   * when it was ended; when Razorpay refuses, nothing changes and the caller
   * lets Razorpay redeliver.
   */
  private async endDisputedSubscription(sub: any, orgId: string): Promise<boolean> {
    await this._ownerAlerts?.mark(`cancel:${sub.id}`);
    await this.sendOnce(`cancelled:${sub.id}`, async () => true);
    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${sub.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      // Razorpay takes one cancel per subscription: a redelivered dispute
      // event, or the customer's own cancel, may already have sent it.
      const remote = await this.client
        .request('GET', `/subscriptions/${sub.id}`)
        .catch(() => null);
      if (remote?.status !== 'cancelled' && !scheduledCancelAt(remote)) {
        this.logger.error(
          `Could not cancel ${sub.id} for org ${orgId} after a dispute: ${e?.message || e}`
        );
        await this._ownerAlerts?.unmark(`cancel:${sub.id}`);
        await this.releaseOnce(`cancelled:${sub.id}`);
        return false;
      }
      after = remote;
    }
    this.logger.warn(
      `Cancelled ${sub.id} for org ${orgId}: a payment on it was disputed.`
    );
    await this.handleCancelled(
      { ...sub, ...(after?.id ? after : {}), status: 'cancelled' },
      { endedByDispute: true }
    );
    return true;
  }

  /**
   * Close grace periods left by handleCancelled once their paid time is up,
   * or, for a cancelled trial, once the date its first charge was due has
   * passed. Only rows whose Razorpay subscription is really `cancelled` and
   * ours, so a row carrying an old or odd cancelAt is never downgraded on a
   * guess.
   *
   * Also the end set for a halted renewal (scheduleHaltedRenewalEnd): the
   * workspace's own subscription still `halted` once it is up is cancelled
   * at Razorpay and ended (endHaltedRenewal). One Razorpay says is `active`
   * and paid well past the date (paidPastSavedEnd) keeps its plan, and the
   * date is lifted.
   *
   * `organizationId` runs it for that one workspace: the exact timer at
   * cancelAt (planEndWorkflow, PlanEndTimer) ends the plan at that second
   * through this same code, and the hourly sweep is then a no-op for it (the
   * row is gone, and every email here is sent once).
   */
  async endLapsedCancellations(now = new Date(), organizationId?: string) {
    const rows = await this._subscriptionService.getLapsedCancellations(
      now,
      organizationId
    );
    let ended = 0;
    for (const row of rows) {
      // A paid one-time month (one.time.plan.ts) has no Razorpay
      // subscription to ask: its date is the whole answer. It drops back to
      // the free-posts state, and sends no email (none exists for it yet).
      if (isOrderIdentifier(row.identifier)) {
        if (
          row.cancelAt &&
          new Date(row.cancelAt).getTime() <= now.getTime() &&
          (await this._subscriptionService.endOneTimePlan(
            row.organizationId,
            row.identifier!
          ))
        ) {
          ended++;
          this.logger.log(
            `Paid month ended for org ${row.organizationId} (${row.identifier}).`
          );
        }
        continue;
      }
      const remote = await this.client
        .request('GET', `/subscriptions/${row.identifier}`)
        .catch(() => null);
      const current =
        remote?.id === row.identifier &&
        isOrgSubscription(remote, row.organizationId);
      // A paid plan whose renewal halted, and the end set for it
      // (scheduleHaltedRenewalEnd) has come: end it. Likewise a mandate the
      // customer paused that Razorpay would not let handlePausedByCustomer
      // cancel: it is not charging, and the time paid for is up.
      if (current && (remote.status === 'halted' || remote.status === 'paused')) {
        if (await this.endHaltedRenewal(row, remote)) ended++;
        continue;
      }
      // That renewal was paid after all and nothing lifted the date
      // (renewsPaidUp): the plan carries on. Only when the time paid for runs
      // well past the saved date (paidPastSavedEnd): a cycle-end cancel whose
      // date has passed on a subscription Razorpay has not yet flipped to
      // cancelled keeps its date, so the sweep still ends it.
      if (current && paidPastSavedEnd(remote, row.cancelAt)) {
        await this._subscriptionService.scheduleCancellation(
          row.organizationId,
          row.identifier,
          null
        );
        this.logger.warn(
          `${row.identifier} is paid and renewing; lifted the end date on org ${row.organizationId}.`
        );
        continue;
      }
      if (
        remote?.status !== 'cancelled' ||
        remote?.notes?.service !== 'hookpost'
      ) {
        continue;
      }
      // Same end as handleCancelled: a replacement mandate that never
      // charged runs on the time paid for up to its start_at, a cancelled
      // trial to the start_at its first charge was due on, and a renewal
      // that was never paid to where that cycle started (paidThrough). The
      // later of these, so no grace already on file is ever cut short.
      const end = Math.max(
        (paidThrough(remote) || replacementPaidUntil(remote)) * 1000,
        trialAccessUntil(remote) * 1000
      );
      if (end > now.getTime() + 60_000) continue;
      await this._subscriptionService.deleteSubscriptionByOrg(row.organizationId);
      ended++;
      this.logger.log(
        `Cancellation grace ended for org ${row.organizationId} (${row.identifier}).`
      );
      // A cancelled trial that has run out: a workspace with no Free plan to
      // fall back to is paused now, and is told so. A paid plan whose paid
      // time has run out is told the plan has ended, the other half of the
      // "works until <date>" it got when Cancel was pressed.
      if (trialAccessUntil(remote) > 0) {
        await this.sendTrialEndedPausedEmail(row, remote, now).catch((e) =>
          this.logger.error(
            `Paused-workspace email for org ${row.organizationId} failed: ${e}`
          )
        );
      } else {
        await this.sendPlanEndedEmail(row, remote, now).catch((e) =>
          this.logger.error(
            `Plan-ended email for org ${row.organizationId} failed: ${e}`
          )
        );
      }
    }
    return { checked: rows.length, ended };
  }

  /**
   * The workspace's cancelled trial has just run out (endLapsedCancellations)
   * and it has no Free plan to move to (freePlanFor, at that moment): it is
   * paused, so say so and how to continue. Once per subscription. Not for an
   * internal workspace (isInternalWorkspace), and not while the trial policy
   * is off, when every workspace moves to the Free plan instead.
   */
  /**
   * The pre-charge guard: make sure this database and Razorpay never
   * disagree about whether a customer will be charged. Runs hourly beside the
   * grace sweep, and before it, so a subscription it stops is ended in-app by
   * the same run.
   *
   * Two directions, treated very differently.
   *
   * It acts in one of them only: a plan this database says is ending or has
   * ended (`cancelAt` on the row) whose Razorpay subscription could still
   * charge (canStillCharge, with no proof it will stop). When the debit is
   * within 48 hours or the end has already passed (preChargeVerdict), the
   * subscription is cancelled at Razorpay now (cancel_at_cycle_end 0) and the
   * row is left exactly as it is: the row is what grants access, so the
   * customer keeps what they paid for until `cancelAt`. That is the 11 Nov
   * race in the incident -- charge_at and cancelAt on the same instant, with
   * the sweep that ends the plan only able to run at or after it.
   *
   * In the other direction it only reports (planMismatch). A Razorpay
   * subscription that is charging with no plan row behind it, or a plan with
   * no end date whose subscription Razorpay has already finished with, both
   * go to the owner and nothing else. Acting there could end a plan somebody
   * is paying for: a checkout that finished a moment ago has no row until its
   * webhook lands, and looks exactly like a subscription charging for
   * nothing.
   *
   * Safe to repeat and safe to run in several processes at once: each cancel
   * is claimed in Redis (claimGuardAction) and Razorpay takes one cancel per
   * subscription anyway. Nothing is ever cancelled on the strength of a read
   * that failed -- a subscription Razorpay would not return is counted as
   * unreadable and looked at again next hour. Never throws.
   *
   * `dryRun` reads everything and changes nothing, for the report run on
   * production.
   */
  async reconcileBilling(
    opts: { now?: Date; dryRun?: boolean } = {}
  ): Promise<ReconcileReport> {
    const now = opts.now || new Date();
    const dryRun = !!opts.dryRun;
    const nowSec = Math.floor(now.getTime() / 1000);
    const report: ReconcileReport = {
      dryRun,
      checked: 0,
      endingChecked: 0,
      unreadable: 0,
      refundedEnded: [],
      stoppedUnpaid: [],
      missedWebhooks: [],
      listed: 0,
      listingFailed: false,
      cancelled: [],
      mismatches: [],
      autoRefunds: [],
    };

    // The query already leaves out lifetime deals and plans bought on Gumroad
    // or a marketplace, which hold no Razorpay subscription. Checked again
    // here because this is the one sweep that cancels things: a row without a
    // Razorpay subscription id behind it must never reach the cancel call.
    const rows = (await this._subscriptionService.getRazorpayPlanRows()).filter(
      (r: any) =>
        !r.isLifetime &&
        typeof r.identifier === 'string' &&
        r.identifier.startsWith('sub_') &&
        !isGumroadIdentifier(r.identifier)
    );
    const byIdentifier = new Map(
      rows.map((r: any) => [String(r.identifier), r])
    );
    // Subscriptions whose missed webhook this run has handled (or, in a dry
    // run, would handle): not reported as a mismatch as well.
    const missedHandled = new Set<string>();

    for (const row of rows) {
      report.checked++;
      if (row.cancelAt) report.endingChecked++;
      const remote = await this.client
        .request('GET', `/subscriptions/${row.identifier}`)
        .catch((e: any) => {
          this.logger.warn(
            `Pre-charge guard could not read ${row.identifier} (org ${row.organizationId}): ${e?.message || e}`
          );
          return null;
        });
      if (!remote) {
        report.unreadable++;
        continue;
      }
      // Not this workspace's, or not opened by Hookpost's checkout: the
      // Razorpay account is shared, so nothing here may touch it.
      if (!isOrgSubscription(remote, row.organizationId)) continue;

      // The workspace itself is gone, so no date on the row matters: there is
      // nobody left to hold the plan and nothing a renewal would pay for.
      if (row.organization?.deletedAt && canStillCharge(remote, nowSec)) {
        const done = await this.guardCancel(
          row,
          remote,
          'the workspace was deleted and Razorpay could still charge it',
          dryRun
        );
        if (done) report.cancelled.push(done);
        continue;
      }

      if (!row.cancelAt) {
        // The plan's own subscription has ended or halted at Razorpay and the
        // row still grants it with no end: the webhook that says so never
        // came (Razorpay gives up after 24 hours of failed deliveries, or the
        // webhook secret stopped matching). Handled exactly as that webhook
        // would have been, so the plan ends, or runs out its paid time, as it
        // would have; left alone it went on for free, for good.
        const missed = missedEndEvent(remote, nowSec);
        if (!missed && ENDED_STATES.includes(remote.status) && remote.ended_at) {
          // Ended moments ago: its webhook is still on the way.
          missedHandled.add(String(remote.id));
          continue;
        }
        // A newer mandate already approved for this workspace (Change
        // payment method, a plan change) whose own webhook is late too: the
        // plan has moved on, so ending it here could take it from someone
        // paying. Left to the mismatch report below.
        if (missed && !(await this.hasReplacementSubscription(row.organizationId, remote))) {
          const done = dryRun
            ? true
            : await this.replayMissedEnd(missed, remote).then(
                () => true,
                (e: any) => {
                  this.logger.error(
                    `Pre-charge guard could not apply the missed ${missed} for ${remote.id}: ${e?.message || e}`
                  );
                  return false;
                }
              );
          // One that failed stays in the mismatch report, and is tried again
          // next hour.
          if (done) {
            missedHandled.add(String(remote.id));
            report.missedWebhooks.push(String(row.identifier));
          }
          continue;
        }
        // Two mandates that will never pay for the plan the row grants, with
        // no webhook that has to arrive: one the customer paused (its
        // subscription.paused lost), and one whose first debit never landed.
        if (remote.status === 'paused' || firstChargeNeverLanded(remote, nowSec)) {
          const stopped = dryRun
            ? true
            : remote.status === 'paused'
            ? await this.handlePausedByCustomer(remote).catch((e: any) => {
                this.logger.error(`Pre-charge guard could not stop paused ${remote.id}: ${e?.message || e}`);
                return false;
              })
            : await this.endUnpaidFirstCharge(row, remote).catch((e: any) => {
                this.logger.error(`Pre-charge guard could not end never-paid ${remote.id}: ${e?.message || e}`);
                return false;
              });
          if (stopped) report.stoppedUnpaid.push(String(row.identifier));
          continue;
        }
        if (await this.guardRefundedStillCharging(row, remote, nowSec, dryRun)) {
          report.refundedEnded.push(String(row.identifier));
        }
        continue;
      }

      // Money already taken after the cancel (its subscription.charged
      // webhook lost, or a renewal the guard could not stop): refunded in
      // full now, once per payment.
      const guardRetry = await this.readGuardRetry(String(row.identifier));
      if (
        paidThrough(remote) * 1000 > new Date(row.cancelAt).getTime() + 86400_000 &&
        (remote.status === 'cancelled' || !!guardRetry)
      ) {
        for (const r of await this.refundChargesAfterCancelOn(row as any, dryRun)) {
          report.autoRefunds.push({ subscriptionId: String(row.identifier), ...r });
          if (!dryRun && (r.outcome === 'failed')) {
            await this.settleChargeAfterCancel({
              subscriptionId: String(row.identifier),
              paymentId: r.paymentId,
              organizationId: row.organizationId,
              accessUntil: row.cancelAt,
              billing: row.subscriptionTier,
              period: row.period,
            });
          }
        }
        if (remote.status === 'cancelled') continue;
      }
      // A cancel the guard is already retrying on its backoff is left to the
      // retry sweep.
      if (guardRetry?.nextAt) continue;

      const verdict = preChargeVerdict({
        subscription: remote,
        cancelAt: row.cancelAt,
        nowSec,
      });
      // Paid past the end saved here, so the row and the subscription cannot
      // both be right. A refund settles it: with one, the row is right and the
      // plan really is over; without one, the renewal was paid after all and
      // the grace sweep lifts the date in this very run. Nothing is cancelled
      // on the strength of the row alone.
      if (verdict.recheck) {
        if (!(await this.subscriptionRefunded(String(row.identifier)))) {
          report.mismatches.push(
            this.reportPaidPastEnd(row, remote, verdict.reason, dryRun)
          );
          continue;
        }
        const done = await this.guardCancel(
          row,
          remote,
          'a charge on it was refunded and the plan ended here',
          dryRun
        );
        if (done) report.cancelled.push(done);
        continue;
      }
      if (!verdict.cancel) continue;

      const done = await this.guardCancel(row, remote, verdict.reason, dryRun);
      if (done) report.cancelled.push(done);
    }

    const listed = await this.listHookpostSubscriptions();
    report.listed = listed.items.length;
    report.listingFailed = listed.failed;
    for (const remote of listed.items) {
      if (missedHandled.has(String(remote.id))) continue;
      const row = byIdentifier.get(String(remote.id)) || null;
      const kind = planMismatch({ subscription: remote, row, nowSec });
      if (!kind) continue;
      const orgId = String(remote.notes?.orgId || row?.organizationId || '');

      // The one case here that is acted on: the workspace itself is gone, so
      // there is nobody the plan could belong to and nothing the charge would
      // pay for. Everything else only goes to the owner, because a plan row
      // can be missing for a workspace that is paying perfectly well.
      if (kind === 'charging_without_plan' && orgId) {
        const done = await this.guardCancelDeletedWorkspace(
          orgId,
          remote,
          dryRun
        );
        if (done) {
          report.cancelled.push(done);
          continue;
        }
      }

      const entry = {
        subscriptionId: String(remote.id),
        organizationId: orgId,
        kind,
        status: String(remote.status || ''),
        chargeAt: chargeAtSeconds(remote)
          ? new Date(chargeAtSeconds(remote) * 1000).toISOString()
          : null,
      };
      report.mismatches.push(entry);
      if (dryRun) continue;
      this.alertOwner({
        event: 'BILLING_MISMATCH',
        // One per subscription per kind: a mismatch nobody clears is raised
        // again when the key expires, rather than every hour.
        key: `mismatch:${kind}:${remote.id}`,
        source: 'razorpay',
        organizationId: orgId || null,
        userId: remote.notes?.userId || null,
        tier: row?.subscriptionTier || remote.notes?.billing || null,
        period: row?.period || remote.notes?.period || null,
        paymentMethod: remote.payment_method || null,
        ids: { subscription: String(remote.id) },
        notes: [
          kind === 'charging_without_plan'
            ? `Razorpay says ${remote.status} and can still charge, but this workspace has no plan on file. Nothing was cancelled: check whether the plan should exist before ending it.`
            : `This workspace holds a plan with no end date, but Razorpay says ${remote.status}, so nothing will renew it. Nothing was changed: check whether the plan moved to a newer mandate.`,
          entry.chargeAt ? `Next charge at Razorpay: ${entry.chargeAt}` : null,
        ],
      });
    }

    if (
      report.cancelled.length ||
      report.refundedEnded.length ||
      report.mismatches.length
    ) {
      this.logger.warn(
        `Pre-charge guard${dryRun ? ' (dry run)' : ''}: cancelled ${report.cancelled.length}, ended ${report.refundedEnded.length} refunded, ${report.mismatches.length} mismatch(es) over ${report.checked} plan(s) and ${report.listed} Razorpay subscription(s).`
      );
    }
    return report;
  }

  /**
   * The pre-charge guard found a subscription.cancelled / .completed /
   * .expired / .halted that never arrived (missedEndEvent): run the handler
   * that webhook runs, on the subscription as Razorpay returns it now.
   * Completed and expired end the plan at once, as their webhook does: a
   * completed subscription has billed its last cycle, an expired one was
   * never approved.
   */
  private async replayMissedEnd(event: MissedEndEvent, remote: any) {
    this.logger.warn(
      `${remote.id} (org ${remote.notes?.orgId}) is ${remote.status} at Razorpay but its plan had no end here: applying the missed ${event}.`
    );
    if (event === 'subscription.halted') {
      await this.handlePaymentFailing(event, remote);
    } else if (event === 'subscription.cancelled') {
      await this.handleCancelled(remote);
    } else {
      await this.deleteSubscription(remote);
    }
  }

  /**
   * Cancel one subscription at Razorpay for the pre-charge guard, and tell
   * the owner. The workspace's plan row is deliberately left untouched: it is
   * what grants the access the customer paid for, and the grace sweep ends it
   * on its own date.
   *
   * Returns what was done, or null when another process had already claimed
   * it or Razorpay would not cancel it.
   */
  private async guardCancel(
    row: { organizationId: string; subscriptionTier?: string | null; period?: string | null; cancelAt?: Date | null },
    remote: any,
    reason: string,
    dryRun: boolean
  ) {
    const subId = String(remote.id);
    const entry = {
      subscriptionId: subId,
      organizationId: row.organizationId,
      reason,
      status: String(remote.status || ''),
      chargeAt: chargeAtSeconds(remote)
        ? new Date(chargeAtSeconds(remote) * 1000).toISOString()
        : null,
      accessUntil: row.cancelAt ? new Date(row.cancelAt).toISOString() : null,
    };
    if (dryRun) return entry;

    if (!(await this.claimGuardAction(`guard-cancel:${subId}`))) return null;

    await this.quietGuardCancelWebhook(subId);
    const refused = await this.attemptRazorpayCancel(subId);
    if (refused) {
      this.logger.error(
        `Pre-charge guard could not cancel ${subId} (org ${row.organizationId}): ${refused}. Retrying on its backoff.`
      );
      await this.releaseGuardAction(`guard-cancel:${subId}`);
      await this.releaseGuardCancelQuiet(subId);
      // No owner alert: the retry sweep tries again (5 min, 30 min, 2 h,
      // 6 h, up to 6 h before the charge), and a charge that lands anyway is
      // refunded in full automatically. The owner hears only if that refund
      // cannot be made either (refundChargeAfterCancel).
      await this.scheduleGuardRetry(row, remote, reason, refused);
      return null;
    }
    await this.clearGuardRetry(subId);
    return this.afterGuardCancel(row, remote, reason, entry);
  }

  /**
   * The guard's cancel reaches Razorpay, whose subscription.cancelled then
   * lands in handleCancelled. The guard's own email ("we stopped a charge")
   * and owner alert are the ones for it (owner rule: told once), so that
   * webhook's "plan cancelled" email and "subscription cancelled" alert are
   * claimed here first. Set before the cancel, as cancelAtPeriodEnd marks its
   * own: the webhook can arrive before the cancel call returns. Given back
   * (releaseGuardCancelQuiet) whenever the guard's own notice does not go
   * out: the cancel was refused, the mandate was stopped some other way, or
   * the "stopped a charge" email could not be sent.
   */
  private async quietGuardCancelWebhook(subId: string) {
    await this._ownerAlerts?.mark(`cancel:${subId}`, GUARD_WEBHOOK_QUIET_SECONDS);
    await this.sendOnce(`cancelled:${subId}`, async () => true);
  }

  /** Undo quietGuardCancelWebhook: Razorpay's webhook tells them after all. */
  private async releaseGuardCancelQuiet(subId: string) {
    await this._ownerAlerts?.unmark(`cancel:${subId}`);
    await this.releaseOnce(`cancelled:${subId}`);
  }

  /**
   * Cancel one subscription at Razorpay at once. Null when it is stopped
   * (now, or already: Razorpay takes one cancel per subscription and it may
   * have come from another process, the dashboard or the UPI app), else why
   * it was not.
   */
  private async attemptRazorpayCancel(subId: string): Promise<string | null> {
    try {
      await this.client.request('POST', `/subscriptions/${subId}/cancel`, {
        cancel_at_cycle_end: 0,
      });
      return null;
    } catch (e: any) {
      const after = await this.client
        .request('GET', `/subscriptions/${subId}`)
        .catch(() => null);
      if (after && cancelProvenAtRazorpay(after)) return null;
      return String(e?.message || e).slice(0, 300);
    }
  }

  /** The owner's info alert and the customer's email once a guard cancel went through. */
  private async afterGuardCancel(
    row: { organizationId: string; subscriptionTier?: string | null; period?: string | null; cancelAt?: Date | null },
    remote: any,
    reason: string,
    entry: GuardCancellation
  ): Promise<GuardCancellation> {
    const subId = String(remote.id);
    this.logger.warn(
      `Pre-charge guard cancelled ${subId} at Razorpay (org ${row.organizationId}): ${reason}. The plan here is unchanged and still runs to ${entry.accessUntil || 'its saved end'}.`
    );
    this.alertOwner({
      event: 'GUARD_CANCELLED',
      key: `guard-cancel:${subId}`,
      source: 'razorpay',
      organizationId: row.organizationId,
      userId: remote.notes?.userId || null,
      tier: row.subscriptionTier || remote.notes?.billing || null,
      period: row.period || remote.notes?.period || null,
      paymentMethod: remote.payment_method || null,
      ids: { subscription: subId },
      notes: [
        `Cancelled at Razorpay now because ${reason}.`,
        `Razorpay said ${entry.status}${entry.chargeAt ? ` with the next charge at ${entry.chargeAt}` : ''}.`,
        entry.accessUntil
          ? `The customer keeps their plan here until ${entry.accessUntil}; nothing was taken from them.`
          : 'The plan here was already over.',
      ],
    });
    const told = await this.sendChargeStoppedEmail(
      row,
      remote,
      row.cancelAt && new Date(row.cancelAt).getTime() > Date.now()
        ? new Date(row.cancelAt)
        : null
    );
    // Not sent (Resend down, or nobody to tell): Razorpay's own
    // subscription.cancelled may still say it.
    if (!told) await this.releaseOnce(`cancelled:${subId}`);
    return entry;
  }

  /**
   * Tell the workspace the guard stopped a charge (chargeStoppedEmail): once
   * per subscription (charge-stopped:<id>), and never to an internal
   * workspace or one that has been deleted -- there is nobody to tell.
   * Never throws: the cancel has happened either way.
   */
  private async sendChargeStoppedEmail(
    row: {
      organizationId: string;
      subscriptionTier?: string | null;
      period?: string | null;
    },
    remote: any,
    accessUntil: Date | null
  ): Promise<boolean> {
    try {
      const orgId = row.organizationId;
      if (await this.isInternalWorkspace(orgId)) return false;
      const org = await this._organizationService.getOrgById(orgId);
      if (!org || (org as any).deletedAt) return false;
      const billing =
        (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
        row.subscriptionTier ||
        remote.notes?.billing ||
        'STANDARD';
      return await this.sendOnce(`charge-stopped:${remote.id}`, async () =>
        this.sendCustomerEmail(
          orgId,
          chargeStoppedEmail({
            orgName: org.name || 'your workspace',
            billing,
            period: row.period || remote.notes?.period || 'MONTHLY',
            accessUntil,
          }),
          'Hookpost Billing <support@hookstep.in>'
        )
      );
    } catch (e: any) {
      this.logger.error(
        `Charge-stopped email for org ${row.organizationId} failed: ${e?.message || e}`
      );
      return false;
    }
  }

  /**
   * The row says the plan ends on a date the subscription has been paid well
   * past, and no charge on it was refunded. The grace sweep lifts the date
   * and the plan carries on, which is right -- the customer paid -- but a
   * date got there somehow, usually a cancel that Razorpay charged through
   * anyway, and that is the owner's to look at. Nothing is changed here.
   */
  private reportPaidPastEnd(
    row: {
      organizationId: string;
      identifier: string;
      cancelAt?: Date | null;
      subscriptionTier?: string | null;
      period?: string | null;
    },
    remote: any,
    reason: string,
    dryRun: boolean
  ): BillingMismatch {
    const entry: BillingMismatch = {
      subscriptionId: String(row.identifier),
      organizationId: row.organizationId,
      kind: 'paid_past_saved_end',
      status: String(remote.status || ''),
      chargeAt: chargeAtSeconds(remote)
        ? new Date(chargeAtSeconds(remote) * 1000).toISOString()
        : null,
    };
    if (dryRun) return entry;
    this.alertOwner({
      event: 'BILLING_MISMATCH',
      key: `mismatch:paid-past-end:${row.identifier}`,
      source: 'razorpay',
      organizationId: row.organizationId,
      userId: remote.notes?.userId || null,
      tier: row.subscriptionTier || remote.notes?.billing || null,
      period: row.period || remote.notes?.period || null,
      paymentMethod: remote.payment_method || null,
      ids: { subscription: String(row.identifier) },
      notes: [
        `This plan is set to end on ${row.cancelAt ? new Date(row.cancelAt).toISOString() : 'a saved date'}, but ${reason} and no charge on it was refunded.`,
        'Nothing was cancelled: the customer has paid for the time ahead, and the grace sweep lifts the end date. Check whether they asked to cancel and were charged anyway.',
      ],
    });
    return entry;
  }

  /**
   * A workspace still holds a plan with no end date, Razorpay is about to
   * charge it, and a charge on that subscription was refunded: end it.
   *
   * This is the 11 Oct half of the incident. A refund ends the plan, and the
   * refund webhook already tries to cancel at Razorpay, but when that cancel
   * is refused the plan stays on and the mandate keeps its renewal date; all
   * the customer gets is an owner alert asking for the dashboard. Here it is
   * retried, through the very same path the webhook uses
   * (endRefundedSubscription), so the plan ends and the one customer email
   * goes out once, whichever of the two gets there first.
   *
   * Only within PRE_CHARGE_GUARD_MS of the debit, so a refund looked for here
   * is one where money is about to move; the rest wait for the next hour.
   * Only where Razorpay can still charge, so a subscription already stopped
   * is never looked up. A refund read that fails leaves the plan alone.
   *
   * Returns true when the plan was ended.
   */
  private async guardRefundedStillCharging(
    row: { organizationId: string; identifier: string },
    remote: any,
    nowSec: number,
    dryRun: boolean
  ): Promise<boolean> {
    if (!canStillCharge(remote, nowSec) || !chargeIsNear(remote, nowSec)) {
      return false;
    }
    // subscriptionRefunded answers false when it cannot read, so a Razorpay
    // outage leaves the plan alone and the next hour looks again.
    if (!(await this.subscriptionRefunded(row.identifier))) return false;
    if (dryRun) return true;
    if (!(await this.claimGuardAction(`guard-refunded:${row.identifier}`))) {
      return false;
    }

    const ended = await this.endRefundedSubscription(
      remote,
      row.organizationId
    ).catch((e: any) => {
      this.logger.error(
        `Pre-charge guard could not end refunded ${row.identifier}: ${e?.message || e}`
      );
      return false;
    });
    if (!ended) {
      await this.releaseGuardAction(`guard-refunded:${row.identifier}`);
      return false;
    }

    this.logger.warn(
      `Pre-charge guard ended the plan on ${row.identifier} (org ${row.organizationId}): a charge on it was refunded and Razorpay was about to charge again.`
    );
    this.alertOwner({
      event: 'GUARD_CANCELLED',
      key: `guard-refunded:${row.identifier}`,
      source: 'razorpay',
      organizationId: row.organizationId,
      userId: remote.notes?.userId || null,
      tier: remote.notes?.billing || null,
      period: remote.notes?.period || null,
      paymentMethod: remote.payment_method || null,
      ids: { subscription: String(row.identifier) },
      notes: [
        'A charge on this subscription was refunded but the plan was still on and Razorpay was about to charge again.',
        'The plan has ended here and the subscription is cancelled at Razorpay.',
      ],
    });
    // endRefundedSubscription holds back the "cancelled" email (the refund
    // email already said the plan ends), so this is the one the customer gets.
    await this.sendChargeStoppedEmail(
      { organizationId: row.organizationId },
      remote,
      null
    );
    return true;
  }

  /**
   * Razorpay can still charge this subscription and the workspace behind it
   * is gone -- closed by its owner, or removed by the account purge -- so
   * cancel it.
   *
   * This is the only disagreement in that direction the guard acts on. A plan
   * row can be missing for a hundred harmless reasons, a checkout finishing
   * right now among them, but a deleted workspace has nobody left to hold a
   * plan and nothing a renewal could pay for: charging on would take money
   * from someone who has left.
   *
   * A workspace that is simply unreadable is never treated as deleted, so a
   * database hiccup cannot end anyone's plan. Returns what was done, or null
   * when the workspace is alive, which leaves it to the owner alert.
   */
  private async guardCancelDeletedWorkspace(
    orgId: string,
    remote: any,
    dryRun: boolean
  ): Promise<GuardCancellation | null> {
    const org = await this._organizationService
      .getOrgById(orgId)
      .catch(() => undefined);
    if (org === undefined) return null;
    if (org && !org.deletedAt) return null;

    return this.guardCancel(
      { organizationId: orgId, cancelAt: null },
      remote,
      org
        ? 'the workspace was deleted and Razorpay could still charge it'
        : 'the workspace no longer exists and Razorpay could still charge it',
      dryRun
    );
  }

  /**
   * Claim one guard action, so the several processes that run the sweep
   * (RUN_CRON is on in the backend and the orchestrator) do not each cancel
   * the same subscription. The same Redis SET NX as sendOnce.
   *
   * Redis unreachable counts as claimed and the guard goes ahead: Razorpay
   * takes one cancel per subscription and the caller handles the refusal, so
   * a repeat attempt costs nothing, while skipping it would let a charge the
   * customer never agreed to go through.
   */
  private async claimGuardAction(
    key: string,
    ttlSeconds = GUARD_CLAIM_TTL_SECONDS
  ): Promise<boolean> {
    try {
      return (
        (await (ioRedis as any).set(
          `razorpay:guard:${key}`,
          new Date().toISOString(),
          'EX',
          ttlSeconds,
          'NX'
        )) === 'OK'
      );
    } catch (e) {
      this.logger.warn(`Could not claim razorpay:guard:${key}; going ahead: ${e}`);
      return true;
    }
  }

  /** Give back a guard claim, so the action is tried again next hour. */
  private async releaseGuardAction(key: string) {
    await (ioRedis as any)
      .del(`razorpay:guard:${key}`)
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Guard cancels Razorpay refused: retried on a backoff
  // ---------------------------------------------------------------------------

  private guardRetryKey(subId: string) {
    return `razorpay:guard-retry:${subId}`;
  }

  /** The retry record of a subscription the guard could not cancel, or null. */
  async readGuardRetry(subId: string): Promise<GuardRetry | null> {
    try {
      const raw = await (ioRedis as any).get(this.guardRetryKey(subId));
      return raw ? (JSON.parse(raw) as GuardRetry) : null;
    } catch {
      return null;
    }
  }

  private async writeGuardRetry(rec: GuardRetry) {
    try {
      await (ioRedis as any).set(
        this.guardRetryKey(rec.subscriptionId),
        JSON.stringify(rec),
        'EX',
        GUARD_RETRY_KEEP_SECONDS
      );
      await (ioRedis as any).sadd(GUARD_RETRY_INDEX, rec.subscriptionId);
    } catch (e) {
      this.logger.error(`Could not save the guard retry for ${rec.subscriptionId}: ${e}`);
    }
  }

  private async clearGuardRetry(subId: string) {
    try {
      await (ioRedis as any).del(this.guardRetryKey(subId));
      await (ioRedis as any).srem(GUARD_RETRY_INDEX, subId);
    } catch {
      // Nothing to clear, or Redis cannot say: the record expires anyway.
    }
  }

  /**
   * When the next try of a refused cancel is due: the next step of
   * GUARD_RETRY_BACKOFF_MS, or 0 when the steps are used up or the next one
   * would fall inside GUARD_RETRY_STOP_BEFORE_MS of the charge.
   */
  static nextGuardRetryAt(attempts: number, now: number, chargeAt: number): number {
    const step = GUARD_RETRY_BACKOFF_MS[attempts];
    if (step === undefined) return 0;
    const at = now + step;
    if (chargeAt && at > chargeAt - GUARD_RETRY_STOP_BEFORE_MS) return 0;
    return at;
  }

  /** Remember a refused guard cancel for the retry sweep. Never throws. */
  private async scheduleGuardRetry(
    row: { organizationId: string; subscriptionTier?: string | null; period?: string | null; cancelAt?: Date | null },
    remote: any,
    reason: string,
    error: string,
    now = Date.now()
  ) {
    try {
      const subId = String(remote.id);
      const prev = await this.readGuardRetry(subId);
      const chargeAt = chargeAtSeconds(remote) * 1000;
      const attempts = prev ? prev.attempts : 0;
      await this.writeGuardRetry({
        subscriptionId: subId,
        organizationId: row.organizationId,
        subscriptionTier: row.subscriptionTier ?? null,
        period: row.period ?? null,
        cancelAt: row.cancelAt ? new Date(row.cancelAt).toISOString() : null,
        reason,
        firstFailedAt: prev?.firstFailedAt || now,
        attempts,
        nextAt: prev ? prev.nextAt : RazorpayService.nextGuardRetryAt(0, now, chargeAt),
        chargeAt,
        lastError: error,
      });
    } catch (e) {
      this.logger.error(`Could not record the guard retry for ${remote?.id}: ${e}`);
    }
  }

  /**
   * Try again every guard cancel Razorpay refused whose next try is due
   * (GUARD_RETRY_BACKOFF_MS). Runs every 5 minutes where RUN_CRON is on.
   * Each record is claimed for the run, so the several processes do not
   * cancel the same subscription together. A subscription Razorpay can no
   * longer charge is done with; one cancelled now gets the usual owner info
   * alert and customer email. When the tries are used up nothing is sent:
   * a charge that lands anyway is refunded automatically.
   */
  async retryFailedGuardCancels(now = Date.now()) {
    let ids: string[] = [];
    try {
      ids = (await (ioRedis as any).smembers(GUARD_RETRY_INDEX)) || [];
    } catch (e) {
      this.logger.warn(`Guard retry sweep could not read its index: ${e}`);
      return { checked: 0, cancelled: 0 };
    }
    let cancelled = 0;
    for (const subId of ids) {
      const rec = await this.readGuardRetry(subId);
      if (!rec) {
        await this.clearGuardRetry(subId);
        continue;
      }
      if (!rec.nextAt || rec.nextAt > now) continue;
      if (!(await this.claimGuardAction(`guard-retry:${subId}`, 240))) continue;
      try {
        const remote = await this.client
          .request('GET', `/subscriptions/${subId}`)
          .catch(() => null);
        if (remote && !canStillCharge(remote, Math.floor(now / 1000))) {
          // Stopped some other way (the dashboard, the UPI app, Razorpay):
          // that cancel's own webhook is the one that tells them.
          await this.writeGuardRetry({ ...rec, nextAt: 0 });
          await this.releaseGuardCancelQuiet(subId);
          continue;
        }
        if (remote) await this.quietGuardCancelWebhook(subId);
        const refused = remote
          ? await this.attemptRazorpayCancel(subId)
          : 'could not read the subscription';
        const row = {
          organizationId: rec.organizationId,
          subscriptionTier: rec.subscriptionTier,
          period: rec.period,
          cancelAt: rec.cancelAt ? new Date(rec.cancelAt) : null,
        };
        if (!refused) {
          cancelled++;
          // Kept, spent, so a charge that slipped through before this try is
          // still recognised as one after the cancel.
          await this.writeGuardRetry({ ...rec, attempts: rec.attempts + 1, nextAt: 0, lastError: undefined });
          const chargeAt = chargeAtSeconds(remote);
          await this.afterGuardCancel(row, remote, rec.reason, {
            subscriptionId: subId,
            organizationId: rec.organizationId,
            reason: rec.reason,
            status: String(remote?.status || ''),
            chargeAt: chargeAt ? new Date(chargeAt * 1000).toISOString() : null,
            accessUntil: rec.cancelAt,
          });
          continue;
        }
        if (remote) await this.releaseGuardCancelQuiet(subId);
        const attempts = rec.attempts + 1;
        const chargeAt = remote ? chargeAtSeconds(remote) * 1000 : rec.chargeAt;
        const nextAt = RazorpayService.nextGuardRetryAt(attempts, now, chargeAt);
        this.logger.error(
          `Guard cancel retry ${attempts} of ${subId} refused: ${refused}. ${nextAt ? `Next try ${new Date(nextAt).toISOString()}.` : 'No tries left; a charge that lands is refunded automatically.'}`
        );
        await this.writeGuardRetry({ ...rec, attempts, nextAt, chargeAt, lastError: refused });
      } finally {
        await this.releaseGuardAction(`guard-retry:${subId}`);
      }
    }
    return { checked: ids.length, cancelled };
  }

  // ---------------------------------------------------------------------------
  // A charge that landed after cancel: refunded in full, automatically
  // ---------------------------------------------------------------------------

  /**
   * Refund in full a payment Razorpay took on a subscription after it was
   * cancelled (a UPI debit the bank was told about before Cancel, or a
   * renewal the guard could not stop). Owner rule: a charge after cancel is
   * our mistake, so it goes back in full, with no action from anyone.
   *
   * Nothing from the webhook is trusted. The payment, its invoice and the
   * subscription are read from Razorpay, and the refund is made only when:
   * the payment is captured; its invoice belongs to this subscription; the
   * subscription is Hookpost's and this workspace's; and the payment was
   * created after the cancel (the subscription's ended_at, or for one the
   * guard could not cancel, its first refused try). The amount is what is
   * still refundable on it, never more than was captured.
   *
   * Once per payment, ever: a long Redis claim on the payment id, Razorpay's
   * own idempotency key (RefundsService.refund), and the payment's refunded
   * amount all stand in the way of a second refund. Recorded in RefundAudit
   * like an admin refund. The customer is told once, keyed on the refund id
   * (the refund webhook sends the same email under the same key if it gets
   * there first); the owner gets an info alert.
   *
   * 'refunded' / 'already' need nothing more. 'not_eligible' and 'failed'
   * leave it to the caller, which tells the owner (a failed one is tried
   * again by the next guard run).
   */
  /** The refund webhook of an automatic refund: the customer's email, once. */
  private async handleAutoRefundWebhook(refund: any, payment?: any) {
    const pay =
      payment?.id === refund.payment_id
        ? payment
        : await this.client.request('GET', `/payments/${refund.payment_id}`).catch(() => null);
    const invoice = pay?.invoice_id
      ? await this.client.request('GET', `/invoices/${pay.invoice_id}`).catch(() => null)
      : null;
    const sub = invoice?.subscription_id
      ? await this.client.request('GET', `/subscriptions/${invoice.subscription_id}`).catch(() => null)
      : null;
    const orgId = sub?.notes?.service === 'hookpost' ? sub.notes.orgId : null;
    if (!orgId) return;
    const row = await this._subscriptionService.getSubscription(orgId);
    await this.sendRefundAfterCancelEmail(orgId, {
      refundId: String(refund.id),
      paymentId: String(refund.payment_id),
      amount: Number(refund.amount || 0) / 100,
      currency: refund.currency || pay?.currency || 'INR',
      accessUntil: row?.identifier === sub.id && row?.cancelAt ? new Date(row.cancelAt) : null,
      planId: sub.plan_id,
      notesBilling: sub.notes?.billing,
    });
  }

  async settleChargeAfterCancel(input: {
    subscriptionId: string;
    paymentId: string;
    organizationId: string;
    accessUntil: Date | null;
    billing?: string | null;
    period?: string | null;
    paymentMethod?: string | null;
    userId?: string | null;
  }) {
    const r = await this.refundChargeAfterCancel(input).catch((e: any) => ({
      outcome: 'failed' as const,
      why: String(e?.message || e),
    }));
    if (r.outcome === 'refunded' || r.outcome === 'already') return r;
    if (r.outcome === 'not_eligible') {
      // Razorpay does not show money taken on this subscription after the
      // cancel (an earlier renewal's webhook redelivered, a payment that is
      // not captured or not on it): nothing is owed, nobody is asked.
      this.logger.warn(
        `Charge ${input.paymentId} on ${input.subscriptionId} not refunded automatically: ${r.why}.`
      );
      return r;
    }
    this.logger.error(
      `Charge ${input.paymentId} on ${input.subscriptionId} (org ${input.organizationId}) landed after cancel and was not refunded automatically: ${r.why}.`
    );
    // The one case the owner is asked to act on: nothing else will.
    this.alertOwner({
      event: 'CHARGED_AFTER_CANCEL',
      key: `charged-after-cancel:${input.paymentId}`,
      source: 'razorpay',
      organizationId: input.organizationId,
      userId: input.userId || null,
      tier: input.billing || null,
      period: input.period || null,
      paymentMethod: input.paymentMethod || null,
      ids: { subscription: input.subscriptionId, payment: input.paymentId },
      notes: [
        `Razorpay took a payment after the customer cancelled, and the automatic full refund could not be made: ${r.why}.`,
        'The guard tries again every hour and sends an info alert if it gets through. Otherwise refund it in full from Admin > Refunds.',
      ],
    });
    return r;
  }

  async refundChargeAfterCancel(input: {
    subscriptionId: string;
    paymentId: string;
    organizationId: string;
    /** The plan's end saved here, for the customer's email. */
    accessUntil?: Date | null;
  }): Promise<{ outcome: 'refunded' | 'already' | 'not_eligible' | 'failed'; why?: string; amount?: number; currency?: string; refundId?: string }> {
    const { subscriptionId, paymentId, organizationId } = input;
    const read = (path: string) => this.client.request('GET', path).catch(() => null);

    const payment = await read(`/payments/${paymentId}`);
    const sub = await read(`/subscriptions/${subscriptionId}`);
    if (!payment || !sub) return { outcome: 'failed', why: 'could not read the payment or the subscription at Razorpay' };
    if (!isOrgSubscription(sub, organizationId)) {
      return { outcome: 'not_eligible', why: 'the subscription is not this workspace’s Hookpost subscription' };
    }
    const invoice = payment.invoice_id ? await read(`/invoices/${payment.invoice_id}`) : null;
    if (payment.invoice_id && !invoice) return { outcome: 'failed', why: 'could not read the payment’s invoice' };
    if (!invoice || invoice.subscription_id !== subscriptionId) {
      return { outcome: 'not_eligible', why: 'the payment is not a charge on this subscription' };
    }
    const amount = Number(payment.amount || 0);
    const refundedBefore = Number(payment.amount_refunded || 0);
    if (payment.status === 'refunded' || (amount > 0 && refundedBefore >= amount)) {
      return { outcome: 'already', amount: refundedBefore, currency: payment.currency };
    }
    if (payment.status !== 'captured' || amount <= 0) {
      return { outcome: 'not_eligible', why: `the payment is ${payment.status}, not captured` };
    }
    // When the customer stopped paying: the earliest of Razorpay's ended_at
    // and the guard's first refused cancel. A cancel the guard only got
    // through after the charge landed has an ended_at later than the
    // payment, and must not hide it.
    const retry = await this.readGuardRetry(subscriptionId);
    const stops = [
      sub.status === 'cancelled' && sub.ended_at ? Number(sub.ended_at) * 1000 : 0,
      retry?.firstFailedAt || 0,
    ].filter((t) => t > 0);
    const cancelledAtMs = stops.length ? Math.min(...stops) : 0;
    if (!cancelledAtMs) {
      return { outcome: 'not_eligible', why: 'the subscription was never cancelled' };
    }
    // When the money moved: the payment's creation, or the invoice's paid_at
    // for a UPI debit started before Cancel and completed after it.
    const takenAtMs =
      Math.max(Number(payment.created_at || 0), Number(invoice.paid_at || 0)) * 1000;
    if (takenAtMs < cancelledAtMs) {
      return { outcome: 'not_eligible', why: 'the payment was made before the cancel' };
    }

    if (!this._refunds) return { outcome: 'failed', why: 'the refund service is not available' };

    const claimKey = `razorpay:auto-refund:${paymentId}`;
    try {
      const claimed =
        (await (ioRedis as any).set(claimKey, new Date().toISOString(), 'EX', AUTO_REFUND_CLAIM_SECONDS, 'NX')) === 'OK';
      if (!claimed) return { outcome: 'already' };
    } catch (e) {
      // Fail closed: without the claim a retry could refund twice.
      return { outcome: 'failed', why: `could not claim the refund in Redis: ${e}` };
    }

    let result: Awaited<ReturnType<RefundsService['refund']>>;
    try {
      result = await this._refunds.refund(AUTO_REFUND_ACTOR, {
        paymentId,
        full: true,
        reason: 'Charged after cancel: automatic full refund',
        auto: AUTO_REFUND_NOTE,
      });
    } catch (e: any) {
      // Thrown before Razorpay was asked (refund() turns Razorpay's own
      // answers into results): free the claim so the next run tries again.
      await (ioRedis as any).del(claimKey).catch(() => undefined);
      return { outcome: 'failed', why: String(e?.message || e) };
    }
    if (result.status !== 'refunded') {
      if (result.status === 'refused' && /already fully refunded/i.test(result.error || '')) {
        return { outcome: 'already' };
      }
      // Razorpay may have refunded when the answer was lost (a timeout, a
      // 5xx, a 409): keep the claim, so nothing can refund it again, and
      // let the owner check. A plain refusal frees it for the next run.
      const maybeSent = /may still have gone through|may be in progress/i.test(result.error || '');
      if (!maybeSent) await (ioRedis as any).del(claimKey).catch(() => undefined);
      return { outcome: 'failed', why: result.error || result.status };
    }

    const currency = result.currency || payment.currency || 'INR';
    const major = Number(result.amount || 0) / 100;
    this.logger.warn(
      `Refunded ${paymentId} in full (${result.refundId}, ${major} ${currency}) for org ${organizationId}: charged after cancel on ${subscriptionId}.`
    );
    await this.sendRefundAfterCancelEmail(organizationId, {
      refundId: String(result.refundId),
      paymentId,
      amount: major,
      currency,
      accessUntil: input.accessUntil ?? null,
      planId: sub.plan_id,
      notesBilling: sub.notes?.billing,
    });
    this.alertOwner({
      event: 'AUTO_REFUNDED',
      key: `auto-refund:${paymentId}`,
      source: 'razorpay',
      organizationId,
      userId: sub.notes?.userId || null,
      tier: sub.notes?.billing || null,
      period: sub.notes?.period || null,
      paymentMethod: sub.payment_method || payment.method || null,
      amount: major,
      currency,
      amountNote: 'refunded',
      ids: { subscription: subscriptionId, payment: paymentId, refund: String(result.refundId) },
      notes: [
        'Charged after the customer cancelled, so it was refunded in full automatically. No action needed.',
        'The plan stays cancelled and ends on its saved date.',
      ],
    });
    return { outcome: 'refunded', amount: Number(result.amount || 0), currency, refundId: result.refundId };
  }

  /**
   * The customer's one email for an automatic refund: "we refunded <amount>,
   * your plan stays cancelled". Keyed on the refund id, the key the refund
   * webhook uses too, so the two never both send.
   */
  async sendRefundAfterCancelEmail(
    orgId: string,
    r: {
      refundId: string;
      paymentId: string;
      amount: number;
      currency: string;
      accessUntil: Date | null;
      planId?: string;
      notesBilling?: string;
    }
  ) {
    if (await this.isInternalWorkspace(orgId).catch(() => false)) return false;
    return this.sendOnce(`refund:${r.refundId}`, async () => {
      const org = await this._organizationService.getOrgById(orgId);
      if (!org || (org as any).deletedAt) return false;
      const billing =
        (r.planId && (await this.resolveTierFromPlan(r.planId).catch(() => null))?.billing) ||
        r.notesBilling ||
        'STANDARD';
      return this.sendCustomerEmail(
        orgId,
        refundAfterCancelEmail({
          orgName: org.name || 'your workspace',
          billing,
          amount: r.amount,
          currency: r.currency,
          refundId: r.refundId,
          paymentId: r.paymentId,
          accessUntil: r.accessUntil && r.accessUntil.getTime() > Date.now() ? r.accessUntil : null,
        }),
        'Hookpost Billing <support@hookstep.in>'
      );
    });
  }

  /**
   * Every payment Razorpay took on this subscription after it was cancelled,
   * refunded in full (refundChargeAfterCancel), for the guard: a
   * subscription.charged webhook that never arrived must not leave the money
   * with us. Returns what happened per payment.
   */
  private async refundChargesAfterCancelOn(
    row: { organizationId: string; identifier: string; cancelAt?: Date | null },
    dryRun: boolean
  ) {
    const res = await this.client
      .request('GET', `/invoices?subscription_id=${encodeURIComponent(row.identifier)}&count=100`)
      .catch(() => null);
    const out: Array<{ paymentId: string; outcome: string; why?: string }> = [];
    for (const inv of res?.items || []) {
      if (!inv?.payment_id || inv.subscription_id && inv.subscription_id !== row.identifier) continue;
      if (dryRun) {
        out.push({ paymentId: String(inv.payment_id), outcome: 'would_check' });
        continue;
      }
      const r = await this.refundChargeAfterCancel({
        subscriptionId: row.identifier,
        paymentId: String(inv.payment_id),
        organizationId: row.organizationId,
        accessUntil: row.cancelAt ?? null,
      }).catch((e: any) => ({ outcome: 'failed' as const, why: String(e?.message || e) }));
      if (r.outcome !== 'not_eligible') out.push({ paymentId: String(inv.payment_id), outcome: r.outcome, why: r.why });
    }
    return out;
  }

  /**
   * Every subscription on the Razorpay account that Hookpost's own checkout
   * opened (notes.service), newest first. The account is shared with another
   * product, so everything else is dropped.
   *
   * `failed` says a page could not be read and `truncated` that there are
   * more than MAX_PAGES of them. Either way the list is short rather than
   * wrong, so the caller only misses mismatches; it never invents one.
   */
  private async listHookpostSubscriptions() {
    const PAGE = 100;
    // Safety valve, as in getOrgSubscriptions.
    const MAX_PAGES = 50;
    const items: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client
        .request('GET', `/subscriptions?count=${PAGE}&skip=${page * PAGE}`)
        .catch((e: any) => {
          this.logger.error(`Pre-charge guard could not list subscriptions: ${e}`);
          return null;
        });
      if (!res) return { items, failed: true, truncated: false };
      const batch: any[] = res.items || [];
      items.push(...batch.filter((s) => s?.notes?.service === 'hookpost'));
      if (batch.length < PAGE) return { items, failed: false, truncated: false };
    }
    this.logger.warn(
      `Pre-charge guard stopped listing subscriptions after ${MAX_PAGES * PAGE}.`
    );
    return { items, failed: false, truncated: true };
  }

  /**
   * A cancelled paid plan's paid time has just run out
   * (endLapsedCancellations) and the row is gone: tell the workspace the plan
   * has ended. Once per subscription (plan-ended:<id>, a different key from
   * the "cancelled, works until <date>" email that went out when Cancel was
   * pressed), and never to an internal workspace or one that has been
   * deleted. A plan Hookpost ended because it was never paid
   * (unpaidRenewalEnded) says so in its own email and is not this.
   */
  private async sendPlanEndedEmail(
    row: {
      organizationId: string;
      identifier: string;
      cancelAt?: Date | null;
      subscriptionTier?: string | null;
      period?: string | null;
    },
    remote: any,
    now: Date
  ): Promise<boolean> {
    const orgId = row.organizationId;
    if (await this.isInternalWorkspace(orgId)) return false;
    const org = await this._organizationService.getOrgById(orgId);
    if (!org || (org as any).deletedAt) return false;
    const billing =
      (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
      row.subscriptionTier ||
      remote.notes?.billing ||
      'STANDARD';
    const endedAt = row.cancelAt ? new Date(row.cancelAt) : now;
    return this.sendOnce(`plan-ended:${remote.id}`, async () =>
      this.withMediaKeptUntil(orgId, async (mediaKeptUntil) =>
        this.sendCustomerEmail(
          orgId,
          planEndedEmail({
            orgName: org.name || 'your workspace',
            billing,
            period: row.period || remote.notes?.period || 'MONTHLY',
            endedAt,
            ...(await this.freePlanFor(orgId, now)),
            mediaKeptUntil,
          }),
          'Hookpost Billing <support@hookstep.in>'
        )
      )
    );
  }

  private async sendTrialEndedPausedEmail(
    row: {
      organizationId: string;
      identifier: string;
      subscriptionTier?: string | null;
      period?: string | null;
    },
    remote: any,
    now: Date
  ): Promise<boolean> {
    const orgId = row.organizationId;
    const { freePlanAvailable } = await this.freePlanFor(orgId, now);
    if (freePlanAvailable) return false;
    if (await this.isInternalWorkspace(orgId)) return false;
    const org = await this._organizationService.getOrgById(orgId);
    if (!org || (org as any).deletedAt) return false;
    const billing =
      (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
      row.subscriptionTier ||
      remote.notes?.billing ||
      'STANDARD';
    const endedAt = new Date(trialAccessUntil(remote) * 1000);
    return this.sendOnce(`trial-ended-paused:${remote.id}`, async () =>
      this.withMediaKeptUntil(orgId, async (mediaKeptUntil) =>
        this.sendCustomerEmail(
          orgId,
          workspacePausedEmail({
            orgName: org.name || 'your workspace',
            billing,
            endedAt,
            charge: await this.trialChargeTerms(
              remote,
              billing,
              row.period || remote.notes?.period || 'MONTHLY'
            ),
            mediaKeptUntil,
          }),
          'Hookpost Billing <support@hookstep.in>'
        )
      )
    );
  }

  /**
   * A workspace that gets none of the optional billing emails: one with a
   * platform super admin among its members (the founder's and reviewers'
   * workspaces) or listed in FREE_PLAN_SUNSET_EXEMPT_ORGS (internal and test
   * workspaces), the same two lists the Free-plan sunset leaves out. Emails
   * that state a charge (the trial reminder, the welcome) still go to them.
   * Unreadable counts as not internal: the email goes out.
   */
  private async isInternalWorkspace(orgId: string): Promise<boolean> {
    if (sunsetExemptOrgs().has(orgId)) return true;
    try {
      const org = await this._subscriptionService.getPolicyOrg(orgId);
      return !!org?.platformAdmin;
    } catch {
      return false;
    }
  }

  /**
   * Email every cancelled trial whose access ends in 26 to 48 hours, once per
   * subscription (sendOnce('trial-access-ending:<id>')): the date it stops
   * working, what happens then, and the last moment Reactivate works. Hourly,
   * after sendTrialReminders. Only while the trial policy is on.
   *
   * Only a trial Hookpost opened for that workspace that Razorpay says is
   * cancelled and was never charged (trialAccessUntil), cancelled at least
   * TRIAL_ACCESS_ENDING_QUIET_MS ago, with no newer mandate the customer has
   * already approved (a Reactivate or plan switch), and not an internal
   * workspace. The amount is the trial's own plan when it can be read, and
   * left out when it cannot.
   */
  async sendCancelledTrialReminders(now = new Date()) {
    if (!trialPolicyActive()) return { checked: 0, sent: 0 };
    const rows = await this._subscriptionService.getEndingRows(
      new Date(now.getTime() + TRIAL_ACCESS_ENDING_FROM_MS),
      new Date(now.getTime() + TRIAL_ACCESS_ENDING_TO_MS)
    );
    let sent = 0;
    for (const row of rows) {
      const remote = await this.client
        .request('GET', `/subscriptions/${row.identifier}`)
        .catch(() => null);
      if (
        !remote?.id ||
        remote.id !== row.identifier ||
        !isOrgSubscription(remote, row.organizationId) ||
        remote.status !== 'cancelled'
      ) {
        continue;
      }
      const endsAt = trialAccessUntil(remote) * 1000;
      const ahead = endsAt - now.getTime();
      if (
        !endsAt ||
        ahead < TRIAL_ACCESS_ENDING_FROM_MS ||
        ahead > TRIAL_ACCESS_ENDING_TO_MS
      ) {
        continue;
      }
      const cancelledAt = Number(remote.ended_at || 0) * 1000;
      if (
        cancelledAt &&
        now.getTime() - cancelledAt < TRIAL_ACCESS_ENDING_QUIET_MS
      ) {
        continue;
      }
      if (await this.isInternalWorkspace(row.organizationId)) continue;
      if (await this.hasReplacementSubscription(row.organizationId, remote)) {
        continue;
      }
      const ok = await this.sendOnce(
        `trial-access-ending:${remote.id}`,
        async () => {
          const org = await this._organizationService.getOrgById(
            row.organizationId
          );
          if (!org || (org as any).deletedAt) return false;
          const billing =
            (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
            row.subscriptionTier;
          const accessUntil = new Date(endsAt);
          return this.sendCustomerEmail(
            row.organizationId,
            trialAccessEndingEmail({
              orgName: org.name || 'your workspace',
              billing,
              accessUntil,
              charge: await this.trialChargeTerms(remote, billing, row.period),
              ...(await this.freePlanFor(row.organizationId, accessUntil)),
              now,
            }),
            'Hookpost Billing <support@hookstep.in>'
          );
        }
      );
      if (ok) sent++;
    }
    return { checked: rows.length, sent };
  }

  /**
   * Email every trial whose first charge is 24 to 48 hours away, once per
   * subscription (sendOnce('trial-reminder:<id>'), so the several processes
   * running this sweep send one between them). Hourly, after
   * endLapsedCancellations. Only while the trial policy is on
   * (trial.policy.ts): with both cutoffs empty it reads and sends nothing.
   *
   * Only a trial Hookpost opened for that workspace, still `authenticated`
   * with its first charge ahead, and not set to end (a cancelled trial is
   * never charged). The amount is the trial's own plan; when it cannot be
   * read the email is not sent rather than naming a wrong amount, and the
   * next sweep tries again.
   */
  async sendTrialReminders(now = new Date()) {
    if (!trialPolicyActive()) return { checked: 0, sent: 0 };
    const rows = await this._subscriptionService.getTrialingRows();
    let sent = 0;
    for (const row of rows) {
      const remote = await this.client
        .request('GET', `/subscriptions/${row.identifier}`)
        .catch(() => null);
      if (
        !remote?.id ||
        remote.id !== row.identifier ||
        !isOrgSubscription(remote, row.organizationId) ||
        !isTrialSubscription(remote) ||
        scheduledCancelAt(remote)
      ) {
        continue;
      }
      const chargeAt = firstChargeAt(remote);
      const ahead = chargeAt ? chargeAt.getTime() - now.getTime() : -1;
      if (ahead < TRIAL_REMINDER_FROM_MS || ahead > TRIAL_REMINDER_TO_MS) {
        continue;
      }
      const ok = await this.sendOnce(`trial-reminder:${remote.id}`, async () => {
        const charge = await this.trialChargeTerms(
          remote,
          row.subscriptionTier,
          row.period
        );
        if (!charge) return false;
        const org = await this._organizationService.getOrgById(
          row.organizationId
        );
        return this.sendCustomerEmail(
          row.organizationId,
          trialReminderEmail({
            orgName: org?.name || 'your workspace',
            billing:
              (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
              row.subscriptionTier,
            chargeAt: chargeAt!,
            charge,
          }),
          'Hookpost Billing <support@hookstep.in>'
        );
      });
      if (ok) sent++;
    }
    return { checked: rows.length, sent };
  }

  /**
   * Tell every yearly plan about its renewal 30 days ahead
   * (RENEWAL_REMINDER_TO_MS, renewalReminderEmail), once per renewal
   * (sendOnce('renewal-reminder:<id>:<charge_at>'), so the several processes
   * running this sweep send one between them, and next year's renewal is
   * told again). Hourly, after sendTrialReminders.
   *
   * Only a plan Hookpost opened for that workspace that will really renew as
   * it is: no end date on the row, Razorpay `active` (or a replacement
   * mandate waiting for its first debit) with nothing on it
   * proving it stops (scheduledCancelAt) and no plan change scheduled for the
   * renewal, a workspace that still exists and is not our
   * own. The amount is the plan's own (trialChargeTerms reads it for any
   * charge); when it cannot be read nothing is sent rather than a wrong
   * amount, and the next sweep tries again. Never throws for one plan.
   */
  async sendRenewalReminders(now = new Date()) {
    const rows = (await this._subscriptionService.getRazorpayPlanRows()).filter(
      (r: any) => r.period === 'YEARLY' && !r.cancelAt && !r.organization?.deletedAt
    );
    let sent = 0;
    for (const row of rows) {
      const remote = await this.client
        .request('GET', `/subscriptions/${row.identifier}`)
        .catch(() => null);
      // `active`, or a mandate that took the plan over (Change payment
      // method, Reactivate: notes.replaces), `authenticated` until its first
      // debit, which is the renewal. Not one opened during a trial.
      const renews =
        remote?.status === 'active' ||
        (remote?.status === 'authenticated' && !!remote.notes?.replaces && !remote.notes?.trial);
      if (
        remote?.id !== row.identifier ||
        !renews ||
        !isOrgSubscription(remote, row.organizationId) ||
        scheduledCancelAt(remote) ||
        // A plan change set for the renewal (a downgrade at cycle end): the
        // plan read here is not what renews, and the customer saw the new
        // terms when they chose it.
        remote.has_scheduled_changes
      ) {
        continue;
      }
      const chargeAt = chargeAtSeconds(remote);
      const ahead = chargeAt * 1000 - now.getTime();
      if (!chargeAt || ahead < RENEWAL_REMINDER_FROM_MS || ahead > RENEWAL_REMINDER_TO_MS) {
        continue;
      }
      if (await this.isInternalWorkspace(row.organizationId)) continue;
      const ok = await this.sendOnce(`renewal-reminder:${remote.id}:${chargeAt}`, async () => {
        const charge = await this.trialChargeTerms(remote, row.subscriptionTier, row.period);
        if (!charge || charge.period !== 'YEARLY') return false;
        const org = await this._organizationService.getOrgById(row.organizationId);
        if (!org || (org as any).deletedAt) return false;
        return this.sendCustomerEmail(
          row.organizationId,
          renewalReminderEmail({
            orgName: org.name || 'your workspace',
            billing:
              (await this.resolveTierFromPlan(remote.plan_id))?.billing ||
              row.subscriptionTier,
            renewsAt: new Date(chargeAt * 1000),
            charge,
          }),
          'Hookpost Billing <support@hookstep.in>'
        );
      }).catch((e: any) => {
        this.logger.error(`Renewal reminder for ${remote.id} failed: ${e?.message || e}`);
        return false;
      });
      if (ok) sent++;
    }
    return { checked: rows.length, sent };
  }

  /**
   * When the workspace's trial ends, for /user/self: the date the first
   * charge is due. A cancelled trial keeps working until then, and that date
   * is its cancelAt. A running one is read from Razorpay, cached for five
   * minutes per subscription and given three seconds, so the page never
   * waits on Razorpay for long. Null when it is not a trial or cannot be read.
   */
  async trialEndsAt(organizationId: string): Promise<Date | null> {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (!local?.identifier?.startsWith('sub_') || local.isLifetime) {
      return null;
    }
    if (local.cancelAt) return new Date(local.cancelAt);

    const id = local.identifier;
    const cached = this.trialEndCache.get(id);
    if (cached && Date.now() - cached.at < TRIAL_END_CACHE_MS) {
      return cached.value;
    }
    let timer: NodeJS.Timeout | undefined;
    const remote = await Promise.race([
      this.client.request('GET', `/subscriptions/${id}`).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TRIAL_END_READ_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => timer && clearTimeout(timer));
    if (!remote) return null;
    const value =
      isOrgSubscription(remote, organizationId) && isTrialSubscription(remote)
        ? firstChargeAt(remote)
        : null;
    // Only trialing workspaces land here, a handful at a time; the cap just
    // keeps a long-running process from holding stale entries forever.
    if (this.trialEndCache.size > 500) this.trialEndCache.clear();
    this.trialEndCache.set(id, { at: Date.now(), value });
    return value;
  }

  /**
   * Was any charge on this subscription refunded, by any amount (hasRefund)?
   * A refunded plan has no paid time left, whichever period the refund was.
   * Payments are read a few at a time, newest invoices first, and it stops at
   * the first refund. A read that fails counts as no refund (the plan keeps
   * its paid time) and is logged; the refund webhook ends a refunded plan
   * anyway (handleRefund).
   */
  /**
   * What an upgrade on a mandate Razorpay cannot re-plan comes to: the unused
   * days of the cycle already paid for, as time on the new plan
   * (newMandateUpgradeTerms).
   *
   * The credit is priced on what was actually taken for the cycle, read from
   * the subscription's own invoices, never on pricing.ts: a first-month
   * offer, a coupon or a plan bought at a price that has since moved all paid
   * something other than the list price, and crediting the list price would
   * hand back money nobody spent. A cycle with a refund on it has no unused
   * days left to credit - that money has already gone back.
   */
  private async upgradeTermsFor(
    sub: any,
    billing: Billing,
    period: Period,
    currency: string
  ) {
    const cycle = await this.paidCycleFor(sub);
    return newMandateUpgradeTerms({
      nowSec: Math.floor(Date.now() / 1000),
      cycle: cycle ?? { paidMinor: 0, cycleStart: 0, cycleEnd: 0 },
      newAmountMinor: this.amountFor(billing, period, currency),
      newPeriod: period,
      refunded: cycle ? await this.subscriptionRefunded(sub.id) : false,
    });
  }

  /**
   * What was paid for the cycle this subscription is in, and when that cycle
   * ends, or null when nothing was.
   *
   * The newest paid invoice is the charge that bought the cycle in progress.
   * A renewal that is still failing (currentCycleUnpaid) has a cycle Razorpay
   * opened but nobody paid for, and an invoice that closed before this cycle
   * started belongs to an earlier one: neither buys a credit. A read that
   * fails credits nothing rather than guessing an amount.
   */
  private async paidCycleFor(sub: any, depth = 0): Promise<PaidCycle | null> {
    // A mandate opened by an earlier plan change and not charged yet. Its
    // paid time is not its own cycle (it has none) but what it carried over:
    //  - an upgrade's credit, converted into time up to its start_at, of
    //    which the share still ahead is unused (a second upgrade in the
    //    same cycle keeps it);
    //  - a scheduled downgrade's or a Reactivate's: the cycle of the plan it
    //    replaced, which runs to its start_at.
    // Without this a second change in one cycle credited nothing, and the
    // customer paid twice for the same days.
    const startAt = Number(sub?.start_at || 0);
    if (
      sub?.status === 'authenticated' &&
      !sub.current_start &&
      sub.notes?.replaces &&
      startAt * 1000 > Date.now()
    ) {
      const carried = Number(sub.notes.credit || 0);
      if (carried > 0) {
        const from = Number(sub.notes.credit_at || sub.created_at || 0);
        return from && from < startAt
          ? { paidMinor: carried, cycleStart: from, cycleEnd: startAt }
          : null;
      }
      if (depth > 0) return null;
      const replaced = await this.client
        .request('GET', `/subscriptions/${sub.notes.replaces}`)
        .catch(() => null);
      if (!replaced?.id || replaced.id === sub.id) return null;
      return this.paidCycleFor(replaced, depth + 1);
    }

    const cycleStart = Number(sub?.current_start || 0);
    const cycleEnd = Number(sub?.current_end || 0);
    if (!sub?.id || !cycleStart || !cycleEnd || cycleEnd <= cycleStart) {
      return null;
    }
    if (currentCycleUnpaid(sub)) return null;

    let latest: any = null;
    try {
      const res = await this.client.request(
        'GET',
        `/invoices?subscription_id=${encodeURIComponent(sub.id)}&count=100`
      );
      for (const inv of res?.items || []) {
        if (inv?.status !== 'paid') continue;
        const closed = Number(inv.billing_end || 0);
        if (closed && closed < cycleStart) continue;
        const at = Number(inv.paid_at || inv.billing_start || inv.created_at || 0);
        if (!latest || at > latest.at) latest = { at, amount: Number(inv.amount || 0) };
      }
    } catch (e: any) {
      this.logger.warn(
        `Could not read what ${sub.id} paid for this cycle: ${e?.message || e}`
      );
    }
    if (latest?.amount > 0) {
      return { paidMinor: latest.amount, cycleStart, cycleEnd };
    }

    // No invoice to read: Razorpay was slow to raise it, the list call
    // failed, or this account keeps them elsewhere. The cycle is paid
    // (paid_count, and it is not an unpaid renewal), so credit the price the
    // subscription is actually on - its own plan, which is what was charged.
    // Still not pricing.ts: a plan bought before a price change keeps the
    // price it was bought at, and a credit must follow the money.
    if (!(Number(sub.paid_count || 0) > 0)) return null;
    // A first cycle bought with an offer was paid below the plan's price, and
    // without its invoice there is no telling how far below: credit nothing
    // rather than more than was paid.
    if (sub.offer_id && Number(sub.paid_count) <= 1) return null;
    const plan = await this.client
      .request('GET', `/plans/${sub.plan_id}`)
      .catch(() => null);
    const planAmount = Number(plan?.item?.amount || 0);
    if (!(planAmount > 0)) return null;
    return { paidMinor: planAmount, cycleStart, cycleEnd };
  }

  private async subscriptionRefunded(subscriptionId: string) {
    try {
      const res = await this.client.request(
        'GET',
        `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=100`
      );
      const paymentIds: string[] = (res?.items || [])
        .map((inv: any) => inv?.payment_id)
        .filter(Boolean);
      for (let i = 0; i < paymentIds.length; i += REFUND_READS_AT_ONCE) {
        const pays = await Promise.all(
          paymentIds.slice(i, i + REFUND_READS_AT_ONCE).map((id) =>
            this.client.request('GET', `/payments/${id}`).catch((e: any) => {
              this.logger.warn(
                `Could not read ${id} to check refunds on ${subscriptionId}: ${e?.message || e}`
              );
              return null;
            })
          )
        );
        if (pays.some((pay) => hasRefund(pay))) return true;
      }
    } catch (e) {
      this.logger.warn(`Could not check refunds on ${subscriptionId}: ${e}`);
    }
    return false;
  }

  /**
   * Does this org hold a newer Hookpost subscription the customer approved?
   * A `created` one is a checkout nobody completed (a closed Pro checkout, a
   * Reactivate answered "Not now"), not a plan the customer is moving to.
   */
  private async hasReplacementSubscription(orgId: string, cancelled: any) {
    try {
      const all = await this.getOrgSubscriptions(orgId);
      return (all?.items || []).some(
        (s: any) =>
          s?.id &&
          s.id !== cancelled.id &&
          AUTHORISED_STATES.includes(s.status) &&
          s.notes?.service === 'hookpost' &&
          s.notes?.orgId === orgId &&
          Number(s.created_at || 0) >= Number(cancelled.created_at || 0)
      );
    } catch {
      return false;
    }
  }

  /**
   * Run `send` at most once per key. The key is claimed in Redis first
   * (SET NX), because Razorpay retries webhooks and sends two refund events
   * per refund. A failed send releases the claim so a redelivery can retry.
   * If Redis cannot be reached nothing is sent: a missing email is easier to
   * put right than a customer told twice about one refund.
   */
  private async sendOnce(key: string, send: () => Promise<boolean>) {
    const redisKey = `razorpay:customer-email:${key}`;
    let claimed = false;
    try {
      claimed =
        (await (ioRedis as any).set(
          redisKey,
          new Date().toISOString(),
          'EX',
          EMAIL_ONCE_TTL_SECONDS,
          'NX'
        )) === 'OK';
    } catch (e) {
      this.logger.error(`Could not claim ${redisKey}; email not sent: ${e}`);
      return false;
    }
    if (!claimed) {
      this.logger.log(`Skipping ${key}: that email already went out.`);
      return false;
    }
    const ok = await send().catch(() => false);
    if (!ok) await this.releaseOnce(key);
    return ok;
  }

  /**
   * Send an email that says the workspace's plan has just ended, as the
   * day-0 notice of the media retention clock too, so the workspace gets one
   * email that day, not two (MediaRetentionService.claimNoticeAtPlanEnd).
   * `send` gets the date the media is kept until, or null: not on the clock
   * (a Free plan, our own workspace), already told, or the retention run is
   * off. An email that does not go out gives the notice back, and the daily
   * run sends it on its own.
   */
  private async withMediaKeptUntil(
    orgId: string,
    send: (mediaKeptUntil: Date | null) => Promise<boolean>
  ): Promise<boolean> {
    const claim =
      (await this._mediaRetention?.claimNoticeAtPlanEnd(orgId)) ?? null;
    const ok = await send(claim?.removeAt ?? null).catch((): boolean => false);
    if (!ok && claim) await this._mediaRetention!.releaseNotice(claim);
    return ok;
  }

  /** Give back a sendOnce claim, so the email can still go out. */
  private async releaseOnce(key: string) {
    await (ioRedis as any)
      .del(`razorpay:customer-email:${key}`)
      .catch(() => undefined);
  }

  /**
   * A Razorpay subscription has just taken over a workspace whose plan was
   * paid on Gumroad (createSubscription): the customer may now be paying
   * both. Logged as an error and sent once to the support inbox
   * (EMAIL_FROM_ADDRESS, where the support-ticket alerts go), so someone
   * cancels or refunds one of them. Only when the row really changed hands.
   */
  private async alertGumroadPlanReplaced(
    orgId: string,
    gumroadPlan: string,
    subscriptionId: string
  ) {
    const now = await this._subscriptionService.getSubscription(orgId);
    if (now?.identifier !== subscriptionId) return;
    const sale = gumroadPlan.slice('gumroad:'.length);
    this.logger.error(
      `Razorpay subscription ${subscriptionId} replaced org ${orgId}'s plan paid on Gumroad (sale ${sale}): the customer may be paying twice. Cancel or refund one of them.`
    );
    await this.sendOnce(`gumroad-plan-replaced:${subscriptionId}`, () =>
      this.sendSupportAlert({
        subject: 'Paying twice? Razorpay plan replaced a Gumroad plan',
        headline: 'Possibly paying on both Razorpay and Gumroad',
        summary:
          'A Razorpay subscription became this workspace\'s plan, replacing its plan paid on Gumroad. The Gumroad membership keeps charging until it is cancelled. Cancel the Gumroad membership or refund one of the two payments, and tell the customer.',
        needsAction: true,
        orgId,
        subscriptionId,
        extraFacts: [{ label: 'Gumroad sale', value: sale }],
      })
    );
  }

  /** A note to the support inbox in the shared admin template (admin.alert.email.ts). */
  private async sendSupportAlert(a: {
    subject: string;
    headline: string;
    summary: string;
    needsAction?: boolean;
    orgId?: string;
    subscriptionId?: string;
    extraFacts?: AlertFact[];
  }): Promise<boolean> {
    const subject = a.subject;
    try {
      const apiKey = process.env.RESEND_API_KEY || '';
      if (!apiKey) return false;
      const to = process.env.EMAIL_FROM_ADDRESS || 'support@hookstep.in';
      const testReason = razorpayKeyTestReason();
      const subUrl = a.subscriptionId
        ? `https://dashboard.razorpay.com/app/subscriptions/${encodeURIComponent(a.subscriptionId)}`
        : null;
      const email = adminAlertEmail({
        subject,
        headline: a.headline,
        summary: a.summary,
        needsAction: a.needsAction,
        mode: testReason ? 'test' : 'live',
        modeDetail: testReason,
        facts: [
          ...(a.extraFacts || []),
          ...(a.subscriptionId
            ? [{ label: 'Razorpay subscription', value: a.subscriptionId, href: subUrl }]
            : []),
          ...(a.orgId ? [{ label: 'Workspace id', value: a.orgId }] : []),
        ],
        primary: a.orgId
          ? { label: 'Open in admin', url: `${appUrl()}/admin/users?q=${encodeURIComponent(a.orgId)}` }
          : null,
        secondary: subUrl ? [{ label: 'Subscription in Razorpay', url: subUrl }] : [],
        reason: 'Sent to the support inbox because a billing event needs a person to look at it.',
      });
      const { Resend } = await import('resend');
      const result: any = await new Resend(apiKey).emails.send({
        from: 'Hookpost Alerts <support@hookstep.in>',
        to,
        subject,
        html: email.html,
        text: email.text,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      return true;
    } catch (e) {
      this.logger.error(`Support alert "${subject}" failed: ${e}`);
      return false;
    }
  }

  /** Send a rendered email to the workspace's billing contact (its first member). */
  private async sendCustomerEmail(
    orgId: string,
    email: RenderedEmail,
    from: string
  ): Promise<boolean> {
    try {
      const apiKey = process.env.RESEND_API_KEY || '';
      if (!apiKey) return false;
      const team = await this._organizationService.getTeam(orgId);
      const to = team?.users?.[0]?.user?.email;
      if (!to || !to.includes('@')) return false;

      const { Resend } = await import('resend');
      const result: any = await new Resend(apiKey).emails.send({
        from,
        to,
        reply_to: 'support@hookstep.in',
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      if (result?.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }
      this.logger.log(`"${email.subject}" sent to ${to} for org ${orgId}`);
      return true;
    } catch (e) {
      this.logger.error(`Billing email to org ${orgId} failed: ${e}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Customers, plans
  // ---------------------------------------------------------------------------

  async createOrGetCustomer(organization: Organization): Promise<string> {
    if (organization.paymentId) {
      return organization.paymentId;
    }
    // Mirror upstream: the billing contact is the first member of the team.
    const team = await this._organizationService.getTeam(organization.id);
    const rawEmail = team?.users?.[0]?.user?.email || '';
    // Razorpay rejects malformed emails, and self-hosted installs allow
    // username-only logins, so synthesise a domain when one is missing.
    const email =
      rawEmail.indexOf('@') > -1
        ? rawEmail
        : `${rawEmail || organization.id}@${
            process.env.BILLING_EMAIL_DOMAIN || 'hookpost.local'
          }`;

    try {
      const created = await this.client.request('POST', '/customers', {
        name: organization.name || 'Hookpost customer',
        email,
        // Do not error if a customer with this email already exists -- return it.
        fail_existing: 0,
        notes: { orgId: organization.id },
      });

      await this._subscriptionService.updateCustomerId(
        organization.id,
        created.id
      );
      return created.id;
    } catch (err: any) {
      if (
        err?.message?.includes('Customer already exists') ||
        err?.message?.includes('already exists')
      ) {
        const list = await this.client.request<{
          items: Array<{ id: string; email: string }>;
        }>('GET', `/customers?count=100`);
        const existing = list?.items?.find(
          (c) => c.email && c.email.toLowerCase() === email.toLowerCase()
        );
        if (existing?.id) {
          await this._subscriptionService.updateCustomerId(
            organization.id,
            existing.id
          );
          return existing.id;
        }
      }
      throw err;
    }
  }

  async getCustomerByOrganizationId(organizationId: string) {
    const org = await this._organizationService.getOrgById(organizationId);
    return org?.paymentId || '';
  }

  private amountFor(billing: Billing, period: Period, currency: string) {
    const curr = currency.toUpperCase();
    const planPricing = getPricing(curr);
    const p = planPricing[billing] || pricing[billing];
    const major = period === 'MONTHLY' ? p.month_price : p.year_price;
    const mult = getCurrencyConfig(curr).minorMultiplier || CURRENCY_MINOR_MULTIPLIER;
    return major * mult;
  }

  /**
   * Razorpay plans are immutable once created, so we key on the exact amount.
   * Changing a price in pricing.ts therefore provisions a new plan rather than
   * silently repricing existing subscribers.
   */
  private async findOrCreatePlan(
    billing: Billing,
    period: Period,
    currency: string,
    // Set by a percentOff coupon. The plan key includes the amount, so a
    // discounted price gets its own plan and never touches the list-price one.
    amountOverride?: number
  ) {
    const curr = currency.toUpperCase();
    const amount = amountOverride ?? this.amountFor(billing, period, curr);
    const key = buildPlanKey(billing, period, amount, curr);
    const cached = this.planCache.get(key);
    if (cached) return cached;

    // Page through every plan. Razorpay caps `count` at 100, and this account
    // may be shared with another product, so our plan can easily sit past the
    // first page. Stopping at page one would silently miss it and create a
    // duplicate plan on every single subscribe.
    const match = await this.findPlanByKey(key);
    if (match) {
      this.planCache.set(key, match);
      return match;
    }

    const created = await this.client.request('POST', '/plans', {
      period: period === 'MONTHLY' ? 'monthly' : 'yearly',
      interval: 1,
      item: {
        name: `Hookpost ${billing} ${period} (${curr})${
          amountOverride != null ? ' - coupon price' : ''
        }`,
        amount,
        currency: curr,
      },
      notes: { hookpost_key: key, billing, period },
    });
    this.planCache.set(key, created.id);
    return created.id;
  }

  /**
   * Resolve which tier/period a Razorpay plan represents.
   *
   * This is the authoritative source when reconciling a webhook, and it must be
   * preferred over the subscription's own `notes`. On an upgrade we PATCH the
   * subscription's plan_id, but Razorpay keeps the notes that were set when the
   * subscription was created -- so trusting notes.billing would write the OLD
   * tier back to the database and under-entitle a customer who just paid more.
   *
   * Plans are created by findOrCreatePlan with notes.hookpost_key of the form
   * "TIER|PERIOD|amount|currency", which we parse back out here.
   */
  private async resolveTierFromPlan(
    planId?: string
  ): Promise<{ billing: Billing; period: Period } | null> {
    if (!planId) return null;

    const cached = this.planTierCache.get(planId);
    if (cached) return cached;

    const plan = await this.readPlan(planId);
    if (!plan) return null;

    // hookpost_key is written by createPlan for every plan we own, so its
    // absence means the plan belongs to another product on this account.
    // Falling back to plan.notes.billing here would let a foreign plan named
    // after one of our tiers resolve as ours.
    const parsed = parsePlanKey(plan?.notes?.hookpost_key);
    if (!parsed) return null;

    const billing = (parsed.billing || '').toUpperCase();
    const resolvedPeriod = (
      parsed.period ||
      plan?.notes?.period ||
      (plan?.period === 'yearly' ? 'YEARLY' : 'MONTHLY')
    ).toUpperCase();

    if (!pricing[billing]) return null;

    const result = {
      billing: billing as Billing,
      period: resolvedPeriod as Period,
    };
    this.planTierCache.set(planId, result);
    return result;
  }

  /**
   * Find a plan by its hookpost_key, paging through the full list.
   *
   * Razorpay's /plans endpoint caps `count` at 100 and paginates with `skip`.
   * The cap is why this loops: on an account shared with another product our
   * plan may not be on the first page.
   */
  private async findPlanByKey(key: string): Promise<string | null> {
    const PAGE = 100;
    // Safety valve so a pathological account cannot spin forever.
    const MAX_PAGES = 50;

    for (let page = 0; page < MAX_PAGES; page++) {
      const skip = page * PAGE;
      const res = await this.client
        .request('GET', `/plans?count=${PAGE}&skip=${skip}`)
        .catch(() => null);
      const items: any[] = res?.items || [];

      const hit = items.find((plan: any) => plan?.notes?.hookpost_key === key);
      if (hit) return hit.id;

      // A short page means we have seen everything.
      if (items.length < PAGE) return null;
    }

    this.logger.warn(
      `Gave up scanning plans after ${MAX_PAGES * PAGE}; a duplicate plan may be created.`
    );
    return null;
  }

  // ---------------------------------------------------------------------------
  // Subscribe / change plan
  // ---------------------------------------------------------------------------

  /**
   * Create a new subscription, or move an existing one to a different plan.
   *
   * Returns either { url } for a fresh subscription (the caller redirects the
   * customer to Razorpay's hosted checkout to authorise the mandate) or { id }
   * when an existing mandate was rebound to a new plan without re-auth.
   */
  async subscribe(
    uniqueId: string,
    organizationId: string,
    userId: string,
    body: BillingSubscribeDto,
    allowTrial: boolean,
    hints: CheckoutHints = {}
  ) {
    // One checkout or plan change per workspace at a time. A double click on
    // Upgrade sent two requests that both read the old plan: the first
    // re-planned the card mandate and the second, finding nothing left to
    // prorate, fell through to a fresh mandate - a second plan billed beside
    // the first. The second click now gets a 409 and changes nothing.
    const lockKey = `razorpay:subscribe-lock:${organizationId}`;
    let locked = false;
    try {
      locked =
        (await (ioRedis as any).set(lockKey, '1', 'EX', 60, 'NX')) === 'OK';
    } catch (e) {
      // No Redis: carry on unlocked rather than refuse every checkout.
      this.logger.error(`Could not take ${lockKey}: ${e}`);
      locked = true;
    }
    if (!locked) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PLAN_CHANGE_IN_PROGRESS',
        message:
          'A plan change for this workspace is already going through. Give it a moment and refresh the page.',
      });
    }
    try {
      return await this.subscribeUnlocked(
        uniqueId,
        organizationId,
        userId,
        body,
        allowTrial,
        hints
      );
    } finally {
      await (ioRedis as any).del(lockKey).catch((): void => undefined);
    }
  }

  private async subscribeUnlocked(
    uniqueId: string,
    organizationId: string,
    userId: string,
    body: BillingSubscribeDto,
    allowTrial: boolean,
    hints: CheckoutHints = {}
  ) {
    const id = makeId(10);
    const billing = body.billing.toUpperCase() as Billing;
    // The single plan (HOOKPOST) is monthly only.
    const period = (
      billing === 'HOOKPOST' ? 'MONTHLY' : (body.period || 'MONTHLY').toUpperCase()
    ) as Period;

    // The server picks the currency (billing.currency.ts), from the same
    // facts the pricing context used to show this page its prices. Checked
    // first, before anything is created on Razorpay, so a refused request
    // leaves nothing behind.
    const decided = await this.checkoutCurrencyOrThrow(organizationId, {
      ...hints,
      tz: hints.tz ?? body.tz,
    });
    const { billed } = decided;
    // The one plan on sale is charged in INR to everyone (pricing.ts
    // HOOKPOST_PRICE), a foreign card included: Razorpay converts it. A live
    // plan billed in another currency can't sit beside an INR one.
    if (
      billing === 'HOOKPOST' &&
      billed?.locks &&
      billed.currency &&
      billed.currency !== SUBSCRIPTION_CURRENCY
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CURRENCY_LOCKED',
        lockedCurrency: billed.currency,
        message: `Your current plan is billed in ${billed.currency}, and a second plan in another currency can't be added beside it. Cancel it on this page and subscribe again after it ends, or email support@hookstep.in to switch sooner.`,
      });
    }
    const currency = newPurchaseCurrency(billing, decided.currency);

    // body.currency never picks the currency. Only a tab opened before 12 Oct
    // 2026 still sends it, and that tab may be showing another currency's
    // prices, which would label the payment modal with the wrong figure. Ask
    // it to reload instead. New pages never send it.
    const asked =
      typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    if (asked && asked !== currency) {
      throw new ConflictException({
        statusCode: 409,
        code: 'CURRENCY_CHANGED',
        message: 'Prices on this page are out of date. Please reload.',
      });
    }

    const org = (await this._organizationService.getOrgById(organizationId))!;
    const customerId = await this.createOrGetCustomer(org);

    // Website coupon, applied only when a subscription is created: Razorpay
    // cannot re-price a live UPI Autopay mandate. percentOff buys a discounted
    // plan for the life of the subscription; freeMonths delays its start.
    let coupon: { id: string; code: string; percentOff: number | null; freeMonths: number | null } | undefined;
    let amountOverride: number | undefined;
    if (body.coupon && body.coupon.trim()) {
      const check = await this._subscriptionService.validateCoupon(
        body.coupon,
        organizationId
      );
      if (!check.ok) {
        throw new BadRequestException(check.reason);
      }
      coupon = check.coupon;
      if (coupon.percentOff) {
        const base = this.amountFor(billing, period, currency);
        amountOverride = couponPriceMinor(base, coupon.percentOff);
      }
    }

    const planId = await this.findOrCreatePlan(
      billing,
      period,
      currency,
      amountOverride
    );

    const current = await this._subscriptionService.getSubscription(
      organizationId
    );

    if (coupon && current?.identifier) {
      throw new BadRequestException(
        'Coupons apply to new subscriptions only. This workspace already has one.'
      );
    }

    // A plan change during a trial. Neither route below fits it: Razorpay
    // refuses the in-place PATCH on UPI, and the fresh mandate it falls back
    // to has no trial (allowTrial went false when the trial started), so a
    // switch from Standard to Pro on day 2 charged Rs 1,999 at once and ended
    // the trial. Not tried in place first even on a card: what a PATCH does to
    // a trial's first charge is unproven, and this way nothing is charged
    // early.
    //
    // A trial cancelled before its first charge keeps working until that date
    // (handleCancelled), and a switch then continues it the same way, from
    // the same date, rather than charging today: the in-place PATCH below is
    // refused on a cancelled subscription and the fresh mandate after it has
    // no trial.
    const trialing = billed?.subscription;
    if (
      current?.identifier &&
      trialing &&
      billed?.identifier === current.identifier &&
      (isTrialSubscription(trialing) ||
        this.isRunningCancelledTrial(trialing, current)) &&
      isOrgSubscription(trialing, organizationId)
    ) {
      const switched = await this.switchPlanDuringTrial({
        organizationId,
        userId,
        uniqueId,
        id,
        planId,
        billing,
        period,
        currency,
        customerId,
      });
      if (switched) return switched;
    }

    // Existing mandate -> switch plans in place, no new authorisation needed.
    // Never across currencies: a plan in another currency is replaced by a new
    // mandate, which retires the old one once it is authorised. Only a plan
    // that does not lock the org (halted, pending) can get here with one.
    const crossCurrency =
      !!billed?.currency &&
      billed.identifier === current?.identifier &&
      billed.currency !== currency;
    if (crossCurrency) {
      this.logger.warn(
        `Not moving ${current?.identifier} (${billed?.currency}) onto a ${currency} plan in place; opening a new checkout for org ${organizationId}.`
      );
    }
    // Is this a plan change, and which way? The owner's policy of 29 Oct 2026
    // (razorpay.mapping.ts): an upgrade takes effect at once with the unused
    // days of the cycle already paid for credited against it; a downgrade
    // takes effect at the next billing cycle, and the workspace keeps the
    // higher plan until then.
    const liveSub =
      current?.identifier && billed?.identifier === current.identifier
        ? billed?.subscription
        : null;
    const direction: PlanChangeDirection = liveSub
      ? planChangeDirection(
          {
            billing: String(current!.subscriptionTier || ''),
            period: String(current!.period || ''),
          },
          { billing, period }
        )
      : 'same';

    // Checked before anything is created on Razorpay, so a refused change
    // leaves the plan the customer is on exactly as it was, and from the same
    // function as the preview (POST /billing/prorate), so the line the
    // customer read and the checkout they get can never disagree.
    //
    // Only a CHANGE of plan is ever refused. Buying the same plan again is
    // how a workspace whose renewal failed pays (together with "Pay from a
    // different account", which opens a replacement mandate), so a dunning
    // workspace is never left without a way out - it just cannot move the
    // price it owes while it owes it. Razorpay would refuse the move anyway:
    // "You can only update Subscriptions in the authenticated and active
    // states" (https://razorpay.com/docs/payments/subscriptions/update).
    if (liveSub && direction !== 'same') {
      const refusal = planChangeRefusal({
        direction,
        status: liveSub.status,
        crossCurrency,
        isLifetime: !!current?.isLifetime,
      });
      if (refusal) {
        throw new BadRequestException({
          statusCode: 400,
          code: refusal.code,
          message: refusal.message,
        });
      }
    }

    // The same plan again on a mandate that is in good standing is not a
    // purchase: it opened a second mandate charged in full for days already
    // paid for. Cancelled-and-still-running plans come back through
    // Reactivate (a mandate that starts where the paid time ends), and a
    // pending downgrade is called off with "Keep my current plan". A renewal
    // that is failing (pending, halted) may still buy its plan again: that is
    // how it pays.
    if (
      liveSub &&
      direction === 'same' &&
      ['active', 'authenticated', 'cancelled'].includes(String(liveSub.status))
    ) {
      const ending =
        !!scheduledCancelAt(liveSub) ||
        !!current?.cancelAt ||
        liveSub.status === 'cancelled';
      const pendingDowngrade = !!pendingDowngradeTier(liveSub);
      throw new BadRequestException({
        statusCode: 400,
        code: ending
          ? 'USE_REACTIVATE'
          : pendingDowngrade
          ? 'USE_KEEP_PLAN'
          : 'PLAN_UNCHANGED',
        message: ending
          ? 'This plan is set to end. Use Reactivate in Billing: it carries on from the date your paid time ends, so nothing is charged twice.'
          : pendingDowngrade
          ? 'Your plan already stays as it is until the change date. Use "Keep my current plan" in Billing to call the change off.'
          : "You're already on this plan.",
      });
    }

    // An upgrade that cannot be made in place carries the unused days over as
    // time on the new plan. Worked out here, before the PATCH, because the
    // PATCH may fail (UPI) and the credit must be the same either way.
    const changeTerms =
      liveSub && direction === 'upgrade'
        ? await this.upgradeTermsFor(liveSub, billing, period, currency)
        : null;

    // A plan set to end cannot be re-planned in place: Razorpay can neither
    // revoke a cancellation nor PATCH a cancelled mandate, so the change
    // would leave the workspace on a new plan that still stops on the old
    // date. A fresh mandate replaces both (the new row carries no end date),
    // which is what upgrading while cancelling has to mean.
    // Either Razorpay holds a cycle-end cancel, or Cancel was pressed and the
    // row carries the paid end (cancelAt) - which, once Cancel stops the
    // mandate at Razorpay at once, is the only place it is recorded.
    const endingSoon =
      !!liveSub && (!!scheduledCancelAt(liveSub) || !!current?.cancelAt);

    // A change whose PATCH got no answer (503 RAZORPAY_NO_ANSWER below) may
    // have landed since, whichever route this request would take: the
    // mandate (read fresh above) is already on the plan, or holds it for the
    // cycle end, so neither a second PATCH nor a new mandate is sent.
    if (liveSub && !crossCurrency && !endingSoon && (await this.inPlaceNoAnswerAt(String(liveSub.id)))) {
      const landed =
        direction === 'upgrade'
          ? liveSub.plan_id === planId
          : direction === 'downgrade' && liveSub.has_scheduled_changes
          ? (
              await this.client
                .request('GET', `/subscriptions/${liveSub.id}/retrieve_scheduled_changes`)
                .catch(() => null)
            )?.plan_id === planId
          : false;
      if (landed) {
        if (direction === 'upgrade') await this.createSubscription(liveSub);
        await this.clearInPlaceNoAnswer(String(liveSub.id));
        return {
          id,
          currency,
          direction,
          effectiveAt: direction === 'upgrade' ? ('now' as const) : ('cycle_end' as const),
        };
      }
    }

    // Only where Razorpay re-plans the mandate it holds: an international
    // card (mandateRules). UPI, e-mandate, a domestic card and anything
    // unknown open a new mandate below, the same way the preview said.
    if (
      current?.identifier &&
      !crossCurrency &&
      !endingSoon &&
      liveSub &&
      (await this.replansInPlace(liveSub))
    ) {
      // A downgrade waits for the end of the cycle already paid for; an
      // upgrade takes effect now and Razorpay raises a prorated charge for
      // the rest of the cycle. 'now' on a downgrade refunded the customer
      // the unused difference and dropped the tier the same day, which is
      // neither what the pricing page promises nor what was approved.
      const scheduleChangeAt = direction === 'downgrade' ? 'cycle_end' : 'now';
      // An earlier PATCH got no answer moments ago and may still land: send
      // nothing until it has had PATCH_NO_ANSWER_SETTLE_MS (replansInPlace
      // then sends this to a new mandate).
      if (await this.inPlaceNoAnswerAt(String(liveSub.id))) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'RAZORPAY_NO_ANSWER',
          message:
            "Razorpay didn't answer, so your plan wasn't changed and nothing was charged twice. Please try again in a minute.",
        });
      }
      try {
        await this.client.request(
          'PATCH',
          `/subscriptions/${current.identifier}`,
          {
            plan_id: planId,
            quantity: 1,
            schedule_change_at: scheduleChangeAt,
            customer_notify: 1,
            // No notes: Razorpay's Update API refuses them ("notes is/are not
            // required and should not be sent", 400), which turned every
            // in-place change since 29 Oct into a new mandate. Nothing needs
            // them: the plan says the tier (resolveTierFromPlan), and a
            // scheduled change's plan is read from retrieve_scheduled_changes
            // (scheduledChangeFor).
          }
        );
        // An upgrade is immediate here too, not when subscription.updated
        // arrives (or never, if it is lost): read the mandate back and
        // reconcile the row from its plan, the same path the webhook takes.
        // If Razorpay has not applied the plan yet (its extra charge is still
        // going through) the plan read back is the old one and nothing moves;
        // the webhook finishes it.
        if (scheduleChangeAt === 'now') {
          try {
            const applied = await this.client.request(
              'GET',
              `/subscriptions/${current.identifier}`
            );
            if (applied?.plan_id === planId) {
              await this.createSubscription(applied);
            }
          } catch (e: any) {
            this.logger.warn(
              `Upgrade of ${current.identifier} left to the webhook: ${e?.message || e}`
            );
          }
        }
        await this.clearInPlaceNoAnswer(String(current.identifier));
        return {
          id,
          currency,
          direction,
          effectiveAt: scheduleChangeAt === 'now' ? 'now' : 'cycle_end',
        };
      } catch (err) {
        // Only Razorpay saying no (a 4xx) proves nothing moved. A timeout, a
        // dropped connection or a 5xx can come after the PATCH went through,
        // with its prorated charge, and a fresh mandate on top would charge
        // the customer twice. Read the mandate back instead: applied is done,
        // anything else is refused for now, with nothing opened.
        if (!isRazorpayRefusal(err) || isRazorpayRetryLater(err)) {
          const applied = await this.client
            .request('GET', `/subscriptions/${current.identifier}`)
            .catch(() => null);
          // A cycle-end change is pending, not applied: its plan is read from
          // Razorpay's pending update (as scheduledChangeFor does), not from
          // notes Razorpay may hold back with it.
          const pending =
            scheduleChangeAt === 'cycle_end' && applied?.has_scheduled_changes
              ? await this.client
                  .request('GET', `/subscriptions/${current.identifier}/retrieve_scheduled_changes`)
                  .catch(() => null)
              : null;
          const took =
            scheduleChangeAt === 'now'
              ? applied?.plan_id === planId
              : pending?.plan_id === planId;
          if (took) {
            if (scheduleChangeAt === 'now') await this.createSubscription(applied);
            await this.clearInPlaceNoAnswer(String(current.identifier));
            this.logger.warn(
              `In-place plan change of ${current.identifier} went through despite: ${err}`
            );
            return {
              id,
              currency,
              direction,
              effectiveAt: scheduleChangeAt === 'now' ? 'now' : 'cycle_end',
            };
          }
          this.logger.error(
            `In-place plan change of ${current.identifier} has no answer; no new mandate opened: ${err}`
          );
          await (ioRedis as any)
            .set(
              `razorpay:patch-no-answer:${current.identifier}`,
              String(Date.now()),
              'EX',
              PATCH_NO_ANSWER_TTL_SECONDS,
              'NX'
            )
            .catch(() => undefined);
          throw new ServiceUnavailableException({
            statusCode: 503,
            code: 'RAZORPAY_NO_ANSWER',
            message:
              "Razorpay didn't answer, so your plan wasn't changed and nothing was charged twice. Please try again in a minute.",
          });
        }
        this.logger.error(
          `In-place plan change refused for ${current.identifier}: ${err}`
        );
        // Refused: nothing moved, so a fresh mandate is safe.
      }
    }

    // Every page advertises the trial length, and org.allowTrial decides
    // eligibility. baseTrialDays (trial.policy.ts) is TRIAL_DAYS unless
    // RAZORPAY_TRIAL_DAYS overrides it (0 turns trials off; change the copy
    // if you do). Only new checkouts read this: a trial already running keeps
    // the start_at Razorpay holds for it.
    const baseTrialDays = policyBaseTrialDays();
    // The Free plan sunset notice of 21 Oct 2026 told 25 workspaces "start
    // the 7-day trial"; those still get 7 days (trial.policy.ts
    // SUNSET_NOTICE_TRIAL_DAYS). Everyone else gets baseTrialDays.
    const trialDays =
      allowTrial && Number.isFinite(baseTrialDays) && baseTrialDays > 0
        ? await this._subscriptionService.trialDaysFor(
            organizationId,
            baseTrialDays
          )
        : baseTrialDays;

    const trialStart =
      allowTrial && Number.isFinite(trialDays) && trialDays > 0
        ? Math.floor(Date.now() / 1000) + trialDays * 86400
        : undefined;
    // freeMonths coupon: push the first charge out by that many 30-day months,
    // on top of any trial.
    const couponDelay = (coupon?.freeMonths || 0) * 30 * 86400;
    const checkoutStartAt = couponDelay
      ? (trialStart || Math.floor(Date.now() / 1000)) + couponDelay
      : trialStart;

    // A downgrade's new mandate starts where the cycle the customer paid for
    // runs out, so the higher plan runs to the last day they paid for and the
    // lower price is charged from the next cycle. Nothing is charged today.
    // Razorpay refuses a start_at that is not in the future, so a cycle
    // already over (or one Razorpay has no end for) lets the lower plan
    // simply start now, which is what it would have done anyway.
    const paidUntil = liveSub && direction === 'downgrade' ? paidThrough(liveSub) : 0;
    const downgradeStartAt =
      paidUntil > Math.floor(Date.now() / 1000) + MIN_CREDIT_LEAD_SECONDS
        ? paidUntil
        : null;

    // A plan change decides the first charge, not the trial or coupon delay:
    // a workspace with a live paid plan has neither (allowTrial went false
    // when it started, and a coupon is refused above when one is on file).
    const startAt =
      changeTerms?.startAt ?? downgradeStartAt ?? checkoutStartAt;

    // 20% off the first month (first.month.offer.ts): a new rupee monthly
    // plan charged on approval, with no coupon. Not on a trial: Razorpay
    // refuses an offer on a subscription with a start_at. The customer's
    // choice of UPI or card picks which of the two offers goes on it.
    //
    // Once per person: not for a workspace whose people already had a paid
    // plan or the offer (firstMonthOfferUsedBefore). Asked only when the
    // checkout would get it otherwise.
    const offerCheckout = {
      currency,
      period,
      coupon: !!coupon,
      startsLater: !!startAt,
      // The single plan is a flat price (the owner, 8 Nov 2026): no offer.
      newSubscription: !current?.identifier && billing !== 'HOOKPOST',
      payWith: body.payWith,
    };
    const prior = firstMonthOfferFor(offerCheckout)
      ? await this.firstMonthOfferUsedBefore(organizationId, { askRazorpay: true, userId })
      : { used: false, related: [] as string[] };
    let offer = firstMonthOfferFor({ ...offerCheckout, usedBefore: prior.used });

    const createSubscription = () =>
      this.client.request('POST', '/subscriptions', {
        plan_id: planId,
        total_count: TOTAL_COUNT[period],
        quantity: 1,
        customer_notify: 1,
        customer_id: customerId,
        ...(startAt ? { start_at: startAt } : {}),
        ...(offer ? { offer_id: offer.offerId } : {}),
        notes: {
          service: 'hookpost',
          billing,
          period,
          currency,
          orgId: organizationId,
          userId,
          id,
          ud: uniqueId,
          ...(coupon ? { coupon: coupon.code } : {}),
          // A free-months coupon starts the mandate later without being a
          // trial; the second-trial check at approval skips only these.
          ...(coupon?.freeMonths ? { free_months: String(coupon.freeMonths) } : {}),
          ...(offer ? { offer: offer.method } : {}),
          // A plan change Razorpay could not make in place. `replaces` marks
          // it a continuation rather than a trial (isTrialSubscription), so
          // the workspace is not written down as trialing and gets no second
          // welcome email; `change` and `from_*` say which way it goes and
          // what the workspace keeps until a downgrade lands
          // (pendingDowngradeTier).
          ...(liveSub && direction !== 'same'
            ? {
                replaces: liveSub.id,
                change: direction,
                from_billing: String(current!.subscriptionTier || ''),
                from_period: String(current!.period || ''),
                ...(changeTerms?.creditMinor && changeTerms.startAt
                  ? {
                      credit: String(changeTerms.creditMinor),
                      // When the credit began buying time (paidCycleFor).
                      credit_at: String(Math.floor(Date.now() / 1000)),
                    }
                  : {}),
              }
            : {}),
          // The plan this one is opened beside (a plan change the PATCH
          // could not make): its first charge is not a new customer's, for
          // the owner's sale alert. Nothing else reads it.
          ...(current?.identifier?.startsWith('sub_')
            ? { previous_plan: current.identifier }
            : {}),
        },
      });

    let created: any;
    try {
      created = await createSubscription();
    } catch (e) {
      // An offer that was disabled, has expired or ran out of uses in the
      // dashboard must not stop the customer paying: open the same checkout
      // at the full price instead.
      if (!offer) throw e;
      this.logger.warn(
        `First-month offer ${offer.offerId} refused for org ${organizationId}, checking out without it: ${(e as Error)?.message || e}`
      );
      offer = null;
      created = await createSubscription();
    }

    // The coupon is NOT redeemed here. Creating a subscription only opens
    // checkout; the plan screen rebuilds it on every tier or period toggle, and
    // most are abandoned. Redeeming at creation burned single-use codes on
    // checkouts nobody paid for, and made the second toggle fail with "already
    // used on your workspace". It is redeemed from notes.coupon when the
    // authentication webhook arrives - see recordCouponRedemption.

    // Retire this org's earlier abandoned checkouts now, and ONLY those: the
    // subscriptions still in `created`.
    //
    // createSubscription() retires superseded subscriptions when the activation
    // webhook arrives, but that can never fire for a subscription that is never
    // authenticated, and those are exactly the ones that pile up. One customer
    // produced a MONTHLY and a YEARLY mandate in the same minute on 12 Sep 2026
    // by toggling the period on the billing page; both sat in `created` until
    // they expired, and the cleanup never ran because neither ever activated.
    //
    // Restricted to 'created', the state of a checkout nobody has authorised.
    // With the full LIVE_STATES filter this cancelled a paying customer's
    // `active` plan the moment they opened checkout for a different one; if
    // they then closed that checkout, they lost their plan at the end of the
    // period already paid for and nothing replaced it. A live plan is replaced
    // only from createSubscription(), once the new one is authorised.
    //
    // Awaited rather than fired and forgotten: the function swallows and logs
    // its own errors, and a duplicate pending mandate is worse than a few
    // hundred ms before the modal.
    await this.retireSupersededSubscriptions(organizationId, created, [
      'created',
    ]);
    if (offer && prior.related.length) {
      await this.retireOtherOfferCheckouts(prior.related, created);
    }

    return {
      id,
      url: created.short_url,
      subscriptionId: created.id,
      currency,
      // When the first charge is taken (unix seconds), or null for a plan
      // charged on approval. The checkout modal states the date before the
      // customer approves the mandate.
      startAt: startAt ?? null,
      // The method whose first-month offer this subscription carries, or
      // null when it has none (the page then promises no discount).
      firstMonthOffer: offer ? offer.method : null,
    };
  }

  /**
   * subscribe() for a workspace on a trial: a new mandate for the chosen plan
   * that stays the trial, opened like a Change payment method during a trial
   * (replacementTerms). Its first charge is on the trial's own date
   * (start_at), it carries notes.trial and notes.replaces, and once the
   * customer authorises it createSubscription moves the workspace onto it and
   * retires the trial mandate. A checkout closed half-way changes nothing.
   *
   * Null when the trial has just turned into a paid plan (its first charge
   * went through since the currency check read it): subscribe() then goes on
   * as for any paying customer. replacementTerms refuses with 409 while the
   * trial's first charge is being taken.
   */
  /**
   * A trial cancelled before its first charge that is still running to that
   * date: Razorpay says cancelled, its first charge was never attempted, and
   * the workspace's row keeps it until then (cancelAt). Up to the very end:
   * a plan opened beside it then goes through replacementTerms, which
   * refuses inside FIRST_DEBIT_LEAD_SEC of that date rather than charging a
   * new mandate at once while the cancelled one's debit may still land.
   */
  private isRunningCancelledTrial(subscription: any, row: any): boolean {
    const now = Date.now();
    return (
      subscription?.status === 'cancelled' &&
      trialAccessUntil(subscription) * 1000 > now &&
      !!row?.cancelAt &&
      new Date(row.cancelAt).getTime() > now
    );
  }

  /**
   * Why nothing can be opened on a trial whose first debit may already be
   * under way (FIRST_DEBIT_LEAD_SEC), or null when there is time.
   * `firstChargeSec` is the trial's start_at; `cancelled` says the trial was
   * cancelled and is running out.
   */
  private trialDebitWindowRefusal(
    firstChargeSec: number,
    cancelled: boolean,
    nowSec: number = Math.floor(Date.now() / 1000)
  ): string | null {
    if (!firstChargeSec || firstChargeSec - nowSec >= FIRST_DEBIT_LEAD_SEC) {
      return null;
    }
    const date = formatBillingDate(new Date(firstChargeSec * 1000));
    return cancelled
      ? `Your trial ends on ${date}, and your bank may already have started its first debit, so a new plan cannot start before then. If that debit goes through, we refund it in full. Choose a plan here after ${date}.`
      : `Your trial's first payment is due on ${date}, and your bank may already have started it, so the trial cannot be changed now. Once that payment has gone through, you can switch plan or payment method here.`;
  }

  private async switchPlanDuringTrial(input: {
    organizationId: string;
    userId: string;
    uniqueId: string;
    id: string;
    planId: string;
    billing: Billing;
    period: Period;
    currency: string;
    customerId: string;
  }) {
    const { organizationId, userId, uniqueId, id, planId, billing, period, currency, customerId } = input;
    const terms = await this.replacementTerms(organizationId, 'payment_method');
    if (!terms.trial) return null;
    if (!terms.startAt) {
      // replacementTerms already refuses this; never charge a trial now.
      throw new ConflictException(
        'Your trial is ending and its first payment is being taken right now. Please try again in a few minutes, once it has gone through.'
      );
    }
    if (terms.current.plan_id === planId) {
      throw new BadRequestException('Your trial is already on this plan.');
    }

    const created = await this.client.request('POST', '/subscriptions', {
      plan_id: planId,
      total_count: TOTAL_COUNT[period],
      quantity: 1,
      customer_notify: 1,
      customer_id: terms.current.customer_id || customerId,
      start_at: terms.startAt,
      notes: {
        service: 'hookpost',
        billing,
        period,
        currency,
        orgId: organizationId,
        userId,
        id,
        ud: uniqueId,
        replaces: terms.current.id,
        reason: 'plan_change',
        trial: '1',
      },
    });

    this.logger.log(
      `Plan change during trial for org ${organizationId}: ${created.id} (${billing} ${period}) replaces ${terms.current.id} from ${terms.startAt}.`
    );

    // As in subscribe(): an earlier checkout nobody completed goes now.
    await this.retireSupersededSubscriptions(organizationId, created, [
      'created',
    ]);

    return {
      id,
      url: created.short_url as string | undefined,
      subscriptionId: created.id as string,
      currency,
      startAt: terms.startAt as number,
    };
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /**
   * Every Razorpay subscription Hookpost opened for this workspace, newest
   * first, in any state.
   *
   * GET /subscriptions has no customer filter: sending customer_id gets a 400
   * ("customer_id is/are not required and should not be sent"). This used to
   * send it and swallow the error, so it returned nothing in production and
   * every caller below silently did nothing. So page through the account
   * (count is capped at 100) and keep this workspace's own subscriptions,
   * identified by the notes our checkout stamps - the account and its
   * customers are shared with other products.
   */
  async getOrgSubscriptions(organizationId: string) {
    const customerId = await this.getCustomerByOrganizationId(organizationId);
    // No Razorpay customer means our checkout never ran for this workspace.
    if (!customerId) return { items: [] as any[], count: 0 };
    return this.listSubscriptionsWhere(
      (s) => isOrgSubscription(s, organizationId),
      `org ${organizationId}`
    );
  }

  /**
   * Every subscription on the (shared) Razorpay account that `keep` accepts,
   * read page by page. Razorpay cannot filter by notes, so the whole account
   * is listed; callers list once for several workspaces.
   */
  private async listSubscriptionsWhere(keep: (s: any) => boolean, label: string) {
    const PAGE = 100;
    // Safety valve, as in findPlanByKey.
    const MAX_PAGES = 50;
    const items: any[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.client
        .request('GET', `/subscriptions?count=${PAGE}&skip=${page * PAGE}`)
        .catch((e: any) => {
          this.logger.error(`Listing subscriptions failed: ${e}`);
          return null;
        });
      const batch: any[] = res?.items || [];
      items.push(...batch.filter(keep));
      if (batch.length < PAGE) {
        return { items, count: items.length };
      }
    }
    this.logger.warn(
      `Stopped listing subscriptions after ${MAX_PAGES * PAGE}; ${label} may hold older ones.`
    );
    return { items, count: items.length };
  }

  /**
   * The open (and approved) Hookpost subscriptions of `organizationIds` that
   * carry an offer, read in one listing. Workspaces that never opened a
   * checkout (no Razorpay customer) are not asked about.
   */
  private async offerSubscriptionsOf(organizationIds: string[]) {
    const withCustomer: string[] = [];
    for (const id of organizationIds) {
      if (await this.getCustomerByOrganizationId(id)) withCustomer.push(id);
    }
    if (!withCustomer.length) return [] as Array<{ orgId: string; sub: any }>;
    const { items } = await this.listSubscriptionsWhere(
      (s) => !!s?.offer_id && withCustomer.some((id) => isOrgSubscription(s, id)),
      `workspaces ${withCustomer.join(', ')}`
    );
    return items.map((sub) => ({ orgId: String(sub.notes.orgId), sub }));
  }

  /**
   * Whether the first-month offer is refused to `organizationId`: its people
   * already had a paid plan or the offer, here or in another workspace
   * (SubscriptionService.personHadBefore). With askRazorpay (checkout only,
   * never the pricing page), also when a workspace tied to it holds an offer
   * subscription Razorpay has approved that no webhook has reported yet:
   * two tabs, the first just paid. `related`: the tied workspaces that have
   * not had it, whose open offer checkouts retireOtherOfferCheckouts closes.
   *
   * Fails open, as the free-posts checks do: a lookup that breaks gives the
   * offer, logged, rather than refusing a new customer the price they were
   * shown.
   */
  private async firstMonthOfferUsedBefore(
    organizationId: string,
    opts: { askRazorpay?: boolean; userId?: string } = {}
  ): Promise<{ used: boolean; related: string[] }> {
    try {
      const prior = await this._subscriptionService.personHadBefore(
        organizationId,
        OFFER_ONCE_SOURCES,
        { userId: opts.userId }
      );
      if (prior.had) {
        this.logger.log(
          `No first-month offer for org ${organizationId}: already had (${prior.by}).`
        );
        return { used: true, related: [] };
      }
      if (opts.askRazorpay && prior.related.length) {
        const approved = (await this.offerSubscriptionsOf(prior.related)).find(
          ({ sub }) =>
            AUTHORISED_STATES.includes(sub.status) || Number(sub.paid_count) > 0
        );
        if (approved) {
          this.logger.log(
            `No first-month offer for org ${organizationId}: org ${approved.orgId} holds approved offer subscription ${approved.sub.id}.`
          );
          return { used: true, related: [] };
        }
      }
      return { used: false, related: prior.related };
    } catch (e: any) {
      this.logger.warn(
        `First-month offer check failed for org ${organizationId}, giving the offer: ${e?.message || e}`
      );
      return { used: false, related: [] };
    }
  }

  /** The offer's terms for this workspace's pricing context (see firstMonthOfferUsedBefore). */
  private async firstMonthOfferTermsFor(
    organizationId: string | undefined,
    currency: string,
    userId?: string
  ) {
    const terms = firstMonthOfferTerms(currency);
    if (!terms || !organizationId) return terms;
    return (await this.firstMonthOfferUsedBefore(organizationId, { userId })).used
      ? null
      : terms;
  }

  /**
   * Two tabs, two workspaces: the people behind `keep` have an offer
   * checkout open in a workspace tied to this one too. Only the newest may
   * carry the offer, so the older ones nobody has approved (`created`) are
   * cancelled; an approved one has already refused the offer to `keep`. Two
   * checkouts opened at the same moment both see the other: the older one
   * goes, and within one second (Razorpay's created_at) the lower id, so
   * exactly one survives. Never throws.
   */
  private async retireOtherOfferCheckouts(
    organizationIds: string[],
    keep: { id: string; created_at?: number }
  ) {
    try {
      const open = (await this.offerSubscriptionsOf(organizationIds)).filter(
        ({ sub }) =>
          sub.id !== keep.id &&
          sub.status === 'created' &&
          (Number(sub.created_at) < Number(keep.created_at) ||
            (Number(sub.created_at) === Number(keep.created_at) && sub.id < keep.id))
      );
      for (const { orgId, sub } of open) {
        await this.client
          .request('POST', `/subscriptions/${sub.id}/cancel`, { cancel_at_cycle_end: 0 })
          .then(() =>
            this.logger.warn(
              `Cancelled offer checkout ${sub.id} of org ${orgId}: the same people opened ${keep.id}.`
            )
          )
          .catch((e: any) =>
            this.logger.error(`Failed cancelling offer checkout ${sub.id}: ${e}`)
          );
      }
    } catch (e) {
      this.logger.error(`retireOtherOfferCheckouts failed for ${keep.id}: ${e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Currency (the rules are in billing.currency.ts)
  // ---------------------------------------------------------------------------

  /**
   * A Razorpay plan, read once per process (planByIdCache), or null when it
   * cannot be read. A failed read is not remembered, so it is tried again.
   */
  private async readPlan(planId?: string): Promise<any | null> {
    if (!planId) return null;
    const cached = this.planByIdCache.get(planId);
    if (cached) return cached;

    const plan = await this.client
      .request('GET', `/plans/${planId}`)
      .catch(() => null);
    if (plan) this.planByIdCache.set(planId, plan);
    return plan || null;
  }

  /** The currency a Razorpay plan charges in, or null if it cannot be read. */
  private async resolvePlanCurrency(planId?: string): Promise<string | null> {
    const plan = await this.readPlan(planId);
    return (
      normaliseCurrencyCode(plan?.item?.currency) ||
      // hookpost_key is TIER|PERIOD|amount|CURRENCY on every plan we created.
      normaliseCurrencyCode(
        String(plan?.notes?.hookpost_key || '').split('|')[3]
      )
    );
  }

  /**
   * The org's stored Razorpay subscription as it stands: its status, what its
   * plan charges in, and whether that holds the org to the currency. Null when
   * there is no Razorpay subscription on file (free, or a lifetime plan).
   *
   * Throws CurrencyLockUnknownError when Razorpay cannot be reached, or when a
   * plan that locks has no readable currency. A subscription Razorpay answers
   * 400/404 for (a test-mode id, another account's id) holds nothing.
   */
  private async inspectCurrentPlan(
    organizationId: string,
    now = new Date()
  ): Promise<CurrentPlan | null> {
    const row = await this._subscriptionService.getSubscription(organizationId);
    if (!row?.identifier || row.isLifetime || !row.identifier.startsWith('sub_')) {
      return null;
    }

    let remote: any;
    try {
      remote = await this.client.request(
        'GET',
        `/subscriptions/${row.identifier}`
      );
    } catch (e: any) {
      if (/\((400|404)\)/.test(String(e?.message || e))) {
        return {
          identifier: row.identifier,
          status: null,
          currency: null,
          locks: false,
          row,
          subscription: null,
        };
      }
      throw new CurrencyLockUnknownError(
        `Could not read ${row.identifier} for org ${organizationId}: ${e?.message || e}`
      );
    }

    const status: string | null = remote?.status || null;
    const locks = entitlementLocks({ row, remoteStatus: status, now });
    const currency =
      (await this.resolvePlanCurrency(remote?.plan_id)) ||
      normaliseCurrencyCode(remote?.notes?.currency);
    if (locks && !currency) {
      throw new CurrencyLockUnknownError(
        `${row.identifier} (org ${organizationId}) is ${status} but its plan currency could not be read.`
      );
    }
    return {
      identifier: row.identifier,
      status,
      currency,
      locks,
      row,
      subscription: remote || null,
    };
  }

  /**
   * The currency the org's live plan holds it to, or null when nothing does.
   * Derived from Razorpay on every call; there is no currency column.
   */
  async liveEntitlementCurrency(organizationId: string, now = new Date()) {
    const current = await this.inspectCurrentPlan(organizationId, now);
    return current?.locks ? current.currency : null;
  }

  /**
   * Who the workspace is, for decideCheckoutCurrency: its id, its creator's
   * email and the country the currency follows. The creator is read from the
   * database only when USD_CHECKOUT makes it matter, so with the switch off
   * nothing new is read. A failed read is logged and leaves the request's
   * own hints, which is what a signed-out visitor is judged on too.
   */
  private async currencySubject(
    organizationId: string,
    hints: CheckoutHints
  ): Promise<CurrencySubject> {
    let owner: { ownerCountry: string | null; ownerEmail: string | null } | null =
      null;
    if (currencyNeedsSubject()) {
      try {
        owner = await this._subscriptionService.getCurrencyFacts(organizationId);
      } catch (e: any) {
        this.logger.warn(
          `Currency for org ${organizationId} follows the request only: ${e?.message || e}`
        );
      }
    }
    return {
      orgId: organizationId,
      ownerEmail: owner?.ownerEmail ?? null,
      country: currencyCountry({
        ownerCountry: owner?.ownerCountry ?? null,
        requestCountry: hints.requestCountry ?? null,
        tz: hints.tz ?? null,
      }),
    };
  }

  /**
   * The one place the backend decides what a checkout charges and what the
   * pages show (decideCheckoutCurrency in billing.currency.ts): the live
   * plan's currency, else the USD rail where USD_CHECKOUT turns it on for
   * this workspace, else INR. The client's currency plays no part. Throws
   * CurrencyLockUnknownError.
   */
  async resolveCheckoutCurrency(
    organizationId: string,
    hints: CheckoutHints = {}
  ): Promise<CheckoutDecision & { billed: CurrentPlan | null }> {
    const billed = await this.inspectCurrentPlan(organizationId);
    const dunning =
      !billed?.locks && billed?.status && DUNNING_STATES.includes(billed.status)
        ? billed.currency
        : null;
    return {
      ...decideCheckoutCurrency({
        lockedCurrency: billed?.locks ? billed.currency : null,
        dunningCurrency: dunning,
        subject: await this.currencySubject(organizationId, hints),
        warn: (m) => this.logger.warn(m),
      }),
      billed,
    };
  }

  /** resolveCheckoutCurrency as HTTP: 409 when locked, 503 when unknown. */
  private async checkoutCurrencyOrThrow(
    organizationId: string,
    hints: CheckoutHints = {}
  ) {
    let decision: Awaited<ReturnType<RazorpayService['resolveCheckoutCurrency']>>;
    try {
      decision = await this.resolveCheckoutCurrency(organizationId, hints);
    } catch (e) {
      if (!(e instanceof CurrencyLockUnknownError)) throw e;
      this.logger.error(`Checkout refused: ${e.message}`);
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'CURRENCY_LOCK_UNKNOWN',
        message:
          'We could not check your current plan with our payment provider. Please try again in a minute.',
      });
    }

    if (!decision.allowed) {
      this.logger.warn(
        `Checkout refused for org ${organizationId}: its live plan is billed in ${decision.lockedCurrency}.`
      );
      throw new ConflictException({
        statusCode: 409,
        code: 'CURRENCY_LOCKED',
        lockedCurrency: decision.lockedCurrency,
        message: `Your current plan is billed in ${decision.lockedCurrency}, and a second plan in another currency can't be added beside it. Cancel it on this page and subscribe again after it ends, or email support@hookstep.in to switch sooner.`,
      });
    }

    if (decision.chargeCurrency !== SUBSCRIPTION_CURRENCY) {
      this.logger.log(
        `Checkout for org ${organizationId} is in ${decision.chargeCurrency} (${decision.reason}).`
      );
    }
    return { currency: decision.chargeCurrency, billed: decision.billed };
  }

  /**
   * The currency to show this org prices in: what checkout would charge it.
   * Display only, so an unreachable Razorpay falls back to INR instead of
   * failing the page.
   */
  async displayCurrencyFor(
    organizationId: string,
    hints: CheckoutHints = {}
  ): Promise<string> {
    try {
      return (await this.resolveCheckoutCurrency(organizationId, hints))
        .chargeCurrency;
    } catch (e: any) {
      this.logger.warn(`Showing INR to org ${organizationId}: ${e?.message || e}`);
      return SUBSCRIPTION_CURRENCY;
    }
  }

  /**
   * GET /public/pricing-context (no org) and GET /billing/pricing-context.
   * cf-ipcountry is read here, on the backend, and nowhere else. What it
   * shows is what checkout would charge, decided by the same function with
   * the same facts (resolveCheckoutCurrency).
   */
  async getPricingContext(input: {
    organizationId?: string;
    headers?: Record<string, string | string[] | undefined>;
    tz?: unknown;
    /** False for members who can't manage billing: they don't see the paid price. */
    includeCurrentPlan?: boolean;
    /** The member asking: whether they had the first-month offer counts too. */
    userId?: string;
  }): Promise<
    PricingContext & {
      currentPlan?: CurrentPlanPrice | null;
      scheduledChange?: ScheduledPlanChange | null;
    }
  > {
    const region = resolveRegion(input.headers, input.tz);
    const hints: CheckoutHints = {
      requestCountry: trustedCountry(input.headers),
      tz: sanitizeTz(input.tz) || null,
    };
    let decision: CheckoutDecision | null = null;
    let current: CurrentPlan | null = null;
    if (input.organizationId) {
      try {
        const resolved = await this.resolveCheckoutCurrency(
          input.organizationId,
          hints
        );
        current = resolved.billed;
        decision = resolved;
      } catch (e: any) {
        this.logger.warn(
          `Pricing context for org ${input.organizationId} shows INR: ${e?.message || e}`
        );
        decision = decideCheckoutCurrency({ env: { USD_CHECKOUT: 'off' } });
      }
    } else {
      // A signed-out visitor has no workspace: no plan, no allowlist entry.
      decision = decideCheckoutCurrency({
        subject: { country: currencyCountry(hints) },
        warn: (m) => this.logger.warn(m),
      });
    }
    const base = buildPricingContext({ decision, region });
    // The single plan sold today, paid one month at a time
    // (one.time.plan.ts): dollars everywhere but India, whatever the
    // subscription rail above would charge.
    const orderCurrency: OrderCurrency =
      input.organizationId && this._oneTimePlan
        ? await this._oneTimePlan
            .currencyFor(input.organizationId, hints)
            .catch(() => orderCurrencyFor(currencyCountry(hints)))
        : orderCurrencyFor(currencyCountry(hints));
    const context = {
      ...base,
      oneTimePlan: {
        name: ONE_TIME_PLAN_NAME,
        tier: ONE_TIME_PLAN_TIER,
        currency: orderCurrency,
        // What the order charges (INR) and what the page shows ($7).
        price: ONE_TIME_PLAN_PRICE[orderCurrency],
        label: oneTimePlanPriceLabel(orderCurrency),
      },
      // What the pages may say about the first-month offer (null: nothing).
      // Whether this checkout gets it also depends on the period, a coupon
      // and a trial, which the page knows and subscribe() checks again.
      // None for a workspace whose people already had a plan or the offer.
      // None since 8 Nov 2026: the only plan on sale (HOOKPOST) is a flat
      // price, and subscribe() puts no offer on it.
      firstMonthOffer: null,
    };
    if (!input.organizationId || input.includeCurrentPlan === false) {
      return context;
    }
    return {
      ...context,
      currentPlan: await this.currentPlanPrice(input.organizationId, current),
      // "Changes to <plan> on <date>", and whether Razorpay can simply drop
      // it again (POST /billing/plan-change/undo). Read off the subscription
      // the currency was just read from; one more call only when Razorpay
      // reports a pending change (scheduledChangeFor).
      scheduledChange:
        current?.subscription &&
        isOrgSubscription(current.subscription, input.organizationId)
          ? await this.scheduledChangeFor(current.subscription)
          : null,
    };
  }

  /**
   * Does Razorpay re-plan this mandate in place (mandateRules)? Only a card
   * mandate whose card the payments on it show to be international. Read
   * failures, a mandate with no payment yet and every other method answer
   * no: the safe path, a new mandate.
   */
  private async replansInPlace(sub: any): Promise<boolean> {
    if (!sub?.id || mandateMethod(sub.payment_method) !== 'card') return false;
    // A PATCH on it got no answer and never landed: the new-mandate route.
    const noAnswerAt = await this.inPlaceNoAnswerAt(String(sub.id));
    if (noAnswerAt && Date.now() - noAnswerAt >= PATCH_NO_ANSWER_SETTLE_MS) return false;
    return mandateRules(sub.payment_method, {
      internationalCard: await this.mandateCardIsInternational(String(sub.id)),
    }).replanInPlace;
  }

  /** When a plan PATCH on this subscription last got no answer (ms), or 0. */
  private async inPlaceNoAnswerAt(subscriptionId: string): Promise<number> {
    try {
      return Number(await (ioRedis as any).get(`razorpay:patch-no-answer:${subscriptionId}`)) || 0;
    } catch {
      return 0;
    }
  }

  private async clearInPlaceNoAnswer(subscriptionId: string) {
    await (ioRedis as any).del(`razorpay:patch-no-answer:${subscriptionId}`).catch(() => undefined);
  }

  /** Card origin per subscription, for MANDATE_CARD_TTL_MS. */
  private readonly mandateCards = new Map<string, { international: boolean; at: number }>();

  /**
   * Was the card on this subscription issued outside India? Read from its
   * newest paid invoice's payment (payment.international). Null when there
   * is no such payment yet, it is not a card payment, or Razorpay would not
   * answer. Remembered for a few minutes, as the billing page asks once per
   * plan it shows.
   */
  private async mandateCardIsInternational(subscriptionId: string): Promise<boolean | null> {
    const now = Date.now();
    const known = this.mandateCards.get(subscriptionId);
    if (known && now - known.at < MANDATE_CARD_TTL_MS) return known.international;
    try {
      const invoices = await this.client.request(
        'GET',
        `/invoices?subscription_id=${encodeURIComponent(subscriptionId)}&count=10`
      );
      const paymentId = (invoices?.items || []).find((i: any) => i?.payment_id)?.payment_id;
      if (!paymentId) return null;
      const payment = await this.client.request(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}?expand[]=card`
      );
      if (payment?.method !== 'card') return null;
      const international =
        payment.international === true || payment.card?.international === true;
      if (this.mandateCards.size > 1000) this.mandateCards.clear();
      this.mandateCards.set(subscriptionId, { international, at: now });
      return international;
    } catch (e: any) {
      this.logger.warn(
        `Could not tell where the card on ${subscriptionId} was issued: ${e?.message || e}`
      );
      return null;
    }
  }

  /**
   * /razorpay/verify, after the checkout handshake: an INR mandate authorised
   * with a card issued outside India is logged, and that is all. Refusing one
   * would lock out NRIs paying with a foreign card, and whether such a card
   * can carry an INR mandate at all is what this log is for (plan PR-4). Never
   * throws; one read-only Razorpay GET.
   */
  async noteInternationalInrAuth(
    subscriptionId: string,
    paymentId: string
  ): Promise<boolean> {
    try {
      if (!paymentId) return false;
      const payment = await this.client.request(
        'GET',
        `/payments/${encodeURIComponent(paymentId)}?expand[]=card`
      );
      const currency = String(payment?.currency || '').toUpperCase();
      const international =
        payment?.international === true || payment?.card?.international === true;
      if (currency !== 'INR' || !international) return false;
      this.logger.warn(
        `International card on an INR mandate: subscription ${subscriptionId}, payment ${paymentId} (${payment?.method || 'unknown method'}, ${payment?.card?.network || 'unknown network'} ${payment?.card?.type || ''}). Logged only; nothing was refused.`
      );
      return true;
    } catch (e: any) {
      this.logger.warn(
        `Could not check the card on ${paymentId} (${subscriptionId}): ${e?.message || e}`
      );
      return false;
    }
  }

  /**
   * What the workspace actually pays for its plan, for the plan card marked
   * "Current Plan". Read from the same subscription and plan the Change
   * payment method quote uses (chargedPlanTerms), so the card and the quote
   * can't disagree. A subscriber on an older plan keeps its price, and the
   * card used to show today's list price instead.
   *
   * No Razorpay read of its own: the subscription was just read for the
   * currency, and the plan sits in planByIdCache. Display only, so anything
   * missing or unreadable answers null and the page shows list prices. Null
   * too for a plan the quote would refuse: ended, or not opened by Hookpost.
   */
  private async currentPlanPrice(
    organizationId: string,
    current: CurrentPlan | null,
    now = new Date()
  ): Promise<CurrentPlanPrice | null> {
    const remote = current?.subscription;
    const row = current?.row;
    if (!remote?.plan_id || !row || !isOrgSubscription(remote, organizationId)) {
      return null;
    }
    const runsUntil = row.cancelAt ? new Date(row.cancelAt).getTime() : 0;
    const live =
      AUTHORISED_STATES.includes(remote.status) ||
      (remote.status === 'cancelled' && runsUntil > now.getTime());
    if (!live) return null;

    // inspectCurrentPlan read the plan for its currency. Not there means
    // that read failed; this doesn't try again.
    const plan = this.planByIdCache.get(remote.plan_id);
    if (!plan) return null;
    try {
      const terms = chargedPlanTerms({
        plan,
        tier: await this.resolveTierFromPlan(remote.plan_id),
        row,
        subscriptionNotes: remote.notes,
      });
      if (terms.amount == null || !terms.billing) return null;
      return {
        billing: terms.billing,
        period: terms.period,
        currency: terms.currency,
        amount: terms.amount,
      };
    } catch (e: any) {
      this.logger.warn(
        `Showing list prices to org ${organizationId}: ${e?.message || e}`
      );
      return null;
    }
  }

  /**
   * What a plan change costs and when it lands, for the line under each plan
   * on the billing page (POST /billing/prorate).
   *
   * An upgrade takes effect at once; a downgrade at the end of the cycle
   * already paid for. What that costs today depends only on whether Razorpay
   * can re-plan the mandate it holds:
   *
   *   - a card mandate is re-planned in place (PATCH). On an upgrade Razorpay
   *     works out the prorated difference itself and charges that, keeping the
   *     renewal date; the figure is Razorpay's and cannot be read beforehand,
   *     so no amount is claimed for today. On a downgrade (cycle_end) nothing
   *     is charged or refunded at all.
   *   - a UPI Autopay or e-mandate cannot be re-planned, so the change opens a
   *     second mandate. An upgrade converts the unused days into time on the
   *     new plan and charges nothing today (upgradeTermsFor); a downgrade's
   *     mandate simply starts where the paid cycle ends.
   *
   * Either way the unused days are credited and nothing is refunded, which is
   * what the pricing page, this line and the terms all say.
   */
  private async planChangePreview(
    sub: any,
    direction: PlanChangeDirection,
    billing: Billing,
    period: Period,
    currency: string,
    mult: number,
    target: number,
    ending = false
  ) {
    const inPlace = !ending && (await this.replansInPlace(sub));
    const renews = paidThrough(sub);

    if (direction === 'downgrade') {
      return {
        price: target,
        mode: (inPlace ? 'in_place' : 'new_mandate') as 'in_place' | 'new_mandate',
        // Nothing today on either route: the plan they paid for runs to the
        // end of its cycle and the lower price starts after it.
        chargeToday: 0 as number | null,
        recurring: target,
        currency,
        period,
        nextChargeAt: renews ? new Date(renews * 1000) : null,
        direction,
        effectiveAt: 'cycle_end' as const,
        creditApplied: 0,
      };
    }

    if (inPlace) {
      // Razorpay's own proration (inPlaceChangeMinor), priced off the plan
      // the mandate is on: that is what Razorpay reads, not what pricing.ts
      // says today. Unreadable plan or cycle: no figure is claimed.
      const oldPlan = await this.readPlan(sub.plan_id);
      const oldAmount =
        Number(oldPlan?.item?.amount || 0) * Number(sub.quantity || 1);
      const cycleStart = Number(sub.current_start || 0);
      const cycleEnd = Number(sub.current_end || 0);
      const known = oldAmount > 0 && cycleStart > 0 && cycleEnd > cycleStart;
      const sameFrequency =
        String(oldPlan?.period || '').toLowerCase() ===
        (period === 'YEARLY' ? 'yearly' : 'monthly');
      const prorated = known
        ? inPlaceChangeMinor({
            oldAmountMinor: oldAmount,
            newAmountMinor: this.amountFor(billing, period, currency),
            cycleStart,
            cycleEnd,
            nowSec: Math.floor(Date.now() / 1000),
            sameFrequency,
          })
        : null;
      return {
        price: target,
        mode: 'in_place' as const,
        chargeToday: prorated ? Math.max(prorated.amountMinor, 0) / mult : null,
        recurring: target,
        currency,
        period,
        // Same frequency: the renewal date stays. A new frequency starts its
        // interval today (Razorpay charges the new plan in full now).
        nextChargeAt: !prorated
          ? renews
            ? new Date(renews * 1000)
            : null
          : sameFrequency
          ? new Date(cycleEnd * 1000)
          : dayjs()
              .add(1, period === 'YEARLY' ? 'year' : 'month')
              .toDate(),
        direction,
        effectiveAt: 'now' as const,
        creditApplied: prorated ? prorated.creditMinor / mult : null,
      };
    }

    const terms = await this.upgradeTermsFor(sub, billing, period, currency);
    return {
      price: target,
      mode: 'new_mandate' as const,
      chargeToday: terms.chargeNowMinor / mult,
      recurring: target,
      currency,
      period,
      nextChargeAt: terms.startAt
        ? new Date(terms.startAt * 1000)
        : dayjs()
            .add(1, period === 'YEARLY' ? 'year' : 'month')
            .toDate(),
      direction,
      effectiveAt: 'now' as const,
      creditApplied: terms.creditMinor / mult,
    };
  }

  /**
   * The Razorpay subscription behind the workspace's plan: the stored one, or
   * failing that the newest authorised Hookpost subscription it holds. Never
   * an unpaid checkout (`created`), which stands for nothing yet.
   */
  private async liveSubscriptionFor(organizationId: string) {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (local?.identifier) {
      const remote = await this.client
        .request('GET', `/subscriptions/${local.identifier}`)
        .catch(() => null);
      if (remote && LIVE_STATES.includes(remote.status)) return remote;
    }
    const all = await this.getOrgSubscriptions(organizationId);
    return (all?.items || []).find((s: any) =>
      AUTHORISED_STATES.includes(s.status)
    );
  }

  /**
   * POST /billing/cancel: stop future charges, keep what was paid for.
   *
   * The cancel always goes to Razorpay at once (cancel_at_cycle_end 0),
   * whatever state the subscription is in, and this row alone keeps the
   * customer's paid access until `cancelAt`. Razorpay never holds a promise
   * we cannot read back: a cycle-end cancel leaves the subscription looking
   * exactly like one that will renew (cancelProvenAtRazorpay), so after
   * posting one there is no way to tell whether it registered. On 28 Oct 2026
   * a cycle-end cancel on sub_TXvoILk8Rch2Wo left status=active with
   * charge_at on the renewal date, and nobody could say whether the customer
   * would be charged on 11 Nov. Cancelling now removes the question: the
   * mandate is revoked, and what the customer paid for is ours to honour.
   *
   * Where the paid time ends:
   * - `active`: the end of the cycle that is paid for (paidThrough).
   * - `pending` or `halted` (the renewal was never paid): where the paid time
   *   stopped, the start of the unpaid cycle (paidThrough).
   * - a trial whose first charge is still ahead: that date
   *   (trialAccessUntil), with nothing charged. A trial with nothing paid and
   *   its first charge already attempted ends now.
   * - `authenticated` with notes.replaces (a Reactivate or Change payment
   *   method mandate before its first charge): its start_at, where the plan it
   *   replaced was paid until.
   * - a plan with a refund on it has no paid time left and ends now.
   *
   * Every one of those is read from the subscription as it was *before* the
   * cancel as well as after, and the later date wins, so nothing Razorpay
   * returns on the cancel can shorten access the customer already bought.
   *
   * Reactivate still works from here: the row keeps `cancelAt`, and
   * replacementTerms opens the new mandate with start_at on that same date, so
   * the customer is never charged twice for the period they already paid for.
   *
   * The date is saved on the row straight away, so the Cancel button does not
   * come back after a reload (Razorpay accepts one cancel per subscription).
   *
   * Any other live Hookpost subscription on the workspace stops as well: an
   * unpaid checkout, or a second plan the old plan-change bug left running.
   */
  async cancelAtPeriodEnd(
    organizationId: string,
    // For the owner's alert only: who pressed Cancel and the reason they gave.
    asked: { userId?: string; feedback?: string } = {}
  ): Promise<CancelResult> {
    // One Cancel per workspace at a time. A double click sends two requests;
    // the second used to find the subscription already cancelled at Razorpay
    // before the first had saved the end date, and told the customer to
    // email support although the cancel had worked. The second now waits for
    // the first and answers with what it saved. Redis down: no lock, as
    // before (Razorpay still takes one cancel per subscription).
    const lockKey = `razorpay:cancel-lock:${organizationId}`;
    let locked = true;
    try {
      locked =
        (await (ioRedis as any).set(
          lockKey,
          new Date().toISOString(),
          'EX',
          CANCEL_LOCK_TTL_SECONDS,
          'NX'
        )) === 'OK';
    } catch (e) {
      this.logger.warn(`Could not take ${lockKey}; cancelling unlocked: ${e}`);
    }
    if (!locked) return this.awaitCancelInFlight(organizationId);
    try {
      return await this.cancelAtPeriodEndUnlocked(organizationId, asked);
    } finally {
      await (ioRedis as any).del(lockKey).catch(() => undefined);
    }
  }

  /**
   * Another request is cancelling this workspace's plan right now: wait for
   * it to save its result, then report that, without calling Razorpay.
   */
  private async awaitCancelInFlight(organizationId: string): Promise<CancelResult> {
    const id = makeId(10);
    const until = Date.now() + CANCEL_LOCK_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      const local = await this._subscriptionService.getSubscription(
        organizationId
      );
      if (!local) {
        return { id, cancel_at: null, immediate: true, alreadyScheduled: true };
      }
      if (local.cancelAt) {
        const at = new Date(local.cancelAt);
        return {
          id,
          cancel_at: at,
          immediate: at.getTime() <= Date.now() + 60_000,
          alreadyScheduled: true,
        };
      }
    }
    throw new ConflictException(
      'Your cancellation is already being processed. Refresh the page in a moment to see it.'
    );
  }

  private async cancelAtPeriodEndUnlocked(
    organizationId: string,
    asked: { userId?: string; feedback?: string }
  ): Promise<CancelResult> {
    const id = makeId(10);
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (local?.isLifetime) {
      throw new BadRequestException(
        'This is a lifetime plan, so there is nothing to cancel.'
      );
    }
    // Paid on Gumroad (gumroad.license.ts): Razorpay holds nothing to cancel,
    // and the membership is cancelled where it was bought.
    if (isGumroadIdentifier(local?.identifier)) {
      throw new BadRequestException(
        'This plan is billed through Gumroad. Cancel it in your Gumroad library (app.gumroad.com/library); the plan here ends when the membership does.'
      );
    }
    if (!local?.identifier) {
      throw new BadRequestException(
        'This workspace has no paid plan to cancel.'
      );
    }

    const sub = await this.liveSubscriptionFor(organizationId);
    if (!sub) {
      if (local.cancelAt) {
        return {
          id,
          cancel_at: local.cancelAt,
          immediate: false,
          alreadyScheduled: true,
        };
      }
      throw new BadRequestException(
        "We couldn't find this plan's subscription at Razorpay. Email support@hookstep.in and we'll cancel it for you."
      );
    }

    const scheduled = scheduledCancelAt(sub);
    if (scheduled || (local.cancelAt && local.identifier === sub.id)) {
      const at = scheduled ? new Date(scheduled * 1000) : local.cancelAt!;
      if (!local.cancelAt) {
        await this._subscriptionService.scheduleCancellation(
          organizationId,
          local.identifier,
          at
        );
      }
      return { id, cancel_at: at, immediate: false, alreadyScheduled: true };
    }

    // A live plan with a refund on it has no paid time left: it stops
    // now, as handleCancelled has it, not at the end of a period nobody paid.
    const refunded = await this.cancelEndsOnRefund(sub);
    // The cancel reaches Razorpay at once, so its subscription.cancelled can
    // reach handleCancelled before this request finishes: the mark makes that
    // webhook leave the owner's alert to this one, which has the reason.
    await this._ownerAlerts?.mark(`cancel:${sub.id}`);
    let after: any;
    try {
      after = await this.client.request(
        'POST',
        `/subscriptions/${sub.id}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      // Razorpay takes one cancel per subscription. If this one was already
      // cancelled (from the dashboard, or a click whose response was lost),
      // go by what Razorpay says now rather than fail.
      const remote = await this.client
        .request('GET', `/subscriptions/${sub.id}`)
        .catch(() => null);
      if (remote?.status === 'cancelled' || scheduledCancelAt(remote)) {
        after = remote;
      } else {
        this.logger.error(
          `Cancel failed for ${sub.id} (org ${organizationId}): ${e?.message || e}`
        );
        await this._ownerAlerts?.unmark(`cancel:${sub.id}`);
        throw new BadRequestException(
          `Razorpay didn't accept the cancellation (${razorpayReason(e)}). Nothing has changed. Please try again, or email support@hookstep.in.`
        );
      }
    }

    // The paid end. A replacement mandate (Reactivate, Change payment method)
    // is `authenticated` until its first charge, so it is stopped now like a
    // trial, but the time up to its start_at was paid for on the plan it
    // replaced and the plan stays until then.
    //
    // A trial that never took a payment has no paid time, even with a
    // current_end from a first charge Razorpay tried and could not take
    // (pending): it ends now, as handleCancelled will have it.
    //
    // A trial whose first charge is still ahead keeps working until that
    // date, as handleCancelled will have it.
    //
    // A renewal that was never paid (pending, halted) has its current_end on
    // the unpaid cycle; the paid time stopped where that cycle started
    // (paidThrough), as handleCancelled will have it.
    const nowSec = Date.now() / 1000;
    const merged = { ...sub, ...(after?.id ? after : {}) };
    // Read from the subscription both before and after the cancel, and keep
    // the later date. The cancel response is Razorpay's, and a cancelled
    // subscription's counts or current_end could yet be presented
    // differently; access the customer has already paid for may never be
    // shortened by it, only confirmed.
    const trialEnd = Math.max(trialAccessUntil(sub), trialAccessUntil(merged));
    const end = refunded
      ? 0
      : trialEnd > nowSec + 60
        ? trialEnd
        : isUnpaidTrial(sub) && isUnpaidTrial(merged)
        ? 0
        : Math.max(
            paidThrough(sub),
            paidThrough(merged),
            replacementPaidUntil(after),
            replacementPaidUntil(sub)
          );
    const paidTimeLeft = end > nowSec + 60;
    const cancelAt = paidTimeLeft ? new Date(end * 1000) : new Date();

    // Sent as soon as Razorpay has the cancel, before anything here can fail:
    // the webhook has stood back for it (the mark). Same key as
    // handleCancelled's alert, so Razorpay's subscription.cancelled for this
    // subscription (now, or at the cycle end) is not a second email.
    // The customer's own words: kept to one line and never a clickable link.
    const feedback = defang(asked.feedback, 300);
    this.alertOwner({
      event: 'CANCEL_REQUESTED',
      key: `cancel:${sub.id}`,
      // Razorpay confirms a cycle-end cancel when the cycle ends, up to a
      // year away: the key outlives that, so it is still this one email.
      ttlSeconds: Math.ceil((cancelAt.getTime() - Date.now()) / 1000) + 7 * 86400,
      source: 'razorpay',
      organizationId,
      userId: asked.userId || sub.notes?.userId || null,
      tier: local.subscriptionTier,
      period: local.period,
      paymentMethod: sub.payment_method || null,
      ids: { subscription: sub.id },
      notes: [
        paidTimeLeft
          ? `Access until ${formatBillingDate(cancelAt)}, no further charges`
          : refunded
          ? 'A charge on it was refunded, so the plan ended now'
          : 'The plan ended now (no paid time left)',
        trialEnd > nowSec + 60 ? 'Cancelled during the trial; nothing was charged' : null,
        feedback ? `Reason given: ${feedback}` : 'No reason given',
      ],
    });

    await this._subscriptionService.scheduleCancellation(
      organizationId,
      local.identifier,
      cancelAt
    );
    // Razorpay has the cancel, so settle the plan here rather than waiting for
    // the webhook: the customer's "cancelled, works until <date>" email goes
    // out while they are still on the page, and a refunded plan ends now.
    // Razorpay's subscription.cancelled lands seconds later and finds the row
    // already saying this (handleCancelled keeps a date already on it) and the
    // email already sent (sendOnce on cancelled:<id>), so it changes nothing.
    // The refund was looked for above, so it is not looked for again.
    await this.handleCancelled(
      { ...merged, status: 'cancelled' },
      { endedByRefund: refunded }
    );
    await this.stopOtherSubscriptions(organizationId, sub.id);

    return {
      id,
      cancel_at: cancelAt,
      immediate: !paidTimeLeft,
      alreadyScheduled: false,
    };
  }

  /**
   * Does Cancel end this subscription now because a charge on it was
   * refunded (subscriptionRefunded)? Any live one: a pending or halted
   * renewal would otherwise keep the time paid before it (paidThrough). A
   * trial with nothing charged has no invoice to look at.
   */
  private async cancelEndsOnRefund(sub: any) {
    return (
      !!sub?.id &&
      LIVE_STATES.includes(sub.status) &&
      (await this.subscriptionRefunded(sub.id))
    );
  }

  /**
   * Whether Cancel would end the plan now rather than at the end of the
   * period, because a charge on it was refunded (GET /billing/cancel/quote),
   * so the confirm dialog says so. False when there is nothing Razorpay can
   * cancel or it is already set to end; POST /billing/cancel decides anyway.
   */
  async cancelQuote(organizationId: string): Promise<{ endsNow: boolean }> {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (
      !local?.identifier ||
      local.isLifetime ||
      local.cancelAt ||
      isGumroadIdentifier(local.identifier)
    ) {
      return { endsNow: false };
    }
    const sub = await this.liveSubscriptionFor(organizationId).catch(
      () => null
    );
    if (!sub || scheduledCancelAt(sub)) return { endsNow: false };
    return { endsNow: await this.cancelEndsOnRefund(sub) };
  }

  /**
   * Cancel every other live Hookpost subscription on the workspace except
   * `keepId` -- an unpaid checkout, a trial, a failing renewal, or a second
   * plan an old plan-change bug left charging. All of them stop now: the
   * workspace's access comes from its plan row, and a subscription left to
   * stop at the end of its cycle shows nothing to prove it will
   * (cancelProvenAtRazorpay). One Razorpay has already stopped is left alone.
   * Best-effort.
   */
  private async stopOtherSubscriptions(organizationId: string, keepId: string) {
    const all = await this.getOrgSubscriptions(organizationId).catch(() => ({
      items: [] as any[],
    }));
    for (const s of all?.items || []) {
      if (!s?.id || s.id === keepId || !LIVE_STATES.includes(s.status)) continue;
      if (s.status === 'active' && scheduledCancelAt(s)) continue;
      // At once, like Cancel itself: these are subscriptions the workspace
      // should not have, and its access comes from the plan row, not from
      // them. A cycle-end cancel would leave one able to charge with nothing
      // on it to prove otherwise (cancelProvenAtRazorpay).
      await this.client
        .request('POST', `/subscriptions/${s.id}/cancel`, {
          cancel_at_cycle_end: 0,
        })
        .then(() =>
          this.logger.warn(
            `Cancelled ${s.id} (${s.status}) for org ${organizationId} along with ${keepId}.`
          )
        )
        .catch((e: any) =>
          this.logger.error(`Failed cancelling ${s.id}: ${e?.message || e}`)
        );
    }
  }

  /**
   * Open a new mandate for the plan the workspace already has, to reactivate a
   * plan that is set to end, or to change how it is paid.
   *
   * Razorpay can neither undo a scheduled cancellation nor edit a UPI Autopay
   * or e-mandate ("You cannot update a Subscription authorised via UPI mode
   * or Emandate"), so both mean the customer approves a fresh mandate.
   *
   * - Same plan_id, so the same price, even where the list price has moved.
   * - The first charge lands where the current plan's paid time ends
   *   (current_end, or the end of a trial), so nothing is charged twice for
   *   one period. Only a plan whose last renewal failed (pending or halted)
   *   is charged on approval, since that period was never paid. A plan mid
   *   renewal is refused until that renewal settles.
   * - Nothing is cancelled here. Once the customer approves it, the
   *   activation webhook / checkout callback runs createSubscription, which
   *   moves the workspace onto it and retires the old one
   *   (retireSupersededSubscriptions). A checkout closed half-way leaves the
   *   current plan exactly as it was.
   *
   * notes.replaces marks it as a continuation, not a new customer: no trial
   * flag, no welcome email (createSubscription). One opened during a trial
   * also carries notes.trial, so it stays a trial until its first charge.
   *
   * The page asks quoteReplacementMandate first and calls this only once the
   * customer has agreed to those terms, so "Not now" creates nothing.
   */
  async startReplacementMandate(
    organizationId: string,
    userId: string,
    reason: ReplacementReason
  ) {
    const terms = await this.replacementTerms(organizationId, reason);
    const { current, planId, billing, period, currency, startAt, trial } = terms;

    const id = makeId(10);
    const created = await this.client.request('POST', '/subscriptions', {
      plan_id: planId,
      total_count: TOTAL_COUNT[period] || TOTAL_COUNT.MONTHLY,
      quantity: 1,
      customer_notify: 1,
      customer_id: current.customer_id,
      ...(startAt ? { start_at: startAt } : {}),
      notes: {
        service: 'hookpost',
        billing,
        period,
        currency,
        orgId: organizationId,
        userId,
        id,
        replaces: current.id,
        reason,
        ...(trial ? { trial: '1' } : {}),
      },
    });

    // As in subscribe(): an earlier checkout nobody completed goes now.
    await this.retireSupersededSubscriptions(organizationId, created, [
      'created',
    ]);

    return {
      id,
      subscriptionId: created.id as string,
      url: created.short_url as string | undefined,
      keyId: process.env.RAZORPAY_KEY_ID || '',
      providerName: 'razorpay',
      ...this.describeReplacement(terms),
    };
  }

  /**
   * What Reactivate or Change payment method would open, without opening it
   * (GET /billing/reactivate/quote and /billing/payment-method/quote).
   *
   * Same checks, same refusals and same terms as startReplacementMandate,
   * from the same two Razorpay reads (the subscription and its plan), and
   * nothing is created. The page used to create the mandate first and then
   * ask; every "Not now" left a `created` subscription behind on Razorpay.
   */
  async quoteReplacementMandate(
    organizationId: string,
    reason: ReplacementReason
  ) {
    return this.describeReplacement(
      await this.replacementTerms(organizationId, reason)
    );
  }

  /**
   * Whether the workspace's last charge failed (GET /billing/payment-issue),
   * for the banner that offers to pay from another account: `pending` while
   * Razorpay retries it, `halted` once it has stopped, else null. Null too
   * when there is no Razorpay plan on file, it is not this workspace's, or
   * Razorpay cannot be reached: the banner is a nudge, never a gate.
   */
  async paymentIssue(
    organizationId: string
  ): Promise<{ status: 'pending' | 'halted' | null }> {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (
      !local?.identifier ||
      local.isLifetime ||
      !local.identifier.startsWith('sub_')
    ) {
      return { status: null };
    }
    const remote = await this.client
      .request('GET', `/subscriptions/${local.identifier}`)
      .catch(() => null);
    if (
      !remote ||
      !isOrgSubscription(remote, organizationId) ||
      !DUNNING_STATES.includes(remote.status)
    ) {
      return { status: null };
    }
    return { status: remote.status };
  }

  /**
   * Withdraw a replacement mandate the page opened and the customer turned
   * down before checkout was shown: its terms had changed since the quote, or
   * checkout could not load.
   *
   * Only one that is still `created` (never approved, so it cannot charge),
   * opened by Hookpost for this workspace as a replacement (notes.replaces),
   * and not the workspace's current plan. Anything else is left alone and
   * answered { discarded: false }, as is a cancel Razorpay refuses: an
   * unapproved checkout left behind is retired by the next one anyway.
   */
  async discardReplacementMandate(
    organizationId: string,
    subscriptionId: string
  ) {
    if (!/^sub_[A-Za-z0-9_]+$/.test(subscriptionId || '')) {
      throw new BadRequestException('Unknown subscription.');
    }
    const sub = await this.client
      .request('GET', `/subscriptions/${subscriptionId}`)
      .catch(() => null);
    if (
      !sub ||
      sub.status !== 'created' ||
      !sub.notes?.replaces ||
      !isOrgSubscription(sub, organizationId)
    ) {
      return { discarded: false };
    }
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (local?.identifier === subscriptionId) {
      return { discarded: false };
    }
    try {
      await this.client.request(
        'POST',
        `/subscriptions/${subscriptionId}/cancel`,
        { cancel_at_cycle_end: 0 }
      );
    } catch (e: any) {
      this.logger.error(
        `Could not discard ${subscriptionId} for org ${organizationId}: ${e?.message || e}`
      );
      return { discarded: false };
    }
    this.logger.log(
      `Discarded unapproved replacement ${subscriptionId} for org ${organizationId}.`
    );
    return { discarded: true };
  }

  /**
   * The plan change this subscription holds for a future date
   * (scheduledChangeOf), with the target plan of an in-place change read from
   * Razorpay itself (GET /subscriptions/:id/retrieve_scheduled_changes): the
   * Update PATCH can carry no notes, so this read is the only place the
   * target plan is known. When it fails the line is left out, and logged.
   * Costs a call only when Razorpay says a change is pending.
   */
  private async scheduledChangeFor(sub: any) {
    if (sub?.has_scheduled_changes && !sub.cancel_at_cycle_end) {
      const pending = await this.client
        .request('GET', `/subscriptions/${sub.id}/retrieve_scheduled_changes`)
        .catch(() => null);
      const target =
        pending?.plan_id && pending.plan_id !== sub.plan_id
          ? await this.resolveTierFromPlan(pending.plan_id)
          : null;
      if (target) {
        sub = {
          ...sub,
          notes: {
            ...(sub.notes || {}),
            scheduled_billing: target.billing,
            scheduled_period: target.period,
          },
        };
      } else {
        this.logger.warn(
          `${sub.id} has a scheduled change whose plan could not be read; the billing page leaves it out.`
        );
      }
    }
    return scheduledChangeOf(sub);
  }

  /**
   * Call off a scheduled downgrade and stay on the plan the workspace is on
   * (POST /billing/plan-change/undo).
   *
   * What that takes depends on how Razorpay is holding the change, which is
   * not a choice we make - it follows the payment method:
   *
   *   - A card mandate holds it as a pending update, and Razorpay drops it
   *     (POST /subscriptions/:id/cancel_scheduled_changes). Nothing is
   *     charged, nothing is created, the plan carries on unchanged.
   *     https://razorpay.com/docs/api/payments/subscriptions/cancel-update/
   *   - A UPI Autopay or e-mandate cannot be re-planned, so the downgrade is a
   *     second subscription, and Razorpay cannot turn that back into the old
   *     mandate. Undoing it means approving a fresh mandate for the plan being
   *     kept, which is startReplacementMandate('undo_downgrade') and the
   *     Reactivate flow the page already runs. `how` on the scheduled change
   *     (GET /billing/pricing-context) says which of the two this workspace
   *     needs, so the page asks for the right one.
   *
   * A downgrade checkout nobody approved is not a scheduled change at all -
   * the workspace is still on its own plan - and is withdrawn by
   * POST /billing/replacement/discard instead.
   *
   * Idempotent: with no in-place change on file nothing is sent and
   * { undone: false } comes back, so a repeat click cannot fail.
   */
  async undoScheduledPlanChange(organizationId: string) {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (!local?.identifier?.startsWith('sub_') || local.isLifetime) {
      return { undone: false };
    }
    const sub = await this.client
      .request('GET', `/subscriptions/${local.identifier}`)
      .catch(() => null);
    if (!sub || !isOrgSubscription(sub, organizationId)) {
      return { undone: false };
    }
    if ((await this.scheduledChangeFor(sub))?.how !== 'in_place') {
      return { undone: false };
    }

    await this.client.request(
      'POST',
      `/subscriptions/${sub.id}/cancel_scheduled_changes`
    );
    this.logger.log(
      `Dropped the scheduled plan change on ${sub.id} for org ${organizationId}.`
    );
    return { undone: true };
  }

  /** The terms of a replacement mandate as the page shows them. */
  private describeReplacement(terms: {
    billing: Billing;
    period: Period;
    currency: string;
    amount: number;
    startAt?: number;
    unpaid: boolean;
  }) {
    const { billing, period, currency, amount, startAt, unpaid } = terms;
    return {
      currency,
      billing,
      period,
      amount,
      /** When the new mandate first charges; null means on approval. */
      startAt: startAt ? new Date(startAt * 1000) : null,
      chargeToday: startAt ? 0 : amount,
      /** Charged on approval because the last renewal failed. */
      unpaid: !startAt && unpaid,
    };
  }

  /**
   * Everything startReplacementMandate decides before it creates anything:
   * whether a replacement is allowed now, the plan, price and currency, and
   * when its first charge lands. Only reads Razorpay.
   */
  private async replacementTerms(
    organizationId: string,
    reason: ReplacementReason
  ) {
    const local = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (
      !local?.identifier ||
      local.isLifetime ||
      !local.identifier.startsWith('sub_')
    ) {
      throw new BadRequestException(
        'This workspace has no Razorpay plan to update. Choose a plan above to subscribe.'
      );
    }

    let current: any;
    try {
      current = await this.client.request(
        'GET',
        `/subscriptions/${local.identifier}`
      );
    } catch (e: any) {
      this.logger.error(
        `Could not read ${local.identifier} for org ${organizationId}: ${e?.message || e}`
      );
      throw new ServiceUnavailableException(
        'We could not reach our payment provider. Please try again in a minute.'
      );
    }
    if (!isOrgSubscription(current, organizationId)) {
      throw new BadRequestException(
        'This plan was not set up through Hookpost checkout. Email support@hookstep.in and we will sort it out.'
      );
    }

    // Undoing a scheduled downgrade quotes the plan the workspace is KEEPING,
    // not the one the mandate on file holds. That plan is read off the
    // subscription this mandate replaced, so the quote carries the price
    // actually being paid rather than today's list price.
    let planId: string = current.plan_id;
    if (reason === 'undo_downgrade') {
      if (!pendingDowngradeTier(current)) {
        throw new BadRequestException(
          'No plan change is waiting on this workspace.'
        );
      }
      const replaced = await this.client
        .request('GET', `/subscriptions/${current.notes.replaces}`)
        .catch(() => null);
      if (!replaced?.plan_id) {
        throw new ServiceUnavailableException(
          'We could not reach our payment provider. Please try again in a minute.'
        );
      }
      planId = replaced.plan_id;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const localEnd = local.cancelAt
      ? Math.floor(new Date(local.cancelAt).getTime() / 1000)
      : 0;
    const ending =
      !!scheduledCancelAt(current) ||
      !!local.cancelAt ||
      current.status === 'cancelled';
    const usable =
      AUTHORISED_STATES.includes(current.status) ||
      (current.status === 'cancelled' && localEnd > nowSec);
    if (!usable) {
      throw new BadRequestException(
        'This plan has already ended. Choose a plan above to subscribe again.'
      );
    }
    if (reason === 'reactivate' && !ending) {
      throw new BadRequestException(
        'Your plan is not set to end, so there is nothing to reactivate.'
      );
    }

    // When the new mandate takes its first charge: where the paid time ends
    // (or the trial does), or where the current mandate charges next.
    let paidUntil = 0;
    const charging = ['active', 'authenticated'].includes(current.status);
    if (charging) {
      paidUntil = Math.max(
        Number(current.current_end || 0),
        Number(current.charge_at || 0),
        Number(current.start_at || 0)
      );
    } else if (current.status === 'cancelled') {
      paidUntil = localEnd;
    }
    // Razorpay wants start_at in the future; too close to now and the
    // checkout could be completed after it.
    const startAt = paidUntil > nowSec + 15 * 60 ? paidUntil : undefined;
    // A plan that is still charging, with its next charge minutes away or
    // past and not yet settled, is mid-renewal (or at the end of its trial).
    // Charging the new mandate on approval would bill that period a second
    // time once the current mandate's debit lands, so wait for the outcome:
    // paid, it is `active` with a new current_end; failed, it is `pending`
    // and charging on approval is right.
    if (charging && !startAt) {
      // A plan set to end takes no further payment: it is just about to end.
      throw new ConflictException(
        ending
          ? 'Your plan ends in a few minutes. Once it has ended, choose a plan on this page to subscribe again.'
          : isTrialSubscription(current)
          ? 'Your trial is ending and its first payment is being taken right now. Please try again in a few minutes, once it has gone through.'
          : "Your plan's next payment is being taken right now. Please try again in a few minutes, once it has gone through."
      );
    }
    // Only a renewal that failed leaves time unpaid for; a cancelled plan in
    // its last minutes is paid up to its end.
    const unpaid = DUNNING_STATES.includes(current.status);
    // A mandate opened during a trial stays the trial: nothing is paid yet.
    // So does Reactivate on a cancelled trial that is still running to the
    // date its first charge was due (handleCancelled): the new mandate starts
    // on that same date, and nothing is charged before it.
    const trial =
      isTrialSubscription(current) ||
      (current.status === 'cancelled' && trialAccessUntil(current) > nowSec);
    // A trial whose first debit may already be at the bank: a new mandate
    // now could be charged beside it. Wait until it has settled (paid, it is
    // `active`; failed, `pending`, and a new mandate is right) or the
    // cancelled trial has ended.
    if (trial) {
      const refusal = this.trialDebitWindowRefusal(
        startAt || paidUntil,
        current.status === 'cancelled',
        nowSec
      );
      if (refusal) throw new ConflictException(refusal);
    }

    const plan = await this.client
      .request('GET', `/plans/${planId}`)
      .catch(() => null);
    const charged = chargedPlanTerms({
      plan,
      tier: await this.resolveTierFromPlan(planId),
      row: local,
      subscriptionNotes: current.notes,
    });
    const billing = charged.billing as Billing;
    const period = charged.period as Period;
    const currency = charged.currency;
    const mult =
      getCurrencyConfig(currency).minorMultiplier || CURRENCY_MINOR_MULTIPLIER;
    const amount =
      charged.amount ?? this.amountFor(billing, period, currency) / mult;

    return {
      current,
      planId,
      billing,
      period,
      currency,
      amount,
      /** Unix seconds of the first charge; undefined means on approval. */
      startAt,
      unpaid,
      trial,
    };
  }

  /**
   * Hard cancel, effective immediately. Only this workspace's plan ends: the
   * Razorpay customer is shared by every workspace with the same billing
   * email, and ending by customer id took the owner's other workspaces too.
   */
  /**
   * `cancelledAtProvider` says whether there was a live Razorpay subscription
   * to cancel. False means nothing was charging anyway and the plan row, if
   * there still is one, is the caller's to end (AdminPlanActionsService).
   */
  async cancelSubscription(
    organizationId: string
  ): Promise<{ ok: true; cancelledAtProvider: boolean }> {
    const sub = await this.liveSubscriptionFor(organizationId);
    if (!sub) return { ok: true, cancelledAtProvider: false };
    await this.client.request('POST', `/subscriptions/${sub.id}/cancel`, {
      cancel_at_cycle_end: 0,
    });
    await this._subscriptionService.deleteSubscriptionByOrg(organizationId);
    return { ok: true, cancelledAtProvider: true };
  }

  async cancelAllSubscriptions(organizationId: string) {
    try {
      const local = await this._subscriptionService.getSubscription(
        organizationId
      );
      if (local?.identifier) {
        const remote = await this.client
          .request('GET', `/subscriptions/${local.identifier}`)
          .catch(() => null);
        if (remote && LIVE_STATES.includes(remote.status)) {
          await this.client
            .request('POST', `/subscriptions/${local.identifier}/cancel`, {
              cancel_at_cycle_end: 0,
            })
            .catch((e: any) =>
              this.logger.error(`Failed cancelling ${local.identifier}: ${e}`)
            );
        }
      }

      const all = await this.getOrgSubscriptions(organizationId).catch(
        () => ({ items: [], count: 0 })
      );
      for (const sub of all?.items || []) {
        if (!LIVE_STATES.includes(sub.status)) continue;
        await this.client
          .request('POST', `/subscriptions/${sub.id}/cancel`, {
            cancel_at_cycle_end: 0,
          })
          .catch((e: any) =>
            this.logger.error(`Failed cancelling ${sub.id}: ${e}`)
          );
      }
      // This workspace's plan only, as above: by customer id it also ended
      // the plans of other workspaces sharing the billing email.
      const customerId = await this.getCustomerByOrganizationId(organizationId);
      if (customerId) {
        await this._subscriptionService.deleteSubscriptionByOrg(organizationId);
      }
    } catch (e: any) {
      this.logger.error(`Failed cancelAllSubscriptions for ${organizationId}: ${e}`);
    }
    return { ok: true };
  }

  async checkSubscription(organizationId: string, subscriptionId: string) {
    return this._subscriptionService.checkSubscription(
      organizationId,
      subscriptionId
    );
  }

  // ---------------------------------------------------------------------------
  // Invoices, charges, refunds
  // ---------------------------------------------------------------------------

  async getCharges(organizationId: string) {
    const customerId = await this.getCustomerByOrganizationId(organizationId);
    if (!customerId) return [];
    const invoices = await this.client.request(
      'GET',
      `/invoices?customer_id=${encodeURIComponent(customerId)}&count=100`
    );
    return (invoices?.items || []).map((inv: any) => ({
      id: inv.payment_id || inv.id,
      amount: (inv.amount || 0) / CURRENCY_MINOR_MULTIPLIER,
      currency: inv.currency,
      status: inv.status,
      created: inv.issued_at ? new Date(inv.issued_at * 1000) : null,
      invoiceUrl: inv.short_url,
      receipt: inv.receipt,
    }));
  }

  /**
   * GET /billing/invoices: the workspace's own billing history.
   *
   * GET /invoices does take customer_id (unlike /subscriptions). A Razorpay
   * customer is shared with other products and can own several workspaces,
   * so each invoice is kept only if its subscription was opened by Hookpost
   * for this workspace. Paid invoices are listed, and an unpaid one only
   * while its subscription is still running (a renewal that is due or
   * failing): an abandoned checkout also raises an invoice, and listing that
   * as "unpaid" would read like a debt.
   */
  async listInvoices(organizationId: string): Promise<BillingInvoice[]> {
    const customerId = await this.getCustomerByOrganizationId(organizationId);
    if (!customerId) return [];

    let res: any;
    try {
      res = await this.client.request(
        'GET',
        `/invoices?customer_id=${encodeURIComponent(customerId)}&count=100`
      );
    } catch (e: any) {
      this.logger.error(
        `Listing invoices failed for org ${organizationId}: ${e?.message || e}`
      );
      throw new ServiceUnavailableException(
        'We could not load your invoices from our payment provider. Please try again in a minute.'
      );
    }

    const toDate = (sec: any) => (Number(sec) > 0 ? new Date(Number(sec) * 1000) : null);
    const subs = new Map<string, any>();
    const invoices: BillingInvoice[] = [];
    for (const inv of res?.items || []) {
      if (!inv?.id) continue;
      let sub: any = null;
      if (inv.subscription_id) {
        if (!subs.has(inv.subscription_id)) {
          subs.set(
            inv.subscription_id,
            await this.client
              .request('GET', `/subscriptions/${inv.subscription_id}`)
              .catch(() => null)
          );
        }
        sub = subs.get(inv.subscription_id);
      }
      const ours = sub
        ? isOrgSubscription(sub, organizationId)
        : isOrgSubscription(inv, organizationId);
      if (!ours) continue;

      const due = inv.status === 'issued' || inv.status === 'partially_paid';
      if (
        inv.status !== 'paid' &&
        !(due && sub && AUTHORISED_STATES.includes(sub.status))
      ) {
        continue;
      }

      const currency = String(inv.currency || SUBSCRIPTION_CURRENCY).toUpperCase();
      const mult =
        getCurrencyConfig(currency).minorMultiplier || CURRENCY_MINOR_MULTIPLIER;
      const tier = sub ? await this.resolveTierFromPlan(sub.plan_id) : null;
      invoices.push({
        id: inv.id,
        date: toDate(inv.paid_at || inv.issued_at || inv.date || inv.created_at),
        periodStart: toDate(inv.billing_start),
        periodEnd: toDate(inv.billing_end),
        amount: Number(inv.amount || 0) / mult,
        currency,
        status: inv.status,
        url: inv.short_url || null,
        billing: tier?.billing || null,
        period: tier?.period || null,
      });
    }

    return invoices.sort(
      (a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0)
    );
  }

  // ---------------------------------------------------------------------------
  // Proration preview
  // ---------------------------------------------------------------------------

  /**
   * POST /billing/prorate: what switching to `body`'s plan charges, and when.
   *
   * subscribe() moves a plan in place only where Razorpay allows it, which is
   * a card mandate. A UPI Autopay or e-mandate PATCH is refused (every
   * subscription on this account so far is UPI), so the switch opens a new
   * mandate: the full price is charged when the customer approves it, the new
   * plan's cycle starts that day, and the plan it replaces is cancelled with
   * no refund for its unused days (createSubscription).
   *
   * This used to return the new price minus the unused share of the old one,
   * at list price, for every switch. Nothing ever charged that figure, so the
   * page read "Pay Today ₹1414" above a ₹1,999 charge. `price` is kept for
   * pages opened before the change and now holds what is charged today.
   */
  async prorate(
    organizationId: string,
    body: BillingSubscribeDto,
    hints: CheckoutHints = {}
  ) {
    const billing = body.billing.toUpperCase() as Billing;
    // The single plan (HOOKPOST) is monthly only.
    const period = (
      billing === 'HOOKPOST' ? 'MONTHLY' : (body.period || 'MONTHLY').toUpperCase()
    ) as Period;
    // What checkout would charge, never body.currency.
    const currency = await this.displayCurrencyFor(organizationId, {
      ...hints,
      tz: hints.tz ?? body.tz,
    });
    const mult = getCurrencyConfig(currency).minorMultiplier || CURRENCY_MINOR_MULTIPLIER;
    const target = this.amountFor(billing, period, currency) / mult;

    let sub = await this.liveSubscriptionFor(organizationId);
    let local = sub
      ? await this._subscriptionService.getSubscription(organizationId)
      : null;
    const current = {
      currentTier: (local?.subscriptionTier as string) || null,
      currentPeriod: (local?.period as string) || null,
      currentStatus: (sub?.status as string) || null,
      // `authenticated` is a trial only without notes.replaces (or with
      // notes.trial). A Reactivate or Change payment method mandate is
      // `authenticated` until its first charge too, but runs on time already
      // paid for, which a switch does not refund.
      currentIsTrial: isTrialSubscription(sub),
      currentIsPaid:
        sub?.status === 'active' ||
        (sub?.status === 'authenticated' &&
          replacementPaidUntil(sub) > Date.now() / 1000),
    };

    // A trial switched to another plan keeps its first charge on the trial's
    // date (subscribe() -> switchPlanDuringTrial): nothing is charged today,
    // on UPI or card. Inside the last day before that charge subscribe()
    // refuses until it settles (FIRST_DEBIT_LEAD_SEC), and the preview says
    // so instead of promising a switch.
    const trialFirstCharge = Number(sub?.start_at || sub?.charge_at || 0);
    const trialRefusal =
      trialFirstCharge > Date.now() / 1000
        ? this.trialDebitWindowRefusal(trialFirstCharge, false)
        : null;
    if (
      sub &&
      sub.id === local?.identifier &&
      current.currentIsTrial &&
      isOrgSubscription(sub, organizationId) &&
      trialFirstCharge > Date.now() / 1000
    ) {
      if (trialRefusal) {
        return {
          price: target,
          mode: 'new_mandate' as const,
          chargeToday: null as number | null,
          recurring: target,
          currency,
          period,
          nextChargeAt: new Date(trialFirstCharge * 1000),
          refusal: trialRefusal,
          ...current,
        };
      }
      return {
        price: 0,
        mode: 'new_mandate' as const,
        chargeToday: 0 as number | null,
        recurring: target,
        currency,
        period,
        nextChargeAt: new Date(trialFirstCharge * 1000),
        ...current,
      };
    }

    // A trial cancelled before its first charge, still running to that date:
    // a switch continues it from that date (subscribe()), nothing today.
    if (!sub) {
      const row = await this._subscriptionService.getSubscription(
        organizationId
      );
      const stored =
        row?.identifier?.startsWith('sub_') && row.cancelAt
          ? await this.client
              .request('GET', `/subscriptions/${row.identifier}`)
              .catch(() => null)
          : null;
      if (
        stored &&
        isOrgSubscription(stored, organizationId) &&
        this.isRunningCancelledTrial(stored, row)
      ) {
        const refusal = this.trialDebitWindowRefusal(
          trialAccessUntil(stored),
          true
        );
        return {
          price: refusal ? target : 0,
          mode: 'new_mandate' as const,
          chargeToday: (refusal ? null : 0) as number | null,
          recurring: target,
          currency,
          period,
          nextChargeAt: new Date(trialAccessUntil(stored) * 1000),
          ...(refusal ? { refusal } : {}),
          currentTier: (row?.subscriptionTier as string) || null,
          currentPeriod: (row?.period as string) || null,
          currentStatus: 'cancelled',
          currentIsTrial: true,
          currentIsPaid: false,
        };
      }
      // A paid plan Cancel has stopped at Razorpay at once while the row
      // keeps its paid time (cancelAtPeriodEnd): it is still the plan a
      // change is made from, read from the stored subscription exactly as
      // subscribe() reads it, so the line and the checkout agree.
      if (
        stored &&
        row &&
        isOrgSubscription(stored, organizationId) &&
        stored.status === 'cancelled' &&
        new Date(row.cancelAt!).getTime() > Date.now()
      ) {
        sub = stored;
        local = row;
        Object.assign(current, {
          currentTier: (row.subscriptionTier as string) || null,
          currentPeriod: (row.period as string) || null,
          currentStatus: 'cancelled',
          currentIsTrial: false,
          currentIsPaid: true,
        });
      }
    }

    // A plan change on a live paid plan, under the owner's policy of
    // 29 Oct 2026. Decided from the same facts and the same functions as
    // subscribe(), so the line the customer reads and the checkout they get
    // can never disagree.
    if (
      sub &&
      sub.id === local?.identifier &&
      isOrgSubscription(sub, organizationId)
    ) {
      const direction = planChangeDirection(
        {
          billing: String(local?.subscriptionTier || ''),
          period: String(local?.period || ''),
        },
        { billing, period }
      );
      if (direction !== 'same') {
        // What this mandate is billed in, from the same two places
        // chargedPlanTerms reads: its plan, then the currency our checkout
        // stamped on it. Blank is read as no mismatch, never as one.
        const billedCurrency = (
          normaliseCurrencyCode(
            this.planByIdCache.get(sub.plan_id)?.item?.currency
          ) ||
          normaliseCurrencyCode(sub.notes?.currency) ||
          ''
        ).toUpperCase();
        const refusal = planChangeRefusal({
          direction,
          status: sub.status,
          crossCurrency: !!billedCurrency && billedCurrency !== currency,
          isLifetime: !!local?.isLifetime,
        });
        if (refusal) {
          return {
            price: target,
            mode: 'new_mandate' as const,
            chargeToday: null as number | null,
            recurring: target,
            currency,
            period,
            nextChargeAt: null as Date | null,
            direction,
            refusal: refusal.message,
            refusalCode: refusal.code,
            ...current,
          };
        }
        return {
          ...(await this.planChangePreview(
            sub,
            direction,
            billing,
            period,
            currency,
            mult,
            target,
            // A plan set to end is never re-planned in place (subscribe()
            // opens a fresh mandate), so its line must not quote a card
            // proration either.
            !!scheduledCancelAt(sub) || !!local?.cancelAt
          )),
          ...current,
        };
      }
    }

    if (
      sub &&
      sub.id === local?.identifier &&
      sub.status !== 'cancelled' &&
      (await this.replansInPlace(sub))
    ) {
      // Razorpay re-plans the card mandate it holds; the cycle does not move.
      // What it charges for the rest of this cycle is Razorpay's calculation,
      // which we cannot preview, so no amount is claimed for today.
      const renews = Number(sub.current_end || 0);
      return {
        price: target,
        mode: 'in_place' as const,
        chargeToday: null as number | null,
        recurring: target,
        currency,
        period,
        nextChargeAt: renews ? new Date(renews * 1000) : null,
        ...current,
      };
    }

    return {
      price: target,
      mode: 'new_mandate' as const,
      chargeToday: target as number | null,
      recurring: target,
      currency,
      period,
      nextChargeAt: dayjs()
        .add(1, period === 'YEARLY' ? 'year' : 'month')
        .toDate(),
      ...current,
    };
  }

  // ---------------------------------------------------------------------------
  // Packages
  // ---------------------------------------------------------------------------

  /**
   * Advertised prices come straight from pricing.ts rather than the payment
   * provider, so the marketing page renders correctly even before any Razorpay
   * plan has been provisioned.
   */
  async getPackages(currency: string) {
    const curr = currency.toUpperCase();
    const activePricing = getPricing(curr);
    const tiers = Object.values(activePricing).filter((p) => p.month_price > 0);
    return {
      month: tiers.map((p) => ({
        name: p.current,
        recurring: 'month',
        price: p.month_price,
        currency: curr,
      })),
      year: tiers.map((p) => ({
        name: p.current,
        recurring: 'year',
        price: p.year_price,
        currency: curr,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Discounts / coupons
  // ---------------------------------------------------------------------------
  //
  // Razorpay Offers cannot be created over the API -- they are defined in the
  // dashboard and referenced by id. The only offer Hookpost attaches is the
  // first-month one (first.month.offer.ts), at subscribe().
  //
  // There is no retention discount. RAZORPAY_OFFER_ID used to be attached to
  // every new subscription when set, which would have broken every trial
  // checkout: Razorpay refuses an offer on a subscription with a start_at
  // (400 "Offer not applicable for this subscription", 22 Oct 2026). An
  // offer cannot be added to a live UPI mandate either, so there is nothing
  // to offer someone who is cancelling.

  async checkDiscount(_customer: string) {
    // "Has a discount already been applied?" False, so the billing page never
    // shows its "Before you cancel" offer.
    return false;
  }

  async applyDiscount(_customer: string) {
    return { ok: false, reason: 'no_offer_configured' };
  }

  // ---------------------------------------------------------------------------
  // Trial
  // ---------------------------------------------------------------------------

  /**
   * End a trial early by charging the mandate now. Razorpay does not expose a
   * "finish trial" call, so we bring the next charge forward to immediately.
   * ok is true only when Razorpay accepted that; otherwise startAt is when
   * the trial's first charge still is, if there is one. unknown is true when
   * the request may have reached Razorpay but no answer says whether it took,
   * so nobody can say whether anything was charged.
   */
  async finishTrial(
    organizationId: string
  ): Promise<{ ok: boolean; startAt?: Date | null; unknown?: boolean }> {
    if (!organizationId) return { ok: false };
    // Only a workspace that is actually on a trial. POST /billing/finish-trial
    // fires whenever /billing?finishTrial=true is opened, by anyone in the
    // workspace, so the request itself proves nothing.
    const org = await this._organizationService
      .getOrgById(organizationId)
      .catch(() => null);
    if (!org?.isTrailing) return { ok: false };
    // The workspace's own subscription. This used to list the customer's
    // subscriptions with customer_id, which Razorpay rejects, so it never
    // found one.
    const sub = await this.liveSubscriptionFor(organizationId);
    // Only a trial (authorised, first charge still ahead). Moving start_at on
    // a plan that is already charging could bill its cycle twice. A
    // replacement mandate (notes.replaces) is `authenticated` too, but its
    // first charge is set for when the paid time on the old plan ends;
    // bringing it forward would charge a period already paid for. One opened
    // during a trial (notes.trial) is still the trial.
    if (!sub || !isTrialSubscription(sub)) {
      return { ok: false };
    }

    // Razorpay refuses this on a UPI Autopay or e-mandate ("subscriptions
    // cannot be updated when payment mode is upi"). Nothing is charged then,
    // so the trial has not ended: the caller keeps the trial limits and tells
    // the customer when the first charge is.
    const startAtBefore = sub.start_at;
    try {
      await this.client.request('PATCH', `/subscriptions/${sub.id}`, {
        start_at: Math.floor(Date.now() / 1000),
        schedule_change_at: 'now',
      });
    } catch (e: any) {
      // Only a 4xx is Razorpay saying no: nothing moved and nothing was
      // charged. A dropped connection or a timeout can come after the PATCH
      // went out, and a 5xx does not say whether it was applied, so the
      // charge may already be on its way.
      if (isRazorpayRefusal(e)) {
        this.logger.warn(
          `finishTrial refused for ${sub.id} (org ${organizationId}): ${e?.message || e}`
        );
        return { ok: false, startAt: firstChargeAt(sub) };
      }
      const after = await this.client
        .request('GET', `/subscriptions/${sub.id}`)
        .catch(() => null);
      if (after && trialChargeBroughtForward(startAtBefore, after)) {
        this.logger.warn(
          `finishTrial for ${sub.id} (org ${organizationId}) went through despite: ${e?.message || e}`
        );
        return { ok: true };
      }
      this.logger.error(
        `finishTrial for ${sub.id} (org ${organizationId}) has no answer, it may or may not have charged: ${e?.message || e}`
      );
      return { ok: false, unknown: true };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Parity stubs
  // ---------------------------------------------------------------------------

  /**
   * Stripe's embedded Checkout has no Razorpay analogue: Razorpay Checkout is a
   * client-side JS modal keyed on a subscription id. We therefore create the
   * subscription and hand the frontend everything the modal needs.
   */
  async embedded(
    uniqueId: string,
    organizationId: string,
    userId: string,
    body: BillingSubscribeDto,
    allowTrial: boolean,
    hints: CheckoutHints = {}
  ) {
    const result = await this.subscribe(
      uniqueId,
      organizationId,
      userId,
      body,
      allowTrial,
      hints
    );
    return {
      ...result,
      keyId: process.env.RAZORPAY_KEY_ID || '',
      // What the subscription was created in, which the modal must show. Old
      // pages fall back to their own currency only when this is missing.
      currency: result.currency,
      providerName: 'razorpay',
    };
  }

  /**
   * Upstream syncs Stripe customer emails when two accounts are merged.
   * Razorpay customers are immutable on email, so this is a no-op we keep for
   * call-site compatibility.
   */
  async syncCustomerEmailsAfterSwitch(_users: any[]) {
    return { ok: true };
  }
}
