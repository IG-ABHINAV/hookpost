import { appUrl } from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import {
  adminAlertEmail,
  AlertFact,
  AlertMode,
} from '@hookpost/nestjs-libraries/emails/templates/admin.alert.email';
import {
  formatBillingDate,
  formatMoney,
  tierLabel,
} from '@hookpost/nestjs-libraries/emails/templates/billing.emails';

/**
 * The owner's sale alert (OwnerSalesAlertService): one branded email to
 * OWNER_SALES_ALERT_EMAIL for every money event, so the owner hears about a
 * sale from Hookpost itself instead of from Razorpay's merchant copy of the
 * customer's receipt. Customer emails are unchanged and still go only to the
 * workspace.
 *
 * Only the fields listed here ever reach the email. Nothing from a provider
 * payload is copied in whole: no card or UPI details, no contact number, no
 * signatures or tokens.
 */

export type OwnerSaleEvent =
  /** A new trial: the mandate is approved and the first charge is days away. */
  | 'TRIAL_STARTED'
  /** The first real charge of a subscription (a trial converting, or paid upfront). */
  | 'FIRST_CHARGE'
  /** The first charge of a new mandate opened while the workspace had a plan (a UPI plan change). */
  | 'NEW_PLAN_CHARGE'
  | 'RENEWAL'
  /** Upgrade, downgrade or monthly/yearly switch, in place or on a new mandate. */
  | 'PLAN_CHANGED'
  /** The same plan on a new mandate: Reactivate or Change payment method. */
  | 'NEW_MANDATE'
  /** The customer pressed Cancel in Billing. */
  | 'CANCEL_REQUESTED'
  /** Razorpay says the subscription is cancelled (UPI app, dashboard, Hookpost ending it). */
  | 'CANCELLED'
  /** A charge failed and Razorpay is retrying it. */
  | 'PAYMENT_FAILING'
  /** Razorpay stopped retrying a renewal. */
  | 'HALTED'
  | 'REFUND'
  /**
   * The pre-charge guard cancelled a subscription at Razorpay because this
   * database said the plan was ending or had ended while Razorpay could
   * still charge it.
   */
  | 'GUARD_CANCELLED'
  /** The guard tried to cancel at Razorpay and Razorpay refused. */
  | 'GUARD_CANCEL_FAILED'
  /** Money was taken after cancel and could NOT be refunded automatically. */
  | 'CHARGED_AFTER_CANCEL'
  /** Money taken after cancel was refunded in full automatically (info). */
  | 'AUTO_REFUNDED'
  /**
   * The guard found the database and Razorpay disagreeing in a way it will
   * not act on by itself, and is asking the owner to look.
   */
  | 'BILLING_MISMATCH'
  /**
   * A bank reported a dispute (chargeback) on a payment: every
   * payment.dispute.* event (RazorpayService.handleDispute).
   */
  | 'DISPUTE'
  /** A super admin let a disputed workspace buy again (/admin dispute clear). */
  | 'DISPUTE_CLEARED'
  /** A super admin gave a disputed workspace its plan back (/admin restore). */
  | 'DISPUTE_RESTORED'
  /** A Gumroad license key was redeemed on a workspace for the first time. */
  | 'GUMROAD_REDEEMED'
  /** The daily Gumroad re-check found the membership refunded, cancelled, ended... */
  | 'GUMROAD_CHANGED'
  // Corrections: Hookpost put something of its own right (an admin action or
  // the reconcile job), not a money event the customer caused. Each one also
  // sends the customer a correction email; see account.correction.emails.ts.
  /** Our records showed a plan that had already ended or was never paid; we ended it. */
  | 'PLAN_CORRECTED_ENDED'
  /** A mandate that could still have charged after the plan ended; we cancelled it. */
  | 'CHARGE_STOPPED'
  /** A workspace ended or paused by mistake; access restored. */
  | 'PLAN_RESTORED'
  /** A charge taken twice; the extra one refunded. */
  | 'DUPLICATE_CHARGE_REFUNDED'
  /** A refund from before that should have ended the plan at the time. */
  | 'REFUND_ENDED_PLAN';

