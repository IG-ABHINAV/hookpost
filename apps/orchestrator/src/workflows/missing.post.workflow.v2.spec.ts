// missingPostWorkflowV2: hourly sweeps that continue as new after a day, so the
// run's history stays small. The repo has no @temporalio/testing harness, so
// the workflow APIs are faked and sleep returns at once.
//   pnpm exec jest -c apps/backend/jest.config.ts missing.post.workflow

const sweep = jest.fn();
const sleep = jest.fn();
const continueAsNew = jest.fn();
const warn = jest.fn();
let historyLength = 0;

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () => ({ searchForMissingThreeHoursPosts: sweep }),
  sleep: (duration: string) => sleep(duration),
  continueAsNew: (...args: unknown[]) => continueAsNew(...args),
  workflowInfo: () => ({ historyLength }),
  log: { warn: (...args: unknown[]) => warn(...args) },
}));

import { missingPostWorkflowV2 } from './missing.post.workflow.v2';

beforeEach(() => {
  jest.clearAllMocks();
  historyLength = 0;
  sweep.mockResolvedValue(undefined);
  sleep.mockImplementation(async () => {
    // About what a sweep, its timer and the two workflow tasks add.
    historyLength += 11;
  });
  continueAsNew.mockResolvedValue(undefined);
});

describe('missingPostWorkflowV2', () => {
  it('sweeps hourly for a day, then continues as new with no state', async () => {
    const order: string[] = [];
    sweep.mockImplementation(async () => {
      order.push('sweep');
    });
    sleep.mockImplementation(async (duration: string) => {
      order.push(`sleep ${duration}`);
    });

    await missingPostWorkflowV2();

    expect(sweep).toHaveBeenCalledTimes(24);
    expect(sleep).toHaveBeenCalledTimes(24);
    expect(order.slice(0, 3)).toEqual(['sweep', 'sleep 1 hour', 'sweep']);
    expect(order[order.length - 1]).toBe('sleep 1 hour');
    expect(continueAsNew).toHaveBeenCalledTimes(1);
    expect(continueAsNew).toHaveBeenCalledWith();
  });

  it('continues as new early once the history passes 2,000 events', async () => {
    sleep.mockImplementation(async () => {
      historyLength += 900;
    });

    await missingPostWorkflowV2();

    // 900, 1,800, then 2,700 after the third sleep.
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(continueAsNew).toHaveBeenCalledTimes(1);
  });

  it('keeps sweeping after a sweep fails all its attempts', async () => {
    sweep.mockRejectedValueOnce(new Error('Activity task failed'));

    await missingPostWorkflowV2();

    expect(warn).toHaveBeenCalledWith('missing post sweep failed', {
      error: 'Error: Activity task failed',
    });
    expect(sweep).toHaveBeenCalledTimes(24);
    expect(continueAsNew).toHaveBeenCalledTimes(1);
  });
});
