/**
 * The workspace level of the super-admin Users page, against the real backend
 * and Postgres: GET /admin/workspaces lists every live workspace (source,
 * members, owner, billing state, live channels and posts, created) and, for a
 * marketplace subscriber workspace, its masked subscriber id, product, plan,
 * status, last call and calls in the last 7 days; GET /admin/users gives each
 * workspace its member count; the user panel lists the user's workspaces with
 * role and members.
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, makeSuperAdmin } from './setup/db';
import { ACCOUNT_CALLS_KEY, utcDay } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';

const RUN = randomUUID().slice(0, 8);

describe('admin: workspaces', () => {
  let t: TestApp;
  let admin: Session;
  let outsider: Session;
  let team: { orgId: string; ownerId: string; memberEmail: string; ownerEmail: string };
  let mktOrgId: string;
  const SUBSCRIBER = `usr_${RUN}secretpart99`;

  beforeAll(async () => {
    t = await startApp();
    admin = await t.api.register({ company: 'Workspaces HQ' });
    await makeSuperAdmin((await admin.self()).id);
    outsider = await t.api.register({ company: 'Not an admin' });

    // A team workspace: its owner and one more member, a live channel, a
    // deleted one and a placeholder.
    const owner = await t.api.register({ company: `Team ${RUN}` });
    const ownerSelf = await owner.self();
    const member = await t.api.register({ company: `Member own ${RUN}` });
    const memberSelf = await member.self();
    await db().userOrganization.create({
      data: { userId: memberSelf.id, organizationId: ownerSelf.orgId, role: 'ADMIN' },
    });
    await addChannel(ownerSelf.orgId, 'linkedin');
    const gone = await addChannel(ownerSelf.orgId, 'x');
    await db().integration.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await addChannel(ownerSelf.orgId, 'instagram', { inBetweenSteps: true });
    team = {
      orgId: ownerSelf.orgId,
      ownerId: ownerSelf.id,
      memberEmail: member.email,
      ownerEmail: owner.email,
    };

    // An api.market subscriber workspace: no users by design.
    const org = await db().organization.create({
      data: { name: `apimkt social ${RUN}`, source: 'API_MARKET' } as any,
    });
    mktOrgId = org.id;
    const account = await db().marketplaceAccount.create({
      data: {
        marketplace: 'API_MARKET',
        externalUserId: SUBSCRIBER,
        product: 'social',
        plan: 'trial',
        organizationId: org.id,
        lastSeenAt: new Date('2026-10-27T03:00:00Z'),
      },
    });
    // Calls the gateway counted today and 3 days ago, and one 10 days ago (out).
    const day = (n: number) => utcDay(new Date(Date.now() - n * 86_400_000));
    await ioRedis.set(ACCOUNT_CALLS_KEY(account.id, day(0)), '5');
    await ioRedis.set(ACCOUNT_CALLS_KEY(account.id, day(3)), '2');
    await ioRedis.set(ACCOUNT_CALLS_KEY(account.id, day(10)), '40');
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const list = async () => {
    const res = await admin.get('/admin/workspaces');
    expect(res.status).toBe(200);
    return res.body.workspaces as any[];
  };

  it('lists a team workspace with members, owner, billing state and only live channels', async () => {
    const row = (await list()).find((w) => w.id === team.orgId);
    expect(row).toMatchObject({
      name: `Team ${RUN}`,
      source: 'DIRECT',
      sourceLabel: 'Direct',
      members: 2,
      owner: team.ownerEmail,
      channels: 1,
      posts: 0,
      marketplace: null,
    });
    expect(row.billing.state).toEqual(expect.any(String));
    expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt);
  });

  it('lists a marketplace workspace with a masked subscriber, plan and calls in the last 7 days', async () => {
    const rows = await list();
    const row = rows.find((w) => w.id === mktOrgId);
    expect(row).toMatchObject({
      source: 'API_MARKET',
      members: 0,
      owner: null,
      billing: { state: 'marketplace' },
      marketplace: {
        product: 'social',
        plan: 'trial',
        status: 'ACTIVE',
        lastCallAt: '2026-10-27T03:00:00.000Z',
        calls7d: 7,
      },
    });
    expect(row.marketplace.subscriber).toMatch(/^usr_…99$/);
    expect(JSON.stringify(rows)).not.toContain(SUBSCRIBER);
    // Newest first.
    const times = rows.map((w) => w.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('a deleted workspace is not listed', async () => {
    const org = await db().organization.create({ data: { name: `gone ${RUN}`, deletedAt: new Date() } as any });
    expect((await list()).some((w) => w.id === org.id)).toBe(false);
  });

  it('GET /admin/users gives each workspace its member count', async () => {
    const res = await admin.get(`/admin/users?search=${encodeURIComponent(team.memberEmail)}`);
    const u = res.body.users.find((x: any) => x.email === team.memberEmail);
    const byId = Object.fromEntries(u.organizations.map((o: any) => [o.organization.id, o]));
    expect(byId[team.orgId].organization.members).toBe(2);
    expect(byId[team.orgId].role).toBe('ADMIN');
  });

  it("the user panel lists the user's workspaces with role and members", async () => {
    const member = await db().user.findFirstOrThrow({ where: { email: team.memberEmail } });
    const res = await admin.get(`/admin/users/${member.id}/journey`);
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({ name: `Member own ${RUN}`, role: 'SUPERADMIN', members: 1, sourceLabel: 'Direct' }),
      expect.objectContaining({ id: team.orgId, name: `Team ${RUN}`, role: 'ADMIN', members: 2 }),
    ]);
  });

  it('is refused to anyone but a platform super admin', async () => {
    const res = await outsider.get('/admin/workspaces');
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body || '')).not.toContain('workspaces');
  });
});
