import { Injectable } from '@nestjs/common';
import { Period, SubscriptionTier } from '@prisma/client';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import {
  GUMROAD_IDENTIFIER_PREFIX,
  GumroadLicenseStatus,
  LIVE_LICENSE_STATUSES,
} from '@hookpost/nestjs-libraries/services/gumroad.license';

@Injectable()
export class GumroadLicenseRepository {
  constructor(
    private _gumroadLicense: PrismaRepository<'gumroadLicense'>,
    private _subscription: PrismaRepository<'subscription'>,
    private _organization: PrismaRepository<'organization'>
  ) {}

  findByHash(licenseKeyHash: string) {
    return this._gumroadLicense.model.gumroadLicense.findUnique({
      where: { licenseKeyHash },
    });
  }

  create(data: {
    organizationId: string;
    productId: string;
    licenseKeyHash: string;
    saleId: string;
    tier: SubscriptionTier;
    period: Period;
    status: GumroadLicenseStatus;
    lastVerifiedAt: Date;
  }) {
    return this._gumroadLicense.model.gumroadLicense.create({ data });
  }

  update(
    id: string,
    data: Partial<{
      productId: string;
      saleId: string;
      tier: SubscriptionTier;
      period: Period;
      status: GumroadLicenseStatus;
      lastVerifiedAt: Date;
    }>
  ) {
    return this._gumroadLicense.model.gumroadLicense.update({
      where: { id },
      data,
    });
  }

  /**
   * Write `data` only while the license is still in `expected` status: the
   * re-check claims a change from the status it read, so a second process
   * that read the same license earlier changes nothing. True when it wrote.
   */
  async updateIfStatus(
    id: string,
    expected: string,
    data: { status: GumroadLicenseStatus; lastVerifiedAt: Date }
  ) {
    const { count } = await this._gumroadLicense.model.gumroadLicense.updateMany({
      where: { id, status: expected },
      data,
    });
    return count > 0;
  }

  /**
   * The workspace's live licenses for any other sale than `keepSaleId`, the
   * one whose plan was just written: REPLACED. Never the plan's own.
   */
  replaceOthers(organizationId: string, keepSaleId: string) {
    return this._gumroadLicense.model.gumroadLicense.updateMany({
      where: {
        organizationId,
        saleId: { not: keepSaleId },
        status: { in: LIVE_LICENSE_STATUSES },
      },
      data: { status: 'REPLACED' },
    });
  }

  /**
   * Licenses due a re-check, oldest first, at most `take`:
   *  - live ones (ACTIVE, CANCELLING) not verified since `staleBefore`;
   *  - any license whose sale is its workspace's plan right now (identifier
   *    "gumroad:<saleId>"), whatever its status, on the same schedule, unless
   *    a live license of that workspace holds the same sale: a plan must
   *    never be left on a license the re-check skips;
   *  - the live licenses of a workspace whose Gumroad plan was set to end on
   *    a date that has now passed, and that plan's own license, at once.
   * The query asks for exactly these, scoped by workspace, so no row it
   * returns is thrown away: a pile of old REPLACED licenses can never fill
   * the batch and starve a due live one.
   */
  async listDue(staleBefore: Date, now: Date, take: number) {
    const plans = await this._subscription.model.subscription.findMany({
      where: {
        identifier: { startsWith: GUMROAD_IDENTIFIER_PREFIX },
        deletedAt: null,
      },
      select: { organizationId: true, identifier: true, cancelAt: true },
    });
    const saleOf = (identifier: string | null) =>
      String(identifier).slice(GUMROAD_IDENTIFIER_PREFIX.length);

    // A plan's sale held by a live license of the same workspace (a rotated
    // key redeemed again, say) is covered by that one; its old, non-live
    // licenses are not re-checked for it.
    const covered = new Set(
      plans.length
        ? (
            await this._gumroadLicense.model.gumroadLicense.findMany({
              where: {
                saleId: { in: plans.map((p) => saleOf(p.identifier)) },
                status: { in: LIVE_LICENSE_STATUSES },
              },
              select: { organizationId: true, saleId: true },
            })
          ).map((l) => `${l.organizationId}|${l.saleId}`)
        : []
    );
    const uncovered = plans.filter(
      (p) => !covered.has(`${p.organizationId}|${saleOf(p.identifier)}`)
    );
    const lapsed = plans.filter(
      (p) => p.cancelAt && p.cancelAt.getTime() <= now.getTime()
    );
    const uncoveredLapsed = lapsed.filter((p) => uncovered.includes(p));

    return this._gumroadLicense.model.gumroadLicense.findMany({
      where: {
        OR: [
          { status: { in: LIVE_LICENSE_STATUSES }, lastVerifiedAt: { lt: staleBefore } },
          ...uncovered.map((p) => ({
            organizationId: p.organizationId,
            saleId: saleOf(p.identifier),
            lastVerifiedAt: { lt: staleBefore },
          })),
          ...(lapsed.length
            ? [
                {
                  organizationId: { in: lapsed.map((p) => p.organizationId) },
                  status: { in: LIVE_LICENSE_STATUSES },
                },
              ]
            : []),
          ...uncoveredLapsed.map((p) => ({
            organizationId: p.organizationId,
            saleId: saleOf(p.identifier),
          })),
        ],
      },
      orderBy: { lastVerifiedAt: 'asc' },
      take,
    });
  }

  /**
   * The plan row and whether the workspace still exists, for each workspace,
   * in two queries rather than two per license.
   */
  async plansFor(organizationIds: string[]) {
    const ids = [...new Set(organizationIds)];
    if (!ids.length) return new Map<string, PlanFacts>();
    const [plans, orgs] = await Promise.all([
      this._subscription.model.subscription.findMany({
        where: { organizationId: { in: ids } },
        select: {
          organizationId: true,
          identifier: true,
          isLifetime: true,
          cancelAt: true,
          deletedAt: true,
        },
      }),
      this._organization.model.organization.findMany({
        where: { id: { in: ids } },
        select: { id: true, deletedAt: true },
      }),
    ]);
    const out = new Map<string, PlanFacts>();
    for (const org of orgs) {
      out.set(org.id, {
        orgDeleted: !!org.deletedAt,
        plan: plans.find((p) => p.organizationId === org.id) || null,
      });
    }
    return out;
  }
}

export interface PlanFacts {
  orgDeleted: boolean;
  plan: {
    identifier: string | null;
    isLifetime: boolean;
    cancelAt: Date | null;
    deletedAt: Date | null;
  } | null;
}
