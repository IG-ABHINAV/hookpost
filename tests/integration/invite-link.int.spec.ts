/**
 * Team invite links, end to end on the backend (25 Oct 2026).
 *
 * Before: an emailed /?org=<token> opened signed out showed the homepage and
 * kept nothing (Cloudflare caches "/" with the query string ignored), so an
 * invitee who then signed up never joined; an existing account that signed
 * in instead of signing up joined nothing either (only /register read the
 * invite cookie); and a signed-in account that had not confirmed its email
 * got a 403 from /user/join-org, which the proxy turned into /?added=true.
 *
 * Now the email links to /invite/<token>; the proxy keeps the token in the
 * `org` cookie when signed out, and asks a signed-in visitor first (the
 * Join question, GET /user/invite; the Join button, POST
 * /user/invite/accept, is the only way in for a signed-in account since
 * /user/join-org joined on the GET), and every way
 * in redeems it the same way (AuthService.redeemInvite): joined now when the
 * account is confirmed (or Google), held until the emailed link when it is a
 * new password account. Plus the adversarial cases: forged, expired, reused,
 * a full team, a workspace that has not started its trial, a member opening
 * their own team's invite, and two people racing for one link or one seat.
 *
 * Runs with an email provider, as production does, so a password sign-up
 * has to confirm its address.
 */
process.env.EMAIL_PROVIDER = 'resend';

import { generateKeyPairSync, randomUUID, sign as cryptoSign } from 'crypto';
import { sign } from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { startApp, TestApp } from './setup/app';
import { ApiResponse, inviteTokenFrom, Session, uniqueEmail } from './setup/api';
import { db, disconnectDb, givePlan } from './setup/db';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';

const PASSWORD = 'Correct-Horse-9';
// needs_trial is a grandfathered workspace the Free plan sunset reached: made
// now it is before this future cutoff, and the sunset below has passed. A
// sign-up after a cutoff is free_posts since 28 Oct 2026.
const CUTOFF = '2099-01-01T00:00:00Z';
const SUNSET_PASSED = '2026-10-20T00:00:00Z';
const linkIn = (html: string) => /\/auth\/activate\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];

