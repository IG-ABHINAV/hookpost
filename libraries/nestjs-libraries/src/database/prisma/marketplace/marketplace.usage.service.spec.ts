/**
 * MarketplaceUsageService: per-call counting in memory, the flush that adds
 * it to MarketplaceUsageDay, and the admin overview per marketplace, on a
 * mocked repository. Against Postgres: tests/integration/marketplace-adapters.int.spec.ts.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.usage.service
 */
import {
  MarketplaceUsageService,
  statusBucket,
  UNKNOWN_MARKETPLACE,
} from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';

jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.repository', () => ({
  MarketplaceUsageRepository: class {},
}));

const NOW = new Date('2026-10-26T10:00:00Z');

const repo = (over: Record<string, any> = {}) => ({
  add: jest.fn(async (_row: any) => undefined),
  days: jest.fn(async (_from: string): Promise<any[]> => []),
  lastCalls: jest.fn(async (): Promise<any[]> => []),
  accounts: jest.fn(async (): Promise<any[]> => []),
  newAccounts: jest.fn(async (_since: Date): Promise<Record<string, number>> => ({})),
  sources: jest.fn(async (): Promise<Record<string, number>> => ({})),
  ...over,
});

const day = (marketplace: string, d: string, over: Record<string, number> = {}) => ({
  marketplace,
  product: 'social',
  day: d,
  calls: 0,
  ok: 0,
  unauthorized: 0,
  forbidden: 0,
  rateLimited: 0,
  clientErrors: 0,
  serverErrors: 0,
  credits: 0,
  lastCallAt: new Date(`${d}T09:00:00Z`),
  ...over,
});

const ENV_KEYS = ['MKT_GATEWAY_SECRETS_SOCIAL', 'MKT_RAPIDAPI_SECRETS_VALIDATE', 'MKT_KEYED_MARKETPLACES'];
afterEach(() => ENV_KEYS.forEach((k) => delete process.env[k]));

describe('statusBucket', () => {
  it.each([
    [200, 'ok'],
    [201, 'ok'],
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rateLimited'],
    [400, 'clientErrors'],
    [404, 'clientErrors'],
    [409, 'clientErrors'],
    [500, 'serverErrors'],
    [503, 'serverErrors'],
  ])('%i counts as %s', (status, bucket) => {
    expect(statusBucket(status)).toBe(bucket);
  });
});

describe('record and flush', () => {
  it('adds up calls per marketplace, product and UTC day in one row each, credits only on a 2xx', async () => {
    const r = repo();
    const s = new MarketplaceUsageService(r as any);
    s.record('API_MARKET', 'social', 200, 3, new Date('2026-10-26T01:00:00Z'));
    s.record('API_MARKET', 'social', 200, 2, new Date('2026-10-26T02:00:00Z'));
    s.record('API_MARKET', 'social', 401, 9, new Date('2026-10-26T03:00:00Z'));
    s.record('API_MARKET', 'social', 429, 0, new Date('2026-10-26T00:30:00Z'));
    s.record('RAPIDAPI', 'social', 503, 0, new Date('2026-10-26T04:00:00Z'));
    s.record('API_MARKET', 'social', 200, 1, new Date('2026-10-27T00:00:01Z'));
    await s.flush();
    expect(r.add).toHaveBeenCalledTimes(3);
    const rows = r.add.mock.calls.map((c) => c[0]);
    expect(rows[0]).toMatchObject({
      marketplace: 'API_MARKET',
      product: 'social',
      day: '2026-10-26',
      calls: 4,
      ok: 2,
      unauthorized: 1,
      rateLimited: 1,
      credits: 5,
      // The 401 at 03:00 is not a call that came through: the last call is 02:00.
      lastCallAt: new Date('2026-10-26T02:00:00Z'),
    });
    expect(rows[1]).toMatchObject({ marketplace: 'RAPIDAPI', calls: 1, serverErrors: 1 });
    expect(rows[2]).toMatchObject({ day: '2026-10-27', calls: 1 });
    // Nothing held: a second flush writes nothing.
    await s.flush();
    expect(r.add).toHaveBeenCalledTimes(3);
  });

  it('keeps a row whose write failed for the next flush, merged with newer calls', async () => {
    const r = repo();
    r.add.mockRejectedValueOnce(new Error('db down'));
    const s = new MarketplaceUsageService(r as any);
    jest.spyOn((s as any).logger, 'warn').mockImplementation(() => undefined);
    s.record('API_MARKET', 'social', 200, 1, NOW);
    await s.flush();
    s.record('API_MARKET', 'social', 403, 0, NOW);
    await s.flush();
    expect(r.add).toHaveBeenLastCalledWith(expect.objectContaining({ calls: 2, ok: 1, forbidden: 1, credits: 1 }));
  });

  it('never throws and holds at most 500 rows between flushes (junk paths cannot grow memory)', async () => {
    const r = repo();
    const s = new MarketplaceUsageService(r as any);
    for (let i = 0; i < 700; i++) s.record(`M${i}`, 'social', 401, 0, NOW);
    expect(() => s.record(null as any, undefined as any, NaN, NaN, new Date('bad'))).not.toThrow();
    await s.flush();
    expect(r.add).toHaveBeenCalledTimes(500);
  });
});

