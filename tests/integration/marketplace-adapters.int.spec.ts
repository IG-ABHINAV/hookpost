/**
 * One gateway, three kinds of marketplace (marketplace.adapters.ts), on the
 * real backend, Postgres and Redis: api.market (setup/marketplace.ts),
 * RapidAPI and a keyed marketplace (setup/marketplace-adapters.ts). For each:
 * a valid call, spoofed headers, a missing or wrong secret, a plan it does
 * not sell, its billing header, and the quota. Then the adversarial pass:
 * nothing one marketplace's buyer sends reaches another marketplace's
 * subscriber, workspace, idempotency record or plan. Then the admin
 * Marketplaces numbers (GET /admin/marketplaces) and the source of every
 * workspace.
 *
 * The database is shared with the other files of a run, so the admin numbers
 * are checked as differences.
 *
 *   pnpm exec jest -c tests/integration/jest.config.ts marketplace-adapters
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, makeSuperAdmin } from './setup/db';
import { Gateway, GATEWAY_SECRET, marketplaceEnv, newSubscriber, Product } from './setup/marketplace';
import {
  KeyedGateway,
  marketplaceAdaptersEnv,
  newRapidUser,
  RAPIDAPI_SECRET,
  RapidGateway,
  ZYLA_SECRET,
} from './setup/marketplace-adapters';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { ledgerKeys } from '@hookpost/backend/marketplace-api/marketplace.ledger';
import { MarketplaceUsageService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';
import { hardCreditCap, marketplacePlan, quotaWindow } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

const CHECK = { text: 'hello world', platforms: ['x'], media: [] };

describe('marketplace adapters (/mkt/v1 through api.market, RapidAPI and a keyed marketplace)', () => {
  let t: TestApp;
  let api: Gateway;
  let rapid: RapidGateway;
  let keyed: KeyedGateway;
  let admin: Session;
  const saved: Record<string, string | undefined> = {};

  const account = (marketplace: string, externalUserId: string, product: Product) =>
    db().marketplaceAccount.findUnique({
      where: { marketplace_externalUserId_product: { marketplace, externalUserId, product } },
    });
  const accountsOf = (externalUserId: string) =>
    db().marketplaceAccount.findMany({ where: { externalUserId }, orderBy: { marketplace: 'asc' } });
  const overview = async () => {
    const res = await admin.get('/admin/marketplaces');
    expect(res.status).toBe(200);
    return res.body;
  };
  const rowOf = (o: any, id: string) => o.marketplaces.find((m: any) => m.id === id);

  beforeAll(async () => {
    const env = { ...marketplaceEnv(), ...marketplaceAdaptersEnv() };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await startApp();
    api = new Gateway(t.baseUrl);
    rapid = new RapidGateway(t.baseUrl);
    keyed = new KeyedGateway(t.baseUrl);
    admin = await t.api.register({ company: 'Marketplaces HQ' });
    await makeSuperAdmin((await admin.self()).id);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.close();
    await disconnectDb();
  });

  // -------------------------------------------------------------------------
  describe('api.market, unchanged', () => {
    it('bills in X-Magicapi-Billing only, and keeps its identifier and workspace name', async () => {
      const user = newSubscriber();
      const res = await api.call({ product: 'validate', plan: 'trial', user, path: '/check', body: CHECK });
      expect([res.status, res.billing]).toEqual([200, 'API=1;']);
      expect(res.headers.get('x-rapidapi-billing')).toBeNull();
      const acc = (await account('API_MARKET', user, 'validate'))!;
      const org = await db().organization.findUniqueOrThrow({
        where: { id: acc.organizationId },
        include: { subscription: true },
      });
      expect(org.source).toBe('API_MARKET');
      expect(org.name).toMatch(/^api\.market subscriber [0-9a-f]{8}$/);
      expect(org.subscription!.identifier).toBe(`apimkt:validate:${user}`);
    });

    it('answers a call that names no marketplace as before: 401 "through api.market", API=0', async () => {
      const res = await fetch(`${t.baseUrl}/mkt/v1/social/usage`, {
        headers: { 'x-magicapi-user': newSubscriber(), 'x-rapidapi-user': 'someone' },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('x-magicapi-billing')).toBe('API=0;');
      expect(await res.json()).toEqual({ error: 'unauthorized', message: 'Call this API through api.market.' });
    });
  });

  // -------------------------------------------------------------------------
  describe('RapidAPI', () => {
    it('a valid call: its own workspace and source, X-RapidAPI-Billing Credits=N, no api.market header', async () => {
      const user = newRapidUser();
      const rules = await rapid.call({ product: 'validate', user, subscription: 'BASIC', path: '/rules' });
      expect(rules.status).toBe(200);
      expect(rules.headers.get('x-rapidapi-billing')).toBe('Credits=0');
      expect(rules.headers.get('x-magicapi-billing')).toBeNull();
      const check = await rapid.call({ product: 'validate', user, subscription: 'BASIC', path: '/check', body: CHECK });
      expect(check.status).toBe(200);
      expect(check.headers.get('x-rapidapi-billing')).toBe('Credits=1');

      const acc = (await account('RAPIDAPI', user, 'validate'))!;
      expect(acc).toMatchObject({ plan: 'trial', status: 'ACTIVE' });
      const org = await db().organization.findUniqueOrThrow({
        where: { id: acc.organizationId },
        include: { subscription: true, users: true },
      });
      expect(org.source).toBe('RAPIDAPI');
      expect(org.name).toMatch(/^RapidAPI subscriber [0-9a-f]{8}$/);
      expect(org.apiKey).toBeNull();
      expect(org.users).toHaveLength(0);
      expect(org.subscription!.identifier).toBe(`apimkt:validate:rapidapi:${user}`);
    });

    it('maps X-RapidAPI-Subscription to the plan, and moves the account when it changes', async () => {
      const user = newRapidUser();
      const basic = await rapid.call({ product: 'social', user, subscription: 'BASIC', path: '/usage' });
      expect(basic.body).toMatchObject({ plan: 'trial' });
      expect(basic.body.note).toBe('RapidAPI bills and limits your plan; these are our own counters.');
      const pro = await rapid.call({ product: 'social', user, subscription: 'PRO', path: '/usage' });
      expect(pro.body).toMatchObject({ plan: 'standard', channels_included: 5 });
      const ultra = await rapid.call({ product: 'social', user, subscription: 'ULTRA', path: '/usage' });
      expect(ultra.body).toMatchObject({ plan: 'pro' });
      expect((await account('RAPIDAPI', user, 'social'))!.plan).toBe('pro');
    });

    it('refuses a missing or wrong proxy secret (401) and spoofed buyer headers without one, creating nothing', async () => {
      const user = newRapidUser();
      const cases: [Record<string, string | undefined>, string][] = [
        [{ 'x-rapidapi-proxy-secret': 'wrong-proxy-secret-0123456789abcdef' }, 'Call this API through RapidAPI.'],
        [{ 'x-rapidapi-proxy-secret': '' }, 'Call this API through RapidAPI.'],
        [{ 'x-rapidapi-proxy-secret': RAPIDAPI_SECRET.linkedin }, 'Call this API through RapidAPI.'],
        [{ 'x-rapidapi-proxy-secret': GATEWAY_SECRET.social }, 'Call this API through RapidAPI.'],
        [{ 'x-rapidapi-proxy-secret': undefined }, 'Call this API through api.market.'],
      ];
      for (const [headers, message] of cases) {
        const res = await rapid.call({ product: 'social', user, subscription: 'MEGA', path: '/usage', headers });
        expect([res.status, res.body]).toEqual([401, { error: 'unauthorized', message }]);
        if (headers['x-rapidapi-proxy-secret'] !== undefined) {
          expect(res.headers.get('x-rapidapi-billing')).toBe('Credits=0');
          expect(res.headers.get('x-magicapi-billing')).toBeNull();
        }
      }
      expect(await accountsOf(user)).toEqual([]);
    });

    it('refuses a plan it does not sell (403), a bad user (400) and an Authorization header (400), creating nothing', async () => {
      const user = newRapidUser();
      for (const subscription of ['CUSTOM', 'GOLD', '']) {
        const res = await rapid.call({ product: 'social', user, subscription, path: '/usage' });
        expect([res.status, res.body.error]).toEqual([403, 'unknown_plan']);
      }
      for (const bad of ['', 'two words', 'a/b', 'x'.repeat(65)]) {
        const res = await rapid.call({ product: 'social', user: bad, subscription: 'PRO', path: '/usage' });
        expect([res.status, res.body.error]).toEqual([400, 'invalid_subscriber']);
      }
      const auth = await rapid.call({ product: 'social', user, subscription: 'PRO', path: '/usage', headers: { authorization: 'Bearer hp_key' } });
      expect([auth.status, auth.body.error]).toEqual([400, 'authorization_not_accepted']);
      expect(auth.body.message).toContain('X-RapidAPI-Key');
      expect(await accountsOf(user)).toEqual([]);
    });

    it('has no launch probe', async () => {
      const res = await rapid.call({ product: 'social', user: newRapidUser(), subscription: 'PRO', path: '/_probe' });
      expect(res.status).toBe(404);
    });

    it('quota: 402 at the plan\'s cap, Credits=0, nothing billed', async () => {
      const user = newRapidUser();
      expect((await rapid.call({ product: 'validate', user, subscription: 'BASIC', path: '/rules' })).status).toBe(200);
      const acc = (await account('RAPIDAPI', user, 'validate'))!;
      const window = quotaWindow(acc.periodStart, new Date());
      await ioRedis.set(
        ledgerKeys.quota(acc.id, acc.periodStart, window.index),
        String(hardCreditCap(marketplacePlan('validate', 'trial')!)),
        'EX',
        3600
      );
      const res = await rapid.call({ product: 'validate', user, subscription: 'BASIC', path: '/check', body: CHECK });
      expect([res.status, res.body.error]).toEqual([402, 'quota_exceeded']);
      expect(res.headers.get('x-rapidapi-billing')).toBe('Credits=0');
    });

    it('repeats: a buyer\'s own x-request-id is not trusted, an Idempotency-Key replays and bills 0', async () => {
      const user = newRapidUser();
      const one = await rapid.call({ product: 'validate', user, subscription: 'PRO', path: '/check', body: CHECK, headers: { 'x-request-id': 'buyer-rid-1' } });
      const two = await rapid.call({ product: 'validate', user, subscription: 'PRO', path: '/check', body: CHECK, headers: { 'x-request-id': 'buyer-rid-1' } });
      expect([one.headers.get('x-rapidapi-billing'), two.headers.get('x-rapidapi-billing')]).toEqual(['Credits=1', 'Credits=1']);
      expect(two.headers.get('idempotent-replay')).toBeNull();
      const k1 = await rapid.call({ product: 'validate', user, subscription: 'PRO', path: '/check', body: CHECK, headers: { 'idempotency-key': 'rapid-key-0001' } });
      const k2 = await rapid.call({ product: 'validate', user, subscription: 'PRO', path: '/check', body: CHECK, headers: { 'idempotency-key': 'rapid-key-0001' } });
      expect(k1.headers.get('x-rapidapi-billing')).toBe('Credits=1');
      expect([k2.status, k2.headers.get('x-rapidapi-billing'), k2.headers.get('idempotent-replay')]).toEqual([200, 'Credits=0', 'true']);
    });
  });

  // -------------------------------------------------------------------------
  describe('a keyed marketplace', () => {
    it('a valid call: its plan names, its buyer header, its own billing header and source', async () => {
      const user = `buyer-${Date.now()}@example.com`;
      const usage = await keyed.zyla({ product: 'social', user, plan: 'Pro', path: '/usage' });
      expect([usage.status, usage.body.plan, usage.headers.get('x-zyla-units')]).toEqual([200, 'standard', '0']);
      expect(usage.headers.get('x-magicapi-billing')).toBeNull();
      const check = await keyed.zyla({ product: 'validate', user, plan: 'Basic', path: '/check', body: CHECK });
      expect([check.status, check.headers.get('x-zyla-units')]).toEqual([200, '1']);
      const acc = (await account('ZYLA', user, 'social'))!;
      const org = await db().organization.findUniqueOrThrow({ where: { id: acc.organizationId }, include: { subscription: true } });
      expect(org.source).toBe('ZYLA');
      expect(org.subscription!.identifier).toBe(`apimkt:social:zyla:${user}`);
    });

    it('refuses a wrong key, another marketplace\'s key, a product it does not sell, an unknown name; 403 an unknown plan; 400 no buyer', async () => {
      const user = `buyer-${Date.now()}-x`;
      for (const key of ['wrong-zyla-key-0123456789abcdef0123456789', ZYLA_SECRET.validate, RAPIDAPI_SECRET.social, GATEWAY_SECRET.social]) {
        const res = await keyed.zyla({ product: 'social', user, plan: 'Pro', path: '/usage', headers: { 'x-hookpost-marketplace-key': key } });
        expect([res.status, res.body.message]).toEqual([401, 'Call this API through Zyla API Hub.']);
      }
      const linkedin = await keyed.zyla({ product: 'linkedin', user, plan: 'Pro', path: '/usage' });
      expect(linkedin.status).toBe(401);
      const unknown = await keyed.zyla({ product: 'social', user, plan: 'Pro', path: '/usage', headers: { 'x-hookpost-marketplace': 'eden' } });
      expect([unknown.status, unknown.body.message]).toEqual([401, 'Call this API through api.market.']);
      const plan = await keyed.zyla({ product: 'social', user, plan: 'Enterprise', path: '/usage' });
      expect([plan.status, plan.body.error]).toEqual([403, 'unknown_plan']);
      const nobody = await keyed.zyla({ product: 'social', user, plan: 'Pro', path: '/usage', headers: { 'x-zyla-user': undefined } });
      expect([nobody.status, nobody.body.error]).toEqual([400, 'invalid_subscriber']);
      expect(await accountsOf(user)).toEqual([]);
    });

    it('without a buyer header: the validator only, one shared subscriber; Social is refused', async () => {
      const check = await keyed.shared({ product: 'validate', path: '/check', body: CHECK });
      expect(check.status).toBe(200);
      expect(await account('SHAREDHUB', 'shared', 'validate')).toMatchObject({ plan: 'starter' });
      const social = await keyed.shared({ product: 'social', path: '/usage' });
      expect([social.status, social.body.error]).toEqual([400, 'invalid_subscriber']);
      expect(await account('SHAREDHUB', 'shared', 'social')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('isolation between marketplaces and subscribers (adversarial)', () => {
    it('the same buyer id on api.market and RapidAPI is two accounts, two workspaces; channels never cross', async () => {
      const id = newSubscriber(); // a cuid: valid as an api.market and as a RapidAPI user
      expect((await api.call({ product: 'social', plan: 'trial', user: id, path: '/usage' })).status).toBe(200);
      expect((await rapid.call({ product: 'social', user: id, subscription: 'PRO', path: '/usage' })).status).toBe(200);
      const [apiAcc, rapidAcc] = [await account('API_MARKET', id, 'social'), await account('RAPIDAPI', id, 'social')];
      expect(apiAcc!.organizationId).not.toBe(rapidAcc!.organizationId);
      expect([apiAcc!.plan, rapidAcc!.plan]).toEqual(['trial', 'standard']);

      await addChannel(apiAcc!.organizationId, 'discord');
      const apiChannels = await api.call({ product: 'social', plan: 'trial', user: id, path: '/channels' });
      const rapidChannels = await rapid.call({ product: 'social', user: id, subscription: 'PRO', path: '/channels' });
      expect(apiChannels.body.channels ?? apiChannels.body).toHaveLength(1);
      expect(rapidChannels.body.channels ?? rapidChannels.body).toHaveLength(0);
    });

    it('two marketplaces\' markers on one call are refused (401), whatever the secrets, and nothing is made', async () => {
      const id = newSubscriber();
      const both = await rapid.call({
        product: 'social',
        user: id,
        subscription: 'PRO',
        path: '/usage',
        headers: { 'x-hookpost-gateway': GATEWAY_SECRET.social, 'x-hookpost-plan': 'x', 'x-magicapi-user': id },
      });
      expect([both.status, both.body.message]).toEqual([401, 'Call this API through one marketplace.']);
      const keyedToo = await api.call({
        product: 'social',
        plan: 'trial',
        user: id,
        path: '/usage',
        headers: { 'x-hookpost-marketplace': 'zyla', 'x-hookpost-marketplace-key': ZYLA_SECRET.social },
      });
      expect(keyedToo.status).toBe(401);
      expect(await accountsOf(id)).toEqual([]);
    });

    it('api.market headers on a RapidAPI call are ignored: the call is the RapidAPI user\'s, never the api.market subscriber\'s', async () => {
      const victim = newSubscriber();
      expect((await api.call({ product: 'social', plan: 'pro', user: victim, path: '/usage' })).status).toBe(200);
      const attacker = newRapidUser();
      const res = await rapid.call({
        product: 'social',
        user: attacker,
        subscription: 'BASIC',
        path: '/usage',
        headers: { 'x-magicapi-user': victim, 'x-magicapi-plan': 'Pro', 'x-hookpost-plan': 'anything-0123456789abcdef' },
      });
      expect([res.status, res.body.plan]).toEqual([200, 'trial']);
      expect(await account('RAPIDAPI', victim, 'social')).toBeNull();
      expect((await account('RAPIDAPI', attacker, 'social'))!.organizationId).not.toBe(
        (await account('API_MARKET', victim, 'social'))!.organizationId
      );
    });

    it('a RapidAPI user named like an api.market subscriber cannot replay that subscriber\'s Idempotency-Key answer', async () => {
      const id = newSubscriber();
      const first = await api.call({ product: 'validate', plan: 'trial', user: id, path: '/check', body: CHECK, headers: { 'idempotency-key': 'shared-key-0001' } });
      expect(first.billing).toBe('API=1;');
      const other = await rapid.call({
        product: 'validate',
        user: id,
        subscription: 'BASIC',
        path: '/check',
        body: { ...CHECK, text: 'different' },
        headers: { 'idempotency-key': 'shared-key-0001' },
      });
      expect(other.status).toBe(200);
      expect(other.headers.get('idempotent-replay')).toBeNull();
      expect(other.headers.get('x-rapidapi-billing')).toBe('Credits=1');
    });

    it('blocking a RapidAPI account blocks only it; the same id on api.market keeps working', async () => {
      const id = newSubscriber();
      await api.call({ product: 'validate', plan: 'trial', user: id, path: '/rules' });
      await rapid.call({ product: 'validate', user: id, subscription: 'BASIC', path: '/rules' });
      await db().marketplaceAccount.update({
        where: { marketplace_externalUserId_product: { marketplace: 'RAPIDAPI', externalUserId: id, product: 'validate' } },
        data: { status: 'BLOCKED' },
      });
      const blocked = await rapid.call({ product: 'validate', user: id, subscription: 'BASIC', path: '/rules' });
      expect([blocked.status, blocked.body.error]).toEqual([403, 'account_blocked']);
      expect((await api.call({ product: 'validate', plan: 'trial', user: id, path: '/rules' })).status).toBe(200);
    });

    it('a repeated buyer header (two values) is no buyer at all', async () => {
      const res = await fetch(`${t.baseUrl}/mkt/v1/validate/rules`, {
        headers: [
          ['x-rapidapi-proxy-secret', RAPIDAPI_SECRET.validate],
          ['x-rapidapi-subscription', 'PRO'],
          ['x-rapidapi-user', 'alice'],
          ['x-rapidapi-user', 'bob'],
        ],
      });
      // Node joins a repeated header with ", ": not a valid username.
      expect(res.status).toBe(400);
    });

    it('a keyed marketplace\'s buyer is not a RapidAPI buyer of the same name', async () => {
      const name = `same-${Date.now()}`;
      await keyed.zyla({ product: 'validate', user: name, plan: 'Basic', path: '/rules' });
      await rapid.call({ product: 'validate', user: name, subscription: 'BASIC', path: '/rules' });
      const accs = await accountsOf(name);
      expect(accs.map((a) => a.marketplace)).toEqual(['RAPIDAPI', 'ZYLA']);
      expect(new Set(accs.map((a) => a.organizationId)).size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('admin: GET /admin/marketplaces and the source of every workspace', () => {
    it('is for super admins only', async () => {
      const someone = await t.api.register({ company: 'Not admin' });
      const res = await someone.get('/admin/marketplaces');
      expect(res.status).not.toBe(200);
    });

    it('counts subscribers (paying vs free), calls, refusals by kind and the last call, per marketplace', async () => {
      const usage = t.get<MarketplaceUsageService>(MarketplaceUsageService);
      const before = await overview();
      const rb = rowOf(before, 'RAPIDAPI');

      const free = newRapidUser();
      const paying = newRapidUser();
      expect((await rapid.call({ product: 'validate', user: free, subscription: 'BASIC', path: '/rules' })).status).toBe(200);
      expect((await rapid.call({ product: 'validate', user: paying, subscription: 'PRO', path: '/check', body: CHECK })).status).toBe(200);
      await rapid.call({ product: 'validate', user: free, subscription: 'BASIC', path: '/rules', headers: { 'x-rapidapi-proxy-secret': 'wrong-proxy-secret-0123456789abcdef' } });
      await rapid.call({ product: 'validate', user: free, subscription: 'CUSTOM', path: '/rules' });
      await fetch(`${t.baseUrl}/mkt/v1/validate/rules`); // names no marketplace
      // Counted when each answer has been sent ('finish'), then held in memory.
      await new Promise((r) => setTimeout(r, 100));
      await usage.flush();

      const after = await overview();
      const ra = rowOf(after, 'RAPIDAPI');
      expect(ra).toMatchObject({ label: 'RapidAPI', configured: true, products: ['social', 'linkedin', 'x', 'validate'] });
      expect(ra.subscribers.total - rb.subscribers.total).toBe(2);
      expect(ra.subscribers.paying - rb.subscribers.paying).toBe(1);
      expect(ra.subscribers.free - rb.subscribers.free).toBe(1);
      expect(ra.today.calls - rb.today.calls).toBe(4);
      expect(ra.today.ok - rb.today.ok).toBe(2);
      expect(ra.today.unauthorized - rb.today.unauthorized).toBe(1);
      expect(ra.today.forbidden - rb.today.forbidden).toBe(1);
      expect(ra.today.credits - rb.today.credits).toBe(1);
      expect(ra.last7d.calls - rb.last7d.calls).toBe(4);
      expect(ra.last30d.calls - rb.last30d.calls).toBe(4);
      expect(new Date(ra.lastCallAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(ra.daily[29].calls - rb.daily[29].calls).toBe(4);
      expect(after.unattributed.today.calls - before.unattributed.today.calls).toBe(1);
      expect(after.unattributed.today.unauthorized - before.unattributed.today.unauthorized).toBe(1);
      expect(rowOf(after, 'API_MARKET')).toMatchObject({ label: 'api.market', configured: true });
      expect(rowOf(after, 'ZYLA')).toMatchObject({ label: 'Zyla API Hub', products: ['social', 'validate'] });

      // Junk naming RapidAPI without its secret afterwards: counted as a 401,
      // but RapidAPI's last call does not move, and is not erased either.
      await rapid.call({ product: 'validate', user: free, subscription: 'BASIC', path: '/rules', headers: { 'x-rapidapi-proxy-secret': 'junk-proxy-secret-0123456789abcdef' } });
      await new Promise((r) => setTimeout(r, 100));
      await usage.flush();
      const junk = rowOf(await overview(), 'RAPIDAPI');
      expect(junk.today.unauthorized - ra.today.unauthorized).toBe(1);
      expect(junk.lastCallAt).toBe(ra.lastCallAt);

      const src = (o: any, id: string) => o.sources.find((s: any) => s.id === id)?.workspaces ?? 0;
      expect(src(after, 'RAPIDAPI') - src(before, 'RAPIDAPI')).toBe(2);
      expect(src(after, 'DIRECT')).toBeGreaterThan(0);
    });

    it('stores the source of a direct sign-up as DIRECT, and /admin/users counts workspaces per source', async () => {
      const direct = await t.api.register({ company: 'Direct customer' });
      const org = await db().organization.findUniqueOrThrow({ where: { id: (await direct.self()).orgId } });
      expect(org.source).toBe('DIRECT');
      const users = await admin.get('/admin/users');
      expect(users.status).toBe(200);
      const sources = users.body.metrics.sources as { id: string; label: string; workspaces: number }[];
      expect(sources.map((s) => s.id)).toEqual(expect.arrayContaining(['DIRECT', 'API_MARKET', 'RAPIDAPI', 'ZYLA']));
      const live = await db().organization.groupBy({ by: ['source'], where: { deletedAt: null }, _count: { _all: true } });
      for (const row of live) {
        expect(sources.find((s) => s.id === row.source)?.workspaces).toBe(row._count._all);
      }
    });
  });
});
