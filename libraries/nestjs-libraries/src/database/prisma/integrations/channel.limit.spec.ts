import 'reflect-metadata';
import { HttpException } from '@nestjs/common';

// A placeholder row from an unfinished two-step connect (Facebook Page,
// Instagram via Facebook Business, YouTube...) must not use up a channel slot,
// and finishing the connect must still respect the plan's allowance.
//   pnpm exec jest -c apps/backend/jest.config.ts channel.limit

// Injection tokens only; the real modules pull in Prisma, Redis, Temporal and
// storage clients.
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository',
  () => ({ IntegrationRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository',
  () => ({ SubscriptionRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository',
  () => ({ AutopostRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service',
  () => ({ NotificationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/upload/upload.factory', () => ({
  UploadFactory: { createStorage: () => ({ uploadSimple: jest.fn() }) },
}));
// An in-memory Redis that honours SET ... NX, enough for the channel-limit lock.
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => {
  const keys = new Map<string, string>();
  return {
    ioRedis: {
      keys,
      set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes('NX') && keys.has(key)) return null;
        keys.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (keys.delete(key) ? 1 : 0)),
      // The compare-and-delete release script: delete only if we still own it.
      eval: jest.fn(async (_script: string, _n: number, key: string, token: string) => {
        if (keys.get(key) === token) {
          keys.delete(key);
          return 1;
        }
        return 0;
      }),
    },
  };
});
jest.mock('nestjs-temporal-core', () => ({ TemporalService: class {} }));

import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { countsTowardChannelLimit } from '@hookpost/nestjs-libraries/database/prisma/integrations/channel.limit';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';

const redis = ioRedis as unknown as {
  keys: Map<string, string>;
  set: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
};

beforeEach(() => {
  redis.keys.clear();
  redis.set.mockClear();
  redis.del.mockClear();
  redis.eval.mockClear();
});

type Row = {
  id: string;
  refreshNeeded: boolean;
  inBetweenSteps: boolean;
  disabled: boolean;
};

const real = (id: string): Row => ({
  id,
  refreshNeeded: false,
  inBetweenSteps: false,
  disabled: false,
});
const placeholder = (id: string): Row => ({
  ...real(id),
  inBetweenSteps: true,
});

const PLACEHOLDER = {
  ...placeholder('ph'),
  organizationId: 'org',
  providerIdentifier: 'facebook',
  token: 'user-token',
  type: 'social',
  additionalSettings: '[]',
  refreshToken: '',
  tokenExpiration: null,
};

const setup = (rows: Row[], subscription: { totalChannels: number } | null) => {
  const repo = {
    getIntegrationsList: jest.fn(async () => rows),
    getIntegrationById: jest.fn(async () => PLACEHOLDER),
    updateIntegration: jest.fn(async () => ({})),
    checkForDeletedOnceAndUpdate: jest.fn(async () => undefined),
    createOrUpdateIntegration: jest.fn(async () => ({})),
    enableChannel: jest.fn(async () => undefined),
  };
  const provider = {
    fetchPageInformation: jest.fn(async (_token: string, item: any) => ({
      id: item.page,
      name: `Page ${item.page}`,
      picture: '',
      access_token: 'page-token',
      username: `page${item.page}`,
    })),
  };
  const manager = { getSocialIntegration: jest.fn(() => provider) };
  const subscriptions = {
    getSubscriptionByOrganizationId: jest.fn(async () => subscription),
  };
  const service = new IntegrationService(
    repo as any,
    {} as any,
    manager as any,
    {} as any,
    {} as any,
    {} as any,
    subscriptions as any
  );
  return { service, repo, provider };
};

describe('countsTowardChannelLimit', () => {
  it('counts a live channel', () => {
    expect(countsTowardChannelLimit(real('a'))).toBe(true);
  });
  it('does not count a placeholder or a channel that needs reconnecting', () => {
    expect(countsTowardChannelLimit(placeholder('a'))).toBe(false);
    expect(
      countsTowardChannelLimit({ ...real('a'), refreshNeeded: true })
    ).toBe(false);
  });
});

describe('saveProviderPage (the page/account pick that finishes a connect)', () => {
  const statusOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return e instanceof HttpException ? e.getStatus() : e;
    }
  };

  it('Free plan, 1 channel + this placeholder: the second channel can be completed', async () => {
    const { service, repo } = setup([real('a'), placeholder('ph')], null);
    await expect(service.saveProviderPage('org', 'ph', { page: '1' })).resolves.toEqual({
      success: true,
      count: 1,
      failed: [],
    });
    expect(repo.updateIntegration).toHaveBeenCalledWith(
      'ph',
      expect.objectContaining({ inBetweenSteps: false, internalId: '1' })
    );
  });

  it('Free plan, 1 channel + stale placeholders from abandoned connects: still completes', async () => {
    const { service } = setup(
      [real('a'), placeholder('old1'), placeholder('old2'), placeholder('ph')],
      null
    );
    expect(await statusOf(service.saveProviderPage('org', 'ph', { page: '1' }))).toBe('ok');
  });

  it('Free plan, 2 channels: completing a third is rejected before anything is saved', async () => {
    const { service, repo, provider } = setup(
      [real('a'), real('b'), placeholder('ph')],
      null
    );
    await expect(
      service.saveProviderPage('org', 'ph', { page: '1' })
    ).rejects.toMatchObject({
      status: 402,
      message:
        'Your plan allows 2 channels and 2 are in use, so you can add 0 more. You selected 1.',
    });
    expect(provider.fetchPageInformation).not.toHaveBeenCalled();
    expect(repo.updateIntegration).not.toHaveBeenCalled();
  });

  it('Free plan, 1 channel: selecting 2 pages at once is still rejected (only 1 slot)', async () => {
    const { service, repo } = setup([real('a'), placeholder('ph')], null);
    expect(
      await statusOf(
        service.saveProviderPage('org', 'ph', [{ page: '1' }, { page: '2' }])
      )
    ).toBe(402);
    expect(repo.updateIntegration).not.toHaveBeenCalled();
  });

  it('paid plan, last slot (4 of 5 + this placeholder): completes', async () => {
    const { service } = setup(
      [real('a'), real('b'), real('c'), real('d'), placeholder('ph')],
      { totalChannels: 5 }
    );
    expect(await statusOf(service.saveProviderPage('org', 'ph', { page: '1' }))).toBe('ok');
  });

  it('paid plan, full (5 of 5): rejected', async () => {
    const { service } = setup(
      [real('a'), real('b'), real('c'), real('d'), real('e'), placeholder('ph')],
      { totalChannels: 5 }
    );
    expect(await statusOf(service.saveProviderPage('org', 'ph', { page: '1' }))).toBe(402);
  });
});

