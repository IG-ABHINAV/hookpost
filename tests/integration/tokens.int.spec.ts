/**
 * Every token the backend hands out is good for its own job only. Until 22 Oct
 * 2026 sessions, reset links, invites and the rest were all plain JWT_SECRET
 * tokens and no endpoint told them apart: a reset link was also a login with
 * no expiry, and a team invite (which signed every field of the request) could
 * be replayed to POST /public/modify-subscription. Now each kind has its own
 * key (TOKEN_PURPOSE in libraries/helpers/src/auth/auth.service.ts).
 */
import { sign } from 'jsonwebtoken';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { startApp, TestApp } from './setup/app';
import { inviteTokenFrom } from './setup/api';
import { disconnectDb, givePlan } from './setup/db';

const resetTokenFrom = (html: string) => /\/auth\/forgot\/([A-Za-z0-9_\-.]+)/.exec(html)?.[1];

describe('tokens: each kind does its own job only', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  async function resetToken() {
    const s = await t.api.register();
    t.temporal.reset();
    await t.api.post('/auth/forgot', { email: s.email });
    const token = resetTokenFrom(t.temporal.emails()[0].html)!;
    expect(token).toBeTruthy();
    return { s, token };
  }

  async function invite(body: Record<string, unknown> = {}) {
    const owner = await t.api.register();
    const { orgId } = await owner.self();
    await givePlan(orgId, 'PRO');
    const res = await owner.post('/settings/team', { role: 'USER', sendEmail: false, ...body });
    expect(res.status).toBe(201);
    return { owner, orgId, token: inviteTokenFrom(res.body.url) };
  }

  describe('password-reset link', () => {
    it('is not accepted as a login session', async () => {
      const { token } = await resetToken();
      const res = await t.api.get('/user/self', { headers: { auth: token } });
      expect(res.status).toBe(401);
    });

    it('still sets a new password, once used on the reset form', async () => {
      const { s, token } = await resetToken();
      const res = await t.api.post('/auth/forgot-return', {
        token,
        password: 'Brand-New-Pass-7',
        repeatPassword: 'Brand-New-Pass-7',
      });
      expect(res.body).toEqual({ reset: true });
      await expect(t.api.login(s.email, 'Brand-New-Pass-7')).resolves.toBeDefined();
    });

    it('a link sent before the fix ({ id, expires } with JWT_SECRET) is no login either', async () => {
      const s = await t.api.register();
      const { id } = await s.self();
      const old = sign({ id, expires: '2099-01-01 00:00:00' }, process.env.JWT_SECRET!);
      const res = await t.api.get('/user/self', { headers: { auth: old } });
      expect(res.status).toBe(401);
    });

    it('a login session is not a reset link', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/auth/forgot-return', {
        token: s.auth,
        password: 'Brand-New-Pass-7',
        repeatPassword: 'Brand-New-Pass-7',
      });
      expect(res.body).toEqual({ reset: false });
      await expect(t.api.login(s.email, s.password)).resolves.toBeDefined();
    });
  });

  describe('team invite', () => {
    it('cannot be replayed as a plan change', async () => {
      const { token } = await invite({ billing: 'ULTIMATE' });
      const res = await t.api.post('/public/modify-subscription', { params: token });
      expect(res.body).toEqual({ success: false });
    });

    it('carries only the invite fields, whatever else the admin sends', async () => {
      const { orgId, token } = await invite({ billing: 'ULTIMATE', apiKey: 'x' });
      const payload = AuthService.verifyPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, token);
      expect(payload).toMatchObject({ orgId, role: 'USER' });
      expect(payload).not.toHaveProperty('billing');
      expect(payload).not.toHaveProperty('apiKey');
    });

    it('is not a login session', async () => {
      const { token } = await invite();
      const res = await t.api.get('/user/self', { headers: { auth: token } });
      expect(res.status).toBe(401);
    });

    it('still adds the invited user to the workspace', async () => {
      const { orgId, token } = await invite();
      const existing = await t.api.register();
      const join = await existing.acceptInvite(token);
      expect(join.body).toEqual({ id: orgId, invite: 'joined' });
    });

    it('a login session is not an invite', async () => {
      const { owner } = await invite();
      const other = await t.api.register();
      const join = await other.acceptInvite(owner.auth);
      expect(join.body).toEqual({ id: null, invite: 'invalid' });
    });

    it('a password-reset link is not an invite', async () => {
      const { token } = await resetToken();
      const other = await t.api.register();
      const join = await other.acceptInvite(token);
      expect(join.body).toEqual({ id: null, invite: 'invalid' });
    });
  });

  describe('POST /public/modify-subscription', () => {
    it('a plain JWT_SECRET token with orgId and billing is refused', async () => {
      const { orgId } = await invite();
      const token = sign({ orgId, billing: 'ULTIMATE' }, process.env.JWT_SECRET!);
      const res = await t.api.post('/public/modify-subscription', { params: token });
      expect(res.body).toEqual({ success: false });
    });

    it('a login session is refused', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/public/modify-subscription', { params: s.auth });
      expect(res.body).toEqual({ success: false });
    });

    it('a plan-change token (which only JWT_SECRET can make) is still taken', async () => {
      const { orgId } = await invite();
      const token = AuthService.signPurposeJWT(TOKEN_PURPOSE.PLAN_CHANGE, { orgId, billing: 'PRO' });
      const res = await t.api.post('/public/modify-subscription', { params: token });
      expect(res.body).toEqual({ success: true });
    });
  });

  describe('Chrome extension refresh', () => {
    it('a login session is not an extension token', async () => {
      const s = await t.api.register();
      const res = await t.api.post('/integrations/extension-refresh', {
        jwt: s.auth,
        cookies: Buffer.from('{}').toString('base64'),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('billing discount flag', () => {
    it('is not a login session', async () => {
      const flag = AuthService.signPurposeJWT(TOKEN_PURPOSE.DISCOUNT_OFFER, { discount: true }, { expiresIn: '1d' });
      const res = await t.api.get('/user/self', { headers: { auth: flag } });
      expect(res.status).toBe(401);
    });
  });
});
