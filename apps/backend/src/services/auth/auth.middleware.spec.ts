import 'reflect-metadata';

// Which workspace a signed-in request lands in when the browser has not
// chosen one (no showorg cookie). Under the trial policy an invitee owns an
// empty personal workspace that has to start a trial, and used to land there,
// on the paywall, instead of in the workspace they were invited to (T9).
//   pnpm exec jest -c apps/backend/jest.config.ts auth.middleware

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
import { sign } from 'jsonwebtoken';
import { AuthMiddleware, isSessionPayload } from '@hookpost/backend/services/auth/auth.middleware';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';

const JWT_SECRET = 'middleware-spec-secret';
process.env.JWT_SECRET = JWT_SECRET;
// The stored row of the signed-in user (getUserById), password hash included.
const HASH = '$2b$10$storedhashstoredhashstoredhashstoredhashstoredhashsto';
const USER = { id: 'user-1', email: 'invitee@example.com', activated: true, password: HASH };
const SESSION = (issuedAt?: number) => AuthService.signSessionJWT(USER, { issuedAt });

// getOrgsByUserId order: the invitee's own personal workspace first.
const PERSONAL = { id: 'org-personal', apiKey: 'k1', users: [{ disabled: false, role: 'SUPERADMIN' }], subscription: null };
const INVITER = { id: 'org-inviter', apiKey: 'k2', users: [{ disabled: false, role: 'USER' }], subscription: null };

function run(states: Record<string, string>, cookies: Record<string, string> = {}, auth = SESSION()) {
  const getPlanState = jest.fn(async (id: string) => ({ state: states[id], freePlanAvailable: states[id] === 'free' }));
  const getUserById = jest.fn(async (_id: string) => ({ ...USER, signupGeoAt: new Date() }));
  const middleware = new AuthMiddleware(
    {
      getOrgsByUserId: jest.fn(async () => [PERSONAL, INVITER]),
      updateApiKey: jest.fn(),
    } as any,
    { getUserById: (id: string) => getUserById(id) } as any,
    { getPlanState } as any
  );
  const req: any = { headers: { auth, 'cf-ipcountry': 'IN' }, cookies };
  return { middleware, req, getPlanState, getUserById };
}

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV, JWT_SECRET };
});

describe('AuthMiddleware: the workspace a fresh browser lands in', () => {
  it('trial policy on: skips the invitee’s own needs_trial workspace for the inviter’s Free one', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const { middleware, req, getPlanState } = run({ 'org-personal': 'needs_trial', 'org-inviter': 'free' });
    await middleware.use(req, {} as any, () => undefined);
    expect(req.org.id).toBe('org-inviter');
    expect(getPlanState).toHaveBeenCalledWith('org-personal', { requestCountry: 'IN' });
  });

  it('a chosen workspace (showorg) is kept, blocked or not', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const { middleware, req, getPlanState } = run(
      { 'org-personal': 'needs_trial', 'org-inviter': 'free' },
      { showorg: 'org-personal' }
    );
    await middleware.use(req, {} as any, () => undefined);
    expect(req.org.id).toBe('org-personal');
    expect(getPlanState).not.toHaveBeenCalled();
  });

  it('every workspace blocked: the first one, as before', async () => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '2026-10-20T00:00:00Z';
    const { middleware, req } = run({ 'org-personal': 'needs_trial', 'org-inviter': 'locked' });
    await middleware.use(req, {} as any, () => undefined);
    expect(req.org.id).toBe('org-personal');
  });

  it('trial policy off: the first workspace, and no plan state is read', async () => {
    delete process.env.TRIAL_REQUIRED_SINCE_IN;
    delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
    const { middleware, req, getPlanState } = run({ 'org-personal': 'free', 'org-inviter': 'free' });
    await middleware.use(req, {} as any, () => undefined);
    expect(req.org.id).toBe('org-personal');
    expect(getPlanState).not.toHaveBeenCalled();
  });
});

