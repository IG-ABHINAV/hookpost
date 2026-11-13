/**
 * GumroadLicenseService with its repository, SubscriptionService and the
 * Gumroad API replaced: what redeem() writes and asks Gumroad, and what the
 * daily re-check does to a workspace's plan. The real-database version is
 * tests/integration/gumroad-license.int.spec.ts.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts gumroad.license.service
 */
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
// A Redis that honours SET ... NX and the owner-checked release, so the
// redeem and run locks can be held from a test.
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => {
  const store = new Map<string, string>();
  return {
    redisStore: store,
    ioRedis: {
      set: async (key: string, value: string, ...args: any[]) => {
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      eval: async (_script: string, _n: number, key: string, token: string) => {
        if (store.get(key) !== token) return 0;
        store.delete(key);
        return 1;
      },
    },
  };
});

import { Logger } from '@nestjs/common';
import {
  GumroadLicenseService,
  hashLicenseKey,
  redeemLockKey,
  REVERIFY_AFTER_MS,
  REVERIFY_LOCK_KEY,
  REVERIFY_LOCK_MS,
  REVERIFY_RUN_BUDGET_MS,
} from './gumroad.license.service';
import { GumroadClient } from '@hookpost/nestjs-libraries/services/gumroad.client';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { redisStore } = require('@hookpost/nestjs-libraries/redis/redis.service') as {
  redisStore: Map<string, string>;
};

const KEY = '85DB562A-C11D4B06-A2335A6B-8C079166';
const SALE = 'FO8TXN-dbxYaBdahG97Y-Q==';
const NOW = new Date('2026-10-24T12:00:00Z');
const NEXT_WEEK = new Date('2026-10-31T12:00:00Z');
const HOUR = 3600_000;
const ENV = { ...process.env };

const purchase = (fields: Record<string, unknown> = {}) => ({
  sale_id: SALE,
  product_id: 'pro-product',
  recurrence: 'monthly',
  refunded: false,
  chargebacked: false,
  disputed: false,
  dispute_won: false,
  subscription_cancelled_at: null,
  subscription_ended_at: null,
  subscription_failed_at: null,
  ...fields,
});

function setup(opts: { bound?: any; plan?: any } = {}) {
  const rows: any[] = opts.bound ? [opts.bound] : [];
  const repository = {
    findByHash: jest.fn(async (hash: string) => rows.find((r) => r.licenseKeyHash === hash) || null),
    create: jest.fn(async (data: any) => {
      const row = { id: 'lic-new', ...data };
      rows.push(row);
      return row;
    }),
    update: jest.fn(async (id: string, data: any) => ({ ...rows.find((r) => r.id === id), ...data })),
    // Writes only while the row still has the status the caller read.
    updateIfStatus: jest.fn(async (id: string, expected: string, data: any) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.status !== expected) return false;
      Object.assign(row, data);
      return true;
    }),
    replaceOthers: jest.fn(async () => ({ count: 0 })),
    listDue: jest.fn(async () => rows),
    plansFor: jest.fn(async () => new Map()),
  };
  const subscriptions = {
    getSubscription: jest.fn(async (_orgId?: string) => opts.plan ?? null),
    applyGumroadPlan: jest.fn(async () => undefined),
    scheduleCancellation: jest.fn(async () => ({ count: 1 })),
    endPlanByIdentifier: jest.fn(async () => true),
  };
  const service = new GumroadLicenseService(repository as any, subscriptions as any);
  return { service, repository, subscriptions };
}

/** Gumroad answers per product id; verify calls are recorded. */
function gumroad(answers: Record<string, { status: number; body: any }>, sale?: any) {
  const verify = jest
    .spyOn(GumroadClient.prototype, 'verifyLicense')
    .mockImplementation(async (productId: string) =>
      answers[productId] || {
        status: 404,
        body: { success: false, message: 'That license does not exist for the provided product.' },
      }
    );
  const getSale = jest
    .spyOn(GumroadClient.prototype, 'getSale')
    .mockImplementation(async () => sale || { status: 200, body: { success: true, sale: { license_key: KEY } } });
  return { verify, getSale };
}

