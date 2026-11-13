import { mandateRules } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import {
  appUrl,
  buildEmail,
  button,
  callout,
  details,
  escapeHtml,
  heading,
  link,
  paragraph,
  RenderedEmail,
  steps,
  strong,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import {
  freePlanEndDateLabel,
  MEDIA_KEPT_LINE,
  PAUSED_WORKSPACE_LINE,
  PAY_FROM_ANOTHER_ACCOUNT_PATH,
  TRIAL_DAYS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { mediaKeptSentence } from '@hookpost/nestjs-libraries/emails/templates/media.retention.emails';

// No Android app link in these emails yet. The Play listing
// (https://play.google.com/store/apps/details?id=in.hookstep.hookpost.twa)
// is public now - HTTP 200 logged out, checked 3 Oct 2026; it was a 404 on
// 29 Sep - so one can be added. The Play app is consumption-only: it hides
// all checkout (apps/frontend/src/components/layout/twa.ts), so an email may
// point people to the app for using Hookpost, never for paying.

/** "STANDARD" -> "Standard" */
export function tierLabel(billing?: string | null): string {
  if (!billing) return '';
  return billing.charAt(0) + billing.slice(1).toLowerCase();
}

/** 599 -> "₹599", 5990 -> "₹5,990", 15 -> "$15" */
export function formatMoney(amount: number, currency?: string | null): string {
  const isUsd = (currency || '').toUpperCase() === 'USD';
  const symbol = isUsd ? '$' : '₹';
  const hasPaise = Math.round(amount * 100) % 100 !== 0;
  const formatted = amount.toLocaleString(isUsd ? 'en-US' : 'en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${symbol}${formatted}`;
}

/** A dollar plan: card only, so no email mentions UPI to its customer. */
function isDollars(currency?: string | null): boolean {
  return (currency || '').toUpperCase() === 'USD';
}

/** What the trial's first charge will be, for the trial emails. */
export interface TrialChargeTerms {
  /** Major units (rupees, not paise). */
  amount: number;
  currency: string;
  period: 'MONTHLY' | 'YEARLY' | string;
  /** Razorpay's payment_method on the subscription: upi, card, emandate... */
  paymentMethod?: string | null;
}

/** "₹599/month" */
function pricePerPeriod(terms: TrialChargeTerms): string {
  return `${formatMoney(terms.amount, terms.currency)}/${
    terms.period === 'YEARLY' ? 'year' : 'month'
  }`;
}

/**
 * How to stop the first charge. The debit is set up about 24 hours before the
 * date shown (both live trial conversions), so cancelling later than that may
 * be too late.
 */
function trialCancelLines(terms: TrialChargeTerms, base: string): string {
  // A dollar mandate is a foreign card (UPI and e-mandates are rupees only),
  // with no portal we can point to. A rupee one Razorpay has not named yet
  // is most likely UPI, which every rupee payment so far has been.
  const stopOutside = isDollars(terms.currency)
    ? null
    : mandateRules(terms.paymentMethod || 'upi').stopOutside;
  return (
    paragraph(
      `Don't want to continue? ${link(
        'Cancel from Billing',
        `${base}/billing`
      )} at least 24 hours before that date and you won't be charged.${
        stopOutside ? ` ${stopOutside}` : ''
      }`
    )
  );
}

/** Razorpay webhook: first charge or trial authentication on a subscription. */
export function subscriptionWelcomeEmail(params: {
  orgName: string;
  billing: string;
  channels: number;
  period: 'MONTHLY' | 'YEARLY' | string;
  isTrial: boolean;
  /** Days until the first charge, from the Razorpay subscription. */
  trialDays?: number;
  /** When the first charge happens; shown so the customer can plan for it. */
  firstChargeAt?: Date;
  /**
   * The trial's first charge: when set (and this is a trial with a date) the
   * email states the amount and how to cancel before it. Sent while the
   * trial policy is on (trial.policy.ts).
   */
  charge?: TrialChargeTerms | null;
}): RenderedEmail {
  const { orgName, billing, channels, period, isTrial, trialDays = TRIAL_DAYS, firstChargeAt, charge } = params;
  const chargeDate = firstChargeAt
    ? firstChargeAt.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      })
    : '';
  const tier = tierLabel(billing);
  const base = appUrl();
  const disclose = isTrial && !!chargeDate && !!charge && charge.amount > 0;

  const subject = isTrial
    ? `Your Hookpost ${tier} trial has started`
    : `Welcome to Hookpost ${tier}`;

  return buildEmail(subject, {
    preheader: isTrial
      ? `Your ${trialDays}-day free trial is active. Here's how to get your first post out.`
      : `Your ${tier} plan is active. Here's how to get your first post out.`,
    kind: 'transactional',
    body:
      heading(isTrial ? `Your ${trialDays}-day trial has started` : `You're on Hookpost ${escapeHtml(tier)}`) +
      paragraph(
        `Thanks for choosing Hookpost. ${
          isTrial ? `Your ${trialDays}-day free trial` : `Your ${escapeHtml(tier)} plan`
        } is now active for ${strong(escapeHtml(orgName))}.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', `${escapeHtml(tier)} &middot; ${channels} channels`],
        ['Billing', period === 'MONTHLY' ? 'Monthly' : 'Yearly'],
        ['Status', isTrial ? `Free trial (${trialDays} days)` : 'Active'],
        ...(isTrial && chargeDate ? ([['First charge', chargeDate]] as Array<[string, string]>) : []),
        ...(disclose ? ([['Then', pricePerPeriod(charge!)]] as Array<[string, string]>) : []),
      ]) +
      (disclose
        ? paragraph(
            `On ${strong(chargeDate)} your ${escapeHtml(tier)} plan starts and ${strong(
              formatMoney(charge!.amount, charge!.currency)
            )} is charged, then the same every ${
              charge!.period === 'YEARLY' ? 'year' : 'month'
            } until you cancel.`
          ) + trialCancelLines(charge!, base)
        : '') +
      paragraph('Three steps to your first scheduled post:') +
      steps(
        [
          `${link('Connect your social channels', `${base}/launches`)}.`,
          'Write a post, or let the AI draft one, and pick a time.',
          `Check or edit what's scheduled from your phone: ${link('Hookpost', `${base}/launches`)} works in any mobile browser.`,
        ],
        { numbered: true }
      ) +
      button('Connect your channels', `${base}/launches`) +
      callout(
        `Need help connecting an account or moving your schedule from Buffer or Hootsuite? Reply to this email. I read every message.<br /><br />${strong(
          'Mohan Bhanushali'
        )}<br /><span style="color:#6B7280;font-size:13px;">Founder, Hookpost</span>`
      ),
  });
}

