/**
 * Session cookie flags (session.cookies.ts). With NOT_SECURED empty every
 * session cookie is httpOnly, Secure and SameSite=Lax, and the token goes in
 * a response header only to a client that keeps no cookies. NOT_SECURED is
 * plain-http development: plain cookies, and the token in a header.
 *   pnpm exec jest -c apps/backend/jest.config.ts session.cookies
 */
import {
  askAboutInvite,
  clearPendingInvite,
  endSession,
  impersonationTarget,
  refreshSession,
  selectWorkspace,
  sessionCookie,
  sessionToken,
  settlePendingInvite,
  startSession,
  stopImpersonation,
  upgradeReadableSession,
} from '@hookpost/backend/services/auth/session.cookies';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const fakeResponse = () => {
  const cookies: Record<string, { value: string; options: any }> = {};
  const headers: Record<string, string> = {};
  return {
    cookies,
    headers,
    res: {
      cookie: (name: string, value: string, options: any) => {
        cookies[name] = { value, options };
      },
      header: (name: string, value: string) => {
        headers[name] = value;
      },
    } as any,
  };
};

const saved = { NOT_SECURED: process.env.NOT_SECURED, FRONTEND_URL: process.env.FRONTEND_URL };
beforeEach(() => {
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('with secure cookies (NOT_SECURED empty)', () => {
  beforeEach(() => {
    delete process.env.NOT_SECURED;
  });

  it('the session cookie is httpOnly, Secure and SameSite=Lax on the registrable domain', () => {
    expect(sessionCookie()).toMatchObject({
      domain: '.hookstep.in',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
    });
  });

  it('signing in sets the cookie and never echoes the token to a browser', () => {
    const { res, cookies, headers } = fakeResponse();
    startSession(res, 'jwt-1');
    expect(cookies.auth.value).toBe('jwt-1');
    expect(cookies.auth.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    // The hint is readable by design (the cached homepage's script), and is not a credential.
    expect(cookies.hp_logged_in).toMatchObject({ value: '1', options: { httpOnly: false, secure: true, sameSite: 'lax' } });
    expect(headers.auth).toBeUndefined();
  });

  it('a client that keeps no cookies (the native mobile sign-in) still gets the header', () => {
    const { res, headers } = fakeResponse();
    startSession(res, 'jwt-2', { forClient: true });
    expect(headers.auth).toBe('jwt-2');
  });

  it('choosing a workspace sets an httpOnly showorg cookie and no header', () => {
    const { res, cookies, headers } = fakeResponse();
    selectWorkspace(res, 'org-1');
    expect(cookies.showorg.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    expect(headers.showorg).toBeUndefined();
  });

  it('the auth cookie lives 30 days, as the session inside it does; showorg keeps its year', () => {
    const { res, cookies } = fakeResponse();
    startSession(res, 'jwt-30');
    selectWorkspace(res, 'org-1');
    expect(cookies.auth.options.maxAge).toBe(THIRTY_DAYS_MS);
    expect(cookies.showorg.options.maxAge).toBeUndefined();
  });

  it('a renewed session replaces the cookie with the same flags, and is never put in a header', () => {
    const { res, cookies, headers } = fakeResponse();
    refreshSession(res, 'jwt-renewed');
    expect(cookies.auth.value).toBe('jwt-renewed');
    expect(cookies.auth.options).toMatchObject({
      domain: '.hookstep.in',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: THIRTY_DAYS_MS,
    });
    expect(headers.auth).toBeUndefined();
    // Not a new sign-in: the hint and the workspace are left as they are.
    expect(cookies.hp_logged_in).toBeUndefined();
    expect(cookies.showorg).toBeUndefined();
  });

  it('signing out expires every session cookie with the same domain', () => {
    const { res, cookies } = fakeResponse();
    endSession(res);
    // invite_pending: a Join question asked of this account is not for
    // whoever signs in next on this browser.
    for (const name of ['auth', 'hp_logged_in', 'showorg', 'impersonate', 'invite_pending']) {
      expect(cookies[name].value).toBe('');
      expect(cookies[name].options.domain).toBe('.hookstep.in');
      expect(cookies[name].options.expires.getTime()).toBe(0);
    }
  });

  it('stopping impersonation expires the cookie instead of leaving an empty one', () => {
    const { res, cookies } = fakeResponse();
    stopImpersonation(res);
    expect(cookies.impersonate.value).toBe('');
    expect(cookies.impersonate.options).toMatchObject({ domain: '.hookstep.in', httpOnly: true });
    expect(cookies.impersonate.options.expires.getTime()).toBe(0);
  });

  it('the session is the cookie first, the header only without one', () => {
    expect(sessionToken({ cookies: { auth: 'c' }, headers: { auth: 'h' } } as any)).toBe('c');
    expect(sessionToken({ cookies: {}, headers: { auth: 'h' } } as any)).toBe('h');
    expect(sessionToken({ cookies: {}, headers: {} } as any)).toBeUndefined();
  });

  it('impersonation comes from the cookie only; a header is ignored', () => {
    expect(impersonationTarget({ cookies: { impersonate: 'uo-1' }, headers: {} } as any)).toBe('uo-1');
    expect(impersonationTarget({ cookies: {}, headers: { impersonate: 'uo-1' } } as any)).toBeUndefined();
    // An empty cookie next to a readable copy the page sends as a header.
    expect(impersonationTarget({ cookies: { impersonate: '' }, headers: { impersonate: 'uo-1' } } as any)).toBeUndefined();
  });

  it('a readable session copy (cookie plus the same token as a header) is set again httpOnly', () => {
    const { res, cookies } = fakeResponse();
    expect(upgradeReadableSession({ cookies: { auth: 'jwt-4' }, headers: { auth: 'jwt-4' } } as any, res)).toBe(true);
    expect(cookies.auth).toMatchObject({ value: 'jwt-4', options: { httpOnly: true, secure: true, sameSite: 'lax', domain: '.hookstep.in' } });
  });

  it('nothing to upgrade with the cookie alone, the header alone (no cookies kept), or two different tokens', () => {
    for (const req of [
      { cookies: { auth: 'jwt-5' }, headers: {} },
      { cookies: {}, headers: { auth: 'jwt-5' } },
      { cookies: { auth: 'jwt-5' }, headers: { auth: 'jwt-older' } },
    ]) {
      const { res, cookies } = fakeResponse();
      expect(upgradeReadableSession(req as any, res)).toBe(false);
      expect(cookies.auth).toBeUndefined();
    }
  });
});

describe('NOT_SECURED (plain-http development, the integration suite)', () => {
  beforeEach(() => {
    process.env.NOT_SECURED = 'true';
  });

  it('keeps the plain cookie and returns the token in a header, as before', () => {
    const { res, cookies, headers } = fakeResponse();
    startSession(res, 'jwt-3');
    expect(cookies.auth.options.httpOnly).toBeUndefined();
    expect(cookies.auth.options.sameSite).toBeUndefined();
    expect(headers.auth).toBe('jwt-3');
    selectWorkspace(res, 'org-2');
    expect(headers.showorg).toBe('org-2');
  });

  it('the impersonate header still counts, and nothing is upgraded', () => {
    expect(impersonationTarget({ cookies: {}, headers: { impersonate: 'uo-2' } } as any)).toBe('uo-2');
    const { res, cookies } = fakeResponse();
    expect(upgradeReadableSession({ cookies: { auth: 'jwt-6' }, headers: { auth: 'jwt-6' } } as any, res)).toBe(false);
    expect(cookies.auth).toBeUndefined();
  });

  it('a renewed session comes back in the header too, which the frontend copies', () => {
    const { res, cookies, headers } = fakeResponse();
    refreshSession(res, 'jwt-4');
    expect(cookies.auth.value).toBe('jwt-4');
    expect(cookies.auth.options.maxAge).toBe(THIRTY_DAYS_MS);
    expect(headers.auth).toBe('jwt-4');
  });
});

describe('the Join question cookie (invite_pending)', () => {
  beforeEach(() => {
    delete process.env.NOT_SECURED;
  });

  it('"Not now" expires it with the flags the proxy set it with, and touches nothing else', () => {
    const { res, cookies } = fakeResponse();
    clearPendingInvite(res);
    expect(Object.keys(cookies)).toEqual(['invite_pending']);
    expect(cookies.invite_pending.value).toBe('');
    expect(cookies.invite_pending.options).toMatchObject({ domain: '.hookstep.in', path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
    expect(cookies.invite_pending.options.expires.getTime()).toBe(0);
  });

  it('Join: the question goes, the outcome is readable once, the joined workspace is shown', () => {
    const { res, cookies } = fakeResponse();
    settlePendingInvite(res, { outcome: 'joined', organizationId: 'org-team' });
    expect(cookies.invite_pending.options.expires.getTime()).toBe(0);
    expect(cookies.hp_invite.value).toBe('joined');
    expect(cookies.hp_invite.options).toMatchObject({ path: '/', httpOnly: false, maxAge: 600_000 });
    expect(cookies.showorg.value).toBe('org-team');
    expect(cookies.showorg.options.httpOnly).toBe(true);
  });

  it('an automatic sign-in turns the sign-in invite into the question: same flags as the proxy, the org cookie spent', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnZpdGUiOjF9.c2lnbmF0dXJl';
    const { res, cookies } = fakeResponse();
    expect(askAboutInvite({ cookies: { org: token } } as any, res)).toBe(true);
    expect(cookies.invite_pending.value).toBe(token);
    expect(cookies.invite_pending.options).toMatchObject({ domain: '.hookstep.in', path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: 3_600_000 });
    expect(cookies.org.value).toBe('');
    expect(cookies.org.options.expires.getTime()).toBe(0);
  });

  it('nothing to ask about without an invite token', () => {
    for (const org of [undefined, '', 'garbage', 'a.b', `${'a'.repeat(3000)}.b.c`]) {
      const { res, cookies } = fakeResponse();
      expect(askAboutInvite({ cookies: { org } } as any, res)).toBe(false);
      expect(cookies).toEqual({});
    }
  });

  it('an outcome with no workspace (held, full, invalid) switches nothing', () => {
    const { res, cookies } = fakeResponse();
    settlePendingInvite(res, { outcome: 'full' });
    expect(cookies.hp_invite.value).toBe('full');
    expect(cookies.showorg).toBeUndefined();
    expect(cookies.invite_pending.value).toBe('');
  });
});
