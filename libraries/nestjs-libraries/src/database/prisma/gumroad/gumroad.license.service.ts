import { everyAligned, AlignedTimer } from '@hookpost/helpers/utils/timer';
import {
  HttpException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { OwnerSalesAlertService } from '@hookpost/nestjs-libraries/services/owner.sales.alert.service';
import { OwnerSaleAlert } from '@hookpost/nestjs-libraries/emails/templates/owner.sales.alert.email';
import { createHash, randomUUID } from 'crypto';
import { GumroadLicense } from '@prisma/client';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import {
  GumroadLicenseRepository,
  PlanFacts,
} from '@hookpost/nestjs-libraries/database/prisma/gumroad/gumroad.license.repository';
import {
  GumroadAnswer,
  GumroadClient,
} from '@hookpost/nestjs-libraries/services/gumroad.client';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import {
  bindDecision,
  endedRedeemError,
  GUMROAD_ACCESS_TOKEN_ENV,
  GUMROAD_REDEEM_ERRORS,
  GumroadLicenseStatus,
  GumroadPeriod,
  GumroadPurchase,
  GumroadRedeemErrorCode,
  GumroadTier,
  gumroadAccessToken,
  gumroadIdentifier,
  gumroadProducts,
  gumroadRedeemEnabled,
  GumroadVerifyResult,
  isEnded,
  LicenseStanding,
  normalizeLicenseKey,
  parseVerifyResponse,
  periodForRecurrence,
  planOnFileBlocksRedeem,
  purchaseStanding,
  statusAfter,
  sweepAction,
  tierForProduct,
  verifyStanding,
} from '@hookpost/nestjs-libraries/services/gumroad.license';

/** License statuses the owner is emailed about when the re-check reaches them. */
const OWNER_ALERT_LICENSE_STATUSES: GumroadLicenseStatus[] = [
  'CANCELLING',
  'REFUNDED',
  'CHARGEBACKED',
  'CANCELLED',
  'ENDED',
  'FAILED',
  'REVOKED',
];

/** How often the re-check runs; each license is verified once a day. */
const SWEEP_MS = 60 * 60 * 1000;
/** A license verified longer ago than this is due again. */
export const REVERIFY_AFTER_MS = 24 * 60 * 60 * 1000;
/** Licenses re-checked per run, oldest first. */
const SWEEP_BATCH = 200;

/**
 * One redeem per workspace at a time (Redis SET NX). Long enough for the
 * Gumroad calls (10 s timeout each, up to three) and the writes; the lock
 * expires by itself if the process dies holding it.
 */
export const REDEEM_LOCK_MS = 60_000;
export const redeemLockKey = (organizationId: string) =>
  `gumroad:redeem:${organizationId}`;

/**
 * One re-check run at a time across every process that runs it (the backend
 * and the orchestrator both have RUN_CRON). A run normally takes seconds;
 * the TTL only bounds a run that died holding it.
 */
export const REVERIFY_LOCK_KEY = 'gumroad:reverify-run';
export const REVERIFY_LOCK_MS = 30 * 60 * 1000;
/**
 * A run stops taking new licenses after this long, well inside the lock, so
 * two runs never work at once; what it did not reach is still due and the
 * next run (an hour later) carries on from there.
 */
export const REVERIFY_RUN_BUDGET_MS = 25 * 60 * 1000;

/**
 * What the re-check learned about one license: where its purchase stands,
 * or that another license of the same workspace now holds the sale's key
 * (the seller rotated it and the buyer redeemed the new one), which makes
 * this one REPLACED and leaves the plan to that license.
 */
/** test: the sale is a seller's test purchase (for the owner's alert only). */
type Standing = (LicenseStanding | { status: 'REPLACED' }) & { test?: boolean };

/** The only form a license key is stored in. */
export const hashLicenseKey = (key: string) =>
  createHash('sha256').update(key).digest('hex');

export class GumroadRedeemError extends HttpException {
  constructor(public readonly code: GumroadRedeemErrorCode) {
    const { status, message } = GUMROAD_REDEEM_ERRORS[code];
    super({ statusCode: status, code, message }, status);
  }
}

export interface GumroadRedeemResult {
  ok: true;
  tier: GumroadTier;
  period: GumroadPeriod;
  status: 'ACTIVE' | 'CANCELLING';
  cancelAt: Date | null;
}

export interface ReverifyResult {
  /** Licenses this run re-checked. */
  checked: number;
  changed: number;
  /** Sales Gumroad refused to show with GUMROAD_ACCESS_TOKEN (401, 403). */
  authFailures: number;
  /** Another process held the run lock: this run did nothing. */
  skipped?: boolean;
  /** The run reached its time budget; the rest are left for the next run. */
  stopped?: boolean;
}

/** Take a Redis lock owned by `token`; false when someone else holds it. */
async function takeLock(key: string, token: string, ms: number) {
  return (await ioRedis.set(key, token, 'PX', ms, 'NX')) === 'OK';
}

/**
 * Release a lock only if it is still this owner's (the channel-limit
 * pattern). A failed release is not an error: the lock expires by itself.
 */
async function releaseLock(key: string, token: string) {
  try {
    await ioRedis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1,
      key,
      token
    );
  } catch {
    // Expires by itself.
  }
}

