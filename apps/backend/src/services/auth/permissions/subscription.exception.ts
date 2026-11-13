import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { AuthorizationActions, Sections, SubscriptionException } from '@hookpost/backend/services/auth/permissions/permission.exception.class';
export { SubscriptionException };
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  checkoutAllowsTrial,
  knownTrialDays,
  PAY_FROM_ANOTHER_ACCOUNT_PATH,
  PAYMENT_FAILING_MESSAGE,
  PLAN_GATE_MESSAGES,
  planGateMessage,
  PlanGateCode,
  planState,
  PolicyOrg,
  preTrialChannelMessage,
  TRIAL_DAYS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { trustedCountry } from '@hookpost/nestjs-libraries/services/billing.currency';

@Catch(SubscriptionException)
export class SubscriptionExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const status = exception.getStatus();
    const error: {
      section: Sections;
      action: AuthorizationActions;
      code?: PlanGateCode;
      trialDays?: number;
      paymentFailing?: boolean;
      freePosts?: boolean;
      trialOffered?: boolean;
    } = exception.getResponse() as any;

    // AI or X refused while the workspace's payment is failing: it has a
    // plan, so say what is off and how to get it back, not "upgrade".
    if (error?.paymentFailing) {
      response.status(status).json({
        statusCode: status,
        code: 'PAYMENT_FAILING',
        message: PAYMENT_FAILING_MESSAGE,
        trial: false,
        url: process.env.FRONTEND_URL + PAY_FROM_ANOTHER_ACCOUNT_PATH,
      });
      return;
    }
    // The workspace's own trial length where the thrower looked it up (7 for
    // a workspace the Free plan sunset notice promised 7 to), else TRIAL_DAYS.
    const days = knownTrialDays(error?.trialDays);

    // A workspace that has to start its trial (or, with the trial used,
    // choose a plan) before anything else: no Free plan to describe. `code`
    // tells the page which button to show.
    if (error?.code && PLAN_GATE_MESSAGES[error.code]) {
      response.status(status).json({
        statusCode: status,
        code: error.code,
        // needs_trial asking for a channel was refused because its
        // PRE_TRIAL_CHANNEL_LIMIT is used up, not because channels need the
        // trial: say so.
        message:
          error.code === 'TRIAL_REQUIRED' && error.section === Sections.CHANNEL
            ? preTrialChannelMessage(days)
            : planGateMessage(error.code, days),
        trial: error.code === 'TRIAL_REQUIRED',
        // For the dialog's button (plan.limit.prompt.ts).
        ...(error.code === 'TRIAL_REQUIRED' ? { trialDays: days } : {}),
        url: process.env.FRONTEND_URL + '/billing',
      });
      return;
    }

    // A Free workspace hitting a limit is the moment to offer Standard's
    // TRIAL_DAYS-day trial, so say what the Free plan includes and what the trial unlocks.
    // allowTrial is true until the workspace has used its trial.
    const req = ctx.getRequest();
    const org = req?.org;
    const onFree = !!org && !org.subscription;
    // A workspace on its free posts has no Free plan and no trial to start:
    // its checkout charges at once (trial.policy.ts checkoutAllowsTrial). The
    // thrower's reading (from the owner's signup country) wins; without one,
    // the request is read cautiously (mayBeOnFreePosts).
    const freePosts =
      onFree &&
      (typeof error?.freePosts === 'boolean'
        ? error.freePosts
        : mayBeOnFreePosts(org, req));
    // The trial is offered where checkout would start one: the thrower's
    // answer (trialOffered), else the policy's (never on the free posts
    // while the trial switch is off, checkoutAllowsTrial).
    const canTrial =
      onFree &&
      (typeof error?.trialOffered === 'boolean'
        ? error.trialOffered
        : checkoutAllowsTrial(freePosts ? 'free_posts' : 'free', org.allowTrial));
    const message =
      (onFree && getFreePlanMessage(error, canTrial, days, freePosts)) ||
      getErrorMessage(error);

    response.status(status).json({
      statusCode: status,
      message,
      trial: canTrial,
      ...(canTrial ? { trialDays: days } : {}),
      url: process.env.FRONTEND_URL + '/billing',
    });
  }
}

