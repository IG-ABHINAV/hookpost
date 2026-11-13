import 'reflect-metadata';
import { PostsRepository } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.repository';
import { NotFoundException } from '@nestjs/common';

// The repository only needs PrismaRepository as an injection token; the real
// module opens a database connection. The test hands in a fake comments model.
jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));

const rows = [
  {
    id: 'c-1',
    content: 'Looks good',
    organizationId: 'org-agency',
    postId: 'post-1',
    userId: 'user-1',
    createdAt: new Date('2026-10-01T10:00:00Z'),
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    deletedAt: null,
  },
  {
    id: 'c-2',
    content: 'removed',
    organizationId: 'org-agency',
    postId: 'post-1',
    userId: 'user-2',
    createdAt: new Date('2026-10-01T11:00:00Z'),
    updatedAt: new Date('2026-10-01T11:00:00Z'),
    deletedAt: new Date('2026-10-02T00:00:00Z'),
  },
];

// Just enough of Prisma's findMany: equality in `where` (null included) and
// `select`.
const findMany = jest.fn(async ({ where, select }: any) =>
  rows
    .filter((row: any) =>
      Object.entries(where).every(([key, value]) => row[key] === value)
    )
    .map((row: any) =>
      select
        ? Object.fromEntries(
            Object.keys(select).map((key) => [key, row[key]])
          )
        : row
    )
);

