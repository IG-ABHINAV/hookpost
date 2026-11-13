/**
 * /enterprise/*: unauthenticated endpoints for a partner SaaS, trusted only
 * through a JWT signed with the partner's own ENTERPRISE_JWT_SECRET (create a
 * workspace on the unlimited lifetime plan, get a connect URL for a workspace
 * by API key, delete a channel by API key). Hookpost has no partner, so in
 * production the secret is unset and every request is refused.
 */
import { sign } from 'jsonwebtoken';
import { startApp, TestApp } from './setup/app';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

const PARTNER_SECRET = 'integration-partner-secret-not-used-anywhere-else';

describe('enterprise endpoints', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  beforeEach(() => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
  });
  afterAll(async () => {
    delete process.env.ENTERPRISE_JWT_SECRET;
    await t?.close();
    await disconnectDb();
  });

  const ultimateOrgs = () =>
    db().subscription.count({ where: { subscriptionTier: 'ULTIMATE', isLifetime: true, deletedAt: null } });

  it('create-user refuses a token we did not sign and creates nothing', async () => {
    const before = await ultimateOrgs();
    const forged = sign({ id: 'x1', name: 'Mallory', saasName: 'evil', email: 'm@example.test' }, 'not-our-secret');
    const res = await t.api.post('/enterprise/create-user', { params: forged });
    expect(res.body).toEqual({ success: false });
    expect(await ultimateOrgs()).toBe(before);
  });

  it('create-user with a partner token makes a lifetime workspace with an API key', async () => {
    const token = sign({ id: `p-${Date.now()}`, name: 'Partner User', saasName: 'partner', email: `pu${Date.now()}@example.test` }, PARTNER_SECRET);
    const res = await t.api.post('/enterprise/create-user', { params: token });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toBeTruthy();
    const org = await db().organization.findUniqueOrThrow({ where: { id: res.body.id }, include: { subscription: true } });
    expect(org.subscription).toMatchObject({ subscriptionTier: 'ULTIMATE', isLifetime: true });
  });

  // Until 22 Oct 2026 these endpoints verified with JWT_SECRET, which also
  // signs every login session, and create-user reads only id, name, email and
  // saasName, which a session has.
  it('a login session cannot be redeemed for an unlimited lifetime workspace', async () => {
    const user = await t.api.register();
    const before = await ultimateOrgs();
    const res = await t.api.post('/enterprise/create-user', { params: user.auth });
    expect(res.body).toEqual({ success: false });
    expect(res.body?.apiKey).toBeUndefined();
    expect(await ultimateOrgs()).toBe(before);
  });

  it('a token signed with JWT_SECRET is not a partner token', async () => {
    const before = await ultimateOrgs();
    const token = sign({ id: `p-${Date.now()}`, name: 'Partner User', saasName: 'partner', email: `pj${Date.now()}@example.test` }, process.env.JWT_SECRET!);
    const res = await t.api.post('/enterprise/create-user', { params: token });
    expect(res.body).toEqual({ success: false });
    expect(await ultimateOrgs()).toBe(before);
  });

  it('with no ENTERPRISE_JWT_SECRET (production) even a partner-shaped token is refused', async () => {
    delete process.env.ENTERPRISE_JWT_SECRET;
    const before = await ultimateOrgs();
    const token = sign({ id: `p-${Date.now()}`, name: 'Partner User', saasName: 'partner', email: `pn${Date.now()}@example.test` }, PARTNER_SECRET);
    const res = await t.api.post('/enterprise/create-user', { params: token });
    expect(res.body).toEqual({ success: false });
    expect(await ultimateOrgs()).toBe(before);
  });

  it('url: a forged token gets no connect URL', async () => {
    const owner = await t.api.register();
    const { orgId } = await owner.self();
    await givePlan(orgId, 'STANDARD');
    const forged = sign(
      { redirectUrl: 'https://evil.example/cb', apiKey: await apiKeyOf(orgId), provider: 'linkedin', webhookUrl: 'https://evil.example/hook' },
      'not-our-secret'
    );
    const res = await t.api.post('/enterprise/url', { params: forged });
    expect(res.text).not.toMatch(/linkedin\.com/);
  });

  it('delete-channel: a forged token deletes nothing', async () => {
    const owner = await t.api.register();
    const { orgId } = await owner.self();
    const channel = await addChannel(orgId, 'bluesky');
    const forged = sign({ apiKey: await apiKeyOf(orgId), id: channel.id }, 'not-our-secret');
    const res = await t.api.post('/enterprise/delete-channel', { params: forged });
    expect(res.body).toEqual({ success: false });
    expect((await db().integration.findUniqueOrThrow({ where: { id: channel.id } })).deletedAt).toBeNull();
  });

  it('delete-channel: a session of the workspace owner deletes nothing', async () => {
    const owner = await t.api.register();
    const { orgId } = await owner.self();
    const channel = await addChannel(orgId, 'bluesky');
    const res = await t.api.post('/enterprise/delete-channel', { params: owner.auth });
    expect(res.body).toEqual({ success: false });
    expect((await db().integration.findUniqueOrThrow({ where: { id: channel.id } })).deletedAt).toBeNull();
  });
});