// Until 25 Oct 2026 an account that had not confirmed its email was refused
// here, so a password sign-up could not reach onboarding or the paywall until
// it opened the emailed link; from 25 Oct it was let in everywhere; since the
// hard gate (29 Oct) it may call only itself, sign out and confirm.
describe('AuthMiddleware: the hard gate for an unconfirmed email account (29 Oct 2026)', () => {
  const build = (row: Record<string, unknown>, session = AuthService.signSessionJWT({ ...USER, ...row } as any)) => {
    const middleware = new AuthMiddleware(
      { getOrgsByUserId: jest.fn(async () => [PERSONAL]), updateApiKey: jest.fn(), getUserOrg: jest.fn(async () => ({ user: { id: 'cust', activated: false, providerName: 'LOCAL' }, organization: { ...PERSONAL, users: [] } })) } as any,
      { getUserById: jest.fn(async () => ({ ...USER, ...row, signupGeoAt: new Date() })) } as any,
      { getPlanState: jest.fn() } as any
    );
    return { middleware, session };
  };
  const call = async (row: Record<string, unknown>, method: string, url: string, extra: Partial<{ cookies: any; session: string }> = {}) => {
    const { middleware, session } = build(row);
    const req: any = { method, originalUrl: url, url, headers: { auth: extra.session ?? session }, cookies: extra.cookies ?? {} };
    const next = jest.fn();
    let error: any;
    await middleware.use(req, {} as any, next).catch((e: any) => (error = e));
    return { next, error, req };
  };
  const PENDING = { activated: false, providerName: 'LOCAL' };

  it.each([
    ['GET', '/user/self'],
    ['POST', '/user/logout'],
    ['GET', '/verify-email'],
    ['POST', '/verify-email/resend'],
    ['POST', '/verify-email/change'],
  ])('lets %s %s through', async (method, url) => {
    const { next, req } = await call(PENDING, method, url);
    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ activated: false });
  });

  it.each([
    ['GET', '/integrations/list'],
    ['POST', '/posts'],
    ['GET', '/billing'],
    ['POST', '/billing/subscribe'],
    ['POST', '/media/upload-simple'],
    ['POST', '/webhooks'],
    ['GET', '/user/organizations'],
    ['PUT', '/user/self'],
    ['GET', '/user/self/../integrations'],
    ['GET', '/verify-email/../posts'],
  ])('refuses %s %s with 403 EMAIL_VERIFICATION_REQUIRED, not a sign-out', async (method, url) => {
    const { next, error } = await call(PENDING, method, url);
    expect(next).not.toHaveBeenCalled();
    expect(error?.getStatus?.()).toBe(403);
    expect(error?.getResponse?.()).toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });

  it('a confirmed email account, and every OAuth sign-in (Google) whatever activated says, pass everywhere', async () => {
    for (const row of [{ activated: true, providerName: 'LOCAL' }, { activated: false, providerName: 'GOOGLE' }, { activated: null, providerName: 'GITHUB' }]) {
      const { next } = await call(row, 'POST', '/posts');
      expect(next).toHaveBeenCalled();
    }
  });

  it('the activated claim in the token is never trusted: the database row decides', async () => {
    const session = AuthService.signSessionJWT({ ...USER, activated: true } as any);
    const { error } = await call(PENDING, 'GET', '/integrations/list', { session });
    expect(error?.getResponse?.()).toMatchObject({ code: 'EMAIL_VERIFICATION_REQUIRED' });
  });

  it('a query string does not open another route', async () => {
    const { next } = await call(PENDING, 'GET', '/user/self?x=1');
    expect(next).toHaveBeenCalled();
    const { error } = await call(PENDING, 'GET', '/posts?r=/user/self');
    expect(error?.getStatus?.()).toBe(403);
  });
});

