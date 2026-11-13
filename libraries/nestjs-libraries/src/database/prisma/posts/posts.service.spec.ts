import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';

// Only injection tokens; the real modules pull in Prisma, Redis, Temporal,
// storage clients, OpenAI and every social provider.
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.repository', () => ({
  PostsRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/media/media.service', () => ({
  MediaService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/short-linking/short.link.service', () => ({
  ShortLinkService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/openai/openai.service', () => ({
  OpenaiService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/social.abstract', () => ({
  RefreshToken: class extends Error {},
}));
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));
jest.mock('sharp', () => jest.fn());
// The post DTOs sanitise content with isomorphic-dompurify, whose jsdom is ESM
jest.mock('@hookpost/helpers/utils/sanitize.post.content', () => ({
  sanitizePostContent: (html: string) => html,
}));

import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';

const integration = {
  id: 'int-1',
  internalId: 'page-1',
  organizationId: 'org-a',
  name: 'My Page',
  picture: 'https://media.hookstep.in/p.png',
  providerIdentifier: 'facebook',
  type: 'social',
  token: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  tokenExpiration: new Date('2026-12-01T00:00:00Z'),
  customInstanceDetails: 'encrypted',
  profile: 'mypage',
  disabled: false,
};

const rootPost = {
  id: 'post-1',
  group: 'group-1',
  parentPostId: null,
  integrationId: 'int-1',
  organizationId: 'org-a',
  content: 'hello',
  image: '[]',
  settings: '{"__type":"facebook"}',
  publishDate: new Date('2026-10-01T10:00:00Z'),
  state: 'ERROR',
  error: null,
  delay: 0,
  integration,
  tags: [],
};

const comment = {
  ...rootPost,
  id: 'post-2',
  parentPostId: 'post-1',
  content: 'first comment',
};

const setup = () => {
  const repository = {
    getPostsByGroup: jest.fn(async () => [rootPost, comment] as any[]),
    getPost: jest.fn(async (id: string, includeIntegration: boolean) =>
      id === 'post-1'
        ? {
            ...rootPost,
            ...(includeIntegration ? {} : { integration: undefined }),
            childrenPost: [{ id: 'post-2' }],
          }
        : id === 'post-2'
        ? { ...comment, integration: undefined, childrenPost: [] }
        : null
    ),
    getErrorsByPostIds: jest.fn(async () => []),
    getPostsCountsByDates: jest.fn(async () => [] as number[]),
  };
  const integrationService = {
    findFreeDateTime: jest.fn(async () => [] as number[]),
  };
  const service = new PostsService(
    repository as any,
    {} as any,
    integrationService as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { assertFreePostAllowed: async () => undefined } as any
  );
  return { service, repository, integrationService };
};

