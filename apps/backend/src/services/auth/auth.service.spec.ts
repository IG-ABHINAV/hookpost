import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { decode, sign } from 'jsonwebtoken';
import { Prisma, Provider, User } from '@prisma/client';
import { CreateOrgUserDto } from '@hookpost/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@hookpost/nestjs-libraries/dtos/auth/login.user.dto';
import { AuthService } from '@hookpost/backend/services/auth/auth.service';
import { inviteRef } from '@hookpost/backend/services/auth/invite.ref';
import { markInviteUsed } from '@hookpost/nestjs-libraries/services/email.verification';
import { AuthService as AuthChecker, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';

// AuthService only needs these as injection tokens; the real modules pull in
// Prisma, Redis and storage clients. Each test hands in its own fakes.
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/services/email.service', () => ({
  EmailService: class {},
}));
jest.mock('@hookpost/backend/services/auth/providers/providers.manager', () => ({
  AuthProviderManager: class {},
}));
jest.mock('@hookpost/nestjs-libraries/newsletter/newsletter.service', () => ({
  NewsletterService: { register: jest.fn().mockResolvedValue(undefined) },
}));

process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'http://localhost:4200';
process.env.NOT_SECURED = 'true';

const makeUser = (over: Partial<User>): User =>
  ({
    id: 'user-1',
    email: 'jo@gmail.com',
    password: '',
    providerName: Provider.LOCAL,
    providerId: '',
    activated: true,
    deletedAt: null,
    createdAt: new Date('2026-01-01'),
    ...over,
  } as User);

/**
 * An in-memory stand-in for UsersService that matches emails the way the
 * Prisma query does (mode: 'insensitive' on a trimmed value).
 */
const fakeUsers = (users: User[]) => {
  const same = (a: string, b: string) =>
    a.trim().toLowerCase() === b.trim().toLowerCase();
  return {
    users,
    getUserByEmail: jest.fn(async (email: string) =>
      users.find(
        (u) => u.providerName === Provider.LOCAL && same(u.email, email)
      ) || null
    ),
    getUserByEmailAnyProvider: jest.fn(async (email: string) =>
      users.find((u) => same(u.email, email)) || null
    ),
    getUserByProvider: jest.fn(async (providerId: string, provider: Provider) =>
      users.find(
        (u) => u.providerId === providerId && u.providerName === provider
      ) || null
    ),
    activateWithVerifiedEmail: jest.fn(async () => ({ count: 1 })),
    getUserById: jest.fn(async (id: string) => users.find((u) => u.id === id) || null),
  };
};

const setup = (
  users: User[],
  providerUser: { id: string; email: string; emailVerified?: boolean } | false
) => {
  const usersService = fakeUsers(users);
  const organizationService = {
    createOrgAndUser: jest.fn(async (body: any) => ({
      id: 'new-org',
      users: [
        {
          user: makeUser({
            id: 'new-user',
            email: body.email,
            providerName: body.provider,
            providerId: body.providerId,
          }),
        },
      ],
    })),
    addUserToOrg: jest.fn(),
    joinWithInvite: jest.fn(async (_u: string, _i: string, orgId: string) => ({
      joined: true,
      membership: { organizationId: orgId },
    })) as jest.Mock,
    inviteState: jest.fn(async (_i: string, orgId: string) => ({
      open: true,
      name: `Workspace ${orgId}`,
    })) as jest.Mock,
    getOrgsByUserId: jest.fn(async () => [] as { id: string }[]) as jest.Mock,
    getCount: jest.fn(async () => 1),
    secureTakenOverAccount: jest.fn(async () => ({
      rotated: ['own-org'],
      left: [{ id: 'shared-org', name: 'Verify now at https://evil.example' }],
    })),
    getOrgById: jest.fn(async (id: string) => ({ id, name: `Workspace ${id}` })),
  };
  const provider = {
    getUser: jest.fn(async () => providerUser),
    getToken: jest.fn(async () => 'access-token'),
    postRegistration: jest.fn(),
  };
  const providerManager = { getProvider: jest.fn(() => provider) };
  const emailService = { sendEmail: jest.fn() };
  const notificationService = { sendEmail: jest.fn() };

  const service = new AuthService(
    usersService as any,
    organizationService as any,
    notificationService as any,
    emailService as any,
    providerManager as any
  );
  return {
    service,
    usersService,
    organizationService,
    emailService,
    notificationService,
  };
};

const jwtUserId = (jwt: string) => (decode(jwt) as { id: string }).id;

const googleRegister = (): CreateOrgUserDto =>
  ({
    provider: Provider.GOOGLE,
    providerToken: 'google-access-token',
    company: 'Acme',
  } as CreateOrgUserDto);

const localRegister = (email: string) =>
  plainToInstance(CreateOrgUserDto, {
    provider: Provider.LOCAL,
    email,
    password: 'secret123',
    company: 'Acme',
  });

