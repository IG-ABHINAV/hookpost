/**
 * @jest-environment node
 *
 * Team invite links in the proxy (proxy.invite.ts). Until 25 Oct 2026 an
 * emailed /?org=<token> opened by a signed-out visitor showed the homepage
 * and kept nothing (Cloudflare serves "/" from its cache whatever the query
 * string), and a signed-in visitor whose email was unconfirmed was sent to
 * /?added=true without being added. Later that day: a signed-in visitor was
 * joined on the GET itself; now they are asked first (/invite).
 *   pnpm exec jest -c apps/frontend/jest.config.ts proxy.invite
 */
import { NextRequest } from 'next/server';

const internalFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/internal.fetch', () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
}));

import { proxy } from '@hookpost/frontend/proxy';
import { tokenFromPath } from '@hookpost/frontend/proxy.invite';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.c2lnbmF0dXJl`;
const now = () => Math.floor(Date.now() / 1000);

const LIVE = jwt({ id: 'user-1', iat: now() - 60, exp: now() + 3600 });
const EXPIRED = jwt({ id: 'user-1', iat: now() - 31 * 86400, exp: now() - 86400 });
const TOKEN = jwt({ purpose: 'team-invite', orgId: 'org-a', id: 'abcde', role: 'USER' });

const ORIGIN = 'https://hookpost.hookstep.in';
const get = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`${ORIGIN}${path}`, { headers }));
const location = (res: Response) => res.headers.get('location');
const target = (res: Response) => {
  const l = location(res);
  if (!l) return null;
  const u = new URL(l, ORIGIN);
  return { origin: u.origin, path: u.pathname + u.search };
};
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieNamed = (res: Response, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));

const joinReply = (status: number, body: unknown) =>
  internalFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  );

const saved = { NOT_SECURED: process.env.NOT_SECURED, FRONTEND_URL: process.env.FRONTEND_URL };
beforeEach(() => {
  process.env.FRONTEND_URL = ORIGIN;
  delete process.env.NOT_SECURED;
  internalFetch.mockReset();
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('/invite/<token>, signed out', () => {
  it('keeps the token in an httpOnly cookie and goes to the sign-up page', async () => {
    const res = await get(`/invite/${TOKEN}`);
    expect(res.status).toBe(307);
    expect(target(res)).toEqual({ origin: ORIGIN, path: '/auth?invite=1' });
    const cookie = cookieNamed(res, 'org')!;
    expect(cookie).toContain(`org=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Domain=\.hookstep\.in/i);
    // An hour, not the invite's two days (review of 1162ff204).
    expect(cookie).toMatch(/Max-Age=3600/);
    // Nothing joins before the visitor signs up or in.
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('is never cached and sends no referrer on to the sign-up page', async () => {
    const res = await get(`/invite/${TOKEN}`);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('someone whose session ended goes to the sign-in form, invite kept', async () => {
    for (const headers of [{ cookie: `auth=${EXPIRED}` }, { cookie: 'hp_logged_in=1' }]) {
      const res = await get(`/invite/${TOKEN}`, headers);
      expect(target(res)!.path).toBe('/auth/login?invite=1');
      expect(cookieNamed(res, 'org')).toContain(TOKEN);
    }
  });

  it('a token that is not shaped like one sets no cookie and says the link is not valid', async () => {
    for (const bad of ['nope', 'a.b', 'a.b.c.d', '%E0%A4%A', 'a.b.c%3Bpath%3D%2F', `${'a'.repeat(2100)}.b.c`]) {
      const res = await get(`/invite/${bad}`);
      expect(target(res)).toEqual({ origin: ORIGIN, path: '/auth?invite=invalid' });
      expect(cookieNamed(res, 'org')).toBeUndefined();
    }
    // Nothing after the token, nothing missing.
    for (const p of ['/invite', '/invite/', `/invite/${TOKEN}/extra`]) {
      const res = await get(p);
      expect(target(res)!.path).toBe('/auth?invite=invalid');
    }
  });
});

