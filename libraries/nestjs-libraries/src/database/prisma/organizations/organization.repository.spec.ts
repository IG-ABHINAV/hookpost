import 'reflect-metadata';
import { OrganizationRepository } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository';

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));

const setup = () => {
  const organization = {
    findFirst: jest.fn(async () => ({ id: 'org-1' })),
    update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
  };
  const userOrganization = {
    findFirst: jest.fn(async () => null),
  };
  const repository = new OrganizationRepository(
    { model: { organization } } as any,
    { model: { userOrganization } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    // signupAttribution and notifications, for the dispute evidence pack.
    {} as any,
    {} as any
  );
  return { repository, organization, userOrganization };
};

describe('OrganizationRepository, deleted workspaces and API keys', () => {
  it('looks keys up among live workspaces only', async () => {
    const { repository, organization } = setup();
    await repository.getOrgByApiKey('key-1');
    const [{ where }] = organization.findFirst.mock.calls[0] as any;
    expect(where).toEqual({
      apiKey: 'key-1',
      deletedAt: null,
      // ...and only for a workspace with a member who may use Hookpost (the
      // email-confirmation gate, email.verification.ts).
      users: {
        some: {
          disabled: false,
          user: { deletedAt: null, OR: [{ activated: true }, { providerName: { not: 'LOCAL' } }] },
        },
      },
    });
  });

  it('never queries with an empty key, which Prisma would treat as no filter', async () => {
    const { repository, organization } = setup();
    await expect(repository.getOrgByApiKey('')).resolves.toBeNull();
    await expect(repository.getOrgByApiKey(undefined as any)).resolves.toBeNull();
    expect(organization.findFirst).not.toHaveBeenCalled();
  });

  it('drops the API key when the workspace is deleted', async () => {
    const { repository, organization } = setup();
    await repository.deleteOrganization('org-1');
    const [{ where, data }] = organization.update.mock.calls[0] as any;
    expect(where).toEqual({ id: 'org-1' });
    expect(data.apiKey).toBeNull();
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('ends every other way to act for the workspace in the same write', async () => {
    const { repository, organization } = setup();
    await repository.deleteOrganization('org-1');
    const [{ data }] = organization.update.mock.calls[0] as any;
    const now = data.deletedAt;
    // Approved Apps grants made inside the workspace: revoked, tokens erased.
    expect(data.oauthAuthorizations.updateMany).toEqual([
      { where: { revokedAt: null }, data: { revokedAt: now } },
      { where: {}, data: { accessToken: null, authorizationCode: null } },
    ]);
    // Its own developer app.
    expect(data.oauthApp.updateMany).toEqual({
      where: { deletedAt: null },
      data: { deletedAt: now },
    });
    // Stored third-party API keys and old GitHub tokens.
    expect(data.thirdParty.updateMany).toEqual({
      where: {},
      data: { apiKey: '', deletedAt: now },
    });
    expect(data.github.updateMany).toEqual({ where: {}, data: { token: '' } });
    // RSS auto-posts stop fetching.
    expect(data.autoPost.updateMany).toEqual({
      where: { deletedAt: null },
      data: { active: false, deletedAt: now },
    });
  });

  it('lists what Temporal may run for the workspace: scheduled or repeating root posts, auto-posts, channels', async () => {
    const { repository, organization } = setup();
    (organization as any).findUnique = jest.fn(async () => null);
    await repository.getWorkflowSubjects('org-1');
    const [{ where, select }] = (organization as any).findUnique.mock.calls[0];
    expect(where).toEqual({ id: 'org-1' });
    expect(select.post.where).toEqual({
      deletedAt: null,
      parentPostId: null,
      OR: [{ state: 'QUEUE' }, { intervalInDays: { not: null } }],
    });
    expect(select.autoPost).toEqual({ select: { id: true } });
    expect(select.Integration).toEqual({ select: { id: true } });
  });

  it('cannot impersonate into a deleted account or workspace', async () => {
    const { repository, userOrganization } = setup();
    await repository.getUserOrg('uo-1');
    const [{ where }] = userOrganization.findFirst.mock.calls[0] as any;
    expect(where).toEqual({
      id: 'uo-1',
      user: { deletedAt: null },
      organization: { deletedAt: null },
    });
  });
});

describe('OrganizationRepository, the "Start free" choice', () => {
  const free = (opts: { missingTable?: boolean } = {}) => {
    const missing = () => {
      const err: any = new Error(
        'The table `public.FreePlanChoice` does not exist in the current database.'
      );
      err.code = 'P2021';
      throw err;
    };
    const freePlanChoice = {
      upsert: jest.fn(async (args: any) =>
        opts.missingTable ? missing() : { organizationId: args.where.organizationId }
      ),
      findUnique: jest.fn(async (args: any) =>
        opts.missingTable
          ? missing()
          : args.where.organizationId === 'chose-free'
          ? { organizationId: 'chose-free' }
          : null
      ),
    };
    const integration = { findFirst: jest.fn(async () => null) };
    const post = { findFirst: jest.fn(async () => ({ id: 'post-1' })) };
    const repository = new OrganizationRepository(
      {} as any,
      {} as any,
      {} as any,
      { model: { post } } as any,
      { model: { integration } } as any,
      { model: { freePlanChoice } } as any,
      {} as any,
      {} as any
    );
    return { repository, freePlanChoice, integration, post };
  };

  afterEach(() => jest.restoreAllMocks());

  it('stores the choice once per workspace (pressing it again is a no-op)', async () => {
    const { repository, freePlanChoice } = free();
    await expect(repository.chooseFreePlan('org-1')).resolves.toBe(true);
    expect(freePlanChoice.upsert).toHaveBeenCalledWith({
      where: { organizationId: 'org-1' },
      create: { organizationId: 'org-1' },
      update: {},
    });
  });

  it('reads it back', async () => {
    const { repository } = free();
    await expect(repository.hasChosenFreePlan('chose-free')).resolves.toBe(true);
    await expect(repository.hasChosenFreePlan('org-1')).resolves.toBe(false);
  });

  it('before the migration is applied: nothing fails, and it warns once', async () => {
    const warn = jest
      .spyOn(require('@nestjs/common').Logger, 'warn')
      .mockImplementation(() => undefined);
    const { repository } = free({ missingTable: true });
    await expect(repository.chooseFreePlan('org-1')).resolves.toBe(false);
    await expect(repository.hasChosenFreePlan('org-1')).resolves.toBe(false);
    await expect(repository.hasChosenFreePlan('org-1')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      'free-plan-choice.migration.sql'
    );
  });

  it('a placeholder from an unfinished connect is not a channel; deleted rows do not count', async () => {
    const { repository, integration, post } = free();
    await expect(repository.hasChannelOrPost('org-1')).resolves.toEqual({
      channel: false,
      post: true,
    });
    expect((integration.findFirst.mock.calls[0] as any)[0].where).toEqual({
      organizationId: 'org-1',
      deletedAt: null,
      inBetweenSteps: false,
    });
    expect((post.findFirst.mock.calls[0] as any)[0].where).toEqual({
      organizationId: 'org-1',
      deletedAt: null,
    });
  });
});

// 25 Oct 2026: the used-invite check, the seat count and the insert were
// separate statements (two people opening one link both joined), and a user
// already in the workspace hit the unique key (a 500).
describe('OrganizationRepository.joinWithInvite', () => {
  const ENV = process.env.RAZORPAY_KEY_ID;
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_spec';
  });
  afterAll(() => {
    if (ENV === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = ENV;
  });

  const run = (org: any, used: any = null) => {
    const steps: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        steps.push(`lock ${strings.join('?')} ${values.join(',')}`);
      }),
      organization: { findFirst: jest.fn(async () => (steps.push('read org'), org)) },
      user: {
        findFirst: jest.fn(async () => (steps.push('used?'), used)),
        update: jest.fn(async (args: any) => (steps.push(`inviteId ${args.data.inviteId}`), {})),
      },
      userOrganization: {
        create: jest.fn(async (args: any) => (steps.push(`join ${args.data.role}`), { id: 'uo-new', ...args.data })),
      },
    };
    const $transaction = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const repository = new OrganizationRepository(
      {} as any,
      { model: { $transaction } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, tx, steps, $transaction };
  };
  const pro = (users: number, extra: any = {}) => ({
    subscription: { subscriptionTier: 'PRO', deletedAt: null },
    users: [],
    _count: { users },
    ...extra,
  });

  it('takes the per-workspace lock first, then joins and records the invite as used', async () => {
    const { repository, steps } = run(pro(3));
    const result = await repository.joinWithInvite('u-1', 'inv-1', 'org-a', 'ADMIN');
    expect(result).toMatchObject({ joined: true, membership: { userId: 'u-1', organizationId: 'org-a', role: 'ADMIN' } });
    expect(steps[0]).toBe('lock SELECT pg_advisory_xact_lock(hashtext(?)) org-join:org-a');
    expect(steps).toEqual([steps[0], 'read org', 'used?', 'join ADMIN', 'inviteId inv-1']);
  });

  it('already a member: nothing written, the role untouched, the invite not spent', async () => {
    const { repository, steps } = run(pro(3, { users: [{ id: 'uo-1' }] }));
    expect(await repository.joinWithInvite('u-1', 'inv-1', 'org-a', 'ADMIN')).toEqual({ joined: false, reason: 'member' });
    expect(steps.some((s) => s.startsWith('join') || s.startsWith('inviteId'))).toBe(false);
  });

  it.each([
    ['a deleted (or missing) workspace', null, null, 'gone'],
    ['an invite someone used', pro(3), { id: 'u-0' }, 'used'],
    ['no plan (Free, or a workspace that has not started its trial)', { subscription: null, users: [], _count: { users: 1 } }, null, 'unavailable'],
    ['a soft-deleted subscription', pro(1, { subscription: { subscriptionTier: 'PRO', deletedAt: new Date() } }), null, 'unavailable'],
    ['Standard (no team)', pro(1, { subscription: { subscriptionTier: 'STANDARD', deletedAt: null } }), null, 'unavailable'],
    ['Pro with 15 of 15 seats', pro(15), null, 'full'],
    ['Team with 5 of 5 seats', pro(5, { subscription: { subscriptionTier: 'TEAM', deletedAt: null } }), null, 'full'],
  ])('%s: refused (%s)', async (_label, org, used, reason) => {
    const { repository, steps } = run(org, used);
    expect(await repository.joinWithInvite('u-1', 'inv-1', 'org-a', 'USER')).toEqual({ joined: false, reason });
    expect(steps.some((s) => s.startsWith('join'))).toBe(false);
  });

  it('addUserToOrg keeps its old answer: the row, or false', async () => {
    expect(await run(pro(1)).repository.addUserToOrg('u-1', 'inv-1', 'org-a', 'USER')).toMatchObject({ id: 'uo-new' });
    expect(await run(pro(15)).repository.addUserToOrg('u-1', 'inv-1', 'org-a', 'USER')).toBe(false);
  });
});

