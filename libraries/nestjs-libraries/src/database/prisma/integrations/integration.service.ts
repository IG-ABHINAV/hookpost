import { randomUUID } from 'crypto';
import {
  forwardRef,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SubscriptionRepository } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.repository';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  CountryHints,
  planState,
  policyOrgFromFacts,
  preTrialChannelLimit,
  trialCutoffs,
  trialDaysFor,
  trialPolicyActive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { PreTrialChannelLimitError } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error';
import { logConnect } from '@hookpost/nestjs-libraries/integrations/connect.log';
import { IntegrationRepository } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.repository';
import {
  isUnfinishedConnect,
  NEVER_SWEPT,
} from '@hookpost/nestjs-libraries/database/prisma/integrations/unfinished.connect';
import { countsTowardChannelLimit } from '@hookpost/nestjs-libraries/database/prisma/integrations/channel.limit';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import {
  AnalyticsData,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { Integration, Organization } from '@prisma/client';
import { NotificationService } from '@hookpost/nestjs-libraries/database/prisma/notifications/notification.service';
import dayjs from 'dayjs';
import { timer, everyAligned, AlignedTimer } from '@hookpost/helpers/utils/timer';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import {
  NotEnoughScopes,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { IntegrationTimeDto } from '@hookpost/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@hookpost/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@hookpost/nestjs-libraries/dtos/plugs/plug.dto';
import { difference, uniq } from 'lodash';
import utc from 'dayjs/plugin/utc';
import { AutopostRepository } from '@hookpost/nestjs-libraries/database/prisma/autopost/autopost.repository';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { TemporalService } from 'nestjs-temporal-core';

dayjs.extend(utc);

/** An unfinished two-step connect older than this is removed. */
export const STALE_PLACEHOLDER_HOURS = 24;
const PLACEHOLDER_SWEEP_MS = 6 * 60 * 60 * 1000;

/**
 * Runs a plug's provider call, or not (IntegrationService.processPlugs and
 * processInternalPlug). `text` is what the plug would post.
 */
export type PlugGuard = (
  integration: Integration,
  text: string,
  run: () => Promise<any>
) => Promise<any>;

@Injectable()
export class IntegrationService implements OnModuleInit, OnModuleDestroy {
  private storage = UploadFactory.createStorage();
  private placeholderTimer?: AlignedTimer;
  constructor(
    private _integrationRepository: IntegrationRepository,
    private _autopostsRepository: AutopostRepository,
    private _integrationManager: IntegrationManager,
    private _notificationService: NotificationService,
    @Inject(forwardRef(() => RefreshIntegrationService))
    private _refreshIntegrationService: RefreshIntegrationService,
    private _temporalService: TemporalService,
    // Repository, not SubscriptionService: SubscriptionService imports
    // IntegrationService, so injecting it here would be a dependency cycle.
    private _subscriptionRepository: SubscriptionRepository
  ) {}

  /**
   * Sweeps unfinished connect placeholders (removeStalePlaceholders) every 6 h.
   * Same gate as the other in-process sweeps (razorpay.service.ts): only
   * where RUN_CRON is on, the production backend and orchestrator. The sweep
   * is idempotent, so two processes running it only repeat no-ops.
   *
   * Also off until PLACEHOLDER_SWEEP=true: its first run deletes the
   * placeholders already sitting in prod, which is a data change to make on
   * purpose, not as a side effect of a deploy.
   */
  onModuleInit() {
    if (
      process.env.RUN_CRON !== 'true' ||
      process.env.PLACEHOLDER_SWEEP !== 'true' ||
      process.env.NODE_ENV === 'test'
    ) {
      return;
    }
    const run = () =>
      this.removeStalePlaceholders().catch((e) =>
        Logger.error(`Placeholder sweep failed: ${e}`, 'IntegrationService')
      );
    setTimeout(run, 5 * 60 * 1000).unref();
    this.placeholderTimer = everyAligned(PLACEHOLDER_SWEEP_MS, run);
  }

  onModuleDestroy() {
    this.placeholderTimer?.stop();
  }

  /**
   * Soft-deletes placeholders from a two-step connect that nobody finished
   * within STALE_PLACEHOLDER_HOURS: the login worked, but no page was picked
   * (a Facebook account with no Page, on 6 Oct, left one that stayed for two
   * weeks). They hold the login's token and show in the channel list as a
   * channel that can do nothing. deleteChannel hashes the tokens and stops
   * any refresh workflow, as for a channel the user removes. Returns how many
   * were removed.
   *
   * Only rows that never became a channel: a two-step provider, no post ever,
   * and still the login's own id (isUnfinishedConnect). A live channel that a
   * failed token refresh marked in between steps is none of these, and
   * deleting it would hash its tokens for good.
   */
  async removeStalePlaceholders(now = new Date()) {
    const before = new Date(
      now.getTime() - STALE_PLACEHOLDER_HOURS * 60 * 60 * 1000
    );
    const twoStep = this._integrationManager
      .getAllowedSocialsIntegrations()
      .filter(
        (identifier) =>
          !!this._integrationManager.getSocialIntegration(identifier)
            ?.isBetweenSteps &&
          // Tumblr and LinkedIn Page: a finished channel can look like a
          // placeholder (unfinished.connect.ts).
          !NEVER_SWEPT.includes(identifier)
      );
    if (!twoStep.length) {
      return 0;
    }
    const stale = (
      await this._integrationRepository.getStalePlaceholders(before, twoStep)
    ).filter(
      (row) =>
        twoStep.includes(row.providerIdentifier) && isUnfinishedConnect(row)
    );
    let removed = 0;
    for (const placeholder of stale) {
      try {
        await this.deleteChannel(placeholder.organizationId, placeholder.id);
        removed++;
      } catch (err) {
        Logger.warn(
          `Could not remove placeholder ${placeholder.id} (${placeholder.providerIdentifier}): ${err}`,
          'IntegrationService'
        );
      }
    }
    if (removed) {
      Logger.log(
        `Removed ${removed} unfinished connect placeholder(s) older than ${STALE_PLACEHOLDER_HOURS} h`,
        'IntegrationService'
      );
    }
    return removed;
  }

  async changeActiveCron(orgId: string) {
    const data = await this._autopostsRepository.getAutoposts(orgId);

    for (const item of data.filter((f) => f.active)) {
      try {
        await this._temporalService.terminateWorkflow(`autopost-${item.id}`);
      } catch (err) {}
    }

    return true;
  }

  /**
   * A provider's short name for a sentence: "Instagram" for
   * "Instagram\n(Facebook Business)", "LinkedIn" for "LinkedIn (personal
   * profile)". The identifier itself for one this build does not know.
   */
  providerName(identifier: string): string {
    const name = this._integrationManager.getSocialIntegration(identifier)?.name;
    return (name || identifier).split(/\n| \(/)[0].trim() || identifier;
  }

  getMentions(platform: string, q: string) {
    return this._integrationRepository.getMentions(platform, q);
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    return this._integrationRepository.insertMentions(platform, mentions);
  }

  async setTimes(
    orgId: string,
    integrationId: string,
    times: IntegrationTimeDto
  ) {
    return this._integrationRepository.setTimes(orgId, integrationId, times);
  }

  updateProviderSettings(org: string, id: string, additionalSettings: string) {
    return this._integrationRepository.updateProviderSettings(
      org,
      id,
      additionalSettings
    );
  }

  checkPreviousConnections(org: string, id: string) {
    return this._integrationRepository.checkPreviousConnections(org, id);
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn?: number,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    rootInternalId?: string
  ) {
    const uploadedPicture = picture
      ? picture?.indexOf('imagedelivery.net') > -1
        ? picture
        : await this.storage.uploadSimple(picture).catch((err) => {
            console.log('Failed to upload profile picture:', picture, err);
            return undefined;
          })
      : undefined;

    return this._integrationRepository.createOrUpdateIntegration(
      additionalSettings,
      oneTimeToken,
      org,
      name,
      uploadedPicture,
      type,
      internalId,
      provider,
      token,
      refreshToken,
      expiresIn,
      username,
      isBetweenSteps,
      refresh,
      timezone,
      customInstanceDetails,
      rootInternalId
    );
  }

  updateIntegrationGroup(org: string, id: string, group: string) {
    return this._integrationRepository.updateIntegrationGroup(org, id, group);
  }

  updateOnCustomerName(org: string, id: string, name: string) {
    return this._integrationRepository.updateOnCustomerName(org, id, name);
  }

  getIntegrationsList(org: string) {
    return this._integrationRepository.getIntegrationsList(org);
  }

  getIntegrationForOrder(id: string, order: string, user: string, org: string) {
    return this._integrationRepository.getIntegrationForOrder(
      id,
      order,
      user,
      org
    );
  }

  updateNameAndUrl(id: string, name: string, url: string) {
    return this._integrationRepository.updateNameAndUrl(id, name, url);
  }

  getIntegrationById(org: string, id: string) {
    return this._integrationRepository.getIntegrationById(org, id);
  }

  /**
   * A live channel of `org` by the platform's account id (internalId), the
   * id a reconnect link carries (?refresh=, launches.component.tsx). Removed
   * channels are left out.
   */
  getIntegrationByInternalId(org: string, internalId: string) {
    return this._integrationRepository.getIntegrationByInternalId(
      org,
      internalId
    );
  }

  async refreshToken(provider: SocialProvider, refresh: string) {
    try {
      const { refreshToken, accessToken, expiresIn } =
        await provider.refreshToken(refresh);

      if (!refreshToken || !accessToken || !expiresIn) {
        return false;
      }

      return { refreshToken, accessToken, expiresIn };
    } catch (e) {
      return false;
    }
  }

  async disconnectChannel(orgId: string, integration: Integration, err = '') {
    await this._integrationRepository.disconnectChannel(orgId, integration.id);
    await this.informAboutRefreshError(orgId, integration, err);
  }

  // A reconnect that came back from a different provider (MIGRATE_PROVIDERS):
  // match the disconnected channel by profile and move it to the new provider
  // in place, so scheduled posts, settings and customers survive. Throws the
  // same error as a mismatched reconnect when the migration is not configured
  // or the user connected a different account.
  async migrateIntegration(
    org: string,
    oldInternalId: string,
    newProvider: string,
    auth: { id: string; username: string }
  ) {
    const existing = await this._integrationRepository.getIntegrationByInternalId(
      org,
      oldInternalId
    );

    if (
      !existing ||
      this._integrationManager.getMigrationTarget(
        existing.providerIdentifier
      ) !== newProvider
    ) {
      throw new NotEnoughScopes(
        'Please refresh the channel that needs to be refreshed'
      );
    }

    const oldProvider = this._integrationManager.getSocialIntegration(
      existing.providerIdentifier
    );

    if (!oldProvider.migrationMatch(auth, existing)) {
      throw new NotEnoughScopes(
        `Please connect the same account (@${existing.profile}) that needs to be refreshed`
      );
    }

    if (
      await this._integrationRepository.getIntegrationByInternalId(org, auth.id)
    ) {
      throw new NotEnoughScopes(
        'This account is already connected as another channel, please delete one of them first'
      );
    }

    return this._integrationRepository.migrateIntegration(
      org,
      existing.id,
      auth.id,
      newProvider,
      existing.rootInternalId === existing.internalId
        ? auth.id
        : existing.rootInternalId
    );
  }

  // A fresh connect of a migration target (MIGRATE_PROVIDERS) for an account
  // the org already has on the source provider: adopt that channel instead of
  // creating a confusing duplicate - the channel is migrated in place exactly
  // like a reconnect, and the follow-up upsert stores the fresh tokens. A no-op
  // when nothing matches, so a genuinely new account still creates a channel.
  async migrateIntegrationOnConnect(
    org: string,
    newProvider: string,
    auth: { id: string; username: string }
  ) {
    const sources = this._integrationManager.getMigrationSources(newProvider);
    if (
      !sources.length ||
      this._integrationManager.getSocialIntegration(newProvider).isBetweenSteps
    ) {
      return;
    }

    // the account already exists on the new provider: the normal upsert
    // updates it, nothing to adopt
    if (
      await this._integrationRepository.getIntegrationByInternalId(org, auth.id)
    ) {
      return;
    }

    const existing = (
      await this._integrationRepository.getIntegrationsList(org)
    ).find(
      (p) =>
        sources.includes(p.providerIdentifier) &&
        this._integrationManager
          .getSocialIntegration(p.providerIdentifier)
          .migrationMatch(auth, p)
    );

    if (!existing) {
      return;
    }

    return this._integrationRepository.migrateIntegration(
      org,
      existing.id,
      auth.id,
      newProvider,
      existing.rootInternalId === existing.internalId
        ? auth.id
        : existing.rootInternalId
    );
  }

  async informAboutRefreshError(
    orgId: string,
    integration: Integration,
    err = ''
  ) {
    const provider = String(integration.providerIdentifier || '');
    const platform = provider.charAt(0).toUpperCase() + provider.slice(1);
    await this._notificationService.inAppNotification(
      orgId,
      `Reconnect your ${platform} channel`,
      `We couldn't refresh the connection to your ${platform} channel${
        err ? ` (${err})` : ''
      }, so posts to it will fail until you reconnect it: ${process.env.FRONTEND_URL}/launches`,
      true,
      false,
      'info'
    );
  }

  async refreshNeeded(org: string, id: string) {
    return this._integrationRepository.refreshNeeded(org, id);
  }

  async setBetweenRefreshSteps(id: string) {
    return this._integrationRepository.setBetweenRefreshSteps(id);
  }

  async refreshTokens() {
    const integrations = await this._integrationRepository.needsToBeRefreshed();
    for (const integration of integrations) {
      const provider = this._integrationManager.getSocialIntegration(
        integration.providerIdentifier
      );

      const data = await this.refreshToken(provider, integration.refreshToken!);

      if (!data) {
        await this.informAboutRefreshError(
          integration.organizationId,
          integration
        );
        await this._integrationRepository.refreshNeeded(
          integration.organizationId,
          integration.id
        );
        return;
      }

      const { refreshToken, accessToken, expiresIn } = data;

      await this.createOrUpdateIntegration(
        undefined,
        !!provider.oneTimeToken,
        integration.organizationId,
        integration.name,
        undefined,
        'social',
        integration.internalId,
        integration.providerIdentifier,
        accessToken,
        refreshToken,
        expiresIn
      );
    }
  }

  async disableChannel(org: string, id: string) {
    return this._integrationRepository.disableChannel(org, id);
  }

  async enableChannel(org: string, totalChannels: number, id: string) {
    // An unfinished two-step connect is not a channel (channel.limit.ts).
    const integrations = (
      await this._integrationRepository.getIntegrationsList(org)
    ).filter((f) => !f.disabled && !f.inBetweenSteps);
    if (
      !!process.env.RAZORPAY_KEY_ID &&
      integrations.length >= totalChannels
    ) {
      throw new Error('You have reached the maximum number of channels');
    }

    return this._integrationRepository.enableChannel(org, id);
  }

  async getPostsForChannel(org: string, id: string) {
    return this._integrationRepository.getPostsForChannel(org, id);
  }

  getChannelsConnectedByAccount(providers: string[], accountId: string) {
    return this._integrationRepository.getChannelsConnectedByAccount(
      providers,
      accountId
    );
  }

  eraseRemovedChannelProfile(org: string, id: string) {
    return this._integrationRepository.eraseRemovedChannelProfile(org, id);
  }

  async deleteChannel(org: string, id: string) {
    const deleted = await this._integrationRepository.deleteChannel(org, id);

    // The token-refresh workflow (refreshCron providers) can sleep for weeks
    // with a copy of the tokens in its history, so stop it with the channel.
    // Only those providers run one, so skip the not-found error for the rest.
    if (
      this._integrationManager.getSocialIntegration(deleted.providerIdentifier)
        ?.refreshCron
    ) {
      await this._temporalService.terminateWorkflow(`refresh_${id}`);
    }

    return deleted;
  }

  updateRefreshedTokens(
    org: string,
    internalId: string,
    oneTimeToken: boolean,
    token: string,
    refreshToken?: string,
    expiresIn?: number
  ) {
    return this._integrationRepository.updateRefreshedTokens(
      org,
      internalId,
      oneTimeToken,
      token,
      refreshToken,
      expiresIn
    );
  }

  async disableIntegrations(org: string, totalChannels: number) {
    return this._integrationRepository.disableIntegrations(org, totalChannels);
  }

  async checkForDeletedOnceAndUpdate(org: string, page: string) {
    return this._integrationRepository.checkForDeletedOnceAndUpdate(org, page);
  }

  async saveProviderPage(org: string, id: string, data: any) {
    const getIntegration = await this._integrationRepository.getIntegrationById(
      org,
      id
    );
    if (!getIntegration) {
      throw new HttpException('Integration not found', HttpStatus.NOT_FOUND);
    }
    if (!getIntegration.inBetweenSteps) {
      throw new HttpException('Invalid request', HttpStatus.BAD_REQUEST);
    }

    const provider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (!provider.fetchPageInformation) {
      throw new HttpException(
        'Provider does not support page selection',
        HttpStatus.BAD_REQUEST
      );
    }

    // Support both single selection and multi-selection (batch)
    const itemsToSave: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.pages)
      ? data.pages
      : [data];

    if (!itemsToSave.length) {
      throw new HttpException('No pages selected', HttpStatus.BAD_REQUEST);
    }

    // The allowance below is a read-then-write: count the channels, then save.
    // Two page picks finishing at once in the same workspace (two tabs, or a
    // double submit) would both read the same count and both pass, taking the
    // org past its plan. The TTL grows with the number of pages, since every
    // page costs a platform call and a picture upload: a long pick can't
    // expire and then delete a later pick's lock.
    return this.withChannelLimitLock(
      org,
      30000 + 5000 * itemsToSave.length,
      () =>
        this.saveProviderPageItems(
          org,
          id,
          getIntegration,
          provider,
          itemsToSave
        )
    );
  }

  /**
   * Runs `save` holding the workspace's channel-limit lock, for a count of
   * its channels and the save that relies on it: one at a time per
   * workspace. The lock expires on its own after `ttlMs` if this process dies
   * before releasing it. Each holder owns its lock (a random token) and only
   * deletes a lock it still owns. While another request holds it: 409, and
   * `save` does not run.
   */
  async withChannelLimitLock<T>(
    org: string,
    ttlMs: number,
    save: () => Promise<T>
  ): Promise<T> {
    const lockKey = `channel-limit:${org}`;
    const lockToken = randomUUID();
    const locked = await ioRedis.set(lockKey, lockToken, 'PX', ttlMs, 'NX');
    if (locked !== 'OK') {
      throw new HttpException(
        'Another channel is being added. Try again in a moment.',
        HttpStatus.CONFLICT
      );
    }

    try {
      return await save();
    } finally {
      // A failed release must not turn a finished save into an error; the
      // lock then expires by itself.
      await ioRedis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
          1,
          lockKey,
          lockToken
        )
        .catch((err) => {
          console.warn('Could not release the channel-limit lock:', err);
        });
    }
  }

  /**
   * PRE_TRIAL_CHANNEL_LIMIT while the workspace has to start its trial
   * (needs_trial, trial.policy.ts), else null. Read here and not through
   * SubscriptionService.getPlanState, which this service cannot inject (it
   * injects this one), with the same facts and the same rule. Null without
   * billing, while no trial cutoff is set, and when the workspace cannot be
   * read: then the plan's own allowance applies, as before.
   */
  async preTrialChannelLimit(
    org: string,
    hints: Pick<CountryHints, 'requestCountry' | 'tz'> = {}
  ): Promise<number | null> {
    if (!process.env.RAZORPAY_KEY_ID && !process.env.RAZORPAY_KEY_SECRET) {
      return null;
    }
    const cutoffs = trialCutoffs();
    if (!trialPolicyActive(cutoffs)) return null;
    const facts = await this._subscriptionRepository
      .getPlanFacts(org)
      .catch(() => null);
    if (!facts) return null;
    return preTrialChannelLimit(
      planState(policyOrgFromFacts(facts, hints), cutoffs)
    );
  }

  /**
   * Refuses (PreTrialChannelLimitError, 402 TRIAL_REQUIRED) a connect that
   * would take a needs_trial workspace past `limit` channels. `accountIds`
   * are the internal ids the connect writes to: one the workspace already
   * has a live row for is that channel again (a reconnect, or the same
   * account connected twice), which createOrUpdateIntegration updates in
   * place, so it adds nothing. A removed channel's row counts as new. Call it
   * inside withChannelLimitLock, right before the save.
   */
  async assertPreTrialChannelRoom(
    org: string,
    limit: number,
    accountIds: string[]
  ) {
    for (const accountId of accountIds.filter(Boolean)) {
      if (
        await this._integrationRepository.getIntegrationByInternalId(
          org,
          accountId
        )
      ) {
        return;
      }
    }
    const used = (await this.getIntegrationsList(org)).filter(
      countsTowardChannelLimit
    ).length;
    if (used >= limit) {
      throw new PreTrialChannelLimitError(await this.trialDaysOf(org));
    }
  }

  /**
   * The workspace's trial length, as SubscriptionService.trialDaysFor reads
   * it (7 for a workspace the Free plan sunset notice promised 7 to), for
   * the refusal's message and its dialog's button.
   */
  private async trialDaysOf(org: string): Promise<number> {
    const promised = await this._subscriptionRepository
      .sunsetNoticePromisedTrial(org)
      .catch(() => false);
    return trialDaysFor({ sunsetNoticePromised: promised });
  }

  private async saveProviderPageItems(
    org: string,
    id: string,
    getIntegration: Integration,
    provider: SocialProvider,
    itemsToSave: any[]
  ) {
    // The @CheckPolicies guard asks "is there room for ONE more channel?" once,
    // at request time (permissions.service.ts:83-93). That was sound while one
    // request created one channel. A batch creates N, so a Free org with one
    // channel and an allowance of two passed the guard and could then create
    // twenty. The public route below has no policy guard at all, so it never
    // even got that check. Enforce the real remaining allowance here, where the
    // creation actually happens and both routes pass through. (PoliciesGuard
    // also returns early for every /integrations/provider path, so in practice
    // this is the only limit check on this step.)
    //
    // A workspace that has to start its trial gets PRE_TRIAL_CHANNEL_LIMIT,
    // not the Free plan's two: it has no plan, and without this a Facebook
    // login picking two Pages would be its way past the limit.
    const preTrialLimit = await this.preTrialChannelLimit(org);
    const subscription =
      preTrialLimit === null
        ? await this._subscriptionRepository.getSubscriptionByOrganizationId(
            org
          )
        : null;
    const allowance =
      preTrialLimit ?? subscription?.totalChannels ?? pricing.FREE.channel;
    // Not counting placeholders, this one included: it is the row the first
    // selected item turns into a channel below, so counting it made the last
    // slot unusable (channel.limit.ts).
    const used = (await this.getIntegrationsList(org)).filter(
      countsTowardChannelLimit
    ).length;
    const remaining = Math.max(0, allowance - used);

    if (itemsToSave.length > remaining) {
      if (preTrialLimit !== null) {
        throw new PreTrialChannelLimitError(await this.trialDaysOf(org));
      }
      // Reject rather than silently connecting the first `remaining` of them.
      // Quietly saving 2 of the 20 pages someone selected is the same kind of
      // lie as reporting a count that never happened.
      throw new HttpException(
        `Your plan allows ${allowance} channels and ${used} are in use, so you can add ${remaining} more. You selected ${itemsToSave.length}.`,
        HttpStatus.PAYMENT_REQUIRED
      );
    }

    const [firstItem, ...restItems] = itemsToSave;

    // The account that signed in (a Facebook user, a LinkedIn member...). The
    // first page takes over this row and keeps it as its root id; every other
    // page must carry it too, as a single-page connect always did: token
    // refreshes reach siblings through it, and a platform's data-deletion
    // callback names this account, not the pages.
    const rootInternalId =
      getIntegration.rootInternalId || getIntegration.internalId;

    const getIntegrationInformation = await provider.fetchPageInformation(
      getIntegration.token,
      firstItem
    );

    await this.checkForDeletedOnceAndUpdate(
      org,
      String(getIntegrationInformation.id)
    );
    await this._integrationRepository.updateIntegration(id, {
      picture: getIntegrationInformation.picture,
      internalId: String(getIntegrationInformation.id),
      organizationId: org,
      name: getIntegrationInformation.name,
      inBetweenSteps: false,
      token: getIntegrationInformation.access_token,
      profile: getIntegrationInformation.username,
    });

    // firstItem above is already saved at this point.
    let saved = 1;
    const failed: string[] = [];

    for (const item of restItems) {
      try {
        const itemInfo = await provider.fetchPageInformation(
          getIntegration.token,
          item
        );

        await this.checkForDeletedOnceAndUpdate(
          org,
          String(itemInfo.id)
        );

        await this.createOrUpdateIntegration(
          getIntegration.additionalSettings
            ? JSON.parse(getIntegration.additionalSettings)
            : undefined,
          false,
          org,
          itemInfo.name,
          itemInfo.picture,
          getIntegration.type as 'article' | 'social',
          String(itemInfo.id),
          getIntegration.providerIdentifier,
          itemInfo.access_token,
          getIntegration.refreshToken,
          getIntegration.tokenExpiration
            ? Math.floor(
                (new Date(getIntegration.tokenExpiration).getTime() -
                  Date.now()) /
                  1000
              )
            : undefined,
          itemInfo.username,
          false,
          undefined,
          undefined,
          undefined,
          rootInternalId
        );
        saved++;
      } catch (err) {
        // firstItem is processed outside this loop, so its failure propagates
        // and the request errors; items 2..N used to fail silently while the
        // response still claimed every one succeeded. Report them instead.
        failed.push(String((item as any)?.page ?? (item as any)?.id ?? 'unknown'));
        console.error('Failed saving additional provider item:', item, err);
      }
    }

    if (preTrialLimit !== null) {
      // The two-step half of the funnel event (the one-step half is logged by
      // the OAuth callback): a channel saved before the trial started.
      logConnect('channel_connected_pre_trial', {
        provider: getIntegration.providerIdentifier,
        orgId: org,
        channelId: id,
        step: 'page_picked',
      });
    }

    return { success: failed.length === 0, count: saved, failed };
  }

  async checkAnalytics(
    org: Organization,
    integration: string,
    date: string,
    forceRefresh = false
  ): Promise<AnalyticsData[]> {
    const getIntegration = await this.getIntegrationById(org.id, integration);

    // A removed channel reads no more data from its platform.
    if (!getIntegration || getIntegration.deletedAt) {
      throw new Error('Invalid integration');
    }

    if (getIntegration.type !== 'social') {
      return [];
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    if (
      dayjs(getIntegration?.tokenExpiration).isBefore(dayjs()) ||
      forceRefresh
    ) {
      const data = await this._refreshIntegrationService.refresh(
        getIntegration
      );
      if (!data) {
        return [];
      }

      const { accessToken } = data;

      if (accessToken) {
        getIntegration.token = accessToken;

        if (integrationProvider.refreshWait) {
          await timer(10000);
        }
      } else {
        await this.disconnectChannel(org.id, getIntegration);
        return [];
      }
    }

    const getIntegrationData = await ioRedis.get(
      `integration:${org.id}:${integration}:${date}`
    );
    if (getIntegrationData) {
      return JSON.parse(getIntegrationData);
    }

    if (integrationProvider.analytics) {
      try {
        const loadAnalytics = await integrationProvider.analytics(
          getIntegration.internalId,
          getIntegration.token,
          +date
        );
        await ioRedis.set(
          `integration:${org.id}:${integration}:${date}`,
          JSON.stringify(loadAnalytics),
          'EX',
          !process.env.NODE_ENV || process.env.NODE_ENV === 'development'
            ? 1
            : 3600
        );
        return loadAnalytics;
      } catch (e) {
        if (e instanceof RefreshToken) {
          return this.checkAnalytics(org, integration, date, true);
        }
      }
    }

    return [];
  }

  customers(orgId: string) {
    return this._integrationRepository.customers(orgId);
  }

  getPlugsByIntegrationId(org: string, integrationId: string) {
    return this._integrationRepository.getPlugsByIntegrationId(
      org,
      integrationId
    );
  }

  /**
   * `guard` wraps the provider's plug call (the orchestrator passes
   * XPostCapService.guardPlug, which holds X plugs to the plan's X caps):
   * `text` is what the plug would post, '' for a repost.
   */
  async processInternalPlug(
    data: {
      post: string;
      originalIntegration: string;
      integration: string;
      plugName: string;
      orgId: string;
      delay: number;
      information: any;
    },
    forceRefresh = false,
    guard: PlugGuard = (_i, _t, run) => run()
  ): Promise<any> {
    const originalIntegration =
      await this._integrationRepository.getIntegrationById(
        data.orgId,
        data.originalIntegration
      );

    const getIntegration = await this._integrationRepository.getIntegrationById(
      data.orgId,
      data.integration
    );

    if (!getIntegration || !originalIntegration) {
      return;
    }

    const getAllInternalPlugs = this._integrationManager
      .getInternalPlugs(getIntegration.providerIdentifier)
      .internalPlugs.find((p: any) => p.identifier === data.plugName);

    if (!getAllInternalPlugs) {
      return;
    }

    const getSocialIntegration = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );

    await guard(getIntegration, '', async () =>
      // @ts-ignore
      getSocialIntegration?.[getAllInternalPlugs.methodName]?.(
        getIntegration,
        originalIntegration,
        data.post,
        data.information
      )
    );

    return;
  }

  async processPlugs(
    data: {
      plugId: string;
      postId: string;
      delay: number;
      totalRuns: number;
      currentRun: number;
    },
    guard: PlugGuard = (_i, _t, run) => run()
  ) {
    const getPlugById = await this._integrationRepository.getPlug(data.plugId);
    if (!getPlugById) {
      return true;
    }

    const integration = this._integrationManager.getSocialIntegration(
      getPlugById.integration.providerIdentifier
    );

    const fields = JSON.parse(getPlugById.data).reduce(
      (all: any, current: any) => {
        all[current.name] = current.value;
        return all;
      },
      {}
    );
    const process = await guard(
      getPlugById.integration,
      typeof fields.post === 'string' ? fields.post : '',
      () =>
        // @ts-ignore
        integration[getPlugById.plugFunction](
          getPlugById.integration,
          data.postId,
          fields
        )
    );

    if (process) {
      return true;
    }

    if (data.totalRuns === data.currentRun) {
      return true;
    }

    return false;
  }

  async createOrUpdatePlug(
    orgId: string,
    integrationId: string,
    body: PlugDto
  ) {
    const { activated } = await this._integrationRepository.createOrUpdatePlug(
      orgId,
      integrationId,
      body
    );

    return {
      activated,
    };
  }

  async changePlugActivation(orgId: string, plugId: string, status: boolean) {
    const { id, integrationId, plugFunction } =
      await this._integrationRepository.changePlugActivation(
        orgId,
        plugId,
        status
      );

    return { id };
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._integrationRepository.getPlugs(orgId, integrationId);
  }

  async loadExisingData(
    methodName: string,
    integrationId: string,
    id: string[]
  ) {
    const exisingData = await this._integrationRepository.loadExisingData(
      methodName,
      integrationId,
      id
    );
    const loadOnlyIds = exisingData.map((p) => p.value);
    return difference(id, loadOnlyIds);
  }

  async findFreeDateTime(
    orgId: string,
    integrationsId?: string
  ): Promise<number[]> {
    const findTimes = await this._integrationRepository.getPostingTimes(
      orgId,
      integrationsId
    );
    return uniq(
      findTimes.reduce((all: any, current: any) => {
        return [
          ...all,
          ...JSON.parse(current.postingTimes).map(
            (p: { time: number }) => p.time
          ),
        ];
      }, [] as number[])
    );
  }
}
