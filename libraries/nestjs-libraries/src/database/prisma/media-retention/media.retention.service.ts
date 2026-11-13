import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MediaRetentionRepository } from '@hookpost/nestjs-libraries/database/prisma/media-retention/media.retention.repository';
import { AccountPurgeRepository } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.repository';
import { PurgeFileStore } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.service';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { TemporalService } from 'nestjs-temporal-core';
import { terminatePostWorkflows } from '@hookpost/nestjs-libraries/temporal/post.workflows';
import { EmailService } from '@hookpost/nestjs-libraries/services/email.service';
import {
  MEDIA_RETENTION_AFTER_END_DAYS,
  MEDIA_RETENTION_REMINDER_DAYS,
  internalWorkspace,
  mediaReminderFrom,
  mediaRemoveAt,
  onMediaRetentionClock,
  planState,
  trialCutoffs,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  mediaRetentionNoticeEmail,
  mediaRetentionReminderEmail,
} from '@hookpost/nestjs-libraries/emails/templates/media.retention.emails';
import { RenderedEmail } from '@hookpost/nestjs-libraries/emails/layout/email.layout';
import { AlignedTimer, everyAligned } from '@hookpost/helpers/utils/timer';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';

/**
 * MEDIA RETENTION AFTER A PLAN ENDS (trial.policy.ts has the rule and its
 * numbers). Once a day, for every workspace with no plan:
 *
 *  1. Day 0: the notice. Usually a line in the email that already says the
 *     plan ended (RazorpayService claims it through claimNoticeAtPlanEnd);
 *     otherwise this run sends mediaRetentionNoticeEmail, but only to a
 *     workspace that has media to lose. Workspaces that had already churned
 *     when this shipped start here on the first run.
 *  2. MEDIA_RETENTION_REMINDER_DAYS before the removal: one reminder. Sent
 *     late (the run was down), it moves the removal so the reminder always
 *     comes that many days ahead.
 *  3. At removeAt: the files go from storage, then the posts that pointed at
 *     them are marked (queued, reminder and failed posts become ERROR with
 *     MEDIA_REMOVED_AFTER_PLAN_MESSAGE, and their workflows are stopped; a
 *     draft stays a draft) and the library rows are hidden. Post text,
 *     channels and settings stay.
 *
 * What is removed: the workspace's media library uploads and the files of
 * its unpublished, undeleted posts. Never a file another workspace's media,
 * post, channel, signature or saved set uses, one its own published posts,
 * signatures or saved sets show, a channel picture, an account picture, an
 * agency logo or a developer app picture, nor anything outside our storage
 * (PurgeFileStore.ownsFile: on R2 only flat Hookpost keys, never another
 * product's prefixed keys in the shared bucket).
 *
 * Safety:
 *  - Dry run unless MEDIA_RETENTION_ENABLED is exactly "true": the run reads
 *    and logs what it would do, and writes nothing (no row, no email, no
 *    file), and the plan-ended emails carry no line.
 *  - The workspace's plan state is read again right before the files go; a
 *    plan bought since (or any other reason it left the clock) clears the
 *    row and nothing is removed. Buying a plan clears it at once too
 *    (SubscriptionService).
 *  - If any file fails, the row stays open and the next run tries again.
 *  - Every email is claimed with one conditional write, and one process
 *    runs at a time (Redis lock), so the backend and the orchestrator never
 *    double anything.
 */

export const MEDIA_RETENTION_ENABLED_ENV = 'MEDIA_RETENTION_ENABLED';

export const mediaRetentionEnabled = (env = process.env) =>
  env[MEDIA_RETENTION_ENABLED_ENV] === 'true';

/** What a post whose file was removed says (MediaRetentionRepository). */
export const MEDIA_REMOVED_AFTER_PLAN_MESSAGE = `This post's media was removed ${MEDIA_RETENTION_AFTER_END_DAYS} days after the workspace's plan ended. Upload it again before retrying.`;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 04:00 UTC (09:30 in India), on the shared hourly database slot. */
const RUN_OFFSET_MS = 4 * 60 * 60 * 1000;
const RUN_LOCK_KEY = 'media-retention:run';
const RUN_LOCK_SECONDS = 50 * 60;
/** Files removed between two reads of the workspace's plan state. */
const REMOVE_BATCH = 25;

