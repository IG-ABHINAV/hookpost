import { proxyActivities, sleep } from '@temporalio/workflow';
import type { BillingActivity } from '@hookpost/orchestrator/activities/billing.activity';

const { planEndDue, endPlanAtCancelAt } = proxyActivities<BillingActivity>({
  startToCloseTimeout: '2 minute',
  taskQueue: 'main',
  retry: {
    maximumAttempts: 5,
    initialInterval: '30 seconds',
    backoffCoefficient: 2,
  },
});

/** Longest single sleep: the row is read again at least this often. */
const MAX_SLEEP_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Razorpay may still call the subscription active for a few minutes after a
 * cycle-end date; the sweep's code then keeps the row. Look again this often,
 * this many times, and leave the rest to the hourly sweep.
 */
const NOT_YET_RETRY_MS = 5 * 60 * 1000;
const NOT_YET_TRIES = 12;

/**
 * The exact plan-end timer (plan.end.timer.ts): one per workspace, id
 * `plan-end-<org>`. Sleeps until the plan's cancelAt, then ends it through
 * the sweep's own code for this workspace. It always follows the row on file
 * when it wakes: a date moved later is slept to, a date cleared or a plan
 * already ended (refund, webhook, the sweep) ends the workflow with nothing
 * done, so a duplicate or stale timer can never end a plan early or twice.
 */
export async function planEndWorkflow({
  organizationId,
}: {
  organizationId: string;
  identifier?: string;
}) {
  let tries = 0;
  while (true) {
    const due = await planEndDue(organizationId);
    if (!due) return 'nothing-to-end';
    const wait = Date.parse(due.cancelAt) - Date.now();
    if (wait > 0) {
      await sleep(Math.min(wait, MAX_SLEEP_MS));
      continue;
    }
    const { ended } = await endPlanAtCancelAt(organizationId);
    if (ended > 0) return 'ended';
    if (++tries >= NOT_YET_TRIES) return 'left-to-sweep';
    await sleep(NOT_YET_RETRY_MS);
  }
}
