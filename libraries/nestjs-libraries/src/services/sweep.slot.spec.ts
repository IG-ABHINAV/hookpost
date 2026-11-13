import { DB_SWEEP_SLOT_MS, everyAligned, msToNextSlot } from '@hookpost/helpers/utils/timer';

const HOUR = DB_SWEEP_SLOT_MS;
const at = (iso: string) => new Date(iso).getTime();

describe('msToNextSlot', () => {
  it('counts to the next top of the UTC hour', () => {
    expect(msToNextSlot(HOUR, at('2026-11-01T10:20:00Z'))).toBe(40 * 60_000);
  });
  it('exactly on a slot waits a full period, never 0 (no double run)', () => {
    expect(msToNextSlot(HOUR, at('2026-11-01T10:00:00Z'))).toBe(HOUR);
  });
  it('one millisecond before a slot waits one millisecond', () => {
    expect(msToNextSlot(HOUR, at('2026-11-01T10:59:59.999Z'))).toBe(1);
  });
  it('a 6-hour period lands on 00/06/12/18 UTC, so it shares an hourly slot', () => {
    const now = at('2026-11-01T07:30:00Z');
    expect(new Date(now + msToNextSlot(6 * HOUR, now)).toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });
  it('an offset shifts the slot', () => {
    expect(msToNextSlot(HOUR, at('2026-11-01T10:20:00Z'), 30 * 60_000)).toBe(10 * 60_000);
  });
});

describe('everyAligned', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-11-01T10:20:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('first run at the next slot, then every slot on the clock', () => {
    const runs: string[] = [];
    const t = everyAligned(HOUR, () => runs.push(new Date().toISOString()));
    jest.advanceTimersByTime(40 * 60_000 - 1);
    expect(runs).toEqual([]);
    jest.advanceTimersByTime(1);
    jest.advanceTimersByTime(2 * HOUR);
    expect(runs).toEqual([
      '2026-11-01T11:00:00.000Z',
      '2026-11-01T12:00:00.000Z',
      '2026-11-01T13:00:00.000Z',
    ]);
    t.stop();
  });

  it('two timers started at different times fire in the same slot (one DB wake)', () => {
    const a: number[] = [];
    const b: number[] = [];
    everyAligned(HOUR, () => a.push(Date.now()));
    jest.advanceTimersByTime(17 * 60_000);
    everyAligned(HOUR, () => b.push(Date.now()));
    jest.advanceTimersByTime(HOUR);
    expect(a).toEqual(b);
    expect(a).toHaveLength(1);
  });

  it('a run that throws or rejects does not stop the schedule', () => {
    let n = 0;
    const t = everyAligned(HOUR, () => {
      n++;
      if (n === 1) throw new Error('boom');
      return Promise.reject(new Error('later'));
    });
    jest.advanceTimersByTime(3 * HOUR);
    expect(n).toBe(3);
    t.stop();
  });

  it('stop() cancels the next run', () => {
    let n = 0;
    const t = everyAligned(HOUR, () => n++);
    t.stop();
    jest.advanceTimersByTime(5 * HOUR);
    expect(n).toBe(0);
  });
});
