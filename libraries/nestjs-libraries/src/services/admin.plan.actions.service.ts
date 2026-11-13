import { Injectable, Logger } from '@nestjs/common';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';

import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  PlanAction,
  PlanActionAuditRepository,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.action.audit.repository';
import { RazorpayService } from '@hookpost/nestjs-libraries/services/razorpay.service';
import { LIVE_STATES } from '@hookpost/nestjs-libraries/services/razorpay.mapping';
import { AccountCorrectionService } from '@hookpost/nestjs-libraries/services/account.correction.service';
import { AccountCorrectionFacts } from '@hookpost/nestjs-libraries/emails/templates/account.correction.emails';
import { DisputeEvidencePack } from '@hookpost/nestjs-libraries/services/dispute.evidence';
import { planLapsed } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

/** Who pressed the button; the same shape the Refunds page passes. */
export interface PlanActionAdmin {
  id: string;
  email: string;
}

/** Which correction email an ending sends, or none at all. */
export type EndPlanCorrection =
  | 'PLAN_CORRECTED_ENDED'
  | 'REFUND_ENDED_PLAN'
  | 'CHARGE_STOPPED'
  | 'NONE';

export interface EndPlanRequest {
  organizationId: string;
  reason: string;
  correction: EndPlanCorrection;
  /** The admin switched the customer's email off (an internal workspace, a test). */
  skipCustomerEmail?: boolean;
  /** For REFUND_ENDED_PLAN: when the refund that should have ended it was made. */
  refundedOn?: Date | null;
}

export interface RestorePlanRequest {
  organizationId: string;
  reason: string;
  tier: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' | 'HOOKPOST';
  period: 'MONTHLY' | 'YEARLY';
  /** Send the customer PLAN_RESTORED. Off for an internal workspace or a test. */
  skipCustomerEmail?: boolean;
  /**
   * When a plan given as a gift ends (cancelAt). Without it the plan has no
   * end; with it the admin page shows "Free <tier> until <date>" and every
   * gate treats it as over from then on (trial.policy.ts planLapsed).
   */
  until?: Date | null;
}

/** What "Restore plan" after a won dispute did, for the admin's dialog. */
export type DisputeRestoreResult =
  | {
      restored: true;
      until: string;
      tier: string;
      period: string;
      identifier: string;
    }
  | { restored: false; reason: string };

export interface PlanActionResult {
  ok: boolean;
  /** Why nothing happened, for the dialog. */
  reason?: string;
  /** The Razorpay subscription was cancelled too, so nothing can charge again. */
  cancelledAtProvider?: boolean;
  /** What became of the customer's email: sent, internal, opted-out, duplicate... */
  email?: string;
  auditId?: string;
}

/**
 * "End plan now" and "Restore plan" on the super admin's Users & Billing page.
 *
 * A plan the customer did not change, so three things always happen together:
 * the same code path the app itself uses makes the change, a PlanActionAudit
 * row records who did it and why, and the customer is told what we did
 * (AccountCorrectionService). Nothing here reimplements ending or restoring a
 * plan; it only decides which existing path to call and keeps the record.
 *
 * The audit row is written first and finished afterwards, as the Refunds page
 * does: if the table is missing nothing changes at all, rather than a plan
 * ending with no record of who ended it.
 */
@Injectable()
export class AdminPlanActionsService {
  private readonly logger = new Logger(AdminPlanActionsService.name);

  constructor(
    private _subscriptionService: SubscriptionService,
    private _razorpayService: RazorpayService,
    private _planActionAuditRepository: PlanActionAuditRepository,
    private _accountCorrectionService: AccountCorrectionService,
    private _organizationService: OrganizationService
  ) {}

  /**
   * One end or restore per workspace at a time (a double click, two admins):
   * a 60 s Redis claim, released when the action is done. Without Redis
   * (development only) there is nothing shared to claim in, so it proceeds.
   */
  private async withWorkspaceLock(
    organizationId: string,
    run: () => Promise<PlanActionResult>
  ): Promise<PlanActionResult> {
    const key = `admin-plan-action:${organizationId}`;
    const claimed = await (ioRedis as any)
      .set(key, '1', 'EX', 60, 'NX')
      .then((r: any) => r === 'OK')
      .catch(() => true);
    if (!claimed) {
      return {
        ok: false,
        reason: 'Another End plan or Restore plan for this workspace is running. Try again in a minute.',
      };
    }
    try {
      return await run();
    } finally {
      await (ioRedis as any).del(key).catch(() => undefined);
    }
  }

