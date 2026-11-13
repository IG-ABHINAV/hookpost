import 'reflect-metadata';
import { createHash } from 'crypto';
import { IntegrationRepository } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository';
import { isUnfinishedConnect } from '@hookpost/nestjs-libraries/database/prisma/integrations/unfinished.connect';

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));
// The repository builds a storage client on construction; none is used here.
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({}) },
}));

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

// Just enough of Prisma's `where` for these queries: equality, null, in,
// not (value or null), lt, a relation's `none`, OR.
const matches = (row: any, where: any): boolean =>
  Object.entries(where || {}).every(([key, condition]: [string, any]) => {
    if (key === 'OR') {
      return condition.some((part: any) => matches(row, part));
    }
    const value = row[key];
    if (condition === null) {
      return value === null || value === undefined;
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      if ('none' in condition) {
        return !(value || []).some((child: any) => matches(child, condition.none));
      }
      if ('lt' in condition) {
        return value !== null && value !== undefined && value < condition.lt;
      }
      if ('in' in condition) {
        return condition.in.includes(value);
      }
      if ('not' in condition) {
        return condition.not === null
          ? value !== null && value !== undefined
          : value !== condition.not;
      }
    }
    return value === condition;
  });

const FB_USER = '10221234567890123';
const USER_TOKEN = 'EAAG-long-lived-user-token';
const OTHER_TOKEN = 'EAAG-another-login';

const row = (overrides: any) => ({
  organizationId: 'org-a',
  providerIdentifier: 'facebook',
  refreshToken: USER_TOKEN,
  deletedAt: null,
  ...overrides,
});

const ROWS = [
  // Page 1 of a multi-Page selection: took over the login's row, root = user.
  row({ id: 'page-1', internalId: 'p1', rootInternalId: FB_USER }),
  // Pages 2 and 3 of that selection, saved before the fix: root = own id.
  row({ id: 'page-2', internalId: 'p2', rootInternalId: 'p2' }),
  row({ id: 'page-3', internalId: 'p3', rootInternalId: 'p3' }),
  // Another person's Facebook login in the same workspace.
  row({ id: 'other-login', internalId: 'p9', rootInternalId: 'u9', refreshToken: OTHER_TOKEN }),
  // A page of this login removed earlier: already gone, not returned.
  row({ id: 'removed-page', internalId: 'p4', rootInternalId: 'p4', deletedAt: new Date() }),
  // Same token value in a workspace where this login has no root: not linked.
  row({ id: 'elsewhere', organizationId: 'org-c', internalId: 'p5', rootInternalId: 'p5' }),
  // Not a Meta channel, even with the same ids.
  row({ id: 'linkedin', providerIdentifier: 'linkedin', internalId: 'li', rootInternalId: FB_USER }),
  // Workspace B: the root was removed with Delete channel (token md5'd), its
  // sibling from the same selection is still live.
  row({
    id: 'b-root',
    organizationId: 'org-b',
    internalId: 'q1',
    rootInternalId: FB_USER,
    refreshToken: md5('EAAG-token-b'),
    deletedAt: new Date(),
  }),
  row({ id: 'b-page-2', organizationId: 'org-b', internalId: 'q2', rootInternalId: 'q2', refreshToken: 'EAAG-token-b' }),
  // Threads keys the channel by the user id itself.
  row({ id: 'threads', organizationId: 'org-d', providerIdentifier: 'threads', internalId: FB_USER, rootInternalId: FB_USER, refreshToken: '' }),
];

const setup = (rows: any[] = ROWS) => {
  const integration = {
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where))),
    findFirst: jest.fn(async ({ where }: any) => rows.find((r) => matches(r, where)) || null),
    update: jest.fn(async ({ data }: any) => data),
    upsert: jest.fn(async (args: any) => ({ id: 'new-row', ...args.create })),
    updateMany: jest.fn(async () => ({ count: 0 })),
  };
  const signupAttribution = { updateMany: jest.fn(async () => ({ count: 0 })) };
  const repository = new IntegrationRepository(
    { model: { integration } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { model: { signupAttribution } } as any
  );
  return { repository, integration, signupAttribution };
};

const META = ['facebook', 'instagram', 'instagram-standalone', 'threads'];