/**
 * The way out of a charge the bank keeps declining: a different UPI app or
 * card (PAY_FROM_ANOTHER_ACCOUNT_PATH). A retry takes the same account again,
 * so it cannot succeed while that account is short of funds.
 */
function payFromAnotherAccount(card: boolean): { label: string; href: string } {
  return {
    label: card ? 'Pay with a different card' : 'Pay from a different UPI app or card',
    href: `${appUrl()}${PAY_FROM_ANOTHER_ACCOUNT_PATH}`,
  };
}

/** What paying from another account does, said once in each failure email. */
function payFromAnotherAccountLine(money: string, card: boolean): string {
  return `If that account may be short of funds, ${
    card ? 'pay with a different card' : 'pay from a different UPI app or card'
  } instead: ${
    money ? strong(money) : 'the missed payment'
  } is charged when you approve it, and the current mandate is cancelled, so you are not charged twice.`;
}

/**
 * Razorpay webhook: subscription.pending (Razorpay is retrying a declined
 * charge) or subscription.halted (it has stopped). One per billing cycle
 * (RazorpayService.handleFailedSubscriptionPayment); payment.failed sends
 * none.
 */
export function paymentFailedEmail(params: {
  orgName: string;
  billing?: string | null;
  amount?: number;
  currency?: string;
  reason?: string;
  isHalted?: boolean;
  /**
   * The first charge after a trial failed and Razorpay will retry it
   * (subscription.pending on a subscription that has never been paid). Both
   * trials that converted on the live account had that first debit declined
   * and were captured on a retry 2-3 days later. AI and X are off while that
   * is true (trial.policy.ts `dunning`), so this email says so.
   */
  firstChargeRetrying?: boolean;
  /**
   * A halted renewal: the plan keeps working until this date, then ends
   * unless it is paid from another account (RazorpayService
   * scheduleHaltedRenewalEnd). Null when nothing was paid for past today,
   * where the plan has already ended and the cancellation email says so.
   */
  activeUntil?: Date | null;
}): RenderedEmail {
  const { orgName, billing, amount, currency, reason, isHalted, firstChargeRetrying, activeUntil } = params;
  const planName = billing ? `your ${tierLabel(billing)} plan` : 'your subscription';
  const money = amount ? formatMoney(amount, currency) : '';
  const card = isDollars(currency);
  const pay = payFromAnotherAccount(card);

  if (firstChargeRetrying && !isHalted) {
    return firstChargeRetryEmail({ orgName, billing, money, reason, card });
  }

  const subject = isHalted
    ? 'Action needed: Hookpost renewal paused'
    : "Your Hookpost payment didn't go through";

  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', billing ? escapeHtml(tierLabel(billing)) : 'Subscription renewal'],
  ];
  if (money) rows.push(['Amount', money]);
  rows.push([
    "Bank's reason",
    escapeHtml(
      reason ||
        (card ? 'Authorization declined' : 'Authorization declined or UPI mandate pending')
    ),
  ]);
  const until = isHalted && activeUntil ? formatBillingDate(activeUntil) : '';
  if (until) rows.push(['Plan active until', until]);

  if (isHalted) {
    return buildEmail(subject, {
      preheader: card
        ? 'Your bank declined every retry. Pay with a different card to keep posting.'
        : 'Your bank declined every retry. Pay from a different UPI app or card to keep posting.',
      kind: 'transactional',
      body:
        heading('Your renewal is paused') +
        paragraph(
          `Your bank declined every retry for ${escapeHtml(planName)}, so the automatic renewal is paused.`
        ) +
        details(rows) +
        paragraph(
          until
            ? `Your scheduled posts and connected channels keep working until ${strong(until)}, the end of the period you have paid for. AI writing and X are paused until the renewal goes through. To keep everything running after that date, ${
                card ? 'pay with a different card' : 'pay from a different UPI app or card'
              }; the missed renewal is charged when you approve it. Otherwise the plan ends on that date, and you won't be charged.`
            : `Your plan is ending now: the renewal was never paid, so there is no paid period left to run on. To pick it up where it stopped, ${
                card ? 'pay with a different card' : 'pay from a different UPI app or card'
              }; the missed renewal is charged when you approve it, and your channels and scheduled posts are kept meanwhile.`
        ) +
        button(pay.label, pay.href) +
        paragraph(card ? "Stuck on your card details? Reply to this email and we'll help." : "Stuck on UPI or card details? Reply to this email and we'll help.", {
          muted: true,
          small: true,
        }),
    });
  }

  return buildEmail(subject, {
    preheader: `Your bank declined ${money || 'the payment'}. Razorpay will retry it, or you can ${
      card ? 'pay with a different card' : 'pay from a different UPI app or card'
    }.`,
    kind: 'transactional',
    body:
      heading('Your bank declined the payment') +
      paragraph(
        `Your bank declined the payment${money ? ` of ${strong(money)}` : ''} for ${escapeHtml(
          planName
        )} on ${strong(escapeHtml(orgName))}. Razorpay will retry it automatically over the next few days, from the same account. Your scheduled posts and connected channels keep working meanwhile; AI writing and posting to X are paused until the renewal goes through, and if every retry fails the plan ends.`
      ) +
      details(rows) +
      paragraph(payFromAnotherAccountLine(money, card)) +
      button(pay.label, pay.href) +
      paragraph(card ? "Stuck on your card details? Reply to this email and we'll help." : "Stuck on UPI or card details? Reply to this email and we'll help.", {
        muted: true,
        small: true,
      }),
  });
}

