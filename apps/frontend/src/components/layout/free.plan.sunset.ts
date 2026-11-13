// What the in-app notice says to a grandfathered Free workspace before
// FREE_PLAN_SUNSET_AT (trial.policy.ts on the backend). /user/self sends
// freePlanEndsAt only while the date is still ahead and the workspace is on
// the Free plan and not exempt, so an absent or null value means no notice.
// After the sunset the same workspace is on the paywall instead.
import {
  freePlanEndDateLabel,
  knownTrialDays,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { TWA_PLAN_NOTICE } from '@hookpost/frontend/components/layout/twa';

/** sessionStorage: the notice was closed in this tab, for this date. */
export const FREE_SUNSET_DISMISS_KEY = 'hookpost_free_sunset_dismissed';

export interface FreePlanSunsetNotice {
  message: string;
  /** The billing button's label, or null for no button (Play app, members). */
  trialLabel: string | null;
}

export const freePlanSunsetNotice = (p: {
  planState?: string | null;
  freePlanEndsAt?: string | null;
  allowTrial?: boolean;
  role?: string | null;
  isTwa: boolean;
  /**
   * /user/self trialDays: 7 for the workspaces the sunset email promised a
   * 7-day trial, else TRIAL_DAYS.
   */
  trialDays?: number | null;
}): FreePlanSunsetNotice | null => {
  if (p.planState !== 'free' || !p.freePlanEndsAt) return null;
  const at = new Date(p.freePlanEndsAt);
  if (Number.isNaN(at.getTime())) return null;
  const ends = `Your Free plan ends on ${freePlanEndDateLabel(at)}.`;
  // The Play app sells nothing (twa.ts): the date and the plain plan line.
  if (p.isTwa) {
    return { message: `${ends} ${TWA_PLAN_NOTICE}.`, trialLabel: null };
  }
  // Billing is for the workspace's admins (top.menu.tsx); a member reads the
  // date and can still delete their own account.
  const canBill = p.role === 'ADMIN' || p.role === 'SUPERADMIN';
  const days = knownTrialDays(p.trialDays);
  return p.allowTrial
    ? {
        message: `${ends} Start your ${days}-day trial to keep posting, or delete your account.`,
        trialLabel: canBill ? `Start ${days}-day trial` : null,
      }
    : {
        message: `${ends} Choose a plan to keep posting, or delete your account.`,
        trialLabel: canBill ? 'Choose a plan' : null,
      };
};

/**
 * Delete Account on the plans screen (FirstBillingComponent) at every width,
 * and on the Play app's plan gate. Its FAQ entry is hidden on mobile and
 * tablet, and the notice above is gone once the sunset has passed. So it is
 * shown wherever a workspace has to start its trial or choose a plan (that
 * screen then replaces every page, /settings included, which the sunset email
 * links to), and while a Free plan end date is ahead.
 */
export const planScreenOffersDelete = (p: {
  planState?: string | null;
  freePlanEndsAt?: string | null;
}): boolean =>
  p.planState === 'needs_trial' ||
  p.planState === 'locked' ||
  (p.planState === 'free' && !!p.freePlanEndsAt);
