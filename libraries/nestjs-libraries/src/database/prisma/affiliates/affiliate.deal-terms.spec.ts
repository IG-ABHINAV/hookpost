/**
 * Per-affiliate deals (3 Nov 2026): a standard affiliate gets 30% for 12
 * months; an admin can set another percent and a duration in months or
 * "while partner active" (0). Terms are fixed on each referral when it is
 * made, so changing a deal never cuts a customer already referred.
 */
import 'reflect-metadata';

jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.repository',
  () => ({ AffiliateRepository: class {} })
);

import { BadRequestException } from '@nestjs/common';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  AFFILIATE_COMMISSION_LIFETIME,
  AFFILIATE_DEFAULT_COMMISSION_MONTHS,
  AFFILIATE_MAX_COMMISSION_MONTHS,
  AFFILIATE_MAX_COMMISSION_PERCENT,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';

const monthsAgo = (n: number) => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d;
};

function fakeDb() {
  const affiliates: any[] = [];
  const referrals: any[] = [];
  const commissions: any[] = [];
  const repo = {
    findByUser: jest.fn(async (userId: string) => affiliates.find((a) => a.userId === userId) || null),
    findById: jest.fn(async (id: string) => affiliates.find((a) => a.id === id) || null),
    findByCode: jest.fn(async (code: string) => affiliates.find((a) => a.code === code) || null),
    findCoupon: jest.fn(async () => null),
    createCoupon: jest.fn(async () => ({})),
    create: jest.fn(async (data: any) => {
      const row = { id: `aff_${affiliates.length + 1}`, active: true, ...data };
      affiliates.push(row);
      return row;
    }),
    setTerms: jest.fn(async (id: string, data: any) => Object.assign(affiliates.find((a) => a.id === id), data)),
    findReferral: jest.fn(async (organizationId: string) => {
      const r = referrals.find((x) => x.organizationId === organizationId);
      return r ? { ...r, affiliate: affiliates.find((a) => a.id === r.affiliateId) } : null;
    }),
    createReferral: jest.fn(async (affiliateId: string, organizationId: string, terms?: any) => {
      const row = { affiliateId, organizationId, createdAt: new Date(), commissionPercent: null, commissionMonths: null, ...(terms || {}) };
      referrals.push(row);
      return row;
    }),
    findCommissionByPayment: jest.fn(async (paymentId: string) => commissions.find((c) => c.paymentId === paymentId) || null),
    createCommission: jest.fn(async (data: any) => {
      commissions.push(data);
      return data;
    }),
  };
  const service = new AffiliateService(repo as any);
  jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);
  const join = (name: string) =>
    service.join({ id: `user-${name}`, name, email: `${name}@example.test` } as any, { id: `org-${name}` } as any);
  const charge = (orgId: string, id: string, amount = 59900) =>
    service.recordCommission(orgId, { id, amount, currency: 'INR', status: 'captured' });
  return { service, repo, affiliates, referrals, commissions, join, charge };
}

describe('the standard deal', () => {
  it('is 30% for 12 months, written out on the row', async () => {
    expect(AFFILIATE_DEFAULT_COMMISSION_MONTHS).toBe(12);
    const t = fakeDb();
    const a = await t.join('asha');
    expect(a).toMatchObject({ commissionPercent: 30, commissionMonths: 12 });
  });

  it('a standard affiliate earns in month 11 and not in month 13', async () => {
    const t = fakeDb();
    const a = await t.join('asha');
    await t.service.attribute(a.code, { id: 'org-c1', createdAt: new Date() } as any, { id: 'u1' } as any);
    await t.service.attribute(a.code, { id: 'org-c2', createdAt: new Date() } as any, { id: 'u2' } as any);
    t.referrals[0].createdAt = monthsAgo(11);
    t.referrals[1].createdAt = monthsAgo(13);
    await t.charge('org-c1', 'pay_1');
    await t.charge('org-c2', 'pay_2');
    expect(t.commissions.map((c) => c.paymentId)).toEqual(['pay_1']);
  });

  it('an affiliate who joined on lifetime terms keeps them', async () => {
    const t = fakeDb();
    const old = await t.join('early');
    old.commissionMonths = AFFILIATE_COMMISSION_LIFETIME; // as affiliate-lifetime.migration.sql left them
    await t.service.attribute(old.code, { id: 'org-c', createdAt: new Date() } as any, { id: 'u' } as any);
    t.referrals[0].createdAt = monthsAgo(40);
    await t.charge('org-c', 'pay_old');
    expect(t.commissions).toEqual([expect.objectContaining({ commission: 17970 })]);
  });
});

