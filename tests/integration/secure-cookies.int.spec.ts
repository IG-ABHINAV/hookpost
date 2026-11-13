/**
 * The backend with secure cookies (NOT_SECURED empty): every way of
 * signing in (email sign-up, email login, Google One Tap, the OAuth state
 * cookie, choosing a workspace) sets httpOnly, Secure, SameSite=Lax cookies
 * and returns no session token in a header; the cookie alone carries the
 * session; sign-out expires all of them. The rest of the integration suite
 * runs with NOT_SECURED (tokens in headers), so this file turns it off before
 * the app boots.
 */
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { startApp, TestApp } from './setup/app';
import { uniqueEmail } from './setup/api';
import { db, disconnectDb, makeSuperAdmin } from './setup/db';
import { TrackService } from '@hookpost/nestjs-libraries/track/track.service';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';

type Cookie = { name: string; value: string; attrs: Record<string, string | true> };
const parseSetCookie = (line: string): Cookie => {
  const [pair, ...rest] = line.split(';').map((p) => p.trim());
  const eq = pair.indexOf('=');
  const attrs: Record<string, string | true> = {};
  for (const a of rest) {
    const i = a.indexOf('=');
    attrs[(i < 0 ? a : a.slice(0, i)).toLowerCase()] = i < 0 ? true : a.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs };
};
const cookiesOf = (res: { headers: Headers }) =>
  Object.fromEntries(res.headers.getSetCookie().map(parseSetCookie).map((c) => [c.name, c]));

const expectLockedDown = (c: Cookie | undefined) => {
  expect(c).toBeDefined();
  expect(c!.attrs.httponly).toBe(true);
  expect(c!.attrs.secure).toBe(true);
  expect(String(c!.attrs.samesite).toLowerCase()).toBe('lax');
};

