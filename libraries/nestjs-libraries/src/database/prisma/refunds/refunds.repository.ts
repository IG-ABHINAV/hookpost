import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

export type RefundAuditStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUSED';

@Injectable()
export class RefundsRepository {
  constructor(
    private _refundAudit: PrismaRepository<'refundAudit'>,
    private _organization: PrismaRepository<'organization'>
  ) {}

  createAudit(data: {
    adminUserId: string;
    adminEmail: string;
    paymentId: string;
    amount: number;
    currency: string;
    reason?: string | null;
    foreign: boolean;
    status: RefundAuditStatus;
    error?: string | null;
    idempotencyKey?: string | null;
    organizationId?: string | null;
  }) {
    return this._refundAudit.model.refundAudit.create({ data });
  }

  finishAudit(
    id: string,
    data: { status: RefundAuditStatus; refundId?: string | null; error?: string | null }
  ) {
    return this._refundAudit.model.refundAudit.update({ where: { id }, data });
  }

  listAudit(take: number) {
    return this._refundAudit.model.refundAudit.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /**
   * The audit rows of refunds this tool made, by Razorpay refund id. Oldest
   * first, so a caller keying them by refund id keeps the newest.
   */
  auditByRefundIds(refundIds: string[]) {
    return this._refundAudit.model.refundAudit.findMany({
      where: { refundId: { in: refundIds } },
      select: { refundId: true, adminEmail: true, reason: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  organizationNames(ids: string[]) {
    return this._organization.model.organization.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
}