  /**
   * End a plan our records show but the customer no longer has: a cancelled
   * trial still on file, a refunded plan that kept running, a mandate that
   * could charge again.
   */
  async endPlan(
    admin: PlanActionAdmin,
    request: EndPlanRequest
  ): Promise<PlanActionResult> {
    return this.withWorkspaceLock(request.organizationId, () =>
      this.endPlanLocked(admin, request)
    );
  }

  private async endPlanLocked(
    admin: PlanActionAdmin,
    request: EndPlanRequest
  ): Promise<PlanActionResult> {
    const { organizationId, reason, correction } = request;
    const local = await this._subscriptionService.getSubscription(organizationId);
    if (!local) {
      return {
        ok: false,
        reason: 'This workspace has no plan on file, so there is nothing to end.',
      };
    }

    const audit = await this.openAudit({
      admin,
      organizationId,
      action: 'END',
      reason,
      correction: correction === 'NONE' ? null : correction,
      tier: local.subscriptionTier,
      period: local.period,
    });
    if ('refused' in audit) return audit.refused;

    let cancelledAtProvider = false;
    try {
      // The app's own cancel: it ends the Razorpay subscription when one is
      // still live and deletes the plan row. A plan whose subscription is
      // already gone (a cancelled trial, a lifetime or Gumroad row) leaves the
      // row behind, so it is deleted here with the same service method the
      // sweep and the webhooks use.
      const cancelled = await this._razorpayService.cancelSubscription(organizationId);
      cancelledAtProvider = !!cancelled?.cancelledAtProvider;
      if (!cancelledAtProvider) {
        await this._subscriptionService.deleteSubscriptionByOrg(organizationId);
      }
      // Any other live mandate of this workspace (a duplicate from a plan
      // change) is stopped too, or the email's "nothing more is taken"
      // would not hold.
      await this._razorpayService.cancelAllSubscriptions(organizationId);
    } catch (e: any) {
      const error = String(e?.message || e);
      await this.closeAudit(audit.id, { status: 'FAILED', error });
      this.logger.error(`End plan for ${organizationId} failed: ${error}`);
      return { ok: false, reason: `Nothing was changed: ${error}`, auditId: audit.id };
    }

    const email = await this.tellCustomer(request, {
      correction,
      cancelledAtProvider,
      tier: local.subscriptionTier,
      period: local.period,
      identifier: local.identifier,
      admin,
    });

    await this.closeAudit(audit.id, { status: 'SUCCESS', emailOutcome: email });
    return { ok: true, cancelledAtProvider, email, auditId: audit.id };
  }

  /** Put a plan back that we ended or paused by mistake. */
  async restorePlan(
    admin: PlanActionAdmin,
    request: RestorePlanRequest
  ): Promise<PlanActionResult> {
    return this.withWorkspaceLock(request.organizationId, () =>
      this.restorePlanLocked(admin, request)
    );
  }

