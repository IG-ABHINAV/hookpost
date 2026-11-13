/**
 * Public API v1 (/public/v1/*), the surface the CLI, the stdio MCP package,
 * the Node SDK, the n8n node and customers' own scripts all depend on.
 *
 * PublicAuthMiddleware: the raw API key (or a pos_ OAuth token, see
 * oauth-provider.int.spec.ts) in Authorization, and a paid plan when billing
 * is on. Every route is scoped to the key's workspace.
 */
import dayjs from 'dayjs';
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

// A real 1x1 PNG, so file-type sniffing accepts it.
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex'
);

const draftBody = (integrationId: string, content = 'Drafted through the public API') => ({
  type: 'draft',
  shortLink: false,
  date: dayjs().add(3, 'day').toISOString(),
  tags: [],
  posts: [
    {
      integration: { id: integrationId },
      value: [{ content, image: [] }],
      settings: {},
    },
  ],
});

describe('public API v1', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let key: string;
  let channel: { id: string; token: string; refreshToken: string | null };

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ company: 'API Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    key = await apiKeyOf(orgId);
    channel = await addChannel(orgId, 'bluesky', { name: 'API test channel' });
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  describe('authentication', () => {
    it('401 without a key', async () => {
      const res = await t.api.get('/public/v1/integrations');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'No API Key found' });
    });

    it('401 with an unknown key', async () => {
      const res = await t.api.publicApi('not-a-key', 'GET', '/integrations');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'Invalid API key' });
    });

    it('401 with a "Bearer " prefix (the key is sent raw)', async () => {
      const res = await t.api.publicApi(`Bearer ${key}`, 'GET', '/integrations');
      expect(res.status).toBe(401);
    });

    it('401 for a workspace without a paid plan', async () => {
      const free = await t.api.register({ company: 'Free API Co' });
      const freeKey = await apiKeyOf((await free.self()).orgId);
      const res = await t.api.publicApi(freeKey, 'GET', '/integrations');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'No subscription found' });
    });

    it('401 for a plan whose end date has passed, before the hourly sweep deletes its row', async () => {
      const lapsed = await t.api.register({ company: 'Lapsed API Co' });
      const lapsedOrg = (await lapsed.self()).orgId;
      await givePlan(lapsedOrg, 'STANDARD');
      await db().subscription.update({
        where: { organizationId: lapsedOrg },
        data: { identifier: `sub_lapsed${Date.now()}`, cancelAt: new Date(Date.now() - 60_000) },
      });
      const lapsedKey = await apiKeyOf(lapsedOrg);
      const res = await t.api.publicApi(lapsedKey, 'GET', '/integrations');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ msg: 'No subscription found' });

      // Still inside the paid time it was cancelled with: the API works.
      await db().subscription.update({
        where: { organizationId: lapsedOrg },
        data: { cancelAt: new Date(Date.now() + 86_400_000) },
      });
      expect((await t.api.publicApi(lapsedKey, 'GET', '/integrations')).status).toBe(200);
    });

    it('401 for a deleted workspace', async () => {
      const gone = await t.api.register({ company: 'Gone API Co' });
      const goneOrg = (await gone.self()).orgId;
      await givePlan(goneOrg, 'STANDARD');
      const goneKey = await apiKeyOf(goneOrg);
      await db().organization.update({ where: { id: goneOrg }, data: { deletedAt: new Date() } });
      const res = await t.api.publicApi(goneKey, 'GET', '/integrations');
      expect(res.status).toBe(401);
    });

    it('/is-connected answers for a valid key', async () => {
      const res = await t.api.publicApi(key, 'GET', '/is-connected');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: true });
    });
  });

  describe('channels', () => {
    it('lists channels without any token or secret', async () => {
      const res = await t.api.publicApi(key, 'GET', '/integrations');
      expect(res.status).toBe(200);
      const mine = res.body.find((i: any) => i.id === channel.id);
      expect(mine).toMatchObject({
        id: channel.id,
        name: 'API test channel',
        identifier: 'bluesky',
        disabled: false,
      });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(channel.token);
      expect(text).not.toContain(channel.refreshToken!);
      expect(Object.keys(mine).sort()).toEqual(
        ['customer', 'disabled', 'id', 'identifier', 'name', 'picture', 'profile'].filter(
          (k) => k in mine
        ).sort()
      );
    });

    it('integration settings: rules and max length for its own channel, 404 for another', async () => {
      const own = await t.api.publicApi(key, 'GET', `/integration-settings/${channel.id}`);
      expect(own.status).toBe(200);
      expect(own.body.output.maxLength).toBe(300);

      const other = await t.api.register({ company: 'Other Co' });
      const otherChannel = await addChannel((await other.self()).orgId, 'bluesky');
      const foreign = await t.api.publicApi(key, 'GET', `/integration-settings/${otherChannel.id}`);
      expect(foreign.status).toBe(404);
    });

    it('GET /groups lists the customers of the workspace', async () => {
      const res = await t.api.publicApi(key, 'GET', '/groups');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('GET /find-slot/:id returns a future time in ISO 8601 UTC', async () => {
      const res = await t.api.publicApi(key, 'GET', `/find-slot/${channel.id}`);
      expect(res.status).toBe(200);
      // The dashboard's /posts/find-slot answers a zone-less UTC wall time;
      // the public API says the zone, so clients can pass it back as a date.
      expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
      expect(new Date(res.body.date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('cannot delete another workspace\'s channel', async () => {
      const other = await t.api.register({ company: 'Victim Co' });
      const victim = await addChannel((await other.self()).orgId, 'bluesky');
      await t.api.publicApi(key, 'DELETE', `/integrations/${victim.id}`);
      const row = await db().integration.findUniqueOrThrow({ where: { id: victim.id } });
      expect(row.deletedAt).toBeNull();
    });

    it('GET /social/:integration refuses a provider that is not allowed', async () => {
      const res = await t.api.publicApi(key, 'GET', '/social/not-a-provider');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ msg: 'Integration not allowed' });
    });
  });

  describe('posts', () => {
    it('creates a draft, lists it, deletes it (the nightly prod smoke does the same)', async () => {
      t.temporal.reset();
      const created = await t.api.publicApi(key, 'POST', '/posts', draftBody(channel.id));
      expect(created.status).toBe(201);
      expect(created.body).toHaveLength(1);
      const { postId } = created.body[0];

      const row = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(row.state).toBe('DRAFT');
      expect(row.creationMethod).toBe('API');
      expect(row.organizationId).toBe(orgId);
      // A draft never publishes.
      expect(t.temporal.postWorkflows()).toHaveLength(0);

      const list = await t.api.publicApi(
        key,
        'GET',
        `/posts?startDate=${dayjs().toISOString()}&endDate=${dayjs().add(7, 'day').toISOString()}`
      );
      expect(list.status).toBe(200);
      expect(list.body.posts.map((p: any) => p.id)).toContain(postId);

      const del = await t.api.publicApi(key, 'DELETE', `/posts/${postId}`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ success: true, id: postId });
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).deletedAt).not.toBeNull();
    });

    it('records creationMethod CLI when the CLI says so, API otherwise', async () => {
      const cli = await t.api.publicApi(key, 'POST', '/posts', { ...draftBody(channel.id), creationMethod: 'CLI' });
      const forged = await t.api.publicApi(key, 'POST', '/posts', { ...draftBody(channel.id), creationMethod: 'WEB' });
      const rows = await db().post.findMany({
        where: { id: { in: [cli.body[0].postId, forged.body[0].postId] } },
      });
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.creationMethod]));
      expect(byId[cli.body[0].postId]).toBe('CLI');
      expect(byId[forged.body[0].postId]).toBe('API');
    });

    it('schedule: starts the publish workflow', async () => {
      t.temporal.reset();
      const res = await t.api.publicApi(key, 'POST', '/posts', { ...draftBody(channel.id), type: 'schedule' });
      expect(res.status).toBe(201);
      expect(t.temporal.postWorkflows()).toHaveLength(1);
    });

    it('400 with a readable message for an empty post', async () => {
      const res = await t.api.publicApi(key, 'POST', '/posts', draftBody(channel.id, '   '));
      expect(res.status).toBe(400);
      // The create DTO (ValidContent) answers before the per-channel check.
      expect(res.text).toMatch(/content must be a non-empty string|at least one character/);
    });

    it('400 for a channel that is not the workspace\'s', async () => {
      const other = await t.api.register({ company: 'Foreign Channel Co' });
      const foreign = await addChannel((await other.self()).orgId, 'bluesky');
      const res = await t.api.publicApi(key, 'POST', '/posts', draftBody(foreign.id));
      expect(res.status).toBe(400);
      expect(await db().post.count({ where: { integrationId: foreign.id } })).toBe(0);
    });

    it('cannot delete another workspace\'s post', async () => {
      const other = await t.api.register({ company: 'Post Victim Co' });
      const otherOrg = (await other.self()).orgId;
      await givePlan(otherOrg, 'STANDARD');
      const otherKey = await apiKeyOf(otherOrg);
      const otherChannel = await addChannel(otherOrg, 'bluesky');
      const theirs = await t.api.publicApi(otherKey, 'POST', '/posts', draftBody(otherChannel.id));
      const theirId = theirs.body[0].postId;
      const theirGroup = (await db().post.findUniqueOrThrow({ where: { id: theirId } })).group;

      await t.api.publicApi(key, 'DELETE', `/posts/${theirId}`);
      await t.api.publicApi(key, 'DELETE', `/posts/group/${theirGroup}`);
      expect((await db().post.findUniqueOrThrow({ where: { id: theirId } })).deletedAt).toBeNull();
    });

    it('PUT /posts/:id/status moves a draft to the schedule', async () => {
      const created = await t.api.publicApi(key, 'POST', '/posts', draftBody(channel.id));
      const { postId } = created.body[0];
      const res = await t.api.publicApi(key, 'PUT', `/posts/${postId}/status`, { status: 'schedule' });
      expect(res.status).toBe(200);
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).state).toBe('QUEUE');
    });

    it('PUT /posts/:id/settings merges settings without touching content', async () => {
      const x = await addChannel(orgId, 'x');
      const created = await t.api.publicApi(key, 'POST', '/posts', {
        ...draftBody(x.id),
        posts: [{ integration: { id: x.id }, value: [{ content: 'x post', image: [] }], settings: { who_can_reply_post: 'everyone' } }],
      });
      const { postId } = created.body[0];
      const res = await t.api.publicApi(key, 'PUT', `/posts/${postId}/settings`, {
        settings: { who_can_reply_post: 'following' },
      });
      expect(res.status).toBe(200);
      const row = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(JSON.parse(row.settings!)).toMatchObject({ who_can_reply_post: 'following' });
      expect(row.content).toContain('x post');
    });
  });

  describe('media', () => {
    it('POST /upload stores a PNG for the workspace', async () => {
      const form = new FormData();
      form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'pixel.png');
      const res = await t.api.request('POST', '/public/v1/upload', {
        raw: form,
        headers: { authorization: key },
      });
      expect(res.status).toBe(201);
      expect(res.body.path).toBeTruthy();
      const media = await db().media.findFirstOrThrow({ where: { id: res.body.id } });
      expect(media.organizationId).toBe(orgId);
    });

    it('POST /upload refuses a file that is not an allowed type', async () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.from('#!/bin/sh\necho hi\n')], { type: 'image/png' }), 'evil.png');
      const res = await t.api.request('POST', '/public/v1/upload', {
        raw: form,
        headers: { authorization: key },
      });
      expect(res.status).toBe(400);
    });

    it.each([
      ['plain http', 'http://example.com/a.png'],
      ['loopback', 'https://127.0.0.1/a.png'],
      ['localhost', 'https://localhost/a.png'],
      ['cloud metadata', 'https://169.254.169.254/latest/meta-data.png'],
      ['private network', 'https://10.0.0.5/a.png'],
      ['IPv6 loopback', 'https://[::1]/a.png'],
      ['not a URL', 'definitely not a url'],
    ])('POST /upload-from-url refuses %s (SSRF guard)', async (_label, url) => {
      const res = await t.api.publicApi(key, 'POST', '/upload-from-url', { url });
      expect(res.status).toBe(400);
    });
  });

  describe('API key rotation', () => {
    it('a rotated key works and the old one stops working', async () => {
      const rotator = await t.api.register({ company: 'Rotate Co' });
      const rotOrg = (await rotator.self()).orgId;
      await givePlan(rotOrg, 'STANDARD');
      const oldKey = await apiKeyOf(rotOrg);
      expect((await rotator.self()).publicApi).toBe(oldKey);

      const res = await rotator.post('/user/api-key/rotate');
      expect(res.status).toBe(201);
      const newKey = await apiKeyOf(rotOrg);
      expect(newKey).not.toBe(oldKey);

      expect((await t.api.publicApi(oldKey, 'GET', '/is-connected')).status).toBe(401);
      expect((await t.api.publicApi(newKey, 'GET', '/is-connected')).status).toBe(200);
    });

    it('a USER member cannot rotate the key or see it', async () => {
      const { pricing } = await import('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing');
      expect(pricing.PRO.team_members).toBe(true);
      const boss = await t.api.register({ company: 'Boss Co' });
      const bossOrg = (await boss.self()).orgId;
      await givePlan(bossOrg, 'PRO');
      const invite = await boss.post('/settings/team', { role: 'USER', sendEmail: false });
      const member = await t.api.register({
        cookies: { org: inviteTokenFrom(invite.body.url) },
      });
      member.showorg = bossOrg;
      expect((await member.self()).publicApi).toBe('');
      const before = await apiKeyOf(bossOrg);
      const res = await member.post('/user/api-key/rotate');
      expect(res.status).toBe(402);
      expect(await apiKeyOf(bossOrg)).toBe(before);
    });
  });

  it('GET /notifications pages the workspace notifications', async () => {
    const res = await t.api.publicApi(key, 'GET', '/notifications');
    expect(res.status).toBe(200);
  });

  it('GET /users is for workspaces with a super admin only', async () => {
    const res = await t.api.publicApi(key, 'GET', '/users?name=a');
    expect(res.status).toBe(403);
  });
});
