/**
 * Email sign-up with an email provider configured, as production runs it
 * (25 Oct 2026).
 *
 * Before: a password sign-up got no session until it opened the emailed link,
 * and sign-in answered "User is not activated". In production none of the
 * five password sign-ups of 19-25 Oct ever opened that link (no request for
 * /auth/activate/<token> in nginx), three of them inside Instagram's or
 * Facebook's browser, so none reached onboarding or the paywall.
 *
 * Now: the sign-up is signed in at once and goes to onboarding; publishing,
 * invites, webhooks and approving an OAuth app wait until the address is
 * confirmed. The rest of the suite runs with EMAIL_PROVIDER empty, where a
 * password sign-up is created confirmed and none of this applies.
 */
process.env.EMAIL_PROVIDER = 'resend';

import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { Redis } from 'ioredis';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail, inviteTokenFrom } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';

const PASSWORD = 'Correct-Horse-9';
const future = () => new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 19);
const postBody = (integrationId: string, type = 'schedule') => ({
  type,
  shortLink: false,
  date: future(),
  tags: [],
  posts: [
    {
      integration: { id: integrationId },
      group: randomBytes(5).toString('hex'),
      value: [{ content: '<p>Hello from the verification suite</p>', image: [] }],
      settings: {},
    },
  ],
});
const linkIn = (html: string) => /\/auth\/activate\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];
const resetIn = (html: string) => /\/auth\/forgot\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];

