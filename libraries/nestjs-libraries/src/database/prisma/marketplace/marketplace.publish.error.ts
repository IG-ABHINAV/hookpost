import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';

/**
 * A marketplace workspace's plan does not allow this publish
 * (marketplace.plans.ts marketplacePublishRefusal). A PlanRequiredError, so
 * every orchestrator workflow version turns it into BadBody with this
 * sentence: the post goes to ERROR once, is not retried, and nothing reaches
 * the network.
 */
export class MarketplacePublishRefusedError extends PlanRequiredError {
  constructor(reason: string) {
    super('PLAN_REQUIRED');
    this.message = reason;
  }
}