describe('AuthService: one account per email', () => {
  describe('OAuth sign-in with an email that already has an account', () => {
    it('Google sign-in with an existing LOCAL user logs in as that user and creates no org', async () => {
      const local = makeUser({ id: 'local-1', email: 'Jo@Gmail.com' });
      const { service, organizationService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });

      const { jwt } = await service.routeAuth(
        Provider.GOOGLE,
        googleRegister(),
        '127.0.0.1',
        'jest'
      );

      expect(jwtUserId(jwt)).toBe('local-1');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('the redirect flow signs straight in instead of showing the new-workspace form', async () => {
      const local = makeUser({ id: 'local-1' });
      const { service, organizationService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });

      const result = await service.checkExists(
        'GOOGLE',
        'code',
        'hookpost://callback'
      );

      expect(result.token).toBeUndefined();
      expect(jwtUserId(result.jwt!)).toBe('local-1');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('Google One Tap with an existing LOCAL user logs in as that user and creates no org', async () => {
      const local = makeUser({ id: 'local-1' });
      const { service, organizationService } = setup([local], {
        id: 'google-sub-1',
        email: 'JO@gmail.com',
        emailVerified: true,
      });

      const result = await service.googleOneTap('id-token', '127.0.0.1', 'jest');

      expect(result.registered).toBe(false);
      expect(jwtUserId(result.jwt)).toBe('local-1');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('a GitHub sign-in with a verified email reaches an existing Google user', async () => {
      const google = makeUser({
        id: 'google-1',
        providerName: Provider.GOOGLE,
        providerId: 'google-sub-1',
      });
      const { service, organizationService } = setup([google], {
        id: 'gh-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });

      const { jwt } = await service.routeAuth(
        Provider.GITHUB,
        { ...googleRegister(), provider: Provider.GITHUB } as CreateOrgUserDto,
        '127.0.0.1',
        'jest'
      );

      expect(jwtUserId(jwt)).toBe('google-1');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('activates an unconfirmed password account and drops its unconfirmed password', async () => {
      const local = makeUser({
        id: 'local-1',
        activated: false,
        password: 'hash-typed-by-someone',
      });
      const { service, usersService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });

      const { jwt } = await service.routeAuth(
        Provider.GOOGLE,
        googleRegister(),
        '127.0.0.1',
        'jest'
      );

      expect(jwtUserId(jwt)).toBe('local-1');
      expect(usersService.activateWithVerifiedEmail).toHaveBeenCalledWith(
        'local-1'
      );
    });

    // Since 25 Oct 2026 an unconfirmed password account is usable, so
    // whoever typed that password may have copied the workspace's API key.
    it('renews the API key of its own workspaces and drops it from shared ones', async () => {
      const local = makeUser({ id: 'local-1', activated: false, password: 'hash-typed-by-someone' });
      const { service, organizationService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });
      await service.routeAuth(Provider.GOOGLE, googleRegister(), '127.0.0.1', 'jest');
      expect(organizationService.secureTakenOverAccount).toHaveBeenCalledWith('local-1');
    });

    it('rotates nothing when the password account was already confirmed', async () => {
      const local = makeUser({ id: 'local-1', activated: true });
      const { service, organizationService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });
      await service.routeAuth(Provider.GOOGLE, googleRegister(), '127.0.0.1', 'jest');
      expect(organizationService.secureTakenOverAccount).not.toHaveBeenCalled();
    });

    it('an unverified Google email does not link and creates nothing', async () => {
      const local = makeUser({ id: 'local-1' });
      const { service, organizationService, usersService } = setup([local], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: false,
      });

      await expect(
        service.routeAuth(Provider.GOOGLE, googleRegister(), '127.0.0.1', 'jest')
      ).rejects.toThrow(
        'An account with this email already exists. Sign in with your email and password.'
      );
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
      expect(usersService.activateWithVerifiedEmail).not.toHaveBeenCalled();

      // and the redirect flow hands back the provider token, not a session
      const exists = await service.checkExists(
        'GOOGLE',
        'code',
        'hookpost://callback'
      );
      expect(exists.jwt).toBeUndefined();
      expect(exists.token).toBe('access-token');
    });

    it('a new Google email still registers with its own workspace', async () => {
      const { service, organizationService } = setup([], {
        id: 'google-sub-2',
        email: 'New@Example.com',
        emailVerified: true,
      });

      const { jwt } = await service.routeAuth(
        Provider.GOOGLE,
        googleRegister(),
        '127.0.0.1',
        'jest'
      );

      expect(jwtUserId(jwt)).toBe('new-user');
      expect(organizationService.createOrgAndUser).toHaveBeenCalledTimes(1);
      expect(organizationService.createOrgAndUser.mock.calls[0][0].email).toBe(
        'new@example.com'
      );
    });

    it('an existing Google user is still found by provider id first', async () => {
      const google = makeUser({
        id: 'google-1',
        providerName: Provider.GOOGLE,
        providerId: 'google-sub-1',
      });
      const { service, usersService } = setup([google], {
        id: 'google-sub-1',
        email: 'jo@gmail.com',
        emailVerified: true,
      });

      const { jwt } = await service.routeAuth(
        Provider.GOOGLE,
        googleRegister(),
        '127.0.0.1',
        'jest'
      );

      expect(jwtUserId(jwt)).toBe('google-1');
      expect(usersService.getUserByEmailAnyProvider).not.toHaveBeenCalled();
    });
  });

  describe('password registration', () => {
    it('is refused when the email belongs to a Google user, naming Google', async () => {
      const google = makeUser({
        id: 'google-1',
        providerName: Provider.GOOGLE,
        providerId: 'google-sub-1',
      });
      const { service, organizationService, emailService } = setup(
        [google],
        false
      );

      await expect(
        service.routeAuth(
          Provider.LOCAL,
          localRegister('jo@gmail.com'),
          '127.0.0.1',
          'jest'
        )
      ).rejects.toThrow(
        'An account with this email already exists. Sign in with Google.'
      );
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('refuses a case and space variant of an existing email', async () => {
      const google = makeUser({
        id: 'google-1',
        providerName: Provider.GOOGLE,
        providerId: 'google-sub-1',
      });
      const { service, organizationService, usersService } = setup(
        [google],
        false
      );

      await expect(
        service.routeAuth(
          Provider.LOCAL,
          localRegister('  JO@Gmail.COM '),
          '127.0.0.1',
          'jest'
        )
      ).rejects.toThrow('Sign in with Google');
      expect(usersService.getUserByEmailAnyProvider).toHaveBeenCalledWith(
        'jo@gmail.com'
      );
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('refuses an existing password account too', async () => {
      const { service, organizationService } = setup([makeUser({})], false);

      await expect(
        service.routeAuth(
          Provider.LOCAL,
          localRegister('Jo@gmail.com'),
          '127.0.0.1',
          'jest'
        )
      ).rejects.toThrow('Sign in with your email and password');
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    it('the DTO trims and lower-cases the email before it is validated', async () => {
      const dto = localRegister('  JO@Gmail.COM ');
      expect(dto.email).toBe('jo@gmail.com');
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('password reset', () => {
    it('sends a reset to the LOCAL user, found case-insensitively', async () => {
      const { service, notificationService } = setup(
        [makeUser({ id: 'local-1' })],
        false
      );

      await service.forgot(' Jo@Gmail.com ');

      expect(notificationService.sendEmail).toHaveBeenCalledTimes(1);
      expect(notificationService.sendEmail.mock.calls[0][0]).toBe(
        'jo@gmail.com'
      );
    });

    it('does nothing for an OAuth-only user and creates no account', async () => {
      const google = makeUser({
        id: 'google-1',
        providerName: Provider.GOOGLE,
        providerId: 'google-sub-1',
      });
      const { service, notificationService, organizationService } = setup(
        [google],
        false
      );

      expect(await service.forgot('jo@gmail.com')).toBe(false);
      expect(notificationService.sendEmail).not.toHaveBeenCalled();
      expect(organizationService.createOrgAndUser).not.toHaveBeenCalled();
    });

    // The link used to be a JWT_SECRET token of { id, expires }: a login
    // session with no expiry for anyone holding the email (22 Oct 2026).
    const resetLink = async () => {
      const { service, usersService, notificationService } = setup(
        [makeUser({ id: 'local-1' })],
        false
      );
      (usersService as any).updatePassword = jest.fn(async () => ({ id: 'local-1' }));
      await service.forgot('jo@gmail.com');
      const html: string = notificationService.sendEmail.mock.calls[0][2];
      const token = html.match(/\/auth\/forgot\/([\w-]+\.[\w-]+\.[\w-]+)/)![1];
      return { service, usersService, token };
    };
    const reset = (service: AuthService, token: string) =>
      service.forgotReturn({ token, password: 'New-Pass-123', repeatPassword: 'New-Pass-123' } as any);

    it('the emailed link sets a new password for that user', async () => {
      const { service, usersService, token } = await resetLink();
      expect(await reset(service, token)).toBeTruthy();
      expect((usersService as any).updatePassword).toHaveBeenCalledWith('local-1', 'New-Pass-123');
    });

    it('the emailed link is not a login session and expires in 20 minutes', async () => {
      const { token } = await resetLink();
      // AuthMiddleware verifies sessions with JWT_SECRET itself.
      expect(() => AuthChecker.verifyJWT(token)).toThrow();
      const payload = decode(token) as { exp: number; iat: number; purpose: string };
      expect(payload.exp - payload.iat).toBe(20 * 60);
      // ...and its shape is one AuthMiddleware refuses (isSessionPayload).
      expect(payload.purpose).toBe('password-reset');
    });

    it.each([
      ['a login session', () => AuthChecker.signSessionJWT({ id: 'local-1', email: 'jo@gmail.com', password: '' })],
      ['a login token without exp', () => sign({ id: 'local-1', email: 'jo@gmail.com' }, 'test-secret')],
      ['an old-style reset token', () => sign({ id: 'local-1', expires: '2099-01-01 00:00:00' }, 'test-secret')],
      [
        'an expired reset token',
        () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: 'local-1', iat: Math.floor(Date.now() / 1000) - 3600 }, { expiresIn: '20m' }),
      ],
      ['a team invite', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { id: 'local-1' }, { expiresIn: '20m' })],
      ['an activation link', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, { id: 'local-1' })],
      ['garbage', () => 'not-a-token'],
    ])('refuses %s and changes no password', async (_label, make) => {
      const { service, usersService } = await resetLink();
      expect(await reset(service, make())).toBe(false);
      expect((usersService as any).updatePassword).not.toHaveBeenCalled();
    });
  });
});

// Every token kind has its own key (TOKEN_PURPOSE), and each reader takes only
// its own (22 Oct 2026). Before, all were plain JWT_SECRET tokens.
describe('AuthService.getOrgFromCookie: only a team invite', () => {
  const inTwoDays = () => {
    const d = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const invite = (over: Record<string, unknown> = {}) =>
    AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      { email: 'new@example.com', role: 'USER', orgId: 'org-1', id: 'abcde', timeLimit: inTwoDays(), ...over },
      { expiresIn: '2d' }
    );
  const service = () => setup([], false).service;

  it('an invite is read', () => {
    expect(service().getOrgFromCookie(invite())).toMatchObject({ orgId: 'org-1', id: 'abcde', role: 'USER' });
  });

  it('an invite link sent before the fix (a JWT_SECRET token) still works for its two days', () => {
    const legacy = sign({ email: 'new@example.com', role: 'ADMIN', sendEmail: false, orgId: 'org-1', timeLimit: inTwoDays(), id: 'abcde' }, 'test-secret');
    expect(service().getOrgFromCookie(legacy)).toMatchObject({ orgId: 'org-1', id: 'abcde', role: 'ADMIN' });
  });

  it.each([
    ['a login session', () => AuthChecker.signSessionJWT({ id: 'user-1', email: 'jo@gmail.com', activated: true, password: '' })],
    ['a password-reset link', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: 'user-1', orgId: 'org-1', role: 'USER', timeLimit: inTwoDays() }, { expiresIn: '20m' })],
    ['a plan-change token', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, { id: 'abcde', orgId: 'org-1', role: 'USER', timeLimit: inTwoDays() })],
    ['an expired invite', () => invite({ timeLimit: '2020-01-01 00:00:00' })],
    ['an invite past its exp', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { role: 'USER', orgId: 'org-1', id: 'abcde', timeLimit: inTwoDays(), iat: Math.floor(Date.now() / 1000) - 3 * 86400 }, { expiresIn: '2d' })],
    ['an invite with a role that is not USER or ADMIN', () => invite({ role: 'SUPERADMIN' })],
    ['an old-style invite valid for more than two days', () => sign({ role: 'USER', orgId: 'org-1', id: 'abcde', timeLimit: '2099-01-01 00:00:00' }, 'test-secret')],
    ['an old-style token with a purpose', () => sign({ role: 'USER', orgId: 'org-1', id: 'abcde', timeLimit: inTwoDays(), purpose: 'x' }, 'test-secret')],
    ['a token signed with another secret', () => sign({ role: 'USER', orgId: 'org-1', id: 'abcde', timeLimit: inTwoDays() }, 'another-secret')],
    ['garbage', () => 'not-a-token'],
  ])('%s is not an invite', (_label, make) => {
    expect(service().getOrgFromCookie(make())).toBe(false);
  });
});

describe('AuthService.activate: only an activation link', () => {
  const pending = () => makeUser({ id: 'local-1', activated: false });
  const run = (users: User[]) => {
    const ctx = setup(users, false);
    const usersService = ctx.usersService as any;
    usersService.getUserById = jest.fn(async (id: string) => users.find((u) => u.id === id) || null);
    usersService.activatePendingUser = jest.fn(async () => true);
    return { ...ctx, usersService };
  };

  it('the emailed link is an activation token, not a session, and activates the account', async () => {
    const { service, emailService, usersService } = run([pending()]);
    await service.resendActivationEmail('jo@gmail.com');
    const html: string = emailService.sendEmail.mock.calls[0][2];
    const code = html.match(/\/auth\/activate\/([\w-]+\.[\w-]+\.[\w-]+)/)![1];
    expect(() => AuthChecker.verifySessionJWT(code)).toThrow();
    expect((decode(code) as { purpose: string }).purpose).toBe('account-activation');

    const session = await service.activate(code, '');
    expect(typeof session).toBe('string');
    expect(usersService.activatePendingUser).toHaveBeenCalledWith('local-1');
    // The new session is the user row from the database, activated.
    const payload = AuthChecker.verifySessionJWT(session);
    expect(payload).toMatchObject({ id: 'local-1', email: 'jo@gmail.com', activated: true });
  });

  it('a link sent before the fix (the unactivated session) still activates', async () => {
    // Its 30 days are counted from 20 Oct: run as of 25 Oct, so the test
    // does not start failing in November.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 25));
    try {
      const { service, usersService } = run([pending()]);
      // An old activation link: an unactivated user's row, signed, without exp.
      const legacy = sign({ id: 'local-1', email: 'jo@gmail.com', activated: false, iat: Date.UTC(2026, 9, 20) / 1000 }, 'test-secret');
      expect(typeof (await service.activate(legacy, ''))).toBe('string');
      expect(usersService.activatePendingUser).toHaveBeenCalledWith('local-1');
    } finally {
      clock.mockRestore();
    }
  });

  it('a link sent before the fix is refused once it is 30 days old', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 10, 20));
    try {
      const { service, usersService } = run([pending()]);
      const legacy = sign({ id: 'local-1', email: 'jo@gmail.com', activated: false, iat: Date.UTC(2026, 9, 20) / 1000 }, 'test-secret');
      expect(await service.activate(legacy, '')).toBe(false);
      expect(usersService.activatePendingUser).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['an unactivated session issued after the fix', () => sign({ id: 'local-1', email: 'jo@gmail.com', activated: false, iat: Date.UTC(2026, 9, 23) / 1000 }, 'test-secret')],
    ['an unactivated session issued at the cutoff', () => sign({ id: 'local-1', email: 'jo@gmail.com', activated: false, iat: Date.UTC(2026, 9, 22, 14) / 1000 }, 'test-secret')],
    ['an unactivated session as signed today (with exp)', () => AuthChecker.signSessionJWT({ id: 'local-1', email: 'jo@gmail.com', activated: false, password: '' })],
    ['a session of an activated user', () => AuthChecker.signSessionJWT({ id: 'local-1', email: 'jo@gmail.com', activated: true, password: '' })],
    ['a password-reset link', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: 'local-1' }, { expiresIn: '20m' })],
    ['a team invite', () => AuthChecker.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { id: 'local-1', activated: false }, { expiresIn: '2d' })],
    ['an old-style reset link', () => sign({ id: 'local-1', expires: '2099-01-01 00:00:00', activated: false }, 'test-secret')],
    ['a token signed with another secret', () => sign({ id: 'local-1', activated: false }, 'another-secret')],
    ['garbage', () => 'not-a-token'],
  ])('%s activates nothing', async (_label, make) => {
    const { service, usersService } = run([pending()]);
    expect(await service.activate(make(), '')).toBe(false);
    expect(usersService.activatePendingUser).not.toHaveBeenCalled();
  });

  it('an account that is already active is not activated again', async () => {
    const { service, usersService } = run([makeUser({ id: 'local-1', activated: true })]);
    const code = AuthChecker.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, { id: 'local-1', email: 'jo@gmail.com' });
    expect(await service.activate(code, '')).toBe(false);
    expect(usersService.activatePendingUser).not.toHaveBeenCalled();
  });
});

