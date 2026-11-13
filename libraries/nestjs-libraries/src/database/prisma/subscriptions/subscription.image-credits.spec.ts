import 'reflect-metadata';

// The post generator's pictures and RSS auto-post have only the workspace id,
// so they take AI image credits through useCreditForOrganizationId. The
// generator used to make any number of paid images per run: the route checks
// only the plan's AI flag. Real service and repository, with the Prisma
// transaction faked in memory.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.image-credits

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
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

type CreditRow = {
  id: string;
  organizationId: string;
  type: string;
  credits: number;
  createdAt: Date;
};

const ORG = 'org-standard';

const setup = (subscription: any) => {
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

  const service = new SubscriptionService(
    repository,
    {} as any,
    {} as any,
    {} as any
  );

  return { service, rows, subscriptionModel };
};

// A Standard plan (a trial is one too) that started 10 days ago.
const standard = () => ({
  organizationId: ORG,
  subscriptionTier: 'STANDARD',
  createdAt: dayjs().subtract(10, 'day').toDate(),
  deletedAt: null,
});

const picture = () => jest.fn(async () => 'aGVsbG8=');

describe('useCreditForOrganizationId (AI images by workspace id)', () => {
  it("reads the workspace's live plan", async () => {
    const { service, subscriptionModel } = setup(standard());
    await service.useCreditForOrganizationId(ORG, 'ai_images', picture());
    expect(subscriptionModel.model.subscription.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, deletedAt: null },
    });
  });

  it("a Standard plan makes its 20 images a month, and the 21st never reaches OpenAI", async () => {
    expect(pricing.STANDARD.image_generation_count).toBe(20);
    const { service, rows } = setup(standard());

    for (let i = 0; i < 20; i++) {
      await expect(
        service.useCreditForOrganizationId(ORG, 'ai_images', picture())
      ).resolves.toBe('aGVsbG8=');
    }
    expect(rows.filter((r) => r.type === 'ai_images')).toHaveLength(20);

    const twentyFirst = picture();
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', twentyFirst)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    expect(twentyFirst).not.toHaveBeenCalled();
    expect(rows).toHaveLength(20);
  });

  it('shares the month with the media library: credits it used count here', async () => {
    const { service, rows } = setup(standard());
    for (let i = 0; i < 20; i++) {
      rows.push({
        id: `media${i}`,
        organizationId: ORG,
        type: 'ai_images',
        credits: 1,
        createdAt: new Date(),
      });
    }
    const run = picture();
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', run)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    expect(run).not.toHaveBeenCalled();
  });

  it('no live plan: no credits, and nothing is asked of OpenAI', async () => {
    const { service, rows } = setup(null);
    const run = picture();
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', run)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    expect(run).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('a picture OpenAI fails to make gives its credit back', async () => {
    const { service, rows } = setup(standard());
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', async () => {
        throw new Error('OpenAI said no');
      })
    ).rejects.toThrow('OpenAI said no');
    expect(rows).toHaveLength(0);
  });
});
