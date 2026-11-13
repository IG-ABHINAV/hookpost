import { AffiliateRepository } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository';
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { PlanEndTimer } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.end.timer';
import {
  AI_CREDIT_COST,
  AI_CREDIT_POOL,
  pricing,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { Organization } from '@prisma/client';
import dayjs from 'dayjs';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { planMonthStart } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.month';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { MarketplacePublishRefusedError } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.publish.error';
import { ONE_TIME_PLAN_TIER } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';
import {
  isMarketplaceIdentifier,
  marketplacePublishRefusal,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { anyMarketplaceEnabled } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import {
  allowsAiFeatures,
  allowsVariableCostFeatures,
  allowsXPublishing,
  checkoutAllowsTrial,
  CountryHints,
  FREE_POST_LIMIT,
  freePostAllowed,
  freePostKey,
  freePostsUsed,
  freePostsLeft,
  freePlanAvailable,
  freePlanEndsAt,
  freePlanSunsetAt,
  inTrialCohort,
  internalWorkspace,
  PAYMENT_FAILING_MESSAGE,
  PlanGateCode,
  planGateCode,
  planLapsed,
  PlanState,
  planState,
  PolicyOrg,
  policyOrgFromFacts,
  trialCheckoutOn,
  trialCutoffs,
  trialDaysFor,
  baseTrialDays,
  trialPolicyActive,
  reusedChannelMessage,
  freePostsLeftElsewhereMessage,
  workspaceDisputed,
  emailIdentity,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { disposableEmail } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/disposable.email';
import {
  billingIdentityHash,
  BillingIdentityKind,
  BillingIdentitySource,
  OFFER_ONCE_SOURCES,
  TRIAL_ONCE_SOURCES,
  paymentMethodKeys,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';

/**
 * personHadBefore's answer. `by` says what tied this workspace to one that
 * had it: the owner's email (any spelling), a channel, a payment method, the
 * workspace itself, or a disposable email (which never gets it). `related`:
 * the other workspaces tied to this one that have NOT had it, for the caller
 * to look at with what only it can see (RazorpayService: their open
 * checkouts, two tabs at once).
 */
export interface PriorUse {
  had: boolean;
  by: 'workspace' | 'email' | 'channel' | 'method' | 'disposable' | null;
  related: string[];
}

/** The request-side hints trial.policy.ts may use (never the owner's country). */
export type RequestHints = Pick<CountryHints, 'requestCountry' | 'tz'>;

/** The credit types that are AI calls Hookpost pays for per use. */
const isAiCreditType = (type: string) =>
  type.startsWith('ai_') || type === 'generate_videos';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly _subscriptionRepository: SubscriptionRepository,
    private readonly _integrationService: IntegrationService,
    private readonly _organizationService: OrganizationService,
    private readonly _affiliateRepository: AffiliateRepository,
    // The exact timer at cancelAt (plan.end.timer.ts). Optional so the specs
    // that build this service by hand need no change; Nest always provides it.
    @Optional() private readonly _planEndTimer?: PlanEndTimer
  ) {}

  getSubscriptionByOrganizationId(organizationId: string) {
    return this._subscriptionRepository.getSubscriptionByOrganizationId(
      organizationId
    );
  }

  async useCredit<T>(
    organization: Organization,
    type = 'ai_images',
    func: () => Promise<T>
  ): Promise<T> {
    // The allowance is resolved here and enforced inside the repository's
    // transaction. Callers used to check the balance separately and then
    // consume it, which let two concurrent requests both pass the same last
    // credit - reachable by anyone with a public API key.
    return this._subscriptionRepository.useCredit(
      organization,
      type,
      func,
      await this.creditAllowance(organization, type)
    );
  }

  /**
   * An AI credit type (ai_text, ai_images, generate_videos) asked for by a
   * workspace whose payment is failing (trial.policy.ts `dunning`), so
   * checkCredits can say why there are none. The meter itself refuses through
   * creditAllowance, which reads the same plan facts from the database.
   */
  private async aiPausedForPayment(organizationId: string, type: string) {
    if (!isAiCreditType(type)) return false;
    return this.isPaymentFailing(organizationId);
  }

  /**
   * Is this workspace's payment failing right now (trial.policy.ts
   * planState `dunning`)? Its AI and X are off until a charge goes through.
   * Without billing, or for a workspace that cannot be read, never.
   */
  async isPaymentFailing(organizationId: string): Promise<boolean> {
    if (!process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
      return false;
    }
    // Fails open like the other plan reads: an unreadable workspace is
    // refused nothing here.
    const org = await this.getPolicyOrg(organizationId).catch(() => null);
    return !!org && planState(org) === 'dunning';
  }

  /**
   * useCredit for code that only has the organization id, like the post
   * generator's pictures and RSS auto-post. The allowance comes from the
   * workspace's live Subscription row (tier and start date), the same fields
   * the request's organization carries to useCredit, so a picture made there
   * counts against the same monthly ai_images credits as the media library's
   * "Generate image". No live plan: no credits, and `func` never runs.
   */
  async useCreditForOrganizationId<T>(
    organizationId: string,
    type: string,
    func: () => Promise<T>
  ): Promise<T> {
    const subscription =
      await this._subscriptionRepository.getSubscriptionByOrganizationId(
        organizationId
      );
    return this.useCredit(
      { id: organizationId, subscription } as unknown as Organization,
      type,
      func
    );
  }

  /**
   * Runs `publish` (the call that puts a post on the platform) within the
   * organization's plan. Paid organizations, and installs without billing,
   * publish unmetered.
   *
   * An organization without a live Subscription row is on the Free plan, and
   * each of its publishes takes one 'posts' credit: at most
   * pricing.FREE.posts_per_month per plan month, the same month the creation
   * check counts. The orchestrator used to refuse every post of such an
   * organization, which is why the Free plan never published at all. It needs
   * a meter instead of that refusal because the creation check
   * (permissions.service.ts) only runs on the web and public API create
   * endpoints: a repeating post, a republish, a re-queued failed post or a post
   * made by the MCP schedule tool reaches the orchestrator without it.
   *
   * The credit is released when `publish` throws, so a failed publish does not
   * count. Over the allowance it throws CreditsExceededError and `publish` never
   * runs.
   *
   * A workspace that must start its trial or choose a plan first
   * (trial.policy.ts: needs_trial, locked) publishes nothing: PlanRequiredError,
   * before any credit is taken. While both trial cutoffs are empty that check
   * reads nothing and never refuses.
   *
   * A workspace on its free posts (free_posts) publishes on this same meter:
   * nothing here refuses it, because its FREE_POST_LIMIT is held where posts
   * are created (assertFreePostAllowed, which also refuses Repeat Post), and
   * a free post that never went out would be the worst way to meet Hookpost.
   *
   * X (`providerIdentifier` 'x' or 'twitter') is also refused, with
   * PLAN_REQUIRED and before any credit is taken, for a workspace whose plan
   * is cancelling (allowsXPublishing).
   *
   * A workspace of a marketplace subscriber (api.market, RapidAPI, ...;
   * plan row `apimkt:...`) is held
   * to its marketplace plan first (marketplace.plans.ts
   * marketplacePublishRefusal): a blocked account, a paused product, or a
   * network its plan does not include (X on a trial) is refused with
   * MarketplacePublishRefusedError, so a post that reached the orchestrator
   * some other way than the gateway publishes nothing. That needs the plan
   * row, which is read where billing or the marketplace is on; an install
   * with neither still publishes without looking up a plan.
   */
  async publishWithinPlan<T>(
    organizationId: string,
    publish: () => Promise<T>,
    providerIdentifier?: string
  ): Promise<T> {
    const billing = !!process.env.RAZORPAY_KEY_SECRET;
    const subscription =
      billing || anyMarketplaceEnabled()
        ? await this.getSubscription(organizationId)
        : null;
    if (isMarketplaceIdentifier(subscription?.identifier)) {
      const account =
        await this._subscriptionRepository.getMarketplaceAccountFacts(
          organizationId
        );
      const refusal = account
        ? marketplacePublishRefusal(account, providerIdentifier)
        : 'This api.market subscription is not known. Nothing was published.';
      if (refusal) {
        throw new MarketplacePublishRefusedError(refusal);
      }
    }

    const isX = providerIdentifier === 'x' || providerIdentifier === 'twitter';
    if (isX && !(await this.allowsXPublishing(organizationId))) {
      throw (await this.isPaymentFailing(organizationId))
        ? new PlanRequiredError(
            'PLAN_REQUIRED',
            baseTrialDays(),
            PAYMENT_FAILING_MESSAGE
          )
        : new PlanRequiredError('PLAN_REQUIRED', baseTrialDays());
    }

    // A plan set to end is over the moment cancelAt passes, not when the
    // hourly sweep (endLapsedCancellations) gets to its row: without this a
    // post timed just after cancelAt went out, for as long as the sweep
    // happened to be away. The row itself is left alone, for the sweep to
    // close and the marketplace check above to read.
    if (!billing || (subscription && !planLapsed(subscription))) {
      return publish();
    }

    const gate = await this.planGate(organizationId);
    if (gate) {
      throw new PlanRequiredError(
        gate,
        gate === 'TRIAL_REQUIRED'
          ? await this.trialDaysFor(organizationId)
          : baseTrialDays()
      );
    }

    const organization = await this._organizationService.getOrgById(
      organizationId
    );

    return this._subscriptionRepository.useCredit(
      { id: organizationId } as Organization,
      'posts',
      publish,
      {
        max: pricing.FREE.posts_per_month,
        // Without the org there is no plan-month anchor. Falling back to now
        // would start an empty month on every publish, i.e. unlimited, so
        // count the last 30 days instead.
        from: organization?.createdAt
          ? planMonthStart(organization.createdAt)
          : dayjs().subtract(1, 'month'),
      }
    );
  }

  /**
   * The plan's monthly allowance for one credit type and the start of the
   * current billing month. Shared by checkCredits (which reports the remaining
   * balance) and useCredit (which enforces it), so the two can never disagree.
   */
  private async creditAllowance(organization: Organization, checkType: string) {
    if (isAiCreditType(checkType)) {
      // The workspace's own plan facts, not this row's (see
      // allowsVariableCostFeatures): only the ai_* and generate_videos types
      // read them, so a publish's 'posts' credit costs no extra query.
      if (!(await this.allowsVariableCostFeatures(organization.id))) {
        return { max: 0, from: dayjs() };
      }
    }

    // @ts-ignore
    const tier = organization?.subscription?.subscriptionTier || 'FREE';
    // @ts-ignore
    const subscriptionStart = organization?.subscription?.createdAt;

    if (tier === 'FREE' || !pricing[tier] || !subscriptionStart) {
      return { max: 0, from: dayjs() };
    }


    let date = dayjs(subscriptionStart);
    while (date.isBefore(dayjs())) {
      date = date.add(1, 'month');
    }

    const from = date.subtract(1, 'month');

    // A tier with an ai_credits pool (HOOKPOST): AI text and images draw on
    // one monthly balance, at AI_CREDIT_COST each (text 1, image 5).
    const pool = pricing[tier].ai_credits;
    if (pool && (AI_CREDIT_POOL as readonly string[]).includes(checkType)) {
      return {
        max: pool,
        from,
        pool: [...AI_CREDIT_POOL] as string[],
        cost: AI_CREDIT_COST[checkType] ?? 1,
      };
    }

    const max =
      checkType === 'ai_images'
        ? pricing[tier].image_generation_count
        : checkType === 'ai_text'
        ? pricing[tier].ai_generation_count
        : pricing[tier].generate_videos;

    return { max: max || 0, from };
  }

  getCode(code: string) {
    return this._subscriptionRepository.getCode(code);
  }

  async deleteSubscription(customerId: string) {
    await this.modifySubscription(
      customerId,
      pricing.FREE.channel || 0,
      'FREE'
    );
    return this._subscriptionRepository.deleteSubscriptionByCustomerId(
      customerId
    );
  }

  /**
   * Drop a subscription for one specific organization. Prefer this over
   * deleteSubscription(customerId): a payment-provider customer can be shared
   * across products on the same account, so the customer id alone does not
   * identify whose plan is being cancelled.
   */
  async deleteSubscriptionByOrg(organizationId: string) {
    // A new-cohort workspace (trial.policy.ts) has no Free plan to fit into:
    // it is paused, and a paused workspace cannot publish anyway. Its channels
    // stay as they are, because modifySubscription never re-enables a channel
    // on resubscribe, so pruning them would cost the customer their channels
    // for good. Team members are still switched off as for any plan without
    // them. Every workspace created before the cutoff is unchanged.
    const keepChannels = await this.inNewCohort(organizationId);
    await this.modifySubscriptionByOrg(
      organizationId,
      pricing.FREE.channel || 0,
      'FREE',
      { keepChannels }
    );
    return this._subscriptionRepository.deleteSubscriptionByOrganizationId(
      organizationId
    );
  }

  /**
   * Put back a plan the workspace should still have: the other half of
   * deleteSubscriptionByOrg, for the super admin's "Restore plan" when we
   * ended one by mistake.
   *
   * The write is the one the Razorpay webhook makes
   * (createOrUpdateSubscription), so the channel and team limits are applied
   * the same way and the workspace's own flags (allowTrial, isTrailing) come
   * out as they would on a real subscription. Unlike addSubscription it
   * leaves the Razorpay customer id alone: that method writes the caller's
   * user id into Organization.paymentId, which would send the customer's
   * next checkout to a customer that does not exist.
   *
   * `identifier` should be the Razorpay subscription the plan is really on,
   * where there still is one; without it the row is a manual grant with no
   * subscription behind it, which charges nobody.
   */
  async restoreSubscriptionByOrg(
    organizationId: string,
    plan: {
      tier: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
      period: 'MONTHLY' | 'YEARLY';
      identifier?: string | null;
      cancelAt?: Date | null;
    }
  ) {
    const org = await this._organizationService.getOrgById(organizationId);
    if (!org) return null;
    return this.createOrUpdateSubscription(
      false,
      plan.identifier || `restored-${makeId(10)}`,
      org.paymentId || '',
      pricing[plan.tier].channel || 0,
      plan.tier,
      plan.period,
      plan.cancelAt ? Math.floor(plan.cancelAt.getTime() / 1000) : null,
      undefined,
      organizationId
    );
  }

  /**
   * End a plan paid on Gumroad, as deleteSubscriptionByOrg ends a plan, but
   * only while the workspace's plan is still the one with `identifier`: the
   * row is deleted on that condition first, and the workspace is moved down
   * (channels, team members) only if it was. False when the plan had
   * already changed, and then nothing is touched.
   */
  async endPlanByIdentifier(organizationId: string, identifier: string) {
    const current = await this._subscriptionRepository.getSubscription(organizationId);
    if (current?.identifier !== identifier) return false;
    const keepChannels = await this.inNewCohort(organizationId);
    const { count } =
      await this._subscriptionRepository.deleteSubscriptionByOrgAndIdentifier(
        organizationId,
        identifier
      );
    if (!count) return false;
    try {
      await this.modifySubscriptionByOrg(
        organizationId,
        pricing.FREE.channel || 0,
        'FREE',
        { keepChannels, fromTier: current.subscriptionTier }
      );
    } catch (e: any) {
      // The plan row is gone, so nothing will redo this on its own: say what
      // to rerun. modifySubscriptionByOrg(org, FREE channels, 'FREE',
      // { keepChannels, fromTier }) is safe to repeat.
      Logger.error(
        `Ended the Gumroad plan ${identifier} of org ${organizationId}, but moving it down from ${current.subscriptionTier} to FREE failed (channels, team members): ${e?.message || e}. Rerun modifySubscriptionByOrg for org ${organizationId} with fromTier ${current.subscriptionTier}${keepChannels ? ' and keepChannels' : ''}.`,
        SubscriptionService.name
      );
      throw e;
    }
    return true;
  }

  /**
   * A cancelled subscription keeps its plan until the paid period ends; null
   * lifts the date. Arms, moves or stops the exact plan-end timer with it
   * (PlanEndTimer), only when this row was the one written.
   */
  async scheduleCancellation(organizationId: string, identifier: string, cancelAt: Date | null) {
    const result = await this._subscriptionRepository.scheduleCancellation(
      organizationId,
      identifier,
      cancelAt
    );
    if (result?.count) {
      await this._planEndTimer?.arm(organizationId, identifier, cancelAt);
    }
    return result;
  }

  /**
   * The hourly sweep's re-arm: a timer for every Razorpay plan set to end
   * from now on, leaving the ones already running alone. Covers a timer lost
   * when Temporal was down at the moment its date was written, and the plans
   * set to end before the timer existed.
   */
  async armPlanEndTimers(now = new Date()) {
    if (!this._planEndTimer) return 0;
    const rows = await this._subscriptionRepository.getEndingRows(
      now,
      new Date(now.getTime() + 400 * 86_400_000)
    );
    for (const row of rows) {
      await this._planEndTimer.arm(
        row.organizationId,
        row.identifier,
        row.cancelAt ? new Date(row.cancelAt) : null,
        'keep'
      );
    }
    return rows.length;
  }

  getLapsedCancellations(now: Date, organizationId?: string) {
    return this._subscriptionRepository.getLapsedCancellations(now, organizationId);
  }

  /** Every live plan that stands on a Razorpay subscription (see the repository). */
  getRazorpayPlanRows() {
    return this._subscriptionRepository.getRazorpayPlanRows();
  }

  /**
   * Remember that the provider's charges on this workspace's plan are
   * failing, so planState can take AI and X off it without asking the
   * provider (trial.policy.ts `dunning`). Only the row with this identifier,
   * and a marker already on file keeps its own date.
   */
  markPaymentFailing(organizationId: string, identifier: string, since: Date) {
    return this._subscriptionRepository.setPaymentFailing(
      organizationId,
      identifier,
      since
    );
  }

  /** A charge went through: the plan is paid, wherever it is on file. */
  clearPaymentFailing(identifier: string) {
    return this._subscriptionRepository.clearPaymentFailingByIdentifier(
      identifier
    );
  }

  /** Razorpay plans set to end between `from` and `to` (see the repository). */
  getEndingRows(from: Date, to: Date) {
    return this._subscriptionRepository.getEndingRows(from, to);
  }

  updateCustomerId(organizationId: string, customerId: string) {
    return this._subscriptionRepository.updateCustomerId(
      organizationId,
      customerId
    );
  }

  async checkSubscription(organizationId: string, subscriptionId: string) {
    return await this._subscriptionRepository.checkSubscription(
      organizationId,
      subscriptionId
    );
  }

  async modifySubscriptionByOrg(
    organizationId: string,
    totalChannels: number,
    billing: 'FREE' | 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST',
    opts: {
      keepChannels?: boolean;
      /** The plan being left, when its row is already gone (endPlanByIdentifier). */
      fromTier?: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
    } = {}
  ) {
    if (!organizationId) {
      return false;
    }

    const getCurrentSubscription = opts.fromTier
      ? null
      : (await this._subscriptionRepository.getSubscriptionByOrgId(
          organizationId
        ))!;

    const from =
      pricing[opts.fromTier || getCurrentSubscription?.subscriptionTier || 'FREE'];
    const to = pricing[billing];

    if (!opts.keepChannels) {
      const currentTotalChannels = (
        await this._integrationService.getIntegrationsList(organizationId)
      ).filter((f) => !f.disabled);

      if (currentTotalChannels.length > totalChannels) {
        await this._integrationService.disableIntegrations(
          organizationId,
          currentTotalChannels.length - totalChannels
        );
      }
    }

    if (from.team_members && !to.team_members) {
      await this._organizationService.disableOrEnableNonSuperAdminUsers(
        organizationId,
        true
      );
    }

    if (!from.team_members && to.team_members) {
      await this._organizationService.disableOrEnableNonSuperAdminUsers(
        organizationId,
        false
      );
    }

    if (billing === 'FREE') {
      await this._integrationService.changeActiveCron(organizationId);
    }

    return true;
  }

  async modifySubscription(
    customerId: string,
    totalChannels: number,
    billing: 'FREE' | 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST'
  ) {
    if (!customerId) {
      return false;
    }

    const getOrgByCustomerId =
      await this._subscriptionRepository.getOrganizationByCustomerId(
        customerId
      );

    const getCurrentSubscription =
      (await this._subscriptionRepository.getSubscriptionByCustomerId(
        customerId
      ))!;

    if (
      !getOrgByCustomerId ||
      (getCurrentSubscription && getCurrentSubscription?.isLifetime)
    ) {
      return false;
    }

    const from = pricing[getCurrentSubscription?.subscriptionTier || 'FREE'];
    const to = pricing[billing];

    const currentTotalChannels = (
      await this._integrationService.getIntegrationsList(
        getOrgByCustomerId?.id!
      )
    ).filter((f) => !f.disabled);

    if (currentTotalChannels.length > totalChannels) {
      await this._integrationService.disableIntegrations(
        getOrgByCustomerId?.id!,
        currentTotalChannels.length - totalChannels
      );
    }

    if (from.team_members && !to.team_members) {
      await this._organizationService.disableOrEnableNonSuperAdminUsers(
        getOrgByCustomerId?.id!,
        true
      );
    }

    if (!from.team_members && to.team_members) {
      await this._organizationService.disableOrEnableNonSuperAdminUsers(
        getOrgByCustomerId?.id!,
        false
      );
    }

    if (billing === 'FREE') {
      await this._integrationService.changeActiveCron(getOrgByCustomerId?.id!);
    }

    return true;
  }

  /**
   * modifySubscription for one workspace, by id: a lifetime plan is left
   * alone (false), exactly as the customer-id path does, and anything else
   * gets the new plan's channel and team limits.
   */
  private async modifySubscriptionForPlanChange(
    organizationId: string,
    totalChannels: number,
    billing: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST'
  ) {
    const current = await this._subscriptionRepository.getSubscriptionByOrgId(
      organizationId
    );
    if (current?.isLifetime) {
      return false;
    }
    return this.modifySubscriptionByOrg(organizationId, totalChannels, billing);
  }

  async createOrUpdateSubscription(
    isTrailing: boolean,
    identifier: string,
    customerId: string,
    totalChannels: number,
    billing: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST',
    period: 'MONTHLY' | 'YEARLY',
    cancelAt: number | null,
    code?: string,
    org?: string
  ) {
    if (!code) {
      try {
        // The workspace named by the caller (the subscription's notes.orgId)
        // comes first; the customer id is only the fallback. One Razorpay
        // customer is shared by every workspace with the same billing email,
        // so the customer lookup could pick the owner's other workspace:
        // pause its channels or switch its team members, or skip this one
        // entirely because the other holds a lifetime plan.
        const load = org
          ? await this.modifySubscriptionForPlanChange(
              org,
              totalChannels,
              billing
            )
          : await this.modifySubscription(customerId, totalChannels, billing);
        if (!load) {
          return {};
        }
      } catch (e) {
        return {};
      }
    }
    const result = await this._subscriptionRepository.createOrUpdateSubscription(
      isTrailing,
      identifier,
      customerId,
      totalChannels,
      billing,
      period,
      cancelAt,
      code,
      org ? { id: org } : undefined
    );
    // The plan just written decides the timer: a date arms it, none stops
    // one left from a plan this replaced.
    if (!code && this._planEndTimer) {
      const orgId =
        org ||
        (await this._subscriptionRepository.getSubscriptionByIdentifier(identifier))
          ?.organizationId;
      if (orgId) {
        await this._planEndTimer.arm(
          orgId,
          identifier,
          cancelAt ? new Date(cancelAt * 1000) : null
        );
      }
    }
    return result;
  }

  /**
   * Put the workspace on the plan a Gumroad license pays for
   * (GumroadLicenseService). The plan's channel and team limits apply first,
   * as for a Razorpay plan change (modifySubscriptionByOrg), then the row is
   * written with identifier "gumroad:<saleId>" and `cancelAt` when the
   * membership is already set to end. Nothing here reads or writes Razorpay.
   */
  async applyGumroadPlan(
    organizationId: string,
    plan: {
      tier: 'STANDARD' | 'PRO';
      period: 'MONTHLY' | 'YEARLY';
      identifier: string;
      cancelAt: Date | null;
    }
  ) {
    const totalChannels = pricing[plan.tier].channel || 0;
    await this.modifySubscriptionByOrg(organizationId, totalChannels, plan.tier);
    return this._subscriptionRepository.upsertGumroadSubscription(
      organizationId,
      { ...plan, totalChannels }
    );
  }

  /**
   * Put the workspace on one paid month of the plan (one.time.plan.ts) until
   * `cancelAt`: the plan's channel and team limits first, as applyGumroadPlan
   * does, then the row (identifier `order_...`), then the exact plan-end
   * timer for that date. A renewal calls this again with the later date.
   */
  async applyOneTimePlan(
    organizationId: string,
    plan: { identifier: string; cancelAt: Date }
  ) {
    const tier = ONE_TIME_PLAN_TIER;
    const totalChannels = pricing[tier].channel || 0;
    await this.modifySubscriptionByOrg(organizationId, totalChannels, tier);
    const result = await this._subscriptionRepository.upsertGumroadSubscription(
      organizationId,
      { tier, period: 'MONTHLY', identifier: plan.identifier, totalChannels, cancelAt: plan.cancelAt }
    );
    await this._planEndTimer?.arm(organizationId, plan.identifier, plan.cancelAt);
    return result;
  }

  /**
   * A paid one-time month has run out (or a full refund took it back): the
   * plan ends as any plan does (endPlanByIdentifier, only while it is still
   * this one) and the workspace drops back to its free-posts state.
   */
  async endOneTimePlan(organizationId: string, identifier: string) {
    const ended = await this.endPlanByIdentifier(organizationId, identifier);
    if (ended) {
      await this._subscriptionRepository.restoreFreePostsState(organizationId);
    }
    return ended;
  }

  claimOrderPayment(organizationId: string, orderId: string, paymentId: string) {
    return this._subscriptionRepository.claimOrderPayment(organizationId, orderId, paymentId);
  }

  releaseOrderPayment(organizationId: string, paymentId: string) {
    return this._subscriptionRepository.releaseOrderPayment(organizationId, paymentId);
  }

  findOrderPayment(paymentId: string) {
    return this._subscriptionRepository.findOrderPayment(paymentId);
  }

  /**
   * Give back the plan a chargeback ended, because the owner decided to
   * (we won the dispute, or it was raised by mistake). Nothing restores
   * itself: payment.dispute.won only tells the owner it was won.
   *
   * The workspace gets the time it had already paid for and nothing more,
   * so `periodEnd` must still be ahead; the caller checks that and says so
   * when it is not. The plan's channel limits apply first, as applyGumroadPlan
   * applies them. Nothing here reads or writes Razorpay: that subscription
   * was cancelled when the dispute arrived and stays cancelled.
   */
  async restoreDisputedPlan(
    organizationId: string,
    plan: {
      tier: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
      period: 'MONTHLY' | 'YEARLY';
      identifier: string;
      periodEnd: Date;
    }
  ) {
    const totalChannels = pricing[plan.tier].channel || 0;
    await this.modifySubscriptionByOrg(organizationId, totalChannels, plan.tier);
    return this._subscriptionRepository.restoreDisputedSubscription(
      organizationId,
      { ...plan, totalChannels, cancelAt: plan.periodEnd }
    );
  }

  getSubscriptionByIdentifier(identifier: string) {
    return this._subscriptionRepository.getSubscriptionByIdentifier(identifier);
  }

  async getSubscription(organizationId: string) {
    return this._subscriptionRepository.getSubscription(organizationId);
  }

  // ---------------------------------------------------------------------------
  // Trial policy (trial.policy.ts)
  // ---------------------------------------------------------------------------

  /**
   * The workspace as trial.policy.ts sees it, or null when it does not exist.
   * `hints` are the request's own country and timezone, used only when the
   * owner has no signup country on file.
   */
  /**
   * The workspace's creator, as the checkout currency needs it: their signup
   * country and email. Null when the workspace does not exist.
   */
  async getCurrencyFacts(
    organizationId: string
  ): Promise<{ ownerCountry: string | null; ownerEmail: string | null } | null> {
    const facts = await this._subscriptionRepository.getCurrencyFacts(
      organizationId
    );
    if (!facts) return null;
    const owner = facts.users?.[0]?.user;
    return {
      ownerCountry: owner?.signupCountry ?? null,
      ownerEmail: owner?.email ?? null,
    };
  }

  async getPolicyOrg(
    organizationId: string,
    hints: RequestHints = {}
  ): Promise<PolicyOrg | null> {
    const facts = await this._subscriptionRepository.getPlanFacts(
      organizationId
    );
    if (!facts) return null;
    return policyOrgFromFacts(facts, hints);
  }

  /**
   * The workspace's plan state, whether the Free plan exists for it, and when
   * a grandfathered Free plan ends (FREE_PLAN_SUNSET_AT, while still ahead):
   * freePlanEndsAt only for a workspace on the Free plan now (the notice),
   * freePlanSunsetAt also for one with a plan, whose Free fallback ends then
   * (Billing's cancel copy). For /user/self and the admin pages. Without
   * billing every workspace is `active` (the app shows every tier unlocked
   * there).
   */
  async getPlanState(
    organizationId: string,
    hints: RequestHints = {}
  ): Promise<{
    state: PlanState;
    freePlanAvailable: boolean;
    freePlanEndsAt: Date | null;
    freePlanSunsetAt: Date | null;
  }> {
    const none = { freePlanEndsAt: null, freePlanSunsetAt: null };
    if (!process.env.RAZORPAY_KEY_ID) {
      return { state: 'active', freePlanAvailable: true, ...none };
    }
    const cutoffs = trialCutoffs();
    const org = await this.getPolicyOrg(organizationId, hints);
    if (!org) {
      return { state: 'free', freePlanAvailable: true, ...none };
    }
    return {
      state: planState(org, cutoffs),
      freePlanAvailable: freePlanAvailable(org, cutoffs),
      freePlanEndsAt: freePlanEndsAt(org, cutoffs),
      freePlanSunsetAt: freePlanSunsetAt(org, cutoffs),
    };
  }

  /**
   * Whether this workspace may connect X and publish to it
   * (trial.policy.ts allowsXPublishing). Read through getPolicyOrg, which
   * carries the Subscription row: getOrgById returns the bare Organization
   * row, without it every workspace looked plan-less and X was refused for
   * all of them. Without billing, and for a workspace that cannot be found,
   * always: nothing is cancelling there.
   */
  async allowsXPublishing(organizationId: string): Promise<boolean> {
    if (!process.env.RAZORPAY_KEY_SECRET) return true;
    const org = await this.getPolicyOrg(organizationId);
    return !org || allowsXPublishing(org);
  }

  /**
   * Whether this workspace may use the features that cost Hookpost per call
   * (AI text, AI images, generated videos; trial.policy.ts
   * allowsVariableCostFeatures): a cancelled trial that never charged loses
   * them at once, a paid plan set to end keeps them until cancelAt, and a plan
   * whose cancelAt has passed has none (planLapsed). The one place the
   * credits, /copilot and the AI permission ask.
   *
   * Read through getPolicyOrg like allowsXPublishing, never from the
   * request's Organization row: that row's `subscription` is selected without
   * cancelAt (organization.repository.ts), so creditAllowance read every
   * `cancelling` plan as `active` and the AI allowance was never cut off.
   * Without billing, and for a workspace that cannot be read, always: nothing
   * is cancelling there.
   */
  /**
   * The AI permission's answer (trial.policy.ts allowsAiFeatures) and the
   * plan state it was read from, so the caller can say why (dunning). Read
   * like getPlanState: without billing every workspace is `active`.
   */
  async aiAccess(
    organizationId: string,
    hints: RequestHints,
    cohortRulesOn: boolean
  ): Promise<{ state: PlanState; allowed: boolean }> {
    if (!process.env.RAZORPAY_KEY_ID) return { state: 'active', allowed: true };
    const org = await this.getPolicyOrg(organizationId, hints);
    const state: PlanState = org ? planState(org, trialCutoffs()) : 'free';
    return { state, allowed: allowsAiFeatures(state, cohortRulesOn, org) };
  }

  async allowsVariableCostFeatures(
    organizationId: string,
    hints: RequestHints = {}
  ): Promise<boolean> {
    if (!process.env.RAZORPAY_KEY_SECRET) return true;
    const org = await this.getPolicyOrg(organizationId, hints).catch(() => null);
    return !org || allowsVariableCostFeatures(planState(org), org);
  }

  /**
   * TRIAL_REQUIRED (start the trial) or PLAN_REQUIRED (choose a plan) for a
   * workspace that may not use Hookpost yet, else null. A plan whose payment
   * is failing is not gated here: it keeps publishing and only loses AI and X
   * (trial.policy.ts `dunning`).
   *
   * Reads nothing while billing is off, so the branch ships dark. Fails
   * open: a workspace that cannot be read is never gated by this.
   *
   * A workspace whose payment was charged back (workspaceDisputed) is
   * PLAN_REQUIRED whatever the cutoffs say: the chargeback ended its plan,
   * and emptying TRIAL_REQUIRED_SINCE_* must not hand it the product back.
   * Every other state needs the trial policy to be on.
   */
  async planGate(
    organizationId: string,
    hints: RequestHints = {}
  ): Promise<PlanGateCode | null> {
    if (!process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
      return null;
    }
    const cutoffs = trialCutoffs();
    const org = await this.getPolicyOrg(organizationId, hints).catch(
      () => null
    );
    if (!org) return null;
    if (workspaceDisputed(org)) return 'PLAN_REQUIRED';
    if (!trialPolicyActive(cutoffs)) return null;
    return planGateCode(planState(org, cutoffs));
  }

  /**
   * A free_posts workspace's FREE_POST_LIMIT allowance (trial.policy.ts): the
   * posts it has used, as freePostKey tells one post from another. Null for
   * every other state, and without billing or a trial cutoff, where no post
   * is read. Fails open like planGate: a workspace that cannot be read has
   * no allowance to enforce. `internal`: one of our own workspaces
   * (internalWorkspace), which a channel used elsewhere does not stop.
   */
  async freePostsUsage(
    organizationId: string,
    hints: RequestHints = {}
  ): Promise<{
    keys: Set<string>;
    used: number;
    limit: number;
    left: number;
    internal: boolean;
  } | null> {
    if (!process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
      return null;
    }
    const cutoffs = trialCutoffs();
    if (!trialPolicyActive(cutoffs)) return null;
    const org = await this.getPolicyOrg(organizationId, hints).catch(
      () => null
    );
    if (!org || planState(org, cutoffs) !== 'free_posts') return null;
    const rows = await this._subscriptionRepository.freePostRows(
      organizationId
    );
    const keys = new Set(rows.map((r) => freePostKey(r.publishDate)));
    const used = freePostsUsed(rows);
    return {
      keys,
      used,
      limit: FREE_POST_LIMIT,
      left: freePostsLeft(used),
      internal: internalWorkspace(org, cutoffs),
    };
  }

  /**
   * ONCE PER PERSON (razorpay.mapping.ts; owner, 29 Oct 2026): whether the
   * people behind `organizationId` have already had one of `sources` (a paid
   * plan or the first-month offer by default; the trial adds TRIAL) here or
   * in any other workspace, deleted ones included. Tied to another workspace
   * by:
   * - an owner's email, however it is spelled (trial.policy.ts
   *   emailIdentity): a live owner of the other workspace, a deleted account's
   *   address, or an owner on file when that workspace paid;
   * - a channel (provider + account id) this workspace has or had, connected
   *   there now or before, including after it paid;
   * - a UPI VPA or card this workspace has paid with, or tried to, that paid
   *   there.
   * `userId`, the member at checkout, counts as an owner here: an admin who
   * paid before does not get it by buying from a workspace someone else owns.
   * An owner on a disposable email never gets it. Our own workspaces
   * (internalWorkspace) are never refused, and marketplace and lifetime ones
   * never count (workspacesThatHad).
   */
  async personHadBefore(
    organizationId: string,
    sources: readonly BillingIdentitySource[] = OFFER_ONCE_SOURCES,
    opts: { userId?: string | null } = {}
  ): Promise<PriorUse> {
    const none: PriorUse = { had: false, by: null, related: [] };
    const cutoffs = trialCutoffs();
    const org = await this.getPolicyOrg(organizationId);
    if (!org || internalWorkspace(org, cutoffs)) return none;
    const exempt = cutoffs.sunsetExempt || new Set<string>();

    const emails = await this._subscriptionRepository.ownerEmails(
      organizationId,
      opts.userId
    );
    if (emails.some((e) => disposableEmail(e))) {
      return { had: true, by: 'disposable', related: [] };
    }
    const identities = [
      ...new Set(emails.map((e) => emailIdentity(e)).filter(Boolean) as string[]),
    ];
    const keys = [
      ...identities.map((i) => ({ kind: 'EMAIL', hash: billingIdentityHash('EMAIL', i) })),
      ...(await this._subscriptionRepository.ownPaymentMethodHashes(organizationId)),
    ];

    const [recorded, byChannel, ...byEmail] = await Promise.all([
      this._subscriptionRepository.workspacesWithBillingIdentity(
        organizationId,
        keys,
        sources
      ),
      this._subscriptionRepository.workspacesSharingAnyChannel(organizationId),
      ...identities.map((identity) => this.workspacesOwnedByIdentity(organizationId, identity, emails)),
    ]);

    // Which tie found each workspace, the first one listed winning.
    const tie = new Map<string, PriorUse['by']>([[organizationId, 'workspace']]);
    const tieTo = (id: string, by: PriorUse['by']) => {
      if (!tie.has(id)) tie.set(id, by);
    };
    byEmail.flat().forEach((id) => tieTo(id, 'email'));
    recorded.forEach((r) => tieTo(r.organizationId, r.kind === 'EMAIL' ? 'email' : 'method'));
    byChannel.forEach((id) => tieTo(id, 'channel'));

    const had = await this._subscriptionRepository.workspacesThatHad(
      [...tie.keys()],
      sources,
      exempt
    );
    if (had.length) {
      const first = had.includes(organizationId) ? organizationId : had[0];
      return { had: true, by: tie.get(first) || null, related: [] };
    }
    return {
      had: false,
      by: null,
      related: [...tie.keys()].filter((id) => id !== organizationId && !exempt.has(id)),
    };
  }

  /**
   * The other workspaces owned by someone whose address is `identity`
   * spelled any way, or by a deleted account whose address was one of
   * `emails` or `identity` itself.
   */
  private async workspacesOwnedByIdentity(
    organizationId: string,
    identity: string,
    emails: string[]
  ): Promise<string[]> {
    const [local, domain] = identity.split('@');
    const gmail = domain === 'gmail.com';
    const rows = await this._subscriptionRepository.workspacesOwnedByEmail(
      organizationId,
      gmail ? local.slice(0, 1) : local,
      gmail ? ['gmail.com', 'googlemail.com'] : [domain],
      [...new Set([...emails.map((e) => e.trim().toLowerCase()), identity])]
    );
    // A deleted account's email has no @: it was matched by its hash.
    return rows
      .filter((r) => !r.email.includes('@') || emailIdentity(r.email) === identity)
      .map((r) => r.organizationId);
  }

  /**
   * Remember what `organizationId` had (BillingIdentity): the workspace, its
   * owners' email identities and the payment method of `payment`, as
   * `source`. ATTEMPT keeps only the method: it claims nothing, it only
   * makes the method this workspace's own. Never throws: a failure is logged
   * and the payment it came from goes on as before.
   */
  async recordBillingIdentities(
    organizationId: string,
    source: BillingIdentitySource,
    ref: { payment?: any; subscriptionId?: string | null } = {}
  ): Promise<void> {
    try {
      const values: Array<{ kind: BillingIdentityKind; value: string }> = [];
      if (source !== 'ATTEMPT') {
        values.push({ kind: 'WORKSPACE', value: organizationId });
        const emails = await this._subscriptionRepository.ownerEmails(organizationId);
        for (const identity of new Set(emails.map((e) => emailIdentity(e)))) {
          if (identity) values.push({ kind: 'EMAIL', value: identity });
        }
      }
      values.push(...paymentMethodKeys(ref.payment));
      await this._subscriptionRepository.saveBillingIdentities(
        values.map((v) => ({
          organizationId,
          kind: v.kind,
          hash: billingIdentityHash(v.kind, v.value),
          source,
          subscriptionId: ref.subscriptionId || null,
          paymentId: ref.payment?.id ? String(ref.payment.id) : null,
        }))
      );
    } catch (err) {
      Logger.warn(
        `Billing identities (${source}) not recorded for ${organizationId}: ${
          (err as Error)?.message || err
        }`,
        'SubscriptionService'
      );
    }
  }

  /**
   * The other workspaces that paid or had the offer (`sources`) with the
   * payment method of `payment`: for a charge that has just been made, which
   * nothing changes, only reports.
   */
  async workspacesPaidWithMethod(
    organizationId: string,
    payment: any,
    sources: readonly BillingIdentitySource[] = OFFER_ONCE_SOURCES
  ): Promise<string[]> {
    const keys = paymentMethodKeys(payment).map((k) => ({
      kind: k.kind,
      hash: billingIdentityHash(k.kind, k.value),
    }));
    const rows = await this._subscriptionRepository.workspacesWithBillingIdentity(
      organizationId,
      keys,
      sources
    );
    return [...new Set(rows.map((r) => r.organizationId))];
  }

  /**
   * Refuses a save that a free_posts workspace may not make
   * (PostsService.createPost): a new post past FREE_POST_LIMIT is
   * PlanRequiredError FREE_POSTS_USED (402, the plan dialog), and Repeat Post
   * is a 400, because it would publish one free post again and again. A post
   * is new when the save carries no post the workspace has (PostsService).
   * A save that puts a post on a channel that already gave its free posts
   * in another workspace (`channelsGainingPosts`: the channels the save puts
   * a post on that it is not on yet, PostsService; trial.policy.ts
   * "free posts are given once") is FREE_POSTS_USED too, saying so, whatever
   * is left here; a lookup that fails lets it through, as freePostsUsage
   * does. Every other state passes without a post being read.
   */
  async assertFreePostAllowed(
    organizationId: string,
    save: {
      newPost: boolean;
      repeats: boolean;
      channelsGainingPosts?: () => Promise<string[]>;
    }
  ): Promise<void> {
    const usage = await this.freePostsUsage(organizationId);
    if (!usage) return;
    if (save.repeats) {
      throw new BadRequestException(
        `Repeat Post needs a plan: each of your ${FREE_POST_LIMIT} free posts publishes once. Turn off Repeat Post, or pick a plan.`
      );
    }
    if (!freePostAllowed(usage.used, save.newPost)) {
      throw new PlanRequiredError('FREE_POSTS_USED');
    }
    if (usage.internal || !save.channelsGainingPosts) return;
    const integrationIds = [...new Set(await save.channelsGainingPosts())];
    if (!integrationIds.length) return;
    const spent = await this._subscriptionRepository
      .workspacesWithSpentFreePosts(organizationId, integrationIds)
      .catch((err) => {
        Logger.warn(
          `Free post saved without the channel check for ${organizationId}: ${
            (err as Error)?.message || err
          }`,
          'SubscriptionService'
        );
        return [] as Array<{ provider: string; organizationId: string }>;
      });
    if (spent.length) {
      const provider = this._integrationService.providerName(spent[0].provider);
      const error = new PlanRequiredError(
        'FREE_POSTS_USED',
        baseTrialDays(),
        reusedChannelMessage(provider)
      );
      error.spentIn = {
        provider,
        organizationIds: [
          ...new Set(
            spent
              .filter((s) => s.provider === spent[0].provider)
              .map((s) => s.organizationId)
          ),
        ],
      };
      throw error;
    }
  }

  /**
   * The composer's FREE_POSTS_USED for a reused account, made specific for
   * the signed-in user (owner, 29 Oct 2026, item 11): when they are a member
   * of a workspace where the account used its free posts and that workspace
   * still has some left, the error names it and carries `switchTo` for the
   * [Switch to <name>] button. Otherwise the error as it was, which names no
   * workspace. Never names a workspace the user is not in.
   */
  async forUser(error: unknown, userId: string | undefined): Promise<unknown> {
    if (!(error instanceof PlanRequiredError) || !error.spentIn || !userId) {
      return error;
    }
    for (const orgId of error.spentIn.organizationIds) {
      const name = await this._subscriptionRepository
        .memberWorkspaceName(userId, orgId)
        .catch(() => null);
      if (!name) continue;
      const usage = await this.freePostsUsage(orgId).catch(() => null);
      if (!usage || usage.left <= 0) continue;
      return new PlanRequiredError(
        'FREE_POSTS_USED',
        baseTrialDays(),
        freePostsLeftElsewhereMessage(error.spentIn.provider, name, usage.left),
        { switchTo: { id: orgId, name, left: usage.left } }
      );
    }
    return error;
  }

  /**
   * Whether a checkout opened now for this workspace starts with a trial
   * (trial.policy.ts checkoutAllowsTrial): for a free_posts workspace only
   * while the trial switch is on and nobody behind it has had a trial
   * (trialUsedByPerson); with the switch off its first payment is taken at
   * once so the first-month offer applies. Otherwise Organization.allowTrial,
   * as before. Without billing or a cutoff, or when the workspace cannot be
   * read, allowTrial alone. `opts.state` is the plan state where the caller
   * has already read it (/user/self), so it is not read twice; `opts.userId`
   * the member at checkout, who counts as an owner (personHadBefore).
   */
  async checkoutAllowsTrial(
    organizationId: string,
    allowTrial: boolean | null | undefined,
    hints: RequestHints = {},
    opts: { state?: PlanState; userId?: string | null } = {}
  ): Promise<boolean> {
    let state = opts.state;
    const cutoffs = trialCutoffs();
    if (!allowTrial || !trialPolicyActive(cutoffs)) return !!allowTrial;
    let org: PolicyOrg | null = null;
    if (!state) {
      org = await this.getPolicyOrg(organizationId, hints).catch(() => null);
      if (!org) return true;
      state = planState(org, cutoffs);
    }
    if (!checkoutAllowsTrial(state, allowTrial)) return false;
    if (state !== 'free_posts') return true;
    return !(await this.trialUsedByPerson(organizationId, opts.userId));
  }

  /**
   * What a 402 offers this workspace, decided where checkout decides it: is
   * it on its free posts, would a checkout opened now start a trial
   * (checkoutAllowsTrial, the once-per-person check included), and that
   * trial's length. Empty without allowTrial; a part that cannot be read is
   * left out, and the 402 filter falls back to its own reading.
   */
  async trialOfferFor(
    organizationId: string,
    allowTrial: boolean | null | undefined,
    hints: RequestHints = {}
  ): Promise<{ freePosts?: boolean; trialOffered?: boolean; trialDays?: number }> {
    if (!allowTrial) return {};
    let state: PlanState;
    try {
      state = (await this.getPlanState(organizationId, hints)).state;
    } catch {
      return {};
    }
    const trialOffered = await this.checkoutAllowsTrial(organizationId, allowTrial, hints, { state });
    const trialDays = trialOffered
      ? await this.trialDaysFor(organizationId).catch(() => undefined)
      : undefined;
    return { freePosts: state === 'free_posts', trialOffered, trialDays };
  }

  /**
   * Whether a new trial mandate just approved for this workspace
   * (startsNewTrial, no coupon) must not become its plan. Only with the
   * trial switch on, so production is untouched, and only while it has no
   * live plan:
   *  - its trial is already used (allowTrial false): a checkout never opens
   *    a trial then, so this is a mandate refused by a delivery running
   *    beside this one (the webhook and the checkout callback arrive
   *    together), or a stale one;
   *  - it is on its free posts and someone behind it has had a trial
   *    meanwhile (trialUsedByPerson), which a second checkout opened side by
   *    side with the first passes at checkout. Its trial is used up then
   *    (allowTrial false, so `locked`: the free posts it had left go too).
   * The approving payment, when Razorpay sends one, is put on file first
   * (ATTEMPT), so a card or UPI ID that had a trial elsewhere is caught too.
   * A lookup that fails is not a refusal, as at checkout.
   */
  async refuseTrialAtApproval(
    organizationId: string,
    approval: { payment?: any; subscriptionId?: string | null } = {}
  ): Promise<boolean> {
    const cutoffs = trialCutoffs();
    if (!trialCheckoutOn() || !trialPolicyActive(cutoffs)) return false;
    const org = await this.getPolicyOrg(organizationId).catch(() => null);
    if (!org) return false;
    const live = org.subscription && !org.subscription.deletedAt && !planLapsed(org.subscription, cutoffs.now);
    if (live) return false;
    if (!org.allowTrial) return true;
    if (planState(org, cutoffs) !== 'free_posts') return false;
    if (approval.payment) {
      await this.recordBillingIdentities(organizationId, 'ATTEMPT', approval);
    }
    if (!(await this.trialUsedByPerson(organizationId))) return false;
    // The webhook and the checkout callback for this very mandate arrive
    // together: one may have made it the plan while this one looked, and
    // its own row then reads as a trial had. Never refuse it.
    const now = await this.getPolicyOrg(organizationId).catch(() => null);
    if (
      !now ||
      (now.subscription && !now.subscription.deletedAt) ||
      (approval.subscriptionId && now.subscription?.identifier === approval.subscriptionId)
    ) {
      return false;
    }
    await this._subscriptionRepository.useUpTrial(organizationId);
    return true;
  }

  /**
   * A trial is given once per person (trial.policy.ts "TRIALS BEHIND A
   * SWITCH"): personHadBefore with TRIAL_ONCE_SOURCES, so an owner's email
   * however spelled, a channel, or a card or UPI ID tied to a workspace that
   * has had a trial, a paid plan or the first-month offer. allowTrial
   * already covers the workspace itself, and sign-up the identities known
   * then; this catches two fresh workspaces whose trial is started in one,
   * then the other. A lookup that fails gives the trial, as a failed
   * free-posts check gives the posts, and says so in the log.
   */
  async trialUsedByPerson(organizationId: string, userId?: string | null): Promise<boolean> {
    try {
      return (await this.personHadBefore(organizationId, TRIAL_ONCE_SOURCES, { userId })).had;
    } catch (err) {
      Logger.warn(
        `Trial offered to ${organizationId} without the once-per-person check: ${
          (err as Error)?.message || err
        }`,
        'SubscriptionService'
      );
      return false;
    }
  }

  /**
   * In the new cohort: created on or after its group's cutoff, or
   * grandfathered with FREE_PLAN_SUNSET_AT passed, so there is no Free plan
   * for it. `at` asks about another moment than now (when a plan ends), so a
   * plan that runs past the sunset is paused rather than moved to Free. False
   * while both cutoffs are empty, without reading anything; false when the
   * workspace cannot be read.
   */
  async inNewCohort(organizationId: string, at?: Date): Promise<boolean> {
    const cutoffs = trialCutoffs();
    if (!trialPolicyActive(cutoffs)) return false;
    const org = await this.getPolicyOrg(organizationId).catch(() => null);
    return !!org && inTrialCohort(org, at ? { ...cutoffs, now: at } : cutoffs);
  }

  /**
   * FREE_PLAN_SUNSET_AT as it applies to this workspace, whatever plan it is
   * on now (trial.policy.ts freePlanSunsetAt): when the Free plan it falls
   * back to ends. Null without a sunset, after it, for an exempt workspace,
   * or when the workspace cannot be read.
   */
  async getFreePlanSunsetAt(organizationId: string): Promise<Date | null> {
    const cutoffs = trialCutoffs();
    if (!cutoffs.sunset || !trialPolicyActive(cutoffs)) return null;
    const org = await this.getPolicyOrg(organizationId).catch(() => null);
    return org ? freePlanSunsetAt(org, cutoffs) : null;
  }

  /**
   * How long this workspace's trial runs if it starts one now: `base`
   * (baseTrialDays: TRIAL_DAYS, or RAZORPAY_TRIAL_DAYS), or 7 days for a
   * workspace the Free plan sunset notice promised them to
   * (trial.policy.ts SUNSET_NOTICE_TRIAL_DAYS). subscribe() sets start_at
   * from it and /user/self sends it, so the paywall's date and wording match
   * what checkout does. A lookup that fails gives `base`, as before.
   */
  async trialDaysFor(
    organizationId: string,
    base: number = baseTrialDays()
  ): Promise<number> {
    if (!(base > 0)) return base;
    let promised = false;
    try {
      promised = await this._subscriptionRepository.sunsetNoticePromisedTrial(
        organizationId
      );
    } catch {
      promised = false;
    }
    return trialDaysFor({ sunsetNoticePromised: promised }, base);
  }

  /** Workspaces on a Razorpay trial that is not set to end. */
  getTrialingRows() {
    return this._subscriptionRepository.getTrialingRows();
  }

  // Website coupons. Returns a reason a buyer can read instead of throwing, so
  // the checkout can show it next to the code field.
  async validateCoupon(rawCode: string, organizationId: string) {
    const code = (rawCode || '').trim().toUpperCase();
    const coupon = code
      ? await this._subscriptionRepository.findCouponByCode(code)
      : null;
    if (!coupon || !coupon.active) {
      return { ok: false as const, reason: 'This coupon code is not valid.' };
    }
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return { ok: false as const, reason: 'This coupon has expired.' };
    }
    if (
      coupon.maxRedemptions != null &&
      (await this._subscriptionRepository.countCouponRedemptions(coupon.id)) >=
        coupon.maxRedemptions
    ) {
      return { ok: false as const, reason: 'This coupon has been fully used.' };
    }
    // An affiliate's code is a coupon for their audience, not for themselves.
    if (coupon.note?.startsWith('affiliate:')) {
      const affiliate = await this._affiliateRepository.findById(
        coupon.note.slice('affiliate:'.length)
      );
      if (!affiliate?.active) {
        return { ok: false as const, reason: 'This coupon code is not valid.' };
      }
      if (affiliate.organizationId === organizationId) {
        return {
          ok: false as const,
          reason: 'Your own affiliate code is for the people you refer.',
        };
      }
    }
    if (
      await this._subscriptionRepository.hasRedeemedCoupon(
        coupon.id,
        organizationId
      )
    ) {
      return {
        ok: false as const,
        reason: 'This coupon was already used on your workspace.',
      };
    }
    return { ok: true as const, coupon };
  }

  async redeemCouponByCode(
    rawCode: string,
    organizationId: string,
    subscriptionId: string
  ) {
    const coupon = await this._subscriptionRepository.findCouponByCode(
      (rawCode || '').trim().toUpperCase()
    );
    if (!coupon) return;
    return this._subscriptionRepository.redeemCoupon(
      coupon.id,
      organizationId,
      subscriptionId
    );
  }


  createCoupon(data: Parameters<SubscriptionRepository['createCoupon']>[0]) {
    return this._subscriptionRepository.createCoupon(data);
  }

  listCoupons() {
    return this._subscriptionRepository.listCoupons();
  }

  setCouponActive(id: string, active: boolean) {
    return this._subscriptionRepository.setCouponActive(id, active);
  }

  /**
   * Whether this workspace's plan has no X link posts at all (pricing.ts
   * x_link_posts_per_month 0), so a post with a link is refused when it is
   * written, not only when it would publish. Same exemptions as the X caps
   * (x.post.cap.ts capsFor): no billing, our own and marketplace workspaces.
   */
  async xLinksBlocked(organizationId: string): Promise<boolean> {
    if (!process.env.RAZORPAY_KEY_SECRET) return false;
    const org = await this.getPolicyOrg(organizationId).catch(() => null);
    if (!org || internalWorkspace(org)) return false;
    const subscription = await this.getSubscription(organizationId).catch(
      () => null
    );
    if (isMarketplaceIdentifier(subscription?.identifier)) return false;
    const tier =
      subscription?.subscriptionTier && pricing[subscription.subscriptionTier]
        ? subscription.subscriptionTier
        : 'FREE';
    return pricing[tier].x_link_posts_per_month <= 0;
  }

  /**
   * This plan month's metered allowances, for the plan screen: the shared AI
   * credit pool (null for a tier without one) and the X posts (null when X is
   * not capped for this workspace: no billing, our own or a marketplace
   * workspace). Counts only; nothing is reserved.
   */
  async planUsage(organization: Organization): Promise<{
    aiCredits: { left: number; total: number; imageCost: number } | null;
    xPosts: { left: number; total: number; linksAllowed: boolean } | null;
  }> {
    const ai = await this.checkCredits(organization, 'ai_text');
    let xPosts: { left: number; total: number; linksAllowed: boolean } | null =
      null;
    if (process.env.RAZORPAY_KEY_SECRET) {
      const org = await this.getPolicyOrg(organization.id).catch(() => null);
      const subscription = await this.getSubscription(organization.id).catch(
        () => null
      );
      if (
        org &&
        !internalWorkspace(org) &&
        !isMarketplaceIdentifier(subscription?.identifier)
      ) {
        const tier =
          subscription?.subscriptionTier && pricing[subscription.subscriptionTier]
            ? subscription.subscriptionTier
            : 'FREE';
        const from = dayjs(
          planMonthStart(subscription?.createdAt || org.createdAt)
        );
        const used = await this._subscriptionRepository.getCreditsFrom(
          organization.id,
          from,
          'x_posts'
        );
        const total = pricing[tier].x_posts_per_month;
        xPosts = {
          left: Math.max(0, total - used),
          total,
          linksAllowed: pricing[tier].x_link_posts_per_month > 0,
        };
      }
    }
    return {
      aiCredits: ai.aiCredits
        ? {
            left: ai.aiCredits.left,
            total: ai.aiCredits.total,
            imageCost: AI_CREDIT_COST.ai_images,
          }
        : null,
      xPosts,
    };
  }

  async checkCredits(
    organization: Organization,
    checkType = 'ai_images'
  ): Promise<{
    credits: number;
    paymentFailing?: boolean;
    /** Tiers with a shared AI pool: credits left in it, and its size. */
    aiCredits?: { left: number; total: number; cost: number };
  }> {
    if (await this.aiPausedForPayment(organization.id, checkType)) {
      return { credits: 0, paymentFailing: true };
    }
    const allowance = await this.creditAllowance(organization, checkType);
    const { max, from } = allowance;

    if (max <= 0) {
      return { credits: 0 };
    }

    const totalUse = await this._subscriptionRepository.getCreditsFrom(
      organization.id,
      from,
      allowance.pool ?? checkType
    );

    if (allowance.pool) {
      // `credits` stays "how many of this kind can still be made", which is
      // what every caller compares with 0; the pool itself rides along.
      const left = Math.max(0, max - totalUse);
      const cost = allowance.cost || 1;
      return {
        credits: Math.floor(left / cost),
        aiCredits: { left, total: max, cost },
      };
    }

    return {
      credits: max - totalUse,
    };
  }

  async addSubscription(orgId: string, userId: string, subscription: any) {
    await this._subscriptionRepository.setCustomerId(orgId, userId);
    return this.createOrUpdateSubscription(
      false,
      makeId(5),
      userId,
      pricing[subscription].channel!,
      subscription,
      'MONTHLY',
      null,
      undefined,
      orgId
    );
  }
}