// 25 Oct 2026: none of the five password sign-ups of 19-25 Oct opened the
// emailed link, and without it they could not sign in at all. Now the account
// is signed in at once and confirms its email before publishing.
describe('AuthService: an unconfirmed password account signs in and confirms later', () => {
  const PASSWORD = 'secret123';
  const pending = (over: Partial<User> = {}) =>
    makeUser({
      id: 'local-1',
      activated: false,
      password: AuthChecker.hashPassword(PASSWORD),
      ...over,
    });
  const withUsers = (users: User[]) => {
    const ctx = setup(users, false);
    const usersService = ctx.usersService as any;
    usersService.getUserById = jest.fn(
      async (id: string) => users.find((u) => u.id === id) || null
    );
    // Atomic in the repository (updateMany where activated is false).
    usersService.activatePendingUser = jest.fn(async (id: string) => {
      const user = users.find((u) => u.id === id);
      if (!user || user.activated) return false;
      user.activated = true;
      return true;
    });
    usersService.changeUnverifiedEmail = jest.fn(
      async (id: string, email: string) => {
        const user = users.find((u) => u.id === id && !u.activated);
        if (!user) return false;
        user.email = email;
        return true;
      }
    );
    return { ...ctx, usersService };
  };
  const sentLink = (emailService: { sendEmail: jest.Mock }, n = 0) => {
    const html: string = emailService.sendEmail.mock.calls[n][2];
    return html.match(/\/auth\/activate\/([\w-]+\.[\w-]+\.[\w-]+)/)![1];
  };
  const status = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (e: any) {
      return { status: e.getStatus?.(), message: e.message };
    }
    return { status: 0, message: '' };
  };

  it('the sign-in form signs in an account that has not confirmed its email', async () => {
    const { service } = withUsers([pending()]);
    const { jwt } = await service.routeAuth(
      Provider.LOCAL,
      { email: 'jo@gmail.com', password: PASSWORD, provider: Provider.LOCAL } as any,
      '127.0.0.1',
      'jest'
    );
    expect(jwtUserId(jwt)).toBe('local-1');
    expect(AuthChecker.verifySessionJWT(jwt)).toMatchObject({ activated: false });
  });

  it('a wrong password is still refused', async () => {
    const { service } = withUsers([pending()]);
    await expect(
      service.routeAuth(
        Provider.LOCAL,
        { email: 'jo@gmail.com', password: 'nope', provider: Provider.LOCAL } as any,
        '127.0.0.1',
        'jest'
      )
    ).rejects.toThrow('Invalid user name or password');
  });

  it('sign-up emails a link that names the address and works for 7 days', async () => {
    const { service, emailService } = withUsers([]);
    await service.routeAuth(Provider.LOCAL, localRegister('New@Example.com'), '127.0.0.1', 'jest');
    expect(emailService.sendEmail.mock.calls[0][0]).toBe('new@example.com');
    const payload = decode(sentLink(emailService)) as Record<string, any>;
    expect(payload).toMatchObject({ purpose: 'account-activation', email: 'new@example.com' });
    expect(payload.exp - payload.iat).toBe(7 * 24 * 3600);
    // Not a session, whatever it is fed to.
    expect(() => AuthChecker.verifySessionJWT(sentLink(emailService))).toThrow();
  });

  it('an expired link activates nothing', async () => {
    const { service, usersService } = withUsers([pending()]);
    const expired = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: 'local-1', email: 'jo@gmail.com', iat: Math.floor(Date.now() / 1000) - 8 * 24 * 3600 },
      { expiresIn: '7d' }
    );
    expect(await service.activate(expired, '')).toBe(false);
    expect(usersService.activatePendingUser).not.toHaveBeenCalled();
  });

  it('a link without exp (sent before 25 Oct) works for 30 days from when it was sent', async () => {
    const now = Math.floor(Date.now() / 1000);
    const recent = AuthChecker.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, {
      id: 'local-1',
      email: 'jo@gmail.com',
      iat: now - 2 * 24 * 3600,
    });
    const old = AuthChecker.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, {
      id: 'local-1',
      email: 'jo@gmail.com',
      iat: now - 31 * 24 * 3600,
    });
    const first = withUsers([pending()]);
    expect(await first.service.activate(old, '')).toBe(false);
    expect(typeof (await first.service.activate(recent, ''))).toBe('string');
  });

  it('works once: the same link again signs nobody in', async () => {
    const { service, emailService } = withUsers([pending()]);
    await service.resendActivationEmail('jo@gmail.com');
    const code = sentLink(emailService);
    expect(typeof (await service.activate(code, ''))).toBe('string');
    expect(await service.activate(code, '')).toBe(false);
  });

  it("another account's link confirms only that account", async () => {
    const users = [pending(), pending({ id: 'local-2', email: 'sam@gmail.com' })];
    const { service, usersService } = withUsers(users);
    const forSam = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: 'local-2', email: 'sam@gmail.com' },
      { expiresIn: '7d' }
    );
    const session = (await service.activate(forSam, '')) as string;
    expect(jwtUserId(session)).toBe('local-2');
    expect(usersService.activatePendingUser).toHaveBeenCalledWith('local-2');
    expect(users[0].activated).toBe(false);
  });

  it('two opens at once: the one that loses the update gets no session', async () => {
    const { service, usersService } = withUsers([pending()]);
    // The row was confirmed between this request's read and its write.
    usersService.activatePendingUser = jest.fn(async () => false);
    const code = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: 'local-1', email: 'jo@gmail.com' },
      { expiresIn: '7d' }
    );
    expect(await service.activate(code, '')).toBe(false);
  });

  it('a link that names no address activates nothing (every real one names it)', async () => {
    const { service, usersService } = withUsers([pending()]);
    const bare = AuthChecker.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, { id: 'local-1' }, { expiresIn: '7d' });
    expect(await service.activate(bare, '')).toBe(false);
    expect(usersService.activatePendingUser).not.toHaveBeenCalled();
  });

  it('a link for a deleted account activates nothing', async () => {
    const { service, usersService } = withUsers([pending({ deletedAt: new Date() })]);
    const code = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: 'local-1', email: 'jo@gmail.com' },
      { expiresIn: '7d' }
    );
    expect(await service.activate(code, '')).toBe(false);
    expect(usersService.activatePendingUser).not.toHaveBeenCalled();
  });

  describe('signed-out "send the link again" answers the same for every address', () => {
    it.each([
      ['an unknown address', [] as User[]],
      ['a confirmed account', [makeUser({ id: 'local-1', activated: true })]],
      ['a Google account', [makeUser({ id: 'g-1', providerName: Provider.GOOGLE })]],
    ])('%s: no email, no error', async (_label, users) => {
      const { service, emailService } = withUsers(users);
      await expect(service.resendActivationEmail('jo@gmail.com')).resolves.toBeUndefined();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('an unconfirmed account: the same answer, and the link goes out', async () => {
      const { service, emailService } = withUsers([pending()]);
      await expect(service.resendActivationEmail(' JO@gmail.com ')).resolves.toBeUndefined();
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
      expect(emailService.sendEmail.mock.calls[0][0]).toBe('jo@gmail.com');
    });
  });

  it("the banner's Resend sends to the user's own address, and says when it is already confirmed", async () => {
    const users = [pending()];
    const { service, emailService } = withUsers(users);
    expect(await service.resendForSignedInUser('local-1')).toEqual({ sent: true, email: 'jo@gmail.com' });
    expect(emailService.sendEmail.mock.calls[0][0]).toBe('jo@gmail.com');
    users[0].activated = true;
    expect(await service.resendForSignedInUser('local-1')).toEqual({ sent: false, reason: 'already_verified' });
    expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
  });

  describe('"Wrong address?" moves an unconfirmed account', () => {
    it('to the new address, with a new link there; links to the old address stop working', async () => {
      const users = [pending({ email: 'jo@gmial.com' })];
      const { service, emailService, usersService } = withUsers(users);
      await service.resendForSignedInUser('local-1');
      const toOldAddress = sentLink(emailService, 0);

      expect(await service.changeUnverifiedEmail('local-1', ' Jo@Gmail.com ')).toEqual({
        sent: true,
        email: 'jo@gmail.com',
      });
      expect(usersService.changeUnverifiedEmail).toHaveBeenCalledWith('local-1', 'jo@gmail.com');
      expect(emailService.sendEmail.mock.calls[1][0]).toBe('jo@gmail.com');

      expect(await service.activate(toOldAddress, '')).toBe(false);
      expect(typeof (await service.activate(sentLink(emailService, 1), ''))).toBe('string');
    });

    it('not to an address that already has an account, with the sign-up form\'s answer', async () => {
      const users = [
        pending({ email: 'jo@gmial.com' }),
        makeUser({ id: 'g-1', email: 'jo@gmail.com', providerName: Provider.GOOGLE }),
      ];
      const { service, usersService, emailService } = withUsers(users);
      expect(await status(service.changeUnverifiedEmail('local-1', 'jo@gmail.com'))).toEqual({
        status: 409,
        message: 'An account with this email already exists. Sign in with Google.',
      });
      expect(usersService.changeUnverifiedEmail).not.toHaveBeenCalled();
      expect(emailService.sendEmail).not.toHaveBeenCalled();
    });

    it('a race for the address (unique index) is the same 409', async () => {
      const { service, usersService } = withUsers([pending({ email: 'jo@gmial.com' })]);
      usersService.changeUnverifiedEmail = jest.fn(async () => {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        });
      });
      expect((await status(service.changeUnverifiedEmail('local-1', 'jo@gmail.com'))).status).toBe(409);
    });

    it('a confirmed account is not moved', async () => {
      const { service, usersService } = withUsers([makeUser({ id: 'local-1', activated: true })]);
      expect(await service.changeUnverifiedEmail('local-1', 'other@gmail.com')).toEqual({
        sent: false,
        reason: 'already_verified',
      });
      expect(usersService.changeUnverifiedEmail).not.toHaveBeenCalled();
    });

    it('only a password account can move here', async () => {
      const { service } = withUsers([
        makeUser({ id: 'g-1', providerName: Provider.GOOGLE, activated: false }),
      ]);
      expect((await status(service.changeUnverifiedEmail('g-1', 'other@gmail.com'))).status).toBe(400);
    });

    it('the same address just sends the link again', async () => {
      const { service, usersService, emailService } = withUsers([pending()]);
      expect(await service.changeUnverifiedEmail('local-1', 'JO@gmail.com')).toEqual({
        sent: true,
        email: 'jo@gmail.com',
      });
      expect(usersService.changeUnverifiedEmail).not.toHaveBeenCalled();
      expect(emailService.sendEmail).toHaveBeenCalledTimes(1);
    });

    it('DISALLOW_PLUS applies to the new address too', async () => {
      process.env.DISALLOW_PLUS = 'true';
      try {
        const { service } = withUsers([pending()]);
        expect((await status(service.changeUnverifiedEmail('local-1', 'jo+x@gmail.com'))).status).toBe(400);
      } finally {
        delete process.env.DISALLOW_PLUS;
      }
    });
  });

  describe('a reset link also confirms the address it was sent to', () => {
    const resetFor = async (users: User[]) => {
      const ctx = withUsers(users);
      ctx.usersService.updatePassword = jest.fn(async (id: string) => {
        const user = users.find((u) => u.id === id)!;
        user.password = 'new-hash';
        return { ...user };
      });
      await ctx.service.forgot(users[0].email);
      const html: string = ctx.notificationService.sendEmail.mock.calls[0][2];
      const token = html.match(/\/auth\/forgot\/([\w-]+\.[\w-]+\.[\w-]+)/)![1];
      const use = () =>
        ctx.service.forgotReturn({ token, password: 'New-Pass-123', repeatPassword: 'New-Pass-123' } as any);
      return { ...ctx, token, use };
    };

    it('an unconfirmed account is confirmed, and its own workspaces get a new API key', async () => {
      const { use, usersService, organizationService } = await resetFor([pending()]);
      expect(await use()).toBeTruthy();
      expect(usersService.activatePendingUser).toHaveBeenCalledWith('local-1');
      expect(organizationService.secureTakenOverAccount).toHaveBeenCalledWith('local-1');
    });

    // Review of f4bee956b: the password used to change first and the address
    // was compared after, so a link to the old address still reset it.
    it('a link sent to an address the account has moved away from changes nothing', async () => {
      const users = [pending()];
      const { use, usersService, organizationService } = await resetFor(users);
      users[0].email = 'someone-else@gmail.com';
      expect(await use()).toBe(false);
      expect(usersService.updatePassword).not.toHaveBeenCalled();
      expect(usersService.activatePendingUser).not.toHaveBeenCalled();
      expect(organizationService.secureTakenOverAccount).not.toHaveBeenCalled();
    });

    it('a link for an account that no longer exists changes nothing', async () => {
      const users = [pending()];
      const { use, usersService } = await resetFor(users);
      users.splice(0, 1);
      expect(await use()).toBe(false);
      expect(usersService.updatePassword).not.toHaveBeenCalled();
    });

    it('a reset link from before 25 Oct (no address in it) sets the password and confirms nothing', async () => {
      const { service, usersService } = await resetFor([pending()]);
      const old = AuthChecker.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: 'local-1' }, { expiresIn: '20m' });
      expect(
        await service.forgotReturn({ token: old, password: 'New-Pass-123', repeatPassword: 'New-Pass-123' } as any)
      ).toBeTruthy();
      expect(usersService.activatePendingUser).not.toHaveBeenCalled();
    });

    it('a confirmed account is left as it is', async () => {
      const { use, usersService } = await resetFor([makeUser({ id: 'local-1', activated: true })]);
      expect(await use()).toBeTruthy();
      expect(usersService.activatePendingUser).not.toHaveBeenCalled();
    });
  });
});

