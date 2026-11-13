import 'reflect-metadata';

// The OAuth callback (POST /integrations/social-connect/:provider). Redis,
// the provider and the services are fakes.
//   pnpm exec jest -c apps/backend/jest.config.ts no.auth.integrations

const redis = new Map<string, string>();
jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: {
    get: jest.fn(async (key: string) => redis.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      redis.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (redis.delete(key) ? 1 : 0)),
    getdel: jest.fn(async (key: string) => {
      const value = redis.get(key) ?? null;
      redis.delete(key);
      return value;
    }),
    incr: jest.fn(async (key: string) => {
      const next = Number(redis.get(key) || 0) + 1;
      redis.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async () => 1),
  },
}));
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
jest.mock(
  '@hookpost/nestjs-libraries/integrations/refresh.integration.service',
  () => ({ RefreshIntegrationService: class {} })
);
jest.mock(
  '@hookpost/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);

import {
  CONNECT_LINK_EXPIRED,
  connectCancelReason,
  NoAuthIntegrationsController,
} from '@hookpost/backend/api/routes/no.auth.integrations.controller';
import { decode, sign } from 'jsonwebtoken';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';

const STATE = 'state-1';
const ORG = 'org-1';

const setup = (
  provider: Partial<{
    isBetweenSteps: boolean;
    authenticate: (...args: any[]) => Promise<any>;
    pages: (...args: any[]) => Promise<any[]>;
  }> = {},
  // IntegrationService.preTrialChannelLimit: 1 for a workspace that has to
  // start its trial, null for everyone else.
  preTrialLimit: number | null = null
) => {
  const social = {
    identifier: 'linkedin',
    isBetweenSteps: false,
    authenticate: jest.fn(async () => ({
      id: 'li-member-1',
      name: 'Dr Mind',
      accessToken: 'access-token-secret',
      refreshToken: '',
      expiresIn: 3600,
      picture: '',
      username: 'drmind',
    })),
    ...provider,
  };
  const manager = {
    getAllowedSocialsIntegrations: jest.fn(() => ['linkedin', 'facebook']),
    getSocialIntegration: jest.fn(() => social),
  };
  const integrations = {
    preTrialChannelLimit: jest.fn(async () => preTrialLimit),
    withChannelLimitLock: jest.fn(
      async (_org: string, _ttl: number, save: () => Promise<any>) => save()
    ),
    assertPreTrialChannelRoom: jest.fn(async () => undefined),
    checkPreviousConnections: jest.fn(async () => false),
    migrateIntegration: jest.fn(async () => undefined),
    migrateIntegrationOnConnect: jest.fn(async () => undefined),
    createOrUpdateIntegration: jest.fn(async () => ({
      id: 'channel-1',
      organizationId: ORG,
      inBetweenSteps: social.isBetweenSteps,
      token: 'access-token-secret',
      refreshToken: 'refresh-token-secret',
      customInstanceDetails: null,
    })),
    // The channel the first connect saved, as the database has it now.
    getIntegrationById: jest.fn(async (org: string, id: string) =>
      org === ORG && id === 'channel-1'
        ? {
            id: 'channel-1',
            organizationId: ORG,
            internalId: 'li-member-1',
            inBetweenSteps: false,
            deletedAt: null,
            token: 'access-token-secret',
            refreshToken: 'refresh-token-secret',
          }
        : null
    ),
  };
  const refresh = { startRefreshWorkflow: jest.fn(async () => undefined) };
  const orgs = {
    getOrgById: jest.fn(async (id: string) => ({ id, isTrailing: false })),
    hasSuperAdminUser: jest.fn(async () => false),
  };
  const controller = new NoAuthIntegrationsController(
    manager as any,
    integrations as any,
    refresh as any,
    orgs as any
  );
  return { controller, social, integrations, orgs, manager };
};

const startConnect = (extra: Record<string, string> = {}) => {
  redis.clear();
  redis.set(`login:${STATE}`, 'code-verifier');
  redis.set(`organization:${STATE}`, ORG);
  for (const [key, value] of Object.entries(extra)) {
    redis.set(key, value);
  }
};

const connect = (
  controller: NoAuthIntegrationsController,
  provider = 'linkedin'
) =>
  controller.connectSocialMedia(provider, {
    state: STATE,
    code: 'oauth-code',
    timezone: '330',
  } as any);

describe('NoAuthIntegrationsController.connectSocialMedia', () => {
  it('a first connect is a new channel, and no stored credential comes back', async () => {
    const { controller } = setup();
    startConnect();
    const res: any = await connect(controller);
    expect(res.reconnected).toBe(false);
    expect(res.id).toBe('channel-1');
    expect(res.token).toBeUndefined();
    expect(res.refreshToken).toBeUndefined();
  });

  it('a reconnect of an existing channel says so', async () => {
    const { controller } = setup();
    startConnect({ [`refresh:${STATE}`]: 'li-member-1' });
    const res: any = await connect(controller);
    expect(res.reconnected).toBe(true);
  });

  describe('a two-step login (Facebook, Instagram, YouTube)', () => {
    beforeEach(() => {
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    it('returns the pages it found, with no error flag', async () => {
      const { controller } = setup({
        isBetweenSteps: true,
        pages: jest.fn(async () => [{ id: 'page-1', name: 'Mind' }]),
      });
      startConnect();
      const res: any = await connect(controller, 'facebook');
      expect(res.pages).toEqual([{ id: 'page-1', name: 'Mind' }]);
      expect(res.pagesError).toBeUndefined();
    });

    it('an account with no Pages is an empty list, not an error', async () => {
      const { controller } = setup({
        isBetweenSteps: true,
        pages: jest.fn(async () => []),
      });
      startConnect();
      const res: any = await connect(controller, 'facebook');
      expect(res.pages).toEqual([]);
      expect(res.pagesError).toBeUndefined();
    });

    it('a failed page lookup says so, so the page does not claim there are no Pages', async () => {
      const log = console.log as unknown as jest.Mock;
      const { controller } = setup({
        isBetweenSteps: true,
        pages: jest.fn(async () => {
          throw new Error(
            'Graph API 500 access_token=EAAB-page-token-secret'
          );
        }),
      });
      startConnect();
      const res: any = await connect(controller, 'facebook');
      expect(res.pagesError).toBe(true);
      expect(res.pages).toEqual([]);
      expect(
        log.mock.calls
          .map((c) => String(c[0]))
          .find((l) => l.startsWith('[connect]'))
      ).toContain('"pagesError":true');
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /EAAB-page-token-secret/
      );
    });
  });
});

describe('connect log lines', () => {
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const lines = (spy: jest.SpyInstance) =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('[connect]'));

  it('connect_ok with the channel, and no token anywhere', async () => {
    const { controller } = setup();
    startConnect();
    await connect(controller);
    expect(lines(log)).toEqual([
      '[connect] connect_ok {"provider":"linkedin","orgId":"org-1","channelId":"channel-1","reconnected":false}',
    ]);
    expect(JSON.stringify([log.mock.calls, error.mock.calls])).not.toMatch(
      /access-token-secret|refresh-token-secret|code-verifier|oauth-code/
    );
  });

  it('a two-step login logs the placeholder and how many pages it found', async () => {
    const { controller } = setup({
      isBetweenSteps: true,
      pages: jest.fn(async () => []),
    });
    startConnect();
    await connect(controller, 'facebook');
    expect(lines(log)[0]).toContain('"awaitingPagePick":true,"pages":0');
  });

  it('connect_failed with the provider, the workspace and the reason', async () => {
    const { controller } = setup({
      authenticate: jest.fn(async () => {
        throw new Error('LinkedIn said no');
      }),
    });
    startConnect();
    // NotEnoughScopes, which the route's filter turns into a 409.
    await expect(connect(controller)).rejects.toMatchObject({
      message: 'Authentication failed',
    });
    const failed = lines(error);
    expect(failed).toEqual([
      '[connect] connect_failed {"provider":"linkedin","orgId":"org-1","reason":"Authentication failed"}',
    ]);
    expect(lines(log)).toEqual([]);
  });
});

describe('a used or expired connect link', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('reloading the callback (state already used) is a 400 with a message, not a 500', async () => {
    const { controller, integrations } = setup();
    // A state that was used up without a connect finishing behind it.
    redis.clear();
    redis.set(`organization:${STATE}`, ORG);
    await expect(connect(controller)).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
    expect(integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  // 21 Oct: the first trial customer connected YouTube, opened the composer,
  // pressed Back, and was told three times that the link was used up.
  it('Back after a connect that succeeded answers with that channel, not an error', async () => {
    const { controller, integrations, social } = setup();
    startConnect({ [`onboarding:${STATE}`]: 'true' });
    await connect(controller);
    // The same callback again: login:<state> was deleted by the first one.
    const again: any = await connect(controller);
    expect(again).toEqual({
      id: 'channel-1',
      alreadyConnected: true,
      inBetweenSteps: false,
      onboarding: true,
      reconnected: false,
    });
    // Nothing was redone: no second token exchange, no second save.
    expect(social.authenticate).toHaveBeenCalledTimes(1);
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
    expect(
      (console.log as unknown as jest.Mock).mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('[connect] connect_repeat'))
    ).toEqual([
      '[connect] connect_repeat {"provider":"linkedin","orgId":"org-1","channelId":"channel-1","awaitingPagePick":false}',
    ]);
  });

  it('the finished connect is kept only as long as the state', async () => {
    const { ioRedis } = jest.requireMock(
      '@hookpost/nestjs-libraries/redis/redis.service'
    );
    const { controller } = setup();
    startConnect();
    await connect(controller);
    expect(ioRedis.set).toHaveBeenCalledWith(
      `connected:${STATE}`,
      expect.any(String),
      'EX',
      3600
    );
    expect(JSON.parse(redis.get(`connected:${STATE}`)!)).toEqual({
      orgId: ORG,
      integrationId: 'channel-1',
      provider: 'linkedin',
      onboarding: false,
      reconnected: false,
    });
  });

  it('is still the 400 once that channel has been removed', async () => {
    const { controller, integrations } = setup();
    startConnect();
    await connect(controller);
    integrations.getIntegrationById.mockResolvedValue({
      id: 'channel-1',
      inBetweenSteps: false,
      deletedAt: new Date(),
    } as any);
    await expect(connect(controller)).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
  });

  it('is still the 400 for the same state sent to another provider', async () => {
    const { controller } = setup();
    startConnect();
    await connect(controller, 'linkedin');
    await expect(connect(controller, 'facebook')).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
  });

  it('a failed connect leaves nothing to repeat', async () => {
    const { controller } = setup({
      authenticate: jest.fn(async () => {
        throw new Error('LinkedIn said no');
      }),
    });
    startConnect();
    await expect(connect(controller)).rejects.toBeTruthy();
    await expect(connect(controller)).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
  });

  it('a two-step login sent again before a page was picked shows the picker again', async () => {
    const { controller, integrations } = setup({
      isBetweenSteps: true,
      pages: jest.fn(async () => [{ id: 'page-1', name: 'Mind' }]),
    });
    startConnect();
    await connect(controller, 'facebook');
    integrations.getIntegrationById.mockResolvedValue({
      id: 'channel-1',
      inBetweenSteps: true,
      deletedAt: null,
    } as any);
    const again: any = await connect(controller, 'facebook');
    expect(again).toMatchObject({
      id: 'channel-1',
      alreadyConnected: true,
      inBetweenSteps: true,
      pages: [],
      pagesError: true,
    });
  });

  it('a state that expired from Redis is the same 400', async () => {
    const { controller } = setup();
    redis.clear();
    await expect(connect(controller)).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
  });

  it('the public page pick with an expired state is a 400 too', async () => {
    const { controller } = setup();
    redis.clear();
    await expect(
      controller.saveProviderPage('channel-1', { state: STATE, page: 'p1' })
    ).rejects.toMatchObject({ status: 400, message: CONNECT_LINK_EXPIRED });
    await expect(
      controller.saveProviderPage('channel-1', { page: 'p1' })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('says what to do on our own page, which returns to the calendar', () => {
    expect(CONNECT_LINK_EXPIRED).toBe(
      'This connect link was already used or has expired. Add the channel again from Add Channel.'
    );
  });

  it('the message is not the one the page retries on', () => {
    // continue.integration.tsx re-posts a 400 that says "Invalid or expired
    // state" or "Invalid connection type".
    expect(CONNECT_LINK_EXPIRED).not.toMatch(
      /Invalid or expired state|Invalid connection type/
    );
  });
});

// Cancel or Deny on the consent screen: the callback page says so itself and
// reports it here, so the log has the connect_failed line the ValidationPipe
// 400 never produced (22 Oct, org d4ad9404, Instagram).
describe('NoAuthIntegrationsController.connectCancelled', () => {
  let error: jest.SpyInstance;
  beforeEach(() => {
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => error.mockRestore());

  it('logs connect_failed user_denied with the workspace from the state', async () => {
    const { controller } = setup();
    startConnect();
    await controller.connectCancelled('facebook', { state: STATE, reason: 'user_denied' });
    expect(error).toHaveBeenCalledWith(
      `[connect] connect_failed {"provider":"facebook","orgId":"${ORG}","reason":"user_denied"}`
    );
    // The state is left alone: a fresh connect makes its own.
    expect(redis.get(`login:${STATE}`)).toBe('code-verifier');
  });

  it('another provider error is logged by its code, and no state is fine', async () => {
    const { controller } = setup();
    redis.clear();
    await controller.connectCancelled('linkedin', { reason: 'invalid_scope' });
    expect(error).toHaveBeenCalledWith(
      '[connect] connect_failed {"provider":"linkedin","orgId":null,"reason":"provider_error: invalid_scope"}'
    );
  });

  it('a provider that is not on the list writes nothing', async () => {
    const { controller } = setup();
    await controller.connectCancelled('<script>', { reason: 'user_denied' });
    expect(error).not.toHaveBeenCalled();
  });

  it('only a short code-shaped reason reaches the log', () => {
    expect(connectCancelReason(undefined)).toBe('user_denied');
    expect(connectCancelReason('access token=abc def')).toBe('user_denied');
    expect(connectCancelReason('Server_Error')).toBe('provider_error: server_error');
  });
});

// The Chrome extension refreshes a channel's cookies with the token it was
// given at connect. This took any JWT_SECRET token, and stored the cookies the
// caller sent as a JWT_SECRET token of their JSON (22 Oct 2026).
describe('NoAuthIntegrationsController.extensionRefreshCookies: only the extension token', () => {
  const payload = { integrationId: 'channel-1', organizationId: ORG, internalId: 'li-member-1', provider: 'linkedin' };
  const cookies = Buffer.from(JSON.stringify({ auth_token: 'a', client_id: 'b' })).toString('base64');
  const extension = () => setup({ isChromeExtension: true } as any);
  beforeAll(() => {
    process.env.JWT_SECRET = 'no-auth-spec-secret';
  });

  it('the token handed out at connect refreshes the channel; the cookies are stored encrypted', async () => {
    const { controller, integrations } = extension();
    startConnect();
    const connected: any = await connect(controller);
    expect(decode(connected.extensionToken)).toMatchObject({ ...payload, purpose: 'extension-refresh' });

    integrations.createOrUpdateIntegration.mockClear();
    const res = await controller.extensionRefreshCookies({ jwt: connected.extensionToken, cookies });
    expect(res).toEqual({ success: true });
    const stored = (integrations.createOrUpdateIntegration.mock.calls[0] as any[])[15];
    expect(JSON.parse(AuthService.fixedDecryption(stored))).toEqual({ auth_token: 'a', client_id: 'b' });
  });

  it('a deleted channel is not revived: 404, nothing written, no Skool call', async () => {
    const { controller, integrations, social } = extension();
    startConnect();
    const connected: any = await connect(controller);
    integrations.getIntegrationById.mockResolvedValueOnce({
      id: 'channel-1',
      organizationId: ORG,
      internalId: 'li-member-1',
      deletedAt: new Date('2026-10-24T10:00:00Z'),
    } as any);
    integrations.createOrUpdateIntegration.mockClear();
    (social.authenticate as jest.Mock).mockClear();

    await expect(
      controller.extensionRefreshCookies({ jwt: connected.extensionToken, cookies })
    ).rejects.toThrow('Integration not found');
    expect(social.authenticate).not.toHaveBeenCalled();
    expect(integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
  });

  it.each([
    ['a login session', () => AuthService.signSessionJWT({ id: 'user-1', password: null, ...payload })],
    ['a login token without exp', () => sign({ id: 'user-1', ...payload }, process.env.JWT_SECRET!)],
    ['an extension token from before the fix (plain JWT_SECRET)', () => sign(payload, process.env.JWT_SECRET!)],
    ['a team invite', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.TEAM_INVITE, payload, { expiresIn: '2d' })],
    ['a password-reset link', () => AuthService.signPurposeJWT(TOKEN_PURPOSE.PASSWORD_RESET, payload, { expiresIn: '20m' })],
    ['garbage', () => 'not-a-token'],
  ])('%s is refused before any channel is read', async (_label, make) => {
    const { controller, integrations } = extension();
    await expect(controller.extensionRefreshCookies({ jwt: make(), cookies })).rejects.toThrow('Invalid token');
    expect(integrations.getIntegrationById).not.toHaveBeenCalled();
  });
});

// 25 Oct 2026: a workspace that has to start its trial (needs_trial) may
// connect PRE_TRIAL_CHANNEL_LIMIT channel(s) before the trial. The callback
// counts again, under the channel-limit lock, right before the save: the link
// was handed out while there was room, but several can be open at once.
describe('the OAuth callback for a workspace that has to start its trial', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const lines = () =>
    log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[connect]'));

  it('counts under the lock, then saves; the funnel event is logged next to connect_ok', async () => {
    const { controller, integrations } = setup({}, 1);
    startConnect();
    const res: any = await connect(controller);
    expect(res.id).toBe('channel-1');
    expect(integrations.withChannelLimitLock).toHaveBeenCalledWith(ORG, 30000, expect.any(Function));
    expect(integrations.assertPreTrialChannelRoom).toHaveBeenCalledWith(ORG, 1, ['li-member-1', '']);
    // The count runs before the save, inside the lock.
    expect(integrations.assertPreTrialChannelRoom.mock.invocationCallOrder[0]).toBeLessThan(
      integrations.createOrUpdateIntegration.mock.invocationCallOrder[0]
    );
    expect(lines()).toEqual([
      '[connect] channel_connected_pre_trial {"provider":"linkedin","orgId":"org-1","channelId":"channel-1"}',
      '[connect] connect_ok {"provider":"linkedin","orgId":"org-1","channelId":"channel-1","reconnected":false}',
    ]);
  });

  it('no room: 402 TRIAL_REQUIRED, nothing saved, no refresh workflow, connect_failed logged', async () => {
    const { PreTrialChannelLimitError } = jest.requireActual(
      '@hookpost/nestjs-libraries/database/prisma/subscriptions/plan.required.error'
    );
    const { controller, integrations } = setup({}, 1);
    integrations.assertPreTrialChannelRoom.mockRejectedValueOnce(new PreTrialChannelLimitError(3));
    startConnect();
    await expect(connect(controller)).rejects.toMatchObject({
      status: 402,
      response: {
        code: 'TRIAL_REQUIRED',
        trial: true,
        trialDays: 3,
        message:
          'You can connect 1 channel before your trial starts. Start your 3-day trial to connect more and schedule posts.',
      },
    });
    expect(integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
    expect(integrations.migrateIntegrationOnConnect).not.toHaveBeenCalled();
    expect(lines().some((l) => l.includes('channel_connected_pre_trial'))).toBe(false);
  });

  it('a reconnect passes the channel it refreshes, and is not counted as a new connect', async () => {
    const { controller, integrations } = setup({}, 1);
    startConnect({ [`refresh:${STATE}`]: 'li-member-1' });
    await connect(controller);
    expect(integrations.assertPreTrialChannelRoom).toHaveBeenCalledWith(ORG, 1, [
      'li-member-1',
      'li-member-1',
    ]);
    expect(lines().some((l) => l.includes('channel_connected_pre_trial'))).toBe(false);
  });

  it('a two-step login only saves its placeholder: counted, but the event waits for the page pick', async () => {
    const { controller, integrations } = setup(
      { isBetweenSteps: true, pages: jest.fn(async () => []) },
      1
    );
    startConnect();
    await connect(controller, 'facebook');
    expect(integrations.assertPreTrialChannelRoom).toHaveBeenCalled();
    expect(lines().some((l) => l.includes('channel_connected_pre_trial'))).toBe(false);
  });

  it('every other workspace: no lock and no pre-trial count, as before', async () => {
    const { controller, integrations } = setup({}, null);
    startConnect();
    await connect(controller);
    expect(integrations.withChannelLimitLock).not.toHaveBeenCalled();
    expect(integrations.assertPreTrialChannelRoom).not.toHaveBeenCalled();
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
  });
});

describe('NoAuthIntegrationsController.extensionRefreshCookies: a removed channel', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = 'no-auth-spec-secret';
  });

  // The save clears deletedAt, so a refresh of a removed channel used to
  // bring it back, past the plan's (or the pre-trial) channel limit.
  it('is not brought back: 404, nothing saved', async () => {
    const { controller, integrations } = setup({ isChromeExtension: true } as any);
    integrations.getIntegrationById.mockResolvedValue({
      id: 'channel-1',
      organizationId: ORG,
      internalId: 'li-member-1',
      inBetweenSteps: false,
      deletedAt: new Date(),
    } as any);
    const jwt = AuthService.signPurposeJWT(TOKEN_PURPOSE.EXTENSION_REFRESH, {
      integrationId: 'channel-1',
      organizationId: ORG,
      internalId: 'li-member-1',
      provider: 'linkedin',
    });
    const cookies = Buffer.from(JSON.stringify({ auth_token: 'a' })).toString('base64');
    await expect(controller.extensionRefreshCookies({ jwt, cookies })).rejects.toMatchObject({ status: 404 });
    expect(integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
  });
});

// Credentials (custom fields, Skool's cookies, a web3 code) used to reach the
// callback page as ?code=<base64> in its URL, which the Meta pixel, GTM,
// Sentry, Plausible and Dub all read. Now they are handed over in a POST body
// and the URL carries a one-time id (connect.handoff.ts).
describe('the connect handoff: credentials never in a URL', () => {
  const COOKIES = { client_id: 'skool-client-SECRET', auth_token: 'skool-token-SECRET' };
  const CODE = Buffer.from(JSON.stringify(COOKIES)).toString('base64');
  const ID = /^[A-Za-z0-9_-]{43}$/;

  const skool = () => {
    const ctx = setup({
      authenticate: jest.fn(async (params: { code: string }) => {
        const cookies = JSON.parse(Buffer.from(params.code, 'base64').toString());
        return cookies.auth_token === COOKIES.auth_token
          ? {
              id: 'skool-user-1',
              name: 'Skool User',
              accessToken: 'encrypted-cookies',
              refreshToken: '',
              expiresIn: 3600,
              picture: '',
              username: 'skooluser',
            }
          : 'Invalid cookie data';
      }),
    } as any);
    Object.assign(ctx.social, { identifier: 'skool', isChromeExtension: true });
    ctx.manager.getAllowedSocialsIntegrations.mockReturnValue([
      'skool',
      'bluesky',
      'moltbook',
      'linkedin',
    ]);
    return ctx;
  };

  const redeem = (
    controller: NoAuthIntegrationsController,
    body: Record<string, unknown>,
    provider = 'skool'
  ) =>
    controller.connectSocialMedia(provider, {
      state: STATE,
      timezone: '330',
      ...body,
    } as any);

  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    startConnect();
  });
  afterEach(() => jest.restoreAllMocks());

  it('keeps the cookies for 5 minutes under a random id, and answers only the id', async () => {
    const { ioRedis } = jest.requireMock('@hookpost/nestjs-libraries/redis/redis.service');
    const { controller } = skool();
    const res = await controller.connectHandoff('skool', { state: STATE, code: CODE });

    expect(Object.keys(res)).toEqual(['handoff']);
    expect(res.handoff).toMatch(ID);
    expect(JSON.stringify(res)).not.toContain('SECRET');
    expect(ioRedis.set).toHaveBeenCalledWith(
      `connect-handoff:${res.handoff}`,
      JSON.stringify({ state: STATE, provider: 'skool', code: CODE }),
      'EX',
      300
    );
    // A new id every time.
    const again = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    expect(again.handoff).not.toBe(res.handoff);
  });

  it('the callback redeems it: the channel is connected with those cookies, stored encrypted', async () => {
    const { controller, social, integrations } = skool();
    const { handoff } = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    const res: any = await redeem(controller, { handoff });

    expect(social.authenticate).toHaveBeenCalledWith(
      { code: CODE, codeVerifier: 'code-verifier', refresh: undefined },
      undefined
    );
    expect(res.id).toBe('channel-1');
    expect(res.extensionToken).toEqual(expect.any(String));
    const stored = integrations.createOrUpdateIntegration.mock.calls[0] as unknown as any[];
    const customInstanceDetails = stored[stored.length - 1];
    expect(customInstanceDetails).not.toContain('SECRET');
    expect(JSON.parse(AuthService.fixedDecryption(customInstanceDetails))).toEqual(COOKIES);
    // Used up.
    expect(redis.has(`connect-handoff:${handoff}`)).toBe(false);
    expect(JSON.stringify(res)).not.toContain('SECRET');
  });

  it('a second redeem of the same id (reload, Back) answers the finished connect, without re-authenticating', async () => {
    const { controller, social, integrations } = skool();
    const { handoff } = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    await redeem(controller, { handoff });
    const again: any = await redeem(controller, { handoff });
    expect(again).toMatchObject({ id: 'channel-1', alreadyConnected: true });
    expect(social.authenticate).toHaveBeenCalledTimes(1);
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
  });

  it('the reloaded page, whose URL lost the id, gets the same answer', async () => {
    const { controller, social } = skool();
    const { handoff } = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    await redeem(controller, { handoff });
    const reload: any = await redeem(controller, {});
    expect(reload).toMatchObject({ id: 'channel-1', alreadyConnected: true });
    expect(social.authenticate).toHaveBeenCalledTimes(1);
  });

  it('with no code and no handoff before any connect: the 400, and the state is left alone', async () => {
    const { controller, social } = skool();
    await expect(redeem(controller, {})).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
    expect(social.authenticate).not.toHaveBeenCalled();
    expect(redis.get(`login:${STATE}`)).toBe('code-verifier');
  });

  it.each([
    ['an id nobody issued', () => 'A'.repeat(43)],
    ['an id that is not ours in shape', () => '../../etc/passwd'],
  ])('%s is the 400 and authenticates nothing', async (_what, id) => {
    const { controller, social } = skool();
    await expect(redeem(controller, { handoff: id() })).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
    expect(social.authenticate).not.toHaveBeenCalled();
  });

  it('a handoff made for another connect state cannot be redeemed with this one', async () => {
    const { controller, social } = skool();
    redis.set('organization:other-state', 'org-2');
    redis.set('login:other-state', 'other-verifier');
    const { handoff } = await controller.connectHandoff('skool', {
      state: 'other-state',
      code: CODE,
    });
    await expect(redeem(controller, { handoff })).rejects.toMatchObject({ status: 400 });
    expect(social.authenticate).not.toHaveBeenCalled();
    // And it is spent: a guess that hit it gains nothing later either.
    expect(redis.has(`connect-handoff:${handoff}`)).toBe(false);
  });

  it('a handoff made for Skool cannot be redeemed on another provider', async () => {
    const { controller, social } = skool();
    const { handoff } = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    await expect(redeem(controller, { handoff }, 'bluesky')).rejects.toMatchObject({
      status: 400,
    });
    expect(social.authenticate).not.toHaveBeenCalled();
  });

  it('a code and a handoff together is refused', async () => {
    const { controller, social } = skool();
    const { handoff } = await controller.connectHandoff('skool', { state: STATE, code: CODE });
    await expect(redeem(controller, { handoff, code: CODE })).rejects.toMatchObject({
      status: 400,
      message: 'Send the code or a handoff, not both',
    });
    expect(social.authenticate).not.toHaveBeenCalled();
  });

  it('an old link that still carries the code in the body keeps working', async () => {
    const { controller, social } = skool();
    const res: any = await redeem(controller, { code: CODE });
    expect(res.id).toBe('channel-1');
    expect(social.authenticate).toHaveBeenCalledTimes(1);
  });

  it('only for a live connect state', async () => {
    const { controller } = skool();
    redis.clear();
    await expect(
      controller.connectHandoff('skool', { state: STATE, code: CODE })
    ).rejects.toMatchObject({ status: 400, message: CONNECT_LINK_EXPIRED });
    expect([...redis.keys()].filter((k) => k.startsWith('connect-handoff:'))).toEqual([]);
  });

  it('not for an OAuth provider: its code comes from its own redirect', async () => {
    const { controller, social } = skool();
    Object.assign(social, { identifier: 'linkedin', isChromeExtension: false });
    await expect(
      controller.connectHandoff('linkedin', { state: STATE, code: CODE })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('a custom-field provider (Bluesky) and a web3 one (Moltbook) can', async () => {
    const { controller, social } = skool();
    Object.assign(social, { isChromeExtension: false, customFields: async () => [] });
    expect((await controller.connectHandoff('bluesky', { state: STATE, code: CODE })).handoff).toMatch(ID);
    Object.assign(social, { customFields: undefined, isWeb3: true });
    expect((await controller.connectHandoff('moltbook', { state: STATE, code: 'moltbook_key' })).handoff).toMatch(ID);
  });

  it('a provider that is not on the list is a 400', async () => {
    const { controller } = skool();
    await expect(
      controller.connectHandoff('myspace', { state: STATE, code: CODE })
    ).rejects.toMatchObject({ status: 400 });
  });

  // A custom-field connect has no login verifier to use up, so its state
  // stayed good for the hour, and the state is still in the callback URL.
  it('a finished custom-field connect uses up its state: a replay with other credentials adds nothing', async () => {
    const { controller, social, integrations } = skool();
    Object.assign(social, { identifier: 'bluesky', isChromeExtension: false, customFields: async () => [] });
    const { handoff } = await controller.connectHandoff('bluesky', { state: STATE, code: CODE });
    await redeem(controller, { handoff }, 'bluesky');
    expect(redis.has(`organization:${STATE}`)).toBe(false);
    expect(redis.has(`login:${STATE}`)).toBe(false);

    const attacker = Buffer.from(JSON.stringify({ ...COOKIES, auth_token: 'attacker-token' })).toString('base64');
    const replay: any = await redeem(controller, { code: attacker }, 'bluesky');
    expect(replay).toMatchObject({ id: 'channel-1', alreadyConnected: true });
    expect(social.authenticate).toHaveBeenCalledTimes(1);
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledTimes(1);
    // And no new handoff for it either.
    await expect(
      controller.connectHandoff('bluesky', { state: STATE, code: attacker })
    ).rejects.toMatchObject({ status: 400 });
  });

  it('a failed custom-field connect uses up its state too (the form asks for a new one each time)', async () => {
    const { controller, social } = skool();
    Object.assign(social, { identifier: 'bluesky', isChromeExtension: false, customFields: async () => [] });
    const wrong = Buffer.from(JSON.stringify({ auth_token: 'wrong' })).toString('base64');
    await expect(redeem(controller, { code: wrong }, 'bluesky')).rejects.toBeTruthy();
    await expect(redeem(controller, { code: CODE }, 'bluesky')).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
    expect(social.authenticate).toHaveBeenCalledTimes(1);
  });

  // A state was good for any provider: one left from a YouTube connect (an
  // hour in Redis, and in that callback's URL) was enough to add someone
  // else's Bluesky account, since custom fields check no login verifier.
  it('two attempts at the same moment with one state: one connects, one is refused', async () => {
    const { controller, social } = skool();
    Object.assign(social, { identifier: 'bluesky', isChromeExtension: false, customFields: async () => [] });
    const other = Buffer.from(JSON.stringify({ ...COOKIES, auth_token: 'other' })).toString('base64');
    const results = await Promise.allSettled([
      redeem(controller, { code: CODE }, 'bluesky'),
      redeem(controller, { code: other }, 'bluesky'),
    ]);
    expect(social.authenticate).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a state made for one provider cannot connect another', async () => {
    const { controller, social, integrations } = skool();
    Object.assign(social, { identifier: 'bluesky', isChromeExtension: false, customFields: async () => [] });
    redis.set(`provider:${STATE}`, 'youtube');
    await expect(redeem(controller, { code: CODE }, 'bluesky')).rejects.toMatchObject({
      status: 400,
      message: CONNECT_LINK_EXPIRED,
    });
    await expect(
      controller.connectHandoff('bluesky', { state: STATE, code: CODE })
    ).rejects.toMatchObject({ status: 400, message: CONNECT_LINK_EXPIRED });
    expect(social.authenticate).not.toHaveBeenCalled();
    expect(integrations.createOrUpdateIntegration).not.toHaveBeenCalled();
    // The state itself is left for the provider it was made for.
    expect(redis.get(`login:${STATE}`)).toBe('code-verifier');
  });

  it('a state made for this provider, or one made before states named theirs, connects', async () => {
    const { controller } = skool();
    redis.set(`provider:${STATE}`, 'skool');
    expect((await redeem(controller, { code: CODE })).id).toBe('channel-1');
    startConnect();
    expect(redis.has(`provider:${STATE}`)).toBe(false);
    const { controller: again } = skool();
    expect((await redeem(again, { code: CODE })).id).toBe('channel-1');
  });

  it('a finished connect clears the workspace from its state; a two-step login keeps it for the page pick', async () => {
    const { controller } = skool();
    await redeem(controller, { code: CODE });
    expect(redis.has(`organization:${STATE}`)).toBe(false);

    startConnect();
    const twoStep = setup({ isBetweenSteps: true, pages: jest.fn(async () => []) });
    await connect(twoStep.controller, 'facebook');
    expect(redis.get(`organization:${STATE}`)).toBe(ORG);
  });

  it('at most 5 handoffs per connect state, then a 429', async () => {
    const { controller } = skool();
    for (let i = 0; i < 5; i++) {
      await controller.connectHandoff('skool', { state: STATE, code: CODE });
    }
    await expect(
      controller.connectHandoff('skool', { state: STATE, code: CODE })
    ).rejects.toMatchObject({ status: 429 });
  });
});
