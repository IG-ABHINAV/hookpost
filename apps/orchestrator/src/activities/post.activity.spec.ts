import 'reflect-metadata';

// The orchestrator's publish path for an organization with no Subscription
// row, which is the Free plan. These activities used to refuse every such post
// (ERROR "No Post"), so no Free organization had ever published.
//   pnpm exec jest -c apps/backend/jest.config.ts post.activity

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({
    PostsService: class {},
  })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/integrations/integration.manager',
  () => ({
    IntegrationManager: class {},
  })
);
jest.mock(
  '@hookpost/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service',
  () => ({
    WebhooksService: class {},
  })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap',
  () => {
    class XPostCapError extends Error {}
    return { XPostCapError, XPostCapService: class {} };
  }
);
jest.mock('@hookpost/helpers/utils/strip.html.validation', () => ({
  stripHtmlValidation: (_editor: string, content: string) => content,
}));

import { PostActivity } from './post.activity';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';
import { PlanRequiredError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { BadBody } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { XPostCapError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';

const ORG = 'org-free';

const root = {
  id: 'root',
  organizationId: ORG,
  state: 'QUEUE',
  publishDate: new Date(Date.now() + 60_000),
  intervalInDays: null,
  parentPostId: null,
  deletedAt: null,
  content: 'hello',
  integration: { id: 'int', deletedAt: null, disabled: false },
};
const comment = { ...root, id: 'comment', parentPostId: 'root' };

const setup = (
  opts: {
    post?: any;
    posts?: any[];
    publishWithinPlan?: (orgId: string, publish: () => Promise<any>) => any;
    /** XPostCapService.publishWithinXCap; lets every post through by default. */
    publishWithinXCap?: (
      orgId: string,
      provider: string | undefined,
      message: string,
      publish: () => Promise<any>
    ) => any;
    finalizePost?: () => Promise<any>;
    inAppNotification?: () => Promise<any>;
    /** Someone in the workspace has confirmed their email (the default). */
    verified?: boolean;
  } = {}
) => {
  const postsService = {
    workspaceCanPublish: jest.fn(async () => opts.verified ?? true),
    getPostById: jest.fn(async () =>
      'post' in opts ? opts.post : { ...root }
    ),
    getPostsRecursively: jest.fn(
      async () => opts.posts ?? [{ ...root }, { ...comment }]
    ),
    updateTags: jest.fn(async (_org: string, posts: any[]) => posts),
    updateMedia: jest.fn(async () => []),
  };

  const provider = {
    editor: 'normal',
    post: jest.fn(async () => [
      {
        id: 'root',
        postId: 'platform-id',
        releaseURL: 'https://x',
        status: 'success',
      },
    ]),
    comment: jest.fn(async () => [
      {
        id: 'comment',
        postId: 'platform-reply-id',
        releaseURL: 'https://x/reply',
        status: 'success',
      },
    ]),
    finalizePost: jest.fn(
      opts.finalizePost ??
        (async () => ({
          status: 'completed',
          postId: 'VID1',
          releaseURL: 'https://www.youtube.com/watch?v=VID1',
        }))
    ),
  };

  const notificationService = {
    inAppNotification: jest.fn(opts.inAppNotification ?? (async () => undefined)),
  };

  const subscriptionService = {
    // the old gate's lookup: nothing on the publish path may depend on it
    getSubscription: jest.fn(async () => null),
    publishWithinPlan: jest.fn(
      opts.publishWithinPlan ??
        ((_orgId: string, publish: () => Promise<any>) => publish())
    ),
  };

  const xPostCap = {
    publishWithinXCap: jest.fn(
      opts.publishWithinXCap ??
        ((_o: string, _p: string, _m: string, publish: () => Promise<any>) =>
          publish())
    ),
  };

  const temporal = {
    client: {
      getRawClient: () => ({ workflow: { start: jest.fn(async () => null) } }),
    },
  };

  const activity = new PostActivity(
    postsService as any,
    notificationService as any,
    { getSocialIntegration: jest.fn(() => provider) } as any,
    {} as any,
    {} as any,
    {} as any,
    temporal as any,
    subscriptionService as any,
    xPostCap as any
  );

  return {
    activity,
    postsService,
    provider,
    subscriptionService,
    notificationService,
    xPostCap,
  };
};

const integration = {
  id: 'int',
  organizationId: ORG,
  providerIdentifier: 'x',
  internalId: 'x-internal',
  token: 't',
} as any;

const OLD_SECRET = process.env.RAZORPAY_KEY_SECRET;
beforeAll(() => {
  // the gate this replaces only ran with billing on, as in production
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
});
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = OLD_SECRET;
});

