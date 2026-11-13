/**
 * "Remind me to post" end to end on the real backend and Postgres: the
 * composer's payload (POST /posts with remind per channel), the reminder the
 * orchestrator's own PostActivity sends at the scheduled time (what
 * postWorkflowV114 runs; no provider is called), the reminder page's data
 * (GET /posts/:id/reminder, this workspace only), "Mark as posted", the list
 * filters, auto-publish left as it was, and remind-to-post.migration.sql
 * applied twice to a copy of today's production schema.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts remind-to-post
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { TemporalService } from 'nestjs-temporal-core';
import { PostActivity } from '@hookpost/orchestrator/activities/post.activity';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { WebhooksService } from '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { XPostCapService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail } from './setup/api';
import { addChannel, db, disconnectDb, givePlan } from './setup/db';
import { TEST_DATABASE_URL } from './setup/test-env';

const ROOT = join(__dirname, '..', '..');
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const MIGRATION = join(
  ROOT,
  'libraries/nestjs-libraries/src/database/prisma/remind-to-post.migration.sql'
);

const future = (days = 2) => dayjs().add(days, 'day').format('YYYY-MM-DDTHH:mm:00');

describe('remind me to post', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let other: Session;
  let channel: { id: string; name: string };
  let activity: PostActivity;

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ email: uniqueEmail('remind'), company: 'Reminder Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    channel = await addChannel(orgId, 'bluesky', { name: 'Reminder Sky' });

    other = await t.api.register({ email: uniqueEmail('remind-other'), company: 'Someone Else' });
    await givePlan((await other.self()).orgId, 'STANDARD');

    activity = new PostActivity(
      t.get(PostsService),
      t.get(NotificationService),
      t.get(IntegrationManager),
      t.get(IntegrationService),
      t.get(RefreshIntegrationService),
      t.get(WebhooksService),
      t.get(TemporalService),
      t.get(SubscriptionService),
      t.get(XPostCapService)
    );
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });
  beforeEach(() => t.temporal.reset());

  /** The composer's payload (manage.modal.tsx), remind per channel. */
  const create = async (remind?: boolean, type = 'schedule') => {
    const res = await owner.post('/posts', {
      type,
      shortLink: false,
      date: future(),
      tags: [],
      posts: [
        {
          integration: { id: channel.id },
          group: randomUUID().slice(0, 10),
          ...(remind === undefined ? {} : { remind }),
          value: [
            {
              content: '<p>Sunset reel</p><p>#travel</p>',
              image: [{ id: 'm1', path: 'https://media.example/reel.mp4' }],
            },
            { content: '<p>link in bio</p>', image: [] },
          ],
          settings: {},
        },
      ],
    });
    expect(res.status).toBe(201);
    return res.body[0].postId as string;
  };

  it('saves remind with the post and starts the V114 workflow, as for any post', async () => {
    const id = await create(true);
    const post = await db().post.findUniqueOrThrow({ where: { id } });
    expect(post.remind).toBe(true);
    expect(post.state).toBe('QUEUE');
    const [wf] = t.temporal.postWorkflows();
    expect(wf.workflow).toBe('postWorkflowV114');
  });

  it('auto-publish is the default: no remind field (public API, MCP) saves remind false', async () => {
    const id = await create(undefined);
    const post = await db().post.findUniqueOrThrow({ where: { id } });
    expect(post.remind).toBe(false);
  });

  it('a post that is not set to remind never gets a reminder and is left QUEUE for the publisher', async () => {
    const id = await create(false);
    await expect(activity.sendPostReminder(orgId, id)).resolves.toBe(false);
    const post = await db().post.findUniqueOrThrow({ where: { id } });
    expect(post.state).toBe('QUEUE');
    expect(t.temporal.emails()).toHaveLength(0);
  });

  it('at the scheduled time: one email per member with caption, file and page; never sent twice', async () => {
    const id = await create(true);
    const network = jest.spyOn(t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('bluesky'), 'post');

    await expect(activity.sendPostReminder(orgId, id)).resolves.toBe(true);
    await expect(activity.sendPostReminder(orgId, id)).resolves.toBe(false);

    expect(network).not.toHaveBeenCalled();
    const post = await db().post.findUniqueOrThrow({ where: { id } });
    expect(post.state).toBe('REMINDER_SENT');
    expect(post.releaseURL).toBeNull();

    const emails = t.temporal.emails();
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe(owner.email);
    expect(emails[0].subject).toBe('Time to post on Bluesky: Reminder Sky');
    expect(emails[0].html).toContain('Sunset reel');
    expect(emails[0].html).toContain('link in bio');
    expect(emails[0].html).toContain('href="https://media.example/reel.mp4"');
    expect(emails[0].html).toContain(`/reminder/${id}`);

    // it still counts against the monthly post limit, like a publish
    // (comments are counted as posts, as when they are created)
    const counted = await t
      .get<PostsService>(PostsService)
      .countPostsFromDay(orgId, dayjs().startOf('day').toDate());
    const ids = (
      await db().post.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { id: true },
      })
    ).length;
    expect(counted).toBe(ids);

    const notifications = await db().notifications.findMany({ where: { organizationId: orgId } });
    expect(notifications.some((n) => n.content.includes(`/reminder/${id}`))).toBe(true);
  });

  it('the reminder page data is for this workspace only', async () => {
    const id = await create(true);
    const mine = await owner.get(`/posts/${id}/reminder`);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      id,
      remind: true,
      platform: 'Bluesky',
      comments: ['link in bio'],
      media: [{ url: 'https://media.example/reel.mp4', video: true }],
    });
    expect(mine.body.caption).toContain('Sunset reel');
    expect(JSON.stringify(mine.body)).not.toContain('fake-token');

    const theirs = await other.get(`/posts/${id}/reminder`);
    expect(theirs.status).toBe(404);
    expect(theirs.text).not.toContain('Sunset reel');

    const anonymous = await t.api.request('GET', `/posts/${id}/reminder`);
    expect(anonymous.status).toBe(401);
  });

  it('"Mark as posted": POSTED_MANUALLY, listed, and only for the owner workspace', async () => {
    const id = await create(true);
    await activity.sendPostReminder(orgId, id);

    const theirs = await other.post(`/posts/${id}/posted-manually`);
    expect(theirs.status).toBe(404);
    expect((await db().post.findUniqueOrThrow({ where: { id } })).state).toBe('REMINDER_SENT');

    const mine = await owner.post(`/posts/${id}/posted-manually`);
    expect([200, 201]).toContain(mine.status);
    expect((await db().post.findUniqueOrThrow({ where: { id } })).state).toBe('POSTED_MANUALLY');

    // twice is harmless
    expect([200, 201]).toContain((await owner.post(`/posts/${id}/posted-manually`)).status);

    // the All and Published list tabs show it; Scheduled does not
    const all = await owner.get('/posts/list?state=all&limit=100');
    expect(JSON.stringify(all.body)).toContain(id);
    const published = await owner.get('/posts/list?state=published&limit=100');
    expect(JSON.stringify(published.body)).toContain(id);
    const scheduled = await owner.get('/posts/list?state=scheduled&limit=100');
    expect(JSON.stringify(scheduled.body)).not.toContain(id);
  });

  it('posted early (before the reminder): the reminder is then not sent', async () => {
    const id = await create(true);
    expect([200, 201]).toContain((await owner.post(`/posts/${id}/posted-manually`)).status);
    await expect(activity.sendPostReminder(orgId, id)).resolves.toBe(false);
    expect(t.temporal.emails()).toHaveLength(0);
  });

  it('refuses "Mark as posted" on an auto-publish post', async () => {
    const id = await create(false);
    const res = await owner.post(`/posts/${id}/posted-manually`);
    expect(res.status).toBe(400);
    expect((await db().post.findUniqueOrThrow({ where: { id } })).state).toBe('QUEUE');
  });
});