describe('/invite/<token>, signed in: asked first, never joined on the GET', () => {
  const signedIn = { cookie: `auth=${LIVE}` };
  const QUESTION = { valid: true, team: 'Acme', inviter: 'Jo', member: false, confirmEmail: false, ref: 'r' };

  it('reads the question (a GET), keeps the token in an httpOnly cookie and goes to /invite', async () => {
    joinReply(200, QUESTION);
    const res = await get(`/invite/${TOKEN}`, signedIn);
    // Only the side-effect-free GET; nothing that joins.
    expect(internalFetch).toHaveBeenCalledTimes(1);
    expect(internalFetch).toHaveBeenCalledWith('/user/invite', {
      method: 'GET',
      headers: { cookie: `invite_pending=${TOKEN}` },
    });
    expect(JSON.stringify(internalFetch.mock.calls)).not.toMatch(/join-org|accept|POST/);
    expect(res.status).toBe(307);
    expect(target(res)).toEqual({ origin: ORIGIN, path: '/invite' });
    const cookie = cookieNamed(res, 'invite_pending')!;
    expect(cookie).toContain(`invite_pending=${TOKEN}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Domain=\.hookstep\.in/i);
    expect(cookie).toMatch(/Max-Age=3600/);
    // Nothing is decided yet: no result, no workspace switch, and not the
    // sign-in cookie (which a later sign-in would redeem).
    expect(cookieNamed(res, 'hp_invite')).toBeUndefined();
    expect(cookieNamed(res, 'showorg')).toBeUndefined();
    expect(cookieNamed(res, 'org')).toBeUndefined();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('an unconfirmed account is asked too (Join then holds it), never sent to /?added=true', async () => {
    joinReply(200, { ...QUESTION, confirmEmail: true });
    const res = await get(`/invite/${TOKEN}`, signedIn);
    expect(target(res)!.path).toBe('/invite');
    expect(location(res)).not.toContain('added');
  });

  it('someone already in that team is asked as well (the page says so)', async () => {
    joinReply(200, { ...QUESTION, member: true });
    const res = await get(`/invite/${TOKEN}`, signedIn);
    expect(target(res)!.path).toBe('/invite');
    expect(cookieNamed(res, 'showorg')).toBeUndefined();
  });

  it('a link that cannot be used skips the question: the app says it expired or was used', async () => {
    joinReply(200, { valid: false });
    const res = await get(`/invite/${TOKEN}`, signedIn);
    expect(target(res)!.path).toBe('/launches');
    expect(cookieNamed(res, 'hp_invite')).toContain('hp_invite=invalid');
    expect(cookieNamed(res, 'invite_pending')).toBeUndefined();
  });

  it('an answer it does not know, or a backend error, is "error" (never a guess, never a question)', async () => {
    for (const body of [{ valid: 'yes' }, null, { invite: 'joined' }]) {
      joinReply(200, body);
      const res = await get(`/invite/${TOKEN}`, signedIn);
      expect(target(res)!.path).toBe('/launches');
      expect(cookieNamed(res, 'hp_invite')).toContain('hp_invite=error');
      expect(cookieNamed(res, 'invite_pending')).toBeUndefined();
    }
    joinReply(500, { message: 'boom' });
    expect(cookieNamed(await get(`/invite/${TOKEN}`, signedIn), 'hp_invite')).toContain('hp_invite=error');
    internalFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const down = await get(`/invite/${TOKEN}`, signedIn);
    expect(target(down)!.path).toBe('/launches');
    expect(cookieNamed(down, 'hp_invite')).toContain('hp_invite=error');
    // A backend hiccup does not sign the user out (the old catch went to /auth/logout).
    expect(location(down)).not.toContain('logout');
  });

  it('the backend refuses the session (401): signed out after all, the invite is kept for the sign-in', async () => {
    joinReply(401, { message: 'Unauthorized' });
    const res = await get(`/invite/${TOKEN}`, signedIn);
    expect(target(res)!.path).toBe('/auth/login?invite=1');
    expect(cookieNamed(res, 'org')).toContain(TOKEN);
    expect(cookieNamed(res, 'invite_pending')).toBeUndefined();
    // The refused session is expired (domain and host-only copies), so the
    // sign-in form is not bounced to /launches on it.
    const cleared = setCookies(res).filter((c) => c.startsWith('auth=;') && /Max-Age=0/i.test(c));
    expect(cleared).toHaveLength(2);
  });

  it('a malformed token is not sent to the backend', async () => {
    const res = await get('/invite/not-a-token', signedIn);
    expect(internalFetch).not.toHaveBeenCalled();
    expect(cookieNamed(res, 'hp_invite')).toContain('hp_invite=invalid');
    expect(cookieNamed(res, 'invite_pending')).toBeUndefined();
  });
});

describe('/invite, the question itself', () => {
  it('signed in: the page loads (no redirect, nothing set), never cached', async () => {
    const res = await get('/invite', { cookie: `auth=${LIVE}; invite_pending=${TOKEN}` });
    expect(location(res)).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(setCookies(res).filter((c) => /^(org|invite_pending|hp_invite|showorg)=/.test(c))).toEqual([]);
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('signed out: not a page for them; the sign-up form, as before', async () => {
    const res = await get('/invite', { cookie: `invite_pending=${TOKEN}` });
    expect(target(res)!.path).toBe('/auth?invite=invalid');
    // A question asked of a signed-in account never becomes a sign-in invite.
    expect(cookieNamed(res, 'org')).toBeUndefined();
  });

  it('signing out removes a pending question with the flags it was set with', async () => {
    const res = await get('/auth/logout', { cookie: `auth=${LIVE}; invite_pending=${TOKEN}` });
    const cookie = cookieNamed(res, 'invite_pending')!;
    expect(cookie).toMatch(/^invite_pending=;/);
    expect(cookie).toMatch(/Max-Age=(-1|0)\b/);
    expect(cookie).toMatch(/Domain=\.hookstep\.in/i);
    expect(cookie).toMatch(/HttpOnly/i);
  });
});

describe('only a GET follows a link (review of 6b39f4692)', () => {
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    '%s /invite/<token>: 405, no cookie, nothing asked',
    async (method) => {
      for (const headers of [{}, { cookie: `auth=${LIVE}` }]) {
        const res = await proxy(
          new NextRequest(`${ORIGIN}/invite/${TOKEN}`, {
            method,
            headers,
            ...(method === 'POST' || method === 'PUT' || method === 'PATCH' ? { body: 'a=1' } : {}),
          })
        );
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('GET, HEAD');
        expect(setCookies(res)).toEqual([]);
      }
      expect(internalFetch).not.toHaveBeenCalled();
    }
  );

  it('HEAD is a GET', async () => {
    const res = await proxy(new NextRequest(`${ORIGIN}/invite/${TOKEN}`, { method: 'HEAD' }));
    expect(target(res)!.path).toBe('/auth?invite=1');
  });
});

describe('/auth/logout from another site (review of 6b39f4692)', () => {
  it('is refused: the session stays, the app opens', async () => {
    const res = await get('/auth/logout', { cookie: `auth=${LIVE}`, 'sec-fetch-site': 'cross-site' });
    expect(target(res)!.path).toBe('/launches');
    expect(setCookies(res).filter((c) => /^auth=/.test(c))).toEqual([]);
  });

  it.each([['same-origin'], ['same-site'], ['none'], [undefined]])(
    'Sec-Fetch-Site %s (the app, a typed URL, an old browser): signed out as before',
    async (site) => {
      const res = await get('/auth/logout', {
        cookie: `auth=${LIVE}`,
        ...(site ? { 'sec-fetch-site': site } : {}),
      });
      expect(target(res)!.path).toBe('/auth/login');
      expect(cookieNamed(res, 'auth')).toMatch(/^auth=;/);
    }
  );
});

describe('the old /?org=<token> links', () => {
  it('signed out, "/" is the same homepage as without the query: no redirect, no cookie', async () => {
    // Cloudflare caches "/" with the query string ignored. Whatever this
    // answers is served to every signed-out visitor for a day, so it must
    // not depend on ?org=. INVITE_LINK_SCRIPT moves it in the browser.
    const plain = await get('/');
    const invited = await get(`/?org=${TOKEN}`);
    expect(invited.status).toBe(plain.status);
    expect(location(invited)).toBeNull();
    expect(setCookies(invited)).toEqual(setCookies(plain));
    expect(invited.headers.get('x-middleware-next')).toBe(plain.headers.get('x-middleware-next'));
    expect(internalFetch).not.toHaveBeenCalled();
  });

  it('signed in, "/" goes to /invite/<token> (Cloudflare never caches a signed-in request)', async () => {
    const res = await get(`/?org=${TOKEN}`, { cookie: `auth=${LIVE}` });
    expect(target(res)).toEqual({ origin: ORIGIN, path: `/invite/${TOKEN}` });
  });

  it('an empty ?org= is no invite: the app as usual', async () => {
    const res = await get('/?org=', { cookie: `auth=${LIVE}` });
    expect(target(res)!.path).toBe('/launches?org=');
    expect(location(await get('/settings?org=', { cookie: `auth=${LIVE}` }))).toBeNull();
  });

  it('/auth?org= and app paths with ?org= go to /invite/ too, signed in or out', async () => {
    for (const p of ['/auth', '/auth/login', '/launches', '/settings']) {
      for (const headers of [{}, { cookie: `auth=${LIVE}` }]) {
        const res = await get(`${p}?org=${TOKEN}`, headers);
        expect(target(res)).toEqual({ origin: ORIGIN, path: `/invite/${TOKEN}` });
        // The cookie is set by /invite/ alone.
        expect(cookieNamed(res, 'org')).toBeUndefined();
      }
    }
  });

  it('a value that is not a token becomes /invite/invalid, never a path of its own', async () => {
    for (const org of ['..', '../../auth/logout', '//evil.example', 'https://evil.example/x', 'a b']) {
      const res = await get(`/launches?org=${encodeURIComponent(org)}`, { cookie: `auth=${LIVE}` });
      expect(target(res)).toEqual({ origin: ORIGIN, path: '/invite/invalid' });
    }
  });
});

describe('open-redirect attempts through the invite flow', () => {
  const attempts = [
    `/invite/${TOKEN}?returnUrl=https://evil.example`,
    `/invite/${TOKEN}?next=//evil.example&redirect=https:%2F%2Fevil.example`,
    '/invite/%2F%2Fevil.example',
    '/invite/https:%2F%2Fevil.example',
    '/invite//evil.example',
    '/invite/javascript:alert(1)',
    '/invite/%0d%0aLocation:%20https://evil.example',
  ];
  it.each(attempts)('%s stays on this site, at a fixed path', async (p) => {
    for (const headers of [{}, { cookie: `auth=${LIVE}` }]) {
      joinReply(200, { valid: true, team: 'Acme', inviter: null, member: false, confirmEmail: false, ref: 'r' });
      const res = await get(p, headers);
      const t = target(res)!;
      expect(t.origin).toBe(ORIGIN);
      expect(['/auth?invite=1', '/auth?invite=invalid', '/launches', '/invite']).toContain(t.path);
      expect(location(res)).not.toMatch(/evil/);
    }
  });
});

describe('tokenFromPath', () => {
  it('takes exactly /invite/<one segment>, decoded and token-shaped', () => {
    expect(tokenFromPath(`/invite/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/invite/${encodeURIComponent(TOKEN)}`)).toBe(TOKEN);
    expect(tokenFromPath('/invite/')).toBeNull();
    expect(tokenFromPath(`/invite/${TOKEN}/`)).toBeNull();
    expect(tokenFromPath(`/x/invite/${TOKEN}`)).toBeNull();
    expect(tokenFromPath('/invite/%E0%A4')).toBeNull();
  });
});