/**
 * Hookpost plans bought on Gumroad (gumroad.license.ts has the rules).
 *
 * redeem(): the workspace's owner or admin enters the license key from the
 * Gumroad receipt. Gumroad verifies it, the key's sha256 is bound to this one
 * workspace (GumroadLicense), and the workspace's Subscription row becomes
 * the plan the product sells, with identifier "gumroad:<saleId>". One redeem
 * per workspace at a time; the plan is written before any other license of
 * the workspace is marked REPLACED, and only one for another sale is.
 *
 * reverifyLicenses(): every hour where RUN_CRON is on, each bound license not
 * verified for a day is verified again, one run at a time across processes.
 * The key itself is not kept, so it is read back from the sale
 * (GUMROAD_ACCESS_TOKEN) first. A refund, chargeback, failed renewal or ended
 * membership ends the plan the way an ended Razorpay plan ends
 * (SubscriptionService.deleteSubscriptionByOrg); a cancellation with paid
 * time left sets cancelAt to its end; a renewal lifts it. A license's new
 * status is claimed only from the status this run read, before the plan is
 * touched, so two runs cannot both act on it.
 *
 * Razorpay is never called from here, and a plan that is not the license's
 * own (a Razorpay one, another key's) is never changed.
 */
@Injectable()
export class GumroadLicenseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GumroadLicenseService.name);
  private readonly client = new GumroadClient();
  private timer?: AlignedTimer;
  private warnedNoToken = false;
  /** REVERIFY_RUN_BUDGET_MS; a spec shortens it. */
  runBudgetMs = REVERIFY_RUN_BUDGET_MS;

  constructor(
    private _repository: GumroadLicenseRepository,
    private _subscriptionService: SubscriptionService,
    // The owner's sale alerts (OWNER_SALES_ALERT_EMAIL); optional so specs
    // that build this service by hand need no change.
    @Optional() private _ownerAlerts?: OwnerSalesAlertService
  ) {}

  /**
   * The re-check, only where RUN_CRON is on (the production backend and
   * orchestrator, like the Razorpay sweeps) and a Gumroad product is set.
   * The run lock makes the second process skip.
   */
  onModuleInit() {
    if (process.env.RUN_CRON !== 'true' || process.env.NODE_ENV === 'test') {
      return;
    }
    const run = () => {
      if (!gumroadProducts().length) return;
      this.reverifyLicenses().catch((e) =>
        this.logger.error(`Gumroad license re-check failed: ${e?.message || e}`)
      );
    };
    setTimeout(run, 3 * 60 * 1000).unref();
    this.timer = everyAligned(SWEEP_MS, run);
  }

  onModuleDestroy() {
    this.timer?.stop();
  }

  /** The owner's sale alert: not awaited, never throws into a redeem or a run. */
  private alertOwner(alert: OwnerSaleAlert) {
    if (!this._ownerAlerts) return;
    try {
      void this._ownerAlerts.notify(alert).catch(() => undefined);
    } catch (e: any) {
      this.logger.error(`Owner sale alert ${alert.key} failed: ${e?.message || e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Redeem
  // ---------------------------------------------------------------------------

  async redeem(
    organizationId: string,
    rawKey: string,
    now = new Date()
  ): Promise<GumroadRedeemResult> {
    if (!gumroadRedeemEnabled()) throw new GumroadRedeemError('GUMROAD_OFF');
    const key = normalizeLicenseKey(rawKey);
    if (!key) throw new GumroadRedeemError('INVALID_KEY');

    // Two redeems on one workspace at once (two tabs, two admins, two keys)
    // would each write the plan and mark the other's license REPLACED.
    const lockKey = redeemLockKey(organizationId);
    const lockToken = randomUUID();
    if (!(await takeLock(lockKey, lockToken, REDEEM_LOCK_MS))) {
      throw new GumroadRedeemError('REDEEM_IN_PROGRESS');
    }
    try {
      return await this.redeemLocked(organizationId, key, now);
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }

  private async redeemLocked(
    organizationId: string,
    key: string,
    now: Date
  ): Promise<GumroadRedeemResult> {
    const licenseKeyHash = hashLicenseKey(key);
    const bound = await this._repository.findByHash(licenseKeyHash);
    if (bindDecision(bound, organizationId) === 'other_org') {
      throw new GumroadRedeemError('LICENSE_IN_USE');
    }

    const plan = await this._subscriptionService.getSubscription(organizationId);
    if (planOnFileBlocksRedeem(plan)) {
      throw new GumroadRedeemError('PLAN_ON_FILE');
    }

    // The product it was bound with, else each configured one in turn: a
    // key belongs to exactly one product, and Gumroad needs product_id.
    const candidates = bound
      ? [
          {
            tier: tierForProduct(bound.productId) ?? (bound.tier as GumroadTier),
            productId: bound.productId,
          },
        ]
      : gumroadProducts();
    const { tier, productId, purchase } = await this.findPurchase(candidates, key);

    const period = periodForRecurrence(purchase.recurrence);
    if (!period) throw new GumroadRedeemError('NOT_A_SUBSCRIPTION');

    const standing = purchaseStanding(purchase, now);
    if (isEnded(standing)) {
      throw new GumroadRedeemError(endedRedeemError(standing.status));
    }
    const status = standing.status;
    const cancelAt = standing.status === 'CANCELLING' ? standing.endsAt : null;

    // Read the plan again before writing anything: the Gumroad calls above
    // can take seconds, and a Razorpay plan may have activated meanwhile (a
    // checkout opened earlier, paid now). Nothing is bound then.
    const planNow = await this._subscriptionService.getSubscription(organizationId);
    if (planOnFileBlocksRedeem(planNow)) {
      throw new GumroadRedeemError('PLAN_ON_FILE');
    }

    const fields = {
      productId,
      saleId: purchase.saleId,
      tier,
      period,
      status,
      lastVerifiedAt: now,
    };
    let license: GumroadLicense;
    let created = false;
    if (bound) {
      license = await this._repository.update(bound.id, fields);
    } else {
      try {
        license = await this._repository.create({
          organizationId,
          licenseKeyHash,
          ...fields,
        });
        created = true;
      } catch (e: any) {
        // Two workspaces redeeming the same new key at once: the unique hash
        // lets one in.
        if (e?.code !== 'P2002') throw e;
        const winner = await this._repository.findByHash(licenseKeyHash);
        if (!winner || winner.organizationId !== organizationId) {
          throw new GumroadRedeemError('LICENSE_IN_USE');
        }
        license = await this._repository.update(winner.id, fields);
      }
    }

    // The plan first, then the workspace's licenses for any other sale are
    // REPLACED: the plan never points at a license marked REPLACED.
    await this._subscriptionService.applyGumroadPlan(organizationId, {
      tier,
      period,
      identifier: gumroadIdentifier(purchase.saleId),
      cancelAt,
    });
    await this._repository.replaceOthers(organizationId, purchase.saleId);

    // Gumroad's "uses" counts this workspace, once: only on the first bind.
    if (created) {
      await this.client
        .verifyLicense(productId, key, true)
        .catch((e) =>
          this.logger.warn(
            `Could not count the use of license ${license.id}: ${e?.message || e}`
          )
        );
    }

    // A new sale reaching a workspace: the owner hears about it once per
    // sale (the key), whichever workspace or license it lands on.
    if (created) {
      this.alertOwner({
        event: 'GUMROAD_REDEEMED',
        key: `gumroad-redeem:${purchase.saleId}`,
        source: 'gumroad',
        organizationId,
        tier,
        period,
        amount: purchase.price ?? null,
        currency: purchase.currency ?? null,
        amountNote: purchase.price != null ? 'paid on Gumroad' : null,
        ids: { sale: purchase.saleId, license: license.id },
        notes: [
          status === 'CANCELLING' && cancelAt
            ? `Membership already cancelled; plan ends ${cancelAt.toISOString().slice(0, 10)}`
            : null,
        ],
        test: purchase.test,
      });
    }

    this.logger.log(
      `Gumroad license ${license.id} ${created ? 'bound to' : 'redeemed again by'} org ${organizationId}: ${tier} ${period}, sale ${purchase.saleId}, ${status}${
        cancelAt ? ` until ${cancelAt.toISOString()}` : ''
      }${purchase.test ? ' (test purchase)' : ''}.`
    );
    return { ok: true, tier, period, status, cancelAt };
  }

  /** The first candidate product Gumroad verifies the key for. */
  private async findPurchase(
    candidates: Array<{ tier: GumroadTier; productId: string }>,
    key: string
  ): Promise<{ tier: GumroadTier; productId: string; purchase: GumroadPurchase }> {
    for (const { tier, productId } of candidates) {
      const result = await this.verify(productId, key);
      if (result.kind === 'valid') {
        // Gumroad answers for the product asked about; anything else is not ours.
        if (result.purchase.productId && result.purchase.productId !== productId) {
          continue;
        }
        return { tier, productId, purchase: result.purchase };
      }
      if (result.kind === 'unavailable') {
        this.logger.warn(`Gumroad license verify failed: ${result.message}`);
        throw new GumroadRedeemError('GUMROAD_UNAVAILABLE');
      }
      // Gumroad found the key for this product, and refuses it.
      if (result.kind === 'disabled' || result.kind === 'revoked') {
        throw new GumroadRedeemError('DISABLED');
      }
    }
    throw new GumroadRedeemError('INVALID_KEY');
  }

  /** POST /v2/licenses/verify without counting a use, read. */
  private async verify(productId: string, key: string): Promise<GumroadVerifyResult> {
    let answer: GumroadAnswer;
    try {
      answer = await this.client.verifyLicense(productId, key, false);
    } catch (e: any) {
      return { kind: 'unavailable', message: String(e?.message || e) };
    }
    return parseVerifyResponse(answer.status, answer.body);
  }

  // ---------------------------------------------------------------------------
  // Daily re-check
  // ---------------------------------------------------------------------------

  async reverifyLicenses(now = new Date()): Promise<ReverifyResult> {
    const lockToken = randomUUID();
    if (!(await takeLock(REVERIFY_LOCK_KEY, lockToken, REVERIFY_LOCK_MS))) {
      return { checked: 0, changed: 0, authFailures: 0, skipped: true };
    }
    try {
      return await this.reverifyLocked(now);
    } finally {
      await releaseLock(REVERIFY_LOCK_KEY, lockToken);
    }
  }

  private async reverifyLocked(now: Date): Promise<ReverifyResult> {
    const token = gumroadAccessToken();
    const due = await this._repository.listDue(
      new Date(now.getTime() - REVERIFY_AFTER_MS),
      now,
      SWEEP_BATCH
    );
    if (!due.length) return { checked: 0, changed: 0, authFailures: 0 };
    if (!token && !this.warnedNoToken) {
      this.warnedNoToken = true;
      this.logger.warn(
        `${GUMROAD_ACCESS_TOKEN_ENV} is not set: redeeming is off, and bound Gumroad licenses are not re-checked for refunds or cancellations; only plans whose end date has passed are ended.`
      );
    }
    const facts = await this._repository.plansFor(due.map((l) => l.organizationId));
    const run = { changed: 0, authFailures: 0 };
    const deadline = Date.now() + this.runBudgetMs;
    let checked = 0;
    let stopped = false;
    for (const license of due) {
      if (Date.now() >= deadline) {
        // Inside the run lock's TTL with room to spare; what is left is still
        // due, so the next run takes it.
        stopped = true;
        this.logger.warn(
          `Gumroad license re-check stopped after ${checked} of ${due.length} (time budget); the rest go in the next run.`
        );
        break;
      }
      checked++;
      try {
        if (await this.reverifyOne(license, facts.get(license.organizationId), token, now, run)) {
          run.changed++;
        }
      } catch (e: any) {
        this.logger.error(
          `Gumroad license ${license.id} (org ${license.organizationId}) re-check failed: ${e?.message || e}`
        );
      }
    }
    if (run.authFailures) {
      // One line per run, not one per sale: a revoked or wrong token stops
      // every re-check, and nothing else would say so.
      this.logger.error(
        `Gumroad refused ${GUMROAD_ACCESS_TOKEN_ENV} (401/403) for ${run.authFailures} of ${checked} sales: refunds and cancellations are not being seen. Replace the token (Gumroad Settings > Advanced > Applications, view_sales).`
      );
    }
    return {
      checked,
      changed: run.changed,
      authFailures: run.authFailures,
      ...(stopped ? { stopped } : {}),
    };
  }

  /** True when the license or its workspace's plan changed. */
  private async reverifyOne(
    license: GumroadLicense,
    facts: PlanFacts | undefined,
    token: string,
    now: Date,
    run: { authFailures: number }
  ): Promise<boolean> {
    // The status as this run read it: the claim below is made from it.
    const readStatus = license.status;
    const identifier = gumroadIdentifier(license.saleId);
    const plan = facts && !facts.orgDeleted ? facts.plan : null;

    let standing: Standing | null;
    if (!plan || plan.deletedAt || plan.identifier !== identifier) {
      // Not this license's plan any more: nothing to ask Gumroad.
      standing = { status: 'ACTIVE' };
    } else {
      standing = token ? await this.readStanding(license, token, now, run) : null;
      // Gumroad could not be read (no token, a failed call, a sale without
      // a key): the end date Gumroad gave at an earlier check still ends the
      // plan once it has passed. Nothing else in Hookpost would: the
      // Razorpay sweeps read only sub_ rows.
      if (
        !standing &&
        plan.cancelAt &&
        new Date(plan.cancelAt).getTime() <= now.getTime()
      ) {
        standing = { status: 'CANCELLED' };
      }
    }
    // Gumroad could not say: leave it, it is due again next run.
    if (!standing) return false;

    if (standing.status === 'REPLACED') {
      // The workspace holds the sale's current key on another license, which
      // pays for the plan now: this one steps aside, the plan is untouched.
      const claimed = await this._repository.updateIfStatus(license.id, readStatus, {
        status: 'REPLACED',
        lastVerifiedAt: now,
      });
      if (claimed && readStatus !== 'REPLACED') {
        this.logger.log(
          `Gumroad license ${license.id} (org ${license.organizationId}, sale ${license.saleId}): ${readStatus} -> REPLACED; the sale's key was rotated and the new one is redeemed on this workspace, plan left alone.`
        );
        return true;
      }
      return false;
    }

    let step = sweepAction(standing, plan, identifier);
    if (step.action === 'end') {
      // Read again: a key redeemed since this run read its plans has put
      // another plan on the workspace, which is not this license's to end.
      const current = await this._subscriptionService.getSubscription(
        license.organizationId
      );
      if (current?.identifier !== identifier) step = { action: 'detach' };
    }
    const status: GumroadLicenseStatus = statusAfter(standing, step);

    // Claim the change from the status this run read, before touching the
    // plan: another run that got there first (it changed the status) wins,
    // and this one does nothing.
    const claimed = await this._repository.updateIfStatus(license.id, readStatus, {
      status,
      lastVerifiedAt: now,
    });
    if (!claimed) {
      this.logger.log(
        `Gumroad license ${license.id} changed while it was re-checked; left to that change.`
      );
      return false;
    }

    switch (step.action) {
      case 'lift':
        await this._subscriptionService.scheduleCancellation(
          license.organizationId,
          identifier,
          null
        );
        break;
      case 'schedule':
        await this._subscriptionService.scheduleCancellation(
          license.organizationId,
          identifier,
          step.endsAt
        );
        break;
      case 'end':
        // Only the plan this license pays for, and only if it is still the
        // workspace's: one written since (another key, a Razorpay plan) stays.
        if (
          !(await this._subscriptionService.endPlanByIdentifier(
            license.organizationId,
            identifier
          ))
        ) {
          this.logger.log(
            `Gumroad license ${license.id} (org ${license.organizationId}): ${status}, but the workspace's plan had already changed; left alone.`
          );
          return true;
        }
        break;
    }

    // The owner hears when a Gumroad membership is refunded, charged back,
    // cancelled, ends, fails to renew or is revoked, and when a cancelled one
    // renews again. Once per license and status.
    const ownerSees =
      status !== readStatus &&
      (OWNER_ALERT_LICENSE_STATUSES.includes(status) ||
        (status === 'ACTIVE' && readStatus === 'CANCELLING'));
    if (ownerSees) {
      this.alertOwner({
        event: 'GUMROAD_CHANGED',
        key: `gumroad:${license.id}:${status}`,
        source: 'gumroad',
        organizationId: license.organizationId,
        tier: license.tier,
        period: license.period,
        ids: { sale: license.saleId, license: license.id },
        test: !!standing.test,
        notes: [
          `Gumroad membership ${readStatus} -> ${status}`,
          step.action === 'end'
            ? 'The plan has ended'
            : step.action === 'schedule'
            ? `The plan ends ${step.endsAt.toISOString().slice(0, 10)}`
            : step.action === 'lift'
            ? 'The end date was lifted; the plan continues'
            : null,
        ],
      });
    }

    if (step.action === 'keep' && status === readStatus) return false;
    const what =
      step.action === 'end'
        ? 'plan ended'
        : step.action === 'schedule'
        ? `plan ends ${step.endsAt.toISOString()}`
        : step.action === 'lift'
        ? 'end date lifted'
        : step.action === 'detach'
        ? 'workspace is on another plan, left alone'
        : 'no plan change';
    this.logger.log(
      `Gumroad license ${license.id} (org ${license.organizationId}, sale ${license.saleId}): ${readStatus} -> ${status}; ${what}.`
    );
    return true;
  }

  /**
   * Where the license stands on Gumroad now: the sale gives back its key
   * (never stored here), which is verified again without counting a use.
   * Null when Gumroad could not be read. When the sale's key is no longer
   * the one this license holds (the seller rotated it): REPLACED if the new
   * key is bound to another license of the same workspace, else REVOKED
   * (nobody redeemed it, or another workspace did). A token Gumroad refuses
   * is counted for the run's one error line.
   */
  private async readStanding(
    license: GumroadLicense,
    token: string,
    now: Date,
    run: { authFailures: number }
  ): Promise<Standing | null> {
    let sale: GumroadAnswer;
    try {
      sale = await this.client.getSale(license.saleId, token);
    } catch (e: any) {
      this.logger.warn(`Gumroad sale read failed for license ${license.id}: ${e?.message || e}`);
      return null;
    }
    if (sale.status === 401 || sale.status === 403) {
      run.authFailures++;
      return null;
    }
    if (sale.status !== 200 || sale.body?.success !== true) {
      // A missing sale is never a reason to end a plan.
      this.logger.warn(
        `Gumroad answered ${sale.status} for the sale of license ${license.id}; not re-checked.`
      );
      return null;
    }
    const key = normalizeLicenseKey(sale.body?.sale?.license_key);
    if (!key) {
      this.logger.warn(`The Gumroad sale of license ${license.id} has no license key; not re-checked.`);
      return null;
    }
    const currentHash = hashLicenseKey(key);
    if (currentHash !== license.licenseKeyHash) {
      const holder = await this._repository.findByHash(currentHash);
      return holder &&
        holder.id !== license.id &&
        holder.organizationId === license.organizationId
        ? { status: 'REPLACED' }
        : { status: 'REVOKED' };
    }
    const result = await this.verify(license.productId, key);
    if (result.kind === 'unavailable') {
      this.logger.warn(`Gumroad license verify failed for ${license.id}: ${result.message}`);
    }
    const standing = verifyStanding(result, now);
    // The license row does not keep it, so the owner's alert learns from
    // the sale whether this was a seller's test purchase.
    if (standing && result.kind === 'valid' && result.purchase.test) {
      return { ...standing, test: true };
    }
    return standing;
  }
}