export type RetentionStep =
  | 'cleared'
  | 'started'
  | 'waiting'
  | 'notified'
  | 'reminded'
  | 'purged'
  | 'failed'
  | 'would-notify'
  | 'would-remind'
  | 'would-purge';

export interface RetentionWorkspaceReport {
  id: string;
  step: RetentionStep;
  files: number;
  sharedKept: number;
  removed?: number;
  posts?: number;
  error?: string;
}

export interface RetentionReport {
  mode: 'dry-run' | 'live';
  workspaces: RetentionWorkspaceReport[];
  counts: Partial<Record<RetentionStep, number>>;
  filesRemoved: number;
}

export interface RetentionRunOptions {
  enabled: boolean;
  stores: PurgeFileStore[];
  now?: Date;
  /** Drops removed files from the CDN cache; optional, never fatal. */
  purgeCache?: (urls: string[]) => Promise<void>;
  log?: (line: string) => void;
}

/** A day-0 notice claimed for a plan-ended email; give it back if unsent. */
export interface RetentionNoticeClaim {
  organizationId: string;
  at: Date;
  removeAt: Date;
}

// Prisma's messages can quote the query: keep the code and the first line.
const shortError = (err: any) =>
  `${err?.code ? `${err.code} ` : ''}${String(err?.message || err)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 300)}`;

