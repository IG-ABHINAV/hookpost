/**
 * Affiliate commission for the lifetime of the referred subscription (owner's
 * approval, 22 Oct 2026; it was 12 months). The cookie, the minimum payout and
 * the 10% coupon are unchanged.
 */
import 'reflect-metadata';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);

import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  AFFILIATE_COMMISSION_LIFETIME,
  AFFILIATE_COMMISSION_PERCENT,
  AFFILIATE_COOKIE_DAYS,
  AFFILIATE_COUPON_PERCENT,
  AFFILIATE_MIN_PAYOUT_INR,
  commissionTerm,
  commissionWindowOpen,
  isLifetimeCommission,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const monthsAgo = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

describe('affiliate terms', () => {
  it('30%, for the lifetime; cookie, payout floor and coupon as before', () => {
    expect(AFFILIATE_COMMISSION_PERCENT).toBe(30);
    expect(AFFILIATE_COMMISSION_LIFETIME).toBe(0);
    expect(AFFILIATE_COOKIE_DAYS).toBe(60);
    expect(AFFILIATE_MIN_PAYOUT_INR).toBe(1000);
    expect(AFFILIATE_COUPON_PERCENT).toBe(10);
  });

  it('a window of 0 has no end', () => {
    expect(isLifetimeCommission(0)).toBe(true);
    expect(isLifetimeCommission(null)).toBe(true);
    for (const months of [0, 1, 11, 12, 13, 24, 60, 240]) {
      expect(commissionWindowOpen(0, monthsAgo(months))).toBe(true);
    }
  });

  it('a limited window (a deal made by hand) still ends', () => {
    const now = new Date('2027-10-22T10:00:00Z');
    expect(commissionWindowOpen(12, new Date('2026-10-23T10:00:00Z'), now)).toBe(true);
    expect(commissionWindowOpen(12, new Date('2026-10-22T10:00:00Z'), now)).toBe(false);
    expect(commissionWindowOpen(12, new Date('2025-01-01T00:00:00Z'), now)).toBe(false);
    expect(commissionWindowOpen(3, new Date('2027-08-01T00:00:00Z'), now)).toBe(true);
  });

  it('in words', () => {
    expect(commissionTerm()).toBe('30% of every payment for the first 12 months');
    expect(commissionTerm(30, 12)).toBe(commissionTerm());
    expect(commissionTerm(30, 0)).toBe(
      '30% of every payment, for as long as the customer pays, while the partnership is active'
    );
    expect(commissionTerm(25, 6)).toBe('25% of every payment for the first 6 months');
  });
});

describe('AffiliateService: lifetime commission', () => {
  const setup = (referral: any) => {
    const repository = {
      findReferral: jest.fn(async () => referral),
      findCommissionByPayment: jest.fn(async () => null as any),
      createCommission: jest.fn(async (data: any) => data),
      findByUser: jest.fn(async () => null as any),
      findByCode: jest.fn(async () => null as any),
      findCoupon: jest.fn(async () => null as any),
      create: jest.fn(async (data: any) => ({ id: 'aff-new', ...data })),
      createCoupon: jest.fn(async () => ({})),
    };
    const service = new AffiliateService(repository as any);
    return { service, repository };
  };
  const lifetime = (createdAt: Date) => ({
    createdAt,
    affiliate: { id: 'aff-1', active: true, commissionPercent: 30, commissionMonths: 0 },
  });
  const charge = (id: string, amount: number) => ({
    id,
    amount,
    currency: 'INR',
    status: 'captured',
  });

  it.each([1, 12, 13, 25, 61])(
    'a Standard charge %i months after the referral earns 30%% (₹179.70)',
    async (months) => {
      const { service, repository } = setup(lifetime(monthsAgo(months)));
      await service.recordCommission('org-1', charge(`pay_${months}`, 59900));
      expect(repository.createCommission).toHaveBeenCalledWith({
        affiliateId: 'aff-1',
        organizationId: 'org-1',
        paymentId: `pay_${months}`,
        amount: 59900,
        commission: 17970,
        currency: 'INR',
      });
    }
  );

  it('a yearly Standard charge (₹5,990) earns ₹1,797, the second year too', async () => {
    expect(pricingINR.STANDARD.year_price).toBe(5990);
    for (const months of [0, 12, 24]) {
      const { service, repository } = setup(lifetime(monthsAgo(months)));
      await service.recordCommission('org-1', charge(`pay_y${months}`, 599000));
      expect(repository.createCommission).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 599000, commission: 179700, currency: 'INR' })
      );
    }
  });

  it('an affiliate still on a 12-month window (before the migration) stops after 12 months', async () => {
    const legacy = (createdAt: Date) => ({
      createdAt,
      affiliate: { id: 'aff-1', active: true, commissionPercent: 30, commissionMonths: 12 },
    });
    const inside = setup(legacy(monthsAgo(11)));
    await inside.service.recordCommission('org-1', charge('pay_in', 59900));
    expect(inside.repository.createCommission).toHaveBeenCalled();

    const after = setup(legacy(monthsAgo(13)));
    await after.service.recordCommission('org-1', charge('pay_out', 59900));
    expect(after.repository.createCommission).not.toHaveBeenCalled();
  });

  it('still nothing for a paused affiliate, a failed payment or a repeat', async () => {
    const paused = setup({ ...lifetime(monthsAgo(2)), affiliate: { ...lifetime(new Date()).affiliate, active: false } });
    await paused.service.recordCommission('org-1', charge('pay_p', 59900));
    expect(paused.repository.createCommission).not.toHaveBeenCalled();

    const failed = setup(lifetime(monthsAgo(2)));
    await failed.service.recordCommission('org-1', { ...charge('pay_f', 59900), status: 'failed' });
    expect(failed.repository.createCommission).not.toHaveBeenCalled();

    const repeat = setup(lifetime(monthsAgo(2)));
    repeat.repository.findCommissionByPayment.mockResolvedValue({ id: 'c1' });
    await repeat.service.recordCommission('org-1', charge('pay_r', 59900));
    expect(repeat.repository.createCommission).not.toHaveBeenCalled();
  });

  // 3 Nov 2026: the standard deal for a new affiliate is 12 months again;
  // lifetime ("while partner active") is a deal an admin gives.
  it('a new affiliate is created on 30% for 12 months, whatever the column default is', async () => {
    const { service, repository } = setup(null);
    await service.join(
      { id: 'user-1', name: 'Asha', email: 'asha@example.com' } as any,
      { id: 'org-1' } as any
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ commissionPercent: 30, commissionMonths: 12 })
    );
    expect(repository.createCoupon).toHaveBeenCalledWith(
      expect.stringMatching(/^asha\d{3}$/),
      10,
      'aff-new'
    );
  });
});