  private async restorePlanLocked(
    admin: PlanActionAdmin,
    request: RestorePlanRequest
  ): Promise<PlanActionResult> {
    const { organizationId, reason, tier, period } = request;
    const until = request.until ?? null;
    if (until && !(until.getTime() > Date.now())) {
      return { ok: false, reason: 'The end date must be in the future.' };
    }
    const existing = await this._subscriptionService.getSubscription(organizationId);
    if (existing) {
      return {
        ok: false,
        reason: `This workspace already has a live ${existing.subscriptionTier} plan. End it first if it is wrong.`,
      };
    }
    // A chargeback ended it: only the dispute's own "Restore (won)" may give
    // it back, once the dispute is won.
    const dispute: any = await this._organizationService
      .getDispute(organizationId)
      .catch(() => null);
    if (dispute?.disputedAt && !dispute.disputeClearedAt) {
      return {
        ok: false,
        reason: 'This workspace has an open chargeback. Use Restore (won) on its dispute once it is won.',
      };
    }
    // A mandate still live at Razorpay is a paid plan that should come back
    // by itself (webhook, reconcile); granting one here would sit beside it.
    const remote: any = await this._razorpayService
      .getOrgSubscriptions(organizationId)
      .catch(() => null);
    if ((remote?.items || []).some((r: any) => LIVE_STATES.includes(r?.status))) {
      return {
        ok: false,
        reason: 'A Razorpay subscription is still live for this workspace, so its plan should come back on its own. Check it in Razorpay instead of granting one here.',
      };
    }

    const audit = await this.openAudit({
      admin,
      organizationId,
      action: 'RESTORE',
      reason,
      correction: request.skipCustomerEmail ? null : 'PLAN_RESTORED',
      tier,
      period,
    });
    if ('refused' in audit) return audit.refused;

    try {
      const restored = await this._subscriptionService.restoreSubscriptionByOrg(
        organizationId,
        until ? { tier, period, cancelAt: until } : { tier, period }
      );
      if (restored === null) {
        const error = 'That workspace does not exist.';
        await this.closeAudit(audit.id, { status: 'FAILED', error });
        return { ok: false, reason: error, auditId: audit.id };
      }
    } catch (e: any) {
      const error = String(e?.message || e);
      await this.closeAudit(audit.id, { status: 'FAILED', error });
      this.logger.error(`Restore plan for ${organizationId} failed: ${error}`);
      return { ok: false, reason: `Nothing was changed: ${error}`, auditId: audit.id };
    }

    const { email } = await this._accountCorrectionService.notify({
      organizationId,
      facts: {
        event: 'PLAN_RESTORED',
        billing: tier,
        restoredAt: new Date(),
      },
      reference: audit.id,
      reason,
      by: admin.email,
      skipCustomerEmail: request.skipCustomerEmail,
      tier,
      period,
    });

    await this.closeAudit(audit.id, { status: 'SUCCESS', emailOutcome: email });
    return { ok: true, email, auditId: audit.id };
  }

  /** The most recent plan actions, for the admin page. */
  listActions(take = 100, organizationId?: string) {
    return this._planActionAuditRepository.listAudit(
      Math.min(Math.max(take, 1), 500),
      organizationId
    );
  }

  /**
   * Give back the plan a chargeback ended, for the time the workspace had
   * already paid for (payment.dispute.won, or a dispute raised by mistake).
   * Never automatic: Razorpay winning a dispute only tells the owner, and
   * this is the owner saying yes. null when the workspace does not exist.
   *
   * It also clears the dispute, because a workspace holding a plan it may
   * not keep would be the worst of both. The Razorpay subscription stays
   * cancelled, so the plan runs out at the end of the period it paid for and
   * nothing charges again. Nothing to give back (no pack, no plan in it, the
   * paid period is over, a live plan bought since, a dispute Razorpay does
   * not say was won) is said plainly and writes nothing.
   */
  async restoreAfterWonDispute(
    organizationId: string,
    by: string
  ): Promise<DisputeRestoreResult | null> {
    const org = await this._organizationService.getDisputeEvidence(organizationId);
    if (!org) return null;

    let pack: DisputeEvidencePack | null = null;
    try {
      pack = org.disputeEvidence
        ? (JSON.parse(org.disputeEvidence) as DisputeEvidencePack)
        : null;
    } catch {
      pack = null;
    }
    const plan = pack?.plan || null;
    const periodEnd = plan?.periodEnd ? new Date(plan.periodEnd) : null;
    if (!plan?.tier || !plan.identifier || !periodEnd) {
      return {
        restored: false,
        reason:
          'No plan was recorded for this dispute, so there is nothing to give back. Clear the dispute instead and let them buy again.',
      };
    }
    if (periodEnd.getTime() <= Date.now()) {
      return {
        restored: false,
        reason: `The period they paid for ended on ${periodEnd.toISOString()}, so there is no access left to give back. Clear the dispute instead and let them buy again.`,
      };
    }

    // Never over a plan the workspace has since bought: the restore would
    // overwrite a live, paying subscription with a cancelled one. A row past
    // its end date is no plan (planLapsed), whatever the sweep has not yet
    // tidied.
    const current = await this._subscriptionService.getSubscription(organizationId);
    if (current && !current.deletedAt && !planLapsed(current)) {
      return {
        restored: false,
        reason:
          'This workspace already has a plan, so nothing was restored. Clear the dispute only if it is still marked.',
      };
    }

    // Only a dispute we won, read live from Razorpay rather than from the
    // pack (which holds the status at the moment it arrived) or from a
    // webhook that may never have come.
    const live = pack?.dispute?.id
      ? await this._razorpayService.readDispute(pack.dispute.id)
      : null;
    if (!live?.status) {
      return {
        restored: false,
        reason:
          'Razorpay could not be asked whether this dispute was won, so nothing was restored. Try again in a minute.',
      };
    }
    if (live.status !== 'won') {
      return {
        restored: false,
        reason: `Razorpay says this dispute is ${String(live.status).slice(0, 40)}, not won, so the plan stays ended. Clear the dispute instead if you want to let them buy again.`,
      };
    }

    await this._subscriptionService.restoreDisputedPlan(organizationId, {
      tier: plan.tier as RestorePlanRequest['tier'],
      period: (plan.period as RestorePlanRequest['period']) || 'MONTHLY',
      identifier: plan.identifier,
      periodEnd,
    });
    await this._organizationService.clearDispute(organizationId, by);
    return {
      restored: true,
      until: periodEnd.toISOString(),
      tier: plan.tier,
      period: plan.period || '',
      identifier: plan.identifier,
    };
  }

