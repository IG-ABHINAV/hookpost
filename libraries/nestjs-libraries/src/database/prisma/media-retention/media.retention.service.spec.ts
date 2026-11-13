/**
 * MediaRetentionService on its own (the integration spec runs it against
 * Postgres): it only runs where RUN_CRON is on, once at a time, writes
 * nothing in a dry run, never throws into a plan-ended email, and one bad
 * workspace never stops the others.
 *
 *   pnpm exec jest -c apps/backend/jest.config.ts media.retention.service
 */
jest.mock('@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service', () => ({
  SubscriptionService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/services/email.service', () => ({ EmailService: class {} }));
const redis = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    set: jest.fn(async (key: string, value: string, ...args: any[]) => {
      if (args.includes('NX') && redis.has(key)) return null;
      redis.set(key, value);
      return 'OK';
    }),
  },
}));
jest.mock('../../../upload/purge.stores', () => ({
  purgeStores: () => [],
  cloudflareCachePurger: () => undefined,
}));

import { MediaRetentionService } from './media.retention.service';

const WRITES = [
  'startClock',
  'claimNotice',
  'claimReminder',
  'markPurged',
  'clear',
  'markPostsWithRemovedMedia',
  'hideMedia',
] as const;

function build() {
  const repo: Record<string, jest.Mock> = {
    rows: jest.fn(async () => []),
    workspacesWithoutPlan: jest.fn(async () => []),
    getWorkspace: jest.fn(async () => ({ id: 'org', name: 'Org', deletedAt: null, source: 'DIRECT' })),
    purgeCandidates: jest.fn(async () => ({ media: [{ id: 'm1', path: 'https://b/x.jpg', thumbnail: null }], pendingUrls: [], keep: new Set(), texts: [] })),
    releaseNotice: jest.fn(async () => ({ count: 1 })),
    releaseReminder: jest.fn(async () => ({ count: 1 })),
    hasScheduledPosts: jest.fn(async () => false),
  };
  for (const w of WRITES) repo[w] = jest.fn(async () => true);
  const purge = {
    keptMediaIds: jest.fn(async () => new Set<string>()),
    findUrlsUsedElsewhere: jest.fn(async () => []),
  };
  const email = { sendEmailSync: jest.fn(async () => true) };
  const orgs = { getTeam: jest.fn(async () => ({ users: [{ user: { email: 'o@x.co' } }] })) };
  const service = new MediaRetentionService(
    repo as any,
    purge as any,
    {} as any,
    orgs as any,
    {} as any,
    email as any
  );
  return { service, repo, email };
}

const store = { ownsFile: () => true, removeFile: jest.fn(async () => undefined) };