describe('admin deal terms', () => {
  it('a custom percent and "while partner active" pay on new referrals', async () => {
    const t = fakeDb();
    const a = await t.join('lostleblanc');
    await expect(t.service.setTerms(a.id, { commissionPercent: 40, commissionMonths: 0 })).resolves.toEqual({
      id: a.id,
      commissionPercent: 40,
      commissionMonths: 0,
    });
    await t.service.attribute(a.code, { id: 'org-c', createdAt: new Date() } as any, { id: 'u' } as any);
    expect(t.referrals[0]).toMatchObject({ commissionPercent: 40, commissionMonths: 0 });
    t.referrals[0].createdAt = monthsAgo(60);
    await t.charge('org-c', 'pay_1');
    expect(t.commissions[0].commission).toBe(23960); // 40% of ₹599
  });

  it('"while partner active" stops while the partner is paused', async () => {
    const t = fakeDb();
    const a = await t.join('raj');
    await t.service.setTerms(a.id, { commissionMonths: 0 });
    await t.service.attribute(a.code, { id: 'org-c', createdAt: new Date() } as any, { id: 'u' } as any);
    a.active = false;
    await t.charge('org-c', 'pay_paused');
    expect(t.commissions).toHaveLength(0);
  });

  it('a percent or a duration alone changes only that', async () => {
    const t = fakeDb();
    const a = await t.join('mahi');
    await t.service.setTerms(a.id, { commissionPercent: 35 });
    expect(a).toMatchObject({ commissionPercent: 35, commissionMonths: 12 });
    await t.service.setTerms(a.id, { commissionMonths: 24 });
    expect(a).toMatchObject({ commissionPercent: 35, commissionMonths: 24 });
  });

  it('never cuts a customer already referred: a lower deal applies only from now on', async () => {
    const t = fakeDb();
    const a = await t.join('fabian');
    await t.service.setTerms(a.id, { commissionPercent: 40, commissionMonths: 0 });
    await t.service.attribute(a.code, { id: 'org-before', createdAt: new Date() } as any, { id: 'u1' } as any);
    await t.service.setTerms(a.id, { commissionPercent: 20, commissionMonths: 6 });
    await t.service.attributeByCoupon(a.code.toUpperCase(), 'org-after', ['u2']);
    for (const r of t.referrals) r.createdAt = monthsAgo(9);

    await t.charge('org-before', 'pay_before');
    await t.charge('org-after', 'pay_after');
    // Before: 40%, no end, still earning 9 months on. After: 20% for 6 months, ended.
    expect(t.commissions.map((c) => [c.paymentId, c.commission])).toEqual([['pay_before', 23960]]);
  });

  it('a raised deal does not reach back either: each customer keeps the terms they came in on', async () => {
    const t = fakeDb();
    const a = await t.join('chris');
    await t.service.attribute(a.code, { id: 'org-before', createdAt: new Date() } as any, { id: 'u1' } as any);
    await t.service.setTerms(a.id, { commissionPercent: 40 });
    await t.charge('org-before', 'pay_b');
    expect(t.commissions[0].commission).toBe(17970);
  });

  it('a referral from before referrals stored terms falls back to the affiliate\'s', async () => {
    const t = fakeDb();
    const a = await t.join('legacy');
    t.referrals.push({ affiliateId: a.id, organizationId: 'org-legacy', createdAt: new Date(), commissionPercent: null, commissionMonths: null });
    await t.charge('org-legacy', 'pay_l');
    expect(t.commissions[0].commission).toBe(17970);
  });

  it.each([
    ['percent 0', { commissionPercent: 0 }],
    ['negative percent', { commissionPercent: -5 }],
    ['percent over the cap', { commissionPercent: AFFILIATE_MAX_COMMISSION_PERCENT + 1 }],
    ['fractional percent', { commissionPercent: 30.5 }],
    ['negative months', { commissionMonths: -1 }],
    ['months over the cap', { commissionMonths: AFFILIATE_MAX_COMMISSION_MONTHS + 1 }],
    ['fractional months', { commissionMonths: 1.5 }],
    ['nothing', {}],
  ])('refuses %s', async (_label, terms) => {
    const t = fakeDb();
    const a = await t.join('asha');
    await expect(t.service.setTerms(a.id, terms as any)).rejects.toBeInstanceOf(BadRequestException);
    expect(t.repo.setTerms).not.toHaveBeenCalled();
    expect(a).toMatchObject({ commissionPercent: 30, commissionMonths: 12 });
  });

  it('refuses an affiliate that does not exist', async () => {
    const t = fakeDb();
    await expect(t.service.setTerms('aff_nope', { commissionPercent: 40 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the caps allow the deals on the table', async () => {
    const t = fakeDb();
    const a = await t.join('asha');
    await expect(t.service.setTerms(a.id, { commissionPercent: AFFILIATE_MAX_COMMISSION_PERCENT, commissionMonths: AFFILIATE_MAX_COMMISSION_MONTHS })).resolves.toBeDefined();
    await expect(t.service.setTerms(a.id, { commissionPercent: 1, commissionMonths: 1 })).resolves.toBeDefined();
  });
});
