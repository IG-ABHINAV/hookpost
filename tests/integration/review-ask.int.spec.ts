/**
 * The in-app review card's server side (GET/POST /user/review-ask,
 * ReviewAskService, review.ask.policy.ts) against real rows: posts made
 * through POST /posts and published by the orchestrator's own PostActivity
 * (only the network call is stubbed), plans as the webhooks leave them,
 * teams, impersonation, the 60-day cap and the claim race. Then
 * review-ask.migration.sql applied twice to a copy of the schema.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts review-ask
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import dayjs from 'dayjs';
import { PrismaClient } from '@prisma/client';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { startApp, TestApp } from './setup/app';
import { Session, uniqueEmail } from './setup/api';
import { addChannel, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { publishLikeTheWorkflow } from './setup/publish';
import { TEST_DATABASE_URL } from './setup/test-env';

const DAY = 24 * 60 * 60 * 1000;
const ROOT = join(__dirname, '..', '..');
const PRISMA = join(ROOT, 'node_modules', '.bin', 'prisma');
const SCHEMA = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma');
const MIGRATION = join(ROOT, 'libraries/nestjs-libraries/src/database/prisma/review-ask.migration.sql');

describe('review card: GET/POST /user/review-ask', () => {
  let t: TestApp;
  const savedExempt = process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;

  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    if (savedExempt === undefined) delete process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS;
    else process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = savedExempt;
    await t?.close();
    await disconnectDb();
  });

  const provider = (id: string): any =>
    t.get<IntegrationManager>(IntegrationManager).getSocialIntegration(id);

  /** The network's answer to a publish: success, or a refusal (ERROR). */
  const network = (outcome: 'ok' | 'fail' = 'ok') => {
    const p = provider('bluesky');
    let n = 0;
    return jest.spyOn(p, 'post').mockImplementation(async (_i: any, _t: any, posts: any[]) => {
      if (outcome === 'fail') throw new Error('The network refused the post');
      return posts.map((post) => ({
        id: post.id,
        postId: `bsky-${++n}`,
        releaseURL: `https://bsky.example/p/${n}`,
        status: 'success',
      }));
    });
  };

  interface Creator {
    session: Session;
    userId: string;
    orgId: string;
    channel: string;
  }

  /**
   * A confirmed account with its own workspace on a plan bought long ago (so
   * the plan itself is not a fresh success moment) and one channel.
   */
  async function creator(opts: { email?: string; plan?: 'old' | 'new' | 'none' } = {}): Promise<Creator> {
    const session = await t.api.register({ email: opts.email || uniqueEmail('review') });
    const { id: userId, orgId } = await session.self();
    await db().user.update({ where: { id: userId }, data: { activated: true } });
    if ((opts.plan || 'old') !== 'none') {
      await givePlan(orgId, 'PRO');
      if ((opts.plan || 'old') === 'old') {
        await db().subscription.update({
          where: { organizationId: orgId },
          data: { createdAt: new Date(Date.now() - 90 * DAY) },
        });
      }
    }
    const channel = (await addChannel(orgId, 'bluesky')).id;
    return { session, userId, orgId, channel };
  }

  /**
   * One post made in the composer ("Post now", or `type`) to `channels` and,
   * unless `publish` is false, published by the orchestrator's activity.
   * `minutesAgo` moves its publish time back (each composer post is its own
   * minute, as two real posts are).
   */
  async function composerPost(
    by: Session,
    orgId: string,
    channels: string[],
    opts: { type?: 'now' | 'schedule' | 'draft'; publish?: 'ok' | 'fail' | false; minutesAgo?: number } = {}
  ) {
    const type = opts.type || 'now';
    const res = await by.post('/posts', {
      type,
      shortLink: false,
      date: dayjs().add(type === 'schedule' ? 2 : 0, 'day').format('YYYY-MM-DDTHH:mm:00'),
      tags: [],
      posts: channels.map((id) => ({
        integration: { id },
        group: randomUUID().slice(0, 10),
        value: [{ content: `<p>Review card post ${randomUUID()}</p>`, image: [] }],
        settings: {},
      })),
    });
    expect(res.status).toBe(201);
    const ids: string[] = res.body.map((p: any) => p.postId);
    if (opts.minutesAgo) {
      await db().post.updateMany({
        where: { id: { in: ids } },
        data: { publishDate: new Date(Date.now() - opts.minutesAgo * 60_000) },
      });
    }
    const publish = opts.publish === undefined ? 'ok' : opts.publish;
    if (publish) {
      const spy = network(publish);
      try {
        for (const id of ids) await publishLikeTheWorkflow(t, orgId, id);
      } finally {
        spy.mockRestore();
      }
    }
    return ids;
  }

  const ask = async (s: Session, headers: Record<string, string> = {}) => {
    const res = await s.get('/user/review-ask', { headers });
    expect(res.status).toBe(200);
    return res.body.ask as boolean;
  };
  const record = (s: Session, body: any, headers: Record<string, string> = {}) =>
    s.post('/user/review-ask', body, { headers });
  const row = (userId: string) => db().reviewAsk.findUnique({ where: { userId } });

  /** Two posts published at two different times: the success moment. */
  async function twoPosts(c: Creator) {
    await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 30 });
    await composerPost(c.session, c.orgId, [c.channel]);
  }

  describe('the success moment', () => {
    it('nothing for a new account, nothing after one published post, the card after the second', async () => {
      const c = await creator();
      expect(await ask(c.session)).toBe(false);
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 30 });
      expect(await db().post.count({ where: { organizationId: c.orgId, state: 'PUBLISHED' } })).toBe(1);
      expect(await ask(c.session)).toBe(false);
      await composerPost(c.session, c.orgId, [c.channel]);
      expect(await ask(c.session)).toBe(true);
      // Asking changes nothing: no row until the card is shown.
      expect(await row(c.userId)).toBeNull();
    });

    it('one post sent to two channels at once is one post', async () => {
      const c = await creator();
      const second = (await addChannel(c.orgId, 'bluesky')).id;
      await composerPost(c.session, c.orgId, [c.channel, second]);
      expect(await db().post.count({ where: { organizationId: c.orgId, state: 'PUBLISHED' } })).toBe(2);
      expect(await ask(c.session)).toBe(false);
    });

    it('a failed publish does not count', async () => {
      const c = await creator();
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 30 });
      await composerPost(c.session, c.orgId, [c.channel], { publish: 'fail' });
      expect(await db().post.count({ where: { organizationId: c.orgId, state: 'ERROR' } })).toBe(1);
      expect(await ask(c.session)).toBe(false);
    });

    it('scheduled (not yet published) and draft posts do not count', async () => {
      const c = await creator();
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 30 });
      await composerPost(c.session, c.orgId, [c.channel], { type: 'schedule', publish: false });
      await composerPost(c.session, c.orgId, [c.channel], { type: 'draft', publish: false });
      expect(await ask(c.session)).toBe(false);
    });

    it('a deleted published post does not count', async () => {
      const c = await creator();
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 30 });
      const [id] = await composerPost(c.session, c.orgId, [c.channel]);
      expect(await ask(c.session)).toBe(true);
      const { group } = await db().post.findUniqueOrThrow({ where: { id } });
      const del = await c.session.delete(`/posts/${group}`);
      expect(del.status).toBeLessThan(300);
      expect(await ask(c.session)).toBe(false);
    });

    it('two posts published long ago are not a success moment now', async () => {
      const c = await creator();
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 20 * 24 * 60 });
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 10 * 24 * 60 });
      expect(await ask(c.session)).toBe(false);
    });

    it('right after a paid plan or trial started, for its owner', async () => {
      const c = await creator({ plan: 'new' });
      expect(await ask(c.session)).toBe(true);
    });

    it('not for a plan set to end, a lifetime grant, or a plan started weeks ago', async () => {
      const cancelling = await creator({ plan: 'new' });
      await db().subscription.update({
        where: { organizationId: cancelling.orgId },
        data: { cancelAt: new Date(Date.now() + 2 * DAY) },
      });
      expect(await ask(cancelling.session)).toBe(false);

      const lifetime = await creator({ plan: 'new' });
      await db().subscription.update({ where: { organizationId: lifetime.orgId }, data: { isLifetime: true } });
      expect(await ask(lifetime.session)).toBe(false);

      const old = await creator({ plan: 'old' });
      expect(await ask(old.session)).toBe(false);
    });

    it('not for a soft-deleted plan or an api.market plan; a plan row without an identifier still counts', async () => {
      const deleted = await creator({ plan: 'new' });
      await db().subscription.update({ where: { organizationId: deleted.orgId }, data: { deletedAt: new Date() } });
      expect(await ask(deleted.session)).toBe(false);

      const mkt = await creator({ plan: 'new' });
      await db().subscription.update({
        where: { organizationId: mkt.orgId },
        data: { identifier: 'apimkt:social:someone' },
      });
      expect(await ask(mkt.session)).toBe(false);

      const bare = await creator({ plan: 'new' });
      await db().subscription.update({ where: { organizationId: bare.orgId }, data: { identifier: null } });
      expect(await ask(bare.session)).toBe(true);
    });
  });

  describe('teams and several workspaces', () => {
    async function join(owner: Creator, role: 'USER' | 'ADMIN' = 'USER') {
      const member = await creator();
      await db().userOrganization.create({
        data: { userId: member.userId, organizationId: owner.orgId, role },
      });
      return member;
    }

    it('a member is asked about the team\'s posts made since they joined, not before', async () => {
      const owner = await creator();
      await twoPosts(owner);
      const member = await join(owner);
      expect(await ask(member.session)).toBe(false);
      // The member picks the team's workspace, as the switcher does.
      member.session.showorg = owner.orgId;
      await composerPost(member.session, owner.orgId, [owner.channel], { minutesAgo: 10 });
      expect(await ask(member.session)).toBe(false);
      await composerPost(member.session, owner.orgId, [owner.channel]);
      expect(await ask(member.session)).toBe(true);
    });

    it('a team member gets no paid-plan ask for the owner\'s new plan; the owner does', async () => {
      const owner = await creator({ plan: 'new' });
      const member = await join(owner, 'ADMIN');
      expect(await ask(owner.session)).toBe(true);
      expect(await ask(member.session)).toBe(false);
    });

    it('a disabled member is not asked about that team', async () => {
      const owner = await creator();
      const member = await join(owner);
      await db().userOrganization.updateMany({
        where: { userId: member.userId, organizationId: owner.orgId },
        data: { disabled: true },
      });
      await twoPosts(owner);
      expect(await ask(member.session)).toBe(false);
    });

    it('a deleted workspace\'s posts do not count', async () => {
      const owner = await creator();
      const member = await join(owner);
      member.session.showorg = owner.orgId;
      await composerPost(member.session, owner.orgId, [owner.channel], { minutesAgo: 10 });
      await composerPost(member.session, owner.orgId, [owner.channel]);
      expect(await ask(member.session)).toBe(true);
      await db().organization.update({ where: { id: owner.orgId }, data: { deletedAt: new Date() } });
      member.session.showorg = member.orgId;
      expect(await ask(member.session)).toBe(false);
    });

    it('posts in two of the user\'s workspaces add up', async () => {
      const owner = await creator();
      const member = await join(owner);
      // Pick the member's own workspace first. Without a choice the backend
      // falls back to the first workspace with a subscription, and both have
      // one, in whatever order Postgres returns them: on Cloud Build that was
      // the owner's, and the post to the member's channel got a 400.
      member.session.showorg = member.orgId;
      await composerPost(member.session, member.orgId, [member.channel], { minutesAgo: 30 });
      expect(await ask(member.session)).toBe(false);
      member.session.showorg = owner.orgId;
      await composerPost(member.session, owner.orgId, [owner.channel]);
      expect(await ask(member.session)).toBe(true);
    });

    it('one card per user, whichever workspace is selected', async () => {
      const owner = await creator();
      const member = await join(owner);
      await twoPosts(owner);
      await composerPost(owner.session, owner.orgId, [owner.channel], { minutesAgo: 5 });
      member.session.showorg = owner.orgId;
      await composerPost(member.session, owner.orgId, [owner.channel]);
      await composerPost(member.session, owner.orgId, [owner.channel], { minutesAgo: 1 });
      expect((await record(member.session, { action: 'shown' })).body).toEqual({ ok: true });
      member.session.showorg = member.orgId;
      expect(await ask(member.session)).toBe(false);
      expect((await record(member.session, { action: 'shown' })).body).toEqual({ ok: false });
    });
  });

  describe('never for', () => {
    it('our own addresses and reviewers', async () => {
      for (const email of [
        `qa.${Date.now()}@hookstep.in`,
        `reviewer.${Date.now()}@opo.razorpay.com`,
        `owner.one+${Date.now()}@example.com`,
      ]) {
        const c = await creator({ email, plan: 'new' });
        await twoPosts(c);
        expect(await ask(c.session)).toBe(false);
        expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: false });
        expect(await row(c.userId)).toBeNull();
      }
    });

    it('but a customer with a similar address is asked', async () => {
      const c = await creator({ email: `owner.${Date.now()}@example.com`, plan: 'new' });
      await twoPosts(c);
      expect(await ask(c.session)).toBe(true);
    });

    it('a platform super admin, and every member of a workspace one belongs to', async () => {
      const owner = await creator({ plan: 'new' });
      expect(await ask(owner.session)).toBe(true);
      const admin = await creator({ plan: 'none' });
      await makeSuperAdmin(admin.userId);
      await db().userOrganization.create({
        data: { userId: admin.userId, organizationId: owner.orgId, role: 'USER' },
      });
      expect(await ask(owner.session)).toBe(false);
      expect(await ask(admin.session)).toBe(false);
    });

    it('a member of a workspace in FREE_PLAN_SUNSET_EXEMPT_ORGS', async () => {
      const c = await creator({ plan: 'new' });
      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = `some-other, ${c.orgId}`;
      try {
        expect(await ask(c.session)).toBe(false);
      } finally {
        process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = savedExempt || '';
      }
      expect(await ask(c.session)).toBe(true);
    });

    it('a member of an api.market workspace', async () => {
      const c = await creator({ plan: 'new' });
      await db().marketplaceAccount.create({
        data: {
          externalUserId: `review-${Date.now()}`,
          product: 'social',
          plan: 'creator',
          organizationId: c.orgId,
        },
      });
      expect(await ask(c.session)).toBe(false);
    });

    it('an unconfirmed account: not even asked, the hard gate refuses the route', async () => {
      const c = await creator({ plan: 'new' });
      await db().user.update({ where: { id: c.userId }, data: { activated: false, providerName: 'LOCAL' } });
      const res = await c.session.get('/user/review-ask');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    });

    it('an admin impersonating the user: nothing read for them, nothing recorded', async () => {
      const c = await creator({ plan: 'new' });
      const admin = await creator({ plan: 'none' });
      await makeSuperAdmin(admin.userId);
      const as = { impersonate: (await db().userOrganization.findFirstOrThrow({ where: { userId: c.userId } })).id };
      const self = await admin.session.get('/user/self', { headers: as });
      expect([self.body.id, self.body.impersonate]).toEqual([c.userId, true]);
      expect(await ask(admin.session, as)).toBe(false);
      for (const body of [{ action: 'shown' }, { action: 'dismissed' }, { action: 'clicked', target: 'g2' }]) {
        expect((await record(admin.session, body, as)).body).toEqual({ ok: false });
      }
      expect(await row(c.userId)).toBeNull();
      // The user's own ask is untouched.
      expect(await ask(c.session)).toBe(true);
    });
  });

  describe('the cap: shown, dismissed, clicked', () => {
    it('shown claims it once; then nothing for 60 days, and again after a new success', async () => {
      const c = await creator();
      await twoPosts(c);
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: true });
      const first = await row(c.userId);
      expect(first).toMatchObject({ asks: 1, dismissedAt: null, clickedAt: null });
      expect(await ask(c.session)).toBe(false);
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: false });

      expect((await record(c.session, { action: 'dismissed' })).body).toEqual({ ok: true });
      expect((await row(c.userId))?.dismissedAt).not.toBeNull();

      // 59 days later, a fresh success: still capped.
      await db().reviewAsk.update({
        where: { userId: c.userId },
        data: { askedAt: new Date(Date.now() - 59 * DAY) },
      });
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 2 });
      expect(await ask(c.session)).toBe(false);

      // 61 days: asked again, once.
      await db().reviewAsk.update({
        where: { userId: c.userId },
        data: { askedAt: new Date(Date.now() - 61 * DAY) },
      });
      expect(await ask(c.session)).toBe(true);
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: true });
      expect(await row(c.userId)).toMatchObject({ asks: 2, dismissedAt: null });
    });

    it('after the user opened a review page, never again', async () => {
      const c = await creator();
      await twoPosts(c);
      await record(c.session, { action: 'shown' });
      expect((await record(c.session, { action: 'clicked', target: 'play' })).body).toEqual({ ok: true });
      expect(await row(c.userId)).toMatchObject({ clickedTarget: 'play' });
      await db().reviewAsk.update({
        where: { userId: c.userId },
        data: { askedAt: new Date(Date.now() - 400 * DAY) },
      });
      await composerPost(c.session, c.orgId, [c.channel], { minutesAgo: 1 });
      expect(await ask(c.session)).toBe(false);
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: false });
    });

    it('a page cannot force the card: shown is refused when it is not due', async () => {
      const c = await creator();
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: false });
      expect(await row(c.userId)).toBeNull();
      // Dismiss or click without a card shown records nothing either.
      expect((await record(c.session, { action: 'dismissed' })).body).toEqual({ ok: false });
      expect((await record(c.session, { action: 'clicked', target: 'g2' })).body).toEqual({ ok: false });
      expect(await row(c.userId)).toBeNull();
    });

    it('ten tabs (or the website and the Play app) claiming at once: exactly one wins', async () => {
      const c = await creator();
      await twoPosts(c);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => record(c.session, { action: 'shown' }))
      );
      expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(results.filter((r) => r.body.ok === true)).toHaveLength(1);
      expect(await row(c.userId)).toMatchObject({ asks: 1 });
    });

    it('60 days later, two tabs claiming the second ask at once: exactly one wins', async () => {
      const c = await creator();
      await twoPosts(c);
      expect((await record(c.session, { action: 'shown' })).body).toEqual({ ok: true });
      await db().reviewAsk.update({
        where: { userId: c.userId },
        data: { askedAt: new Date(Date.now() - 61 * DAY) },
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, () => record(c.session, { action: 'shown' }))
      );
      expect(results.filter((r) => r.body.ok === true)).toHaveLength(1);
      expect(await row(c.userId)).toMatchObject({ asks: 2 });
    });

    it('a cross-site form cannot spend the ask, and bad bodies are refused', async () => {
      const c = await creator();
      await twoPosts(c);
      const form = await t.api.request('POST', '/user/review-ask', {
        raw: 'action=shown',
        headers: { auth: c.session.auth, 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect([400, 415]).toContain(form.status);
      for (const body of [{ action: 'rated' }, { action: 'clicked' }, { action: 'clicked', target: 'x' }]) {
        expect((await record(c.session, body)).status).toBe(400);
      }
      expect(await row(c.userId)).toBeNull();
      expect(await ask(c.session)).toBe(true);
    });

    it('signed out: 401', async () => {
      expect((await t.api.get('/user/review-ask')).status).toBe(401);
      expect((await t.api.post('/user/review-ask', { action: 'shown' })).status).toBe(401);
    });
  });

  it('before the migration (no table) the card is simply off, never a 500', async () => {
    const c = await creator({ plan: 'new' });
    await db().$executeRawUnsafe('ALTER TABLE "ReviewAsk" RENAME TO "ReviewAskAway"');
    try {
      expect(await ask(c.session)).toBe(false);
      const res = await record(c.session, { action: 'shown' });
      expect([res.status, res.body]).toEqual([200, { ok: false }]);
    } finally {
      await db().$executeRawUnsafe('ALTER TABLE "ReviewAskAway" RENAME TO "ReviewAsk"');
    }
    expect(await ask(c.session)).toBe(true);
  });
});

