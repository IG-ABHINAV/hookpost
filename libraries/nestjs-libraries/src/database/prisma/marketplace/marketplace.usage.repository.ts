import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

/** What one flush adds to one MarketplaceUsageDay row. */
export interface UsageIncrement {
  marketplace: string;
  product: string;
  day: string;
  calls: number;
  ok: number;
  unauthorized: number;
  forbidden: number;
  rateLimited: number;
  clientErrors: number;
  serverErrors: number;
  credits: number;
  lastCallAt: Date;
}

/**
 * The per-day call counters of the marketplace gateway (MarketplaceUsageDay)
 * and the subscriber and source counts the admin Marketplaces page reads.
 */
@Injectable()
export class MarketplaceUsageRepository {
  constructor(
    private _usage: PrismaRepository<'marketplaceUsageDay'>,
    private _account: PrismaRepository<'marketplaceAccount'>,
    private _organization: PrismaRepository<'organization'>
  ) {}

  /**
   * Adds to the day's row, creating it on the first call of the day.
   * lastCallAt only ever moves forward, and never for a flush that held no
   * call that came through (lastCallAt at the epoch: only 401s).
   */
  async add(inc: UsageIncrement) {
    const counters = {
      calls: inc.calls,
      ok: inc.ok,
      unauthorized: inc.unauthorized,
      forbidden: inc.forbidden,
      rateLimited: inc.rateLimited,
      clientErrors: inc.clientErrors,
      serverErrors: inc.serverErrors,
      credits: inc.credits,
    };
    const key = { marketplace: inc.marketplace, product: inc.product, day: inc.day };
    await this._usage.model.marketplaceUsageDay.upsert({
      where: {
        marketplace_product_day: {
          marketplace: inc.marketplace,
          product: inc.product,
          day: inc.day,
        },
      },
      create: {
        marketplace: inc.marketplace,
        product: inc.product,
        day: inc.day,
        ...counters,
        lastCallAt: inc.lastCallAt,
      },
      update: Object.fromEntries(
        Object.entries(counters).map(([k, v]) => [k, { increment: v }])
      ),
    });
    if (inc.lastCallAt.getTime() > 0) {
      await this._usage.model.marketplaceUsageDay.updateMany({
        where: { ...key, lastCallAt: { lt: inc.lastCallAt } },
        data: { lastCallAt: inc.lastCallAt },
      });
    }
  }

  /** Every row from `fromDay` (inclusive, YYYY-MM-DD). */
  days(fromDay: string) {
    return this._usage.model.marketplaceUsageDay.findMany({
      where: { day: { gte: fromDay } },
      orderBy: { day: 'asc' },
      select: {
        marketplace: true,
        product: true,
        day: true,
        calls: true,
        ok: true,
        unauthorized: true,
        forbidden: true,
        rateLimited: true,
        clientErrors: true,
        serverErrors: true,
        credits: true,
        lastCallAt: true,
      },
    });
  }

  /** The newest call per marketplace, over all days. */
  lastCalls() {
    return this._usage.model.marketplaceUsageDay.groupBy({
      by: ['marketplace'],
      _max: { lastCallAt: true },
    });
  }

  /** Subscribers per marketplace, product, plan and status: a few rows however many there are. */
  async accounts() {
    const rows = await this._account.model.marketplaceAccount.groupBy({
      by: ['marketplace', 'product', 'plan', 'status'],
      _count: { _all: true },
    });
    return rows.map((r) => ({
      marketplace: r.marketplace,
      product: r.product,
      plan: r.plan,
      status: r.status,
      count: r._count._all,
    }));
  }

  /** Subscribers made since `since`, per marketplace. */
  async newAccounts(since: Date): Promise<Record<string, number>> {
    const rows = await this._account.model.marketplaceAccount.groupBy({
      by: ['marketplace'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.marketplace, r._count._all]));
  }

  /** Live workspaces per Organization.source. */
  async sources(): Promise<Record<string, number>> {
    const rows = await this._organization.model.organization.groupBy({
      by: ['source'],
      where: { deletedAt: null },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((r) => [r.source, r._count._all]));
  }
}
