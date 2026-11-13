/**
 * @jest-environment node
 *
 * A session lasts 30 days, renewed while in use. The proxy counts only a
 * session whose exp is in the future as signed in, so /auth/login is never
 * bounced to /launches by a dead one; a dead one is expired on the way to
 * the login form, and a visitor whose cookie ran out with its token (only
 * the hp_logged_in hint left) is sent to the login form as well.
 *   pnpm exec jest -c apps/frontend/jest.config.ts proxy.session-expiry
 */
import { NextRequest } from 'next/server';
import { proxy } from '@hookpost/frontend/proxy';
import {
  sessionLooksLive,
  unverifiedClaims,
} from '@hookpost/helpers/auth/session.lifetime';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.signature`;
const now = () => Math.floor(Date.now() / 1000);

const LIVE = jwt({ id: 'user-1', iat: now() - 60, exp: now() + 3600 });
const EXPIRED = jwt({ id: 'user-1', iat: now() - 31 * 86400, exp: now() - 86400 });
/** A token without exp: the user row only. Not a session. */
const LEGACY = jwt({ id: 'user-1', email: 'jo@example.com', iat: 1760000000 });

const ORIGIN = 'https://hookpost.hookstep.in';
const get = (path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`${ORIGIN}${path}`, { headers }));
const location = (res: Response) => res.headers.get('location');
const path = (res: Response) =>
  location(res) ? new URL(location(res)!).pathname + new URL(location(res)!).search : null;
const authClears = (res: Response) =>
  res.headers
    .getSetCookie()
    .filter((c) => c.startsWith('auth=;') && /Max-Age=0/i.test(c));

const saved = { NOT_SECURED: process.env.NOT_SECURED, FRONTEND_URL: process.env.FRONTEND_URL };
beforeEach(() => {
  process.env.FRONTEND_URL = ORIGIN;
  delete process.env.NOT_SECURED;
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('sessionLooksLive', () => {
  it('a JWT with a future exp is live; past, missing or unreadable is not', () => {
    expect(sessionLooksLive(LIVE)).toBe(true);
    expect(sessionLooksLive(EXPIRED)).toBe(false);
    expect(sessionLooksLive(LEGACY)).toBe(false);
    expect(sessionLooksLive('session')).toBe(false);
    expect(sessionLooksLive('a.b.c')).toBe(false);
    expect(sessionLooksLive(undefined)).toBe(false);
  });

  it('reads names outside ASCII (the payload is the user row)', () => {
    const token = jwt({ id: 'user-1', name: 'जतिंदर 🎬', exp: now() + 60 });
    expect(unverifiedClaims(token)).toMatchObject({ name: 'जतिंदर 🎬' });
    expect(sessionLooksLive(token)).toBe(true);
  });
});

describe('proxy: a live session', () => {
  it('/auth/login still sends a signed-in visitor to the app', async () => {
    const res = await get('/auth/login', { cookie: `auth=${LIVE}` });
    expect(res.status).toBe(307);
    expect(path(res)).toBe('/launches');
    expect(authClears(res)).toEqual([]);
  });

  it('the app is served, and nothing is cleared', async () => {
    const res = await get('/launches', { cookie: `auth=${LIVE}` });
    expect(location(res)).toBeNull();
    expect(authClears(res)).toEqual([]);
  });

  it('a stale host-only copy next to a live domain cookie still counts as signed in', async () => {
    const res = await get('/launches', { cookie: `auth=${LEGACY}; auth=${LIVE}` });
    expect(location(res)).toBeNull();
    expect(authClears(res)).toEqual([]);
  });
});

describe('proxy: an expired session, or a token without exp', () => {
  it.each([
    ['expired', EXPIRED],
    ['without exp', LEGACY],
    ['not a JWT', 'session'],
  ])('%s: /launches goes to the login form (not sign-up) and the cookie is expired', async (_label, token) => {
    const res = await get('/launches', { cookie: `auth=${token}; hp_logged_in=1` });
    expect(res.status).toBe(307);
    expect(path(res)).toBe('/auth/login');
    const clears = authClears(res);
    // The domain cookie the backend sets, and the host-only copy the app wrote.
    expect(clears).toHaveLength(2);
    expect(clears.some((c) => /Domain=\.hookstep\.in/i.test(c))).toBe(true);
    expect(clears.some((c) => !/Domain=/i.test(c))).toBe(true);
    for (const c of clears) expect(c).toMatch(/Path=\//);
  });

  it('/auth/login is served (no bounce to /launches), and the cookie is expired', async () => {
    const res = await get('/auth/login', { cookie: `auth=${EXPIRED}` });
    expect(location(res)).toBeNull();
    expect(authClears(res)).toHaveLength(2);
  });

  it('the sign-up and reset pages are served too', async () => {
    for (const p of ['/auth', '/auth/forgot', '/auth/forgot/abc.def.ghi']) {
      expect(location(await get(p, { cookie: `auth=${LEGACY}` }))).toBeNull();
    }
  });

  it('/billing keeps its returnUrl to the login form', async () => {
    const res = await get('/billing', { cookie: `auth=${EXPIRED}` });
    expect(path(res)).toBe('/auth/login?returnUrl=%2Fbilling');
    expect(authClears(res)).toHaveLength(2);
  });

  it('/ is the homepage, the dead cookie and the login hint are cleared', async () => {
    const res = await get('/', { cookie: `auth=${LEGACY}; hp_logged_in=1` });
    expect(location(res)).toBeNull();
    expect(authClears(res)).toHaveLength(2);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('hp_logged_in=;'))).toBe(true);
  });

  it('a /modal/ link asks to sign in', async () => {
    const res = await get('/modal/x', { cookie: `auth=${EXPIRED}` });
    expect(path(res)).toBe('/auth/login-required');
  });

  it('a session in the auth header or ?loggedAuth is judged the same way', async () => {
    expect(path(await get('/launches', { auth: EXPIRED }))).toBe('/auth/login');
    expect(location(await get(`/launches?loggedAuth=${LIVE}`))).toBeNull();
  });

  it('secure cookies: the clear carries Secure and SameSite=Lax, and HttpOnly on the domain cookie', async () => {
    const [domain, hostOnly] = authClears(await get('/launches', { cookie: `auth=${EXPIRED}` }));
    expect(domain).toMatch(/Secure/i);
    expect(domain).toMatch(/HttpOnly/i);
    expect(domain).toMatch(/SameSite=Lax/i);
    expect(hostOnly).toMatch(/Secure/i);
  });

  it('NOT_SECURED (plain-http development): the clear has no Secure flag', async () => {
    process.env.NOT_SECURED = 'true';
    const clears = authClears(await get('/launches', { cookie: `auth=${EXPIRED}` }));
    expect(clears).toHaveLength(2);
    for (const c of clears) expect(c).not.toMatch(/Secure/i);
  });

  it('a visitor with no cookie at all is unchanged: sign-up form, nothing cleared', async () => {
    const res = await get('/launches');
    expect(path(res)).toBe('/auth');
    expect(authClears(res)).toEqual([]);
  });

  // The cookie's Max-Age ends with the token's exp, so after 30 days unused
  // the browser sends no auth at all; the year-long hint is what is left.
  it('only the login hint left (the cookie ran out with its token): the login form, and it clears the hint', async () => {
    const res = await get('/launches', { cookie: 'hp_logged_in=1' });
    expect(res.status).toBe(307);
    expect(path(res)).toBe('/auth/login');
    expect(authClears(res)).toEqual([]);
    const login = await get('/auth/login', { cookie: 'hp_logged_in=1' });
    expect(location(login)).toBeNull();
    expect(login.headers.getSetCookie().some((c) => c.startsWith('hp_logged_in=;'))).toBe(true);
    // The homepage stays the homepage.
    expect(location(await get('/', { cookie: 'hp_logged_in=1' }))).toBeNull();
    // A path that is not an app page is still a 404, not a redirect.
    expect(location(await get('/no-such-page', { cookie: 'hp_logged_in=1' }))).toBeNull();
  });
});

describe('proxy: what must not change for a dead session', () => {
  it('preview and share links (/p/:id) render, with no redirect', async () => {
    for (const p of ['/p/AbC123', '/p/AbC123?share=true']) {
      const res = await get(p, { cookie: `auth=${EXPIRED}` });
      expect(location(res)).toBeNull();
    }
  });

  it('the Play app (TWA): a dead session gets the homepage, a live one the app with ?source=twa', async () => {
    const referer = 'android-app://in.hookstep.hookpost.twa/';
    const dead = await get('/', { cookie: `auth=${LEGACY}`, referer });
    expect(location(dead)).toBeNull();
    const live = await get('/', { cookie: `auth=${LIVE}`, referer });
    expect(location(live)).toBe(`${ORIGIN}/launches?source=twa`);
  });

  it('/auth/logout still clears the session and goes to the login form', async () => {
    const res = await get('/auth/logout', { cookie: `auth=${LIVE}` });
    expect(path(res)).toBe('/auth/login');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('auth=;'))).toBe(true);
  });

  it('marketing pages are left alone', async () => {
    const res = await get('/pricing', { cookie: `auth=${EXPIRED}` });
    expect(location(res)).toBeNull();
    expect(authClears(res)).toEqual([]);
  });
});
