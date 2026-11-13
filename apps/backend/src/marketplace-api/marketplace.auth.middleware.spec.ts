/**
 * MarketplaceAuthMiddleware: who may call /mkt/v1/<product>/..., in order,
 * and that neither the gateway secret nor a plan token is ever logged.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.auth.middleware
 */
import { Logger } from '@nestjs/common';
import { sha256Hex } from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import { PRIOR_PLAN_LIMITS } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => {
  const chain: any = { incr: () => chain, expire: () => chain, exec: async () => [] };
  return { ioRedis: { multi: () => chain }, ioRedisIsMock: false };
});

jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service', () => ({
  MarketplaceAccountService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository', () => ({
  MarketplaceAccountRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/sentry/initialize.sentry', () => ({ setSentryUserContext: () => undefined }));

import { MarketplaceAuthMiddleware } from '@hookpost/backend/marketplace-api/marketplace.auth.middleware';

const SECRET = 'g'.repeat(32) + 'secret-value-1';
const NEXT_SECRET = 'h'.repeat(32) + 'secret-value-2';
const TRIAL_TOKEN = 'plan-token-trial-' + 'x'.repeat(30);
const PRO_TOKEN = 'plan-token-pro-' + 'y'.repeat(30);
const USER = 'cll8kolno0000l808v6p3xvax';

const account = (over = {}) => ({
  id: 'acc-1',
  product: 'social',
  plan: 'trial',
  status: 'ACTIVE',
  organizationId: 'org-1',
  periodStart: new Date(),
  externalUserId: USER,
  ...over,
});

function setup(opts: { status?: string; allow?: boolean; periodStart?: Date } = {}) {
  const accounts = {
    resolve: jest.fn(async (_user: string, plan: { plan: string }) => ({
      account: account({
        status: opts.status || 'ACTIVE',
        plan: plan.plan,
        ...(opts.periodStart ? { periodStart: opts.periodStart } : {}),
      }),
      created: false,
      planChanged: false,
    })),
  };
  const repository = { organization: jest.fn(async () => ({ id: 'org-1', deletedAt: null })) };
  const ledger = { allow: jest.fn(async () => opts.allow ?? true) };
  const usage = { record: jest.fn(), recordAccount: jest.fn() };
  const middleware = new MarketplaceAuthMiddleware(accounts as any, repository as any, ledger as any, usage as any);
  return { middleware, accounts, repository, ledger, usage };
}

function call(
  middleware: MarketplaceAuthMiddleware,
  headers: Record<string, any>,
  { url = '/mkt/v1/social/channels', method = 'GET' } = {}
) {
  const res: any = {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    removeHeader(k: string) {
      delete this.headers[k];
    },
    finish: [] as (() => void)[],
    once(event: string, fn: () => void) {
      if (event === 'finish') this.finish.push(fn);
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.body = body;
      return this;
    },
  };
  const req: any = { headers, originalUrl: url, url, method };
  const next = jest.fn();
  return middleware.use(req, res, next).then(() => {
    // The answer is sent: what the usage counter sees.
    res.finish.forEach((fn: () => void) => fn());
    return { req, res, next };
  });
}

const good = (over: Record<string, any> = {}) => ({
  'x-hookpost-gateway': SECRET,
  'x-hookpost-plan': TRIAL_TOKEN,
  'x-magicapi-user': USER,
  'x-magicapi-plan': 'Free trial',
  ...over,
});

const logged: string[] = [];
beforeAll(() => {
  process.env.MKT_GATEWAY_SECRETS_SOCIAL = `${SECRET},${NEXT_SECRET}`;
  process.env.MKT_PLAN_TOKEN_HASHES = `${sha256Hex(TRIAL_TOKEN)}=social:trial,${sha256Hex(PRO_TOKEN)}=x:pro`;
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: any[]) => {
      logged.push(JSON.stringify(args));
    });
    jest.spyOn(console, level === 'verbose' ? 'info' : level).mockImplementation((...args: any[]) => {
      logged.push(JSON.stringify(args));
    });
  }
});
afterAll(() => {
  delete process.env.MKT_GATEWAY_SECRETS_SOCIAL;
  delete process.env.MKT_PLAN_TOKEN_HASHES;
  delete process.env.MKT_DISABLED_PRODUCTS;
  jest.restoreAllMocks();
});

