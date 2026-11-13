import 'reflect-metadata';

// Whether a Free workspace skips the full-screen plans screen, decided on the
// server so it holds on every browser and phone.
//   pnpm exec jest -c apps/backend/jest.config.ts organization.service

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository',
  () => ({ OrganizationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.service',
  () => ({ AutopostService: class {} })
);

import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';

const service = (facts: {
  chose: boolean;
  channel: boolean;
  post: boolean;
}) => {
  const repository = {
    hasChosenFreePlan: jest.fn(async () => facts.chose),
    hasChannelOrPost: jest.fn(async () => ({
      channel: facts.channel,
      post: facts.post,
    })),
    chooseFreePlan: jest.fn(async () => true),
  };
  return {
    org: new OrganizationService(repository as any, {} as any),
    repository,
  };
};

describe('OrganizationService.skipsPlansScreen', () => {
  it('skips it for a workspace that chose Free, without counting anything', async () => {
    const { org, repository } = service({
      chose: true,
      channel: false,
      post: false,
    });
    await expect(org.skipsPlansScreen('org-1')).resolves.toBe(true);
    expect(repository.hasChannelOrPost).not.toHaveBeenCalled();
  });

  it('skips it for a workspace with a channel or a post', async () => {
    await expect(
      service({
        chose: false,
        channel: true,
        post: false,
      }).org.skipsPlansScreen('org-1')
    ).resolves.toBe(true);
    await expect(
      service({
        chose: false,
        channel: false,
        post: true,
      }).org.skipsPlansScreen('org-1')
    ).resolves.toBe(true);
  });

  it('shows it to a new workspace', async () => {
    await expect(
      service({
        chose: false,
        channel: false,
        post: false,
      }).org.skipsPlansScreen('org-1')
    ).resolves.toBe(false);
  });
});

describe('OrganizationService.chooseFreePlan', () => {
  it('stores the choice and says whether to open the onboarding', async () => {
    const { org, repository } = service({
      chose: false,
      channel: false,
      post: true,
    });
    await expect(org.chooseFreePlan('org-1')).resolves.toEqual({
      saved: true,
      hasChannels: false,
    });
    expect(repository.chooseFreePlan).toHaveBeenCalledWith('org-1');
  });
});

// The invite link was a JWT_SECRET token of the whole request body, so any
// extra field the admin sent (billing, apiKey...) was signed with it, and other
// endpoints took the invite as their own token (22 Oct 2026).
describe('OrganizationService.inviteTeamMember: the link is a team invite only', () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ENV, JWT_SECRET: 'invite-spec-secret', FRONTEND_URL: 'http://localhost:4200' };
    delete process.env.RAZORPAY_KEY_ID;
  });
  afterAll(() => {
    process.env = { ...ENV };
  });

  it('signs only the invite fields, with its own key and a two-day expiry', async () => {
    const { AuthService, TOKEN_PURPOSE } = await import('@hookpost/helpers/auth/auth.service');
    const { decode } = await import('jsonwebtoken');
    const org = new OrganizationService({} as any, { sendEmail: jest.fn() } as any);
    const body = { email: 'new@example.com', role: 'USER', sendEmail: false, billing: 'ULTIMATE', apiKey: 'x', id: 'chosen' } as any;
    const { url } = await org.inviteTeamMember({ id: 'org-1', name: 'Acme' } as any, { name: 'Jo', email: 'jo@example.com' } as any, body);
    // /invite/<token>: "/" is edge-cached with the query string ignored, so
    // /?org= never reached the proxy for a signed-out invitee (25 Oct 2026).
    expect(url).toMatch(/^http:\/\/localhost:4200\/invite\/[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new URL(url).search).toBe('');
    const token = decodeURIComponent(new URL(url).pathname.split('/')[2]);

    const payload = AuthService.verifyPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, token);
    expect(Object.keys(payload).sort()).toEqual(['email', 'exp', 'iat', 'id', 'orgId', 'purpose', 'role', 'timeLimit']);
    expect(payload).toMatchObject({ email: 'new@example.com', role: 'USER', orgId: 'org-1', purpose: 'team-invite' });
    expect(payload.id).not.toBe('chosen');
    const { exp, iat } = decode(token) as { exp: number; iat: number };
    expect(exp - iat).toBe(2 * 24 * 3600);
    expect(() => AuthService.verifySessionJWT(token)).toThrow();
    expect(() => AuthService.verifyPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, token)).toThrow();
  });
});

