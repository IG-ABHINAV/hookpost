import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

/**
 * Arms missingPostWorkflowV2: the hourly sweep that re-queues a QUEUE post
 * whose Temporal workflow no longer exists (see missing.post.workflow.v2.ts,
 * which calls searchForMissingThreeHoursPosts over a two-day window).
 *
 * This is the only thing that starts that sweep, and both of its failure modes
 * used to be silent:
 *
 *   - `RUN_CRON` was never set in the production .env, so the branch below
 *     simply did not run. Discovered 2026-09-10: the sweep had never executed
 *     in production once, and `temporal workflow list` showed no
 *     missingPostWorkflow at all. Nothing said so anywhere.
 *   - the start was wrapped in `catch (err) {}`, so even with RUN_CRON set a
 *     failure to arm it left no trace.
 *
 * A safety net whose absence is invisible is not a safety net, so both cases
 * now log.
 *
 * The sweep now runs as missingPostWorkflowV2, which continues as new once a
 * day. The v1 run never did, so it would hold the id forever: a running run of
 * any other type is replaced (terminated and restarted as V2 in one call). It
 * holds no state, and V2 sweeps as soon as it starts.
 */
const SWEEP_WORKFLOW_TYPE = 'missingPostWorkflowV2';
const SWEEP_WORKFLOW_ID = 'missing-post-workflow';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  constructor(private _temporalService: TemporalService) {}

  async onModuleInit(): Promise<void> {
    if (!process.env.RUN_CRON) {
      Logger.warn(
        `RUN_CRON is not set: ${SWEEP_WORKFLOW_TYPE} will not run, so a post whose Temporal workflow is lost will never be re-queued`,
        'InfiniteWorkflowRegister'
      );
      return;
    }

    // Never throws. Undefined when nothing is running or the lookup failed.
    const running = await this._runningSweep();
    const legacyRunId =
      running && running.type !== SWEEP_WORKFLOW_TYPE
        ? running.runId
        : undefined;

    try {
      await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.start(SWEEP_WORKFLOW_TYPE, {
          workflowId: SWEEP_WORKFLOW_ID,
          taskQueue: 'main',
          ...(legacyRunId
            ? { workflowIdConflictPolicy: 'TERMINATE_EXISTING' as const }
            : {}),
        });
      Logger.log(
        legacyRunId
          ? `${SWEEP_WORKFLOW_TYPE} started, replacing older run ${legacyRunId}`
          : `${SWEEP_WORKFLOW_TYPE} started`,
        'InfiniteWorkflowRegister'
      );
    } catch (err) {
      // Restarting the backend hits this every time, because the workflow is
      // already running from the previous boot. That is the normal case and is
      // not worth an error.
      const message = String((err as Error)?.message ?? err);
      if (/already started|AlreadyStarted|already exists/i.test(message)) {
        // Name what the server reported, not what we tried to start: after a
        // failed lookup the run holding the id may still be v1.
        Logger.log(
          `${running?.type ?? SWEEP_WORKFLOW_ID} already running`,
          'InfiniteWorkflowRegister'
        );
      } else {
        Logger.error(
          `could not start ${SWEEP_WORKFLOW_TYPE} - overdue posts will NOT be re-queued: ${message}`,
          'InfiniteWorkflowRegister'
        );
      }
    }
  }

  // The type and run id of the sweep run holding the id, if one is running.
  // Not found (first boot, or the last run ended) means a plain start.
  private async _runningSweep(): Promise<
    { type: string; runId: string } | undefined
  > {
    try {
      const description = await this._temporalService.client
        ?.getRawClient()
        ?.workflow?.getHandle(SWEEP_WORKFLOW_ID)
        .describe();
      return description?.status.name === 'RUNNING'
        ? { type: description.type, runId: description.runId }
        : undefined;
    } catch (err) {
      if ((err as Error)?.name !== 'WorkflowNotFoundError') {
        Logger.warn(
          `could not read the running sweep's type, starting without replacing it: ${String((err as Error)?.message ?? err)}`,
          'InfiniteWorkflowRegister'
        );
      }
      return undefined;
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}
