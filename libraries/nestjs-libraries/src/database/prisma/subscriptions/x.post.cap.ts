import { Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import dayjs from 'dayjs';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';
import { planMonthStart } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.month';
import { internalWorkspace } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { isMarketplaceIdentifier } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { hasLink } from '@hookpost/nestjs-libraries/marketplace/marketplace.credits';
import { stripHtmlValidation } from '@hookpost/helpers/utils/strip.html.validation';

/**
 * The X post caps of a plan (pricing.ts x_posts_per_month and
 * x_link_posts_per_month; the cost table is there). X bills Hookpost per post
 * it creates, $0.20 for one with a link, and nothing else in the plan limited
 * how many a workspace sent (P1-3 of the 1 Nov 2026 review).
 *
 * Counted at publish time, as Credits rows of type `x_posts` and
 * `x_link_posts` on the plan month (planMonthStart of the subscription, or of
 * the workspace without one), through the same locked reservation as every
 * other meter (SubscriptionRepository.useCredit): a publish that fails gives
 * its credits back, and two publishes at once cannot both take the last one.
 *
 * Not capped: our own workspaces (internalWorkspace: a platform super admin
 * member, FREE_PLAN_SUNSET_EXEMPT_ORGS), marketplace workspaces (an `apimkt:`
 * plan, which pays per X post through its own credits, marketplace.plans.ts),
 * and an install without billing.
 */
export const X_CREDIT = 'x_posts';
export const X_LINK_CREDIT = 'x_link_posts';

export const isXProvider = (providerIdentifier?: string | null) =>
  providerIdentifier === 'x' || providerIdentifier === 'twitter';

/**
 * The text X receives for a post the composer saved as HTML, flattened the
 * way XProvider.toTweetText does it, so a link counts only when it is in the
 * tweet (an editor's mention markup is not a link).
 */
export function xTweetText(message: string): string {
  return stripHtmlValidation(
    'normal',
    message,
    true,
    false,
    !/<\/?[a-z][\s\S]*>/i.test(message)
  );
}

/** Whether X bills this post as one with a link. */
function isLinkPost(message: string) {
  // Links are removed before publishing where STRIP_LINKS_FROM_X_POSTS is set
  // (x.provider.ts), so the post is billed as a plain one.
  return !process.env.STRIP_LINKS_FROM_X_POSTS && hasLink(xTweetText(message));
}

/**
 * A plan with no X link posts (x_link_posts_per_month 0, the HOOKPOST tier):
 * the composer (/posts/valid) and the publish both say this. Other platforms
 * keep their links.
 */
export const X_LINKS_NOT_INCLUDED =
  "Links on X aren't included in your plan — remove the link";

/** Whether X would bill this post (HTML or text) as one with a link. */
export function xPostHasLink(message: string): boolean {
  return isLinkPost(message);
}

/** The sentence the post's error and the notification show. */
export function xCapMessage(
  kind: 'posts' | 'links',
  limit: number,
  tierName: string
): string {
  if (kind === 'links' && limit <= 0) {
    return X_LINKS_NOT_INCLUDED;
  }
  return kind === 'links'
    ? `Your ${tierName} plan includes ${limit} X post${limit === 1 ? '' : 's'} with a link a month, and this month's are used. X charges much more for a post with a link: remove the link to publish it now, or schedule it after your plan month renews`
    : `Your ${tierName} plan includes ${limit} X post${limit === 1 ? '' : 's'} a month (each reply in a thread counts as one), and this month's are used. Schedule it after your plan month renews, or upgrade your plan for more`;
}

export class XPostCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XPostCapError';
  }
}

const TIER_NAMES: Record<string, string> = {
  FREE: 'Free',
  STANDARD: 'Standard',
  TEAM: 'Team',
  PRO: 'Pro',
  ULTIMATE: 'Ultimate',
  HOOKPOST: 'Hookpost',
};

@Injectable()
export class XPostCapService {
  constructor(
    private readonly _subscriptionService: SubscriptionService,
    private readonly _subscriptionRepository: SubscriptionRepository
  ) {}

