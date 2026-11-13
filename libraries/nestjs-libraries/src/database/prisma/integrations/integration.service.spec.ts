import 'reflect-metadata';

// Only injection tokens; the real modules pull in Prisma, Redis, Temporal,
// storage clients and every social provider.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository',
  () => ({ IntegrationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository',
  () => ({ AutopostRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository',
  () => ({ SubscriptionRepository: class {} })
);
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/integrations/refresh.integration.service', () => ({
  RefreshIntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/integrations/social.abstract', () => ({
  NotEnoughScopes: class extends Error {},
  RefreshToken: class extends Error {},
}));
// saveProviderPage takes a per-workspace lock (SET NX) around the save.
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), eval: jest.fn(async () => 1) },
}));
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple: jest.fn() }) },
}));

import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';

const FB_USER = '10221234567890123';

const setup = () => {
  const repository = {
    getIntegrationById: jest.fn(async () => ({
      id: 'login-row',
      organizationId: 'org-a',
      internalId: FB_USER,
      rootInternalId: FB_USER,
      providerIdentifier: 'facebook',
      type: 'social',
      token: 'user-token',
      refreshToken: 'user-token',
      tokenExpiration: null,
      additionalSettings: '[]',
      inBetweenSteps: true,
    })),
    getIntegrationsList: jest.fn(async () => []),
    checkForDeletedOnceAndUpdate: jest.fn(async () => ({ count: 0 })),
    updateIntegration: jest.fn(async () => ({})),
    createOrUpdateIntegration: jest.fn(async () => ({ id: 'new' })),
  };
  const provider = {
    fetchPageInformation: jest.fn(async (_token: string, item: any) => ({
      id: item.page,
      name: `Page ${item.page}`,
      access_token: `page-token-${item.page}`,
      picture: undefined,
      username: `page${item.page}`,
    })),
  };
  const manager = { getSocialIntegration: jest.fn(() => provider) };
  const subscriptions = {
    getSubscriptionByOrganizationId: jest.fn(async () => ({ totalChannels: 10 })),
  };
  const service = new IntegrationService(
    repository as any,
    {} as any,
    manager as any,
    {} as any,
    {} as any,
    {} as any,
    subscriptions as any
  );
  return { service, repository };
};

describe('IntegrationService.saveProviderPage', () => {
  it('gives every page of a multi-page selection the login account as root id', async () => {
    const { service, repository } = setup();
    const result = await service.saveProviderPage('org-a', 'login-row', [
      { page: '111' },
      { page: '222' },
      { page: '333' },
    ]);
    expect(result).toEqual({ success: true, count: 3, failed: [] });

    // Page 1 takes over the login's row, which already has the root id.
    expect(repository.updateIntegration).toHaveBeenCalledWith(
      'login-row',
      expect.objectContaining({ internalId: '111' })
    );

    // Pages 2 and 3: their own id, the login's root id (the 17th argument).
    const calls = repository.createOrUpdateIntegration.mock.calls as any[];
    expect(calls.map((c) => c[6])).toEqual(['222', '333']);
    expect(calls.map((c) => c[16])).toEqual([FB_USER, FB_USER]);
  });
});