describe('saveProviderPage: one page pick per workspace at a time', () => {
  // Free plan (2 channels), 1 live channel and two connects waiting for their
  // page pick: one slot left. Every repository call yields to the event loop,
  // so two requests interleave the way two tabs submitting together do.
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const race = () => {
    const rows: Row[] = [real('a'), placeholder('ph1'), placeholder('ph2')];
    const repo = {
      getIntegrationById: jest.fn(async (_org: string, id: string) => {
        await tick();
        const row = rows.find((r) => r.id === id);
        return row ? { ...PLACEHOLDER, ...row } : null;
      }),
      getIntegrationsList: jest.fn(async () => {
        await tick();
        return rows.map((r) => ({ ...r }));
      }),
      updateIntegration: jest.fn(async (id: string, data: any) => {
        await tick();
        const row = rows.find((r) => r.id === id)!;
        row.inBetweenSteps = data.inBetweenSteps;
        return {};
      }),
      checkForDeletedOnceAndUpdate: jest.fn(async () => {
        await tick();
      }),
      createOrUpdateIntegration: jest.fn(async () => ({})),
    };
    const provider = {
      fetchPageInformation: jest.fn(async (_token: string, item: any) => {
        await tick();
        return {
          id: item.page,
          name: `Page ${item.page}`,
          picture: '',
          access_token: 'page-token',
          username: `page${item.page}`,
        };
      }),
    };
    const subscriptions = {
      getSubscriptionByOrganizationId: jest.fn(async () => {
        await tick();
        return null;
      }),
    };
    const service = new IntegrationService(
      repo as any,
      {} as any,
      { getSocialIntegration: jest.fn(() => provider) } as any,
      {} as any,
      {} as any,
      {} as any,
      subscriptions as any
    );
    const live = () => rows.filter(countsTowardChannelLimit).length;
    return { service, repo, provider, live };
  };

  const statusOf = (r: PromiseSettledResult<unknown>) =>
    r.status === 'fulfilled'
      ? 'ok'
      : r.reason instanceof HttpException
      ? r.reason.getStatus()
      : r.reason;

  it('two picks finishing at once cannot both pass the allowance', async () => {
    const { service, repo, live } = race();

    const results = await Promise.allSettled([
      service.saveProviderPage('org', 'ph1', { page: '1' }),
      service.saveProviderPage('org', 'ph2', { page: '2' }),
    ]);

    expect(results.map(statusOf)).toEqual(['ok', 409]);
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      'Another channel is being added. Try again in a moment.'
    );
    expect(repo.updateIntegration).toHaveBeenCalledTimes(1);
    expect(live()).toBe(2);
    expect(redis.set).toHaveBeenCalledWith(
      'channel-limit:org',
      expect.any(String),
      'PX',
      35000, // 30 s plus 5 s per page picked
      'NX'
    );
    // Released, so the retry is judged by the allowance, which is now used up.
    expect(redis.keys.has('channel-limit:org')).toBe(false);
    await expect(
      service.saveProviderPage('org', 'ph2', { page: '2' })
    ).rejects.toMatchObject({ status: 402 });
    expect(live()).toBe(2);
  });

  it('a pick in another workspace is not held up by the lock', async () => {
    const { service } = race();
    redis.keys.set('channel-limit:other-org', '1');
    await expect(
      service.saveProviderPage('org', 'ph1', { page: '1' })
    ).resolves.toMatchObject({ success: true, count: 1 });
  });

  it('while another request holds the lock: 409, nothing read or saved, its lock left alone', async () => {
    const { service, repo, provider } = race();
    redis.keys.set('channel-limit:org', '1');
    await expect(
      service.saveProviderPage('org', 'ph1', { page: '1' })
    ).rejects.toMatchObject({ status: 409 });
    expect(repo.getIntegrationsList).not.toHaveBeenCalled();
    expect(provider.fetchPageInformation).not.toHaveBeenCalled();
    expect(repo.updateIntegration).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.keys.has('channel-limit:org')).toBe(true);
  });

  it('releases the lock when the save fails', async () => {
    const { service, provider } = race();
    provider.fetchPageInformation.mockRejectedValueOnce(
      new Error('platform said no')
    );
    await expect(
      service.saveProviderPage('org', 'ph1', { page: '1' })
    ).rejects.toThrow('platform said no');
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'channel-limit:org',
      expect.any(String)
    );
    expect(redis.keys.has('channel-limit:org')).toBe(false);

    // The next attempt is not locked out.
    await expect(
      service.saveProviderPage('org', 'ph1', { page: '1' })
    ).resolves.toMatchObject({ success: true, count: 1 });
  });

  it('releases the lock when the allowance rejects the pick', async () => {
    const { service } = race();
    await expect(
      service.saveProviderPage('org', 'ph1', [{ page: '1' }, { page: '2' }])
    ).rejects.toMatchObject({ status: 402 });
    expect(redis.eval).toHaveBeenCalled();
    expect(redis.keys.has('channel-limit:org')).toBe(false);
  });

  it('never deletes a lock it no longer owns (its own expired and another pick took it)', async () => {
    const { service, provider } = race();
    provider.fetchPageInformation.mockImplementationOnce(async (...args: unknown[]) => {
      // Simulate this pick outliving its TTL: another request now holds the lock.
      redis.keys.set('channel-limit:org', 'another-pick');
      return { id: 'p1', name: 'Page 1', picture: '', username: 'p1', access_token: 't', ...(args as object) };
    });
    await service.saveProviderPage('org', 'ph1', { page: '1' }).catch(() => undefined);
    expect(redis.keys.get('channel-limit:org')).toBe('another-pick');
  });

  it('a failed release does not turn a finished save into an error', async () => {
    const { service } = race();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    redis.eval.mockRejectedValueOnce(new Error('redis down'));
    await expect(
      service.saveProviderPage('org', 'ph1', { page: '1' })
    ).resolves.toMatchObject({ success: true, count: 1 });
    warn.mockRestore();
  });
});