// Free posts are given once (trial.policy.ts): a sign-up that is someone
// already in a workspace that had its free posts, a trial or a plan, under
// another spelling of their address, or from a disposable email service,
// starts locked (allowTrial false). The sign-up itself always goes ahead.
describe('OrganizationService.createOrgAndUser: free posts once per person', () => {
  const signup = (spentEmails: string[] | Error) => {
    const repository = {
      emailsWithSpentFreePosts: jest.fn(async () => {
        if (spentEmails instanceof Error) throw spentEmails;
        return spentEmails.map((email) => ({ email }));
      }),
      createOrgAndUser: jest.fn(async () => ({ id: 'org-new', users: [] })),
    };
    const notifications = { hasEmailProvider: () => true };
    const org = new OrganizationService(repository as any, notifications as any);
    const create = async (email: string) => {
      await org.createOrgAndUser(
        { email, company: 'Co', password: 'x', provider: 'LOCAL' } as any,
        '1.1.1.1',
        'jest'
      );
      return repository.createOrgAndUser.mock.calls.at(-1) as any[];
    };
    return { create, repository };
  };

  it('a gmail address with dots and a +tag of a spent user starts locked', async () => {
    const { create, repository } = signup(['John.Doe@gmail.com']);
    const call = await create('j.o.h.n.d.o.e+2@gmail.com');
    expect(call[4]).toBe(false);
    expect(call[0].email).toBe('j.o.h.n.d.o.e+2@gmail.com');
    // Both Gmail domains, narrowed by the first letter of the identity, and
    // the address and identity in a deleted account's hashed form.
    expect(repository.emailsWithSpentFreePosts).toHaveBeenCalledWith(
      'j',
      ['gmail.com', 'googlemail.com'],
      ['j.o.h.n.d.o.e+2@gmail.com', 'johndoe@gmail.com']
    );
  });

  it('googlemail.com is gmail.com', async () => {
    const { create } = signup(['johndoe@googlemail.com']);
    expect((await create('johndoe@gmail.com'))[4]).toBe(false);
  });

  it('a +tag on another domain is the same person', async () => {
    const { create, repository } = signup(['sam@agency.io']);
    expect((await create('sam+client2@agency.io'))[4]).toBe(false);
    expect(repository.emailsWithSpentFreePosts).toHaveBeenCalledWith(
      'sam',
      ['agency.io'],
      ['sam+client2@agency.io', 'sam@agency.io']
    );
  });

  it('the address of a deleted account that had them (its email is a hash now) starts locked', async () => {
    const { create } = signup(['deleted_5d41402abc4b2a76b9719d911017c592_ab12c']);
    expect((await create('john@gmail.com'))[4]).toBe(false);
  });

  it('dots matter off Gmail, and a different person gets the free posts', async () => {
    const { create } = signup(['s.am@agency.io', 'sammy@agency.io', 'john@gmail.com']);
    expect((await create('sam@agency.io'))[4]).toBe(true);
  });

  it('nobody spent: free posts', async () => {
    const { create } = signup([]);
    expect((await create('new.person@gmail.com'))[4]).toBe(true);
  });

  it('a disposable domain starts locked without a lookup', async () => {
    const { create, repository } = signup([]);
    expect((await create('throwaway@mailinator.com'))[4]).toBe(false);
    expect((await create('x@yopmail.fr'))[4]).toBe(false);
    expect(repository.emailsWithSpentFreePosts).not.toHaveBeenCalled();
    // ...but the workspace is still created.
    expect(repository.createOrgAndUser).toHaveBeenCalledTimes(2);
  });

  it('a wallet id (no address) gets the free posts, as before', async () => {
    const { create, repository } = signup(['x@gmail.com']);
    expect((await create('0xabc123'))[4]).toBe(true);
    expect(repository.emailsWithSpentFreePosts).not.toHaveBeenCalled();
  });

  it('a lookup that fails gives the free posts and still signs up', async () => {
    const { create, repository } = signup(new Error('db down'));
    expect((await create('john@gmail.com'))[4]).toBe(true);
    expect(repository.createOrgAndUser).toHaveBeenCalledTimes(1);
  });
});
