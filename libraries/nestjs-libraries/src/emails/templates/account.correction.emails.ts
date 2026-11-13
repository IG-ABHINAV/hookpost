import { chargeStoppedEmail as guardChargeStoppedEmail } from '@hookpost/nestjs-libraries/emails/templates/billing.emails';
import {
  appUrl,
  buildEmail,
  button,
  details,
  escapeHtml,
  heading,
  paragraph,
  RenderedEmail,
  strong,
} from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import {
  formatBillingDate,
  formatMoney,
  tierLabel,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

/**
 * Emails that say Hookpost got a plan wrong and has now put it right. Every
 * other billing email in billing.emails.ts describes something the customer
 * or their bank did; these describe something we did, so each one says plainly
 * what was wrong, what we changed, and whether any money moved.
 *
 * Kept apart from billing.emails.ts on purpose: a correction is sent by an
 * admin or by the reconcile job (AccountCorrectionService), never by a
 * Razorpay webhook, and the copy rules are different - no upsell before the
 * apology, and never a promise we cannot keep about a charge we are not sure
 * of. docs/billing-emails.md lists them with their triggers.
 */

/** Which correction happened; the event name is also the send-once key's prefix. */
export type AccountCorrectionEvent =
  /** Our records showed a plan that had already ended or was never paid. */
  | 'PLAN_CORRECTED_ENDED'
  /** A mandate at Razorpay could still have charged after the plan ended. */
  | 'CHARGE_STOPPED'
  /** The workspace was paused or ended by mistake; access is back. */
  | 'PLAN_RESTORED'
  /** One charge was taken twice and the extra one is refunded. */
  | 'DUPLICATE_CHARGE_REFUNDED'
  /** A refund from before should have ended the plan at the time. */
  | 'REFUND_ENDED_PLAN';

export const ACCOUNT_CORRECTION_EVENTS: AccountCorrectionEvent[] = [
  'PLAN_CORRECTED_ENDED',
  'CHARGE_STOPPED',
  'PLAN_RESTORED',
  'DUPLICATE_CHARGE_REFUNDED',
  'REFUND_ENDED_PLAN',
];

/**
 * Where a correction email sends someone to choose a plan. The campaign is
 * stamped so these visits are not read as ordinary billing traffic.
 */
export function correctionBillingUrl(
  event: AccountCorrectionEvent,
  path = '/billing'
): string {
  return `${appUrl()}${path}?utm_source=account_fix&utm_medium=email&utm_campaign=${event.toLowerCase()}`;
}

/** "Standard plan", or just "plan" when the tier is not known. */
function planName(billing?: string | null): string {
  const tier = tierLabel(billing);
  return tier ? `${escapeHtml(tier)} plan` : 'plan';
}

/** The line every correction ends on: a person wrote it and a person reads the reply. */
function apologyLine(): string {
  return paragraph(
    'Sorry for the confusion. Reply to this email if you have any questions; a person reads every reply.',
    { muted: true, small: true }
  );
}

/** What is kept when a plan ends: said the same way in each ending email. */
const KEPT_LINE =
  'Your connected channels and everything you have posted or scheduled are saved.';

export interface CorrectionParams {
  orgName: string;
}

export interface PlanCorrectedEndedParams extends CorrectionParams {
  billing?: string | null;
  /** When we corrected it. */
  endedAt: Date;
  /**
   * Nothing was ever charged on this plan (a cancelled trial, like RK Defence
   * on 29 Oct 2026). The email says so, because that is the first thing
   * someone reading it wants to know.
   */
  neverCharged: boolean;
  /** When the plan actually ended, if that is a different, earlier date. */
  endedOn?: Date | null;
  /** Why it had ended, in the customer's terms ("your trial was cancelled on 21 October"). */
  because?: string | null;
}

/**
 * Our records showed a plan that had already ended, or had never been paid
 * for, and we have ended it. No money moved.
 */
export function planCorrectedEndedEmail(
  params: PlanCorrectedEndedParams
): RenderedEmail {
  const { orgName, billing, endedAt, neverCharged, endedOn, because } = params;
  const tier = tierLabel(billing);
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', tier ? `${escapeHtml(tier)} &middot; ended` : 'Ended'],
    ['Corrected on', formatBillingDate(endedAt)],
  ];
  if (endedOn) rows.push(['Plan actually ended', formatBillingDate(endedOn)]);
  rows.push(['Charges', neverCharged ? 'None. You were never charged.' : 'No further charges']);

  return buildEmail('Your Hookpost workspace: plan status corrected', {
    preheader: neverCharged
      ? 'You were never charged. The plan your workspace was showing has now ended.'
      : 'The plan your workspace was showing had already ended. It has now ended here too.',
    kind: 'transactional',
    body:
      heading('We have corrected your plan') +
      paragraph(
        `Your Hookpost ${planName(billing)} for ${strong(escapeHtml(orgName))} had ${
          neverCharged ? 'ended without ever being paid for' : 'already ended'
        }${because ? `: ${escapeHtml(because)}` : ''}. Because of an error on our side the workspace kept showing it afterwards. We have corrected that today, so the plan has now ended.`
      ) +
      details(rows) +
      paragraph(
        neverCharged
          ? `${KEPT_LINE} You were never charged for this plan, and you will not be.`
          : `${KEPT_LINE} You will not be charged again.`
      ) +
      paragraph('To keep scheduling posts, choose a plan:') +
      button('Choose a plan', correctionBillingUrl('PLAN_CORRECTED_ENDED')) +
      apologyLine(),
  });
}