export const OWNER_SALE_EVENT_LABELS: Record<OwnerSaleEvent, string> = {
  TRIAL_STARTED: 'Trial started',
  FIRST_CHARGE: 'First charge',
  NEW_PLAN_CHARGE: 'Charged on a new plan',
  RENEWAL: 'Renewal charged',
  PLAN_CHANGED: 'Plan changed',
  NEW_MANDATE: 'New mandate on the same plan',
  CANCEL_REQUESTED: 'Cancellation requested',
  CANCELLED: 'Subscription cancelled',
  PAYMENT_FAILING: 'Payment failing',
  HALTED: 'Renewal paused',
  REFUND: 'Refund',
  GUARD_CANCELLED: 'Cancelled by the pre-charge guard',
  GUARD_CANCEL_FAILED: 'Pre-charge guard could not cancel',
  CHARGED_AFTER_CANCEL: 'Charged after cancel, refund failed',
  AUTO_REFUNDED: 'Charged after cancel, refunded automatically',
  BILLING_MISMATCH: 'Billing mismatch',
  DISPUTE: 'Payment dispute',
  DISPUTE_CLEARED: 'Payment dispute cleared',
  DISPUTE_RESTORED: 'Plan restored after a dispute',
  GUMROAD_REDEEMED: 'Gumroad license redeemed',
  GUMROAD_CHANGED: 'Gumroad membership changed',
  PLAN_CORRECTED_ENDED: 'Correction: plan ended',
  CHARGE_STOPPED: 'Correction: charging stopped',
  PLAN_RESTORED: 'Correction: plan restored',
  DUPLICATE_CHARGE_REFUNDED: 'Correction: duplicate charge refunded',
  REFUND_ENDED_PLAN: 'Correction: refunded plan ended',
};

/** What the billing code knows about the event. */
export interface OwnerSaleAlert {
  event: OwnerSaleEvent;
  /**
   * One email per key (OwnerSalesAlertService claims it in Redis): the
   * provider's own id for the thing that happened, never a time, so a
   * retried or duplicated webhook maps to the same key.
   */
  key: string;
  /** 'hookpost' is a correction we made ourselves, not a provider event. */
  source: 'razorpay' | 'gumroad' | 'hookpost';
  organizationId?: string | null;
  /** The member who opened the checkout (notes.userId), when known. */
  userId?: string | null;
  tier?: string | null;
  period?: string | null;
  previousTier?: string | null;
  previousPeriod?: string | null;
  /** Major units (rupees, not paise). */
  amount?: number | null;
  currency?: string | null;
  /** What the amount is, when it is not money taken now ("first charge on 26 Oct 2026"). */
  amountNote?: string | null;
  /** Razorpay's method name only (upi, card, emandate); never its details. */
  paymentMethod?: string | null;
  ids?: {
    payment?: string | null;
    subscription?: string | null;
    previousSubscription?: string | null;
    refund?: string | null;
    /** Razorpay's dispute id (disp_...). */
    dispute?: string | null;
    sale?: string | null;
    license?: string | null;
  };
  /** Short lines written by Hookpost (dates, reasons). Customer text is cleaned. */
  notes?: Array<string | null | undefined | false>;
  /** The provider marked this a test (Gumroad test purchase, a test payment). */
  test?: boolean;
  /**
   * Remember the key longer than the default 45 days: a cancellation made
   * now that Razorpay confirms at the end of a yearly cycle.
   */
  ttlSeconds?: number;
}

/** Who the event is about, read from the database by the service. */
export interface OwnerSaleContext {
  orgName?: string | null;
  orgCreatedAt?: Date | null;
  customerName?: string | null;
  customerEmail?: string | null;
  signupCountry?: string | null;
  attribution?: {
    method?: string | null;
    utmSource?: string | null;
    utmMedium?: string | null;
    utmCampaign?: string | null;
    utmContent?: string | null;
    utmTerm?: string | null;
    gclid?: string | null;
    fbclid?: string | null;
    landingPath?: string | null;
    referrer?: string | null;
    country?: string | null;
    device?: string | null;
  } | null;
  /** Why this is not real money, if it is not: a small "Test mode" badge, never the subject. */
  testReason?: string | null;
  /**
   * The workspace is ours (a member is a platform super admin, or
   * FREE_PLAN_SUNSET_EXEMPT_ORGS lists it): real money on a live key, but not
   * a customer. A small "Internal workspace" badge, never "Test mode".
   */
  internal?: boolean;
  /** Set when the database could not be read; the alert still goes out. */
  contextError?: boolean;
}

