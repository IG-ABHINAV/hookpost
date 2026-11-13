import 'reflect-metadata';

// The real dependencies pull in every provider (and ESM-only packages); this
// test only needs their shapes, which are passed in below.
jest.mock(
  '@hookpost/nestjs-libraries/integrations/integration.manager',
  () => ({
    IntegrationManager: class {},
  })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class {} })
);

import { RefreshIntegrationService } from '@hookpost/nestjs-libraries/integrations/refresh.integration.service';

const integration: any = {
  id: 'int1',
  organizationId: 'org1',
  providerIdentifier: 'instagram',
  refreshToken: '',
  internalId: 'ig1',
  rootInternalId: 'root1',
};

const build = (refreshToken: () => Promise<any>) => {
  const integrationService = {
    getIntegrationById: jest.fn(async () => integration),
    refreshNeeded: jest.fn(),
    informAboutRefreshError: jest.fn(),
    disconnectChannel: jest.fn(),
    updateRefreshedTokens: jest.fn(async () => true),
  };
  const manager = { getSocialIntegration: () => ({ refreshToken }) };
  const service = new RefreshIntegrationService(
    manager as any,
    integrationService as any,
    {} as any
  );
  return { service, integrationService };
};

describe('RefreshIntegrationService.refresh when the token cannot be refreshed', () => {
  it('flags the channel and notifies the user exactly once, with the cause', async () => {
    const { service, integrationService } = build(async () => ({
      accessToken: '',
    }));

    const result = await service.refresh(
      integration,
      'Instagram no longer accepts this connection'
    );

    expect(result).toBe(false);
    expect(integrationService.disconnectChannel).toHaveBeenCalledTimes(1);
    expect(integrationService.disconnectChannel).toHaveBeenCalledWith(
      'org1',
      integration,
      'Instagram no longer accepts this connection'
    );
    // disconnectChannel already notifies; a second direct call meant two
    // notifications and two emails per failed refresh
    expect(integrationService.informAboutRefreshError).not.toHaveBeenCalled();
    expect(integrationService.updateRefreshedTokens).not.toHaveBeenCalled();
  });

  it('treats a throwing refreshToken the same way', async () => {
    const { service, integrationService } = build(async () => {
      throw new Error('boom');
    });

    expect(await service.refresh(integration, 'x')).toBe(false);
    expect(integrationService.disconnectChannel).toHaveBeenCalledTimes(1);
  });
});