// "Continue with Google" failures were plain Errors, so a 500, and the sign-up
// page spun forever: a 7 Oct visitor was lost that way, and a reload of
// /auth?code=... after a good sign-up (a spent code) did the same on 18 Oct.
describe('AuthService.checkExists failures are a 400 the page can show', () => {
  const ENV_NOT_SECURED = process.env.NOT_SECURED;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    process.env.NOT_SECURED = ENV_NOT_SECURED;
  });

  const failWith = async (setupFn: (provider: any) => void, state?: string, cookie?: string) => {
    const { service } = setup([], { id: 'g-1', email: 'jo@gmail.com', emailVerified: true });
    const provider = (service as any)._providerManager.getProvider();
    setupFn(provider);
    try {
      await service.checkExists('GOOGLE', 'spent-code-123', undefined, state, cookie);
    } catch (e) {
      return e as any;
    }
    throw new Error('expected a failure');
  };

  it('a spent code (invalid_grant) says the link expired, and logs no code', async () => {
    const e = await failWith((p) => {
      p.getToken.mockRejectedValue(
        Object.assign(new Error('invalid_grant'), {
          response: { data: { error: 'invalid_grant', error_description: 'Bad Request' } },
        })
      );
    });
    expect(e.getStatus()).toBe(400);
    expect(e.message).toBe(
      'This Google sign-in link expired or was already used. Please continue with Google again.'
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^\[auth\] oauth_exists_failed /);
    expect(String(warn.mock.calls[0][0])).not.toContain('spent-code-123');
  });

  it('a state that does not match the cookie (another browser, an old tab) is the same 400', async () => {
    delete process.env.NOT_SECURED;
    const e = await failWith(() => undefined, 'state-a', 'state-b');
    expect(e.getStatus()).toBe(400);
    expect(e.message).toContain('expired or was already used');
  });

  it('Google returning no user, or anything else, is a 400 with a reason, never a 500', async () => {
    const noUser = await failWith((p) => p.getUser.mockResolvedValue(false));
    expect(noUser.getStatus()).toBe(400);
    expect(noUser.message).toBe(
      'Google did not share your account details. Please try again, or sign up with your email.'
    );
    const other = await failWith((p) => p.getUser.mockRejectedValue(new Error('socket hang up')));
    expect(other.getStatus()).toBe(400);
    expect(other.message).toBe(
      'Signing in with Google did not finish. Please try again, or sign up with your email.'
    );
  });
});