/**
 * Whether the request's workspace may be on its free posts (trial.policy.ts
 * free_posts), for a thrower that did not say (error.freePosts). The owner's
 * signup country is not on the request, and the request's own country can
 * be wrong for it (an MCP call from a US server, an Indian owner travelling),
 * so every group it could be in is tried: free posts in any of them means no
 * trial is offered. Never offering a trial that checkout would not start is
 * the safe side; the guard, the AI credit check and video generation pass
 * the real answer, so this only decides when that lookup failed. Known cost:
 * with the two cutoffs different (GLOBAL unset while the USD rail is off), a
 * grandfathered workspace outside India created after the IN cutoff is not
 * offered its trial here; it still is on Billing.
 */
export const mayBeOnFreePosts = (org: any, req: any): boolean => {
  const base: PolicyOrg = {
    id: org.id,
    createdAt: org.createdAt,
    allowTrial: org.allowTrial,
    isTrailing: org.isTrailing,
    subscription: null,
  };
  return [trustedCountry(req?.headers || {}), 'IN', null].some(
    (ownerCountry) => planState({ ...base, ownerCountry }) === 'free_posts'
  );
};

const getErrorMessage = (error: {
  section: Sections;
  action: AuthorizationActions;
}) => {
  switch (error.section) {
    case Sections.POSTS_PER_MONTH:
      switch (error.action) {
        default:
          return 'You have reached the maximum number of posts for your subscription. Please upgrade your subscription to add more posts.';
      }
    case Sections.CHANNEL:
      switch (error.action) {
        default:
          return 'You have reached the maximum number of channels for your subscription. Please upgrade your subscription to add more channels.';
      }
    case Sections.WEBHOOKS:
      switch (error.action) {
        default:
          return 'You have reached the maximum number of webhooks for your subscription. Please upgrade your subscription to add more webhooks.';
      }
    case Sections.AUTOPOST:
      switch (error.action) {
        default:
          return 'RSS autopost is not on your plan. It comes with Team, Pro and Ultimate; please upgrade your subscription to post from your feeds automatically.';
      }
    case Sections.VIDEOS_PER_MONTH:
      switch (error.action) {
        default:
          return 'You have reached the maximum number of generated videos for your subscription. Please upgrade your subscription to generate more videos.';
      }
  }
};

const getFreePlanMessage = (
  error: { section: Sections; action: AuthorizationActions },
  canTrial: boolean,
  days: number = TRIAL_DAYS,
  freePosts = false
) => {
  const { FREE, STANDARD } = pricingINR;
  // The closing sentence keeps "Upgrade" or "trial" so the Play app drops it
  // (twa.ts twaLimitMessage).
  const next = (what: string) =>
    canTrial
      ? `Start a ${days}-day free trial of Standard to get ${what} - no charge until the trial ends, cancel at least 24 hours before it does.`
      : `Upgrade to Standard to get ${what}.`;
  // On its free posts there is no Free plan to name, and a trial to offer
  // only while the trial switch is on (canTrial).
  if (freePosts) {
    switch (error.section) {
      case Sections.CHANNEL:
        return `Your free posts include ${FREE.channel} channels. ${next(`up to ${STANDARD.channel} channels`)}`;
      case Sections.POSTS_PER_MONTH:
        return `You've used this month's posts. ${next(`${STANDARD.posts_per_month} posts a month`)}`;
      case Sections.AI:
      case Sections.AI_GENERATIONS:
        return `AI writing and the AI Agent are on the paid plans. You can still write and schedule posts yourself. ${next('the AI Agent and AI writing')}`;
      default:
        return undefined;
    }
  }
  switch (error.section) {
    case Sections.CHANNEL:
      return `The Free plan includes ${FREE.channel} channels. ${next(`up to ${STANDARD.channel} channels`)}`;
    case Sections.POSTS_PER_MONTH:
      return `You've used all ${FREE.posts_per_month} posts on the Free plan this month. ${next(`${STANDARD.posts_per_month} posts a month`)}`;
    // The Free plan has no AI at all (ai: false, ai_generation_count: 0), so
    // this is never a limit the user ran into. It used to fall through to
    // "You have reached a limit of your plan", shown to people who had
    // signed up a minute earlier and opened the AI Agent.
    case Sections.AI:
    case Sections.AI_GENERATIONS:
      return `AI writing and the AI Agent are on the paid plans. You can still write and schedule posts yourself. ${next('the AI Agent and AI writing')}`;
    default:
      return undefined;
  }
};
