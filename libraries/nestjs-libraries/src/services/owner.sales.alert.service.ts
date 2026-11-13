import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { OrganizationRepository } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.repository';
import { sunsetExemptOrgs } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { ioRedis, ioRedisIsMock } from '@hookpost/nestjs-libraries/redis/redis.service';
import {
  cleanLine,
  OwnerSaleAlert,
  OwnerSaleContext,
  ownerSaleAlertEmail,
} from '@hookpost/nestjs-libraries/emails/templates/owner.sales.alert.email';

/** Where the owner's sale alerts go: one address, or several separated by commas. */
export const OWNER_SALES_ALERT_ENV = 'OWNER_SALES_ALERT_EMAIL';

/** The sender the owner sees in his inbox. */
export const OWNER_ALERT_FROM = 'Hookpost Alerts <support@hookstep.in>';

/**
 * How long a sent alert's key is remembered. Razorpay retries a webhook for up
 * to a day and sends authenticated, activated and charged for one
 * subscription; refund.created and refund.processed for one refund. Same
 * horizon as the customer emails' sendOnce.
 */
export const OWNER_ALERT_ONCE_TTL_SECONDS = 45 * 86400;

/** The longest a key is remembered (a yearly plan's cancellation, plus margin). */
const OWNER_ALERT_MAX_TTL_SECONDS = 400 * 86400;
/** How long the queue list lives without being touched. */
const PENDING_LIST_TTL_SECONDS = 7 * 86400;

/** Alerts Resend refused, waiting for the next retry run (a Redis list). */
export const OWNER_ALERT_PENDING_KEY = 'owner-sales-alert:pending';
/** A queued alert is tried this many times, one run apart, then dropped (logged). */
export const OWNER_ALERT_MAX_TRIES = 48;
/** How often queued alerts are retried, where RUN_CRON is on: 48 x 30 min = a day. */
const RETRY_RUN_MS = 30 * 60 * 1000;
/** Alerts one retry run sends at most. */
const RETRY_BATCH = 50;

/** How long a cancel waits on the mark before going on without it. */
const MARK_TIMEOUT_MS = 500;

/** `p`, or a rejection once `ms` have passed. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(p).finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
      timer.unref?.();
    }),
  ]);
}

const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;

/** OWNER_SALES_ALERT_EMAIL as a list of addresses; anything malformed is dropped. */
export function ownerAlertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env[OWNER_SALES_ALERT_ENV] ?? '')
    .split(/[,;\s]+/)
    .map((a) => a.trim())
    .filter((a) => EMAIL_RE.test(a));
}

/** Why a Razorpay event is not a live sale, from the key this process runs with. */
export function razorpayKeyTestReason(env: NodeJS.ProcessEnv = process.env): string | null {
  const key = String(env.RAZORPAY_KEY_ID || '');
  if (key.startsWith('rzp_live_')) return null;
  return 'Razorpay test key';
}

export type OwnerAlertOutcome =
  | 'sent'
  | 'disabled'
  | 'duplicate'
  /** Resend refused every attempt; the alert waits in the retry queue. */
  | 'queued'
  | 'failed'
  | 'invalid';

/** A rendered alert waiting for Resend to come back. */
interface PendingAlert {
  key: string;
  event: string;
  subject: string;
  text: string;
  /** Absent on alerts queued before the HTML template (sent as text only). */
  html?: string;
  tries: number;
  firstFailedAt: string;
}

/**
 * Emails the owner about every money event (OWNER_SALES_ALERT_EMAIL), so he
 * hears about a sale from Hookpost rather than from Razorpay's merchant copy
 * of the customer's receipt. The callers are the billing paths that already
 * act on the event (RazorpayService, GumroadLicenseService); this only reads
 * the workspace and sends.
 *
 * - Exactly one email per alert key: claimed in Redis (SET NX) before
 *   anything is sent, so a webhook Razorpay retries, delivers twice, or
 *   delivers while /razorpay/verify handles the same subscription, gives one
 *   email. If Redis cannot be reached the email is sent anyway: for the
 *   owner a duplicate is better than a missed sale.
 * - Resend down: a few quick attempts, then the rendered alert waits in a
 *   Redis list (the claim kept, so nothing else sends it) and the retry run
 *   (every 30 minutes where RUN_CRON is on) sends it, for up to a day. Only
 *   if that list cannot be written is the claim given back, for a
 *   redelivery to try.
 * - Never throws and is never awaited by a webhook: an email provider outage
 *   cannot fail or slow the webhook, and the plan is provisioned either way.
 * - Nothing but the whitelisted fields of OwnerSaleAlert/OwnerSaleContext is
 *   written: no card, UPI or bank details, no phone number, no signature.
 * - Only fake money gets the small "Test mode" badge (never a subject
 *   prefix): a Razorpay key that is not rzp_live_, or a provider's test
 *   purchase. An internal workspace (a member is a platform super admin, or
 *   FREE_PLAN_SUNSET_EXEMPT_ORGS lists it, the same two lists
 *   isInternalWorkspace reads) on a live key is real money and gets an
 *   "Internal workspace" badge instead (ownerAlertMode).
 */
