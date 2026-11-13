/**
 * Hookpost as an OAuth provider, and the remote MCP server that the Claude
 * and ChatGPT connectors talk to through it.
 *
 *  - Dynamic client registration (RFC 7591), the consent step, the PKCE code
 *    exchange, and the pos_ token that comes out of it: it works on the public
 *    API and on /mcp-oauth, and stops working when the user revokes the app.
 *  - The static OAuth app a workspace registers under Settings -> Developers.
 *  - The remote MCP endpoints (/mcp, /mcp/:apiKey, /mcp-oauth,
 *    /mcp-oauth-claude): auth, discovery metadata, the tool list each one
 *    exposes, and real tool calls that read and write the workspace.
 *
 * The MCP routes are mounted the way main.ts mounts them (startMcp). Nothing
 * here calls an AI model: the tools used are the ones that only touch the
 * database.
 */
import { createHash, randomBytes } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

const REDIRECT = 'https://client.example.com/callback';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

describe('OAuth provider and remote MCP', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let apiKey: string;
  let channelId: string;

  beforeAll(async () => {
    t = await startApp({ mcp: true });
    owner = await t.api.register({ company: 'OAuth Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    apiKey = await apiKeyOf(orgId);
    channelId = (await addChannel(orgId, 'bluesky', { name: 'OAuth Bluesky' })).id;
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  /** Registers a public (PKCE-only) dynamic client, as Claude does. */
  async function registerPublicClient(redirect = REDIRECT) {
    const res = await t.api.post('/oauth/register', {
      redirect_uris: [redirect],
      client_name: 'Test MCP Client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
    });
    expect(res.status).toBe(201);
    return res.body as { client_id: string; client_secret?: string };
  }

  /** Runs consent and the code exchange; returns the access token. */
  async function authorize(session: Session, clientId: string) {
    const { verifier, challenge } = pkce();
    const approve = await session.post('/oauth/authorize', {
      client_id: clientId,
      action: 'approve',
      state: 'xyz',
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(approve.status).toBe(201);
    const code = new URL(approve.body.redirect).searchParams.get('code')!;
    const token = await t.api.post('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    });
    expect(token.status).toBe(200);
    return { token: token.body.access_token as string, code, verifier };
  }

  describe('dynamic client registration', () => {
    it('a confidential client gets an id and a secret', async () => {
      const res = await t.api.post('/oauth/register', { redirect_uris: [REDIRECT], client_name: 'Confidential' });
      expect(res.status).toBe(201);
      expect(res.body.client_id).toMatch(/^pcd_/);
      expect(res.body.client_secret).toMatch(/^pcs_/);
      expect(res.body).toMatchObject({ token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code'] });
    });

    it('a public client (token_endpoint_auth_method none) gets no secret', async () => {
      const body = await registerPublicClient();
      expect(body.client_id).toMatch(/^pcd_/);
      expect(body.client_secret).toBeUndefined();
    });

    it('a loopback http redirect is allowed (CLI and desktop clients)', async () => {
      const res = await t.api.post('/oauth/register', { redirect_uris: ['http://127.0.0.1:33418/callback'] });
      expect(res.status).toBe(201);
    });

    it.each([
      ['plain http on a public host', { redirect_uris: ['http://client.example.com/cb'] }],
      ['no redirect at all', { redirect_uris: [] }],
      ['a grant type other than authorization_code', { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }],
    ])('refuses %s', async (_label, body) => {
      const res = await t.api.post('/oauth/register', body);
      expect(res.status).toBe(400);
    });
  });

  describe('consent and token exchange', () => {
    it('GET /oauth/authorize describes the app for the consent page', async () => {
      const { client_id } = await registerPublicClient();
      const { challenge } = pkce();
      const q = new URLSearchParams({
        client_id,
        response_type: 'code',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's1',
      });
      const res = await t.api.get(`/oauth/authorize?${q}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ app: { name: 'Test MCP Client', clientId: client_id }, state: 's1' });
    });

    it.each([
      ['a redirect_uri that was not registered', { redirect_uri: 'https://evil.example.com/cb' }],
      ['no PKCE challenge from a public client', { code_challenge: undefined }],
      ['a plain (non-S256) challenge', { code_challenge_method: 'plain' }],
      ['an unknown client', { client_id: 'pcd_does_not_exist' }],
    ])('GET /oauth/authorize refuses %s', async (_label, override: Record<string, string | undefined>) => {
      const { client_id } = await registerPublicClient();
      const { challenge } = pkce();
      const params: Record<string, string | undefined> = {
        client_id,
        response_type: 'code',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...override,
      };
      const q = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][]
      );
      expect((await t.api.get(`/oauth/authorize?${q}`)).status).toBe(400);
    });

    it('approving needs a signed-in user', async () => {
      const { client_id } = await registerPublicClient();
      const res = await t.api.post('/oauth/authorize', { client_id, action: 'approve', redirect_uri: REDIRECT });
      expect(res.status).toBe(401);
    });

    it('deny sends the user back with access_denied and the state', async () => {
      const { client_id } = await registerPublicClient();
      const { challenge } = pkce();
      const res = await owner.post('/oauth/authorize', {
        client_id,
        action: 'deny',
        state: 'st',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const back = new URL(res.body.redirect);
      expect(back.origin + back.pathname).toBe(REDIRECT);
      expect(back.searchParams.get('error')).toBe('access_denied');
      expect(back.searchParams.get('state')).toBe('st');
      expect(back.searchParams.get('code')).toBeNull();
    });

    it('approve -> code -> pos_ token; the code works once', async () => {
      const { client_id } = await registerPublicClient();
      const { token, code, verifier } = await authorize(owner, client_id);
      expect(token).toMatch(/^pos_/);

      const again = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      });
      expect(again.status).toBe(400);
      expect(again.body.error).toBe('invalid_grant');
    });

    it('a wrong code_verifier is refused', async () => {
      const { client_id } = await registerPublicClient();
      const { challenge } = pkce();
      const approve = await owner.post('/oauth/authorize', {
        client_id,
        action: 'approve',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const code = new URL(approve.body.redirect).searchParams.get('code')!;
      const res = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id,
        code_verifier: pkce().verifier,
        redirect_uri: REDIRECT,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_grant');
    });

    it('a code issued to one client cannot be redeemed by another', async () => {
      const a = await registerPublicClient();
      const b = await registerPublicClient();
      const { challenge, verifier } = pkce();
      const approve = await owner.post('/oauth/authorize', {
        client_id: a.client_id,
        action: 'approve',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      const code = new URL(approve.body.redirect).searchParams.get('code')!;
      const res = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: b.client_id,
        code_verifier: verifier,
        redirect_uri: REDIRECT,
      });
      expect(res.status).toBe(400);
    });

    it('only the authorization_code grant is supported', async () => {
      const res = await t.api.post('/oauth/token', { grant_type: 'password', code: 'x', client_id: 'y' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('unsupported_grant_type');
    });

    it('the pos_ token works on the public API, is listed, and stops working once revoked', async () => {
      const { client_id } = await registerPublicClient();
      const { token } = await authorize(owner, client_id);

      expect((await t.api.publicApi(token, 'GET', '/is-connected')).status).toBe(200);
      const channels = await t.api.publicApi(token, 'GET', '/integrations');
      expect(channels.body.map((c: any) => c.id)).toContain(channelId);

      const approved = await owner.get('/user/approved-apps');
      expect(approved.status).toBe(200);
      const entry = approved.body.find((a: any) => (a.oauthApp?.clientId ?? a.clientId) === client_id) ?? approved.body[0];
      expect(entry).toBeDefined();
      // The list is for the consent screen: it never carries the token.
      expect(JSON.stringify(approved.body)).not.toContain(token);

      const revoke = await owner.delete(`/user/approved-apps/${entry.id}`);
      expect(revoke.status).toBe(200);
      expect((await t.api.publicApi(token, 'GET', '/is-connected')).status).toBe(401);
    });

    it('another user cannot revoke your approval', async () => {
      const { client_id } = await registerPublicClient();
      const { token } = await authorize(owner, client_id);
      const approved = await owner.get('/user/approved-apps');
      const stranger = await t.api.register();
      for (const app of approved.body) {
        await stranger.delete(`/user/approved-apps/${app.id}`);
      }
      expect((await t.api.publicApi(token, 'GET', '/is-connected')).status).toBe(200);
    });

    // Until 22 Oct 2026 revokeAuthorization used update() where {id, userId},
    // which throws P2025 when nothing matches: a 500.
    it('revoking an approval you do not own answers 404', async () => {
      const { client_id } = await registerPublicClient();
      const { token } = await authorize(owner, client_id);
      const approved = await owner.get('/user/approved-apps');
      const stranger = await t.api.register();
      const res = await stranger.delete(`/user/approved-apps/${approved.body[0].id}`);
      expect(res.status).toBe(404);
      expect((await t.api.publicApi(token, 'GET', '/is-connected')).status).toBe(200);
      expect((await stranger.delete('/user/approved-apps/no-such-approval')).status).toBe(404);
    });

    it('/oauth/userinfo is off unless the ChatGPT client id is configured', async () => {
      expect((await t.api.get('/oauth/userinfo')).status).toBe(404);
    });
  });

  describe('static OAuth app (Settings -> Developers)', () => {
    it('create, read without the secret, rotate, delete; scoped to the workspace', async () => {
      const dev = await t.api.register({ company: 'Dev Co' });
      await givePlan((await dev.self()).orgId, 'STANDARD');

      const created = await dev.post('/user/oauth-app', { name: 'My App', redirectUrl: 'https://myapp.example.com/cb' });
      expect(created.status).toBe(201);
      const clientSecret: string = created.body.clientSecret;
      expect(clientSecret).toBeTruthy();

      const read = await dev.get('/user/oauth-app');
      expect(read.status).toBe(200);
      expect(read.body.clientId).toBeTruthy();
      expect(JSON.stringify(read.body)).not.toContain(clientSecret);

      const stranger = await t.api.register();
      const theirs = await stranger.get('/user/oauth-app');
      expect(theirs.body?.clientId).not.toBe(read.body.clientId);

      const rotated = await dev.post('/user/oauth-app/rotate-secret');
      expect(rotated.body.clientSecret).toBeTruthy();
      expect(rotated.body.clientSecret).not.toBe(clientSecret);

      // The token endpoint wants the current secret from a confidential app.
      const approve = await dev.post('/oauth/authorize', { client_id: read.body.clientId, action: 'approve' });
      const code = new URL(approve.body.redirect).searchParams.get('code')!;
      const withOld = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: read.body.clientId,
        client_secret: clientSecret,
      });
      expect(withOld.status).toBe(401);
      const withNew = await t.api.post('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        client_id: read.body.clientId,
        client_secret: rotated.body.clientSecret,
      });
      expect(withNew.status).toBe(200);
      expect(withNew.body.access_token).toMatch(/^pos_/);

      expect((await dev.delete('/user/oauth-app')).status).toBe(200);
      expect((await dev.delete('/user/oauth-app')).status).toBe(404);
    });
  });

  describe('remote MCP server', () => {
    let rpcId = 1;
    async function mcp(path: string, method: string, params: any = {}, headers: Record<string, string> = {}) {
      const res = await fetch(t.baseUrl + path, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
      });
      const text = await res.text();
      let body: any = text;
      try {
        body = JSON.parse(text);
      } catch {
        // An SSE frame: take the JSON from its data line.
        const data = /^data: (.*)$/m.exec(text)?.[1];
        if (data) body = JSON.parse(data);
      }
      return { status: res.status, body, text };
    }
    const toolNames = (body: any): string[] => (body?.result?.tools || []).map((tool: any) => tool.name).sort();
    const callTool = (path: string, name: string, args: any, headers?: Record<string, string>) =>
      mcp(path, 'tools/call', { name, arguments: args }, headers);
    const toolOutput = (body: any) => {
      const r = body?.result;
      if (r?.structuredContent) return r.structuredContent;
      const text = r?.content?.[0]?.text;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    };

    it('initialize answers with the server name', async () => {
      const res = await mcp(`/mcp/${apiKey}`, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1' },
      });
      expect(res.status).toBe(200);
      expect(res.body.result.serverInfo.name).toBe('Hookpost MCP');
    });

    it('/mcp without a token is 401; with a wrong key is 401', async () => {
      expect((await mcp('/mcp', 'tools/list')).status).toBe(401);
      expect((await mcp('/mcp', 'tools/list', {}, { authorization: 'Bearer not-a-key' })).status).toBe(401);
    });

    it('/mcp/:key with an unknown key is refused', async () => {
      expect((await mcp('/mcp/not-a-real-key', 'tools/list')).status).toBe(400);
    });

    it('/mcp/:key lists the scheduling tools', async () => {
      const res = await mcp(`/mcp/${apiKey}`, 'tools/list');
      expect(res.status).toBe(200);
      const names = toolNames(res.body);
      for (const name of ['integrationList', 'integrationSchedulePostTool', 'postsListTool', 'uploadFromUrlTool', 'generateImageTool']) {
        expect(names).toContain(name);
      }
    });

    it('/mcp with "Bearer <api key>" works the same', async () => {
      const res = await mcp('/mcp', 'tools/list', {}, { authorization: `Bearer ${apiKey}` });
      expect(res.status).toBe(200);
      expect(toolNames(res.body)).toContain('integrationList');
    });

    // Smithery's gateway reserves Authorization, so it sends the key here.
    describe('/mcp with the key in x-hookpost-api-key', () => {
      const initialize = {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1' },
      };

      it('initialize and tools/list work with the raw key', async () => {
        const init = await mcp('/mcp', 'initialize', initialize, { 'x-hookpost-api-key': apiKey });
        expect(init.status).toBe(200);
        expect(init.body.result.serverInfo.name).toBe('Hookpost MCP');

        const list = await mcp('/mcp', 'tools/list', {}, { 'x-hookpost-api-key': apiKey });
        expect(list.status).toBe(200);
        expect(toolNames(list.body)).toContain('integrationList');
      });

      it('a "Bearer " prefix in the header is tolerated', async () => {
        const res = await mcp('/mcp', 'tools/list', {}, { 'x-hookpost-api-key': `Bearer ${apiKey}` });
        expect(res.status).toBe(200);
        expect(toolNames(res.body)).toContain('integrationList');
      });

      it('a wrong key is 401, the same answer as a wrong key in Authorization', async () => {
        const viaHeader = await mcp('/mcp', 'tools/list', {}, { 'x-hookpost-api-key': 'not-a-key' });
        const viaAuth = await mcp('/mcp', 'tools/list', {}, { authorization: 'Bearer not-a-key' });
        expect(viaHeader.status).toBe(401);
        expect(viaHeader.text).toBe('Invalid API Key or OAuth token');
        expect(viaHeader.text).toBe(viaAuth.text);
      });

      it('an empty header is 401, the same as no header', async () => {
        const res = await mcp('/mcp', 'tools/list', {}, { 'x-hookpost-api-key': '' });
        expect(res.status).toBe(401);
        expect(res.text).toBe('Missing Authorization header');
      });

      it('both headers: Authorization is the one used', async () => {
        const authGood = await mcp('/mcp', 'tools/list', {}, {
          authorization: `Bearer ${apiKey}`,
          'x-hookpost-api-key': 'not-a-key',
        });
        expect(authGood.status).toBe(200);
        expect(toolNames(authGood.body)).toContain('integrationList');

        const authBad = await mcp('/mcp', 'tools/list', {}, {
          authorization: 'Bearer not-a-key',
          'x-hookpost-api-key': apiKey,
        });
        expect(authBad.status).toBe(401);
        expect(authBad.text).toBe('Invalid API Key or OAuth token');
      });

      it('a real tool call reads this workspace with the header key', async () => {
        const res = await callTool('/mcp', 'integrationList', {}, { 'x-hookpost-api-key': apiKey });
        expect(res.status).toBe(200);
        expect(res.body.result.isError).toBeFalsy();
        expect(JSON.stringify(toolOutput(res.body))).toContain(channelId);
      });

      it('the OAuth endpoints do not take the header', async () => {
        const res = await mcp('/mcp-oauth', 'tools/list', {}, { 'x-hookpost-api-key': apiKey });
        expect(res.status).toBe(401);
      });
    });

    it('integrationList returns this workspace\'s channels only', async () => {
      const other = await t.api.register();
      const otherOrg = (await other.self()).orgId;
      await givePlan(otherOrg, 'STANDARD');
      const otherChannel = await addChannel(otherOrg, 'bluesky', { name: 'Not Yours' });

      const res = await callTool(`/mcp/${apiKey}`, 'integrationList', {});
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBeFalsy();
      const ids = JSON.stringify(toolOutput(res.body));
      expect(ids).toContain(channelId);
      expect(ids).not.toContain(otherChannel.id);
      // No stored credential reaches an AI client.
      expect(ids).not.toMatch(/fake-token|fake-refresh/);
    });

    it('integrationSchedulePostTool saves a draft for the workspace', async () => {
      const before = await db().post.count({ where: { organizationId: orgId, deletedAt: null } });
      const res = await callTool(`/mcp/${apiKey}`, 'integrationSchedulePostTool', {
        socialPost: [
          {
            integrationId: channelId,
            isPremium: false,
            date: new Date(Date.now() + 2 * 86400_000).toISOString(),
            shortLink: false,
            type: 'draft',
            postsAndComments: [{ content: '<p>From the MCP test</p>', attachments: [] }],
            settings: [],
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBeFalsy();
      const after = await db().post.findMany({ where: { organizationId: orgId, deletedAt: null } });
      expect(after.length).toBe(before + 1);
      expect(after.some((p) => p.content.includes('From the MCP test') && p.state === 'DRAFT')).toBe(true);
    });

    it('integrationSchedulePostTool cannot post to another workspace\'s channel', async () => {
      const other = await t.api.register();
      const otherOrg = (await other.self()).orgId;
      const otherChannel = await addChannel(otherOrg, 'bluesky');
      const res = await callTool(`/mcp/${apiKey}`, 'integrationSchedulePostTool', {
        socialPost: [
          {
            integrationId: otherChannel.id,
            isPremium: false,
            date: new Date(Date.now() + 2 * 86400_000).toISOString(),
            shortLink: false,
            type: 'draft',
            postsAndComments: [{ content: '<p>Should not land</p>', attachments: [] }],
            settings: [],
          },
        ],
      });
      expect(await db().post.count({ where: { integrationId: otherChannel.id } })).toBe(0);
      // Either an MCP error result or a JSON-RPC error, never a saved post.
      expect(res.body.error || res.body.result?.isError || toolOutput(res.body)?.output?.errors).toBeTruthy();
    });

    it('a grandfathered workspace the Free plan sunset reached (needs_trial) is refused by the plan gate', async () => {
      // Made now it is before this future cutoff, and the sunset has passed.
      // A sign-up after a cutoff is free_posts since 28 Oct 2026.
      process.env.TRIAL_REQUIRED_SINCE_IN = '2099-01-01T00:00:00Z';
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      try {
        const fresh = await t.api.register();
        const self = await fresh.self();
        await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
        const key = await apiKeyOf(self.orgId);
        // Connects (tools/list answers), and every tool call is refused with
        // the way to start the trial instead of a bare 402 (since 27 Oct).
        const list = await mcp(`/mcp/${key}`, 'tools/list');
        expect(list.status).toBe(200);
        const res = await callTool(`/mcp/${key}`, 'integrationList', {});
        expect(res.body.result?.isError).toBe(true);
        expect(JSON.stringify(res.body)).toContain('/billing?utm_source=mcp_paywall');
      } finally {
        process.env.TRIAL_REQUIRED_SINCE_IN = '';
        process.env.FREE_PLAN_SUNSET_AT = '';
      }
    });

    // Red team, 2 Nov 2026: ask_hookpost ran the model for any API key with no
    // AI check and no credit. It now takes one ai_text credit like the app's
    // agent, so a workspace with none is refused before the model runs.
    describe('ask_hookpost is metered like the in-app agent', () => {
      it('a Free workspace (no AI on its plan) is refused and nothing is metered', async () => {
        const fresh = await t.api.register();
        const self = await fresh.self();
        const key = await apiKeyOf(self.orgId);

        const res = await callTool(`/mcp/${key}`, 'ask_hookpost', { message: 'Write me 50 posts' });

        expect(res.body.result?.isError).toBe(true);
        expect(JSON.stringify(res.body)).toContain("Hookpost AI isn't available on this workspace");
        expect(await db().credits.count({ where: { organizationId: self.orgId } })).toBe(0);
      });

      it('a paid workspace whose monthly AI allowance is used up is refused', async () => {
        const fresh = await t.api.register();
        const self = await fresh.self();
        await givePlan(self.orgId, 'STANDARD');
        const { pricing } = await import(
          '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing'
        );
        const allowance = pricing.STANDARD.ai_generation_count;
        await db().credits.createMany({
          data: Array.from({ length: allowance }, () => ({
            organizationId: self.orgId,
            credits: 1,
            type: 'ai_text',
          })),
        });
        const key = await apiKeyOf(self.orgId);

        const res = await callTool('/mcp', 'ask_hookpost', { message: 'hi' }, { authorization: `Bearer ${key}` });

        expect(res.body.result?.isError).toBe(true);
        expect(JSON.stringify(res.body)).toContain("Hookpost AI isn't available on this workspace");
        expect(await db().credits.count({ where: { organizationId: self.orgId } })).toBe(allowance);
      });
    });

    describe('OAuth-protected endpoints', () => {
      it('discovery: protected-resource and authorization-server metadata', async () => {
        const pr = await t.api.get('/.well-known/oauth-protected-resource/mcp-oauth');
        expect(pr.status).toBe(200);
        expect(pr.body.resource).toBe('http://localhost:3000/mcp-oauth');

        const as = await t.api.get('/.well-known/oauth-authorization-server/mcp-oauth');
        expect(as.status).toBe(200);
        expect(as.body).toMatchObject({
          issuer: 'http://localhost:3000/mcp-oauth',
          authorization_endpoint: 'http://localhost:4200/oauth/authorize',
          token_endpoint: 'http://localhost:3000/oauth/token',
          registration_endpoint: 'http://localhost:3000/oauth/register',
          code_challenge_methods_supported: ['S256'],
        });
      });

      it('the root path does not advertise OAuth (so /mcp/:key clients are not asked for it)', async () => {
        const res = await t.api.get('/.well-known/oauth-protected-resource');
        expect(res.status).toBe(404);
      });

      it('/mcp-oauth without a token is 401 with a WWW-Authenticate pointer', async () => {
        const res = await fetch(`${t.baseUrl}/mcp-oauth`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate') || '').toMatch(/resource_metadata/);
      });

      it('/mcp-oauth with a pos_ token lists tools; /mcp-oauth-claude hides AI media generation', async () => {
        const { client_id } = await registerPublicClient();
        const { token } = await authorize(owner, client_id);
        const auth = { authorization: `Bearer ${token}` };

        const full = await mcp('/mcp-oauth', 'tools/list', {}, auth);
        expect(full.status).toBe(200);
        expect(toolNames(full.body)).toContain('generateImageTool');

        const claude = await mcp('/mcp-oauth-claude', 'tools/list', {}, auth);
        expect(claude.status).toBe(200);
        const names = toolNames(claude.body);
        expect(names).toContain('integrationList');
        for (const hidden of ['generateImageTool', 'generateVideoTool', 'generateVideoOptions', 'videoFunctionTool']) {
          expect(names).not.toContain(hidden);
        }
      });
    });
  });
});