  /**
   * The caps that apply to this workspace's X posts, or null when they are
   * not capped (another provider, no billing, our own or a marketplace
   * workspace).
   */
  private async capsFor(organizationId: string, providerIdentifier?: string) {
    if (!isXProvider(providerIdentifier) || !process.env.RAZORPAY_KEY_SECRET) {
      return null;
    }
    const org = await this._subscriptionService.getPolicyOrg(organizationId);
    if (!org || internalWorkspace(org)) {
      return null;
    }
    const subscription = await this._subscriptionService.getSubscription(
      organizationId
    );
    if (isMarketplaceIdentifier(subscription?.identifier)) {
      return null;
    }
    const tier =
      subscription?.subscriptionTier && pricing[subscription.subscriptionTier]
        ? subscription.subscriptionTier
        : 'FREE';
    return {
      plan: pricing[tier],
      from: dayjs(planMonthStart(subscription?.createdAt || org.createdAt)),
      tierName: TIER_NAMES[tier] || tier,
    };
  }

  /**
   * Runs `publish` for one X post (`message`: the post as the provider gets
   * it, HTML or text) within the workspace's monthly X caps, or throws
   * XPostCapError and publishes nothing. Any other provider publishes
   * untouched.
   */
  async publishWithinXCap<T>(
    organizationId: string,
    providerIdentifier: string | undefined,
    message: string,
    publish: () => Promise<T>
  ): Promise<T> {
    const caps = await this.capsFor(organizationId, providerIdentifier);
    if (!caps) {
      return publish();
    }
    const { plan, from, tierName } = caps;
    const link = isLinkPost(message);

    const workspace = { id: organizationId } as Organization;
    const metered = async <R>(
      type: string,
      max: number,
      kind: 'posts' | 'links',
      run: () => Promise<R>
    ): Promise<R> => {
      let reserved = false;
      try {
        return await this._subscriptionRepository.useCredit(
          workspace,
          type,
          () => {
            reserved = true;
            return run();
          },
          { max, from }
        );
      } catch (err) {
        // Only this meter's own refusal (before `run`) is the cap; whatever
        // `run` threw (the inner meter, the publish) passes through as it is.
        if (!reserved && err instanceof CreditsExceededError) {
          throw new XPostCapError(xCapMessage(kind, max, tierName));
        }
        throw err;
      }
    };

    return metered(X_CREDIT, plan.x_posts_per_month, 'posts', () =>
      link
        ? metered(X_LINK_CREDIT, plan.x_link_posts_per_month, 'links', publish)
        : publish()
    );
  }

  /**
   * The X plugs (XProvider autoPlugPost, autoRepostPost, repostPostUsers):
   * the provider polls and decides by itself whether to post, so a credit
   * cannot be held around the post itself. Instead `run` is skipped (and
   * `skipped` returned) once the month's cap is used, and when it reports
   * that it acted (anything but `false`) the post is counted afterwards.
   * `text` is what it would post ('' for a repost).
   */
  async guardPlug<T>(
    organizationId: string,
    providerIdentifier: string | undefined,
    text: string,
    run: () => Promise<T>,
    skipped: T
  ): Promise<T> {
    const caps = await this.capsFor(organizationId, providerIdentifier);
    if (!caps) {
      return run();
    }
    const { plan, from } = caps;
    const link = isLinkPost(text);
    const usedPosts = await this._subscriptionRepository.getCreditsFrom(
      organizationId,
      from,
      X_CREDIT
    );
    const usedLinks = link
      ? await this._subscriptionRepository.getCreditsFrom(
          organizationId,
          from,
          X_LINK_CREDIT
        )
      : 0;
    if (
      usedPosts >= plan.x_posts_per_month ||
      (link && usedLinks >= plan.x_link_posts_per_month)
    ) {
      return skipped;
    }
    const result = await run();
    if (result !== false) {
      const workspace = { id: organizationId } as Organization;
      const done = async () => undefined;
      await this._subscriptionRepository.useCredit(workspace, X_CREDIT, done);
      if (link) {
        await this._subscriptionRepository.useCredit(workspace, X_LINK_CREDIT, done);
      }
    }
    return result;
  }
}
