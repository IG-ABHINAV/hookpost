import { Injectable, Logger, Optional } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

/**
 * THE EXACT PLAN-END TIMER (the owner, 29 Oct 2026: "30 minute wala gap hum
 * le kyun rahe hain, wo events immediate").
 *
 * When a Razorpay plan is set to end (cancelAt), one durable Temporal timer
 * per workspace (planEndWorkflow, id `plan-end-<org>`) wakes at that second
 * and ends the plan through the hourly sweep's own code, for that one
 * workspace (RazorpayService.endLapsedCancellations(now, org)): the row is
 * closed and the one "plan ended" email goes out then, not at the next sweep.
 *
 * - Every gate already treats the plan as over from cancelAt on
 *   (trial.policy.ts planLapsed), so the timer only does the tidying and the
 *   email on time; access never depended on it.
 * - Moved date: the timer is replaced (TERMINATE_EXISTING). Cleared date
 *   (Reactivate, a renewal paid, a new plan): the timer is stopped. Either
 *   way the workflow re-reads the row when it wakes and does nothing for a
 *   date that is no longer on file, so a stale or duplicate timer is harmless.
 * - Temporal or the orchestrator down: the hourly sweep still ends the row,
 *   and the timer that fires later finds nothing to do. The sweep also re-arms
 *   (keep) a timer for every plan set to end, so one lost at start is armed
 *   within the hour.
 *
 * Only `sub_` (Razorpay) and `order_` (a paid one-time month) rows: those
 * are the ones the sweep ends. Never
 * throws: a timer that could not be armed is logged, and the sweep is the
 * backup.
 */
export const PLAN_END_WORKFLOW = 'planEndWorkflow';

/** The plans the sweep ends, so the timer is armed for: Razorpay and paid one-time months. */
export const endsOnTimer = (identifier: string | null | undefined) =>
  !!identifier && (identifier.startsWith('sub_') || identifier.startsWith('order_'));
export const planEndWorkflowId = (organizationId: string) =>
  `plan-end-${organizationId}`;

@Injectable()
export class PlanEndTimer {
  private readonly logger = new Logger(PlanEndTimer.name);

  constructor(@Optional() private readonly _temporal?: TemporalService) {}

  /**
   * Arm, move or stop the timer for this workspace's plan.
   *
   * `replace` (a date just written) restarts the timer at the new date;
   * `keep` (the sweep's re-arm) leaves a running timer alone.
   */
  async arm(
    organizationId: string,
    identifier: string | null | undefined,
    cancelAt: Date | null,
    mode: 'replace' | 'keep' = 'replace'
  ): Promise<void> {
    if (!organizationId || !endsOnTimer(identifier)) return;
    const client = this._temporal?.client?.getRawClient?.();
    if (!client) return;
    const workflowId = planEndWorkflowId(organizationId);
    try {
      if (!cancelAt) {
        await client.workflow
          .getHandle(workflowId)
          .terminate('plan end date cleared')
          .catch(() => undefined);
        return;
      }
      await client.workflow.start(PLAN_END_WORKFLOW, {
        workflowId,
        taskQueue: 'main',
        workflowIdConflictPolicy:
          mode === 'replace' ? 'TERMINATE_EXISTING' : 'USE_EXISTING',
        args: [{ organizationId, identifier }],
      });
    } catch (e: any) {
      this.logger.error(
        `Could not arm the plan-end timer for org ${organizationId} (${identifier}, ${cancelAt?.toISOString() ?? 'cleared'}); the hourly sweep will end it: ${e?.message || e}`
      );
    }
  }
}
