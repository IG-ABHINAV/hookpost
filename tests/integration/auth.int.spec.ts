/**
 * Email/password sign-up, login, session handling, logout and password reset,
 * end to end through the real controllers, middleware and database.
 *
 * No email provider is configured here, so registration logs straight in
 * (activation.int.spec.ts covers the activation path). Every email the backend
 * sends is captured by FakeTemporal.
 */
import { generateKeyPairSync, randomUUID, sign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { startApp, TestApp } from './setup/app';
import { uniqueEmail } from './setup/api';
import { db, disconnectDb } from './setup/db';

describe('auth: email and password', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  describe('POST /auth/register', () => {
    it('creates the user, a workspace it owns, and logs in', async () => {
      const email = uniqueEmail('signup');
      const res = await t.api.post('/auth/register', {
        email,
        password: 'Correct-Horse-9',
        company: 'Signup Co',
        provider: 'LOCAL',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ register: true, eventId: expect.stringMatching(/^reg_/) });
      // The frontend sends a new user to onboarding on this header.
      expect(res.headers.get('onboarding')).toBe('true');
      expect(res.headers.get('auth')).toBeTruthy();

      const user = await db().user.findFirstOrThrow({
        where: { email },
        include: { organizations: { include: { organization: true } } },
      });
      expect(user.activated).toBe(true);
      expect(user.providerName).toBe('LOCAL');
      // Stored hashed, never as typed.
      expect(user.password).not.toContain('Correct-Horse-9');
      expect(user.password).toMatch(/^\$2[aby]\$/);
      expect(user.organizations).toHaveLength(1);
      expect(user.organizations[0].role).toBe('SUPERADMIN');
      expect(user.organizations[0].organization.name).toBe('Signup Co');
      expect(user.organizations[0].organization.apiKey).toBeTruthy();
    });

    it('sends the activation email even when activation is not required', async () => {
      const email = uniqueEmail('mail');
      t.temporal.reset();
      await t.api.register({ email });
      const mails = t.temporal.emails().filter((m) => m.to === email);
      expect(mails).toHaveLength(1);
      expect(mails[0].html).toContain('/auth/activate/');
    });

    it('normalises the email: case and surrounding spaces', async () => {
      const email = uniqueEmail('Mixed').replace('mixed', 'MiXeD');
      const res = await t.api.post('/auth/register', {
        email: `  ${email.toUpperCase()}  `,
        password: 'Correct-Horse-9',
        company: 'Case Co',
        provider: 'LOCAL',
      });
      expect(res.status).toBe(200);
      const stored = await db().user.findFirst({
        where: { email: email.toLowerCase() },
      });
      expect(stored).not.toBeNull();
    });

    it('refuses a second account for the same email', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/auth/register', {
        email: s.email.toUpperCase(),
        password: 'Another-Pass-1',
        company: 'Dupe Co',
        provider: 'LOCAL',
      });
      expect(res.status).toBe(400);
      expect(await db().user.count({ where: { email: s.email } })).toBe(1);
    });

    it.each([
      ['missing email', { password: 'Correct-Horse-9', company: 'Co Name', provider: 'LOCAL' }],
      ['bad email', { email: 'not-an-email', password: 'Correct-Horse-9', company: 'Co Name', provider: 'LOCAL' }],
      ['short password', { email: uniqueEmail(), password: 'ab', company: 'Co Name', provider: 'LOCAL' }],
      ['short company', { email: uniqueEmail(), password: 'Correct-Horse-9', company: 'ab', provider: 'LOCAL' }],
    ])('rejects a %s with 400', async (_label, body) => {
      const res = await t.api.post('/auth/register', body);
      expect(res.status).toBe(400);
    });

    it('GET /auth/can-register says registration is open', async () => {
      const res = await t.api.get('/auth/can-register');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ register: true });
    });
  });

  describe('POST /auth/login', () => {
    it('logs in with the right password', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/auth/login', {
        email: s.email,
        password: s.password,
        provider: 'LOCAL',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ login: true });
      expect(res.headers.get('reload')).toBe('true');
      expect(res.headers.get('auth')).toBeTruthy();
    });

    it('accepts the email in another case', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/auth/login', {
        email: ` ${s.email.toUpperCase()} `,
        password: s.password,
        provider: 'LOCAL',
      });
      expect(res.status).toBe(200);
    });

    it('refuses a wrong password with the same message as an unknown email', async () => {
      const s = await t.api.register();
      const wrong = await t.api.post('/auth/login', {
        email: s.email,
        password: 'Wrong-Password-1',
        provider: 'LOCAL',
      });
      const unknown = await t.api.post('/auth/login', {
        email: uniqueEmail('nobody'),
        password: 'Wrong-Password-1',
        provider: 'LOCAL',
      });
      expect(wrong.status).toBe(400);
      expect(unknown.status).toBe(400);
      // No account enumeration through the error text.
      expect(wrong.text).toBe(unknown.text);
      expect(wrong.headers.get('auth')).toBeNull();
    });
  });

  describe('session (AuthMiddleware)', () => {
    it('GET /user/self answers for a signed-in user, without the password', async () => {
      const s = await t.api.register({ company: 'Self Co' });
      const self = await s.self();
      expect(self.email).toBe(s.email);
      expect(self.orgId).toBeTruthy();
      expect(self).not.toHaveProperty('password');
      expect(self.role).toBe('SUPERADMIN');
      // Billing is on (RAZORPAY_KEY_ID), so a new workspace is on Free.
      expect(self.tier).toBe('FREE');
    });

    // HttpForbiddenException answers 401: the frontend signs out on a 401.
    it('refuses a request with no session', async () => {
      const res = await t.api.get('/user/self');
      expect(res.status).toBe(401);
    });

    it('refuses a token signed with another secret', async () => {
      const { sign } = await import('jsonwebtoken');
      const s = await t.api.register();
      const self = await s.self();
      const forged = sign({ id: self.id, email: s.email, activated: true, isSuperAdmin: true }, 'not-the-secret');
      const res = await t.api.get('/user/self', { headers: { auth: forged } });
      expect(res.status).toBe(401);
    });

    it('re-reads the user from the database instead of trusting token claims', async () => {
      const { AuthService } = await import('@hookpost/helpers/auth/auth.service');
      const s = await t.api.register();
      const self = await s.self();
      // A validly signed session that claims super-admin: the claim is ignored.
      const row = await db().user.findUniqueOrThrow({ where: { id: self.id } });
      const claims = AuthService.signSessionJWT({ ...row, isSuperAdmin: true });
      const res = await t.api.get('/user/self', { headers: { auth: claims } });
      expect(res.status).toBe(200);
      expect(res.body.admin).toBe(false);
    });

    // Until 25 Oct 2026 this was a 401, so a password sign-up could not
    // reach onboarding before opening the emailed link. Now it is signed in
    // and the row says it is unconfirmed (email-verification.int.spec.ts).
    it('lets in a user who has not confirmed their email, and says so', async () => {
      const s = await t.api.register();
      await db().user.updateMany({ where: { email: s.email }, data: { activated: false } });
      const res = await s.get('/user/self');
      expect(res.status).toBe(200);
      expect(res.body.activated).toBe(false);
    });

    it('cookie auth works the same as the header', async () => {
      const s = await t.api.register();
      const res = await t.api.get('/user/self', { cookies: { auth: s.auth } });
      expect(res.status).toBe(200);
    });
  });

  describe('POST /user/logout', () => {
    it('clears the auth, showorg and login-hint cookies', async () => {
      const s = await t.api.register();
      const res = await s.post('/user/logout');
      expect(res.status).toBe(200);
      expect(res.headers.get('logout')).toBe('true');
      const cookies = res.headers.getSetCookie().join('\n');
      for (const name of ['auth', 'hp_logged_in', 'showorg', 'impersonate']) {
        expect(cookies).toMatch(new RegExp(`(^|\\n)${name}=;`));
      }
      // Max-Age below zero: the browser drops each cookie at once.
      for (const line of res.headers.getSetCookie()) {
        expect(line).toMatch(/Max-Age=-1/);
      }
    });
  });

  describe('forgot and reset password', () => {
    const resetTokenFrom = (html: string) =>
      /\/auth\/forgot\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];

    it('emails a reset link, and the link sets a new password', async () => {
      const s = await t.api.register();
      t.temporal.reset();

      const forgot = await t.api.post('/auth/forgot', { email: s.email });
      expect(forgot.status).toBe(201);
      expect(forgot.body).toEqual({ forgot: true });

      const mail = t.temporal.emails().find((m) => m.to === s.email);
      expect(mail).toBeDefined();
      expect(mail!.subject).toMatch(/reset/i);
      const token = resetTokenFrom(mail!.html);
      expect(token).toBeTruthy();

      const reset = await t.api.post('/auth/forgot-return', {
        token,
        password: 'Brand-New-Pass-7',
        repeatPassword: 'Brand-New-Pass-7',
      });
      expect(reset.status).toBe(201);
      expect(reset.body).toEqual({ reset: true });

      await expect(t.api.login(s.email, s.password)).rejects.toThrow(/400/);
      const again = await t.api.login(s.email, 'Brand-New-Pass-7');
      expect((await again.self()).email).toBe(s.email);
    });

    it('refuses a reset when the two passwords differ', async () => {
      const s = await t.api.register();
      t.temporal.reset();
      await t.api.post('/auth/forgot', { email: s.email });
      const token = resetTokenFrom(t.temporal.emails()[0].html);
      const res = await t.api.post('/auth/forgot-return', {
        token,
        password: 'Brand-New-Pass-7',
        repeatPassword: 'Something-Else-7',
      });
      expect(res.status).toBe(400);
    });

    it('answers the same for an unknown email and sends nothing', async () => {
      t.temporal.reset();
      const res = await t.api.post('/auth/forgot', { email: uniqueEmail('ghost') });
      expect(res.status).toBe(201);
      expect(t.temporal.emails()).toHaveLength(0);
    });

    it('refuses an expired reset token', async () => {
      const { sign } = await import('jsonwebtoken');
      const s = await t.api.register();
      const self = await s.self();
      const expired = sign(
        { id: self.id, expires: '2020-01-01 00:00:00' },
        process.env.JWT_SECRET!
      );
      const res = await t.api.post('/auth/forgot-return', {
        token: expired,
        password: 'Brand-New-Pass-7',
        repeatPassword: 'Brand-New-Pass-7',
      });
      expect(res.body).toEqual({ reset: false });
      await expect(t.api.login(s.email, s.password)).resolves.toBeDefined();
    });

    // That a reset link is no login session is tokens.int.spec.ts's job.
  });

  describe('Google One Tap and OAuth guards', () => {
    // google-auth-library fetches Google's signing certificates before it
    // checks a credential. Here it gets one test key instead, so no request
    // leaves the machine and a credential that key signed can be tested too.
    const CLIENT_ID = 'one-tap-client.apps.googleusercontent.com';
    const KID = 'hookpost-integration-key';
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const b64url = (v: object | Buffer) =>
      (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
    const credential = (claims: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
        iss: 'https://accounts.google.com',
        aud: CLIENT_ID,
        sub: `g-${randomUUID()}`,
        email: uniqueEmail('onetap'),
        email_verified: true,
        name: 'One Tap',
        iat: now,
        exp: now + 600,
        ...claims,
      })}`;
      return `${head}.${b64url(sign('RSA-SHA256', Buffer.from(head), privateKey))}`;
    };
    let savedClientId: string | undefined;
    beforeAll(() => {
      savedClientId = process.env.YOUTUBE_CLIENT_ID;
      process.env.YOUTUBE_CLIENT_ID = CLIENT_ID;
      jest.spyOn(OAuth2Client.prototype, 'getFederatedSignonCertsAsync').mockResolvedValue({
        certs: { [KID]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
        format: 'PEM',
      } as any);
    });
    afterAll(() => {
      jest.restoreAllMocks();
      if (savedClientId === undefined) delete process.env.YOUTUBE_CLIENT_ID;
      else process.env.YOUTUBE_CLIENT_ID = savedClientId;
    });

    it('a credential Google signed signs up once, then logs the same user in', async () => {
      const sub = `g-${randomUUID()}`;
      const email = uniqueEmail('onetap');
      const token = credential({ sub, email });
      const first = await t.api.post('/auth/oauth/google/one-tap', { credential: token });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ login: true, registered: true, eventId: expect.stringMatching(/^reg_/) });
      expect(first.headers.get('auth')).toBeTruthy();
      const user = await db().user.findFirstOrThrow({ where: { email } });
      expect(user).toMatchObject({ providerName: 'GOOGLE', providerId: sub });

      const again = await t.api.post('/auth/oauth/google/one-tap', { credential: credential({ sub, email }) });
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ login: true, registered: false });
      expect(await db().user.count({ where: { email } })).toBe(1);
    });

    it.each([
      ['another app', { aud: 'someone-else.apps.googleusercontent.com' }],
      ['an unverified email', { email_verified: false }],
      ['an expired credential', { iat: 1_600_000_000, exp: 1_600_000_600 }],
      ['another issuer', { iss: 'https://evil.example' }],
    ])('refuses a credential for %s', async (_label, claims) => {
      const email = uniqueEmail('onetap-refused');
      const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential({ email, ...claims }) });
      expect(res.status).toBe(401);
      expect(res.headers.get('auth')).toBeNull();
      expect(await db().user.count({ where: { email } })).toBe(0);
    });

    it('refuses a One Tap post that is not JSON (CSRF guard)', async () => {
      const res = await t.api.request('POST', '/auth/oauth/google/one-tap', {
        raw: 'credential=abc',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(400);
    });

    it('refuses a One Tap credential that Google did not sign, without echoing internals', async () => {
      const res = await t.api.post('/auth/oauth/google/one-tap', {
        credential: 'eyJhbGciOiJSUzI1NiJ9.e30.not-a-signature',
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        login: false,
        message: 'Google sign-in could not be verified',
      });
      expect(res.headers.get('auth')).toBeNull();
    });

    it('refuses /auth/oauth/:provider/exists unless the body is JSON', async () => {
      const res = await t.api.request('POST', '/auth/oauth/github/exists', {
        raw: 'code=abc',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(res.status).toBe(400);
    });

    it('the OAuth redirect hand-off sends the code on to the frontend', async () => {
      const res = await t.api.get('/auth/oauth/github/redirect?code=abc123&state=login-xyz');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(
        'http://localhost:4200/auth?code=abc123&provider=GITHUB&state=login-xyz'
      );
    });

    it('the OAuth redirect without a code goes back to login', async () => {
      const res = await t.api.get('/auth/oauth/github/redirect');
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://localhost:4200/auth/login');
    });

    it('the mobile OAuth callback forwards to the app scheme', async () => {
      const res = await t.api.get('/auth/oauth-mobile-callback?code=c1&state=s1');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('hookpost://auth/callback?code=c1&state=s1');
    });
  });
});
