import { everyAligned, AlignedTimer } from '@hookpost/helpers/utils/timer';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MarketplaceAccountRepository } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import {
  CAROUSEL_PDF_TTL_DAYS,
  DORMANT_AFTER_DAYS,
  MarketplacePlan,
  MEDIA_RETENTION_DAYS,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { subscriberTag } from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import {
  apiMarketAdapter,
  MarketplaceAdapter,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';

const DAY = 86_400_000;
/** lastSeenAt is written at most this often per account (one write per call was a hot row). */
const TOUCH_EVERY_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
export const MARKETPLACE_SWEEP_LOCK = (day: string) => `mkt:sweep:${day}`;

export interface ResolvedAccount {
  account: {
    id: string;
    product: string;
    plan: string;
    status: string;
    organizationId: string;
    periodStart: Date;
    externalUserId: string;
  };
  created: boolean;
  planChanged: boolean;
}

/**
 * Provisioning for marketplace subscribers (api.market, RapidAPI and the
 * keyed marketplaces, marketplace.adapters.ts), and the daily upkeep of their
 * workspaces.
 *
 * resolve(): the subscriber's account for one product on one marketplace,
 * created with its workspace on the first call
 * (MarketplaceAccountRepository.provision; the workspace's source is the
 * marketplace), and moved to the plan the call names when that changed. The
 * same buyer id on two marketplaces is two accounts and two workspaces.
 *
 * sweep(), once a day where RUN_CRON is on:
 *  - an account not seen for DORMANT_AFTER_DAYS is DORMANT and its posts
 *    still scheduled are cancelled (api.market sends no cancellation, so a
 *    subscriber who stopped paying stops publishing here);
 *  - media older than MEDIA_RETENTION_DAYS, and carousel PDFs older than
 *    CAROUSEL_PDF_TTL_DAYS, are removed from storage, except files a
 *    scheduled post still uses.
 */
@Injectable()
export class MarketplaceAccountService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Marketplace');
  private timer?: AlignedTimer;

  constructor(
    private _repository: MarketplaceAccountRepository,
    private _postsService: PostsService
  ) {}

  onModuleInit() {
    if (process.env.RUN_CRON !== 'true' || process.env.NODE_ENV === 'test') {
      return;
    }
    const run = () =>
      this.sweepOncePerDay().catch((e) =>
        this.logger.error(`Marketplace sweep failed: ${e?.message || e}`)
      );
    setTimeout(run, 5 * 60 * 1000).unref();
    this.timer = everyAligned(SWEEP_EVERY_MS, run);
  }

  onModuleDestroy() {
    this.timer?.stop();
  }

  findByOrganization(organizationId: string) {
    return this._repository.findByOrganization(organizationId);
  }

  async resolve(
    externalUserId: string,
    plan: MarketplacePlan,
    now = new Date(),
    marketplace: Pick<
      MarketplaceAdapter,
      'id' | 'identifier' | 'workspaceName' | 'subscriberKey'
    > = apiMarketAdapter
  ): Promise<ResolvedAccount> {
    let account = await this._repository.find(externalUserId, plan.product, marketplace.id);
    let created = false;
    if (!account) {
      try {
        account = await this._repository.provision({
          marketplace: marketplace.id,
          externalUserId,
          product: plan.product,
          plan: plan.plan,
          tier: plan.tier,
          totalChannels: plan.channels,
          identifier: marketplace.identifier(plan.product, externalUserId),
          name: marketplace.workspaceName(subscriberTag(marketplace.subscriberKey(externalUserId))),
          now,
        });
        created = true;
        this.logger.log(
          `provisioned marketplace=${marketplace.id} product=${plan.product} plan=${plan.plan} subscriber=${subscriberTag(marketplace.subscriberKey(externalUserId))} org=${account.organizationId}`
        );
      } catch (err) {
        // Another first call won the race: use its workspace.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          account = await this._repository.find(externalUserId, plan.product, marketplace.id);
        }
        if (!account) throw err;
      }
    }

    let planChanged = false;
    if (account.plan !== plan.plan) {
      account = await this._repository.changePlan(
        account.id,
        account.organizationId,
        { plan: plan.plan, tier: plan.tier, totalChannels: plan.channels },
        now
      );
      planChanged = true;
      this.logger.log(
        `plan change marketplace=${marketplace.id} product=${plan.product} plan=${plan.plan} subscriber=${subscriberTag(marketplace.subscriberKey(externalUserId))}`
      );
    } else if (
      !created &&
      (account.status === 'DORMANT' ||
        now.getTime() - account.lastSeenAt.getTime() > TOUCH_EVERY_MS)
    ) {
      account = await this._repository.touch(
        account.id,
        now,
        account.status === 'DORMANT'
      );
    }
    return { account, created, planChanged };
  }

  // ---------------------------------------------------------------------------
  // Daily upkeep
  // ---------------------------------------------------------------------------

  /** One sweep a day across processes (the backend and orchestrator both run crons). */
  async sweepOncePerDay(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const taken = await ioRedis.set(
      MARKETPLACE_SWEEP_LOCK(day),
      '1',
      'EX',
      26 * 3600,
      'NX'
    );
    if (taken !== 'OK') return null;
    return this.sweep(now);
  }

  async sweep(now = new Date()) {
    const dormant = await this.sweepDormant(now);
    const media = await this.purgeMedia(now);
    this.logger.log(
      `sweep dormant=${dormant.accounts} cancelledGroups=${dormant.groups} mediaRemoved=${media.removed} mediaKept=${media.kept}`
    );
    return { ...dormant, ...media };
  }

  async sweepDormant(now = new Date()) {
    const before = new Date(now.getTime() - DORMANT_AFTER_DAYS * DAY);
    let accounts = 0;
    let groups = 0;
    for (const candidate of await this._repository.dormantCandidates(before)) {
      if (!(await this._repository.markDormant(candidate.id, before))) continue;
      accounts++;
      for (const group of await this._repository.scheduledGroups(
        candidate.organizationId,
        now
      )) {
        await this._postsService.deletePost(candidate.organizationId, group);
        groups++;
      }
    }
    return { accounts, groups };
  }

  async purgeMedia(now = new Date()) {
    const orgs = await this._repository.marketplaceOrganizationIds();
    const storage = UploadFactory.createStorage();
    const due = [
      ...(await this._repository.expiredMedia(
        orgs,
        new Date(now.getTime() - MEDIA_RETENTION_DAYS * DAY)
      )),
      ...(await this._repository.expiredMedia(
        orgs,
        new Date(now.getTime() - CAROUSEL_PDF_TTL_DAYS * DAY),
        'pdf'
      )),
    ];
    const seen = new Set<string>();
    const keep = new Map<string, Set<string>>();
    let removed = 0;
    let kept = 0;
    for (const media of due) {
      if (seen.has(media.id)) continue;
      seen.add(media.id);
      if (!keep.has(media.organizationId)) {
        keep.set(
          media.organizationId,
          await this._repository.queuedMediaPaths(media.organizationId)
        );
      }
      if (keep.get(media.organizationId)!.has(media.path)) {
        kept++;
        continue;
      }
      try {
        if (storage.ownsFile(media.path)) {
          await storage.removeFile(media.path);
        }
        await this._repository.softDeleteMedia(media.organizationId, media.id);
        removed++;
      } catch (e: any) {
        // Left for the next run: the row stays until its file is gone.
        this.logger.warn(`media purge kept ${media.id}: ${e?.message || e}`);
      }
    }
    return { removed, kept };
  }
}
