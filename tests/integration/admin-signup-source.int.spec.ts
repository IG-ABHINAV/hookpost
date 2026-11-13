/**
 * GET /admin/users: each workspace carries where its sign-up came from
 * (signupSource, from SignupAttribution via signup.source.ts) next to its
 * marketplace source (Organization.source), against the real backend and
 * Postgres. The hp_attr cookie is what the marketing pages write before
 * sign-up; a Claude-directory visitor arrives with only a claude.ai referrer.
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail } from './setup/api';
import { addChannel, db, disconnectDb, makeSuperAdmin } from './setup/db';

const RUN = randomUUID().slice(0, 8);
const cookie = (v: Record<string, unknown>) =>
  encodeURIComponent(JSON.stringify({ first_seen_at: Date.now() - 60_000, ...v }));

describe('admin: sign-up source on GET /admin/users', () => {
  let t: TestApp;
  let admin: Session;
  let outsider: Session;

  const signUp = async (key: string, hpAttr?: Record<string, unknown>) => {
    const email = uniqueEmail(`src-${key}-${RUN}`);
    const res = await t.api.post(
      '/auth/register',
      { email, password: 'Correct-Horse-9', company: `Source ${key}`, provider: 'LOCAL' },
      hpAttr ? { cookies: { hp_attr: cookie(hpAttr) } } : {}
    );
    expect(res.status).toBe(200);
    const user = await db().user.findFirstOrThrow({ where: { email }, include: { organizations: true } });
    return { email, orgId: user.organizations[0].organizationId };
  };
  const orgFor = async (email: string) => {
    const res = await admin.get(`/admin/users?search=${encodeURIComponent(email)}`);
    expect(res.status).toBe(200);
    const u = res.body.users.find((x: any) => x.email === email);
    return u.organizations[0].organization;
  };

  beforeAll(async () => {
    t = await startApp();
    admin = await t.api.register({ company: 'Source HQ' });
    await makeSuperAdmin((await admin.self()).id);
    outsider = await t.api.register({ company: 'Not an admin' });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  it('a Claude-directory sign-up is labelled claude.ai with its landing path, and is a Direct workspace', async () => {
    const { email } = await signUp('claude', { referrer: 'https://claude.ai/', landing_path: '/auth' });
    const org = await orgFor(email);
    expect(org.signupSource).toEqual({
      label: 'claude.ai',
      kind: 'referral',
      campaign: null,
      landingPath: '/auth',
    });
    expect(org.source).toBe('DIRECT');
  });

  it('an ad sign-up is source / campaign', async () => {
    const { email } = await signUp('meta', {
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: `hp_in_sales_${RUN}`,
      fbclid: `IwAR${RUN}`,
      referrer: 'https://l.facebook.com/',
      landing_path: '/mcp',
    });
    expect((await orgFor(email)).signupSource).toEqual({
      label: `meta / hp_in_sales_${RUN}`,
      kind: 'utm',
      campaign: `hp_in_sales_${RUN}`,
      landingPath: '/mcp',
    });
  });

  it('no cookie is direct; no attribution row at all is null (unknown)', async () => {
    const direct = await signUp('direct');
    expect((await orgFor(direct.email)).signupSource).toMatchObject({ label: 'direct', kind: 'direct' });

    const old = await signUp('old');
    await db().signupAttribution.deleteMany({ where: { organizationId: old.orgId } });
    expect((await orgFor(old.email)).signupSource).toBeNull();
  });

  it('a marketplace workspace keeps its marketplace source beside the sign-up source', async () => {
    const mkt = await signUp('mkt', { referrer: 'https://chatgpt.com/' });
    await db().organization.update({ where: { id: mkt.orgId }, data: { source: 'API_MARKET' } });
    const org = await orgFor(mkt.email);
    expect(org.source).toBe('API_MARKET');
    expect(org.signupSource.label).toBe('chatgpt.com');
  });

  it('the user panel (journey) has the sign-up block: source, method, dates and live counts', async () => {
    const { email, orgId } = await signUp('panel', {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: `hp_search_${RUN}`,
      referrer: 'https://www.google.com/',
      landing_path: '/alternatives',
    });
    const user = await db().user.findFirstOrThrow({ where: { email } });
    await db().user.update({ where: { id: user.id }, data: { signupCountry: 'CA', signupCity: 'Toronto' } });
    const trialAt = new Date('2026-10-27T05:00:00Z');
    await db().signupAttribution.update({ where: { organizationId: orgId }, data: { trialStartedAt: trialAt } });
    // A finished channel, a deleted one and a placeholder: only the first counts.
    await addChannel(orgId, 'linkedin');
    const gone = await addChannel(orgId, 'facebook');
    await db().integration.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await addChannel(orgId, 'instagram', { inBetweenSteps: true });

    const res = await admin.get(`/admin/users/${user.id}/journey`);
    expect(res.status).toBe(200);
    expect(res.body.signup).toMatchObject({
      workspaceId: orgId,
      source: { label: `google / hp_search_${RUN}`, kind: 'utm' },
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: `hp_search_${RUN}`,
      referrerHost: 'google.com',
      landingPath: '/alternatives',
      country: 'CA',
      city: 'Toronto',
      method: 'LOCAL',
      trialStartedAt: trialAt.toISOString(),
      paidAt: null,
      channels: 1,
      posts: 0,
    });
    expect(new Date(res.body.signup.signedUpAt).getTime()).toBe(user.createdAt.getTime());
    expect(res.body.signup.firstChannelAt).not.toBeNull();

    expect((await outsider.get(`/admin/users/${user.id}/journey`)).status).not.toBe(200);
  });

  it('is refused to anyone but a platform super admin', async () => {
    const res = await outsider.get('/admin/users');
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body || '')).not.toContain('signupSource');
  });
});