describe('overview', () => {
  it('counts subscribers, paying vs free, calls and refusals per window, and the last call, per marketplace', async () => {
    process.env.MKT_GATEWAY_SECRETS_SOCIAL = 'a'.repeat(40);
    const r = repo({
      days: jest.fn(async () => [
        day('API_MARKET', '2026-10-26', { calls: 10, ok: 6, unauthorized: 2, forbidden: 1, serverErrors: 1, credits: 9 }),
        day('API_MARKET', '2026-10-22', { calls: 5, ok: 5 }),
        day('API_MARKET', '2026-09-20', { calls: 100, ok: 100 }), // before the 30 days: not counted
        day('RAPIDAPI', '2026-10-26', { calls: 4, ok: 1, rateLimited: 3 }),
        day(UNKNOWN_MARKETPLACE, '2026-10-26', { calls: 7, unauthorized: 7 }),
        day('OLDHUB', '2026-10-20', { calls: 1, ok: 1 }),
      ]),
      lastCalls: jest.fn(async () => [
        { marketplace: 'API_MARKET', _max: { lastCallAt: new Date('2026-10-26T09:59:00Z') } },
        { marketplace: UNKNOWN_MARKETPLACE, _max: { lastCallAt: new Date('2026-10-26T08:00:00Z') } },
      ]),
      accounts: jest.fn(async () => [
        { marketplace: 'API_MARKET', product: 'social', plan: 'trial', status: 'ACTIVE', count: 1 },
        { marketplace: 'API_MARKET', product: 'social', plan: 'pro', status: 'ACTIVE', count: 2 },
        { marketplace: 'API_MARKET', product: 'x', plan: 'basic', status: 'DORMANT', count: 1 },
        { marketplace: 'API_MARKET', product: 'social', plan: 'pro', status: 'BLOCKED', count: 1 },
        { marketplace: 'RAPIDAPI', product: 'validate', plan: 'trial', status: 'ACTIVE', count: 1 },
      ]),
      newAccounts: jest.fn(async (since: Date) =>
        since.toISOString().startsWith('2026-10-20') ? { API_MARKET: 2, RAPIDAPI: 1 } : { API_MARKET: 3, RAPIDAPI: 1 }
      ),
      sources: jest.fn(async () => ({ DIRECT: 60, API_MARKET: 4, RAPIDAPI: 1 })),
    });
    const s = new MarketplaceUsageService(r as any);
    const out = await s.overview(NOW);
    expect(r.days).toHaveBeenCalledWith('2026-09-27');
    expect(out.marketplaces.map((m) => m.id)).toEqual(['API_MARKET', 'RAPIDAPI', 'OLDHUB']);

    const api = out.marketplaces[0];
    expect(api).toMatchObject({ label: 'api.market', configured: true, products: ['social'] });
    // Paying and free count active subscribers only: the dormant paid one and the blocked one are apart.
    expect(api.subscribers).toEqual({
      total: 5,
      paying: 2,
      free: 1,
      active: 3,
      dormant: 1,
      blocked: 1,
      new7d: 2,
      new30d: 3,
      byProduct: { social: 4, x: 1 },
    });
    expect(r.newAccounts).toHaveBeenCalledWith(new Date('2026-10-20T00:00:00.000Z'));
    expect(r.newAccounts).toHaveBeenCalledWith(new Date('2026-09-27T00:00:00.000Z'));
    expect(api.today).toMatchObject({ calls: 10, ok: 6, unauthorized: 2, forbidden: 1, serverErrors: 1, credits: 9 });
    expect(api.last7d.calls).toBe(15);
    expect(api.last30d.calls).toBe(15);
    expect(api.lastCallAt).toBe('2026-10-26T09:59:00.000Z');
    expect(api.daily).toHaveLength(30);
    expect(api.daily[29]).toEqual({ day: '2026-10-26', calls: 10, errors: 4 });

    expect(out.marketplaces[1]).toMatchObject({
      label: 'RapidAPI',
      configured: false,
      subscribers: { total: 1, free: 1, paying: 0 },
      today: { calls: 4, rateLimited: 3 },
      lastCallAt: null,
    });
    // A marketplace that left .env still shows what it has.
    expect(out.marketplaces[2]).toMatchObject({ label: 'OLDHUB', configured: false, last7d: { calls: 1 } });
    expect(out.unattributed.today).toMatchObject({ calls: 7, unauthorized: 7 });
    expect(out.unattributed.lastCallAt).toBe('2026-10-26T08:00:00.000Z');
    expect(out.sources).toEqual([
      { id: 'DIRECT', label: 'Direct (hookpost.hookstep.in)', workspaces: 60 },
      { id: 'API_MARKET', label: 'api.market', workspaces: 4 },
      { id: 'RAPIDAPI', label: 'RapidAPI', workspaces: 1 },
    ]);
  });

  it('reads a marketplace whose only calls were refused at the door (401) as never called', async () => {
    const r = repo({
      lastCalls: jest.fn(async () => [{ marketplace: 'RAPIDAPI', _max: { lastCallAt: new Date(0) } }]),
    });
    const s = new MarketplaceUsageService(r as any);
    s.record('RAPIDAPI', 'social', 401, 0, NOW);
    await s.flush();
    expect(r.add).toHaveBeenCalledWith(expect.objectContaining({ unauthorized: 1, lastCallAt: new Date(0) }));
    const out = await s.overview(NOW);
    expect(out.marketplaces.find((m) => m.id === 'RAPIDAPI')!.lastCallAt).toBeNull();
  });

  it('flushes what is held first, so today counts the calls of the last seconds', async () => {
    const r = repo();
    const s = new MarketplaceUsageService(r as any);
    s.record('API_MARKET', 'social', 200, 0, NOW);
    await s.overview(NOW);
    expect(r.add).toHaveBeenCalledTimes(1);
    expect(r.add.mock.invocationCallOrder[0]).toBeLessThan(r.days.mock.invocationCallOrder[0]);
  });
});

