/**
 * The AI post generator's workspace links, against the real database: the
 * links a workspace keeps in its signatures and its members' agency profiles
 * are what an invented link in a generated post is replaced with (the post
 * may go out unread, so it never keeps a placeholder). Only live rows of
 * this workspace count. The model itself is not called here
 * (agent.graph.links.spec.ts and the live Vertex spec cover that).
 */
import { randomUUID } from 'crypto';
import { HumanMessage } from '@langchain/core/messages';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan } from './setup/db';
import { AgentGraphService } from '@hookpost/nestjs-libraries/agent/agent.graph.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';

describe('generator: workspace links', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let ownerId: string;

  const agency = (userId: string, website: string, deletedAt: Date | null = null) =>
    db().socialMediaAgency.create({
      data: {
        userId,
        name: 'Agency',
        website,
        shortDescription: 'short',
        description: 'long',
        deletedAt,
      },
    });

  const member = async (disabled: boolean) => {
    const user = await db().user.create({
      data: {
        email: `member-${randomUUID()}@example.test`,
        providerName: 'LOCAL',
        timezone: 0,
      },
    });
    await db().userOrganization.create({
      data: { userId: user.id, organizationId: orgId, disabled },
    });
    return user.id;
  };

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ company: 'Links Co' });
    const self = await owner.self();
    orgId = self.orgId;
    ownerId = self.id;
    await givePlan(orgId, 'STANDARD');

    // a deleted signature, then the auto-added one, then another
    const old = await owner.post('/signatures', { content: '<p>old.example</p>', autoAdd: false });
    expect(old.status).toBe(201);
    expect((await owner.delete(`/signatures/${old.body.id}`)).status).toBe(200);
    await owner.post('/signatures', { content: '<p>Write to team@acme.in</p>', autoAdd: false });
    await owner.post('/signatures', {
      content: '<p>Find us at <a href="https://acme.in">acme.in</a></p>',
      autoAdd: true,
    });

    await agency(ownerId, 'acme.co.za');
    await agency(await member(true), 'https://disabled-member.example');
    await agency(await member(false), 'https://gone-agency.example', new Date());

    const other = await t.api.register({ company: 'Other Co' });
    await other.post('/signatures', { content: '<p>other-workspace.example</p>', autoAdd: true });
  });

  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  it('reads live signatures (auto-added first) and live agency websites of active members', async () => {
    const sources = await t.get<OrganizationService>(OrganizationService).getLinkSources(orgId);
    expect(sources).toEqual([
      '<p>Find us at <a href="https://acme.in">acme.in</a></p>',
      '<p>Write to team@acme.in</p>',
      'https://acme.co.za',
    ]);
  });

  it('the generator loads them and puts the real website in place of an invented one', async () => {
    const generator = t.get<AgentGraphService>(AgentGraphService);
    const request = 'Write a post about our scheduler. Tell people where to sign up.';
    const loaded = await generator.saveResearch({
      messages: [new HumanMessage(request)],
      orgId,
    } as any);
    expect(loaded.workspaceLinks).toEqual(['https://acme.in', 'team@acme.in', 'https://acme.co.za']);

    const state = { messages: [new HumanMessage(request)], orgId, ...loaded } as any;
    const check = (text: string) => (generator as any).withoutInventedLinks(state, text, 'content');
    expect(check('Plan a month in an hour.\nTry it free at hookpost.com today! 🚀')).toBe(
      'Plan a month in an hour.\nTry it free at https://acme.in today! 🚀'
    );
    expect(check('Questions? Email hello@hookpost.com')).toBe('Questions? Email team@acme.in');
    expect(check('Sign up: [link]')).toBe('Sign up: https://acme.in');
  });

  it('a workspace without links gets the invented link removed, never a placeholder', async () => {
    const bare = await t.api.register({ company: 'Bare Co' });
    const bareOrg = (await bare.self()).orgId;
    const generator = t.get<AgentGraphService>(AgentGraphService);
    const loaded = await generator.saveResearch({ messages: [], orgId: bareOrg } as any);
    expect(loaded.workspaceLinks).toEqual([]);
    const state = { messages: [new HumanMessage('Write a post')], orgId: bareOrg, ...loaded } as any;
    expect(
      (generator as any).withoutInventedLinks(
        state,
        'Plan a month in an hour.\nTry it free at hookpost.com today!\nLink: [link]',
        'content'
      )
    ).toBe('Plan a month in an hour.\nTry it free today!');
  });
});
