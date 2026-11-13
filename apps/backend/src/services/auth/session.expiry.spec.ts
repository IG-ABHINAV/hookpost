import 'reflect-metadata';

// Login sessions: a session carries iat, exp (30 days) and a stamp of the
// password it was issued under; AuthMiddleware refuses one that is past exp,
// has none, or no longer matches the password, and re-issues one that is a
// day old (sliding expiry).
//   pnpm exec jest -c apps/backend/jest.config.ts session.expiry

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/users/users.service', () => ({
  UsersService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/chat/mastra.service', () => ({
  MastraService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/sentry/initialize.sentry', () => ({
  setSentryUserContext: jest.fn(),
}));
import { decode, sign } from 'jsonwebtoken';
import { AuthMiddleware } from '@hookpost/backend/services/auth/auth.middleware';
import {
  AuthService,
  PASSWORD_STAMP_CLAIM,
  passwordStamp,
} from '@hookpost/helpers/auth/auth.service';
import {
  SESSION_REFRESH_AFTER_SECONDS,
  SESSION_TTL_SECONDS,
  sessionLooksLive,
  unverifiedClaims,
} from '@hookpost/helpers/auth/session.lifetime';

const JWT_SECRET = 'session-expiry-spec-secret';
const DAY = 24 * 60 * 60;
const now = () => Math.floor(Date.now() / 1000);

const HASH = '$2b$10$firstpasswordhashfirstpasswordhashfirstpasswordhashfi';
const NEW_HASH = '$2b$10$secondpasswordhashsecondpasswordhashsecondpasswordh';
const USER = {
  id: 'user-1',
  email: 'jo@example.com',
  activated: true,
  isSuperAdmin: false,
  password: HASH,
  signupGeoAt: new Date('2026-10-01'),
};

const ENV = { ...process.env };
beforeEach(() => {
  process.env = {
    ...ENV,
    JWT_SECRET,
    FRONTEND_URL: 'https://hookpost.hookstep.in',
  };
  delete process.env.NOT_SECURED;
  delete process.env.TRIAL_REQUIRED_SINCE_IN;
  delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
});
afterAll(() => {
  process.env = { ...ENV };
});

const fakeResponse = () => {
  const cookies: Record<string, { value: string; options: any }> = {};
  const headers: Record<string, string> = {};
  return {
    cookies,
    headers,
    res: {
      cookie: jest.fn((name: string, value: string, options: any) => {
        cookies[name] = { value, options };
      }),
      header: jest.fn((name: string, value: string) => {
        headers[name] = value;
      }),
    } as any,
  };
};

const ORG = { id: 'org-1', apiKey: 'k1', users: [{ disabled: false, role: 'SUPERADMIN' }], subscription: null };

/** AuthMiddleware over a stored user row (what getUserById returns now). */
function middlewareFor(stored: Record<string, unknown> | null = USER, extra: { getUserOrg?: jest.Mock } = {}) {
  const getUserById = jest.fn(async (_id: string) => (stored ? { ...stored } : null));
  const middleware = new AuthMiddleware(
    {
      getOrgsByUserId: jest.fn(async () => [ORG]),
      updateApiKey: jest.fn(),
      getUserOrg: extra.getUserOrg || jest.fn(),
    } as any,
    { getUserById, recordSignupGeo: jest.fn(async () => undefined) } as any,
    { getPlanState: jest.fn() } as any
  );
  return { middleware, getUserById };
}

async function call(
  token: string,
  opts: { via?: 'cookie' | 'header'; stored?: Record<string, unknown> | null; cookies?: Record<string, string>; getUserOrg?: jest.Mock } = {}
) {
  const { middleware, getUserById } = middlewareFor(opts.stored === undefined ? USER : opts.stored, {
    getUserOrg: opts.getUserOrg,
  });
  const { res, cookies, headers } = fakeResponse();
  const req: any =
    (opts.via || 'cookie') === 'cookie'
      ? { headers: {}, cookies: { auth: token, ...(opts.cookies || {}) } }
      : { headers: { auth: token }, cookies: { ...(opts.cookies || {}) } };
  const next = jest.fn();
  let error: unknown;
  try {
    await middleware.use(req, res, next);
  } catch (e) {
    error = e;
  }
  return { req, res, cookies, headers, next, error, getUserById };
}

