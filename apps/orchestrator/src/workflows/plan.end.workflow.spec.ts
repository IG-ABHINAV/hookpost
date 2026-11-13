// planEndWorkflow: the exact plan-end timer. No @temporalio/testing harness in
// the repo, so the workflow APIs are faked; `sleep` moves a fake clock.
//   pnpm exec jest -c apps/backend/jest.config.ts plan.end.workflow

const planEndDue = jest.fn();
const endPlanAtCancelAt = jest.fn();
const sleeps: number[] = [];
let now = Date.parse('2026-11-11T09:00:00Z');

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ planEndDue, endPlanAtCancelAt }),
  sleep: async (ms: number) => {
    sleeps.push(ms);
    now += ms;
  },
}));

import { planEndWorkflow } from './plan.end.workflow';

const ORG = 'org-1';
const at = (iso: string) => ({ identifier: 'sub_1', cancelAt: iso });

beforeEach(() => {
  jest.clearAllMocks();
  sleeps.length = 0;
  now = Date.parse('2026-11-11T09:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

describe('planEndWorkflow', () => {
  it('sleeps to cancelAt exactly, then ends the plan once', async () => {
    planEndDue.mockResolvedValue(at('2026-11-11T14:30:00.000Z'));
    endPlanAtCancelAt.mockResolvedValue({ checked: 1, ended: 1 });

    expect(await planEndWorkflow({ organizationId: ORG })).toBe('ended');
    expect(sleeps).toEqual([5.5 * 3600_000]);
    expect(endPlanAtCancelAt).toHaveBeenCalledTimes(1);
    expect(endPlanAtCancelAt).toHaveBeenCalledWith(ORG);
    expect(new Date(now).toISOString()).toBe('2026-11-11T14:30:00.000Z');
  });

  it('a date moved later while it slept: sleeps on to the new date', async () => {
    planEndDue
      .mockResolvedValueOnce(at('2026-11-11T10:00:00.000Z'))
      .mockResolvedValueOnce(at('2026-11-11T12:00:00.000Z'))
      .mockResolvedValue(at('2026-11-11T12:00:00.000Z'));
    endPlanAtCancelAt.mockResolvedValue({ checked: 1, ended: 1 });

    expect(await planEndWorkflow({ organizationId: ORG })).toBe('ended');
    expect(sleeps).toEqual([3600_000, 2 * 3600_000]);
    expect(endPlanAtCancelAt).toHaveBeenCalledTimes(1);
  });

  it('a date cleared while it slept (Reactivate, renewal paid): does nothing', async () => {
    planEndDue.mockResolvedValueOnce(at('2026-11-11T10:00:00.000Z')).mockResolvedValue(null);
    expect(await planEndWorkflow({ organizationId: ORG })).toBe('nothing-to-end');
    expect(endPlanAtCancelAt).not.toHaveBeenCalled();
  });

  it('a plan already ended (refund, webhook, the sweep): a duplicate timer does nothing', async () => {
    planEndDue.mockResolvedValue(null);
    expect(await planEndWorkflow({ organizationId: ORG })).toBe('nothing-to-end');
    expect(sleeps).toEqual([]);
    expect(endPlanAtCancelAt).not.toHaveBeenCalled();
  });

  it('a timer that wakes late (orchestrator was down) ends the plan at once', async () => {
    planEndDue.mockResolvedValue(at('2026-11-10T09:00:00.000Z'));
    endPlanAtCancelAt.mockResolvedValue({ checked: 1, ended: 1 });
    expect(await planEndWorkflow({ organizationId: ORG })).toBe('ended');
    expect(sleeps).toEqual([]);
  });

  it('never sleeps more than a week without reading the row again (a yearly plan)', async () => {
    planEndDue.mockResolvedValue(at('2027-11-11T09:00:00.000Z'));
    endPlanAtCancelAt.mockResolvedValue({ checked: 1, ended: 1 });
    await planEndWorkflow({ organizationId: ORG });
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(7 * 86_400_000);
    expect(planEndDue.mock.calls.length).toBeGreaterThan(50);
    expect(new Date(now).toISOString()).toBe('2027-11-11T09:00:00.000Z');
  });

  it('Razorpay not caught up at the date: looks again every 5 minutes, then leaves it to the sweep', async () => {
    planEndDue.mockResolvedValue(at('2026-11-11T09:00:00.000Z'));
    endPlanAtCancelAt.mockResolvedValue({ checked: 1, ended: 0 });
    expect(await planEndWorkflow({ organizationId: ORG })).toBe('left-to-sweep');
    expect(endPlanAtCancelAt).toHaveBeenCalledTimes(12);
    expect(sleeps.every((ms) => ms === 5 * 60_000)).toBe(true);
  });
});
