/**
 * Team invites and seat limits (pricing.ts team_member_limit, owner included):
 * Free and Standard have no team, Team has 5 seats, Pro has 15. The limit is
 * enforced twice, when the invite is made (organization.service.ts) and when
 * it is redeemed (organization.repository.ts addUserToOrg), and the pricing
 * page states the same numbers (pricing-page unit spec).
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail, inviteTokenFrom } from './setup/api';
import { db, disconnectDb, givePlan } from './setup/db';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

/** Adds `count` members straight in the database (seat-filling). */
async function fillSeats(organizationId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await db().user.create({
      data: {
        email: uniqueEmail('seat'),
        providerName: 'LOCAL',
        timezone: 0,
        password: '',
        organizations: { create: { organizationId, role: 'USER' } },
      },
    });
  }
}


describe('team: invites and seats', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  async function ownerOn(tier?: 'STANDARD' | 'TEAM' | 'PRO') {
    const owner = await t.api.register();
    const { orgId } = await owner.self();
    if (tier) await givePlan(orgId, tier);
    return { owner, orgId };
  }

  it('the published seat numbers are the ones enforced below', () => {
    expect(pricing.FREE.team_members).toBe(false);
    expect(pricing.STANDARD.team_members).toBe(false);
    expect(pricing.TEAM.team_member_limit).toBe(5);
    expect(pricing.PRO.team_member_limit).toBe(15);
  });

  it.each([['FREE' as const], ['STANDARD' as const]])(
    '%s: the team page and invites are refused with 402',
    async (tier) => {
      const { owner } = await ownerOn(tier === 'FREE' ? undefined : tier);
      const team = await owner.get('/settings/team');
      expect(team.status).toBe(402);
      const invite = await owner.post('/settings/team', {
        role: 'USER',
        sendEmail: false,
      });
      expect(invite.status).toBe(402);
    }
  );

  it('PRO: an invite link adds a new user to the workspace on sign-up', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    const invite = await owner.post('/settings/team', {
      role: 'ADMIN',
      sendEmail: false,
    });
    expect(invite.status).toBe(201);
    expect(invite.body.url).toMatch(/^http:\/\/localhost:4200\/invite\/[\w-]+\.[\w-]+\.[\w-]+$/);

    const member = await t.api.register({
      cookies: { org: inviteTokenFrom(invite.body.url) },
    });
    // The new user lands in the workspace they were invited to.
    expect(member.showorg).toBe(orgId);

    const team = await owner.get('/settings/team');
    expect(team.status).toBe(200);
    const roles = Object.fromEntries(
      team.body.users.map((u: any) => [u.user.email, u.role])
    );
    expect(roles[owner.email]).toBe('SUPERADMIN');
    expect(roles[member.email]).toBe('ADMIN');

    const orgs = await member.get('/user/organizations');
    expect(orgs.body.map((o: any) => o.id)).toContain(orgId);
  });

  it('an invite link works once', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    const token = inviteTokenFrom(invite.body.url);
    await t.api.register({ cookies: { org: token } });
    await t.api.register({ cookies: { org: token } });
    expect(await db().userOrganization.count({ where: { organizationId: orgId } })).toBe(2);
  });

  it('an existing user joins through the Join button (POST /user/invite/accept)', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    const existing = await t.api.register();
    const join = await existing.acceptInvite(inviteTokenFrom(invite.body.url));
    expect(join.status).toBe(200);
    expect(join.body).toEqual({ id: orgId, invite: 'joined' });
  });

  it('a forged invite token joins nothing', async () => {
    const { sign } = await import('jsonwebtoken');
    const { orgId } = await ownerOn('PRO');
    const forged = sign(
      { orgId, role: 'ADMIN', id: 'forge', timeLimit: '2999-01-01 00:00:00' },
      'wrong-secret'
    );
    const user = await t.api.register();
    const join = await user.acceptInvite(forged);
    expect(join.body).toEqual({ id: null, invite: 'invalid' });
  });

  it('an expired invite token joins nothing', async () => {
    const { sign } = await import('jsonwebtoken');
    const { orgId } = await ownerOn('PRO');
    const expired = sign(
      { orgId, role: 'USER', id: 'old01', timeLimit: '2020-01-01 00:00:00' },
      process.env.JWT_SECRET!
    );
    const user = await t.api.register();
    const join = await user.acceptInvite(expired);
    expect(join.body).toEqual({ id: null, invite: 'invalid' });
  });

  it('sendEmail: the invite goes out by email with the same link', async () => {
    const { owner } = await ownerOn('PRO');
    t.temporal.reset();
    const to = uniqueEmail('invitee');
    const invite = await owner.post('/settings/team', {
      email: to,
      role: 'USER',
      sendEmail: true,
    });
    expect(invite.status).toBe(201);
    const mail = t.temporal.emails().find((m) => m.to === to);
    expect(mail).toBeDefined();
    expect(mail!.html).toContain(inviteTokenFrom(invite.body.url));
  });

  it('PRO: the 16th seat is refused when inviting', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    await fillSeats(orgId, 13); // owner + 13 = 14
    const fifteenth = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    expect(fifteenth.status).toBe(201);
    await t.api.register({ cookies: { org: inviteTokenFrom(fifteenth.body.url) } });
    expect(await db().userOrganization.count({ where: { organizationId: orgId } })).toBe(15);

    const sixteenth = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    expect(sixteenth.status).toBe(400);
    expect(sixteenth.text).toMatch(/15 seats/);
  });

  it('PRO: an invite made with a seat free is refused if the team filled up since', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    await fillSeats(orgId, 13); // 14 of 15
    const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    expect(invite.status).toBe(201);
    await fillSeats(orgId, 1); // now 15 of 15

    const late = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
    expect(late.showorg).toBeUndefined();
    expect(await db().userOrganization.count({ where: { organizationId: orgId } })).toBe(15);
  });

  it('TEAM: 5 seats, the 6th invite is refused', async () => {
    const { owner, orgId } = await ownerOn('TEAM');
    await fillSeats(orgId, 4);
    const res = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    expect(res.status).toBe(400);
    expect(res.text).toMatch(/5 seats/);
  });

  it('a workspace downgraded to Free cannot redeem an invite made on Pro', async () => {
    const { owner, orgId } = await ownerOn('PRO');
    const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
    await db().subscription.deleteMany({ where: { organizationId: orgId } });
    await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
    expect(await db().userOrganization.count({ where: { organizationId: orgId } })).toBe(1);
  });

  describe('roles', () => {
    async function teamWithMember(role: 'USER' | 'ADMIN') {
      const { owner, orgId } = await ownerOn('PRO');
      const invite = await owner.post('/settings/team', { role, sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      return { owner, orgId, member: member as Session };
    }

    it('a USER member cannot see or invite to the team (ADMIN section)', async () => {
      const { member } = await teamWithMember('USER');
      expect((await member.get('/settings/team')).status).toBe(402);
      expect((await member.post('/settings/team', { role: 'USER', sendEmail: false })).status).toBe(402);
    });

    it('an ADMIN member can invite', async () => {
      const { member } = await teamWithMember('ADMIN');
      const res = await member.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(res.status).toBe(201);
    });

    it('the owner removes a member', async () => {
      const { owner, orgId, member } = await teamWithMember('USER');
      const { id } = await member.self();
      const res = await owner.delete(`/settings/team/${id}`);
      expect(res.status).toBe(200);
      expect(
        await db().userOrganization.count({ where: { organizationId: orgId, userId: id } })
      ).toBe(0);
    });

    it('an ADMIN cannot remove the owner', async () => {
      const { owner, orgId, member } = await teamWithMember('ADMIN');
      const { id: ownerId } = await owner.self();
      const res = await member.delete(`/settings/team/${ownerId}`);
      expect(res.status).toBe(403);
      expect(
        await db().userOrganization.count({ where: { organizationId: orgId, userId: ownerId } })
      ).toBe(1);
    });

    // Until 22 Oct 2026 deleteTeamMember refused with a plain Error, which
    // the exception filter could not serialise ("Converting circular structure
    // to JSON" in the log): a 500, and a generic failure on the Teams page.
    it('refusing to remove the owner answers 403 with the reason', async () => {
      const { owner, member } = await teamWithMember('ADMIN');
      const { id: ownerId } = await owner.self();
      const res = await member.delete(`/settings/team/${ownerId}`);
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/permission/i);
    });

    it('removing someone outside the workspace changes nothing', async () => {
      const { owner } = await ownerOn('PRO');
      const stranger = await t.api.register();
      const { id, orgId: strangerOrg } = await stranger.self();
      const res = await owner.delete(`/settings/team/${id}`);
      expect(res.status).toBe(404);
      expect(
        await db().userOrganization.count({ where: { organizationId: strangerOrg, userId: id } })
      ).toBe(1);
    });
  });

  describe('workspace switching', () => {
    it('showorg picks the workspace; one the user is not in is ignored', async () => {
      const { owner, orgId } = await ownerOn('PRO');
      const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({ cookies: { org: inviteTokenFrom(invite.body.url) } });
      const own = (await member.get('/user/organizations')).body.find((o: any) => o.id !== orgId);

      member.showorg = own.id;
      expect((await member.self()).orgId).toBe(own.id);
      member.showorg = orgId;
      expect((await member.self()).orgId).toBe(orgId);

      // Someone else's workspace id: falls back to one of the user's own.
      member.showorg = randomUUID();
      expect([own.id, orgId]).toContain((await member.self()).orgId);
    });

    it('POST /user/change-org answers the chosen workspace in showorg', async () => {
      const s = await t.api.register();
      const { orgId } = await s.self();
      const res = await s.post('/user/change-org', { id: orgId });
      expect(res.status).toBe(200);
      expect(res.headers.get('showorg')).toBe(orgId);
    });
  });
});