describe('issuing a session (signSessionJWT)', () => {
  it('carries iat, an exp 30 days later and the password stamp, never the password hash', () => {
    const token = AuthService.signSessionJWT(USER);
    const claims = decode(token) as Record<string, any>;
    expect(claims.id).toBe('user-1');
    expect(Math.abs(claims.iat - now())).toBeLessThanOrEqual(2);
    expect(claims.exp - claims.iat).toBe(SESSION_TTL_SECONDS);
    expect(SESSION_TTL_SECONDS).toBe(30 * DAY);
    expect(claims[PASSWORD_STAMP_CLAIM]).toBe(passwordStamp(HASH));
    expect(claims).not.toHaveProperty('password');
    expect(token).not.toContain(HASH);
    expect(JSON.stringify(claims)).not.toContain('firstpasswordhash');
    expect(AuthService.verifySessionJWT(token)).toMatchObject({ id: 'user-1', email: 'jo@example.com' });
  });

  it('ignores an iat, exp or stamp already on the row it is given', () => {
    const token = AuthService.signSessionJWT({ ...USER, iat: 1, exp: 2, [PASSWORD_STAMP_CLAIM]: 'forged' } as any);
    const claims = decode(token) as Record<string, any>;
    expect(claims.exp - claims.iat).toBe(SESSION_TTL_SECONDS);
    expect(claims[PASSWORD_STAMP_CLAIM]).toBe(passwordStamp(HASH));
  });

  it('refuses a row without its password field, so no session is born unmatched', () => {
    const { password: _p, ...withoutPassword } = USER;
    expect(() => AuthService.signSessionJWT(withoutPassword as any)).toThrow();
    expect(() => AuthService.signSessionJWT({ id: '', password: null })).toThrow();
  });

  it('a provider account (no password) gets the same stamp for null and empty', () => {
    expect(passwordStamp(null)).toBe(passwordStamp(''));
    expect(passwordStamp(null)).not.toBe(passwordStamp(HASH));
  });

  it('the stamp is keyed by JWT_SECRET, so it cannot be computed from a leaked hash alone', () => {
    const first = passwordStamp(HASH);
    process.env.JWT_SECRET = 'another-secret';
    expect(passwordStamp(HASH)).not.toBe(first);
  });
});

describe('expiry', () => {
  it('a session past its exp is refused before any user is loaded', async () => {
    const token = AuthService.signSessionJWT(USER, { issuedAt: now() - SESSION_TTL_SECONDS - 60 });
    expect(() => AuthService.verifySessionJWT(token)).toThrow(/expired/);
    const r = await call(token);
    expect(r.error).toBeDefined();
    expect(r.next).not.toHaveBeenCalled();
    expect(r.getUserById).not.toHaveBeenCalled();
    expect(r.cookies.auth).toBeUndefined();
  });

  it('a session one day short of its exp still signs in', async () => {
    const token = AuthService.signSessionJWT(USER, { issuedAt: now() - 29 * DAY });
    const r = await call(token);
    expect(r.error).toBeUndefined();
    expect(r.next).toHaveBeenCalled();
    expect(r.req.user.id).toBe('user-1');
  });

  it('the frontend proxy reads the same exp (unverified, for routing only)', () => {
    const live = AuthService.signSessionJWT(USER);
    const dead = AuthService.signSessionJWT(USER, { issuedAt: now() - SESSION_TTL_SECONDS - 1 });
    expect(sessionLooksLive(live)).toBe(true);
    expect(sessionLooksLive(dead)).toBe(false);
    expect(unverifiedClaims(live)).toMatchObject({ id: 'user-1' });
  });
});

