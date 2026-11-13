/**
 * Stands in for nestjs-temporal-core's TemporalService. Nothing in the
 * integration stack runs a Temporal worker, so instead of a server this
 * records what the backend asked Temporal to do: which workflows it started
 * (a scheduled post, an autopost) and which signals it sent (every email goes
 * out as a signal to sendEmailWorkflow, see email.service.ts).
 *
 * Tests read `started`, `signals` and `emails()` to assert on side effects
 * that would otherwise be invisible over HTTP.
 */
export interface RecordedCall {
  workflow: string;
  options: any;
}

export class FakeTemporal {
  started: RecordedCall[] = [];
  signals: RecordedCall[] = [];
  terminated: string[] = [];
  workerPolledAt: number | null = Date.now();

  private handle = (workflowId: string) => ({
    workflowId,
    terminate: async () => {
      this.terminated.push(workflowId);
    },
    cancel: async () => undefined,
    signal: async () => undefined,
    query: async () => undefined,
    result: async () => undefined,
    describe: async () => ({ status: { name: 'COMPLETED' } }),
  });

  readonly rawClient = {
    workflow: {
      start: async (workflow: string, options: any) => {
        this.started.push({ workflow, options });
        return this.handle(options?.workflowId);
      },
      signalWithStart: async (workflow: string, options: any) => {
        this.signals.push({ workflow, options });
        return this.handle(options?.workflowId);
      },
      // No workflow is ever running in the test stack.
      list: () => (async function* () {})(),
      count: async () => ({ count: 0 }),
      getHandle: (workflowId: string) => this.handle(workflowId),
    },
    workflowService: {
      describeTaskQueue: async () => ({
        pollers: this.workerPolledAt
          ? [
              {
                lastAccessTime: {
                  seconds: Math.floor(this.workerPolledAt / 1000),
                  nanos: 0,
                },
              },
            ]
          : [],
      }),
    },
    connection: {
      operatorService: {
        listSearchAttributes: async () => ({
          customAttributes: { organizationId: 1, postId: 1 },
        }),
        addSearchAttributes: async () => ({}),
      },
    },
  };

  readonly client = {
    getRawClient: () => this.rawClient,
    getWorkflowHandle: async (workflowId: string) => this.handle(workflowId),
  };

  async terminateWorkflow(workflowId: string) {
    this.terminated.push(workflowId);
    return true;
  }

  /** Emails the backend handed to sendEmailWorkflow, oldest first. */
  emails(): { to: string; subject: string; html: string }[] {
    return this.signals
      .filter((s) => s.workflow === 'sendEmailWorkflow')
      .flatMap((s) => s.options?.signalArgs ?? []);
  }

  /** Publish workflows started for posts, by post id. */
  postWorkflows() {
    return this.started.filter((s) => /^postWorkflowV\d+$/.test(s.workflow));
  }

  reset() {
    this.started = [];
    this.signals = [];
    this.terminated = [];
  }
}
