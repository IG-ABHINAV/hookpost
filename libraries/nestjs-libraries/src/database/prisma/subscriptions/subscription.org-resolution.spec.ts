import 'reflect-metadata';

// Which workspace a Razorpay subscription is applied to
// (SubscriptionService.createOrUpdateSubscription). One Razorpay customer is
// shared by every workspace with the same billing email, so the workspace
// named by the subscription's notes.orgId decides, and the customer id is only
// the fallback. Repository and services are in-memory fakes.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.org-resolution

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

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';

const CUSTOMER = 'cust_shared';
// The owner's first workspace: what a lookup by customer id finds.
const A = 'org-agency';
// The workspace that just subscribed.
const B = 'org-brand';

function setup(rows: Record<string, any>, channels: Record<string, number>) {
  const repo = {
    getOrganizationByCustomerId: jest.fn(async () => ({ id: A, paymentId: CUSTOMER })),
    getSubscriptionByCustomerId: jest.fn(async () => rows[A] || null),
    getSubscriptionByOrgId: jest.fn(async (id: string) => rows[id] || null),
    createOrUpdateSubscription: jest.fn(async () => undefined),
  };
  const integrations = {
    getIntegrationsList: jest.fn(async (id: string) =>
      Array.from({ length: channels[id] || 0 }, (_, i) => ({ id: `${id}-ch${i}`, disabled: false }))
    ),
    disableIntegrations: jest.fn(async () => undefined),
    changeActiveCron: jest.fn(async () => undefined),
  };
  const organizations = {
    disableOrEnableNonSuperAdminUsers: jest.fn(async () => undefined),
  };
  const service = new SubscriptionService(
    repo as any,
    integrations as any,
    organizations as any,
    {} as any
  );
  return { service, repo, integrations, organizations };
}

const subscribeB = (service: SubscriptionService, org: string | null = B) =>
  service.createOrUpdateSubscription(
    true,
    'sub_b',
    CUSTOMER,
    5,
    'STANDARD',
    'MONTHLY',
    null,
    undefined,
    org || undefined
  );

describe('createOrUpdateSubscription: the workspace comes from notes.orgId', () => {
  it("never touches the owner's other workspace", async () => {
    // A is on Team with 9 channels and team members; B has 7 channels.
    const { service, repo, integrations, organizations } = setup(
      { [A]: { organizationId: A, subscriptionTier: 'TEAM', isLifetime: false } },
      { [A]: 9, [B]: 7 }
    );

    await subscribeB(service);

    // Only B's channels are counted and trimmed to Standard's 5.
    expect(integrations.getIntegrationsList).toHaveBeenCalledWith(B);
    expect(integrations.getIntegrationsList).not.toHaveBeenCalledWith(A);
    expect(integrations.disableIntegrations).toHaveBeenCalledWith(B, 2);
    expect(integrations.disableIntegrations).not.toHaveBeenCalledWith(A, expect.anything());
    // A's team members are not switched off because B is on Standard.
    expect(organizations.disableOrEnableNonSuperAdminUsers).not.toHaveBeenCalled();
    expect(repo.getOrganizationByCustomerId).not.toHaveBeenCalled();
    expect(repo.createOrUpdateSubscription).toHaveBeenCalledWith(
      true,
      'sub_b',
      CUSTOMER,
      5,
      'STANDARD',
      'MONTHLY',
      null,
      undefined,
      { id: B }
    );
  });

  it("is written even when the owner's other workspace holds a lifetime plan", async () => {
    // By customer id this found A's lifetime row and silently skipped B.
    const { service, repo } = setup(
      { [A]: { organizationId: A, subscriptionTier: 'ULTIMATE', isLifetime: true } },
      { [B]: 1 }
    );

    await subscribeB(service);

    expect(repo.createOrUpdateSubscription).toHaveBeenCalledTimes(1);
  });

  it("leaves the workspace's own lifetime plan alone, as before", async () => {
    const { service, repo, integrations } = setup(
      { [B]: { organizationId: B, subscriptionTier: 'ULTIMATE', isLifetime: true } },
      { [B]: 12 }
    );

    expect(await subscribeB(service)).toEqual({});
    expect(repo.createOrUpdateSubscription).not.toHaveBeenCalled();
    expect(integrations.disableIntegrations).not.toHaveBeenCalled();
  });

  it('without an org it still goes by the customer id', async () => {
    const { service, repo, integrations } = setup({}, { [A]: 3 });

    await subscribeB(service, null);

    expect(repo.getOrganizationByCustomerId).toHaveBeenCalledWith(CUSTOMER);
    expect(integrations.getIntegrationsList).toHaveBeenCalledWith(A);
    expect(repo.createOrUpdateSubscription).toHaveBeenCalledTimes(1);
  });
});
