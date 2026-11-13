import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';
import { MARKETPLACE_IDENTIFIER_PREFIX } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { ReviewAskTarget } from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.policy';

export interface ReviewAskMembership {
  organizationId: string;
  role: string;
  createdAt: Date;
}

/**
 * Reads for the review card's decision (review.ask.policy.ts) and the one
 * ReviewAsk row per user. Every read is scoped to the user's own active
 * memberships.
 */
@Injectable()
export class ReviewAskRepository {
  constructor(
    private _reviewAsk: PrismaRepository<'reviewAsk'>,
    private _userOrganization: PrismaRepository<'userOrganization'>,
    private _post: PrismaRepository<'post'>,
    private _subscription: PrismaRepository<'subscription'>,
    private _marketplaceAccount: PrismaRepository<'marketplaceAccount'>
  ) {}

  getState(userId: string) {
    return this._reviewAsk.model.reviewAsk.findUnique({ where: { userId } });
  }

  /** Workspaces the user is an active member of (not disabled, not deleted). */
  getMemberships(userId: string): Promise<ReviewAskMembership[]> {
    return this._userOrganization.model.userOrganization.findMany({
      where: { userId, disabled: false, organization: { deletedAt: null } },
      select: { organizationId: true, role: true, createdAt: true },
    });
  }

  /** Any of these is an api.market workspace or has a platform super admin member. */
  async hasInternalWorkspace(organizationIds: string[]) {
    if (!organizationIds.length) return false;
    const admins = await this._userOrganization.model.userOrganization.count({
      where: {
        organizationId: { in: organizationIds },
        user: { isSuperAdmin: true, deletedAt: null },
      },
    });
    if (admins > 0) return true;
    const marketplace = await this._marketplaceAccount.model.marketplaceAccount.count({
      where: { organizationId: { in: organizationIds } },
    });
    return marketplace > 0;
  }

  /**
   * The newest published post in these workspaces made since the user joined
   * each, and whether another one went out at a different time before it:
   * { count: 0, 1 or 2, latest }. A post sent to several channels at once is
   * one row per channel, each with its own group (posts.repository.ts rotates
   * it per channel) but one publishDate, so it counts once.
   */
  async getPublishedPosts(memberships: ReviewAskMembership[], now: Date) {
    if (!memberships.length) return { count: 0, latest: null as Date | null };
    const where: Prisma.PostWhereInput = {
      state: 'PUBLISHED',
      deletedAt: null,
      parentPostId: null,
      publishDate: { lte: now },
      OR: memberships.map((m) => ({
        organizationId: m.organizationId,
        createdAt: { gte: m.createdAt },
      })),
    };
    const latest = await this._post.model.post.findFirst({
      where,
      orderBy: { publishDate: 'desc' },
      select: { publishDate: true },
    });
    if (!latest) return { count: 0, latest: null };
    const other = await this._post.model.post.findFirst({
      where: { ...where, publishDate: { lt: latest.publishDate } },
      select: { id: true },
    });
    return { count: other ? 2 : 1, latest: latest.publishDate };
  }

  /**
   * When the newest live paid plan of these workspaces started: not deleted,
   * not set to end, not a lifetime grant, not an api.market plan.
   */
  async getPaidPlanStartedAt(organizationIds: string[]) {
    if (!organizationIds.length) return null;
    const row = await this._subscription.model.subscription.findFirst({
      where: {
        organizationId: { in: organizationIds },
        deletedAt: null,
        cancelAt: null,
        isLifetime: false,
        // NOT alone would also drop a row without an identifier (SQL NULL).
        OR: [
          { identifier: null },
          { NOT: { identifier: { startsWith: MARKETPLACE_IDENTIFIER_PREFIX } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt || null;
  }

  /**
   * Stamp askedAt, only if the user is not asked within the cooldown and has
   * not opened a review page: true when this call made the claim. A second
   * tab or device racing it gets false (the conditional update matches
   * nothing, or the insert hits the primary key).
   */
  async claim(userId: string, now: Date, askedBefore: Date): Promise<boolean> {
    const updated = await this._reviewAsk.model.reviewAsk.updateMany({
      where: { userId, clickedAt: null, askedAt: { lt: askedBefore } },
      data: { askedAt: now, asks: { increment: 1 }, dismissedAt: null },
    });
    if (updated.count > 0) return true;
    try {
      await this._reviewAsk.model.reviewAsk.create({
        data: { userId, askedAt: now },
      });
      return true;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        return false;
      }
      throw e;
    }
  }

  /** "Not now": only for a card that was shown (a claimed row). */
  async dismiss(userId: string, now: Date) {
    const res = await this._reviewAsk.model.reviewAsk.updateMany({
      where: { userId, dismissedAt: null, clickedAt: null },
      data: { dismissedAt: now },
    });
    return res.count > 0;
  }

  /** The user opened a review page: no more asks. */
  async click(userId: string, target: ReviewAskTarget, now: Date) {
    const res = await this._reviewAsk.model.reviewAsk.updateMany({
      where: { userId, clickedAt: null },
      data: { clickedAt: now, clickedTarget: target },
    });
    return res.count > 0;
  }
}
