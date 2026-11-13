import { Injectable, Logger } from '@nestjs/common';
import { ReviewAskRepository } from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.repository';
import {
  decideReviewAsk,
  capReason,
  NO_RECENT_SUCCESS,
  REVIEW_ASK_COOLDOWN_DAYS,
  ReviewAskDecision,
  ReviewAskTarget,
} from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.policy';
import { sunsetExemptOrgs } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewAskUser {
  id: string;
  email: string;
  isSuperAdmin?: boolean | null;
  activated?: boolean | null;
  deletedAt?: Date | null;
}

export type ReviewAskAction = 'shown' | 'dismissed' | 'clicked';

/**
 * The in-app review card (review.ask.policy.ts has the rules). GET asks
 * whether the card is due; the page claims it (`shown`) right before showing
 * it, and that claim re-checks everything and stamps askedAt atomically, so a
 * second tab or the Play app on another device gets `false`.
 *
 * Never throws to the caller: until review-ask.migration.sql is applied, or
 * if the database fails, the card simply does not appear.
 */
@Injectable()
export class ReviewAskService {
  private readonly logger = new Logger(ReviewAskService.name);
  private warned = false;

  constructor(private _reviewAskRepository: ReviewAskRepository) {}

  /**
   * The card is off for this request. A missing table (review-ask.migration.sql
   * not applied yet) is said once per process; anything else is logged every
   * time, so a real failure does not hide behind the migration hint.
   */
  private unavailable(err: unknown): ReviewAskDecision {
    const missingTable =
      (err as any)?.code === 'P2021' ||
      /ReviewAsk.*does not exist|does not exist.*ReviewAsk/i.test(
        String((err as Error)?.message || '')
      );
    if (!missingTable) {
      this.logger.error(
        `Review card check failed: ${(err as Error)?.message || err}`
      );
    } else if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'Review card is off until review-ask.migration.sql is applied.'
      );
    }
    return { ask: false, reason: 'unavailable' };
  }

  /** Whether the card is due for this user right now. */
  async status(
    user: ReviewAskUser,
    impersonating: boolean,
    now: Date = new Date()
  ): Promise<ReviewAskDecision> {
    try {
      return await this.decide(user, impersonating, now);
    } catch (err) {
      return this.unavailable(err);
    }
  }

  private async decide(
    user: ReviewAskUser,
    impersonating: boolean,
    now: Date
  ): Promise<ReviewAskDecision> {
    // The cheap refusals first, so most page loads cost one query or none.
    const base = {
      user,
      impersonating,
      internalWorkspace: false,
      publishedPosts: 0,
      latestPublishAt: null,
      paidPlanStartedAt: null,
    };
    const early = decideReviewAsk({ ...base, state: null }, now);
    if ('reason' in early && early.reason !== NO_RECENT_SUCCESS) return early;

    const state = await this._reviewAskRepository.getState(user.id);
    if (capReason(state, now)) return decideReviewAsk({ ...base, state }, now);

    const memberships = await this._reviewAskRepository.getMemberships(user.id);
    const orgIds = memberships.map((m) => m.organizationId);
    const exempt = sunsetExemptOrgs();
    const internalWorkspace =
      orgIds.some((id) => exempt.has(id)) ||
      (await this._reviewAskRepository.hasInternalWorkspace(orgIds));
    if (internalWorkspace) {
      return decideReviewAsk({ ...base, state, internalWorkspace }, now);
    }

    const published = await this._reviewAskRepository.getPublishedPosts(
      memberships,
      now
    );
    const owned = memberships
      .filter((m) => m.role === 'SUPERADMIN')
      .map((m) => m.organizationId);
    const paidPlanStartedAt =
      await this._reviewAskRepository.getPaidPlanStartedAt(owned);

    return decideReviewAsk(
      {
        ...base,
        state,
        publishedPosts: published.count,
        latestPublishAt: published.latest,
        paidPlanStartedAt,
      },
      now
    );
  }

  /**
   * `shown`: claim the ask (true only if it is due and this call claimed it).
   * `dismissed` / `clicked`: recorded on a claimed row only. Impersonation
   * records nothing.
   */
  async record(
    user: ReviewAskUser,
    impersonating: boolean,
    action: ReviewAskAction,
    target?: ReviewAskTarget,
    now: Date = new Date()
  ): Promise<{ ok: boolean }> {
    if (impersonating) return { ok: false };
    try {
      if (action === 'shown') {
        const decision = await this.decide(user, false, now);
        if (!decision.ask) return { ok: false };
        const askedBefore = new Date(
          now.getTime() - REVIEW_ASK_COOLDOWN_DAYS * DAY_MS
        );
        return {
          ok: await this._reviewAskRepository.claim(user.id, now, askedBefore),
        };
      }
      if (action === 'dismissed') {
        return { ok: await this._reviewAskRepository.dismiss(user.id, now) };
      }
      if (action === 'clicked' && target) {
        return {
          ok: await this._reviewAskRepository.click(user.id, target, now),
        };
      }
      return { ok: false };
    } catch (err) {
      this.unavailable(err);
      return { ok: false };
    }
  }
}