describe('calls per subscriber workspace (admin Workspaces list)', () => {
  // No REDIS_URL in unit tests: the in-memory Redis stand-in.
  const flushPromises = () => new Promise((r) => setImmediate(r));

  it('counts each call by account and UTC day, and sums the last 7 days with today', async () => {
    const s = new MarketplaceUsageService(repo() as any);
    const id = `acc-${Math.random().toString(36).slice(2)}`;
    const at = (iso: string) => new Date(iso);
    s.recordAccount(id, at('2026-10-26T09:00:00Z'));
    s.recordAccount(id, at('2026-10-26T23:59:00Z'));
    s.recordAccount(id, at('2026-10-20T00:00:00Z')); // 7th day back: in
    s.recordAccount(id, at('2026-10-19T23:59:00Z')); // 8th day back: out
    s.recordAccount('other-account', at('2026-10-26T09:00:00Z'));
    await flushPromises();
    expect(await s.accountCalls([id, 'never-called'], 7, NOW)).toEqual({ [id]: 3, 'never-called': 0 });
    expect(await s.accountCalls([id], 1, NOW)).toEqual({ [id]: 2 });
  });

  it('a call with no account counts nothing and never throws', async () => {
    const s = new MarketplaceUsageService(repo() as any);
    expect(() => s.recordAccount(undefined)).not.toThrow();
    expect(() => s.recordAccount(null)).not.toThrow();
    expect(await s.accountCalls([])).toEqual({});
  });
});
