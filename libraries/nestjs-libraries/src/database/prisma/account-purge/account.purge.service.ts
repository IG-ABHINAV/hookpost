import { Injectable } from '@nestjs/common';
import { AccountPurgeRepository } from '@hookpost/nestjs-libraries/database/prisma/account-purge/account.purge.repository';
import { IUploadProvider } from '@hookpost/nestjs-libraries/upload/upload.interface';

/**
 * The account purge: erases what deleted accounts leave behind.
 *
 * Deleting an account (UsersService.deleteAccount) removes access at once and
 * hides everything, but only marks rows deleted. The privacy policy promises
 * that the rest is purged or anonymised within 30 days, and this is what does
 * it: for workspaces and accounts deleted more than 30 days ago it deletes
 * posts, comments, media rows and the stored files behind them, signatures,
 * sets, webhooks, auto-posts, stored API keys, notifications, AI assistant
 * threads, and clears every channel's tokens and profile. What it keeps is
 * listed on AccountPurgeRepository.purgeOrganization and purgeUser.
 *
 * Safety, in the order it applies:
 *  - Dry run unless ACCOUNT_PURGE_ENABLED is exactly "true": a dry run reads,
 *    counts and reports, and writes nothing, files included.
 *  - Never fewer than 30 days: minDays below 30 is raised to 30.
 *  - Only workspaces deleted before the cutoff whose every member is an
 *    account deleted before the cutoff; anything with a live member, or
 *    deleted more recently, is left alone (and counted in the report). Each
 *    target is re-read right before it is written.
 *  - At most `batch` workspaces and `batch` accounts per run (default 10).
 *  - Files go first, only files the storage provider says are its own, never
 *    a file another workspace still points at. If any file fails, that
 *    workspace's rows are left for the next run, so no file is ever orphaned.
 *  - Each workspace and each account is one database transaction.
 *  - Idempotent: a target that has nothing left to erase is not selected.
 *
 * Run by scripts/purge-deleted-accounts.sh (cron); see that file.
 */

export type PurgeFileStore = Pick<IUploadProvider, 'ownsFile' | 'removeFile'>;

export interface PurgeOptions {
  enabled: boolean;
  now?: Date;
  batch?: number;
  minDays?: number;
  stores: PurgeFileStore[];
  /** Drops deleted files from the CDN cache; optional, never fatal. */
  purgeCache?: (urls: string[]) => Promise<void>;
  log?: (line: string) => void;
}

export interface PurgeTargetReport {
  id: string;
  deletedAt: Date | null;
  status: 'would-purge' | 'purged' | 'skipped' | 'failed';
  rows?: Record<string, number | string>;
  files?: {
    toDelete: number;
    deleted: number;
    usedElsewhere: number;
    notOurs: number;
    keptMedia: number;
  };
  error?: string;
}

export interface PurgeReport {
  mode: 'dry-run' | 'purge';
  cutoff: Date;
  batch: number;
  organizations: PurgeTargetReport[];
  users: PurgeTargetReport[];
  /** Deleted before the cutoff but held back by a live or recently deleted member. */
  organizationsHeldByMembers: number;
  failed: number;
}

export const MIN_PURGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Prisma's messages can quote the query, data included: keep the code and the
// first line only, so the cron log never holds row contents.
const shortError = (err: any) => {
  const line = String(err?.message || err)
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return `${err?.code ? `${err.code} ` : ''}${(line || 'error').slice(0, 300)}`;
};

@Injectable()
export class AccountPurgeService {
  constructor(private _accountPurgeRepository: AccountPurgeRepository) {}

  async run(options: PurgeOptions): Promise<PurgeReport> {
    const log = options.log || (() => undefined);
    const now = options.now || new Date();
    const minDays = Math.max(MIN_PURGE_DAYS, Math.floor(options.minDays || 0));
    const batch = Math.min(100, Math.max(1, Math.floor(options.batch || 10)));
    const cutoff = new Date(now.getTime() - minDays * DAY_MS);
    const enabled = options.enabled === true;

    const report: PurgeReport = {
      mode: enabled ? 'purge' : 'dry-run',
      cutoff,
      batch,
      organizations: [],
      users: [],
      organizationsHeldByMembers:
        await this._accountPurgeRepository.countOrganizationsHeldByMembers(
          cutoff
        ),
      failed: 0,
    };

    log(
      `${enabled ? 'PURGE' : 'DRY RUN (nothing is written)'}: deleted before ${cutoff.toISOString()} (${minDays} days), at most ${batch} workspaces and ${batch} accounts`
    );

    const organizations =
      await this._accountPurgeRepository.findOrganizationsToPurge(cutoff, batch);
    for (const org of organizations) {
      const result = await this.purgeOrganization(
        org.id,
        org.deletedAt,
        cutoff,
        enabled,
        options
      );
      report.organizations.push(result);
      log(describeTarget('workspace', result));
    }

    const users = await this._accountPurgeRepository.findUsersToPurge(
      cutoff,
      batch
    );
    for (const user of users) {
      const result = await this.purgeUser(user.id, user.deletedAt, cutoff, enabled);
      report.users.push(result);
      log(describeTarget('account', result));
    }

    report.failed =
      report.organizations.filter((o) => o.status === 'failed').length +
      report.users.filter((u) => u.status === 'failed').length;

    log(
      `${report.organizations.length} workspace(s), ${report.users.length} account(s)${
        report.organizationsHeldByMembers
          ? `; ${report.organizationsHeldByMembers} deleted workspace(s) left alone because a member is live or was deleted less than ${minDays} days ago`
          : ''
      }${report.failed ? `; ${report.failed} FAILED` : ''}.${
        enabled ? '' : ' Dry run: nothing was written. Set ACCOUNT_PURGE_ENABLED=true to purge.'
      }`
    );
    return report;
  }