/** The trial's first charge was declined; Razorpay retries it on its own. */
function firstChargeRetryEmail(params: {
  orgName: string;
  billing?: string | null;
  money: string;
  reason?: string;
  /** A dollar plan: card only, no UPI wording. */
  card?: boolean;
}): RenderedEmail {
  const { orgName, billing, money, reason, card } = params;
  const tier = billing ? tierLabel(billing) : '';
  const pay = payFromAnotherAccount(!!card);
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', tier ? escapeHtml(tier) : 'Subscription'],
  ];
  if (money) rows.push(['Amount', money]);
  rows.push([
    "Bank's reason",
    escapeHtml(
      reason ||
        (card ? 'Authorization declined' : 'Authorization declined or UPI mandate pending')
    ),
  ]);

  return buildEmail("Your first Hookpost payment didn't go through yet", {
    preheader: `Your bank declined it, so AI writing and X are paused. Razorpay will retry it, or you can ${
      card ? 'pay with a different card' : 'pay from a different UPI app or card'
    }.`,
    kind: 'transactional',
    body:
      heading('Your bank declined your first payment') +
      paragraph(
        `Your ${tier ? `${escapeHtml(tier)} ` : ''}trial for ${strong(
          escapeHtml(orgName)
        )} has ended, and your bank declined the first payment${
          money ? ` of ${strong(money)}` : ''
        }. Until it goes through, AI writing and posting to X are paused. Everything else carries on as usual: your scheduled posts go out to your other channels, and your drafts, media and channels are all untouched.`
      ) +
      details(rows) +
      paragraph(
        `Razorpay will retry it automatically on the same account over the next few days, and AI and X switch back on the moment one goes through. ${payFromAnotherAccountLine(
          money,
          !!card
        )}`
      ) +
      button(pay.label, pay.href) +
      paragraph(
        "If every retry fails, the trial ends and you won't be charged. Questions? Reply to this email.",
        { muted: true, small: true }
      ),
  });
}

/** "30 Sep 2026", in India time like the rest of the billing emails. */
export function formatBillingDate(date: Date): string {
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * Hourly sweep (RazorpayService.sendTrialReminders): a trial's first charge is
 * one to two days away (day 2 of the 3-day trial). Once per subscription.
 */
export function trialReminderEmail(params: {
  orgName: string;
  billing: string;
  chargeAt: Date;
  charge: TrialChargeTerms;
}): RenderedEmail {
  const { orgName, billing, chargeAt, charge } = params;
  const tier = tierLabel(billing);
  const date = formatBillingDate(chargeAt);
  const money = formatMoney(charge.amount, charge.currency);
  const base = appUrl();

  return buildEmail(`Your Hookpost ${tier} trial ends on ${date}`, {
    preheader: `${money} will be charged on ${date} unless you cancel at least 24 hours before.`,
    kind: 'transactional',
    body:
      heading(`Your trial ends on ${date}`) +
      paragraph(
        `Your Hookpost ${escapeHtml(tier)} trial for ${strong(
          escapeHtml(orgName)
        )} ends on ${strong(date)}. On that date ${strong(
          money
        )} is charged, then the same every ${
          charge.period === 'YEARLY' ? 'year' : 'month'
        } until you cancel.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', escapeHtml(tier)],
        ['First charge', date],
        ['Amount', pricePerPeriod(charge)],
      ]) +
      paragraph(
        'Keeping Hookpost? There is nothing to do: your channels and scheduled posts carry on as they are.'
      ) +
      trialCancelLines(charge, base) +
      button('Open billing', `${base}/billing`) +
      paragraph('Questions about the charge? Reply to this email.', {
        muted: true,
        small: true,
      }),
  });
}

/**
 * Hourly sweep (RazorpayService.sendRenewalReminders): a yearly plan renews
 * in 30 days (RENEWAL_REMINDER_TO_MS). Once per renewal. What Stripe's
 * "upcoming renewal" email and Zoho's pre-renewal email do, and what
 * California's auto-renewal law asks of a plan of a year or longer (a notice
 * 15 to 45 days ahead): the date, the amount, and how to stop it, where
 * Cancel keeps every feature to the end of the year already paid for.
 */
export function renewalReminderEmail(params: {
  orgName: string;
  billing: string;
  renewsAt: Date;
  charge: TrialChargeTerms;
}): RenderedEmail {
  const { orgName, billing, renewsAt, charge } = params;
  const tier = tierLabel(billing);
  const date = formatBillingDate(renewsAt);
  const price = pricePerPeriod(charge);
  const base = appUrl();

  return buildEmail(`Your Hookpost ${tier} plan renews on ${date}`, {
    preheader: `${formatMoney(charge.amount, charge.currency)} will be charged on ${date}. Nothing to do if you are keeping it.`,
    kind: 'transactional',
    body:
      heading(`Your plan renews on ${date}`) +
      paragraph(
        `Your yearly Hookpost ${escapeHtml(tier)} plan for ${strong(
          escapeHtml(orgName)
        )} renews on ${strong(date)}, and ${strong(
          formatMoney(charge.amount, charge.currency)
        )} is charged then for the next year.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', `${escapeHtml(tier)} &middot; Yearly`],
        ['Renews on', date],
        ['Amount', price],
      ]) +
      paragraph(
        'Keeping Hookpost? There is nothing to do: your channels and scheduled posts carry on as they are.'
      ) +
      paragraph(
        `Not renewing? Press Cancel in Billing before ${date}. Nothing more is charged, and you keep every feature until ${date}.`
      ) +
      button('Open billing', `${base}/billing`) +
      paragraph('Questions about the renewal? Reply to this email.', {
        muted: true,
        small: true,
      }),
  });
}

/** "25 Oct 2026, 5:30 pm IST": a date and time in India time. */
export function formatBillingDateTime(date: Date): string {
  const time = date
    .toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata',
    })
    .toLowerCase();
  return `${formatBillingDate(date)}, ${time} IST`;
}

