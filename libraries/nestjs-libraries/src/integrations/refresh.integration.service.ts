import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Integration } from '@prisma/client';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service';
import {
  AuthTokenDetails,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { TemporalService } from 'nestjs-temporal-core';

@Injectable()
export class RefreshIntegrationService {
  constructor(
    private _integrationManager: IntegrationManager,
    @Inject(forwardRef(() => IntegrationService))
    private _integrationService: IntegrationService,
    private _temporalService: TemporalService
  ) {}
  async refresh(integration: Integration, cause = ''): Promise<false | AuthTokenDetails> {
    // A removed channel stays removed. Read it again, because callers (a
    // running post workflow, for one) can hold a copy from before the removal.
    const current = await this._integrationService.getIntegrationById(
      integration.organizationId,
      integration.id
    );
    if (!current || current.deletedAt) {
      return false as const;
    }

    const socialProvider = this._integrationManager.getSocialIntegration(
      integration.providerIdentifier
    );

    const refresh = await this.refreshProcess(integration, socialProvider, cause);

    if (!refresh) {
      return false as const;
    }

    // Tokens only: the avatar is already in our storage, and a channel removed
    // mid-refresh must not come back.
    const stored = await this._integrationService.updateRefreshedTokens(
      integration.organizationId,
      integration.internalId,
      !!socialProvider.oneTimeToken,
      refresh.accessToken,
      refresh.refreshToken,
      refresh.expiresIn
    );

    if (!stored) {
      return false as const;
    }

    return refresh;
  }

  public async setBetweenSteps(integration: Integration, cause = '') {
    await this._integrationService.setBetweenRefreshSteps(integration.id);
    await this._integrationService.informAboutRefreshError(
      integration.organizationId,
      integration,
      cause
    );
  }

  public async startRefreshWorkflow(orgId: string, id: string, integration: SocialProvider) {
    if (!integration.refreshCron) {
      return false;
    }

    return this._temporalService.client
      .getRawClient()
      ?.workflow.start(`refreshTokenWorkflow`, {
        workflowId: `refresh_${id}`,
        args: [{integrationId: id, organizationId: orgId}],
        taskQueue: 'main',
        workflowIdConflictPolicy: 'TERMINATE_EXISTING',
      });
  }

  private async refreshProcess(
    integration: Integration,
    socialProvider: SocialProvider,
    cause = ''
  ): Promise<AuthTokenDetails | false> {
    const refresh: false | AuthTokenDetails = await socialProvider
      .refreshToken(integration.refreshToken)
      .catch((err) => false);

    if (!refresh || !refresh.accessToken) {
      // disconnectChannel sets refreshNeeded AND sends the "Reconnect your
      // channel" notification. This used to also call refreshNeeded and
      // informAboutRefreshError itself, so every failed refresh sent the user
      // two notifications and two emails, the second without the cause.
      await this._integrationService.disconnectChannel(
        integration.organizationId,
        integration,
        cause
      );

      return false;
    }

    if (
      !socialProvider.reConnect ||
      integration.rootInternalId === integration.internalId
    ) {
      return refresh;
    }

    const reConnect = await socialProvider.reConnect(
      integration.rootInternalId,
      integration.internalId,
      refresh.accessToken
    );

    return {
      ...refresh,
      ...reConnect,
    };
  }
}
