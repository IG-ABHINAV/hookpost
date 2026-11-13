import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { dripUnsubscribeCode } from '@hookpost/nestjs-libraries/emails/drip-unsubscribe';

/**
 * Records and reverses opt-outs from the marketing drip
 * (scripts/lead-campaign/run-lead-drip.js). The opt-out is a UsedCodes row,
 * `unsub:drip:<userId>`, on the user's own workspace; see drip-unsubscribe.ts.
 * Only the drip reads it. Transactional mail is unaffected.
 */
@Injectable()
export class DripUnsubscribeService {
  constructor(private _repo: PrismaRepository<'usedCodes' | 'user'>) {}

  /** True when the user exists (deleted or not) and is now opted out. */
  async unsubscribe(userId: string): Promise<boolean> {
    const user = await this._repo.model.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        organizations: {
          orderBy: { createdAt: 'asc' },
          select: { organizationId: true, role: true },
        },
      },
    });
    if (!user) return false;

    const code = dripUnsubscribeCode(user.id);
    const existing = await this._repo.model.usedCodes.findFirst({
      where: { code },
      select: { id: true },
    });
    if (existing) return true;

    const org =
      user.organizations.find((o) => o.role === 'SUPERADMIN') ||
      user.organizations[0];
    // No workspace means the drip can never pick this person up anyway.
    if (!org) return true;

    await this._repo.model.usedCodes.create({
      data: { code, orgId: org.organizationId },
    });
    return true;
  }

  async resubscribe(userId: string): Promise<boolean> {
    const user = await this._repo.model.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) return false;
    await this._repo.model.usedCodes.deleteMany({
      where: { code: dripUnsubscribeCode(user.id) },
    });
    return true;
  }
}
