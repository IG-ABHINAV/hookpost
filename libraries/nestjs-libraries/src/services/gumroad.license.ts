/**
 * Hookpost plans sold on Gumroad: which Gumroad product is which plan, what a
 * license verification says about the purchase, and what that means for the
 * workspace the license is bound to.
 *
 * Pure: no Nest, Prisma or HTTP, and no imports, so the Billing page can read
 * isGumroadIdentifier and the decisions are tested without a database.
 * GumroadLicenseService (database/prisma/gumroad) does the reading and
 * writing; GumroadClient (gumroad.client.ts) talks to Gumroad.
 *
 * The fields are the ones Gumroad documents for POST /v2/licenses/verify
 * (gumroad.com/api, Licenses; help article 76, "License keys"): success,
 * uses, and purchase.sale_id, product_id, recurrence, refunded, chargebacked,
 * disputed, dispute_won, subscription_cancelled_at, subscription_ended_at and
 * subscription_failed_at. A failed verification is a 404 with
 * { success: false, message }.
 *
 * The three subscription timestamps are the date the membership ends, not
 * the date someone asked for it to: a membership cancelled by the buyer
 * carries the end of its paid period (still ahead) from the moment it is
 * cancelled, a failed renewal and a fixed-length membership that ran out
 * carry the moment it stopped, and a renewal or restart puts all three back
 * to null. So a date still ahead is a plan set to end (cancelling, as a
 * Razorpay cycle-end cancel is) and a date that has passed is a plan that has
 * ended.
 */

/** The plans Gumroad sells, as SubscriptionTier names them. */
export type GumroadTier = 'STANDARD' | 'PRO';
export type GumroadPeriod = 'MONTHLY' | 'YEARLY';

/** The env key holding each plan's Gumroad product id (the License key block's). */
export const GUMROAD_PRODUCT_ENV: Record<GumroadTier, string> = {
  STANDARD: 'GUMROAD_PRODUCT_STANDARD',
  PRO: 'GUMROAD_PRODUCT_PRO',
};

/**
 * A Gumroad API access token with the view_sales scope, for the daily
 * re-check: the key itself is never stored, so the re-check reads it back
 * from the sale (GET /v2/sales/:id) before verifying it again. Required:
 * without it a membership refunded or cancelled after the key was redeemed
 * could never end the plan, so redeeming stays off (gumroadRedeemEnabled).
 */
export const GUMROAD_ACCESS_TOKEN_ENV = 'GUMROAD_ACCESS_TOKEN';

/**
 * Subscription.identifier of a plan paid on Gumroad: "gumroad:<sale_id>".
 * Razorpay plans are "sub_...", and every Razorpay sweep and Billing action
 * reads only those, so a Gumroad plan is never sent to Razorpay.
 */
export const GUMROAD_IDENTIFIER_PREFIX = 'gumroad:';

type Env = Record<string, string | undefined>;

export const gumroadIdentifier = (saleId: string) =>
  `${GUMROAD_IDENTIFIER_PREFIX}${saleId}`;

export const isGumroadIdentifier = (identifier?: string | null): boolean =>
  !!identifier && identifier.startsWith(GUMROAD_IDENTIFIER_PREFIX);

/** The configured products, Standard first. Empty when Gumroad is off. */
export function gumroadProducts(
  env: Env = process.env
): Array<{ tier: GumroadTier; productId: string }> {
  return (Object.keys(GUMROAD_PRODUCT_ENV) as GumroadTier[])
    .map((tier) => ({
      tier,
      productId: String(env[GUMROAD_PRODUCT_ENV[tier]] ?? '').trim(),
    }))
    .filter((p) => !!p.productId);
}

/** GUMROAD_ACCESS_TOKEN, trimmed; empty when unset. */
export const gumroadAccessToken = (env: Env = process.env) =>
  String(env[GUMROAD_ACCESS_TOKEN_ENV] ?? '').trim();

/**
 * Redeeming is on: a product is set, and the access token the re-check
 * needs. Otherwise the redeem field is hidden and the endpoint answers
 * GUMROAD_OFF.
 */
export function gumroadRedeemEnabled(env: Env = process.env): boolean {
  return gumroadProducts(env).length > 0 && !!gumroadAccessToken(env);
}

/** The plan a product id sells, or null when it is not one of ours. */
export function tierForProduct(
  productId: string | null | undefined,
  env: Env = process.env
): GumroadTier | null {
  if (!productId) return null;
  return gumroadProducts(env).find((p) => p.productId === productId)?.tier ?? null;
}

