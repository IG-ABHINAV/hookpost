/**
 * Everything a workspace keeps besides posts and channels: media library,
 * outgoing webhooks (plan limit 0/2/10/30 and the SSRF guard on their URL),
 * signatures, sets (post templates), RSS autopost, notifications and the
 * shortlink and email preferences. Each is created by its owner and checked
 * against a second workspace that tries to read, change or delete it by id.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan } from './setup/db';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex'
);
// A public address written as a literal, so the SSRF guard accepts it without
// a DNS lookup. Nothing is ever sent to it by these tests.
const PUBLIC_URL = 'https://93.184.215.14/hook';
const PUBLIC_FEED = 'https://93.184.215.14/feed.xml';

describe('workspace resources', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let intruder: Session;

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ company: 'Resources Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    intruder = await t.api.register({ company: 'Resources Intruder' });
    await givePlan((await intruder.self()).orgId, 'STANDARD');
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  describe('media library', () => {
    async function upload(session: Session, name = 'pixel.png', bytes = PNG_1X1) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'image/png' }), name);
      return session.request('POST', '/media/upload-simple', { raw: form });
    }

    it('uploads an image, lists it, deletes it', async () => {
      const up = await upload(owner, 'library.png');
      expect(up.status).toBe(201);
      expect(up.body).toMatchObject({ originalName: 'library.png' });
      expect((await db().media.findUniqueOrThrow({ where: { id: up.body.id } })).organizationId).toBe(orgId);

      const list = await owner.get('/media?page=1');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(up.body.id);

      const search = await owner.get('/media?page=1&search=LIBRARY');
      expect(JSON.stringify(search.body)).toContain(up.body.id);

      const del = await owner.delete(`/media/${up.body.id}`);
      expect(del.status).toBe(200);
      const list2 = await owner.get('/media?page=1');
      expect(JSON.stringify(list2.body)).not.toContain(up.body.id);
    });

    it('preventSave uploads the file without adding it to the library', async () => {
      const form = new FormData();
      form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'temp.png');
      form.append('preventSave', 'true');
      const res = await owner.request('POST', '/media/upload-simple', { raw: form });
      expect(res.status).toBe(201);
      expect(Object.keys(res.body)).toEqual(['path']);
    });

    it('refuses a file whose bytes are not an allowed type', async () => {
      const res = await upload(owner, 'fake.png', Buffer.from('<?php echo 1; ?>'));
      expect(res.status).toBe(400);
    });

    it('another workspace cannot list, delete or relabel the file', async () => {
      const up = await upload(owner, 'private.png');
      const theirList = await intruder.get('/media?page=1');
      expect(JSON.stringify(theirList.body)).not.toContain(up.body.id);

      await intruder.delete(`/media/${up.body.id}`);
      await intruder.post('/media/information', { id: up.body.id, alt: 'pwned', thumbnail: '' });
      const row = await db().media.findUniqueOrThrow({ where: { id: up.body.id } });
      expect(row.deletedAt).toBeNull();
      expect(row.alt).not.toBe('pwned');
    });
  });

  describe('webhooks', () => {
    it('the published limits', () => {
      expect([pricing.FREE.webhooks, pricing.STANDARD.webhooks, pricing.PRO.webhooks]).toEqual([0, 2, 30]);
    });

    it('Standard: creates two, the third is refused (402)', async () => {
      const s = await t.api.register({ company: 'Webhook Limit Co' });
      const sOrg = (await s.self()).orgId;
      await givePlan(sOrg, 'STANDARD');
      for (let i = 0; i < 2; i++) {
        const res = await s.post('/webhooks', { name: `hook ${i}`, url: PUBLIC_URL, integrations: [] });
        expect(res.status).toBe(201);
      }
      const third = await s.post('/webhooks', { name: 'hook 3', url: PUBLIC_URL, integrations: [] });
      expect(third.status).toBe(402);
      expect(await db().webhooks.count({ where: { organizationId: sOrg, deletedAt: null } })).toBe(2);
    });

    it('Free: no webhooks', async () => {
      const free = await t.api.register({ company: 'Webhook Free Co' });
      const res = await free.post('/webhooks', { name: 'nope', url: PUBLIC_URL, integrations: [] });
      expect(res.status).toBe(402);
    });

    // PUT /webhooks has no plan check of its own (POST makes it), so it only
    // changes a webhook that exists. Until 22 Oct 2026 it upserted, and an
    // unknown id created a webhook on any plan.
    it('PUT /webhooks with an unknown id is a 404 and creates nothing (Free, limit 0)', async () => {
      const free = await t.api.register({ company: 'Webhook Bypass Co' });
      const freeOrg = (await free.self()).orgId;
      const res = await free.put('/webhooks', { id: 'not-an-existing-id', name: 'bypass', url: PUBLIC_URL, integrations: [] });
      expect(res.status).toBe(404);
      expect(await db().webhooks.count({ where: { organizationId: freeOrg, deletedAt: null } })).toBe(0);
    });

    it('PUT /webhooks with an unknown id on a full Standard workspace adds no third', async () => {
      const s = await t.api.register({ company: 'Webhook Full Co' });
      const sOrg = (await s.self()).orgId;
      await givePlan(sOrg, 'STANDARD');
      for (let i = 0; i < 2; i++) {
        expect((await s.post('/webhooks', { name: `hook ${i}`, url: PUBLIC_URL, integrations: [] })).status).toBe(201);
      }
      const res = await s.put('/webhooks', { id: 'brand-new-id', name: 'third', url: PUBLIC_URL, integrations: [] });
      expect(res.status).toBe(404);
      expect(await db().webhooks.count({ where: { organizationId: sOrg, deletedAt: null } })).toBe(2);
    });

    it('PUT /webhooks still renames an existing webhook, and not another workspace\'s', async () => {
      const s = await t.api.register({ company: 'Webhook Edit Co' });
      const sOrg = (await s.self()).orgId;
      await givePlan(sOrg, 'STANDARD');
      const created = await s.post('/webhooks', { name: 'before', url: PUBLIC_URL, integrations: [] });
      const id = created.body.id;
      const res = await s.put('/webhooks', { id, name: 'after', url: PUBLIC_URL, integrations: [] });
      expect(res.status).toBe(200);
      expect((await db().webhooks.findUniqueOrThrow({ where: { id } })).name).toBe('after');

      const other = await t.api.register({ company: 'Webhook Other Co' });
      const theirs = await other.put('/webhooks', { id, name: 'hijack', url: PUBLIC_URL, integrations: [] });
      expect(theirs.status).toBe(404);
      expect((await db().webhooks.findUniqueOrThrow({ where: { id } })).name).toBe('after');
    });

    it.each([
      ['plain http', 'http://93.184.215.14/hook'],
      ['loopback', 'https://127.0.0.1/hook'],
      ['cloud metadata', 'https://169.254.169.254/latest'],
      ['private network', 'https://192.168.1.10/hook'],
      ['localhost', 'https://localhost/hook'],
    ])('refuses a %s URL', async (_label, url) => {
      const res = await owner.post('/webhooks', { name: 'bad', url, integrations: [] });
      expect(res.status).toBe(400);
    });

    it('is scoped: another workspace cannot see, rename or delete it', async () => {
      const channel = await addChannel(orgId, 'bluesky');
      const created = await owner.post('/webhooks', {
        name: 'mine',
        url: PUBLIC_URL,
        integrations: [{ id: channel.id }],
      });
      expect(created.status).toBe(201);
      const id = created.body.id;

      const theirs = await intruder.get('/webhooks');
      expect(JSON.stringify(theirs.body)).not.toContain(id);

      await intruder.put('/webhooks', { id, name: 'pwned', url: PUBLIC_URL, integrations: [] });
      await intruder.delete(`/webhooks/${id}`);
      const row = await db().webhooks.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe('mine');
      expect(row.organizationId).toBe(orgId);
      expect(row.deletedAt).toBeNull();

      const mine = await owner.get('/webhooks');
      const listed = mine.body.find((w: any) => w.id === id);
      expect(listed.integrations[0].integration.id).toBe(channel.id);

      expect((await owner.delete(`/webhooks/${id}`)).status).toBe(200);
      expect((await db().webhooks.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
    });

    it('POST /webhooks/send refuses an internal URL', async () => {
      const res = await owner.post('/webhooks/send?url=' + encodeURIComponent('https://127.0.0.1/x'), { a: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe('signatures', () => {
    it('create, make default, update, delete; another workspace sees none of it', async () => {
      const a = await owner.post('/signatures', { content: '<p>-- Sent with Hookpost</p>', autoAdd: true });
      expect(a.status).toBe(201);
      const def = await owner.get('/signatures/default');
      expect(def.body.content).toContain('Sent with Hookpost');

      const b = await owner.post('/signatures', { content: '<p>Second</p>', autoAdd: true });
      // Only one signature is added automatically.
      const rows = await db().signatures.findMany({ where: { organizationId: orgId, deletedAt: null } });
      expect(rows.filter((r) => r.autoAdd)).toHaveLength(1);

      const upd = await owner.put(`/signatures/${a.body.id}`, { content: '<p>Edited</p>', autoAdd: false });
      expect(upd.status).toBe(200);

      expect(JSON.stringify((await intruder.get('/signatures')).body)).not.toContain('Edited');
      await intruder.put(`/signatures/${a.body.id}`, { content: '<p>pwned</p>', autoAdd: false });
      await intruder.delete(`/signatures/${b.body.id}`);
      const after = await db().signatures.findMany({ where: { organizationId: orgId } });
      expect(after.map((r) => r.content)).not.toContain('<p>pwned</p>');
      expect(after.find((r) => r.id === b.body.id)?.deletedAt).toBeNull();

      expect((await owner.delete(`/signatures/${b.body.id}`)).status).toBe(200);
    });
  });

  describe('sets (post templates)', () => {
    it('create, update, delete; another workspace cannot touch them', async () => {
      const created = await owner.post('/sets', { name: 'Weekly tip', content: '{"posts":[]}' });
      expect(created.status).toBe(201);
      const id = created.body.id;

      expect((await owner.put('/sets', { id, name: 'Weekly tip v2', content: '{"posts":[]}' })).status).toBe(200);
      expect(JSON.stringify((await owner.get('/sets')).body)).toContain('Weekly tip v2');

      expect(JSON.stringify((await intruder.get('/sets')).body)).not.toContain(id);
      await intruder.put('/sets', { id, name: 'pwned', content: '{}' });
      await intruder.delete(`/sets/${id}`);
      const row = await db().sets.findUniqueOrThrow({ where: { id } });
      expect(row.name).toBe('Weekly tip v2');
      expect(row.organizationId).toBe(orgId);

      // Sets are deleted for good, not soft-deleted.
      expect((await owner.delete(`/sets/${id}`)).status).toBe(200);
      expect(await db().sets.count({ where: { id } })).toBe(0);
    });
  });

  describe('RSS autopost', () => {
    // lastUrl is optional in AutopostDto but required by the table; the
    // dashboard always sends it (the last item it previewed).
    const autopost = (overrides: Record<string, unknown> = {}) => ({
      title: 'Blog feed',
      lastUrl: 'https://93.184.215.14/posts/1',
      onSlot: true,
      syncLast: false,
      url: PUBLIC_FEED,
      active: false,
      addPicture: false,
      generateContent: false,
      integrations: [],
      ...overrides,
    });

    it('Free (no webhooks, no autopost) is refused (402)', async () => {
      const free = await t.api.register({ company: 'Autopost Free Co' });
      const res = await free.post('/autopost', autopost());
      expect(res.status).toBe(402);
    });

    // pricing.ts says Standard has no autopost (autoPost: false) and the
    // settings tab hides it. Until 22 Oct 2026 POST /autopost was gated on the
    // webhook allowance, which Standard has (2), so the API accepted it.
    it('Standard (autoPost: false) is refused an RSS autopost (402)', async () => {
      expect(pricing.STANDARD.autoPost).toBe(false);
      const res = await owner.post('/autopost', autopost());
      expect(res.status).toBe(402);
      expect(res.body.message).toMatch(/autopost/i);
      expect(await db().autoPost.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('Pro: create, pause, delete; scoped to the workspace', async () => {
      const pro = await t.api.register({ company: 'Autopost Pro Co' });
      const proOrg = (await pro.self()).orgId;
      await givePlan(proOrg, 'PRO');
      const created = await pro.post('/autopost', autopost({ active: true }));
      expect(created.status).toBe(201);
      const id = created.body.id;
      expect(t.temporal.started.some((s) => s.workflow === 'autoPostWorkflow' && s.options.workflowId === `autopost-${id}`)).toBe(true);

      expect((await pro.post(`/autopost/${id}/active`, { active: false })).status).toBe(201);
      expect((await db().autoPost.findUniqueOrThrow({ where: { id } })).active).toBe(false);

      await intruder.post(`/autopost/${id}/active`, { active: true });
      await intruder.delete(`/autopost/${id}`);
      const row = await db().autoPost.findUniqueOrThrow({ where: { id } });
      expect(row.active).toBe(false);
      expect(row.deletedAt).toBeNull();

      expect((await pro.delete(`/autopost/${id}`)).status).toBe(200);
    });

    it('refuses an internal feed URL', async () => {
      const pro = await t.api.register({ company: 'Autopost SSRF Co' });
      await givePlan((await pro.self()).orgId, 'PRO');
      const res = await pro.post('/autopost', autopost({ url: 'https://169.254.169.254/feed.xml' }));
      expect(res.status).toBe(400);
    });

    // PUT /autopost/:id only changes an autopost that exists (POST makes the
    // plan check). Until 22 Oct 2026 it upserted, so an unknown id created one.
    it('PUT /autopost/:id with an unknown id is a 404 and creates nothing', async () => {
      const s = await t.api.register({ company: 'Autopost Bypass Co' });
      const sOrg = (await s.self()).orgId;
      await givePlan(sOrg, 'STANDARD');
      const res = await s.put('/autopost/brand-new-id', autopost());
      expect(res.status).toBe(404);
      expect(await db().autoPost.count({ where: { organizationId: sOrg } })).toBe(0);
    });

    it('PUT /autopost/:id still edits your own autopost, and not another workspace\'s', async () => {
      const pro = await t.api.register({ company: 'Autopost Edit Co' });
      await givePlan((await pro.self()).orgId, 'PRO');
      const { id } = (await pro.post('/autopost', autopost())).body;
      const res = await pro.put(`/autopost/${id}`, autopost({ title: 'Renamed feed' }));
      expect(res.status).toBe(200);
      expect((await db().autoPost.findUniqueOrThrow({ where: { id } })).title).toBe('Renamed feed');

      const other = await t.api.register({ company: 'Autopost Other Co' });
      await givePlan((await other.self()).orgId, 'PRO');
      expect((await other.put(`/autopost/${id}`, autopost({ title: 'hijack' }))).status).toBe(404);
      expect((await db().autoPost.findUniqueOrThrow({ where: { id } })).title).toBe('Renamed feed');
    });
  });

  describe('preferences and notifications', () => {
    it('shortlink preference: ADMIN can change it', async () => {
      const get = await owner.get('/settings/shortlink');
      expect(get.status).toBe(200);
      const set = await owner.post('/settings/shortlink', { shortlink: 'NO' });
      expect(set.status).toBe(201);
      expect((await db().organization.findUniqueOrThrow({ where: { id: orgId } })).shortlink).toBe('NO');
    });

    it('email notification preferences round-trip', async () => {
      const before = await owner.get('/user/email-notifications');
      expect(before.status).toBe(200);
      const set = await owner.post('/user/email-notifications', {
        sendSuccessEmails: false,
        sendFailureEmails: true,
        sendStreakEmails: false,
      });
      expect(set.status).toBe(201);
      const after = await owner.get('/user/email-notifications');
      expect(after.body).toMatchObject({ sendSuccessEmails: false, sendFailureEmails: true, sendStreakEmails: false });
    });

    it('notifications bell: list and unread count', async () => {
      await db().notifications.create({ data: { organizationId: orgId, content: 'Your post was published' } });
      const count = await owner.get('/notifications');
      expect(count.status).toBe(200);
      const list = await owner.get('/notifications/list');
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain('Your post was published');
      expect(JSON.stringify((await intruder.get('/notifications/list')).body)).not.toContain(
        'Your post was published'
      );
    });

    it('personal information round-trip', async () => {
      const res = await owner.post('/user/personal', { fullname: 'Test Owner', bio: 'Testing' });
      expect(res.status).toBe(201);
      const get = await owner.get('/user/personal');
      expect(get.status).toBe(200);
    });
  });
});
