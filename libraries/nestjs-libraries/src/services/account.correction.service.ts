import { Injectable, Logger } from '@nestjs/common';
import { OrganizationRepository } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository';
import { sunsetExemptOrgs } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import {
  AccountCorrectionEvent,
  AccountCorrectionFacts,
  accountCorrectionEmail,
} from '@hookpost/nestjs-libraries/emails/templates/account.correction.emails';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';

/** Where a correction email comes from; the billing emails use the same box. */
const CORRECTION_FROM = 'Hookpost Billing <support@hookstep.in>';

/**
 * How long a sent correction's key is remembered. The same horizon as the
 * billing emails' sendOnce: long enough that a job rerun, a redeploy or a
 * second admin cannot send the same apology twice.
 */
export const CORRECTION_ONCE_TTL_SECONDS = 45 * 86400;

/** How a correction email ended up. */
export type CorrectionEmailOutcome =
  | 'sent'
  /** The workspace is one of ours. */
  | 'internal'
  /** The caller asked for no customer email (the admin's opt-out). */
  | 'opted-out'
  /** That correction has already been emailed for this workspace. */
  | 'duplicate'
  /** No RESEND_API_KEY, so no email anywhere in this environment. */
  | 'disabled'
  /** The workspace has no member with an email address. */
  | 'no-recipient'
  | 'failed';

export interface AccountCorrection {
  organizationId: string;
  /** What the correction says to the customer. */
  facts: AccountCorrectionFacts;
  /**
   * What the correction is about: the Razorpay subscription or refund id it
   * corrects. One email per workspace per event per reference, so a job that
   * runs hourly corrects a subscription once. Without one the day in India is
   * used, which still stops a rerun inside the same day.
   */
  reference?: string | null;
  /** Why we did it, in our own words. Goes to the owner, never to the customer. */
  reason: string;
  /** Who did it: an admin's email, or the name of the job. */
  by: string;
  /** Don't email the customer, whatever workspace this is. */
  skipCustomerEmail?: boolean;
  /** For the owner's alert. */
  tier?: string | null;
  period?: string | null;
  /** Major units (rupees, not paise), when money moved. */
  amount?: number | null;
  currency?: string | null;
  ids?: { subscription?: string | null; payment?: string | null; refund?: string | null };
}

export interface AccountCorrectionResult {
  email: CorrectionEmailOutcome;
  /** The subject that went out, for the audit row. */
  subject?: string;
  /** Who it went to, for the audit row. */
  to?: string;
}

/**
 * Tells a customer that Hookpost got their plan wrong and has put it right,
 * and tells the owner the same thing.
 *
 * Every other billing email answers a Razorpay webhook. These answer us: an
 * admin pressing "End plan now" or "Restore plan" on the Users & Billing page,
 * or the billing reconcile job finding a workspace whose plan does not match
 * what Razorpay says. So the rules are a little different from
 * RazorpayService's:
 *
 * - One email per workspace, event and reference (Redis SET NX), because a
 *   job that reruns must not apologise twice for one mistake. With Redis
 *   unreachable nothing is sent, as everywhere else in billing.
 * - An internal workspace (a platform super admin is a member, or
 *   FREE_PLAN_SUNSET_EXEMPT_ORGS lists it) is never emailed: correcting our
 *   own test workspace is not news to anyone. An admin can also switch the
 *   email off per action.
 * - The owner alert goes out either way, so a correction nobody was emailed
 *   about is still visible.
 * - Never throws: the plan change has already happened by the time this runs,
 *   and an email provider outage must not undo it or fail the request.
 */
@Injectable()
export class AccountCorrectionService {
  private readonly logger = new Logger(AccountCorrectionService.name);

  constructor(
    private _organizationRepository: OrganizationRepository,
    private _ownerSalesAlertService: OwnerSalesAlertService
  ) {}

  /** Email the customer and alert the owner. Never rejects. */
  async notify(correction: AccountCorrection): Promise<AccountCorrectionResult> {
    const result = await this.sendCustomerEmail(correction).catch((e) => {
      this.logger.error(
        `Correction email ${correction.facts.event} for ${
          correction.organizationId
        } failed: ${e?.message || e}`
      );
      return { email: 'failed' as const };
    });

    // Fire and forget, like every other owner alert: it must not hold up or
    // fail the admin's request. Wrapped because the plan change has already
    // happened; an alert that cannot be raised is a log line, not an error.
    try {
      void this._ownerSalesAlertService.notify({
        event: correction.facts.event,
        key: `correction:${this.onceKey(correction)}`,
        source: 'hookpost',
        organizationId: correction.organizationId,
        tier: correction.tier ?? null,
        period: correction.period ?? null,
        amount: correction.amount ?? null,
        currency: correction.currency ?? null,
        amountNote: correction.amount ? 'refunded' : null,
        ids: correction.ids,
        notes: [
          `Reason: ${correction.reason}`,
          `By: ${correction.by}`,
          `Customer email: ${this.outcomeNote(result.email)}`,
        ],
      });
    } catch (e: any) {
      this.logger.error(
        `Owner alert for ${correction.facts.event} on ${
          correction.organizationId
        } could not be raised: ${e?.message || e}`
      );
    }

    return result;
  }

