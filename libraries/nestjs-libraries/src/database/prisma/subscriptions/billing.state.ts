/**
 * One billing state per workspace for the super-admin Users & Billing page
 * (GET /admin/users), in the owner's words (4 Nov 2026, "make terminology
 * easy"):
 *
 *   Free posts            "Can post free · X of 3 left"
 *   Paying                "Paying ₹X/month · renews <date>", only with a real
 *                         Razorpay charge on record (or a Gumroad purchase)
 *   Free Pro (gift)       "Free Pro until <date>": a plan an admin gave
 *   Needs a plan          "Used 3 free posts · must pick a plan"
 *   Team / review account our own, team and app-review workspaces, never
 *                         counted as customers
 *   Lifetime plan         a lifetime plan that was bought, not given
 *
 * plus the states a Razorpay plan passes through (first charge due,
 * cancelled, payment failed), api.market workspaces and users with no
 * workspace.
 *
 * Pure, like trial.policy.ts, which decides everything: planState() is the
 * one rule the paywall applies, planSource() says where a plan came from, and
 * freePostsUsed() (the caller's count, the same one the post gate uses)
 * splits Free posts from Needs a plan. This page and the paywall can never
 * disagree. Time comes from `cutoffs.now` (absent means now).
 */
import {
  FREE_POST_LIMIT,
  freePostsLeft,
  internalWorkspace,
  planLapsed,
  planSource,
  planState,
  PlanState,
  PolicyOrg,
  PolicySubscription,
  TrialCutoffs,
  trialCutoffs,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

export type BillingState =
  /** A real charge on record: Razorpay charged it at least once (or Gumroad sold it). */
  | 'paying'
  /** A Razorpay plan whose card or UPI is added and whose first charge is still ahead. */
  | 'first_charge'
  /** Cancelled (cancelAt on file, or ended at Razorpay): keeps access until then. */
  | 'cancelled'
  /** Razorpay could not charge it (pending: retrying; halted: stopped). */
  | 'payment_failed'
  /** A plan an admin gave, never billed: "Free Pro until <date>". */
  | 'gift'
  /** No plan: on its FREE_POST_LIMIT free posts. */
  | 'free_posts'
  /** No plan and no free posts left: must pick a plan. */
  | 'needs_plan'
  /** Our own, team and app-review workspaces: never customers. */
  | 'team'
  /** A lifetime plan that was bought. */
  | 'lifetime'
  /** The old Free plan, only where FREE_PLAN_SUNSET_AT does not reach. */
  | 'free'
  /** An api.market subscriber's workspace (billed by api.market, no users). */
  | 'marketplace'
  /** A user without a live workspace. */
  | 'no_workspace';

/** The order the page lists the states in: customers first, then the rest. */
export const BILLING_STATES: readonly BillingState[] = [
  'free_posts',
  'paying',
  'first_charge',
  'gift',
  'needs_plan',
  'cancelled',
  'payment_failed',
  'free',
  'lifetime',
  'team',
  'marketplace',
  'no_workspace',
];

/** What the caller read from Razorpay for the workspace's subscription. */
export interface RemoteSubscription {
  status: string;
  paidCount: number;
  /** Unix seconds, or null. */
  startAt: number | null;
  chargeAt: number | null;
  currentEnd: number | null;
  /** The plan's price per cycle in major units (599, not 59900), when known. */
  amount: number | null;
  currency: string | null;
}

export interface BillingSubscription extends PolicySubscription {
  subscriptionTier?: string | null;
  period?: string | null;
  identifier?: string | null;
}

export interface BillingInput {
  /** The workspace as the trial policy sees it; null for a user with none. */
  org: (PolicyOrg & { subscription?: BillingSubscription | null }) | null;
  /** A MarketplaceAccount row points at this workspace. */
  marketplace?: boolean;
  attribution?: {
    trialStartedAt?: Date | string | null;
    paidAt?: Date | string | null;
  } | null;
  /** Razorpay's copy of the subscription; null or absent when not read. */
  remote?: RemoteSubscription | null;
  /**
   * The workspace's free posts used, counted as the post gate counts them
   * (trial.policy.ts freePostsUsed over SubscriptionRepository.freePostRows).
   * Absent means none.
   */
  freePostsUsed?: number | null;
}

export interface BillingView {
  state: BillingState;
  /** One line with the date that matters, e.g. "Paying — renews 13 Nov". */
  label: string;
  /** A second, smaller line: plan, amount, why. */
  detail: string;
  /** The date in the label, ISO, for a tooltip. */
  at: string | null;
  /** The trial policy's state (what the paywall applies), for reference. */
  planState: PlanState | null;
}

/** Razorpay states that will never bill again. */
const ENDED = ['cancelled', 'completed', 'expired'];

/** "26 Oct", in India (where the business is); with the year when it is not this year's. */
export function billingDay(at: Date | string, now: Date = new Date()): string {
  const d = new Date(at);
  const year = (x: Date) =>
    x.toLocaleDateString('en-GB', { year: 'numeric', timeZone: 'Asia/Kolkata' });
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(year(d) !== year(now) ? { year: 'numeric' } : {}),
    timeZone: 'Asia/Kolkata',
  });
}

