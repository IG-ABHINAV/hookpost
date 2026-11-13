/**
 * Login sessions. A session carries iat, exp (30 days) and a stamp of the
 * password it was issued under; the backend refuses one past exp, one
 * without exp and one issued before the latest password reset, and
 * re-issues a session that is a day old, so an active user is never signed
 * out.
 *
 * The second half pins what must not change: API keys (public API, MCP, CLI),
 * OAuth apps, /enterprise, invite and reset links, impersonation, the cookie
 * the Play app (TWA) uses, Google One Tap, preview links and Temporal.
 *
 * Runs with NOT_SECURED like the rest of the suite (the token comes back in
 * the `auth` header); secure-cookies.int.spec.ts covers the cookie flags.
 */
import { execFileSync, spawn } from 'child_process';
import { copyFileSync, mkdtempSync } from 'fs';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as rsaSign } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { decode, sign } from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import dayjs from 'dayjs';
import { AuthService, PASSWORD_STAMP_CLAIM } from '@hookpost/helpers/auth/auth.service';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail, inviteTokenFrom } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';

const ROOT = join(__dirname, '..', '..');
const DAY = 24 * 60 * 60;
const TTL = 30 * DAY;
const now = () => Math.floor(Date.now() / 1000);
const claimsOf = (token: string) => decode(token) as Record<string, any>;
const resetTokenFrom = (html: string) => /\/auth\/forgot\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];
const authSetCookie = (res: { headers: Headers }) =>
  res.headers.getSetCookie().find((c) => c.startsWith('auth='));

