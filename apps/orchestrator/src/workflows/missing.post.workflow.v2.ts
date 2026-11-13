import {
  continueAsNew,
  log,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { PostActivity } from '@hookpost/orchestrator/activities/post.activity';

const { searchForMissingThreeHoursPosts } = proxyActivities<PostActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '2 minutes',
  },
});

// missingPostWorkflow (v1) loops forever in a single run. By 19 Oct 2026 that
// run held 10,471 events, the server logged "history count exceeds warn limit"
// on every task, and a cold replay after a restart took 8.5 s of the 10 s
// workflow task timeout. A sweep is about 11 events, so a day of hourly sweeps
// keeps each run near 265 events before it continues as new.
const SWEEPS_PER_RUN = 24;
// Backstop in case something starts adding more events per sweep.
const MAX_HISTORY_LENGTH = 2000;

export async function missingPostWorkflowV2() {
  for (let sweep = 0; sweep < SWEEPS_PER_RUN; sweep++) {
    try {
      await searchForMissingThreeHoursPosts();
    } catch (err) {
      // In v1 a sweep that failed all its attempts failed the workflow, and
      // nothing re-armed it until the next backend restart. Try next hour.
      log.warn('missing post sweep failed', { error: String(err) });
    }

    await sleep('1 hour');

    if (workflowInfo().historyLength > MAX_HISTORY_LENGTH) {
      break;
    }
  }

  // The loop carries no state between runs. The next run sweeps as soon as it
  // starts, an hour after this run's last sweep, so the cadence is unchanged.
  return await continueAsNew<typeof missingPostWorkflowV2>();
}