/**
 * Free text from a customer or a provider made safe for one line: control
 * characters (newlines included, so a name cannot add header-looking lines)
 * become spaces, runs of whitespace collapse, and the length is capped.
 */
export function cleanLine(value: unknown, max = 160): string {
  const s = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * cleanLine for text a customer chose (their name, the workspace name, a
 * cancellation reason, the utm values and referrer they arrived with): it
 * also stops looking like a link, so the owner's mail app cannot turn
 * "https://evil.example/login" in a workspace name into something to click.
 * "https://a.b/c" -> "hxxps[://]a[.]b/c". The customer's email address is
 * not passed through this.
 */
export function defang(value: unknown, max = 160): string {
  return cleanLine(value, max)
    .replace(/:\/\//g, '[://]')
    .replace(/\bhttp(s?)\[:\/\/\]/gi, 'hxxp$1[://]')
    .replace(/\.(?=[a-z0-9-]{2,})/gi, '[.]');
}

/** "PRO", "YEARLY" -> "Pro yearly". */
export function planLabel(tier?: string | null, period?: string | null): string {
  const t = tierLabel(cleanLine(tier, 20).toUpperCase());
  const p = cleanLine(period, 20).toLowerCase();
  if (!t) return '';
  return p ? `${t} ${p}` : t;
}

/** 599, 'INR' -> "₹599 INR"; other currencies keep their code. */
export function amountLabel(amount?: number | null, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    return '';
  }
  const code = cleanLine(currency || 'INR', 5).toUpperCase();
  if (code === 'INR' || code === 'USD') {
    return `${formatMoney(Number(amount), code)} ${code}`;
  }
  return `${Number(amount).toFixed(2)} ${code}`;
}

/** The person, for the subject: "Priya Shah (priya@x.in)", or whichever is known. */
function who(ctx: OwnerSaleContext): string {
  const name = defang(ctx.customerName, 60);
  const email = cleanLine(ctx.customerEmail, 80);
  if (name && email) return `${name} (${email})`;
  return name || email || '';
}

function sourceLine(ctx: OwnerSaleContext): string {
  const a = ctx.attribution;
  if (!a) return 'not recorded';
  const parts: string[] = [];
  const pair = (label: string, v?: string | null, max = 80) => {
    const c = defang(v, max);
    if (c) parts.push(`${label}=${c}`);
  };
  pair('utm_source', a.utmSource);
  pair('utm_medium', a.utmMedium);
  pair('utm_campaign', a.utmCampaign);
  pair('utm_content', a.utmContent);
  pair('utm_term', a.utmTerm);
  pair('gclid', a.gclid, 40);
  pair('fbclid', a.fbclid, 40);
  pair('landing', a.landingPath, 80);
  pair('referrer', a.referrer, 80);
  pair('signup', a.method, 20);
  pair('device', a.device, 20);
  return parts.length ? parts.join(', ') : 'direct (no campaign recorded)';
}


/** Events the owner has to act on: an amber "Needs a look" badge. */
export const OWNER_ACTION_EVENTS: ReadonlySet<OwnerSaleEvent> = new Set<OwnerSaleEvent>([
  'GUARD_CANCEL_FAILED',
  'CHARGED_AFTER_CANCEL',
  'BILLING_MISMATCH',
  'DISPUTE',
]);

/**
 * Test, internal or live. Test only when the money was fake (ctx.testReason
 * is set from the Razorpay key this process runs with, or a provider's own
 * test flag); a workspace of ours on a live key is internal, never test.
 */
export function ownerAlertMode(ctx: OwnerSaleContext): AlertMode {
  if (cleanLine(ctx.testReason, 80)) return 'test';
  if (ctx.internal) return 'internal';
  return 'live';
}

/** 599, 'INR' -> "₹599"; 19, 'USD' -> "$19"; other currencies keep their code. */
export function shortAmount(amount?: number | null, currency?: string | null): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) {
    return '';
  }
  const code = cleanLine(currency || 'INR', 5).toUpperCase();
  if (code === 'INR' || code === 'USD') return formatMoney(Number(amount), code);
  return `${Number(amount).toFixed(2)} ${code}`;
}