  /** The correction email an ending sends, if any. */
  private async tellCustomer(
    request: EndPlanRequest,
    context: {
      correction: EndPlanCorrection;
      cancelledAtProvider: boolean;
      tier?: string | null;
      period?: string | null;
      identifier?: string | null;
      admin: PlanActionAdmin;
    }
  ): Promise<string> {
    if (context.correction === 'NONE') return 'opted-out';
    const now = new Date();
    const billing = context.tier || null;

    let facts: AccountCorrectionFacts;
    switch (context.correction) {
      case 'CHARGE_STOPPED':
        // The plan ends now (End plan now), so there is no paid time left
        // to name: the guard's own email, with the plan over.
        facts = { event: 'CHARGE_STOPPED', billing, accessUntil: null };
        break;
      case 'REFUND_ENDED_PLAN':
        facts = {
          event: 'REFUND_ENDED_PLAN',
          billing,
          refundedOn: request.refundedOn || now,
          endedAt: now,
        };
        break;
      default:
        facts = {
          event: 'PLAN_CORRECTED_ENDED',
          billing,
          endedAt: now,
          // An admin ending a plan by hand cannot know from here whether a
          // charge ever went through, and the email must not say "you were
          // never charged" unless it is certain.
          neverCharged: false,
        };
    }

    const { email } = await this._accountCorrectionService.notify({
      organizationId: request.organizationId,
      facts,
      reference: context.identifier || null,
      reason: request.reason,
      by: context.admin.email,
      skipCustomerEmail: request.skipCustomerEmail,
      tier: context.tier,
      period: context.period,
      ids: { subscription: context.identifier || null },
    });
    return email;
  }

  private async openAudit(data: {
    admin: PlanActionAdmin;
    organizationId: string;
    action: PlanAction;
    reason: string;
    correction: string | null;
    tier?: string | null;
    period?: string | null;
  }): Promise<{ id: string } | { refused: PlanActionResult }> {
    try {
      const row = await this._planActionAuditRepository.createAudit({
        adminUserId: data.admin.id,
        adminEmail: data.admin.email,
        organizationId: data.organizationId,
        action: data.action,
        reason: data.reason,
        correction: data.correction,
        tier: data.tier ?? null,
        period: data.period ?? null,
        status: 'PENDING',
      });
      return { id: row.id };
    } catch (e: any) {
      this.logger.error(
        `Plan ${data.action} for ${data.organizationId} not run, audit row not written: ${
          e?.message || e
        }`
      );
      return {
        refused: {
          ok: false,
          reason:
            'Could not write the audit record (has plan-action-audit.migration.sql been applied?). Nothing was changed.',
        },
      };
    }
  }

  private async closeAudit(
    id: string,
    data: { status: 'SUCCESS' | 'FAILED'; emailOutcome?: string; error?: string }
  ) {
    await this._planActionAuditRepository
      .finishAudit(id, data)
      .catch((e) => this.logger.error(`Plan action audit ${id} not updated: ${e}`));
  }
}