/** The calendar day of `date` in India, as YYYY-MM-DD. */
function indiaDay(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * "today", "tomorrow" or "on 25 Oct 2026": when `at` falls in India's
 * calendar, seen from `now`. A subject says "tomorrow" only when it is.
 */
export function relativeDayLabel(at: Date, now: Date = new Date()): string {
  const day = indiaDay(at);
  if (day === indiaDay(now)) return 'today';
  if (day === indiaDay(new Date(now.getTime() + 86_400_000))) return 'tomorrow';
  return `on ${formatBillingDate(at)}`;
}

/** How long before a trial's first-charge date a new mandate is refused. */
const FIRST_DEBIT_LEAD_MS = 24 * 3600 * 1000;

/**
 * Hourly sweep (RazorpayService.sendCancelledTrialReminders): a trial the
 * customer cancelled is still running to the date its first charge was due
 * (`accessUntil`), which is a day or two away. Once per subscription.
 *
 * Reactivate opens a new mandate whose first charge stays on that date
 * (startReplacementMandate), and Billing refuses one inside the last 24
 * hours (FIRST_DEBIT_LEAD_SEC: the cancelled mandate's debit may already be
 * at the bank). So the email names the last moment Reactivate works, and is
 * sent while there is still time to use it.
 *
 * The subject says "access ends" for a workspace that is paused afterwards
 * (no Free plan, freePlanAvailable false) and "trial ends" for one that
 * moves to the Free plan, which keeps access.
 */
export function trialAccessEndingEmail(params: {
  orgName: string;
  billing: string;
  /** When the cancelled trial stops working: the first charge's date. */
  accessUntil: Date;
  /** The trial plan's charge, when it could be read; the amount is left out otherwise. */
  charge?: TrialChargeTerms | null;
  freePlanAvailable: boolean;
  freePlanEndsAt?: Date | null;
  /** The moment the email is sent (tests fix it). */
  now?: Date;
}): RenderedEmail {
  const {
    orgName,
    billing,
    accessUntil,
    charge,
    freePlanAvailable,
    freePlanEndsAt = null,
    now = new Date(),
  } = params;
  const tier = tierLabel(billing);
  const when = relativeDayLabel(accessUntil, now);
  const until = formatBillingDateTime(accessUntil);
  const date = formatBillingDate(accessUntil);
  const reactivateBy = formatBillingDateTime(
    new Date(accessUntil.getTime() - FIRST_DEBIT_LEAD_MS)
  );
  const what = freePlanAvailable
    ? `Your Hookpost ${tier} trial ends ${when}`
    : `Your Hookpost access ends ${when}`;
  const method = isDollars(charge?.currency)
    ? 'your card'
    : 'UPI AutoPay or your card';

  return buildEmail(`${what}: reactivate to keep it`, {
    preheader: `You cancelled your trial, so nothing is charged. To keep Hookpost, reactivate from Billing by ${reactivateBy}.`,
    kind: 'transactional',
    body:
      heading(freePlanAvailable ? `Your trial ends ${when}` : `Your access ends ${when}`) +
      paragraph(
        `You cancelled the Hookpost ${escapeHtml(tier)} trial for ${strong(
          escapeHtml(orgName)
        )}, so nothing will be charged. It keeps working until ${strong(until)}.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', escapeHtml(tier)],
        ['Works until', until],
        ['Charges', 'None'],
      ]) +
      paragraph(afterPlanLine(freePlanAvailable, 'after', freePlanEndsAt)) +
      paragraph(
        `Want to keep it? Reactivate from Billing by ${strong(
          reactivateBy
        )}: you approve ${method} again and the first charge${
          charge && charge.amount > 0
            ? ` of ${strong(pricePerPeriod(charge))}`
            : ''
        } stays on ${strong(date)}.`
      ) +
      button('Reactivate in Billing', `${appUrl()}/billing`) +
      paragraph(
        `Not staying? There is nothing to do, and nothing is charged. After ${reactivateBy} a new plan can only be chosen once access has ended, on ${date}.`,
        { muted: true, small: true }
      ),
  });
}

/**
 * Hourly sweep (RazorpayService.endLapsedCancellations): a cancelled trial
 * has run out and the workspace, which has no Free plan to fall back to
 * (trial.policy.ts), is paused. Once per subscription. Its trial is used, so
 * the plan it picks is charged when it picks it.
 */
export function workspacePausedEmail(params: {
  orgName: string;
  billing: string;
  /** When the trial ended (the date its first charge was due). */
  endedAt: Date;
  /** The trial plan's charge, when it could be read. */
  charge?: TrialChargeTerms | null;
  /**
   * The date this workspace's media is kept until, when this email is the
   * day-0 notice of the media retention clock (MediaRetentionService).
   */
  mediaKeptUntil?: Date | null;
}): RenderedEmail {
  const { orgName, billing, endedAt, charge, mediaKeptUntil } = params;
  const tier = tierLabel(billing);
  const date = formatBillingDate(endedAt);
  return buildEmail(
    'Your Hookpost workspace is paused: pick a plan to continue',
    {
      preheader:
        'Your trial has ended. Your channels and posts are kept.',
      kind: 'transactional',
      body:
        heading('Your workspace is paused') +
        paragraph(
          `The Hookpost ${escapeHtml(tier)} trial for ${strong(
            escapeHtml(orgName)
          )} ended on ${strong(date)}.`
        ) +
        paragraph(
          `${PAUSED_WORKSPACE_LINE} Nothing is published while it is paused.${
            mediaKeptUntil ? ` ${mediaKeptSentence(mediaKeptUntil)}` : ''
          }`
        ) +
        details([
          ['Workspace', escapeHtml(orgName)],
          ['Trial ended', date],
          ['Channels and posts', 'Kept'],
        ]) +
        paragraph(
          `Pick a plan to continue${
            charge && charge.amount > 0
              ? `: ${escapeHtml(tier)} is ${pricePerPeriod(charge)}`
              : ''
          }. Your trial has been used, so the plan you pick is charged when you pick it.`
        ) +
        button('Pick a plan', `${appUrl()}/billing`) +
        paragraph('Questions? Reply to this email.', {
          muted: true,
          small: true,
        }),
    }
  );
}

const FREE_PLAN_LINE =
  'the Free plan (2 channels, 30 posts a month). Your posts and connected accounts stay; channels beyond the first 2 are paused until you subscribe again';

/**
 * What the workspace becomes once its plan has ended. Workspaces created
 * before the trial cutoff move to the Free plan; the new cohort
 * (trial.policy.ts) has no Free plan and is paused instead. So is a
 * grandfathered one once FREE_PLAN_SUNSET_AT has passed: the caller decides
 * freePlanAvailable at the moment the plan ends, and `freePlanEndsAt` is the
 * sunset when that Free plan itself ends later.
 */
function afterPlanLine(
  freePlanAvailable: boolean,
  when: 'now' | 'after',
  freePlanEndsAt?: Date | null,
  mediaKeptUntil?: Date | null
): string {
  // The day-0 notice of the media retention clock (MediaRetentionService
  // claimed it for this email): the date its media is kept until.
  if (when === 'now' && mediaKeptUntil) {
    return `${afterPlanLine(freePlanAvailable, when, freePlanEndsAt)} ${mediaKeptSentence(mediaKeptUntil)}`;
  }
  if (freePlanAvailable) {
    const line =
      when === 'now'
        ? `The workspace is now on ${FREE_PLAN_LINE}.`
        : `After that the workspace moves to ${FREE_PLAN_LINE}.`;
    return freePlanEndsAt
      ? `${line} The Free plan itself ends on ${freePlanEndDateLabel(
          freePlanEndsAt
        )}; from then the workspace is paused, and ${MEDIA_KEPT_LINE}.`
      : line;
  }
  return when === 'now'
    ? PAUSED_WORKSPACE_LINE
    : `After that your workspace is paused; ${MEDIA_KEPT_LINE}.`;
}

/**
 * Razorpay webhook: subscription.cancelled, whoever cancelled it (the customer
 * from Billing, or us from the Razorpay dashboard).
 *
 * `accessUntil` is the end of the period already paid for (Razorpay's
 * current_end) when the workspace keeps the plan until then. It is null when
 * the plan has already ended: the period ran out, or its payment was refunded.
 */
export function subscriptionCancelledEmail(params: {
  orgName: string;
  billing: string;
  period?: 'MONTHLY' | 'YEARLY' | string | null;
  accessUntil: Date | null;
  endedAt?: Date;
  /**
   * Hookpost ended a trial whose first payment failed on every retry
   * (subscription.halted, never paid). The customer did not cancel anything,
   * so the email says what happened instead of "your plan is cancelled".
   */
  unpaidTrialEnded?: boolean;
  /**
   * Hookpost ended a paid plan whose renewal halted: every automatic retry
   * failed, and the time paid for had run out. The customer did not cancel
   * anything either.
   */
  unpaidRenewalEnded?: boolean;
  /**
   * Hookpost ended a plan that was to be paid at once but whose first debit
   * never went through (a bank e-mandate's first debit lands a banking day
   * after checkout, and can fail). Nothing was ever taken.
   */
  unpaidFirstChargeEnded?: boolean;
  /**
   * The customer paused AutoPay outside Hookpost (their UPI app, their bank's
   * card portal), so Hookpost stopped the mandate. Otherwise an ordinary
   * cancel: paid time is kept (`accessUntil`).
   */
  pausedByCustomer?: boolean;
  /**
   * A trial cancelled before its first charge. With `accessUntil` (the date
   * the first charge was due) the trial keeps working until then, and nothing
   * is charged.
   */
  trialCancelled?: boolean;
  /**
   * The trial was cancelled less than a day before its first charge was due:
   * the bank may already have the debit (it reached the bank about a day
   * early on live trials), so "you won't be charged" cannot be promised.
   * The email says it may still go through and is refunded in full if it
   * does.
   */
  firstDebitMayBeUnderway?: boolean;
  /**
   * A charge on the plan was refunded, so the plan ended now instead of at
   * the end of the period (no `accessUntil`).
   */
  endedByRefund?: boolean;
  /**
   * False for a workspace in the new cohort (trial.policy.ts): there is no
   * Free plan for it, so it is paused rather than moved to Free. Decided for
   * the moment the plan ends (accessUntil, else now).
   */
  freePlanAvailable?: boolean;
  /**
   * When that Free plan itself ends (FREE_PLAN_SUNSET_AT, still ahead), so
   * the email never promises a Free plan without an end.
   */
  freePlanEndsAt?: Date | null;
  /**
   * The date this workspace's media is kept until, when this email is the
   * day-0 notice of the media retention clock (MediaRetentionService).
   */
  mediaKeptUntil?: Date | null;
}): RenderedEmail {
  const {
    orgName,
    billing,
    period,
    accessUntil,
    endedAt = new Date(),
    unpaidTrialEnded,
    unpaidRenewalEnded,
    unpaidFirstChargeEnded,
    pausedByCustomer,
    trialCancelled,
    firstDebitMayBeUnderway,
    endedByRefund,
    freePlanAvailable = true,
    freePlanEndsAt = null,
    mediaKeptUntil,
  } = params;
  const tier = tierLabel(billing);
  const until = accessUntil ? formatBillingDate(accessUntil) : '';
  const refundedNow = !!endedByRefund && !accessUntil;
  const planCell = `${escapeHtml(tier)}${period ? ` &middot; ${period === 'YEARLY' ? 'Yearly' : 'Monthly'}` : ''}`;

  if (trialCancelled && accessUntil) {
    const late = !!firstDebitMayBeUnderway;
    return buildEmail(`Your Hookpost ${tier} trial is cancelled`, {
      preheader: late
        ? `Your bank may already have started the first debit; if it goes through, we refund it in full. Your trial keeps working until ${until}.`
        : `You won't be charged. Your trial keeps working until ${until}.`,
      kind: 'transactional',
      body:
        heading('Your trial is cancelled') +
        paragraph(
          late
            ? `Your Hookpost ${escapeHtml(tier)} trial for ${strong(
                escapeHtml(orgName)
              )} is cancelled. It was cancelled less than a day before its first charge, so your bank may already have started that debit. If it goes through, we refund it in full; you don't need to do anything.`
            : `Your Hookpost ${escapeHtml(tier)} trial for ${strong(
                escapeHtml(orgName)
              )} is cancelled, and you won't be charged.`
        ) +
        details([
          ['Workspace', escapeHtml(orgName)],
          ['Plan', planCell],
          ['Trial access until', until],
          [
            'Charges',
            late ? 'None. A debit already under way is refunded in full.' : 'None',
          ],
        ]) +
        paragraph(
          `Everything keeps working as it does now until ${strong(until)}. ${afterPlanLine(
            freePlanAvailable,
            'after',
            freePlanEndsAt
          )}`
        ) +
        button('Open billing', `${appUrl()}/billing`) +
        paragraph(
          late
            ? `Changed your mind? Choose a plan from Billing after ${until}.`
            : `Changed your mind? Reactivate from Billing before ${until}: you approve the payment method again, and the first charge stays on ${until}.`,
          { muted: true, small: true }
        ),
    });
  }

  if (unpaidTrialEnded) {
    return buildEmail(`Your Hookpost ${tier} trial has ended`, {
      preheader: `The first payment didn't go through, so the trial has ended. You won't be charged.`,
      kind: 'transactional',
      body:
        heading('Your trial has ended') +
        paragraph(
          `The first payment for your Hookpost ${escapeHtml(tier)} trial for ${strong(
            escapeHtml(orgName)
          )} didn't go through on any of the automatic retries, so we've ended the trial. You won't be charged.`
        ) +
        details([
          ['Workspace', escapeHtml(orgName)],
          ['Plan', planCell],
          ['Trial ended', formatBillingDate(endedAt)],
          ['Future charges', 'None'],
        ]) +
        paragraph(afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)) +
        button('Choose a plan', `${appUrl()}/billing`) +
        paragraph(
          'Want to keep your plan? Subscribe again from Billing with a UPI app or card that works for you, or reply to this email and we will help.',
          { muted: true, small: true }
        ),
    });
  }

  if (unpaidRenewalEnded) {
    return buildEmail(`Your Hookpost ${tier} plan has ended`, {
      preheader: `The renewal payment didn't go through, so the plan has ended. You won't be charged.`,
      kind: 'transactional',
      body:
        heading('Your plan has ended') +
        paragraph(
          `The renewal payment for your Hookpost ${escapeHtml(tier)} plan for ${strong(
            escapeHtml(orgName)
          )} didn't go through on any of the automatic retries, and the period you had paid for has run out, so we've ended the plan. You won't be charged.`
        ) +
        details([
          ['Workspace', escapeHtml(orgName)],
          ['Plan', planCell],
          ['Plan ended', formatBillingDate(endedAt)],
          ['Future charges', 'None'],
        ]) +
        paragraph(afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)) +
        button('Choose a plan', `${appUrl()}/billing`) +
        paragraph(
          'Want your plan back? Subscribe again from Billing with a UPI app or card that works for you, or reply to this email and we will help.',
          { muted: true, small: true }
        ),
    });
  }

  if (unpaidFirstChargeEnded) {
    return buildEmail(`Your Hookpost ${tier} plan didn't start`, {
      preheader: `The first payment didn't go through, so the plan has ended. You won't be charged.`,
      kind: 'transactional',
      body:
        heading("Your plan didn't start") +
        paragraph(
          `The first payment for your Hookpost ${escapeHtml(tier)} plan for ${strong(
            escapeHtml(orgName)
          )} didn't go through, so we've ended the plan. Nothing was taken, and you won't be charged.`
        ) +
        details([
          ['Workspace', escapeHtml(orgName)],
          ['Plan', planCell],
          ['Plan ended', formatBillingDate(endedAt)],
          ['Future charges', 'None'],
        ]) +
        paragraph(afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)) +
        button('Choose a plan', `${appUrl()}/billing`) +
        paragraph(
          'Want the plan? Subscribe again from Billing with a UPI app, card or bank account that works for you, or reply to this email and we will help.',
          { muted: true, small: true }
        ),
    });
  }

  const pausedLine = pausedByCustomer
    ? 'You paused AutoPay for Hookpost from your UPI app or bank, so we have stopped the mandate. '
    : '';
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', planCell],
    accessUntil
      ? ['Paid access until', until]
      : ['Plan ended', formatBillingDate(endedAt)],
    ['Future charges', 'None'],
  ];

  return buildEmail('Your Hookpost plan is cancelled', {
    preheader: accessUntil
      ? `${tier} stays active until ${until}. You won't be charged again.`
      : refundedNow
      ? `Your payment was refunded, so your ${tier} plan has ended now. You won't be charged again.`
      : `Your ${tier} plan has ended. You won't be charged again.`,
    kind: 'transactional',
    body:
      heading('Your plan is cancelled') +
      paragraph(
        refundedNow
          ? `Your Hookpost ${escapeHtml(tier)} plan for ${strong(escapeHtml(orgName))} is cancelled, and you won't be charged again. Your payment was refunded, so the plan ended now rather than at the end of the period.`
          : `${pausedLine}Your Hookpost ${escapeHtml(tier)} plan for ${strong(escapeHtml(orgName))} is cancelled, and you won't be charged again.`
      ) +
      details(rows) +
      paragraph(
        accessUntil
          ? `Everything keeps working as it does now until ${strong(until)}: your channels, scheduled posts and AI credits. ${afterPlanLine(freePlanAvailable, 'after', freePlanEndsAt)}`
          : afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)
      ) +
      button('Resubscribe', `${appUrl()}/billing`) +
      paragraph(
        "Cancelled by mistake, or is there something we could have done better? Reply to this email; a person reads every reply.",
        { muted: true, small: true }
      ),
  });
}