/** The Set-Cookie line for `name`, or undefined. */
const setCookie = (res: ApiResponse, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
const cookieValue = (res: ApiResponse, name: string) =>
  setCookie(res, name)?.split(';')[0].slice(name.length + 1);

describe('team invite links', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
  });
  afterEach(() => {
    process.env.TRIAL_REQUIRED_SINCE_IN = '';
    process.env.TRIAL_REQUIRED_SINCE_GLOBAL = '';
    process.env.FREE_PLAN_SUNSET_AT = '';
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const mailsTo = (email: string) => t.temporal.emails().filter((m) => m.to === email);
  const activate = async (email: string) => {
    const code = linkIn(mailsTo(email).filter((m) => /Confirm your email/.test(m.subject)).at(-1)!.html)!;
    return t.api.post('/auth/activate', { code });
  };
  const membersOf = (organizationId: string) => db().userOrganization.count({ where: { organizationId } });
  const isMember = async (userId: string, organizationId: string) =>
    (await db().userOrganization.count({ where: { userId, organizationId } })) === 1;
  const idOf = async (email: string) => (await db().user.findFirstOrThrow({ where: { email } })).id;

  /** A password account whose email is confirmed. */
  async function confirmedAccount(tag: string, company = 'Own Co') {
    const email = uniqueEmail(tag);
    const reg = await t.api.post('/auth/register', { email, password: PASSWORD, company, provider: 'LOCAL' });
    expect(reg.status).toBe(200);
    expect((await activate(email)).body).toEqual({ can: true });
    const s = await t.api.login(email, PASSWORD);
    return { email, s, userId: await idOf(email), orgId: (await s.self()).orgId };
  }

  /** A password account that has not confirmed its email. */
  async function unconfirmedAccount(tag: string) {
    const email = uniqueEmail(tag);
    const reg = await t.api.post('/auth/register', { email, password: PASSWORD, company: 'Pending Co', provider: 'LOCAL' });
    expect(reg.status).toBe(200);
    const s = new Session(t.api, reg.headers.get('auth')!, email, PASSWORD);
    return { email, s, userId: await idOf(email) };
  }

  /** A confirmed owner of a Pro workspace named `team`, and an invite into it. */
  async function teamWithInvite(team = 'Acme Team', role: 'USER' | 'ADMIN' = 'USER') {
    const owner = await confirmedAccount('owner', team);
    await givePlan(owner.orgId, 'PRO');
    const invite = await owner.s.post('/settings/team', { role, sendEmail: false });
    expect(invite.status).toBe(201);
    return { owner, orgId: owner.orgId, token: inviteTokenFrom(invite.body.url), url: invite.body.url as string };
  }

  describe('the link', () => {
    it('emails /invite/<token>, never /?org= (which the homepage cache swallowed)', async () => {
      const { owner } = await teamWithInvite();
      t.temporal.reset();
      const to = uniqueEmail('mailed');
      const res = await owner.s.post('/settings/team', { email: to, role: 'USER', sendEmail: true });
      expect(res.body.url).toMatch(/^http:\/\/localhost:4200\/invite\/[\w-]+\.[\w-]+\.[\w-]+$/);
      const html = t.temporal.emails().find((m) => m.to === to)!.html;
      expect(html).toContain(`http://localhost:4200/invite/${inviteTokenFrom(res.body.url)}`);
      expect(html).not.toContain('?org=');
    });

    it('POST /auth/invite/preview names the team while the invite is open, and only "not valid" otherwise', async () => {
      const { token, orgId } = await teamWithInvite('Preview Team');
      expect((await t.api.post('/auth/invite/preview', { token })).body).toEqual({ valid: true, team: 'Preview Team' });

      const forged = sign({ purpose: 'team-invite', orgId, id: 'forge', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
      const expired = AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { orgId, id: 'old01', role: 'USER', timeLimit: '2020-01-01 00:00:00' }, { expiresIn: '2d' });
      for (const bad of [forged, expired, 'garbage', '', undefined]) {
        expect((await t.api.post('/auth/invite/preview', { token: bad })).body).toEqual({ valid: false });
      }
      // A form post (cross-site) is refused like the other JSON-only routes.
      const form = await t.api.request('POST', '/auth/invite/preview', {
        raw: `token=${token}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(form.status).toBe(400);
      // Used: not valid any more.
      const member = await confirmedAccount('preview-member');
      await member.s.acceptInvite(token);
      expect((await t.api.post('/auth/invite/preview', { token })).body).toEqual({ valid: false });
    });
  });

  describe('signed out: the invite cookie, then sign-up or sign-in', () => {
    it('a new password account: held, then joined by the emailed link; the cookie is spent at once', async () => {
      const { orgId: target, token } = await teamWithInvite('Held Team');
      const email = uniqueEmail('new-invitee');
      t.temporal.reset();
      const reg = await t.api.post('/auth/register', { email, password: PASSWORD, company: 'Invitee Co', provider: 'LOCAL' }, { cookies: { org: token } });
      expect(reg.status).toBe(200);
      expect(cookieValue(reg, 'hp_invite')).toBe('held');
      expect(setCookie(reg, 'org')).toMatch(/^org=;/);
      expect(reg.headers.get('showorg')).toBeNull();
      const userId = await idOf(email);
      expect(await isMember(userId, target)).toBe(false);
      // The confirmation email and the banner name the team.
      expect(mailsTo(email)[0].html).toContain('Held Team');
      const s = new Session(t.api, reg.headers.get('auth')!, email, PASSWORD);
      expect((await s.get('/verify-email')).body.invitedTo).toBe('Held Team');

      expect((await activate(email)).body).toEqual({ can: true });
      expect(await isMember(userId, target)).toBe(true);
    });

    it('an existing confirmed account signs in instead: joined, that workspace shown, cookie spent', async () => {
      const { orgId, token } = await teamWithInvite('Sign-in Team');
      const member = await confirmedAccount('existing');
      const res = await t.api.post('/auth/login', { email: member.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: token } });
      expect(res.status).toBe(200);
      expect(cookieValue(res, 'hp_invite')).toBe('joined');
      expect(res.headers.get('showorg')).toBe(orgId);
      expect(setCookie(res, 'org')).toMatch(/^org=;/);
      expect(await isMember(member.userId, orgId)).toBe(true);
      const role = await db().userOrganization.findFirstOrThrow({ where: { userId: member.userId, organizationId: orgId } });
      expect(role.role).toBe('USER');
    });

    it('an existing account that has not confirmed its email signs in: held, not joined', async () => {
      const { orgId, token } = await teamWithInvite('Pending Team');
      const pending = await unconfirmedAccount('pending-signin');
      const res = await t.api.post('/auth/login', { email: pending.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: token } });
      expect(res.status).toBe(200);
      expect(cookieValue(res, 'hp_invite')).toBe('held');
      expect(await isMember(pending.userId, orgId)).toBe(false);
      expect((await pending.s.get('/verify-email')).body.invitedTo).toBe('Pending Team');
      await activate(pending.email);
      expect(await isMember(pending.userId, orgId)).toBe(true);
    });

    it('a wrong password redeems nothing and leaves the cookie for the next try', async () => {
      const { orgId, token } = await teamWithInvite();
      const member = await confirmedAccount('wrong-pass');
      const res = await t.api.post('/auth/login', { email: member.email, password: 'nope-nope-1', provider: 'LOCAL' }, { cookies: { org: token } });
      expect(res.status).toBe(400);
      expect(setCookie(res, 'org')).toBeUndefined();
      expect(await isMember(member.userId, orgId)).toBe(false);
    });

    describe('Google One Tap (auto-selected on the sign-up and sign-in pages)', () => {
      const CLIENT_ID = 'invite-one-tap.apps.googleusercontent.com';
      const KID = 'invite-integration-key';
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const b64url = (v: object | Buffer) =>
        (Buffer.isBuffer(v) ? v : Buffer.from(JSON.stringify(v))).toString('base64url');
      const credential = (email: string, sub: string) => {
        const now = Math.floor(Date.now() / 1000);
        const head = `${b64url({ alg: 'RS256', kid: KID, typ: 'JWT' })}.${b64url({
          iss: 'https://accounts.google.com',
          aud: CLIENT_ID,
          sub,
          email,
          email_verified: true,
          name: 'Invitee',
          iat: now,
          exp: now + 600,
        })}`;
        return `${head}.${b64url(cryptoSign('RSA-SHA256', Buffer.from(head), privateKey))}`;
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
        jest.restoreAllMocks();
        if (saved === undefined) delete process.env.YOUTUBE_CLIENT_ID;
        else process.env.YOUTUBE_CLIENT_ID = saved;
      });

      it('a new Google account is joined at once (Google vouched for the address)', async () => {
        const { orgId, token } = await teamWithInvite('Google Team');
        const email = uniqueEmail('g-new');
        // The visitor tapped "Continue as" (select_by: user).
        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, `g-${randomUUID()}`), select_by: 'user' }, { cookies: { org: token } });
        expect(res.status).toBe(200);
        expect(res.body.registered).toBe(true);
        expect(cookieValue(res, 'hp_invite')).toBe('joined');
        expect(res.headers.get('showorg')).toBe(orgId);
        expect(await isMember(await idOf(email), orgId)).toBe(true);
      });

      it('an existing Google account signing in is joined too (it used to join nothing)', async () => {
        const email = uniqueEmail('g-old');
        const sub = `g-${randomUUID()}`;
        expect((await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, sub) })).status).toBe(200);
        const { orgId, token } = await teamWithInvite('Google Team 2');
        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, sub), select_by: 'btn' }, { cookies: { org: token } });
        expect(res.body.registered).toBe(false);
        expect(cookieValue(res, 'hp_invite')).toBe('joined');
        expect(await isMember(await idOf(email), orgId)).toBe(true);
      });

      it('Google signing a returning account in by itself joins nothing: the invite becomes the Join question (review of 6b39f4692)', async () => {
        for (const selectBy of ['auto', 'fedcm_auto', undefined, 'something-new']) {
          const email = uniqueEmail('g-auto');
          const sub = `g-${randomUUID()}`;
          expect((await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, sub), select_by: 'user' })).status).toBe(200);
          const { orgId, token } = await teamWithInvite('Auto Team');
          const res = await t.api.post(
            '/auth/oauth/google/one-tap',
            { credential: credential(email, sub), ...(selectBy ? { select_by: selectBy } : {}) },
            { cookies: { org: token } }
          );
          expect(res.status).toBe(200);
          expect(res.body).toMatchObject({ login: true, registered: false, invite: 'ask' });
          const userId = await idOf(email);
          expect(await isMember(userId, orgId)).toBe(false);
          // Signed in, the sign-in invite spent, and the question waiting.
          expect(setCookie(res, 'org')).toMatch(/^org=;/);
          expect(cookieValue(res, 'invite_pending')).toBe(token);
          expect(setCookie(res, 'hp_invite')).toBeUndefined();
          expect(res.headers.get('showorg')).toBeNull();
          const s = new Session(t.api, res.headers.get('auth')!, email, '');
          expect((await s.inviteQuestion(token)).body).toMatchObject({ valid: true, team: 'Auto Team', member: false });
          // Joined only by Join.
          expect((await s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'joined' });
        }
      });

      it('an automatic sign-in with a dead invite settles it as before ("invalid"), nothing asked', async () => {
        const email = uniqueEmail('g-auto-dead');
        const sub = `g-${randomUUID()}`;
        await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, sub), select_by: 'user' });
        const res = await t.api.post('/auth/oauth/google/one-tap', { credential: credential(email, sub), select_by: 'auto' }, { cookies: { org: 'not.a.token' } });
        expect(res.body.invite).toBeUndefined();
        expect(cookieValue(res, 'hp_invite')).toBe('invalid');
        expect(setCookie(res, 'invite_pending')).toBeUndefined();
      });
    });
  });

  describe('signed in: asked first, joined only by the Join button (POST /user/invite/accept)', () => {
    /** The browser after the proxy answered GET /invite/<token>: its session and the invite_pending cookie. */
    const browserCookies = (s: Session, token: string) => ({ auth: s.auth, invite_pending: token });
    const APP = 'http://localhost:4200';

    it('the question names the team and who invited, and asking joins, holds and spends nothing', async () => {
      const { owner, orgId, token } = await teamWithInvite('Question Team');
      await db().user.update({ where: { id: owner.userId }, data: { name: 'Priya', lastName: 'Shah' } });
      const member = await confirmedAccount('asked');
      for (let i = 0; i < 3; i++) {
        const q = await member.s.inviteQuestion(token);
        expect(q.status).toBe(200);
        expect(q.body).toEqual({ valid: true, team: 'Question Team', inviter: 'Priya Shah', member: false, confirmEmail: false, ref: expect.stringMatching(/^[\w-]{22}$/) });
      }
      // An unconfirmed account is not asked at all: the hard gate (29 Oct 2026).
      const pending = await unconfirmedAccount('asked-pending');
      const asked = await pending.s.inviteQuestion(token);
      expect(asked.status).toBe(403);
      expect(asked.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
      expect(await isMember(member.userId, orgId)).toBe(false);
      expect(await isMember(pending.userId, orgId)).toBe(false);
      expect((await pending.s.get('/verify-email')).body.invitedTo).toBeNull();
      expect(await membersOf(orgId)).toBe(1);
      // Still unused: the person it was for can join.
      expect((await member.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'joined' });
    });

    it('the inviter is named only while still an active member; an invite made before 25 Oct names nobody', async () => {
      const { owner, orgId, token } = await teamWithInvite('Inviter Team');
      await db().user.update({ where: { id: owner.userId }, data: { name: 'Owner One' } });
      const member = await confirmedAccount('inviter-check');
      expect((await member.s.inviteQuestion(token)).body.inviter).toBe('Owner One');
      await db().userOrganization.updateMany({ where: { userId: owner.userId, organizationId: orgId }, data: { disabled: true } });
      expect((await member.s.inviteQuestion(token)).body.inviter).toBeNull();
      const older = AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { orgId, id: 'pre25', role: 'USER', timeLimit: '2999-01-01 00:00:00' }, { expiresIn: '2d' });
      expect((await member.s.inviteQuestion(older)).body).toMatchObject({ valid: true, inviter: null });
      // A `by` naming someone outside the team names nobody either.
      const stranger = await confirmedAccount('not-in-team');
      await db().user.update({ where: { id: stranger.userId }, data: { name: 'Hookpost Support' } });
      const spoof = AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { orgId, id: 'spoof', role: 'USER', timeLimit: '2999-01-01 00:00:00', by: stranger.userId }, { expiresIn: '2d' });
      expect((await member.s.inviteQuestion(spoof)).body.inviter).toBeNull();
    });

    it('Join: a confirmed account joins, the question is answered, that workspace is shown', async () => {
      const { orgId, token } = await teamWithInvite();
      const member = await confirmedAccount('signed-in');
      const res = await member.s.acceptInvite(token);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: orgId, invite: 'joined' });
      expect(await isMember(member.userId, orgId)).toBe(true);
      expect(setCookie(res, 'invite_pending')).toMatch(/^invite_pending=;/);
      expect(cookieValue(res, 'hp_invite')).toBe('joined');
      expect(res.headers.get('showorg')).toBe(orgId);
    });

    it('an unconfirmed account pressing Join is refused by the gate; once confirmed, Join joins', async () => {
      const { orgId, token } = await teamWithInvite('Banner Team');
      const pending = await unconfirmedAccount('signed-in-pending');
      const res = await pending.s.acceptInvite(token);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
      expect(await isMember(pending.userId, orgId)).toBe(false);
      await activate(pending.email);
      expect((await pending.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'joined' });
      expect(await isMember(pending.userId, orgId)).toBe(true);
    });

    it('Not now: the question goes, the invite stays usable until it expires', async () => {
      const { orgId, token } = await teamWithInvite('Later Team');
      const member = await confirmedAccount('not-now');
      const res = await member.s.post('/user/invite/dismiss', {}, { cookies: { invite_pending: token }, headers: { origin: APP } });
      expect(res.status).toBe(200);
      expect(setCookie(res, 'invite_pending')).toMatch(/^invite_pending=;/);
      expect(setCookie(res, 'hp_invite')).toBeUndefined();
      expect(await isMember(member.userId, orgId)).toBe(false);
      // Opened again later: asked again, and Join works.
      expect((await member.s.inviteQuestion(token)).body.valid).toBe(true);
      expect((await member.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'joined' });
    });

    it('a sign-in never redeems the question cookie (only the sign-up/sign-in cookie, org, is theirs)', async () => {
      const { orgId, token } = await teamWithInvite();
      const member = await confirmedAccount('signin-pending');
      const res = await t.api.post('/auth/login', { email: member.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { invite_pending: token } });
      expect(res.status).toBe(200);
      expect(setCookie(res, 'hp_invite')).toBeUndefined();
      expect(await isMember(member.userId, orgId)).toBe(false);
    });

    it('someone already in that team is told so, and Join changes nothing (not the role either)', async () => {
      const { owner, orgId, token } = await teamWithInvite('Own Team', 'ADMIN');
      expect((await owner.s.inviteQuestion(token)).body).toMatchObject({ valid: true, member: true, team: 'Own Team' });
      expect((await owner.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'member' });
      expect((await db().userOrganization.findFirstOrThrow({ where: { userId: owner.userId, organizationId: orgId } })).role).toBe('SUPERADMIN');
      expect(await membersOf(orgId)).toBe(1);
    });

    it('names are sent fit to show: markup kept as text, direction and control characters out, cut to 60', async () => {
      const name = `<img src=x onerror=alert(1)>\u202E${'B'.repeat(90)}`; // sign-up takes up to 128
      const { owner, token } = await teamWithInvite(name);
      await db().user.update({ where: { id: owner.userId }, data: { name: '<script>alert(2)</script>\n\u200BEve' } });
      const member = await confirmedAccount('xss-question');
      const q = (await member.s.inviteQuestion(token)).body;
      expect([...q.team]).toHaveLength(60);
      expect(q.team).toBe(`<img src=x onerror=alert(1)>${'B'.repeat(31)}\u2026`);
      expect(q.inviter).toBe('<script>alert(2)</script> Eve');
      // Stored as typed; only what is shown is cleaned.
      expect((await db().organization.findFirstOrThrow({ where: { id: owner.orgId } })).name).toBe(name);
    });

    it('the team name reaches the Check your inbox page as stored, for the frontend to show as text', async () => {
      // An invite is held only by signing up through its link now (the gate
      // refuses Join until the email is confirmed).
      const { token } = await teamWithInvite('<img src=x onerror=alert(1)> https://evil.example');
      const email = uniqueEmail('xss');
      const reg = await t.api.post('/auth/register', { email, password: PASSWORD, company: 'Pending Co', provider: 'LOCAL' }, { cookies: { org: token } });
      expect(reg.status).toBe(200);
      const pending = new Session(t.api, reg.headers.get('auth')!, email, PASSWORD);
      expect((await pending.get('/verify-email')).body.invitedTo).toBe('<img src=x onerror=alert(1)> https://evil.example');
    });

    describe('what a page on another site (or another *.hookstep.in host) can make the browser send', () => {
      it('an auto-submitted form, with the session and question cookies the browser attaches: 415, nothing joined', async () => {
        const { orgId, token } = await teamWithInvite('CSRF Team');
        const victim = await confirmedAccount('csrf-victim');
        const ref = (await victim.s.inviteQuestion(token)).body.ref;
        const forms: [string, string][] = [
          ['application/x-www-form-urlencoded', `ref=${ref}`],
          ['text/plain', `{"ref":"${ref}","pad":"="}`],
          ['text/plain; x=application/json', JSON.stringify({ ref })],
          ['multipart/form-data; boundary=x', `--x\r\nContent-Disposition: form-data; name="ref"\r\n\r\n${ref}\r\n--x--\r\n`],
        ];
        for (const [type, raw] of forms) {
          for (const origin of ['https://evil.example', 'https://media.hookstep.in', APP]) {
            const res = await t.api.request('POST', '/user/invite/accept', {
              raw,
              headers: { 'content-type': type, origin },
              cookies: browserCookies(victim.s, token),
            });
            expect(res.status).toBe(415);
            expect(setCookie(res, 'showorg')).toBeUndefined();
          }
        }
        expect(await isMember(victim.userId, orgId)).toBe(false);
        expect((await victim.s.inviteQuestion(token)).body.valid).toBe(true);
      });

      it('JSON without the app\u2019s Origin (none, "null", another site, a sibling host): 403, nothing joined', async () => {
        const { orgId, token } = await teamWithInvite();
        const victim = await confirmedAccount('origin-victim');
        const ref = (await victim.s.inviteQuestion(token)).body.ref;
        for (const origin of [undefined, 'null', 'https://evil.example', 'https://media.hookstep.in', 'http://localhost:6274', 'http://localhost:4200.evil.example']) {
          const res = await t.api.request('POST', '/user/invite/accept', {
            body: { ref },
            headers: origin === undefined ? {} : { origin },
            cookies: browserCookies(victim.s, token),
          });
          expect(res.status).toBe(403);
        }
        expect(await isMember(victim.userId, orgId)).toBe(false);
      });

      it('no GET joins: not the accept route, not the old /user/join-org, not the question', async () => {
        const { orgId, token } = await teamWithInvite();
        const victim = await confirmedAccount('get-victim');
        const ref = (await victim.s.inviteQuestion(token)).body.ref;
        for (const path of ['/user/invite/accept', `/user/invite/accept?ref=${ref}`, `/user/join-org?org=${token}`, `/user/invite?accept=1&ref=${ref}`]) {
          const res = await t.api.request('GET', path, { cookies: browserCookies(victim.s, token) });
          expect(res.status === 404 || (res.status === 200 && res.body?.valid === true)).toBe(true);
        }
        expect((await victim.s.post('/user/join-org', { org: token })).status).toBe(404);
        expect(await isMember(victim.userId, orgId)).toBe(false);
        expect(await membersOf(orgId)).toBe(1);
      });

      it('a click on a page that showed another invite: 409, nothing joined, then the right one joins', async () => {
        const a = await teamWithInvite('Shown Team');
        const b = await teamWithInvite('Swapped Team');
        const victim = await confirmedAccount('swap-victim');
        const shown = (await victim.s.inviteQuestion(a.token)).body.ref;
        // A popup opened b's link, which replaced the question cookie.
        const res = await victim.s.acceptInvite(b.token, { ref: shown });
        expect(res.status).toBe(409);
        expect(res.body.invite).toBe('changed');
        expect(await isMember(victim.userId, a.orgId)).toBe(false);
        expect(await isMember(victim.userId, b.orgId)).toBe(false);
        for (const ref of ['', 'x'.repeat(22)]) {
          expect((await victim.s.acceptInvite(b.token, { ref })).status).toBe(409);
        }
        expect((await victim.s.acceptInvite(b.token)).body).toEqual({ id: b.orgId, invite: 'joined' });
      });

      it('a replayed POST: the same person is "member" (nothing added), anyone else "invalid"', async () => {
        const { orgId, token } = await teamWithInvite('Replay Team');
        const first = await confirmedAccount('replay-first');
        const ref = (await first.s.inviteQuestion(token)).body.ref;
        const press = (s: Session) =>
          s.post('/user/invite/accept', { ref }, { cookies: { invite_pending: token }, headers: { origin: APP } });
        expect((await press(first.s)).body).toEqual({ id: orgId, invite: 'joined' });
        for (let i = 0; i < 3; i++) expect((await press(first.s)).body).toEqual({ id: orgId, invite: 'member' });
        const second = await confirmedAccount('replay-second');
        expect((await press(second.s)).body).toEqual({ id: null, invite: 'invalid' });
        expect((await second.s.inviteQuestion(token)).body).toEqual({ valid: false });
        expect(await membersOf(orgId)).toBe(2);
        // Ten presses at once by people holding the same link: one joins.
        const crowd = await Promise.all([...Array(5)].map((_, i) => confirmedAccount(`replay-crowd-${i}`)));
        const fresh = await teamWithInvite('Crowd Team');
        const freshRef = (await crowd[0].s.inviteQuestion(fresh.token)).body.ref;
        const answers = await Promise.all(
          [...crowd, ...crowd].map((p) =>
            p.s.post('/user/invite/accept', { ref: freshRef }, { cookies: { invite_pending: fresh.token }, headers: { origin: APP } })
          )
        );
        expect(answers.filter((r) => r.body.invite === 'joined')).toHaveLength(1);
        expect(await membersOf(fresh.orgId)).toBe(2);
      });

      it('a full team: asked, then "full" on Join, nobody added', async () => {
        const { orgId, token } = await teamWithInvite('Packed Team');
        for (let i = 0; i < 14; i++) {
          await db().user.create({
            data: { email: uniqueEmail('packed'), providerName: 'LOCAL', timezone: 0, password: '', activated: true, organizations: { create: { organizationId: orgId, role: 'USER' } } },
          });
        }
        expect(await membersOf(orgId)).toBe(15);
        const late = await confirmedAccount('packed-late');
        expect((await late.s.inviteQuestion(token)).body.valid).toBe(true);
        const res = await late.s.acceptInvite(token);
        expect(res.body).toEqual({ id: null, invite: 'full' });
        expect(cookieValue(res, 'hp_invite')).toBe('full');
        expect(res.headers.get('showorg')).toBeNull();
        expect(await membersOf(orgId)).toBe(15);
      });

      it('a grandfathered team the Free plan sunset reached (needs_trial): "unavailable" on Join, nobody added', async () => {
        process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
        process.env.FREE_PLAN_SUNSET_AT = SUNSET_PASSED;
        const { owner, orgId, token } = await teamWithInvite('Trial Gate Team');
        await db().user.update({ where: { id: owner.userId }, data: { signupCountry: 'IN' } });
        await db().subscription.deleteMany({ where: { organizationId: orgId } });
        expect((await owner.s.self()).planState).toBe('needs_trial');
        const member = await confirmedAccount('trial-gate');
        expect((await member.s.acceptInvite(token)).body).toEqual({ id: null, invite: 'unavailable' });
        expect(await membersOf(orgId)).toBe(1);
      });
    });
  });

  describe('adversarial', () => {
    it('forged and expired tokens: "invalid" on every way in, nothing joined, nothing held', async () => {
      const { orgId } = await teamWithInvite();
      const forged = sign({ purpose: 'team-invite', orgId, id: 'forge', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
      const expired = AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, { orgId, id: 'old02', role: 'ADMIN', timeLimit: '2020-01-01 00:00:00' }, { expiresIn: '2d' });
      const session = AuthService.signSessionJWT({ id: 'x', email: 'x@x', password: null } as any);
      for (const bad of [forged, expired, session, 'not-a-token']) {
        const member = await confirmedAccount('bad-token');
        const login = await t.api.post('/auth/login', { email: member.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: bad } });
        expect(cookieValue(login, 'hp_invite')).toBe('invalid');
        expect(setCookie(login, 'org')).toMatch(/^org=;/);
        // Never asked about (the proxy sends such a link straight to the app), and Join refuses it.
        expect((await member.s.inviteQuestion(bad)).body).toEqual({ valid: false });
        expect((await member.s.acceptInvite(bad)).body).toEqual({ id: null, invite: 'invalid' });
        const pending = await unconfirmedAccount('bad-token-pending');
        expect((await pending.s.acceptInvite(bad)).status).toBe(403);
        expect((await pending.s.get('/verify-email')).body.invitedTo).toBeNull();
      }
      expect(await membersOf(orgId)).toBe(1);
    });

    it('a used invite does not work again, not even after its user joined another team', async () => {
      const a = await teamWithInvite('Team A');
      const b = await teamWithInvite('Team B');
      const first = await confirmedAccount('first');
      expect((await first.s.acceptInvite(a.token)).body.invite).toBe('joined');
      const second = await confirmedAccount('second');
      expect((await second.s.acceptInvite(a.token)).body).toEqual({ id: null, invite: 'invalid' });

      // first's User.inviteId moves on to B's invite; the database alone
      // would now let A's link through again (a forwarded email).
      expect((await first.s.acceptInvite(b.token)).body.invite).toBe('joined');
      const third = await confirmedAccount('third');
      expect((await third.s.acceptInvite(a.token)).body).toEqual({ id: null, invite: 'invalid' });
      const signup = await t.api.post('/auth/register', { email: uniqueEmail('fourth'), password: PASSWORD, company: 'Invitee Co', provider: 'LOCAL' }, { cookies: { org: a.token } });
      expect(cookieValue(signup, 'hp_invite')).toBe('invalid');
      expect(await membersOf(a.orgId)).toBe(2);
      // Its own user opening it again is told they are in.
      expect((await first.s.acceptInvite(a.token)).body).toEqual({ id: a.orgId, invite: 'member' });
    });

    it('one link opened by six people at once: exactly one joins', async () => {
      const { orgId, token } = await teamWithInvite('Race Team');
      const people = await Promise.all([...Array(6)].map((_, i) => confirmedAccount(`race-${i}`)));
      const answers = await Promise.all(people.map((p) => p.s.acceptInvite(token)));
      const outcomes = answers.map((r) => r.body.invite).sort();
      expect(outcomes).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid', 'joined']);
      expect(await membersOf(orgId)).toBe(2);
    });

    it('seat limit: the 16th member of a Pro team is refused as "full", one at a time and racing', async () => {
      const { owner, orgId } = await teamWithInvite('Full Team');
      // owner + 13 = 14 of 15
      for (let i = 0; i < 13; i++) {
        await db().user.create({
          data: { email: uniqueEmail('seat'), providerName: 'LOCAL', timezone: 0, password: '', activated: true, organizations: { create: { organizationId: orgId, role: 'USER' } } },
        });
      }
      // Three invites made while a seat was free, redeemed at once: one seat, one join.
      const tokens = [];
      for (let i = 0; i < 3; i++) {
        tokens.push(inviteTokenFrom((await owner.s.post('/settings/team', { role: 'USER', sendEmail: false })).body.url));
      }
      const people = await Promise.all(tokens.map((_, i) => confirmedAccount(`seat-race-${i}`)));
      const answers = await Promise.all(people.map((p, i) => p.s.acceptInvite(tokens[i])));
      expect(answers.map((r) => r.body.invite).sort()).toEqual(['full', 'full', 'joined']);
      expect(await membersOf(orgId)).toBe(15);

      // And through sign-in.
      const late = await confirmedAccount('seat-late');
      const unused = tokens[answers.findIndex((r) => r.body.invite === 'full')];
      const login = await t.api.post('/auth/login', { email: late.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: unused } });
      expect(cookieValue(login, 'hp_invite')).toBe('full');
      expect(login.headers.get('showorg')).toBeNull();
      expect(await membersOf(orgId)).toBe(15);
    });

    it('a grandfathered workspace the Free plan sunset reached (needs_trial) cannot invite (402), and an older invite into it is "unavailable"', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = SUNSET_PASSED;
      const owner = await confirmedAccount('needs-trial-owner', 'Trial Team');
      await db().user.update({ where: { id: owner.userId }, data: { signupCountry: 'IN' } });
      expect((await owner.s.self()).planState).toBe('needs_trial');
      const refused = await owner.s.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(refused.status).toBe(402);

      // An invite made while it had a plan, then the plan went away.
      await givePlan(owner.orgId, 'PRO');
      const made = await owner.s.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(made.status).toBe(201);
      await db().subscription.deleteMany({ where: { organizationId: owner.orgId } });
      expect((await owner.s.self()).planState).toBe('needs_trial');

      const member = await confirmedAccount('needs-trial-member');
      expect((await member.s.acceptInvite(inviteTokenFrom(made.body.url))).body).toEqual({ id: null, invite: 'unavailable' });
      const login = await t.api.post('/auth/login', { email: member.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: inviteTokenFrom(made.body.url) } });
      expect(cookieValue(login, 'hp_invite')).toBe('unavailable');
      expect(await membersOf(owner.orgId)).toBe(1);
    });

    it("an invite to team A redeemed by someone already in A: told so, nothing changes, the invite stays usable", async () => {
      const { owner, orgId, token } = await teamWithInvite('Member Team', 'ADMIN');
      // The owner opens their own team's ADMIN invite: still SUPERADMIN.
      expect((await owner.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'member' });
      const login = await t.api.post('/auth/login', { email: owner.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: token } });
      expect(cookieValue(login, 'hp_invite')).toBe('member');
      expect(login.headers.get('showorg')).toBe(orgId);
      const ownerRow = await db().userOrganization.findFirstOrThrow({ where: { userId: owner.userId, organizationId: orgId } });
      expect(ownerRow.role).toBe('SUPERADMIN');

      // A plain USER member opening an ADMIN invite stays USER.
      const userInvite = await owner.s.post('/settings/team', { role: 'USER', sendEmail: false });
      const plain = await confirmedAccount('plain-member');
      expect((await plain.s.acceptInvite(inviteTokenFrom(userInvite.body.url))).body.invite).toBe('joined');
      expect((await plain.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'member' });
      expect((await db().userOrganization.findFirstOrThrow({ where: { userId: plain.userId, organizationId: orgId } })).role).toBe('USER');

      // Nobody used the ADMIN invite: the person it was for still can.
      const invitee = await confirmedAccount('admin-invitee');
      expect((await invitee.s.acceptInvite(token)).body).toEqual({ id: orgId, invite: 'joined' });
      expect((await db().userOrganization.findFirstOrThrow({ where: { userId: invitee.userId, organizationId: orgId } })).role).toBe('ADMIN');
      expect(await membersOf(orgId)).toBe(3);
    });

    it('a deleted workspace: "invalid"', async () => {
      const { orgId, token } = await teamWithInvite('Gone Team');
      await db().organization.update({ where: { id: orgId }, data: { deletedAt: new Date() } });
      const member = await confirmedAccount('gone');
      expect((await member.s.acceptInvite(token)).body).toEqual({ id: null, invite: 'invalid' });
      expect((await t.api.post('/auth/invite/preview', { token })).body).toEqual({ valid: false });
    });
  });

  describe('cookies as production sets them (NOT_SECURED empty)', () => {
    it('the spent invite cookie is cleared with the flags the proxy set it with; the result cookie is readable', async () => {
      const { token } = await teamWithInvite();
      const member = await confirmedAccount('secure');
      const saved = process.env.NOT_SECURED;
      delete process.env.NOT_SECURED;
      let res: ApiResponse;
      try {
        res = await t.api.post('/auth/login', { email: member.email, password: PASSWORD, provider: 'LOCAL' }, { cookies: { org: token } });
      } finally {
        process.env.NOT_SECURED = saved;
      }
      expect(res.status).toBe(200);
      const org = setCookie(res, 'org')!;
      expect(org).toMatch(/^org=;/);
      expect(org).toMatch(/Domain=localhost/i);
      expect(org).toMatch(/Path=\//);
      expect(org).toMatch(/HttpOnly/i);
      expect(org).toMatch(/Secure/i);
      expect(org).toMatch(/SameSite=Lax/i);
      const result = setCookie(res, 'hp_invite')!;
      expect(result).toMatch(/^hp_invite=joined;/);
      expect(result).not.toMatch(/HttpOnly/i);
      expect(result).toMatch(/Max-Age=600/);
      // The workspace is picked with the session's own flags, never in a header.
      expect(setCookie(res, 'showorg')).toMatch(/HttpOnly/i);
      expect(res.headers.get('showorg')).toBeNull();
    });

    it('Join answers the question with the flags the proxy set it with; the workspace cookie is httpOnly', async () => {
      const { orgId, token } = await teamWithInvite();
      const member = await confirmedAccount('secure-join');
      const ref = (await member.s.inviteQuestion(token)).body.ref;
      const saved = process.env.NOT_SECURED;
      delete process.env.NOT_SECURED;
      let res: ApiResponse;
      try {
        res = await t.api.post('/user/invite/accept', { ref }, {
          cookies: { auth: member.s.auth, invite_pending: token },
          headers: { origin: 'http://localhost:4200' },
        });
      } finally {
        process.env.NOT_SECURED = saved;
      }
      expect(res.body).toEqual({ id: orgId, invite: 'joined' });
      const pending = setCookie(res, 'invite_pending')!;
      expect(pending).toMatch(/^invite_pending=;/);
      expect(pending).toMatch(/Domain=localhost/i);
      expect(pending).toMatch(/Path=\//);
      expect(pending).toMatch(/HttpOnly/i);
      expect(pending).toMatch(/Secure/i);
      expect(pending).toMatch(/SameSite=Lax/i);
      expect(setCookie(res, 'hp_invite')).toMatch(/^hp_invite=joined;/);
      expect(setCookie(res, 'hp_invite')).not.toMatch(/HttpOnly/i);
      expect(setCookie(res, 'showorg')).toMatch(/HttpOnly/i);
      expect(res.headers.get('showorg')).toBeNull();
    });
  });
});
