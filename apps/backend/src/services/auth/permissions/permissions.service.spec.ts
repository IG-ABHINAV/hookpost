import 'reflect-metadata';

// The "can this org add a channel?" check behind GET /integrations/social/:id,
// the first step of every connect. A placeholder left by an unfinished
// two-step connect (Facebook Page, Instagram via Facebook Business, YouTube...)
// must not use up a slot.
//   pnpm exec jest -c apps/backend/jest.config.ts permissions.service

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock('@hookpost/nestjs-libraries/database/prisma/webhooks/webhooks.service', () => ({
  WebhooksService: class {},
}));

import { PermissionsService } from '@hookpost/backend/services/auth/permissions/permissions.service';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';

const real = { refreshNeeded: false, inBetweenSteps: false, disabled: false };
const placeholder = { ...real, inBetweenSteps: true };

const canAddChannel = async (
  rows: Array<typeof real>,
  subscription: { subscriptionTier: string; totalChannels: number } | null
) => {
  const service = new PermissionsService(
    { getSubscriptionByOrganizationId: jest.fn(async () => subscription), planGate: jest.fn(async () => null) } as any,
    {} as any,
    {
      getIntegrationsList: jest.fn(async () => rows),
      getIntegrationById: jest.fn(async () => null),
    } as any,
    {} as any
  );
  const ability = await service.check('org', new Date(), 'ADMIN', [
    [AuthorizationActions.Create, Sections.CHANNEL],
  ]);
  return ability.can(AuthorizationActions.Create, Sections.CHANNEL);
};

const OLD_KEY = process.env.RAZORPAY_KEY_ID;
beforeAll(() => {
  // Without a Razorpay key every limit is off; the checks only run with one.
  process.env.RAZORPAY_KEY_ID = 'rzp_test_unit';
});
afterAll(() => {
  if (OLD_KEY === undefined) delete process.env.RAZORPAY_KEY_ID;
  else process.env.RAZORPAY_KEY_ID = OLD_KEY;
});

describe('Free plan (2 channels)', () => {
  it('1 channel + 1 placeholder: can still add the second', async () => {
    expect(await canAddChannel([real, placeholder], null)).toBe(true);
  });

  it('2 channels: blocked', async () => {
    expect(await canAddChannel([real, real], null)).toBe(false);
  });

  it('2 channels + a placeholder: blocked', async () => {
    expect(await canAddChannel([real, real, placeholder], null)).toBe(false);
  });
});

describe('paid plan (5 channels)', () => {
  const standard = { subscriptionTier: 'STANDARD', totalChannels: 5 };

  it('last slot with a placeholder (4 + 1): can add', async () => {
    expect(
      await canAddChannel([real, real, real, real, placeholder], standard)
    ).toBe(true);
  });

  it('full (5): blocked', async () => {
    expect(
      await canAddChannel([real, real, real, real, real], standard)
    ).toBe(false);
  });

  // The channel menu's "Reconnect" asks for ?refresh=<internalId>
  // (launches.component.tsx), and a reconnect adds no channel.
  describe('reconnect when full', () => {
    const full = [real, real, real, real, real];
    const reconnect = async (refresh: string) => {
      const getIntegrationByInternalId = jest.fn(
        async (_org: string, internalId: string) =>
          internalId === 'li-acct-1' ? { id: 'ch-1', internalId } : null
      );
      const service = new PermissionsService(
        { getSubscriptionByOrganizationId: jest.fn(async () => standard), planGate: jest.fn(async () => null) } as any,
        {} as any,
        {
          getIntegrationsList: jest.fn(async () => full),
          getIntegrationById: jest.fn(async (_org: string, id: string) =>
            id === 'ch-1' ? { id, internalId: 'li-acct-1' } : null
          ),
          getIntegrationByInternalId,
        } as any,
        {} as any
      );
      const ability = await service.check(
        'org',
        new Date(),
        'ADMIN',
        [[AuthorizationActions.Create, Sections.CHANNEL]],
        refresh
      );
      return {
        allowed: ability.can(AuthorizationActions.Create, Sections.CHANNEL),
        getIntegrationByInternalId,
      };
    };

    it('by the internalId the page sends: allowed', async () => {
      const res = await reconnect('li-acct-1');
      expect(res.allowed).toBe(true);
      expect(res.getIntegrationByInternalId).toHaveBeenCalledWith('org', 'li-acct-1');
    });

    it('an id that is not one of its channels: blocked', async () => {
      expect((await reconnect('not-ours')).allowed).toBe(false);
    });

    it('the database id is not what the link carries: blocked', async () => {
      expect((await reconnect('ch-1')).allowed).toBe(false);
    });
  });
});