/**
 * The paid access a cancelled plan kept has run out and the plan has now
 * ended (RazorpayService.endLapsedCancellations), so the workspace is told on
 * the day rather than left to notice.
 *
 * The customer already had "your plan is cancelled, it works until <date>"
 * when they pressed Cancel; this is the other half of that promise. It states
 * no charge and offers no refund: nothing was taken.
 */
export function planEndedEmail(params: {
  orgName: string;
  billing: string;
  period?: 'MONTHLY' | 'YEARLY' | string | null;
  /** The date the paid access ran out (the row's cancelAt). */
  endedAt: Date;
  /** See subscriptionCancelledEmail: false means the workspace is paused. */
  freePlanAvailable?: boolean;
  freePlanEndsAt?: Date | null;
  /**
   * The date this workspace's media is kept until, when this email is the
   * day-0 notice of the media retention clock (MediaRetentionService).
   */
  mediaKeptUntil?: Date | null;
}): RenderedEmail {
  const {
    orgName,
    billing,
    period,
    endedAt,
    freePlanAvailable = true,
    freePlanEndsAt = null,
    mediaKeptUntil,
  } = params;
  const tier = tierLabel(billing);
  const planCell = `${escapeHtml(tier)}${period ? ` &middot; ${period === 'YEARLY' ? 'Yearly' : 'Monthly'}` : ''}`;

  return buildEmail(`Your Hookpost ${tier} plan has ended`, {
    preheader: `The paid time on your cancelled plan has run out. You weren't charged again.`,
    kind: 'transactional',
    body:
      heading('Your plan has ended') +
      paragraph(
        `The paid time on your cancelled Hookpost ${escapeHtml(tier)} plan for ${strong(
          escapeHtml(orgName)
        )} has run out, so the plan has now ended. You weren't charged again.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', planCell],
        ['Plan ended', formatBillingDate(endedAt)],
        ['Future charges', 'None'],
      ]) +
      paragraph(afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)) +
      button('Choose a plan', `${appUrl()}/billing`) +
      paragraph(
        'Your channels and posts are still here. Subscribe again from Billing whenever you want them back, or reply to this email and we will help.',
        { muted: true, small: true }
      ),
  });
}

/**
 * The pre-charge guard (RazorpayService.reconcileBilling) stopped a charge
 * Razorpay was still able to take on a plan that is ending or has ended
 * here: a cancel that had not stuck, a plan already over, or a refunded plan
 * still set to renew. Sent once per subscription.
 *
 * It says the one thing the customer needs: no further money will be taken,
 * and how long the plan keeps working (the row's cancelAt, which the guard
 * never changes), or that it has ended.
 */
export function chargeStoppedEmail(params: {
  orgName: string;
  billing: string;
  period?: 'MONTHLY' | 'YEARLY' | string | null;
  /** Where the paid access ends here; null when the plan is already over. */
  accessUntil: Date | null;
}): RenderedEmail {
  const { orgName, billing, period, accessUntil } = params;
  const tier = tierLabel(billing);
  const planCell = `${escapeHtml(tier)}${period ? ` &middot; ${period === 'YEARLY' ? 'Yearly' : 'Monthly'}` : ''}`;
  const until = accessUntil ? formatBillingDate(accessUntil) : '';

  return buildEmail(`We stopped a charge on your Hookpost ${tier} plan`, {
    preheader: accessUntil
      ? `You won't be charged again. Your plan keeps working until ${until}.`
      : `You won't be charged again. Your plan has ended.`,
    kind: 'transactional',
    body:
      heading("You won't be charged again") +
      paragraph(
        `Your Hookpost ${escapeHtml(tier)} plan for ${strong(
          escapeHtml(orgName)
        )} is ${accessUntil ? 'set to end' : 'over'}, but the payment mandate behind it could still have taken a payment. We have cancelled that mandate, so no further money will be taken.`
      ) +
      details([
        ['Workspace', escapeHtml(orgName)],
        ['Plan', planCell],
        accessUntil ? ['Works until', until] : ['Status', 'Ended'],
        ['Future charges', 'None'],
      ]) +
      button('Open Billing', `${appUrl()}/billing`) +
      paragraph(
        'Nothing else changes. If you think a payment went through that should not have, reply to this email and we will sort it out.',
        { muted: true, small: true }
      ),
  });
}

/**
 * A payment Razorpay took after the plan was cancelled, refunded in full by
 * Hookpost on its own (RazorpayService.refundChargeAfterCancel). The plan
 * stays cancelled: it keeps working until the date already saved, if that is
 * still ahead, and is never charged again.
 */
export function refundAfterCancelEmail(params: {
  orgName: string;
  billing: string;
  /** Major units, e.g. 699 for Rs 699. */
  amount: number;
  currency: string;
  refundId: string;
  paymentId: string;
  /** Where the paid access ends, when still ahead; null when it is over. */
  accessUntil: Date | null;
}): RenderedEmail {
  const { orgName, billing, amount, currency, refundId, paymentId, accessUntil } = params;
  const money = formatMoney(amount, currency);
  const tier = tierLabel(billing);
  const until = accessUntil ? formatBillingDate(accessUntil) : '';
  return buildEmail(`We refunded ${money}: your plan stays cancelled`, {
    preheader: `A payment was taken after you cancelled, so we refunded all ${money}. You won't be charged again.`,
    kind: 'transactional',
    body:
      heading(`We refunded ${money}`) +
      paragraph(
        `A payment of ${strong(money)} was taken for your Hookpost ${escapeHtml(tier)} plan for ${strong(
          escapeHtml(orgName)
        )} after you had cancelled it. That should not have happened, so we have refunded all of it. It usually reaches your bank in 5–7 working days.`
      ) +
      details([
        ['Refund', money],
        ['Refund ID', escapeHtml(refundId)],
        ['Original payment', escapeHtml(paymentId)],
        ['Your plan', accessUntil ? `Cancelled, works until ${until}` : 'Cancelled'],
        ['Future charges', 'None'],
      ]) +
      paragraph(
        accessUntil
          ? `Your plan stays cancelled. It keeps working until ${until}, and you won't be charged again.`
          : "Your plan stays cancelled, and you won't be charged again."
      ) +
      paragraph(
        `Not in your account after 7 working days? Reply with the refund ID above and we'll chase it with Razorpay.`,
        { muted: true, small: true }
      ),
  });
}

/**
 * Razorpay webhook: refund.processed (or refund.created when Razorpay already
 * marks the refund processed). One email per refund id.
 *
 * `plan` says what happened to the subscription, so the customer is never left
 * guessing whether a refund also switched their plan off:
 *   - active: the refund was not of the workspace's current plan (a superseded
 *     subscription, or not a subscription charge), so that plan continues
 *   - cancelled: the plan is cancelled and access has ended
 *   - none: the payment was not for a plan we can name
 */
/**
 * A bank reported a dispute (chargeback) on one of the workspace's payments,
 * so its plan ended now (RazorpayService.handleDispute). Short and neutral:
 * it states what the bank reported and what happened to the plan, and asks
 * them to write to support. It never accuses anyone, never argues the case
 * and never offers Resubscribe: a disputed workspace cannot buy again until
 * a super admin clears it.
 */
export function paymentDisputedEmail(params: {
  orgName: string;
  /** The tier the workspace was on, when it is known. */
  billing?: string | null;
  /** Razorpay's id for the disputed payment, so support can find it. */
  paymentId: string;
  disputedAt: Date;
  /** False for a new-cohort workspace: paused, not moved to Free. */
  freePlanAvailable?: boolean;
  freePlanEndsAt?: Date | null;
  /**
   * The date this workspace's media is kept until, when this email is the
   * day-0 notice of the media retention clock (MediaRetentionService).
   */
  mediaKeptUntil?: Date | null;
}): RenderedEmail {
  const {
    orgName,
    billing,
    paymentId,
    disputedAt,
    freePlanAvailable = true,
    freePlanEndsAt = null,
    mediaKeptUntil,
  } = params;
  const tier = billing ? tierLabel(billing) : '';
  const planName = tier ? `${tier} plan` : 'plan';
  const subject = 'Your Hookpost plan has ended';

  return buildEmail(subject, {
    preheader: `Your bank reported a dispute on the payment for ${orgName}, so the plan has ended.`,
    kind: 'transactional',
    body:
      heading(subject) +
      paragraph(
        `Your bank has reported a dispute on the payment for ${strong(
          escapeHtml(orgName)
        )}, so your ${escapeHtml(planName)} has ended and you won't be charged again.`
      ) +
      details([
        ['Payment', escapeHtml(paymentId)],
        ['Reported on', formatBillingDate(disputedAt)],
      ]) +
      paragraph(afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)) +
      paragraph(
        `If you didn't mean to raise this, or you think it was a mistake, reply to this email or write to ${link(
          'support@hookstep.in',
          'mailto:support@hookstep.in'
        )} with the payment above and we'll sort it out with you.`
      ),
  });
}