/**
 * Hookpost's Period for a Gumroad membership's recurrence. Period has only
 * MONTHLY and YEARLY, and every quota resets each month on both, so a
 * quarterly or six-monthly membership is MONTHLY here and a two-yearly one
 * YEARLY. Null for a one-time purchase (no recurrence): it is not a plan.
 */
export function periodForRecurrence(recurrence: unknown): GumroadPeriod | null {
  switch (String(recurrence ?? '').trim().toLowerCase()) {
    case 'monthly':
    case 'quarterly':
    case 'biannually':
      return 'MONTHLY';
    case 'yearly':
    case 'every_two_years':
      return 'YEARLY';
    default:
      return null;
  }
}

/**
 * A license key as typed or pasted: spaces and line breaks dropped, upper
 * case (Gumroad's keys are upper-case hex in four dash-separated groups), or
 * null when it cannot be one, so it is refused before Gumroad is asked.
 */
export function normalizeLicenseKey(raw: unknown): string | null {
  const key = String(raw ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
  return /^[A-Z0-9-]{8,64}$/.test(key) ? key : null;
}

/** The purchase a verified license belongs to, as far as Hookpost needs it. */
export interface GumroadPurchase {
  saleId: string;
  productId: string | null;
  recurrence: string | null;
  refunded: boolean;
  chargebacked: boolean;
  disputed: boolean;
  disputeWon: boolean;
  cancelledAt: Date | null;
  endedAt: Date | null;
  failedAt: Date | null;
  /** A seller's test purchase. */
  test: boolean;
  /** What the sale charged, in major units, when Gumroad says (owner alert only). */
  price?: number | null;
  currency?: string | null;
}

export type GumroadVerifyResult =
  | { kind: 'valid'; uses: number; purchase: GumroadPurchase }
  /** 404: no such key for that product (or the key was rotated). */
  | { kind: 'not_found'; message: string }
  /** 404: the seller disabled the key. */
  | { kind: 'disabled'; message: string }
  /** 404: access to the purchase was revoked or has expired. */
  | { kind: 'revoked'; message: string }
  /** Anything else: Gumroad could not say. Nothing is decided on it. */
  | { kind: 'unavailable'; message: string };

const flag = (v: unknown) => v === true || v === 'true';

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** What POST /v2/licenses/verify answered, read into a decision. */
export function parseVerifyResponse(
  status: number,
  body: unknown
): GumroadVerifyResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  if (status === 200 && b.success === true) {
    const p = b.purchase && typeof b.purchase === 'object' ? b.purchase : null;
    const saleId = text(p?.sale_id) || text(p?.id);
    if (!p || !saleId) {
      return { kind: 'unavailable', message: 'Gumroad answered without a purchase.' };
    }
    return {
      kind: 'valid',
      uses: Number(b.uses) || 0,
      purchase: {
        saleId,
        productId: text(p.product_id),
        recurrence: text(p.recurrence),
        refunded: flag(p.refunded),
        chargebacked: flag(p.chargebacked),
        disputed: flag(p.disputed),
        disputeWon: flag(p.dispute_won),
        cancelledAt: toDate(p.subscription_cancelled_at),
        endedAt: toDate(p.subscription_ended_at),
        failedAt: toDate(p.subscription_failed_at),
        test: flag(p.test),
        // For the owner's alert, only when Gumroad sends them. Gumroad gives
        // the price in cents.
        ...(p.price !== null &&
        p.price !== undefined &&
        p.price !== '' &&
        Number.isFinite(Number(p.price))
          ? { price: Number(p.price) / 100 }
          : {}),
        ...(text(p.currency) ? { currency: text(p.currency) } : {}),
      },
    };
  }
  const message = String(b.message || `Gumroad answered ${status}.`);
  if (status === 404 && b.success === false) {
    if (/disabled/i.test(message)) return { kind: 'disabled', message };
    if (/expired|revoked/i.test(message)) return { kind: 'revoked', message };
    return { kind: 'not_found', message };
  }
  return { kind: 'unavailable', message };
}

/** Why a plan bought on Gumroad ended. */
export type EndedLicenseStatus =
  | 'REFUNDED'
  | 'CHARGEBACKED'
  | 'CANCELLED'
  | 'ENDED'
  | 'FAILED'
  | 'REVOKED';

