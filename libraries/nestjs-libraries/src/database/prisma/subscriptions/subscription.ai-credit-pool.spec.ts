import 'reflect-metadata';

// The HOOKPOST tier (the one plan on sale since 8 Nov 2026) has ONE monthly
// pool of 100 AI credits: a text generation takes 1, an image 5 (pricing.ts
// AI_CREDIT_COST). Real service and repository, the Prisma transaction faked
// in memory (the pool is counted with `type: { in: [...] }`).
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.ai-credit-pool

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
import {
  AI_CREDIT_COST,
  pricing,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

type CreditRow = {
  id: string;
  organizationId: string;
  type: string;
  credits: number;
  createdAt: Date;
};

const ORG = 'org-hookpost';

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
                (typeof where.type === 'string'
                  ? r.type === where.type
                  : where.type.in.includes(r.type)) &&
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
        groupBy: jest.fn(async ({ where }: any) => [
          {
            _sum: {
              credits: rows
                .filter(
                  (r) =>
                    r.organizationId === where.organizationId &&
                    (typeof where.type === 'string'
                      ? r.type === where.type
                      : where.type.in.includes(r.type)) &&
                    r.createdAt >= where.createdAt.gte
                )
                .reduce((sum, r) => sum + r.credits, 0),
            },
          },
        ]),
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

// The one plan on sale, started 10 days ago.
const hookpost = () => ({
  organizationId: ORG,
  subscriptionTier: 'HOOKPOST',
  createdAt: dayjs().subtract(10, 'day').toDate(),
  deletedAt: null,
});

const text = () => jest.fn(async () => 'a post');
const picture = () => jest.fn(async () => 'aGVsbG8=');
const used = (rows: { credits: number }[]) =>
  rows.reduce((sum, r) => sum + r.credits, 0);
const org = { id: ORG, subscription: hookpost() } as any;

describe('HOOKPOST AI credits: one pool of 100, text 1, image 5', () => {
  it('the plan and the costs are what the owner set', () => {
    expect(pricing.HOOKPOST.ai_credits).toBe(100);
    expect(AI_CREDIT_COST).toEqual({ ai_text: 1, ai_images: 5, generate_videos: 0 });
    expect(pricing.HOOKPOST.generate_videos).toBe(0);
  });

  it('a text generation takes 1 credit', async () => {
    const { service, rows } = setup(hookpost());
    await service.useCreditForOrganizationId(ORG, 'ai_text', text());
    expect(rows).toEqual([expect.objectContaining({ type: 'ai_text', credits: 1 })]);
  });

  it('an image takes 5 credits', async () => {
    const { service, rows } = setup(hookpost());
    await service.useCreditForOrganizationId(ORG, 'ai_images', picture());
    expect(rows).toEqual([expect.objectContaining({ type: 'ai_images', credits: 5 })]);
  });

  it('20 images use the whole pool; the next image and the next text are refused before the model runs', async () => {
    const { service, rows } = setup(hookpost());
    for (let i = 0; i < 20; i++) {
      await service.useCreditForOrganizationId(ORG, 'ai_images', picture());
    }
    expect(used(rows)).toBe(100);
    const image = picture();
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', image)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    const post = text();
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_text', post)
    ).rejects.toBeInstanceOf(CreditsExceededError);
    expect(image).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(used(rows)).toBe(100);
  });

  it('text and images share it: 97 texts leave 3 credits, too few for an image but enough for 3 texts', async () => {
    const { service, rows } = setup(hookpost());
    for (let i = 0; i < 97; i++) {
      await service.useCreditForOrganizationId(ORG, 'ai_text', text());
    }
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', picture())
    ).rejects.toBeInstanceOf(CreditsExceededError);
    for (let i = 0; i < 3; i++) {
      await service.useCreditForOrganizationId(ORG, 'ai_text', text());
    }
    expect(used(rows)).toBe(100);
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_text', text())
    ).rejects.toBeInstanceOf(CreditsExceededError);
  });

  it('a failed generation gives its credits back', async () => {
    const { service, rows } = setup(hookpost());
    await expect(
      service.useCreditForOrganizationId(ORG, 'ai_images', async () => {
        throw new Error('model down');
      })
    ).rejects.toThrow('model down');
    expect(rows).toHaveLength(0);
  });

  it('checkCredits reports the pool and how many of each kind are left', async () => {
    const { service } = setup(hookpost());
    await service.useCreditForOrganizationId(ORG, 'ai_images', picture());
    await service.useCreditForOrganizationId(ORG, 'ai_text', text());
    await expect(service.checkCredits(org, 'ai_text')).resolves.toEqual({
      credits: 94,
      aiCredits: { left: 94, total: 100, cost: 1 },
    });
    await expect(service.checkCredits(org, 'ai_images')).resolves.toEqual({
      credits: 18,
      aiCredits: { left: 94, total: 100, cost: 5 },
    });
  });

  it('other tiers keep their separate meters (a Standard image is still 1 of 20)', async () => {
    const { service, rows } = setup({ ...hookpost(), subscriptionTier: 'STANDARD' });
    await service.useCreditForOrganizationId(ORG, 'ai_images', picture());
    expect(rows).toEqual([expect.objectContaining({ type: 'ai_images', credits: 1 })]);
  });
});