// A token without exp is not a session, wherever it arrives.
describe('tokens without exp', () => {
  const legacy = () => sign({ id: 'user-1', email: 'jo@example.com', activated: true, iat: now() - 90 * DAY }, JWT_SECRET);

  it('a session with no exp is refused, by the middleware too', async () => {
    expect(() => AuthService.verifySessionJWT(legacy())).toThrow(/no expiry/);
    expect(sessionLooksLive(legacy())).toBe(false);
    const r = await call(legacy());
    expect(r.error).toBeDefined();
    expect(r.next).not.toHaveBeenCalled();
    expect(r.getUserById).not.toHaveBeenCalled();
  });

  it('...whether it arrives in the cookie or the header', async () => {
    const r = await call(legacy(), { via: 'header' });
    expect(r.error).toBeDefined();
    expect(r.next).not.toHaveBeenCalled();
  });

  it.each([
    ['an exp but no password stamp', () => sign({ id: 'user-1' }, JWT_SECRET, { expiresIn: '30d' })],
    ['a lifetime longer than 30 days', () => sign({ id: 'user-1', [PASSWORD_STAMP_CLAIM]: passwordStamp(HASH) }, JWT_SECRET, { expiresIn: '365d' })],
    ['an exp and no iat', () => sign({ id: 'user-1', [PASSWORD_STAMP_CLAIM]: passwordStamp(HASH) }, JWT_SECRET, { expiresIn: '30d', noTimestamp: true })],
  ])('a token with %s is no session', async (_label, make) => {
    expect(() => AuthService.verifySessionJWT(make())).toThrow();
    const r = await call(make());
    expect(r.next).not.toHaveBeenCalled();
  });

  it('an old activation link (such a token) still reads as one, for activation only', () => {
    expect(AuthService.verifyLegacySessionJWT(legacy())).toMatchObject({ id: 'user-1' });
  });
});