/** GumroadLicense.status (see the model in schema.prisma). */
export type GumroadLicenseStatus =
  | 'ACTIVE'
  | 'CANCELLING'
  | EndedLicenseStatus
  | 'REPLACED'
  | 'DETACHED';

/** The statuses the daily re-check still looks at. */
export const LIVE_LICENSE_STATUSES: GumroadLicenseStatus[] = ['ACTIVE', 'CANCELLING'];

export type LicenseStanding =
  | { status: 'ACTIVE' }
  /** Set to end: cancelled, with paid time left until endsAt. */
  | { status: 'CANCELLING'; endsAt: Date }
  | { status: EndedLicenseStatus };

export const isEnded = (
  s: LicenseStanding
): s is { status: EndedLicenseStatus } =>
  s.status !== 'ACTIVE' && s.status !== 'CANCELLING';

/**
 * Where a verified purchase stands now. Refunded or charged back ends the
 * plan whatever the dates say (a dispute the seller has not won counts as a
 * chargeback: the money has been taken back). Otherwise the first of the
 * three membership dates that has passed ends it (failed, then ended, then
 * cancelled), and the earliest one still ahead is when it is set to end.
 */
export function purchaseStanding(
  purchase: GumroadPurchase,
  now: Date = new Date()
): LicenseStanding {
  if (purchase.refunded) return { status: 'REFUNDED' };
  if (purchase.chargebacked || (purchase.disputed && !purchase.disputeWon)) {
    return { status: 'CHARGEBACKED' };
  }
  const ends: Array<[EndedLicenseStatus, Date | null]> = [
    ['FAILED', purchase.failedAt],
    ['ENDED', purchase.endedAt],
    ['CANCELLED', purchase.cancelledAt],
  ];
  const passed = ends.find(([, at]) => at && at.getTime() <= now.getTime());
  if (passed) return { status: passed[0] };
  const ahead = ends
    .map(([, at]) => at)
    .filter((at): at is Date => !!at)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return ahead ? { status: 'CANCELLING', endsAt: ahead } : { status: 'ACTIVE' };
}

/**
 * A verification's standing, or null when Gumroad could not say (then
 * nothing changes). A key Gumroad no longer finds, has disabled, or whose
 * purchase access was revoked is REVOKED.
 */
export function verifyStanding(
  result: GumroadVerifyResult,
  now: Date = new Date()
): LicenseStanding | null {
  switch (result.kind) {
    case 'valid':
      return purchaseStanding(result.purchase, now);
    case 'not_found':
    case 'disabled':
    case 'revoked':
      return { status: 'REVOKED' };
    default:
      return null;
  }
}

export type BindDecision = 'new' | 'same_org' | 'other_org';

/**
 * One license, one workspace. A key nobody has redeemed binds to this
 * workspace; the workspace that already holds it may redeem it again (it is
 * re-checked and its plan refreshed); any other workspace is refused.
 */
export function bindDecision(
  bound: { organizationId: string } | null | undefined,
  organizationId: string
): BindDecision {
  if (!bound) return 'new';
  return bound.organizationId === organizationId ? 'same_org' : 'other_org';
}

/** The workspace's Subscription row, as the redeem and the re-check read it. */
export interface PlanRow {
  identifier?: string | null;
  isLifetime?: boolean | null;
  cancelAt?: Date | string | null;
  deletedAt?: Date | string | null;
}

/**
 * Whether the plan on file stops a Gumroad license from being redeemed on
 * this workspace: any live plan not paid on Gumroad (Razorpay, lifetime,
 * given by an admin), even one set to end. Hookpost never touches a Razorpay
 * subscription for a Gumroad purchase, and a Razorpay row with an end date
 * is not always a cancelled one: a halted renewal carries its grace date
 * there (scheduleHaltedRenewalEnd) and can still be paid, which would bring
 * the Razorpay plan back over the Gumroad one. Such a workspace redeems once
 * its plan has ended, or the key goes on another workspace. A plan paid on
 * Gumroad can be replaced by another key.
 */
export function planOnFileBlocksRedeem(row: PlanRow | null | undefined): boolean {
  if (!row || row.deletedAt) return false;
  return !isGumroadIdentifier(row.identifier);
}

export type SweepAction =
  /** Nothing to change. */
  | { action: 'keep' }
  /** Renewed or restarted on Gumroad: the plan is no longer set to end. */
  | { action: 'lift' }
  /** Cancelled with paid time left: the plan ends on endsAt. */
  | { action: 'schedule'; endsAt: Date }
  /** Ended on Gumroad: the plan ends now, as an ended Razorpay plan does. */
  | { action: 'end'; status: EndedLicenseStatus }
  /** The workspace's plan is no longer this license's: leave it alone. */
  | { action: 'detach' };

