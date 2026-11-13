import { Ability, AbilityBuilder, AbilityClass } from '@casl/ability';
import { Injectable } from '@nestjs/common';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  RequestHints,
  SubscriptionService,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  PlanGateCode,
  preTrialChannelLimit,
  trialPolicyActive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { countsTowardChannelLimit } from '@hookpost/nestjs-libraries/database/prisma/integrations/channel.limit';
import { planMonthStart } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.month';
import { WebhooksService } from '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { AuthorizationActions, Sections } from './permission.exception.class';

export type AppAbility = Ability<[AuthorizationActions, Sections]>;

@Injectable()
export class PermissionsService {
  constructor(
    private _subscriptionService: SubscriptionService,
    private _postsService: PostsService,
    private _integrationService: IntegrationService,
    private _webhooksService: WebhooksService
  ) {}
  /**
   * The workspace's trial length (SubscriptionService.trialDaysFor), for the
   * 402 message of a workspace that can still start a trial.
   */
  trialDaysFor(orgId: string): Promise<number> {
    return this._subscriptionService.trialDaysFor(orgId);
  }

  /**
   * What the 402 offers this workspace: its free posts, whether checkout
   * would start a trial and its length (SubscriptionService.trialOfferFor).
   */
  trialOfferFor(
    orgId: string,
    allowTrial: boolean | null | undefined,
    hints: { requestCountry?: string | null } = {}
  ) {
    return this._subscriptionService.trialOfferFor(orgId, allowTrial, hints);
  }

  /**
   * Whether the workspace is on its free posts (trial.policy.ts free_posts),
   * read from its own billing facts (the owner's signup country first, the
   * request's only without one). Undefined when it cannot be read, so the
   * 402 filter falls back to its own reading.
   */
  async onFreePosts(
    orgId: string,
    hints: { requestCountry?: string | null } = {}
  ): Promise<boolean | undefined> {
    try {
      const { state } = await this._subscriptionService.getPlanState(
        orgId,
        hints
      );
      return state === 'free_posts';
    } catch {
      return undefined;
    }
  }

  async getPackageOptions(orgId: string) {
    const subscription =
      await this._subscriptionService.getSubscriptionByOrganizationId(orgId);

    const tier =
      subscription?.subscriptionTier ||
      (!process.env.RAZORPAY_KEY_ID ? 'PRO' : 'FREE');

    const { channel, ...all } = pricing[tier];
    return {
      subscription,
      options: {
        ...all,
        ...{ channel: tier === 'FREE' ? channel : -10 },
      },
    };
  }

  async check(
    orgId: string,
    created_at: Date,
    permission: 'USER' | 'ADMIN' | 'SUPERADMIN',
    requestedPermission: Array<[AuthorizationActions, Sections]>,
    refreshChannelId?: string,
    hints: RequestHints = {}
  ) {
    return (
      await this.evaluate(
        orgId,
        created_at,
        permission,
        requestedPermission,
        refreshChannelId,
        hints
      )
    ).ability;
  }