export interface ChargeStoppedParams extends CorrectionParams {
  billing?: string | null;
  period?: string | null;
  /** Where paid access ends here; null when the plan is already over. */
  accessUntil?: Date | null;
}

/**
 * A mandate at Razorpay was still live after the plan ended, so it could have
 * charged again, and we cancelled it. ONE template for this, whoever stops
 * the charge: the hourly guard (RazorpayService.reconcileBilling) and the
 * admin's "End plan now" both send billing.emails.ts chargeStoppedEmail, so
 * the customer reads the same words either way.
 */
export function chargeStoppedEmail(params: ChargeStoppedParams): RenderedEmail {
  return guardChargeStoppedEmail({
    orgName: params.orgName,
    billing: params.billing || 'STANDARD',
    period: params.period || null,
    accessUntil: params.accessUntil ?? null,
  });
}

export interface PlanRestoredParams extends CorrectionParams {
  billing: string;
  /** When we put it back. */
  restoredAt: Date;
  /** How long the restored plan runs, when it is not open-ended. */
  activeUntil?: Date | null;
  /** How long it was off, in the customer's terms ("from 21 to 29 October"). */
  wasOffFor?: string | null;
}

/** The workspace was paused or ended by mistake and we have put it back. */
export function planRestoredEmail(params: PlanRestoredParams): RenderedEmail {
  const { orgName, billing, restoredAt, activeUntil, wasOffFor } = params;
  const tier = tierLabel(billing);
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', `${escapeHtml(tier)} &middot; active`],
    ['Restored on', formatBillingDate(restoredAt)],
  ];
  if (activeUntil) rows.push(['Active until', formatBillingDate(activeUntil)]);

  return buildEmail(`Your Hookpost ${tier} plan is back`, {
    preheader: 'We ended your plan by mistake. It is active again and nothing extra was charged.',
    kind: 'transactional',
    body:
      heading('Your plan is back') +
      paragraph(
        `We ended the Hookpost ${planName(billing)} for ${strong(
          escapeHtml(orgName)
        )} by mistake${wasOffFor ? ` (${escapeHtml(wasOffFor)})` : ''}. That was our error, not anything you did. Your plan is active again, with every channel and scheduled post as it was.`
      ) +
      details(rows) +
      paragraph(
        'You have not been charged anything extra for this, and your billing dates are unchanged. Posts that were due while the workspace was paused were not published; you can reschedule them from the calendar.'
      ) +
      button('Open your calendar', correctionBillingUrl('PLAN_RESTORED', '/launches')) +
      apologyLine(),
  });
}

export interface DuplicateChargeRefundedParams extends CorrectionParams {
  billing?: string | null;
  /** Major units (rupees, not paise). */
  amount: number;
  currency: string;
  refundId: string;
  paymentId?: string | null;
  refundedAt: Date;
  /** Why it happened, in the customer's terms ("when you moved to Pro on 12 October"). */
  because?: string | null;
}

/** One charge was taken twice; the extra one is refunded. */
export function duplicateChargeRefundedEmail(
  params: DuplicateChargeRefundedParams
): RenderedEmail {
  const { orgName, billing, amount, currency, refundId, paymentId, refundedAt, because } =
    params;
  const money = formatMoney(amount, currency);
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Refunded', money],
    ['Refund ID', escapeHtml(refundId)],
  ];
  if (paymentId) rows.push(['Duplicate payment', escapeHtml(paymentId)]);
  rows.push(['Date', formatBillingDate(refundedAt)]);
  rows.push(['Your plan', `${tierLabel(billing) || 'Plan'} &middot; unchanged`]);

  return buildEmail(`We have refunded a duplicate charge of ${money}`, {
    preheader: `You were charged twice. ${money} is going back to the account you paid from.`,
    kind: 'transactional',
    body:
      heading(`We charged you twice, and have refunded ${money}`) +
      paragraph(
        `Your Hookpost ${planName(billing)} for ${strong(
          escapeHtml(orgName)
        )} was charged twice${because ? ` ${escapeHtml(because)}` : ''}. That was a fault on our side. We have refunded ${strong(
          money
        )} to the account you paid from; it usually reaches your bank in 5-7 working days, depending on your bank.`
      ) +
      details(rows) +
      paragraph(
        'Your plan is unaffected: it carries on exactly as it is, and your next charge is the normal one. You do not need to do anything.'
      ) +
      button('Open billing', correctionBillingUrl('DUPLICATE_CHARGE_REFUNDED')) +
      paragraph(
        `Not in your account after 7 working days? Reply with the refund ID above and we will chase it with our payment provider. Sorry for the trouble.`,
        { muted: true, small: true }
      ),
  });
}