describe('session expiry', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp({ mcp: true });
  });
  afterAll(async () => {
    jest.restoreAllMocks();
    await t?.close();
    await disconnectDb();
  });

  /** A session for that user as the backend would have issued it `ago` seconds ago. */
  const sessionIssued = async (email: string, ago: number) => {
    const row = await db().user.findFirstOrThrow({ where: { email } });
    return AuthService.signSessionJWT(row, { issuedAt: now() - ago });
  };
  /** The user row, signed, without exp: not a session. */
  const legacySession = async (email: string) => {
    const { password: _p, ...row } = await db().user.findFirstOrThrow({ where: { email } });
    return sign({ ...row, iat: now() - 60 * DAY }, process.env.JWT_SECRET!);
  };

  /** Forgot password, then the emailed link with a new password. */
  async function resetPassword(email: string, password = 'Brand-New-Pass-7') {
    t.temporal.reset();
    await t.api.post('/auth/forgot', { email });
    const mail = t.temporal.emails().find((m) => m.to === email);
    const token = resetTokenFrom(mail!.html)!;
    const res = await t.api.post('/auth/forgot-return', { token, password, repeatPassword: password });
    expect(res.body).toEqual({ reset: true });
    return { token, password };
  }

  describe('issue', () => {
    it('sign-up and login sessions carry iat, a 30-day exp and the password stamp, never the hash', async () => {
      const s = await t.api.register();
      const login = await t.api.login(s.email, s.password);
      const row = await db().user.findFirstOrThrow({ where: { email: s.email } });
      for (const token of [s.auth, login.auth]) {
        const c = claimsOf(token);
        expect(Math.abs(c.iat - now())).toBeLessThan(60);
        expect(c.exp - c.iat).toBe(TTL);
        expect(typeof c[PASSWORD_STAMP_CLAIM]).toBe('string');
        expect(c).not.toHaveProperty('password');
        expect(token).not.toContain(row.password!.slice(7));
      }
      // Two sign-ins, two sessions.
      expect(login.auth).not.toBe(s.auth);
    });

    it('the auth cookie lives 30 days, as the session inside it does', async () => {
      const res = await t.api.post('/auth/login', {
        email: (await t.api.register()).email,
        password: 'Correct-Horse-9',
        provider: 'LOCAL',
      });
      expect(authSetCookie(res)).toMatch(new RegExp(`Max-Age=${TTL}(;|$)`));
    });
  });

  describe('expiry', () => {
    it('a session past its exp gets a 401 that signs the browser out, not a 500', async () => {
      const s = await t.api.register();
      const res = await t.api.get('/user/self', { headers: { auth: await sessionIssued(s.email, TTL + 60) } });
      expect(res.status).toBe(401);
      expect(res.headers.get('logout')).toBe('true');
      expect(authSetCookie(res)).toMatch(/^auth=;/);
    });

    it('a token without exp is refused: its holder signs in once more', async () => {
      const s = await t.api.register();
      for (const via of ['header', 'cookie'] as const) {
        const token = await legacySession(s.email);
        const res =
          via === 'header'
            ? await t.api.get('/user/self', { headers: { auth: token } })
            : await t.api.get('/user/self', { cookies: { auth: token } });
        expect(res.status).toBe(401);
      }
      // ...and signing in again gives a session that works.
      const again = await t.api.login(s.email, s.password);
      expect((await again.get('/user/self')).status).toBe(200);
    });

    it('a day short of its exp the session still works', async () => {
      const s = await t.api.register();
      const res = await t.api.get('/user/self', { headers: { auth: await sessionIssued(s.email, TTL - DAY) } });
      expect(res.status).toBe(200);
    });
  });

  describe('sliding refresh', () => {
    it('a fresh session comes back unchanged', async () => {
      const s = await t.api.register();
      const res = await s.get('/user/self');
      expect(res.status).toBe(200);
      expect(res.headers.get('auth')).toBeNull();
      expect(authSetCookie(res)).toBeUndefined();
    });

    it('a day-old session is re-issued with 30 new days, and the new one works', async () => {
      const s = await t.api.register();
      const old = await sessionIssued(s.email, 2 * DAY);
      const res = await t.api.get('/user/self', { headers: { auth: old } });
      expect(res.status).toBe(200);
      const fresh = res.headers.get('auth')!;
      expect(fresh).toBeTruthy();
      expect(fresh).not.toBe(old);
      const c = claimsOf(fresh);
      expect(c.id).toBe(claimsOf(old).id);
      expect(Math.abs(c.iat - now())).toBeLessThan(60);
      expect(c.exp - c.iat).toBe(TTL);
      expect(authSetCookie(res)).toMatch(new RegExp(`^auth=${fresh};.*Max-Age=${TTL}`));
      expect((await t.api.get('/user/self', { headers: { auth: fresh } })).status).toBe(200);
    });
  });

  describe('a password reset signs out every other session', () => {
    it('both earlier sessions die, the old password fails, the new one signs in', async () => {
      const s = await t.api.register();
      const laptop = s;
      const phone = await t.api.login(s.email, s.password);
      expect((await laptop.get('/user/self')).status).toBe(200);
      expect((await phone.get('/user/self')).status).toBe(200);

      const { password } = await resetPassword(s.email);

      for (const session of [laptop, phone]) {
        const res = await session.get('/user/self');
        expect(res.status).toBe(401);
        expect(res.headers.get('logout')).toBe('true');
      }
      // A session that would have been renewed is not renewed on its way out.
      const stale = await t.api.get('/user/self', { headers: { auth: laptop.auth } });
      expect(stale.headers.get('auth')).toBeNull();

      await expect(t.api.login(s.email, s.password)).rejects.toThrow();
      const fresh = await t.api.login(s.email, password);
      expect((await fresh.get('/user/self')).status).toBe(200);
    });

    it('the reset link is still no session, and a session is still no reset link', async () => {
      const s = await t.api.register();
      const live = await t.api.login(s.email, s.password);
      const { token } = await resetPassword(s.email);
      expect((await t.api.get('/user/self', { headers: { auth: token } })).status).toBe(401);
      const withSession = await t.api.post('/auth/forgot-return', {
        token: live.auth,
        password: 'Another-Pass-8',
        repeatPassword: 'Another-Pass-8',
      });
      expect(withSession.body).toEqual({ reset: false });
    });
  });

  describe('what must not break', () => {
    let owner: Session;
    let orgId: string;
    let apiKey: string;
    let channelId: string;

    beforeAll(async () => {
      owner = await t.api.register({ company: 'Expiry Co' });
      orgId = (await owner.self()).orgId;
      await givePlan(orgId, 'STANDARD');
      apiKey = await apiKeyOf(orgId);
      channelId = (await addChannel(orgId, 'bluesky', { name: 'Expiry Bluesky' })).id;
    });

    it('public API keys: work whatever the sessions do; a session is still not an API key', async () => {
      const s = await t.api.register({ company: 'Key Co' });
      const { orgId: keyOrg } = await s.self();
      await givePlan(keyOrg, 'STANDARD');
      const key = await apiKeyOf(keyOrg);
      await resetPassword(s.email);
      expect((await s.get('/user/self')).status).toBe(401);
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(200);
      const fresh = await t.api.login(s.email, 'Brand-New-Pass-7');
      expect((await t.api.publicApi(fresh.auth, 'GET', '/integrations')).status).toBe(401);
    });

    it('MCP: /mcp/:apiKey and Bearer <api key> list the tools; a session is no MCP credential', async () => {
      const rpc = (path: string, headers: Record<string, string> = {}) =>
        fetch(t.baseUrl + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        });
      const byPath = await rpc(`/mcp/${apiKey}`);
      expect(byPath.status).toBe(200);
      expect(await byPath.text()).toContain('integrationSchedulePostTool');
      expect((await rpc('/mcp', { authorization: `Bearer ${apiKey}` })).status).toBe(200);
      expect((await rpc('/mcp', { authorization: `Bearer ${owner.auth}` })).status).toBe(401);
    });

    it('CLI: signs in with the API key and lists the channels', async () => {
      const cliDir = mkdtempSync(join(tmpdir(), 'hookpost-cli-expiry-'));
      execFileSync(
        join(ROOT, 'node_modules', '.bin', 'tsc'),
        ['-p', join(ROOT, 'apps/cli/tsconfig.json'), '--outDir', join(cliDir, 'dist')],
        { stdio: 'inherit' }
      );
      copyFileSync(join(ROOT, 'apps/cli/package.json'), join(cliDir, 'package.json'));
      const home = mkdtempSync(join(tmpdir(), 'hookpost-cli-expiry-home-'));
      const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
        const child = spawn(process.execPath, [join(cliDir, 'dist', 'index.js'), 'channels'], {
          env: { PATH: process.env.PATH || '', HOME: home, HOOKPOST_API_URL: t.baseUrl, HOOKPOST_API_KEY: apiKey, NO_COLOR: '1' },
        });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
      });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(channelId);
    });

    it('OAuth apps: a pos_ token granted with a session keeps working after the session ends', async () => {
      const app = await t.api.post('/oauth/register', {
        redirect_uris: ['https://client.example.com/callback'],
        client_name: 'Expiry Client',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      });
      expect(app.status).toBe(201);
      const grantor = await t.api.register({ company: 'Grant Co' });
      const { orgId: grantOrg } = await grantor.self();
      await givePlan(grantOrg, 'STANDARD');
      const verifier = randomBytes(32).toString('base64url');
      const approve = await grantor.post('/oauth/authorize', {
        client_id: app.body.client_id,
        action: 'approve',
        state: 's',
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      expect(approve.status).toBe(201);
      const token = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code: new URL(approve.body.redirect).searchParams.get('code'),
        client_id: app.body.client_id,
        code_verifier: verifier,
        redirect_uri: 'https://client.example.com/callback',
      });
      const pos = token.body.access_token as string;
      expect(pos).toMatch(/^pos_/);

      await resetPassword(grantor.email);
      expect((await grantor.get('/user/self')).status).toBe(401);
      // The consent page needs a live session...
      expect((await grantor.post('/oauth/authorize', { client_id: app.body.client_id, action: 'approve' })).status).toBe(401);
      // ...the grant itself is not a session, and is revoked in Settings, not by a reset.
      expect((await t.api.publicApi(pos, 'GET', '/integrations')).status).toBe(200);
    });

    it('/enterprise: a session, new or old, is still no partner token', async () => {
      const s = await t.api.register();
      for (const token of [s.auth, await sessionIssued(s.email, 2 * DAY), await legacySession(s.email)]) {
        const res = await t.api.post('/enterprise/create-user', { params: token });
        expect(res.body).toEqual({ success: false });
      }
    });

    it('team invites: the link still joins, and is still no session', async () => {
      const inviter = await t.api.register({ company: 'Team Co' });
      const { orgId: teamOrg } = await inviter.self();
      await givePlan(teamOrg, 'PRO');
      const invite = await inviter.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(invite.status).toBe(201);
      const token = inviteTokenFrom(invite.body.url);
      expect((await t.api.get('/user/self', { headers: { auth: token } })).status).toBe(401);
      const joiner = await t.api.register();
      expect((await joiner.acceptInvite(token)).body).toEqual({ id: teamOrg, invite: 'joined' });
    });

    it('admin impersonation: works on a renewed session, and the renewal is the admin’s own', async () => {
      const admin = await t.api.register({ company: 'Hookpost HQ' });
      const { id: adminId } = await admin.self();
      await makeSuperAdmin(adminId);
      const customer = await t.api.register({ company: 'Customer' });
      const { orgId: customerOrg } = await customer.self();
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: customerOrg } });

      const old = await sessionIssued(admin.email, 2 * DAY);
      const as = await t.api.get('/user/self', { headers: { auth: old, impersonate: userOrg.id } });
      expect(as.status).toBe(200);
      expect(as.body).toMatchObject({ email: customer.email, orgId: customerOrg, impersonate: true });
      expect(claimsOf(as.headers.get('auth')!).id).toBe(adminId);

      // A customer's password reset ends the customer's sessions, not the admin's view.
      await resetPassword(customer.email);
      expect((await customer.get('/user/self')).status).toBe(401);
      const still = await t.api.get('/user/self', { headers: { auth: admin.auth, impersonate: userOrg.id } });
      expect(still.status).toBe(200);
      expect(still.body.email).toBe(customer.email);
    });

    it('the Play app (TWA): its cookie-only session is renewed in the cookie', async () => {
      const s = await t.api.register();
      const res = await t.api.get('/user/self', { cookies: { auth: await sessionIssued(s.email, 3 * DAY) } });
      expect(res.status).toBe(200);
      const cookie = authSetCookie(res)!;
      expect(cookie).toMatch(new RegExp(`Max-Age=${TTL}`));
      const fresh = /^auth=([^;]+)/.exec(cookie)![1];
      expect((await t.api.get('/user/self', { cookies: { auth: fresh } })).status).toBe(200);
    });

    describe('Google One Tap', () => {
      const CLIENT_ID = 'expiry-one-tap.apps.googleusercontent.com';
      const KID = 'hookpost-expiry-key';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const b64url = (v: object | Buffer) =>
        (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
      const credential = (claims: Record<string, unknown>) => {
        const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          email_verified: true,
          name: 'One Tap',
          iat: now(),
          exp: now() + 600,
          ...claims,
        })}`;
        return `${head}.${b64url(rsaSign('RSA-SHA256', Buffer.from(head), privateKey))}`;
      };
      let saved: string | undefined;
      beforeAll(() => {
        saved = process.env.YOUTUBE_CLIENT_ID;
        process.env.YOUTUBE_CLIENT_ID = CLIENT_ID;
        jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
          certs: { [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
          format: 'PEM',
        } as any);
      });
      afterAll(() => {
        if (saved === undefined) delete process.env.YOUTUBE_CLIENT_ID;
        else process.env.YOUTUBE_CLIENT_ID = saved;
      });

      it('signs up and in with an expiring session that works and is renewed like any other', async () => {
        const sub = `g-${randomUUID()}`;
        const email = uniqueEmail('onetap-expiry');
        const first = await t.api.post('/auth/oauth/google/one-tap', { credential: credential({ sub, email }) });
        expect(first.status).toBe(200);
        const token = first.headers.get('auth')!;
        expect(claimsOf(token).exp - claimsOf(token).iat).toBe(TTL);
        expect((await t.api.get('/user/self', { headers: { auth: token } })).status).toBe(200);

        const again = await t.api.post('/auth/oauth/google/one-tap', { credential: credential({ sub, email }) });
        expect(again.status).toBe(200);
        const renewed = await t.api.get('/user/self', { headers: { auth: await sessionIssued(email, 2 * DAY) } });
        expect(renewed.status).toBe(200);
        expect(renewed.headers.get('auth')).toBeTruthy();
      });
    });

    it('preview and share links: answer without a session, and with a dead one', async () => {
      const post = await db().post.create({
        data: {
          organizationId: orgId,
          integrationId: channelId,
          content: '<p>Preview after expiry</p>',
          group: `expiry-preview-${orgId}`,
          publishDate: new Date(),
        },
      });
      const dead = await legacySession(owner.email);
      for (const options of [{}, { cookies: { auth: dead } }, { headers: { auth: dead } }]) {
        const res = await t.api.get(`/public/posts/${post.id}`, options);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toContain('Preview after expiry');
        expect((await t.api.get(`/public/posts/${post.id}/comments`, options)).status).toBe(200);
      }
    });

    it('Temporal: a scheduled post keeps its workflow when every session of the user ends', async () => {
      const s = await t.api.register({ company: 'Queue Co' });
      const { orgId: queueOrg } = await s.self();
      await givePlan(queueOrg, 'STANDARD');
      const channel = await addChannel(queueOrg, 'bluesky', { name: 'Queue Bluesky' });
      t.temporal.reset();
      const created = await t.api.publicApi(await apiKeyOf(queueOrg), 'POST', '/posts', {
        type: 'schedule',
        shortLink: false,
        date: dayjs().add(3, 'day').toISOString(),
        tags: [],
        posts: [{ integration: { id: channel.id }, value: [{ content: 'Queued before the reset', image: [] }], settings: {} }],
      });
      expect(created.status).toBe(201);
      expect(t.temporal.postWorkflows()).toHaveLength(1);

      await resetPassword(s.email);
      expect((await s.get('/user/self')).status).toBe(401);
      expect(t.temporal.terminated).toEqual([]);
      const row = await db().post.findUniqueOrThrow({ where: { id: created.body[0].postId } });
      expect(row).toMatchObject({ state: 'QUEUE', deletedAt: null });
    });
  });
});