@Injectable()
export class OwnerSalesAlertService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OwnerSalesAlertService.name);
  private warnedOff = false;
  private timer?: NodeJS.Timeout;
  /** Waits before each immediate send attempt; the spec shortens them. */
  retryDelaysMs = [0, 2000, 10000];

  constructor(private _organizationRepository: OrganizationRepository) {}

  /** The retry run, only where RUN_CRON is on (production backend and orchestrator). */
  onModuleInit() {
    if (process.env.RUN_CRON !== 'true' || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.retryPending(), RETRY_RUN_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire and forget from a webhook: never rejects. */
  notify(alert: OwnerSaleAlert): Promise<OwnerAlertOutcome> {
    return this.send(alert).catch((e) => {
      this.logger.error(`Owner sale alert ${alert?.key} failed: ${e?.message || e}`);
      return 'failed' as const;
    });
  }

  private apiKey() {
    return process.env.RESEND_API_KEY || '';
  }

  private async send(alert: OwnerSaleAlert): Promise<OwnerAlertOutcome> {
    const to = ownerAlertRecipients();
    if (!to.length || !this.apiKey()) {
      if (!this.warnedOff) {
        this.warnedOff = true;
        this.logger.log(
          `Owner sale alerts are off (${!to.length ? `${OWNER_SALES_ALERT_ENV} not set` : 'RESEND_API_KEY not set'}).`
        );
      }
      return 'disabled';
    }
    const key = cleanLine(alert?.key, 200);
    if (!alert?.event || !key) return 'invalid';

    const redisKey = `owner-sales-alert:${key}`;
    const ttl = Math.min(
      OWNER_ALERT_MAX_TTL_SECONDS,
      Math.max(OWNER_ALERT_ONCE_TTL_SECONDS, Math.ceil(Number(alert.ttlSeconds) || 0))
    );
    let claimed = true;
    let redisDown = false;
    try {
      claimed =
        (await (ioRedis as any).set(
          redisKey,
          new Date().toISOString(),
          'EX',
          ttl,
          'NX'
        )) === 'OK';
    } catch (e: any) {
      redisDown = true;
      this.logger.warn(
        `Could not claim ${redisKey} (${e?.message || e}); sending the owner alert anyway.`
      );
    }
    if (!claimed) return 'duplicate';

    const ctx = await this.context(alert);
    const { subject, html, text } = ownerSaleAlertEmail(alert, ctx);

    let lastError = '';
    for (const wait of this.retryDelaysMs) {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const error = await this.deliver(to, subject, text, html);
      if (!error) {
        this.logger.log(`Owner sale alert sent: ${alert.event} ${key}`);
        return 'sent';
      }
      lastError = error;
    }

    if (!redisDown) {
      const pending: PendingAlert = {
        key,
        event: alert.event,
        subject,
        text,
        html,
        tries: 0,
        firstFailedAt: new Date().toISOString(),
      };
      try {
        await (ioRedis as any).rpush(OWNER_ALERT_PENDING_KEY, JSON.stringify(pending));
        await (ioRedis as any)
          .expire(OWNER_ALERT_PENDING_KEY, PENDING_LIST_TTL_SECONDS)
          .catch(() => undefined);
        this.logger.warn(
          `Owner sale alert ${alert.event} ${key} not sent (${lastError}); queued for the retry run.`
        );
        return 'queued';
      } catch {
        await (ioRedis as any).del(redisKey).catch(() => undefined);
      }
    }
    this.logger.error(
      `Owner sale alert ${alert.event} ${key} not sent after ${this.retryDelaysMs.length} attempts: ${lastError}`
    );
    return 'failed';
  }

  /**
   * A short-lived note that something is about to send the alert for `key`
   * itself (the customer pressed Cancel, and the cancel call to Razorpay is
   * on its way): isMarked() lets the webhook that races it stand back, so
   * the alert that goes out is the one with the customer's reason. Never
   * throws.
   */
  async mark(key: string, seconds = 600): Promise<void> {
    // Without the mark the webhook may send the alert first, without the
    // reason; that is all. Never waits long: the customer's Cancel is
    // waiting on it, and ioredis queues commands while Redis is away.
    await withTimeout(
      (ioRedis as any).set(`owner-sales-alert:mark:${key}`, '1', 'EX', seconds),
      MARK_TIMEOUT_MS
    ).catch(() => undefined);
  }

  async unmark(key: string): Promise<void> {
    await withTimeout(
      (ioRedis as any).del(`owner-sales-alert:mark:${key}`),
      MARK_TIMEOUT_MS
    ).catch(() => undefined);
  }

  /** Not marked when Redis does not answer in time. */
  async isMarked(key: string): Promise<boolean> {
    try {
      return !!(await withTimeout(
        (ioRedis as any).get(`owner-sales-alert:mark:${key}`),
        MARK_TIMEOUT_MS
      ));
    } catch {
      return false;
    }
  }

  /** One send through Resend; the error message, or null when it was accepted. */
  private async deliver(
    to: string[],
    subject: string,
    text: string,
    html?: string
  ): Promise<string | null> {
    try {
      const { Resend } = await import('resend');
      const result: any = await new Resend(this.apiKey()).emails.send({
        from: OWNER_ALERT_FROM,
        to,
        subject,
        text,
        ...(html ? { html } : {}),
      });
      if (result?.error) {
        return String(result.error.message || JSON.stringify(result.error));
      }
      return null;
    } catch (e: any) {
      return String(e?.message || e);
    }
  }

  /**
   * Send what is waiting in the retry queue. Each alert is taken off the
   * list by one process (LPOP), sent once, and put back with one more try on
   * failure, until OWNER_ALERT_MAX_TRIES. Never throws.
   */
  async retryPending(): Promise<{ sent: number; requeued: number; dropped: number }> {
    const out = { sent: 0, requeued: 0, dropped: 0 };
    const to = ownerAlertRecipients();
    // Without REDIS_URL (a development machine) there is no queue to read.
    if (!to.length || !this.apiKey() || ioRedisIsMock) return out;
    try {
      for (let i = 0; i < RETRY_BATCH; i++) {
        const raw = await (ioRedis as any).lpop(OWNER_ALERT_PENDING_KEY);
        if (!raw) break;
        let item: PendingAlert;
        try {
          item = JSON.parse(raw);
        } catch {
          continue;
        }
        const error = await this.deliver(to, item.subject, item.text, item.html);
        if (!error) {
          out.sent++;
          this.logger.log(`Owner sale alert sent on retry: ${item.event} ${item.key}`);
          continue;
        }
        item.tries = Number(item.tries || 0) + 1;
        if (item.tries >= OWNER_ALERT_MAX_TRIES) {
          out.dropped++;
          this.logger.error(
            `Owner sale alert ${item.event} ${item.key} dropped after ${item.tries} retries since ${item.firstFailedAt}: ${error}`
          );
          continue;
        }
        await (ioRedis as any).rpush(OWNER_ALERT_PENDING_KEY, JSON.stringify(item));
        await (ioRedis as any)
          .expire(OWNER_ALERT_PENDING_KEY, PENDING_LIST_TTL_SECONDS)
          .catch(() => undefined);
        out.requeued++;
        // Resend is still down: the rest waits for the next run.
        break;
      }
    } catch (e: any) {
      this.logger.error(`Owner sale alert retry run failed: ${e?.message || e}`);
    }
    return out;
  }

  /** The workspace, its customer and where they came from. Never throws. */
  private async context(alert: OwnerSaleAlert): Promise<OwnerSaleContext> {
    const reasons: string[] = [];
    if (alert.test) {
      reasons.push(
        alert.source === 'gumroad' ? 'Gumroad test purchase' : 'test payment'
      );
    }
    // A correction ('hookpost') is about a Razorpay plan too, so a test key
    // makes it test money just the same.
    if (alert.source !== 'gumroad') {
      const keyReason = razorpayKeyTestReason();
      if (keyReason) reasons.push(keyReason);
    }

    const orgId = alert.organizationId || '';
    const ctx: OwnerSaleContext = {};
    if (orgId) {
      try {
        const facts: any = await this._organizationRepository.getSaleAlertFacts(orgId);
        const members: any[] = (facts?.users || []).filter((m: any) => m?.user);
        const buyer =
          (alert.userId && members.find((m) => m.user.id === alert.userId)) ||
          members[0];
        const u = buyer?.user;
        ctx.orgName = facts?.name ?? null;
        ctx.orgCreatedAt = facts?.createdAt ?? null;
        ctx.customerName = u
          ? [u.name, u.lastName].filter(Boolean).join(' ') || null
          : null;
        ctx.customerEmail = u?.email ?? null;
        ctx.signupCountry = u?.signupCountry ?? null;
        ctx.attribution = facts?.attribution || null;
        ctx.internal =
          sunsetExemptOrgs().has(orgId) ||
          members.some((m) => m.user.isSuperAdmin && !m.user.deletedAt);
      } catch (e: any) {
        ctx.contextError = true;
        this.logger.warn(
          `Owner sale alert ${alert.key}: workspace ${orgId} could not be read: ${e?.message || e}`
        );
      }
    }
    ctx.testReason = reasons.length ? reasons.join('; ') : null;
    return ctx;
  }
}
