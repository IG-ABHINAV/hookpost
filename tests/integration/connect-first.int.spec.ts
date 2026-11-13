/**
 * Connect first (25 Oct 2026): a workspace that has to start its trial
 * (needs_trial) may connect PRE_TRIAL_CHANNEL_LIMIT (1) channel before it,
 * and the trial still comes before anything else: posts and schedules, AI,
 * webhooks, autopost, analytics, the platform-calling helpers, MCP and the
 * public API all refuse it. Against the real backend; only the providers'
 * token exchange and page list are replaced, and nothing may leave the
 * machine (network-guard.cjs), so a refused AI call is proven not to reach
 * OpenAI.
 *
 * The cutoffs are read from the environment on every call: each test sets
 * them and afterEach clears them.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { startApp, TestApp } from './setup/app';
import { Session, inviteTokenFrom } from './setup/api';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { IntegrationManager } from '@hookpost/nestjs-libraries/integrations/integration.manager';

const POLICY_ENV = [
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'FREE_PLAN_SUNSET_AT',
  'FREE_PLAN_SUNSET_EXEMPT_ORGS',
];
const PROVIDER_ENV: Record<string, string> = {
  LINKEDIN_CLIENT_ID: 'linkedin-client-test',
  LINKEDIN_CLIENT_SECRET: 'linkedin-secret-test',
  FACEBOOK_APP_ID: 'fb-app-id-test',
  FACEBOOK_APP_SECRET: 'fb-secret-test',
};
// The earliest cutoff trial.policy.ts accepts (TRIAL_CUTOFF_FLOOR).
const CUTOFF = '2026-10-19T00:00:00Z';
// A workspace created now is BEFORE this cutoff (grandfathered), and once the
// sunset below has passed it is needs_trial. A workspace created after the
// cutoff is free_posts since 28 Oct 2026, not needs_trial.
const FUTURE_CUTOFF = '2099-01-01T00:00:00Z';
const SUNSET_PASSED = '2026-10-20T00:00:00Z';
const PRE_TRIAL_MESSAGE =
  'You can connect 1 channel before your trial starts. Start your 3-day trial to connect more and schedule posts.';
const POST_MESSAGE = 'Start your 3-day trial to schedule and publish posts.';

let accounts = 0;
const account = (tag: string) => `${tag}-${Date.now().toString(36)}-${accounts++}`;

describe('connect first: a grandfathered workspace the Free plan sunset reached (needs_trial)', () => {
  let t: TestApp;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [k, v] of Object.entries(PROVIDER_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    t = await startApp({ mcp: true });
  });
  afterEach(() => {
    for (const key of POLICY_ENV) process.env[key] = '';
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await t?.close();
    await disconnectDb();
  });

  const provider = (id: string) => t.get<IntegrationManager>(IntegrationManager).getSocialIntegration(id) as any;

  /** LinkedIn's token exchange answers `accounts` in order, one per callback. */
  function linkedInReturns(...ids: string[]) {
    const spy = jest.spyOn(provider('linkedin'), 'authenticate');
    for (const id of ids) {
      spy.mockResolvedValueOnce({
        id,
        name: `Person ${id}`,
        accessToken: `access-${id}`,
        refreshToken: `refresh-${id}`,
        expiresIn: 3600,
        picture: '',
        username: id,
      } as any);
    }
    return spy;
  }

  /**
   * An Indian workspace the Free plan sunset reached (grandfathered: created
   * before its group's cutoff, FREE_PLAN_SUNSET_AT passed): needs_trial.
   */
  async function newWorkspace(): Promise<{ s: Session; orgId: string }> {
    process.env.TRIAL_REQUIRED_SINCE_IN = FUTURE_CUTOFF;
    process.env.FREE_PLAN_SUNSET_AT = SUNSET_PASSED;
    const s = await t.api.register();
    const self = await s.self();
    await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
    return { s, orgId: self.orgId };
  }

  const stateOf = (url: string) => /[?&]state=([^&]+)/.exec(decodeURIComponent(url))?.[1] || url;

  async function connectLink(s: Session, providerId = 'linkedin', query = '') {
    const res = await s.get(`/integrations/social/${providerId}${query}`);
    return { res, state: res.status === 200 ? stateOf(res.body.url) : '' };
  }

  const callback = (providerId: string, state: string, code = 'oauth-code') =>
    t.api.post(`/integrations/social-connect/${providerId}`, { code, state, timezone: '330' });

  const liveChannels = (orgId: string) =>
    db().integration.count({
      where: { organizationId: orgId, deletedAt: null, inBetweenSteps: false, refreshNeeded: false },
    });

  const draft = (integrationId: string) => ({
    type: 'draft',
    shortLink: false,
    date: new Date(Date.now() + 86400_000).toISOString(),
    tags: [],
    posts: [{ integration: { id: integrationId }, group: 'g1', value: [{ content: 'hello', image: [] }], settings: {} }],
  });

  it('/user/self says one channel may come before the trial', async () => {
    const { s } = await newWorkspace();
    expect(await s.self()).toMatchObject({ planState: 'needs_trial', preTrialChannelLimit: 1 });
  });

  it('connects its first channel: link, callback, the channel is saved and the funnel event logged', async () => {
    const { s, orgId } = await newWorkspace();
    const id = account('li');
    linkedInReturns(id);
    const log = jest.spyOn(console, 'log');
    const { res, state } = await connectLink(s);
    expect(res.status).toBe(200);
    expect(await ioRedis.get(`organization:${state}`)).toBe(orgId);

    const done = await callback('linkedin', state);
    expect(done.status).toBe(201);
    expect(await liveChannels(orgId)).toBe(1);
    expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringContaining('[connect] channel_connected_pre_trial {"provider":"linkedin","orgId":"' + orgId)
    );
    // Still needs_trial: connecting did not start anything.
    expect((await s.self()).planState).toBe('needs_trial');
    // The funnel marker: when the first channel came, against the sign-up.
    const attribution = await db().signupAttribution.findUniqueOrThrow({ where: { organizationId: orgId } });
    expect(attribution.firstChannelAt).not.toBeNull();
    expect(attribution.firstChannelAt!.getTime() - attribution.createdAt.getTime()).toBeLessThan(10 * 60_000);
  });

  it('a second connect is refused at the link: 402 TRIAL_REQUIRED, with the one-channel message', async () => {
    const { s, orgId } = await newWorkspace();
    await addChannel(orgId, 'bluesky');
    const { res } = await connectLink(s);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'TRIAL_REQUIRED', trial: true, trialDays: 3, message: PRE_TRIAL_MESSAGE });
  });

  it('two links opened while there was room: the second callback is refused and saves nothing', async () => {
    const { s, orgId } = await newWorkspace();
    const first = await connectLink(s);
    const second = await connectLink(s);
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    linkedInReturns(account('li-a'), account('li-b'));

    expect((await callback('linkedin', first.state)).status).toBe(201);
    const refused = await callback('linkedin', second.state);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: 'TRIAL_REQUIRED', message: PRE_TRIAL_MESSAGE });
    expect(await liveChannels(orgId)).toBe(1);
  });

  it('double-click: two callbacks at the same moment leave exactly one channel', async () => {
    const { s, orgId } = await newWorkspace();
    const a = await connectLink(s);
    const b = await connectLink(s);
    linkedInReturns(account('li-x'), account('li-y'));
    const results = await Promise.all([callback('linkedin', a.state), callback('linkedin', b.state)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    // The other one either waited for the lock (409) or found the slot used (402).
    expect([402, 409]).toContain(statuses[1]);
    expect(await liveChannels(orgId)).toBe(1);
  });

  it('a custom-fields login (Bluesky) uses up its state: finishing it again answers the channel it added, and adds nothing', async () => {
    const { s, orgId } = await newWorkspace();
    const { res, state } = await connectLink(s, 'bluesky');
    expect(res.status).toBe(200);
    const auth = jest.spyOn(provider('bluesky'), 'authenticate');
    for (const id of [account('bsky-1'), account('bsky-2')]) {
      auth.mockResolvedValueOnce({ id, name: id, accessToken: 'a', refreshToken: 'r', expiresIn: 3600, picture: '', username: id } as any);
    }
    const creds = Buffer.from(JSON.stringify({ identifier: 'x', password: 'y' })).toString('base64');
    const first = await callback('bluesky', state, creds);
    expect(first.status).toBe(201);
    const again = await callback('bluesky', state, creds);
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: first.body.id, alreadyConnected: true });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(await liveChannels(orgId)).toBe(1);
  });

  // Connect first and the connect handoff together: the credentials go in a
  // POST body (connect.handoff.ts) and the callback only names the handoff;
  // the pre-trial count under the lock still decides the second one.
  it('Bluesky through the POST handoff: the first connect works, the second is 402 TRIAL_REQUIRED', async () => {
    const { s, orgId } = await newWorkspace();
    // Two links opened while there was room.
    const first = await connectLink(s, 'bluesky');
    const second = await connectLink(s, 'bluesky');
    expect([first.res.status, second.res.status]).toEqual([200, 200]);
    const auth = jest.spyOn(provider('bluesky'), 'authenticate');
    for (const id of [account('bsky-h1'), account('bsky-h2')]) {
      auth.mockResolvedValueOnce({ id, name: id, accessToken: 'a', refreshToken: 'r', expiresIn: 3600, picture: '', username: id } as any);
    }
    const creds = (n: string) =>
      Buffer.from(JSON.stringify({ service: 'https://bsky.social', identifier: n, password: `pw-${n}` })).toString('base64');
    const handOff = (state: string, code: string) =>
      t.api.post('/integrations/social-connect/bluesky/handoff', { state, code });
    const redeem = (state: string, handoff: string) =>
      t.api.post('/integrations/social-connect/bluesky', { state, handoff, timezone: '330' });

    const h1 = await handOff(first.state, creds('one'));
    const h2 = await handOff(second.state, creds('two'));
    expect([h1.status, h2.status]).toEqual([200, 200]);

    const done = await redeem(first.state, h1.body.handoff);
    expect(done.status).toBe(201);
    expect(await liveChannels(orgId)).toBe(1);

    const refused = await redeem(second.state, h2.body.handoff);
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: 'TRIAL_REQUIRED', trial: true, trialDays: 3, message: PRE_TRIAL_MESSAGE });
    expect(await liveChannels(orgId)).toBe(1);
    // The refused attempt spent its handoff and its state: no second try with either.
    expect(await ioRedis.exists(`connect-handoff:${h2.body.handoff}`)).toBe(0);
    expect((await handOff(second.state, creds('two'))).status).toBe(400);
    // And a new link is refused before any credentials are asked for.
    const third = await connectLink(s, 'bluesky');
    expect(third.res.status).toBe(402);
    expect(await liveChannels(orgId)).toBe(1);
    expect((await s.self()).planState).toBe('needs_trial');
  });

  it('reconnecting the channel it has (same account) is allowed with the slot used', async () => {
    const { s, orgId } = await newWorkspace();
    const id = account('li-re');
    linkedInReturns(id, id);
    expect((await callback('linkedin', (await connectLink(s)).state)).status).toBe(201);
    const row = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, internalId: id } });
    await db().integration.update({ where: { id: row.id }, data: { refreshNeeded: true } });

    // As the channel menu asks for it (launches.component.tsx refreshChannel).
    const { res, state } = await connectLink(s, 'linkedin', `?refresh=${row.internalId}`);
    expect(res.status).toBe(200);
    expect((await callback('linkedin', state)).status).toBe(201);
    expect(await liveChannels(orgId)).toBe(1);
  });

  it('reconnecting its one healthy channel (it holds the slot) is allowed; the same channel, not a second', async () => {
    const { s, orgId } = await newWorkspace();
    const id = account('li-ok');
    linkedInReturns(id, id);
    expect((await callback('linkedin', (await connectLink(s)).state)).status).toBe(201);
    const row = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, internalId: id } });
    expect(row.refreshNeeded).toBe(false);
    // The slot is used: a new connect is refused...
    expect((await connectLink(s)).res.status).toBe(402);

    // ...but the channel menu's Reconnect, which carries the internalId
    // (launches.component.tsx refreshChannel), is that same channel again.
    expect(row.internalId).not.toBe(row.id);
    const { res, state } = await connectLink(s, 'linkedin', `?refresh=${row.internalId}`);
    expect(res.status).toBe(200);
    expect((await callback('linkedin', state)).status).toBe(201);
    expect(await liveChannels(orgId)).toBe(1);
    const after = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, internalId: id } });
    expect(after.id).toBe(row.id);
    expect((await s.self()).planState).toBe('needs_trial');
  });

  it('after removing its channel it may connect one again (still before the trial)', async () => {
    const { s, orgId } = await newWorkspace();
    const channel = await addChannel(orgId, 'bluesky');
    expect((await connectLink(s)).res.status).toBe(402);
    expect((await s.request('DELETE', '/integrations', { body: { id: channel.id } })).status).toBe(200);
    expect((await connectLink(s)).res.status).toBe(200);
    expect((await s.self()).planState).toBe('needs_trial');
  });

  describe('a two-step login (Facebook Pages)', () => {
    function facebookReturns(loginId: string, pages: string[]) {
      const fb = provider('facebook');
      jest.spyOn(fb, 'authenticate').mockResolvedValue({
        id: loginId,
        name: 'FB login',
        accessToken: 'fb-user-token',
        refreshToken: '',
        expiresIn: 3600,
        picture: '',
        username: loginId,
      } as any);
      jest.spyOn(fb, 'pages').mockResolvedValue(pages.map((p) => ({ id: p, name: `Page ${p}`, picture: '' })) as any);
      jest.spyOn(fb, 'fetchPageInformation').mockImplementation(async (_token: string, data: any) => ({
        id: data.page,
        name: `Page ${data.page}`,
        access_token: `page-token-${data.page}`,
        picture: '',
        username: `page${data.page}`,
      }));
    }

    async function placeholderFor(s: Session, orgId: string, pages: string[]) {
      facebookReturns(account('fb-login'), pages);
      const res = await callback('facebook', (await connectLink(s, 'facebook')).state);
      expect(res.status).toBe(201);
      expect(res.body.pages).toHaveLength(pages.length);
      const row = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, inBetweenSteps: true, deletedAt: null } });
      return row.id;
    }

    it('picking two Pages at once is refused (402 TRIAL_REQUIRED); one Page connects', async () => {
      const { s, orgId } = await newWorkspace();
      const [p1, p2] = [account('page'), account('page')];
      const id = await placeholderFor(s, orgId, [p1, p2]);

      const two = await s.post(`/integrations/provider/${id}/connect`, [{ page: p1 }, { page: p2 }]);
      expect(two.status).toBe(402);
      expect(two.body).toMatchObject({ code: 'TRIAL_REQUIRED', message: PRE_TRIAL_MESSAGE });
      expect(await liveChannels(orgId)).toBe(0);
      // A login that is only a placeholder is not a first channel yet.
      const marker = () => db().signupAttribution.findUniqueOrThrow({ where: { organizationId: orgId } });
      expect((await marker()).firstChannelAt).toBeNull();

      const one = await s.post(`/integrations/provider/${id}/connect`, { page: p1 });
      expect(one.status).toBe(201);
      expect(await liveChannels(orgId)).toBe(1);
      expect((await marker()).firstChannelAt).not.toBeNull();
    });

    it('the page picker may list the login’s Pages, and only that', async () => {
      const { s, orgId } = await newWorkspace();
      const id = await placeholderFor(s, orgId, [account('page')]);
      const pages = await s.post('/integrations/function', { name: 'pages', id, data: {} });
      expect(pages.status).toBe(201);
      expect(Array.isArray(pages.body)).toBe(true);
      // Any other provider method on the same login is refused.
      const other = await s.post('/integrations/function', { name: 'post', id, data: {} });
      expect(other.status).toBe(402);
      expect(other.body.code).toBe('TRIAL_REQUIRED');
    });

    // /integrations/public/provider/:id/connect has no policy guard (an
    // invite link's page pick); the limit holds there too, in saveProviderPage.
    it('the unguarded public page pick (invite links) is held to the same one channel', async () => {
      const { s, orgId } = await newWorkspace();
      const [p1, p2] = [account('page'), account('page')];
      facebookReturns(account('fb-login'), [p1, p2]);
      const { state } = await connectLink(s, 'facebook');
      expect((await callback('facebook', state)).status).toBe(201);
      const row = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, inBetweenSteps: true, deletedAt: null } });
      const two = await t.api.post(`/integrations/public/provider/${row.id}/connect`, {
        state,
        items: [{ page: p1 }, { page: p2 }],
      });
      expect(two.status).toBe(402);
      expect(two.body.code).toBe('TRIAL_REQUIRED');
      expect(await liveChannels(orgId)).toBe(0);
    });

    it('with its one channel connected, a second login is refused before it leaves a placeholder', async () => {
      const { s, orgId } = await newWorkspace();
      await addChannel(orgId, 'bluesky');
      expect((await connectLink(s, 'facebook')).res.status).toBe(402);
    });
  });

  describe('everything else waits for the trial', () => {
    let s: Session;
    let orgId: string;
    let channelId: string;
    beforeEach(async () => {
      ({ s, orgId } = await newWorkspace());
      channelId = (await addChannel(orgId, 'linkedin')).id;
    });

    it('creating, scheduling or publishing a post: 402 TRIAL_REQUIRED with the paywall code, nothing saved', async () => {
      for (const type of ['draft', 'schedule', 'now']) {
        const res = await s.post('/posts', { ...draft(channelId), type });
        expect([type, res.status, res.body?.code]).toEqual([type, 402, 'TRIAL_REQUIRED']);
        expect(res.body.message).toBe(POST_MESSAGE);
      }
      expect(await db().post.count({ where: { organizationId: orgId } })).toBe(0);
      expect(t.temporal.started.filter((w: any) => String(w.options?.workflowId || '').includes(orgId))).toEqual([]);
    });

    it('AI: the generator, the agent, splitting a post, and a copilot generation sent without its operationName', async () => {
      expect((await s.post('/posts/generator', {})).status).toBe(402);
      expect((await s.post('/posts/generator/draft', {})).status).toBe(402);
      expect((await s.post('/posts/separate-posts', { content: 'a long post', len: 10 })).status).toBe(402);
      expect((await s.post('/copilot/agent', {})).status).toBe(402);
      expect((await s.get('/copilot/list')).status).toBe(402);
      // The GraphQL server runs a document's only operation whatever the
      // operationName says; this used to reach OpenAI uncharged.
      const sneaky = await s.post('/copilot/chat', {
        query: 'mutation { generateCopilotResponse(data: {}) { threadId } }',
        variables: {},
      });
      expect(sneaky.status).toBe(402);
      const disguised = await s.post('/copilot/chat', {
        operationName: 'availableAgents',
        query: 'mutation availableAgents { generateCopilotResponse(data: {}) { threadId } }',
      });
      expect(disguised.status).toBe(402);
      expect(await db().credits.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('the copilot handshake still answers (CopilotKit wraps the paywall too)', async () => {
      const res = await s.post('/copilot/chat', {
        operationName: 'availableAgents',
        query: 'query availableAgents { availableAgents { agents { name id description } } }',
        variables: {},
      });
      expect(res.status).not.toBe(402);
      expect(res.status).toBeLessThan(500);
    });

    it('AI images answer no image and spend nothing', async () => {
      const res = await s.post('/media/generate-image', { prompt: 'a cat' });
      expect(res.status).toBeLessThan(500);
      expect(res.body?.output).toBeUndefined();
    });

    it('webhooks, autopost, analytics, mentions, profile changes, plugs and third-party tools', async () => {
      const refused = [
        await s.post('/webhooks', { name: 'w', url: 'https://example.com/hook', integrations: [] }),
        await s.post('/autopost', { url: 'https://example.com/rss', title: 'x', active: true, integrations: [] }),
        await s.get(`/analytics/${channelId}?date=7`),
        await s.post('/integrations/mentions', { name: 'mention', id: channelId, data: { query: 'a' } }),
        await s.post('/integrations/function', { name: 'mention', id: channelId, data: { query: 'a' } }),
        await s.post(`/integrations/${channelId}/nickname`, { name: 'n', picture: '' }),
        await s.post(`/integrations/${channelId}/plugs`, { func: 'x', fields: [] }),
        await s.post('/third-party/heygen', { api: 'heygen-key' }),
        await s.post('/third-party/function/any/generateVoice', { text: 'hi' }),
      ];
      expect(refused.map((r) => r.status)).toEqual(refused.map(() => 402));
      expect(refused.every((r) => r.body?.code === 'TRIAL_REQUIRED')).toBe(true);
    });

    it('MCP and the public API (CLI, SDK, n8n, the Chrome extension all use it) refuse it', async () => {
      const key = await apiKeyOf(orgId);
      // Not handed out on /user/self, but the column exists: it must not work either.
      expect((await s.self()).publicApi).toBe('');
      const list = await t.api.publicApi(key, 'GET', '/integrations');
      expect(list.status).toBe(401);
      const post = await t.api.publicApi(key, 'POST', '/posts', draft(channelId));
      expect(post.status).toBe(401);
      // MCP connects (so the client can show why) and every tool call is
      // refused with the way to the trial; nothing is written.
      const rpc = (method: string, params: any) =>
        fetch(`${t.baseUrl}/mcp/${key}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
      expect((await rpc('tools/list', {})).status).toBe(200);
      const call = await (
        await rpc('tools/call', { name: 'integrationSchedulePostTool', arguments: { socialPost: [] } })
      ).json();
      expect(call.result.isError).toBe(true);
      expect(call.result.content[0].text).toMatch(/^Hookpost needs an active plan to do this\. Start your \d+-day trial here: .*\/billing\?utm_source=mcp_paywall/);
      expect(await db().post.count({ where: { organizationId: orgId } })).toBe(0);
    });

    it('no team invites either, so nobody can be brought in to work around it', async () => {
      const invite = await s.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(invite.status).toBe(402);
      expect(invite.body.code).toBe('TRIAL_REQUIRED');
    });

    it('Billing stays reachable, so the trial can be started', async () => {
      expect((await s.get('/billing')).status).toBe(200);
      expect((await s.get('/billing/pricing-context')).status).toBe(200);
    });

    it('the admin report counts it as a channel connected within 10 minutes of sign-up', async () => {
      const admin = await t.api.register();
      await db().user.update({ where: { id: (await admin.self()).id }, data: { isSuperAdmin: true } });
      const report = await admin.get('/admin/attribution?days=1');
      expect(report.status).toBe(200);
      expect(report.body.totals.channelsFast).toBeGreaterThanOrEqual(1);
      expect(report.body.totals.channels).toBeGreaterThanOrEqual(report.body.totals.channelsFast);
    });

    it('once the trial runs: a second channel, and posts', async () => {
      await givePlan(orgId, 'STANDARD');
      await db().organization.update({ where: { id: orgId }, data: { isTrailing: true } });
      expect((await s.self()).planState).toBe('trialing');
      expect((await s.self()).preTrialChannelLimit).toBeNull();
      expect((await connectLink(s)).res.status).toBe(200);
      expect((await s.post('/posts', draft(channelId))).status).toBe(201);
      expect((await s.get(`/analytics/${channelId}?date=7`)).status).not.toBe(402);
    });
  });

  describe('who never gets the pre-trial limit', () => {
    it('a workspace with a plan and no channel: no limit, connects like any paid workspace', async () => {
      const { s, orgId } = await newWorkspace();
      await givePlan(orgId, 'STANDARD');
      const self = await s.self();
      expect(self.planState).not.toBe('needs_trial');
      expect(self.preTrialChannelLimit).toBeNull();
      await addChannel(orgId, 'bluesky');
      expect((await connectLink(s)).res.status).toBe(200);
    });

    it('locked (trial used, no plan): no channel at all, PLAN_REQUIRED', async () => {
      const { s, orgId } = await newWorkspace();
      await db().organization.update({ where: { id: orgId }, data: { allowTrial: false } });
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'locked', preTrialChannelLimit: null });
      const { res } = await connectLink(s);
      expect(res.status).toBe(402);
      expect(res.body.code).toBe('PLAN_REQUIRED');
    });

    it('a grandfathered Free workspace (before the cutoff, no sunset): its Free allowance, as before', async () => {
      const s = await t.api.register();
      const self = await s.self();
      expect(self).toMatchObject({ planState: 'free', preTrialChannelLimit: null });
      await addChannel(self.orgId, 'bluesky');
      expect((await connectLink(s)).res.status).toBe(200);
    });

    // FREE_PLAN_SUNSET_AT, unchanged by this: once it has passed, a
    // grandfathered Free workspace is needs_trial with the channels it had;
    // it adds no new one and posts nothing before its trial, and an exempt
    // workspace keeps the Free plan.
    it('a grandfathered workspace after the Free plan sunset: keeps its channels, adds none, posts nothing', async () => {
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      process.env.FREE_PLAN_SUNSET_AT = '2026-10-20T00:00:00Z';
      const s = await t.api.register();
      const self = await s.self();
      await db().user.update({ where: { id: self.id }, data: { signupCountry: 'IN' } });
      await db().organization.update({ where: { id: self.orgId }, data: { createdAt: new Date('2026-10-01T00:00:00Z') } });
      const a = await addChannel(self.orgId, 'bluesky');
      await addChannel(self.orgId, 'threads');

      expect(await s.self()).toMatchObject({ planState: 'needs_trial', preTrialChannelLimit: 1 });
      expect((await connectLink(s)).res.status).toBe(402);
      expect((await s.post('/posts', draft(a.id))).status).toBe(402);
      expect((await s.get('/integrations/list')).body.integrations).toHaveLength(2);

      process.env.FREE_PLAN_SUNSET_EXEMPT_ORGS = self.orgId;
      expect(await s.self()).toMatchObject({ planState: 'free', preTrialChannelLimit: null });
      expect((await s.post('/posts', draft(a.id))).status).toBe(201);
    });

    it('a member invited into a paid workspace lands there, with no limit', async () => {
      const owner = await t.api.register();
      const ownerOrg = (await owner.self()).orgId;
      await givePlan(ownerOrg, 'PRO');
      process.env.TRIAL_REQUIRED_SINCE_IN = CUTOFF;
      const invite = await owner.post('/settings/team', { role: 'USER', sendEmail: false });
      expect(invite.status).toBe(201);
      const member = await t.api.register({
        cookies: { org: inviteTokenFrom(invite.body.url) },
      });
      const self = await member.self();
      expect(self.orgId).toBe(ownerOrg);
      expect(self.preTrialChannelLimit).toBeNull();
    });
  });

  describe('a multi-user workspace that has to start its trial', () => {
    it('a plain member gets the same limit; neither member can post; opening checkout grants nothing', async () => {
      const { s: owner, orgId } = await newWorkspace();
      const member = await t.api.register();
      await db().userOrganization.create({
        data: { userId: (await member.self()).id, organizationId: orgId, role: 'USER' },
      });
      member.showorg = orgId;
      expect((await member.self()).orgId).toBe(orgId);
      expect((await member.self()).preTrialChannelLimit).toBe(1);

      // The member's connect uses the workspace's one slot ...
      const id = account('li-member');
      linkedInReturns(id);
      expect((await callback('linkedin', (await connectLink(member)).state)).status).toBe(201);
      // ... so the owner's is refused, and nobody can post.
      expect((await connectLink(owner)).res.status).toBe(402);
      const channel = await db().integration.findFirstOrThrow({ where: { organizationId: orgId, internalId: id } });
      expect((await member.post('/posts', draft(channel.id))).status).toBe(402);
      expect((await owner.post('/posts', draft(channel.id))).status).toBe(402);
      // Any member may open the checkout (as before), but a checkout that was
      // opened and not paid starts nothing: still needs_trial, still no posts.
      const checkout = await member.post('/billing/embedded', { billing: 'STANDARD', period: 'MONTHLY' });
      expect(checkout.status).toBeLessThan(500);
      expect((await owner.self()).planState).toBe('needs_trial');
      expect((await member.post('/posts', draft(channel.id))).status).toBe(402);
    });
  });

  // Applied by hand to production before the backend deploys, and once more
  // after it to fill the channels connected in between. Last in the file: it
  // drops the column to get production's shape, and puts it back.
  describe('signup-attribution-first-channel.migration.sql', () => {
    const sql = readFileSync(
      join(__dirname, '../../libraries/nestjs-libraries/src/database/prisma/signup-attribution-first-channel.migration.sql'),
      'utf8'
    );
    const clients: Client[] = [];
    const pgClient = async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      clients.push(c);
      return c;
    };
    afterAll(async () => {
      const pg = await pgClient();
      await pg.query('ALTER TABLE "SignupAttribution" ADD COLUMN IF NOT EXISTS "firstChannelAt" TIMESTAMP(3)');
      await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    });

    /** A workspace and its SignupAttribution row with no firstChannelAt. */
    async function signedUp() {
      const s = await t.api.register();
      const { id: userId, orgId } = await s.self();
      await db().signupAttribution.upsert({
        where: { organizationId: orgId },
        create: { organizationId: orgId, userId, method: 'email' },
        update: { firstChannelAt: null },
      });
      return orgId;
    }
    const channelAt = async (orgId: string, at: Date, extra: { inBetweenSteps?: boolean } = {}) => {
      const row = await addChannel(orgId, 'bluesky', extra);
      await db().integration.update({ where: { id: row.id }, data: { createdAt: at } });
    };
    const firstChannelAt = async (orgId: string) =>
      (await db().signupAttribution.findUniqueOrThrow({ where: { organizationId: orgId } })).firstChannelAt;
    const updated = (results: any) =>
      (Array.isArray(results) ? results : [results]).find((r) => r.command === 'UPDATE').rowCount;

    it('sets a 5 s lock_timeout right after BEGIN', () => {
      const statements = sql
        .replace(/--.*$/gm, '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      expect(statements[0]).toBe('BEGIN');
      expect(statements[1]).toBe("SET lock_timeout = '5s'");
      expect(statements[statements.length - 1]).toBe('COMMIT');
    });

    it('adds the column, backfills from the earliest real channel, never overwrites, and a re-run fills only the gap', async () => {
      const pg = await pgClient();
      const t1 = new Date('2026-10-25T05:00:00.000Z');
      const t2 = new Date('2026-10-25T06:00:00.000Z');
      const placeholderAt = new Date('2026-10-25T04:00:00.000Z');
      const withChannels = await signedUp();
      await channelAt(withChannels, placeholderAt, { inBetweenSteps: true });
      await channelAt(withChannels, t2);
      await channelAt(withChannels, t1);
      const noChannel = await signedUp();
      const rows = async () => (await pg.query('SELECT count(*)::int AS n FROM "SignupAttribution"')).rows[0].n;
      const before = await rows();

      // Production before the first run: no column.
      await pg.query('ALTER TABLE "SignupAttribution" DROP COLUMN IF EXISTS "firstChannelAt"');
      await pg.query(sql);
      const column = await pg.query(
        `SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'SignupAttribution' AND column_name = 'firstChannelAt'`
      );
      expect(column.rows).toEqual([{ data_type: 'timestamp without time zone', is_nullable: 'YES' }]);
      // The earliest channel that is not an unfinished two-step placeholder.
      expect((await firstChannelAt(withChannels))?.getTime()).toBe(t1.getTime());
      expect(await firstChannelAt(noChannel)).toBeNull();

      // The backend writes the marker from now on; a re-run never touches it.
      const written = new Date('2026-10-25T07:00:00.000Z');
      await db().signupAttribution.update({ where: { organizationId: withChannels }, data: { firstChannelAt: written } });
      // A channel connected between the first run and the deploy.
      const gap = new Date('2026-10-25T08:00:00.000Z');
      await channelAt(noChannel, gap);

      expect(updated(await pg.query(sql))).toBe(1);
      expect((await firstChannelAt(withChannels))?.getTime()).toBe(written.getTime());
      expect((await firstChannelAt(noChannel))?.getTime()).toBe(gap.getTime());
      expect(updated(await pg.query(sql))).toBe(0);
      expect(await rows()).toBe(before);
    });

    it('gives up after 5 s while another transaction holds the table, and changes nothing', async () => {
      const holder = await pgClient();
      const runner = await pgClient();
      const orgId = await signedUp();
      await channelAt(orgId, new Date('2026-10-25T05:00:00.000Z'));
      await holder.query('BEGIN');
      // Any lock at all conflicts with the ACCESS EXCLUSIVE lock ADD COLUMN takes.
      await holder.query('LOCK TABLE "SignupAttribution" IN ACCESS SHARE MODE');
      const started = Date.now();
      try {
        await expect(runner.query(sql)).rejects.toMatchObject({ code: '55P03' }); // lock_not_available
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(4500);
        expect(took).toBeLessThan(15_000);
      } finally {
        await runner.query('ROLLBACK');
        await holder.query('ROLLBACK');
      }
      // The backfill did not run.
      expect(await firstChannelAt(orgId)).toBeNull();
      // Once the table is free it goes through.
      await runner.query(sql);
      expect(await firstChannelAt(orgId)).not.toBeNull();
    });
  });
});