// A password-reset link used to be a JWT_SECRET token of { id, expires }, and
// this middleware took any verified token with an id as a login; an invite
// link was a JWT_SECRET token too (22 Oct 2026).
describe('AuthMiddleware: only a login session signs in', () => {
  it('a session (the user row) is one, and signs in', async () => {
    expect(isSessionPayload({ id: 'user-1', email: 'a@b.co', activated: true, iat: 1 })).toBe(true);
    const { middleware, req, getUserById } = run({ 'org-personal': 'free', 'org-inviter': 'free' });
    const next = jest.fn();
    await middleware.use(req, {} as any, next);
    expect(next).toHaveBeenCalled();
    expect(getUserById).toHaveBeenCalledWith('user-1');
    expect(req.user.id).toBe('user-1');
  });

  it.each([
    ['a password-reset link from before the fix', () => sign({ id: 'user-1', expires: '2026-10-22 10:00:00' }, JWT_SECRET)],
    ['an invite link from before the fix', () => sign({ id: 'abcde', orgId: 'org-1', timeLimit: '2099-01-01 00:00:00', role: 'ADMIN' }, JWT_SECRET)],
    ['a session-shaped token that says it has a purpose', () => sign({ id: 'user-1', purpose: 'password-reset' }, JWT_SECRET)],
    ['a password-reset link', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: 'user-1' }, { expiresIn: '20m' })],
    ['an activation link', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, { id: 'user-1', email: 'a@b.co' })],
    ['a team invite', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { id: 'user-1', orgId: 'org-1' }, { expiresIn: '2d' })],
    ['an extension token', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.EXTENSION_REFRESH, { id: 'user-1' })],
    ['a token with no id', () => sign({ discount: true }, JWT_SECRET)],
    ['a token signed with another secret', () => sign({ id: 'user-1' }, 'another-secret')],
  ])('%s is refused before any user is loaded', async (_label, make) => {
    const { middleware, req, getUserById } = run({ 'org-personal': 'free', 'org-inviter': 'free' }, {}, make());
    const next = jest.fn();
    await expect(middleware.use(req, {} as any, next)).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });
});