/**
 * A trial approved for a workspace whose owner, or one of whose channels, had
 * a trial elsewhere meanwhile (trial.policy.ts "TRIALS BEHIND A SWITCH": two
 * checkouts side by side both passed the check made at checkout). The
 * mandate is stopped at once and nothing is charged; a plan from Billing is
 * paid at once.
 */
export function secondTrialRefusedEmail(params: { orgName: string }): RenderedEmail {
  const subject = 'Your Hookpost trial did not start';
  return buildEmail(subject, {
    preheader: 'A trial is given once per person. Nothing was charged.',
    kind: 'transactional',
    body:
      heading(subject) +
      paragraph(
        `A Hookpost trial is given once per person, and this account or one of its channels has already had one, so the checkout for ${strong(
          escapeHtml(params.orgName)
        )} did not start a trial. We stopped the payment authorisation at once: nothing was charged, and nothing will be.`
      ) +
      paragraph('To keep going, choose a plan on Billing. It is charged when you check out.') +
      button('Choose a plan', `${appUrl()}/billing`) +
      paragraph(
        `If you think this is a mistake, reply to this email or write to ${link(
          'support@hookstep.in',
          'mailto:support@hookstep.in'
        )}.`
      ),
  });
}

export function refundEmail(params: {
  orgName: string;
  /** Major units, e.g. 599 for Rs 599. */
  amount: number;
  currency: string;
  refundId: string;
  paymentId?: string | null;
  refundedAt: Date;
  billing?: string | null;
  plan: 'active' | 'cancelled' | 'none';
  /** The plan ended because of this refund (any refund on the current plan ends it). */
  endedByRefund?: boolean;
  /** False for a new-cohort workspace: paused, not moved to Free (trial.policy.ts). */
  freePlanAvailable?: boolean;
  /** When that Free plan itself ends (FREE_PLAN_SUNSET_AT, still ahead). */
  freePlanEndsAt?: Date | null;
  /**
   * The date this workspace's media is kept until, when this email is the
   * day-0 notice of the media retention clock (MediaRetentionService).
   */
  mediaKeptUntil?: Date | null;
}): RenderedEmail {
  const { orgName, amount, currency, refundId, paymentId, refundedAt, billing, plan, endedByRefund, freePlanAvailable = true, freePlanEndsAt = null, mediaKeptUntil } = params;
  const money = formatMoney(amount, currency);
  const tier = billing ? tierLabel(billing) : '';
  const planName = tier ? `${tier} plan` : 'plan';

  const rows: Array<[string, string]> = [
    ['Amount', money],
    ['Refund ID', escapeHtml(refundId)],
  ];
  if (paymentId) rows.push(['Original payment', escapeHtml(paymentId)]);
  rows.push(['Date', formatBillingDate(refundedAt)]);
  if (plan !== 'none') {
    rows.push([
      'Your plan',
      plan === 'active' ? `${escapeHtml(tier || 'Plan')} &middot; still active` : `${escapeHtml(tier || 'Plan')} &middot; cancelled`,
    ]);
  }

  const planLine =
    plan === 'active'
      ? `Your ${escapeHtml(planName)} for ${strong(escapeHtml(orgName))} stays active. Nothing else changes.`
      : plan === 'cancelled'
      ? `${
          endedByRefund ? 'Because this payment was refunded, your plan has ended now. ' : ''
        }Your ${escapeHtml(planName)} for ${strong(escapeHtml(orgName))} is cancelled, so you won't be charged again. ${afterPlanLine(freePlanAvailable, 'now', freePlanEndsAt, mediaKeptUntil)}`
      : '';

  return buildEmail(`Your refund of ${money} is on its way`, {
    preheader: `${money} is going back to your original payment method. It usually reaches your bank in 5–7 working days.`,
    kind: 'transactional',
    body:
      heading(`Your refund of ${money} is on its way`) +
      paragraph(
        `We've refunded ${strong(money)} to the payment method you paid with. It usually reaches your bank in 5–7 working days; the exact time depends on your bank.`
      ) +
      details(rows) +
      (planLine ? paragraph(planLine) : '') +
      (plan === 'cancelled' ? button('Resubscribe', `${appUrl()}/billing`) : '') +
      paragraph(
        `Not in your account after 7 working days? Reply with the refund ID above and we'll chase it with Razorpay.`,
        { muted: true, small: true }
      ),
  });
}
