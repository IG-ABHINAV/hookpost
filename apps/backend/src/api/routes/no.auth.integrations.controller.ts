import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  UseFilters,
} from '@nestjs/common';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import {
  ConnectHandoffDto,
  ConnectIntegrationDto,
} from '@hookpost/nestjs-libraries/dtos/integrations/connect.integration.dto';
import {
  storeConnectHandoff,
  takeConnectHandoff,
} from '@hookpost/nestjs-libraries/integrations/connect.handoff';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import { CheckPolicies } from '@hookpost/backend/services/auth/permissions/permissions.ability';
import { ApiTags } from '@nestjs/swagger';
import { NotEnoughScopesFilter } from '@hookpost/nestjs-libraries/integrations/integration.missing.scopes';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { signEnterpriseWebhook } from '@hookpost/backend/services/auth/enterprise.token';
import { AuthTokenDetails } from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { NotEnoughScopes } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import {
  AuthorizationActions,
  Sections,
} from '@hookpost/backend/services/auth/permissions/permission.exception.class';
import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';
import { OrganizationService } from '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service';
import { getSsrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import {
  connectFailureReason,
  logConnect,
  redactSecrets,
} from '@hookpost/nestjs-libraries/integrations/connect.log';
import { MARKETPLACE_CONNECT_KEY } from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';


// The connect's state lives in Redis for an hour and is used up by the first
// callback, so a reload of the callback page, the back button, or a link
// opened late lands here. That was a plain Error, a 500, and the page said
// "Could not add provider: Internal server error". The message shows on our
// own callback page, which then returns to the calendar.
export const CONNECT_LINK_EXPIRED =
  'This connect link was already used or has expired. Add the channel again from Add Channel.';

/**
 * What a finished connect leaves behind for its own state, for as long as the
 * state itself lives. The first trial customer pressed Back after connecting
 * YouTube on 21 Oct, which re-sent the spent code three times, and each time
 * was told the link was used up although the channel had connected fine.
 * With this, a repeat of a connect that already succeeded answers with that
 * channel instead of an error.
 */
interface FinishedConnect {
  orgId: string;
  integrationId: string;
  provider: string;
  onboarding: boolean;
  reconnected: boolean;
  returnURL?: string;
  marketplace?: boolean;
}
const FINISHED_CONNECT_TTL_SECONDS = 3600;

/**
 * "user_denied" for a Cancel or Deny on the consent screen, otherwise the
 * provider's error code ("provider_error: invalid_scope"). Only a short
 * code-shaped value reaches the log.
 */
export const connectCancelReason = (reason: unknown): string => {
  const code =
    typeof reason === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(reason)
      ? reason.toLowerCase()
      : '';
  return !code || code === 'user_denied'
    ? 'user_denied'
    : `provider_error: ${code}`;
};
const finishedConnectKey = (state: string) => `connected:${state}`;

@ApiTags('Integrations')
@Controller('/integrations')
export class NoAuthIntegrationsController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _organizationService: OrganizationService
  ) {}

  @Get('/')
  getIntegrations() {
    return this._integrationManager.getAllIntegrations();
  }

  @Post('/social-connect/:integration')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  @UseFilters(new NotEnoughScopesFilter())
  async connectSocialMedia(
    @Param('integration') integration: string,
    @Body() body: ConnectIntegrationDto
  ) {
    // Filled in once the state names the workspace, for the log line.
    const attempt: { orgId?: string } = {};
    try {
      return await this.completeConnect(integration, body, attempt);
    } catch (err) {
      logConnect('connect_failed', {
        provider: integration,
        orgId: attempt.orgId ?? null,
        reason: err,
      });
      throw err;
    }
  }

  /**
   * The provider sent the person back without a code: they pressed Cancel or
   * Deny on its consent screen (?error=access_denied, X's ?denied=), or the
   * provider refused the request. The callback page says so itself and calls
   * this only so the log has a connect_failed line: posting the code-less
   * callback to social-connect was a 400 from the ValidationPipe, before any
   * log line (22 Oct, org d4ad9404, Instagram).
   */
  @Post('/social-connect/:integration/cancelled')
  @HttpCode(204)
  async connectCancelled(
    @Param('integration') integration: string,
    @Body() body: { state?: unknown; reason?: unknown }
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      return;
    }
    const state =
      typeof body?.state === 'string' && body.state.length <= 512
        ? body.state
        : '';
    const orgId = state
      ? await ioRedis.get(`organization:${state}`).catch(() => null)
      : null;
    logConnect('connect_failed', {
      provider: integration,
      orgId: orgId ?? null,
      reason: connectCancelReason(body?.reason),
    });
  }

  /**
   * The Add Channel page hands over a channel's credentials here (custom
   * fields, the Skool cookies from the Chrome extension, or a web3
   * provider's code, which for Moltbook is the agent's permanent API key)
   * and gets a one-time id for the callback URL, so the credentials are
   * never in a URL: that page loads the Meta pixel, GTM, Sentry, Plausible
   * and Dub, which all read it, and it lands in the request logs. Only for a
   * live connect state, and only for the providers whose code the page
   * itself holds; an OAuth code comes from the provider's own redirect. See
   * connect.handoff.ts.
   */
  @Post('/social-connect/:integration/handoff')
  @HttpCode(200)
  async connectHandoff(
    @Param('integration') integration: string,
    @Body() body: ConnectHandoffDto
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new HttpException('Integration not allowed', 400);
    }
    const integrationProvider =
      this._integrationManager.getSocialIntegration(integration);
    if (
      !integrationProvider?.customFields &&
      !integrationProvider?.isChromeExtension &&
      !integrationProvider?.isWeb3
    ) {
      throw new HttpException(
        'This channel connects through its own sign-in page',
        400
      );
    }
    // A state that is live, not used yet, and made for this provider.
    if (
      !(await ioRedis.get(`organization:${body.state}`)) ||
      !(await ioRedis.get(`login:${body.state}`)) ||
      !(await this.stateIsFor(integration, body.state))
    ) {
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }
    const handoff = await storeConnectHandoff(ioRedis, {
      state: body.state,
      provider: integration,
      code: body.code,
    });
    if (!handoff) {
      throw new HttpException(
        'Too many attempts for this connect. Add the channel again from Add Channel.',
        429
      );
    }
    return { handoff };
  }

  /**
   * Whether the state was made for this provider. A state used to be good
   * for any provider: one from a YouTube connect, still in Redis for its
   * hour, was enough to add someone else's Bluesky account (custom fields
   * check no login verifier) to that workspace. A state made before the
   * provider was recorded has none and is let through until it expires.
   */
  private async stateIsFor(integration: string, state: string) {
    const provider = await ioRedis.get(`provider:${state}`).catch(() => null);
    return !provider || provider === integration;
  }

  /**
   * The code to authenticate with: the one in the body, or the credentials
   * a handoff holds (redeemed once, and only for its own state and
   * provider). Null when there is neither: a used or expired handoff, or a
   * reload of the callback page after its URL lost the code.
   */
  private async connectCode(
    integration: string,
    body: ConnectIntegrationDto
  ): Promise<string | null> {
    if (body.handoff === undefined) {
      return body.code || null;
    }
    if (body.code) {
      throw new HttpException('Send the code or a handoff, not both', 400);
    }
    const handoff = await takeConnectHandoff(ioRedis, body.handoff);
    if (
      !handoff ||
      handoff.state !== body.state ||
      handoff.provider !== integration
    ) {
      return null;
    }
    return handoff.code;
  }

  private async completeConnect(
    integration: string,
    body: ConnectIntegrationDto,
    attempt: { orgId?: string }
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new Error('Integration not allowed');
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(integration);

    // Nothing to authenticate with: the connect already finished (a reload
    // or Back) or its link is spent. Decided before any connect state is
    // read or used up.
    const code = await this.connectCode(integration, body);
    if (!code) {
      const finished = await this.finishedConnect(integration, body.state);
      if (finished) {
        return finished;
      }
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }

    // Every state is used up by its first attempt, custom fields included:
    // they take no verifier, so theirs stayed good for the whole hour, and
    // anyone who saw the callback URL (the state is still in it) could send
    // it again with their own credentials and add their account to this
    // workspace. The form asks for a new state on every submit. Read and
    // removed in one step (GETDEL), so two requests at once cannot both use
    // it; a state for another provider is refused before it is touched.
    const forThisProvider = await this.stateIsFor(integration, body.state);
    const loginVerifier = forThisProvider
      ? await ioRedis.getdel(`login:${body.state}`)
      : null;
    const getCodeVerifier =
      loginVerifier && integrationProvider.customFields ? 'none' : loginVerifier;
    if (!getCodeVerifier) {
      const finished = await this.finishedConnect(integration, body.state);
      if (finished) {
        return finished;
      }
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }

    const organization = await ioRedis.get(`organization:${body.state}`);
    if (!organization) {
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }
    attempt.orgId = organization;

    const org = await this._organizationService.getOrgById(organization);

    const details = integrationProvider.externalUrl
      ? await ioRedis.get(`external:${body.state}`)
      : undefined;

    if (details) {
      await ioRedis.del(`external:${body.state}`);
    }

    const refresh = await ioRedis.get(`refresh:${body.state}`);
    if (refresh) {
      await ioRedis.del(`refresh:${body.state}`);
    }

    const onboarding = await ioRedis.get(`onboarding:${body.state}`);
    if (onboarding) {
      await ioRedis.del(`onboarding:${body.state}`);
    }

    // Started by an api.market subscriber (marketplace.service.ts connect):
    // there is no Hookpost session or dashboard behind it, so the callback
    // page ends on "connected, close this tab" whoever is signed in.
    const marketplace = !!(await ioRedis
      .get(MARKETPLACE_CONNECT_KEY(body.state))
      .catch(() => null));

    const {
      error,
      accessToken,
      expiresIn,
      refreshToken,
      id,
      name,
      picture,
      username,
      additionalSettings,
      // eslint-disable-next-line no-async-promise-executor
    } = await new Promise<AuthTokenDetails>(async (res) => {
      try {
        const auth = await integrationProvider.authenticate(
          {
            code,
            codeVerifier: getCodeVerifier,
            refresh: body.refresh,
          },
          details ? JSON.parse(details) : undefined
        );

        if (typeof auth === 'string') {
          return res({
            error: auth,
            accessToken: '',
            id: '',
            name: '',
            picture: '',
            username: '',
            additionalSettings: [],
          });
        }

        if (refresh && integrationProvider.reConnect) {
          console.log('reconnect');
          try {
            const newAuth = await integrationProvider.reConnect(
              auth.id,
              refresh,
              auth.accessToken
            );
            return res({ ...newAuth, refreshToken: body.refresh });
          } catch (err: any) {
            return res({
              error: err.message,
              accessToken: '',
              id: '',
              name: '',
              picture: '',
              username: '',
              additionalSettings: [],
            });
          }
        }

        return res(auth);
      } catch (err) {
        // The generic branch below collapses every provider failure into
        // "Authentication failed", which is undiagnosable from the 409 alone.
        // Log the real error (message + platform response body) first.
        console.error(
          `[social-connect:${integration}] authenticate failed`,
          (err as any)?.message,
          redactSecrets(JSON.stringify((err as any)?.details ?? {})),
          (err as any)?.stack
        );

        if (err instanceof NotEnoughScopes) {
          return res({
            error: err.message,
            accessToken: '',
            id: '',
            name: '',
            picture: '',
            username: '',
            additionalSettings: [],
          });
        }

        return res({
          error: 'Authentication failed',
          accessToken: '',
          id: '',
          name: '',
          picture: '',
          username: '',
          additionalSettings: [],
        });
      }
    });

    if (error) {
      throw new NotEnoughScopes(error);
    }

    if (!id) {
      throw new NotEnoughScopes('Invalid API key');
    }

    let validName = name;
    if (!validName) {
      if (username) {
        validName = username.split('.')[0] ?? username;
      } else {
        validName = `Channel_${String(id).slice(0, 8)}`;
      }
    }

    const isSuperAdminOrg = await this._organizationService.hasSuperAdminUser(
      org.id
    );

    if (
      !isSuperAdminOrg &&
      process.env.RAZORPAY_KEY_ID &&
      org.isTrailing &&
      (await this._integrationService.checkPreviousConnections(
        org.id,
        String(id)
      ))
    ) {
      throw new HttpException('', 412);
    }

    const save = async () => {
      if (refresh && String(id) !== String(refresh)) {
        // A reconnect that returns a different id is either the wrong account or
        // a channel migrating to another provider (MIGRATE_PROVIDERS) - the two
        // apps return different app-scoped ids, so the channel is matched by
        // profile and moved in place. Throws for anything else. Runs after every
        // check that can reject the connect, so a rejection can never leave a
        // half-migrated channel behind.
        await this._integrationService.migrateIntegration(
          org.id,
          refresh,
          integration,
          { id: String(id), username }
        );
      } else if (!refresh) {
        // A fresh connect of a migration target for an account the org already
        // has on the source provider adopts that channel instead of creating a
        // duplicate. No-op for everything else.
        await this._integrationService.migrateIntegrationOnConnect(
          org.id,
          integration,
          { id: String(id), username }
        );
      }

      return this._integrationService.createOrUpdateIntegration(
        additionalSettings,
        !!integrationProvider.oneTimeToken,
        org.id,
        validName.trim(),
        picture,
        'social',
        String(id),
        integration,
        accessToken,
        refreshToken,
        expiresIn,
        username,
        refresh ? false : integrationProvider.isBetweenSteps,
        body.refresh,
        +body.timezone,
        details
          ? AuthService.fixedEncryption(details)
          : integrationProvider.customFields
          ? AuthService.fixedEncryption(Buffer.from(code, 'base64').toString())
          : integrationProvider.isChromeExtension
          ? AuthService.fixedEncryption(Buffer.from(code, 'base64').toString())
          : undefined
      );
    };

    // A workspace that has to start its trial may connect
    // PRE_TRIAL_CHANNEL_LIMIT channel(s) first (trial.policy.ts). Its connect
    // link was only handed out while there was room, but that was a check at
    // link time: several links can be open at once, each with its own state
    // (a state itself is used up by its first attempt, above). So the count
    // is taken again here, under the channel-limit lock, right before the
    // save. A reconnect of a channel it has (the same account, or `refresh`)
    // adds nothing and passes; a two-step login is refused here too, before
    // it leaves a placeholder.
    const preTrialLimit = await this._integrationService.preTrialChannelLimit(
      org.id
    );
    const createUpdate =
      preTrialLimit === null
        ? await save()
        : await this._integrationService.withChannelLimitLock(
            org.id,
            30000,
            async () => {
              await this._integrationService.assertPreTrialChannelRoom(
                org.id,
                preTrialLimit,
                [String(id), refresh || '']
              );
              return save();
            }
          );

    if (preTrialLimit !== null && !refresh && !createUpdate.inBetweenSteps) {
      // A two-step login only saved its placeholder: the page pick logs it.
      logConnect('channel_connected_pre_trial', {
        provider: integration,
        orgId: org.id,
        channelId: createUpdate.id,
      });
    }

    this._refreshIntegrationService
      .startRefreshWorkflow(org.id, createUpdate.id, integrationProvider)
      .catch((err) => {
        console.log(err);
      });

    // Fetch pages if this is a two-step provider and not a refresh
    let pages: any[] = [];
    // A failed lookup is not "no pages": the page says so, and its picker
    // loads the list itself (with a Try again), instead of telling the user
    // the account has no Pages and to go and create one.
    let pagesError = false;
    if (integrationProvider.isBetweenSteps && !refresh) {
      try {
        // Check which method the provider uses (pages or companies)
        const fetchMethod =
          'pages' in integrationProvider
            ? 'pages'
            : 'companies' in integrationProvider
            ? 'companies'
            : null;

        if (fetchMethod) {
          // @ts-ignore - dynamic method call
          pages = await integrationProvider[fetchMethod](accessToken);
        }
      } catch (err) {
        pagesError = true;
        console.log(
          'Failed to fetch pages:',
          redactSecrets(connectFailureReason(err)).slice(0, 300)
        );
      }
    }

    // Only /enterprise/url sets a webhook, for a partner, so the partner's own
    // key signs what it gets back. It used to be a JWT_SECRET token, a kind
    // the backend's other endpoints did not tell apart from their own.
    const webhookUrl = await ioRedis.get(`webhookUrl:${body.state}`);
    if (webhookUrl) {
      const params = signEnterpriseWebhook({ apiKey: org.apiKey });
      try {
        if (params) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ params }),
            // @ts-ignore — undici option, not in lib.dom fetch types
            dispatcher: getSsrfSafeDispatcher(),
          });
        }
      } catch (err) {}

      await ioRedis.del(`webhookUrl:${body.state}`);
    }

    const returnURL = await ioRedis.get(`redirect:${body.state}`);
    if (returnURL) {
      await ioRedis.del(`redirect:${body.state}`);
    }

    if (body.state) {
      const finished: FinishedConnect = {
        orgId: org.id,
        integrationId: createUpdate.id,
        provider: integration,
        onboarding: onboarding === 'true',
        reconnected: !!refresh,
        ...(returnURL ? { returnURL } : {}),
        ...(marketplace ? { marketplace: true } : {}),
      };
      await ioRedis
        .set(
          finishedConnectKey(body.state),
          JSON.stringify(finished),
          'EX',
          FINISHED_CONNECT_TTL_SECONDS
        )
        .catch(() => undefined);

      // Done with the state: Back or a reload is answered from
      // connected:<state> above. A two-step login keeps it for its page
      // pick (/public/provider/:id/connect).
      if (!integrationProvider.isBetweenSteps) {
        await ioRedis.del(`organization:${body.state}`).catch(() => undefined);
      }
    }

    // Kept by the Chrome extension to refresh this channel's cookies later
    // (/extension-refresh), so it has no expiry. Its own key: it used to be a
    // plain JWT_SECRET token.
    const extensionToken = integrationProvider.isChromeExtension
      ? AuthService.signPurposeJWT(TOKEN_PURPOSE.EXTENSION_REFRESH, {
          integrationId: createUpdate.id,
          organizationId: org.id,
          internalId: String(id),
          provider: integration,
        })
      : undefined;

    // Never leak stored credentials (signed/encrypted secrets) back to the
    // caller. These columns hold the integration access token, refresh token
    // and encrypted custom instance details and must stay server-side.
    const {
      token: _token,
      refreshToken: _refreshToken,
      customInstanceDetails: _customInstanceDetails,
      ...safeIntegration
    } = createUpdate as any;

    logConnect('connect_ok', {
      provider: integration,
      orgId: org.id,
      channelId: createUpdate.id,
      reconnected: !!refresh,
      // A two-step provider (Facebook, Instagram, YouTube...) has only
      // created the placeholder; the page pick logs its own connect_ok.
      ...(integrationProvider.isBetweenSteps && !refresh
        ? { awaitingPagePick: true, pages: pages.length, pagesError }
        : {}),
    });

    return {
      ...safeIntegration,
      onboarding: onboarding === 'true',
      // A reconnect of an existing channel; anything else is a new channel,
      // and the page says "Channel added" rather than "Channel Updated".
      reconnected: !!refresh,
      pages,
      ...(pagesError ? { pagesError: true } : {}),
      ...(returnURL ? { returnURL } : {}),
      ...(extensionToken ? { extensionToken } : {}),
      ...(marketplace ? { marketplace: true } : {}),
    };
  }

  /**
   * The state was used up by a connect that succeeded (Back, a reload, a
   * second tab): answer with that channel, so the page goes on as it did the
   * first time instead of showing an error. Null when there is no such
   * connect, or its channel has since been removed, and the caller gives the
   * usual "already used" 400. Only ids and flags go back, never credentials:
   * the caller only proves it holds the state, as on the first call.
   */
  private async finishedConnect(provider: string, state?: string) {
    if (!state) return null;
    const raw = await ioRedis.get(finishedConnectKey(state)).catch(() => null);
    if (!raw) return null;
    let finished: FinishedConnect;
    try {
      finished = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!finished?.integrationId || finished.provider !== provider) {
      return null;
    }
    const channel = await this._integrationService.getIntegrationById(
      finished.orgId,
      finished.integrationId
    );
    if (!channel || channel.deletedAt) {
      return null;
    }

    logConnect('connect_repeat', {
      provider,
      orgId: finished.orgId,
      channelId: channel.id,
      awaitingPagePick: !!channel.inBetweenSteps,
    });

    return {
      id: channel.id,
      alreadyConnected: true,
      // A two-step login whose page was never picked: the page shows the
      // picker again, which loads the list itself (pagesError).
      inBetweenSteps: !!channel.inBetweenSteps,
      ...(channel.inBetweenSteps ? { pages: [], pagesError: true } : {}),
      onboarding: finished.onboarding,
      reconnected: finished.reconnected,
      ...(finished.returnURL ? { returnURL: finished.returnURL } : {}),
      ...(finished.marketplace ? { marketplace: true } : {}),
    };
  }

  @Post('/public/provider/:id/connect')
  async saveProviderPage(@Param('id') id: string, @Body() body: any) {
    if (!body.state) {
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }

    const organization = await ioRedis.get(`organization:${body.state}`);
    if (!organization) {
      throw new HttpException(CONNECT_LINK_EXPIRED, 400);
    }

    const org = await this._organizationService.getOrgById(organization);

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

  @Post('/extension-refresh')
  async extensionRefreshCookies(
    @Body() body: { jwt: string; cookies: string }
  ) {
    // Only the token this controller gave the extension: a session, an invite
    // or any other token is refused (it used to take any JWT_SECRET token).
    let payload: any;
    try {
      payload = AuthService.verifyPurposeJWT(
        TOKEN_PURPOSE.EXTENSION_REFRESH,
        body.jwt
      );
    } catch {
      throw new HttpException('Invalid token', 401);
    }

    const { integrationId, organizationId, internalId, provider } = payload;
    if (!integrationId || !organizationId || !internalId || !provider) {
      throw new HttpException('Invalid token payload', 400);
    }

    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    // A deleted channel stays deleted. getIntegrationById also returns
    // soft-deleted rows, and createOrUpdateIntegration below sets
    // deletedAt: null, so an extension that still held the token (the channel
    // was removed from another browser) revived it every day.
    if (
      !integration ||
      integration.deletedAt ||
      integration.internalId !== internalId
    ) {
      throw new HttpException('Integration not found', 404);
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(provider);
    if (!integrationProvider?.isChromeExtension) {
      throw new HttpException('Not a Chrome extension integration', 400);
    }

    const authResult = await integrationProvider.authenticate({
      code: body.cookies,
      codeVerifier: '',
    });

    if (typeof authResult === 'string') {
      throw new HttpException(authResult, 400);
    }

    if (String(authResult.id) !== String(integration.internalId)) {
      await this._integrationService.refreshNeeded(
        organizationId,
        integrationId
      );
      return { success: false, reason: 'account_mismatch' };
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      false,
      organizationId,
      integration.name,
      undefined,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      authResult.accessToken,
      '',
      authResult.expiresIn,
      undefined,
      false,
      undefined,
      undefined,
      // Encrypted, as the first connect stores them (and Skool reads them).
      // This used to sign the caller's JSON with JWT_SECRET, as it came.
      AuthService.fixedEncryption(
        JSON.stringify(
          JSON.parse(Buffer.from(body.cookies, 'base64').toString())
        )
      )
    );

    return { success: true };
  }
}
