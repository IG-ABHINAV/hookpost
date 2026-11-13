/**
 * Provisioning api.market subscribers and the daily upkeep of their
 * workspaces (MarketplaceAccountService), on a mocked repository. The same
 * against Postgres is tests/integration/marketplace.int.spec.ts.
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.account.service
 */
import { Prisma } from '@prisma/client';
import { MarketplaceAccountService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service';
import { marketplacePlan } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { rapidApiAdapter } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';

jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({ PostsService: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository', () => ({
  MarketplaceAccountRepository: class {},
}));
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: {
    createStorage: () => ({
      ownsFile: () => true,
      removeFile: jest.fn(async () => undefined),
    }),
  },
}));

const USER = 'cll8kolno0000l808v6p3xvax';
const NOW = new Date('2026-10-25T10:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'acc-1',
  externalUserId: USER,
  product: 'social',
  plan: 'trial',
  status: 'ACTIVE',
  organizationId: 'org-1',
  periodStart: new Date('2026-10-20T00:00:00Z'),
  lastSeenAt: new Date('2026-10-25T09:00:00Z'),
  ...over,
});

const repo = () => ({
  find: jest.fn<Promise<any>, any[]>(),
  provision: jest.fn<Promise<any>, any[]>(),
  changePlan: jest.fn(async (_id: string, _org: string, plan: { plan: string }, _now?: Date) =>
    row({ plan: plan.plan, periodStart: NOW })
  ),
  touch: jest.fn(async (_id: string, _now: Date, _wake: boolean) => row({ lastSeenAt: NOW })),
  dormantCandidates: jest.fn(async (_before: Date): Promise<any[]> => []),
  markDormant: jest.fn(async (_id: string, _before: Date) => true),
  scheduledGroups: jest.fn(async (_org: string, _now: Date): Promise<any[]> => []),
  marketplaceOrganizationIds: jest.fn(async (): Promise<any[]> => []),
  expiredMedia: jest.fn(async (_orgs: string[], _before: Date, _type?: string): Promise<any[]> => []),
  queuedMediaPaths: jest.fn(async (_org: string) => new Set<string>()),
  softDeleteMedia: jest.fn(async (_org: string, _id: string) => ({ count: 1 })),
});

describe('resolve', () => {
  it('creates the workspace on the first call, with the plan\'s tier, cap and an apimkt identifier', async () => {
    const r = repo();
    r.find.mockResolvedValue(null);
    r.provision.mockResolvedValue(row());
    const service = new MarketplaceAccountService(r as any, {} as any);
    const out = await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(out.created).toBe(true);
    expect(r.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        externalUserId: USER,
        product: 'social',
        plan: 'trial',
        tier: 'STANDARD',
        totalChannels: 1,
        marketplace: 'API_MARKET',
        identifier: `apimkt:social:${USER}`,
        name: expect.stringMatching(/^api\.market subscriber [0-9a-f]{8}$/),
      })
    );
  });

  it('provisions a RapidAPI subscriber on its own marketplace: its id, identifier, name and source', async () => {
    const r = repo();
    r.find.mockResolvedValue(null);
    r.provision.mockResolvedValue(row({ product: 'social', plan: 'standard' }));
    const service = new MarketplaceAccountService(r as any, {} as any);
    const out = await service.resolve('jane_doe', marketplacePlan('social', 'standard')!, NOW, rapidApiAdapter);
    expect(out.created).toBe(true);
    expect(r.find).toHaveBeenCalledWith('jane_doe', 'social', 'RAPIDAPI');
    expect(r.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        marketplace: 'RAPIDAPI',
        externalUserId: 'jane_doe',
        identifier: 'apimkt:social:rapidapi:jane_doe',
        name: expect.stringMatching(/^RapidAPI subscriber [0-9a-f]{8}$/),
      })
    );
  });

  it('looks an api.market subscriber up on api.market only, by default', async () => {
    const r = repo();
    r.find.mockResolvedValue(row());
    const service = new MarketplaceAccountService(r as any, {} as any);
    await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(r.find).toHaveBeenCalledWith(USER, 'social', 'API_MARKET');
  });

  it('uses the other call\'s workspace when two first calls race (unique index)', async () => {
    const r = repo();
    r.find.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    r.provision.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6' })
    );
    const service = new MarketplaceAccountService(r as any, {} as any);
    const out = await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(out).toMatchObject({ created: false, account: { id: 'acc-1' } });
  });

  it('moves the account to a new plan token\'s plan and restarts its window', async () => {
    const r = repo();
    r.find.mockResolvedValue(row({ plan: 'trial' }));
    const service = new MarketplaceAccountService(r as any, {} as any);
    const out = await service.resolve(USER, marketplacePlan('social', 'pro')!, NOW);
    expect(out.planChanged).toBe(true);
    expect(r.changePlan).toHaveBeenCalledWith('acc-1', 'org-1', { plan: 'pro', tier: 'PRO', totalChannels: 20 }, NOW);
  });

  it('writes lastSeenAt at most every 5 minutes, and wakes a dormant account', async () => {
    const r = repo();
    r.find.mockResolvedValue(row({ lastSeenAt: new Date(NOW.getTime() - 60_000) }));
    const service = new MarketplaceAccountService(r as any, {} as any);
    await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(r.touch).not.toHaveBeenCalled();

    r.find.mockResolvedValue(row({ lastSeenAt: new Date(NOW.getTime() - 10 * 60_000) }));
    await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(r.touch).toHaveBeenLastCalledWith('acc-1', NOW, false);

    r.find.mockResolvedValue(row({ status: 'DORMANT', lastSeenAt: new Date(NOW.getTime() - 60_000) }));
    await service.resolve(USER, marketplacePlan('social', 'trial')!, NOW);
    expect(r.touch).toHaveBeenLastCalledWith('acc-1', NOW, true);
  });
});

