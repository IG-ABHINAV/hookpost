// postWorkflowV114: "Remind me to post" sends the reminder and never calls the
// provider; every other post publishes exactly as V113 did. The repo has no
// @temporalio/testing harness, so the workflow APIs are faked and sleep
// returns at once (as in missing.post.workflow.v2.spec.ts).
//   pnpm exec jest -c apps/backend/jest.config.ts post.workflow.v1.1.4

const activities: Record<string, jest.Mock> = {};
const activity = (name: string) =>
  (activities[name] = activities[name] || jest.fn());
const sleep = jest.fn(async () => undefined);
const startChild = jest.fn(async () => undefined);

jest.mock('@temporalio/workflow', () => ({
  proxyActivities: () =>
    new Proxy({}, { get: (_target, name: string) => activity(name) }),
  sleep: (...args: unknown[]) => sleep(...(args as [])),
  startChild: (...args: unknown[]) => startChild(...(args as [])),
  defineSignal: () => 'poke',
  setHandler: () => undefined,
  ActivityFailure: class ActivityFailure extends Error {},
  ApplicationFailure: class ApplicationFailure extends Error {},
}));

import { postWorkflowV114 } from './post.workflow.v1.1.4';

const ORG = 'org-1';
const integration = {
  id: 'int-1',
  organizationId: ORG,
  providerIdentifier: 'instagram',
  name: 'My IG',
  token: 'token',
  refreshNeeded: false,
  disabled: false,
};
const post = (over: Record<string, unknown> = {}) => ({
  id: 'post-1',
  organizationId: ORG,
  state: 'QUEUE',
  publishDate: new Date(Date.now() - 1000),
  settings: '{"__type":"instagram"}',
  intervalInDays: null,
  remind: false,
  integration,
  ...over,
});

const run = () =>
  postWorkflowV114({ taskQueue: 'instagram', postId: 'post-1', organizationId: ORG });

beforeEach(() => {
  // reset in place: the workflow module destructured these at import time
  for (const mock of Object.values(activities)) mock.mockReset();
  jest.clearAllMocks();
  activity('isCommentable').mockResolvedValue(false);
  activity('sendPostReminder').mockResolvedValue(true);
  activity('postSocialPending').mockResolvedValue([
    { id: 'post-1', postId: 'ig-1', releaseURL: 'https://ig/p/1', status: 'success' },
  ]);
  activity('internalPlugs').mockResolvedValue([]);
  activity('globalPlugs').mockResolvedValue([]);
});

describe('postWorkflowV114: remind me to post', () => {
  it('sends the reminder at the scheduled time and never calls the provider', async () => {
    activity('getPost').mockResolvedValue(post({ remind: true }));
    activity('getPostsList').mockResolvedValue([post({ remind: true })]);

    await run();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(activity('sendPostReminder')).toHaveBeenCalledWith(ORG, 'post-1');
    expect(activity('postSocialPending')).not.toHaveBeenCalled();
    expect(activity('updatePost')).not.toHaveBeenCalled();
    expect(activity('sendWebhooks')).not.toHaveBeenCalled();
    expect(activity('changeState')).not.toHaveBeenCalled();
    expect(startChild).not.toHaveBeenCalled();
  });

  it('waits for the scheduled time before sending it', async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000);
    activity('getPost').mockResolvedValue(post({ remind: true, publishDate: at }));
    activity('getPostsList').mockResolvedValue([post({ remind: true })]);
    const order: string[] = [];
    sleep.mockImplementationOnce(async () => {
      order.push('sleep');
    });
    activity('sendPostReminder').mockImplementation(async () => {
      order.push('remind');
      return true;
    });

    await run();

    expect(order).toEqual(['sleep', 'remind']);
    const waited = (sleep.mock.calls[0] as unknown[])[0] as number;
    expect(waited).toBeGreaterThan(59 * 60 * 1000);
  });

  it('sends it even when the channel needs reconnecting: a reminder uses no token', async () => {
    const stale = { ...integration, refreshNeeded: true };
    activity('getPost').mockResolvedValue(post({ remind: true }));
    activity('getPostsList').mockResolvedValue([post({ remind: true, integration: stale })]);

    await run();

    expect(activity('sendPostReminder')).toHaveBeenCalledTimes(1);
    expect(activity('changeState')).not.toHaveBeenCalled();
  });

  it.each(['REMINDER_SENT', 'POSTED_MANUALLY'])(
    'a post already %s is done: no second reminder, never marked ERROR',
    async (state) => {
      activity('getPost').mockResolvedValue(post({ remind: true, state }));

      await run();

      expect(activity('getPostsList')).not.toHaveBeenCalled();
      expect(activity('sendPostReminder')).not.toHaveBeenCalled();
      expect(activity('changeState')).not.toHaveBeenCalled();
    }
  );
});

describe('postWorkflowV114: auto-publish is unchanged (regression)', () => {
  it('publishes through the provider and sends no reminder', async () => {
    activity('getPost').mockResolvedValue(post());
    activity('getPostsList').mockResolvedValue([post()]);

    await run();

    expect(activity('postSocialPending')).toHaveBeenCalledTimes(1);
    expect(activity('updatePost')).toHaveBeenCalledWith('post-1', 'ig-1', 'https://ig/p/1');
    expect(activity('sendWebhooks')).toHaveBeenCalledTimes(1);
    expect(activity('sendPostReminder')).not.toHaveBeenCalled();
  });

  it('still refuses a channel that needs reconnecting', async () => {
    const stale = { ...integration, refreshNeeded: true };
    activity('getPost').mockResolvedValue(post());
    activity('getPostsList').mockResolvedValue([post({ integration: stale })]);

    await run();

    expect(activity('postSocialPending')).not.toHaveBeenCalled();
    expect(activity('changeState')).toHaveBeenCalledWith(
      'post-1',
      'ERROR',
      'Refresh channel needed',
      expect.any(Array)
    );
  });

  it('a published post started again is still "Already posted"', async () => {
    activity('getPost').mockResolvedValue(post({ state: 'PUBLISHED' }));

    await run();

    expect(activity('changeState')).toHaveBeenCalledWith(
      'post-1',
      'ERROR',
      'Already posted',
      expect.any(Array)
    );
  });
});
