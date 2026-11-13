/**
 * The connect handoff (nestjs-libraries/integrations/connect.handoff.ts) on the
 * real backend, Redis and database: a channel's credentials (Bluesky's app
 * password, Skool's cookies) reach the backend in a POST body and are
 * redeemed once by a one-time id, so the callback URL never carries them.
 * Only the provider's own authenticate is replaced.
 */
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { db, disconnectDb, givePlan } from './setup/db';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { CONNECT_LINK_EXPIRED } from '@hookpost/backend/api/routes/no.auth.integrations.controller';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');

describe('connect handoff', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  const logged: string[] = [];

  beforeAll(async () => {
    t = await startApp();
    owner = await t.api.register({ company: 'Handoff Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'PRO');
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });
  beforeEach(() => {
    logged.length = 0;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      const real = console[level].bind(console);
      jest.spyOn(console, level).mockImplementation((...args: any[]) => {
        logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
        if (process.env.INTEGRATION_LOGS) real(...args);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  const provider = (id: string): any =>
    t.get<IntegrationManager>(IntegrationManager).getSocialIntegration(id);
  const start = async (id: string) => {
    const res = await owner.get(`/integrations/social/${id}`);
    expect(res.status).toBe(200);
    return res.body.url as string;
  };
  const handOff = (id: string, body: Record<string, unknown>) =>
    t.api.post(`/integrations/social-connect/${id}/handoff`, body);
  const connect = (id: string, body: Record<string, unknown>) =>
    t.api.post(`/integrations/social-connect/${id}`, { timezone: '330', ...body });

  describe('Bluesky (custom fields: an app password)', () => {
    const fields = (n: string) => ({
      service: 'https://bsky.social',
      identifier: `handoff-${n}.bsky.social`,
      password: `app-password-${n}-SECRET`,
    });
    const fakeLogin = () =>
      jest.spyOn(provider('bluesky'), 'authenticate').mockImplementation(async (params: any) => {
        const f = JSON.parse(Buffer.from(params.code, 'base64').toString());
        return {
          id: `did:plc:${f.identifier}`,
          name: `Handoff ${f.identifier}`,
          accessToken: 'bsky-access',
          refreshToken: 'bsky-refresh',
          expiresIn: 3600,
          picture: '',
          username: f.identifier,
        } as any;
      });

    it('handed over, redeemed once, the channel saved with the fields encrypted', async () => {
      const auth = fakeLogin();
      const state = await start('bluesky');
      const code = encode(fields('a'));

      const res = await handOff('bluesky', { state, code });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['handoff']);
      expect(res.body.handoff).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const key = `connect-handoff:${res.body.handoff}`;
      const ttl = await ioRedis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);

      const done = await connect('bluesky', { state, handoff: res.body.handoff });
      expect(done.status).toBe(201);
      expect(auth.mock.calls[0][0]).toMatchObject({ code });
      expect(await ioRedis.exists(key)).toBe(0);
      const row = await db().integration.findUniqueOrThrow({ where: { id: done.body.id } });
      expect(row.organizationId).toBe(orgId);
      expect(row.customInstanceDetails).not.toContain('SECRET');
      expect(JSON.parse(AuthService.fixedDecryption(row.customInstanceDetails!))).toEqual(fields('a'));
      expect(JSON.stringify(done.body)).not.toContain('SECRET');

      // Redeemed again (Back, a reload): the finished connect, no second login.
      const again = await connect('bluesky', { state, handoff: res.body.handoff });
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({ id: done.body.id, alreadyConnected: true });
      expect(auth).toHaveBeenCalledTimes(1);

      // Not one log line carries the password or its encoding.
      expect(logged.filter((l) => l.includes('SECRET') || l.includes(code))).toEqual([]);
    });

    it('the state is used up: someone who saw the callback URL cannot add their own account with it', async () => {
      const auth = fakeLogin();
      const state = await start('bluesky');
      const { body } = await handOff('bluesky', { state, code: encode(fields('victim')) });
      const done = await connect('bluesky', { state, handoff: body.handoff });
      expect(done.status).toBe(201);
      expect(await ioRedis.exists(`organization:${state}`)).toBe(0);

      const replay = await connect('bluesky', { state, code: encode(fields('attacker')) });
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ id: done.body.id, alreadyConnected: true });
      expect((await handOff('bluesky', { state, code: encode(fields('attacker')) })).status).toBe(400);
      expect(auth).toHaveBeenCalledTimes(1);
      expect(
        await db().integration.count({ where: { internalId: 'did:plc:handoff-attacker.bsky.social' } })
      ).toBe(0);
    });

    it('a state made for another provider (Skool) cannot connect Bluesky', async () => {
      const auth = fakeLogin();
      const skoolState = await start('skool');
      expect(await ioRedis.get(`provider:${skoolState}`)).toBe('skool');
      const direct = await connect('bluesky', { state: skoolState, code: encode(fields('x')) });
      expect(direct.status).toBe(400);
      const viaHandoff = await handOff('bluesky', { state: skoolState, code: encode(fields('x')) });
      expect(viaHandoff.status).toBe(400);
      expect(auth).not.toHaveBeenCalled();
    });

    it('an old link with the fields in the body as `code` still connects', async () => {
      fakeLogin();
      const state = await start('bluesky');
      const res = await connect('bluesky', { state, code: encode(fields('b')) });
      expect(res.status).toBe(201);
    });

    it('a handoff for one connect cannot finish another', async () => {
      const auth = fakeLogin();
      const mine = await start('bluesky');
      const theirs = await start('bluesky');
      const { body } = await handOff('bluesky', { state: theirs, code: encode(fields('c')) });
      const res = await connect('bluesky', { state: mine, handoff: body.handoff });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(CONNECT_LINK_EXPIRED);
      expect(auth).not.toHaveBeenCalled();
    });

    it('a code and a handoff together is refused', async () => {
      const auth = fakeLogin();
      const state = await start('bluesky');
      const { body } = await handOff('bluesky', { state, code: encode(fields('d')) });
      const res = await connect('bluesky', { state, handoff: body.handoff, code: encode(fields('d')) });
      expect(res.status).toBe(400);
      expect(auth).not.toHaveBeenCalled();
    });
  });

  describe('Skool (the Chrome extension\'s cookies)', () => {
    const cookies = { client_id: 'skool-client-SECRET', auth_token: 'skool-token-SECRET' };

    it('handed over and redeemed: the channel, its extension token, the cookies encrypted', async () => {
      jest.spyOn(provider('skool'), 'authenticate').mockResolvedValue({
        id: 'skool-member-1',
        name: 'Skool Member',
        accessToken: 'encrypted',
        refreshToken: '',
        expiresIn: 3600,
        picture: '',
        username: 'skoolmember',
      } as any);
      const state = await start('skool');
      const { status, body } = await handOff('skool', { state, code: encode(cookies) });
      expect(status).toBe(200);
      const done = await connect('skool', { state, handoff: body.handoff });
      expect(done.status).toBe(201);
      expect(done.body.extensionToken).toEqual(expect.any(String));
      const row = await db().integration.findUniqueOrThrow({ where: { id: done.body.id } });
      expect(JSON.parse(AuthService.fixedDecryption(row.customInstanceDetails!))).toEqual(cookies);
      expect(logged.filter((l) => l.includes('SECRET'))).toEqual([]);
    });
  });

  describe('what the handoff endpoint refuses', () => {
    it('an OAuth provider: its code comes from its own redirect', async () => {
      // Refused on the provider alone, before any state is looked at.
      const bluesky = await start('bluesky');
      const res = await handOff('linkedin', { state: bluesky, code: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe('This channel connects through its own sign-in page');
    });

    it('a state that is not a live connect', async () => {
      const res = await handOff('bluesky', { state: 'not-a-state', code: encode({}) });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(CONNECT_LINK_EXPIRED);
    });

    it('a provider that is not on the list', async () => {
      const res = await handOff('myspace', { state: 'x', code: 'x' });
      expect(res.status).toBe(400);
    });

    it('credentials over 16 KB, a missing state or code (validation)', async () => {
      const state = await start('bluesky');
      expect((await handOff('bluesky', { state, code: 'a'.repeat(16 * 1024 + 1) })).status).toBe(400);
      expect((await handOff('bluesky', { code: 'x' })).status).toBe(400);
      expect((await handOff('bluesky', { state })).status).toBe(400);
    });

    it('a handoff id that is not one we make', async () => {
      const state = await start('bluesky');
      for (const handoff of ['../../x', 'short', 'A'.repeat(44), 'connect-handoff:*']) {
        const res = await connect('bluesky', { state, handoff });
        expect([handoff, res.status]).toEqual([handoff, 400]);
      }
    });

    it('more than 5 handoffs for one connect: 429', async () => {
      const state = await start('bluesky');
      for (let i = 0; i < 5; i++) {
        expect((await handOff('bluesky', { state, code: encode({ i }) })).status).toBe(200);
      }
      expect((await handOff('bluesky', { state, code: encode({ i: 6 }) })).status).toBe(429);
    });
  });
});
