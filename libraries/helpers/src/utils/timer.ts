export const timer = (ms: number) => new Promise((res) => setTimeout(res, ms));

/**
 * The one wall-clock slot every database sweep shares: the top of each UTC
 * hour.
 *
 * Why it matters: production Postgres is Neon, whose Free plan gives 100
 * compute-hours a month and suspends the compute after 5 idle minutes. Each
 * sweep used to run on its own setInterval, started whenever its process
 * booted, in two processes (backend and orchestrator both have RUN_CRON). That
 * scattered queries across the hour, so the compute never suspended (it had
 * been up for 2.6 days straight on 1 Nov 2026) and the project used 80 of its
 * 100 CU-hours in October. Sharing one slot means one wake an hour for all.
 */
export const DB_SWEEP_SLOT_MS = 60 * 60 * 1000;

/** Milliseconds from `now` to the next multiple of `everyMs` (epoch-aligned), shifted by `offsetMs`. */
export function msToNextSlot(everyMs: number, now = Date.now(), offsetMs = 0): number {
  const next = Math.floor((now - offsetMs) / everyMs) * everyMs + everyMs + offsetMs;
  return next - now;
}

export interface AlignedTimer {
  stop(): void;
}

/**
 * Runs `fn` at every multiple of `everyMs` on the wall clock (every hour at
 * :00 UTC for DB_SWEEP_SLOT_MS) instead of every `everyMs` from process
 * start. Each run is scheduled from the clock again, so it never drifts. The
 * timer is unref'd, so it never keeps a process alive on its own, and a run
 * that throws or rejects never stops the schedule.
 */
export function everyAligned(everyMs: number, fn: () => unknown, offsetMs = 0): AlignedTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    handle = setTimeout(() => {
      schedule();
      try {
        const out = fn() as any;
        if (out && typeof out.catch === 'function') out.catch(() => undefined);
      } catch {
        /* a sweep failing must never stop the schedule */
      }
    }, msToNextSlot(everyMs, Date.now(), offsetMs));
    (handle as any)?.unref?.();
  };
  schedule();
  return {
    stop() {
      stopped = true;
      if (handle) clearTimeout(handle);
    },
  };
}