describe('OrganizationRepository.getLinkSources, the workspace links for the AI generator', () => {
  const make = (row: any) => {
    const organization = { findFirst: jest.fn(async () => row) };
    const repository = new OrganizationRepository(
      { model: { organization } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    return { repository, organization };
  };

  it('returns signatures first, then live agency websites with a scheme', async () => {
    const { repository, organization } = make({
      signatures: [{ content: '<p>acme.in</p>' }, { content: 'team@acme.in' }],
      users: [
        { user: { agencies: { website: 'acme.co.za', deletedAt: null } } },
        { user: { agencies: { website: 'https://studio.example', deletedAt: null } } },
        { user: { agencies: { website: 'gone.example', deletedAt: new Date() } } },
        { user: { agencies: { website: '  ', deletedAt: null } } },
        { user: { agencies: null } },
      ],
    });
    await expect(repository.getLinkSources('org-1')).resolves.toEqual([
      '<p>acme.in</p>',
      'team@acme.in',
      'https://acme.co.za',
      'https://studio.example',
    ]);
    const [args] = organization.findFirst.mock.calls[0] as any;
    expect(args.where).toEqual({ id: 'org-1', deletedAt: null });
    expect(args.select.signatures.where).toEqual({ deletedAt: null });
    expect(args.select.signatures.orderBy[0]).toEqual({ autoAdd: 'desc' });
    expect(args.select.users.where).toEqual({ disabled: false, user: { deletedAt: null } });
  });

  it('a deleted or unknown workspace has none', async () => {
    await expect(make(null).repository.getLinkSources('org-x')).resolves.toEqual([]);
  });
});