const ok = (fields?: Record<string, unknown>) => ({
  status: 200,
  body: { success: true, uses: 0, purchase: purchase(fields) },
});

beforeEach(() => {
  redisStore.clear();
  process.env = {
    ...ENV,
    GUMROAD_PRODUCT_STANDARD: 'standard-product',
    GUMROAD_PRODUCT_PRO: 'pro-product',
    GUMROAD_ACCESS_TOKEN: 'gumroad-token',
  };
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...ENV };
});

describe('redeem()', () => {
  it('finds the product the key belongs to, binds its hash, and puts the workspace on that plan', async () => {
    const { service, repository, subscriptions } = setup();
    const { verify } = gumroad({ 'pro-product': ok() });

    await expect(service.redeem('org-1', ` ${KEY.toLowerCase()} `, NOW)).resolves.toEqual({
      ok: true,
      tier: 'PRO',
      period: 'MONTHLY',
      status: 'ACTIVE',
      cancelAt: null,
    });

    // Standard first (404), then Pro; uses counted once, after the bind.
    expect(verify.mock.calls).toEqual([
      ['standard-product', KEY, false],
      ['pro-product', KEY, false],
      ['pro-product', KEY, true],
    ]);
    const created = repository.create.mock.calls[0][0];
    expect(created).toEqual({
      organizationId: 'org-1',
      licenseKeyHash: hashLicenseKey(KEY),
      productId: 'pro-product',
      saleId: SALE,
      tier: 'PRO',
      period: 'MONTHLY',
      status: 'ACTIVE',
      lastVerifiedAt: NOW,
    });
    expect(JSON.stringify(created)).not.toContain(KEY);
    expect(subscriptions.applyGumroadPlan).toHaveBeenCalledWith('org-1', {
      tier: 'PRO',
      period: 'MONTHLY',
      identifier: `gumroad:${SALE}`,
      cancelAt: null,
    });
  });

  it('writes the plan first, then marks REPLACED only the licenses of another sale', async () => {
    const { service, repository, subscriptions } = setup();
    gumroad({ 'pro-product': ok() });
    await service.redeem('org-1', KEY, NOW);
    expect(repository.replaceOthers).toHaveBeenCalledWith('org-1', SALE);
    expect(subscriptions.applyGumroadPlan.mock.invocationCallOrder[0]).toBeLessThan(
      repository.replaceOthers.mock.invocationCallOrder[0]
    );
  });

  it('one redeem per workspace at a time: a second one gets 409 REDEEM_IN_PROGRESS and asks Gumroad nothing', async () => {
    const { service, repository } = setup();
    const { verify } = gumroad({ 'pro-product': ok() });
    redisStore.set(redeemLockKey('org-1'), 'another-request');
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'REDEEM_IN_PROGRESS' }),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    // Another workspace is not held up, and the lock is released after it.
    await expect(service.redeem('org-2', KEY, NOW)).resolves.toMatchObject({ ok: true });
    expect(redisStore.has(redeemLockKey('org-2'))).toBe(false);
    // Still the other request's: never released by someone else.
    expect(redisStore.get(redeemLockKey('org-1'))).toBe('another-request');
  });

  it('the lock is released when a redeem fails too', async () => {
    const { service } = setup();
    gumroad({});
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_KEY' }),
    });
    expect(redisStore.has(redeemLockKey('org-1'))).toBe(false);
  });

  it('a key another workspace holds: 409, and Gumroad is not asked', async () => {
    const { service, subscriptions } = setup({
      bound: { id: 'lic-1', organizationId: 'org-1', licenseKeyHash: hashLicenseKey(KEY), productId: 'pro-product', tier: 'PRO' },
    });
    const { verify } = gumroad({ 'pro-product': ok() });
    await expect(service.redeem('org-2', KEY, NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'LICENSE_IN_USE' }),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(subscriptions.applyGumroadPlan).not.toHaveBeenCalled();
  });

  it('the same workspace again: re-checked on its own product, no second use counted', async () => {
    const { service, repository, subscriptions } = setup({
      bound: { id: 'lic-1', organizationId: 'org-1', licenseKeyHash: hashLicenseKey(KEY), productId: 'pro-product', tier: 'PRO' },
      plan: { identifier: `gumroad:${SALE}`, cancelAt: null },
    });
    const { verify } = gumroad({ 'pro-product': ok({ subscription_cancelled_at: NEXT_WEEK.toISOString() }) });
    await expect(service.redeem('org-1', KEY, NOW)).resolves.toMatchObject({
      status: 'CANCELLING',
      cancelAt: NEXT_WEEK,
    });
    expect(verify.mock.calls).toEqual([['pro-product', KEY, false]]);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith('lic-1', expect.objectContaining({ status: 'CANCELLING' }));
    expect(subscriptions.applyGumroadPlan).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ cancelAt: NEXT_WEEK })
    );
  });

  it.each([
    ['a Razorpay plan', { identifier: 'sub_live', cancelAt: null }],
    ['a Razorpay plan set to end (or a halted renewal in its grace)', { identifier: 'sub_halted', cancelAt: NEXT_WEEK }],
    ['a lifetime plan', { identifier: 'LIFETIME', isLifetime: true, cancelAt: null }],
  ])('%s on file: 409 PLAN_ON_FILE, nothing bound', async (_label, plan) => {
    const { service, repository } = setup({ plan });
    const { verify } = gumroad({ 'pro-product': ok() });
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'PLAN_ON_FILE' }),
    });
    expect(verify).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ refunded: true }, 'REFUNDED'],
    [{ chargebacked: true }, 'REFUNDED'],
    [{ subscription_failed_at: '2026-10-20T00:00:00Z' }, 'CANCELLED'],
    [{ subscription_cancelled_at: '2026-10-20T00:00:00Z' }, 'CANCELLED'],
    [{ recurrence: null }, 'NOT_A_SUBSCRIPTION'],
  ])('a purchase with %j is refused with %s', async (fields, code) => {
    const { service, repository, subscriptions } = setup();
    gumroad({ 'pro-product': ok(fields) });
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code }),
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(subscriptions.applyGumroadPlan).not.toHaveBeenCalled();
  });

  it('an unknown key: INVALID_KEY after asking each product; a disabled one: DISABLED', async () => {
    const { service } = setup();
    gumroad({});
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 400,
      response: expect.objectContaining({ code: 'INVALID_KEY' }),
    });
    gumroad({
      'standard-product': { status: 404, body: { success: false, message: 'This license key has been disabled.' } },
    });
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DISABLED' }),
    });
  });

  it('a Razorpay plan that activated while Gumroad was being asked: 409 PLAN_ON_FILE, nothing bound or written', async () => {
    const { service, repository, subscriptions } = setup();
    // None when the redeem starts; a live Razorpay plan by the time it writes.
    subscriptions.getSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ identifier: 'sub_paid_meanwhile', cancelAt: null } as any);
    gumroad({ 'pro-product': ok() });
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'PLAN_ON_FILE' }),
    });
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(subscriptions.applyGumroadPlan).not.toHaveBeenCalled();
    expect(repository.replaceOthers).not.toHaveBeenCalled();
  });

  it('Gumroad down: 503, nothing bound', async () => {
    const { service, repository } = setup();
    jest.spyOn(GumroadClient.prototype, 'verifyLicense').mockRejectedValue(new Error('timeout'));
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: 'GUMROAD_UNAVAILABLE' }),
    });
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('a key that cannot be one, and Gumroad switched off', async () => {
    const { service } = setup();
    const { verify } = gumroad({});
    await expect(service.redeem('org-1', 'nope', NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'INVALID_KEY' }),
    });
    // Products set, but no token for the re-check: off.
    process.env.GUMROAD_ACCESS_TOKEN = '';
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'GUMROAD_OFF' }),
    });
    process.env.GUMROAD_ACCESS_TOKEN = 'gumroad-token';
    process.env.GUMROAD_PRODUCT_STANDARD = '';
    process.env.GUMROAD_PRODUCT_PRO = '';
    await expect(service.redeem('org-1', KEY, NOW)).rejects.toMatchObject({
      status: 404,
      response: expect.objectContaining({ code: 'GUMROAD_OFF' }),
    });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('reverifyLicenses(): the daily re-check', () => {
  const license = (fields: Record<string, unknown> = {}) => ({
    id: 'lic-1',
    organizationId: 'org-1',
    licenseKeyHash: hashLicenseKey(KEY),
    productId: 'pro-product',
    saleId: SALE,
    tier: 'PRO',
    period: 'MONTHLY',
    status: 'ACTIVE',
    lastVerifiedAt: new Date(NOW.getTime() - REVERIFY_AFTER_MS - 1),
    ...fields,
  });
  const planned = (cancelAt: Date | null = null, identifier = `gumroad:${SALE}`) =>
    new Map([['org-1', { orgDeleted: false, plan: { identifier, isLifetime: false, cancelAt, deletedAt: null } }]]);

  function sweepSetup(row: any, facts: Map<string, any>) {
    const s = setup({ bound: row });
    s.repository.plansFor.mockResolvedValue(facts);
    // The row as the database has it when the sweep reads it again.
    s.subscriptions.getSubscription.mockResolvedValue(facts.get('org-1')?.plan ?? null);
    return s;
  }

  it('refunded: the plan ends (endPlanByIdentifier, its own plan only) and the license says why', async () => {
    const { service, repository, subscriptions } = sweepSetup(license(), planned());
    const { verify, getSale } = gumroad({ 'pro-product': ok({ refunded: true }) });
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 1, authFailures: 0 });
    expect(getSale).toHaveBeenCalledWith(SALE, 'gumroad-token');
    expect(verify).toHaveBeenCalledWith('pro-product', KEY, false);
    expect(subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'REFUNDED', lastVerifiedAt: NOW });
  });

  it('failed renewal: the plan ends', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    gumroad({ 'pro-product': ok({ subscription_failed_at: '2026-10-23T00:00:00Z' }) });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'FAILED', lastVerifiedAt: NOW });
  });

  it('cancelled with paid time left: cancelAt set, the plan kept until then', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    gumroad({ 'pro-product': ok({ subscription_cancelled_at: NEXT_WEEK.toISOString() }) });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.scheduleCancellation).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`, NEXT_WEEK);
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'CANCELLING', lastVerifiedAt: NOW });
  });

  it('active and renewing after a cancellation: the end date is lifted', async () => {
    const { service, subscriptions } = sweepSetup(license({ status: 'CANCELLING' }), planned(NEXT_WEEK));
    gumroad({ 'pro-product': ok() });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.scheduleCancellation).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`, null);
  });

  it('active and nothing to change: only lastVerifiedAt moves', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    gumroad({ 'pro-product': ok() });
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 0, authFailures: 0 });
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'ACTIVE', lastVerifiedAt: NOW });
  });

  it('Gumroad unreachable, or the sale unreadable (a wrong token): nothing changes', async () => {
    for (const [sale, authFailures] of [
      [{ status: 401, body: { success: false, message: 'The access token is invalid' } }, 1],
      [{ status: 404, body: { success: false } }, 0],
    ] as const) {
      const { service, subscriptions, repository } = sweepSetup(license(), planned());
      gumroad({ 'pro-product': ok({ refunded: true }) }, sale);
      await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 0, authFailures });
      expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
      expect(repository.updateIfStatus).not.toHaveBeenCalled();
      jest.restoreAllMocks();
    }
  });

  it('the sale now carries another key (rotated at Gumroad) nobody redeemed: REVOKED, the plan ends', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    gumroad({ 'pro-product': ok() }, { status: 200, body: { success: true, sale: { license_key: 'AAAAAAAA-BBBBBBBB' } } });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'REVOKED', lastVerifiedAt: NOW });
  });

  it('rotated, and the new key is redeemed on the same workspace: this license is REPLACED, the plan is untouched', async () => {
    const NEW_KEY = 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD';
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    repository.findByHash.mockImplementation(async (hash: string) =>
      hash === hashLicenseKey(NEW_KEY)
        ? { id: 'lic-2', organizationId: 'org-1', licenseKeyHash: hash, status: 'ACTIVE', saleId: SALE }
        : null
    );
    const { verify } = gumroad({ 'pro-product': ok() }, { status: 200, body: { success: true, sale: { license_key: NEW_KEY } } });
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 1, authFailures: 0 });
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', 'ACTIVE', { status: 'REPLACED', lastVerifiedAt: NOW });
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('rotated, and the new key is on another workspace: REVOKED, this plan ends', async () => {
    const NEW_KEY = 'AAAAAAAA-BBBBBBBB-CCCCCCCC-DDDDDDDD';
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    repository.findByHash.mockImplementation(async (hash: string) =>
      hash === hashLicenseKey(NEW_KEY)
        ? { id: 'lic-9', organizationId: 'org-elsewhere', licenseKeyHash: hash, status: 'ACTIVE', saleId: SALE }
        : null
    );
    gumroad({ 'pro-product': ok() }, { status: 200, body: { success: true, sale: { license_key: NEW_KEY } } });
    await service.reverifyLicenses(NOW);
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', 'ACTIVE', { status: 'REVOKED', lastVerifiedAt: NOW });
    expect(subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);
  });

  it('a plan that changed after the claim (endPlanByIdentifier deletes nothing): reported, nothing else touched', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    subscriptions.endPlanByIdentifier.mockResolvedValueOnce(false);
    gumroad({ 'pro-product': ok({ refunded: true }) });
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 1, authFailures: 0 });
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', 'ACTIVE', { status: 'REFUNDED', lastVerifiedAt: NOW });
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
  });

  it('a slow run stops at its time budget, inside the lock; the rest stay due for the next run', async () => {
    const s = setup();
    const lic = (id: string, organizationId: string, saleId: string) => ({ ...license(), id, organizationId, saleId });
    s.repository.listDue.mockResolvedValue([lic('lic-a', 'org-a', 'sale-a'), lic('lic-b', 'org-b', 'sale-b')]);
    s.repository.plansFor.mockResolvedValue(
      new Map(
        ['a', 'b'].map((x) => [
          `org-${x}`,
          { orgDeleted: false, plan: { identifier: `gumroad:sale-${x}`, isLifetime: false, cancelAt: null, deletedAt: null } },
        ])
      )
    );
    s.subscriptions.getSubscription.mockImplementation(async (orgId: string) => ({
      identifier: `gumroad:sale-${orgId.slice(4)}`,
      cancelAt: null,
    }));
    // Each sale read takes longer than the whole budget.
    const getSale = jest.spyOn(GumroadClient.prototype, 'getSale').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, body: { success: true, sale: { license_key: KEY } } }), 60))
    );
    jest.spyOn(GumroadClient.prototype, 'verifyLicense').mockResolvedValue(ok());
    s.service.runBudgetMs = 30;
    expect(REVERIFY_RUN_BUDGET_MS).toBeLessThan(REVERIFY_LOCK_MS);

    await expect(s.service.reverifyLicenses(NOW)).resolves.toEqual({
      checked: 1,
      changed: 0,
      authFailures: 0,
      stopped: true,
    });
    expect(getSale).toHaveBeenCalledTimes(1);
    expect(s.repository.updateIfStatus.mock.calls.map(([id]) => id)).not.toContain('lic-b');
  });

  it('the workspace moved to another plan: the license is DETACHED and its plan untouched', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned(null, 'sub_TYd1D4gZnW0EP2'));
    const { verify, getSale } = gumroad({ 'pro-product': ok({ refunded: true }) });
    await service.reverifyLicenses(NOW);
    expect(getSale).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'DETACHED', lastVerifiedAt: NOW });
  });

  it('Gumroad unreadable but the end date it gave has passed: the plan ends anyway', async () => {
    const past = new Date(NOW.getTime() - HOUR);
    const { service, subscriptions, repository } = sweepSetup(
      license({ status: 'CANCELLING' }),
      planned(past)
    );
    gumroad({ 'pro-product': ok() }, { status: 401, body: { success: false } });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'CANCELLED', lastVerifiedAt: NOW });
  });

  it('a key redeemed while the sweep ran (another plan now on the workspace): not ended, DETACHED', async () => {
    const { service, subscriptions, repository } = sweepSetup(license(), planned());
    subscriptions.getSubscription.mockResolvedValue({ identifier: 'gumroad:a-newer-sale', cancelAt: null });
    gumroad({ 'pro-product': ok({ refunded: true }) });
    await service.reverifyLicenses(NOW);
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', expect.any(String), { status: 'DETACHED', lastVerifiedAt: NOW });
  });

  it('without GUMROAD_ACCESS_TOKEN: Gumroad is not read; a plan whose end date has passed still ends', async () => {
    process.env.GUMROAD_ACCESS_TOKEN = '';
    const lapsed = sweepSetup(license({ status: 'CANCELLING' }), planned(new Date(NOW.getTime() - 1000)));
    const { verify, getSale } = gumroad({ 'pro-product': ok() });
    await lapsed.service.reverifyLicenses(NOW);
    expect(getSale).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(lapsed.subscriptions.endPlanByIdentifier).toHaveBeenCalledWith('org-1', `gumroad:${SALE}`);

    const live = sweepSetup(license(), planned());
    await expect(live.service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 0, authFailures: 0 });
    expect(live.subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
  });

  it('another process holds the run lock: this run reads and changes nothing', async () => {
    const { service, repository, subscriptions } = sweepSetup(license(), planned());
    const { getSale } = gumroad({ 'pro-product': ok({ refunded: true }) });
    redisStore.set(REVERIFY_LOCK_KEY, 'the-orchestrator');
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({
      checked: 0,
      changed: 0,
      authFailures: 0,
      skipped: true,
    });
    expect(repository.listDue).not.toHaveBeenCalled();
    expect(getSale).not.toHaveBeenCalled();
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(redisStore.get(REVERIFY_LOCK_KEY)).toBe('the-orchestrator');

    // Released after a run of its own.
    redisStore.clear();
    await service.reverifyLicenses(NOW);
    expect(redisStore.has(REVERIFY_LOCK_KEY)).toBe(false);
  });

  it('a license another run changed after this one read it: the claim fails and the plan is not touched', async () => {
    const { service, repository, subscriptions } = sweepSetup(license(), planned());
    gumroad({ 'pro-product': ok({ refunded: true }) });
    // The other run already ended it: REFUNDED, not the ACTIVE this run read.
    repository.updateIfStatus.mockResolvedValueOnce(false);
    await expect(service.reverifyLicenses(NOW)).resolves.toEqual({ checked: 1, changed: 0, authFailures: 0 });
    expect(repository.updateIfStatus).toHaveBeenCalledWith('lic-1', 'ACTIVE', {
      status: 'REFUNDED',
      lastVerifiedAt: NOW,
    });
    expect(subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
    expect(subscriptions.scheduleCancellation).not.toHaveBeenCalled();
  });

  it('a token Gumroad refuses (401, 403): one error line per run, with the count', async () => {
    const s = setup();
    const lic = (id: string, organizationId: string, saleId: string) => ({
      ...license(),
      id,
      organizationId,
      saleId,
    });
    s.repository.listDue.mockResolvedValue([
      lic('lic-a', 'org-a', 'sale-a'),
      lic('lic-b', 'org-b', 'sale-b'),
      lic('lic-c', 'org-c', 'sale-c'),
    ]);
    s.repository.plansFor.mockResolvedValue(
      new Map(
        ['a', 'b', 'c'].map((x) => [
          `org-${x}`,
          {
            orgDeleted: false,
            plan: { identifier: `gumroad:sale-${x}`, isLifetime: false, cancelAt: null, deletedAt: null },
          },
        ])
      )
    );
    jest
      .spyOn(GumroadClient.prototype, 'getSale')
      .mockResolvedValueOnce({ status: 401, body: { success: false } })
      .mockResolvedValueOnce({ status: 403, body: { success: false } })
      .mockResolvedValueOnce({ status: 401, body: { success: false } });
    const verify = jest.spyOn(GumroadClient.prototype, 'verifyLicense');
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(s.service.reverifyLicenses(NOW)).resolves.toEqual({
      checked: 3,
      changed: 0,
      authFailures: 3,
    });
    const tokenLines = error.mock.calls.filter(([m]) => String(m).includes('GUMROAD_ACCESS_TOKEN'));
    expect(tokenLines).toHaveLength(1);
    expect(String(tokenLines[0][0])).toContain('for 3 of 3 sales');
    expect(verify).not.toHaveBeenCalled();
    expect(s.subscriptions.endPlanByIdentifier).not.toHaveBeenCalled();
  });
});

