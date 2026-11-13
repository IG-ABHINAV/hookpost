/**
 * Hookpost as a ChatGPT connector (custom MCP server with OAuth), the way
 * ChatGPT talks to it as of OpenAI's Apps SDK auth docs (Oct 2026):
 *
 *  - discovery: 401 + WWW-Authenticate on /mcp-oauth, the protected-resource
 *    metadata, the authorization-server metadata whose issuer equals the
 *    resource's authorization_servers entry, S256 PKCE;
 *  - dynamic client registration with ChatGPT's redirect URIs under the
 *    production allowlist (DCR_VERIFIED_DOMAINS);
 *  - consent, then a form-encoded token request carrying `resource`, with
 *    the client authenticating in the body, with a Basic header, or (public)
 *    not at all;
 *  - MCP initialize, tools/list (every tool annotated), a read tool call;
 *  - and the ways it must break: bad PKCE, a reused or expired code, a wrong
 *    redirect_uri, wrong client credentials, a revoked approval, a deleted
 *    account, a removed member, another workspace's data, a workspace without
 *    a plan.
 *
 * The same flow is also run once with the official MCP TypeScript SDK client
 * (its own discovery, registration, PKCE and token request).
 */
import { createHash, randomBytes } from 'crypto';
import { startApp, TestApp } from './setup/app';
import { Session } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CHATGPT_CALLBACK_REDIRECT = 'https://chatgpt.com/connector/oauth/cb_123abc';
const PLATFORM_REDIRECT = 'https://platform.openai.com/apps-manage/oauth';
const CHALLENGE = 'openai-domain-token-for-tests';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const form = (fields: Record<string, string | undefined>) =>
  new URLSearchParams(
    Object.entries(fields).filter(([, v]) => v !== undefined) as [string, string][]
  ).toString();

const basic = (id: string, secret: string) =>
  'Basic ' +
  Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64');

