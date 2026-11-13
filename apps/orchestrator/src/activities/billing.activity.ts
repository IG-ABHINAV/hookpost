import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';

/**
 * The billing steps the exact plan-end timer runs (planEndWorkflow,
 * plan.end.timer.ts). Each one is the backend's own code, so the timer and
 * the hourly sweep can never disagree about how a plan ends.
 */
@Injectable()
@Activity()
export class BillingActivity {
  constructor(private _razorpay: RazorpayService) {}

  /** The workspace's plan set to end, or null when there is none any more. */
  @ActivityMethod()
  async planEndDue(organizationId: string) {
    return this._razorpay.planEndDue(organizationId);
  }

  /**
   * End the workspace's plan if its date has passed: the hourly sweep
   * (endLapsedCancellations) for this one workspace, emails sent once.
   */
  @ActivityMethod()
  async endPlanAtCancelAt(organizationId: string) {
    return this._razorpay.endLapsedCancellations(new Date(), organizationId);
  }
}