export interface RefundEndedPlanParams extends CorrectionParams {
  billing?: string | null;
  /** When the refund was made, which is the thing we failed to act on. */
  refundedOn: Date;
  /** When we ended the plan (today). */
  endedAt: Date;
  /** Major units, when the refunded amount is worth naming. */
  amount?: number | null;
  currency?: string | null;
}

/**
 * A refund from before should have ended the plan at the time and did not.
 * The plan ends now; no money moves, because the refund already happened.
 */
export function refundEndedPlanEmail(params: RefundEndedPlanParams): RenderedEmail {
  const { orgName, billing, refundedOn, endedAt, amount, currency } = params;
  const tier = tierLabel(billing);
  const money = amount ? formatMoney(amount, currency) : '';
  const rows: Array<[string, string]> = [
    ['Workspace', escapeHtml(orgName)],
    ['Plan', tier ? `${escapeHtml(tier)} &middot; ended` : 'Ended'],
    ['Refunded on', formatBillingDate(refundedOn)],
  ];
  if (money) rows.push(['Amount refunded', money]);
  rows.push(['Plan ended', formatBillingDate(endedAt)]);
  rows.push(['Charges', 'None. Nothing more is taken.']);

  return buildEmail('Your Hookpost plan has ended after your refund', {
    preheader: `We refunded you on ${formatBillingDate(
      refundedOn
    )} but left the plan running. It has now ended, and there is nothing more to pay.`,
    kind: 'transactional',
    body:
      heading('Your plan has ended') +
      paragraph(
        `We refunded your Hookpost ${planName(billing)} for ${strong(
          escapeHtml(orgName)
        )} on ${strong(formatBillingDate(refundedOn))}${
          money ? ` (${strong(money)})` : ''
        }, and the plan should have ended then. Because of an error on our side it kept running. We have ended it today and cancelled the payment instruction behind it, so nothing more will be taken.`
      ) +
      details(rows) +
      paragraph(
        `${KEPT_LINE} If you were charged anything after the refund, reply to this email and we will refund that too.`
      ) +
      paragraph('To start posting again, choose a plan here:') +
      button('Choose a plan', correctionBillingUrl('REFUND_ENDED_PLAN')) +
      apologyLine(),
  });
}
/**
 * One correction, without the workspace name: what a caller passes to
 * AccountCorrectionService, which reads the name itself.
 */
export type AccountCorrectionFacts =
  | ({ event: 'PLAN_CORRECTED_ENDED' } & Omit<PlanCorrectedEndedParams, 'orgName'>)
  | ({ event: 'CHARGE_STOPPED' } & Omit<ChargeStoppedParams, 'orgName'>)
  | ({ event: 'PLAN_RESTORED' } & Omit<PlanRestoredParams, 'orgName'>)
  | ({ event: 'DUPLICATE_CHARGE_REFUNDED' } & Omit<DuplicateChargeRefundedParams, 'orgName'>)
  | ({ event: 'REFUND_ENDED_PLAN' } & Omit<RefundEndedPlanParams, 'orgName'>);

/** The correction email for `facts`, addressed to `orgName`. */
export function accountCorrectionEmail(
  facts: AccountCorrectionFacts,
  orgName: string
): RenderedEmail {
  switch (facts.event) {
    case 'PLAN_CORRECTED_ENDED':
      return planCorrectedEndedEmail({ ...facts, orgName });
    case 'CHARGE_STOPPED':
      return chargeStoppedEmail({ ...facts, orgName });
    case 'PLAN_RESTORED':
      return planRestoredEmail({ ...facts, orgName });
    case 'DUPLICATE_CHARGE_REFUNDED':
      return duplicateChargeRefundedEmail({ ...facts, orgName });
    case 'REFUND_ENDED_PLAN':
      return refundEndedPlanEmail({ ...facts, orgName });
  }
}