describe('ChatGPT connector (OAuth MCP at /mcp-oauth)', () => {
  let t: TestApp;
  let owner: Session;
  let orgId: string;
  let channelId: string;
  let resource: string;
  const previous = {
    dcr: process.env.DCR_VERIFIED_DOMAINS,
    challenge: process.env.OPENAI_APP_CHALLANGE,
  };

  beforeAll(async () => {
    // Production's allowlist, and a domain-check token (read when the MCP
    // routes are mounted).
    process.env.DCR_VERIFIED_DOMAINS = 'claude.ai,claude.com,chatgpt.com,platform.openai.com';
    process.env.OPENAI_APP_CHALLANGE = `  ${CHALLENGE}\n`;
    t = await startApp({ mcp: true });
    owner = await t.api.register({ company: 'ChatGPT Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    channelId = (await addChannel(orgId, 'bluesky', { name: 'ChatGPT Bluesky' })).id;
    resource = new URL('/mcp-oauth', process.env.NEXT_PUBLIC_BACKEND_URL).toString();
  });
  afterAll(async () => {
    process.env.DCR_VERIFIED_DOMAINS = previous.dcr ?? '';
    process.env.OPENAI_APP_CHALLANGE = previous.challenge ?? '';
    await t?.close();
    await disconnectDb();
  });

  /** POST /oauth/register the way ChatGPT does. */
  async function registerChatGpt(
    method: 'client_secret_post' | 'client_secret_basic' | 'none' = 'client_secret_post',
    redirects = [CHATGPT_REDIRECT, CHATGPT_CALLBACK_REDIRECT]
  ) {
    const res = await t.api.post('/oauth/register', {
      client_name: 'ChatGPT',
      redirect_uris: redirects,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: method,
      scope: 'mcp:read mcp:write',
    });
    expect(res.status).toBe(201);
    return res.body as { client_id: string; client_secret?: string; token_endpoint_auth_method: string };
  }

  /** The consent page's two calls; returns the code from the redirect. */
  async function consent(
    session: Session,
    clientId: string,
    challenge: string,
    redirect = CHATGPT_REDIRECT
  ) {
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'chatgpt-state',
      scope: 'mcp:read mcp:write',
      resource,
    });
    const page = await t.api.get(`/oauth/authorize?${q}`);
    expect(page.status).toBe(200);
    const approve = await session.post('/oauth/authorize', {
      client_id: clientId,
      action: 'approve',
      state: 'chatgpt-state',
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(approve.status).toBe(201);
    const back = new URL(approve.body.redirect);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get('state')).toBe('chatgpt-state');
    return back.searchParams.get('code')!;
  }

  /** A form-encoded token request, as ChatGPT sends it. */
  function token(fields: Record<string, string | undefined>, headers: Record<string, string> = {}) {
    return t.api.request('POST', '/oauth/token', {
      raw: form({ grant_type: 'authorization_code', resource, ...fields }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });
  }

  /** Registration, consent and the token request; returns the token. */
  async function connect(session: Session = owner) {
    const client = await registerChatGpt();
    const { verifier, challenge } = pkce();
    const code = await consent(session, client.client_id, challenge);
    const res = await token({
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
      redirect_uri: CHATGPT_REDIRECT,
    });
    expect(res.status).toBe(200);
    return res.body.access_token as string;
  }

  let rpcId = 1;
  async function mcp(method: string, params: any, accessToken?: string, path = '/mcp-oauth') {
    return mcpAt(path, method, params, accessToken);
  }
  async function mcpAt(path: string, method: string, params: any, accessToken?: string) {
    const res = await fetch(t.baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      const data = /^data: (.*)$/m.exec(text)?.[1];
      if (data) body = JSON.parse(data);
    }
    return { status: res.status, headers: res.headers, body };
  }
  const callTool = (accessToken: string, name: string, args: any = {}) =>
    mcp('tools/call', { name, arguments: args }, accessToken);
  const toolText = (body: any): string => body?.result?.content?.[0]?.text ?? '';

  describe('discovery', () => {
    it('/mcp-oauth without a token: 401 pointing at the protected-resource metadata', async () => {
      const res = await mcp('initialize', {});
      expect(res.status).toBe(401);
      const header = res.headers.get('www-authenticate') || '';
      expect(header).toMatch(/^Bearer /);
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
      expect(metadataUrl).toBe(new URL('/.well-known/oauth-protected-resource/mcp-oauth', resource).toString());
    });

    it('protected-resource and authorization-server metadata meet ChatGPT\'s checks', async () => {
      const pr = await t.api.get('/.well-known/oauth-protected-resource/mcp-oauth');
      expect(pr.status).toBe(200);
      expect(pr.body.resource).toBe(resource);
      expect(pr.body.authorization_servers).toEqual([resource]);

      const as = await t.api.get('/.well-known/oauth-authorization-server/mcp-oauth');
      expect(as.status).toBe(200);
      // issuer must equal the authorization_servers entry exactly.
      expect(as.body.issuer).toBe(pr.body.authorization_servers[0]);
      expect(as.body.code_challenge_methods_supported).toContain('S256');
      expect(as.body.registration_endpoint).toMatch(/\/oauth\/register$/);
      expect(as.body.token_endpoint_auth_methods_supported).toEqual(
        expect.arrayContaining(['client_secret_post', 'client_secret_basic', 'none'])
      );
      // No OIDC scopes unless the ChatGPT client id is configured: ChatGPT
      // requests every advertised OIDC scope by default.
      expect(as.body.scopes_supported).toEqual(['mcp:read', 'mcp:write']);
      // Not claimed: issuer identification is not implemented.
      expect(as.body.authorization_response_iss_parameter_supported).toBeUndefined();
    });

    it('/.well-known/openai-apps-challenge serves the trimmed token as plain text', async () => {
      const res = await fetch(`${t.baseUrl}/.well-known/openai-apps-challenge`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toBe(CHALLENGE);
      expect((await fetch(`${t.baseUrl}/.well-known/openai-apps-challenge/other`)).status).toBe(404);
    });
  });

  describe('registration under the production allowlist', () => {
    it.each([
      ['the stable redirect', [CHATGPT_REDIRECT]],
      ['a callback-id redirect', [CHATGPT_CALLBACK_REDIRECT]],
      ['the OpenAI Platform dashboard', [PLATFORM_REDIRECT]],
      ['Claude', ['https://claude.ai/api/mcp/auth_callback']],
      ['a loopback CLI', ['http://127.0.0.1:43123/callback']],
    ])('accepts %s', async (_label, redirects) => {
      const res = await t.api.post('/oauth/register', { client_name: 'x', redirect_uris: redirects });
      expect(res.status).toBe(201);
    });

    it.each([
      ['another site', 'https://evil.example.com/cb'],
      ['a look-alike of chatgpt.com', 'https://chatgpt.com.evil.example/cb'],
      ['a host that only ends in chatgpt.com', 'https://notchatgpt.com/cb'],
      ['plain http on chatgpt.com', 'http://chatgpt.com/connector_platform_oauth_redirect'],
    ])('refuses %s', async (_label, redirect) => {
      const res = await t.api.post('/oauth/register', { redirect_uris: [CHATGPT_REDIRECT, redirect] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_redirect_uri');
    });

    it('answers with the auth method the client asked for', async () => {
      expect((await registerChatGpt('client_secret_post')).token_endpoint_auth_method).toBe('client_secret_post');
      const viaBasic = await registerChatGpt('client_secret_basic');
      expect(viaBasic.token_endpoint_auth_method).toBe('client_secret_basic');
      expect(viaBasic.client_secret).toMatch(/^pcs_/);
      const pub = await registerChatGpt('none');
      expect(pub.token_endpoint_auth_method).toBe('none');
      expect(pub.client_secret).toBeUndefined();
    });
  });

  describe('the token request', () => {
    it('form-encoded with resource and the secret in the body: a bearer token, never cached, no billing id', async () => {
      const client = await registerChatGpt('client_secret_post');
      const { verifier, challenge } = pkce();
      const code = await consent(owner, client.client_id, challenge);
      const res = await token({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        redirect_uri: CHATGPT_REDIRECT,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ token_type: 'bearer', scope: 'mcp:read mcp:write' });
      expect(res.body.access_token).toMatch(/^pos_/);
      expect(res.body).not.toHaveProperty('cus');
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('client_secret_basic: credentials in the Authorization header, no client_id in the body', async () => {
      const client = await registerChatGpt('client_secret_basic');
      const { verifier, challenge } = pkce();
      const code = await consent(owner, client.client_id, challenge);
      const res = await token(
        { code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT },
        { authorization: basic(client.client_id, client.client_secret!) }
      );
      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^pos_/);
    });

    it('a public client that leaves client_id out is the one the code was issued to', async () => {
      const client = await registerChatGpt('none');
      const { verifier, challenge } = pkce();
      const code = await consent(owner, client.client_id, challenge);
      const res = await token({ code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT });
      expect(res.status).toBe(200);
      expect(res.body.access_token).toMatch(/^pos_/);
    });

    it('a confidential client that leaves client_id out is refused (invalid_client)', async () => {
      const client = await registerChatGpt('client_secret_post');
      const { verifier, challenge } = pkce();
      const code = await consent(owner, client.client_id, challenge);
      const res = await token({ code, code_verifier: verifier, redirect_uri: CHATGPT_REDIRECT, client_secret: client.client_secret });
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_client');
      // The code is still good for the real request.
      const ok = await token({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        redirect_uri: CHATGPT_REDIRECT,
      });
      expect(ok.status).toBe(200);
    });

    describe('refuses', () => {
      let client: { client_id: string; client_secret?: string };
      let verifier: string;
      let code: string;
      beforeEach(async () => {
        client = await registerChatGpt('client_secret_post');
        const p = pkce();
        verifier = p.verifier;
        code = await consent(owner, client.client_id, p.challenge);
      });
      const good = () => ({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        redirect_uri: CHATGPT_REDIRECT,
      });

      it('a wrong code_verifier, and no code_verifier', async () => {
        for (const code_verifier of [pkce().verifier, undefined]) {
          const res = await token({ ...good(), code_verifier });
          expect(res.status).toBe(400);
          expect(res.body.error).toBe('invalid_grant');
        }
      });

      it('a code used twice', async () => {
        expect((await token(good())).status).toBe(200);
        const again = await token(good());
        expect(again.status).toBe(400);
        expect(again.body.error).toBe('invalid_grant');
      });

      it('an expired code (older than 10 minutes)', async () => {
        await db().oAuthAuthorization.updateMany({
          where: { oauthApp: { clientId: client.client_id } },
          data: { codeExpiresAt: new Date(Date.now() - 1000) },
        });
        const res = await token(good());
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'invalid_grant', error_description: 'Code has expired' });
      });

      it('a redirect_uri other than the one consented to (even another registered one)', async () => {
        const res = await token({ ...good(), redirect_uri: CHATGPT_CALLBACK_REDIRECT });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
      });

      it('a wrong secret, in the body or in a Basic header', async () => {
        expect((await token({ ...good(), client_secret: 'pcs_wrong' })).status).toBe(401);
        const { client_id, client_secret, ...rest } = good();
        expect((await token(rest, { authorization: basic(client_id, 'pcs_wrong') })).status).toBe(401);
        expect((await token(good())).status).toBe(200);
      });

      it('Basic credentials that disagree with the body, or are malformed', async () => {
        const other = await registerChatGpt('client_secret_post');
        const mismatch = await token(good(), { authorization: basic(other.client_id, other.client_secret!) });
        expect(mismatch.status).toBe(401);
        expect(mismatch.body.error).toBe('invalid_client');
        const { client_id, client_secret, ...rest } = good();
        const malformed = await token(rest, { authorization: 'Basic ' + Buffer.from('no-colon').toString('base64') });
        expect(malformed.status).toBe(401);
        expect(malformed.body.error).toBe('invalid_client');
      });

      it('the code at another client', async () => {
        const other = await registerChatGpt('client_secret_post');
        const res = await token({ ...good(), client_id: other.client_id, client_secret: other.client_secret });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
      });

      it('a made-up code', async () => {
        const res = await token({ ...good(), code: 'not-a-code' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_grant');
      });
    });

    it('consent refuses a redirect_uri the client did not register', async () => {
      const client = await registerChatGpt('client_secret_post', [CHATGPT_REDIRECT]);
      const { challenge } = pkce();
      const res = await owner.post('/oauth/authorize', {
        client_id: client.client_id,
        action: 'approve',
        redirect_uri: CHATGPT_CALLBACK_REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('MCP with the token', () => {
    let accessToken: string;
    beforeAll(async () => {
      accessToken = await connect();
    });

    it('initialize, tools/list with every tool annotated, and a read tool call', async () => {
      const init = await mcp('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'openai-mcp', version: '1.0.0' },
      }, accessToken);
      expect(init.status).toBe(200);
      expect(init.body.result.serverInfo.name).toBe('Hookpost MCP');
      expect(init.body.result.capabilities.tools).toBeDefined();

      const list = await mcp('tools/list', {}, accessToken);
      expect(list.status).toBe(200);
      const tools: any[] = list.body.result.tools;
      expect(tools.length).toBeGreaterThan(5);
      for (const tool of tools) {
        expect(tool.description?.trim()).toBeTruthy();
        for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
          expect([tool.name, hint, typeof tool.annotations?.[hint]]).toEqual([tool.name, hint, 'boolean']);
        }
      }
      // No catch-all agent tool on the directory-facing endpoint.
      expect(tools.map((tool) => tool.name)).not.toContain('ask_hookpost');
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      expect(byName.integrationList.readOnlyHint).toBe(true);
      expect(byName.postsListTool.readOnlyHint).toBe(true);
      expect(byName.integrationSchedulePostTool).toMatchObject({ readOnlyHint: false, destructiveHint: true });

      const call = await callTool(accessToken, 'integrationList');
      expect(call.status).toBe(200);
      expect(call.body.result.isError).toBeFalsy();
      expect(toolText(call.body)).toContain(channelId);
      expect(toolText(call.body)).not.toMatch(/fake-token|fake-refresh/);
    });

    it('cannot read or write another workspace', async () => {
      const other = await t.api.register({ company: 'Other Co' });
      const otherOrg = (await other.self()).orgId;
      await givePlan(otherOrg, 'STANDARD');
      const otherChannel = await addChannel(otherOrg, 'bluesky', { name: 'Not Yours' });

      const list = await callTool(accessToken, 'integrationList');
      expect(toolText(list.body)).not.toContain(otherChannel.id);

      const schedule = await callTool(accessToken, 'integrationSchedulePostTool', {
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
      expect(schedule.body.error || schedule.body.result?.isError || /error/i.test(toolText(schedule.body))).toBeTruthy();
    });

    it('a token issued for /mcp-oauth is refused with a made-up suffix', async () => {
      const res = await mcp('tools/list', {}, accessToken + 'x');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate') || '').toMatch(/error="invalid_token"/);
    });
  });

  describe('a token stops working', () => {
    it('when the user revokes the app (401 with a challenge, so ChatGPT asks to reconnect)', async () => {
      const accessToken = await connect();
      expect((await mcp('tools/list', {}, accessToken)).status).toBe(200);
      const approved = await owner.get('/user/approved-apps');
      for (const app of approved.body) {
        await owner.delete(`/user/approved-apps/${app.id}`);
      }
      const res = await mcp('tools/list', {}, accessToken);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate') || '').toMatch(/resource_metadata=/);
    });

    it('when ChatGPT connects again with the same client (the old token is replaced)', async () => {
      const client = await registerChatGpt('client_secret_post');
      const first = pkce();
      const firstCode = await consent(owner, client.client_id, first.challenge);
      const firstToken = (await token({
        code: firstCode, client_id: client.client_id, client_secret: client.client_secret,
        code_verifier: first.verifier, redirect_uri: CHATGPT_REDIRECT,
      })).body.access_token;
      const second = pkce();
      const secondCode = await consent(owner, client.client_id, second.challenge);
      const secondToken = (await token({
        code: secondCode, client_id: client.client_id, client_secret: client.client_secret,
        code_verifier: second.verifier, redirect_uri: CHATGPT_REDIRECT,
      })).body.access_token;
      expect((await mcp('tools/list', {}, firstToken)).status).toBe(401);
      expect((await mcp('tools/list', {}, secondToken)).status).toBe(200);
    });

    it('when the account is deleted', async () => {
      const user = await t.api.register({ company: 'Deleted Co' });
      const self = await user.self();
      await givePlan(self.orgId, 'STANDARD');
      const accessToken = await connect(user);
      expect((await mcp('tools/list', {}, accessToken)).status).toBe(200);
      await db().user.update({ where: { id: self.id }, data: { deletedAt: new Date() } });
      expect((await mcp('tools/list', {}, accessToken)).status).toBe(401);
    });

    it('when the user is removed from the workspace', async () => {
      const user = await t.api.register({ company: 'Removed Co' });
      const self = await user.self();
      await givePlan(self.orgId, 'STANDARD');
      const accessToken = await connect(user);
      expect((await mcp('tools/list', {}, accessToken)).status).toBe(200);
      await db().userOrganization.updateMany({
        where: { userId: self.id, organizationId: self.orgId },
        data: { disabled: true },
      });
      expect((await mcp('tools/list', {}, accessToken)).status).toBe(401);
    });
  });

  // needs_trial is a grandfathered workspace the Free plan sunset reached: a
  // workspace created now is before the (future) cutoff, and the sunset has
  // passed. A sign-up after a cutoff is free_posts since 28 Oct 2026 and is
  // not refused here.
  describe('a grandfathered workspace the Free plan sunset reached (no plan, needs_trial)', () => {
    let accessToken: string;
    let freshOrg: string;
    let freshChannel: string;
    beforeAll(async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = '2099-01-01T00:00:00Z';
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const fresh = await t.api.register({ company: 'No Plan Co' });
      const self = await fresh.self();
      freshOrg = self.orgId;
      await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
      freshChannel = (await addChannel(freshOrg, 'bluesky')).id;
      accessToken = await connect(fresh);
    });
    afterAll(() => {
      process.env.TRIAL_REQUIRED_SINCE_IN = '';
      process.env.FREE_PLAN_SUNSET_AT = '';
    });

    it('connects: initialize and tools/list answer, so ChatGPT adds the connector', async () => {
      const init = await mcp('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'openai-mcp', version: '1.0.0' },
      }, accessToken);
      expect(init.status).toBe(200);
      const list = await mcp('tools/list', {}, accessToken);
      expect(list.status).toBe(200);
      expect(list.body.result.tools.length).toBeGreaterThan(5);
    });

    it('every tool call answers with the reason and where to start the trial, and does nothing', async () => {
      const read = await callTool(accessToken, 'integrationList');
      expect(read.status).toBe(200);
      expect(read.body.result.isError).toBe(true);
      // Exactly the sentence, as the user should see it in ChatGPT: no
      // error object, no echo of the arguments.
      const billing = new URL('/billing?utm_source=mcp_paywall', process.env.FRONTEND_URL).toString();
      expect(toolText(read.body).replace(/\d+-day/, 'N-day')).toBe(
        `Hookpost needs an active plan to do this. Start your N-day trial here: ${billing} (it takes about a minute), then ask me again.`
      );
      expect(toolText(read.body)).not.toContain(freshChannel);

      const write = await callTool(accessToken, 'integrationSchedulePostTool', {
        socialPost: [
          {
            integrationId: freshChannel,
            isPremium: false,
            date: new Date(Date.now() + 2 * 86400_000).toISOString(),
            shortLink: false,
            type: 'draft',
            postsAndComments: [{ content: '<p>No plan</p>', attachments: [] }],
            settings: [],
          },
        ],
      });
      expect(write.body.result.isError).toBe(true);
      expect(await db().post.count({ where: { organizationId: freshOrg } })).toBe(0);
    });

    it('the Claude endpoint refuses the same way', async () => {
      expect((await mcpAt('/mcp-oauth-claude', 'tools/list', {}, accessToken)).status).toBe(200);
      const read = await mcpAt('/mcp-oauth-claude', 'tools/call', { name: 'integrationList', arguments: {} }, accessToken);
      expect(read.body.result.isError).toBe(true);
      expect(toolText(read.body)).toMatch(/^Hookpost needs an active plan to do this\. Start your \d+-day trial here: .*\/billing\?utm_source=mcp_paywall /);
      expect(toolText(read.body)).not.toContain(freshChannel);
    });

    it('interleaved calls from a workspace with a plan and one without each get their own answer', async () => {
      const paid = await connect();
      const calls = Array.from({ length: 16 }, (_, i) =>
        i % 2 ? callTool(accessToken, 'integrationList') : callTool(paid, 'integrationList')
      );
      const results = await Promise.all(calls);
      results.forEach((res, i) => {
        if (i % 2) {
          expect(res.body.result.isError).toBe(true);
          expect(toolText(res.body)).not.toContain(freshChannel);
        } else {
          expect(res.body.result.isError).toBeFalsy();
          expect(toolText(res.body)).toContain(channelId);
          expect(toolText(res.body)).not.toContain(freshChannel);
        }
      });
    });

    // Cursor and other API-key clients: the same sentence as a tool result
    // instead of a bare 402 the client shows as "connection failed".
    it('the API-key endpoints connect, list the tools without the agent, and refuse each call with the link', async () => {
      const key = await apiKeyOf(freshOrg);
      for (const [path, token] of [[`/mcp/${key}`, undefined], ['/mcp', key]] as const) {
        const init = await mcpAt(path, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'cursor', version: '1.0.0' },
        }, token);
        expect(init.status).toBe(200);
        const list = await mcpAt(path, 'tools/list', {}, token);
        expect(list.status).toBe(200);
        const names: string[] = list.body.result.tools.map((tool: any) => tool.name);
        expect(names).toContain('integrationList');
        // The agent would run the model before any tool: not offered here.
        expect(names).not.toContain('ask_hookpost');

        const read = await mcpAt(path, 'tools/call', { name: 'integrationList', arguments: {} }, token);
        expect(read.status).toBe(200);
        expect(read.body.result.isError).toBe(true);
        expect(toolText(read.body)).toMatch(/^Hookpost needs an active plan to do this\. Start your \d+-day trial here: .*\/billing\?utm_source=mcp_paywall \(it takes about a minute\), then ask me again\.$/);
        expect(toolText(read.body)).not.toContain(freshChannel);

        const write = await mcpAt(path, 'tools/call', {
          name: 'integrationSchedulePostTool',
          arguments: {
            socialPost: [
              {
                integrationId: freshChannel,
                isPremium: false,
                date: new Date(Date.now() + 2 * 86400_000).toISOString(),
                shortLink: false,
                type: 'draft',
                postsAndComments: [{ content: '<p>No plan</p>', attachments: [] }],
                settings: [],
              },
            ],
          },
        }, token);
        expect(write.body.result.isError).toBe(true);
      }
      expect(await db().post.count({ where: { organizationId: freshOrg } })).toBe(0);
    });

    it('once the workspace has a plan, the same token works', async () => {
      await givePlan(freshOrg, 'STANDARD');
      const read = await callTool(accessToken, 'integrationList');
      expect(read.body.result.isError).toBeFalsy();
      expect(toolText(read.body)).toContain(freshChannel);

      // The API key too, with the full server again (agent included).
      const key = await apiKeyOf(freshOrg);
      const list = await mcpAt(`/mcp/${key}`, 'tools/list', {});
      expect(list.body.result.tools.map((tool: any) => tool.name)).toContain('ask_hookpost');
      const viaKey = await mcpAt(`/mcp/${key}`, 'tools/call', { name: 'integrationList', arguments: {} });
      expect(viaKey.body.result.isError).toBeFalsy();
      expect(toolText(viaKey.body)).toContain(freshChannel);
    });
  });

  it('the official MCP SDK client: discovery, registration, PKCE, token, then tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');

    // The backend's public URL (resource, issuer) is NEXT_PUBLIC_BACKEND_URL;
    // the SDK fetches what discovery hands it, so send those URLs here.
    const publicBase = new URL(process.env.NEXT_PUBLIC_BACKEND_URL!).origin;
    const toLocal = (input: string | URL) => {
      const url = new URL(String(input));
      return url.origin === publicBase ? t.baseUrl + url.pathname + url.search : url.toString();
    };
    const localFetch: typeof fetch = (input: any, init?: any) =>
      fetch(toLocal(typeof input === 'string' || input instanceof URL ? input : input.url), init);

    const state: { client?: any; tokens?: any; verifier?: string; authUrl?: URL } = {};
    const provider = {
      get redirectUrl() {
        return CHATGPT_REDIRECT;
      },
      get clientMetadata() {
        return {
          client_name: 'ChatGPT',
          redirect_uris: [CHATGPT_REDIRECT],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'client_secret_basic',
        };
      },
      clientInformation: () => state.client,
      saveClientInformation: (info: any) => {
        state.client = info;
      },
      tokens: () => state.tokens,
      saveTokens: (tokens: any) => {
        state.tokens = tokens;
      },
      redirectToAuthorization: (url: URL) => {
        state.authUrl = url;
      },
      saveCodeVerifier: (verifier: string) => {
        state.verifier = verifier;
      },
      codeVerifier: () => state.verifier!,
    };

    const serverUrl = new URL('/mcp-oauth', publicBase);
    expect(await auth(provider as any, { serverUrl, fetchFn: localFetch })).toBe('REDIRECT');
    const authUrl = state.authUrl!;
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('resource')).toBe(resource);

    // The user approves on the consent page.
    const approve = await owner.post('/oauth/authorize', {
      client_id: authUrl.searchParams.get('client_id'),
      action: 'approve',
      state: authUrl.searchParams.get('state') ?? undefined,
      redirect_uri: authUrl.searchParams.get('redirect_uri'),
      code_challenge: authUrl.searchParams.get('code_challenge'),
      code_challenge_method: 'S256',
    });
    const code = new URL(approve.body.redirect).searchParams.get('code')!;
    expect(await auth(provider as any, { serverUrl, authorizationCode: code, fetchFn: localFetch })).toBe('AUTHORIZED');
    expect(state.tokens.access_token).toMatch(/^pos_/);

    const client = new Client({ name: 'chatgpt-like', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(serverUrl, { authProvider: provider as any, fetch: localFetch })
    );
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('integrationList');
    const result: any = await client.callTool({ name: 'integrationList', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain(channelId);
    await client.close();
  });
});