/** ₹599, $9, €12, or "AED 30". */
export function billingMoney(amount: number, currency: string | null | undefined): string {
  const cur = (currency || 'INR').toUpperCase();
  const symbol = cur === 'INR' ? '₹' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : `${cur} `;
  const n = Number.isInteger(amount)
    ? amount.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US')
    : amount.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
  return `${symbol}${n}`;
}

const seconds = (s: number | null | undefined): Date | null =>
  s && s > 0 ? new Date(s * 1000) : null;

const validDate = (v: Date | string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/** "Standard monthly" from STANDARD / MONTHLY. */
function planName(row: BillingSubscription): string {
  const tier = row.subscriptionTier ? titleCase(String(row.subscriptionTier)) : 'Plan';
  return row.period ? `${tier} ${String(row.period).toLowerCase()}` : tier;
}

/** "₹599/month", "$190.50/year", or '' when the price was not read. */
function pricePerCycle(remote: RemoteSubscription | null | undefined, row: BillingSubscription) {
  if (!remote || remote.amount == null) return '';
  const per = String(row.period || '').toUpperCase() === 'YEARLY' ? '/year' : '/month';
  return `${billingMoney(remote.amount, remote.currency)}${per}`;
}

/** "Free Pro", from the tier. */
function giftName(row: BillingSubscription): string {
  return `Free ${row.subscriptionTier ? titleCase(String(row.subscriptionTier)) : 'plan'}`;
}

export function billingState(
  input: BillingInput,
  cutoffs: TrialCutoffs = trialCutoffs()
): BillingView {
  const now = cutoffs.now ?? new Date();
  const day = (d: Date) => billingDay(d, now);
  const view = (
    state: BillingState,
    label: string,
    detail: string,
    at: Date | null = null,
    ps: PlanState | null = null
  ): BillingView => ({ state, label, detail, at: at ? at.toISOString() : null, planState: ps });

  const { org, remote } = input;
  if (!org) {
    return view('no_workspace', 'No workspace', 'This user has no live workspace');
  }

  const sub = org.subscription && !org.subscription.deletedAt ? org.subscription : null;

  if (input.marketplace) {
    return view(
      'marketplace',
      'API marketplace',
      'An api.market subscriber: billed by api.market, no Hookpost users',
      null,
      sub ? 'active' : null
    );
  }

  const source = planSource(sub);
  // A plan an admin gave is over at its end date, like a Razorpay one
  // (planLapsed); from then on it is no plan at all.
  // A paid one-time month ends the same way at its cancelAt.
  const live =
    sub && !((source === 'gift' || source === 'order') && planLapsed(sub, now)) ? sub : null;

  if (live && source === 'lifetime') {
    const ps = planState(org, cutoffs);
    // Every lifetime plan on file was given by us (sub_admin_lifetime, or no
    // identifier): our own and team workspaces. One with any other
    // identifier was sold.
    const given =
      internalWorkspace(org, cutoffs) ||
      !live.identifier ||
      live.identifier.startsWith('sub_admin');
    return given
      ? view('team', 'Team / review account', `${planName(live)} · lifetime plan we gave, never billed`, null, ps)
      : view('lifetime', 'Lifetime plan', planName(live), null, ps);
  }

  if (live && source === 'gift') {
    const ps = planState(org, cutoffs);
    const ends = validDate(live.cancelAt);
    return view(
      'gift',
      ends ? `${giftName(live)} until ${day(ends)}` : `${giftName(live)} · no end date set`,
      'Given by an admin, never billed',
      ends,
      ps
    );
  }

  if (live && source === 'order') {
    // One paid month (one.time.plan.ts): no renewal, it ends at cancelAt.
    const ps = planState(org, cutoffs);
    const ends = validDate(live.cancelAt);
    return view(
      'paying',
      ends ? `Paid · until ${day(ends)}` : 'Paid · end date not set',
      `${planName(live)} · one-time payment, renews only if paid again`,
      ends,
      ps
    );
  }

  if (live && source === 'gumroad') {
    const ps = planState(org, cutoffs);
    const cancelAt = validDate(live.cancelAt);
    if (cancelAt) {
      return view('cancelled', `Cancelled · access until ${day(cancelAt)}`, `${planName(live)} · Gumroad`, cancelAt, ps);
    }
    return view('paying', 'Paying · Gumroad', `${planName(live)} · bought on Gumroad`, null, ps);
  }

  if (live) {
    const ps = planState(org, cutoffs, remote?.status ?? null);
    const plan = planName(live);
    const price = pricePerCycle(remote, live);

    const status = remote?.status ?? null;
    if (status === 'pending') {
      return view(
        'payment_failed',
        'Payment failed · retrying',
        `${plan}${price ? ` · ${price}` : ''} · Razorpay is retrying the charge; AI and X are off`,
        seconds(remote?.chargeAt),
        ps
      );
    }
    if (status === 'halted') {
      return view(
        'payment_failed',
        'Payment failed · stopped',
        `${plan}${price ? ` · ${price}` : ''} · Razorpay stopped retrying; the plan ends once the time paid for runs out`,
        null,
        ps
      );
    }
    // Razorpay was not read (the page lists many workspaces, or Razorpay is
    // down), but the webhook left the marker: say so rather than call a
    // failing plan "paying" (trial.policy.ts paymentFailingSince).
    if (!remote && validDate(live.paymentFailingSince)) {
      return view(
        'payment_failed',
        'Payment failed · retrying',
        `${plan} · failing since ${day(validDate(live.paymentFailingSince)!)}; AI and X are off`,
        validDate(live.paymentFailingSince),
        ps
      );
    }

    const neverCharged = remote
      ? remote.paidCount === 0
      : !!org.isTrailing && !validDate(input.attribution?.paidAt);

    const cancelAt = validDate(live.cancelAt);
    if (cancelAt) {
      const label =
        cancelAt.getTime() > now.getTime()
          ? `Cancelled · access until ${day(cancelAt)}`
          : `Cancelled · access ended ${day(cancelAt)}`;
      const why = neverCharged ? 'cancelled before the first charge, never charged' : 'no further charges';
      return view('cancelled', label, `${plan} · ${why}`, cancelAt, ps);
    }
    if (status && ENDED.includes(status)) {
      return view(
        'cancelled',
        'Cancelled · ended at Razorpay',
        `${plan} · Razorpay says ${status}; the plan row is still on file`,
        null,
        ps
      );
    }

    if (neverCharged) {
      const first = remote ? seconds(remote.startAt) || seconds(remote.chargeAt) : null;
      const added = validDate(input.attribution?.trialStartedAt);
      const addedText = added ? ` · card or UPI added ${day(added)}` : '';
      if (!first) {
        return view(
          'first_charge',
          'First charge date unknown',
          `${plan}${addedText}${remote ? '' : ' · Razorpay not read'}`,
          null,
          ps
        );
      }
      const amount =
        remote && remote.amount != null ? ` ${billingMoney(remote.amount, remote.currency)}` : '';
      const when = first.getTime() >= now.getTime() ? 'on' : 'due since';
      return view('first_charge', `First charge${amount} ${when} ${day(first)}`, `${plan}${addedText}`, first, ps);
    }

    const next = remote ? seconds(remote.chargeAt) || seconds(remote.currentEnd) : null;
    const head = price ? `Paying ${price}` : 'Paying';
    return view(
      'paying',
      next ? `${head} · renews ${day(next)}` : head,
      `${plan} · ${remote ? 'Razorpay' : 'renewal date not read from Razorpay'}`,
      next,
      ps
    );
  }

  // No plan on file (or a gift past its end date): one rule, the paywall's.
  const ps = planState(org, cutoffs);
  if (internalWorkspace(org, cutoffs)) {
    return view(
      'team',
      'Team / review account',
      org.platformAdmin
        ? 'A platform admin is a member'
        : 'In FREE_PLAN_SUNSET_EXEMPT_ORGS (our own and app-review workspaces)',
      null,
      ps
    );
  }
  if (ps === 'free') {
    return view('free', 'Old Free plan', "Signed up before the free posts; FREE_PLAN_SUNSET_AT does not reach this workspace's region", null, ps);
  }

  const used = Math.max(0, Math.floor(input.freePostsUsed ?? 0));
  if (ps === 'free_posts' && freePostsLeft(used) > 0) {
    return view(
      'free_posts',
      `Can post free · ${freePostsLeft(used)} of ${FREE_POST_LIMIT} left`,
      `${FREE_POST_LIMIT} free posts, no card; then picks a plan`,
      null,
      ps
    );
  }
  const spent = used >= FREE_POST_LIMIT;
  return view(
    'needs_plan',
    spent ? `Used ${FREE_POST_LIMIT} free posts · must pick a plan` : 'No free posts · must pick a plan',
    org.disputedAt
      ? 'A payment dispute is open on this workspace'
      : spent
      ? `${used} posts counted`
      : 'Had a plan before, or its sign-up was refused free posts (same person, or a disposable email)',
    null,
    ps
  );
}

/** How many of `views` are in each state, every state present. */
export function countBillingStates(states: Iterable<BillingState>): Record<BillingState, number> {
  const out = Object.fromEntries(BILLING_STATES.map((s) => [s, 0])) as Record<BillingState, number>;
  for (const s of states) out[s] += 1;
  return out;
}