describe('PostsService: opening a post', () => {
  it('never sends the channel tokens to the browser (GET /posts/group/:group)', async () => {
    const { service } = setup();
    const result = await service.getPostsByGroup('org-a', 'group-1');
    const body = JSON.stringify(result);
    expect(body).not.toContain('secret-access-token');
    expect(body).not.toContain('secret-refresh-token');
    expect(result.posts[0].integration).toEqual({
      id: 'int-1',
      name: 'My Page',
      picture: 'https://media.hookstep.in/p.png',
      providerIdentifier: 'facebook',
      profile: 'mypage',
      disabled: false,
    });
    expect(result.integrationPicture).toBe('https://media.hookstep.in/p.png');
    expect(result.integration).toBe('int-1');
    expect(result.posts).toHaveLength(2);
  });

  it('never sends the channel tokens to the browser (GET /posts/:id)', async () => {
    const { service } = setup();
    const result = await service.getPost('org-a', 'post-1');
    const body = JSON.stringify(result);
    expect(body).not.toContain('secret-access-token');
    expect(body).not.toContain('secret-refresh-token');
    expect(result.posts[0].integration).toMatchObject({ id: 'int-1', name: 'My Page' });
    expect(result.posts).toHaveLength(2);
  });

  it('answers 404, not 500, for a deleted or another organisation\'s post', async () => {
    const { service, repository } = setup();
    repository.getPostsByGroup.mockResolvedValue([]);
    await expect(service.getPostsByGroup('org-a', 'nope')).rejects.toBeInstanceOf(
      NotFoundException
    );
    await expect(
      service.getPostGroupDebugExport('org-a', 'nope')
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.getPost('org-a', 'nope')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('leaves the group out of the debug export, so importing it cannot replace the original', async () => {
    const { service } = setup();
    const result = await service.getPostGroupDebugExport('org-a', 'group-1');
    expect(result.posts[0]).not.toHaveProperty('group');
    expect(result._debug.originalGroup).toBe('group-1');
    expect(result.posts[0].value.map((v) => v.content)).toEqual([
      'hello',
      'first comment',
    ]);
  });
});

describe('PostsService.getPublicPreview (GET /public/posts/:id, no login)', () => {
  it('returns only what the preview page shows', async () => {
    const { service, repository } = setup();
    repository.getPost.mockImplementationOnce(async () => ({
      ...rootPost,
      error:
        '{"stackTrace":"at PostActivity.postSocialBody (/home/hookpost/hookpost/apps/orchestrator/src/activities/post.activity.ts:378:11)"}',
      childrenPost: [{ id: 'post-2' }],
    }));
    const result = await service.getPublicPreview('post-1');
    expect(result).toEqual([
      {
        id: 'post-1',
        content: 'hello',
        image: '[]',
        publishDate: new Date('2026-10-01T10:00:00Z'),
        state: 'ERROR',
        integration: {
          id: 'int-1',
          name: 'My Page',
          picture: 'https://media.hookstep.in/p.png',
          providerIdentifier: 'facebook',
          profile: 'mypage',
        },
      },
      {
        id: 'post-2',
        content: 'first comment',
        image: '[]',
        publishDate: new Date('2026-10-01T10:00:00Z'),
        state: 'ERROR',
      },
    ]);
    const body = JSON.stringify(result);
    for (const leak of ['org-a', 'group-1', 'stackTrace', '__type', 'secret-']) {
      expect(body).not.toContain(leak);
    }
  });

  it('is empty for an unknown or deleted post', async () => {
    const { service } = setup();
    await expect(service.getPublicPreview('nope')).resolves.toEqual([]);
  });
});

describe('PostsService.findFreeDateTime', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-14T08:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('answers at once when the workspace has no posting times', async () => {
    const { service, repository } = setup();
    await expect(service.findFreeDateTime('org-a')).resolves.toBe(
      '2026-10-14T08:10:00'
    );
    expect(repository.getPostsCountsByDates).not.toHaveBeenCalled();
  });

  it('stops after a year when every slot is booked', async () => {
    const { service, repository, integrationService } = setup();
    integrationService.findFreeDateTime.mockResolvedValue([120, 400]);
    await expect(service.findFreeDateTime('org-a')).resolves.toBe(
      '2026-10-14T08:10:00'
    );
    expect(repository.getPostsCountsByDates).toHaveBeenCalledTimes(366);
  });

  it('still returns the first free slot', async () => {
    const { service, repository, integrationService } = setup();
    integrationService.findFreeDateTime.mockResolvedValue([120, 400, 700]);
    repository.getPostsCountsByDates
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([700, 400]);
    await expect(service.findFreeDateTime('org-a')).resolves.toBe(
      '2026-10-15T06:40:00'
    );
  });
});

describe('PostsService: saving from the composer', () => {
  const linkedin = { ...integration, providerIdentifier: 'linkedin' };

  const saving = (existingState?: string) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => true),
      getPostById: jest.fn(async () =>
        existingState ? { ...rootPost, state: existingState } : null
      ),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async (type: string) => ({
        posts: [
          {
            id: 'post-1',
            state: type === 'draft' ? 'DRAFT' : existingState || 'QUEUE',
          },
        ],
      })),
    };
    const provider = {
      checkValidity: jest.fn(async () => true),
      maxLength: () => 3000,
      stripLinks: () => false,
    };
    const service = new PostsService(
      repository as any,
      { getSocialIntegration: () => provider } as any,
      { getIntegrationById: jest.fn(async () => linkedin) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    const startWorkflow = jest
      .spyOn(service, 'startWorkflow')
      .mockResolvedValue(undefined);
    return { service, repository, startWorkflow, provider };
  };

  const draft = {
    type: 'draft' as const,
    shortLink: false,
    date: '2026-10-20T10:00:00',
    tags: [] as any[],
    posts: [
      {
        integration: { id: 'int-1' },
        group: 'group-1',
        settings: { __type: 'linkedin' },
        value: [{ id: 'post-1', content: '<p>hello</p>', image: [] as any[] }],
      },
    ],
  };

  it.each([
    ['<p></p><p></p>', 'Enter in an empty editor'],
    ['<p> </p>', 'spaces only'],
    ['<p>   </p><p></p>', 'spaces and a blank line'],
  ])('flags %s (%s) as empty, as the create DTO does', async (content) => {
    const { service } = saving();
    const [result] = await service.validatePosts('org-a', [
      { integration: { id: 'int-1' }, value: [{ content, image: [] }] },
    ]);
    expect(result.emptyContent).toBe(true);
  });

  it('still accepts text, or an image without text', async () => {
    const { service } = saving();
    const results = await service.validatePosts('org-a', [
      { integration: { id: 'int-1' }, value: [{ content: '<p>hi</p>' }] },
      {
        integration: { id: 'int-1' },
        value: [{ content: '<p></p>', image: [{ path: 'https://x/a.png' }] }],
      },
    ]);
    expect(results.map((r) => r.emptyContent)).toEqual([false, false]);
  });

  it('passes provider notices through without failing validation', async () => {
    const { service, provider } = saving();
    const p: any = provider;
    p.mediaNotices = jest.fn(async () => ['will be posted as a link']);
    const [result] = await service.validatePosts('org-a', [
      {
        integration: { id: 'int-1' },
        value: [{ content: '<p>hi</p>', image: [{ path: 'https://x/a.mp4' }] }],
      },
    ]);
    expect(result.notices).toEqual(['will be posted as a link']);
    expect(result.errors).toBe(true);

    // a provider without notices, or one whose check throws, gives none
    delete p.mediaNotices;
    const [plain] = await service.validatePosts('org-a', [
      { integration: { id: 'int-1' }, value: [{ content: '<p>hi</p>' }] },
    ]);
    expect(plain.notices).toEqual([]);
    p.mediaNotices = jest.fn(async () => {
      throw new Error('HEAD refused');
    });
    const [failed] = await service.validatePosts('org-a', [
      { integration: { id: 'int-1' }, value: [{ content: '<p>hi</p>' }] },
    ]);
    expect(failed.notices).toEqual([]);
    expect(failed.errors).toBe(true);
  });

  it('keeps a published post published when it is saved as a draft', async () => {
    const { service, repository, startWorkflow } = saving('PUBLISHED');
    await service.createPost('org-a', JSON.parse(JSON.stringify(draft)), 'WEB');
    expect(repository.getPostById).toHaveBeenCalledWith('post-1', 'org-a');
    expect((repository.createOrUpdatePost.mock.calls[0] as any[])[0]).toBe(
      'update'
    );
    // a recurring post's schedule keeps running
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('saves no channel when a later one fails before saving', async () => {
    const { service, repository, startWorkflow } = saving();
    // shortlinks work for the first channel and fail for the second
    const convertTextToShortLinks = jest
      .fn()
      .mockImplementationOnce(async (_org: string, messages: string[]) => messages)
      .mockRejectedValueOnce(new Error('shortener down'));
    (service as any)._shortLinkService = { convertTextToShortLinks };
    const body = JSON.parse(JSON.stringify(draft));
    body.type = 'schedule';
    body.shortLink = true;
    body.posts = [
      { ...body.posts[0], value: [{ content: '<p>https://a.example</p>', image: [] }] },
      {
        ...body.posts[0],
        integration: { id: 'int-2' },
        value: [{ content: '<p>https://b.example</p>', image: [] }],
      },
    ];

    await expect(service.createPost('org-a', body, 'WEB')).rejects.toThrow(
      'shortener down'
    );
    expect(convertTextToShortLinks).toHaveBeenCalledTimes(2);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('still saves a scheduled post as a draft', async () => {
    const { service, repository, startWorkflow } = saving('QUEUE');
    await service.createPost('org-a', JSON.parse(JSON.stringify(draft)), 'WEB');
    expect((repository.createOrUpdatePost.mock.calls[0] as any[])[0]).toBe(
      'draft'
    );
    expect(startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'post-1',
      'org-a',
      'DRAFT'
    );
  });
});

describe('PostsService: saving several channels at once (POST /posts)', () => {
  // A transaction that behaves like Postgres: rows written through `tx` only
  // become visible (saved) when the callback resolves; a throw discards them.
  const channels = (failOn?: number, emptyOn?: number) => {
    const saved: string[] = [];
    const events: string[] = [];
    const tx = { id: 'tx-client' };
    let channel = 0;
    const repository = {
      organizationCanPublish: jest.fn(async () => true),
      getPostById: jest.fn(async () => null),
      transaction: jest.fn(async (fn: any) => {
        const pending: string[] = [];
        (tx as any).pending = pending;
        const result = await fn(tx);
        saved.push(...pending);
        events.push('commit');
        return result;
      }),
      createOrUpdatePost: jest.fn(async (...args: any[]) => {
        channel++;
        if (args[8] !== tx) {
          throw new Error('wrote outside the transaction');
        }
        if (channel === failOn) {
          throw new Error('Unique constraint failed on the fields: (`id`)');
        }
        if (channel === emptyOn) {
          return { posts: [] as any[] };
        }
        const id = `post-of-${args[3].integration.id}`;
        (tx as any).pending.push(id);
        return { posts: [{ id, state: 'QUEUE' }] };
      }),
    };
    const service = new PostsService(
      repository as any,
      { getSocialIntegration: () => ({ stripLinks: () => false }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    const startWorkflow = jest
      .spyOn(service, 'startWorkflow')
      .mockImplementation(async (_queue, postId) => {
        events.push(`start ${postId}`);
      });
    return { service, repository, startWorkflow, saved, events };
  };

  const body = (type = 'schedule') =>
    ({
      type,
      shortLink: false,
      date: '2026-10-20T10:00:00',
      tags: [] as any[],
      posts: ['int-1', 'int-2', 'int-3'].map((id) => ({
        integration: { id },
        group: 'group-1',
        settings: { __type: 'linkedin-page' },
        value: [{ content: '<p>hello</p>', image: [] as any[] }],
      })),
    } as any);

  it('saves nothing and starts no workflow when channel 2 fails to save', async () => {
    const { service, repository, startWorkflow, saved } = channels(2);
    await expect(service.createPost('org-a', body(), 'WEB')).rejects.toThrow(
      'Unique constraint failed'
    );
    expect(repository.transaction).toHaveBeenCalledTimes(1);
    // channel 1 was written, then rolled back with channel 2
    expect(repository.createOrUpdatePost).toHaveBeenCalledTimes(2);
    expect(saved).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('saves every channel in one transaction, then starts every workflow', async () => {
    const { service, repository, startWorkflow, saved, events } = channels();
    await expect(service.createPost('org-a', body(), 'WEB')).resolves.toEqual([
      { postId: 'post-of-int-1', integration: 'int-1' },
      { postId: 'post-of-int-2', integration: 'int-2' },
      { postId: 'post-of-int-3', integration: 'int-3' },
    ]);
    expect(repository.transaction).toHaveBeenCalledTimes(1);
    expect(saved).toEqual(['post-of-int-1', 'post-of-int-2', 'post-of-int-3']);
    expect(events).toEqual([
      'commit',
      'start post-of-int-1',
      'start post-of-int-2',
      'start post-of-int-3',
    ]);
    expect(startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'post-of-int-1',
      'org-a',
      'QUEUE'
    );
  });

  it('keeps every saved channel and starts the rest when one workflow fails to start', async () => {
    const { service, startWorkflow, saved, events } = channels();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    startWorkflow
      .mockImplementationOnce(() => {
        throw new Error('temporal unreachable');
      })
      .mockImplementationOnce(async () => {
        throw new Error('workflow start rejected');
      });
    try {
      const result = await service.createPost('org-a', body(), 'WEB');
      await new Promise((resolve) => setImmediate(resolve));

      expect(result.map((r) => r.postId)).toEqual([
        'post-of-int-1',
        'post-of-int-2',
        'post-of-int-3',
      ]);
      expect(saved).toHaveLength(3);
      expect(startWorkflow).toHaveBeenCalledTimes(3);
      expect(events).toEqual(['commit', 'start post-of-int-3']);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.map(([message]) => message)).toEqual([
        'Could not start the publish workflow of post post-of-int-1',
        'Could not start the publish workflow of post post-of-int-2',
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps none of the channels when one saves nothing, and answers [] as before', async () => {
    const { service, startWorkflow, saved } = channels(undefined, 3);
    await expect(service.createPost('org-a', body(), 'WEB')).resolves.toEqual(
      []
    );
    expect(saved).toEqual([]);
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('logs a workflow that Temporal refuses to start, without throwing', async () => {
    const start = jest.fn(async () => {
      throw new Error('namespace not found');
    });
    const temporal = {
      client: {
        getRawClient: () => ({
          workflow: {
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            list: async function* () {},
            start,
          },
        }),
      },
    };
    const service = new PostsService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      temporal as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        service.startWorkflow('linkedin', 'post-1', 'org-a', 'QUEUE')
      ).resolves.toBeUndefined();
      expect(start).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe(
        'Could not start the publish workflow of post post-1'
      );
    } finally {
      log.mockRestore();
    }
  });

  it('still starts no workflow for an update', async () => {
    const { service, repository, startWorkflow, saved } = channels();
    // An update changes posts that exist (since 25 Oct 2026 it cannot create one).
    repository.getPostById.mockResolvedValue({ id: 'existing', state: 'QUEUE' } as any);
    const update = body('update');
    update.posts.forEach((p: any, i: number) => (p.value[0].id = `existing-${i}`));
    await service.createPost('org-a', update, 'WEB');
    expect(saved).toHaveLength(3);
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe('PostsService: publishing a file that was purged from storage', () => {
  const REMOVED =
    "This post's video/image was removed from storage. Upload it again before retrying.";
  const DEAD = 'https://media.hookstep.in/SqkI7X8hpR.mp4';
  const LIVE = 'https://media.hookstep.in/Ab3dE6gH9j.png';
  const images = (...paths: string[]) => JSON.stringify(paths.map((path) => ({ id: path, path })));

  const purged = (
    missing: string[],
    group: any[] = [
      { ...rootPost, image: images(DEAD) },
      { ...comment, image: '[]' },
    ]
  ) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => true),
      getPostById: jest.fn(async () => ({ ...group[0], integration })),
      getPostsByGroup: jest.fn(async () => group),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async () => ({
        posts: [{ id: 'post-1', state: 'QUEUE' }],
      })),
      changeDate: jest.fn(async () => ({ date: 'ok' })),
      changeState: jest.fn(async () => ({})),
    };
    const service = new PostsService(
      repository as any,
      { getSocialIntegration: () => ({ stripLinks: () => false }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    const startWorkflow = jest
      .spyOn(service, 'startWorkflow')
      .mockResolvedValue(undefined);
    const findMissingMedia = jest
      .spyOn(service, 'findMissingMedia')
      .mockImplementation(async (paths) =>
        (paths as string[]).filter((path) => missing.includes(path))
      );
    return { service, repository, startWorkflow, findMissingMedia };
  };

  const save = (type: string, ...paths: string[]) => ({
    type: type as any,
    shortLink: false,
    date: '2026-10-20T10:00:00',
    tags: [] as any[],
    posts: [
      {
        integration: { id: 'int-1' },
        group: 'group-1',
        settings: { __type: 'facebook' } as any,
        value: [
          { id: 'post-1', content: '<p>hi</p>', image: [{ id: 'a', path: LIVE }] },
          {
            id: 'post-2',
            content: '<p>comment</p>',
            image: paths.map((path) => ({ id: path, path })),
          },
        ],
      },
    ],
  });

  it.each(['schedule', 'now'])(
    'refuses to %s with a file that is gone, and saves nothing',
    async (type) => {
      const { service, repository, startWorkflow } = purged([DEAD]);
      await expect(
        service.createPost('org-a', save(type, DEAD) as any, 'WEB')
      ).rejects.toThrow(REMOVED);
      expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
      expect(startWorkflow).not.toHaveBeenCalled();
    }
  );

  it('answers a published post saved as schedule with the republish rule, not "upload again"', async () => {
    const published = [
      { ...rootPost, state: 'PUBLISHED', image: images(DEAD) },
      { ...comment, state: 'PUBLISHED', image: '[]' },
    ];
    const { service, repository, findMissingMedia } = purged([DEAD], published);
    await expect(
      service.createPost('org-a', save('schedule', DEAD) as any, 'WEB')
    ).rejects.toThrow(/already published.*use type 'update'/);
    expect(findMissingMedia).not.toHaveBeenCalled();
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();

    // asked to publish it again on purpose, the file still has to exist
    const again = purged([DEAD], published);
    await expect(
      again.service.createPost(
        'org-a',
        { ...save('schedule', DEAD), republish: true } as any,
        'WEB'
      )
    ).rejects.toThrow(REMOVED);
    expect(again.repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('refuses before making any shortlink', async () => {
    const { service } = purged([DEAD]);
    const convertTextToShortLinks = jest.fn(async (_org: string, m: string[]) => m);
    (service as any)._shortLinkService = { convertTextToShortLinks };
    await expect(
      service.createPost(
        'org-a',
        { ...save('schedule', DEAD), shortLink: true } as any,
        'WEB'
      )
    ).rejects.toThrow(REMOVED);
    expect(convertTextToShortLinks).not.toHaveBeenCalled();
  });

  it('checks every file of the post and its comments', async () => {
    const { service, findMissingMedia } = purged([]);
    await service.createPost('org-a', save('schedule', DEAD) as any, 'WEB');
    expect(findMissingMedia).toHaveBeenCalledWith([LIVE, DEAD]);
  });

  it.each(['draft', 'update'])(
    'never holds up a %s, which does not publish',
    async (type) => {
      const { service, repository, findMissingMedia } = purged([DEAD]);
      await service.createPost('org-a', save(type, DEAD) as any, 'WEB');
      expect(findMissingMedia).not.toHaveBeenCalled();
      expect(repository.createOrUpdatePost).toHaveBeenCalled();
    }
  );

  it('never blocks a link to another site, even one that is gone', async () => {
    const previous = process.env.CLOUDFLARE_BUCKET_URL;
    process.env.CLOUDFLARE_BUCKET_URL = 'https://media.hookstep.in';
    // the other site's file really is gone; ours is still there
    const head = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url) => ({ status: url === LIVE ? 200 : 404 } as Response)
      );
    try {
      const { service, repository, findMissingMedia } = purged([]);
      findMissingMedia.mockRestore();
      await service.createPost(
        'org-a',
        save('schedule', 'https://cdn.example.com/gone.mp4') as any,
        'WEB'
      );
      expect(repository.createOrUpdatePost).toHaveBeenCalled();
      // only our own file was asked about
      expect(head.mock.calls.map(([url]) => url)).toEqual([LIVE]);
    } finally {
      head.mockRestore();
      process.env.CLOUDFLARE_BUCKET_URL = previous;
    }
  });

  it.each(['ERROR', 'QUEUE'])(
    'refuses to requeue (calendar move) a %s post whose file is gone',
    async (state) => {
      const { service, repository, startWorkflow } = purged([DEAD], [
        { ...rootPost, state, image: images(DEAD) },
        { ...comment, state, image: '[]' },
      ]);
      await expect(
        service.changeDate('org-a', 'post-1', '2026-10-20T10:00:00', 'schedule')
      ).rejects.toThrow(REMOVED);
      expect(repository.changeDate).not.toHaveBeenCalled();
      expect(startWorkflow).not.toHaveBeenCalled();
    }
  );

  it('lets a draft whose file is gone be moved on the calendar: it stays a draft', async () => {
    const { service, repository, findMissingMedia, startWorkflow } = purged(
      [DEAD],
      [
        { ...rootPost, state: 'DRAFT', image: images(DEAD) },
        { ...comment, state: 'DRAFT', image: '[]' },
      ]
    );
    await service.changeDate('org-a', 'post-1', '2026-10-20T10:00:00', 'schedule');
    expect(findMissingMedia).not.toHaveBeenCalled();
    expect(repository.changeDate).toHaveBeenCalledWith(
      'org-a',
      'post-1',
      '2026-10-20T10:00:00',
      true,
      'schedule'
    );
    expect(startWorkflow).toHaveBeenCalledWith(
      'facebook',
      'post-1',
      'org-a',
      'DRAFT'
    );
  });

  it("checks the post's comments too, but not another channel's posts in the group", async () => {
    const inComment = purged([DEAD], [
      { ...rootPost, image: '[]' },
      { ...comment, image: images(DEAD) },
    ]);
    await expect(
      inComment.service.changeDate('org-a', 'post-1', '2026-10-20T10:00:00', 'schedule')
    ).rejects.toThrow(REMOVED);

    const otherChannel = purged([DEAD], [
      { ...rootPost, image: '[]' },
      { ...rootPost, id: 'post-9', integrationId: 'int-2', image: images(DEAD) },
    ]);
    await otherChannel.service.changeDate(
      'org-a',
      'post-1',
      '2026-10-20T10:00:00',
      'schedule'
    );
    expect(otherChannel.repository.changeDate).toHaveBeenCalled();
  });

  it('still moves the date only (action update) without checking', async () => {
    const { service, repository, findMissingMedia } = purged([DEAD]);
    await service.changeDate('org-a', 'post-1', '2026-10-20T10:00:00', 'update');
    expect(findMissingMedia).not.toHaveBeenCalled();
    expect(repository.changeDate).toHaveBeenCalled();
  });

  it('refuses to requeue it through the public API status change, but not to draft it', async () => {
    const { service, repository } = purged([DEAD]);
    await expect(
      service.changePostStatus('org-a', 'post-1', 'schedule')
    ).rejects.toThrow(REMOVED);
    expect(repository.changeState).not.toHaveBeenCalled();

    await service.changePostStatus('org-a', 'post-1', 'draft');
    expect(repository.changeState).toHaveBeenCalledWith('post-1', 'DRAFT');
  });
});

// Since 25 Oct 2026 a password sign-up is signed in before it confirms its
// email. Nothing from its workspace is published until someone there has
// confirmed theirs, by any route that ends in PostsService (composer, public
// API, MCP, CLI, autopost); drafts are saved as before.
describe('PostsService: a workspace in which nobody has confirmed their email', () => {
  const unverified = (verified = false) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => verified),
      getPostById: jest.fn(async () => ({ ...rootPost, state: 'QUEUE', integration })),
      getPostsByGroup: jest.fn(async () => [rootPost]),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async (type: string) => ({
        posts: [{ id: 'post-1', state: type === 'draft' ? 'DRAFT' : 'QUEUE' }],
      })),
      changeDate: jest.fn(async () => ({ date: 'ok' })),
      changeState: jest.fn(async () => ({})),
    };
    const media = { findMissingMedia: jest.fn(async () => [] as string[]) };
    const service = new PostsService(
      repository as any,
      { getSocialIntegration: () => ({ stripLinks: () => false }) } as any,
      {} as any,
      media as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    const startWorkflow = jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined);
    return { service, repository, startWorkflow };
  };
  const body = (type: 'draft' | 'schedule' | 'now') =>
    ({
      type,
      shortLink: false,
      date: '2026-10-30T10:00:00',
      tags: [],
      posts: [
        {
          integration: { id: 'int-1' },
          group: 'group-1',
          settings: { __type: 'facebook' },
          value: [{ id: 'new-1', content: 'hello', image: [] }],
        },
      ],
    } as any);
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (e: any) {
      return { status: e.getStatus?.(), body: e.getResponse?.() };
    }
    return null;
  };

  it.each(['schedule', 'now'] as const)('refuses %s with 403 EMAIL_NOT_VERIFIED and saves nothing', async (type) => {
    const { service, repository, startWorkflow } = unverified();
    expect(await refusal(service.createPost('org-a', body(type), 'WEB'))).toEqual({
      status: 403,
      body: expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' }),
    });
    expect(repository.organizationCanPublish).toHaveBeenCalledWith('org-a');
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });

  it('the same for the public API, MCP and the CLI: they call createPost with their own creation method', async () => {
    const { service, repository } = unverified();
    for (const method of ['API', 'MCP', 'AUTOPOST'] as any[]) {
      expect((await refusal(service.createPost('org-a', body('schedule'), method)))?.status).toBe(403);
    }
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('a draft is saved, and its workflow (which publishes nothing) starts as before', async () => {
    const { service, repository } = unverified();
    await expect(service.createPost('org-a', body('draft'), 'WEB')).resolves.toHaveLength(1);
    expect(repository.organizationCanPublish).not.toHaveBeenCalled();
    expect(repository.createOrUpdatePost).toHaveBeenCalledWith(
      'draft', 'org-a', expect.anything(), expect.anything(), expect.anything(), 'WEB',
      undefined, false, expect.anything()
    );
  });

  it('the public API cannot turn a draft into a scheduled post either', async () => {
    const { service, repository } = unverified();
    expect((await refusal(service.changePostStatus('org-a', 'post-1', 'schedule')))?.status).toBe(403);
    expect(repository.changeState).not.toHaveBeenCalled();
    await service.changePostStatus('org-a', 'post-1', 'draft');
    expect(repository.changeState).toHaveBeenCalledWith('post-1', 'DRAFT');
  });

  it('nor can rescheduling a queued post on the calendar', async () => {
    const { service, repository } = unverified();
    expect(
      (await refusal(service.changeDate('org-a', 'post-1', '2026-10-31T10:00:00', 'schedule')))?.status
    ).toBe(403);
    expect(repository.changeDate).not.toHaveBeenCalled();
  });

  it('a draft moved on the calendar stays a draft and is not refused', async () => {
    const { service, repository } = unverified();
    repository.getPostById.mockResolvedValue({ ...rootPost, state: 'DRAFT', integration } as any);
    await service.changeDate('org-a', 'post-1', '2026-10-31T10:00:00', 'schedule');
    expect(repository.changeDate).toHaveBeenCalled();
    expect(repository.organizationCanPublish).not.toHaveBeenCalled();
  });

  it('once someone in the workspace has confirmed, it publishes', async () => {
    const { service, startWorkflow } = unverified(true);
    await expect(service.createPost('org-a', body('schedule'), 'WEB')).resolves.toHaveLength(1);
    expect(startWorkflow).toHaveBeenCalled();
  });
});

// Review of f4bee956b (25 Oct 2026): createPost published anything that was
// not exactly 'draft', 'schedule' or 'now' without the email check (the public
// API overwrote the validated type with the raw one), and type 'update' could
// create a new root post that Prisma saved as QUEUE.
describe('PostsService.createPost: only the four types, and update only updates', () => {
  const service = (verified = true, existing: any = null) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => verified),
      getPostById: jest.fn(async () => existing),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async (type: string) => ({
        posts: [{ id: 'post-1', state: type === 'draft' ? 'DRAFT' : 'QUEUE' }],
      })),
    };
    const svc = new PostsService(
      repository as any,
      { getSocialIntegration: () => ({ stripLinks: () => false }) } as any,
      {} as any,
      { findMissingMedia: jest.fn(async () => []) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { assertFreePostAllowed: async () => undefined } as any
    );
    jest.spyOn(svc, 'startWorkflow').mockResolvedValue(undefined);
    return { svc, repository };
  };
  const body = (type: any, id = 'p-1') =>
    ({
      ...(type === undefined ? {} : { type }),
      shortLink: false,
      date: '2026-10-30T10:00:00',
      tags: [],
      posts: [
        {
          integration: { id: 'int-1' },
          group: 'g-1',
          settings: { __type: 'facebook' },
          value: [{ id, content: 'hello', image: [] }],
        },
      ],
    } as any);
  const status = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e: any) {
      return e.getStatus?.() ?? 'threw';
    }
    return 'saved';
  };

  it.each([undefined, 'whatever', '', 'DRAFT', 'publish'])('type %p is a 400 and nothing is saved', async (type) => {
    const { svc, repository } = service();
    expect(await status(svc.createPost('org-a', body(type), 'API'))).toBe(400);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it("'update' of a post that does not exist in this workspace is a 400", async () => {
    const { svc, repository } = service(true, null);
    expect(await status(svc.createPost('org-a', body('update', 'unknown-id'), 'WEB'))).toBe(400);
    expect(repository.getPostById).toHaveBeenCalledWith('unknown-id', 'org-a');
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it("'update' without a post id is a 400", async () => {
    const { svc, repository } = service(true, null);
    const b = body('update');
    delete b.posts[0].value[0].id;
    expect(await status(svc.createPost('org-a', b, 'WEB'))).toBe(400);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it("'update' of an existing post saves it", async () => {
    const { svc, repository } = service(true, { id: 'p-1', state: 'QUEUE' });
    expect(await status(svc.createPost('org-a', body('update'), 'WEB'))).toBe('saved');
    expect(repository.createOrUpdatePost).toHaveBeenCalled();
  });

  it("anything but a draft meets the email check, 'update' included", async () => {
    const { svc, repository } = service(false, { id: 'p-1', state: 'DRAFT' });
    expect(await status(svc.createPost('org-a', body('update'), 'WEB'))).toBe(403);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
    expect(await status(svc.createPost('org-a', body('draft'), 'WEB'))).toBe('saved');
  });

  it('workspaceCanPublish answers for the orchestrator', async () => {
    expect(await service(true).svc.workspaceCanPublish('org-a')).toBe(true);
    expect(await service(false).svc.workspaceCanPublish('org-a')).toBe(false);
  });
});

// 28 Oct 2026: a new sign-up's FREE_POST_LIMIT free posts are held where every
// post arrives (SubscriptionService.assertFreePostAllowed).
describe('PostsService: a workspace on its free posts', () => {
  const setupFree = (gate: (orgId: string, save: any) => Promise<void>) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => true),
      // post-1 is the workspace's; post-gone was deleted; anything else is a
      // random id the composer gave a new value (makeId).
      getPostById: jest.fn(async (id: string) =>
        id === 'post-1'
          ? { id, state: 'QUEUE', deletedAt: null, integrationId: 'int-2' }
          : id === 'post-gone'
          ? { id, state: 'QUEUE', deletedAt: new Date() }
          : null
      ),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async (...args: any[]) => ({
        posts: [{ id: `post-of-${args[3].integration.id}`, state: 'QUEUE' }],
      })),
    };
    const subscriptions = { assertFreePostAllowed: jest.fn(gate) };
    const service = new PostsService(
      repository as any,
      { getSocialIntegration: () => ({ stripLinks: () => false }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      subscriptions as any
    );
    const startWorkflow = jest
      .spyOn(service, 'startWorkflow')
      .mockImplementation(async () => undefined);
    return { service, repository, subscriptions, startWorkflow };
  };

  const save = (over: Record<string, any> = {}, ids: Array<string | undefined> = [undefined, undefined]) =>
    ({
      type: 'schedule',
      shortLink: false,
      date: '2026-11-01T09:00:00',
      tags: [] as any[],
      ...over,
      posts: ids.map((id, i) => ({
        integration: { id: `int-${i + 1}` },
        settings: { __type: 'linkedin-page' },
        value: [{ id, content: '<p>hello</p>', image: [] as any[] }],
      })),
    } as any);

  it('asks once per save, with the date every channel shares: a new post', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save(), 'WEB');
    expect(subscriptions.assertFreePostAllowed).toHaveBeenCalledTimes(1);
    expect(subscriptions.assertFreePostAllowed).toHaveBeenCalledWith('org-a', {
      newPost: true,
      repeats: false,
      // The save's channels, for "a channel gives its free posts once".
      channelsGainingPosts: expect.any(Function),
    });
    expect(await subscriptions.assertFreePostAllowed.mock.calls[0][1].channelsGainingPosts()).toEqual([
      'int-1',
      'int-2',
    ]);
  });

  it('passes every channel of the save, for the channel check', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({}, ['p1', 'p2', 'p3']), 'WEB');
    expect(await subscriptions.assertFreePostAllowed.mock.calls[0][1].channelsGainingPosts()).toEqual([
      'int-1',
      'int-2',
      'int-3',
    ]);
  });

  it('the composer gives every new value a random id: still a new post', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({}, ['kq3ZpX81aB', 'Vt0LmN44zQ']), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[0][1]).toMatchObject({ newPost: true });
  });

  it('the id of a deleted post is not an edit either', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({}, ['post-gone', undefined]), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[0][1]).toMatchObject({ newPost: true });
  });

  it('drafts count too', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({ type: 'draft' }), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[0][1]).toMatchObject({ newPost: true });
  });

  it('an edit of a post it has is not a new one, whichever channel carries it', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({}, [undefined, 'post-1']), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[0][1]).toMatchObject({ newPost: false });
  });

  it('the channel check gets only the channels a post moves onto: none for an edit in place', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    const gaining = async (call: number) =>
      subscriptions.assertFreePostAllowed.mock.calls[call][1].channelsGainingPosts();
    // post-1 is on int-2, and the save keeps it there.
    await service.createPost('org-a', save({}, [undefined, 'post-1']), 'WEB');
    expect(await gaining(0)).toEqual(['int-1']);
    // The same post saved on int-1 is moved there (createOrUpdatePost
    // connects the channel the save names).
    await service.createPost('org-a', save({}, ['post-1']), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[1][1].newPost).toBe(false);
    expect(await gaining(1)).toEqual(['int-1']);
    // A deleted post's id is a new post on its channel.
    await service.createPost('org-a', save({}, ['post-gone']), 'WEB');
    expect(await gaining(2)).toEqual(['int-1']);
  });

  it('Repeat Post is passed on', async () => {
    const { service, subscriptions } = setupFree(async () => undefined);
    await service.createPost('org-a', save({ type: 'now', inter: 7 }), 'WEB');
    expect(subscriptions.assertFreePostAllowed.mock.calls[0][1].repeats).toBe(true);
  });

  it('the 4th post: the 402 reaches the caller, nothing is saved, no workflow starts', async () => {
    const { PlanRequiredError } = jest.requireActual(
      '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error'
    );
    const { service, repository, startWorkflow } = setupFree(async () => {
      throw new PlanRequiredError('FREE_POSTS_USED');
    });
    await expect(service.createPost('org-a', save(), 'WEB')).rejects.toMatchObject({
      code: 'FREE_POSTS_USED',
      status: 402,
    });
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe('PostsService.validatePosts: X links on a plan without them', () => {
  const build = (providerIdentifier: string, blocked: boolean) => {
    const provider = {
      checkValidity: jest.fn(async () => true),
      maxLength: () => 280,
      stripLinks: () => false,
    };
    const xLinksBlocked = jest.fn(async () => blocked);
    const service = new PostsService(
      {} as any,
      { getSocialIntegration: () => provider } as any,
      {
        getIntegrationById: jest.fn(async () => ({
          ...integration,
          providerIdentifier,
        })),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { xLinksBlocked } as any
    );
    return { service, xLinksBlocked };
  };
  const post = (content: string) => [
    { integration: { id: 'int-1' }, value: [{ content, image: [] }] },
  ];
  const saved = process.env.STRIP_LINKS_FROM_X_POSTS;
  beforeEach(() => {
    delete process.env.STRIP_LINKS_FROM_X_POSTS;
  });
  afterAll(() => {
    if (saved !== undefined) process.env.STRIP_LINKS_FROM_X_POSTS = saved;
  });

  it('an X post with a link is refused with the plain sentence, in the composer and on create', async () => {
    const { service } = build('x', true);
    const [result] = await service.validatePosts(
      'org-a',
      post('<p>read this https://hookpost.in/blog</p>')
    );
    expect(result.errors).toBe(
      "Links on X aren't included in your plan — remove the link"
    );
  });

  it('an X post without a link, and a link on another platform, pass', async () => {
    const plain = build('x', true);
    const [x] = await plain.service.validatePosts('org-a', post('<p>no link here</p>'));
    expect(x.errors).toBe(true);
    const other = build('linkedin', true);
    const [li] = await other.service.validatePosts(
      'org-a',
      post('<p>https://hookpost.in</p>')
    );
    expect(li.errors).toBe(true);
    expect(other.xLinksBlocked).not.toHaveBeenCalled();
  });

  it('a plan that has X link posts keeps them', async () => {
    const { service } = build('x', false);
    const [result] = await service.validatePosts(
      'org-a',
      post('<p>https://hookpost.in</p>')
    );
    expect(result.errors).toBe(true);
  });
});