describe("the owner's sale alert (OwnerSalesAlertService)", () => {
  const alerts = () => ({ notify: jest.fn(async (_alert: any) => 'sent') });
  const withAlerts = (s: ReturnType<typeof setup>) => {
    const a = alerts();
    (s.service as any)._ownerAlerts = a;
    return a;
  };

  it('a first redeem tells the owner once: plan, price, sale, license, test flag', async () => {
    const s = setup();
    const a = withAlerts(s);
    gumroad({ 'pro-product': ok({ price: 2900, currency: 'usd', test: true }) });
    await s.service.redeem('org-1', KEY, NOW);
    expect(a.notify).toHaveBeenCalledTimes(1);
    expect(a.notify.mock.calls[0][0]).toMatchObject({
      event: 'GUMROAD_REDEEMED',
      key: `gumroad-redeem:${SALE}`,
      source: 'gumroad',
      organizationId: 'org-1',
      tier: 'PRO',
      period: 'MONTHLY',
      amount: 29,
      currency: 'usd',
      ids: { sale: SALE, license: 'lic-new' },
      test: true,
    });
    // Never the key itself.
    expect(JSON.stringify(a.notify.mock.calls)).not.toContain(KEY);
  });

  it('the same workspace redeeming its key again: no second alert', async () => {
    const bound = {
      id: 'lic-1',
      organizationId: 'org-1',
      licenseKeyHash: hashLicenseKey(KEY),
      productId: 'pro-product',
      saleId: SALE,
      tier: 'PRO',
      period: 'MONTHLY',
      status: 'ACTIVE',
    };
    const s = setup({ bound });
    const a = withAlerts(s);
    gumroad({ 'pro-product': ok() });
    await s.service.redeem('org-1', KEY, NOW);
    expect(a.notify).not.toHaveBeenCalled();
  });

  it('a refused redeem (key on another workspace) tells nobody', async () => {
    const bound = {
      id: 'lic-1',
      organizationId: 'org-other',
      licenseKeyHash: hashLicenseKey(KEY),
      productId: 'pro-product',
      saleId: SALE,
      tier: 'PRO',
      period: 'MONTHLY',
      status: 'ACTIVE',
    };
    const s = setup({ bound });
    const a = withAlerts(s);
    gumroad({ 'pro-product': ok() });
    await expect(s.service.redeem('org-1', KEY, NOW)).rejects.toThrow();
    expect(a.notify).not.toHaveBeenCalled();
  });

  it('the alert service throwing does not fail the redeem', async () => {
    const s = setup();
    (s.service as any)._ownerAlerts = {
      notify: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    gumroad({ 'pro-product': ok() });
    // notify is fire-and-forget; its rejection is not the redeem's.
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    await expect(s.service.redeem('org-1', KEY, NOW)).resolves.toMatchObject({ ok: true });
    await new Promise((r) => setImmediate(r));
    process.off('unhandledRejection', unhandled);
  });

  describe('the daily re-check', () => {
    const license = (fields: Record<string, unknown> = {}) => ({
      id: 'lic-1',
      organizationId: 'org-1',
      licenseKeyHash: hashLicenseKey(KEY),
      productId: 'pro-product',
      saleId: SALE,
      tier: 'PRO',
      period: 'MONTHLY',
      status: 'ACTIVE',
      lastVerifiedAt: new Date(NOW.getTime() - REVERIFY_AFTER_MS - 1),
      ...fields,
    });
    const planned = (cancelAt: Date | null = null) =>
      new Map([
        ['org-1', { orgDeleted: false, plan: { identifier: `gumroad:${SALE}`, isLifetime: false, cancelAt, deletedAt: null } }],
      ]);
    function sweep(row: any, facts: Map<string, any>) {
      const s = setup({ bound: row });
      s.repository.plansFor.mockResolvedValue(facts);
      s.subscriptions.getSubscription.mockResolvedValue(facts.get('org-1')?.plan ?? null);
      return { ...s, a: withAlerts(s) };
    }

    it('refunded: one alert saying the plan ended', async () => {
      const { service, a } = sweep(license(), planned());
      gumroad({ 'pro-product': ok({ refunded: true }) });
      await service.reverifyLicenses(NOW);
      expect(a.notify).toHaveBeenCalledTimes(1);
      expect(a.notify.mock.calls[0][0]).toMatchObject({
        event: 'GUMROAD_CHANGED',
        key: 'gumroad:lic-1:REFUNDED',
        notes: ['Gumroad membership ACTIVE -> REFUNDED', 'The plan has ended'],
      });
    });

    it("a seller's test sale refunded: the alert is labelled a test", async () => {
      const { service, a } = sweep(license(), planned());
      gumroad({ 'pro-product': ok({ refunded: true, test: true }) });
      await service.reverifyLicenses(NOW);
      expect(a.notify.mock.calls[0][0]).toMatchObject({ key: 'gumroad:lic-1:REFUNDED', test: true });
    });

    it('a real sale refunded: not a test', async () => {
      const { service, a } = sweep(license(), planned());
      gumroad({ 'pro-product': ok({ refunded: true }) });
      await service.reverifyLicenses(NOW);
      expect(a.notify.mock.calls[0][0]).toMatchObject({ test: false });
    });

    it('cancelled with time left: one alert with the end date', async () => {
      const { service, a } = sweep(license(), planned());
      gumroad({ 'pro-product': ok({ subscription_cancelled_at: NEXT_WEEK.toISOString() }) });
      await service.reverifyLicenses(NOW);
      expect(a.notify.mock.calls[0][0]).toMatchObject({
        key: 'gumroad:lic-1:CANCELLING',
        notes: ['Gumroad membership ACTIVE -> CANCELLING', 'The plan ends 2026-10-31'],
      });
    });

    it('renewing again after a cancellation: one alert', async () => {
      const { service, a } = sweep(license({ status: 'CANCELLING' }), planned(NEXT_WEEK));
      gumroad({ 'pro-product': ok() });
      await service.reverifyLicenses(NOW);
      expect(a.notify.mock.calls[0][0]).toMatchObject({
        key: 'gumroad:lic-1:ACTIVE',
        notes: ['Gumroad membership CANCELLING -> ACTIVE', 'The end date was lifted; the plan continues'],
      });
    });

    it('nothing changed, or Gumroad unreadable: no alert', async () => {
      const first = sweep(license(), planned());
      gumroad({ 'pro-product': ok() });
      await first.service.reverifyLicenses(NOW);
      expect(first.a.notify).not.toHaveBeenCalled();
      jest.restoreAllMocks();
      redisStore.clear();

      const second = sweep(license(), planned());
      gumroad({}, { status: 500, body: {} });
      await second.service.reverifyLicenses(NOW);
      expect(second.a.notify).not.toHaveBeenCalled();
    });

    it('a rotated key redeemed again on the same workspace (REPLACED): no alert', async () => {
      const row = license();
      const s = sweep(row, planned());
      // The sale now carries a new key that another license of org-1 holds.
      const newKey = '11111111-22222222-33333333-44444444';
      s.repository.findByHash.mockImplementation(async (hash: string) =>
        hash === hashLicenseKey(newKey) ? { ...row, id: 'lic-2', licenseKeyHash: hash } : hash === row.licenseKeyHash ? row : null
      );
      gumroad({ 'pro-product': ok() }, { status: 200, body: { success: true, sale: { license_key: newKey } } });
      await s.service.reverifyLicenses(NOW);
      expect(s.a.notify).not.toHaveBeenCalled();
    });
  });
});
