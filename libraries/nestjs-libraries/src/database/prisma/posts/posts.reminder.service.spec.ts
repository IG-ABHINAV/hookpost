import 'reflect-metadata';

// "Remind me to post" in PostsService: the reminder page's data
// (GET /posts/:id/reminder), "Mark as posted" (POST /posts/:id/posted-manually),
// the one-reminder claim, and a post posted by hand counting as published.
//   pnpm exec jest -c apps/backend/jest.config.ts posts.reminder.service
import { BadRequestException, NotFoundException } from '@nestjs/common';

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
  organizationId: 'org-a',
  name: 'Sacred Smiles',
  picture: 'https://media.hookstep.in/p.png',
  providerIdentifier: 'instagram',
  token: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  disabled: false,
};

const root = {
  id: 'post-1',
  group: 'group-1',
  parentPostId: null as string | null,
  organizationId: 'org-a',
  content: '<p>Sunset <strong>reel</strong></p><p>#travel</p>',
  image: JSON.stringify([{ id: 'm1', path: 'https://media.hookstep.in/reel.mp4' }]),
  settings: '{"__type":"instagram"}',
  publishDate: new Date('2026-10-30T10:00:00Z'),
  state: 'REMINDER_SENT',
  remind: true,
  deletedAt: null as Date | null,
  integration,
};
const comment = { ...root, id: 'post-2', parentPostId: 'post-1', content: '<p>link in bio</p>' };

const appLink = { name: 'Instagram', app: 'instagram://app', web: 'https://www.instagram.com/' };

const setup = (opts: { provider?: any; counts?: Record<string, number>; existing?: any } = {}) => {
  const repository = {
    // org-scoped like the real query: another workspace's id finds nothing
    getPost: jest.fn(async (id: string, _inc: boolean, orgId?: string) =>
      orgId && orgId !== 'org-a'
        ? null
        : id === 'post-1'
        ? { ...root, childrenPost: [{ id: 'post-2' }] }
        : id === 'post-2'
        ? { ...comment, integration: undefined, childrenPost: [] }
        : null
    ),
    getPostById: jest.fn(async (_id: string, orgId?: string) =>
      orgId === 'org-a' ? opts.existing ?? null : null
    ),
    claimReminder: jest.fn(async () => ({ count: opts.counts?.claim ?? 1 })),
    releaseReminder: jest.fn(async () => ({ count: 1 })),
    markPostedManually: jest.fn(async () => ({ count: opts.counts?.mark ?? 1 })),
  };
  const provider = opts.provider ?? { name: 'Instagram\n(Facebook Business)', appLink };
  const service = new PostsService(
    repository as any,
    { getSocialIntegration: () => provider } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { assertFreePostAllowed: async () => undefined } as any
  );
  jest.spyOn(service, 'updateMedia').mockImplementation(async (_id, list: any[]) =>
    list.map((m: any) => ({ ...m, url: m.path }))
  );
  return { service, repository };
};