describe('email verification (EMAIL_PROVIDER set)', () => {
  let t: TestApp;
  let redis: Redis;

  beforeAll(async () => {
    t = await startApp();
    redis = new Redis(process.env.REDIS_URL!);
  });
  afterAll(async () => {
    await redis?.quit();
    await t?.close();
    await disconnectDb();
  });

  /** Lets the next activation email to `email` go out at once (60 s cooldown). */
  const coolDown = (email: string) =>
    redis.del(`throttle:cooldown:activation-send:${email.toLowerCase()}`);

  const mailsTo = (email: string) => t.temporal.emails().filter((m) => m.to === email);
  const linkFor = (email: string, n = -1) => linkIn(mailsTo(email).at(n)!.html)!;

  async function signUp(tag = 'verify', headers: Record<string, string> = {}) {
    const email = uniqueEmail(tag);
    const res = await t.api.post(
      '/auth/register',
      { email, password: PASSWORD, company: 'Verify Co', provider: 'LOCAL' },
      { headers }
    );
    expect(res.status).toBe(200);
    const s = new Session(t.api, res.headers.get('auth')!, email, PASSWORD);
    const self = await s.self();
    return { email, s, res, userId: self.id, orgId: self.orgId };
  }

  /** A workspace that has a plan and a channel, so only the email stands in the way. */
  async function readyToPost(tag = 'ready') {
    const signup = await signUp(tag);
    await givePlan(signup.orgId, 'PRO');
    const channel = await addChannel(signup.orgId, 'bluesky');
    return { ...signup, channelId: channel.id };
  }

  describe('sign-up', () => {
    it('signs in at once and goes to onboarding; the account is unconfirmed', async () => {
      const { email, res, s } = await signUp();
      expect(res.body).toEqual({
        register: true,
        verifyEmail: true,
        eventId: expect.stringMatching(/^reg_/),
      });
      expect(res.headers.get('auth')).toBeTruthy();
      expect(res.headers.get('onboarding')).toBe('true');
      expect(res.headers.get('activate')).toBeNull();
      expect((await db().user.findFirstOrThrow({ where: { email } })).activated).toBe(false);
      expect(await s.self()).toMatchObject({ email, activated: false });
      expect((await s.get('/verify-email')).body).toEqual({ verified: false, email, invitedTo: null });
    });

    it('emails one link, to this host, that works for 7 days', async () => {
      const { email } = await signUp('mail');
      expect(mailsTo(email)).toHaveLength(1);
      expect(mailsTo(email)[0].subject).toBe('Confirm your email for Hookpost');
      expect(mailsTo(email)[0].html).toContain(`${process.env.FRONTEND_URL}/auth/activate/`);
      const payload = JSON.parse(Buffer.from(linkFor(email).split('.')[1], 'base64url').toString());
      expect(payload).toMatchObject({ purpose: 'account-activation', email });
      expect(payload.exp - payload.iat).toBe(7 * 86400);
    });

    it('the unconfirmed account signs in with its password, from any browser', async () => {
      const { email } = await signUp('login');
      const res = await t.api.post('/auth/login', { email, password: PASSWORD, provider: 'LOCAL' });
      expect(res.status).toBe(200);
      expect(res.headers.get('auth')).toBeTruthy();
      expect(res.text).not.toMatch(/not activated/);
    });

    it('a double-tapped Create Account makes one account', async () => {
      const email = uniqueEmail('double');
      const body = { email, password: PASSWORD, company: 'Double Co', provider: 'LOCAL' };
      const statuses = (
        await Promise.all([t.api.post('/auth/register', body), t.api.post('/auth/register', body)])
      ).map((r) => r.status);
      expect(statuses.sort()).toEqual([200, 400]);
      expect(await db().user.count({ where: { email } })).toBe(1);
    });
  });

  describe('until the email is confirmed: the hard gate (owner, 29 Oct 2026)', () => {
    const GATE = { code: 'EMAIL_VERIFICATION_REQUIRED', message: expect.stringMatching(/^Confirm your email address to use Hookpost/) };

    it('/user/self answers with the account only: no workspace, plan or key details', async () => {
      const { s, email, orgId } = await readyToPost('self');
      const self = await s.self();
      expect(self).toEqual({
        id: expect.any(String),
        email,
        name: null,
        providerName: 'LOCAL',
        activated: false,
        emailVerificationRequired: true,
        orgId,
      });
    });

    it('refuses every other signed-in route with 403 EMAIL_VERIFICATION_REQUIRED, and signs nobody out', async () => {
      const { s, channelId, orgId } = await readyToPost('routes');
      t.temporal.reset();
      const calls: Array<[string, string, any?]> = [
        ['GET', '/integrations/list'],
        ['POST', '/posts', postBody(channelId, 'draft')],
        ['POST', '/posts', postBody(channelId, 'schedule')],
        ['GET', '/billing'],
        ['POST', '/billing/subscribe', { period: 'MONTHLY', billing: 'STANDARD' }],
        ['GET', '/user/organizations'],
        ['POST', '/settings/team', { role: 'USER', sendEmail: true, email: 'someone@example.com' }],
        ['POST', '/webhooks', { name: 'Hook', url: 'https://hooks.example.com/x', integrations: [] }],
        ['PUT', '/webhooks', { id: 'x', name: 'Hook', url: 'https://hooks.example.com/x', integrations: [] }],
        ['POST', '/media/upload-simple'],
        ['GET', '/notifications'],
      ];
      for (const [method, path, body] of calls) {
        const res = await s.request(method, path, body === undefined ? {} : { body });
        expect({ method, path, status: res.status, body: res.body }).toMatchObject({ method, path, status: 403, body: GATE });
        expect(res.headers.get('logout')).toBeNull();
      }
      expect(await db().post.count({ where: { organizationId: orgId } })).toBe(0);
      expect(mailsTo('someone@example.com')).toHaveLength(0);
      expect(t.temporal.postWorkflows()).toHaveLength(0);
      // Still signed in: the allowed routes answer.
      expect((await s.get('/verify-email')).status).toBe(200);
      expect((await s.get('/user/self')).status).toBe(200);
    });

    it('its API key (public API, the CLI, n8n, MCP by key) is refused, even with a plan and a channel', async () => {
      const { channelId, orgId } = await readyToPost('publicapi');
      const key = await apiKeyOf(orgId);
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(401);
      const post = await t.api.publicApi(key, 'POST', '/posts', postBody(channelId));
      expect(post.status).toBe(401);
      expect(await db().post.count({ where: { organizationId: orgId } })).toBe(0);
      // MCP by key (/mcp/:key, /sse/:key) resolves the key with the same
      // getOrgByApiKey, so it gets nothing either (not mounted in this suite).
      expect(await t.app.get(OrganizationService).getOrgByApiKey(key)).toBeNull();
    });

    it('an OAuth token it approved before the gate (MCP, the CLI) stops working; confirming brings it back', async () => {
      const ready = await readyToPost('oauth-token');
      // Approve while confirmed, as it could have before 1 Nov 2026.
      await db().user.update({ where: { id: ready.userId }, data: { activated: true } });
      const client = await t.api.post('/oauth/register', {
        redirect_uris: ['https://client.example.com/callback'],
        client_name: 'Gate MCP',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      });
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const approve = await ready.s.post('/oauth/authorize', {
        client_id: client.body.client_id,
        action: 'approve',
        state: 'st',
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(approve.status).toBe(201);
      const code = new URL(approve.body.redirect).searchParams.get('code')!;
      const token = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: client.body.client_id,
        redirect_uri: 'https://client.example.com/callback',
        code_verifier: verifier,
      });
      const access = token.body.access_token as string;
      expect(access).toMatch(/^pos_/);
      expect((await t.api.publicApi(access, 'GET', '/integrations')).status).toBe(200);

      await db().user.update({ where: { id: ready.userId }, data: { activated: false } });
      expect((await t.api.publicApi(access, 'GET', '/integrations')).status).toBe(401);
      await db().user.update({ where: { id: ready.userId }, data: { activated: true } });
      expect((await t.api.publicApi(access, 'GET', '/integrations')).status).toBe(200);
    });

    it('approving an OAuth app is refused by the gate before anything else', async () => {
      const { s } = await signUp('oauth');
      const client = await t.api.post('/oauth/register', {
        redirect_uris: ['https://client.example.com/callback'],
        client_name: 'Verify MCP',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      });
      const approve = await s.post('/oauth/authorize', {
        client_id: client.body.client_id,
        action: 'approve',
        state: 'st',
        redirect_uri: 'https://client.example.com/callback',
        code_challenge: createHash('sha256').update(randomBytes(32)).digest('base64url'),
        code_challenge_method: 'S256',
      });
      expect(approve.status).toBe(403);
      expect(approve.body).toMatchObject(GATE);
      expect(await db().oAuthAuthorization.count({ where: { user: { email: s.email } } })).toBe(0);
    });

    it('the gate comes before the paywall: a workspace with no plan sees "confirm", not 402', async () => {
      const { s, orgId } = await signUp('paywall', { 'cf-ipcountry': 'IN' });
      const channel = await addChannel(orgId, 'bluesky');
      const res = await s.post('/posts', postBody(channel.id), { headers: { 'cf-ipcountry': 'IN' } });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject(GATE);
    });

    it('an existing unconfirmed account (made before the gate) gets the same, and loses nothing', async () => {
      const { s, orgId, channelId } = await readyToPost('existing');
      await db().post.create({
        data: { organizationId: orgId, integrationId: channelId, content: 'kept', group: 'g-kept', publishDate: new Date(), state: 'DRAFT' },
      });
      expect((await s.get('/integrations/list')).status).toBe(403);
      expect(await db().post.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
      expect(await db().integration.count({ where: { organizationId: orgId, deletedAt: null } })).toBe(1);
    });

    it('a Google (or any OAuth) account is never gated, whatever its activated flag says', async () => {
      const { s, userId } = await readyToPost('google');
      await db().user.update({ where: { id: userId }, data: { providerName: 'GOOGLE', providerId: `g-${userId}`, activated: false } });
      expect((await s.get('/integrations/list')).status).toBe(200);
      expect((await s.self()).emailVerificationRequired).toBe(false);
    });

    it('once the link is used, everything opens at once', async () => {
      const { s, email } = await readyToPost('opens');
      expect((await s.get('/integrations/list')).status).toBe(403);
      await t.api.post('/auth/activate', { code: linkFor(email) });
      expect((await s.get('/integrations/list')).status).toBe(200);
      expect((await s.self()).emailVerificationRequired).toBe(false);
    });
  });

  describe('the emailed link', () => {
    it('opened in another browser (no cookies) confirms and signs in there; then posts publish', async () => {
      const { email, userId, s, channelId } = await readyToPost('link');
      const res = await t.api.post('/auth/activate', { code: linkFor(email) });
      expect(res.body).toEqual({ can: true });
      expect(res.headers.get('onboarding')).toBe('true');
      const there = new Session(t.api, res.headers.get('auth')!, email, PASSWORD);
      expect(await there.self()).toMatchObject({ id: userId, activated: true });

      // The first browser's session sees it too: the row decides, not the token.
      expect(await s.self()).toMatchObject({ activated: true });
      t.temporal.reset();
      const post = await s.post('/posts', postBody(channelId));
      expect(post.status).toBe(201);
      expect(t.temporal.postWorkflows()).toHaveLength(1);
      expect((await s.get('/verify-email')).body.verified).toBe(true);
    });

    it('works once: the second use signs nobody in', async () => {
      const { email } = await signUp('once');
      const code = linkFor(email);
      expect((await t.api.post('/auth/activate', { code })).body).toEqual({ can: true });
      const again = await t.api.post('/auth/activate', { code });
      expect(again.body).toEqual({ can: false });
      expect(again.headers.get('auth')).toBeNull();
    });

    it("confirms only the account it was sent to, never the one that uses it", async () => {
      const a = await signUp('owner-a');
      const b = await signUp('owner-b');
      // b's session posting a's link: a is confirmed (that inbox got the link),
      // b is not, and the session it returns is a's own.
      const res = await b.s.post('/auth/activate', { code: linkFor(a.email) });
      expect(res.body).toEqual({ can: true });
      const issued = new Session(t.api, res.headers.get('auth')!, a.email, PASSWORD);
      expect((await issued.self()).id).toBe(a.userId);
      expect((await db().user.findUniqueOrThrow({ where: { id: b.userId } })).activated).toBe(false);
    });

    it('a cross-site form post of a good link signs nobody in (login CSRF)', async () => {
      const { email, userId } = await signUp('csrf');
      const code = linkFor(email);
      for (const [type, raw] of [
        ['application/x-www-form-urlencoded', `code=${encodeURIComponent(code)}`],
        ['text/plain', JSON.stringify({ code })],
      ]) {
        const res = await t.api.request('POST', '/auth/activate', { raw, headers: { 'content-type': type } });
        expect([type, res.status, res.body]).toEqual([type, 400, { can: false }]);
        expect(res.headers.get('auth')).toBeNull();
        expect(res.headers.getSetCookie().join(';')).not.toMatch(/(^|;\s*)auth=[^;]/);
      }
      expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).activated).toBe(false);
      // The page's own JSON request still works.
      expect((await t.api.post('/auth/activate', { code })).body).toEqual({ can: true });
    });

    it('an expired link, a forged one, and every other kind of token are refused', async () => {
      const { AuthService, TOKEN_PURPOSE } = await import('@hookpost/helpers/auth/auth.service');
      const { email, userId, s } = await signUp('refused');
      const row = await db().user.findUniqueOrThrow({ where: { id: userId } });
      const now = Math.floor(Date.now() / 1000);
      const tokens = {
        expired: AuthService.signPurposeJWT(
          TOKEN_PURPOSE.ACCOUNT_ACTIVATION,
          { id: userId, email, iat: now - 8 * 86400 },
          { expiresIn: '7d' }
        ),
        noExpOlderThan30Days: AuthService.signPurposeJWT(TOKEN_PURPOSE.ACCOUNT_ACTIVATION, {
          id: userId,
          email,
          iat: now - 31 * 86400,
        }),
        session: s.auth,
        signedSession: AuthService.signSessionJWT(row),
        reset: AuthService.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, { id: userId, email }, { expiresIn: '20m' }),
        invite: AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { id: userId }, { expiresIn: '2d' }),
        forged: 'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IngifQ.x',
        empty: '',
      };
      for (const [label, code] of Object.entries(tokens)) {
        const res = await t.api.post('/auth/activate', { code });
        expect([label, res.status, res.body]).toEqual([label, 200, { can: false }]);
        expect(res.headers.get('auth')).toBeNull();
      }
      expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).activated).toBe(false);
    });
  });

  describe('"send the link again" when signed out', () => {
    it('answers the same for an unknown, a confirmed and an unconfirmed address', async () => {
      const pending = await signUp('resend-pending');
      const confirmed = await signUp('resend-confirmed');
      await t.api.post('/auth/activate', { code: linkFor(confirmed.email) });
      await coolDown(pending.email);
      await coolDown(confirmed.email);
      t.temporal.reset();

      const answers = [];
      for (const email of [uniqueEmail('nobody'), confirmed.email, pending.email]) {
        const res = await t.api.post('/auth/resend-activation', { email });
        answers.push({ status: res.status, body: res.body, auth: res.headers.get('auth') });
      }
      expect(answers).toEqual(Array(3).fill({ status: 201, body: { success: true }, auth: null }));
      expect(t.temporal.emails().map((m) => m.to)).toEqual([pending.email]);
    });

    it('sends at most one a minute to an address, whoever asks', async () => {
      const { email } = await signUp('resend-throttle');
      t.temporal.reset();
      // The sign-up's own email started the minute.
      expect((await t.api.post('/auth/resend-activation', { email })).body).toEqual({ success: true });
      await coolDown(email);
      await t.api.post('/auth/resend-activation', { email });
      await t.api.post('/auth/resend-activation', { email: email.toUpperCase() });
      expect(mailsTo(email)).toHaveLength(1);
    });
  });

  describe('the banner (signed in)', () => {
    it('Resend: says when it is too soon, then sends to the account address', async () => {
      const { email, s } = await signUp('banner');
      const soon = await s.post('/verify-email/resend');
      expect(soon.status).toBe(201);
      expect(soon.body).toEqual({ sent: false, reason: 'throttled', retryAfterSeconds: expect.any(Number) });
      expect(soon.body.retryAfterSeconds).toBeLessThanOrEqual(60);

      await coolDown(email);
      t.temporal.reset();
      expect((await s.post('/verify-email/resend')).body).toEqual({ sent: true, email });
      expect(mailsTo(email)).toHaveLength(1);
    });

    it('Wrong address?: moves the account, sends there, and the old link stops working', async () => {
      const { email, s, userId } = await signUp('typo');
      const oldLink = linkFor(email);
      const fixed = uniqueEmail('fixed');
      t.temporal.reset();
      const res = await s.post('/verify-email/change', { email: `  ${fixed.toUpperCase()} ` });
      expect(res.body).toEqual({ sent: true, email: fixed });
      expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).email).toBe(fixed);
      expect(mailsTo(fixed)).toHaveLength(1);

      expect((await t.api.post('/auth/activate', { code: oldLink })).body).toEqual({ can: false });
      expect((await t.api.post('/auth/activate', { code: linkFor(fixed) })).body).toEqual({ can: true });
      // The password is unchanged and signs in on the new address.
      expect((await t.api.post('/auth/login', { email: fixed, password: PASSWORD, provider: 'LOCAL' })).status).toBe(200);
    });

    it('Wrong address?: not to an address that has an account (the sign-up form says the same)', async () => {
      const taken = await signUp('taken');
      const { s, userId, email } = await signUp('mover');
      const res = await s.post('/verify-email/change', { email: taken.email });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('An account with this email already exists. Sign in with your email and password.');
      expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).email).toBe(email);
    });

    it('Wrong address?: refuses something that is not an address, and a confirmed account', async () => {
      const { s, email } = await signUp('bad');
      expect((await s.post('/verify-email/change', { email: 'not-an-email' })).status).toBe(400);
      await t.api.post('/auth/activate', { code: linkFor(email) });
      expect((await s.post('/verify-email/change', { email: uniqueEmail('late') })).body).toEqual({
        sent: false,
        reason: 'already_verified',
      });
      expect((await db().user.findFirst({ where: { email } }))).not.toBeNull();
    });

    it('Wrong address?: a super admin impersonating the user cannot move their address', async () => {
      const customer = await signUp('impersonated');
      const admin = await signUp('admin');
      await makeSuperAdmin(admin.userId);
      const userOrg = await db().userOrganization.findFirstOrThrow({ where: { organizationId: customer.orgId } });
      const res = await admin.s.post(
        '/verify-email/change',
        { email: uniqueEmail('hijack') },
        { headers: { impersonate: userOrg.id } }
      );
      expect(res.status).toBe(400);
      expect((await db().user.findUniqueOrThrow({ where: { id: customer.userId } })).email).toBe(customer.email);
    });

    it('signed out, none of it answers', async () => {
      expect((await t.api.post('/verify-email/resend')).status).toBe(401);
      expect((await t.api.post('/verify-email/change', { email: uniqueEmail('anon') })).status).toBe(401);
    });
  });

  // Independent review of f4bee956b, 25 Oct 2026: four ways around the gate,
  // each reproduced end to end. Every test here failed before its fix.
  describe('review: ways around the gate', () => {
    /** A confirmed account on PRO with a channel: nothing but the request decides. */
    async function confirmedReady(tag: string) {
      const ready = await readyToPost(tag);
      await t.api.post('/auth/activate', { code: linkFor(ready.email) });
      return ready;
    }
    const rows = (orgId: string) =>
      db().post.findMany({ where: { organizationId: orgId, deletedAt: null }, select: { state: true } });

    it.each([
      ['no type', undefined],
      ['an unknown type', 'whatever'],
    ])('public API: %s is a 400 and saves nothing (it used to publish)', async (_label, type) => {
      for (const [ready, confirmed] of [[await confirmedReady('api-type'), true], [await readyToPost('api-type-unconfirmed'), false]] as const) {
        const key = await apiKeyOf(ready.orgId);
        t.temporal.reset();
        const body: any = postBody(ready.channelId);
        if (type === undefined) delete body.type;
        else body.type = type;
        const res = await t.api.publicApi(key, 'POST', '/posts', body);
        // An unconfirmed account's key is refused outright (the hard gate).
        expect(res.status).toBe(confirmed ? 400 : 401);
        if (confirmed) expect(res.text).toMatch(/type/);
        expect(await rows(ready.orgId)).toEqual([]);
        expect(t.temporal.postWorkflows()).toHaveLength(0);
      }
    });

    it("type 'update' cannot create a post (composer and public API); it saved a QUEUE row the hourly sweep would publish", async () => {
      for (const [ready, confirmed] of [[await confirmedReady('update-new'), true], [await readyToPost('update-new-unconfirmed'), false]] as const) {
        const key = await apiKeyOf(ready.orgId);
        const body = { ...postBody(ready.channelId, 'update') };
        body.posts[0].value[0] = { ...body.posts[0].value[0], id: 'never-saved-1' } as any;
        const composer = await ready.s.post('/posts', body);
        expect(composer.status).toBe(confirmed ? 400 : 403);
        const api = await t.api.publicApi(key, 'POST', '/posts', body);
        expect(api.status).toBe(confirmed ? 400 : 401);
        expect(await rows(ready.orgId)).toEqual([]);
      }
    });

    it("type 'update' on an existing draft keeps it a draft", async () => {
      const ready = await confirmedReady('update-draft');
      const draft = await ready.s.post('/posts', postBody(ready.channelId, 'draft'));
      expect(draft.status).toBe(201);
      const saved = await db().post.findFirstOrThrow({ where: { organizationId: ready.orgId } });
      const body = postBody(ready.channelId, 'update');
      body.posts[0].group = saved.group;
      body.posts[0].value[0] = { ...body.posts[0].value[0], id: saved.id, content: '<p>edited</p>' } as any;
      expect((await ready.s.post('/posts', body)).status).toBe(201);
      expect(await db().post.findUniqueOrThrow({ where: { id: saved.id } })).toMatchObject({
        state: 'DRAFT',
        content: '<p>edited</p>',
      });
    });

    describe('the payment gate holds whatever the type (no live hole on main)', () => {
      // A grandfathered workspace the Free plan sunset reached (needs_trial):
      // made now it is before this future cutoff, and the sunset has passed.
      const cutoff = '2099-01-01T00:00:00Z';
      beforeAll(() => {
        process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
        process.env.TRIAL_REQUIRED_SINCE_GLOBAL = cutoff;
        process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      });
      afterAll(() => {
        delete process.env.TRIAL_REQUIRED_SINCE_IN;
        delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
        delete process.env.FREE_PLAN_SUNSET_AT;
      });

      it.each([
        ['no type', undefined],
        ['an unknown type', 'whatever'],
        ["'update' on a new id", 'update'],
        ['schedule', 'schedule'],
      ])('a workspace that must start its trial: %s is refused before anything is saved', async (_label, type) => {
        const { s, orgId, userId, email } = await signUp('paygate', { 'cf-ipcountry': 'IN' });
        await db().user.update({ where: { id: userId }, data: { signupCountry: 'IN' } });
        await t.api.post('/auth/activate', { code: linkFor(email) });
        const channel = await addChannel(orgId, 'bluesky');
        const body: any = postBody(channel.id);
        if (type === undefined) delete body.type;
        else body.type = type;
        if (type === 'update') body.posts[0].value[0].id = 'never-saved-2';

        const composer = await s.post('/posts', body, { headers: { 'cf-ipcountry': 'IN' } });
        expect(composer.status).toBe(402);
        expect(composer.body.code).toBe('TRIAL_REQUIRED');
        // The public API refuses a workspace without a plan outright.
        const api = await t.api.publicApi(await apiKeyOf(orgId), 'POST', '/posts', body);
        expect(api.status).toBe(401);
        expect(await rows(orgId)).toEqual([]);
      });
    });

    it('an unconfirmed account pressing Join on an invite is refused by the gate, not joined; after the emailed link it joins', async () => {
      const owner = await confirmedReady('inviter');
      const invite = await owner.s.post('/settings/team', { role: 'ADMIN', sendEmail: false });
      expect(invite.status).toBe(201);
      const token = inviteTokenFrom(invite.body.url);

      const stranger = await signUp('joiner');
      const join = await stranger.s.acceptInvite(token);
      expect(join.status).toBe(403);
      expect(join.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
      expect(await db().userOrganization.count({ where: { userId: stranger.userId, organizationId: owner.orgId } })).toBe(0);

      await t.api.post('/auth/activate', { code: linkFor(stranger.email) });
      expect((await stranger.s.acceptInvite(token)).body).toEqual({ id: owner.orgId, invite: 'joined' });
      expect(await db().userOrganization.count({ where: { userId: stranger.userId, organizationId: owner.orgId } })).toBe(1);
    });

    it("taking over an unconfirmed account (reset link) drops it from the squatter's shared workspace", async () => {
      // The squatter's own paid workspace, and an invite into it.
      const squatter = await confirmedReady('squatter');
      const invite = await squatter.s.post('/settings/team', { role: 'ADMIN', sendEmail: false });
      const inviteToken = inviteTokenFrom(invite.body.url);

      // Signs the victim's address up with that invite. Since the re-review
      // of f77349f66 the invite is held, not joined, until the address is
      // confirmed (before, the account was a member from the start).
      const victimEmail = uniqueEmail('victim');
      const reg = await t.api.post(
        '/auth/register',
        { email: victimEmail, password: 'Squatter-Pass-1', company: 'Victim Co', provider: 'LOCAL' },
        { cookies: { org: inviteToken } }
      );
      expect(reg.status).toBe(200);
      const victimId = (await db().user.findFirstOrThrow({ where: { email: victimEmail } })).id;
      expect(await db().userOrganization.count({ where: { userId: victimId, organizationId: squatter.orgId } })).toBe(0);
      const confirmLink = linkFor(victimEmail);

      // The mailbox owner resets the password from the link in their inbox.
      t.temporal.reset();
      await t.api.post('/auth/forgot', { email: victimEmail });
      const token = resetIn(t.temporal.emails().find((m) => m.to === victimEmail)!.html)!;
      expect(
        (await t.api.post('/auth/forgot-return', { token, password: 'Owner-Pass-22', repeatPassword: 'Owner-Pass-22' })).body
      ).toEqual({ reset: true });

      expect(await db().userOrganization.count({ where: { userId: victimId, organizationId: squatter.orgId } })).toBe(0);
      // The held invite went with the takeover: the old confirm link signs
      // nobody in and joins nothing.
      expect((await t.api.post('/auth/activate', { code: confirmLink })).body).toEqual({ can: false });
      expect(await db().userOrganization.count({ where: { userId: victimId, organizationId: squatter.orgId } })).toBe(0);
      // The squatter keeps their own workspace; the victim keeps theirs.
      expect(await db().userOrganization.count({ where: { userId: squatter.userId, organizationId: squatter.orgId } })).toBe(1);
      const owner = await t.api.login(victimEmail, 'Owner-Pass-22');
      expect((await owner.self()).orgId).not.toBe(squatter.orgId);
    });

    describe('the same takeover through Google (One Tap on that address)', () => {
      // As auth.int.spec.ts: google-auth-library gets one test signing key,
      // so a credential it signed is checked without leaving the machine.
      const CLIENT_ID = 'verify-one-tap.apps.googleusercontent.com';
      const KID = 'verify-integration-key';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const b64url = (v: object | Buffer) =>
        (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
      const credential = (email: string) => {
        const now = Math.floor(Date.now() / 1000);
        const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          sub: `g-${randomUUID()}`,
          email,
          email_verified: true,
          name: 'Mailbox Owner',
          iat: now,
          exp: now + 600,
        })}`;
        return `${head}.${b64url(cryptoSign('RSA-SHA256', Buffer.from(head), privateKey))}`;
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

      it("drops the account from the squatter's workspace, renews its own key, and ends the squatter's session", async () => {
        const squatter = await confirmedReady('g-squatter');
        const invite = await squatter.s.post('/settings/team', { role: 'ADMIN', sendEmail: false });
        const inviteToken = inviteTokenFrom(invite.body.url);
        const victimEmail = uniqueEmail('g-victim');
        const reg = await t.api.post(
          '/auth/register',
          { email: victimEmail, password: 'Squatter-Pass-1', company: 'Victim Co', provider: 'LOCAL' },
          { cookies: { org: inviteToken } }
        );
        const squatterSession = new Session(t.api, reg.headers.get('auth')!, victimEmail, 'Squatter-Pass-1');
        const victimId = (await db().user.findFirstOrThrow({ where: { email: victimEmail } })).id;
        const own = await db().userOrganization.findFirstOrThrow({
          where: { userId: victimId, organizationId: { not: squatter.orgId } },
        });
        const ownKeyBefore = await apiKeyOf(own.organizationId);
        const squatterKeyBefore = await apiKeyOf(squatter.orgId);

        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential(victimEmail) });
        expect(res.status).toBe(200);
        expect(res.body.registered).toBe(false);

        expect(await db().userOrganization.count({ where: { userId: victimId, organizationId: squatter.orgId } })).toBe(0);
        expect(await apiKeyOf(own.organizationId)).not.toBe(ownKeyBefore);
        // The squatter's own workspace and key are theirs and untouched.
        expect(await apiKeyOf(squatter.orgId)).toBe(squatterKeyBefore);
        expect((await squatterSession.get('/user/self')).status).toBe(401);
        const owner = new Session(t.api, res.headers.get('auth')!, victimEmail, '');
        expect(await owner.self()).toMatchObject({ id: victimId, activated: true, orgId: own.organizationId });
      });
    });

    // Re-review of f77349f66: the takeover only left workspaces that had other
    // members, so the squatter could leave their own paid workspace first.
    describe('leave-first, and invites held until the email is confirmed', () => {
      const CLIENT_ID = 'verify-one-tap-2.apps.googleusercontent.com';
      const KID = 'verify-integration-key-2';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const b64url = (v: object | Buffer) =>
        (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
      const googleCredential = (email: string) => {
        const now = Math.floor(Date.now() / 1000);
        const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          sub: `g-${randomUUID()}`,
          email,
          email_verified: true,
          name: 'Mailbox Owner',
          iat: now,
          exp: now + 600,
        })}`;
        return `${head}.${b64url(cryptoSign('RSA-SHA256', Buffer.from(head), privateKey))}`;
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

      /** The squatter's paid workspace W, with a webhook to their server, and an invite into it. */
      async function squatterWorkspace(tag: string) {
        const squatter = await confirmedReady(tag);
        await db().webhooks.create({
          data: {
            organizationId: squatter.orgId,
            name: 'Squatter hook',
            url: 'https://squatter.example.com/hook',
          },
        });
        const invite = await squatter.s.post('/settings/team', { role: 'ADMIN', sendEmail: false });
        return { ...squatter, inviteToken: inviteTokenFrom(invite.body.url) };
      }
      const memberships = (userId: string, organizationId: string) =>
        db().userOrganization.count({ where: { userId, organizationId } });

      it('the reviewer\'s order: invite sign-up, squatter leaves W, owner signs in with Google: not in W', async () => {
        const w = await squatterWorkspace('lf-squatter');
        const victimEmail = uniqueEmail('lf-victim');
        const reg = await t.api.post(
          '/auth/register',
          { email: victimEmail, password: 'Squatter-Pass-1', company: 'Victim Co', provider: 'LOCAL' },
          { cookies: { org: w.inviteToken } }
        );
        expect(reg.status).toBe(200);
        const victimId = (await db().user.findFirstOrThrow({ where: { email: victimEmail } })).id;
        // Held, not joined, while the address is unconfirmed.
        expect(await memberships(victimId, w.orgId)).toBe(0);

        // The squatter leaves W, so no one else is in it.
        const leave = await w.s.delete(`/settings/team/${w.userId}`);
        expect(leave.status).toBe(200);

        t.temporal.reset();
        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: googleCredential(victimEmail) });
        expect(res.status).toBe(200);
        expect(await memberships(victimId, w.orgId)).toBe(0);
        const owner = new Session(t.api, res.headers.get('auth')!, victimEmail, '');
        expect((await owner.self()).orgId).not.toBe(w.orgId);
        // ...and the owner is told which invitation was dropped.
        const notice = t.temporal.emails().find((m) => m.to === victimEmail && /removed|invitation/i.test(m.subject));
        expect(notice?.html).toContain('1 shared workspace');
        // A count only: a workspace name is whatever its maker typed.
        expect(notice?.html).not.toContain('Verify Co');
      });

      it('a membership the account already had (made before 25 Oct), even as the only member, is removed on takeover', async () => {
        const w = await squatterWorkspace('legacy-squatter');
        const { email, userId } = await signUp('legacy-victim');
        // As an account made before invites were held could have: joined, then left alone in W.
        await db().userOrganization.create({ data: { userId, organizationId: w.orgId, role: 'ADMIN' } });
        await db().userOrganization.deleteMany({ where: { userId: w.userId, organizationId: w.orgId } });
        expect(await db().userOrganization.count({ where: { organizationId: w.orgId } })).toBe(1);

        t.temporal.reset();
        await t.api.post('/auth/forgot', { email });
        const token = resetIn(t.temporal.emails().find((m) => m.to === email)!.html)!;
        await t.api.post('/auth/forgot-return', { token, password: 'Owner-Pass-22', repeatPassword: 'Owner-Pass-22' });
        expect(await memberships(userId, w.orgId)).toBe(0);
        const notice = t.temporal.emails().find((m) => m.to === email && /removed/i.test(m.subject));
        expect(notice?.html).toContain('1 shared workspace');
        // A count only: a workspace name is whatever its maker typed.
        expect(notice?.html).not.toContain('Verify Co');
      });

      it('while held, the invitee is told which team waits: GET /verify-email and the confirmation email', async () => {
        const w = await squatterWorkspace('hint-owner');
        const email = uniqueEmail('hint-invitee');
        t.temporal.reset();
        const reg = await t.api.post(
          '/auth/register',
          { email, password: PASSWORD, company: 'Invitee Co', provider: 'LOCAL' },
          { cookies: { org: w.inviteToken } }
        );
        const s = new Session(t.api, reg.headers.get('auth')!, email, PASSWORD);
        expect((await s.get('/verify-email')).body).toEqual({ verified: false, email, invitedTo: 'Verify Co' });
        expect(mailsTo(email)[0].html).toContain("You've been invited to");
        expect(mailsTo(email)[0].html).toContain('Verify Co');

        await t.api.post('/auth/activate', { code: linkFor(email) });
        expect((await s.get('/verify-email')).body).toEqual({ verified: true, email, invitedTo: null });
      });

      it('the held invite joins when the emailed link is used, and W (paid) is where it lands', async () => {
        const w = await squatterWorkspace('held-owner');
        const email = uniqueEmail('held-invitee');
        t.temporal.reset();
        await t.api.post(
          '/auth/register',
          { email, password: PASSWORD, company: 'Invitee Co', provider: 'LOCAL' },
          { cookies: { org: w.inviteToken } }
        );
        const userId = (await db().user.findFirstOrThrow({ where: { email } })).id;
        expect(await memberships(userId, w.orgId)).toBe(0);
        const res = await t.api.post('/auth/activate', { code: linkFor(email) });
        expect(res.body).toEqual({ can: true });
        expect(await memberships(userId, w.orgId)).toBe(1);
        const s = new Session(t.api, res.headers.get('auth')!, email, PASSWORD);
        expect((await s.self()).orgId).toBe(w.orgId);
      });
    });

    it('a workspace with no members and no api.market account cannot publish with its API key', async () => {
      const org = await db().organization.create({ data: { name: 'Emptied', apiKey: `emptied-${randomUUID()}` } });
      await givePlan(org.id, 'PRO');
      const channel = await addChannel(org.id, 'bluesky');
      const res = await t.api.publicApi(org.apiKey!, 'POST', '/posts', postBody(channel.id));
      // No member who may use Hookpost: the key resolves to nothing (the hard gate).
      expect(res.status).toBe(401);
    });

    it('the public API refuses a workspace whose subscription was deleted', async () => {
      const ready = await confirmedReady('deleted-sub');
      const key = await apiKeyOf(ready.orgId);
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(200);
      await db().subscription.update({ where: { organizationId: ready.orgId }, data: { deletedAt: new Date() } });
      expect((await t.api.publicApi(key, 'GET', '/integrations')).status).toBe(401);
    });

    describe('PUT /posts/:id/date meets the plan gate', () => {
      // A grandfathered workspace the Free plan sunset reached (needs_trial):
      // made now it is before this future cutoff, and the sunset has passed.
      const cutoff = '2099-01-01T00:00:00Z';
      beforeAll(() => {
        process.env.TRIAL_REQUIRED_SINCE_IN = cutoff;
        process.env.TRIAL_REQUIRED_SINCE_GLOBAL = cutoff;
        process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      });
      afterAll(() => {
        delete process.env.TRIAL_REQUIRED_SINCE_IN;
        delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
        delete process.env.FREE_PLAN_SUNSET_AT;
      });

      it('a workspace that must start its trial cannot requeue a post by moving it', async () => {
        const { s, orgId, userId, email } = await signUp('move-gated', { 'cf-ipcountry': 'IN' });
        await db().user.update({ where: { id: userId }, data: { signupCountry: 'IN' } });
        await t.api.post('/auth/activate', { code: linkFor(email) });
        const channel = await addChannel(orgId, 'bluesky');
        const post = await db().post.create({
          data: {
            organizationId: orgId,
            integrationId: channel.id,
            content: 'failed earlier',
            group: randomUUID(),
            publishDate: new Date(),
            state: 'ERROR',
          },
        });
        const res = await s.put(`/posts/${post.id}/date`, { date: future(), action: 'schedule' }, { headers: { 'cf-ipcountry': 'IN' } });
        expect(res.status).toBe(402);
        expect((await db().post.findUniqueOrThrow({ where: { id: post.id } })).state).toBe('ERROR');
      });
    });

    it('a workspace with a plan still moves its posts', async () => {
      const ready = await confirmedReady('move-paid');
      const created = await ready.s.post('/posts', postBody(ready.channelId));
      const id = created.body[0].postId;
      const res = await ready.s.put(`/posts/${id}/date`, { date: future(), action: 'schedule' });
      expect(res.status).toBe(200);
    });

    it('a reset link sent to the old address stops working after "Wrong address?"', async () => {
      const { email, s, userId } = await signUp('reset-moved');
      t.temporal.reset();
      await t.api.post('/auth/forgot', { email });
      const token = resetIn(t.temporal.emails().find((m) => m.to === email)!.html)!;
      expect((await s.post('/verify-email/change', { email: uniqueEmail('moved') })).body.sent).toBe(true);

      const res = await t.api.post('/auth/forgot-return', { token, password: 'Taken-Over-1', repeatPassword: 'Taken-Over-1' });
      expect(res.body).toEqual({ reset: false });
      const row = await db().user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.activated).toBe(false);
      // The password is the one the account had.
      expect((await t.api.post('/auth/login', { email: row.email, password: PASSWORD, provider: 'LOCAL' })).status).toBe(200);
    });

    it('two opens of the same link at once: exactly one signs in', async () => {
      const { email } = await signUp('race');
      const code = linkFor(email);
      const both = await Promise.all([t.api.post('/auth/activate', { code }), t.api.post('/auth/activate', { code })]);
      expect(both.map((r) => r.body.can).sort()).toEqual([false, true]);
      expect(both.filter((r) => r.headers.get('auth')).length).toBe(1);
    });

    it('PUT /webhooks is refused too', async () => {
      const { s } = await readyToPost('hook-put');
      const res = await s.put('/webhooks', { id: 'x', name: 'Hook', url: 'https://hooks.example.com/x', integrations: [] });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    });
  });

  describe('a password reset link confirms the address too', () => {
    it('confirms, signs the old sessions out, and renews the API key', async () => {
      const { email, s, orgId, userId } = await signUp('reset');
      const keyBefore = await apiKeyOf(orgId);
      t.temporal.reset();
      expect((await t.api.post('/auth/forgot', { email })).body).toEqual({ forgot: true });
      const token = resetIn(t.temporal.emails().find((m) => m.to === email)!.html)!;
      const res = await t.api.post('/auth/forgot-return', { token, password: 'New-Horse-77', repeatPassword: 'New-Horse-77' });
      expect(res.body).toEqual({ reset: true });

      expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).activated).toBe(true);
      expect(await apiKeyOf(orgId)).not.toBe(keyBefore);
      expect((await s.get('/user/self')).status).toBe(401);
    });
  });
});