describe('sweep', () => {
  it('marks accounts unseen for 40 days dormant and cancels their scheduled posts', async () => {
    const r = repo();
    r.dormantCandidates.mockResolvedValue([{ id: 'acc-1', organizationId: 'org-1' }] as any);
    r.scheduledGroups.mockResolvedValue(['g1', 'g2'] as any);
    const posts = { deletePost: jest.fn(async () => ({ success: true })) };
    const service = new MarketplaceAccountService(r as any, posts as any);
    const out = await service.sweepDormant(NOW);
    expect(r.dormantCandidates.mock.calls[0][0].toISOString()).toBe('2026-09-15T10:00:00.000Z');
    expect(out).toEqual({ accounts: 1, groups: 2 });
    expect(posts.deletePost).toHaveBeenCalledWith('org-1', 'g1');
    expect(posts.deletePost).toHaveBeenCalledWith('org-1', 'g2');
  });

  it('skips an account another run (or a call) claimed first', async () => {
    const r = repo();
    r.dormantCandidates.mockResolvedValue([{ id: 'acc-1', organizationId: 'org-1' }] as any);
    r.markDormant.mockResolvedValue(false);
    const posts = { deletePost: jest.fn() };
    const service = new MarketplaceAccountService(r as any, posts as any);
    expect(await service.sweepDormant(NOW)).toEqual({ accounts: 0, groups: 0 });
    expect(posts.deletePost).not.toHaveBeenCalled();
  });

  it('purges old media and carousel PDFs, never a file a scheduled post still uses', async () => {
    const r = repo();
    r.marketplaceOrganizationIds.mockResolvedValue(['org-1'] as any);
    r.expiredMedia
      .mockResolvedValueOnce([
        { id: 'm1', organizationId: 'org-1', path: 'https://cdn/a.jpg', type: 'image' },
        { id: 'm2', organizationId: 'org-1', path: 'https://cdn/b.jpg', type: 'image' },
      ] as any)
      .mockResolvedValueOnce([{ id: 'p1', organizationId: 'org-1', path: 'https://cdn/c.pdf', type: 'pdf' }] as any);
    r.queuedMediaPaths.mockResolvedValue(new Set(['https://cdn/b.jpg']));
    const service = new MarketplaceAccountService(r as any, {} as any);
    expect(await service.purgeMedia(NOW)).toEqual({ removed: 2, kept: 1 });
    expect(r.softDeleteMedia).toHaveBeenCalledWith('org-1', 'm1');
    expect(r.softDeleteMedia).toHaveBeenCalledWith('org-1', 'p1');
    expect(r.softDeleteMedia).not.toHaveBeenCalledWith('org-1', 'm2');
    // 45 days for media, 7 for PDFs.
    expect(r.expiredMedia.mock.calls[0][1].toISOString()).toBe('2026-09-10T10:00:00.000Z');
    expect(r.expiredMedia.mock.calls[1][1].toISOString()).toBe('2026-10-18T10:00:00.000Z');
    expect(r.expiredMedia.mock.calls[1][2]).toBe('pdf');
  });
});