describe('remind-to-post.migration.sql', () => {
  const PG_SCHEMA = 'remind_to_post_migration_check';
  const withSchema = (url: string, schema: string) => {
    const u = new URL(url);
    u.searchParams.set('schema', schema);
    return u.toString();
  };
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  beforeAll(async () => {
    // Today's production schema: schema.prisma without the column and states
    const now = readFileSync(SCHEMA, 'utf8');
    const before = now
      .replace(/\n  remind\s+Boolean\s+@default\(false\)/, '')
      .replace(/\n  REMINDER_SENT/, '')
      .replace(/\n  POSTED_MANUALLY/, '');
    expect(before).not.toMatch(/REMINDER_SENT|POSTED_MANUALLY|\n  remind /);
    const beforeFile = join(mkdtempSync(join(tmpdir(), 'remind-migration-')), 'before.prisma');
    writeFileSync(beforeFile, before);
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe(
      `INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES ('org-before', 'Existing', now())`
    );
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

  const apply = () =>
    execFileSync('psql', [TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
      env: { ...process.env, PGOPTIONS: `-c search_path=${PG_SCHEMA}` },
      stdio: 'pipe',
    });

  const diff = () => {
    try {
      execFileSync(PRISMA, ['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', SCHEMA, '--exit-code'], {
        env: { ...process.env, DATABASE_URL: url },
        stdio: 'pipe',
      });
      return 0;
    } catch (e: any) {
      return e.status;
    }
  };

  it('applies twice cleanly, and leaves the database exactly as schema.prisma says', async () => {
    expect(diff()).toBe(2);
    apply();
    apply();
    expect(diff()).toBe(0);
    const rows = await client.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "${PG_SCHEMA}"."Organization"`);
    expect(rows.map((r) => r.id)).toEqual(['org-before']);
  }, 120_000);
});
