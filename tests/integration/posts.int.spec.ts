/**
 * The composer's core actions through POST /posts and friends: save a draft,
 * add to the calendar (schedule), post now, update, change the date, delete,
 * plus server-side validation, multi-channel saves, tags, the monthly post
 * meter and org scoping (another workspace can never read or change a post).
 *
 * Channels are seeded rows (no network). Publishing is Temporal's job; here we
 * assert that the right workflow was started, on the right queue, for the
 * right post (FakeTemporal).
 */
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { randomUUID } from 'crypto';
import { expandPosts } from '@hookpost/helpers/utils/posts.list.minify';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan } from './setup/db';

dayjs.extend(utc);

const future = (days = 2) => dayjs().add(days, 'day').format('YYYY-MM-DDTHH:mm:00');

const postBody = (
  integrationId: string | string[],
  overrides: Partial<{ type: string; date: string; content: string; tags: any[]; settings: any }> = {},
  // The composer sends one group for every channel of a post (manage.modal.tsx).
  group = randomUUID().slice(0, 10)
) => ({
  type: overrides.type ?? 'schedule',
  shortLink: false,
  date: overrides.date ?? future(),
  tags: overrides.tags ?? [],
  posts: (Array.isArray(integrationId) ? integrationId : [integrationId]).map((id) => ({
    integration: { id },
    group,
    value: [{ content: overrides.content ?? '<p>Hello from the integration suite</p>', image: [] }],
    settings: overrides.settings ?? {},
  })),
});