// posts_per_month at post creation (POST /posts, /posts/generator*, the public
// API). An org with no Subscription row resolves to FREE: 30 a month, counted
// from the org's createdAt anniversary.
describe('Free plan (30 posts a month)', () => {
  const orgCreated = new Date('2026-08-15T10:00:00Z');

  const check = async (
    postsThisMonth: number,
    section: Sections,
    subscription: { subscriptionTier: string; totalChannels: number; createdAt?: Date } | null = null
  ) => {
    const countPostsFromDay = jest.fn(async () => postsThisMonth);
    const service = new PermissionsService(
      {
        getSubscriptionByOrganizationId: jest.fn(async () => subscription),
        getSubscription: jest.fn(async () => subscription),
        // A paid plan, its payment going through (trial.policy.ts allowsAiFeatures).
        getPlanState: jest.fn(async () => ({ state: subscription ? 'active' : 'free' })),
        aiAccess: jest.fn(async () => ({ state: subscription ? 'active' : 'free', allowed: true })),
        planGate: jest.fn(async () => null),
      } as any,
      { countPostsFromDay } as any,
      {} as any,
      {} as any
    );
    const ability = await service.check('org', orgCreated, 'ADMIN', [
      [AuthorizationActions.Create, section],
    ]);
    return {
      allowed: ability.can(AuthorizationActions.Create, section),
      countPostsFromDay,
    };
  };

  it('post 30 of the month: allowed', async () => {
    expect((await check(29, Sections.POSTS_PER_MONTH)).allowed).toBe(true);
  });

  it('post 31 of the month: blocked', async () => {
    expect((await check(30, Sections.POSTS_PER_MONTH)).allowed).toBe(false);
  });

  it('counts from the latest monthly anniversary of the org createdAt', async () => {
    const { countPostsFromDay } = await check(0, Sections.POSTS_PER_MONTH);
    const from: Date = (countPostsFromDay.mock.calls[0] as any)[1];
    expect(from.getUTCDate()).toBe(15);
    expect(from <= new Date()).toBe(true);
    expect(from > new Date(Date.now() - 32 * 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('Standard: post 31 is allowed (500 a month)', async () => {
    expect(
      (
        await check(30, Sections.POSTS_PER_MONTH, {
          subscriptionTier: 'STANDARD',
          totalChannels: 5,
          createdAt: orgCreated,
        })
      ).allowed
    ).toBe(true);
  });

  it('AI (the post generator and copilot): blocked on Free', async () => {
    expect((await check(0, Sections.AI)).allowed).toBe(false);
  });

  it('AI: allowed on Standard', async () => {
    expect(
      (
        await check(0, Sections.AI, {
          subscriptionTier: 'STANDARD',
          totalChannels: 5,
        })
      ).allowed
    ).toBe(true);
  });

  // pricing.ts autoPost: Standard has webhooks (2) but no RSS autopost.
  it.each([
    [null, false],
    [{ subscriptionTier: 'STANDARD', totalChannels: 5 }, false],
    [{ subscriptionTier: 'TEAM', totalChannels: 10 }, true],
    [{ subscriptionTier: 'PRO', totalChannels: 30 }, true],
    [{ subscriptionTier: 'ULTIMATE', totalChannels: 100 }, true],
  ])('RSS autopost on %j: %s', async (subscription, allowed) => {
    expect((await check(0, Sections.AUTOPOST, subscription as any)).allowed).toBe(allowed);
  });
});