@Injectable()
export class MediaRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaRetentionService.name);
  private timer?: AlignedTimer;

  constructor(
    private _repository: MediaRetentionRepository,
    private _purgeRepository: AccountPurgeRepository,
    private _subscriptionService: SubscriptionService,
    private _organizationService: OrganizationService,
    private _temporalService: TemporalService,
    private _emailService: EmailService
  ) {}

  /**
   * Daily at 04:00 UTC and once a few minutes after boot (so a deploy shows
   * the first run at once), only where RUN_CRON is on.
   */
  onModuleInit() {
    if (process.env.RUN_CRON !== 'true' || process.env.NODE_ENV === 'test') {
      return;
    }
    const run = () => this.runLocked();
    setTimeout(run, 5 * 60 * 1000).unref();
    this.timer = everyAligned(DAY_MS, run, RUN_OFFSET_MS);
  }

  onModuleDestroy() {
    this.timer?.stop();
  }

  private async runLocked() {
    try {
      const claimed =
        (await (ioRedis as any).set(
          RUN_LOCK_KEY,
          new Date().toISOString(),
          'EX',
          RUN_LOCK_SECONDS,
          'NX'
        )) === 'OK';
      if (!claimed) return;
      // Loaded here, not at the top: the storage clients (ESM file-type, the
      // S3 SDK) are only needed by the scheduled run, and every spec that
      // builds RazorpayService would otherwise load them. A relative path:
      // the build rewrites the @hookpost aliases of static imports only, so
      // an aliased import() is MODULE_NOT_FOUND in production (1 Nov 2026).
      const { purgeStores, cloudflareCachePurger } = await import(
        '../../../upload/purge.stores'
      );
      await this.run({
        enabled: mediaRetentionEnabled(),
        stores: purgeStores(),
        purgeCache: cloudflareCachePurger(),
        log: (line) => this.logger.log(line),
      });
    } catch (e) {
      this.logger.error(`Media retention run failed: ${shortError(e)}`);
    }
  }

  /**
   * Whether this workspace is on the clock now (onMediaRetentionClock): a
   * live sign-up workspace (not deleted, not a marketplace one) in a plan
   * state with nothing to post on. Never without billing.
   */
  async onClock(organizationId: string, now: Date = new Date()) {
    if (!process.env.RAZORPAY_KEY_ID) return false;
    const workspace = await this._repository.getWorkspace(organizationId);
    if (!workspace || workspace.deletedAt || workspace.source !== 'DIRECT') {
      return false;
    }
    const org = await this._subscriptionService.getPolicyOrg(organizationId);
    if (!org) return false;
    const cutoffs = { ...trialCutoffs(), now };
    const state = planState(org, cutoffs);
    const freePostsSpent =
      state === 'free_posts'
        ? (await this._subscriptionService.freePostsUsage(organizationId))
            ?.left === 0 &&
          !(await this._repository.hasScheduledPosts(organizationId, now))
        : false;
    return onMediaRetentionClock(state, {
      internal: internalWorkspace(org, cutoffs),
      freePostsSpent,
    });
  }

  /**
   * The plan of this workspace has just ended and an email is about to say
   * so: if the workspace is on the clock, start it now and let that email be
   * the day-0 notice. Null when it is not (a Free plan, our own workspace,
   * dry run) or when this stretch without a plan was already told (a later
   * email about the same end, a refund after the plan-ended email); the
   * email then goes without the line. Never throws.
   */
  async claimNoticeAtPlanEnd(
    organizationId: string,
    now: Date = new Date()
  ): Promise<RetentionNoticeClaim | null> {
    if (!mediaRetentionEnabled()) return null;
    try {
      if (!(await this.onClock(organizationId, now))) return null;
      const removeAt = mediaRemoveAt(now);
      await this._repository.startClock(organizationId, now);
      return (await this._repository.claimNotice(organizationId, now, removeAt))
        ? { organizationId, at: now, removeAt }
        : null;
    } catch (e) {
      this.logger.error(
        `Media retention notice for org ${organizationId} not claimed: ${shortError(e)}`
      );
      return null;
    }
  }

  /** The email that carried the notice did not go out: the run sends it. */
  async releaseNotice(claim: RetentionNoticeClaim) {
    await this._repository
      .releaseNotice(claim.organizationId, claim.at)
      .catch((e) =>
        this.logger.error(
          `Media retention notice for org ${claim.organizationId} not released: ${shortError(e)}`
        )
      );
  }

  /** A plan again: the clock stops and nothing is removed. Never throws. */
  async clear(organizationId: string) {
    await this._repository.clear(organizationId).catch((e) =>
      this.logger.error(
        `Media retention for org ${organizationId} not cleared: ${shortError(e)}`
      )
    );
  }

  async run(options: RetentionRunOptions): Promise<RetentionReport> {
    const now = options.now || new Date();
    const enabled = options.enabled === true;
    const log = options.log || (() => undefined);
    const report: RetentionReport = {
      mode: enabled ? 'live' : 'dry-run',
      workspaces: [],
      counts: {},
      filesRemoved: 0,
    };

    // Without billing every workspace reads as having a plan (onClock): a
    // process missing the key must not clear every clock on file.
    if (!process.env.RAZORPAY_KEY_ID) {
      log('Media retention: RAZORPAY_KEY_ID is not set here, nothing to do.');
      return report;
    }

    const rows = new Map(
      (await this._repository.rows()).map((r) => [r.organizationId, r])
    );
    const ids = new Set([
      ...rows.keys(),
      ...(await this._repository.workspacesWithoutPlan(now)),
    ]);

    for (const id of ids) {
      let result: RetentionWorkspaceReport | null;
      try {
        result = await this.step(id, rows.get(id) || null, now, enabled, options);
      } catch (e) {
        result = { id, step: 'failed', files: 0, sharedKept: 0, error: shortError(e) };
      }
      if (!result) continue;
      report.workspaces.push(result);
      report.counts[result.step] = (report.counts[result.step] || 0) + 1;
      report.filesRemoved += result.removed || 0;
      if (result.step !== 'waiting') log(describe(result));
    }

    const counts = Object.entries(report.counts)
      .map(([step, n]) => `${step} ${n}`)
      .join(', ');
    log(
      `Media retention ${enabled ? 'LIVE' : 'DRY RUN (nothing is written, sent or removed)'}: ${
        report.workspaces.length
      } workspace(s) on the clock${counts ? ` (${counts})` : ''}, ${report.filesRemoved} file(s) removed.${
        enabled ? '' : ` Set ${MEDIA_RETENTION_ENABLED_ENV}=true to run it.`
      }`
    );
    return report;
  }

  private async step(
    id: string,
    row: Awaited<ReturnType<MediaRetentionRepository['getRow']>>,
    now: Date,
    enabled: boolean,
    options: RetentionRunOptions
  ): Promise<RetentionWorkspaceReport | null> {
    if (!(await this.onClock(id, now))) {
      if (!row) return null;
      if (enabled) await this._repository.clear(id);
      return { id, step: 'cleared', files: 0, sharedKept: 0 };
    }
    // Removed already: done until the workspace leaves the clock (a plan
    // again, which clears the row) and a later plan end starts a new one.
    if (row?.purgedAt) return null;
    // Told, and neither the reminder nor the removal is due: nothing to read.
    if (
      row?.noticeSentAt &&
      row.removeAt &&
      now < row.removeAt &&
      (row.reminderSentAt || now < mediaReminderFrom(row.removeAt))
    ) {
      return { id, step: 'waiting', files: 0, sharedKept: 0 };
    }

    const files = await this.filesToRemove(id, options.stores);
    const base = { id, files: files.toRemove.length, sharedKept: files.shared };

    if (!row) {
      if (!enabled) {
        return { ...base, step: files.toRemove.length ? 'would-notify' : 'waiting' };
      }
      row = await this._repository.startClock(id, now);
    }

    // 1. The day-0 notice, only when there is something to lose.
    if (!row.noticeSentAt || !row.removeAt) {
      if (!files.toRemove.length) return { ...base, step: 'waiting' };
      if (!enabled) return { ...base, step: 'would-notify' };
      const removeAt = mediaRemoveAt(now);
      if (!(await this._repository.claimNotice(id, now, removeAt))) {
        return { ...base, step: 'waiting' };
      }
      const sent = await this.sendToWorkspace(id, (orgName) =>
        mediaRetentionNoticeEmail({ orgName, removeAt, files: files.toRemove.length })
      );
      if (!sent) {
        await this._repository.releaseNotice(id, now);
        return { ...base, step: 'failed', error: 'notice not sent; next run tries again' };
      }
      return { ...base, step: 'notified' };
    }

    // 2. The reminder, a full MEDIA_RETENTION_REMINDER_DAYS ahead.
    const removeAt = row.removeAt;
    if (!row.reminderSentAt && now >= mediaReminderFrom(removeAt) && files.toRemove.length) {
      if (!enabled) return { ...base, step: 'would-remind' };
      const later = mediaRemoveAt(now, MEDIA_RETENTION_REMINDER_DAYS);
      const newRemoveAt = later > removeAt ? later : removeAt;
      if (!(await this._repository.claimReminder(id, now, newRemoveAt))) {
        return { ...base, step: 'waiting' };
      }
      const sent = await this.sendToWorkspace(id, (orgName) =>
        mediaRetentionReminderEmail({
          orgName,
          removeAt: newRemoveAt,
          files: files.toRemove.length,
        })
      );
      if (!sent) {
        await this._repository.releaseReminder(id, now, removeAt);
        return { ...base, step: 'failed', error: 'reminder not sent; next run tries again' };
      }
      return { ...base, step: 'reminded' };
    }

    if (now < removeAt) return { ...base, step: 'waiting' };

    // 3. The removal.
    if (!enabled) return { ...base, step: 'would-purge' };
    if (!files.toRemove.length) {
      await this._repository.markPurged(id, now);
      return { ...base, step: 'purged', removed: 0, posts: 0 };
    }
    // Read again right before anything goes: a plan bought a second ago wins.
    if (!(await this.onClock(id, now))) {
      await this._repository.clear(id);
      return { ...base, step: 'cleared' };
    }
    const removed: string[] = [];
    let failed = 0;
    let bought = false;
    for (let i = 0; i < files.toRemove.length; i++) {
      // And again every REMOVE_BATCH files, so a plan bought mid-way keeps
      // the rest. A read that fails stops here like a failed file: what is
      // already gone is still recorded below, the next run does the rest.
      if (i && i % REMOVE_BATCH === 0) {
        const still = await this.onClock(id, now).catch(() => null);
        if (still === null) {
          failed += files.toRemove.length - i;
          break;
        }
        if (!still) {
          bought = true;
          break;
        }
      }
      const url = files.toRemove[i];
      const store = options.stores.find((s) => s.ownsFile(url))!;
      try {
        await store.removeFile(url);
        removed.push(url);
      } catch {
        failed++;
      }
    }
    if (removed.length && options.purgeCache) {
      await options.purgeCache(removed).catch(() => undefined);
    }
    const postIds = await this._repository.markPostsWithRemovedMedia(
      id,
      removed,
      MEDIA_REMOVED_AFTER_PLAN_MESSAGE
    );
    for (const postId of postIds) {
      await terminatePostWorkflows(this._temporalService, postId);
    }
    await this._repository.hideMedia(id, removed, now);
    if (bought) {
      await this._repository.clear(id);
      return { ...base, step: 'cleared', removed: removed.length, posts: postIds.length };
    }
    if (failed) {
      return {
        ...base,
        step: 'failed',
        removed: removed.length,
        posts: postIds.length,
        error: `${failed} file(s) could not be removed; the next run tries again`,
      };
    }
    await this._repository.markPurged(id, now);
    return { ...base, step: 'purged', removed: removed.length, posts: postIds.length };
  }

  /**
   * The files the removal takes: the library rows and unpublished posts'
   * files (purgeCandidates), less what must stay (see the top of this
   * file), only those in our storage, and none another workspace uses.
   */
  private async filesToRemove(id: string, stores: PurgeFileStore[]) {
    const { media, pendingUrls, keep, texts } =
      await this._repository.purgeCandidates(id);
    const kept = await this._purgeRepository.keptMediaIds(
      id,
      media.map((m) => m.id),
      { ownApps: true }
    );
    const urls = new Set<string>(pendingUrls);
    for (const m of media) {
      if (kept.has(m.id)) {
        keep.add(m.path);
        if (m.thumbnail) keep.add(m.thumbnail);
        continue;
      }
      urls.add(m.path);
      if (m.thumbnail) urls.add(m.thumbnail);
    }
    const ours = [...urls].filter(
      (url) =>
        !keep.has(url) &&
        !texts.some((text) => text.includes(url)) &&
        stores.some((s) => s.ownsFile(url))
    );
    const elsewhere = new Set(
      await this._purgeRepository.findUrlsUsedElsewhere(id, ours)
    );
    return {
      toRemove: ours.filter((url) => !elsewhere.has(url)),
      shared: elsewhere.size,
    };
  }

  /** To the workspace's billing contact (its first member), as billing emails go. */
  private async sendToWorkspace(
    organizationId: string,
    render: (orgName: string) => RenderedEmail
  ): Promise<boolean> {
    try {
      const [workspace, team] = await Promise.all([
        this._repository.getWorkspace(organizationId),
        this._organizationService.getTeam(organizationId),
      ]);
      const to = team?.users?.[0]?.user?.email;
      if (!to) return false;
      const email = render(workspace?.name || 'your workspace');
      return await this._emailService.sendEmailSync(
        to,
        email.subject,
        email.html,
        'support@hookstep.in'
      );
    } catch (e) {
      this.logger.error(
        `Media retention email for org ${organizationId} failed: ${shortError(e)}`
      );
      return false;
    }
  }
}

const describe = (r: RetentionWorkspaceReport) =>
  `  workspace ${r.id}: ${r.step}, ${r.files} file(s)${
    r.sharedKept ? `, ${r.sharedKept} used elsewhere (kept)` : ''
  }${r.removed !== undefined ? `, ${r.removed} removed` : ''}${
    r.posts ? `, ${r.posts} post(s) marked` : ''
  }${r.error ? ` ERROR: ${r.error}` : ''}`;