describe('posts: composer actions', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let bluesky: { id: string };
  let threads: { id: string };

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ company: 'Posts Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    bluesky = await addChannel(orgId, 'bluesky');
    threads = await addChannel(orgId, 'threads');
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });
  beforeEach(() => t.temporal.reset());

  describe('create', () => {
    it('schedule: saves a QUEUE post and starts its publish workflow on the provider queue', async () => {
      const res = await owner.post('/posts', postBody(bluesky.id));
      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(1);
      const { postId, integration } = res.body[0];
      expect(integration).toBe(bluesky.id);

      const post = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(post.state).toBe('QUEUE');
      expect(post.organizationId).toBe(orgId);
      expect(post.creationMethod).toBe('WEB');
      expect(post.content).toContain('Hello from the integration suite');

      const [wf] = t.temporal.postWorkflows();
      expect(wf.workflow).toBe('postWorkflowV114');
      expect(wf.options.workflowId).toBe(`post_${postId}`);
      expect(wf.options.taskQueue).toBe('main');
      expect(wf.options.args[0]).toEqual({
        taskQueue: 'bluesky',
        postId,
        organizationId: orgId,
      });
    });

    it('draft: saves a DRAFT post and starts no workflow', async () => {
      const res = await owner.post('/posts', postBody(bluesky.id, { type: 'draft' }));
      expect(res.status).toBe(201);
      const post = await db().post.findUniqueOrThrow({ where: { id: res.body[0].postId } });
      expect(post.state).toBe('DRAFT');
      expect(t.temporal.postWorkflows()).toHaveLength(0);
    });

    it('now: publishes at the current minute', async () => {
      const res = await owner.post('/posts', postBody(bluesky.id, { type: 'now', date: future(10) }));
      expect(res.status).toBe(201);
      const post = await db().post.findUniqueOrThrow({ where: { id: res.body[0].postId } });
      expect(Math.abs(dayjs(post.publishDate).diff(dayjs(), 'minute'))).toBeLessThanOrEqual(1);
      expect(t.temporal.postWorkflows()).toHaveLength(1);
    });

    it('several channels in one request: one post and one workflow per channel', async () => {
      const res = await owner.post('/posts', postBody([bluesky.id, threads.id]));
      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(2);
      const posts = await db().post.findMany({
        where: { id: { in: res.body.map((p: any) => p.postId) } },
      });
      expect(posts.map((p) => p.integrationId).sort()).toEqual([bluesky.id, threads.id].sort());
      // Each channel's post gets its own group on save (posts.repository.ts
      // createOrUpdatePost rotates it unless keepGroup is set).
      expect(t.temporal.postWorkflows().map((w) => w.options.args[0].taskQueue).sort()).toEqual([
        'bluesky',
        'threads',
      ]);
    });

    it('a post is saved even when its workflow cannot be started', async () => {
      const start = t.temporal.rawClient.workflow.start;
      t.temporal.rawClient.workflow.start = async () => {
        throw new Error('temporal is down');
      };
      try {
        const res = await owner.post('/posts', postBody(bluesky.id));
        expect(res.status).toBe(201);
        expect(await db().post.count({ where: { id: res.body[0].postId } })).toBe(1);
      } finally {
        t.temporal.rawClient.workflow.start = start;
      }
    });
  });

  describe('server-side validation', () => {
    it('refuses empty content, even for a draft', async () => {
      const res = await owner.post('/posts', postBody(bluesky.id, { type: 'draft', content: '<p>   </p>' }));
      expect(res.status).toBe(400);
      expect(res.text).toMatch(/at least one character/);
    });

    it('refuses a post longer than the network allows, but keeps it as a draft', async () => {
      const long = `<p>${'a'.repeat(400)}</p>`; // Bluesky allows 300
      const scheduled = await owner.post('/posts', postBody(bluesky.id, { content: long }));
      expect(scheduled.status).toBe(400);
      expect(scheduled.text).toMatch(/too long/);
      const draft = await owner.post('/posts', postBody(bluesky.id, { type: 'draft', content: long }));
      expect(draft.status).toBe(201);
    });

    it('refuses a channel id that does not exist', async () => {
      const res = await owner.post('/posts', postBody('no-such-channel'));
      expect(res.status).toBe(400);
    });

    it('refuses invalid provider settings when scheduling (X needs who_can_reply_post)', async () => {
      const x = await addChannel(orgId, 'x');
      const res = await owner.post('/posts', postBody(x.id, { settings: {} }));
      expect(res.status).toBe(400);
      const ok = await owner.post(
        '/posts',
        postBody(x.id, { settings: { who_can_reply_post: 'everyone' } })
      );
      expect(ok.status).toBe(201);
    });

    it('POST /posts/valid reports per channel without saving', async () => {
      const before = await db().post.count({ where: { organizationId: orgId } });
      const res = await owner.post('/posts/valid', {
        posts: [{ integration: { id: bluesky.id }, value: [{ content: '<p>ok</p>', image: [] }], settings: {} }],
      });
      expect(res.status).toBe(201);
      expect(res.body[0]).toMatchObject({ valid: true, errors: true, tooLong: false, emptyContent: false });
      expect(await db().post.count({ where: { organizationId: orgId } })).toBe(before);
    });
  });

  describe('read, move, delete', () => {
    it('lists the week, opens one post, moves it, deletes its group', async () => {
      const date = future(3);
      const created = await owner.post('/posts', postBody(bluesky.id, { date }));
      const { postId } = created.body[0];

      const list = await owner.get(
        `/posts?startDate=${dayjs().toISOString()}&endDate=${dayjs().add(7, 'day').toISOString()}`
      );
      expect(list.status).toBe(200);
      // The calendar response is minified (posts.list.minify.ts).
      const listed = expandPosts(list.body).posts.find((p: any) => p.id === postId);
      expect(listed).toBeDefined();

      const one = await owner.get(`/posts/${postId}`);
      expect(one.status).toBe(200);
      expect(JSON.stringify(one.body)).toContain('Hello from the integration suite');

      const newDate = future(5);
      const moved = await owner.put(`/posts/${postId}/date`, { date: newDate, action: 'update' });
      expect(moved.status).toBe(200);
      const after = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(dayjs(after.publishDate).format('YYYY-MM-DDTHH:mm')).toBe(dayjs(newDate).format('YYYY-MM-DDTHH:mm'));

      const del = await owner.delete(`/posts/${after.group}`);
      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ success: true, id: postId });
      const deleted = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(deleted.deletedAt).not.toBeNull();
    });

    it('GET /posts/find-slot returns a free future time', async () => {
      const res = await owner.get('/posts/find-slot');
      expect(res.status).toBe(200);
      // UTC wall time without a zone, e.g. 2026-10-22T06:40:00.
      expect(res.body.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
      expect(dayjs.utc(res.body.date).isAfter(dayjs.utc().subtract(1, 'minute'))).toBe(true);
    });

    // Sunday 25 Oct 2026, 15:30 UTC (21:00 IST): the day's posting times,
    // 02:00, 06:40 and 11:40 UTC by default, have all gone, so the next free
    // one is Monday's first, in the next calendar week. The calendar has to
    // follow the new post there (calendar.helpers rangeShowingPost, E2E
    // app.spec.ts).
    it('GET /posts/find-slot on a Sunday after its last posting time answers Monday 02:00 UTC', async () => {
      const sunday = await t.api.register({ company: 'Sunday Slot Co' });
      const sundayOrg = (await sunday.self()).orgId;
      await givePlan(sundayOrg, 'STANDARD');
      await addChannel(sundayOrg, 'bluesky');
      // Only Date is pinned; it runs on from there. Timers stay real for the
      // HTTP server, Prisma and Redis.
      jest.useFakeTimers({
        now: new Date('2026-10-25T15:30:00Z'),
        advanceTimers: true,
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'requestAnimationFrame',
          'cancelAnimationFrame',
          'requestIdleCallback',
          'cancelIdleCallback',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      try {
        const res = await sunday.get('/posts/find-slot');
        expect(res.status).toBe(200);
        expect(res.body.date).toBe('2026-10-26T02:00:00');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('tags', () => {
    it('creates, renames and deletes a tag', async () => {
      const created = await owner.post('/posts/tags', { name: 'Launch', color: '#ff0000' });
      expect(created.status).toBe(201);
      const id = created.body.id;
      const edited = await owner.put(`/posts/tags/${id}`, { name: 'Launch day', color: '#00ff00' });
      expect(edited.status).toBe(200);
      const list = await owner.get('/posts/tags');
      expect(JSON.stringify(list.body)).toContain('Launch day');
      const del = await owner.delete(`/posts/tags/${id}`);
      expect(del.status).toBe(200);
    });
  });

  describe('another workspace (IDOR)', () => {
    let intruder: Session;
    let postId: string;
    let group: string;
    let tagId: string;

    beforeAll(async () => {
      intruder = await t.api.register({ company: 'Intruder Co' });
      await givePlan((await intruder.self()).orgId, 'STANDARD');
      const created = await owner.post('/posts', postBody(bluesky.id));
      postId = created.body[0].postId;
      group = (await db().post.findUniqueOrThrow({ where: { id: postId } })).group;
      tagId = (await owner.post('/posts/tags', { name: 'Private', color: '#123456' })).body.id;
    });

    it('cannot read the post', async () => {
      const res = await intruder.get(`/posts/${postId}`);
      expect(JSON.stringify(res.body ?? '')).not.toContain('Hello from the integration suite');
    });

    it('cannot read the group', async () => {
      const res = await intruder.get(`/posts/group/${group}`);
      expect(JSON.stringify(res.body ?? '')).not.toContain('Hello from the integration suite');
    });

    it('cannot delete the group', async () => {
      await intruder.delete(`/posts/${group}`);
      const post = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(post.deletedAt).toBeNull();
    });

    it('cannot move the post', async () => {
      const before = await db().post.findUniqueOrThrow({ where: { id: postId } });
      await intruder.put(`/posts/${postId}/date`, { date: future(9), action: 'schedule' });
      const after = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(after.publishDate.toISOString()).toBe(before.publishDate.toISOString());
    });

    it('cannot post to the channel', async () => {
      const res = await intruder.post('/posts', postBody(bluesky.id));
      expect(res.status).toBe(400);
    });

    it('cannot rename or delete the tag', async () => {
      const edit = await intruder.put(`/posts/tags/${tagId}`, { name: 'pwned', color: '#000000' });
      expect(edit.status).toBe(404);
      const del = await intruder.delete(`/posts/tags/${tagId}`);
      expect(del.status).toBe(404);
      const tag = await db().tags.findUniqueOrThrow({ where: { id: tagId } });
      expect(tag.name).toBe('Private');
      expect(tag.deletedAt).toBeNull();
    });
  });

  describe('posts per month (plan meter)', () => {
    it('a Free workspace is refused its 31st post of the month with 402', async () => {
      const free = await t.api.register({ company: 'Free Meter Co' });
      const freeOrg = (await free.self()).orgId;
      const channel = await addChannel(freeOrg, 'bluesky');
      // 30 posts this month, the Free plan's allowance.
      await db().post.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
          organizationId: freeOrg,
          integrationId: channel.id,
          content: `seeded ${i}`,
          group: `seed-${freeOrg}-${i}`,
          publishDate: new Date(),
          state: 'PUBLISHED' as const,
        })),
      });
      const res = await free.post('/posts', postBody(channel.id));
      expect(res.status).toBe(402);
      expect(res.body.url).toBe('http://localhost:4200/billing');
    });
  });
});