describe('getPost', () => {
  it('returns the post of an organization with no Subscription row', async () => {
    const { activity, subscriptionService } = setup();
    const post = await activity.getPost(ORG, 'root');
    expect(post).toMatchObject({ id: 'root', state: 'QUEUE' });
    expect(subscriptionService.getSubscription).not.toHaveBeenCalled();
  });

  it('still refuses a deleted post', async () => {
    const { activity } = setup({ post: { ...root, deletedAt: new Date() } });
    expect(await activity.getPost(ORG, 'root')).toBe(false);
  });

  it('refuses a post that no longer exists instead of throwing', async () => {
    const { activity } = setup({ post: null });
    expect(await activity.getPost(ORG, 'root')).toBe(false);
  });
});

describe('getPostsList', () => {
  it('returns the post and its comments for an organization with no Subscription row', async () => {
    const { activity, subscriptionService } = setup();
    const list = await activity.getPostsList(ORG, 'root');
    expect(list.map((p: any) => p.id)).toEqual(['root', 'comment']);
    expect(subscriptionService.getSubscription).not.toHaveBeenCalled();
  });

  it('still refuses a post whose channel was removed', async () => {
    const { activity } = setup({
      posts: [
        {
          ...root,
          integration: { ...root.integration, deletedAt: new Date() },
        },
      ],
    });
    expect(await activity.getPostsList(ORG, 'root')).toEqual([]);
  });

  it('still refuses a comment passed as the root', async () => {
    const { activity } = setup({ posts: [{ ...comment }] });
    expect(await activity.getPostsList(ORG, 'comment')).toEqual([]);
  });

  it('still refuses when nothing is left to publish', async () => {
    const { activity } = setup({ posts: [] });
    expect(await activity.getPostsList(ORG, 'root')).toEqual([]);
  });
});

describe('postSocial', () => {
  it('publishes a Free post through the plan meter', async () => {
    const { activity, provider, subscriptionService } = setup();
    const result = await activity.postSocial(integration, [{ ...root }] as any);

    expect(result).toEqual([
      expect.objectContaining({ postId: 'platform-id', status: 'success' }),
    ]);
    // The channel's provider goes along, for the X gate (allowsXPublishing).
    expect(subscriptionService.publishWithinPlan).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
      'x'
    );
    expect(provider.post).toHaveBeenCalledTimes(1);
    expect(subscriptionService.getSubscription).not.toHaveBeenCalled();
  });

  it('over the Free allowance: a non-retryable BadBody, and nothing sent to the platform', async () => {
    const { activity, provider } = setup({
      publishWithinPlan: async () => {
        throw new CreditsExceededError('posts');
      },
    });

    const attempt = activity.postSocial(integration, [{ ...root }] as any);
    await expect(attempt).rejects.toBeInstanceOf(BadBody);
    await expect(attempt).rejects.toMatchObject({
      type: 'bad_body',
      nonRetryable: true,
      message: expect.stringContaining('30 posts a month'),
    });
    expect(provider.post).not.toHaveBeenCalled();
  });

  it.each([
    ['TRIAL_REQUIRED', 'Start your 3-day trial to schedule and publish posts.'],
    ['PLAN_REQUIRED', 'Choose a plan to continue.'],
  ] as const)(
    'a workspace that must start its trial or choose a plan (%s): a non-retryable BadBody with that sentence, nothing sent',
    async (code, sentence) => {
      const { activity, provider } = setup({
        publishWithinPlan: async () => {
          throw new PlanRequiredError(code);
        },
      });

      const attempt = activity.postSocial(integration, [{ ...root }] as any);
      await expect(attempt).rejects.toBeInstanceOf(BadBody);
      await expect(attempt).rejects.toMatchObject({
        type: 'bad_body',
        nonRetryable: true,
        message: expect.stringContaining(sentence),
      });
      expect(provider.post).not.toHaveBeenCalled();
    }
  );

  it('runs the X caps inside the plan gate, with the post as the provider gets it', async () => {
    const { activity, xPostCap, subscriptionService } = setup();
    await activity.postSocial(integration, [{ ...root, content: 'see https://hookpost.in' }] as any);
    expect(xPostCap.publishWithinXCap).toHaveBeenCalledWith(
      ORG,
      'x',
      'see https://hookpost.in',
      expect.any(Function)
    );
    // Taken through the plan gate's publish callback: a refused workspace
    // never reaches the X meter.
    expect(subscriptionService.publishWithinPlan.mock.invocationCallOrder[0]).toBeLessThan(
      xPostCap.publishWithinXCap.mock.invocationCallOrder[0]
    );
  });

  it('over an X cap: a non-retryable BadBody with the cap sentence, nothing sent', async () => {
    const { activity, provider } = setup({
      publishWithinXCap: async () => {
        throw new XPostCapError('Your Standard plan includes 50 X posts a month');
      },
    });
    const attempt = activity.postSocial(integration, [{ ...root }] as any);
    await expect(attempt).rejects.toBeInstanceOf(BadBody);
    await expect(attempt).rejects.toMatchObject({
      type: 'bad_body',
      nonRetryable: true,
      message: expect.stringContaining('50 X posts a month'),
    });
    expect(provider.post).not.toHaveBeenCalled();
  });

  it('a platform error still reaches the workflow unchanged', async () => {
    const boom = new Error('rate limited');
    const { activity, provider } = setup();
    provider.post.mockRejectedValueOnce(boom);

    await expect(
      activity.postSocial(integration, [{ ...root }] as any)
    ).rejects.toBe(boom);
  });

  it('passes each channel its own provider, so only X meets the X gate', async () => {
    const { activity, subscriptionService } = setup();
    const linkedin = { ...integration, providerIdentifier: 'linkedin' };
    await activity.postSocial(linkedin, [{ ...root }] as any);
    expect(subscriptionService.publishWithinPlan).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
      'linkedin'
    );
  });
});

