import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

export type PlanAction = 'END' | 'RESTORE';
export type PlanActionStatus = 'PENDING' | 'SUCCESS' | 'FAILED';

/**
 * The record of a plan a super admin ended or restored by hand
 * (AdminPlanActionsService). Written like RefundsRepository's audit: a PENDING
 * row before anything changes, finished with what happened.
 */
@Injectable()
export class PlanActionAuditRepository {
  constructor(private _planActionAudit: PrismaRepository<'planActionAudit'>) {}

  createAudit(data: {
    adminUserId: string;
    adminEmail: string;
    organizationId: string;
    action: PlanAction;
    reason: string;
    correction?: string | null;
    tier?: string | null;
    period?: string | null;
    status: PlanActionStatus;
  }) {
    return this._planActionAudit.model.planActionAudit.create({ data });
  }

  finishAudit(
    id: string,
    data: { status: PlanActionStatus; emailOutcome?: string | null; error?: string | null }
  ) {
    return this._planActionAudit.model.planActionAudit.update({
      where: { id },
      data,
    });
  }

  listAudit(take: number, organizationId?: string) {
    return this._planActionAudit.model.planActionAudit.findMany({
      ...(organizationId ? { where: { organizationId } } : {}),
      orderBy: { createdAt: 'desc' },
      take,
    });
  }
}
