import 'reflect-metadata';
import { OAuthRepository } from '@hookpost/nestjs-libraries/database/prisma/oauth/oauth.repository';

// The repository only needs PrismaRepository as an injection token; the real
// module opens a database connection. Each test hands in fake models.
jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
}));

// Just enough of Prisma's `where` to run the repository's real filters against
// rows: equality (null included), nested relation objects and OR.
const matches = (row: any, where: any): boolean =>
  Object.entries(where || {}).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as any[]).some((part) => matches(row, part));
    }
    const value = row?.[key];
    if (condition === null) {
      return value === null || value === undefined;
    }
    if (typeof condition === 'object' && !(condition instanceof Date)) {
      return value !== null && value !== undefined && matches(value, condition);
    }
    return value === condition;
  });

const live = { deletedAt: null };
const gone = { deletedAt: new Date('2026-09-01T00:00:00Z') };

// One authorization row as stored, with the relations the filter walks. The
// membership list is what the `include` returns.
const authorization = (overrides: any = {}) => ({
  id: 'auth-1',
  oauthAppId: 'app-1',
  userId: 'user-1',
  organizationId: 'org-1',
  accessToken: 'enc-token',
  authorizationCode: 'enc-code',
  revokedAt: null,
  user: {
    ...live,
    id: 'user-1',
    email: 'jo@example.com',
    activated: true,
    organizations: [{ organizationId: 'org-1' }],
  },
  organization: { ...live, id: 'org-1', subscription: null },
  oauthApp: { ...live, clientId: 'pcd_x', organizationId: null, organization: null },
  ...overrides,
});

const setup = (rows: any[], apps: any[] = []) => {
  const oAuthAuthorization = {
    findFirst: jest.fn(async ({ where }: any) =>
      rows.find((row) => matches(row, where)) || null
    ),
  };
  const oAuthApp = {
    findFirst: jest.fn(async ({ where }: any) =>
      apps.find((app) => matches(app, where)) || null
    ),
  };
  const repository = new OAuthRepository(
    { model: { oAuthApp } } as any,
    { model: { oAuthAuthorization } } as any
  );
  return { repository, oAuthAuthorization, oAuthApp };
};

describe('OAuthRepository.findByAccessToken', () => {
  it('accepts a token whose user, workspace and app are all live', async () => {
    const { repository } = setup([authorization()]);
    await expect(repository.findByAccessToken('enc-token')).resolves.toMatchObject({
      id: 'auth-1',
    });
  });

  it('refuses the token of an account deleted before tokens were revoked on deletion', async () => {
    // What production holds for those accounts: never revoked, token still set.
    const { repository } = setup([
      authorization({ user: { ...authorization().user, ...gone } }),
    ]);
    await expect(repository.findByAccessToken('enc-token')).resolves.toBeNull();
  });

  it('refuses the token when its workspace was deleted', async () => {
    const { repository } = setup([
      authorization({ organization: { ...gone, id: 'org-1' } }),
    ]);
    await expect(repository.findByAccessToken('enc-token')).resolves.toBeNull();
  });

  it('refuses a revoked token', async () => {
    const { repository } = setup([authorization({ revokedAt: new Date() })]);
    await expect(repository.findByAccessToken('enc-token')).resolves.toBeNull();
  });

  it('refuses tokens of a deleted app and of an app whose workspace was deleted', async () => {
    const deletedApp = setup([
      authorization({ oauthApp: { ...gone, organizationId: null } }),
    ]);
    await expect(
      deletedApp.repository.findByAccessToken('enc-token')
    ).resolves.toBeNull();

    const orphanedApp = setup([
      authorization({
        oauthApp: { ...live, organizationId: 'dev-org', organization: gone },
      }),
    ]);
    await expect(
      orphanedApp.repository.findByAccessToken('enc-token')
    ).resolves.toBeNull();

    const liveDeveloperApp = setup([
      authorization({
        oauthApp: { ...live, organizationId: 'dev-org', organization: live },
      }),
    ]);
    await expect(
      liveDeveloperApp.repository.findByAccessToken('enc-token')
    ).resolves.not.toBeNull();
  });

  it('refuses the token of a member who no longer belongs to the workspace', async () => {
    const removed = authorization();
    removed.user.organizations = [{ organizationId: 'another-org' }];
    const { repository, oAuthAuthorization } = setup([removed]);
    await expect(repository.findByAccessToken('enc-token')).resolves.toBeNull();

    // Disabled memberships are excluded by the query itself, like the session
    // middleware does.
    const [{ include }] = oAuthAuthorization.findFirst.mock.calls[0] as any;
    expect(include.user.select.organizations.where).toEqual({ disabled: false });
  });

  it('never queries with an empty token', async () => {
    const { repository, oAuthAuthorization } = setup([authorization()]);
    await expect(repository.findByAccessToken('')).resolves.toBeNull();
    expect(oAuthAuthorization.findFirst).not.toHaveBeenCalled();
  });
});

describe('OAuthRepository.findByCode', () => {
  it('applies the same rules to authorization codes', async () => {
    const ok = setup([authorization()]);
    await expect(ok.repository.findByCode('enc-code')).resolves.not.toBeNull();

    const deletedUser = setup([
      authorization({ user: { ...authorization().user, ...gone } }),
    ]);
    await expect(deletedUser.repository.findByCode('enc-code')).resolves.toBeNull();

    const deletedOrg = setup([
      authorization({ organization: { ...gone, id: 'org-1' } }),
    ]);
    await expect(deletedOrg.repository.findByCode('enc-code')).resolves.toBeNull();

    const empty = setup([authorization()]);
    await expect(empty.repository.findByCode('')).resolves.toBeNull();
    expect(empty.oAuthAuthorization.findFirst).not.toHaveBeenCalled();
  });
});

describe('OAuthRepository.getAppByClientId', () => {
  it('hides the developer app of a deleted workspace, keeps dynamic clients', async () => {
    const { repository } = setup(
      [],
      [
        { ...live, clientId: 'pca_dead', organizationId: 'org-x', organization: gone },
        { ...live, clientId: 'pca_live', organizationId: 'org-y', organization: live },
        { ...live, clientId: 'pcd_mcp', organizationId: null, organization: null },
      ]
    );
    await expect(repository.getAppByClientId('pca_dead')).resolves.toBeNull();
    await expect(repository.getAppByClientId('pca_live')).resolves.not.toBeNull();
    await expect(repository.getAppByClientId('pcd_mcp')).resolves.not.toBeNull();
  });
});