describe('sliding refresh', () => {
  it('a session younger than a day is used as it is', async () => {
    const r = await call(AuthService.signSessionJWT(USER, { issuedAt: now() - DAY + 120 }));
    expect(r.next).toHaveBeenCalled();
    expect(r.res.cookie).not.toHaveBeenCalled();
    expect(r.res.header).not.toHaveBeenCalled();
  });

  it('a day-old session gets a new 30 days in an httpOnly cookie, and no header (secure cookies)', async () => {
    const old = AuthService.signSessionJWT(USER, { issuedAt: now() - SESSION_REFRESH_AFTER_SECONDS - 5 });
    const r = await call(old);
    expect(r.next).toHaveBeenCalled();
    const fresh = r.cookies.auth.value;
    expect(fresh).not.toBe(old);
    const claims = decode(fresh) as Record<string, any>;
    expect(claims.id).toBe('user-1');
    expect(Math.abs(claims.iat - now())).toBeLessThanOrEqual(2);
    expect(claims.exp - claims.iat).toBe(SESSION_TTL_SECONDS);
    expect(claims[PASSWORD_STAMP_CLAIM]).toBe(passwordStamp(HASH));
    expect(claims).not.toHaveProperty('password');
    expect(r.cookies.auth.options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: '.hookstep.in',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    expect(r.headers.auth).toBeUndefined();
    // The fresh token is itself a valid session.
    const again = await call(fresh);
    expect(again.next).toHaveBeenCalled();
    expect(again.res.cookie).not.toHaveBeenCalled();
  });

  it('under NOT_SECURED the fresh token also goes back in the header the frontend copies', async () => {
    process.env.NOT_SECURED = 'true';
    const r = await call(AuthService.signSessionJWT(USER, { issuedAt: now() - 2 * DAY }), { via: 'header' });
    expect(r.next).toHaveBeenCalled();
    expect(r.headers.auth).toBe(r.cookies.auth.value);
  });

  it('an active user is never signed out: renewed every day, the session outlives 30 days', async () => {
    // Day 0 sign-in, then one request every 20 days for 100 days.
    const realNow = Date.now;
    try {
      let token = AuthService.signSessionJWT(USER);
      const start = Date.now();
      for (let day = 20; day <= 100; day += 20) {
        Date.now = () => start + day * DAY * 1000;
        const r = await call(token);
        expect(r.next).toHaveBeenCalled();
        token = r.cookies.auth.value;
      }
      // ...and 31 idle days after the last use, it is over.
      Date.now = () => start + 131 * DAY * 1000;
      const idle = await call(token);
      expect(idle.next).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  it('while a super admin impersonates, the renewed session is still the admin’s own', async () => {
    const admin = { ...USER, id: 'admin-1', email: 'owner@hookstep.in', isSuperAdmin: true };
    const getUserOrg = jest.fn(async () => ({
      user: { id: 'cust-1', email: 'customer@example.com', password: '$2b$10$customer', activated: true },
      organization: { id: 'org-cust', paymentId: null, users: [{ userId: 'cust-1' }] },
    }));
    const r = await call(AuthService.signSessionJWT(admin, { issuedAt: now() - 3 * DAY }), {
      stored: admin,
      cookies: { impersonate: 'uo-cust' },
      getUserOrg,
    });
    expect(r.next).toHaveBeenCalled();
    expect(r.req.user.id).toBe('cust-1');
    expect(r.req.user).not.toHaveProperty('password');
    expect(r.req.org.id).toBe('org-cust');
    expect((decode(r.cookies.auth.value) as any).id).toBe('admin-1');
    expect(r.cookies.impersonate).toBeUndefined();
  });
});

describe('a password reset or change signs out every other session', () => {
  it('a session issued under the old password is refused once the hash changes', async () => {
    const before = AuthService.signSessionJWT(USER);
    const r = await call(before, { stored: { ...USER, password: NEW_HASH } });
    expect(r.error).toBeDefined();
    expect(r.next).not.toHaveBeenCalled();
    expect(r.req.user).toBeUndefined();
    expect(AuthService.sessionMatchesPassword(decode(before) as any, NEW_HASH)).toBe(false);
  });

  it('a session issued under the new password signs in', async () => {
    const after = AuthService.signSessionJWT({ ...USER, password: NEW_HASH });
    const r = await call(after, { stored: { ...USER, password: NEW_HASH } });
    expect(r.next).toHaveBeenCalled();
  });

  it('even setting the same password again (a new salt) ends the old sessions', async () => {
    const { hashSync } = await import('bcrypt');
    const first = hashSync('Same-Pass-1', 4);
    const second = hashSync('Same-Pass-1', 4);
    expect(first).not.toBe(second);
    const session = AuthService.signSessionJWT({ ...USER, password: first });
    expect((await call(session, { stored: { ...USER, password: first } })).next).toHaveBeenCalled();
    expect((await call(session, { stored: { ...USER, password: second } })).next).not.toHaveBeenCalled();
  });

  it('a stale session is not refreshed on its way out', async () => {
    const old = AuthService.signSessionJWT(USER, { issuedAt: now() - 2 * DAY });
    const r = await call(old, { stored: { ...USER, password: NEW_HASH } });
    expect(r.next).not.toHaveBeenCalled();
    expect(r.cookies.auth).toBeUndefined();
  });

  it('a Google account (no password) keeps its sessions through unrelated updates', async () => {
    const google = { ...USER, id: 'google-1', password: null };
    const session = AuthService.signSessionJWT(google);
    expect((await call(session, { stored: { ...google, password: '' } })).next).toHaveBeenCalled();
  });

  it('a forged stamp is refused', async () => {
    const forged = sign(
      { id: 'user-1', [PASSWORD_STAMP_CLAIM]: 'x'.repeat(22) },
      JWT_SECRET,
      { expiresIn: SESSION_TTL_SECONDS }
    );
    expect((await call(forged)).next).not.toHaveBeenCalled();
  });
});
