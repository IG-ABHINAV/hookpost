// What a workspace without a plan (planState needs_trial or locked, from
// /user/self, and free_posts for its counter) is told wherever it can still
// see Hookpost: the strip over the
// app and the connect step, the composer's main button, and the OAuth consent
// page after an AI client (Claude, ChatGPT) is linked. Every button goes to
// TRIAL_CTA_HREF, the paywall: plans in the currency the server picks for the
// visitor (/billing/pricing-context) and the Razorpay checkout.
//
// On 27 Oct 2026 twelve sign-ups came in through the Claude connector and
// none started the trial; the connect step said "Next, start your trial" with
// no button, and an admin impersonating one of them got the whole app with
// nothing saying a trial was needed.
import {
  blocksPlanUse,
  knownTrialDays,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/** The paywall (PlanGateScreen on /billing skips the connect step). */
export const TRIAL_CTA_HREF = '/billing';

export interface TrialCta {
  /** The sentence on the strip. */
  message: string;
  /** The strip's button, or null for a member (Billing is for admins). */
  label: string | null;
  /** The composer's main button in place of "Add to calendar". */
  scheduleLabel: string | null;
}

interface PlanFields {
  planState?: string | null;
  allowTrial?: boolean | null;
  role?: string | null;
  isTwa: boolean;
  trialDays?: number | null;
}

/** Billing is for the workspace's admins (top.menu.tsx, permissions ADMIN). */
const canBill = (role?: string | null) =>
  role === 'ADMIN' || role === 'SUPERADMIN';

/**
 * Null for a workspace with a plan, a trial or the Free plan, and inside the
 * Play app, which sells nothing (twa.ts; showTwaPlanGate covers it there).
 * needs_trial is offered the trial; locked (trial used) a plan.
 */
export const trialRequiredCta = (p: PlanFields): TrialCta | null => {
  if (p.isTwa || !blocksPlanUse(p.planState as any)) return null;
  const trial = p.planState === 'needs_trial' && p.allowTrial !== false;
  const days = knownTrialDays(p.trialDays);
  if (!canBill(p.role)) {
    return {
      message: trial
        ? 'Publishing starts once this workspace starts its trial. Ask a workspace admin to start it.'
        : 'Publishing starts once this workspace has a plan. Ask a workspace admin to choose one.',
      label: null,
      scheduleLabel: null,
    };
  }
  return trial
    ? {
        message: `Start your ${days}-day trial to publish posts.`,
        label: 'Start free trial',
        scheduleLabel: 'Start trial to schedule',
      }
    : {
        message: 'Choose a plan to publish posts.',
        label: 'Choose a plan',
        scheduleLabel: 'Choose a plan to schedule',
      };
};

/** /user/self freePosts: a workspace on its free posts (planState free_posts). */
export interface FreePostsAllowance {
  used: number;
  limit: number;
  left: number;
}

export interface FreePostsCounter {
  /** "2 of 3 free posts left", or that they are used. */
  message: string;
  /** "Upgrade" to the plans, or null for a member and in the Play app. */
  label: string | null;
  /** None left: the counter turns into the way to the plans. */
  usedUp: boolean;
}

/**
 * The counter over the app for a new sign-up on its FREE_POST_LIMIT free
 * posts (trial.policy.ts free_posts). Null in every other state. Its Upgrade
 * goes to TRIAL_CTA_HREF, the plans, which a workspace on its free posts
 * reaches like any page (no paywall in front of the app for it).
 */
export const freePostsCounter = (p: {
  planState?: string | null;
  freePosts?: FreePostsAllowance | null;
  role?: string | null;
  isTwa: boolean;
}): FreePostsCounter | null => {
  const f = p.freePosts;
  if (p.planState !== 'free_posts' || !f) return null;
  const usedUp = f.left <= 0;
  return {
    message: usedUp
      ? `You've used your ${f.limit} free posts`
      : `${f.left} of ${f.limit} free post${f.limit === 1 ? '' : 's'} left`,
    label: p.isTwa || !canBill(p.role) ? null : 'Upgrade',
    usedUp,
  };
};

/**
 * The line over the plans for a workspace on its free posts. `offerPercent`
 * is the first-month offer when this checkout carries it (rupees, monthly,
 * no coupon: first.month.offer.ts), else null, so dollars and yearly plans
 * are never promised it.
 */
export const freePostsPlansLine = (
  freePosts: FreePostsAllowance | null | undefined,
  offerPercent: number | null
): string | null => {
  if (!freePosts) return null;
  const offer = offerPercent ? ` — first month ${offerPercent}% off (new customers)` : '';
  return freePosts.left <= 0
    ? `You've used your ${freePosts.limit} free posts. Pick a plan to keep posting${offer}.`
    : `${freePosts.left} of ${freePosts.limit} free posts left. Pick a plan whenever you're ready${offer}.`;
};

/**
 * The paywall and plan gates apply to everyone looking at the workspace, the
 * platform admin included while impersonating: /user/self says admin: true
 * then too (AuthMiddleware keeps isSuperAdmin on the impersonated user), and
 * the admin used to get the whole app where the customer gets the paywall.
 * Only an admin in their own workspace skips the gates.
 */
export const skipsPlanGates = (u?: {
  admin?: boolean | null;
  impersonate?: boolean | null;
} | null): boolean => !!u?.admin && !u?.impersonate;

export interface ConnectorTrialNotice {
  title: string;
  message: string;
  /** Opens the paywall in a new tab; null for a member. */
  label: string | null;
  continueLabel: string;
}

/**
 * The card the OAuth consent page shows after Authorize, before handing the
 * browser back to the AI client, when the workspace has no plan: the
 * connector works, but every tool call is refused until the trial starts
 * (mcp.plan.gate.ts). Null otherwise, and the page redirects at once.
 */
export const connectorTrialNotice = (
  p: PlanFields & { appName?: string | null }
): ConnectorTrialNotice | null => {
  const cta = trialRequiredCta(p);
  if (!cta) return null;
  const app = (p.appName || '').trim() || 'Your AI assistant';
  const trial = p.planState === 'needs_trial' && p.allowTrial !== false;
  const days = knownTrialDays(p.trialDays);
  const ask = !cta.label;
  return {
    title: 'Your connector is linked',
    message: ask
      ? `${app} is connected to Hookpost. It can publish once a workspace admin ${
          trial ? 'starts the trial' : 'chooses a plan'
        }.`
      : trial
      ? `${app} is connected to Hookpost. Start your ${days}-day trial so ${app} can publish. Until then it can't schedule or post anything.`
      : `${app} is connected to Hookpost. Choose a plan so ${app} can publish. Until then it can't schedule or post anything.`,
    label: cta.label,
    continueLabel: `Continue to ${app}`,
  };
};

/** utm_source on the paywall link the consent page opens. */
export const CONNECTOR_TRIAL_SOURCE = 'oauth_connect';
export const connectorTrialHref = () =>
  `${TRIAL_CTA_HREF}?utm_source=${CONNECTOR_TRIAL_SOURCE}`;