// Re-review of f77349f66: an invite redeemed at sign-up by an account that
// must confirm its email is held, not joined, and a takeover of the address
// drops it, leaves every joined workspace and tells the owner which.
describe('AuthService: invites held until the email is confirmed', () => {
  const invite = (orgId = `org-w-${Math.random().toString(36).slice(2)}`) => ({
    orgId,
    id: `invite-${orgId}`,
    role: 'ADMIN' as const,
    email: '',
    timeLimit: new Date(Date.now() + 86400_000).toISOString(),
  });
  const signUpWith = async (activated: boolean, inv = invite()) => {
    const ctx = setup([], false);
    const userId = `new-${Math.random().toString(36).slice(2)}`;
    ctx.organizationService.createOrgAndUser = jest.fn(async (body: any) => ({
      id: 'own-org',
      users: [{ user: makeUser({ id: userId, email: body.email, activated }) }],
    }));
    const result = await ctx.service.routeAuth(
      Provider.LOCAL,
      localRegister('invitee@example.com'),
      '127.0.0.1',
      'jest',
      inv as any
    );
    return { ...ctx, userId, inv, result };
  };

  it('an account that must confirm: the invite is held, nothing is joined', async () => {
    const { organizationService, result } = await signUpWith(false);
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
    expect(result.invite).toEqual({ outcome: 'held' });
  });

  it("the confirmation email says which team waits for it", async () => {
    const { emailService, inv } = await signUpWith(false);
    const mail = emailService.sendEmail.mock.calls.find((c: any[]) => /Confirm your email/.test(c[1]));
    expect(mail?.[2]).toContain("You've been invited to");
    expect(mail?.[2]).toContain(`Workspace ${inv.orgId}`);
  });

  it('heldInviteWorkspace answers the team name while the invite is held, and nothing after it is taken', async () => {
    const ctx = await signUpWith(false);
    expect(await ctx.service.heldInviteWorkspace(ctx.userId)).toBe(`Workspace ${ctx.inv.orgId}`);
    const none = await signUpWith(true);
    expect(await none.service.heldInviteWorkspace(none.userId)).toBeNull();
  });

  it('no confirmation needed (no email provider): joined at once, as before', async () => {
    const { organizationService, inv, result } = await signUpWith(true);
    expect(organizationService.joinWithInvite).toHaveBeenCalledWith(
      expect.any(String),
      inv.id,
      inv.orgId,
      'ADMIN'
    );
    expect(result.invite).toEqual({ outcome: 'joined', organizationId: inv.orgId });
  });

  it('the emailed link joins the held invite', async () => {
    const ctx = await signUpWith(false);
    const users = [makeUser({ id: ctx.userId, email: 'invitee@example.com', activated: false })];
    (ctx.usersService as any).getUserById = jest.fn(async (id: string) => users.find((u) => u.id === id) || null);
    (ctx.usersService as any).activatePendingUser = jest.fn(async () => true);
    const code = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: ctx.userId, email: 'invitee@example.com' },
      { expiresIn: '7d' }
    );
    expect(typeof (await ctx.service.activate(code, ''))).toBe('string');
    expect(ctx.organizationService.joinWithInvite).toHaveBeenCalledWith(ctx.userId, ctx.inv.id, ctx.inv.orgId, 'ADMIN');
  });

  it('a full team when the link is used: still confirmed, the join is skipped', async () => {
    const ctx = await signUpWith(false);
    ctx.organizationService.joinWithInvite = jest.fn(async () => {
      throw new Error('seat limit');
    });
    const users = [makeUser({ id: ctx.userId, email: 'invitee@example.com', activated: false })];
    (ctx.usersService as any).getUserById = jest.fn(async (id: string) => users.find((u) => u.id === id) || null);
    (ctx.usersService as any).activatePendingUser = jest.fn(async () => true);
    const code = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
      { id: ctx.userId, email: 'invitee@example.com' },
      { expiresIn: '7d' }
    );
    expect(typeof (await ctx.service.activate(code, ''))).toBe('string');
  });

  it('a Google takeover drops the held invite (never joined), and emails the owner how many were dropped', async () => {
    const ctx = await signUpWith(false);
    const local = makeUser({ id: ctx.userId, email: 'invitee@example.com', activated: false, password: 'typed' });
    const takeover = setup([local], { id: 'g-1', email: 'invitee@example.com', emailVerified: true });
    const log = jest.spyOn((takeover.service as any)._logger, 'log');
    await takeover.service.routeAuth(Provider.GOOGLE, googleRegister(), '127.0.0.1', 'jest');
    expect(takeover.organizationService.secureTakenOverAccount).toHaveBeenCalledWith(ctx.userId);
    expect(takeover.organizationService.joinWithInvite).not.toHaveBeenCalled();
    const notice = takeover.emailService.sendEmail.mock.calls.find((c: any[]) => /removed/i.test(c[1]));
    expect(notice?.[0]).toBe('invitee@example.com');
    // The workspace it left and the one it was invited to: a count only.
    expect(notice?.[2]).toContain('2 shared workspaces');
    expect(notice?.[2]).toContain('ask them to invite you again');
    // Final review of 733294f78: a name is whatever its maker typed, and
    // in a Hookpost email a URL in it is a phishing line. Never in the email.
    expect(notice?.[2]).not.toMatch(/evil\.example|Verify now/);
    expect(notice?.[2]).not.toContain(`Workspace ${ctx.inv.orgId}`);
    // ...only in the server log.
    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('takeover of unconfirmed account'));
    expect(line).toContain('"Verify now at https://evil.example"');
    expect(line).toContain(`"Workspace ${ctx.inv.orgId}"`);
  });

  it('a takeover that drops nothing sends no notice', async () => {
    const local = makeUser({ id: 'quiet-1', activated: false, password: 'typed' });
    const ctx = setup([local], { id: 'g-2', email: 'jo@gmail.com', emailVerified: true });
    ctx.organizationService.secureTakenOverAccount = jest.fn(async () => ({ rotated: ['own-org'], left: [] }));
    await ctx.service.routeAuth(Provider.GOOGLE, googleRegister(), '127.0.0.1', 'jest');
    expect(ctx.emailService.sendEmail.mock.calls.some((c: any[]) => /removed/i.test(c[1]))).toBe(false);
  });
});

