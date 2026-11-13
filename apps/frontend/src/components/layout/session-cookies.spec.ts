/**
 * The frontend's side of secure session cookies (custom.fetch.func.ts), on
 * hookpost.hookstep.in as in production. Under NOT_SECURED the frontend wrote
 * readable copies of auth, showorg and impersonate itself, one host-only and
 * one on .hookstep.in (layout.context.tsx setCookie). With secure cookies:
 *
 * - the host-only copies are removed once per page load (a Set-Cookie for
 *   the domain, which is all the backend sends, can never reach them);
 * - a readable `auth` still goes out as a header, the backend's signal to set
 *   it again httpOnly; showorg and impersonate never do (the browser sends
 *   the cookies, and the backend ignores an impersonate header).
 *   pnpm exec jest -c apps/frontend/jest.config.ts session-cookies
 */

type Module = typeof import('@hookpost/helpers/utils/custom.fetch.func');
const load = (): Module => {
  let mod: Module | undefined;
  jest.isolateModules(() => {
    mod = require('@hookpost/helpers/utils/custom.fetch.func');
  });
  return mod!;
};

const clearAll = () => {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (!name) continue;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.hookstep.in`;
  }
};

/** What setCookie(name, value, 365) wrote: a host-only copy and one on the domain. */
const legacyCopies = (name: string, hostOnly: string, onDomain: string) => {
  document.cookie = `${name}=${hostOnly}; path=/`;
  document.cookie = `${name}=${onDomain}; path=/; domain=.hookstep.in`;
};

beforeEach(() => clearAll());

describe('clearHostOnlySessionCookies', () => {
  it('removes the host-only copies and leaves the ones on the domain', () => {
    legacyCopies('auth', 'host-auth', 'domain-auth');
    legacyCopies('showorg', 'host-org', 'domain-org');
    legacyCopies('impersonate', 'host-uo', 'domain-uo');
    document.cookie = 'hp_attr=keep; path=/';
    expect(document.cookie).toContain('auth=host-auth');

    load().clearHostOnlySessionCookies();

    const jar = document.cookie;
    for (const gone of ['host-auth', 'host-org', 'host-uo']) expect(jar).not.toContain(gone);
    for (const kept of ['auth=domain-auth', 'showorg=domain-org', 'impersonate=domain-uo', 'hp_attr=keep']) {
      expect(jar).toContain(kept);
    }
  });

  it('runs once per page load', () => {
    const m = load();
    m.clearHostOnlySessionCookies();
    document.cookie = 'auth=written-after; path=/';
    m.clearHostOnlySessionCookies();
    expect(document.cookie).toContain('auth=written-after');
  });
});

describe('customFetch headers', () => {
  const sent = () => {
    const calls = (global.fetch as jest.Mock).mock.calls;
    return calls[calls.length - 1][1].headers as Record<string, string>;
  };
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as any;
  });

  it('with secure cookies: a readable auth goes out (so the backend can upgrade it), showorg and impersonate do not', async () => {
    document.cookie = 'auth=readable-jwt; path=/; domain=.hookstep.in';
    document.cookie = 'showorg=org-1; path=/; domain=.hookstep.in';
    document.cookie = 'impersonate=uo-1; path=/; domain=.hookstep.in';
    await load().customFetch({ baseUrl: 'https://api.test' }, undefined, undefined, true)('/user/self');
    const headers = sent();
    expect(headers.auth).toBe('readable-jwt');
    expect(headers.showorg).toBeUndefined();
    expect(headers.impersonate).toBeUndefined();
  });

  it('with secure cookies and nothing readable: no session header at all', async () => {
    await load().customFetch({ baseUrl: 'https://api.test' }, undefined, undefined, true)('/user/self');
    const headers = sent();
    expect(headers.auth).toBeUndefined();
    expect(headers.showorg).toBeUndefined();
    expect(headers.impersonate).toBeUndefined();
  });

  it('NOT_SECURED: every readable cookie goes out as a header, as before', async () => {
    document.cookie = 'auth=dev-jwt; path=/';
    document.cookie = 'showorg=org-2; path=/';
    document.cookie = 'impersonate=uo-2; path=/';
    await load().customFetch({ baseUrl: 'https://api.test' }, undefined, undefined, false)('/user/self');
    expect(sent()).toMatchObject({ auth: 'dev-jwt', showorg: 'org-2', impersonate: 'uo-2' });
  });
});
