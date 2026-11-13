import { Injectable } from '@nestjs/common';
import { State } from '@prisma/client';
import { PrismaRepository } from '@hookpost/nestjs-libraries/database/prisma/prisma.service';

/** Posts whose media the retention purge removes: not published yet. */
export const RETAINED_POST_STATES: State[] = [
  State.QUEUE,
  State.DRAFT,
  State.ERROR,
  State.REMINDER_SENT,
];

/** Posts that stay in the workspace's history with their media. */
const PUBLISHED_STATES: State[] = [State.PUBLISHED, State.POSTED_MANUALLY];

/** Every URL a post's `image` JSON points at (path, thumbnail, url). */
export function postImageUrls(image: string | null | undefined): string[] {
  try {
    const items = JSON.parse(image || '[]');
    return (Array.isArray(items) ? items : []).flatMap((item: any) =>
      [item?.path, item?.thumbnail, item?.url].filter(
        (url): url is string => typeof url === 'string' && !!url
      )
    );
  } catch {
    return [];
  }
}

/**
 * Prisma side of the media retention clock (MediaRetentionService). Every
 * claim is one conditional write, so the backend and the orchestrator (both
 * run with RUN_CRON) and a plan-ended email racing the daily run never send
 * the same email twice.
 */
@Injectable()
export class MediaRetentionRepository {
  constructor(
    private _db: PrismaRepository<
      | 'mediaRetention'
      | 'organization'
      | 'post'
      | 'media'
      | 'integration'
      | 'signatures'
      | 'sets'
    >
  ) {}

  /** Every workspace on the clock, removed ones included. */
  rows() {
    return this._db.model.mediaRetention.findMany();
  }

  getRow(organizationId: string) {
    return this._db.model.mediaRetention.findUnique({
      where: { organizationId },
    });
  }