describe('postComment', () => {
  it('publishes a Free comment through the plan meter, one credit per call', async () => {
    const { activity, provider, subscriptionService } = setup();
    const result = await activity.postComment(
      'platform-id',
      undefined,
      integration,
      [{ ...comment }] as any
    );

    expect(result).toEqual([
      expect.objectContaining({ postId: 'platform-reply-id' }),
    ]);
    expect(subscriptionService.publishWithinPlan).toHaveBeenCalledTimes(1);
    expect(subscriptionService.publishWithinPlan).toHaveBeenCalledWith(
      ORG,
      expect.any(Function),
      'x'
    );
    expect(provider.comment).toHaveBeenCalledTimes(1);
    expect(provider.comment).toHaveBeenCalledWith(
      'x-internal',
      'platform-id',
      undefined,
      't',
      [expect.objectContaining({ id: 'comment', message: 'hello' })],
      integration
    );
  });

  it('over the Free allowance: a non-retryable BadBody, and no reply sent to the platform', async () => {
    const { activity, provider } = setup({
      publishWithinPlan: async () => {
        throw new CreditsExceededError('posts');
      },
    });

    const attempt = activity.postComment(
      'platform-id',
      undefined,
      integration,
      [{ ...comment }] as any
    );
    await expect(attempt).rejects.toBeInstanceOf(BadBody);
    await expect(attempt).rejects.toMatchObject({
      type: 'bad_body',
      nonRetryable: true,
      message: expect.stringContaining('each comment or thread reply'),
    });
    expect(provider.comment).not.toHaveBeenCalled();
  });

  it('a thread reply takes its own X cap check, with its own text; over the cap no reply is sent', async () => {
    const { activity, provider, xPostCap } = setup({
      publishWithinXCap: async () => {
        throw new XPostCapError('Your Pro plan includes 150 X posts a month');
      },
    });
    const attempt = activity.postComment('platform-id', undefined, integration, [
      { ...comment, content: 'reply two' },
    ] as any);
    await expect(attempt).rejects.toMatchObject({
      type: 'bad_body',
      message: expect.stringContaining('150 X posts a month'),
    });
    expect(xPostCap.publishWithinXCap).toHaveBeenCalledWith(ORG, 'x', 'reply two', expect.any(Function));
    expect(provider.comment).not.toHaveBeenCalled();
  });
});