// Where the session and the impersonation come from (session.cookies.ts).
// In NOT_SECURED mode the frontend keeps its own copies of these cookies and
// sends them as headers; with secure cookies only the httpOnly cookie counts.
describe('AuthMiddleware: cookies before headers, with secure cookies', () => {
  const OTHER = () => AuthService.signSessionJWT({ id: 'user-2', email: 'other@example.com', activated: true, password: null });
  const CUSTOMER = { id: 'user-9', email: 'customer@example.com', activated: true };
  const fakeRes = () => {
    const cookies: Record<string, { value: string; options: any }> = {};
    return {
      cookies,
      res: {
        cookie: (name: string, value: string, options: any) => {
          cookies[name] = { value, options };
        },
        header: jest.fn(),
      } as any,
    };
  };
  const admin = (overrides: Record<string, unknown> = {}) => {
    const getUserOrg = jest.fn(async (id: string) =>
      id === 'uo-customer'
        ? { user: { ...CUSTOMER }, organization: { id: 'org-customer', paymentId: null, users: [{ userId: 'user-9' }] } }
        : null
    );
    const getUserById = jest.fn(async (id: string) => ({
      id,
      email: `${id}@example.com`,
      activated: true,
      isSuperAdmin: id === 'user-1',
      // The stored hash the session's password stamp is checked against.
      password: id === 'user-1' ? HASH : null,
      signupGeoAt: new Date(),
      ...overrides,
    }));
    const middleware = new AuthMiddleware(
      { getOrgsByUserId: jest.fn(async () => [PERSONAL]), updateApiKey: jest.fn(), getUserOrg } as any,
      { getUserById } as any,
      { getPlanState: jest.fn() } as any
    );
    return { middleware, getUserById, getUserOrg };
  };

  beforeEach(() => {
    delete process.env.NOT_SECURED;
    process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
  });

  it('the cookie is the session when a header names someone else, and neither is set again', async () => {
    const { middleware, getUserById } = admin();
    const req: any = { headers: { auth: OTHER() }, cookies: { auth: SESSION() } };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(getUserById).toHaveBeenCalledWith('user-1');
    expect(req.user.id).toBe('user-1');
    expect(cookies.auth).toBeUndefined();
  });

  it('a client with no cookies (the mobile app) still signs in with the header', async () => {
    const { middleware } = admin();
    const req: any = { headers: { auth: OTHER() }, cookies: {} };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(req.user.id).toBe('user-2');
    // Nothing to replace: no cookie came in.
    expect(cookies.auth).toBeUndefined();
  });

  it('a readable copy (cookie and the same value as a header) is set again httpOnly', async () => {
    const { middleware } = admin();
    const token = SESSION();
    const req: any = { headers: { auth: token }, cookies: { auth: token } };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(cookies.auth.value).toBe(token);
    expect(cookies.auth.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', domain: '.hookstep.in' });
  });

  it('a day-old readable copy is replaced by the renewed session, not set again as it was', async () => {
    const { middleware } = admin();
    const token = SESSION(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60);
    const req: any = { headers: { auth: token }, cookies: { auth: token } };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(cookies.auth.value).not.toBe(token);
    expect(AuthService.verifySessionJWT(cookies.auth.value).id).toBe('user-1');
    expect(cookies.auth.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', domain: '.hookstep.in' });
    // With secure cookies the renewed token never goes back in a header.
    expect(res.header).not.toHaveBeenCalled();
  });

  it('the httpOnly cookie alone: nothing is set again', async () => {
    const { middleware } = admin();
    const req: any = { headers: {}, cookies: { auth: SESSION() } };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(req.user.id).toBe('user-1');
    expect(cookies.auth).toBeUndefined();
  });

  it('a super admin impersonates through the cookie, never through a header', async () => {
    const { middleware, getUserOrg } = admin();
    const viaCookie: any = { headers: {}, cookies: { auth: SESSION(), impersonate: 'uo-customer' } };
    await middleware.use(viaCookie, fakeRes().res, () => undefined);
    expect(viaCookie.user.id).toBe('user-9');
    expect(viaCookie.org.id).toBe('org-customer');

    // The stop button expired the cookie; a readable copy the page still sends
    // as a header must not keep the admin in the customer's workspace.
    getUserOrg.mockClear();
    const viaHeader: any = { headers: { impersonate: 'uo-customer' }, cookies: { auth: SESSION() } };
    await middleware.use(viaHeader, fakeRes().res, () => undefined);
    expect(getUserOrg).not.toHaveBeenCalled();
    expect(viaHeader.user.id).toBe('user-1');
    expect(viaHeader.org.id).toBe('org-personal');
  });

  it('NOT_SECURED (development, the integration suite): the header still impersonates', async () => {
    process.env.NOT_SECURED = 'true';
    const { middleware } = admin();
    const req: any = { headers: { auth: SESSION(), impersonate: 'uo-customer' }, cookies: {} };
    const { res, cookies } = fakeRes();
    await middleware.use(req, res, () => undefined);
    expect(req.user.id).toBe('user-9');
    expect(cookies.auth).toBeUndefined();
  });

  it('a non-super-admin user cannot impersonate: the impersonate cookie is strictly ignored and no customer org is loaded', async () => {
    const { middleware, getUserOrg } = admin();
    // user-2 is NOT a super admin
    const nonAdminReq: any = { headers: {}, cookies: { auth: OTHER(), impersonate: 'uo-customer' } };
    await middleware.use(nonAdminReq, fakeRes().res, () => undefined);
    expect(getUserOrg).not.toHaveBeenCalled();
    expect(nonAdminReq.user.id).toBe('user-2');
    expect(nonAdminReq.user.isSuperAdmin).toBe(false);
    expect(nonAdminReq.org.id).toBe('org-personal');
  });

  it('when a super admin impersonates, user.isSuperAdmin remains true for admin privilege retention', async () => {
    const { middleware, getUserOrg } = admin();
    const req: any = { headers: {}, cookies: { auth: SESSION(), impersonate: 'uo-customer' } };
    await middleware.use(req, fakeRes().res, () => undefined);
    expect(getUserOrg).toHaveBeenCalledWith('uo-customer');
    expect(req.user.id).toBe('user-9');
    expect(req.user.isSuperAdmin).toBe(true);
    expect(req.org.id).toBe('org-customer');
  });

  it('when impersonating a deleted or missing user-organization, falls back cleanly to the admin own workspace', async () => {
    const { middleware, getUserOrg } = admin();
    const req: any = { headers: {}, cookies: { auth: SESSION(), impersonate: 'uo-missing' } };
    await middleware.use(req, fakeRes().res, () => undefined);
    expect(getUserOrg).toHaveBeenCalledWith('uo-missing');
    expect(req.user.id).toBe('user-1');
    expect(req.org.id).toBe('org-personal');
  });
});