  /**
   * Live sign-ups (not marketplace) with no live plan row: the workspaces
   * that may be on the clock. A row whose cancelAt has passed counts too;
   * planState decides.
   */
  async workspacesWithoutPlan(now: Date): Promise<string[]> {
    const rows = await this._db.model.organization.findMany({
      where: {
        deletedAt: null,
        source: 'DIRECT',
        OR: [
          { subscription: { is: null } },
          { subscription: { is: { deletedAt: { not: null } } } },
          {
            subscription: {
              is: {
                isLifetime: false,
                cancelAt: { lte: now },
                identifier: { startsWith: 'sub_' },
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** The workspace as the run needs it: deleted or not, and its source. */
  getWorkspace(organizationId: string) {
    return this._db.model.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, deletedAt: true, source: true },
    });
  }

  /**
   * A workspace first seen without a plan: its clock starts now. A row
   * already on file is kept as it is: every plan write deletes the row
   * (SubscriptionRepository), so a row on file is this same stretch without
   * a plan, already counting.
   */
  async startClock(organizationId: string, at: Date) {
    return this._db.model.mediaRetention.upsert({
      where: { organizationId },
      create: { organizationId, planEndedAt: at },
      update: {},
    });
  }

  /** The day-0 notice, once: true for the one caller that claimed it. */
  async claimNotice(organizationId: string, at: Date, removeAt: Date) {
    const { count } = await this._db.model.mediaRetention.updateMany({
      where: { organizationId, noticeSentAt: null, purgedAt: null },
      data: { noticeSentAt: at, removeAt },
    });
    return count > 0;
  }

  /** Give a notice claim back (the email did not go out). */
  releaseNotice(organizationId: string, at: Date) {
    return this._db.model.mediaRetention.updateMany({
      where: { organizationId, noticeSentAt: at },
      data: { noticeSentAt: null, removeAt: null },
    });
  }

  /** The reminder, once, with the removal date it states. */
  async claimReminder(organizationId: string, at: Date, removeAt: Date) {
    const { count } = await this._db.model.mediaRetention.updateMany({
      where: {
        organizationId,
        reminderSentAt: null,
        noticeSentAt: { not: null },
        purgedAt: null,
      },
      data: { reminderSentAt: at, removeAt },
    });
    return count > 0;
  }

  /** Give a reminder claim back, with the removal date it had. */
  releaseReminder(organizationId: string, at: Date, removeAt: Date | null) {
    return this._db.model.mediaRetention.updateMany({
      where: { organizationId, reminderSentAt: at },
      data: { reminderSentAt: null, removeAt },
    });
  }

  markPurged(organizationId: string, at: Date) {
    return this._db.model.mediaRetention.updateMany({
      where: { organizationId, purgedAt: null },
      data: { purgedAt: at },
    });
  }

  /** A plan again (or no longer on the clock): nothing is removed. */
  clear(organizationId: string) {
    return this._db.model.mediaRetention.deleteMany({
      where: { organizationId },
    });
  }

  /**
   * The files the purge may remove, before the storage and used-elsewhere
   * checks: the workspace's media library rows (hidden ones too) and every
   * file its unpublished, undeleted posts point at. Never a file one of its
   * published posts shows (history keeps its pictures), nor its channels'
   * pictures. `texts` are its signatures and saved sets (settings, which
   * stay): a file they mention stays too.
   */
  async purgeCandidates(organizationId: string) {
    const [media, pending, published, integrations, signatures, sets] = await Promise.all([
      this._db.model.media.findMany({
        where: { organizationId },
        select: { id: true, path: true, thumbnail: true },
      }),
      this._db.model.post.findMany({
        where: {
          organizationId,
          deletedAt: null,
          state: { in: RETAINED_POST_STATES },
          image: { not: null },
        },
        select: { image: true },
      }),
      this._db.model.post.findMany({
        where: {
          organizationId,
          state: { in: PUBLISHED_STATES },
          image: { not: null },
        },
        select: { image: true },
      }),
      this._db.model.integration.findMany({
        where: { organizationId, picture: { not: null } },
        select: { picture: true },
      }),
      this._db.model.signatures.findMany({
        where: { organizationId, deletedAt: null },
        select: { content: true },
      }),
      this._db.model.sets.findMany({
        where: { organizationId },
        select: { content: true },
      }),
    ]);
    const keep = new Set<string>([
      ...published.flatMap((p) => postImageUrls(p.image)),
      ...integrations.map((i) => i.picture!),
    ]);
    return {
      media,
      pendingUrls: pending.flatMap((p) => postImageUrls(p.image)),
      keep,
      texts: [...signatures, ...sets].map((r) => r.content || ''),
    };
  }

  /** Any of the workspace's posts still due to publish later than `now`. */
  async hasScheduledPosts(organizationId: string, now: Date) {
    const count = await this._db.model.post.count({
      where: {
        organizationId,
        deletedAt: null,
        state: State.QUEUE,
        publishDate: { gt: now },
      },
    });
    return count > 0;
  }

  /**
   * The unpublished posts that pointed at a removed file. Queued, reminder
   * and failed ones become ERROR with `message`, so nothing tries to publish
   * a file that is gone; a draft stays a draft (the composer marks the
   * missing file). The `image` JSON is left as it was, so the composer can
   * show what was there.
   */
  async markPostsWithRemovedMedia(
    organizationId: string,
    removed: string[],
    message: string
  ) {
    if (!removed.length) return [];
    const posts = await this._db.model.post.findMany({
      where: {
        organizationId,
        deletedAt: null,
        state: { in: [State.QUEUE, State.ERROR, State.REMINDER_SENT] },
        OR: removed.map((url) => ({ image: { contains: url } })),
      },
      select: { id: true, image: true },
    });
    const gone = new Set(removed);
    const ids = posts
      .filter((p) => postImageUrls(p.image).some((url) => gone.has(url)))
      .map((p) => p.id);
    if (ids.length) {
      await this._db.model.post.updateMany({
        where: { id: { in: ids }, organizationId },
        data: { state: State.ERROR, error: message },
      });
    }
    return ids;
  }

  /** Hide the library rows whose file was removed. */
  hideMedia(organizationId: string, removed: string[], at: Date) {
    if (!removed.length) return Promise.resolve({ count: 0 });
    return this._db.model.media.updateMany({
      where: { organizationId, path: { in: removed }, deletedAt: null },
      data: { deletedAt: at },
    });
  }
}