describe('gateway secret', () => {
  it.each([
    ['missing', {}],
    ['wrong', { 'x-hookpost-gateway': 'w'.repeat(46) }],
    ['a different length', { 'x-hookpost-gateway': SECRET + 'z' }],
    ['repeated', { 'x-hookpost-gateway': [SECRET, SECRET] }],
  ])('refuses a %s secret with 401 before anything else is read', async (_n, headers) => {
    const { middleware, accounts } = setup();
    const { res, next } = await call(middleware, { ...good(), 'x-hookpost-gateway': undefined, ...headers });
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('unauthorized');
    expect(next).not.toHaveBeenCalled();
    expect(accounts.resolve).not.toHaveBeenCalled();
  });

  it('takes both secrets during a rotation', async () => {
    for (const secret of [SECRET, NEXT_SECRET]) {
      const { middleware } = setup();
      const { next } = await call(middleware, good({ 'x-hookpost-gateway': secret }));
      expect(next).toHaveBeenCalled();
    }
  });

  it('refuses every call of a product with no secret configured', async () => {
    const { middleware } = setup();
    const { res } = await call(middleware, good(), { url: '/mkt/v1/x/channels' });
    expect(res.statusCode).toBe(401);
  });

  it('answers 404 for a path that is not a product', async () => {
    const { middleware } = setup();
    const { res } = await call(middleware, good(), { url: '/mkt/v1/analytics/x' });
    expect(res.statusCode).toBe(404);
  });
});

