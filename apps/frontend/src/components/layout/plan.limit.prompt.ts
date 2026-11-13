import {
  knownTrialDays,
  PAY_FROM_ANOTHER_ACCOUNT_PATH,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/**
 * The dialog for a 402 from the backend. `code` is set when the workspace has
 * to start its trial (TRIAL_REQUIRED) or choose a plan (PLAN_REQUIRED) before
 * anything else, or has used its free posts (FREE_POSTS_USED; trial.policy.ts); otherwise it is a plan limit, where
 * trial=true means a Free workspace that has not used its Standard trial yet.
 * body.trialDays is that workspace's trial length (7 for one the Free plan
 * sunset notice promised 7 to); without it, TRIAL_DAYS.
 */
/** The workspace a FREE_POSTS_USED body offers to switch to, if it is well formed. */
export const freePostsSwitchTarget = (
  body: any
): { id: string; name: string; left: number } | null => {
  const t = body?.switchTo;
  if (!t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string') return null;
  const left = Number(t.left);
  if (!Number.isFinite(left) || left <= 0) return null;
  return { id: t.id, name: t.name.slice(0, 60), left };
};

export const planLimitPrompt = (body: any): {
  message: string;
  button: string;
  title: string;
  href?: string;
  switchTo?: { id: string; name: string; left: number };
  secondButton?: string;
} => {
  const days = knownTrialDays(body?.trialDays);
  if (body?.code === 'TRIAL_REQUIRED') {
    return {
      message:
        body?.message ||
        `Start your ${days}-day trial to schedule and publish posts.`,
      button: `Start ${days}-day trial`,
      title: 'Start your trial',
    };
  }
  // A new sign-up's free posts are used (trial.policy.ts FREE_POSTS_USED):
  // the plans, which the button opens, show the first-month offer.
  if (body?.code === 'FREE_POSTS_USED') {
    // The account used its free posts in another workspace of this user that
    // still has some (trial.policy.ts freePostsLeftElsewhereMessage): offer
    // to switch there, with the plans as the other way out.
    const switchTo = freePostsSwitchTarget(body);
    if (switchTo) {
      return {
        message: body.message,
        button: `Switch to ${switchTo.name}`,
        title: 'Free posts left in your other workspace',
        switchTo,
        secondButton: 'See plans',
      };
    }
    return {
      message:
        body?.message ||
        "You've used your free posts. Pick a plan to keep posting.",
      button: 'See plans',
      title: 'Pick a plan to keep posting',
    };
  }
  // AI or X refused while the plan's payment is failing (trial.policy.ts
  // `dunning`): the workspace has a plan, so the button pays for it from
  // another account rather than showing the plans.
  if (body?.code === 'PAYMENT_FAILING') {
    return {
      message:
        body?.message ||
        "Your last payment didn't go through, so AI and X are paused until it does.",
      button: 'Pay from a different account',
      title: 'Payment failed',
      href: PAY_FROM_ANOTHER_ACCOUNT_PATH,
    };
  }
  if (body?.code === 'PLAN_REQUIRED') {
    return {
      message: body?.message || 'Choose a plan to continue.',
      button: 'Choose a plan',
      title: 'Choose a plan',
    };
  }
  return {
    message: body?.message || 'You have reached a limit of your plan.',
    button: body?.trial ? `Start ${days}-day free trial` : 'See plans',
    title: 'Upgrade to keep going',
  };
};

/**
 * The 402 body for the plan dialog, read from a copy so the caller still gets
 * the response unread. It used to get one this read had already consumed: its
 * own .json() threw, SWR counted an error and retried, and every retry opened
 * the dialog again (the AI Agent re-opened it 13 to 90 s after each close).
 */
export const readPlanRefusal = (
  response: Pick<Response, 'clone'>
): Promise<any> =>
  response
    .clone()
    .json()
    .catch(() => ({}));

let planDialogOpen = false;

/**
 * Shows at most one plan dialog at a time. A page that fires several requests
 * the plan refuses (the AI Agent loaded its thread list, and SWR retried it)
 * stacked one "Upgrade to keep going" dialog per 402. While one is open, the
 * others are dropped, not queued, and resolve false (no navigation).
 */
export const showPlanDialogOnce = async <T = boolean>(
  open: () => Promise<T>
): Promise<T | undefined> => {
  // Already open: nothing chosen (undefined), so no caller acts on it.
  if (planDialogOpen) {
    return undefined;
  }
  planDialogOpen = true;
  try {
    // As the dialog answered: true / false for its two buttons, undefined
    // when it was closed (new-modal.tsx).
    return await open();
  } finally {
    planDialogOpen = false;
  }
};

/**
 * The plan has no AI (the Free plan: pricing.ts ai: false). The user context
 * holds the plan's pricing entry as `tier`. Unknown means not locked.
 */
export const aiLocked = (tier?: { ai?: boolean } | null): boolean =>
  tier?.ai === false;
