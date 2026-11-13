import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class AffiliateRepository {
  constructor(
    private _affiliate: PrismaRepository<'affiliate'>,
    private _referral: PrismaRepository<'affiliateReferral'>,
    private _commission: PrismaRepository<'affiliateCommission'>,
    private _coupon: PrismaRepository<'coupon'>
  ) {}

  /** Coupon codes are stored upper-case (see SubscriptionService.validateCoupon). */
  findCoupon(code: string) {
    return this._coupon.model.coupon.findUnique({
      where: { code: code.toUpperCase() },
    });
  }

  createCoupon(code: string, percentOff: number, affiliateId: string) {
    return this._coupon.model.coupon.create({
      data: {
        code: code.toUpperCase(),
        percentOff,
        note: `affiliate:${affiliateId}`,
      },
    });
  }

  findByUser(userId: string) {
    return this._affiliate.model.affiliate.findUnique({ where: { userId } });
  }

  findById(id: string) {
    return this._affiliate.model.affiliate.findUnique({ where: { id } });
  }

  findByCode(code: string) {
    return this._affiliate.model.affiliate.findUnique({ where: { code } });
  }

  create(data: {
    userId: string;
    organizationId: string;
    code: string;
    name: string;
    email: string;
    payoutDetails?: string | null;
    commissionPercent?: number;
    /** 0: every payment for as long as the customer pays (affiliate.terms.ts). */
    commissionMonths?: number;
  }) {
    return this._affiliate.model.affiliate.create({ data });
  }

  updatePayout(userId: string, payoutDetails: string | null) {
    return this._affiliate.model.affiliate.update({
      where: { userId },
      data: { payoutDetails },
    });
  }

  setActive(id: string, active: boolean) {
    return this._affiliate.model.affiliate.update({
      where: { id },
      data: { active },
    });
  }

  findReferral(organizationId: string) {
    return this._referral.model.affiliateReferral.findUnique({
      where: { organizationId },
      include: { affiliate: true },
    });
  }

  /** `terms` are the affiliate's deal at this moment, fixed for this customer. */
  createReferral(
    affiliateId: string,
    organizationId: string,
    terms?: { commissionPercent: number; commissionMonths: number }
  ) {
    return this._referral.model.affiliateReferral.create({
      data: { affiliateId, organizationId, ...(terms || {}) },
    });
  }

  setTerms(
    id: string,
    data: { commissionPercent?: number; commissionMonths?: number }
  ) {
    return this._affiliate.model.affiliate.update({ where: { id }, data });
  }

  countReferrals(affiliateId: string) {
    return this._referral.model.affiliateReferral.count({
      where: { affiliateId },
    });
  }

  findCommissionByPayment(paymentId: string) {
    return this._commission.model.affiliateCommission.findUnique({
      where: { paymentId },
    });
  }

  createCommission(data: {
    affiliateId: string;
    organizationId: string;
    paymentId: string;
    amount: number;
    commission: number;
    currency: string;
  }) {
    return this._commission.model.affiliateCommission.create({ data });
  }

  listCommissions(affiliateId: string, take = 50) {
    return this._commission.model.affiliateCommission.findMany({
      where: { affiliateId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  allCommissions(affiliateId: string) {
    return this._commission.model.affiliateCommission.findMany({
      where: { affiliateId },
      select: {
        organizationId: true,
        commission: true,
        currency: true,
        status: true,
      },
    });
  }

  listAffiliates() {
    return this._affiliate.model.affiliate.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { referrals: true } },
        commissions: {
          select: { commission: true, currency: true, status: true },
        },
      },
    });
  }

  listPendingCommissions() {
    return this._commission.model.affiliateCommission.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: {
        affiliate: {
          select: { name: true, email: true, code: true, payoutDetails: true },
        },
      },
    });
  }

  markPaid(ids: string[], note: string | null) {
    return this._commission.model.affiliateCommission.updateMany({
      where: { id: { in: ids }, status: 'PENDING' },
      data: { status: 'PAID', paidAt: new Date(), paidNote: note },
    });
  }

  /** The rows a mark-paid names, to check they are one affiliate's. */
  findCommissionsByIds(ids: string[]) {
    return this._commission.model.affiliateCommission.findMany({
      where: { id: { in: ids } },
      select: { id: true, affiliateId: true, status: true },
    });
  }

  /** A payout already recorded under this transfer reference, if any. */
  findPaidByNote(note: string) {
    return this._commission.model.affiliateCommission.findFirst({
      where: { status: 'PAID', paidNote: note },
      select: { affiliateId: true },
    });
  }

  /** The payment was refunded: its commission, if still unpaid, is void. */
  voidCommissionByPayment(paymentId: string, note: string) {
    return this._commission.model.affiliateCommission.updateMany({
      where: { paymentId, status: 'PENDING' },
      data: { status: 'VOID', paidNote: note },
    });
  }

  voidCommission(id: string, note: string | null) {
    return this._commission.model.affiliateCommission.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'VOID', paidNote: note },
    });
  }
}