/** Razorpay's method name for people: "upi" -> "UPI". */
export function paymentMethodLabel(method?: string | null): string {
  const m = cleanLine(method, 20).toLowerCase();
  const known: Record<string, string> = {
    upi: 'UPI',
    card: 'Card',
    emandate: 'e-mandate',
    nach: 'NACH',
    netbanking: 'Netbanking',
    wallet: 'Wallet',
  };
  return known[m] || cleanLine(method, 20);
}

/** One sentence saying what happened. `name` is already cleaned. */
function summaryFor(
  event: OwnerSaleEvent,
  p: { name: string; plan: string; previous: string; source: string }
): string {
  const who = p.name || 'A customer';
  const whose = p.name ? `${p.name}'s` : "The customer's";
  // Mid-sentence: "the customer's", or the name as written.
  const whoseIn = p.name ? whose : "the customer's";
  const plan = p.plan || 'their plan';
  switch (event) {
    case 'TRIAL_STARTED':
      return `${who} approved a mandate for ${plan}. Nothing has been charged yet.`;
    case 'FIRST_CHARGE':
      return `${who} paid for ${plan} for the first time.`;
    case 'NEW_PLAN_CHARGE':
      return `${who} was charged for ${plan} on a new mandate.`;
    case 'RENEWAL':
      return `${whose} ${plan} renewed and the payment went through.`;
    case 'PLAN_CHANGED':
      return p.previous && p.previous !== p.plan
        ? `${who} moved from ${p.previous} to ${plan}.`
        : `${who} changed their plan to ${plan}.`;
    case 'NEW_MANDATE':
      return `${who} set up a new mandate on the same plan (${plan}).`;
    case 'CANCEL_REQUESTED':
      return `${who} pressed Cancel in Billing.`;
    case 'CANCELLED':
      return `Razorpay reports ${whoseIn} subscription as cancelled.`;
    case 'PAYMENT_FAILING':
      return `A charge for ${whoseIn} ${plan} failed. Razorpay is retrying it.`;
    case 'HALTED':
      return `Razorpay stopped retrying ${whoseIn} renewal, so the renewal is paused.`;
    case 'REFUND':
      return `A refund was issued to ${p.name || 'the customer'}.`;
    case 'GUARD_CANCELLED':
      return 'The pre-charge guard cancelled this subscription at Razorpay, because Hookpost says the plan has ended.';
    case 'GUARD_CANCEL_FAILED':
      return 'The pre-charge guard tried to cancel this subscription at Razorpay and Razorpay refused, so it can still be charged.';
    case 'CHARGED_AFTER_CANCEL':
      return 'Money was taken after the plan was cancelled, and the automatic refund did not go through.';
    case 'AUTO_REFUNDED':
      return 'Money taken after the plan was cancelled was refunded in full automatically. Nothing to do.';
    case 'BILLING_MISMATCH':
      return 'Hookpost and Razorpay disagree about this subscription, and the guard will not change it by itself.';
    case 'DISPUTE':
      return `${whose} bank raised a dispute on a payment.`;
    case 'DISPUTE_CLEARED':
      return 'A super admin let this workspace buy again after a dispute.';
    case 'DISPUTE_RESTORED':
      return 'A super admin gave this workspace its plan back after a dispute.';
    case 'GUMROAD_REDEEMED':
      return `${who} redeemed a Gumroad license.`;
    case 'GUMROAD_CHANGED':
      return `Gumroad reports a change to ${whoseIn} membership.`;
    default:
      return `A ${p.source} billing event for ${p.name || 'a workspace'}.`;
  }
}