describe('enableChannel', () => {
  const OLD_KEY = process.env.RAZORPAY_KEY_ID;
  beforeAll(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
  });
  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = OLD_KEY;
  });

  it('a placeholder does not block re-enabling a disabled channel', async () => {
    const { service, repo } = setup(
      [real('a'), placeholder('ph'), { ...real('off'), disabled: true }],
      null
    );
    await expect(service.enableChannel('org', 2, 'off')).resolves.toBeUndefined();
    expect(repo.enableChannel).toHaveBeenCalledWith('org', 'off');
  });

  it('two live channels still block it on a 2-channel plan', async () => {
    const { service, repo } = setup(
      [real('a'), real('b'), { ...real('off'), disabled: true }],
      null
    );
    await expect(service.enableChannel('org', 2, 'off')).rejects.toThrow(
      'You have reached the maximum number of channels'
    );
    expect(repo.enableChannel).not.toHaveBeenCalled();
  });
});

// 25 Oct 2026, connect first: a workspace that has to start its trial
// (needs_trial) may connect PRE_TRIAL_CHANNEL_LIMIT (1) channel before it,
// not the Free plan's 2: the page pick of a two-step login is where a
// Facebook or LinkedIn login would otherwise save several at once.
describe('a workspace that has to start its trial', () => {
  const ENV = { ...process.env };
  const CUTOFF = '2026-10-20T00:00:00Z';
  beforeEach(() => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
    process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
    delete process.env.TRIAL_REQUIRED_SINCE_GLOBAL;
    // Since 28 Oct 2026 a new sign-up gets free posts instead: needs_trial is
    // a grandfathered workspace the Free plan sunset reached.
    process.env.FREE_PLAN_SUNSET_AT = '2026-10-21T00:00:00Z';
  });
  afterAll(() => {
    process.env = ENV;
  });

  const facts = (over: Record<string, unknown> = {}) => ({
    id: 'org',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    allowTrial: true,
    isTrailing: true,
    subscription: null,
    users: [{ user: { signupCountry: 'IN' } }],
    _count: { users: 0 },
    ...over,
  });

  const build = (
    rows: Row[],
    planFacts: unknown = facts(),
    live: Record<string, unknown> = {},
    sunsetNoticePromised = false
  ) => {
    const repo = {
      getIntegrationsList: jest.fn(async () => rows),
      getIntegrationById: jest.fn(async () => PLACEHOLDER),
      getIntegrationByInternalId: jest.fn(
        async (_org: string, internalId: string) => live[internalId] || null
      ),
      updateIntegration: jest.fn(async () => ({})),
      checkForDeletedOnceAndUpdate: jest.fn(async () => undefined),
      createOrUpdateIntegration: jest.fn(async () => ({})),
    };
    const provider = {
      fetchPageInformation: jest.fn(async (_token: string, item: any) => ({
        id: item.page,
        name: `Page ${item.page}`,
        picture: '',
        access_token: 'page-token',
        username: `page${item.page}`,
      })),
    };
    const subscriptions = {
      getPlanFacts: jest.fn(async () => planFacts),
      getSubscriptionByOrganizationId: jest.fn(async () => null),
      sunsetNoticePromisedTrial: jest.fn(async () => sunsetNoticePromised),
    };
    const service = new IntegrationService(
      repo as any,
      {} as any,
      { getSocialIntegration: jest.fn(() => provider) } as any,
      {} as any,
      {} as any,
      {} as any,
      subscriptions as any
    );
    return { service, repo, provider, subscriptions };
  };

  describe('preTrialChannelLimit', () => {
    it('null for a grandfathered workspace the sunset reached: it is on its free posts now, not needs_trial (4 Nov 2026)', async () => {
      expect(await build([]).service.preTrialChannelLimit('org')).toBeNull();
    });

    it('null for every other state: free_posts, locked, trialing, active', async () => {
      const cases = [
        // A new sign-up on its free posts: the Free plan's channel allowance.
        facts({ createdAt: new Date('2026-10-22T00:00:00Z') }),
        facts({ allowTrial: false }),
        facts({ subscription: { isLifetime: false, cancelAt: null, deletedAt: null } }),
        facts({ isTrailing: false, subscription: { isLifetime: true, cancelAt: null, deletedAt: null } }),
      ];
      for (const planFacts of cases) {
        expect(await build([], planFacts).service.preTrialChannelLimit('org')).toBeNull();
      }
    });

    it('null without a trial cutoff or without billing, and the workspace is not even read', async () => {
      delete process.env.TRIAL_REQUIRED_SINCE_IN;
      const noCutoff = build([]);
      expect(await noCutoff.service.preTrialChannelLimit('org')).toBeNull();
      expect(noCutoff.subscriptions.getPlanFacts).not.toHaveBeenCalled();

      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      const noBilling = build([]);
      expect(await noBilling.service.preTrialChannelLimit('org')).toBeNull();
      expect(noBilling.subscriptions.getPlanFacts).not.toHaveBeenCalled();
    });

    it('a workspace that cannot be read is not limited by this (fails open, like the gate)', async () => {
      const { service, subscriptions } = build([]);
      subscriptions.getPlanFacts.mockRejectedValueOnce(new Error('db down'));
      expect(await service.preTrialChannelLimit('org')).toBeNull();
    });
  });

  describe('assertPreTrialChannelRoom (the OAuth callback, under the lock)', () => {
    it('no channel yet: passes', async () => {
      await expect(build([]).service.assertPreTrialChannelRoom('org', 1, ['acct-1'])).resolves.toBeUndefined();
    });

    it('one channel: a new account is refused with 402 TRIAL_REQUIRED', async () => {
      await expect(
        build([real('a')]).service.assertPreTrialChannelRoom('org', 1, ['acct-2', ''])
      ).rejects.toMatchObject({
        status: 402,
        response: { code: 'TRIAL_REQUIRED', trial: true, trialDays: 3 },
      });
    });

    it('the 402 names the 7 days a workspace the sunset email promised them to', async () => {
      await expect(
        build([real('a')], facts(), {}, true).service.assertPreTrialChannelRoom('org', 1, ['acct-2'])
      ).rejects.toMatchObject({
        response: {
          trialDays: 7,
          message:
            'You can connect 1 channel before your trial starts. Start your 7-day trial to connect more and schedule posts.',
        },
      });
    });

    it('the same account again (a reconnect, or connected twice) updates its channel and passes', async () => {
      const { service } = build([real('a')], facts(), { 'acct-1': { id: 'a' } });
      await expect(service.assertPreTrialChannelRoom('org', 1, ['acct-1', ''])).resolves.toBeUndefined();
    });

    it('a placeholder or a dead channel does not use up the slot', async () => {
      await expect(
        build([placeholder('ph'), { ...real('b'), refreshNeeded: true }]).service.assertPreTrialChannelRoom('org', 1, ['acct-9'])
      ).resolves.toBeUndefined();
    });

    it('a disabled channel still does', async () => {
      await expect(
        build([{ ...real('a'), disabled: true }]).service.assertPreTrialChannelRoom('org', 1, ['acct-9'])
      ).rejects.toMatchObject({ status: 402 });
    });
  });

  describe('the page pick', () => {
    // The pre-trial limit itself (needs_trial, no longer produced since
    // 4 Nov 2026) is covered by assertPreTrialChannelRoom above.
    it('after the trial starts the plan’s allowance applies again', async () => {
      const { service } = build(
        [real('a'), placeholder('ph')],
        facts({ subscription: { isLifetime: false, cancelAt: null, deletedAt: null } })
      );
      await expect(service.saveProviderPage('org', 'ph', { page: '1' })).resolves.toMatchObject({
        success: true,
      });
    });
  });
});