describe('PostsRepository.getComments (GET /public/posts/:id/comments, no login)', () => {
  it('returns live comments without the workspace id', async () => {
    const repository = new PostsRepository(
      {} as any,
      {} as any,
      { model: { comments: { findMany } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await expect(repository.getComments('post-1')).resolves.toEqual([
      {
        id: 'c-1',
        content: 'Looks good',
        userId: 'user-1',
        createdAt: new Date('2026-10-01T10:00:00Z'),
      },
    ]);
  });
});

describe('PostsRepository calendar lists (GET /posts, GET /posts/list)', () => {
  // As stored by the worker: Temporal failure JSON with a stack trace and
  // server paths, cut off at 4000 characters so it no longer parses.
  const storedFailure =
    JSON.stringify({
      cause: {
        failure: {
          message:
            'The account is missing some permissions to perform this action, please re-add the account and allow all permissions',
          source: 'TypeScriptSDK',
          stackTrace:
            'Error: x\n    at FacebookProvider.post (/home/app/hookpost/libraries/nestjs-libraries/src/integrations/social/facebook.provider.ts:10:5)',
        },
      },
    }).slice(0, 260) + '… [truncated]';

  const row = (state: string, error: string | null) => ({
    id: `post-${state}`,
    content: 'hello',
    publishDate: new Date('2026-10-08T05:35:00Z'),
    state,
    intervalInDays: null,
    error,
    tags: [],
    integration: { id: 'int-1' },
  });

  const repositoryWith = (rows: any[]) => {
    const findMany = jest.fn(async () => rows);
    const count = jest.fn(async () => rows.length);
    const repository = new PostsRepository(
      { model: { post: { findMany, count } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, findMany };
  };

  it('sends why a post failed, without the stack trace', async () => {
    const { repository, findMany } = repositoryWith([
      row('ERROR', storedFailure),
      row('ERROR', 'No Post'),
      row('PUBLISHED', '{"cause":{"failure":{"message":"fetch failed"}}}'),
    ]);
    const posts = await repository.getPosts('org-1', {
      startDate: '2026-10-04T18:30:00Z',
      endDate: '2026-10-11T18:29:59Z',
    } as any);

    expect(posts.map((p: any) => p.error)).toEqual([
      'The account is missing some permissions to perform this action, please re-add the account and allow all permissions',
      null,
      null,
    ]);
    expect(JSON.stringify(posts)).not.toContain('/home/');
    expect((findMany.mock.calls[0] as any)[0].select.error).toBe(true);
  });

  it('sends the same reason in the list view', async () => {
    const { repository, findMany } = repositoryWith([
      row('ERROR', storedFailure),
    ]);
    const { posts } = await repository.getPostsList('org-1', {} as any);

    expect(posts[0].error).toMatch(/^The account is missing some permissions/);
    expect((findMany.mock.calls[0] as any)[0].select.error).toBe(true);
  });

  it('leaves deleted tags off the calendar and list cards', async () => {
    const { repository, findMany } = repositoryWith([]);
    await repository.getPosts('org-1', {
      startDate: '2026-10-04T18:30:00Z',
      endDate: '2026-10-11T18:29:59Z',
    } as any);
    await repository.getPostsList('org-1', {} as any);

    for (const [args] of findMany.mock.calls as any[]) {
      expect(args.select.tags).toEqual({
        where: { tag: { deletedAt: null } },
        select: { tag: true },
      });
    }
  });
});

describe('PostsRepository.createOrUpdatePost (POST /posts)', () => {
  // The share link hands out a post's id, and GET /public/posts/:id used to
  // hand out its group: neither may reach another workspace's rows.
  const setup = () => {
    const post = {
      upsert: jest.fn(async ({ where }: any) => ({
        id: where.id,
        state: 'DRAFT',
      })),
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(),
    };
    const repository = new PostsRepository(
      { model: { post } } as any,
      {} as any,
      {} as any,
      { model: { tags: { findMany: jest.fn(async () => []) } } } as any,
      { model: { tagsPosts: { deleteMany: jest.fn() } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, post };
  };

  const body = (extra: any = {}) => ({
    integration: { id: 'int-b' },
    group: 'group-of-org-a',
    settings: { __type: 'x' },
    value: [{ id: 'post-of-org-a', content: 'x', image: [] }],
    ...extra,
  });

  it('only updates a post of the caller\'s own workspace', async () => {
    const { repository, post } = setup();
    await repository.createOrUpdatePost(
      'draft',
      'org-b',
      '2026-10-20T10:00:00',
      body() as any,
      [],
      'WEB'
    );
    const [{ where, update }] = post.upsert.mock.calls[0] as any[];
    expect(where).toEqual({ id: 'post-of-org-a', organizationId: 'org-b' });
    expect(update.organization).toEqual({ connect: { id: 'org-b' } });
  });

  it('only sweeps the group inside the caller\'s workspace', async () => {
    const { repository, post } = setup();
    await repository.createOrUpdatePost(
      'draft',
      'org-b',
      '2026-10-20T10:00:00',
      body() as any,
      [],
      'WEB'
    );
    await repository.createOrUpdatePost(
      'update',
      'org-b',
      '2026-10-20T10:00:00',
      body() as any,
      [],
      'API',
      undefined,
      true
    );
    expect(post.findFirst).toHaveBeenCalledTimes(2);
    for (const [args] of post.findFirst.mock.calls as any[]) {
      expect(args.where).toMatchObject({
        organizationId: 'org-b',
        group: 'group-of-org-a',
      });
    }
    expect(post.updateMany).toHaveBeenCalledTimes(2);
    for (const [args] of post.updateMany.mock.calls as any[]) {
      expect(args.where).toMatchObject({
        organizationId: 'org-b',
        group: 'group-of-org-a',
      });
    }
  });
});

describe('PostsRepository.createOrUpdatePost inside a transaction (POST /posts, several channels)', () => {
  const models = () => ({
    post: {
      upsert: jest.fn(async ({ where }: any) => ({ id: where.id, state: 'QUEUE' })),
      findFirst: jest.fn(async () => ({ id: 'post-1' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
    tags: { findMany: jest.fn(async () => [{ id: 'tag-1', name: 'Launch' }]) },
    tagsPosts: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  });

  it('writes every row through the transaction client, none outside it', async () => {
    const outside = models();
    const tx = models();
    const repository = new PostsRepository(
      { model: { post: outside.post } } as any,
      {} as any,
      {} as any,
      { model: { tags: outside.tags } } as any,
      { model: { tagsPosts: outside.tagsPosts } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await repository.createOrUpdatePost(
      'schedule',
      'org-a',
      '2026-10-20T10:00:00',
      {
        integration: { id: 'int-1' },
        group: 'group-1',
        settings: { __type: 'linkedin' },
        value: [
          { id: 'post-1', content: 'x', image: [] },
          { id: 'post-2', content: 'comment', image: [] },
        ],
      } as any,
      [{ value: 'Launch', label: 'Launch' }],
      'WEB',
      undefined,
      false,
      tx as any
    );

    expect(tx.post.upsert).toHaveBeenCalledTimes(2);
    expect(tx.tagsPosts.deleteMany).toHaveBeenCalledTimes(1);
    expect(tx.tags.findMany).toHaveBeenCalledTimes(1);
    expect(tx.post.update).toHaveBeenCalledTimes(1);
    expect(tx.post.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.post.updateMany).toHaveBeenCalledTimes(1);
    for (const model of Object.values(outside)) {
      for (const fn of Object.values(model)) {
        expect(fn).not.toHaveBeenCalled();
      }
    }
  });

  it('runs the callback in one interactive Prisma transaction', async () => {
    const $transaction = jest.fn(async (fn: any) => fn('tx-client'));
    const repository = new PostsRepository(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { model: { $transaction } } as any,
      {} as any,
      {} as any
    );
    await expect(
      repository.transaction(async (tx) => `saved with ${tx}`)
    ).resolves.toBe('saved with tx-client');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(($transaction.mock.calls[0] as any[])[1]).toEqual({
      timeout: 30000,
      maxWait: 10000,
    });
  });
});

describe('PostsRepository.deleteTag (DELETE /posts/tags/:id)', () => {
  const repositoryWith = (count: number, tag: any = { id: 'tag-1' }) => {
    const updateMany = jest.fn(async (_args: any) => ({ count }));
    const findFirst = jest.fn(async (_args: any) => tag);
    const update = jest.fn();
    const repository = new PostsRepository(
      {} as any,
      {} as any,
      {} as any,
      { model: { tags: { updateMany, findFirst, update } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, updateMany, findFirst, update };
  };

  it("soft-deletes a live tag of the caller's own workspace only", async () => {
    const { repository, updateMany, findFirst, update } = repositoryWith(1);
    await expect(repository.deleteTag('tag-1', 'org-a')).resolves.toEqual({
      id: 'tag-1',
    });
    const [{ where, data }] = updateMany.mock.calls[0] as any[];
    expect(where).toEqual({ id: 'tag-1', orgId: 'org-a', deletedAt: null });
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'tag-1', orgId: 'org-a' },
    });
    // a Prisma update throws (500) when its where matches nothing
    expect(update).not.toHaveBeenCalled();
  });

  it("answers 404 for another workspace's tag, a missing id or one already deleted", async () => {
    const { repository, findFirst } = repositoryWith(0);
    await expect(
      repository.deleteTag('tag-of-org-a', 'org-b')
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      repository.deleteTag('no-such-tag', 'org-a')
    ).rejects.toThrow('Tag not found');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('answers 404 when the tag is gone by the time it is read back', async () => {
    const { repository } = repositoryWith(1, null);
    await expect(repository.deleteTag('tag-1', 'org-a')).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});

describe('PostsRepository.editTag (PUT /posts/tags/:id)', () => {
  const repositoryWith = (count: number, tag: any = { id: 'tag-of-org-a' }) => {
    const updateMany = jest.fn(async () => ({ count }));
    const findFirst = jest.fn(async () => tag);
    const repository = new PostsRepository(
      {} as any,
      {} as any,
      {} as any,
      { model: { tags: { updateMany, findFirst } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, updateMany, findFirst };
  };

  it("only updates a live tag of the caller's own workspace", async () => {
    const { repository, updateMany } = repositoryWith(1);
    await repository.editTag('tag-of-org-a', 'org-a', {
      name: 'renamed',
      color: '#000000',
    } as any);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'tag-of-org-a', orgId: 'org-a', deletedAt: null },
      data: { name: 'renamed', color: '#000000' },
    });
  });

  it("answers 404 for another workspace's tag or a deleted one", async () => {
    const { repository, findFirst } = repositoryWith(0);
    await expect(
      repository.editTag('tag-of-org-a', 'org-b', {
        name: 'renamed',
        color: '#000000',
      } as any)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('answers 404 when the tag is deleted between the update and the read', async () => {
    const { repository, findFirst } = repositoryWith(1, null);
    await expect(
      repository.editTag('tag-of-org-a', 'org-a', {
        name: 'renamed',
        color: '#000000',
      } as any)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'tag-of-org-a', orgId: 'org-a', deletedAt: null },
    });
  });
});

describe('PostsRepository.updatePost (orchestrator marks a post live)', () => {
  it('clears an error left by an earlier failed attempt', async () => {
    const update = jest.fn(async (args: any) => args);
    const repository = new PostsRepository(
      { model: { post: { update } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await repository.updatePost('post-1', 'release-1', 'https://x.com/i/status/1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: {
        state: 'PUBLISHED',
        releaseURL: 'https://x.com/i/status/1',
        releaseId: 'release-1',
        error: null,
      },
    });
  });
});

describe('PostsRepository.organizationCanPublish (the publish gate)', () => {
  const repo = (verified: number, marketplace: number) => {
    const countMembers = jest.fn(async (_args: any) => verified);
    const countMarketplace = jest.fn(async (_args: any) => marketplace);
    const repository = new PostsRepository(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { model: { userOrganization: { count: countMembers } } } as any,
      { model: { marketplaceAccount: { count: countMarketplace } } } as any
    );
    return { repository, countMembers, countMarketplace };
  };

  it('a confirmed, active, undeleted member is enough', async () => {
    const { repository, countMembers, countMarketplace } = repo(1, 0);
    await expect(repository.organizationCanPublish('org-a')).resolves.toBe(true);
    expect(countMembers).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        disabled: false,
        user: { activated: true, deletedAt: null },
      },
    });
    expect(countMarketplace).not.toHaveBeenCalled();
  });

  // api.market workspaces have no users by design (re-review of f77349f66).
  it('an api.market subscriber workspace (no users) may publish', async () => {
    const { repository, countMarketplace } = repo(0, 1);
    await expect(repository.organizationCanPublish('org-mkt')).resolves.toBe(true);
    expect(countMarketplace).toHaveBeenCalledWith({ where: { organizationId: 'org-mkt' } });
  });

  it('no confirmed member and no api.market account: no, even with no members at all', async () => {
    await expect(repo(0, 0).repository.organizationCanPublish('org-a')).resolves.toBe(false);
  });
});

// Review of f4bee956b: 'update' left state unset, so a root row created under
// it took Prisma's default, QUEUE, and the hourly sweep would publish it.
describe("PostsRepository.createOrUpdatePost: a root created under 'update' is a draft", () => {
  const save = async (state: any, existing = false) => {
    const upsert = jest.fn(async (args: any) => ({ id: 'row-1', ...args.create }));
    const repository = new PostsRepository(
      { model: { post: { upsert, update: jest.fn() } } } as any,
      {} as any,
      {} as any,
      { model: { tags: { findMany: jest.fn(async () => []) } } } as any,
      { model: { tagsPosts: { deleteMany: jest.fn() } } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    await repository.createOrUpdatePost(
      state,
      'org-a',
      '2026-10-30T10:00:00',
      { integration: { id: 'int-1' }, settings: {}, value: [{ id: existing ? 'p-1' : undefined, content: 'x', image: [] }, { content: 'reply', image: [] }] } as any,
      [],
      'WEB'
    );
    return upsert.mock.calls.map((c: any[]) => c[0]);
  };

  it("'update': the root's create is DRAFT; its update leaves the state alone", async () => {
    const [root, reply] = await save('update');
    expect(root.create.state).toBe('DRAFT');
    expect(root.update.state).toBeUndefined();
    // A reply follows its root's publishing, as before.
    expect(reply.create.state).toBeUndefined();
  });

  it.each([
    ['draft', 'DRAFT'],
    ['schedule', 'QUEUE'],
    ['now', 'QUEUE'],
  ])("'%s' is saved as %s, as before", async (state, saved) => {
    const [root] = await save(state);
    expect(root.create.state).toBe(saved);
    expect(root.update.state).toBe(saved);
  });
});
