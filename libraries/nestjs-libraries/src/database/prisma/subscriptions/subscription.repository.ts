import { Injectable, Optional } from '@nestjs/common';
import { MediaRetentionRepository } from '@hookpost/nestjs-libraries/database/prisma/media-retention/media.retention.repository';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import dayjs from 'dayjs';
import { createHash } from 'crypto';
import { Organization, Prisma } from '@prisma/client';
import { CreditsExceededError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/credits.exceeded.error';
import {
  SUNSET_NOTICE_7_DAY_BEFORE,
  SUNSET_NOTICE_CODE_PREFIX,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import type {
  BillingIdentityKind,
  BillingIdentitySource,
} from '@hookpost/nestjs-libraries/services/razorpay.mapping';

/** A post that counts against FREE_POST_LIMIT even after it is deleted. */
export const POSTED_STATES = ['PUBLISHED', 'REMINDER_SENT', 'POSTED_MANUALLY'] as const;

/**
 * A workspace that has had what a free_posts workspace is given: it has a post
 * that counts as freePostRows counts them, or it has had a trial or a plan.
 * allowTrial goes false with the first trial or plan and never back, and a
 * Subscription row (live, soft-deleted or a marketplace plan) is a plan.
 * Deleted workspaces count too: deleting one is not a way to get the posts
 * again. For trial.policy.ts "free posts are given once".
 */
export const SPENT_FREE_POSTS_WORKSPACE: Prisma.OrganizationWhereInput = {
  OR: [
    { allowTrial: false },
    { subscription: { isNot: null } },
    {
      post: {
        some: {
          parentPostId: null,
          OR: [{ deletedAt: null }, { state: { in: [...POSTED_STATES] } }],
        },
      },
    },
  ],
};

/**
 * A plan's monthly allowance for one credit type. `pool`: the types sharing
 * one balance (pricing.ts AI_CREDIT_POOL); `cost`: credits one use takes
 * (pricing.ts AI_CREDIT_COST). Without them: its own type, 1 each.
 */
export interface CreditAllowance {
  max: number;
  from: dayjs.Dayjs;
  pool?: string[];
  cost?: number;
}

@Injectable()
export class SubscriptionRepository {
  constructor(
    private readonly _subscription: PrismaRepository<'subscription'>,
    private readonly _organization: PrismaRepository<'organization'>,
    private readonly _user: PrismaRepository<'user'>,
    private readonly _credits: PrismaRepository<'credits'>,
    private _usedCodes: PrismaRepository<'usedCodes'>,
    private _transaction: PrismaTransaction,
    private _coupon: PrismaRepository<'coupon'>,
    private _couponRedemption: PrismaRepository<'couponRedemption'>,
    private _post: PrismaRepository<'post'>,
    private _integration: PrismaRepository<'integration'>,
    private _billingIdentity: PrismaRepository<'billingIdentity'>,
    private _gumroadLicense: PrismaRepository<'gumroadLicense'>,
    // The media retention clock, stopped whenever a plan is written (a plan
    // bought again before the removal keeps everything). Optional so the
    // specs that build this repository by hand need no change; Nest always
    // provides it (DatabaseModule).
    @Optional() private _mediaRetention?: MediaRetentionRepository
  ) {}

  /** A plan is on file again: nothing of this workspace is removed. */
  private async stopMediaRetention(organizationId: string) {
    await this._mediaRetention?.clear(organizationId).catch((e) => {
      console.error(
        `Media retention for org ${organizationId} not cleared: ${String(e?.message || e).split('\n')[0]}`
      );
    });
  }

  findCouponByCode(code: string) {
    return this._coupon.model.coupon.findUnique({ where: { code } });
  }

  countCouponRedemptions(couponId: string) {
    return this._couponRedemption.model.couponRedemption.count({
      where: { couponId },
    });
  }

  async hasRedeemedCoupon(couponId: string, organizationId: string) {
    return !!(await this._couponRedemption.model.couponRedemption.findUnique({
      where: { couponId_organizationId: { couponId, organizationId } },
    }));
  }

  redeemCoupon(couponId: string, organizationId: string, subscriptionId: string) {
    return this._couponRedemption.model.couponRedemption.upsert({
      where: { couponId_organizationId: { couponId, organizationId } },
      create: { couponId, organizationId, subscriptionId },
      update: { subscriptionId },
    });
  }

  createCoupon(data: {
    code: string;
    percentOff?: number | null;
    freeMonths?: number | null;
    maxRedemptions?: number | null;
    expiresAt?: Date | null;
    note?: string | null;
  }) {
    return this._coupon.model.coupon.create({ data });
  }

  listCoupons() {
    return this._coupon.model.coupon.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    });
  }

  setCouponActive(id: string, active: boolean) {
    return this._coupon.model.coupon.update({ where: { id }, data: { active } });
  }

  getUserAccount(userId: string) {
    return this._user.model.user.findFirst({
      where: {
        id: userId,
      },
      select: {
        account: true,
        connectedAccount: true,
      },
    });
  }

  getCode(code: string) {
    return this._usedCodes.model.usedCodes.findFirst({
      where: {
        code,
      },
    });
  }

  updateAccount(userId: string, account: string) {
    return this._user.model.user.update({
      where: {
        id: userId,
      },
      data: {
        account,
      },
    });
  }

  getSubscriptionByOrganizationId(organizationId: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        organizationId,
        deletedAt: null,
      },
    });
  }

  updateConnectedStatus(account: string, accountCharges: boolean) {
    return this._user.model.user.updateMany({
      where: {
        account,
      },
      data: {
        connectedAccount: accountCharges,
      },
    });
  }

  getCustomerIdByOrgId(organizationId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        id: organizationId,
      },
      select: {
        paymentId: true,
      },
    });
  }

  checkSubscription(organizationId: string, subscriptionId: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        organizationId,
        identifier: subscriptionId,
        deletedAt: null,
      },
    });
  }

  deleteSubscriptionByOrganizationId(organizationId: string) {
    return this._subscription.model.subscription.deleteMany({
      where: {
        organizationId,
      },
    });
  }

  /**
   * Delete the workspace's plan only while it is still the one with this
   * identifier: a plan written since it was read (another key, a Razorpay
   * activation) is left alone. The count says whether anything was deleted.
   */
  deleteSubscriptionByOrgAndIdentifier(organizationId: string, identifier: string) {
    return this._subscription.model.subscription.deleteMany({
      where: { organizationId, identifier },
    });
  }

  /** Keep the plan until `cancelAt`, for this org's row with this identifier only. */
  /** Save when the plan ends; null lifts it (a halted renewal paid after all). */
  scheduleCancellation(organizationId: string, identifier: string, cancelAt: Date | null) {
    return this._subscription.model.subscription.updateMany({
      where: { organizationId, identifier, deletedAt: null },
      data: { cancelAt },
    });
  }

  /**
   * Mark, or clear, that the provider's charges on this plan are failing
   * (trial.policy.ts planState: `dunning`). Only this org's row
   * with this identifier, so a late webhook for a plan the workspace has
   * already moved off changes nothing. Marking is idempotent: a marker
   * already on file keeps its own date, so every retry's webhook does not
   * push "failing since" forward.
   */
  async setPaymentFailing(
    organizationId: string,
    identifier: string,
    since: Date | null
  ) {
    const { count } =
      await this._subscription.model.subscription.updateMany({
        where: {
          organizationId,
          identifier,
          deletedAt: null,
          ...(since ? { paymentFailingSince: null } : {}),
        },
        data: { paymentFailingSince: since },
      });
    return count;
  }

  /**
   * Clear the failing-payment marker wherever this provider subscription is
   * on file, by identifier alone: a charge that went through says the plan is
   * paid whichever workspace holds it.
   */
  async clearPaymentFailingByIdentifier(identifier: string) {
    const { count } =
      await this._subscription.model.subscription.updateMany({
        where: { identifier, deletedAt: null, paymentFailingSince: { not: null } },
        data: { paymentFailingSince: null },
      });
    return count;
  }

  /** Provider subscriptions whose scheduled end has passed and that still hold a plan. */
  /**
   * Razorpay plans whose cancelAt has passed and are still on file: the rows
   * endLapsedCancellations ends. `organizationId` narrows it to one workspace,
   * for the exact timer at cancelAt (planEndWorkflow); the hourly sweep reads
   * them all.
   */
  getLapsedCancellations(now: Date, organizationId?: string) {
    return this._subscription.model.subscription.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        cancelAt: { lte: now },
        deletedAt: null,
        isLifetime: false,
        // A paid one-time month (one.time.plan.ts) ends here too.
        OR: [{ identifier: { startsWith: 'sub_' } }, { identifier: { startsWith: 'order_' } }],
      },
      select: {
        organizationId: true,
        identifier: true,
        cancelAt: true,
        subscriptionTier: true,
        period: true,
      },
    });
  }

  /**
   * Every live plan in this database that stands on a Razorpay subscription:
   * what the pre-charge guard (RazorpayService.reconcileBilling) compares
   * against Razorpay, in one read.
   *
   * A lifetime deal and a plan bought on Gumroad or a marketplace hold no
   * Razorpay subscription, so the `sub_` prefix and isLifetime leave them
   * out, as they do for the grace sweep.
   *
   * A deleted workspace keeps its rows, and the grace sweep passes them over
   * (getLapsedCancellations takes live workspaces only), so whether the
   * workspace is still there comes along: a mandate charging a workspace that
   * no longer exists is the guard's to stop.
   */
  getRazorpayPlanRows() {
    return this._subscription.model.subscription.findMany({
      where: {
        deletedAt: null,
        isLifetime: false,
        identifier: { startsWith: 'sub_' },
      },
      select: {
        organizationId: true,
        identifier: true,
        cancelAt: true,
        subscriptionTier: true,
        period: true,
        organization: { select: { deletedAt: true } },
      },
    });
  }

  /**
   * Razorpay plans set to end between `from` and `to`, on a workspace that
   * still exists: the candidates for the "your access ends" email
   * (RazorpayService.sendCancelledTrialReminders), which reads Razorpay to
   * keep only cancelled trials.
   */
  getEndingRows(from: Date, to: Date) {
    return this._subscription.model.subscription.findMany({
      where: {
        cancelAt: { gte: from, lte: to },
        deletedAt: null,
        isLifetime: false,
        OR: [{ identifier: { startsWith: 'sub_' } }, { identifier: { startsWith: 'order_' } }],
        organization: { deletedAt: null },
      },
      select: {
        organizationId: true,
        identifier: true,
        cancelAt: true,
        subscriptionTier: true,
        period: true,
      },
    });
  }

  /**
   * What trial.policy.ts needs about one workspace, in one query: when it was
   * created, its trial flags, its plan row, and the signup country of its
   * first SUPERADMIN (the person who created it).
   */
  getPlanFacts(organizationId: string) {
    return this._organization.model.organization.findFirst({
      where: { id: organizationId },
      select: {
        id: true,
        createdAt: true,
        allowTrial: true,
        isTrailing: true,
        // A chargeback on one of its payments locks the workspace
        // (trial.policy.ts workspaceDisputed).
        disputedAt: true,
        subscription: {
          select: {
            isLifetime: true,
            cancelAt: true,
            deletedAt: true,
            identifier: true,
            paymentFailingSince: true,
          },
        },
        users: {
          where: { role: 'SUPERADMIN' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { user: { select: { signupCountry: true } } },
        },
        // Members who are platform super admins: such a workspace keeps the
        // Free plan after FREE_PLAN_SUNSET_AT (trial.policy.ts).
        _count: {
          select: {
            users: {
              where: { user: { isSuperAdmin: true, deletedAt: null } },
            },
          },
        },
      },
    });
  }

  /**
   * The root post rows (publish date and channel) a workspace has used of
   * its FREE_POST_LIMIT (trial.policy.ts; freePostsUsed turns them into posts):
   * every post that is not deleted, drafts included, and every one that went
   * out even if deleted since. Comments and thread replies are part of their
   * post, so only roots are read.
   */
  async freePostRows(
    organizationId: string
  ): Promise<Array<{ publishDate: Date; integrationId: string | null }>> {
    const rows = await this._post.model.post.findMany({
      where: {
        organizationId,
        parentPostId: null,
        OR: [
          { deletedAt: null },
          { state: { in: [...POSTED_STATES] } },
        ],
      },
      select: { publishDate: true, integrationId: true },
    });
    return rows;
  }

  /**
   * Of this workspace's channels `integrationIds`, the provider of each one
   * whose account (providerIdentifier + internalId) is, or ever was (deleted
   * rows too), connected in another workspace that has had its free posts or
   * a trial or plan (SPENT_FREE_POSTS_WORKSPACE): trial.policy.ts "free posts
   * are given once". Two queries, whatever the number of channels.
   *
   * A removed channel keeps its internalId in one of four forms: as it was
   * (deleteChannel), `deleted_<id>_<random>` (a reconnect elsewhere in the
   * workspace), `deleted_<md5>_<random>` (eraseRemovedChannelProfile) or its
   * md5 (deleteIntegrationsForAccount, a deleted account). All four match,
   * as checkPreviousConnections matches the hashed root id.
   */
  async channelsWithSpentFreePosts(
    organizationId: string,
    integrationIds: string[]
  ): Promise<string[]> {
    const spent = await this.workspacesWithSpentFreePosts(organizationId, integrationIds);
    return [...new Set(spent.map((s) => s.provider))];
  }

  /**
   * The accounts behind `integrationIds` that are, or ever were, connected in
   * another workspace that has spent its free posts, with that workspace
   * (channelsWithSpentFreePosts reads the providers only). Which workspace is
   * server-side only: the user is told its name only when they belong to it
   * (PostsController, trial.policy.ts freePostsLeftElsewhereMessage).
   */
  async workspacesWithSpentFreePosts(
    organizationId: string,
    integrationIds: string[]
  ): Promise<Array<{ provider: string; organizationId: string }>> {
    if (!integrationIds.length) return [];
    const channels = await this._integration.model.integration.findMany({
      where: { organizationId, id: { in: integrationIds } },
      select: { providerIdentifier: true, internalId: true },
    });
    return this.workspacesSharingChannels(
      organizationId,
      channels,
      SPENT_FREE_POSTS_WORKSPACE
    );
  }

  /**
   * The other workspaces in which one of `channels` (providerIdentifier +
   * internalId) is, or ever was, connected, in any of the four forms a
   * removed channel keeps its internalId in (see channelsWithSpentFreePosts),
   * optionally only those matching `organization`. One query.
   */
  private async workspacesSharingChannels(
    organizationId: string,
    channels: Array<{ providerIdentifier: string; internalId: string }>,
    organization?: Prisma.OrganizationWhereInput
  ): Promise<Array<{ provider: string; organizationId: string }>> {
    const accounts = channels.filter((c) => c.providerIdentifier && c.internalId);
    if (!accounts.length) return [];
    const elsewhere = await this._integration.model.integration.findMany({
      where: {
        organizationId: { not: organizationId },
        OR: accounts.map((c) => {
          const md5 = createHash('md5').update(c.internalId).digest('hex');
          return {
            providerIdentifier: c.providerIdentifier,
            OR: [
              { internalId: { in: [c.internalId, md5] } },
              { internalId: { startsWith: `deleted_${c.internalId}_` } },
              { internalId: { startsWith: `deleted_${md5}_` } },
            ],
          };
        }),
        ...(organization ? { organization } : {}),
      },
      distinct: ['providerIdentifier', 'organizationId'],
      select: { providerIdentifier: true, organizationId: true },
    });
    return elsewhere.map((c) => ({ provider: c.providerIdentifier, organizationId: c.organizationId }));
  }

  /**
   * ONCE PER PERSON (razorpay.mapping.ts): the other workspaces in which any
   * channel this workspace has, or had, is or was connected. Removed
   * channels count: removing one before checkout changes nothing. A channel
   * whose internalId was already rewritten (deleted_...) has no account id
   * left to compare and is skipped; the other workspace's rows are still
   * matched in every form.
   */
  async workspacesSharingAnyChannel(organizationId: string): Promise<string[]> {
    const channels = await this._integration.model.integration.findMany({
      where: { organizationId, NOT: { internalId: { startsWith: 'deleted_' } } },
      select: { providerIdentifier: true, internalId: true },
    });
    const shared = await this.workspacesSharingChannels(organizationId, channels);
    return [...new Set(shared.map((s) => s.organizationId))];
  }

  /**
   * The emails of a workspace's owners (role SUPERADMIN), and of `userId`
   * when they are a member whatever their role (the admin at checkout),
   * deleted accounts left out.
   */
  async ownerEmails(organizationId: string, userId?: string | null): Promise<string[]> {
    const org = await this._organization.model.organization.findFirst({
      where: { id: organizationId },
      select: {
        users: {
          where: {
            user: { deletedAt: null },
            OR: [{ role: 'SUPERADMIN' }, ...(userId ? [{ userId }] : [])],
          },
          select: { user: { select: { email: true } } },
        },
      },
    });
    return (org?.users || []).map((m) => m.user.email).filter(Boolean);
  }

  /**
   * The workspaces other than `organizationId` that a user owns (role
   * SUPERADMIN) whose email may be one person's address spelled another
   * way: starting with `prefix` at one of `domains`, matched exactly by the
   * caller with emailIdentity, as emailsWithSpentFreePosts does. A deleted
   * user's email is `deleted_<md5 of the address>_<random>`, so each of
   * `addresses` is matched in that form too and comes back without an @.
   *
   * Only workspaces that have, or had, a plan row (a paid plan, the offer
   * and a trial all leave one, soft-deleted when it ends) or a Razorpay
   * customer (a checkout was opened: two tabs, RazorpayService
   * retireOtherOfferCheckouts). One recorded without either is found by its
   * BillingIdentity EMAIL row instead. That keeps a one-letter Gmail prefix
   * from reading every Gmail user.
   */
  async workspacesOwnedByEmail(
    organizationId: string,
    prefix: string,
    domains: string[],
    addresses: string[]
  ): Promise<Array<{ email: string; organizationId: string }>> {
    const hash = (value: string) => createHash('md5').update(value).digest('hex');
    const owned: Prisma.UserOrganizationWhereInput = {
      role: 'SUPERADMIN',
      organizationId: { not: organizationId },
      organization: { OR: [{ subscription: { isNot: null } }, { paymentId: { not: null } }] },
    };
    const users = await this._user.model.user.findMany({
      where: {
        organizations: { some: owned },
        OR: [
          ...domains.map((domain) => ({
            AND: [
              { email: { startsWith: prefix, mode: 'insensitive' as const } },
              { email: { endsWith: `@${domain}`, mode: 'insensitive' as const } },
            ],
          })),
          ...addresses.map((address) => ({
            email: { startsWith: `deleted_${hash(address)}_` },
          })),
        ],
      },
      select: {
        email: true,
        organizations: { where: owned, select: { organizationId: true } },
      },
    });
    return users.flatMap((u) =>
      u.organizations.map((m) => ({ email: u.email, organizationId: m.organizationId }))
    );
  }

  /**
   * Store what a workspace had (model BillingIdentity). Idempotent: a row
   * already on file (same workspace, kind, hash and source) is left as it
   * is, so every redelivered webhook and every backfill run is a no-op.
   */
  saveBillingIdentities(
    rows: Array<{
      organizationId: string;
      kind: BillingIdentityKind;
      hash: string;
      source: BillingIdentitySource;
      subscriptionId?: string | null;
      paymentId?: string | null;
    }>
  ) {
    if (!rows.length) return Promise.resolve({ count: 0 });
    return this._billingIdentity.model.billingIdentity.createMany({
      data: rows,
      skipDuplicates: true,
    });
  }

  /**
   * Record that a one-time order's payment has given its month
   * (one.time.plan.ts). The unique (organizationId, kind, hash, source) key
   * makes this the idempotency check: true for the first caller only, so a
   * webhook delivered twice, order.paid and payment.captured for the same
   * payment, and the page's own confirmation never add two months. Source
   * PAID, so the workspace counts as one that has paid (workspacesThatHad).
   */
  async claimOrderPayment(organizationId: string, orderId: string, paymentId: string) {
    const { count } = await this._billingIdentity.model.billingIdentity.createMany({
      data: [
        {
          organizationId,
          kind: 'ORDER_PAYMENT',
          hash: paymentId,
          source: 'PAID',
          subscriptionId: orderId,
          paymentId,
        },
      ],
      skipDuplicates: true,
    });
    return count > 0;
  }

  /** Undo claimOrderPayment when writing the plan failed, so a retry can grant it. */
  releaseOrderPayment(organizationId: string, paymentId: string) {
    return this._billingIdentity.model.billingIdentity.deleteMany({
      where: { organizationId, kind: 'ORDER_PAYMENT', hash: paymentId, source: 'PAID' },
    });
  }

  /** The workspace whose month this payment gave, or null when it gave none. */
  findOrderPayment(paymentId: string) {
    return this._billingIdentity.model.billingIdentity.findFirst({
      where: { kind: 'ORDER_PAYMENT', hash: paymentId, source: 'PAID' },
      select: { organizationId: true, subscriptionId: true },
    });
  }

  /**
   * A paid one-time month ran out: the workspace drops back to its
   * free-posts state (trial.policy.ts planState), so allowTrial comes back.
   * Its free posts are still counted from its own posts, so nothing new is
   * given to a workspace that already used them.
   */
  restoreFreePostsState(organizationId: string) {
    return this._organization.model.organization.update({
      where: { id: organizationId },
      data: { allowTrial: true, isTrailing: false },
    });
  }

  /** The payment methods on file for this workspace's own payments, whatever they bought. */
  ownPaymentMethodHashes(
    organizationId: string
  ): Promise<Array<{ kind: string; hash: string }>> {
    return this._billingIdentity.model.billingIdentity.findMany({
      where: { organizationId, kind: { in: ['UPI', 'CARD'] } },
      distinct: ['kind', 'hash'],
      select: { kind: true, hash: true },
    });
  }

  /**
   * The workspaces other than `organizationId` with a row for one of `keys`
   * from one of `sources`, and which kind matched.
   */
  workspacesWithBillingIdentity(
    organizationId: string,
    keys: Array<{ kind: string; hash: string }>,
    sources: readonly BillingIdentitySource[]
  ): Promise<Array<{ organizationId: string; kind: string }>> {
    if (!keys.length || !sources.length) return Promise.resolve([]);
    return this._billingIdentity.model.billingIdentity.findMany({
      where: {
        organizationId: { not: organizationId },
        source: { in: [...sources] },
        OR: keys.map((k) => ({ kind: k.kind, hash: k.hash })),
      },
      distinct: ['organizationId', 'kind'],
      select: { organizationId: true, kind: true },
    });
  }

  /**
   * Of `organizationIds`, the workspaces that have had one of `sources`:
   * a BillingIdentity row from it, or what the database shows without one
   * (rows began with the offer-once change; scripts/backfill-billing-identity.ts
   * fills in Razorpay's history). PAID: a Razorpay plan on file that is not
   * a trial (a live one, or a replacement mandate waiting for its first
   * charge), or a plan bought on Gumroad. TRIAL: any plan row ever (every
   * plan before 28 Oct began with a trial) or a trial running now.
   *
   * Never one of our own workspaces (a platform super admin is a member, or
   * it is in `exempt`), a marketplace workspace or a lifetime deal: the rule
   * leaves those alone, both ways. A workspace with rows whose own row is
   * gone altogether still counts: the rows are kept to outlive it.
   */
  async workspacesThatHad(
    organizationIds: string[],
    sources: readonly BillingIdentitySource[],
    exempt: ReadonlySet<string> = new Set()
  ): Promise<string[]> {
    const ids = [...new Set(organizationIds)].filter((id) => id && !exempt.has(id));
    if (!ids.length || !sources.length) return [];
    const outside: Prisma.OrganizationWhereInput[] = [
      { source: { not: 'DIRECT' } },
      { subscription: { is: { isLifetime: true } } },
      { users: { some: { user: { isSuperAdmin: true, deletedAt: null } } } },
    ];
    const left = new Set(
      (
        await this._organization.model.organization.findMany({
          where: { id: { in: ids }, OR: outside },
          select: { id: true },
        })
      ).map((o) => o.id)
    );
    const candidates = ids.filter((id) => !left.has(id));
    if (!candidates.length) return [];

    const had = new Set<string>();
    const recorded = await this._billingIdentity.model.billingIdentity.findMany({
      where: { organizationId: { in: candidates }, source: { in: [...sources] } },
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    recorded.forEach((r) => had.add(r.organizationId));

    const live: Prisma.OrganizationWhereInput[] = [];
    if (sources.includes('PAID')) {
      live.push({
        isTrailing: false,
        subscription: {
          is: { deletedAt: null, identifier: { startsWith: 'sub_' } },
        },
      });
      const gumroad = await this._gumroadLicense.model.gumroadLicense.findMany({
        where: { organizationId: { in: candidates } },
        distinct: ['organizationId'],
        select: { organizationId: true },
      });
      gumroad.forEach((g) => had.add(g.organizationId));
    }
    if (sources.includes('TRIAL')) {
      // A plan row on file now (a trial leaves one on approval). Not
      // isTrailing alone: every new workspace starts with it true
      // (OrganizationRepository.createOrgAndUser), so it would count every
      // free_posts workspace as having had its trial. An ended trial's row is
      // deleted; its recorded TRIAL rows (above) are what remain.
      live.push({ subscription: { isNot: null } });
    }
    if (live.length) {
      const rows = await this._organization.model.organization.findMany({
        where: { id: { in: candidates }, OR: live },
        select: { id: true },
      });
      rows.forEach((r) => had.add(r.id));
    }
    return candidates.filter((id) => had.has(id));
  }

  /** The trial is used (allowTrial false), with no plan: `locked`. */
  async useUpTrial(organizationId: string) {
    await this._organization.model.organization.update({
      where: { id: organizationId },
      data: { allowTrial: false },
    });
  }

  /**
   * The name of `organizationId` when `userId` is an active member of it,
   * else null: a workspace name is only ever shown to its own members.
   */
  async memberWorkspaceName(userId: string, organizationId: string): Promise<string | null> {
    const row = await this._organization.model.organization.findFirst({
      where: {
        id: organizationId,
        deletedAt: null,
        users: { some: { userId, disabled: false } },
      },
      select: { name: true },
    });
    return row ? row.name || 'your other workspace' : null;
  }

  /**
   * The Free plan sunset notice promised this workspace a 7-day trial
   * (trial.policy.ts SUNSET_NOTICE_TRIAL_DAYS): a sent-once row of the notice
   * written before SUNSET_NOTICE_7_DAY_BEFORE is on this workspace, or is for
   * one of its owners and was written after the workspace was created (the
   * email named every affected workspace its owner had then).
   */
  async sunsetNoticePromisedTrial(organizationId: string): Promise<boolean> {
    const org = await this._organization.model.organization.findFirst({
      where: { id: organizationId },
      select: {
        createdAt: true,
        users: { where: { role: 'SUPERADMIN' }, select: { userId: true } },
      },
    });
    if (!org) return false;
    const ownerCodes = org.users.map(
      (m) => `${SUNSET_NOTICE_CODE_PREFIX}${m.userId}`
    );
    const row = await this._usedCodes.model.usedCodes.findFirst({
      where: {
        code: { startsWith: SUNSET_NOTICE_CODE_PREFIX },
        createdAt: { lt: SUNSET_NOTICE_7_DAY_BEFORE },
        OR: [
          { orgId: organizationId },
          ...(ownerCodes.length
            ? [{ code: { in: ownerCodes }, createdAt: { gt: org.createdAt } }]
            : []),
        ],
      },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * Who created the workspace (its first SUPERADMIN), for the checkout
   * currency (billing.currency.ts): their signup country, which the currency
   * follows, and their email, which USD_ALLOWLIST may name.
   */
  getCurrencyFacts(organizationId: string) {
    return this._organization.model.organization.findFirst({
      where: { id: organizationId },
      select: {
        id: true,
        users: {
          where: { role: 'SUPERADMIN' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { user: { select: { signupCountry: true, email: true } } },
        },
      },
    });
  }

  /**
   * Razorpay trials that may need the "your first charge is coming" email:
   * a live, non-lifetime Razorpay row on a workspace still trialing, not set
   * to end (a cancelled trial is never charged).
   */
  getTrialingRows() {
    return this._subscription.model.subscription.findMany({
      where: {
        deletedAt: null,
        isLifetime: false,
        cancelAt: null,
        identifier: { startsWith: 'sub_' },
        organization: { isTrailing: true, deletedAt: null },
      },
      select: {
        organizationId: true,
        identifier: true,
        subscriptionTier: true,
        period: true,
      },
    });
  }

  deleteSubscriptionByCustomerId(customerId: string) {
    return this._subscription.model.subscription.deleteMany({
      where: {
        organization: {
          paymentId: customerId,
        },
      },
    });
  }

  updateCustomerId(organizationId: string, customerId: string) {
    return this._organization.model.organization.update({
      where: {
        id: organizationId,
      },
      data: {
        paymentId: customerId,
      },
    });
  }

  async getSubscriptionByOrgId(orgId: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        organizationId: orgId,
      },
    });
  }

  async getSubscriptionByCustomerId(customerId: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        organization: {
          paymentId: customerId,
        },
      },
    });
  }

  async getOrganizationByCustomerId(customerId: string) {
    return this._organization.model.organization.findFirst({
      where: {
        paymentId: customerId,
      },
    });
  }

  async createOrUpdateSubscription(
    isTrailing: boolean,
    identifier: string,
    customerId: string,
    totalChannels: number,
    billing: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST',
    period: 'MONTHLY' | 'YEARLY',
    cancelAt: number | null,
    code?: string,
    org?: { id: string }
  ) {
    const findOrg =
      org || (await this.getOrganizationByCustomerId(customerId))!;

    if (!findOrg) {
      return;
    }

    await this._subscription.model.subscription.upsert({
      where: {
        organizationId: findOrg.id,
        ...(!code
          ? {
              organization: {
                paymentId: customerId,
              },
            }
          : {}),
      },
      update: {
        subscriptionTier: billing,
        totalChannels,
        period,
        identifier,
        isLifetime: !!code,
        cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        deletedAt: null,
      },
      create: {
        organizationId: findOrg.id,
        subscriptionTier: billing,
        isLifetime: !!code,
        totalChannels,
        period,
        cancelAt: cancelAt ? new Date(cancelAt * 1000) : null,
        identifier,
        deletedAt: null,
      },
    });

    await this._organization.model.organization.update({
      where: {
        id: findOrg.id,
      },
      data: {
        isTrailing,
        allowTrial: false,
      },
    });
    await this.stopMediaRetention(findOrg.id);

    if (code) {
      await this._usedCodes.model.usedCodes.create({
        data: {
          code,
          orgId: findOrg.id,
        },
      });
    }
  }

  /**
   * The plan a Gumroad license pays for (GumroadLicenseService): the
   * workspace's one Subscription row, created or taken over, with the
   * "gumroad:<saleId>" identifier, so planState and every entitlement read it
   * as a paid plan exactly as they read a Razorpay one. Like a first Razorpay
   * payment (createOrUpdateSubscription), it ends the trial flags: the
   * workspace is not trialing, and has had its trial.
   */
  async upsertGumroadSubscription(
    organizationId: string,
    plan: {
      tier: 'STANDARD' | 'PRO' | 'HOOKPOST';
      period: 'MONTHLY' | 'YEARLY';
      identifier: string;
      totalChannels: number;
      cancelAt: Date | null;
    }
  ) {
    const fields = {
      subscriptionTier: plan.tier,
      period: plan.period,
      totalChannels: plan.totalChannels,
      identifier: plan.identifier,
      isLifetime: false,
      cancelAt: plan.cancelAt,
      deletedAt: null as Date | null,
    };
    await this._subscription.model.subscription.upsert({
      where: { organizationId },
      create: { organizationId, ...fields },
      update: fields,
    });
    await this._organization.model.organization.update({
      where: { id: organizationId },
      data: { isTrailing: false, allowTrial: false },
    });
    await this.stopMediaRetention(organizationId);
  }

  /**
   * Write back the plan a chargeback ended, with the paid time it had left
   * (AdminController restoreWorkspacePlan, after the owner won the dispute).
   * The row carries its old Razorpay identifier and `cancelAt` at the end of
   * the period already paid for, which is exactly the state of a plan the
   * customer cancelled: it can never charge again, because that subscription
   * is cancelled at Razorpay, and RazorpayService.endLapsedCancellations removes the row when the
   * date passes. `allowTrial` stays false: the workspace has had its plan.
   */
  async restoreDisputedSubscription(
    organizationId: string,
    plan: {
      tier: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
      period: 'MONTHLY' | 'YEARLY';
      identifier: string;
      totalChannels: number;
      cancelAt: Date;
    }
  ) {
    const fields = {
      subscriptionTier: plan.tier,
      period: plan.period,
      totalChannels: plan.totalChannels,
      identifier: plan.identifier,
      isLifetime: false,
      cancelAt: plan.cancelAt,
      deletedAt: null as Date | null,
    };
    await this._subscription.model.subscription.upsert({
      where: { organizationId },
      create: { organizationId, ...fields },
      update: fields,
    });
    await this._organization.model.organization.update({
      where: { id: organizationId },
      data: { isTrailing: false, allowTrial: false },
    });
    await this.stopMediaRetention(organizationId);
  }

  getSubscriptionByIdentifier(identifier: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        identifier,
        deletedAt: null,
      },
      include: {
        organization: true,
      },
    });
  }

  getSubscription(organizationId: string) {
    return this._subscription.model.subscription.findFirst({
      where: {
        organizationId,
        deletedAt: null,
      },
    });
  }

  /**
   * The api.market account behind a marketplace workspace (an `apimkt:` plan
   * row), for the publish-time re-check. PrismaRepository's model is the
   * whole client, so this needs no new constructor argument.
   */
  getMarketplaceAccountFacts(organizationId: string) {
    return (
      this._subscription.model as unknown as Pick<PrismaService, 'marketplaceAccount'>
    ).marketplaceAccount.findUnique({
      where: { organizationId },
      select: { product: true, plan: true, status: true },
    });
  }

  async getCreditsFrom(
    organizationId: string,
    from: dayjs.Dayjs,
    // One type, or a shared pool of types (pricing.ts AI_CREDIT_POOL)
    type: string | string[] = 'ai_images'
  ) {
    const load = await this._credits.model.credits.groupBy({
      by: ['organizationId'],
      where: {
        organizationId,
        type: Array.isArray(type) ? { in: type } : type,
        createdAt: {
          gte: from.toDate(),
        },
      },
      _sum: {
        credits: true,
      },
    });

    return load?.[0]?._sum?.credits || 0;
  }

  async useCredit<T>(
    org: Organization,
    type = 'ai_images',
    func: () => Promise<T>,
    allowance?: CreditAllowance
  ) {
    const data = allowance
      ? await this.reserveCredit(org.id, type, allowance)
      : await this._credits.model.credits.create({
          data: {
            organizationId: org.id,
            credits: 1,
            type,
          },
        });

    try {
      return await func();
    } catch (err) {
      // Release the reservation so a provider failure is not billed to the
      // customer's monthly allowance. Best effort: the caller acts on the type
      // of `err` (a publish retries, refreshes the token or disconnects the
      // channel by it), so a failed release must never replace it.
      try {
        await this._credits.model.credits.delete({
          where: {
            id: data.id,
          },
        });
      } catch (e) {
        /**empty**/
      }
      throw err;
    }
  }

  /**
   * Counts the allowance already used and writes the new credit row in a
   * single transaction, serialized per organization and credit type by a
   * Postgres advisory lock.
   *
   * The lock is what makes the cap hold: counting and inserting used to be two
   * unsynchronized statements, so N concurrent requests could each read the
   * same "1 credit left" and all proceed. That is cheap to exploit through the
   * public API, and every over-spend is real money at the provider.
   *
   * pg_advisory_xact_lock releases on commit or rollback, so a crash mid-way
   * cannot leave the organization wedged.
   */
  private reserveCredit(
    organizationId: string,
    type: string,
    allowance: CreditAllowance
  ) {
    // A shared pool (pricing.ts ai_credits) is counted and locked as one, so
    // a text and an image racing for the last credits cannot both pass.
    const pool = allowance.pool?.length ? allowance.pool : [type];
    const cost = allowance.cost ?? 1;
    const lockKey = allowance.pool?.length ? `pool:${pool.join('+')}` : type;
    return this._transaction.model.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credits:${organizationId}:${lockKey}`}))`;

      const used = await tx.credits.aggregate({
        _sum: { credits: true },
        where: {
          organizationId,
          type: pool.length === 1 ? pool[0] : { in: pool },
          createdAt: { gte: allowance.from.toDate() },
        },
      });

      if ((used._sum.credits || 0) + cost > allowance.max) {
        throw new CreditsExceededError(type);
      }

      return tx.credits.create({
        data: {
          organizationId,
          credits: cost,
          type,
        },
      });
    });
  }

  setCustomerId(orgId: string, customerId: string) {
    return this._organization.model.organization.update({
      where: {
        id: orgId,
      },
      data: {
        paymentId: customerId,
      },
    });
  }
}
