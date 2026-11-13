import { HttpException, HttpStatus } from '@nestjs/common';
import {
  planGateMessage,
  PlanGateCode,
  preTrialChannelMessage,
  TRIAL_DAYS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/**
 * Raised instead of publishing for a workspace that must start its trial
 * (TRIAL_REQUIRED) or choose a plan (PLAN_REQUIRED) first, and instead of
 * saving a new post past a new sign-up's free posts (FREE_POSTS_USED,
 * SubscriptionService.assertFreePostAllowed); see trial.policy.ts.
 *
 * 402 like CreditsExceededError and the backend's SubscriptionException, with
 * the gate code and the sentence the user sees. The orchestrator turns it into
 * BadBody with this message, so the post goes to ERROR once and is not retried.
 * `trialDays` is the workspace's own trial length (trialDaysFor: 7 for one
 * the Free plan sunset notice promised 7 to), so the post's error names the
 * same length as the banner and checkout.
 */
export class PlanRequiredError extends HttpException {
  /**
   * `message` replaces the code's own sentence where the reason is more
   * specific: a channel that already gave its free posts in another
   * workspace (trial.policy.ts reusedChannelMessage).
   */
  /**
   * Server-side only, never in the response: for FREE_POSTS_USED on a
   * reused account, the workspaces where it used its free posts and the
   * provider's name, so the composer's route can offer the user's OWN one of
   * them (PostsController). The public API and MCP leave it unused.
   */
  spentIn?: { organizationIds: string[]; provider: string };

  constructor(
    readonly code: PlanGateCode,
    trialDays: number = TRIAL_DAYS,
    message: string = planGateMessage(code, trialDays),
    extra: Record<string, unknown> = {}
  ) {
    super({ ...extra, code, message }, HttpStatus.PAYMENT_REQUIRED);
    this.message = message;
  }
}

/**
 * A connect that would take a workspace that has to start its trial past
 * PRE_TRIAL_CHANNEL_LIMIT (trial.policy.ts), refused where the channel would
 * be created: the OAuth callback and the page pick of a two-step login.
 *
 * The body is the one the backend's SubscriptionExceptionFilter gives a
 * TRIAL_REQUIRED refusal (code, message, trial, trialDays), so the page's
 * plan dialog (plan.limit.prompt.ts) offers the trial with the right length.
 */
export class PreTrialChannelLimitError extends HttpException {
  readonly code: PlanGateCode = 'TRIAL_REQUIRED';
  constructor(trialDays: number = TRIAL_DAYS) {
    const days = trialDays > 0 ? trialDays : TRIAL_DAYS;
    const message = preTrialChannelMessage(days);
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: 'TRIAL_REQUIRED',
        message,
        trial: true,
        trialDays: days,
      },
      HttpStatus.PAYMENT_REQUIRED
    );
    this.message = message;
  }
}
