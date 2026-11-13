import 'reflect-metadata';

// SubscriptionService.endPlanByIdentifier: how the Gumroad re-check ends a
// plan. Only the workspace's plan with that identifier is deleted, on that
// condition in the delete itself, and the workspace is moved down (channels,
// team members) only when a row was deleted. A plan written since the
// re-check read it (another key, a Razorpay activation) is left alone.
// Repository and services are in-memory fakes; the real-database version is
// in tests/integration/gumroad-license.int.spec.ts.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.gumroad-end

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

import { Logger } from '@nestjs/common';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';

const ORG = 'org-gumroad';
const PLAN = 'gumroad:FO8TXN-dbxYaBdahG97Y-Q==';
const ENV = { ...process.env };

function setup(row: any, deleted = 1) {
  const repo = {
    getSubscription: jest.fn(async () => row),
    getSubscriptionByOrgId: jest.fn(async () => row),
    deleteSubscriptionByOrgAndIdentifier: jest.fn(async () => ({ count: deleted })),
    deleteSubscriptionByOrganizationId: jest.fn(async () => ({ count: 1 })),
  };
  const integrations = {
    getIntegrationsList: jest.fn(async () =>
      Array.from({ length: 8 }, (_, i) => ({ id: `ch${i}`, disabled: false }))
    ),
    disableIntegrations: jest.fn(async () => undefined),
    changeActiveCron: jest.fn(async () => undefined),
  };
  const organizations = { disableOrEnableNonSuperAdminUsers: jest.fn(async () => undefined) };
  const service = new SubscriptionService(
    repo as any,
    integrations as any,
    organizations as any,
    {} as any
  );
  return { service, repo, integrations, organizations };
}

beforeEach(() => {
  // No trial cutoff: a grandfathered workspace falls back to the Free plan.
  process.env = { ...ENV, TRIAL_REQUIRED_SINCE_IN: '', TRIAL_REQUIRED_SINCE_GLOBAL: '' };
});
afterAll(() => {
  process.env = { ...ENV };
});

describe('endPlanByIdentifier', () => {
  it('its own Pro plan: deleted by organization AND identifier, then moved down to Free (channels and team members)', async () => {
    const { service, repo, integrations, organizations } = setup({
      identifier: PLAN,
      subscriptionTier: 'PRO',
    });
    await expect(service.endPlanByIdentifier(ORG, PLAN)).resolves.toBe(true);
    expect(repo.deleteSubscriptionByOrgAndIdentifier).toHaveBeenCalledWith(ORG, PLAN);
    expect(repo.deleteSubscriptionByOrganizationId).not.toHaveBeenCalled();
    // Pro had team members; the row is gone, so the tier being left is passed.
    expect(organizations.disableOrEnableNonSuperAdminUsers).toHaveBeenCalledWith(ORG, true);
    // 8 channels, Free keeps 2.
    expect(integrations.disableIntegrations).toHaveBeenCalledWith(ORG, 6);
    expect(integrations.changeActiveCron).toHaveBeenCalledWith(ORG);
  });

  it('the workspace is on another plan now (a Razorpay one, another key): nothing deleted, nothing moved down', async () => {
    for (const identifier of ['sub_TYd1D4gZnW0EP2', 'gumroad:another-sale']) {
      const { service, repo, integrations, organizations } = setup({
        identifier,
        subscriptionTier: 'PRO',
      });
      await expect(service.endPlanByIdentifier(ORG, PLAN)).resolves.toBe(false);
      expect(repo.deleteSubscriptionByOrgAndIdentifier).not.toHaveBeenCalled();
      expect(integrations.disableIntegrations).not.toHaveBeenCalled();
      expect(organizations.disableOrEnableNonSuperAdminUsers).not.toHaveBeenCalled();
    }
  });

  it('the plan changed between the read and the delete (the delete matched no row): not moved down', async () => {
    const { service, integrations, organizations } = setup(
      { identifier: PLAN, subscriptionTier: 'PRO' },
      0
    );
    await expect(service.endPlanByIdentifier(ORG, PLAN)).resolves.toBe(false);
    expect(integrations.disableIntegrations).not.toHaveBeenCalled();
    expect(organizations.disableOrEnableNonSuperAdminUsers).not.toHaveBeenCalled();
  });

  it('a downgrade that fails after the delete is logged at error level with the org, and rethrown', async () => {
    const { service, integrations } = setup({ identifier: PLAN, subscriptionTier: 'PRO' });
    integrations.getIntegrationsList.mockRejectedValueOnce(new Error('database went away'));
    const error = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    await expect(service.endPlanByIdentifier(ORG, PLAN)).rejects.toThrow('database went away');
    expect(error).toHaveBeenCalledTimes(1);
    const [message, context] = error.mock.calls[0] as [string, string];
    expect(message).toContain(`org ${ORG}`);
    expect(message).toContain('fromTier PRO');
    expect(context).toBe('SubscriptionService');
    error.mockRestore();
  });

  it('no plan at all: false, nothing touched', async () => {
    const { service, repo } = setup(null);
    await expect(service.endPlanByIdentifier(ORG, PLAN)).resolves.toBe(false);
    expect(repo.deleteSubscriptionByOrgAndIdentifier).not.toHaveBeenCalled();
  });
});
