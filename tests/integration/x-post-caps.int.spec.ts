/**
 * The monthly X caps (pricing.ts x_posts_per_month / x_link_posts_per_month,
 * XPostCapService) on the real database, through the orchestrator's real
 * PostActivity (publishLikeTheWorkflow): a post the composer saved, published
 * the way postWorkflowV114 does it. Only X's own post and reply calls are
 * stubbed; nothing leaves the machine.
 *
 * Usage is seeded as Credits rows (the meter's own table) so a test does not
 * have to publish 50 posts to reach a cap.
 */
import { randomUUID } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan, makeSuperAdmin } from './setup/db';
import { publishLikeTheWorkflow } from './setup/publish';
import { TemporalService } from 'nestjs-temporal-core';
import { PostActivity } from '@hookpost/orchestrator/activities/post.activity';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { WebhooksService } from '@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { XPostCapService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  X_CREDIT,
  X_LINK_CREDIT,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/x.post.cap';

const DAY = 86400_000;
const MINUTE = 60_000;

describe('X caps per plan (real database)', () => {
  let t: TestApp;
  let posted = 0;
  beforeAll(async () => {
    t = await startApp();
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  type Workspace = { s: Session; orgId: string; userId: string; x: string; bluesky: string };

  async function workspace(tier: 'STANDARD' | 'PRO' = 'STANDARD'): Promise<Workspace> {
    const s = await t.api.register({ company: `X caps ${randomUUID().slice(0, 8)}` });
    const { id: userId, orgId } = await s.self();
    await db().user.update({ where: { id: userId }, data: { activated: true } });
    await givePlan(orgId, tier);
    const x = (await addChannel(orgId, 'x')).id;
    const bluesky = (await addChannel(orgId, 'bluesky')).id;
    return { s, orgId, userId, x, bluesky };
  }

  const seed = (orgId: string, type: string, n: number) =>
    db().credits.createMany({
      data: Array.from({ length: n }, () => ({ organizationId: orgId, credits: 1, type })),
    });
  const used = (orgId: string, type: string) =>
    db().credits.count({ where: { organizationId: orgId, type } });

  /** A post (and its thread replies) saved through the composer. */
  async function schedule(w: Workspace, channel: string, texts: string[]): Promise<string> {
    const res = await w.s.post('/posts', {
      type: 'schedule',
      shortLink: false,
      date: new Date(Date.now() + 2 * DAY + posted++ * MINUTE).toISOString().slice(0, 16),
      tags: [],
      posts: [
        {
          integration: { id: channel },
          group: randomUUID().slice(0, 10),
          value: texts.map((content) => ({ content: `<p>${content}</p>`, image: [] })),
          settings: channel === w.x ? { __type: 'x', who_can_reply_post: 'everyone' } : {},
        },
      ],
    });
    if (res.status !== 201) throw new Error(`POST /posts ${res.status} ${res.text}`);
    return res.body[0].postId;
  }

  /** X's answers, stubbed; counts the calls that would have reached X. */
  function network(provider = 'x', fail = false) {
    const p: any = t.get<IntegrationManager>(IntegrationManager).getSocialIntegration(provider);
    let n = 0;
    const answer = (posts: any[]) =>
      posts.map((post) => ({
        id: post.id,
        postId: `${provider}-${++n}`,
        releaseURL: `https://${provider}.example/${n}`,
        status: 'success',
      }));
    const post = jest.spyOn(p, 'post').mockImplementation(async (_i: any, _t: any, posts: any) => {
      if (fail) throw new Error('X 503');
      return answer(posts);
    });
    const comment = jest
      .spyOn(p, 'comment')
      .mockImplementation(async (_i: any, _p: any, _l: any, _t: any, posts: any) => answer(posts));
    return {
      calls: () => post.mock.calls.length + comment.mock.calls.length,
      restore: () => {
        post.mockRestore();
        comment.mockRestore();
      },
    };
  }

  async function publish(w: Workspace, id: string, opts: { provider?: string; fail?: boolean } = {}) {
    const net = network(opts.provider ?? 'x', opts.fail);
    try {
      const result = await publishLikeTheWorkflow(t, w.orgId, id);
      return { ...result, calls: net.calls() };
    } finally {
      net.restore();
    }
  }

  const row = (id: string) => db().post.findUniqueOrThrow({ where: { id } });

  it('Standard: the 50th X post of the month goes out, the 51st is refused with a sentence and never reaches X', async () => {
    const w = await workspace('STANDARD');
    const cap = pricing.STANDARD.x_posts_per_month;
    await seed(w.orgId, X_CREDIT, cap - 1);

    const last = await publish(w, await schedule(w, w.x, ['the fiftieth']));
    expect(last).toMatchObject({ published: true, calls: 1 });
    expect(await used(w.orgId, X_CREDIT)).toBe(cap);

    const id = await schedule(w, w.x, ['one too many']);
    const over = await publish(w, id);
    expect(over.published).toBe(false);
    expect(over.calls).toBe(0);
    expect(over.error).toMatch(/^Your Standard plan includes 50 X posts a month .*this month's are used/);
    expect(await row(id)).toMatchObject({ state: 'ERROR' });
    expect(await used(w.orgId, X_CREDIT)).toBe(cap);

    // Other channels are not affected.
    const sky = await publish(w, await schedule(w, w.bluesky, ['still fine']), { provider: 'bluesky' });
    expect(sky).toMatchObject({ published: true, calls: 1 });
  });

  it('links: past 3 link posts, a link post is refused (and gives back its post credit); a plain one still goes', async () => {
    const w = await workspace('STANDARD');
    await seed(w.orgId, X_LINK_CREDIT, pricing.STANDARD.x_link_posts_per_month);

    const linked = await publish(w, await schedule(w, w.x, ['read https://hookpost.hookstep.in/blog']));
    expect(linked).toMatchObject({ published: false, calls: 0 });
    expect(linked.error).toMatch(/includes 3 X posts with a link a month.*remove the link/);
    expect(await used(w.orgId, X_CREDIT)).toBe(0);

    const plain = await publish(w, await schedule(w, w.x, ['no link, just words']));
    expect(plain).toMatchObject({ published: true, calls: 1 });
    expect(await used(w.orgId, X_CREDIT)).toBe(1);
    expect(await used(w.orgId, X_LINK_CREDIT)).toBe(3);
  });

  it('a thread: every reply takes a credit; the reply over the cap is refused and never sent', async () => {
    const w = await workspace('STANDARD');
    await seed(w.orgId, X_CREDIT, pricing.STANDARD.x_posts_per_month - 2);
    const id = await schedule(w, w.x, ['root', 'reply one', 'reply two']);
    const result = await publish(w, id);
    expect(result.calls).toBe(2);
    expect(result.error).toMatch(/50 X posts a month \(each reply in a thread counts as one\)/);
    expect(await used(w.orgId, X_CREDIT)).toBe(50);
  });

  it('five publishes at once with one post left: exactly one goes out (the meter is locked per workspace)', async () => {
    const w = await workspace('STANDARD');
    await seed(w.orgId, X_CREDIT, pricing.STANDARD.x_posts_per_month - 1);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await schedule(w, w.x, [`race ${i}`]));
    const net = network('x');
    try {
      const results = await Promise.all(ids.map((id) => publishLikeTheWorkflow(t, w.orgId, id)));
      expect(results.filter((r) => r.published)).toHaveLength(1);
      expect(net.calls()).toBe(1);
    } finally {
      net.restore();
    }
    expect(await used(w.orgId, X_CREDIT)).toBe(pricing.STANDARD.x_posts_per_month);
  });

  it('Pro has its own caps: 150 posts', async () => {
    const w = await workspace('PRO');
    await seed(w.orgId, X_CREDIT, 149);
    expect(await publish(w, await schedule(w, w.x, ['pro 150']))).toMatchObject({ published: true });
    const over = await publish(w, await schedule(w, w.x, ['pro 151']));
    expect(over.error).toMatch(/^Your Pro plan includes 150 X posts a month/);
  });

  it('a publish X refuses gives its credits back', async () => {
    const w = await workspace('STANDARD');
    const failed = await publish(w, await schedule(w, w.x, ['https://hookpost.hookstep.in']), { fail: true });
    expect(failed.published).toBe(false);
    expect(await used(w.orgId, X_CREDIT)).toBe(0);
    expect(await used(w.orgId, X_LINK_CREDIT)).toBe(0);
  });

  it('credits from before this plan month do not count', async () => {
    const w = await workspace('STANDARD');
    await seed(w.orgId, X_CREDIT, 50);
    await db().credits.updateMany({
      where: { organizationId: w.orgId, type: X_CREDIT },
      data: { createdAt: new Date(Date.now() - 40 * DAY) },
    });
    expect(await publish(w, await schedule(w, w.x, ['new month']))).toMatchObject({ published: true });
  });

  it('our own workspaces (a platform super admin member) are not capped', async () => {
    const w = await workspace('STANDARD');
    await makeSuperAdmin(w.userId);
    await seed(w.orgId, X_CREDIT, 500);
    await seed(w.orgId, X_LINK_CREDIT, 500);
    expect(await publish(w, await schedule(w, w.x, ['https://hookpost.hookstep.in']))).toMatchObject({
      published: true,
      calls: 1,
    });
  });

  describe('X plugs (auto plug a reply once a post has N likes)', () => {
    const activity = () =>
      new PostActivity(
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
    async function plug(w: Workspace, text: string) {
      return db().plugs.create({
        data: {
          organizationId: w.orgId,
          integrationId: w.x,
          plugFunction: 'autoPlugPost',
          data: JSON.stringify([
            { name: 'likesAmount', value: '1' },
            { name: 'post', value: text },
          ]),
        },
      });
    }
    const stubPlug = (acted: boolean) => {
      const p: any = t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('x');
      return jest.spyOn(p, 'autoPlugPost').mockImplementation(async () => acted);
    };
    const run = (id: string) =>
      activity().processPlug({ plugId: id, postId: 'x-1', delay: 0, totalRuns: 5, currentRun: 1 });

    it('a plug that posted is counted; one that only polled is not', async () => {
      const w = await workspace('STANDARD');
      const p = await plug(w, 'Thanks for the likes! https://hookpost.hookstep.in');
      const polled = stubPlug(false);
      try {
        expect(await run(p.id)).toBe(false);
      } finally {
        polled.mockRestore();
      }
      expect(await used(w.orgId, X_CREDIT)).toBe(0);
      const acted = stubPlug(true);
      try {
        expect(await run(p.id)).toBe(true);
      } finally {
        acted.mockRestore();
      }
      expect(await used(w.orgId, X_CREDIT)).toBe(1);
      expect(await used(w.orgId, X_LINK_CREDIT)).toBe(1);
    });

    it('with the X cap used up the plug never reaches X and stops polling', async () => {
      const w = await workspace('STANDARD');
      await seed(w.orgId, X_CREDIT, pricing.STANDARD.x_posts_per_month);
      const p = await plug(w, 'plain thanks');
      const spy = stubPlug(true);
      try {
        expect(await run(p.id)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await used(w.orgId, X_CREDIT)).toBe(pricing.STANDARD.x_posts_per_month);
    });
  });
});