describe('after the secret', () => {
  it('refuses an unknown plan token, or another product\'s, with 403 when no plan name names a plan', async () => {
    for (const token of ['nope-' + 'n'.repeat(30), PRO_TOKEN, undefined]) {
      for (const name of [undefined, 'Starter', 'Enterprise', 'Testers', 'Freee']) {
        const { middleware, accounts } = setup();
        const { res } = await call(middleware, good({ 'x-hookpost-plan': token, 'x-magicapi-plan': name }));
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('unknown_plan');
        expect(accounts.resolve).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses a bad x-magicapi-user with 400', async () => {
    for (const user of [undefined, 'short', 'UPPER-CASE-NOT-A-CUID-1234', [USER, USER]]) {
      const { middleware } = setup();
      const { res } = await call(middleware, good({ 'x-magicapi-user': user }));
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('invalid_subscriber');
    }
  });

  it('refuses any Authorization header with 400: a Hookpost key never passes through api.market', async () => {
    const { middleware, accounts } = setup();
    const { res } = await call(middleware, good({ authorization: 'hookpost-key-123' }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('authorization_not_accepted');
    expect(accounts.resolve).not.toHaveBeenCalled();
  });

  it('refuses a blocked account with 403, and a paused product with 503', async () => {
    const blocked = setup({ status: 'BLOCKED' });
    expect((await call(blocked.middleware, good())).res.statusCode).toBe(403);
    process.env.MKT_DISABLED_PRODUCTS = 'social';
    const paused = setup();
    const { res } = await call(paused.middleware, good());
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('product_paused');
    delete process.env.MKT_DISABLED_PRODUCTS;
  });

  it('answers 429 past the subscriber\'s token bucket, writes and reads separately', async () => {
    const { middleware, ledger } = setup({ allow: false });
    const { res } = await call(middleware, good(), { method: 'POST', url: '/mkt/v1/social/posts' });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('1');
    expect(ledger.allow).toHaveBeenCalledWith('mkt:rl:acc-1:write', 2, 4);
    await call(middleware, good());
    expect(ledger.allow).toHaveBeenLastCalledWith('mkt:rl:acc-1:read', 10, 20);
  });
});

describe("the plan from api.market's x-magicapi-plan (no plan header)", () => {
  const noToken = (name: any, over: Record<string, any> = {}) =>
    good({ 'x-hookpost-plan': undefined, 'x-magicapi-plan': name, ...over });

  it.each([
    ['Free trial', 'trial'],
    ['Standard', 'standard'],
    ['Pro', 'pro'],
    [' PRO ', 'pro'],
    ['free  TRIAL', 'trial'],
    ['standard\t', 'standard'],
    ['Tester', 'pro'],
    [' tester ', 'pro'],
    ['Free', 'trial'],
    [' FREE ', 'trial'],
  ])('takes %j as the %s plan', async (name, plan) => {
    const { middleware, accounts } = setup();
    const { next, req } = await call(middleware, noToken(name));
    expect(next).toHaveBeenCalled();
    expect(accounts.resolve).toHaveBeenCalledWith(USER, expect.objectContaining({ product: 'social', plan }), expect.any(Date), expect.objectContaining({ id: 'API_MARKET' }));
    expect(req.mkt.plan.plan).toBe(plan);
  });

  it.each([
    ['an unknown name', 'Enterprise'],
    ['a near miss of Free', 'Freee'],
    ['the private Starter', 'Starter'],
    ['no name', undefined],
    ['a repeated header', ['Pro', 'Pro']],
    ['two names joined', 'Free trial, Pro'],
  ])('refuses %s with 403 unknown_plan before a workspace is made', async (_n, name) => {
    const { middleware, accounts } = setup();
    const { res, next } = await call(middleware, noToken(name));
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('unknown_plan');
    expect(next).not.toHaveBeenCalled();
    expect(accounts.resolve).not.toHaveBeenCalled();
  });

  it('refuses a spoofed x-magicapi-plan without the gateway secret with 401, whatever the plan', async () => {
    for (const name of ['Pro', 'Tester', 'Free']) {
      for (const secret of [undefined, 'w'.repeat(46), '']) {
        const { middleware, accounts } = setup();
        const { res, next } = await call(middleware, noToken(name, { 'x-hookpost-gateway': secret }));
        expect(res.statusCode).toBe(401);
        expect(next).not.toHaveBeenCalled();
        expect(accounts.resolve).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses a plan name for a product that has no name table (X stays on plan tokens)', async () => {
    process.env.MKT_GATEWAY_SECRETS_X = SECRET;
    try {
      for (const name of ['Pro', 'Tester', 'Free']) {
        const { middleware, accounts } = setup();
        const { res } = await call(middleware, noToken(name), { url: '/mkt/v1/x/usage' });
        expect(res.statusCode).toBe(403);
        expect(accounts.resolve).not.toHaveBeenCalled();
      }
    } finally {
      delete process.env.MKT_GATEWAY_SECRETS_X;
    }
  });

  it('still needs a valid subscriber, and still refuses an Authorization header', async () => {
    const a = setup();
    expect((await call(a.middleware, noToken('Pro', { 'x-magicapi-user': undefined }))).res.statusCode).toBe(400);
    const b = setup();
    const { res } = await call(b.middleware, noToken('Pro', { authorization: 'Bearer x' }));
    expect(res.body.error).toBe('authorization_not_accepted');
  });

  it('lets a plan token that resolves win over the plan name, and logs the mismatch', async () => {
    const { middleware, accounts } = setup();
    const before = logged.length;
    await call(middleware, good({ 'x-hookpost-plan': TRIAL_TOKEN, 'x-magicapi-plan': 'Pro' }));
    expect(accounts.resolve).toHaveBeenCalledWith(USER, expect.objectContaining({ plan: 'trial' }), expect.any(Date), expect.objectContaining({ id: 'API_MARKET' }));
    expect(logged.slice(before).join('\n')).toContain('plan mismatch');
  });

  it('falls back to the plan name when the plan token names nothing, and logs it without the token', async () => {
    const { middleware, accounts } = setup();
    const before = logged.length;
    const garbage = 'garbage-' + 'g'.repeat(30);
    await call(middleware, good({ 'x-hookpost-plan': garbage, 'x-magicapi-plan': 'Standard' }));
    expect(accounts.resolve).toHaveBeenCalledWith(USER, expect.objectContaining({ plan: 'standard' }), expect.any(Date), expect.objectContaining({ id: 'API_MARKET' }));
    const lines = logged.slice(before).join('\n');
    expect(lines).toContain('plan_token_unknown product=social plan=standard');
    expect(lines).not.toContain(garbage);
  });

  it('logs a refused plan name short and without control characters', async () => {
    const { middleware } = setup();
    const before = logged.length;
    const { res } = await call(middleware, good({ 'x-hookpost-plan': undefined, 'x-magicapi-plan': 'Pro\n\u001b[31m' + 'x'.repeat(50) }));
    expect(res.statusCode).toBe(403);
    const line = logged.slice(before).find((l) => l.includes('reason=unknown_plan'))!;
    const message = JSON.parse(line)[0] as string;
    expect(message).not.toMatch(/[\n\u001b]/);
    expect(message.length).toBeLessThan(140);
  });
});

describe('an accepted call', () => {
  it('sets the workspace and context, without injecting any role, and starts billing at API=0;', async () => {
    const { middleware, accounts } = setup();
    const { req, res, next } = await call(middleware, good({ 'x-request-id': 'req-1', 'idempotency-key': 'my-key-12345' }));
    expect(next).toHaveBeenCalled();
    expect(res.headers['X-Magicapi-Billing']).toBe('API=0;');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(accounts.resolve).toHaveBeenCalledWith(USER, expect.objectContaining({ product: 'social', plan: 'trial' }), expect.any(Date), expect.objectContaining({ id: 'API_MARKET' }));
    expect(req.org).toEqual({ id: 'org-1', deletedAt: null });
    expect(req.org.users).toBeUndefined();
    expect(req.mkt).toMatchObject({
      product: 'social',
      organizationId: 'org-1',
      subscriber: USER,
      requestId: 'req-1',
      idempotencyKey: 'my-key-12345',
      credits: 0,
    });
  });

  it('lets the probe through on the secret alone', async () => {
    const { middleware, accounts } = setup();
    const { req, next } = await call(
      middleware,
      { 'x-hookpost-gateway': SECRET, authorization: 'forwarded?' },
      { url: '/mkt/v1/social/_probe?bill=2' }
    );
    expect(next).toHaveBeenCalled();
    expect(req.mktProbe).toEqual({ product: 'social', secret: 0 });
    expect(accounts.resolve).not.toHaveBeenCalled();
  });
});

it('never logs the gateway secret or a plan token', () => {
  const all = logged.join('\n');
  expect(logged.length).toBeGreaterThan(0);
  for (const value of [SECRET, NEXT_SECRET, TRIAL_TOKEN, PRO_TOKEN, 'secret-value']) {
    expect(all).not.toContain(value);
  }
});

// ---------------------------------------------------------------------------
// The other marketplaces, through the same middleware
// ---------------------------------------------------------------------------

const RAPID = 'r'.repeat(30) + '-proxy';
const ZYLA = 'z'.repeat(40);
const rapid = (over: Record<string, any> = {}) => ({
  'x-rapidapi-proxy-secret': RAPID,
  'x-rapidapi-user': 'jane_doe',
  'x-rapidapi-subscription': 'PRO',
  ...over,
});
const zyla = (over: Record<string, any> = {}) => ({
  'x-hookpost-marketplace': 'zyla',
  'x-hookpost-marketplace-key': ZYLA,
  'x-zyla-user': 'buyer-1',
  ...over,
});

describe('one gateway, several marketplaces', () => {
  beforeAll(() => {
    process.env.MKT_RAPIDAPI_SECRETS_SOCIAL = RAPID;
    process.env.MKT_KEYED_MARKETPLACES = 'zyla';
    process.env.MKT_KEYED_ZYLA_SECRETS_SOCIAL = ZYLA;
    process.env.MKT_KEYED_ZYLA_USER_HEADER = 'x-zyla-user';
    process.env.MKT_KEYED_ZYLA_DEFAULT_PLAN_SOCIAL = 'standard';
    process.env.MKT_KEYED_ZYLA_BILLING_HEADER = 'x-zyla-units';
  });
  afterAll(() => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('MKT_RAPIDAPI_') || k.startsWith('MKT_KEYED_')) delete process.env[k];
    }
  });

  it('RapidAPI: its secret, user and subscription; its billing header instead of api.market\'s', async () => {
    const { middleware, accounts, usage } = setup();
    const { req, res, next } = await call(middleware, rapid());
    expect(next).toHaveBeenCalled();
    expect(accounts.resolve).toHaveBeenCalledWith(
      'jane_doe',
      expect.objectContaining({ product: 'social', plan: 'standard' }),
      expect.any(Date),
      expect.objectContaining({ id: 'RAPIDAPI' })
    );
    expect(res.headers['X-Magicapi-Billing']).toBeUndefined();
    expect(res.headers['X-RapidAPI-Billing']).toBe('Credits=0');
    expect(req.mkt).toMatchObject({ subscriber: 'jane_doe', subscriberKey: 'rapidapi:jane_doe', requestId: undefined });
    expect(req.mkt.adapter.id).toBe('RAPIDAPI');
    expect(usage.record).toHaveBeenCalledWith('RAPIDAPI', 'social', 200, 0);
    // The subscriber's own workspace is counted too (admin Workspaces list).
    expect(usage.recordAccount).toHaveBeenCalledWith(req.mkt.account.id);
  });

  it('RapidAPI: a wrong or missing proxy secret is 401 and counted against RapidAPI, nothing resolved', async () => {
    for (const secret of ['w'.repeat(36), '', ['a', 'b']]) {
      const { middleware, accounts, usage } = setup();
      const { res } = await call(middleware, rapid({ 'x-rapidapi-proxy-secret': secret }));
      expect([res.statusCode, res.body.message]).toEqual([401, 'Call this API through RapidAPI.']);
      expect(accounts.resolve).not.toHaveBeenCalled();
      expect(usage.record).toHaveBeenCalledWith('RAPIDAPI', 'social', 401, 0);
      // No account was found: nothing is counted against any workspace.
      expect(usage.recordAccount).not.toHaveBeenCalled();
    }
  });

  it('RapidAPI: api.market\'s secret is not RapidAPI\'s, and RapidAPI\'s is not api.market\'s', async () => {
    const a = setup();
    expect((await call(a.middleware, rapid({ 'x-rapidapi-proxy-secret': SECRET }))).res.statusCode).toBe(401);
    const b = setup();
    expect((await call(b.middleware, good({ 'x-hookpost-gateway': RAPID }))).res.statusCode).toBe(401);
  });

  it('RapidAPI: a plan it does not sell is 403, a bad user 400, an Authorization header 400; the probe is not there', async () => {
    const a = setup();
    expect((await call(a.middleware, rapid({ 'x-rapidapi-subscription': 'CUSTOM' }))).res.body.error).toBe('unknown_plan');
    const b = setup();
    expect((await call(b.middleware, rapid({ 'x-rapidapi-user': 'a b' }))).res.body.error).toBe('invalid_subscriber');
    const c = setup();
    const auth = await call(c.middleware, rapid({ authorization: 'Bearer k' }));
    expect([auth.res.statusCode, auth.res.body.error]).toEqual([400, 'authorization_not_accepted']);
    const d = setup();
    const probe = await call(d.middleware, rapid(), { url: '/mkt/v1/social/_probe' });
    expect([probe.res.statusCode, probe.next.mock.calls.length]).toEqual([404, 0]);
  });

  it('a keyed marketplace: its key, its buyer header and its default plan', async () => {
    const { middleware, accounts } = setup();
    const { req, res, next } = await call(middleware, zyla());
    expect(next).toHaveBeenCalled();
    expect(accounts.resolve).toHaveBeenCalledWith(
      'buyer-1',
      expect.objectContaining({ plan: 'standard' }),
      expect.any(Date),
      expect.objectContaining({ id: 'ZYLA' })
    );
    expect(res.headers['x-zyla-units']).toBe('0');
    expect(res.headers['X-Magicapi-Billing']).toBeUndefined();
    expect(req.mkt.subscriberKey).toBe('zyla:buyer-1');
  });

  it('ignores Idempotency-Key for the shared subscriber of a marketplace without buyer ids', async () => {
    process.env.MKT_KEYED_MARKETPLACES = 'zyla,hub';
    process.env.MKT_KEYED_HUB_SECRETS_VALIDATE = ZYLA;
    process.env.MKT_KEYED_HUB_DEFAULT_PLAN_VALIDATE = 'starter';
    process.env.MKT_GATEWAY_SECRETS_VALIDATE = SECRET;
    try {
      const { middleware, next } = setup() as any;
      const { req } = await call(
        middleware,
        { 'x-hookpost-marketplace': 'hub', 'x-hookpost-marketplace-key': ZYLA, 'idempotency-key': 'buyer-key-0001' },
        { url: '/mkt/v1/validate/check', method: 'POST' }
      );
      expect(req.mkt).toMatchObject({ subscriber: 'shared', idempotencyKey: undefined });
    } finally {
      process.env.MKT_KEYED_MARKETPLACES = 'zyla';
      delete process.env.MKT_GATEWAY_SECRETS_VALIDATE;
    }
  });

  it('refuses a call that carries two marketplaces\' markers, whichever secrets are right', async () => {
    for (const headers of [{ ...good(), ...rapid() }, { ...rapid(), ...zyla() }, { ...good(), ...zyla() }]) {
      const { middleware, accounts, usage } = setup();
      const { res } = await call(middleware, headers);
      expect([res.statusCode, res.body.message]).toEqual([401, 'Call this API through one marketplace.']);
      expect(accounts.resolve).not.toHaveBeenCalled();
      expect(usage.record).toHaveBeenCalledWith('UNKNOWN', 'social', 401, 0);
    }
  });

  it('counts a call that names no marketplace as UNKNOWN, and a path that is no product as "-"', async () => {
    const a = setup();
    await call(a.middleware, { 'x-rapidapi-user': 'jane' });
    expect(a.usage.record).toHaveBeenCalledWith('UNKNOWN', 'social', 401, 0);
    const b = setup();
    await call(b.middleware, rapid(), { url: '/mkt/v1/nothing/x' });
    expect(b.usage.record).toHaveBeenCalledWith('UNKNOWN', '-', 404, 0);
  });

  it('never logs a RapidAPI or keyed secret', () => {
    const all = logged.join('\n');
    expect(all).not.toContain(RAPID);
    expect(all).not.toContain(ZYLA);
  });
});

describe('the Social trial limits lowered on 26 Oct 2026 (PRIOR_PLAN_LIMITS)', () => {
  const MB = 1024 * 1024;
  const until = PRIOR_PLAN_LIMITS['social:trial'].until;
  const free = (over: Record<string, any> = {}) => good({ 'x-hookpost-plan': undefined, 'x-magicapi-plan': 'Free', ...over });

  it('a new trial account gets 10 credits, 1 channel and 50 MB', async () => {
    const now = new Date(until.getTime() + 60_000);
    jest.useFakeTimers({ now, doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { middleware } = setup({ periodStart: now });
      const { req, next } = await call(middleware, free());
      expect(next).toHaveBeenCalled();
      expect(req.mkt.plan).toMatchObject({ product: 'social', plan: 'trial', credits: 10, channels: 1, storageBytes: 50 * MB });
    } finally {
      jest.useRealTimers();
    }
  });

  it('a trial account whose window began before the change keeps 100 credits, 2 channels and 250 MB in this window', async () => {
    jest.useFakeTimers({ now: new Date(until.getTime() + 3 * 86_400_000), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { middleware, accounts } = setup({ periodStart: new Date(until.getTime() - 3_600_000) });
      const { req, next } = await call(middleware, free());
      expect(next).toHaveBeenCalled();
      expect(req.mkt.plan).toMatchObject({ plan: 'trial', credits: 100, channels: 2, storageBytes: 250 * MB, allowX: false });
      // The account itself is resolved with the plan as it is now: no plan change, no new window.
      expect(accounts.resolve).toHaveBeenCalledWith(USER, expect.objectContaining({ plan: 'trial', credits: 10 }), expect.any(Date), expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('the same account gets the new limits in its next window', async () => {
    jest.useFakeTimers({ now: new Date(until.getTime() + 28 * 86_400_000), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const { middleware } = setup({ periodStart: new Date(until.getTime() - 3_600_000) });
      const { req } = await call(middleware, free());
      expect(req.mkt.plan).toMatchObject({ plan: 'trial', credits: 10, channels: 1, storageBytes: 50 * MB });
    } finally {
      jest.useRealTimers();
    }
  });

  it('Tester and the paid plans are untouched, whenever the window began', async () => {
    for (const [name, plan, credits, channels] of [
      ['Tester', 'pro', 1200, 20],
      ['Pro', 'pro', 1200, 20],
      ['Standard', 'standard', 500, 5],
    ] as const) {
      const { middleware } = setup({ periodStart: new Date(until.getTime() - 3_600_000) });
      const { req } = await call(middleware, free({ 'x-magicapi-plan': name }));
      expect(req.mkt.plan).toMatchObject({ plan, credits, channels });
    }
  });
});