  /** What the owner's alert says about the customer's copy. */
  private outcomeNote(outcome: CorrectionEmailOutcome): string {
    switch (outcome) {
      case 'sent':
        return 'sent';
      case 'internal':
        return 'not sent (internal workspace)';
      case 'opted-out':
        return 'not sent (switched off for this action)';
      case 'duplicate':
        return 'not sent (already sent for this correction)';
      case 'disabled':
        return 'not sent (no email provider configured)';
      case 'no-recipient':
        return 'not sent (the workspace has no member with an email address)';
      default:
        return 'NOT SENT - the send failed, see the logs';
    }
  }

  /**
   * `<event>:<orgId>:<reference>`, where the reference falls back to the day
   * in India. Lower case and hyphenated, as the docs and the admin page show
   * it (docs/billing-emails.md).
   */
  private onceKey(correction: AccountCorrection): string {
    const event = correction.facts.event.toLowerCase().replace(/_/g, '-');
    const reference =
      String(correction.reference || '').trim() ||
      new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    return `${event}:${correction.organizationId}:${reference}`;
  }

  private async sendCustomerEmail(
    correction: AccountCorrection
  ): Promise<AccountCorrectionResult> {
    const apiKey = process.env.RESEND_API_KEY || '';
    if (!apiKey) return { email: 'disabled' };
    if (correction.skipCustomerEmail) return { email: 'opted-out' };

    const facts: any = await this._organizationRepository
      .getSaleAlertFacts(correction.organizationId)
      .catch(() => null);
    const all: any[] = (facts?.users || []).filter((m: any) => m?.user);
    // The recipient must be a live member: a deleted first member is skipped.
    const members = all.filter((m: any) => !m.user.deletedAt);
    if (
      sunsetExemptOrgs().has(correction.organizationId) ||
      members.some((m: any) => m.user.isSuperAdmin)
    ) {
      return { email: 'internal' };
    }

    // The billing contact, as everywhere else in billing: the first member.
    const to = members[0]?.user?.email || '';
    if (!to || !to.includes('@')) return { email: 'no-recipient' };

    const email = accountCorrectionEmail(
      correction.facts,
      facts?.name || 'your workspace'
    );

    const redisKey = `hookpost:account-correction:${this.onceKey(correction)}`;
    let claimed = false;
    try {
      claimed =
        (await (ioRedis as any).set(
          redisKey,
          new Date().toISOString(),
          'EX',
          CORRECTION_ONCE_TTL_SECONDS,
          'NX'
        )) === 'OK';
    } catch (e: any) {
      // As in RazorpayService.sendOnce: a correction nobody received is
      // easier to put right than two apologies for one mistake.
      this.logger.error(`Could not claim ${redisKey}; nothing sent: ${e?.message || e}`);
      return { email: 'failed' };
    }
    if (!claimed) {
      this.logger.log(`Skipping ${redisKey}: that correction already went out.`);
      return { email: 'duplicate' };
    }

    try {
      const { Resend } = await import('resend');
      const sent: any = await new Resend(apiKey).emails.send({
        from: CORRECTION_FROM,
        to,
        reply_to: 'support@hookstep.in',
        subject: email.subject,
        html: email.html,
        text: email.text,
      });
      if (sent?.error) {
        throw new Error(sent.error.message || JSON.stringify(sent.error));
      }
    } catch (e: any) {
      await (ioRedis as any).del(redisKey).catch((): undefined => undefined);
      this.logger.error(
        `Correction email "${email.subject}" to org ${correction.organizationId} failed: ${
          e?.message || e
        }`
      );
      return { email: 'failed' };
    }

    this.logger.log(
      `"${email.subject}" sent to ${to} for org ${correction.organizationId}`
    );
    return { email: 'sent', subject: email.subject, to };
  }
}

/** The events this service can send, re-exported so callers need one import. */
export type { AccountCorrectionEvent };
