/**
 * Connecting channels: the add-channel list, the OAuth URL each provider
 * builds (GET /integrations/social/:provider), and the callback
 * (POST /integrations/social-connect/:provider) that turns the code into a
 * channel. Only the provider's own token exchange (authenticate) is replaced;
 * the state handling in Redis, the plan's channel limit, reconnects and the
 * saved row are the real thing.
 *
 * Then the channel settings the dashboard changes, and org scoping on each.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, db, disconnectDb, givePlan } from './setup/db';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';

// Client ids the URL builders read. Fake values: nothing calls the networks.
const PROVIDER_ENV: Record<string, string> = {
  FACEBOOK_APP_ID: 'fb-app-id-test',
  FACEBOOK_APP_SECRET: 'fb-secret-test',
  INSTAGRAM_APP_ID: 'ig-app-id-test',
  INSTAGRAM_APP_SECRET: 'ig-secret-test',
  THREADS_APP_ID: 'threads-app-id-test',
  THREADS_APP_SECRET: 'threads-secret-test',
  LINKEDIN_CLIENT_ID: 'linkedin-client-test',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret-test',
  YOUTUBE_CLIENT_ID: 'youtube-client-test',
  YOUTUBE_CLIENT_SECRET: 'youtube-secret-test',
  PINTEREST_CLIENT_ID: 'pinterest-client-test',
  PINTEREST_CLIENT_SECRET: 'pinterest-secret-test',
  TIKTOK_CLIENT_ID: 'tiktok-client-test',
  TIKTOK_CLIENT_SECRET: 'tiktok-secret-test',
  REDDIT_CLIENT_ID: 'reddit-client-test',
  REDDIT_CLIENT_SECRET: 'reddit-secret-test',
  DISCORD_CLIENT_ID: 'discord-client-test',
  DISCORD_CLIENT_SECRET: 'discord-secret-test',
  DISCORD_BOT_TOKEN_ID: 'discord-bot-test',
  SLACK_ID: 'slack-client-test',
  SLACK_SECRET: 'slack-secret-test',
};

// Where each provider's consent screen lives, and the client id it must carry.
// Always three entries: jest.each passes a done callback in a missing slot.
const CONNECT_URLS: Array<[provider: string, host: RegExp, clientId: string]> = [
  ['facebook', /(^|\.)facebook\.com$/, 'fb-app-id-test'],
  ['instagram', /(^|\.)facebook\.com$/, 'fb-app-id-test'],
  ['instagram-standalone', /(^|\.)instagram\.com$|redirectmeto\.com$/, 'ig-app-id-test'],
  ['threads', /(^|\.)threads\.(net|com)$|redirectmeto\.com$/, 'threads-app-id-test'],
  ['linkedin', /(^|\.)linkedin\.com$/, 'linkedin-client-test'],
  ['youtube', /^accounts\.google\.com$/, 'youtube-client-test'],
  ['pinterest', /(^|\.)pinterest\.com$/, 'pinterest-client-test'],
  ['tiktok', /(^|\.)tiktok\.com$|redirectmeto\.com$/, 'tiktok-client-test'],
  ['linkedin-page', /(^|\.)linkedin\.com$/, 'linkedin-client-test'],
  ['discord', /^discord\.com$/, 'discord-client-test'],
  ['slack', /^slack\.com$|redirectmeto\.com$/, 'slack-client-test'],
];

describe('channels: connect and manage', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(PROVIDER_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await startApp();
    owner = await t.api.register({ company: 'Channels Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.close();
    await disconnectDb();
  });

  it('GET /integrations lists the providers for the add-channel screen', async () => {
    const res = await t.api.get('/integrations');
    expect(res.status).toBe(200);
    const ids = res.body.social.map((p: any) => p.identifier);
    for (const id of ['instagram', 'facebook', 'threads', 'linkedin', 'bluesky', 'youtube', 'pinterest', 'x']) {
      expect(ids).toContain(id);
    }
  });

  describe('OAuth connect URL per provider', () => {
    it.each(CONNECT_URLS)('%s: consent URL with state, client id and our callback', async (provider, host, clientId) => {
      const res = await owner.get(`/integrations/social/${provider}`);
      expect(res.status).toBe(200);
      expect(res.body.err).toBeUndefined();
      const url = new URL(res.body.url);
      expect(url.host).toMatch(host);
      const full = decodeURIComponent(res.body.url);
      expect(full).toContain(clientId);
      // The callback lands on the frontend route for this provider.
      expect(full).toContain(`/integrations/social/${provider}`);

      // The state names the workspace in Redis for the callback (1 h).
      const state = /[?&]state=([^&]+)/.exec(full)?.[1];
      expect(state).toBeTruthy();
      expect(await ioRedis.get(`organization:${state}`)).toBe(orgId);
      expect(await ioRedis.get(`login:${state}`)).toBeTruthy();
      expect(await ioRedis.ttl(`organization:${state}`)).toBeGreaterThan(3000);
    });

    it('refuses a provider that does not exist', async () => {
      const res = await owner.get('/integrations/social/myspace');
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('a Free workspace at its 2-channel limit cannot start a connect (402)', async () => {
      const free = await t.api.register({ company: 'Full Free Co' });
      const freeOrg = (await free.self()).orgId;
      await addChannel(freeOrg, 'bluesky');
      await addChannel(freeOrg, 'threads');
      const res = await free.get('/integrations/social/linkedin');
      expect(res.status).toBe(402);
    });

    it('an unfinished two-step connect (placeholder) does not use up a channel', async () => {
      const free = await t.api.register({ company: 'Placeholder Co' });
      const freeOrg = (await free.self()).orgId;
      await addChannel(freeOrg, 'bluesky');
      await addChannel(freeOrg, 'facebook', { inBetweenSteps: true });
      const res = await free.get('/integrations/social/linkedin');
      expect(res.status).toBe(200);
    });
  });

  describe('OAuth callback (social-connect)', () => {
    const linkedin = () => t.get<IntegrationManager>(IntegrationManager).getSocialIntegration('linkedin');

    async function startConnect(session: Session, query = '') {
      const res = await session.get(`/integrations/social/linkedin${query}`);
      return /[?&]state=([^&]+)/.exec(decodeURIComponent(res.body.url))![1];
    }

    afterEach(() => jest.restoreAllMocks());

    it('creates the channel for the workspace named by the state', async () => {
      const auth = jest.spyOn(linkedin(), 'authenticate').mockResolvedValue({
        id: 'li-person-1',
        name: 'Test Person',
        accessToken: 'li-access-token',
        refreshToken: 'li-refresh-token',
        expiresIn: 3600,
        picture: '',
        username: 'testperson',
      } as any);
      const state = await startConnect(owner);

      const res = await t.api.post('/integrations/social-connect/linkedin', {
        code: 'auth-code-from-linkedin',
        state,
        timezone: '330',
      });
      expect(res.status).toBe(201);
      expect(auth).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'auth-code-from-linkedin' }),
        undefined
      );
      // The callback never sends stored credentials back to the browser.
      expect(JSON.stringify(res.body)).not.toContain('li-access-token');
      expect(JSON.stringify(res.body)).not.toContain('li-refresh-token');

      const row = await db().integration.findFirstOrThrow({
        where: { organizationId: orgId, internalId: 'li-person-1' },
      });
      expect(row.providerIdentifier).toBe('linkedin');
      expect(row.name).toBe('Test Person');
      expect(row.deletedAt).toBeNull();
      // Single-use state.
      expect(await ioRedis.get(`login:${state}`)).toBeNull();
      // LinkedIn has no refreshCron, so no refreshTokenWorkflow is armed.
      expect(t.temporal.started.some((s) => s.workflow === 'refreshTokenWorkflow')).toBe(
        !!linkedin().refreshCron
      );
    });

    it('an unknown or expired state is refused and creates nothing', async () => {
      const auth = jest.spyOn(linkedin(), 'authenticate');
      const before = await db().integration.count();
      const res = await t.api.post('/integrations/social-connect/linkedin', {
        code: 'whatever',
        state: 'no-such-state',
        timezone: '0',
      });
      expect(res.status).toBe(400);
      expect(auth).not.toHaveBeenCalled();
      expect(await db().integration.count()).toBe(before);
    });

    it('a provider error is a 409 with the reason, and creates nothing', async () => {
      jest.spyOn(linkedin(), 'authenticate').mockRejectedValue(new Error('token exchange failed'));
      const state = await startConnect(owner);
      const before = await db().integration.count({ where: { organizationId: orgId } });
      const res = await t.api.post('/integrations/social-connect/linkedin', {
        code: 'bad-code',
        state,
        timezone: '0',
      });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ msg: 'Authentication failed' });
      expect(await db().integration.count({ where: { organizationId: orgId } })).toBe(before);
    });

    it('reconnecting the same account refreshes the token in place', async () => {
      jest.spyOn(linkedin(), 'authenticate').mockResolvedValue({
        id: 'li-person-2',
        name: 'Reconnect Person',
        accessToken: 'first-token',
        refreshToken: 'r1',
        expiresIn: 3600,
        picture: '',
        username: 'reconnect',
      } as any);
      await t.api.post('/integrations/social-connect/linkedin', {
        code: 'c1',
        state: await startConnect(owner),
        timezone: '0',
      });
      const first = await db().integration.findFirstOrThrow({
        where: { organizationId: orgId, internalId: 'li-person-2' },
      });
      await db().integration.update({ where: { id: first.id }, data: { refreshNeeded: true } });

      jest.restoreAllMocks();
      jest.spyOn(linkedin(), 'authenticate').mockResolvedValue({
        id: 'li-person-2',
        name: 'Reconnect Person',
        accessToken: 'second-token',
        refreshToken: 'r2',
        expiresIn: 3600,
        picture: '',
        username: 'reconnect',
      } as any);
      const res = await t.api.post('/integrations/social-connect/linkedin', {
        code: 'c2',
        state: await startConnect(owner, `?refresh=li-person-2`),
        timezone: '0',
      });
      expect(res.status).toBe(201);
      const rows = await db().integration.findMany({
        where: { organizationId: orgId, internalId: 'li-person-2' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
      expect(rows[0].refreshNeeded).toBe(false);
      expect(rows[0].token).not.toBe(first.token);
    });
  });

  // Medium stopped issuing integration tokens, so it is retired from Add
  // Channel (RETIRED_PROVIDERS). A channel connected before must keep working.
  describe('Medium (retired from Add Channel)', () => {
    const realFetch = global.fetch;
    // Medium's GET /v1/me as it answers (401 body checked live 26 Oct 2026);
    // every other request (the test client's own calls) goes through.
    function fakeMedium(reply: { status: number; body: any }) {
      jest.spyOn(global, 'fetch').mockImplementation((async (url: any, init?: any) => {
        if (String(url).startsWith('https://api.medium.com/')) {
          return new Response(JSON.stringify(reply.body), { status: reply.status });
        }
        return realFetch(url, init);
      }) as any);
    }
    const mediumCode = (apiKey: string) => Buffer.from(JSON.stringify({ apiKey })).toString('base64');
    async function mediumState(session: Session, query = '') {
      const res = await session.get(`/integrations/social/medium${query}`);
      expect(res.status).toBe(200);
      return res.body.url as string; // a custom-fields provider: the url is the state
    }
    afterEach(() => jest.restoreAllMocks());

    it('GET /integrations does not offer Medium; the other article networks stay', async () => {
      const ids = (await t.api.get('/integrations')).body.social.map((p: any) => p.identifier);
      expect(ids).not.toContain('medium');
      for (const id of ['devto', 'hashnode', 'wordpress', 'bluesky', 'linkedin']) {
        expect(ids).toContain(id);
      }
    });

    it('an existing Medium channel is still listed, enabled, and can be reconnected', async () => {
      const row = await addChannel(orgId, 'medium', {
        name: 'Old Medium',
        internalId: 'medium-user-1',
        refreshNeeded: true,
      });
      const list = (await owner.get('/integrations/list')).body.integrations;
      const listed = list.find((c: any) => c.id === row.id);
      expect(listed).toMatchObject({ identifier: 'medium', name: 'Old Medium', disabled: false, refreshNeeded: true });

      // Reconnect with a token Medium still accepts: refreshed in place.
      fakeMedium({ status: 200, body: { data: { id: 'medium-user-1', username: 'old', name: 'Old Medium' } } });
      const res = await t.api.post('/integrations/social-connect/medium', {
        code: mediumCode('still-valid-token'),
        state: await mediumState(owner, '?refresh=medium-user-1'),
        timezone: '0',
      });
      expect(res.status).toBe(201);
      const rows = await db().integration.findMany({ where: { organizationId: orgId, internalId: 'medium-user-1' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(row.id);
      expect(rows[0].deletedAt).toBeNull();
      expect(rows[0].refreshNeeded).toBe(false);
      expect(rows[0].token).not.toBe(row.token);
    });

    it('a malformed submission is a 409 with a readable reason, not "Authentication failed"', async () => {
      const before = await db().integration.count({ where: { organizationId: orgId } });
      for (const code of ['not-base64-json %%%', Buffer.from('{"apiKey": "trunc').toString('base64'), mediumCode('  ')]) {
        const res = await t.api.post('/integrations/social-connect/medium', {
          code,
          state: await mediumState(owner),
          timezone: '0',
        });
        expect({ code, status: res.status, body: res.body }).toEqual({
          code,
          status: 409,
          body: { msg: 'Paste your Medium integration token to connect Medium.' },
        });
      }
      expect(await db().integration.count({ where: { organizationId: orgId } })).toBe(before);
    });

    it('a token Medium rejects is a 409 saying so, and creates nothing', async () => {
      fakeMedium({ status: 401, body: { errors: [{ message: 'Token was invalid.', code: 6003 }] } });
      const before = await db().integration.count({ where: { organizationId: orgId } });
      const res = await t.api.post('/integrations/social-connect/medium', {
        code: mediumCode('revoked'),
        state: await mediumState(owner),
        timezone: '0',
      });
      expect(res.status).toBe(409);
      expect(res.body.msg).toMatch(/^Medium did not accept this integration token/);
      expect(await db().integration.count({ where: { organizationId: orgId } })).toBe(before);
    });
  });

  describe('managing a channel', () => {
    let channelId: string;
    let intruder: Session;
    beforeAll(async () => {
      channelId = (await addChannel(orgId, 'bluesky', { name: 'Managed' })).id;
      intruder = await t.api.register({ company: 'Channel Intruder' });
      await givePlan((await intruder.self()).orgId, 'STANDARD');
    });

    it('GET /integrations/list shows the channel and never its tokens', async () => {
      const row = await db().integration.findUniqueOrThrow({ where: { id: channelId } });
      const res = await owner.get('/integrations/list');
      expect(res.status).toBe(200);
      const item = res.body.integrations.find((i: any) => i.id === channelId);
      expect(item).toMatchObject({ name: 'Managed', identifier: 'bluesky', disabled: false });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(row.token);
      expect(text).not.toContain(row.refreshToken!);
    });

    it('posting times: set by the owner, untouched by another workspace', async () => {
      const times = { time: [{ time: 600 }, { time: 900 }] };
      expect((await owner.post(`/integrations/${channelId}/time`, times)).status).toBe(201);
      await intruder.post(`/integrations/${channelId}/time`, { time: [{ time: 1 }] });
      const row = await db().integration.findUniqueOrThrow({ where: { id: channelId } });
      expect(JSON.parse(row.postingTimes)).toEqual([{ time: 600 }, { time: 900 }]);
    });

    it('disable and enable', async () => {
      expect((await owner.post('/integrations/disable', { id: channelId })).status).toBe(201);
      expect((await db().integration.findUniqueOrThrow({ where: { id: channelId } })).disabled).toBe(true);
      expect((await owner.post('/integrations/enable', { id: channelId })).status).toBe(201);
      expect((await db().integration.findUniqueOrThrow({ where: { id: channelId } })).disabled).toBe(false);
    });

    it('another workspace cannot disable it', async () => {
      await intruder.post('/integrations/disable', { id: channelId });
      expect((await db().integration.findUniqueOrThrow({ where: { id: channelId } })).disabled).toBe(false);
    });

    it('customer (group) name: set by the owner, not by another workspace', async () => {
      const set = await owner.put(`/integrations/${channelId}/customer-name`, { name: 'Client A' });
      expect(set.status).toBe(200);
      await intruder.put(`/integrations/${channelId}/customer-name`, { name: 'pwned' });
      const row = await db().integration.findUniqueOrThrow({
        where: { id: channelId },
        include: { customer: true },
      });
      expect(row.customer?.name).toBe('Client A');
      const customers = await owner.get('/integrations/customers');
      expect(JSON.stringify(customers.body)).toContain('Client A');
    });

    it('additional settings cannot be written by another workspace', async () => {
      const before = (await db().integration.findUniqueOrThrow({ where: { id: channelId } })).additionalSettings;
      await intruder.post(`/integrations/${channelId}/settings`, {
        additionalSettings: JSON.stringify([{ title: 'pwned', value: true }]),
      });
      const after = (await db().integration.findUniqueOrThrow({ where: { id: channelId } })).additionalSettings;
      expect(after).toBe(before);
    });

    it('another workspace cannot delete it; the owner can', async () => {
      await intruder.delete('/integrations', { body: { id: channelId } } as any);
      expect((await db().integration.findUniqueOrThrow({ where: { id: channelId } })).deletedAt).toBeNull();
      const res = await owner.request('DELETE', '/integrations', { body: { id: channelId } });
      expect(res.status).toBe(200);
      expect((await db().integration.findUniqueOrThrow({ where: { id: channelId } })).deletedAt).not.toBeNull();
    });
  });
});
