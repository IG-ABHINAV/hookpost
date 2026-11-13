import { Injectable } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { DB_SWEEP_SLOT_MS, msToNextSlot } from '@hookpost/helpers/utils/timer';

/**
 * What the external uptime monitor (.github/workflows/uptime.yml) reads.
 *
 * - db: one indexed read through Prisma. If this fails the API cannot serve
 *   anything useful, so the endpoint answers 503.
 * - worker: whether an orchestrator worker has polled the "main" Temporal task
 *   queue recently. Temporal remembers each poller's last poll for a few
 *   minutes, so an empty list means no worker is picking up posts or emails.
 *   Reported in the body only: the API itself is still up when the worker is
 *   down, and the monitor treats the two as separate checks.
 *
 * Results are cached for a few seconds so the endpoint is cheap to hammer.
 *
 * The database read is NOT repeated on every call. Production Postgres is Neon
 * (Free plan: 100 compute-hours a month, compute suspends after 5 idle
 * minutes). The uptime cron reads this endpoint every 5 minutes, which alone
 * kept the compute awake around the clock. A good read is now trusted until
 * the next shared sweep slot (the top of the UTC hour, DB_SWEEP_SLOT_MS), when
 * the billing and marketplace sweeps wake the compute anyway, so the next
 * probe rides along with that wake instead of causing its own. A failed read
 * is cached only for CACHE_MS, so recovery shows at once. Worst case, a
 * database that dies right after a good read shows here up to an hour late;
 * the external Neon usage alerts (scripts/uptime) warn before the quota runs
 * out, which is the outage this trade-off is about.
 */
export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  db: 'ok' | 'error';
  worker: 'ok' | 'no_pollers' | 'error';
  workerLastPollSecondsAgo: number | null;
  checkedAt: string;
}

const CACHE_MS = 10_000;
const STEP_TIMEOUT_MS = 4_000;
// A healthy worker long-polls at least once a minute.
const WORKER_STALE_SECONDS = 180;
// temporal.api.enums.v1.TaskQueueType.TASK_QUEUE_TYPE_WORKFLOW
const TASK_QUEUE_TYPE_WORKFLOW = 1;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

@Injectable()
export class HealthService {
  private _cached?: { at: number; report: HealthReport };
  private _dbOkUntil = 0;

  constructor(
    private _user: PrismaRepository<'user'>,
    private _temporalService: TemporalService
  ) {}

  async check(): Promise<HealthReport> {
    if (this._cached && Date.now() - this._cached.at < CACHE_MS) {
      return this._cached.report;
    }

    const [db, worker] = await Promise.all([this.dbState(), this.checkWorker()]);
    const report: HealthReport = {
      status: db !== 'ok' ? 'down' : worker.state !== 'ok' ? 'degraded' : 'ok',
      db,
      worker: worker.state,
      workerLastPollSecondsAgo: worker.secondsAgo,
      checkedAt: new Date().toISOString(),
    };
    this._cached = { at: Date.now(), report };
    return report;
  }

  /** The database state, read at most once per sweep slot while it is good. */
  private async dbState(now = Date.now()): Promise<HealthReport['db']> {
    if (now < this._dbOkUntil) return 'ok';
    const db = await this.checkDb();
    this._dbOkUntil =
      db === 'ok' ? now + msToNextSlot(DB_SWEEP_SLOT_MS, now) : 0;
    return db;
  }

  private async checkDb(): Promise<HealthReport['db']> {
    try {
      await withTimeout(
        this._user.model.user.findFirst({ select: { id: true } }),
        STEP_TIMEOUT_MS
      );
      return 'ok';
    } catch {
      return 'error';
    }
  }

  private async checkWorker(): Promise<{
    state: HealthReport['worker'];
    secondsAgo: number | null;
  }> {
    try {
      const client = this._temporalService.client?.getRawClient();
      if (!client) return { state: 'error', secondsAgo: null };

      const res = await withTimeout(
        client.workflowService.describeTaskQueue({
          namespace: process.env.TEMPORAL_NAMESPACE || 'default',
          taskQueue: { name: 'main' },
          taskQueueType: TASK_QUEUE_TYPE_WORKFLOW,
        }),
        STEP_TIMEOUT_MS
      );

      const lastPoll = (res.pollers || [])
        .map((p) => {
          const t = p.lastAccessTime;
          if (!t?.seconds) return 0;
          return Number(t.seconds) * 1000 + Math.floor((t.nanos || 0) / 1e6);
        })
        .reduce((a, b) => Math.max(a, b), 0);

      if (!lastPoll) return { state: 'no_pollers', secondsAgo: null };
      const secondsAgo = Math.max(0, Math.round((Date.now() - lastPoll) / 1000));
      return {
        state: secondsAgo <= WORKER_STALE_SECONDS ? 'ok' : 'no_pollers',
        secondsAgo,
      };
    } catch {
      return { state: 'error', secondsAgo: null };
    }
  }
}