describe('the lazy import of the storage clients', () => {
  // The build rewrites the @hookpost aliases of static imports to relative
  // paths, but not the string inside import(): an aliased one was
  // MODULE_NOT_FOUND on the first production run (1 Nov 2026).
  it('uses a relative path that resolves to purge.stores', () => {
    const { readFileSync, existsSync } = require('fs');
    const { join, resolve } = require('path');
    const source = readFileSync(join(__dirname, 'media.retention.service.ts'), 'utf8');
    const specifiers = [...source.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    expect(specifiers).toEqual(['../../../upload/purge.stores']);
    expect(existsSync(resolve(__dirname, `${specifiers[0]}.ts`))).toBe(true);
  });
});

describe('MediaRetentionService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
    redis.clear();
  });

  it('schedules nothing without RUN_CRON, or under test', () => {
    jest.useFakeTimers();
    const { service } = build();
    process.env.RUN_CRON = '';
    service.onModuleInit();
    process.env.RUN_CRON = 'true';
    process.env.NODE_ENV = 'test';
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('the scheduled run takes a lock: a second process in the same slot does nothing', async () => {
    const { service } = build();
    const run = jest.spyOn(service, 'run').mockResolvedValue({} as any);
    await (service as any).runLocked();
    await (service as any).runLocked();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].enabled).toBe(false); // MEDIA_RETENTION_ENABLED unset: dry run
  });

  describe('claimNoticeAtPlanEnd (called from a plan-ended email)', () => {
    it('null with the run off, without reading anything', async () => {
      delete process.env.MEDIA_RETENTION_ENABLED;
      const { service, repo } = build();
      const onClock = jest.spyOn(service, 'onClock');
      expect(await service.claimNoticeAtPlanEnd('org')).toBeNull();
      expect(onClock).not.toHaveBeenCalled();
      expect(repo.startClock).not.toHaveBeenCalled();
    });

    it('null for a workspace not on the clock', async () => {
      process.env.MEDIA_RETENTION_ENABLED = 'true';
      const { service, repo } = build();
      jest.spyOn(service, 'onClock').mockResolvedValue(false);
      expect(await service.claimNoticeAtPlanEnd('org')).toBeNull();
      expect(repo.startClock).not.toHaveBeenCalled();
    });

    it('null when this stretch without a plan was already told (the claim is taken)', async () => {
      process.env.MEDIA_RETENTION_ENABLED = 'true';
      const { service, repo } = build();
      jest.spyOn(service, 'onClock').mockResolvedValue(true);
      repo.claimNotice.mockResolvedValue(false);
      expect(await service.claimNoticeAtPlanEnd('org')).toBeNull();
    });

    it('a claim with the removal date when it starts the clock', async () => {
      process.env.MEDIA_RETENTION_ENABLED = 'true';
      const { service } = build();
      jest.spyOn(service, 'onClock').mockResolvedValue(true);
      const at = new Date('2026-11-01T10:00:00Z');
      expect(await service.claimNoticeAtPlanEnd('org', at)).toEqual({
        organizationId: 'org',
        at,
        removeAt: new Date('2026-12-02T12:00:00Z'),
      });
    });

    it('never throws into the email: a database error is null', async () => {
      process.env.MEDIA_RETENTION_ENABLED = 'true';
      const { service } = build();
      jest.spyOn(service, 'onClock').mockRejectedValue(new Error('relation "MediaRetention" does not exist'));
      jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
      await expect(service.claimNoticeAtPlanEnd('org')).resolves.toBeNull();
    });
  });

  it('without RAZORPAY_KEY_ID it touches nothing (it would read every workspace as paying)', async () => {
    delete process.env.RAZORPAY_KEY_ID;
    const { service, repo } = build();
    repo.rows.mockResolvedValue([{ organizationId: 'x', noticeSentAt: new Date(), removeAt: new Date(), reminderSentAt: null, purgedAt: null }]);
    const report = await service.run({ enabled: true, stores: [store] });
    expect(report.workspaces).toEqual([]);
    expect(repo.rows).not.toHaveBeenCalled();
    for (const w of WRITES) expect(repo[w]).not.toHaveBeenCalled();
  });

  it('a told workspace with nothing due is not scanned', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test';
    const { service, repo } = build();
    jest.spyOn(service, 'onClock').mockResolvedValue(true);
    const soon = new Date(Date.now() + 20 * 86400_000);
    repo.rows.mockResolvedValue([{ organizationId: 'w', noticeSentAt: new Date(), removeAt: soon, reminderSentAt: null, purgedAt: null }]);
    const report = await service.run({ enabled: true, stores: [store] });
    expect(report.workspaces[0].step).toBe('waiting');
    expect(repo.purgeCandidates).not.toHaveBeenCalled();
  });

  it('dry run: everything due, nothing written, sent or removed', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test';
    const { service, repo, email } = build();
    jest.spyOn(service, 'onClock').mockResolvedValue(true);
    const past = new Date(Date.now() - 40 * 86400_000);
    repo.rows.mockResolvedValue([
      { organizationId: 'due', planEndedAt: past, noticeSentAt: past, removeAt: past, reminderSentAt: past, purgedAt: null },
      { organizationId: 'remind', planEndedAt: past, noticeSentAt: past, removeAt: new Date(Date.now() + 86400_000), reminderSentAt: null, purgedAt: null },
    ]);
    repo.workspacesWithoutPlan.mockResolvedValue(['new']);
    const report = await service.run({ enabled: false, stores: [store] });
    expect(report.mode).toBe('dry-run');
    expect(Object.fromEntries(report.workspaces.map((w) => [w.id, w.step]))).toEqual({
      due: 'would-purge',
      remind: 'would-remind',
      new: 'would-notify',
    });
    for (const w of WRITES) expect(repo[w]).not.toHaveBeenCalled();
    expect(email.sendEmailSync).not.toHaveBeenCalled();
    expect(store.removeFile).not.toHaveBeenCalled();
  });

  it('a database blip mid-removal: what went is still recorded, the rest waits for the next run', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test';
    const { service, repo } = build();
    const urls = Array.from({ length: 30 }, (_, i) => `https://b/f${i}.jpg`);
    repo.purgeCandidates.mockResolvedValue({
      media: urls.map((path, i) => ({ id: `m${i}`, path, thumbnail: null })),
      pendingUrls: [],
      keep: new Set(),
      texts: [],
    });
    const past = new Date(Date.now() - 86400_000);
    repo.rows.mockResolvedValue([{ organizationId: 'w', noticeSentAt: past, removeAt: past, reminderSentAt: past, purgedAt: null }]);
    repo.markPostsWithRemovedMedia.mockResolvedValue([]);
    jest
      .spyOn(service, 'onClock')
      .mockResolvedValueOnce(true) // the run's own check
      .mockResolvedValueOnce(true) // right before the files go
      .mockRejectedValueOnce(new Error('connection reset')); // after 25 files
    const removeFile = jest.fn(async () => undefined);
    const report = await service.run({ enabled: true, stores: [{ ownsFile: () => true, removeFile }] });
    expect(report.workspaces[0]).toMatchObject({ step: 'failed', removed: 25 });
    expect(removeFile).toHaveBeenCalledTimes(25);
    expect(repo.markPostsWithRemovedMedia.mock.calls[0][1]).toHaveLength(25);
    expect(repo.hideMedia.mock.calls[0][1]).toHaveLength(25);
    expect(repo.markPurged).not.toHaveBeenCalled();
  });

  it('one workspace failing does not stop the others', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test';
    const { service, repo } = build();
    jest.spyOn(service, 'onClock').mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('boom');
      return true;
    });
    repo.workspacesWithoutPlan.mockResolvedValue(['bad', 'good']);
    repo.startClock.mockResolvedValue({ organizationId: 'good', noticeSentAt: null, removeAt: null, reminderSentAt: null, purgedAt: null });
    const report = await service.run({ enabled: true, stores: [store] });
    expect(report.workspaces.find((w) => w.id === 'bad')).toMatchObject({ step: 'failed', error: 'boom' });
    expect(report.workspaces.find((w) => w.id === 'good')?.step).toBe('notified');
  });
});