describe('finalizePost', () => {
  const youtube = {
    ...integration,
    providerIdentifier: 'youtube',
    name: 'Example Channel',
  } as any;
  const coverWarning =
    "YouTube published the video but didn't apply your custom cover, because custom thumbnails need a verified channel.";

  it('passes a clean result through and notifies nobody', async () => {
    const { activity, notificationService } = setup();
    expect(await activity.finalizePost(youtube, {})).toEqual({
      status: 'completed',
      postId: 'VID1',
      releaseURL: 'https://www.youtube.com/watch?v=VID1',
    });
    expect(notificationService.inAppNotification).not.toHaveBeenCalled();
  });

  it('turns a provider warning into one notification and returns the usual shape', async () => {
    const { activity, notificationService } = setup({
      finalizePost: async () => ({
        status: 'completed',
        postId: 'VID1',
        releaseURL: 'https://www.youtube.com/watch?v=VID1',
        warning: coverWarning,
      }),
    });

    const result = await activity.finalizePost(youtube, {});

    // the workflow sees exactly what it always did
    expect(result).toEqual({
      status: 'completed',
      postId: 'VID1',
      releaseURL: 'https://www.youtube.com/watch?v=VID1',
    });
    expect(notificationService.inAppNotification).toHaveBeenCalledTimes(1);
    expect(notificationService.inAppNotification).toHaveBeenCalledWith(
      ORG,
      'Published on Youtube, with a warning',
      `Example Channel: ${coverWarning} https://www.youtube.com/watch?v=VID1`,
      true,
      true,
      'info'
    );
  });

  it('never fails a live post because the notification failed', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { activity } = setup({
      finalizePost: async () => ({
        status: 'completed',
        postId: 'VID1',
        releaseURL: 'https://www.youtube.com/watch?v=VID1',
        warning: coverWarning,
      }),
      inAppNotification: async () => {
        throw new Error('db down');
      },
    });

    await expect(activity.finalizePost(youtube, {})).resolves.toMatchObject({
      status: 'completed',
      postId: 'VID1',
    });
    error.mockRestore();
  });

  it('leaves a still-uploading result alone', async () => {
    const { activity, notificationService } = setup({
      finalizePost: async () => ({
        status: 'pending',
        pendingData: { uploadedBytes: 10 },
      }),
    });

    expect(await activity.finalizePost(youtube, {})).toEqual({
      status: 'pending',
      pendingData: { uploadedBytes: 10 },
    });
    expect(notificationService.inAppNotification).not.toHaveBeenCalled();
  });
});

// Second layer behind PostsService (review of f4bee956b, 25 Oct 2026): a post
// that reaches the publisher by any way at all (the hourly sweep of QUEUE
// posts, a repeating post, a row saved before the gate existed) is not sent
// while nobody in its workspace has confirmed their email.
describe('a workspace in which nobody has confirmed their email', () => {
  it('postSocial: a non-retryable BadBody saying so; nothing sent, no plan credit used', async () => {
    const { activity, provider, subscriptionService, postsService } = setup({ verified: false });
    const attempt = activity.postSocial(integration, [{ ...root }] as any);
    await expect(attempt).rejects.toBeInstanceOf(BadBody);
    await expect(attempt).rejects.toMatchObject({
      type: 'bad_body',
      nonRetryable: true,
      message: expect.stringContaining('Confirm your email address to publish'),
    });
    expect(postsService.workspaceCanPublish).toHaveBeenCalledWith(ORG);
    expect(provider.post).not.toHaveBeenCalled();
    expect(subscriptionService.publishWithinPlan).not.toHaveBeenCalled();
  });

  it('postComment: the same', async () => {
    const { activity, provider, subscriptionService } = setup({ verified: false });
    await expect(
      activity.postComment('platform-id', undefined, integration, [{ ...comment }] as any)
    ).rejects.toBeInstanceOf(BadBody);
    expect(provider.comment).not.toHaveBeenCalled();
    expect(subscriptionService.publishWithinPlan).not.toHaveBeenCalled();
  });

  it('a confirmed workspace publishes through the plan meter as before', async () => {
    const { activity, provider, subscriptionService } = setup({ verified: true });
    await activity.postSocial(integration, [{ ...root }] as any);
    expect(subscriptionService.publishWithinPlan).toHaveBeenCalled();
    expect(provider.post).toHaveBeenCalledTimes(1);
  });
});

describe('plugs are held to the X caps', () => {
  it('processPlug and processInternalPlug pass a guard that goes through XPostCapService.guardPlug', async () => {
    const { activity, xPostCap } = setup();
    (xPostCap as any).guardPlug = jest.fn(async (_o, _p, _t, run) => run());
    const integrationService = {
      processPlugs: jest.fn(async (_data: any, guard: any) =>
        guard({ organizationId: ORG, providerIdentifier: 'x' }, 'plug text', async () => true)
      ),
      processInternalPlug: jest.fn(async (_data: any, _force: boolean, guard: any) =>
        guard({ organizationId: ORG, providerIdentifier: 'x' }, '', async () => undefined)
      ),
    };
    (activity as any)._integrationService = integrationService;

    expect(await activity.processPlug({ plugId: 'p', postId: 'x1', delay: 0, totalRuns: 3, currentRun: 1 })).toBe(true);
    expect((xPostCap as any).guardPlug).toHaveBeenCalledWith(ORG, 'x', 'plug text', expect.any(Function), true);

    await activity.processInternalPlug({ post: 'x1', originalIntegration: 'a', integration: 'b', plugName: 'n', orgId: ORG, delay: 0, information: {} });
    expect((xPostCap as any).guardPlug).toHaveBeenCalledWith(ORG, 'x', '', expect.any(Function), undefined);
  });
});
