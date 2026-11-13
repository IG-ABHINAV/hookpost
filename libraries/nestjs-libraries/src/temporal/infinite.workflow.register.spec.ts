import 'reflect-metadata';

// The backend boot that arms the missing-post sweep. A running sweep of an
// older type (the v1 run that never continued as new) is replaced by V2; a
// running V2 is left alone.
//   pnpm exec jest -c apps/backend/jest.config.ts infinite.workflow.register

jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

import { Logger } from '@nestjs/common';
import { InfiniteWorkflowRegister } from './infinite.workflow.register';

class WorkflowNotFoundError extends Error {
  name = 'WorkflowNotFoundError';
}

const ALREADY_STARTED = new Error('Workflow execution already started');

/** A Temporal client fake: what describe() returns and what start() does. */
const fakeTemporal = ({
  current,
  status = 'RUNNING',
  describeError,
  startError,
}: {
  current?: { type: string; runId: string };
  status?: string;
  describeError?: Error;
  startError?: Error;
} = {}) => {
  const start = jest.fn(async () => {
    if (startError) {
      throw startError;
    }
  });
  const client = {
    workflow: {
      getHandle: () => ({
        describe: async () => {
          if (describeError) {
            throw describeError;
          }
          if (!current) {
            throw new WorkflowNotFoundError('workflow not found');
          }
          return { ...current, status: { name: status } };
        },
      }),
      start,
    },
  };
  const register = new InfiniteWorkflowRegister({
    client: { getRawClient: () => client },
  } as any);
  return { register, start };
};

const PLAIN_START = {
  workflowId: 'missing-post-workflow',
  taskQueue: 'main',
};

beforeEach(() => {
  process.env.RUN_CRON = 'true';
  jest.spyOn(Logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.RUN_CRON;
  jest.restoreAllMocks();
});

describe('InfiniteWorkflowRegister', () => {
  it('replaces a running v1 sweep with V2 under the same id', async () => {
    const { register, start } = fakeTemporal({
      current: { type: 'missingPostWorkflow', runId: 'v1-run' },
    });

    await register.onModuleInit();

    expect(start).toHaveBeenCalledWith('missingPostWorkflowV2', {
      ...PLAIN_START,
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
    });
    expect(Logger.log).toHaveBeenCalledWith(
      'missingPostWorkflowV2 started, replacing older run v1-run',
      'InfiniteWorkflowRegister'
    );
  });

  it('leaves a running V2 alone', async () => {
    const { register, start } = fakeTemporal({
      current: { type: 'missingPostWorkflowV2', runId: 'v2-run' },
      startError: ALREADY_STARTED,
    });

    await register.onModuleInit();

    expect(start).toHaveBeenCalledWith('missingPostWorkflowV2', PLAIN_START);
    expect(Logger.log).toHaveBeenCalledWith(
      'missingPostWorkflowV2 already running',
      'InfiniteWorkflowRegister'
    );
    expect(Logger.error).not.toHaveBeenCalled();
  });

  it('starts V2 normally when no sweep exists yet', async () => {
    const { register, start } = fakeTemporal();

    await register.onModuleInit();

    expect(start).toHaveBeenCalledWith('missingPostWorkflowV2', PLAIN_START);
    expect(Logger.warn).not.toHaveBeenCalled();
  });

  it('starts V2 normally when the last v1 run has already ended', async () => {
    const { register, start } = fakeTemporal({
      current: { type: 'missingPostWorkflow', runId: 'v1-run' },
      status: 'TERMINATED',
    });

    await register.onModuleInit();

    expect(start).toHaveBeenCalledWith('missingPostWorkflowV2', PLAIN_START);
  });

  it('warns, and does not claim V2 is running, when the lookup fails', async () => {
    const { register, start } = fakeTemporal({
      describeError: new Error('14 UNAVAILABLE: connection refused'),
      startError: ALREADY_STARTED,
    });

    await register.onModuleInit();

    expect(start).toHaveBeenCalledWith('missingPostWorkflowV2', PLAIN_START);
    expect(Logger.warn).toHaveBeenCalledWith(
      "could not read the running sweep's type, starting without replacing it: 14 UNAVAILABLE: connection refused",
      'InfiniteWorkflowRegister'
    );
    expect(Logger.log).toHaveBeenCalledWith(
      'missing-post-workflow already running',
      'InfiniteWorkflowRegister'
    );
  });
});
