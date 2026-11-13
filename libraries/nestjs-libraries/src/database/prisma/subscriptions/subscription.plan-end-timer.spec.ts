import 'reflect-metadata';

// SubscriptionService arms, moves and stops the exact plan-end timer
// (plan.end.timer.ts) wherever a plan's end date is written.
//   pnpm exec jest -c apps/backend/jest.config.ts subscription.plan-end-timer

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

/** Where SubscriptionService arms the exact plan-end timer (plan.end.timer.ts). */
function setup() {
  const repo: any = {
    scheduleCancellation: jest.fn(async () => ({ count: 1 })),
    createOrUpdateSubscription: jest.fn(async () => undefined),
    getSubscriptionByIdentifier: jest.fn(async () => ({ organizationId: 'org-c' })),
    getEndingRows: jest.fn(async () => []),
  };
  const timer: any = { arm: jest.fn(async () => undefined) };
  const service = new SubscriptionService(repo, {} as any, {} as any, {} as any, timer);
  jest.spyOn(service as any, 'modifySubscriptionForPlanChange').mockResolvedValue(true);
  jest.spyOn(service as any, 'modifySubscription').mockResolvedValue(true);
  return { service, repo, timer };
}

const AT = new Date('2026-11-11T14:30:00Z');

describe('SubscriptionService: the plan-end timer follows every date written', () => {
  it('a date set (Cancel, halted, reconcile) arms the timer at it', async () => {
    const { service, timer } = setup();
    await service.scheduleCancellation('org-1', 'sub_1', AT);
    expect(timer.arm).toHaveBeenCalledWith('org-1', 'sub_1', AT);
  });

  it('a date lifted stops it', async () => {
    const { service, timer } = setup();
    await service.scheduleCancellation('org-1', 'sub_1', null);
    expect(timer.arm).toHaveBeenCalledWith('org-1', 'sub_1', null);
  });

  it('nothing written (another plan is on file now): the timer is left alone', async () => {
    const { service, repo, timer } = setup();
    repo.scheduleCancellation.mockResolvedValueOnce({ count: 0 });
    await service.scheduleCancellation('org-1', 'sub_old', AT);
    expect(timer.arm).not.toHaveBeenCalled();
  });

  it('a plan written by a webhook arms with its date, or stops a timer with none', async () => {
    const { service, timer } = setup();
    const sec = Math.floor(AT.getTime() / 1000);
    await service.createOrUpdateSubscription(false, 'sub_2', 'cust', 5, 'STANDARD', 'MONTHLY', sec, undefined, 'org-1');
    expect(timer.arm).toHaveBeenLastCalledWith('org-1', 'sub_2', new Date(sec * 1000));
    await service.createOrUpdateSubscription(false, 'sub_3', 'cust', 5, 'STANDARD', 'MONTHLY', null, undefined, 'org-1');
    expect(timer.arm).toHaveBeenLastCalledWith('org-1', 'sub_3', null);
  });

  it('a webhook with only the customer id finds the workspace from the row written', async () => {
    const { service, timer, repo } = setup();
    await service.createOrUpdateSubscription(false, 'sub_4', 'cust', 5, 'STANDARD', 'MONTHLY', null);
    expect(repo.getSubscriptionByIdentifier).toHaveBeenCalledWith('sub_4');
    expect(timer.arm).toHaveBeenCalledWith('org-c', 'sub_4', null);
  });

  it("a lifetime code never arms one", async () => {
    const { service, timer } = setup();
    await service.createOrUpdateSubscription(false, 'code', 'cust', 5, 'PRO', 'MONTHLY', null, 'CODE1');
    expect(timer.arm).not.toHaveBeenCalled();
  });

  it("the sweep's re-arm keeps running timers for every plan set to end", async () => {
    const { service, repo, timer } = setup();
    repo.getEndingRows.mockResolvedValueOnce([
      { organizationId: 'org-a', identifier: 'sub_a', cancelAt: AT },
      { organizationId: 'org-b', identifier: 'sub_b', cancelAt: AT },
    ]);
    expect(await service.armPlanEndTimers(new Date('2026-11-01T00:00:00Z'))).toBe(2);
    expect(timer.arm).toHaveBeenCalledWith('org-a', 'sub_a', AT, 'keep');
    expect(timer.arm).toHaveBeenCalledWith('org-b', 'sub_b', AT, 'keep');
  });
});
