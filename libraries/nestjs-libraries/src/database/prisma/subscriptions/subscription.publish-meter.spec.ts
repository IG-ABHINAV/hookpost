import 'reflect-metadata';

// The Free plan's publish meter (SubscriptionService.publishWithinPlan): the
// orchestrator publishes every post through it. Real service and repository,
// with the Prisma transaction faked in memory.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.publish-meter

jest.mock('@hookpost/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaRepository: class {},
  PrismaTransaction: class {},
}));
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import dayjs from 'dayjs';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';
import { planMonthStart } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.month';

type CreditRow = {
  id: string;
  organizationId: string;
  type: string;
  credits: number;
  createdAt: Date;
};

const ORG = 'org-free';
// Created 20 days ago, so the current plan month started then.
const ORG_CREATED = dayjs().subtract(20, 'day').toDate();

const setup = (subscription: any = null) => {
  const rows: CreditRow[] = [];
  let seq = 0;

  const tx = {
    $executeRaw: jest.fn(async () => 0),
    credits: {
      aggregate: jest.fn(async ({ where }: any) => ({
        _sum: {
          credits: rows
            .filter(
              (r) =>
                r.organizationId === where.organizationId &&
                r.type === where.type &&
                r.createdAt >= where.createdAt.gte
            )
            .reduce((sum, r) => sum + r.credits, 0),
        },
      })),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `c${++seq}`, createdAt: new Date() };
        rows.push(row);
        return row;
      }),
    },
  };

  const credits = {
    model: {
      credits: {
        delete: jest.fn(async ({ where }: any) => {
          const i = rows.findIndex((r) => r.id === where.id);
          if (i >= 0) rows.splice(i, 1);
        }),
      },
    },
  };

  const subscriptionModel = {
    model: { subscription: { findFirst: jest.fn(async () => subscription) } },
  };

  const repository = new SubscriptionRepository(
    subscriptionModel as any,
    {} as any,
    {} as any,
    credits as any,
    {} as any,
    { model: { $transaction: (fn: any) => fn(tx) } } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any
  );

  const organizationService = {
    getOrgById: jest.fn(async () => ({ id: ORG, createdAt: ORG_CREATED })),
  };

  const service = new SubscriptionService(
    repository,
    {} as any,
    organizationService as any,
    {} as any
  );

  return { service, rows, subscriptionModel, organizationService, credits };
};

const published = () => jest.fn(async () => ({ postId: 'p' }));

const OLD_SECRET = process.env.RAZORPAY_KEY_SECRET;
beforeEach(() => {
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret_unit';
});
afterAll(() => {
  if (OLD_SECRET === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = OLD_SECRET;
});

describe('Free plan (no Subscription row): 30 publishes a month', () => {
  it('publishes posts 1 to 30 and refuses the 31st without calling the platform', async () => {
    const { service, rows } = setup(null);

    for (let i = 0; i < 30; i++) {
      const publish = published();
      await expect(service.publishWithinPlan(ORG, publish)).resolves.toEqual({
        postId: 'p',
      });
      expect(publish).toHaveBeenCalledTimes(1);
    }
    expect(rows.filter((r) => r.type === 'posts')).toHaveLength(30);

    const thirtyFirst = published();
    const refused = service.publishWithinPlan(ORG, thirtyFirst);
    await expect(refused).rejects.toBeInstanceOf(CreditsExceededError);
    await expect(refused).rejects.toMatchObject({
      response: { section: 'posts_per_month', action: 'create' },
      status: 402,
    });
    expect(thirtyFirst).not.toHaveBeenCalled();
    expect(rows).toHaveLength(30);
  });

  it('a publish the platform rejects does not use up the month', async () => {
    const { service, rows } = setup(null);

    const failing = jest.fn(async () => {
      throw new Error('platform said no');
    });
    await expect(service.publishWithinPlan(ORG, failing)).rejects.toThrow(
      'platform said no'
    );
    expect(rows).toHaveLength(0);

    for (let i = 0; i < 30; i++) {
      await service.publishWithinPlan(ORG, published());
    }
    expect(rows).toHaveLength(30);
  });

  it('counts only the current plan month, anchored on the org createdAt', async () => {
    const { service, rows } = setup(null);
    const monthStart = planMonthStart(ORG_CREATED).toDate();

    // 30 publishes in the previous plan month do not count
    for (let i = 0; i < 30; i++) {
      rows.push({
        id: `old${i}`,
        organizationId: ORG,
        type: 'posts',
        credits: 1,
        createdAt: dayjs(monthStart).subtract(1, 'day').toDate(),
      });
    }
    // and neither do AI credits in this one
    rows.push({
      id: 'ai',
      organizationId: ORG,
      type: 'ai_text',
      credits: 1,
      createdAt: new Date(),
    });

    const publish = published();
    await service.publishWithinPlan(ORG, publish);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('meter edge cases', () => {
  it('fails closed when the organization cannot be loaded: the last 30 days count', async () => {
    const { service, rows, organizationService } = setup(null);
    organizationService.getOrgById.mockResolvedValue(null as any);

    for (let i = 0; i < 30; i++) {
      rows.push({
        id: `recent${i}`,
        organizationId: ORG,
        type: 'posts',
        credits: 1,
        createdAt: dayjs().subtract(10, 'day').toDate(),
      });
    }

    const publish = published();
    await expect(service.publishWithinPlan(ORG, publish)).rejects.toBeInstanceOf(
      CreditsExceededError
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it('a failed credit release never replaces the platform error', async () => {
    const { service, credits } = setup(null);
    credits.model.credits.delete.mockRejectedValueOnce(
      new Error('db connection lost')
    );

    const platformError = new Error('refresh_token');
    await expect(
      service.publishWithinPlan(ORG, async () => {
        throw platformError;
      })
    ).rejects.toBe(platformError);
  });
});

describe('not metered', () => {
  it('a paid organization publishes without taking a credit', async () => {
    const { service, rows, organizationService } = setup({
      id: 'sub',
      subscriptionTier: 'STANDARD',
      createdAt: new Date(),
    });

    for (let i = 0; i < 31; i++) {
      await service.publishWithinPlan('org-paid', published());
    }
    expect(rows).toHaveLength(0);
    expect(organizationService.getOrgById).not.toHaveBeenCalled();
  });

  it('an install without billing publishes without looking up a plan', async () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    const { service, rows, subscriptionModel } = setup(null);

    const publish = published();
    await service.publishWithinPlan(ORG, publish);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
    expect(
      subscriptionModel.model.subscription.findFirst
    ).not.toHaveBeenCalled();
  });

  it('a cancelled paid plan (row deleted) falls back to the Free meter, not to unlimited or blocked', async () => {
    // deleteSubscriptionByOrg hard-deletes the row, so a lapsed plan looks
    // exactly like Free: it publishes, within 30 a month.
    const { service, rows } = setup(null);
    await service.publishWithinPlan('org-lapsed', published());
    expect(rows).toHaveLength(1);
  });
});

describe('planMonthStart', () => {
  it('is the latest monthly anniversary of the anchor', () => {
    const anchor = new Date('2026-08-15T10:00:00Z');
    expect(
      planMonthStart(anchor, dayjs('2026-10-17T00:00:00Z')).toISOString()
    ).toBe('2026-10-15T10:00:00.000Z');
    expect(
      planMonthStart(anchor, dayjs('2026-10-10T00:00:00Z')).toISOString()
    ).toBe('2026-09-15T10:00:00.000Z');
  });
});