describe('IntegrationRepository.getChannelsConnectedByAccount', () => {
  it('finds every live channel one Facebook login connected, pages saved before the fix included', async () => {
    const { repository } = setup();
    const found = await repository.getChannelsConnectedByAccount(META, FB_USER);
    expect(found.map((c) => c.id).sort()).toEqual(
      ['b-page-2', 'page-1', 'page-2', 'page-3', 'threads'].sort()
    );
    expect(found.find((c) => c.id === 'b-page-2')?.organizationId).toBe('org-b');
  });

  it('never returns another login, another workspace, a removed channel or another platform', async () => {
    const { repository } = setup();
    const ids = (await repository.getChannelsConnectedByAccount(META, FB_USER)).map((c) => c.id);
    expect(ids).not.toContain('other-login');
    expect(ids).not.toContain('elsewhere');
    expect(ids).not.toContain('removed-page');
    expect(ids).not.toContain('b-root');
    expect(ids).not.toContain('linkedin');
  });

  it('finds nothing for an unknown or empty account id', async () => {
    const { repository, integration } = setup();
    await expect(repository.getChannelsConnectedByAccount(META, 'nobody')).resolves.toEqual([]);
    await expect(repository.getChannelsConnectedByAccount(META, '')).resolves.toEqual([]);
    expect(integration.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('IntegrationRepository.eraseRemovedChannelProfile', () => {
  it('overwrites the profile of a removed channel, keeping the md5 root for the trial check', async () => {
    const removed = {
      id: 'page-1',
      organizationId: 'org-a',
      name: 'Jo Bakes',
      internalId: 'p1',
      rootInternalId: FB_USER,
      profile: 'jobakes',
      picture: 'https://media.hookstep.in/abc.png',
      deletedAt: new Date(),
    };
    const { repository, integration } = setup([removed]);
    await repository.eraseRemovedChannelProfile('org-a', 'page-1');
    const [{ where, data }] = integration.update.mock.calls[0] as any;
    expect(where).toEqual({ id: 'page-1', organizationId: 'org-a' });
    expect(data.name).toBe(md5('Jo Bakes'));
    expect(data.profile).toBe(md5('jobakes'));
    expect(data.rootInternalId).toBe(md5(FB_USER));
    expect(data.picture).toBeNull();
    expect(data.internalId).toMatch(new RegExp(`^deleted_${md5('p1')}_.{10}$`));
  });

  it('leaves a live channel alone', async () => {
    const { repository, integration } = setup([
      { id: 'page-1', organizationId: 'org-a', name: 'x', internalId: 'p1', deletedAt: null },
    ]);
    await expect(repository.eraseRemovedChannelProfile('org-a', 'page-1')).resolves.toBeNull();
    expect(integration.update).not.toHaveBeenCalled();
  });
});

describe('IntegrationRepository.createOrUpdateIntegration root id', () => {
  const call = (repository: IntegrationRepository, rootInternalId?: string) =>
    repository.createOrUpdateIntegration(
      undefined, false, 'org-a', 'Page 2', undefined, 'social', 'p2', 'facebook',
      'page-token', 'user-token', 3600, 'page2', false, undefined, undefined,
      undefined, rootInternalId
    );

  it('stores the given root id on create and on update', async () => {
    const { repository, integration } = setup([]);
    await call(repository, FB_USER);
    const [{ create, update }] = integration.upsert.mock.calls[0] as any;
    expect(create.rootInternalId).toBe(FB_USER);
    expect(update.rootInternalId).toBe(FB_USER);
  });

  it('falls back to the channel id, and leaves an existing root alone, when none is given', async () => {
    const { repository, integration } = setup([]);
    await call(repository);
    const [{ create, update }] = integration.upsert.mock.calls[0] as any;
    expect(create.rootInternalId).toBe('p2');
    expect('rootInternalId' in update).toBe(false);
  });
});

describe('IntegrationRepository.getStalePlaceholders', () => {
  it('asks for unfinished two-step rows with no post, untouched since the cutoff, a bounded batch', async () => {
    const { repository, integration } = setup([]);
    const before = new Date('2026-10-19T00:00:00Z');
    await repository.getStalePlaceholders(before, ['facebook', 'youtube']);
    const [args] = integration.findMany.mock.calls[0] as any;
    expect(args.where).toEqual({
      inBetweenSteps: true,
      deletedAt: null,
      providerIdentifier: { in: ['facebook', 'youtube'] },
      // A failed token refresh marks a live channel in between steps, and
      // that only happens while one of its posts goes out.
      posts: { none: {} },
      createdAt: { lt: before },
      // A new login to the same account updates the row: not stale.
      OR: [{ updatedAt: null }, { updatedAt: { lt: before } }],
    });
    expect(args.select).toEqual({
      id: true,
      organizationId: true,
      providerIdentifier: true,
      internalId: true,
      rootInternalId: true,
    });
    expect(args.take).toBe(500);
  });

  it('a live channel that a failed refresh marked in between steps is never swept', async () => {
    const created = new Date('2026-10-01T00:00:00Z');
    const rows = [
      // The 6 Oct case: a Facebook login with no Page, never finished.
      row({
        id: 'placeholder',
        internalId: FB_USER,
        rootInternalId: FB_USER,
        inBetweenSteps: true,
        createdAt: created,
        updatedAt: created,
        posts: [],
      }),
      // A picked Page that publishes: root is the login, it has posts.
      row({
        id: 'live-page',
        internalId: 'p1',
        rootInternalId: FB_USER,
        inBetweenSteps: false,
        createdAt: created,
        updatedAt: created,
        posts: [{ id: 'post-1', deletedAt: null }],
      }),
      // Page 2 of a selection saved before the root fix (root = own id),
      // whose only post was deleted since.
      row({
        id: 'old-page-2',
        internalId: 'p2',
        rootInternalId: 'p2',
        inBetweenSteps: false,
        createdAt: created,
        updatedAt: created,
        posts: [{ id: 'post-2', deletedAt: new Date() }],
      }),
    ];
    const integration = {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => matches(r, where))
      ),
      // What Prisma does on update: the fields, and @updatedAt.
      update: jest.fn(async ({ where, data }: any) => {
        const target = rows.find((r) => r.id === where.id)!;
        Object.assign(target, data, { updatedAt: new Date('2026-10-02T00:00:00Z') });
        return target;
      }),
    };
    const repository = new IntegrationRepository(
      { model: { integration } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { model: { signupAttribution: { updateMany: jest.fn(async () => ({ count: 0 })) } } } as any
    );

    // post.activity.ts: a token refresh threw while a post went out.
    await repository.setBetweenRefreshSteps('live-page');
    await repository.setBetweenRefreshSteps('old-page-2');
    expect(rows.every((r) => r.inBetweenSteps)).toBe(true);

    // Days later, the sweep.
    const candidates = await repository.getStalePlaceholders(
      new Date('2026-10-20T00:00:00Z'),
      ['facebook']
    );
    expect(candidates.map((c: any) => c.id)).toEqual(['placeholder']);
    expect(candidates.filter(isUnfinishedConnect).map((c: any) => c.id)).toEqual([
      'placeholder',
    ]);
  });
});

describe('isUnfinishedConnect', () => {
  const fb = (internalId: string, rootInternalId: string | null) => ({
    providerIdentifier: 'facebook',
    internalId,
    rootInternalId,
  });
  it('is a row that still carries the login account as its own root', () => {
    expect(isUnfinishedConnect(fb(FB_USER, FB_USER))).toBe(true);
  });
  it('a picked page (root = the login) is a channel', () => {
    expect(isUnfinishedConnect(fb('p1', FB_USER))).toBe(false);
  });
  it('a row with no root is left alone', () => {
    expect(isUnfinishedConnect(fb('p1', null))).toBe(false);
  });
  it('never Tumblr: the primary blog has the login name as its id, so a finished blog has this shape', () => {
    expect(
      isUnfinishedConnect({ providerIdentifier: 'tumblr', internalId: 'staff', rootInternalId: 'staff' })
    ).toBe(false);
  });
  it('never LinkedIn Page: its login id is a personal LinkedIn channel\'s id, and the upsert can convert that row', () => {
    expect(
      isUnfinishedConnect({ providerIdentifier: 'linkedin-page', internalId: 'member', rootInternalId: 'member' })
    ).toBe(false);
  });
});

// Connect-first funnel, 25 Oct 2026: SignupAttribution.firstChannelAt is set
// the first time a workspace has a real channel, whichever way it connected.
describe('IntegrationRepository: SignupAttribution.firstChannelAt', () => {
  const build = (failing = false) => {
    const integration = {
      upsert: jest.fn(async (args: any) => ({ id: 'row', ...args.create })),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async ({ data }: any) => ({ id: 'ph', ...data })),
    };
    const signupAttribution = {
      updateMany: jest.fn(async () => {
        if (failing) throw new Error('column "firstChannelAt" does not exist\nmore');
        return { count: 1 };
      }),
    };
    const repository = new IntegrationRepository(
      { model: { integration } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { model: { signupAttribution } } as any
    );
    return { repository, signupAttribution };
  };
  const save = (repository: IntegrationRepository, isBetweenSteps: boolean) =>
    repository.createOrUpdateIntegration(
      undefined, false, 'org-1', 'Name', undefined, 'social', 'acct-1', 'linkedin', 'token',
      '', 3600, 'user', isBetweenSteps
    );

  it('a one-step connect marks it, only where it is not set yet', async () => {
    const { repository, signupAttribution } = build();
    await save(repository, false);
    expect(signupAttribution.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', firstChannelAt: null },
      data: { firstChannelAt: expect.any(Date) },
    });
  });

  it('a two-step login (placeholder) does not; the page pick that finishes it does', async () => {
    const { repository, signupAttribution } = build();
    await save(repository, true);
    expect(signupAttribution.updateMany).not.toHaveBeenCalled();
    await repository.updateIntegration('ph', { organizationId: 'org-1', internalId: 'page-1', inBetweenSteps: false } as any);
    expect(signupAttribution.updateMany).toHaveBeenCalledTimes(1);
  });

  it('any other update of a channel does not', async () => {
    const { repository, signupAttribution } = build();
    await repository.updateIntegration('ch', { organizationId: 'org-1', internalId: 'acct-1', name: 'New name' } as any);
    expect(signupAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('a missing column (migration not applied yet) never fails the save', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { repository } = build(true);
    await expect(save(repository, false)).resolves.toMatchObject({ id: 'row' });
    expect(warn).toHaveBeenCalledWith(
      'SignupAttribution.firstChannelAt not recorded:',
      'column "firstChannelAt" does not exist'
    );
    warn.mockRestore();
  });
});