describe('review-ask.migration.sql', () => {
  const PG_SCHEMA = 'review_ask_migration_check';
  const withSchema = (url: string, schema: string) => {
    const u = new URL(url);
    u.searchParams.set('schema', schema);
    return u.toString();
  };
  const url = withSchema(TEST_DATABASE_URL, PG_SCHEMA);
  let client: PrismaClient;

  beforeAll(async () => {
    // Today's production schema: schema.prisma without the new model.
    const before = readFileSync(SCHEMA, 'utf8').replace(
      /\n\/\/ The in-app "Enjoying Hookpost\?[\s\S]*?\nmodel ReviewAsk \{[\s\S]*?\n\}\n/,
      '\n'
    );
    expect(before).not.toContain('ReviewAsk');
    const beforeFile = join(mkdtempSync(join(tmpdir(), 'review-ask-migration-')), 'before.prisma');
    writeFileSync(beforeFile, before);
    execFileSync(
      PRISMA,
      ['db', 'push', '--schema', beforeFile, '--skip-generate', '--force-reset', '--accept-data-loss'],
      { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' }
    );
    client = new PrismaClient({ datasources: { db: { url } } });
    await client.$executeRawUnsafe(
      `INSERT INTO "${PG_SCHEMA}"."Organization" ("id", "name", "updatedAt") VALUES ('org-before-migration', 'Existing', now())`
    );
  }, 120_000);

  afterAll(async () => {
    await client?.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`).catch(() => undefined);
    await client?.$disconnect();
  });

  const apply = () => {
    try {
      execFileSync('psql', ['--version'], { stdio: 'pipe' });
    } catch {
      execFileSync(PRISMA, ['db', 'execute', '--url', url, '--file', MIGRATION], { stdio: 'pipe' });
      return;
    }
    execFileSync('psql', [TEST_DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', MIGRATION], {
      env: { ...process.env, PGOPTIONS: `-c search_path=${PG_SCHEMA}` },
      stdio: 'pipe',
    });
  };

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
    expect(rows.map((r) => r.id)).toEqual(['org-before-migration']);
  }, 120_000);
});