/** The owner's email: a short subject, and the shared admin template. */
export function ownerSaleAlertEmail(
  alert: OwnerSaleAlert,
  ctx: OwnerSaleContext
): { subject: string; html: string; text: string } {
  const label = OWNER_SALE_EVENT_LABELS[alert.event] || cleanLine(alert.event, 40);
  const plan = planLabel(alert.tier, alert.period);
  const previous = planLabel(alert.previousTier, alert.previousPeriod);
  const amount = shortAmount(alert.amount, alert.currency);
  const amountNote = cleanLine(alert.amountNote, 80);
  const name = defang(ctx.customerName, 60);
  const email = cleanLine(ctx.customerEmail, 80);
  const mode = ownerAlertMode(ctx);
  const source = alert.source === 'gumroad' ? 'Gumroad' : 'Razorpay';

  const planPart = plan && previous && previous !== plan ? `${previous} → ${plan}` : plan;
  const headline = cleanLine(
    `${label}${[planPart, amount].filter(Boolean).length ? `: ${[planPart, amount].filter(Boolean).join(', ')}` : ''}`,
    140
  );
  const person = name || email;
  // An event the owner must act on keeps its note ("respond within 3
  // business days") in the subject, where he sees it first.
  const urgent = OWNER_ACTION_EVENTS.has(alert.event) && amountNote ? `, ${amountNote}` : '';
  const subject = cleanLine(`${headline}${urgent}${person ? ` · ${person}` : ''}`, 200);

  const orgId = cleanLine(alert.organizationId, 64);
  const base = appUrl();
  const adminUrl = orgId ? `${base}/admin/users?q=${encodeURIComponent(orgId)}` : null;
  const ids = alert.ids || {};
  const subId = cleanLine(ids.subscription, 40);
  const disputeId = cleanLine(ids.dispute, 40);
  const rzpSubUrl =
    alert.source === 'razorpay' && subId
      ? `https://dashboard.razorpay.com/app/subscriptions/${encodeURIComponent(subId)}`
      : null;
  const rzpDisputeUrl =
    alert.source === 'razorpay' && disputeId
      ? `https://dashboard.razorpay.com/app/disputes/${encodeURIComponent(disputeId)}`
      : null;

  const facts: AlertFact[] = [];
  const fact = (label: string, value: unknown, max = 160, href?: string | null) => {
    const v = cleanLine(value, max);
    if (v) facts.push({ label, value: v, href });
  };
  fact('Plan', planPart);
  fact('Amount', [amount, amountNote].filter(Boolean).join(', '), 120);
  fact('Payment method', paymentMethodLabel(alert.paymentMethod));
  fact('Customer', name, 80);
  fact('Email', email, 120, email ? `mailto:${email}` : null);
  fact('Workspace', defang(ctx.orgName, 80), 120);
  if (ctx.orgCreatedAt) fact('Signed up', formatBillingDate(new Date(ctx.orgCreatedAt)));
  fact('Signup country', ctx.signupCountry || ctx.attribution?.country || 'not recorded', 40);
  fact('Signup source', sourceLine(ctx), 400);
  fact('Razorpay payment', ids.payment, 40);
  fact('Razorpay subscription', subId, 40, rzpSubUrl);
  fact('Replaced subscription', ids.previousSubscription, 40);
  fact('Razorpay refund', ids.refund, 40);
  fact('Razorpay dispute', disputeId, 40, rzpDisputeUrl);
  fact('Gumroad sale', ids.sale, 60);
  fact('Gumroad license', ids.license, 60);
  fact('Workspace id', orgId, 64);

  const notes = (alert.notes || [])
    .filter(Boolean)
    .map((n) => cleanLine(n, 300))
    .filter(Boolean);
  if (ctx.contextError) {
    notes.push('The workspace details could not be read; see the admin page.');
  }

  const secondary: Array<{ label: string; url: string }> = [];
  if (rzpDisputeUrl) secondary.push({ label: 'Dispute in Razorpay', url: rzpDisputeUrl });
  if (rzpSubUrl) secondary.push({ label: 'Subscription in Razorpay', url: rzpSubUrl });

  return adminAlertEmail({
    subject,
    headline,
    summary: summaryFor(alert.event, { name, plan, previous, source }),
    mode,
    modeDetail: mode === 'test' ? cleanLine(ctx.testReason, 80) : null,
    needsAction: OWNER_ACTION_EVENTS.has(alert.event),
    notes,
    facts,
    // Without a workspace the Razorpay page is the record to open.
    primary: adminUrl ? { label: 'Open in admin', url: adminUrl } : secondary.shift() || null,
    secondary,
    reason:
      'Sent to the owner alert address (OWNER_SALES_ALERT_EMAIL). The customer gets their own email separately.',
  });
}
