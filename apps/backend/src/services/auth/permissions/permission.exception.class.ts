import { HttpException, HttpStatus } from '@nestjs/common';
import type { PlanGateCode } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

export enum Sections {
  CHANNEL = 'channel',
  POSTS_PER_MONTH = 'posts_per_month',
  VIDEOS_PER_MONTH = 'videos_per_month',
  AI_GENERATIONS = 'ai_generation_count',
  TEAM_MEMBERS = 'team_members',
  COMMUNITY_FEATURES = 'community_features',
  FEATURED_BY_GITROOM = 'featured_by_gitroom',
  AI = 'ai',
  IMPORT_FROM_CHANNELS = 'import_from_channels',
  ADMIN = 'admin',
  WEBHOOKS = 'webhooks',
  /** RSS autopost: pricing.ts autoPost (Team, Pro and Ultimate). */
  AUTOPOST = 'autopost',
  /**
   * Using Hookpost at all: granted to every plan state (Free included), and
   * refused only to a workspace that has to start its trial or choose a plan
   * first (needs_trial, locked; the trial gate in PermissionsService). For
   * routes no plan limit covers that still reach a platform or a paid API
   * through a channel (analytics, mentions, profile changes, third-party
   * tools). A needs_trial workspace can hold its first channel since 25 Oct
   * 2026, and these routes must not work for it before the trial.
   */
  PLAN_ACCESS = 'plan_access',
}

export enum AuthorizationActions {
  Create = 'create',
  Read = 'read',
  Update = 'update',
  Delete = 'delete',
}

export class SubscriptionException extends HttpException {
  constructor(message: {
    section: Sections;
    action: AuthorizationActions;
    /**
     * Set when the workspace must start its trial (TRIAL_REQUIRED) or choose
     * a plan (PLAN_REQUIRED) before anything else; see trial.policy.ts.
     */
    code?: PlanGateCode;
    /**
     * The workspace's own trial length when it can still start one
     * (SubscriptionService.trialDaysFor): the 402 message names it. Absent
     * means TRIAL_DAYS.
     */
    trialDays?: number;
    /**
     * Refused because the workspace's payment is failing (trial.policy.ts
     * `dunning`): the 402 says so (PAYMENT_FAILING_MESSAGE) instead of
     * offering a plan the workspace already has.
     */
    paymentFailing?: boolean;
    /**
     * Whether the workspace is on its free posts (trial.policy.ts
     * free_posts), as the thrower read it from the workspace's own billing
     * facts (the owner's signup country, SubscriptionService.getPlanState).
     * Such a workspace has no Free plan and no trial to start (its checkout
     * charges at once), so the 402 offers neither. Absent means the thrower
     * did not look: the filter then decides it from the request alone.
     */
    freePosts?: boolean;
    /**
     * Whether a checkout opened now would start a trial, where the thrower
     * asked (SubscriptionService.trialOfferFor, the once-per-person check
     * included). Absent, the filter reads it from trial.policy.ts alone.
     */
    trialOffered?: boolean;
  }) {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
