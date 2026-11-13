import { Injectable } from '@nestjs/common';
import { SubscriptionTier } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import {
  API_MARKET,
  MARKETPLACE_IDENTIFIER_PREFIX,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

export interface ProvisionInput {
  /** MarketplaceAccount.marketplace, also the workspace's Organization.source. */
  marketplace: string;
  externalUserId: string;
  product: string;
  plan: string;
  tier: SubscriptionTier;
  totalChannels: number;
  identifier: string;
  name: string;
  now: Date;
}

/**
 * Rows of marketplace subscribers (MarketplaceAccount) and the workspace each
 * one gets. Nothing here reads or writes Razorpay; every query on posts,
 * media and channels is scoped by the workspace id.
 */
@Injectable()
export class MarketplaceAccountRepository {
  constructor(
    private _account: PrismaRepository<'marketplaceAccount'>,
    private _organization: PrismaRepository<'organization'>,
    private _media: PrismaRepository<'media'>,
    private _integration: PrismaRepository<'integration'>,
    private _post: PrismaRepository<'post'>,
    private _transaction: PrismaTransaction
  ) {}

  find(externalUserId: string, product: string, marketplace: string = API_MARKET) {
    return this._account.model.marketplaceAccount.findUnique({
      where: {
        marketplace_externalUserId_product: {
          marketplace,
          externalUserId,
          product,
        },
      },
    });
  }

  findByOrganization(organizationId: string) {
    return this._account.model.marketplaceAccount.findUnique({
      where: { organizationId },
    });
  }

  /**
   * The subscriber's workspace, its plan row and its account, in one
   * transaction: a race between two first calls ends with one workspace (the
   * unique index refuses the second account, and its workspace and plan row
   * roll back with it).
   *
   * The workspace has no users and no API key, so the public API, the MCP
   * server and the dashboard cannot reach it; it has had no trial and is not
   * trialing, so planState reads its plan row as a paid plan.
   */
  provision(input: ProvisionInput) {
    return this._transaction.model.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.name,
          apiKey: null,
          allowTrial: false,
          isTrailing: false,
          source: input.marketplace,
        },
        select: { id: true },
      });
      await tx.subscription.create({
        data: {
          organizationId: org.id,
          subscriptionTier: input.tier,
          period: 'MONTHLY',
          totalChannels: input.totalChannels,
          identifier: input.identifier,
          isLifetime: false,
          cancelAt: null,
        },
      });
      return tx.marketplaceAccount.create({
        data: {
          marketplace: input.marketplace,
          externalUserId: input.externalUserId,
          product: input.product,
          plan: input.plan,
          organizationId: org.id,
          status: 'ACTIVE',
          firstSeenAt: input.now,
          lastSeenAt: input.now,
          periodStart: input.now,
        },
      });
    });
  }

  /** A new plan token on a later call (upgrade or downgrade): new tier, cap and window. */
  changePlan(
    accountId: string,
    organizationId: string,
    plan: { plan: string; tier: SubscriptionTier; totalChannels: number },
    now: Date
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      await tx.subscription.updateMany({
        where: {
          organizationId,
          identifier: { startsWith: MARKETPLACE_IDENTIFIER_PREFIX },
        },
        data: {
          subscriptionTier: plan.tier,
          totalChannels: plan.totalChannels,
          deletedAt: null,
          cancelAt: null,
        },
      });
      const current = await tx.marketplaceAccount.findUnique({
        where: { id: accountId },
        select: { status: true },
      });
      return tx.marketplaceAccount.update({
        where: { id: accountId },
        data: {
          plan: plan.plan,
          periodStart: now,
          lastSeenAt: now,
          ...(current?.status === 'DORMANT' ? { status: 'ACTIVE' } : {}),
        },
      });
    });
  }

  /** Seen again; a dormant account is active again. A blocked one stays blocked. */
  touch(accountId: string, now: Date, wake: boolean) {
    return this._account.model.marketplaceAccount.update({
      where: { id: accountId },
      data: { lastSeenAt: now, ...(wake ? { status: 'ACTIVE' } : {}) },
    });
  }

  organization(organizationId: string) {
    return this._organization.model.organization.findUnique({
      where: { id: organizationId },
    });
  }

  countChannels(organizationId: string) {
    return this._integration.model.integration.count({
      where: { organizationId, deletedAt: null },
    });
  }

  async storageUsed(organizationId: string): Promise<number> {
    const sum = await this._media.model.media.aggregate({
      where: { organizationId, deletedAt: null },
      _sum: { fileSize: true },
    });
    return sum._sum.fileSize || 0;
  }

  recordMedia(
    organizationId: string,
    file: { name: string; path: string; originalName?: string | null; fileSize: number; type: string }
  ) {
    return this._media.model.media.create({
      data: {
        organizationId,
        name: file.name,
        path: file.path,
        originalName: file.originalName || null,
        fileSize: file.fileSize,
        type: file.type,
      },
      select: { id: true, path: true, fileSize: true, type: true, createdAt: true },
    });
  }

  findMedia(organizationId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([]);
    return this._media.model.media.findMany({
      where: { id: { in: ids }, organizationId, deletedAt: null },
      select: { id: true, path: true, type: true, fileSize: true, thumbnail: true },
    });
  }

  dormantCandidates(before: Date, take = 200) {
    return this._account.model.marketplaceAccount.findMany({
      where: { status: 'ACTIVE', lastSeenAt: { lt: before } },
      select: { id: true, organizationId: true },
      take,
    });
  }

  /** Claims the account for the dormant sweep; false when another run (or a call) got there first. */
  async markDormant(accountId: string, before: Date) {
    const { count } = await this._account.model.marketplaceAccount.updateMany({
      where: { id: accountId, status: 'ACTIVE', lastSeenAt: { lt: before } },
      data: { status: 'DORMANT' },
    });
    return count > 0;
  }

  /** Groups of the workspace's posts still waiting to publish after `now`. */
  async scheduledGroups(organizationId: string, now: Date): Promise<string[]> {
    const rows = await this._post.model.post.findMany({
      where: {
        organizationId,
        deletedAt: null,
        parentPostId: null,
        state: 'QUEUE',
        publishDate: { gt: now },
      },
      select: { group: true },
      distinct: ['group'],
    });
    return rows.map((r) => r.group);
  }

  async marketplaceOrganizationIds(): Promise<string[]> {
    const rows = await this._account.model.marketplaceAccount.findMany({
      select: { organizationId: true },
    });
    return rows.map((r) => r.organizationId);
  }

  /** Media of these workspaces created before `before` (of `type` when given), not yet removed. */
  expiredMedia(organizationIds: string[], before: Date, type?: string, take = 500) {
    if (!organizationIds.length) return Promise.resolve([]);
    return this._media.model.media.findMany({
      where: {
        organizationId: { in: organizationIds },
        deletedAt: null,
        createdAt: { lt: before },
        ...(type ? { type } : {}),
      },
      select: { id: true, organizationId: true, path: true, type: true },
      take,
    });
  }

  /** The media of posts still waiting to publish (never purged from under them). */
  async queuedMediaPaths(organizationId: string): Promise<Set<string>> {
    const rows = await this._post.model.post.findMany({
      where: { organizationId, deletedAt: null, state: 'QUEUE' },
      select: { image: true },
    });
    const paths = new Set<string>();
    for (const row of rows) {
      try {
        for (const m of JSON.parse(row.image || '[]')) {
          if (m?.path) paths.add(String(m.path));
        }
      } catch {
        /* not JSON: nothing to keep */
      }
    }
    return paths;
  }

  softDeleteMedia(organizationId: string, id: string) {
    return this._media.model.media.updateMany({
      where: { id, organizationId },
      data: { deletedAt: new Date() },
    });
  }
}