  /**
   * check(), plus the trial gate that decided it: TRIAL_REQUIRED or
   * PLAN_REQUIRED when the workspace must start its trial or choose a plan
   * first (trial.policy.ts), else null. PoliciesGuard puts the code in the
   * 402 so the page can offer the trial.
   *
   * A gated workspace is refused every plan check: channels, posts, webhooks,
   * AI, team members and the rest. ADMIN is not a plan check but the member's
   * role, and it guards Billing (subscribe, invoices, cancel), the API key and
   * the team page, so it is decided exactly as before: a workspace that has
   * to start its trial must still be able to reach the page that starts it.
   *
   * While both trial cutoffs are empty the gate is never consulted and this
   * is check() as it always was.
   */
  async evaluate(
    orgId: string,
    created_at: Date,
    permission: 'USER' | 'ADMIN' | 'SUPERADMIN',
    requestedPermission: Array<[AuthorizationActions, Sections]>,
    refreshChannelId?: string,
    hints: RequestHints = {}
  ): Promise<{
    ability: AppAbility;
    gate: PlanGateCode | null;
    /** AI was refused because the workspace's payment is failing (`dunning`). */
    paymentFailing: boolean;
  }> {
    let paymentFailing = false;
    const { can, build } = new AbilityBuilder<
      Ability<[AuthorizationActions, Sections]>
    >(Ability as AbilityClass<AppAbility>);
    const done = (gate: PlanGateCode | null = null) => ({
      ability: build({
        detectSubjectType: (item) =>
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          item.constructor,
      }),
      gate,
      paymentFailing,
    });

    if (
      requestedPermission.length === 0 ||
      !process.env.RAZORPAY_KEY_ID
    ) {
      for (const [action, section] of requestedPermission) {
        can(action, section);
      }
      return done();
    }

    // planGate answers null while the cutoffs are empty, except for a
    // workspace a chargeback locked (trial.policy.ts workspaceDisputed),
    // which is refused everything but Billing whatever the cutoffs say.
    const gate = await this._subscriptionService.planGate(orgId, hints);
    if (gate) {
      // TRIAL_REQUIRED is needs_trial (planGateCode): it may connect its
      // first PRE_TRIAL_CHANNEL_LIMIT channel(s) before the trial, so a new
      // sign-up sees its own account in Hookpost before the card or UPI step.
      // Posts, AI, webhooks, team members and the rest stay refused. locked
      // (PLAN_REQUIRED) gets nothing: it has had its trial.
      const preTrialLimit =
        gate === 'TRIAL_REQUIRED' ? preTrialChannelLimit('needs_trial') : null;
      for (const [action, section] of requestedPermission) {
        if (
          section === Sections.ADMIN &&
          ['ADMIN', 'SUPERADMIN'].includes(permission)
        ) {
          can(action, section);
        }
        if (
          section === Sections.CHANNEL &&
          preTrialLimit !== null &&
          (await this.channelRoom(orgId, preTrialLimit, refreshChannelId))
        ) {
          can(action, section);
        }
      }
      return done(gate);
    }

    const { subscription, options } = await this.getPackageOptions(orgId);
    for (const [action, section] of requestedPermission) {
      // Not a plan limit: every state that got past the trial gate above.
      if (section === Sections.PLAN_ACCESS) {
        can(action, section);
        continue;
      }

      // check for the amount of channels
      if (section === Sections.CHANNEL) {
        // Refreshing an existing channel doesn't add a new one, so skip the limit check
        // but only if the channel actually belongs to this org. The reconnect
        // link carries the channel's internalId (?refresh=, launches.component.tsx).
        if (refreshChannelId) {
          const existingIntegration =
            await this._integrationService.getIntegrationByInternalId(
              orgId,
              refreshChannelId
            );
          if (existingIntegration) {
            can(action, section);
            continue;
          }
        }

        // Placeholders from an unfinished two-step connect do not count; see
        // channel.limit.ts.
        const totalChannels = (
          await this._integrationService.getIntegrationsList(orgId)
        ).filter(countsTowardChannelLimit).length;

        if (
          (options.channel && options.channel > totalChannels) ||
          (subscription?.totalChannels || 0) > totalChannels
        ) {
          can(action, section);
          continue;
        }
      }

      if (section === Sections.WEBHOOKS) {
        const totalWebhooks = await this._webhooksService.getTotal(orgId);
        if (totalWebhooks < options.webhooks) {
          can(AuthorizationActions.Create, section);
          continue;
        }
      }

      // RSS autopost is a feature of the plan (autoPost), not a share of the
      // webhook allowance: Standard has two webhooks but no autopost.
      if (section === Sections.AUTOPOST && options.autoPost) {
        can(action, section);
        continue;
      }

      // check for posts per month
      if (section === Sections.POSTS_PER_MONTH) {
        const createdAt =
          (await this._subscriptionService.getSubscription(orgId))?.createdAt ||
          created_at;
        const checkFrom = planMonthStart(createdAt);
        const count = await this._postsService.countPostsFromDay(
          orgId,
          checkFrom.toDate()
        );

        if (count < options.posts_per_month) {
          can(action, section);
          continue;
        }
      }

      if (section === Sections.TEAM_MEMBERS && options.team_members) {
        can(action, section);
        continue;
      }

      if (
        section === Sections.ADMIN &&
        ['ADMIN', 'SUPERADMIN'].includes(permission)
      ) {
        can(action, section);
        continue;
      }

      if (
        section === Sections.COMMUNITY_FEATURES &&
        options.community_features
      ) {
        can(action, section);
        continue;
      }

      if (
        section === Sections.FEATURED_BY_GITROOM &&
        options.featured_by_gitroom
      ) {
        can(action, section);
        continue;
      }

      if (section === Sections.AI && options.ai) {
        // trial.policy.ts allowsAiFeatures: a failing payment (`dunning`)
        // loses AI whatever the cutoffs say; the cohort states only while the
        // trial policy is on; a paid plan set to end keeps it to cancelAt.
        const { state, allowed } = await this._subscriptionService.aiAccess(
          orgId,
          hints,
          trialPolicyActive()
        );
        if (!allowed) {
          if (state === 'dunning') paymentFailing = true;
          continue;
        }
        can(action, section);
        continue;
      }

      if (
        section === Sections.IMPORT_FROM_CHANNELS &&
        options.import_from_channels
      ) {
        can(action, section);
      }
    }

    return done();
  }

  /**
   * Room for one more channel within `allowance`, or `refreshChannelId` is a
   * live channel of this workspace (a reconnect adds nothing; a removed one
   * would come back). `refreshChannelId` is the channel's internalId, which
   * the reconnect link carries (?refresh=, launches.component.tsx), not its
   * database id. Placeholders from an unfinished two-step connect do not
   * count (channel.limit.ts).
   */
  private async channelRoom(
    orgId: string,
    allowance: number,
    refreshChannelId?: string
  ): Promise<boolean> {
    if (refreshChannelId) {
      const existing = await this._integrationService.getIntegrationByInternalId(
        orgId,
        refreshChannelId
      );
      if (existing && !existing.deletedAt) {
        return true;
      }
    }
    const totalChannels = (
      await this._integrationService.getIntegrationsList(orgId)
    ).filter(countsTowardChannelLimit).length;
    return allowance > totalChannels;
  }
}