describe('PostsService.getReminder (the reminder page)', () => {
  it('gives the caption as plain text, the comments, the files and where to post', async () => {
    const { service } = setup();
    const reminder = await service.getReminder('org-a', 'post-1');
    expect(reminder).toMatchObject({
      id: 'post-1',
      state: 'REMINDER_SENT',
      remind: true,
      platform: 'Instagram',
      appLink,
      comments: ['link in bio'],
      media: [{ url: 'https://media.hookstep.in/reel.mp4', video: true }],
      integration: { name: 'Sacred Smiles', providerIdentifier: 'instagram' },
    });
    expect(reminder.caption).toContain('Sunset');
    expect(reminder.caption).toContain('#travel');
    expect(reminder.caption).not.toMatch(/<[a-z]/i);
  });

  it('never sends the channel tokens to the browser', async () => {
    const { service } = setup();
    const body = JSON.stringify(await service.getReminder('org-a', 'post-1'));
    expect(body).not.toContain('secret-access-token');
    expect(body).not.toContain('secret-refresh-token');
  });

  it("is a 404 for another workspace's post, never its caption or files", async () => {
    const { service } = setup();
    await expect(service.getReminder('org-b', 'post-1')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('is a 404 for a comment id: only the post itself has a reminder page', async () => {
    const { service, repository } = setup();
    repository.getPost.mockImplementationOnce(async () => ({
      ...comment,
      childrenPost: [],
    }));
    await expect(service.getReminder('org-a', 'post-2')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('a channel with no app to open gets no open-the-app button, and its first name line', async () => {
    const { service } = setup({ provider: { name: 'LinkedIn\n(Personal)' } });
    const reminder = await service.getReminder('org-a', 'post-1');
    expect(reminder.appLink).toBeNull();
    expect(reminder.platform).toBe('LinkedIn');
  });
});

describe('PostsService.markPostedManually ("Mark as posted")', () => {
  it('moves a reminder post of this workspace to POSTED_MANUALLY', async () => {
    const { service, repository } = setup();
    await expect(service.markPostedManually('org-a', 'post-1')).resolves.toEqual({
      id: 'post-1',
      state: 'POSTED_MANUALLY',
    });
    expect(repository.markPostedManually).toHaveBeenCalledWith('org-a', 'post-1');
  });

  it("is a 404 for another workspace's post", async () => {
    const { service } = setup({ counts: { mark: 0 } });
    await expect(service.markPostedManually('org-b', 'post-1')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('refuses a post that is not set to remind (or that Hookpost published or that failed)', async () => {
    const { service } = setup({
      counts: { mark: 0 },
      existing: { ...root, remind: false, state: 'PUBLISHED' },
    });
    await expect(service.markPostedManually('org-a', 'post-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
  });
});

describe('PostsService.claimReminder (one reminder per post)', () => {
  it('true for the caller that moved the post, false for every later one', async () => {
    const { service, repository } = setup();
    await expect(service.claimReminder('org-a', 'post-1')).resolves.toBe(true);
    repository.claimReminder.mockResolvedValueOnce({ count: 0 });
    await expect(service.claimReminder('org-a', 'post-1')).resolves.toBe(false);
  });
});

describe('PostsService: a post posted by hand counts as published', () => {
  const saving = (state: string) => {
    const repository = {
      organizationCanPublish: jest.fn(async () => true),
      getPostById: jest.fn(async () => ({ ...root, state })),
      transaction: jest.fn(async (fn: any) => fn({})),
      createOrUpdatePost: jest.fn(async () => ({ posts: [{ id: 'post-1', state }] })),
      changeDate: jest.fn(),
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
    jest.spyOn(service, 'startWorkflow').mockResolvedValue(undefined);
    return { service, repository };
  };
  const body = (type: string, remind?: boolean): any => ({
    type: type as any,
    shortLink: false,
    date: '2026-10-30T10:00:00',
    tags: [] as any[],
    posts: [
      {
        integration: { id: 'int-1' },
        group: 'group-1',
        ...(remind === undefined ? {} : { remind }),
        settings: { __type: 'instagram' } as any,
        value: [{ id: 'post-1', content: '<p>hi</p>', image: [] as any[] }],
      },
    ],
  });

  it('scheduling it again needs republish, like a published post', async () => {
    const { service, repository } = saving('POSTED_MANUALLY');
    await expect(service.createPost('org-a', body('schedule'), 'API')).rejects.toThrow(
      /already published/
    );
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
  });

  it('moving it on the calendar with action schedule needs republish too', async () => {
    const { service, repository } = saving('POSTED_MANUALLY');
    await expect(service.changeDate('org-a', 'post-1', '2026-11-01T10:00:00', 'schedule')).rejects.toThrow(
      /already published/
    );
    expect(repository.changeDate).not.toHaveBeenCalled();
  });

  it('saving it as a draft keeps it posted (saved as an update)', async () => {
    const { service, repository } = saving('POSTED_MANUALLY');
    await service.createPost('org-a', body('draft'), 'API');
    expect((repository.createOrUpdatePost.mock.calls[0] as any[])[0]).toBe('update');
  });

  it('refuses a repeating reminder: it would show on the calendar and never arrive', async () => {
    const { service, repository } = saving('QUEUE');
    await expect(
      service.createPost('org-a', { ...body('schedule', true), inter: 7 }, 'WEB')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.createOrUpdatePost).not.toHaveBeenCalled();
    // repeating without a reminder is untouched
    await service.createPost('org-a', { ...body('schedule', false), inter: 7 }, 'WEB');
    expect(repository.createOrUpdatePost).toHaveBeenCalledTimes(1);
  });

  it('passes remind through to the save, and leaves it out when the client sends none', async () => {
    const { service, repository } = saving('QUEUE');
    await service.createPost('org-a', body('schedule', true), 'API');
    expect((repository.createOrUpdatePost.mock.calls[0] as any[])[3].remind).toBe(true);
    await service.createPost('org-a', body('schedule'), 'MCP');
    expect((repository.createOrUpdatePost.mock.calls[1] as any[])[3]).not.toHaveProperty('remind');
  });
});