  private async purgeOrganization(
    orgId: string,
    deletedAt: Date | null,
    cutoff: Date,
    enabled: boolean,
    options: PurgeOptions
  ): Promise<PurgeTargetReport> {
    const result: PurgeTargetReport = { id: orgId, deletedAt, status: 'skipped' };
    try {
      if (
        !(await this._accountPurgeRepository.isOrganizationPurgeable(
          orgId,
          cutoff
        ))
      ) {
        return result;
      }

      result.rows = await this._accountPurgeRepository.countOrganizationRows(
        orgId
      );
      const files = await this._accountPurgeRepository.collectOrganizationFiles(
        orgId
      );
      const ours = files.urls.filter((url) =>
        options.stores.some((store) => store.ownsFile(url))
      );
      const usedElsewhere = new Set(
        await this._accountPurgeRepository.findUrlsUsedElsewhere(orgId, ours)
      );
      const toDelete = ours.filter((url) => !usedElsewhere.has(url));
      result.files = {
        toDelete: toDelete.length,
        deleted: 0,
        usedElsewhere: usedElsewhere.size,
        notOurs: files.urls.length - ours.length,
        keptMedia: files.keepMediaIds.length,
      };

      if (!enabled) {
        result.status = 'would-purge';
        return result;
      }

      // Files first: if one cannot be deleted, the rows that point at it stay
      // for the next run instead of leaving an orphan nobody can find.
      const deleted: string[] = [];
      const failed: string[] = [];
      for (const url of toDelete) {
        const store = options.stores.find((s) => s.ownsFile(url))!;
        try {
          await store.removeFile(url);
          deleted.push(url);
        } catch (err) {
          failed.push(url);
        }
      }
      result.files.deleted = deleted.length;
      if (deleted.length && options.purgeCache) {
        await options.purgeCache(deleted).catch(() => undefined);
      }
      if (failed.length) {
        result.status = 'failed';
        result.error = `${failed.length} file(s) could not be deleted; the workspace's rows are kept for the next run`;
        return result;
      }

      // Re-check right before the write.
      if (
        !(await this._accountPurgeRepository.isOrganizationPurgeable(
          orgId,
          cutoff
        ))
      ) {
        result.status = 'skipped';
        return result;
      }
      await this._accountPurgeRepository.purgeOrganization(
        orgId,
        files.keepMediaIds
      );
      await this._accountPurgeRepository.forgetSignupAttribution(orgId);
      result.status = 'purged';
      return result;
    } catch (err) {
      result.status = 'failed';
      result.error = shortError(err);
      return result;
    }
  }

  private async purgeUser(
    userId: string,
    deletedAt: Date | null,
    cutoff: Date,
    enabled: boolean
  ): Promise<PurgeTargetReport> {
    const result: PurgeTargetReport = { id: userId, deletedAt, status: 'skipped' };
    try {
      if (!(await this._accountPurgeRepository.isUserPurgeable(userId, cutoff))) {
        return result;
      }
      result.rows = await this._accountPurgeRepository.countUserRows(userId);
      if (!enabled) {
        result.status = 'would-purge';
        return result;
      }
      await this._accountPurgeRepository.purgeUser(userId);
      result.status = 'purged';
      return result;
    } catch (err) {
      result.status = 'failed';
      result.error = shortError(err);
      return result;
    }
  }
}

const describeTarget = (kind: string, r: PurgeTargetReport) => {
  const rows = Object.entries(r.rows || {})
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const files = r.files
    ? `; files: ${r.files.toDelete} to delete${
        r.status === 'purged' || r.status === 'failed' ? ` (${r.files.deleted} deleted)` : ''
      }, ${r.files.usedElsewhere} used elsewhere (kept), ${r.files.notOurs} not in our storage, ${r.files.keptMedia} media row(s) kept`
    : '';
  return `  ${kind} ${r.id} deleted ${
    r.deletedAt ? r.deletedAt.toISOString() : '?'
  }: ${r.status}${rows ? ` [${rows}]` : ''}${files}${r.error ? ` ERROR: ${r.error}` : ''}`;
};
