import 'reflect-metadata';

// /enterprise/* trusted any token signed with JWT_SECRET, which also signs
// login sessions: a signed-in user could POST their own session to
// /create-user and get the API key of a new lifetime ULTIMATE workspace
// (22 Oct 2026). Partner tokens now need ENTERPRISE_JWT_SECRET.
//   pnpm exec jest -c apps/backend/jest.config.ts enterprise.controller

jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => ({ ioRedis: { set: jest.fn() } }));
jest.mock('@hookpost/nestjs-libraries/integrations/integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock('@hookpost/nestjs-libraries/database/prisma/organizations/organization.service', () => ({
  OrganizationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/integrations/integration.service', () => ({
  IntegrationService: class {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/posts/posts.service', () => ({ PostsService: class {} }));

import { decode, sign } from 'jsonwebtoken';
import { AuthService, TOKEN_PURPOSE } from '@hookpost/helpers/auth/auth.service';
import { EnterpriseController, enterprisePayload } from '@hookpost/backend/api/routes/enterprise.controller';
import { signEnterpriseWebhook } from '@hookpost/backend/services/auth/enterprise.token';

const JWT_SECRET = 'session-secret-session-secret-session-secret';
const PARTNER_SECRET = 'partner-secret-partner-secret-partner-secret';
const ENV = { ...process.env };

function controller() {
  const organizations = {
    createMaxUser: jest.fn(async () => ({ id: 'org-new', apiKey: 'key-new' })),
    getOrgByApiKey: jest.fn(async () => ({ id: 'org-1' })),
  };
  const integrations = {
    getPostsForChannel: jest.fn(async () => []),
    deleteChannel: jest.fn(async () => undefined),
  };
  const c = new EnterpriseController({} as any, organizations as any, integrations as any, {} as any);
  return { c, organizations, integrations };
}

beforeEach(() => {
  process.env = { ...ENV, JWT_SECRET };
});
afterAll(() => {
  process.env = { ...ENV };
});

describe('enterprise endpoints: only a partner token', () => {
  const partnerUser = { id: 'p-1', name: 'Partner User', email: 'pu@example.test', saasName: 'partner' };

  it('a login session is refused, even with every field create-user reads', async () => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
    const session = AuthService.signSessionJWT({ ...partnerUser, activated: true, password: null });
    const { c, organizations } = controller();
    expect(await c.createUser(session)).toEqual({ success: false });
    expect(organizations.createMaxUser).not.toHaveBeenCalled();
  });

  it('no ENTERPRISE_JWT_SECRET (how Hookpost runs): every request is refused', async () => {
    delete process.env.ENTERPRISE_JWT_SECRET;
    const { c, organizations, integrations } = controller();
    expect(await c.createUser(AuthService.signSessionJWT({ ...partnerUser, password: null }))).toEqual({ success: false });
    expect(await c.deleteChannel(sign({ apiKey: 'k', id: 'ch-1' }, JWT_SECRET))).toEqual({ success: false });
    expect(await c.redirectParams(sign({ redirectUrl: 'https://x.test', apiKey: 'k', provider: 'x', webhookUrl: 'https://x.test' }, JWT_SECRET))).toBeUndefined();
    expect(organizations.createMaxUser).not.toHaveBeenCalled();
    expect(organizations.getOrgByApiKey).not.toHaveBeenCalled();
    expect(integrations.deleteChannel).not.toHaveBeenCalled();
  });

  it.each([
    ['shorter than 32 characters', 'short-secret'],
    ['the same as JWT_SECRET', JWT_SECRET],
  ])('an ENTERPRISE_JWT_SECRET %s counts as none', (_label, secret) => {
    process.env.ENTERPRISE_JWT_SECRET = secret;
    expect(enterprisePayload(sign(partnerUser, secret))).toBeNull();
  });

  it('a token the partner signed with its own secret still works', async () => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
    const { c, organizations, integrations } = controller();
    expect(await c.createUser(sign(partnerUser, PARTNER_SECRET))).toEqual({ id: 'org-new', apiKey: 'key-new' });
    expect(organizations.createMaxUser).toHaveBeenCalledWith('p-1', 'Partner User', 'partner', 'pu@example.test');
    expect(await c.deleteChannel(sign({ apiKey: 'k', id: 'ch-1' }, PARTNER_SECRET))).toEqual({ success: true });
    expect(integrations.deleteChannel).toHaveBeenCalledWith('org-1', 'ch-1');
  });

  it('a token signed with any other key is refused', () => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
    expect(enterprisePayload(sign(partnerUser, 'someone-else-someone-else-someone-else'))).toBeNull();
    expect(enterprisePayload(undefined)).toBeNull();
    expect(enterprisePayload('not-a-token')).toBeNull();
  });

  it('any purpose token of ours is refused, whatever it carries', async () => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
    const { c, organizations } = controller();
    for (const purpose of Object.values(TOKEN_PURPOSE)) {
      expect(await c.createUser(AuthService.signPurposeJWT(purpose, partnerUser))).toEqual({ success: false });
    }
    expect(organizations.createMaxUser).not.toHaveBeenCalled();
  });

  it('what Hookpost posts to the partner webhook cannot be sent back in as a request', async () => {
    process.env.ENTERPRISE_JWT_SECRET = PARTNER_SECRET;
    const params = signEnterpriseWebhook({ apiKey: 'k' })!;
    expect(enterprisePayload<{ apiKey: string }>(params)).toBeNull();
    expect(decode(params)).toMatchObject({ apiKey: 'k', purpose: 'enterprise-webhook' });
    const { c, integrations } = controller();
    const replay = sign({ apiKey: 'k', id: 'ch-1', purpose: 'enterprise-webhook' }, PARTNER_SECRET);
    expect(await c.deleteChannel(replay)).toEqual({ success: false });
    expect(integrations.deleteChannel).not.toHaveBeenCalled();
  });

  it('no partner secret: no webhook token is signed at all', () => {
    delete process.env.ENTERPRISE_JWT_SECRET;
    expect(signEnterpriseWebhook({ apiKey: 'k' })).toBeNull();
  });
});