/**
 * What the daily re-check does with one license, given where it stands on
 * Gumroad and the workspace's plan row. Only the plan this license pays for
 * (identifier "gumroad:<its sale>") is ever changed: a workspace that has
 * since moved to a Razorpay plan, or redeemed another key, is left as it is.
 */
export function sweepAction(
  standing: LicenseStanding,
  plan: PlanRow | null | undefined,
  identifier: string
): SweepAction {
  if (!plan || plan.deletedAt || plan.identifier !== identifier) {
    return { action: 'detach' };
  }
  if (isEnded(standing)) return { action: 'end', status: standing.status };
  const cancelAt = plan.cancelAt ? new Date(plan.cancelAt) : null;
  if (standing.status === 'CANCELLING') {
    return cancelAt && cancelAt.getTime() === standing.endsAt.getTime()
      ? { action: 'keep' }
      : { action: 'schedule', endsAt: standing.endsAt };
  }
  return cancelAt ? { action: 'lift' } : { action: 'keep' };
}

/**
 * Why POST /billing/gumroad/redeem said no: the HTTP status and the English
 * message the API sends. The Billing page shows the same words, translated,
 * under the key gumroad_error_<code in lower case> (gumroad.redeem.copy.ts).
 */
export type GumroadRedeemErrorCode =
  | 'GUMROAD_OFF'
  | 'INVALID_KEY'
  | 'LICENSE_IN_USE'
  | 'PLAN_ON_FILE'
  | 'REFUNDED'
  | 'CANCELLED'
  | 'DISABLED'
  | 'NOT_A_SUBSCRIPTION'
  | 'GUMROAD_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'REDEEM_IN_PROGRESS';

export const GUMROAD_REDEEM_ERRORS: Record<
  GumroadRedeemErrorCode,
  { status: number; message: string }
> = {
  GUMROAD_OFF: {
    status: 404,
    message: 'Gumroad purchases cannot be redeemed here.',
  },
  INVALID_KEY: {
    status: 400,
    message:
      "We couldn't find that license key for a Hookpost plan on Gumroad. Copy the whole key from your Gumroad receipt and try again.",
  },
  LICENSE_IN_USE: {
    status: 409,
    message:
      'This license key is already in use on another workspace. To move it, email support@hookstep.in.',
  },
  PLAN_ON_FILE: {
    status: 409,
    message:
      'This workspace already has a plan. Redeem the key on another workspace, or email support@hookstep.in to move this one to Gumroad.',
  },
  REFUNDED: {
    status: 400,
    message:
      'This Gumroad purchase was refunded or charged back, so it no longer includes a plan.',
  },
  CANCELLED: {
    status: 400,
    message:
      'This Gumroad membership has ended. Restart it on Gumroad, then enter the key again.',
  },
  DISABLED: {
    status: 400,
    message:
      'This license key has been disabled on Gumroad. Email support@hookstep.in for help.',
  },
  NOT_A_SUBSCRIPTION: {
    status: 400,
    message:
      'This Gumroad purchase is a one-time payment, and Hookpost plans are monthly or yearly memberships. Email support@hookstep.in and we will sort it out.',
  },
  GUMROAD_UNAVAILABLE: {
    status: 503,
    message: "We couldn't reach Gumroad to check the key. Try again in a minute.",
  },
  RATE_LIMITED: {
    status: 429,
    message: 'Too many attempts. Try again in a few minutes.',
  },
  REDEEM_IN_PROGRESS: {
    status: 409,
    message:
      'A license key is already being redeemed on this workspace. Try again in a moment.',
  },
};

/** The redeem error for a purchase that is no longer a plan. */
export function endedRedeemError(
  status: EndedLicenseStatus
): GumroadRedeemErrorCode {
  switch (status) {
    case 'REFUNDED':
    case 'CHARGEBACKED':
      return 'REFUNDED';
    case 'REVOKED':
      return 'DISABLED';
    default:
      return 'CANCELLED';
  }
}

/** The status a license is left in after a sweep action. */
export function statusAfter(
  standing: LicenseStanding,
  step: SweepAction
): GumroadLicenseStatus {
  if (step.action === 'detach') return 'DETACHED';
  if (step.action === 'end') return step.status;
  return standing.status === 'CANCELLING' ? 'CANCELLING' : 'ACTIVE';
}