// 25 Oct 2026: an invite link opened while signed out was lost, and only a
// sign-up ever redeemed one. Now every way in redeems it the same way.
describe('AuthService.redeemInvite: one way to redeem, for every way in', () => {
  const invite = (orgId = `org-${Math.random().toString(36).slice(2)}`) => ({
    orgId,
    id: `inv-${Math.random().toString(36).slice(2)}`,
    role: 'USER' as const,
    timeLimit: new Date(Date.now() + 86400_000).toISOString(),
  });
  const confirmed = makeUser({ id: 'confirmed-1', email: 'member@example.com', password: AuthChecker.hashPassword('secret123'), activated: true });
  const unconfirmed = makeUser({ id: 'pending-1', email: 'pending@example.com', password: AuthChecker.hashPassword('secret123'), activated: false });
  const loginBody = (email: string): LoginUserDto =>
    plainToInstance(LoginUserDto, {
      provider: Provider.LOCAL,
      email,
      password: 'secret123',
    });

  it('no invite: null, and nothing is looked up', async () => {
    const { service, organizationService } = setup([], false);
    expect(await service.redeemInvite(confirmed, false)).toBeNull();
    expect(await service.redeemInvite(confirmed, undefined)).toBeNull();
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
  });

  it.each([
    [{ joined: true, membership: {} }, 'joined', true],
    [{ joined: false, reason: 'member' }, 'member', true],
    [{ joined: false, reason: 'full' }, 'full', false],
    [{ joined: false, reason: 'unavailable' }, 'unavailable', false],
    [{ joined: false, reason: 'used' }, 'invalid', false],
    [{ joined: false, reason: 'gone' }, 'invalid', false],
  ])('a confirmed account: %j -> %s', async (join, outcome, showsWorkspace) => {
    const { service, organizationService } = setup([], false);
    organizationService.joinWithInvite = jest.fn(async () => join);
    const inv = invite();
    expect(await service.redeemInvite(confirmed, inv)).toEqual({
      outcome,
      ...(showsWorkspace ? { organizationId: inv.orgId } : {}),
    });
  });

  it('a database error is "error", never a crash of the sign-in', async () => {
    const { service, organizationService } = setup([], false);
    organizationService.joinWithInvite = jest.fn(async () => {
      throw new Error('deadlock');
    });
    expect(await service.redeemInvite(confirmed, invite())).toEqual({ outcome: 'error' });
  });

  it('an unconfirmed account: held (not joined) while the invite is open, "invalid" when it is not', async () => {
    const { service, organizationService } = setup([], false);
    const inv = invite();
    expect(await service.redeemInvite(unconfirmed, inv)).toEqual({ outcome: 'held' });
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
    expect(await service.heldInviteWorkspace(unconfirmed.id)).toBe(`Workspace ${inv.orgId}`);

    organizationService.inviteState = jest.fn(async () => ({ open: false }));
    expect(await service.redeemInvite(makeUser({ id: 'pending-2', activated: false }), invite())).toEqual({ outcome: 'invalid' });
    expect(await service.heldInviteWorkspace('pending-2')).toBeNull();
  });

  it('a used invite stays used after its user joins another team (Redis marker): reuse is "invalid", the user who used it is "member"', async () => {
    const { service, organizationService } = setup([], false);
    const inv = invite();
    expect((await service.redeemInvite(confirmed, inv))?.outcome).toBe('joined');
    // The database alone would let it through now: the first user's
    // inviteId moved on to another team's invite.
    organizationService.joinWithInvite = jest.fn(async () => ({ joined: true, membership: {} }));
    const other = makeUser({ id: 'other-1', activated: true });
    expect(await service.redeemInvite(other, inv)).toEqual({ outcome: 'invalid' });
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
    // The one who used it, opening it again:
    organizationService.getOrgsByUserId = jest.fn(async (id: string) => (id === confirmed.id ? [{ id: inv.orgId }] : []));
    expect(await service.redeemInvite(confirmed, inv)).toEqual({ outcome: 'member', organizationId: inv.orgId });
    // ...and it is not held for someone unconfirmed either.
    expect(await service.redeemInvite(makeUser({ id: 'pending-3', activated: false }), inv)).toEqual({ outcome: 'invalid' });
  });

  it('password sign-in redeems it: joined when confirmed, held when not', async () => {
    const a = setup([confirmed], false);
    const inv = invite();
    const res = await a.service.routeAuth(Provider.LOCAL, loginBody(confirmed.email), '127.0.0.1', 'jest', inv);
    expect(res.invite).toEqual({ outcome: 'joined', organizationId: inv.orgId });
    expect(a.organizationService.joinWithInvite).toHaveBeenCalledWith(confirmed.id, inv.id, inv.orgId, 'USER');

    const b = setup([unconfirmed], false);
    const held = await b.service.routeAuth(Provider.LOCAL, loginBody(unconfirmed.email), '127.0.0.1', 'jest', invite());
    expect(held.invite).toEqual({ outcome: 'held' });
    expect(b.organizationService.joinWithInvite).not.toHaveBeenCalled();
  });

  it('a wrong password redeems nothing', async () => {
    const { service, organizationService } = setup([confirmed], false);
    const body = loginBody(confirmed.email);
    body.password = 'wrong';
    await expect(service.routeAuth(Provider.LOCAL, body, '127.0.0.1', 'jest', invite())).rejects.toThrow(/Invalid user name or password/);
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
  });

  it('an existing Google user (redirect flow) is joined; a new one keeps the invite for its sign-up', async () => {
    const google = makeUser({ id: 'g-user', email: 'g@gmail.com', providerName: Provider.GOOGLE, providerId: 'g-sub' });
    const a = setup([google], { id: 'g-sub', email: 'g@gmail.com', emailVerified: true });
    const inv = invite();
    const existing = await a.service.checkExists('GOOGLE', 'code', 'hookpost://callback', undefined, undefined, inv);
    expect(existing.invite).toEqual({ outcome: 'joined', organizationId: inv.orgId });

    const b = setup([], { id: 'new-sub', email: 'new@gmail.com', emailVerified: true });
    const fresh = await b.service.checkExists('GOOGLE', 'code', 'hookpost://callback', undefined, undefined, invite());
    expect(fresh.token).toBe('access-token');
    expect(fresh.invite).toBeNull();
    expect(b.organizationService.joinWithInvite).not.toHaveBeenCalled();
  });

  it('Google One Tap redeems it for an existing user and for a new one', async () => {
    const google = makeUser({ id: 'g-user', email: 'g@gmail.com', providerName: Provider.GOOGLE, providerId: 'g-sub' });
    const a = setup([google], { id: 'g-sub', email: 'g@gmail.com', emailVerified: true });
    const inv = invite();
    expect((await a.service.googleOneTap('cred', '127.0.0.1', 'jest', inv)).invite).toEqual({ outcome: 'joined', organizationId: inv.orgId });

    const b = setup([], { id: 'new-sub', email: 'new@gmail.com', emailVerified: true });
    const inv2 = invite();
    const res = await b.service.googleOneTap('cred', '127.0.0.1', 'jest', inv2);
    expect(res.registered).toBe(true);
    expect(res.invite).toEqual({ outcome: 'joined', organizationId: inv2.orgId });
    expect(b.organizationService.joinWithInvite).toHaveBeenCalledWith('new-user', inv2.id, inv2.orgId, 'USER');
  });

  it('getOrgFromCookie keeps timeLimit (a held invite needs it) and nothing the token did not carry', () => {
    const { service } = setup([], false);
    const token = AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      { orgId: 'org-1', id: 'abcde', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' },
      { expiresIn: '2d' }
    );
    expect(service.getOrgFromCookie(token)).toEqual({ orgId: 'org-1', id: 'abcde', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' });
  });
});

describe('AuthService.previewInvite: what the sign-up page says', () => {
  const token = (claims: Record<string, unknown> = {}) =>
    AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      { orgId: 'org-p', id: `p-${Math.random().toString(36).slice(2)}`, role: 'USER', timeLimit: '2999-01-01 00:00:00', ...claims },
      { expiresIn: '2d' }
    );

  it('an open invite: its team name', async () => {
    const { service } = setup([], false);
    expect(await service.previewInvite(token())).toEqual({ valid: true, team: 'Workspace org-p' });
  });

  it('forged, expired, used, gone or not a string: only "not valid"', async () => {
    const { service, organizationService } = setup([], false);
    const forged = sign({ purpose: 'team-invite', orgId: 'org-p', id: 'x', role: 'USER', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
    expect(await service.previewInvite(forged)).toEqual({ valid: false });
    expect(await service.previewInvite(token({ timeLimit: '2020-01-01 00:00:00' }))).toEqual({ valid: false });
    expect(await service.previewInvite(undefined)).toEqual({ valid: false });
    expect(await service.previewInvite({ token: 'x' })).toEqual({ valid: false });
    organizationService.inviteState = jest.fn(async () => ({ open: false }));
    expect(await service.previewInvite(token())).toEqual({ valid: false });
    organizationService.inviteState = jest.fn(async () => {
      throw new Error('db down');
    });
    expect(await service.previewInvite(token())).toEqual({ valid: false });
  });
});

describe('AuthService.pendingInvite: the Join question a signed-in visitor answers', () => {
  const token = (claims: Record<string, unknown> = {}) =>
    AuthChecker.signPurposeJWT(
      TOKEN_PURPOSE.TEAM_INVITE,
      { orgId: 'org-q', id: `q-${Math.random().toString(36).slice(2)}`, role: 'USER', timeLimit: '2999-01-01 00:00:00', by: 'owner-1', ...claims },
      { expiresIn: '2d' }
    );
  const me = makeUser({ id: 'me-1', activated: true });
  const details = (over: Record<string, unknown> = {}) =>
    jest.fn(async () => ({ name: 'Acme Studio', used: false, member: false, inviter: 'Priya Shah', ...over }));
  const withDetails = (over: Record<string, unknown> = {}) => {
    const s = setup([], false);
    (s.organizationService as any).inviteDetails = details(over);
    return s;
  };

  it('an open invite: the team, who invited, and the ref of that exact token', async () => {
    const { service, organizationService } = withDetails();
    const t = token();
    expect(await service.pendingInvite(me, t)).toEqual({
      valid: true,
      team: 'Acme Studio',
      inviter: 'Priya Shah',
      member: false,
      confirmEmail: false,
      ref: inviteRef(t),
    });
    expect((organizationService as any).inviteDetails).toHaveBeenCalledWith(expect.any(String), 'org-q', 'me-1', 'owner-1');
  });

  it('reads only: nothing is joined, held or marked used, however often it is asked', async () => {
    const { service, organizationService } = withDetails();
    const t = token();
    for (let i = 0; i < 3; i++) await service.pendingInvite(makeUser({ id: 'pending-q', activated: false }), t);
    expect(organizationService.joinWithInvite).not.toHaveBeenCalled();
    expect(await service.heldInviteWorkspace('pending-q')).toBeNull();
    // Still open for anyone.
    expect((await service.pendingInvite(me, t)).valid).toBe(true);
  });

  it('an unconfirmed account is told Join waits for the confirmation', async () => {
    const { service } = withDetails();
    expect(await service.pendingInvite(makeUser({ id: 'p', activated: false }), token())).toMatchObject({ valid: true, confirmEmail: true });
  });

  it('a token made before the inviter was recorded, or an inviter who left: "a team member" (null)', async () => {
    const { service } = withDetails({ inviter: null });
    expect(await service.pendingInvite(me, token({ by: undefined }))).toMatchObject({ valid: true, inviter: null });
  });

  it('already in that team: "member", also when they are the one who used it', async () => {
    const { service } = withDetails({ member: true, used: true });
    expect(await service.pendingInvite(me, token())).toMatchObject({ valid: true, member: true, confirmEmail: false });
    const t = token();
    await markInviteUsed(service.getOrgFromCookie(t) && (service.getOrgFromCookie(t) as any).id, '2999-01-01 00:00:00');
    expect(await service.pendingInvite(me, t)).toMatchObject({ valid: true, member: true });
  });

  it('used by someone else (database or Redis marker), gone, forged, expired, not a string, or the database down: "not valid"', async () => {
    const forged = sign({ purpose: 'team-invite', orgId: 'org-q', id: 'x', role: 'USER', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
    const session = AuthChecker.signSessionJWT({ id: 'me-1', email: 'a@b.c', password: null } as any);
    const a = withDetails();
    for (const bad of [forged, session, token({ timeLimit: '2020-01-01 00:00:00' }), undefined, '', 42, { token: 'x' }]) {
      expect(await a.service.pendingInvite(me, bad)).toEqual({ valid: false });
    }
    expect(await withDetails({ used: true }).service.pendingInvite(me, token())).toEqual({ valid: false });
    const marked = token();
    await markInviteUsed((a.service.getOrgFromCookie(marked) as any).id, '2999-01-01 00:00:00');
    expect(await a.service.pendingInvite(me, marked)).toEqual({ valid: false });

    const gone = setup([], false);
    (gone.organizationService as any).inviteDetails = jest.fn(async () => null);
    expect(await gone.service.pendingInvite(me, token())).toEqual({ valid: false });
    const down = setup([], false);
    (down.organizationService as any).inviteDetails = jest.fn(async () => {
      throw new Error('db down');
    });
    expect(await down.service.pendingInvite(me, token())).toEqual({ valid: false });
  });

  it('names are made fit to show: one line, no control or direction characters, at most 60 characters', async () => {
    const { service } = withDetails({
      name: `<img src=x onerror=alert(1)>\u202E${'A'.repeat(200)}`,
      inviter: 'Jo\nBloggs\u0000\u200B',
    });
    const q = (await service.pendingInvite(me, token())) as any;
    expect([...q.team]).toHaveLength(60);
    expect(q.team.startsWith('<img src=x onerror=alert(1)>AAA')).toBe(true);
    expect(q.team.endsWith('\u2026')).toBe(true);
    expect(q.inviter).toBe('Jo Bloggs');
  });

  it('getOrgFromCookie carries who made the invite, when the token says', () => {
    const { service } = setup([], false);
    expect(service.getOrgFromCookie(token({ id: 'abcde' }))).toMatchObject({ id: 'abcde', by: 'owner-1' });
    expect(service.getOrgFromCookie(token({ by: '' }))).not.toHaveProperty('by');
    expect(service.getOrgFromCookie(token({ by: 42 }))).not.toHaveProperty('by');
  });
});
