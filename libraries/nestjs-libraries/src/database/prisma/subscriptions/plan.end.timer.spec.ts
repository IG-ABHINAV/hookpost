import { PlanEndTimer, planEndWorkflowId } from './plan.end.timer';

function setup(startImpl?: () => Promise<any>) {
  const terminate = jest.fn(async () => undefined);
  const start = jest.fn(startImpl ?? (async () => ({})));
  const temporal: any = {
    client: {
      getRawClient: () => ({
        workflow: { start, getHandle: jest.fn(() => ({ terminate })) },
      }),
    },
  };
  return { timer: new PlanEndTimer(temporal), start, terminate };
}

const AT = new Date('2026-11-11T14:30:00Z');

describe('PlanEndTimer', () => {
  it('a date arms one timer per workspace, replacing any running one', async () => {
    const { timer, start } = setup();
    await timer.arm('org-1', 'sub_1', AT);
    expect(start).toHaveBeenCalledWith('planEndWorkflow', {
      workflowId: planEndWorkflowId('org-1'),
      taskQueue: 'main',
      workflowIdConflictPolicy: 'TERMINATE_EXISTING',
      args: [{ organizationId: 'org-1', identifier: 'sub_1' }],
    });
  });

  it("the sweep's re-arm keeps a running timer", async () => {
    const { timer, start } = setup();
    await timer.arm('org-1', 'sub_1', AT, 'keep');
    expect((start.mock.calls[0] as any[])[1].workflowIdConflictPolicy).toBe('USE_EXISTING');
  });

  it('a cleared date stops the timer, and a missing one is no error', async () => {
    const { timer, start, terminate } = setup();
    terminate.mockRejectedValueOnce(new Error('WorkflowNotFoundError'));
    await expect(timer.arm('org-1', 'sub_1', null)).resolves.toBeUndefined();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('only Razorpay plans: Gumroad, marketplace and lifetime codes get no timer', async () => {
    const { timer, start, terminate } = setup();
    for (const id of ['gumroad:sale', 'apimkt:social:u', null, undefined, '']) {
      await timer.arm('org-1', id as any, AT);
    }
    expect(start).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('Temporal down: never throws, the sweep is the backup', async () => {
    const { timer } = setup(async () => {
      throw new Error('14 UNAVAILABLE');
    });
    await expect(timer.arm('org-1', 'sub_1', AT)).resolves.toBeUndefined();
    await expect(new PlanEndTimer(undefined).arm('org-1', 'sub_1', AT)).resolves.toBeUndefined();
  });
});
