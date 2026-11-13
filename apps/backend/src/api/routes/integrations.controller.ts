import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { GetOrgFromRequest } from '@hookpost/nestjs-libraries/user/org.from.request';
import { Organization, User } from '@prisma/client';
import { IntegrationFunctionDto } from '@hookpost/nestjs-libraries/dtos/integrations/integration.function.dto';
import { CheckPolicies } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { ApiTags } from '@nestjs/swagger';
import { GetUserFromRequest } from '@hookpost/nestjs-libraries/user/user.from.request';
import { PostsService } from '@hookpost/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationTimeDto } from '@hookpost/nestjs-libraries/dtos/integrations/integration.time.dto';
import { PlugDto } from '@hookpost/nestjs-libraries/dtos/plugs/plug.dto';
import {
  Disconnect,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

import { timer } from '@hookpost/helpers/utils/timer';
import { TelegramProvider } from '@hookpost/nestjs-libraries/integrations/social/telegram.provider';
import { MoltbookProvider } from '@hookpost/nestjs-libraries/integrations/social/moltbook.provider';
import {
  AuthorizationActions,
  Sections,
  SubscriptionException,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { uniqBy } from 'lodash';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { logConnect } from '@hookpost/nestjs-libraries/integrations/connect.log';

/**
 * The provider functions a page picker calls to list what a two-step login
 * can connect (the same two completeConnect reads after the login).
 */
const PAGE_LIST_FUNCTIONS = ['pages', 'companies'];

@ApiTags('Integrations')
@Controller('/integrations')
export class IntegrationsController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _postService: PostsService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _subscriptionService: SubscriptionService
  ) {}

  @Post('/provider/:id/connect')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async saveProviderPage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: any
  ) {
    try {
      const saved = await this._integrationService.saveProviderPage(
        org.id,
        id,
        body
      );
      logConnect('connect_ok', {
        orgId: org.id,
        channelId: id,
        step: 'page_picked',
      });
      return saved;
    } catch (err) {
      logConnect('connect_failed', {
        orgId: org.id,
        channelId: id,
        step: 'page_pick',
        reason: err,
      });
      throw err;
    }
  }

  @Get('/:identifier/internal-plugs')
  getInternalPlugs(@Param('identifier') identifier: string) {
    return this._integrationManager.getInternalPlugs(identifier);
  }

  @Get('/customers')
  getCustomers(@GetOrgFromRequest() org: Organization) {
    return this._integrationService.customers(org.id);
  }

  @Put('/:id/group')
  async updateIntegrationGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { group: string }
  ) {
    return this._integrationService.updateIntegrationGroup(
      org.id,
      id,
      body.group
    );
  }

  @Put('/:id/customer-name')
  async updateOnCustomerName(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name: string }
  ) {
    return this._integrationService.updateOnCustomerName(org.id, id, body.name);
  }

  @Get('/list')
  async getIntegrationList(@GetOrgFromRequest() org: Organization) {
    return {
      integrations: await Promise.all(
        (
          await this._integrationService.getIntegrationsList(org.id)
        ).map(async (p) => {
          const findIntegration = this._integrationManager.getSocialIntegration(
            p.providerIdentifier
          );
          return {
            name: p.name,
            id: p.id,
            internalId: p.internalId,
            disabled: p.disabled,
            editor: findIntegration.editor,
            stripLinks: !!findIntegration?.stripLinks?.(),
            picture: p.picture || '/no-picture.jpg',
            identifier: p.providerIdentifier,
            inBetweenSteps: p.inBetweenSteps,
            refreshNeeded: p.refreshNeeded,
            isCustomFields: !!findIntegration.customFields,
            ...(findIntegration.customFields
              ? { customFields: await findIntegration.customFields() }
              : {}),
            display: p.profile,
            type: p.type,
            time: (() => {
              try {
                return JSON.parse(p.postingTimes || '[]');
              } catch {
                return [{ time: 230 }, { time: 520 }, { time: 810 }];
              }
            })(),
            changeProfilePicture: !!findIntegration?.changeProfilePicture,
            changeNickName: !!findIntegration?.changeNickname,
            customer: p.customer,
            additionalSettings: p.additionalSettings || '[]',
          };
        })
      ),
    };
  }

  @Post('/:id/settings')
  async updateProviderSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('additionalSettings') body: string
  ) {
    if (typeof body !== 'string') {
      throw new Error('Invalid body');
    }

    await this._integrationService.updateProviderSettings(org.id, id, body);
  }
  // Changes the profile on the platform itself (Sections.PLAN_ACCESS).
  @Post('/:id/nickname')
  @CheckPolicies([AuthorizationActions.Update, Sections.PLAN_ACCESS])
  async setNickname(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name: string; picture: string }
  ) {
    const integration = await this._integrationService.getIntegrationById(
      org.id,
      id
    );
    if (!integration) {
      throw new Error('Invalid integration');
    }

    const manager = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );
    if (!manager.changeProfilePicture && !manager.changeNickname) {
      throw new Error('Invalid integration');
    }

    const { url } = manager.changeProfilePicture
      ? await manager.changeProfilePicture(
          integration.internalId,
          integration.token,
          body.picture
        )
      : { url: '' };

    const { name } = manager.changeNickname
      ? await manager.changeNickname(
          integration.internalId,
          integration.token,
          body.name
        )
      : { name: '' };

    return this._integrationService.updateNameAndUrl(id, name, url);
  }

  @Get('/:id')
  getSingleIntegration(
    @Param('id') id: string,
    @Query('order') order: string,
    @GetUserFromRequest() user: User,
    @GetOrgFromRequest() org: Organization
  ) {
    return this._integrationService.getIntegrationForOrder(
      id,
      order,
      user.id,
      org.id
    );
  }

  @Get('/social/:integration')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  async getIntegrationUrl(
    @Param('integration') integration: string,
    @Query('refresh') refresh: string,
    @Query('externalUrl') externalUrl: string,
    @Query('redirectUrl') redirectUrl: string,
    @Query('onboarding') onboarding: string,
    @GetOrgFromRequest() org: Organization
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new Error('Integration not allowed');
    }

    // X bills per post: a workspace whose plan is cancelling cannot connect
    // it (allowsXPublishing). Read from the database, not from `org`: the
    // request's organization carries no cancelAt and no platform admin flag.
    if (
      (integration === 'x' || integration === 'twitter') &&
      !(await this._subscriptionService.allowsXPublishing(org.id))
    ) {
      throw new SubscriptionException({
        action: AuthorizationActions.Create,
        section: Sections.CHANNEL,
        // While a payment is failing X is paused, not over the plan's limit.
        ...((await this._subscriptionService.isPaymentFailing(org.id))
          ? { paymentFailing: true }
          : {}),
      });
    }

    // A provider migrated via MIGRATE_PROVIDERS reconnects through its target
    // provider's OAuth: the callback lands on the target and the channel is
    // migrated in place (see migrateIntegration).
    const migrateTo = refresh
      ? this._integrationManager.getMigrationTarget(integration)
      : undefined;

    const integrationProvider = this._integrationManager.getSocialIntegration(
      migrateTo || integration
    );

    if (integrationProvider.externalUrl && !externalUrl) {
      throw new Error('Missing external url');
    }

    try {
      const getExternalUrl = integrationProvider.externalUrl
        ? {
            ...(await integrationProvider.externalUrl(externalUrl)),
            instanceUrl: externalUrl,
          }
        : undefined;

      const { codeVerifier, state, url } =
        await integrationProvider.generateAuthUrl(getExternalUrl);

      if (refresh) {
        await ioRedis.set(`refresh:${state}`, refresh, 'EX', 3600);
      }

      if (onboarding === 'true') {
        await ioRedis.set(`onboarding:${state}`, 'true', 'EX', 3600);
      }

      if (redirectUrl) {
        await ioRedis.set(`redirect:${state}`, redirectUrl, 'EX', 3600);
      }

      await ioRedis.set(`organization:${state}`, org.id, 'EX', 3600);
      await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);
      // The callback must come back to this provider (see completeConnect).
      await ioRedis.set(`provider:${state}`, migrateTo || integration, 'EX', 3600);
      await ioRedis.set(
        `external:${state}`,
        JSON.stringify(getExternalUrl),
        'EX',
        3600
      );

      logConnect('connect_start', {
        provider: integration,
        orgId: org.id,
        reconnect: !!refresh,
        onboarding: onboarding === 'true',
      });

      return { url };
    } catch (err) {
      // The page only says "Could not connect to the platform"; this was
      // the one place that kept no trace of why.
      logConnect('connect_failed', {
        provider: integration,
        orgId: org.id,
        step: 'auth_url',
        reason: err,
      });
      return { err: true };
    }
  }

  @Post('/:id/time')
  async setTime(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: IntegrationTimeDto
  ) {
    return this._integrationService.setTimes(org.id, id, body);
  }

  // A composer helper that searches the platform (X bills per lookup), so
  // not before the trial (Sections.PLAN_ACCESS).
  @Post('/mentions')
  @CheckPolicies([AuthorizationActions.Read, Sections.PLAN_ACCESS])
  async mentions(
    @GetOrgFromRequest() org: Organization,
    @Body() body: IntegrationFunctionDto
  ) {
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      body.id
    );
    if (!getIntegration) {
      throw new Error('Invalid integration');
    }

    let newList: any[] | { none: true } = [];
    try {
      newList = (await this.functionIntegration(org, body)) || [];
    } catch (err) {
      console.log(err);
    }

    if (!Array.isArray(newList) && newList?.none) {
      return newList;
    }

    const list = await this._integrationService.getMentions(
      getIntegration.providerIdentifier,
      body?.data?.query
    );

    if (Array.isArray(newList) && newList.length) {
      await this._integrationService.insertMentions(
        getIntegration.providerIdentifier,
        newList
          .map((p: any) => ({
            name: p.label || '',
            username: p.id || '',
            image: p.image || '',
            doNotCache: p.doNotCache || false,
          }))
          .filter((f: any) => f.name && !f.doNotCache)
      );
    }

    return uniqBy(
      [
        ...list.map((p) => ({
          id: p.username,
          image: p.image,
          label: p.name,
        })),
        ...(newList as any[]),
      ],
      (p) => p.id
    ).filter((f) => f.label && f.id);
  }

  @Post('/function')
  async functionIntegration(
    @GetOrgFromRequest() org: Organization,
    @Body() body: IntegrationFunctionDto
  ): Promise<any> {
    const getIntegration = await this._integrationService.getIntegrationById(
      org.id,
      body.id
    );
    // A removed channel makes no more calls to its platform.
    if (!getIntegration || getIntegration.deletedAt) {
      throw new Error('Invalid integration');
    }

    // Before the trial (or a plan, once it is used) the only call a
    // workspace may make to a platform is the one its page picker needs to
    // finish a two-step connect: the page list of the login it just made,
    // through the same two names completeConnect calls. This route calls any
    // method of the provider by name, and the workspace may hold a real
    // channel before its trial (PRE_TRIAL_CHANNEL_LIMIT).
    if (
      !(
        getIntegration.inBetweenSteps &&
        PAGE_LIST_FUNCTIONS.includes(body.name)
      )
    ) {
      await this.refuseBlockedPlan(org.id);
    }

    const integrationProvider = this._integrationManager.getSocialIntegration(
      getIntegration.providerIdentifier
    );
    if (!integrationProvider) {
      throw new Error('Invalid provider');
    }

    // @ts-ignore
    if (integrationProvider[body.name]) {
      try {
        // @ts-ignore
        const load = await integrationProvider[body.name](
          getIntegration.token,
          body.data,
          getIntegration.internalId,
          getIntegration
        );

        return load;
      } catch (err) {
        // The platform will keep rejecting this channel until the user
        // re-connects it: mark it as needing a refresh instead of retrying.
        if (err instanceof Disconnect) {
          await this._integrationService.disconnectChannel(
            org.id,
            getIntegration
          );
          return false;
        }

        if (err instanceof RefreshToken) {
          const data = await this._refreshIntegrationService.refresh(
            getIntegration
          );

          if (!data) {
            return;
          }

          const { accessToken } = data;

          if (accessToken) {
            if (integrationProvider.refreshWait) {
              await timer(10000);
            }
            return this.functionIntegration(org, body);
          }

          return false;
        }

        return false;
      }
    }
    throw new Error('Function not found');
  }

  @Post('/disable')
  disableChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    return this._integrationService.disableChannel(org.id, id);
  }

  @Post('/enable')
  enableChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    return this._integrationService.enableChannel(
      org.id,
      // @ts-ignore
      org?.subscription?.totalChannels || pricing.FREE.channel,
      id
    );
  }

  @Delete('/')
  async deleteChannel(
    @GetOrgFromRequest() org: Organization,
    @Body('id') id: string
  ) {
    const isTherePosts = await this._integrationService.getPostsForChannel(
      org.id,
      id
    );
    if (isTherePosts.length) {
      for (const post of isTherePosts) {
        this._postService.deletePost(org.id, post.group).catch((err) => {});
      }
    }

    return this._integrationService.deleteChannel(org.id, id);
  }

  @Get('/plug/list')
  async getPlugList() {
    return { plugs: this._integrationManager.getAllPlugs() };
  }

  @Get('/:id/plugs')
  async getPlugsByIntegrationId(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization
  ) {
    return this._integrationService.getPlugsByIntegrationId(org.id, id);
  }

  // Plugs act on the platform for the channel's posts (Sections.PLAN_ACCESS).
  @Post('/:id/plugs')
  @CheckPolicies([AuthorizationActions.Create, Sections.PLAN_ACCESS])
  async postPlugsByIntegrationId(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization,
    @Body() body: PlugDto
  ) {
    return this._integrationService.createOrUpdatePlug(org.id, id, body);
  }

  @Put('/plugs/:id/activate')
  @CheckPolicies([AuthorizationActions.Update, Sections.PLAN_ACCESS])
  async changePlugActivation(
    @Param('id') id: string,
    @GetOrgFromRequest() org: Organization,
    @Body('status') status: boolean
  ) {
    return this._integrationService.changePlugActivation(org.id, id, status);
  }

  @Get('/telegram/updates')
  async getUpdates(@Query() query: { word: string; id?: number }) {
    return new TelegramProvider().getBotId(query);
  }

  @Post('/moltbook/register')
  async moltbookRegister(@Body() body: { name: string; description: string }) {
    try {
      const provider = new MoltbookProvider();
      const result = await provider.registerAgent(body.name, body.description);
      return {
        apiKey: result.api_key,
        claimUrl: result.claim_url,
        verificationCode: result.verification_code,
      };
    } catch (err: any) {
      return { error: err.message || 'Registration failed' };
    }
  }

  // POST so the agent's API key travels in the body: as a GET query string it
  // was written to every proxy access log on each 3-second poll.
  @Post('/moltbook/status')
  async moltbookStatus(@Body('apiKey') apiKey: string) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return { claimed: false, error: 'Paste the API key of your Moltbook agent' };
    }

    try {
      return await new MoltbookProvider().checkAgentStatus(apiKey.trim());
    } catch (err) {
      return { claimed: false };
    }
  }

  /**
   * The trial gate's 402 (TRIAL_REQUIRED or PLAN_REQUIRED, trial.policy.ts)
   * for a route that decides it from its body, which @CheckPolicies cannot
   * see. Does nothing for every other workspace.
   */
  private async refuseBlockedPlan(orgId: string) {
    const gate = await this._subscriptionService.planGate(orgId);
    if (!gate) {
      return;
    }
    throw new SubscriptionException({
      action: AuthorizationActions.Read,
      section: Sections.PLAN_ACCESS,
      code: gate,
      ...(gate === 'TRIAL_REQUIRED'
        ? {
            trialDays: await this._subscriptionService
              .trialDaysFor(orgId)
              .catch(() => undefined),
          }
        : {}),
    });
  }
}