describe('session cookies with NOT_SECURED empty', () => {
  let t: TestApp;
  const saved = { NOT_SECURED: process.env.NOT_SECURED, YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID };

  beforeAll(async () => {
    process.env.NOT_SECURED = '';
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
    jest.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const register = async (email = uniqueEmail('secure')) => {
    const res = await t.api.post('/auth/register', {
      email,
      password: 'Correct-Horse-9',
      company: 'Secure Co',
      provider: 'LOCAL',
    });
    expect(res.status).toBe(200);
    return { res, email };
  };

  it('email sign-up: httpOnly Secure Lax session, no token in any header', async () => {
    const { res } = await register();
    const c = cookiesOf(res);
    expectLockedDown(c.auth);
    expect(c.auth.value).toMatch(/^eyJ/);
    expect(c.auth.attrs.path || '/').toBe('/');
    // The hint is readable on purpose; it is not a credential.
    expect(c.hp_logged_in.attrs.httponly).toBeUndefined();
    expect(String(c.hp_logged_in.attrs.samesite).toLowerCase()).toBe('lax');
    expect(res.headers.get('auth')).toBeNull();
    expect(res.headers.get('showorg')).toBeNull();
  });

  it('the cookie alone is the session, and sign-out expires every session cookie', async () => {
    const { res } = await register();
    const jwt = cookiesOf(res).auth.value;
    const self = await t.api.get('/user/self', { cookies: { auth: jwt } });
    expect(self.status).toBe(200);

    const out = await t.api.post('/user/logout', undefined, { cookies: { auth: jwt } });
    expect(out.status).toBe(200);
    const cleared = cookiesOf(out);
    for (const name of ['auth', 'showorg', 'impersonate']) {
      expectLockedDown(cleared[name]);
      expect(cleared[name].value).toBe('');
      expect(new Date(String(cleared[name].attrs.expires)).getTime()).toBeLessThan(Date.now());
    }
  });

  it('a day-old session is renewed in the same locked-down cookie (30 days), never in a header', async () => {
    const { AuthService } = await import('@hookpost/helpers/auth/auth.service');
    const { db } = await import('./setup/db');
    const { email } = await register();
    const row = await db().user.findFirstOrThrow({ where: { email } });
    const old = AuthService.signSessionJWT(row, { issuedAt: Math.floor(Date.now() / 1000) - 2 * 86400 });
    const res = await t.api.get('/user/self', { cookies: { auth: old } });
    expect(res.status).toBe(200);
    const renewed = cookiesOf(res).auth;
    expectLockedDown(renewed);
    expect(renewed.value).not.toBe(old);
    expect(renewed.attrs['max-age']).toBe(String(30 * 86400));
    expect(res.headers.get('auth')).toBeNull();
    expect((await t.api.get('/user/self', { cookies: { auth: renewed.value } })).status).toBe(200);
  });

  it('email login: the same flags, no header', async () => {
    const { email } = await register();
    const res = await t.api.post('/auth/login', { email, password: 'Correct-Horse-9', provider: 'LOCAL' });
    expect(res.status).toBe(200);
    expectLockedDown(cookiesOf(res).auth);
    expect(res.headers.get('auth')).toBeNull();
  });

  it('choosing a workspace: httpOnly showorg, no header', async () => {
    const { res } = await register();
    const jwt = cookiesOf(res).auth.value;
    const orgs = await t.api.get('/user/organizations', { cookies: { auth: jwt } });
    const change = await t.api.post('/user/change-org', { id: orgs.body[0].id }, { cookies: { auth: jwt } });
    expect(change.status).toBe(200);
    expectLockedDown(cookiesOf(change).showorg);
    expect(change.headers.get('showorg')).toBeNull();
  });

  it('the OAuth sign-in state cookie is locked down too', async () => {
    process.env.YOUTUBE_CLIENT_ID = 'secure-cookie-test.apps.googleusercontent.com';
    const res = await t.api.get('/auth/oauth/GOOGLE');
    expect(res.status).toBe(200);
    expectLockedDown(cookiesOf(res).oauth_state);
  });

  it('Google One Tap sign-up: the same flags, no header', async () => {
    const CLIENT_ID = 'secure-cookie-test.apps.googleusercontent.com';
    const KID = 'secure-cookie-key';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.YOUTUBE_CLIENT_ID = CLIENT_ID;
    jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
      certs: { [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
      format: 'PEM',
    } as any);
    const b64 = (v: object | Buffer) =>
      (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: `g-${randomUUID()}`,
      email: uniqueEmail('secure-onetap'),
      email_verified: true,
      name: 'Secure One Tap',
      iat: now,
      exp: now + 600,
    })}`;
    const credential = `${head}.${b64(sign('RSA-SHA256', Buffer.from(head), privateKey))}`;

    const res = await t.api.post('/auth/oauth/google/one-tap', { credential });
    expect(res.status).toBe(200);
    expect(res.body.registered).toBe(true);
    expectLockedDown(cookiesOf(res).auth);
    expect(res.headers.get('auth')).toBeNull();
  });

  it('the first-touch copy /public/t keeps (hp_attr_s) is httpOnly, Secure and Lax, on this host only', async () => {
    // Meta's Conversions API is not called from a test.
    jest.spyOn(TrackService.prototype, 'track').mockResolvedValue(undefined as any);
    const touch = { utm_source: 'meta', utm_campaign: 'secure_copy', first_seen_at: Date.now() - 60_000 };
    const res = await t.api.post('/public/t', {
      tt: TrackEnum.ViewContent,
      additional: { content_name: '/start' },
      attr: touch,
    });
    expect(res.status).toBe(200);
    const copy = cookiesOf(res).hp_attr_s;
    expectLockedDown(copy);
    expect(copy.attrs.domain).toBeUndefined();
    expect(JSON.parse(copy.value)).toEqual(touch);
    // Ninety days after the touch, as hp_attr.
    expect(new Date(String(copy.attrs.expires)).getTime()).toBeGreaterThan(touch.first_seen_at + 89 * 86_400_000);
  });

  // A copy of a cookie set without the secure flags (NOT_SECURED mode) is
  // one the frontend sends as a header too (custom.fetch.func.ts).
  describe('readable copies and impersonation', () => {
    const jwtOf = (res: { headers: Headers }) => cookiesOf(res).auth.value;

    it('the cookie wins over a header that names another account', async () => {
      const a = await register();
      const b = await register();
      const self = await t.api.get('/user/self', {
        cookies: { auth: jwtOf(a.res) },
        headers: { auth: jwtOf(b.res) },
      });
      expect(self.status).toBe(200);
      expect(self.body.email).toBe(a.email);
      // Two different tokens: neither is set again.
      expect(cookiesOf(self).auth).toBeUndefined();
    });

    it('a readable copy, sent back as a header too, is set again httpOnly; the cookie alone is left alone', async () => {
      const { res } = await register();
      const jwt = jwtOf(res);
      const both = await t.api.get('/user/self', { cookies: { auth: jwt }, headers: { auth: jwt } });
      expect(both.status).toBe(200);
      const again = cookiesOf(both).auth;
      expectLockedDown(again);
      expect(again.value).toBe(jwt);
      expect(both.headers.get('auth')).toBeNull();

      const cookieOnly = await t.api.get('/user/self', { cookies: { auth: jwt } });
      expect(cookieOnly.status).toBe(200);
      expect(cookiesOf(cookieOnly).auth).toBeUndefined();
    });

    it('impersonation starts with an httpOnly cookie, the stop button expires it, and a header cannot keep it going', async () => {
      const admin = await register();
      const customer = await register();
      const adminJwt = jwtOf(admin.res);
      await makeSuperAdmin((await t.api.get('/user/self', { cookies: { auth: adminJwt } })).body.id);
      const { orgId } = (await t.api.get('/user/self', { cookies: { auth: jwtOf(customer.res) } })).body;
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: orgId } });

      const start = await t.api.post('/user/impersonate', { id: userOrg.id }, { cookies: { auth: adminJwt } });
      expect(start.status).toBe(201);
      const set = cookiesOf(start).impersonate;
      expectLockedDown(set);
      expect(set.value).toBe(userOrg.id);
      expect(start.headers.get('impersonate')).toBeNull();

      const as = await t.api.get('/user/self', { cookies: { auth: adminJwt, impersonate: userOrg.id } });
      expect(as.body.email).toBe(customer.email);
      expect(as.body.impersonate).toBe(true);

      const stop = await t.api.post('/user/impersonate', { id: '' }, {
        cookies: { auth: adminJwt, impersonate: userOrg.id },
      });
      expect(stop.status).toBe(201);
      const cleared = cookiesOf(stop).impersonate;
      expectLockedDown(cleared);
      expect(cleared.value).toBe('');
      expect(new Date(String(cleared.attrs.expires)).getTime()).toBeLessThan(Date.now());

      const after = await t.api.get('/user/self', {
        cookies: { auth: adminJwt },
        headers: { impersonate: userOrg.id },
      });
      expect(after.body.email).toBe(admin.email);
      expect(after.body.impersonate).toBe(false);
    });
  });
});
