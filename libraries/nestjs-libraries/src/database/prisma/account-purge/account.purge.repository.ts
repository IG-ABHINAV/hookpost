import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import {
  PrismaRepository,
  PrismaTransaction,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

/** What a purged workspace is called. Nothing personal is left in the row. */
export const PURGED_ORGANIZATION_NAME = 'Deleted workspace';
/** Prefix of a purged account's email, and of a purged channel's internal id. */
export const PURGED_PREFIX = 'purged_';
/** A purged developer app keeps its row (other workspaces' grants point at it). */
export const PURGED_APP_NAME = 'Deleted app';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const isMd5 = (value: string) => /^[0-9a-f]{32}$/.test(value);

/**
 * A deleted workspace that still holds something to erase. Only workspaces
 * deleted before `cutoff` whose every member is a deleted account, deleted
 * before `cutoff` too: a workspace with a live member, or one deleted more
 * recently, is never touched. Workspaces already purged match none of the OR
 * branches, which is what makes the purge idempotent.
 */
const organizationsToPurge = (cutoff: Date): Prisma.OrganizationWhereInput => ({
  deletedAt: { lt: cutoff },
  users: { every: { user: { deletedAt: { lt: cutoff } } } },
  OR: [
    { NOT: { name: PURGED_ORGANIZATION_NAME } },
    { apiKey: { not: null } },
    { description: { not: null } },
    { post: { some: {} } },
    // Media a live account, agency or another workspace's app still uses stays
    // (collectOrganizationFiles), so it does not count as left to erase.
    {
      media: {
        some: {
          userPicture: { none: {} },
          agencies: { none: {} },
          oauthApps: { none: {} },
        },
      },
    },
    { Comments: { some: {} } },
    { signatures: { some: {} } },
    { sets: { some: {} } },
    { webhooks: { some: {} } },
    { autoPost: { some: {} } },
    { thirdParty: { some: {} } },
    { github: { some: {} } },
    { notifications: { some: {} } },
    { tags: { some: {} } },
    { plugs: { some: {} } },
    { customers: { some: {} } },
    { credits: { some: {} } },
    { errors: { some: {} } },
    {
      oauthApp: {
        some: {
          OR: [
            { NOT: { name: PURGED_APP_NAME } },
            { description: { not: null } },
            { pictureId: { not: null } },
            { clientSecret: { not: null } },
            { NOT: { redirectUrl: '' } },
          ],
        },
      },
    },
    { oauthAuthorizations: { some: {} } },
    { Integration: { some: { NOT: { internalId: { startsWith: PURGED_PREFIX } } } } },
  ],
});

/**
 * A deleted account (before `cutoff`) whose own rows still hold something.
 * Only rows that belong to the account alone: its comments and Approved Apps
 * grants belong to a workspace and go with that workspace's purge, never with
 * the account's (a workspace that is still live keeps them).
 */
const usersToPurge = (cutoff: Date): Prisma.UserWhereInput => ({
  deletedAt: { lt: cutoff },
  OR: [
    { NOT: { email: { startsWith: PURGED_PREFIX } } },
    { name: { not: null } },
    { lastName: { not: null } },
    { providerId: { not: null } },
    { bio: { not: null } },
    { pictureId: { not: null } },
    { ip: { not: null } },
    { agent: { not: null } },
    { items: { some: {} } },
    { agencies: { isNot: null } },
  ],
});

export interface OrganizationFiles {
  /** Media rows that must stay because a row outside the workspace uses them. */
  keepMediaIds: string[];
  /** Every file URL the workspace's rows point at. */
  urls: string[];
}

/**
 * Prisma side of the account purge (AccountPurgeService). Every write takes
 * the one workspace or account it may touch and is scoped to it.
 */
@Injectable()
export class AccountPurgeRepository {
  constructor(
    private _db: PrismaRepository<
      | 'organization'
      | 'user'
      | 'post'
      | 'media'
      | 'integration'
      | 'oAuthApp'
      | 'socialMediaAgency'
      | 'affiliate'
      | 'messagesGroup'
      | 'mastra_threads'
      | 'signupAttribution'
      | 'signatures'
      | 'sets'
    >,
    private _transaction: PrismaTransaction
  ) {}

  /**
   * Where the workspace came from (ad click ids, landing page, referrer).
   * Outside purgeOrganization's transaction on purpose: until
   * signup-attribution.migration.sql is applied the table does not exist, and
   * a failed statement would roll back the whole purge.
   */
  async forgetSignupAttribution(orgId: string) {
    try {
      await this._db.model.signupAttribution.deleteMany({
        where: { organizationId: orgId },
      });
    } catch {
      // No table yet: nothing was recorded either.
    }
  }

  findOrganizationsToPurge(cutoff: Date, take: number) {
    return this._db.model.organization.findMany({
      where: organizationsToPurge(cutoff),
      select: { id: true, deletedAt: true },
      orderBy: { deletedAt: 'asc' },
      take,
    });
  }

  /** Deleted long enough, but a member is live or was deleted too recently. */
  countOrganizationsHeldByMembers(cutoff: Date) {
    return this._db.model.organization.count({
      where: {
        deletedAt: { lt: cutoff },
        users: {
          some: {
            user: { OR: [{ deletedAt: null }, { deletedAt: { gte: cutoff } }] },
          },
        },
      },
    });
  }

  findUsersToPurge(cutoff: Date, take: number) {
    return this._db.model.user.findMany({
      where: usersToPurge(cutoff),
      select: { id: true, deletedAt: true },
      orderBy: { deletedAt: 'asc' },
      take,
    });
  }

  /** Re-read right before writing: still deleted before `cutoff`, members too. */
  async isOrganizationPurgeable(orgId: string, cutoff: Date) {
    const org = await this._db.model.organization.findUnique({
      where: { id: orgId },
      select: {
        deletedAt: true,
        users: { select: { user: { select: { deletedAt: true } } } },
      },
    });
    return (
      !!org?.deletedAt &&
      org.deletedAt < cutoff &&
      org.users.every((m) => !!m.user.deletedAt && m.user.deletedAt < cutoff)
    );
  }

  async isUserPurgeable(userId: string, cutoff: Date) {
    const user = await this._db.model.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true },
    });
    return !!user?.deletedAt && user.deletedAt < cutoff;
  }

  /** Rows per table that purging this workspace removes or rewrites (the dry-run report). */
  async countOrganizationRows(orgId: string) {
    const counts = await this._db.model.organization.findUnique({
      where: { id: orgId },
      select: {
        _count: {
          select: {
            post: true,
            media: true,
            Comments: true,
            signatures: true,
            sets: true,
            webhooks: true,
            autoPost: true,
            thirdParty: true,
            github: true,
            notifications: true,
            tags: true,
            plugs: true,
            customers: true,
            credits: true,
            errors: true,
            oauthApp: true,
            oauthAuthorizations: true,
            Integration: true,
          },
        },
      },
    });
    const aiThreads = await this._db.model.mastra_threads.count({
      where: { resourceId: orgId },
    });
    // Marketplace records are payment records between two users: kept, but
    // reported so the owner knows they exist.
    const marketplaceKept = await this._db.model.messagesGroup.count({
      where: { buyerOrganizationId: orgId },
    });
    return { ...(counts?._count || {}), aiThreads, marketplaceKept };
  }

  /**
   * Of these media rows, the ones something outside the posts still shows: a
   * live account's profile picture, a live agency's logo, or a developer
   * app's picture. Their files stay. `ownApps` keeps the workspace's own
   * developer app's picture too (the media retention purge keeps settings;
   * the account purge erases that app).
   */
  async keptMediaIds(
    orgId: string,
    mediaIds: string[],
    opts: { ownApps?: boolean } = {}
  ): Promise<Set<string>> {
    if (!mediaIds.length) return new Set();
    const [users, agencies, apps] = await Promise.all([
      this._db.model.user.findMany({
        where: { pictureId: { in: mediaIds }, deletedAt: null },
        select: { pictureId: true },
      }),
      this._db.model.socialMediaAgency.findMany({
        where: { logoId: { in: mediaIds }, user: { deletedAt: null } },
        select: { logoId: true },
      }),
      this._db.model.oAuthApp.findMany({
        where: {
          pictureId: { in: mediaIds },
          ...(opts.ownApps ? {} : { NOT: { organizationId: orgId } }),
        },
        select: { pictureId: true },
      }),
    ]);
    return new Set<string>([
      ...users.map((u) => u.pictureId!),
      ...agencies.map((a) => a.logoId!),
      ...apps.map((a) => a.pictureId!),
    ]);
  }

  /**
   * Every file the workspace's rows point at, and the media rows that must
   * stay because something outside the workspace uses them (a live account's
   * profile picture, an agency logo, another workspace's app icon).
   */
  async collectOrganizationFiles(orgId: string): Promise<OrganizationFiles> {
    const media = await this._db.model.media.findMany({
      where: { organizationId: orgId },
      select: { id: true, path: true, thumbnail: true },
    });
    const posts = await this._db.model.post.findMany({
      where: { organizationId: orgId, image: { not: null } },
      select: { image: true },
    });
    const integrations = await this._db.model.integration.findMany({
      where: { organizationId: orgId, picture: { not: null } },
      select: { picture: true },
    });

    const keepMediaIds = await this.keptMediaIds(
      orgId,
      media.map((m) => m.id)
    );

    const urls = new Set<string>();
    for (const m of media) {
      if (keepMediaIds.has(m.id)) {
        continue;
      }
      urls.add(m.path);
      if (m.thumbnail) urls.add(m.thumbnail);
    }
    for (const post of posts) {
      try {
        const items = JSON.parse(post.image || '[]');
        for (const item of Array.isArray(items) ? items : []) {
          for (const url of [item?.path, item?.thumbnail, item?.url]) {
            if (typeof url === 'string' && url) urls.add(url);
          }
        }
      } catch (e) {
        // Not JSON: nothing structured to find.
      }
    }
    for (const integration of integrations) {
      urls.add(integration.picture!);
    }
    // A kept media row keeps its file, even when a post here shows it too.
    for (const m of media) {
      if (keepMediaIds.has(m.id)) {
        urls.delete(m.path);
        if (m.thumbnail) urls.delete(m.thumbnail);
      }
    }
    return { keepMediaIds: [...keepMediaIds], urls: [...urls] };
  }

  /**
   * Of these URLs, the ones a row outside the workspace still points at
   * (another workspace's media, post, channel picture, signature or saved
   * set: a file uploaded without a library row can live only in those).
   * Those files stay.
   */
  async findUrlsUsedElsewhere(orgId: string, urls: string[]) {
    const used = new Set<string>();
    for (let i = 0; i < urls.length; i += 50) {
      const chunk = urls.slice(i, i + 50);
      const media = await this._db.model.media.findMany({
        where: {
          NOT: { organizationId: orgId },
          OR: [{ path: { in: chunk } }, { thumbnail: { in: chunk } }],
        },
        select: { path: true, thumbnail: true },
      });
      media.forEach((m) => {
        used.add(m.path);
        if (m.thumbnail) used.add(m.thumbnail);
      });
      const pictures = await this._db.model.integration.findMany({
        where: { NOT: { organizationId: orgId }, picture: { in: chunk } },
        select: { picture: true },
      });
      pictures.forEach((p) => used.add(p.picture!));
      const posts = await this._db.model.post.findMany({
        where: {
          NOT: { organizationId: orgId },
          OR: chunk.map((url) => ({ image: { contains: url } })),
        },
        select: { image: true },
      });
      for (const url of chunk) {
        if (posts.some((p) => (p.image || '').includes(url))) used.add(url);
      }
      const mentions = chunk.map((url) => ({ content: { contains: url } }));
      const [signatures, sets] = await Promise.all([
        this._db.model.signatures.findMany({
          where: { NOT: { organizationId: orgId }, OR: mentions },
          select: { content: true },
        }),
        this._db.model.sets.findMany({
          where: { NOT: { organizationId: orgId }, OR: mentions },
          select: { content: true },
        }),
      ]);
      const texts = [...signatures, ...sets].map((r) => r.content || '');
      for (const url of chunk) {
        if (texts.some((text) => text.includes(url))) used.add(url);
      }
    }
    return urls.filter((url) => used.has(url));
  }

  /**
   * Erases one workspace, in one transaction. Kept: the workspace row itself
   * (renamed, key and description cleared) because billing records point at
   * it, its subscription, coupon and affiliate records (tax), its membership
   * rows (no personal data), marketplace payment records, its developer app as
   * an empty row, and each channel as a skeleton: provider, workspace and the
   * md5 root id that the free-trial check compares (checkPreviousConnections),
   * with every token, name, picture and setting cleared.
   */
  purgeOrganization(orgId: string, keepMediaIds: string[]) {
    return this._transaction.model.$transaction(
      async (tx) => {
        const inOrg = { organizationId: orgId };
        const threads = await tx.mastra_threads.findMany({
          where: { resourceId: orgId },
          select: { id: true },
        });

        await tx.tagsPosts.deleteMany({ where: { post: inOrg } });
        await tx.comments.deleteMany({
          where: { OR: [inOrg, { post: inOrg }] },
        });
        await tx.errors.deleteMany({ where: { OR: [inOrg, { post: inOrg }] } });
        await tx.post.updateMany({
          where: { ...inOrg, parentPostId: { not: null } },
          data: { parentPostId: null },
        });
        await tx.post.deleteMany({ where: inOrg });
        await tx.tags.deleteMany({ where: { orgId } });
        await tx.media.deleteMany({
          where: { ...inOrg, id: { notIn: keepMediaIds } },
        });
        await tx.signatures.deleteMany({ where: inOrg });
        await tx.sets.deleteMany({ where: inOrg });
        await tx.integrationsWebhooks.deleteMany({
          where: { OR: [{ webhook: inOrg }, { integration: inOrg }] },
        });
        await tx.webhooks.deleteMany({ where: inOrg });
        await tx.autoPost.deleteMany({ where: inOrg });
        await tx.thirdParty.deleteMany({ where: inOrg });
        await tx.gitHub.deleteMany({ where: inOrg });
        await tx.notifications.deleteMany({ where: inOrg });
        await tx.credits.deleteMany({ where: inOrg });
        await tx.exisingPlugData.deleteMany({ where: { integration: inOrg } });
        await tx.plugs.deleteMany({
          where: { OR: [inOrg, { integration: inOrg }] },
        });
        await tx.integration.updateMany({
          where: { ...inOrg, customerId: { not: null } },
          data: { customerId: null },
        });
        await tx.customer.deleteMany({ where: { orgId } });
        // Grants made inside this workspace. Its developer app is emptied,
        // not deleted: users of live workspaces may hold (dead) grants to it,
        // and those rows are theirs.
        await tx.oAuthAuthorization.deleteMany({ where: inOrg });
        await tx.oAuthApp.updateMany({
          where: { ...inOrg, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.oAuthApp.updateMany({
          where: inOrg,
          data: {
            name: PURGED_APP_NAME,
            description: null,
            pictureId: null,
            redirectUrl: '',
            redirectUris: null,
            clientSecret: null,
          },
        });
        await tx.mastra_messages.deleteMany({
          where: {
            OR: [
              { resourceId: orgId },
              { thread_id: { in: threads.map((t) => t.id) } },
            ],
          },
        });
        await tx.mastra_threads.deleteMany({ where: { resourceId: orgId } });
        await tx.mastra_resources.deleteMany({ where: { id: orgId } });
        await tx.mastra_scorers.deleteMany({ where: { resourceId: orgId } });
        await tx.mastra_workflow_snapshot.deleteMany({
          where: { resourceId: orgId },
        });

        const integrations = await tx.integration.findMany({
          where: inOrg,
          select: { id: true, rootInternalId: true, deletedAt: true },
        });
        for (const integration of integrations) {
          await tx.integration.update({
            where: { id: integration.id },
            data: {
              internalId: `${PURGED_PREFIX}${integration.id}`,
              rootInternalId:
                integration.rootInternalId && !isMd5(integration.rootInternalId)
                  ? md5(integration.rootInternalId)
                  : integration.rootInternalId,
              name: '',
              token: '',
              refreshToken: null,
              tokenExpiration: null,
              profile: null,
              picture: null,
              customInstanceDetails: null,
              additionalSettings: '[]',
              customerId: null,
              deletedAt: integration.deletedAt || new Date(),
            },
          });
        }

        await tx.organization.update({
          where: { id: orgId },
          data: {
            name: PURGED_ORGANIZATION_NAME,
            description: null,
            apiKey: null,
          },
        });
      },
      { timeout: 120000, maxWait: 10000 }
    );
  }

  /** What purging this account touches (the dry-run report). */
  async countUserRows(userId: string) {
    const user = await this._db.model.user.findUnique({
      where: { id: userId },
      select: {
        _count: { select: { items: true } },
        agencies: { select: { id: true } },
      },
    });
    const affiliate = await this.findAffiliate(userId);
    return {
      items: user?._count?.items || 0,
      agency: user?.agencies ? 1 : 0,
      affiliate: affiliate ? affiliateAction(affiliate) : 'none',
    };
  }

  private findAffiliate(userId: string) {
    return this._db.model.affiliate.findUnique({
      where: { userId },
      select: {
        id: true,
        commissions: { select: { status: true } },
      },
    });
  }

  /**
   * Erases one deleted account's own rows, in one transaction. The user row
   * stays as a placeholder (other rows point at it) with nothing personal.
   * Affiliate: payout details go unless a commission is still owed; name and
   * email stay only when commissions exist, as payout and tax records.
   */
  purgeUser(userId: string) {
    return this._transaction.model.$transaction(
      async (tx) => {
        await tx.itemUser.deleteMany({ where: { userId } });
        await tx.socialMediaAgencyNiche.deleteMany({
          where: { agency: { userId } },
        });
        await tx.socialMediaAgency.deleteMany({ where: { userId } });

        const affiliate = await tx.affiliate.findUnique({
          where: { userId },
          select: { id: true, commissions: { select: { status: true } } },
        });
        if (affiliate) {
          const action = affiliateAction(affiliate);
          await tx.affiliate.update({
            where: { id: affiliate.id },
            data: {
              active: false,
              ...(action !== 'keep-payout-details' ? { payoutDetails: null } : {}),
              ...(action === 'anonymise'
                ? { name: 'Deleted affiliate', email: `${PURGED_PREFIX}${affiliate.id}` }
                : {}),
            },
          });
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            email: `${PURGED_PREFIX}${userId}`,
            name: null,
            lastName: null,
            providerId: null,
            bio: null,
            pictureId: null,
            ip: null,
            agent: null,
            account: null,
          },
        });
      },
      { timeout: 60000, maxWait: 10000 }
    );
  }
}

/**
 * anonymise: never earned a commission, nothing to keep.
 * keep-payout-details: a commission is still PENDING, so it can be paid.
 * keep-records: commissions exist (paid or void), kept for tax records.
 */
export const affiliateAction = (affiliate: {
  commissions: Array<{ status: string }>;
}) =>
  affiliate.commissions.length === 0
    ? ('anonymise' as const)
    : affiliate.commissions.some((c) => c.status === 'PENDING')
    ? ('keep-payout-details' as const)
    : ('keep-records' as const);
