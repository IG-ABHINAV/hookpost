'use client';

import { createContext, FC, ReactNode, useContext } from 'react';
import { User } from '@prisma/client';
import {
  pricing,
  PricingInnerInterface,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

/** Mirrors PlanState in libraries/.../subscriptions/trial.policy.ts. */
export type PlanState =
  | 'free'
  | 'free_posts'
  | 'needs_trial'
  | 'locked'
  | 'trialing'
  | 'active'
  | 'dunning'
  | 'cancelling';
export const UserContext = createContext<
  | undefined
  | (User & {
      orgId: string;
      tier: PricingInnerInterface;
      publicApi: string;
      role: 'USER' | 'ADMIN' | 'SUPERADMIN';
      totalChannels: number;
      isLifetime?: boolean;
      impersonate: boolean;
      allowTrial: boolean;
      isTrailing: boolean;
      /**
       * Where the workspace stands with the trial policy, from /user/self
       * (trial.policy.ts on the backend). needs_trial and locked see only the
       * paywall. tier stays FREE for them, like any workspace without a plan.
       */
      planState?: PlanState;
      /**
       * A workspace on its free posts (planState free_posts): how many of its
       * FREE_POST_LIMIT posts it has used and has left. Null in every other
       * state, absent from an older backend.
       */
      freePosts?: { used: number; limit: number; left: number } | null;
      /**
       * How many channels the workspace may connect before its trial starts
       * (PRE_TRIAL_CHANNEL_LIMIT on the backend): a number only while it is
       * needs_trial, else null. Absent from an older backend, which means
       * no connect step before the paywall.
       */
      preTrialChannelLimit?: number | null;
      /** False for the new cohort: no Free plan, no "continue free". */
      freePlanAvailable?: boolean;
      /**
       * ISO time a grandfathered Free plan ends (FREE_PLAN_SUNSET_AT on the
       * backend), only while that is still ahead; null or absent otherwise.
       */
      freePlanEndsAt?: string | null;
      /** When a paid one-time month ends (one.time.plan.ts); null for any other plan. */
      oneTimePlanEndsAt?: string | null;
      /**
       * The same date for a workspace with a plan too: when the Free plan it
       * would fall back to ends (Billing's cancel copy). Null or absent when
       * that Free plan has no end.
       */
      freePlanSunsetAt?: string | null;
      /**
       * The server's "continue free": a Free workspace that pressed "Start
       * free" on any device, or that has a channel or a post. Absent from an
       * older backend.
       */
      continueFree?: boolean;
      /** AGENT_MEDIA_SSO_KEY is set on the backend (the UGC item works). */
      agentMedia?: boolean;
      /**
       * A Gumroad product is configured on the backend: Billing and the
       * paywall offer "Bought on Gumroad? Enter your license key".
       */
      gumroadRedeem?: boolean;
      /** ISO date the trial's first charge is due, when on a trial. */
      trialEndsAt?: string | null;
      /**
       * A trial cutoff is set on the server, so new workspaces have no Free
       * plan. The paywall's trial wording follows it for every workspace.
       */
      trialPolicyActive?: boolean;
      /**
       * How long a trial started now runs (subscribe() on the backend):
       * TRIAL_DAYS, or 7 for a workspace the Free plan sunset notice of 21 Oct
       * promised 7 to. Absent from an older backend; read it through
       * knownTrialDays (trial.policy.ts).
       */
      trialDays?: number;
      streakSince: string | null;
    })
>(undefined);
export const ContextWrapper: FC<{
  user: User & {
    orgId: string;
    tier: 'FREE' | 'STANDARD' | 'PRO' | 'ULTIMATE' | 'TEAM' | 'HOOKPOST';
    role: 'USER' | 'ADMIN' | 'SUPERADMIN';
    publicApi: string;
    totalChannels: number;
  };
  children: ReactNode;
}> = ({ user, children }) => {
  const values = user
    ? {
        ...user,
        tier: pricing[user.tier],
      }
    : ({} as any);
  return <UserContext.Provider value={values}>{children}</UserContext.Provider>;
};
export const useUser = () => useContext(UserContext);
