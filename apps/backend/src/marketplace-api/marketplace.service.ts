import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { Readable } from 'stream';
import { Integration } from '@prisma/client';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import { MarketplaceAccountRepository } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { ssrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { getValidationSchemas } from '@hookpost/nestjs-libraries/chat/validation.schemas.helper';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { PostValidationException } from '@hookpost/backend/api/routes/posts.validation.exception';
import { BadBody } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import type { DiscordProvider } from '@hookpost/nestjs-libraries/integrations/social/discord.provider';
import {
  alertCreditThreshold,
  CAROUSEL_PDF_TTL_DAYS,
  CREDIT_COST,
  hardCreditCap,
  MARKETPLACE_MAX_IMAGE_BYTES,
  MARKETPLACE_MAX_VIDEO_BYTES,
  productProviders,
  quotaWindow,
  trialXDailyBudgetUsd,
  X_TWEETS_PER_CHANNEL_PER_DAY,
  YOUTUBE_MARKETPLACE_DAILY,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import {
  checkThread,
  LinkPolicy,
  plainTextToPostHtml,
  ThreadCheck,
  threadCostMicroUsd,
  threadOptionsFor,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.credits';
import { ruleFor } from '@hookpost/nestjs-libraries/marketplace/marketplace.validator';
import { MARKETPLACE_CONNECT_KEY } from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import { logConnect } from '@hookpost/nestjs-libraries/integrations/connect.log';
import {
  CAROUSEL_PAGE_SIZES,
  CarouselPageSize,
  renderCarouselPdf,
} from '@hookpost/nestjs-libraries/integrations/social/carousel.pdf';
import {
  MarketplaceContext,
  MktError,
} from '@hookpost/backend/marketplace-api/marketplace.context';
import {
  Hold,
  ledgerKeys,
  MarketplaceLedger,
  secondsUntilDayAfter,
  utcDay,
} from '@hookpost/backend/marketplace-api/marketplace.ledger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

const DAY = 86_400_000;
const CONNECT_TTL_SECONDS = 3600;
const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const UPLOAD_MIME = new Set([...IMAGE_MIME, 'image/avif', 'image/bmp', 'image/tiff', 'video/mp4']);
const CAROUSEL_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** Posts may be scheduled this far in the past (clock skew), then they are refused. */
const SCHEDULE_SLACK_MS = 60_000;

export type When = { type: 'now' | 'schedule' | 'draft'; date: Date };

export interface ChannelPost {
  channelId: string;
  settings?: Record<string, unknown>;
  items: { text: string; mediaIds: string[] }[];
}

const STATUS: Record<string, string> = {
  QUEUE: 'scheduled',
  PUBLISHED: 'published',
  ERROR: 'error',
  DRAFT: 'draft',
  // "Remind me to post" (never set by the marketplace API, shown if a post
  // made in the app is read through it)
  REMINDER_SENT: 'reminder_sent',
  POSTED_MANUALLY: 'posted_manually',
};

const isX = (provider: string) => provider === 'x';

/**
 * What every marketplace product does, on the subscriber's own workspace
 * only: every lookup is by MarketplaceContext.organizationId, and a channel,
 * post or media id of another workspace answers 404 like one that does not
 * exist.
 */
@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger('Marketplace');
  private storage = UploadFactory.createStorage();
  private schemas?: Record<string, unknown>;

  constructor(
    private _integrationService: IntegrationService,
    private _integrationManager: IntegrationManager,
    private _postsService: PostsService,
    private _notificationService: NotificationService,
    private _repository: MarketplaceAccountRepository,
    private _ledger: MarketplaceLedger
  ) {}

  // ---------------------------------------------------------------------------
  // Networks and channels
  // ---------------------------------------------------------------------------

  /** The networks this product can connect, as the app has them now. */
  sellableProviders(ctx: Pick<MarketplaceContext, 'product'>): string[] {
    const known = new Set(this._integrationManager.getAllowedSocialsIntegrations());
    return productProviders(ctx.product).filter(
      (id) => known.has(id) && !this._integrationManager.isHiddenProvider(id)
    );
  }

  private connectable(provider: string) {
    const p: any = this._integrationManager.getSocialIntegration(provider);
    return !!p && !p.externalUrl && !p.customFields && !p.isChromeExtension;
  }

  providers(ctx: Pick<MarketplaceContext, 'product' | 'plan'>) {
    this.schemas ??= getValidationSchemas();
    return {
      providers: this.sellableProviders(ctx).map((id) => {
        const p: any = this._integrationManager.getSocialIntegration(id);
        const rule = ruleFor(id);
        return {
          identifier: id,
          name: p.name,
          max_chars: p.maxLength(),
          counting: rule?.counting ?? 'characters',
          media: rule
            ? {
                min: rule.minMedia,
                max: rule.maxMedia,
                video_alone: rule.videoAlone,
                requires_video: rule.requiresVideo,
              }
            : null,
          connect: this.connectable(id),
          picks_page_after_login: !!p.isBetweenSteps,
          credits: isX(id)
            ? { per_tweet: CREDIT_COST.xTweet, per_tweet_with_link: CREDIT_COST.xTweetWithLink }
            : { per_post: CREDIT_COST.channelPost },
          included_in_plan: !isX(id) || ctx.plan.allowX,
          settings: (p.dto && this.schemas?.[p.dto.name]) || null,
        };
      }),
    };
  }

  async connect(ctx: MarketplaceContext, provider: string, reconnectChannelId?: string) {
    if (!this.sellableProviders(ctx).includes(provider)) {
      throw new MktError(400, 'provider_not_available', `${provider} is not part of this API.`, {
        provider,
      });
    }
    if (!this.connectable(provider)) {
      throw new MktError(400, 'connect_not_supported', `${provider} cannot be connected through this API.`);
    }
    if (isX(provider) && !ctx.plan.allowX) {
      throw new MktError(402, 'plan_excludes_x', 'Your plan does not include X. Upgrade to a paid plan to post to X.');
    }

    let refresh: string | undefined;
    if (reconnectChannelId) {
      const channel = await this.channelOf(ctx, reconnectChannelId);
      if (channel.providerIdentifier !== provider) {
        throw new MktError(400, 'provider_mismatch', 'That channel is on another network.');
      }
      refresh = channel.internalId;
    } else if ((await this._repository.countChannels(ctx.organizationId)) >= ctx.plan.channels) {
      throw new MktError(
        402,
        'channel_limit',
        `Your plan connects up to ${ctx.plan.channels} channel${ctx.plan.channels === 1 ? '' : 's'}. Remove one (DELETE /channels/{id}) or upgrade.`
      );
    }

    let auth: { codeVerifier: string; state: string; url: string };
    try {
      auth = await this._integrationManager.getSocialIntegration(provider).generateAuthUrl();
    } catch (e: any) {
      this.logger.error(`connect url failed provider=${provider}: ${e?.message || e}`);
      throw new MktError(502, 'provider_unavailable', `${provider} did not answer. Try again in a minute.`);
    }
    const { codeVerifier, state, url } = auth;
    const pipeline = ioRedis
      .multi()
      .set(`organization:${state}`, ctx.organizationId, 'EX', CONNECT_TTL_SECONDS)
      .set(`login:${state}`, codeVerifier, 'EX', CONNECT_TTL_SECONDS)
      // The callback must come back to this provider (completeConnect's
      // stateIsFor): without it the state would also finish a custom-fields
      // login, which takes no verifier, with anyone's own credentials.
      .set(`provider:${state}`, provider, 'EX', CONNECT_TTL_SECONDS)
      .set(MARKETPLACE_CONNECT_KEY(state), ctx.product, 'EX', CONNECT_TTL_SECONDS);
    if (refresh) pipeline.set(`refresh:${state}`, refresh, 'EX', CONNECT_TTL_SECONDS);
    await pipeline.exec();
    logConnect('connect_start', {
      provider,
      orgId: ctx.organizationId,
      reconnect: !!refresh,
      marketplace: ctx.product,
    });
    return { provider, url, expires_in: CONNECT_TTL_SECONDS };
  }

  /** A channel of this workspace, or 404 (also for another workspace's id). */
  private async channelOf(ctx: MarketplaceContext, id: string): Promise<Integration> {
    const channel = await this._integrationService
      .getIntegrationById(ctx.organizationId, String(id))
      .catch(() => null);
    if (!channel || channel.deletedAt || channel.organizationId !== ctx.organizationId) {
      throw new MktError(404, 'channel_not_found', 'No such channel.', { channel_id: id });
    }
    return channel;
  }

  async channels(ctx: MarketplaceContext) {
    const list = await this._integrationService.getIntegrationsList(ctx.organizationId);
    return {
      channels: list.map((c: any) => ({
        id: c.id,
        provider: c.providerIdentifier,
        name: c.name,
        picture: c.picture || null,
        profile: c.profile || null,
        disabled: !!c.disabled,
        needs_reconnect: !!c.refreshNeeded,
        pending_page_pick: !!c.inBetweenSteps,
      })),
      included: ctx.plan.channels,
    };
  }

  async deleteChannel(ctx: MarketplaceContext, id: string) {
    const channel = await this.channelOf(ctx, id);
    const groups = await this._integrationService.getPostsForChannel(ctx.organizationId, channel.id);
    for (const post of groups) {
      await this._postsService.deletePost(ctx.organizationId, post.group).catch(() => undefined);
    }
    await this._integrationService.deleteChannel(ctx.organizationId, channel.id);
    return { deleted: true, id: channel.id };
  }

  // ---------------------------------------------------------------------------
  // Media
  // ---------------------------------------------------------------------------

  private async storeUpload(ctx: MarketplaceContext, buffer: Buffer, originalName?: string) {
    const detected = await fileTypeFromBuffer(buffer);
    if (!detected || !UPLOAD_MIME.has(detected.mime)) {
      throw new MktError(400, 'unsupported_media_type', 'Upload a JPEG, PNG, GIF, WebP image or an MP4 video.');
    }
    const video = detected.mime === 'video/mp4';
    const max = video ? MARKETPLACE_MAX_VIDEO_BYTES : MARKETPLACE_MAX_IMAGE_BYTES;
    if (buffer.length > max) {
      throw new MktError(413, 'file_too_large', `${video ? 'Videos' : 'Images'} can be up to ${max / 1024 / 1024} MB.`);
    }
    await this.assertStorage(ctx, buffer.length);
    const stored = await this.storage.uploadFile({
      buffer,
      mimetype: detected.mime,
      size: buffer.length,
      path: '',
      fieldname: 'file',
      destination: '',
      stream: new Readable(),
      filename: '',
      originalname: `upload.${detected.ext}`,
      encoding: '',
    });
    const row = await this._repository.recordMedia(ctx.organizationId, {
      name: stored.originalname,
      path: stored.path,
      originalName: (originalName || '').slice(0, 200) || null,
      fileSize: buffer.length,
      type: video ? 'video' : 'image',
    });
    return { id: row.id, url: row.path, bytes: row.fileSize, type: row.type };
  }

  private async assertStorage(ctx: MarketplaceContext, bytes: number) {
    const used = await this._repository.storageUsed(ctx.organizationId);
    if (used + bytes > ctx.plan.storageBytes) {
      throw new MktError(
        402,
        'storage_quota_exceeded',
        `Your plan stores up to ${Math.round(ctx.plan.storageBytes / 1024 / 1024)} MB of media. Media is removed 45 days after upload.`
      );
    }
  }

  upload(ctx: MarketplaceContext, file?: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new MktError(400, 'file_required', 'Send the file as multipart/form-data in the "file" field.');
    }
    return this.storeUpload(ctx, file.buffer, file.originalname);
  }

  async uploadFromUrl(ctx: MarketplaceContext, url: string) {
    return this.storeUpload(ctx, await this.fetchLimited(url, MARKETPLACE_MAX_VIDEO_BYTES), url.split('/').pop());
  }

  /** A public URL's body, through the SSRF guard, refused past `max` bytes while reading. */
  private async fetchLimited(url: string, max: number): Promise<Buffer> {
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        // @ts-ignore - undici option, not in lib.dom fetch types
        dispatcher: ssrfSafeDispatcher,
        redirect: 'follow',
      });
    } catch {
      throw new MktError(400, 'fetch_failed', 'That URL could not be fetched (it must be a public http(s) address).');
    }
    if (!response.ok || !response.body) {
      throw new MktError(400, 'fetch_failed', `That URL answered ${response.status}.`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared && declared > max) {
      throw new MktError(413, 'file_too_large', `The file is over ${Math.round(max / 1024 / 1024)} MB.`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = (response.body as any).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new MktError(413, 'file_too_large', `The file is over ${Math.round(max / 1024 / 1024)} MB.`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }

  /** One of our stored files, read from disk for local storage, else fetched. */
  private async readStored(path: string): Promise<Buffer> {
    const prefix = `${process.env.FRONTEND_URL || ''}/uploads/`;
    if ((process.env.STORAGE_PROVIDER || 'local') === 'local' && path.startsWith(prefix)) {
      const root = resolve(process.env.UPLOAD_DIRECTORY || '');
      const full = resolve(root, path.slice(prefix.length));
      if (!full.startsWith(root + sep)) throw new MktError(404, 'media_not_found', 'No such media.');
      return readFile(full);
    }
    return this.fetchLimited(path, MARKETPLACE_MAX_VIDEO_BYTES);
  }

  private async mediaOf(ctx: MarketplaceContext, ids: string[]) {
    const unique = [...new Set(ids.map(String))];
    const rows = await this._repository.findMedia(ctx.organizationId, unique);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of unique) {
      const row = byId.get(id);
      if (!row) throw new MktError(404, 'media_not_found', 'No such media.', { media_id: id });
      if (row.type === 'pdf') {
        throw new MktError(400, 'media_not_postable', 'A rendered carousel PDF cannot be attached; send the images to POST /carousels.', {
          media_id: id,
        });
      }
    }
    return byId;
  }

  // ---------------------------------------------------------------------------
  // Posting
  // ---------------------------------------------------------------------------

  /** schedule_at: an ISO time with a zone, "now" or "draft", within the plan's horizon. */
  when(ctx: MarketplaceContext, scheduleAt: string, now = new Date()): When {
    const value = String(scheduleAt || '').trim();
    if (value === 'now') return { type: 'now', date: now };
    if (value === 'draft') return { type: 'draft', date: now };
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
    const date = new Date(value);
    if (!hasZone || Number.isNaN(date.getTime())) {
      throw new MktError(400, 'invalid_schedule', 'schedule_at must be an ISO 8601 time with a zone (2026-11-02T09:30:00Z), "now" or "draft".');
    }
    const horizon = ctx.plan.scheduleHorizonDays;
    if (date.getTime() < now.getTime() - SCHEDULE_SLACK_MS) {
      throw new MktError(400, 'schedule_out_of_range', 'schedule_at is in the past. Use "now" to post at once.');
    }
    if (date.getTime() > now.getTime() + horizon * DAY) {
      throw new MktError(400, 'schedule_out_of_range', `Your plan schedules up to ${horizon} days ahead.`);
    }
    return { type: 'schedule', date };
  }

  /**
   * Checks, prices and (unless `dryRun`) saves one post per channel. Credits
   * and every cap are held before anything is saved and given back if the
   * save fails; nothing reaches a network here (the orchestrator publishes).
   */
  async createPosts(
    ctx: MarketplaceContext,
    input: {
      channels: ChannelPost[];
      when: When;
      linkPolicy?: LinkPolicy;
      dryRun?: boolean;
      /** Settings the product sets for every channel (LinkedIn carousel). */
      forcedSettings?: Record<string, unknown>;
    }
  ) {
    const now = new Date();
    const policy: LinkPolicy = input.linkPolicy === 'allow' ? 'allow' : 'reject';
    const draft = input.when.type === 'draft';
    const allowed = this.sellableProviders(ctx);

    // Channels: this workspace's, connected, on a network the product sells.
    const channels = new Map<string, Integration>();
    for (const target of input.channels) {
      if (channels.has(target.channelId)) {
        throw new MktError(400, 'duplicate_channel', 'A channel is listed twice.', { channel_id: target.channelId });
      }
      const channel = await this.channelOf(ctx, target.channelId);
      if (channel.disabled) {
        throw new MktError(409, 'channel_disabled', 'That channel is disabled.', { channel_id: channel.id });
      }
      if (channel.inBetweenSteps) {
        throw new MktError(409, 'channel_not_ready', 'Finish connecting that channel (pick the page) first.', { channel_id: channel.id });
      }
      if (channel.refreshNeeded) {
        throw new MktError(409, 'channel_needs_reconnect', 'That channel needs to be connected again (GET /connect with reconnect).', {
          channel_id: channel.id,
        });
      }
      if (!allowed.includes(channel.providerIdentifier)) {
        throw new MktError(400, 'provider_not_available', `${channel.providerIdentifier} is not part of this API.`, {
          channel_id: channel.id,
        });
      }
      if (isX(channel.providerIdentifier) && !ctx.plan.allowX) {
        throw new MktError(402, 'plan_excludes_x', 'Your plan does not include X. Upgrade to a paid plan to post to X.', {
          channel_id: channel.id,
        });
      }
      channels.set(target.channelId, channel);
    }
    if ((await this._repository.countChannels(ctx.organizationId)) > ctx.plan.channels) {
      throw new MktError(402, 'channel_limit', `Your plan includes ${ctx.plan.channels} channels and this workspace has more. Remove one (DELETE /channels/{id}).`);
    }

    const media = await this.mediaOf(
      ctx,
      input.channels.flatMap((c) => c.items.flatMap((i) => i.mediaIds))
    );

    // Price each channel and check X's rules before anything is held.
    const priced = input.channels.map((target) => {
      const channel = channels.get(target.channelId)!;
      const provider = channel.providerIdentifier;
      if (target.items.length > ctx.plan.threadCap) {
        throw new MktError(
          400,
          'thread_too_long',
          `This plan takes up to ${ctx.plan.threadCap} item${ctx.plan.threadCap === 1 ? '' : 's'} per post (the post and its replies).`,
          { channel_id: channel.id }
        );
      }
      let check: ThreadCheck | null = null;
      let credits: number = CREDIT_COST.channelPost;
      if (isX(provider)) {
        check = checkThread(
          target.items.map((i) => ({
            text: i.text,
            media: i.mediaIds.map((id) => ({ type: media.get(id)?.type === 'video' ? 'video' : 'image' })),
          })),
          threadOptionsFor(ctx.plan, {
            premium: this.verified(channel),
            linkPolicy: policy,
            stripLinks: !!process.env.STRIP_LINKS_FROM_X_POSTS,
          })
        );
        if (!check.valid) {
          throw new MktError(400, 'invalid_thread', check.errors[0] || 'A tweet breaks an X rule; see tweets[].errors.', {
            channel_id: channel.id,
            tweets: check.tweets,
          });
        }
        credits = check.credits;
      }
      return { target, channel, provider, check, credits: draft ? 0 : credits };
    });

    // The post as the app saves it: one group per channel, the buyer's text
    // escaped into the editor's paragraphs.
    const body: any = {
      type: input.when.type,
      shortLink: false,
      date: input.when.date.toISOString(),
      tags: [],
      posts: priced.map(({ target, provider }) => ({
        integration: { id: target.channelId },
        group: makeId(12),
        value: target.items.map((item) => ({
          content: plainTextToPostHtml(item.text),
          image: item.mediaIds.map((id) => ({ id, path: media.get(id)!.path })),
        })),
        settings: this.settingsFor(provider, target.settings, input.forcedSettings),
      })),
    };

    let mapped: any;
    try {
      mapped = await this._postsService.mapTypeToPost(body, ctx.organizationId, true);
      mapped.type = input.when.type;
    } catch (e: any) {
      if (e instanceof BadRequestException) {
        const response: any = e.getResponse();
        const message = Array.isArray(response?.message) ? response.message.join('; ') : String(response?.message || e.message);
        throw new MktError(400, 'invalid_settings', message);
      }
      throw e;
    }

    const validation = await this._postsService.validatePosts(ctx.organizationId, mapped.posts);
    for (const item of validation) {
      const fail = (code: string, message: string) => {
        throw new MktError(400, code, message, { channel_id: item.id, provider: item.identifier });
      };
      if (item.emptyContent) fail('empty_post', 'A post needs text or at least one image or video.');
      if (!draft) {
        if (!item.valid) fail('invalid_settings', item.settingsError || `Check the ${item.identifier} settings (GET /providers).`);
        if (item.errors !== true) fail('invalid_media', String(item.errors));
        if (item.tooLong) fail('too_long', `Over ${item.maximumCharacters} characters for ${item.identifier}.`);
      }
    }

    // The settings as they are saved (mapTypeToPost's validation pipe may
    // have converted them), in the order of `priced`.
    await this.assertDiscordChannels(
      priced.map((p, i) => ({ channel: p.channel, provider: p.provider, settings: mapped.posts[i]?.settings || {} })),
      draft
    );

    const credits = priced.reduce((sum, p) => sum + p.credits, 0);
    if (input.dryRun) {
      return {
        valid: true,
        credits,
        channels: priced.map((p) => ({
          channel_id: p.channel.id,
          provider: p.provider,
          credits: p.credits,
          ...(p.check ? { tweets: p.check.tweets } : {}),
        })),
      };
    }

    const holds = draft ? [] : this.holdsFor(ctx, priced, input.when.date, now);
    await this.hold(ctx, holds);
    let created: { postId: string; integration: string }[];
    try {
      created = await this._postsService.createPost(ctx.organizationId, mapped, 'API');
      if (!created?.length) {
        throw new MktError(400, 'empty_post', 'Nothing to post.');
      }
    } catch (e) {
      await this._ledger.refund(holds).catch(() => undefined);
      if (e instanceof PostValidationException || e instanceof BadRequestException) {
        throw new MktError(400, 'invalid_post', (e as any).message);
      }
      throw e;
    }
    ctx.credits = credits;

    const status = draft ? 'draft' : input.when.type === 'now' ? 'queued' : 'scheduled';
    return {
      posts: created.map((c) => {
        const p = priced.find((x) => x.channel.id === c.integration)!;
        return {
          id: c.postId,
          channel_id: c.integration,
          provider: p.provider,
          status,
          publish_at: input.when.date.toISOString(),
          credits: p.credits,
        };
      }),
      credits_charged: credits,
    };
  }

  private verified(channel: Integration) {
    try {
      return !!JSON.parse(channel.additionalSettings || '[]')?.find((s: any) => s?.title === 'Verified')?.value;
    } catch {
      return false;
    }
  }

  /**
   * Discord posts go out through Hookpost's one bot, which is in every server
   * that added it, so settings.channel alone could name a channel of anyone's
   * server. Each one must be in the server this channel connected
   * (internalId), checked with Discord before anything is held or saved.
   * DiscordProvider checks it again before every publish, for every path.
   * A draft without a channel yet is left for the publish-time check.
   */
  private async assertDiscordChannels(
    targets: { channel: Integration; provider: string; settings: Record<string, unknown> }[],
    draft: boolean
  ) {
    for (const { channel, provider, settings } of targets) {
      if (provider !== 'discord') continue;
      if (draft && (settings.channel === undefined || settings.channel === '')) continue;
      const discord = this._integrationManager.getSocialIntegration('discord') as unknown as DiscordProvider;
      try {
        await discord.channelInServer(channel.internalId, settings.channel);
      } catch (e: any) {
        if (e instanceof BadBody) {
          throw new MktError(400, 'channel_not_in_server', e.message, { channel_id: channel.id });
        }
        this.logger.error(`discord channel check failed: ${e?.message || e}`);
        throw new MktError(502, 'provider_unavailable', 'Discord did not answer. Try again in a minute.', {
          channel_id: channel.id,
        });
      }
    }
  }

  /** The network's settings: the buyer's, the product's, and X kept to plain posts. */
  private settingsFor(
    provider: string,
    given?: Record<string, unknown>,
    forced?: Record<string, unknown>
  ) {
    const settings: Record<string, unknown> = { ...(given || {}), ...(forced || {}) };
    delete settings.__type;
    if (isX(provider)) {
      // Articles need X Premium and a draft one takes no replies: not sold.
      for (const key of ['post_type', 'article_title', 'article_status', 'article_cover']) {
        delete settings[key];
      }
      settings.post_type = 'post';
      settings.who_can_reply_post ??= 'everyone';
    }
    return settings;
  }

  /** Every cap this post is held against (see MarketplaceLedger). */
  private holdsFor(
    ctx: MarketplaceContext,
    priced: { channel: Integration; provider: string; check: ThreadCheck | null; credits: number; target: ChannelPost }[],
    publishAt: Date,
    now: Date
  ): Hold[] {
    const holds: Hold[] = [this.quotaHold(ctx, priced.reduce((s, p) => s + p.credits, 0), now)];
    const day = utcDay(publishAt);
    const dayTtl = secondsUntilDayAfter(publishAt, now);
    let trialCost = 0;
    let youtube = 0;
    for (const p of priced) {
      if (p.check) {
        holds.push({
          key: ledgerKeys.xDay(p.channel.id, day),
          amount: p.check.tweets.length,
          cap: X_TWEETS_PER_CHANNEL_PER_DAY,
          ttlSeconds: dayTtl,
          reason: 'x_daily_limit',
        });
        if (ctx.plan.trial) trialCost += threadCostMicroUsd(p.check);
      }
      if (p.provider === 'youtube') youtube++;
      holds.push({
        key: ledgerKeys.duplicate(p.channel.id, this.contentHash(p.target)),
        amount: 1,
        cap: 1,
        ttlSeconds: 86400,
        reason: 'duplicate_content',
      });
    }
    if (trialCost) {
      holds.push({
        key: ledgerKeys.trialX(day),
        amount: trialCost,
        cap: Math.floor(trialXDailyBudgetUsd() * 1_000_000),
        ttlSeconds: dayTtl,
        reason: 'trial_capacity',
      });
    }
    if (youtube) {
      holds.push({
        key: ledgerKeys.youtubeAll(day),
        amount: youtube,
        cap: YOUTUBE_MARKETPLACE_DAILY,
        ttlSeconds: dayTtl,
        reason: 'youtube_daily_limit',
      });
      holds.push({
        key: ledgerKeys.youtubeAccount(ctx.account.id, day),
        amount: youtube,
        cap: ctx.plan.youtubePerDay,
        ttlSeconds: dayTtl,
        reason: 'youtube_daily_limit',
      });
    }
    return holds;
  }

  private contentHash(target: ChannelPost) {
    const normal = target.items
      .map((i) => `${i.text.replace(/\s+/g, ' ').trim().toLowerCase()}|${i.mediaIds.join(',')}`)
      .join('\n');
    return createHash('sha256').update(normal).digest('hex').slice(0, 32);
  }

  /**
   * `amount` credits against this plan's window: counted from periodStart,
   * keyed by it (a plan change starts again from 0), refused past the plan's
   * cap, and kept a day past the window's end.
   */
  private quotaHold(ctx: MarketplaceContext, amount: number, now: Date): Hold {
    const window = quotaWindow(ctx.account.periodStart, now);
    return {
      key: ledgerKeys.quota(ctx.account.id, ctx.account.periodStart, window.index),
      amount,
      cap: hardCreditCap(ctx.plan),
      ttlSeconds: Math.ceil((window.end.getTime() - now.getTime()) / 1000) + 86400,
      reason: 'quota_exceeded',
      resetsAt: window.end,
    };
  }

  /** Holds everything or throws the refusal of the first cap it is over. */
  private async hold(ctx: MarketplaceContext, holds: Hold[]) {
    const result = await this._ledger.reserve(holds);
    if (result.ok || !result.failed) {
      await this.alertPastThreshold(ctx, holds.find((h) => h.reason === 'quota_exceeded'));
      return;
    }
    const reason = result.failed.reason;
    switch (reason) {
      case 'quota_exceeded': {
        const resetsAt = result.failed.resetsAt?.toISOString();
        throw new MktError(
          402,
          'quota_exceeded',
          `This call is over the usage limit we hold for this subscription${resetsAt ? ` until ${resetsAt}` : ''}. Nothing was posted or billed. GET /usage shows the counter.`,
          resetsAt ? { resets_at: resetsAt } : {}
        );
      }
      case 'x_daily_limit':
        throw new MktError(429, 'x_daily_limit', `An X channel posts up to ${X_TWEETS_PER_CHANNEL_PER_DAY} tweets a day. Schedule the rest for another day.`);
      case 'youtube_daily_limit':
        throw new MktError(429, 'youtube_daily_limit', 'The YouTube uploads for that day are used. Schedule it for another day.');
      case 'trial_capacity':
        throw new MktError(503, 'trial_capacity', 'Free-trial X posting is at capacity for today. Try tomorrow, or subscribe to a paid plan. Nothing was billed.');
      case 'duplicate_content':
        throw new MktError(409, 'duplicate_content', 'The same post went to this channel in the last 24 hours.');
      default:
        throw new MktError(429, reason, 'A limit was reached.');
    }
  }

  /**
   * A paid plan is refused only at 2x its credits in a window, since a
   * window can hold two api.market months. Past 1.2x it is logged once per
   * window ("mkt usage alert"): either the buyer straddles a renewal, or
   * api.market's counter missed calls. Never fails the call.
   */
  private async alertPastThreshold(ctx: MarketplaceContext, quota?: Hold) {
    const threshold = alertCreditThreshold(ctx.plan);
    if (!quota || threshold === null) return;
    try {
      const used = await this._ledger.used(quota.key);
      if (used <= threshold) return;
      if (!(await this._ledger.claim(ledgerKeys.quotaAlert(quota.key), quota.ttlSeconds))) return;
      this.logger.warn(
        `mkt usage alert account=${ctx.account.id} subscriber=${ctx.tag} product=${ctx.product} plan=${ctx.plan.plan} used=${used} included=${ctx.plan.credits} cap=${quota.cap} window_end=${quota.resetsAt?.toISOString()}`
      );
    } catch (e: any) {
      this.logger.error(`usage alert check failed: ${e?.message || e}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Reading and deleting posts
  // ---------------------------------------------------------------------------

  private async thread(ctx: MarketplaceContext, id: string) {
    try {
      return await this._postsService.getPost(ctx.organizationId, String(id));
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new MktError(404, 'post_not_found', 'No such post.', { post_id: id });
      }
      throw e;
    }
  }

  async getPost(ctx: MarketplaceContext, id: string) {
    const found = await this.thread(ctx, id);
    const [root, ...replies] = found.posts as any[];
    if (!root || root.organizationId !== ctx.organizationId || root.deletedAt) {
      throw new MktError(404, 'post_not_found', 'No such post.', { post_id: id });
    }
    const item = (p: any) => ({
      id: p.id,
      status: STATUS[p.state] || String(p.state).toLowerCase(),
      url: p.releaseURL || null,
      error: p.state === 'ERROR' ? String(p.error || '').slice(0, 500) || null : null,
    });
    return {
      ...item(root),
      channel_id: root.integrationId,
      provider: root.integration?.providerIdentifier ?? null,
      publish_at: new Date(root.publishDate).toISOString(),
      replies: replies.map(item),
    };
  }

  async deletePost(ctx: MarketplaceContext, id: string) {
    const found = await this.thread(ctx, id);
    const root: any = found.posts[0];
    if (!root || root.organizationId !== ctx.organizationId || root.deletedAt) {
      throw new MktError(404, 'post_not_found', 'No such post.', { post_id: id });
    }
    if (root.state === 'PUBLISHED') {
      throw new MktError(409, 'already_published', 'This post is already published; it can only be deleted on the network itself.');
    }
    await this._postsService.deletePost(ctx.organizationId, found.group);
    return { deleted: true, id: root.id };
  }

  async listPosts(ctx: MarketplaceContext, from?: string, to?: string) {
    const start = from ? new Date(from) : new Date(Date.now() - 7 * DAY);
    const end = to ? new Date(to) : new Date(Date.now() + 35 * DAY);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
      throw new MktError(400, 'invalid_range', 'from and to must be ISO 8601 times, from before to.');
    }
    if (end.getTime() - start.getTime() > 92 * DAY) {
      throw new MktError(400, 'invalid_range', 'Ask for at most 92 days at a time.');
    }
    const posts = await this._postsService.getPosts(ctx.organizationId, {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    } as any);
    return {
      posts: (posts as any[]).map((p) => ({
        id: p.id,
        channel_id: p.integration?.id ?? null,
        provider: p.integration?.providerIdentifier ?? null,
        status: STATUS[p.state] || String(p.state).toLowerCase(),
        publish_at: new Date(p.publishDate).toISOString(),
        url: p.releaseURL || null,
      })),
    };
  }

  async slot(ctx: MarketplaceContext, channelId: string) {
    const channel = await this.channelOf(ctx, channelId);
    const date = await this._postsService.findFreeDateTime(ctx.organizationId, channel.id);
    return { channel_id: channel.id, date: new Date(`${date}Z`).toISOString() };
  }

  async notifications(ctx: MarketplaceContext, page = 0) {
    const result: any = await this._notificationService.getNotificationsPaginated(
      ctx.organizationId,
      Math.max(0, Math.floor(page) || 0)
    );
    return {
      notifications: (result?.notifications || []).map((n: any) => ({
        id: n.id,
        message: n.content,
        created_at: n.createdAt,
      })),
      has_more: !!result?.hasMore,
    };
  }

  async usage(ctx: MarketplaceContext, now = new Date()) {
    const window = quotaWindow(ctx.account.periodStart, now);
    const [used, channels, storage] = await Promise.all([
      this._ledger.used(ledgerKeys.quota(ctx.account.id, ctx.account.periodStart, window.index)),
      this._repository.countChannels(ctx.organizationId),
      this._repository.storageUsed(ctx.organizationId),
    ]);
    return {
      product: ctx.product,
      plan: ctx.plan.plan,
      plan_name: ctx.plan.name,
      window_start: window.start.toISOString(),
      window_end: window.end.toISOString(),
      credits_included: ctx.plan.credits,
      credits_used: used,
      channels_included: ctx.plan.channels,
      channels_used: channels,
      storage_included_bytes: ctx.plan.storageBytes,
      storage_used_bytes: storage,
      schedule_horizon_days: ctx.plan.scheduleHorizonDays,
      x_included: ctx.plan.allowX,
      x_links_included: ctx.plan.allowXLinks,
      thread_cap: ctx.plan.threadCap,
      note: `${ctx.adapter.label} bills and limits your plan; these are our own counters.`,
    };
  }

  // ---------------------------------------------------------------------------
  // LinkedIn carousels
  // ---------------------------------------------------------------------------

  /** Image URLs and media ids as image buffers, in order. */
  private async carouselImages(ctx: MarketplaceContext, images: string[]) {
    const ids = images.filter((i) => !/^https?:\/\//i.test(i));
    const media = ids.length ? await this.mediaOf(ctx, ids) : new Map();
    let total = 0;
    const buffers: Buffer[] = [];
    for (const image of images) {
      let buffer: Buffer;
      if (/^https?:\/\//i.test(image)) {
        buffer = await this.fetchLimited(image, MARKETPLACE_MAX_IMAGE_BYTES);
      } else {
        const row = media.get(image)!;
        if (row.type !== 'image') {
          throw new MktError(400, 'not_an_image', 'Carousel pages must be images.', { media_id: image });
        }
        buffer = await this.readStored(row.path);
      }
      const detected = await fileTypeFromBuffer(buffer);
      if (!detected || !IMAGE_MIME.has(detected.mime)) {
        throw new MktError(400, 'not_an_image', 'Carousel pages must be JPEG, PNG, GIF or WebP images.');
      }
      total += buffer.length;
      if (total > CAROUSEL_MAX_TOTAL_BYTES) {
        throw new MktError(413, 'file_too_large', 'A carousel takes up to 50 MB of images in all.');
      }
      buffers.push(buffer);
    }
    return buffers;
  }

  async renderCarousel(
    ctx: MarketplaceContext,
    input: { images: string[]; title?: string; size?: CarouselPageSize },
    now = new Date()
  ) {
    if (!this.storage.uploadGeneratedPdf) {
      throw new MktError(503, 'unavailable', 'Rendering is not available right now.');
    }
    const holds = [this.quotaHold(ctx, CREDIT_COST.carouselRender, now)];
    await this.hold(ctx, holds);
    try {
      const buffers = await this.carouselImages(ctx, input.images);
      const rendered = await renderCarouselPdf(buffers, CAROUSEL_PAGE_SIZES[input.size || 'portrait']);
      await this.assertStorage(ctx, rendered.pdf.length);
      const stored = await this.storage.uploadGeneratedPdf(rendered.pdf);
      const slug = (input.title || 'carousel').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'carousel';
      const row = await this._repository.recordMedia(ctx.organizationId, {
        name: `${slug}.pdf`,
        path: stored.path,
        originalName: null,
        fileSize: rendered.pdf.length,
        type: 'pdf',
      });
      ctx.credits = CREDIT_COST.carouselRender;
      return {
        id: row.id,
        pdf_url: stored.path,
        pages: rendered.pages,
        width: rendered.width,
        height: rendered.height,
        bytes: rendered.pdf.length,
        expires_at: new Date(row.createdAt.getTime() + CAROUSEL_PDF_TTL_DAYS * DAY).toISOString(),
      };
    } catch (e) {
      await this._ledger.refund(holds).catch(() => undefined);
      throw e;
    }
  }

  /** URL images of a carousel post become this workspace's media first. */
  async carouselMediaIds(ctx: MarketplaceContext, images: string[]) {
    const ids: string[] = [];
    for (const image of images) {
      if (/^https?:\/\//i.test(image)) {
        const stored = await this.storeUpload(ctx, await this.fetchLimited(image, MARKETPLACE_MAX_IMAGE_BYTES));
        if (stored.type !== 'image') {
          throw new MktError(400, 'not_an_image', 'Carousel pages must be images.');
        }
        ids.push(stored.id);
      } else {
        ids.push(image);
      }
    }
    const media = await this.mediaOf(ctx, ids);
    for (const id of ids) {
      if (media.get(id)!.type !== 'image') {
        throw new MktError(400, 'not_an_image', 'Carousel pages must be images.', { media_id: id });
      }
    }
    return ids;
  }

  /** A validator check: 1 credit, held like a post. */
  async chargeCheck(ctx: MarketplaceContext, now = new Date()) {
    await this.hold(ctx, [this.quotaHold(ctx, CREDIT_COST.validatorCheck, now)]);
    ctx.credits = CREDIT_COST.validatorCheck;
  }
}