describe('IntegrationService.removeStalePlaceholders', () => {
  const NOW = new Date('2026-10-20T03:00:00Z');

  // Two-step providers pick a page after the login; X and LinkedIn do not.
  const TWO_STEP = new Set(['facebook', 'youtube', 'tumblr', 'linkedin-page']);
  const manager = {
    getAllowedSocialsIntegrations: () => ['facebook', 'youtube', 'tumblr', 'linkedin-page', 'x', 'linkedin'],
    getSocialIntegration: (id: string) => ({ isBetweenSteps: TWO_STEP.has(id) }),
  };
  // A login's row: its own id is its root until a page is picked.
  const placeholder = (id: string, organizationId: string, providerIdentifier: string) => ({
    id,
    organizationId,
    providerIdentifier,
    internalId: `${id}-account`,
    rootInternalId: `${id}-account`,
  });

  const sweep = (stale: any[], failOn?: string) => {
    const repository = {
      getStalePlaceholders: jest.fn(async () => stale),
    };
    const service = new IntegrationService(
      repository as any,
      {} as any,
      manager as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    const deleteChannel = jest
      .spyOn(service, 'deleteChannel')
      .mockImplementation(async (_org: string, id: string) => {
        if (id === failOn) throw new Error('temporal unreachable');
        return {} as any;
      });
    return { service, repository, deleteChannel };
  };

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('removes placeholders older than 24 h the way a user removes a channel', async () => {
    const { service, repository, deleteChannel } = sweep([
      placeholder('fb-1', 'org-a', 'facebook'),
      placeholder('yt-1', 'org-b', 'youtube'),
    ]);
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(2);
    expect(repository.getStalePlaceholders).toHaveBeenCalledWith(
      new Date('2026-10-19T03:00:00Z'),
      ['facebook', 'youtube']
    );
    expect(deleteChannel.mock.calls).toEqual([
      ['org-a', 'fb-1'],
      ['org-b', 'yt-1'],
    ]);
  });

  it('never removes a channel that once worked, even marked in between steps', async () => {
    const { service, deleteChannel } = sweep([
      // A picked Facebook Page that a failed token refresh marked
      // (setBetweenRefreshSteps): its root is the login, not itself.
      {
        id: 'fb-page',
        organizationId: 'org-a',
        providerIdentifier: 'facebook',
        internalId: 'page-1',
        rootInternalId: 'fb-user',
      },
      // An X channel marked the same way: X has no page step at all.
      { ...placeholder('x-1', 'org-a', 'x') },
      // No root on file.
      {
        id: 'yt-old',
        organizationId: 'org-a',
        providerIdentifier: 'youtube',
        internalId: 'UC123',
        rootInternalId: null,
      },
      placeholder('fb-1', 'org-a', 'facebook'),
    ]);
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(1);
    expect(deleteChannel.mock.calls).toEqual([['org-a', 'fb-1']]);
  });

  it('never Tumblr: a finished primary blog has the placeholder shape (its id is the login name)', async () => {
    const { service, repository, deleteChannel } = sweep([
      { id: 'blog', organizationId: 'org-a', providerIdentifier: 'tumblr', internalId: 'staff', rootInternalId: 'staff' },
    ]);
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(0);
    expect(deleteChannel).not.toHaveBeenCalled();
    // Not even asked for.
    expect((repository.getStalePlaceholders.mock.calls[0] as any[])[1]).not.toContain('tumblr');
  });

  it('never LinkedIn Page: its login id is the member id, the internalId of a personal LinkedIn channel', async () => {
    // A personal profile channel (one-step linkedin) that a LinkedIn Page
    // connect turned into a linkedin-page row, left on the page picker.
    const { service, repository, deleteChannel } = sweep([
      { id: 'li', organizationId: 'org-a', providerIdentifier: 'linkedin-page', internalId: 'member', rootInternalId: 'member' },
    ]);
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(0);
    expect(deleteChannel).not.toHaveBeenCalled();
    expect((repository.getStalePlaceholders.mock.calls[0] as any[])[1]).not.toContain('linkedin-page');
  });

  it('one that cannot be removed does not stop the rest', async () => {
    const { service, deleteChannel } = sweep(
      [
        placeholder('fb-1', 'org-a', 'facebook'),
        placeholder('fb-2', 'org-a', 'facebook'),
      ],
      'fb-1'
    );
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(1);
    expect(deleteChannel).toHaveBeenCalledTimes(2);
  });

  it('nothing stale, nothing removed', async () => {
    const { service, deleteChannel } = sweep([]);
    await expect(service.removeStalePlaceholders(NOW)).resolves.toBe(0);
    expect(deleteChannel).not.toHaveBeenCalled();
  });

  describe('when the sweep runs', () => {
    const saved = {
      RUN_CRON: process.env.RUN_CRON,
      PLACEHOLDER_SWEEP: process.env.PLACEHOLDER_SWEEP,
      NODE_ENV: process.env.NODE_ENV,
    };
    const restore = (key: keyof typeof saved) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    };
    afterEach(() => {
      restore('RUN_CRON');
      restore('PLACEHOLDER_SWEEP');
      restore('NODE_ENV');
    });

    const scheduled = () => {
      const setInterval = jest
        .spyOn(global, 'setInterval')
        .mockImplementation((() => ({ unref: () => undefined })) as any);
      const setTimeout = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((() => ({ unref: () => undefined })) as any);
      sweep([]).service.onModuleInit();
      // The sweep is on the shared hourly slot (everyAligned, a setTimeout
      // chain), plus the one run 5 minutes after boot.
      const ran = setInterval.mock.calls.length + setTimeout.mock.calls.length > 0;
      setInterval.mockRestore();
      setTimeout.mockRestore();
      return ran;
    };

    it('never under jest', () => {
      process.env.RUN_CRON = 'true';
      process.env.PLACEHOLDER_SWEEP = 'true';
      expect(scheduled()).toBe(false);
    });

    it('not on a deploy alone: RUN_CRON without PLACEHOLDER_SWEEP=true does nothing', () => {
      process.env.NODE_ENV = 'production';
      process.env.RUN_CRON = 'true';
      delete process.env.PLACEHOLDER_SWEEP;
      expect(scheduled()).toBe(false);
    });

    it('with both RUN_CRON and PLACEHOLDER_SWEEP on', () => {
      process.env.NODE_ENV = 'production';
      process.env.RUN_CRON = 'true';
      process.env.PLACEHOLDER_SWEEP = 'true';
      expect(scheduled()).toBe(true);
    });
  });
});
