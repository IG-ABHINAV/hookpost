/**
 * The api.market products (/mkt/v1/<product>) on the real backend, Postgres
 * and Redis, called the way api.market forwards a subscriber's call
 * (setup/marketplace.ts Gateway). Nothing reaches a network: the providers'
 * token exchange, X's request token and every publish are stubbed on the
 * provider, and the network guard fails any other attempt.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts marketplace
 */
import { startApp, TestApp } from './setup/app';
import { addChannel, db, disconnectDb } from './setup/db';
import {
  Gateway,
  GATEWAY_SECRET,
  imageForm,
  marketplaceEnv,
  newSubscriber,
  NEXT_GATEWAY_SECRET_SOCIAL,
  planToken,
  png,
  Product,
} from './setup/marketplace';
import { publishLikeTheWorkflow } from './setup/publish';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { MarketplacePublishRefusedError } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.publish.error';
import { MarketplaceAccountService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service';
import { MarketplaceLedger, ledgerKeys } from '@hookpost/backend/marketplace-api/marketplace.ledger';
import {
  alertCreditThreshold,
  hardCreditCap,
  marketplacePlan,
  PRIOR_PLAN_LIMITS,
  quotaWindow,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { Logger } from '@nestjs/common';
import { countPdfPages } from '@hookpost/nestjs-libraries/integrations/social/carousel.pdf';
import { readFileSync } from 'fs';
import { join } from 'path';

const DAY = 86_400_000;
const PROVIDER_ENV: Record<string, string> = {
  LINKEDIN_CLIENT_ID: 'linkedin-client-test',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret-test',
  X_API_KEY: 'x-key-test',
  X_API_SECRET: 'x-secret-test',
  DISCORD_BOT_TOKEN_ID: 'discord-bot-test',
};

// Discord ids: a channel of the subscriber's own server (the server is the
// channel row's internalId), and one of another server the Hookpost bot is in.
const OWN_DISCORD_CHANNEL = '1200000000000000002';
const FOREIGN_DISCORD_CHANNEL = '1300000000000000003';
const FOREIGN_DISCORD_SERVER = '1900000000000000009';

describe('api.market products (/mkt/v1)', () => {
  let t: TestApp;
  let gw: Gateway;
  const saved: Record<string, string | undefined> = {};

  const manager = () => t.get<IntegrationManager>(IntegrationManager);
  const provider = (id: string): any => manager().getSocialIntegration(id);
  const account = (user: string, product: Product) =>
    db().marketplaceAccount.findUnique({
      where: { marketplace_externalUserId_product: { marketplace: 'API_MARKET', externalUserId: user, product } },
    });

  /** A subscriber whose workspace exists (one call made), with channels added as connects leave them. */
  async function subscriber(product: Product, plan: string, providers: string[] = []) {
    const user = newSubscriber();
    const first = await gw.call({ product, plan, user, path: '/usage' });
    expect(first.status).toBe(200);
    const acc = (await account(user, product))!;
    const channels = [];
    for (const p of providers) channels.push(await addChannel(acc.organizationId, p));
    const call = (c: Omit<Parameters<Gateway['call']>[0], 'product' | 'plan' | 'user'> & { plan?: string }) =>
      gw.call({ product, plan, user, ...c });
    return { user, account: acc, orgId: acc.organizationId, channels, call };
  }

  const stubPublish = (id: string) => {
    const p = provider(id);
    let n = 0;
    const post = jest.spyOn(p, 'post').mockImplementation(async (_internal: any, _token: any, posts: any[]) =>
      posts.map((post) => ({ id: post.id, postId: `${id}-${++n}`, releaseURL: `https://${id}.example/p/${n}`, status: 'success' }))
    );
    const comment = p.comment
      ? jest.spyOn(p, 'comment').mockImplementation(async (_i: any, _p: any, _l: any, _t: any, posts: any[]) =>
          posts.map((post) => ({ id: post.id, postId: `${id}-${++n}`, releaseURL: `https://${id}.example/p/${n}`, status: 'success' }))
        )
      : null;
    // The pending flow is not under test here: publish in one step.
    if (p.postPending) jest.spyOn(p, 'postPending').mockImplementation((...a: any[]) => p.post(...a));
    return { post, comment };
  };

  /**
   * Discord's GET /channels/{id} as it answers the bot: `servers` maps a
   * channel id to its server; any other id is Discord's 404 "Unknown
   * Channel". Only that request is answered here; every other fetch goes
   * through (the gateway calls in this suite), so the network guard still
   * fails anything else that leaves. Returns the lookups made.
   */
  const discordChannels = (servers: Record<string, string>) => {
    const realFetch = globalThis.fetch;
    const lookups: { channel: string; auth: string | null }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
      const url = String(input?.url ?? input);
      const match = url.match(/^https:\/\/discord\.com\/api\/channels\/([^/?]+)$/);
      if (!match) return realFetch(input, init);
      const channel = decodeURIComponent(match[1]);
      lookups.push({ channel, auth: new Headers(init?.headers).get('authorization') });
      if (!(channel in servers)) {
        return new Response(JSON.stringify({ message: 'Unknown Channel', code: 10003 }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: channel, type: 0, guild_id: servers[channel] }), { status: 200 });
    });
    return lookups;
  };

  beforeAll(async () => {
    const env = { ...marketplaceEnv(), ...PROVIDER_ENV };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await startApp();
    gw = new Gateway(t.baseUrl);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.close();
    await disconnectDb();
  });
  afterEach(() => jest.restoreAllMocks());

  // -------------------------------------------------------------------------
  describe('who may call', () => {
    it('refuses a missing or wrong gateway secret with 401, takes both secrets of a rotation', async () => {
      const user = newSubscriber();
      for (const secret of [undefined, 'wrong-secret-0123456789abcdef0123456789', GATEWAY_SECRET.linkedin]) {
        const res = await gw.call({ product: 'social', plan: 'trial', user, path: '/providers', headers: { 'x-hookpost-gateway': secret } });
        expect(res.status).toBe(401);
        expect(res.billing).toBe('API=0;');
      }
      for (const secret of [GATEWAY_SECRET.social, NEXT_GATEWAY_SECRET_SOCIAL]) {
        const res = await gw.call({ product: 'social', plan: 'trial', user, path: '/providers', headers: { 'x-hookpost-gateway': secret } });
        expect(res.status).toBe(200);
      }
    });

    it('refuses an unknown plan token (403), a bad subscriber (400) and an Authorization header (400), creating nothing', async () => {
      const user = newSubscriber();
      const bad = [
        [{ 'x-hookpost-plan': 'not-a-plan-token-0123456789', 'x-magicapi-plan': undefined }, 403, 'unknown_plan'],
        [{ 'x-hookpost-plan': planToken('x', 'pro'), 'x-magicapi-plan': 'Enterprise' }, 403, 'unknown_plan'],
        [{ 'x-magicapi-user': 'Not-A-Cuid' }, 400, 'invalid_subscriber'],
        [{ authorization: 'a-hookpost-api-key' }, 400, 'authorization_not_accepted'],
      ] as const;
      for (const [headers, status, error] of bad) {
        const res = await gw.call({ product: 'social', plan: 'trial', user, path: '/channels', headers: headers as any });
        expect([res.status, res.body.error]).toEqual([status, error]);
        expect(res.billing).toBe('API=0;');
      }
      expect(await account(user, 'social')).toBeNull();
    });

    describe("Social: the plan from api.market's x-magicapi-plan, no plan header", () => {
      const NO_TOKEN = { 'x-hookpost-plan': undefined };

      it('Free trial, Standard and Pro each get their own limits', async () => {
        for (const [name, plan, channels] of [
          ['Free trial', 'trial', 1],
          ['Standard', 'standard', 5],
          ['Pro', 'pro', 20],
        ] as const) {
          const user = newSubscriber();
          const res = await gw.call({ product: 'social', plan, user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
          expect([res.status, res.body.plan, res.body.channels_included]).toEqual([200, plan, channels]);
          expect((await account(user, 'social'))!.plan).toBe(plan);
        }
      });

      it('a plan name in another case or with extra whitespace is the same plan', async () => {
        for (const [name, plan] of [[' PRO ', 'pro'], ['free  TRIAL', 'trial'], ['standard\t', 'standard']] as const) {
          const res = await gw.call({ product: 'social', plan, user: newSubscriber(), path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
          expect([res.status, res.body.plan]).toEqual([200, plan]);
        }
      });

      it('an unknown or missing plan name is 403 unknown_plan, creating nothing', async () => {
        for (const name of ['Starter', 'Enterprise', 'Testers', 'Freee', undefined]) {
          const user = newSubscriber();
          const res = await gw.call({ product: 'social', plan: 'pro', user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
          expect([res.status, res.body.error, res.billing]).toEqual([403, 'unknown_plan', 'API=0;']);
          expect(await account(user, 'social')).toBeNull();
        }
      });

      it("api.market's review plan, Tester, gets Pro limits", async () => {
        for (const name of ['Tester', ' TESTER ']) {
          const user = newSubscriber();
          const res = await gw.call({ product: 'social', plan: 'pro', user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
          expect([res.status, res.body.plan, res.body.channels_included]).toEqual([200, 'pro', 20]);
          expect((await account(user, 'social'))!.plan).toBe('pro');
        }
      });

      it("api.market's free plan name, Free, gets the trial limits (Free trial still works during the rename)", async () => {
        for (const name of ['Free', ' FREE ', 'Free trial']) {
          const user = newSubscriber();
          const res = await gw.call({ product: 'social', plan: 'trial', user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
          expect([res.status, res.body.plan, res.body.channels_included]).toEqual([200, 'trial', 1]);
          expect((await account(user, 'social'))!.plan).toBe('trial');
        }
      });

      it('Free without the Social Source key is 401, creating nothing', async () => {
        const user = newSubscriber();
        for (const secret of [undefined, 'wrong-secret-0123456789abcdef0123456789', GATEWAY_SECRET.linkedin]) {
          const res = await gw.call({
            product: 'social',
            plan: 'trial',
            user,
            path: '/usage',
            headers: { ...NO_TOKEN, 'x-hookpost-gateway': secret, 'x-magicapi-plan': 'Free' },
          });
          expect([res.status, res.body.error]).toEqual([401, 'unauthorized']);
        }
        expect(await account(user, 'social')).toBeNull();
      });

      it('Tester without the Social Source key is 401, creating nothing', async () => {
        const user = newSubscriber();
        for (const secret of [undefined, 'wrong-secret-0123456789abcdef0123456789', GATEWAY_SECRET.linkedin]) {
          const res = await gw.call({
            product: 'social',
            plan: 'pro',
            user,
            path: '/usage',
            headers: { ...NO_TOKEN, 'x-hookpost-gateway': secret, 'x-magicapi-plan': 'Tester' },
          });
          expect([res.status, res.body.error]).toEqual([401, 'unauthorized']);
        }
        expect(await account(user, 'social')).toBeNull();
      });

      it('a spoofed x-magicapi-plan without the Social Source key is 401, creating nothing', async () => {
        const user = newSubscriber();
        for (const secret of [undefined, 'wrong-secret-0123456789abcdef0123456789', GATEWAY_SECRET.linkedin]) {
          const res = await gw.call({
            product: 'social',
            plan: 'pro',
            user,
            path: '/usage',
            headers: { ...NO_TOKEN, 'x-hookpost-gateway': secret, 'x-magicapi-plan': 'Pro' },
          });
          expect([res.status, res.body.error]).toEqual([401, 'unauthorized']);
        }
        expect(await account(user, 'social')).toBeNull();
      });

      it('a new plan name moves the account like a new plan token does', async () => {
        const user = newSubscriber();
        await gw.call({ product: 'social', plan: 'trial', user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': 'Free trial' } });
        const res = await gw.call({ product: 'social', plan: 'pro', user, path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': 'Pro' } });
        expect([res.status, res.body.plan, res.body.channels_included]).toEqual([200, 'pro', 20]);
        expect((await account(user, 'social'))!.plan).toBe('pro');
      });

      it('LinkedIn, X and the Validator still need a plan token: their plan names are not mapped', async () => {
        for (const product of ['linkedin', 'x', 'validate'] as const) {
          for (const name of ['Free trial', 'Free', 'Tester']) {
            const res = await gw.call({ product, plan: 'trial', user: newSubscriber(), path: '/usage', headers: { ...NO_TOKEN, 'x-magicapi-plan': name } });
            expect([res.status, res.body.error]).toEqual([403, 'unknown_plan']);
          }
        }
      });
    });

    it('serves nothing it does not sell: analytics, video, users or another product name are 404', async () => {
      const user = newSubscriber();
      for (const path of ['/analytics/x', '/users', '/generate-video', '/video/function', '/integration-trigger/x']) {
        const res = await gw.call({ product: 'social', plan: 'standard', user, path });
        expect(res.status).toBe(404);
      }
      const res = await fetch(`${t.baseUrl}/mkt/v1/tiktok/posts`, { headers: { 'x-hookpost-gateway': GATEWAY_SECRET.social } });
      expect(res.status).toBe(404);
    });

    it('answers 429 past the subscriber\'s token bucket', async () => {
      const s = await subscriber('validate', 'trial');
      process.env.MKT_RATE_READ_PER_SEC = '1';
      try {
        const statuses = [];
        for (let i = 0; i < 4; i++) statuses.push((await s.call({ path: '/rules' })).status);
        expect(statuses).toContain(429);
      } finally {
        process.env.MKT_RATE_READ_PER_SEC = '200';
      }
    });

    it('a paused product answers 503 at once', async () => {
      process.env.MKT_DISABLED_PRODUCTS = 'validate';
      try {
        const res = await gw.call({ product: 'validate', plan: 'trial', user: newSubscriber(), path: '/rules' });
        expect([res.status, res.body.error]).toEqual([503, 'product_paused']);
      } finally {
        process.env.MKT_DISABLED_PRODUCTS = '';
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('provisioning', () => {
    it('the first call creates an isolated workspace and plan row; later calls reuse it', async () => {
      const user = newSubscriber();
      await gw.call({ product: 'social', plan: 'trial', user, path: '/usage' });
      await gw.call({ product: 'social', plan: 'trial', user, path: '/channels' });
      const rows = await db().marketplaceAccount.findMany({ where: { externalUserId: user } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ product: 'social', plan: 'trial', status: 'ACTIVE', marketplace: 'API_MARKET' });
      const org = await db().organization.findUniqueOrThrow({
        where: { id: rows[0].organizationId },
        include: { users: true, subscription: true },
      });
      expect(org.users).toHaveLength(0);
      expect(org.apiKey).toBeNull();
      expect(org.allowTrial).toBe(false);
      expect(org.isTrailing).toBe(false);
      expect(org.subscription).toMatchObject({
        identifier: `apimkt:social:${user}`,
        subscriptionTier: 'STANDARD',
        totalChannels: 1,
        cancelAt: null,
        isLifetime: false,
      });
    });

    it('five first calls at once still make one workspace', async () => {
      const user = newSubscriber();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => gw.call({ product: 'x', plan: 'basic', user, path: '/usage' }))
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(await db().marketplaceAccount.count({ where: { externalUserId: user } })).toBe(1);
      expect(await db().subscription.count({ where: { identifier: `apimkt:x:${user}` } })).toBe(1);
    });

    it('buying two products makes two workspaces', async () => {
      const user = newSubscriber();
      await gw.call({ product: 'x', plan: 'basic', user, path: '/usage' });
      await gw.call({ product: 'linkedin', plan: 'creator', user, path: '/usage' });
      const rows = await db().marketplaceAccount.findMany({ where: { externalUserId: user } });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.organizationId)).size).toBe(2);
    });

    it('a new plan token moves the account: tier, channel cap and window', async () => {
      const s = await subscriber('social', 'trial');
      await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { periodStart: new Date(Date.now() - 10 * DAY) } });
      const res = await s.call({ plan: 'pro', path: '/usage' });
      expect(res.body).toMatchObject({ plan: 'pro', channels_included: 20, x_included: true });
      const acc = (await account(s.user, 'social'))!;
      expect(acc.plan).toBe('pro');
      expect(Date.now() - acc.periodStart.getTime()).toBeLessThan(60_000);
      expect(await db().subscription.findUniqueOrThrow({ where: { organizationId: s.orgId } })).toMatchObject({
        subscriptionTier: 'PRO',
        totalChannels: 20,
      });
    });

    it('a new plan starts its credits from 0, on a counter that lives until the new window ends', async () => {
      // Review 25 Oct: the counter had no period in its key, so a trial's
      // usage carried into the plan bought after it.
      const s = await subscriber('linkedin', 'trial', ['linkedin']);
      const trialStart = new Date(Date.now() - 5 * DAY);
      await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { periodStart: trialStart } });
      await ioRedis.set(ledgerKeys.quota(s.account.id, trialStart, 0), '60', 'EX', 23 * 86400);
      const onTrial = await s.call({ path: '/usage' });
      expect([onTrial.body.plan, onTrial.body.credits_used]).toEqual(['trial', 60]);

      const upgraded = await s.call({ plan: 'creator', path: '/usage' });
      expect([upgraded.body.plan, upgraded.body.credits_used]).toEqual(['creator', 0]);

      const res = await s.call({
        plan: 'creator',
        path: '/posts',
        body: { channel_id: s.channels[0].id, text: 'First post on Creator', schedule_at: new Date(Date.now() + DAY).toISOString() },
      });
      expect([res.status, res.billing]).toEqual([200, 'API=1;']);
      expect((await s.call({ plan: 'creator', path: '/usage' })).body.credits_used).toBe(1);

      const acc = (await account(s.user, 'linkedin'))!;
      expect(acc.periodStart.getTime()).toBeGreaterThan(trialStart.getTime());
      const window = quotaWindow(acc.periodStart, new Date());
      const key = ledgerKeys.quota(s.account.id, acc.periodStart, window.index);
      expect(await ioRedis.get(key)).toBe('1');
      // The counter lives until a day after the new 28-day window ends.
      const expected = Math.ceil((window.end.getTime() - Date.now()) / 1000) + 86400;
      const ttl = await ioRedis.ttl(key);
      expect(ttl).toBeGreaterThan(expected - 60);
      expect(ttl).toBeLessThanOrEqual(expected + 1);
      expect(window.end.getTime() - acc.periodStart.getTime()).toBe(28 * DAY);
    });

    it('/public/v1 cannot reach a marketplace workspace: it has no API key', async () => {
      const s = await subscriber('social', 'standard');
      expect((await db().organization.findUniqueOrThrow({ where: { id: s.orgId } })).apiKey).toBeNull();
      for (const key of ['null', 'undefined', '']) {
        const res = await t.api.get('/public/v1/integrations', { headers: { authorization: key } });
        expect(res.status).toBe(401);
      }
    });

    it('every Razorpay sweep ignores apimkt: rows, even ones that look due', async () => {
      const s = await subscriber('social', 'standard');
      const soon = new Date(Date.now() + DAY);
      await db().organization.update({ where: { id: s.orgId }, data: { isTrailing: true } });
      const repository = t.get<SubscriptionRepository>(SubscriptionRepository);
      expect((await repository.getTrialingRows()).map((r) => r.organizationId)).not.toContain(s.orgId);
      await db().subscription.update({ where: { organizationId: s.orgId }, data: { cancelAt: soon } });
      expect((await repository.getEndingRows(new Date(), new Date(Date.now() + 2 * DAY))).map((r) => r.organizationId)).not.toContain(s.orgId);
      await db().subscription.update({ where: { organizationId: s.orgId }, data: { cancelAt: new Date(Date.now() - DAY) } });
      expect((await repository.getLapsedCancellations(new Date())).map((r) => r.organizationId)).not.toContain(s.orgId);
      await db().subscription.update({ where: { organizationId: s.orgId }, data: { cancelAt: null } });
      await db().organization.update({ where: { id: s.orgId }, data: { isTrailing: false } });
    });
  });

  // -------------------------------------------------------------------------
  describe('calls that need nothing connected (the reviewer\'s test calls)', () => {
    it('Social: GET /providers, 0 credits, X not on the trial', async () => {
      const res = await gw.call({ product: 'social', plan: 'trial', user: newSubscriber(), path: '/providers' });
      expect(res.status).toBe(200);
      expect(res.billing).toBe('API=0;');
      const ids = res.body.providers.map((p: any) => p.identifier);
      expect(ids).toEqual(expect.arrayContaining(['linkedin', 'x', 'threads']));
      expect(ids).not.toContain('tiktok');
      expect(res.body.providers.find((p: any) => p.identifier === 'x')).toMatchObject({
        included_in_plan: false,
        max_chars: 280,
        credits: { per_tweet: 2, per_tweet_with_link: 20 },
      });
    });

    it('X: POST /threads/estimate prices a thread, 0 credits', async () => {
      const res = await gw.call({
        product: 'x',
        plan: 'trial',
        user: newSubscriber(),
        path: '/threads/estimate',
        body: { tweets: [{ text: 'one' }, { text: 'two, see example.com' }], link_policy: 'allow' },
      });
      expect(res.status).toBe(200);
      expect(res.billing).toBe('API=0;');
      expect(res.body).toMatchObject({ valid: false, thread_cap: 5, links_included: false });
      const paid = await gw.call({
        product: 'x',
        plan: 'basic',
        user: newSubscriber(),
        path: '/threads/estimate',
        body: { tweets: [{ text: 'one' }, { text: 'two, see example.com' }], link_policy: 'allow' },
      });
      expect(paid.body).toMatchObject({ valid: true, credits: 22 });
    });

    it('Validator: GET /rules is 0 credits and POST /check is 1', async () => {
      const user = newSubscriber();
      const rules = await gw.call({ product: 'validate', plan: 'trial', user, path: '/rules' });
      expect([rules.status, rules.billing]).toEqual([200, 'API=0;']);
      const check = await gw.call({
        product: 'validate',
        plan: 'trial',
        user,
        path: '/check',
        body: { text: 'hello world', platforms: ['x', 'youtube'], media: [{ type: 'image' }] },
      });
      expect([check.status, check.billing]).toEqual([200, 'API=1;']);
      expect(check.body.results.map((r: any) => [r.platform, r.valid])).toEqual([
        ['x', true],
        ['youtube', false],
      ]);
    });

    it('LinkedIn: POST /carousels/render makes a PDF with one page per image, 1 credit', async () => {
      const s = await subscriber('linkedin', 'trial');
      const ids = [];
      for (const color of ['#ff0000', '#00ff00', '#0000ff']) {
        const up = await s.call({ path: '/media', form: imageForm(await png(600, 400, color)) });
        expect([up.status, up.billing]).toEqual([200, 'API=0;']);
        ids.push(up.body.id);
      }
      const res = await s.call({ path: '/carousels/render', body: { images: ids, title: 'Launch lessons', size: 'square' } });
      expect(res.status).toBe(200);
      expect(res.billing).toBe('API=1;');
      expect(res.body).toMatchObject({ pages: 3, width: 1080, height: 1080 });
      expect(new Date(res.body.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);
      const prefix = `${process.env.FRONTEND_URL}/uploads/`;
      const pdf = readFileSync(join(process.env.UPLOAD_DIRECTORY!, res.body.pdf_url.slice(prefix.length)));
      expect(countPdfPages(pdf)).toBe(3);
      expect((await db().media.findUniqueOrThrow({ where: { id: res.body.id } })).type).toBe('pdf');
    });

    it('LinkedIn: a carousel image on a private address is refused (SSRF guard), and the credit is not kept', async () => {
      const s = await subscriber('linkedin', 'trial');
      const res = await s.call({
        path: '/carousels/render',
        body: { images: ['http://127.0.0.1:1/a.png', 'http://169.254.169.254/latest/meta-data'] },
      });
      expect([res.status, res.body.error, res.billing]).toEqual([400, 'fetch_failed', 'API=0;']);
      const window = quotaWindow(s.account.periodStart, new Date());
      expect(await ioRedis.get(ledgerKeys.quota(s.account.id, s.account.periodStart, window.index))).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('connecting channels', () => {
    const linkedinLogin = (id: string) =>
      jest.spyOn(provider('linkedin'), 'authenticate').mockResolvedValue({
        id,
        name: `LinkedIn ${id}`,
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresIn: 3600 * 24 * 60,
        picture: '',
        username: id,
      } as any);

    it('a connect link binds the state to this workspace; the callback says marketplace and the channel appears', async () => {
      const s = await subscriber('linkedin', 'trial');
      const link = await s.call({ path: '/connect' });
      expect([link.status, link.billing]).toEqual([200, 'API=0;']);
      expect(link.body).toMatchObject({ provider: 'linkedin', expires_in: 3600 });
      const state = new URL(link.body.url).searchParams.get('state')!;
      expect(await ioRedis.get(`organization:${state}`)).toBe(s.orgId);
      // Bound to its provider (completeConnect's stateIsFor).
      expect(await ioRedis.get(`provider:${state}`)).toBe('linkedin');

      linkedinLogin('li-mkt-1');
      const callback = await t.api.post('/integrations/social-connect/linkedin', { code: 'code-1', state, timezone: '0' });
      expect(callback.status).toBe(201);
      expect(callback.body.marketplace).toBe(true);
      expect(JSON.stringify(callback.body)).not.toContain('access-li-mkt-1');

      const channels = await s.call({ path: '/channels' });
      expect(channels.body.channels).toEqual([
        expect.objectContaining({ provider: 'linkedin', name: 'LinkedIn li-mkt-1', needs_reconnect: false }),
      ]);
      expect(JSON.stringify(channels.body)).not.toContain('access-li-mkt-1');

      // The trial connects one profile.
      const again = await s.call({ path: '/connect' });
      expect([again.status, again.body.error]).toEqual([402, 'channel_limit']);
    });

    // A custom-fields login (Bluesky) takes no verifier, so a state that is
    // not bound to its provider would add anyone's own account to this
    // subscriber's workspace.
    it("a connect link's state cannot finish a Bluesky login with someone else's credentials", async () => {
      const s = await subscriber('linkedin', 'trial');
      const link = await s.call({ path: '/connect' });
      const state = new URL(link.body.url).searchParams.get('state')!;
      const bluesky = jest.spyOn(provider('bluesky'), 'authenticate');
      const creds = Buffer.from(JSON.stringify({ service: 'https://bsky.social', identifier: 'intruder', password: 'pw' })).toString('base64');

      const forged = await t.api.post('/integrations/social-connect/bluesky', { code: creds, state, timezone: '0' });
      expect(forged.status).toBe(400);
      expect(bluesky).not.toHaveBeenCalled();
      expect((await s.call({ path: '/channels' })).body.channels).toEqual([]);

      // The state was not touched: the subscriber's own LinkedIn login still finishes.
      linkedinLogin('li-mkt-bound');
      const callback = await t.api.post('/integrations/social-connect/linkedin', { code: 'code-1', state, timezone: '0' });
      expect(callback.status).toBe(201);
      expect((await s.call({ path: '/channels' })).body.channels).toEqual([
        expect.objectContaining({ provider: 'linkedin', name: 'LinkedIn li-mkt-bound' }),
      ]);
    });

    it('an ordinary dashboard connect does not say marketplace', async () => {
      const owner = await t.api.register({ company: 'Ordinary workspace' });
      const { orgId } = await owner.self();
      await db().subscription.create({
        data: { organizationId: orgId, subscriptionTier: 'STANDARD', period: 'MONTHLY', totalChannels: 5, identifier: `sub_test_${orgId.slice(0, 8)}` },
      });
      const res = await owner.get('/integrations/social/linkedin');
      const state = new URL(res.body.url).searchParams.get('state')!;
      linkedinLogin('li-ordinary-1');
      const callback = await t.api.post('/integrations/social-connect/linkedin', { code: 'c', state, timezone: '0' });
      expect(callback.status).toBe(201);
      expect(callback.body.marketplace).toBeUndefined();
    });

    it('the Social trial cannot connect X, and nothing outside the product connects', async () => {
      const s = await subscriber('social', 'trial');
      const x = await s.call({ path: '/connect/x' });
      expect([x.status, x.body.error]).toEqual([402, 'plan_excludes_x']);
      for (const p of ['tiktok', 'bluesky', 'telegram', 'linkedin-page', 'nope']) {
        const res = await s.call({ path: `/connect/${p}` });
        expect([res.status, res.body.error]).toEqual([400, 'provider_not_available']);
      }
    });

    it('the X product connects X (request token stubbed)', async () => {
      jest.spyOn(provider('x'), 'generateAuthUrl').mockResolvedValue({
        url: 'https://api.x.com/oauth/authorize?oauth_token=tok-1',
        codeVerifier: 'tok-1:secret',
        state: 'tok-1',
      });
      const s = await subscriber('x', 'trial');
      const res = await s.call({ path: '/connect' });
      expect([res.status, res.body.url]).toEqual([200, 'https://api.x.com/oauth/authorize?oauth_token=tok-1']);
      expect(await ioRedis.get('organization:tok-1')).toBe(s.orgId);
      expect(await ioRedis.get('mkt:connect:tok-1')).toBe('x');
    });
  });

  // -------------------------------------------------------------------------
  describe('posting', () => {
    const later = (days = 1) => new Date(Date.now() + days * DAY).toISOString();

    it('Social: one post to LinkedIn and X, billed 1 + 2 per tweet, saved and handed to the orchestrator', async () => {
      const s = await subscriber('social', 'standard', ['linkedin', 'x']);
      const [li, x] = s.channels;
      const before = t.temporal.started.length;
      const res = await s.call({
        path: '/posts',
        body: {
          channels: [{ id: li.id }, { id: x.id }],
          content: [{ text: 'We shipped today.' }, { text: 'Details in the changelog.' }],
          schedule_at: later(),
        },
      });
      expect(res.status).toBe(200);
      expect(res.billing).toBe('API=5;');
      expect(res.body.credits_charged).toBe(5);
      expect(res.body.posts.map((p: any) => [p.provider, p.credits, p.status])).toEqual([
        ['linkedin', 1, 'scheduled'],
        ['x', 4, 'scheduled'],
      ]);
      const rows = await db().post.findMany({ where: { organizationId: s.orgId, deletedAt: null } });
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.creationMethod === 'API')).toBe(true);
      expect(t.temporal.started.length - before).toBe(2);
      const usage = await s.call({ path: '/usage' });
      expect(usage.body.credits_used).toBe(5);
    });

    it('X: a link is refused by default (400, nothing saved or billed), and 20 credits with allow', async () => {
      const s = await subscriber('x', 'basic', ['x']);
      const thread = (policy?: string) => ({
        channel_id: s.channels[0].id,
        tweets: [{ text: 'Thread time' }, { text: 'Read more at example.com/post' }],
        schedule_at: later(),
        ...(policy ? { link_policy: policy } : {}),
      });
      const refused = await s.call({ path: '/threads', body: thread() });
      expect([refused.status, refused.body.error, refused.billing]).toEqual([400, 'invalid_thread', 'API=0;']);
      expect(refused.body.tweets[1].has_link).toBe(true);
      expect(await db().post.count({ where: { organizationId: s.orgId } })).toBe(0);

      const allowed = await s.call({ path: '/threads', body: thread('allow') });
      expect([allowed.status, allowed.billing]).toEqual([200, 'API=22;']);
    });

    it('the Social trial refuses X posts, and so does the orchestrator for a post that got there anyway', async () => {
      const s = await subscriber('social', 'trial', ['x', 'linkedin']);
      const res = await s.call({
        path: '/posts',
        body: { channels: [{ id: s.channels[0].id }], content: [{ text: 'hi' }], schedule_at: 'now' },
      });
      expect([res.status, res.body.error]).toEqual([402, 'plan_excludes_x']);

      const subscriptions = t.get<SubscriptionService>(SubscriptionService);
      const publish = jest.fn(async () => 'posted');
      await expect(subscriptions.publishWithinPlan(s.orgId, publish, 'x')).rejects.toBeInstanceOf(MarketplacePublishRefusedError);
      expect(publish).not.toHaveBeenCalled();
      await expect(subscriptions.publishWithinPlan(s.orgId, publish, 'linkedin')).resolves.toBe('posted');
    });

    it('publishes through the orchestrator\'s activity: status published with the URL', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const res = await s.call({
        path: '/posts',
        body: { channel_id: s.channels[0].id, text: 'Hiring two engineers.', schedule_at: 'now' },
      });
      expect([res.status, res.billing]).toEqual([200, 'API=1;']);
      const id = res.body.posts[0].id;
      const { post } = stubPublish('linkedin');
      expect(await publishLikeTheWorkflow(t, s.orgId, id)).toEqual({ published: true });
      expect(post).toHaveBeenCalledTimes(1);
      const status = await s.call({ path: `/posts/${id}` });
      expect(status.body).toMatchObject({ id, status: 'published', url: 'https://linkedin.example/p/1', provider: 'linkedin' });
      const del = await s.call({ method: 'DELETE', path: `/posts/${id}` });
      expect([del.status, del.body.error]).toEqual([409, 'already_published']);
    });

    it('an X thread publishes each tweet as a reply and reports every URL', async () => {
      const s = await subscriber('x', 'pro', ['x']);
      const res = await s.call({
        path: '/threads',
        body: { channel_id: s.channels[0].id, tweets: [{ text: 'one' }, { text: 'two' }, { text: 'three' }], schedule_at: 'now', who_can_reply: 'following' },
      });
      expect(res.billing).toBe('API=6;');
      const { post, comment } = stubPublish('x');
      expect(await publishLikeTheWorkflow(t, s.orgId, res.body.posts[0].id)).toEqual({ published: true });
      expect(post).toHaveBeenCalledTimes(1);
      expect(comment).toHaveBeenCalledTimes(2);
      const status = await s.call({ path: `/threads/${res.body.posts[0].id}` });
      expect(status.body.status).toBe('published');
      expect(status.body.replies.map((r: any) => r.status)).toEqual(['published', 'published']);
      const settings = JSON.parse((await db().post.findUniqueOrThrow({ where: { id: res.body.posts[0].id } })).settings!);
      expect(settings).toMatchObject({ __type: 'x', who_can_reply_post: 'following', post_type: 'post' });
    });

    it('LinkedIn carousel post: images become media and the carousel settings are set', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const ids = [];
      for (const c of ['#111111', '#222222']) ids.push((await s.call({ path: '/media', form: imageForm(await png(300, 300, c)) })).body.id);
      const res = await s.call({
        path: '/carousels',
        body: { channel_id: s.channels[0].id, title: 'Two slides', images: ids, text: 'Swipe', schedule_at: later() },
      });
      expect([res.status, res.billing]).toEqual([200, 'API=1;']);
      const row = await db().post.findUniqueOrThrow({ where: { id: res.body.posts[0].id } });
      expect(JSON.parse(row.settings!)).toMatchObject({ post_as_images_carousel: true, carousel_name: 'Two slides' });
      expect(JSON.parse(row.image!)).toHaveLength(2);
    });

    it('a trial: 402 at 1.2x its credits (it never renews), nothing saved or billed, and the refusal says when the counter starts again', async () => {
      const s = await subscriber('linkedin', 'trial', ['linkedin']);
      const plan = marketplacePlan('linkedin', 'trial')!;
      expect(hardCreditCap(plan)).toBe(60);
      const window = quotaWindow(s.account.periodStart, new Date());
      await ioRedis.set(ledgerKeys.quota(s.account.id, s.account.periodStart, window.index), String(hardCreditCap(plan)), 'EX', 3600);
      const res = await s.call({ path: '/posts', body: { channel_id: s.channels[0].id, text: 'one more', schedule_at: later() } });
      expect([res.status, res.body.error, res.billing]).toEqual([402, 'quota_exceeded', 'API=0;']);
      expect(res.body.resets_at).toBe(window.end.toISOString());
      expect(res.body.message).toContain(window.end.toISOString());
      expect(res.body.message).not.toMatch(/month/i);
      expect(await db().post.count({ where: { organizationId: s.orgId } })).toBe(0);
    });

    it('a paid plan: never refused within 2x its credits in a window (two api.market months), logged once past 1.2x, 402 past 2x', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const plan = marketplacePlan('linkedin', 'creator')!;
      expect([plan.credits, alertCreditThreshold(plan), hardCreditCap(plan)]).toEqual([300, 360, 600]);
      const window = quotaWindow(s.account.periodStart, new Date());
      const key = ledgerKeys.quota(s.account.id, s.account.periodStart, window.index);
      const warn = jest.spyOn(Logger.prototype, 'warn');
      const alerts = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('mkt usage alert')).length;
      let n = 0;
      const post = () =>
        s.call({ path: '/posts', body: { channel_id: s.channels[0].id, text: `post ${++n}`, schedule_at: later() } });

      // The whole of one api.market month and some of the next, in one window.
      await ioRedis.set(key, '359', 'EX', 3600);
      expect((await post()).status).toBe(200);
      expect(alerts()).toBe(0);
      expect((await post()).status).toBe(200);
      expect(alerts()).toBe(1);
      expect(await ioRedis.ttl(ledgerKeys.quotaAlert(key))).toBeGreaterThan(0);
      expect((await post()).status).toBe(200);
      expect(alerts()).toBe(1);
      expect(warn.mock.calls.find((c) => String(c[0]).startsWith('mkt usage alert'))![0]).toContain(
        `account=${s.account.id}`
      );

      await ioRedis.set(key, '599', 'EX', 3600);
      expect((await post()).status).toBe(200);
      const over = await post();
      expect([over.status, over.body.error, over.billing]).toEqual([402, 'quota_exceeded', 'API=0;']);
      expect((await s.call({ path: '/usage' })).body.credits_used).toBe(600);
    });

    it('a repeated x-request-id creates exactly one post and answers the same; a reused Idempotency-Key bills 0', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const body = { channel_id: s.channels[0].id, text: 'Exactly once', schedule_at: later() };
      const first = await s.call({ path: '/posts', body, requestId: 'rid-once-1', headers: { 'idempotency-key': 'client-key-0001' } });
      const retry = await s.call({ path: '/posts', body, requestId: 'rid-once-1' });
      const again = await s.call({ path: '/posts', body, requestId: 'rid-once-2', headers: { 'idempotency-key': 'client-key-0001' } });
      expect([first.status, retry.status, again.status]).toEqual([200, 200, 200]);
      expect(retry.body).toEqual(first.body);
      expect(again.body).toEqual(first.body);
      expect([first.billing, retry.billing, again.billing]).toEqual(['API=1;', 'API=1;', 'API=0;']);
      expect(await db().post.count({ where: { organizationId: s.orgId, deletedAt: null } })).toBe(1);
    });

    it('the same text to the same channel twice in a day is a 409', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const body = { channel_id: s.channels[0].id, text: 'Same words', schedule_at: later() };
      expect((await s.call({ path: '/posts', body })).status).toBe(200);
      const dup = await s.call({ path: '/posts', body: { ...body, schedule_at: later(2) } });
      expect([dup.status, dup.body.error]).toEqual([409, 'duplicate_content']);
    });

    it('schedules within the plan\'s horizon only', async () => {
      const s = await subscriber('social', 'trial', ['linkedin']);
      const res = await s.call({ path: '/posts', body: { channels: [{ id: s.channels[0].id }], content: [{ text: 'far' }], schedule_at: later(8) } });
      expect([res.status, res.body.error]).toEqual([400, 'schedule_out_of_range']);
    });

    it('YouTube: one upload a day on a trial, 20 a day across every workspace', async () => {
      const s = await subscriber('social', 'trial', ['youtube']);
      const video = await db().media.create({
        data: { organizationId: s.orgId, name: 'clip.mp4', path: 'https://media.example.com/clip.mp4', type: 'video', fileSize: 1000 },
      });
      const post = (text: string, days = 1) =>
        s.call({
          path: '/posts',
          body: {
            channels: [{ id: s.channels[0].id, settings: { title: 'My clip', type: 'public' } }],
            content: [{ text, media_ids: [video.id] }],
            schedule_at: later(days),
          },
        });
      expect((await post('first')).status).toBe(200);
      const second = await post('second');
      expect([second.status, second.body.error]).toEqual([429, 'youtube_daily_limit']);
      // The marketplace-wide cap, for another day.
      const day = later(3).slice(0, 10);
      await ioRedis.set(ledgerKeys.youtubeAll(day), '20', 'EX', 3600);
      const third = await post('third', 3);
      expect([third.status, third.body.error]).toEqual([429, 'youtube_daily_limit']);
    });

    it('the X trial shares a daily budget; past it trial X posts get 503 trial_capacity', async () => {
      process.env.MKT_TRIAL_X_DAILY_USD = '0.02';
      try {
        const a = await subscriber('x', 'trial', ['x']);
        const b = await subscriber('x', 'trial', ['x']);
        const day = later(4);
        const first = await a.call({ path: '/threads', body: { channel_id: a.channels[0].id, tweets: [{ text: 'trial tweet a' }], schedule_at: day } });
        expect(first.status).toBe(200);
        const second = await b.call({ path: '/threads', body: { channel_id: b.channels[0].id, tweets: [{ text: 'trial tweet b' }], schedule_at: day } });
        expect([second.status, second.body.error, second.billing]).toEqual([503, 'trial_capacity', 'API=0;']);
      } finally {
        process.env.MKT_TRIAL_X_DAILY_USD = '';
      }
    });

    describe('the Social trial is for testing (owner, 26 Oct 2026): 10 credits, 1 channel, 50 MB', () => {
      const MB = 1024 * 1024;
      const until = PRIOR_PLAN_LIMITS['social:trial'].until;
      const post = (s: Awaited<ReturnType<typeof subscriber>>, ids: string[], text: string) =>
        s.call({ path: '/posts', body: { channels: ids.map((id) => ({ id })), content: [{ text }], schedule_at: later() } });

      it('a new Free subscriber: /usage says 10 credits, 1 channel, 50 MB; a second channel cannot connect', async () => {
        const s = await subscriber('social', 'trial', ['linkedin']);
        const usage = await s.call({ path: '/usage', headers: { 'x-hookpost-plan': undefined, 'x-magicapi-plan': 'Free' } });
        expect(usage.status).toBe(200);
        expect(usage.body).toMatchObject({ plan: 'trial', credits_included: 10, channels_included: 1, storage_included_bytes: 50 * MB, x_included: false });
        const again = await s.call({ path: '/connect/threads' });
        expect([again.status, again.body.error, again.billing]).toEqual([402, 'channel_limit', 'API=0;']);
        expect(again.body.message).toMatch(/up to 1 channel\./);
      });

      it('refused past 12 credits (1.2x of 10), nothing saved or billed', async () => {
        const s = await subscriber('social', 'trial', ['linkedin']);
        const window = quotaWindow(s.account.periodStart, new Date());
        const key = ledgerKeys.quota(s.account.id, s.account.periodStart, window.index);
        await ioRedis.set(key, '11', 'EX', 3600);
        const last = await post(s, [s.channels[0].id], 'the twelfth credit');
        expect([last.status, last.billing]).toEqual([200, 'API=1;']);
        const over = await post(s, [s.channels[0].id], 'one too many');
        expect([over.status, over.body.error, over.billing]).toEqual([402, 'quota_exceeded', 'API=0;']);
        expect(await db().post.count({ where: { organizationId: s.orgId, deletedAt: null } })).toBe(1);
      });

      it('storage: 50 MB on the new trial', async () => {
        const s = await subscriber('social', 'trial');
        await db().media.create({
          data: { organizationId: s.orgId, name: 'mid.mp4', path: 'https://media.example.com/mid.mp4', type: 'video', fileSize: 50 * MB },
        });
        const res = await s.call({ path: '/media', form: imageForm(await png(10, 10)) });
        expect([res.status, res.body.error]).toEqual([402, 'storage_quota_exceeded']);
      });

      it('a new trial workspace over 1 channel cannot post (402 channel_limit) until one is removed', async () => {
        const s = await subscriber('social', 'trial', ['linkedin', 'threads']);
        const res = await post(s, [s.channels[0].id], 'two channels on the new trial');
        expect([res.status, res.body.error, res.billing]).toEqual([402, 'channel_limit', 'API=0;']);
        const del = await s.call({ method: 'DELETE', path: `/channels/${s.channels[1].id}` });
        expect(del.status).toBe(200);
        const ok = await post(s, [s.channels[0].id], 'one channel now');
        expect([ok.status, ok.billing]).toEqual([200, 'API=1;']);
      });

      // An account whose window began before the change. Its window must
      // still be open, which is true until 28 days after the change; after
      // that no such window exists and the unit tests cover the rule.
      const priorWindowOpen = Date.now() < until.getTime() + 27 * 86_400_000;
      (priorWindowOpen ? it : it.skip)(
        'a subscriber whose window began before the change keeps 100 credits, 2 channels and 250 MB to its end',
        async () => {
          const s = await subscriber('social', 'trial', ['linkedin', 'threads']);
          const periodStart = new Date(until.getTime() - 3_600_000);
          await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { periodStart } });
          const usage = await s.call({ path: '/usage' });
          expect(usage.body).toMatchObject({ plan: 'trial', credits_included: 100, channels_included: 2, storage_included_bytes: 250 * MB });
          // Both channels keep posting: 2 credits, well past the new trial's 1 channel.
          const both = await post(s, s.channels.map((c) => c.id), 'still on the old trial');
          expect([both.status, both.billing]).toEqual([200, 'API=2;']);
          // The old cap holds: 120 credits.
          const window = quotaWindow(periodStart, new Date());
          await ioRedis.set(ledgerKeys.quota(s.account.id, periodStart, window.index), '100', 'EX', 3600);
          const past12 = await post(s, [s.channels[0].id], 'credit 101');
          expect([past12.status, past12.billing]).toEqual([200, 'API=1;']);
          await ioRedis.set(ledgerKeys.quota(s.account.id, periodStart, window.index), '120', 'EX', 3600);
          const over = await post(s, [s.channels[0].id], 'credit 121');
          expect([over.status, over.body.error]).toEqual([402, 'quota_exceeded']);
        }
      );

      it("the same subscriber's next window has the new limits, and nothing is deleted", async () => {
        const s = await subscriber('social', 'trial', ['linkedin', 'threads']);
        // Its second window began a minute ago, after the change.
        const periodStart = new Date(Date.now() - 28 * 86_400_000 - 60_000);
        await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { periodStart } });
        const usage = await s.call({ path: '/usage' });
        expect(usage.body).toMatchObject({ plan: 'trial', credits_included: 10, channels_included: 1, channels_used: 2 });
        const res = await post(s, [s.channels[0].id], 'next window');
        expect([res.status, res.body.error]).toEqual([402, 'channel_limit']);
        expect((await s.call({ path: '/channels' })).body.channels).toHaveLength(2);
      });
    });

    it('storage: an upload over the plan\'s storage is a 402', async () => {
      const s = await subscriber('x', 'trial');
      await db().media.create({
        data: { organizationId: s.orgId, name: 'big.mp4', path: 'https://media.example.com/big.mp4', type: 'video', fileSize: 250 * 1024 * 1024 },
      });
      const res = await s.call({ path: '/media', form: imageForm(await png(10, 10)) });
      expect([res.status, res.body.error]).toEqual([402, 'storage_quota_exceeded']);
    });

    it('a post can be cancelled before it publishes', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const res = await s.call({ path: '/posts', body: { channel_id: s.channels[0].id, text: 'to cancel', schedule_at: later() } });
      const del = await s.call({ method: 'DELETE', path: `/posts/${res.body.posts[0].id}` });
      expect([del.status, del.body.deleted, del.billing]).toEqual([200, true, 'API=0;']);
      expect((await s.call({ path: `/posts/${res.body.posts[0].id}` })).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  describe('isolation', () => {
    it('subscriber B gets 404 on A\'s posts, channels and media, and never sees A\'s ids', async () => {
      const a = await subscriber('social', 'standard', ['linkedin']);
      const b = await subscriber('social', 'standard', ['linkedin']);
      const media = await a.call({ path: '/media', form: imageForm(await png(20, 20)) });
      const post = await a.call({
        path: '/posts',
        body: { channels: [{ id: a.channels[0].id }], content: [{ text: 'A only', media_ids: [media.body.id] }], schedule_at: 'draft' },
      });
      expect(post.status).toBe(200);
      const postId = post.body.posts[0].id;

      const tries = [
        await b.call({ path: `/posts/${postId}` }),
        await b.call({ method: 'DELETE', path: `/posts/${postId}` }),
        await b.call({ method: 'DELETE', path: `/channels/${a.channels[0].id}` }),
        await b.call({ path: `/slots/${a.channels[0].id}` }),
        await b.call({ path: '/posts', body: { channels: [{ id: a.channels[0].id }], content: [{ text: 'x' }], schedule_at: 'draft' } }),
        await b.call({ path: '/posts', body: { channels: [{ id: b.channels[0].id }], content: [{ text: 'x', media_ids: [media.body.id] }], schedule_at: 'draft' } }),
      ];
      expect(tries.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
      for (const r of tries) {
        expect(JSON.stringify(r.body)).not.toContain(a.orgId);
      }
      const list = await b.call({ path: '/posts', headers: {} });
      expect(JSON.stringify(list.body)).not.toContain(postId);
      expect((await a.call({ path: `/posts/${postId}` })).status).toBe(200);
    });

    // Review 25 Oct: the Hookpost bot is in every server that added it, and
    // a Discord post went to whatever settings.channel named.
    it('Discord: a trial buyer cannot post into another server\'s channel (400 channel_not_in_server), nothing saved or billed', async () => {
      const s = await subscriber('social', 'trial', ['discord']);
      const server = s.channels[0].internalId;
      const lookups = discordChannels({
        [OWN_DISCORD_CHANNEL]: server,
        [FOREIGN_DISCORD_CHANNEL]: FOREIGN_DISCORD_SERVER,
      });
      const post = (channel: string, path = '/posts') =>
        s.call({
          path,
          body: {
            channels: [{ id: s.channels[0].id, settings: { channel } }],
            content: [{ text: `@everyone hello from ${channel.length}` }],
            schedule_at: 'now',
          },
        });

      const started = t.temporal.started.length;
      for (const channel of [FOREIGN_DISCORD_CHANNEL, '1500000000000000005', `${FOREIGN_DISCORD_CHANNEL}/messages`, `../guilds/${FOREIGN_DISCORD_SERVER}`]) {
        const refused = await post(channel);
        expect([refused.status, refused.body.error, refused.billing]).toEqual([400, 'channel_not_in_server', 'API=0;']);
        expect(refused.body.channel_id).toBe(s.channels[0].id);
      }
      const dryRun = await post(FOREIGN_DISCORD_CHANNEL, '/posts/validate');
      expect([dryRun.status, dryRun.body.error]).toEqual([400, 'channel_not_in_server']);
      expect(await db().post.count({ where: { organizationId: s.orgId } })).toBe(0);
      expect(t.temporal.started.length).toBe(started);
      expect((await s.call({ path: '/usage' })).body.credits_used).toBe(0);
      // Only real ids were looked up, each with the bot token, never a path.
      expect(lookups.map((l) => l.channel)).toEqual([FOREIGN_DISCORD_CHANNEL, '1500000000000000005', FOREIGN_DISCORD_CHANNEL]);
      expect(lookups.every((l) => l.auth === 'Bot discord-bot-test')).toBe(true);

      const ok = await post(OWN_DISCORD_CHANNEL);
      expect([ok.status, ok.billing]).toEqual([200, 'API=1;']);
    });

    it('Discord: the orchestrator refuses a saved post whose channel is in another server, for every path, and sends nothing', async () => {
      const s = await subscriber('social', 'standard', ['discord']);
      const server = s.channels[0].internalId;
      discordChannels({ [OWN_DISCORD_CHANNEL]: server, [FOREIGN_DISCORD_CHANNEL]: FOREIGN_DISCORD_SERVER });
      const res = await s.call({
        path: '/posts',
        body: { channels: [{ id: s.channels[0].id, settings: { channel: OWN_DISCORD_CHANNEL } }], content: [{ text: 'Release notes are out' }], schedule_at: 'now' },
      });
      expect(res.status).toBe(200);
      const id = res.body.posts[0].id;
      const setChannel = async (channel: string) => {
        const row = await db().post.findUniqueOrThrow({ where: { id } });
        await db().post.update({
          where: { id },
          data: { state: 'QUEUE', error: null, settings: JSON.stringify({ ...JSON.parse(row.settings!), channel }) },
        });
      };
      const sent: string[] = [];
      jest.spyOn(provider('discord'), 'getSsrfSafeAxios').mockReturnValue({
        post: async (url: string) => {
          sent.push(url);
          return { data: { id: `${sent.length}` } };
        },
      } as any);

      // As the dashboard or the public API could have saved it.
      await setChannel(FOREIGN_DISCORD_CHANNEL);
      const refused = await publishLikeTheWorkflow(t, s.orgId, id);
      expect(refused.published).toBe(false);
      expect(refused.error).toMatch(/not in the server this channel is connected to/);
      expect(sent).toEqual([]);
      expect((await db().post.findUniqueOrThrow({ where: { id } })).state).toBe('ERROR');

      await setChannel(OWN_DISCORD_CHANNEL);
      expect(await publishLikeTheWorkflow(t, s.orgId, id)).toEqual({ published: true });
      expect(sent).toEqual([`https://discord.com/api/channels/${OWN_DISCORD_CHANNEL}/messages`]);
    });
  });

  // -------------------------------------------------------------------------
  describe('the ledger against Redis', () => {
    const later = (days = 1) => new Date(Date.now() + days * DAY).toISOString();

    it('50 parallel holds against a cap of 20: exactly 20 succeed, refunds give back', async () => {
      const ledger = t.get<MarketplaceLedger>(MarketplaceLedger);
      const key = `mkt:q:test-parallel:${Date.now()}`;
      const hold = { key, amount: 1, cap: 20, ttlSeconds: 60, reason: 'quota_exceeded' };
      const results = await Promise.all(Array.from({ length: 50 }, () => ledger.reserve([hold])));
      expect(results.filter((r) => r.ok)).toHaveLength(20);
      expect(await ledger.used(key)).toBe(20);
      await ledger.refund([{ ...hold, amount: 5 }]);
      expect(await ledger.used(key)).toBe(15);
      await ledger.refund([{ ...hold, amount: 100 }]);
      expect(await ledger.used(key)).toBe(0);
    });

    it('holds several caps all or nothing', async () => {
      const ledger = t.get<MarketplaceLedger>(MarketplaceLedger);
      const a = { key: `mkt:test:a:${Date.now()}`, amount: 3, cap: 10, ttlSeconds: 60, reason: 'a' };
      const b = { key: `mkt:test:b:${Date.now()}`, amount: 3, cap: 2, ttlSeconds: 60, reason: 'b' };
      const res = await ledger.reserve([a, b]);
      expect(res).toEqual({ ok: false, failed: b });
      expect(await ledger.used(a.key)).toBe(0);
    });

    it('a new 28-day window starts from zero', async () => {
      const s = await subscriber('linkedin', 'trial', ['linkedin']);
      const start = new Date(Date.now() - 29 * DAY);
      await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { periodStart: start } });
      // Window 0 of this period is full; now is in window 1.
      await ioRedis.set(ledgerKeys.quota(s.account.id, start, 0), '60', 'EX', 3600);
      const res = await s.call({ path: '/posts', body: { channel_id: s.channels[0].id, text: 'new window', schedule_at: later() } });
      expect(res.status).toBe(200);
      expect(await ioRedis.get(ledgerKeys.quota(s.account.id, start, 1))).toBe('1');
    });
  });

  // -------------------------------------------------------------------------
  describe('daily upkeep', () => {
    it('an account unseen for 40 days goes dormant, its scheduled posts are cancelled, and a call wakes it', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const res = await s.call({
        path: '/posts',
        body: { channel_id: s.channels[0].id, text: 'scheduled far', schedule_at: new Date(Date.now() + 20 * DAY).toISOString() },
      });
      await db().marketplaceAccount.update({ where: { id: s.account.id }, data: { lastSeenAt: new Date(Date.now() - 41 * DAY) } });
      const service = t.get<MarketplaceAccountService>(MarketplaceAccountService);
      const out = await service.sweepDormant(new Date());
      expect(out.accounts).toBeGreaterThanOrEqual(1);
      expect((await account(s.user, 'linkedin'))!.status).toBe('DORMANT');
      expect((await db().post.findUniqueOrThrow({ where: { id: res.body.posts[0].id } })).deletedAt).not.toBeNull();
      await s.call({ path: '/usage' });
      expect((await account(s.user, 'linkedin'))!.status).toBe('ACTIVE');
    });

    it('media older than 45 days is removed, except what a scheduled post still uses', async () => {
      const s = await subscriber('linkedin', 'creator', ['linkedin']);
      const old = await s.call({ path: '/media', form: imageForm(await png(30, 30, '#abcdef')) });
      const kept = await s.call({ path: '/media', form: imageForm(await png(31, 31, '#fedcba')) });
      await s.call({ path: '/posts', body: { channel_id: s.channels[0].id, text: 'uses kept', media_ids: [kept.body.id], schedule_at: new Date(Date.now() + DAY).toISOString() } });
      await db().media.updateMany({ where: { id: { in: [old.body.id, kept.body.id] } }, data: { createdAt: new Date(Date.now() - 46 * DAY) } });
      await t.get<MarketplaceAccountService>(MarketplaceAccountService).purgeMedia(new Date());
      expect((await db().media.findUniqueOrThrow({ where: { id: old.body.id } })).deletedAt).not.toBeNull();
      expect((await db().media.findUniqueOrThrow({ where: { id: kept.body.id } })).deletedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  it('the probe reports what is forwarded without echoing a value', async () => {
    const res = await fetch(`${t.baseUrl}/mkt/v1/social/_probe?bill=3&status=201`, {
      headers: {
        'x-hookpost-gateway': GATEWAY_SECRET.social,
        'x-hookpost-plan': planToken('social', 'trial'),
        'x-magicapi-user': 'cll8kolno0000l808v6p3xvax',
        'x-magicapi-plan': 'Private',
        authorization: 'Bearer forwarded-client-key',
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-magicapi-billing')).toBe('API=3;');
    const body = await res.json();
    expect(body).toMatchObject({
      authorization_present: true,
      x_magicapi_plan: 'Private',
      subscriber: { present: true, valid_shape: true, values: 1 },
      plan_token: { present: true, known: true },
      magicapi_plan: { present: true, values: 1, maps_to: null },
    });
    const pro = await fetch(`${t.baseUrl}/mkt/v1/social/_probe`, {
      headers: { 'x-hookpost-gateway': GATEWAY_SECRET.social, 'x-magicapi-plan': ' pro ' },
    });
    expect((await pro.json()).magicapi_plan).toMatchObject({ values: 1, maps_to: 'pro' });
    const text = JSON.stringify(body);
    for (const secret of [GATEWAY_SECRET.social, planToken('social', 'trial'), 'forwarded-client-key', 'cll8kolno0000l808v6p3xvax']) {
      expect(text).not.toContain(secret);
    }
    const noSecret = await fetch(`${t.baseUrl}/mkt/v1/social/_probe`);
    expect(noSecret.status).toBe(401);
  });
});
