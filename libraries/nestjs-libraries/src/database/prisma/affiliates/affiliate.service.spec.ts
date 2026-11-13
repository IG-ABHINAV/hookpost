import 'reflect-metadata';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);

import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';

const setup = (affiliate: any) => {
  const repository = {
    findByUser: jest.fn(async () => affiliate),
    setActive: jest.fn(async () => ({})),
    findByCode: jest.fn(async () => (affiliate ? { ...affiliate, active: false } : null)),
    findReferral: jest.fn(async () => null),
    createReferral: jest.fn(async () => ({})),
  };
  const service = new AffiliateService(repository as any);
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  return { service, repository };
};

describe('AffiliateService.deactivateForDeletedAccount', () => {
  it('switches the deleted account\'s affiliate code off', async () => {
    const { service, repository } = setup({ id: 'aff-1', userId: 'user-1', active: true });
    await expect(service.deactivateForDeletedAccount('user-1')).resolves.toBe(true);
    expect(repository.findByUser).toHaveBeenCalledWith('user-1');
    expect(repository.setActive).toHaveBeenCalledWith('aff-1', false);
  });

  it('does nothing for someone who never joined, or twice', async () => {
    const none = setup(null);
    await expect(none.service.deactivateForDeletedAccount('user-1')).resolves.toBe(false);
    expect(none.repository.setActive).not.toHaveBeenCalled();

    const already = setup({ id: 'aff-1', userId: 'user-1', active: false });
    await expect(already.service.deactivateForDeletedAccount('user-1')).resolves.toBe(false);
    expect(already.repository.setActive).not.toHaveBeenCalled();
  });

  it('a deactivated code no longer attributes new workspaces', async () => {
    const { service, repository } = setup({ id: 'aff-1', userId: 'user-1', organizationId: 'org-1', active: true });
    await service.attribute('jo123', { id: 'org-new', createdAt: new Date() } as any, { id: 'user-9' } as any);
    expect(repository.createReferral).not.toHaveBeenCalled();
  });
});

// PR-4: a USD charge earns its commission in dollars (cents), on the same
// rules as a rupee one.
describe('AffiliateService.recordCommission in USD', () => {
  const commissionSetup = () => {
    const repository = {
      findReferral: jest.fn(async () => ({
        createdAt: new Date(),
        affiliate: { id: 'aff-1', active: true, commissionPercent: 30, commissionMonths: 12 },
      })),
      findCommissionByPayment: jest.fn(async () => null as any),
      createCommission: jest.fn(async (data: any) => data),
    };
    const service = new AffiliateService(repository as any);
    return { service, repository };
  };

  it('30% of a $19 charge is 570 cents, recorded in USD', async () => {
    const { service, repository } = commissionSetup();
    await service.recordCommission('org-us', {
      id: 'pay_usd_1',
      amount: 1900,
      currency: 'USD',
      status: 'captured',
    });
    expect(repository.createCommission).toHaveBeenCalledWith({
      affiliateId: 'aff-1',
      organizationId: 'org-us',
      paymentId: 'pay_usd_1',
      amount: 1900,
      commission: 570,
      currency: 'USD',
    });
  });

  it('a redelivered USD charge is not paid twice', async () => {
    const { service, repository } = commissionSetup();
    repository.findCommissionByPayment.mockResolvedValue({ id: 'existing' });
    await service.recordCommission('org-us', {
      id: 'pay_usd_1',
      amount: 1900,
      currency: 'USD',
      status: 'captured',
    });
    expect(repository.createCommission).not.toHaveBeenCalled();
  });
});
