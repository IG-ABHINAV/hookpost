/**
 * The n8n community node (apps/n8n-node) against the real public API. n8n
 * itself is not run: execute() gets the small slice of IExecuteFunctions it
 * uses, and httpRequestWithAuthentication applies the credential the way
 * n8n's generic auth does (the bare key in Authorization, from
 * HookpostApi.credentials.ts).
 */
import { startApp, TestApp } from './setup/app';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';
import { Hookpost } from '../../apps/n8n-node/nodes/Hookpost/Hookpost.node';
import { HookpostApi } from '../../apps/n8n-node/credentials/HookpostApi.credentials';

describe('n8n node', () => {
  let t: TestApp;
  let apiKey: string;
  let orgId: string;
  let channelId: string;

  beforeAll(async () => {
    t = await startApp();
    const owner = await t.api.register({ company: 'n8n Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    apiKey = await apiKeyOf(orgId);
    channelId = (await addChannel(orgId, 'bluesky', { name: 'n8n Bluesky' })).id;
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  /** Runs the node once with these parameters and returns its output items. */
  async function run(params: Record<string, unknown>, key = apiKey) {
    const credential = new HookpostApi();
    const header = (credential.authenticate as any).properties.headers.Authorization as string;
    const context = {
      getInputData: () => [{ json: {} }],
      getNodeParameter: (name: string, _i: number, fallback?: unknown) => (name in params ? params[name] : fallback),
      getCredentials: async () => ({ apiKey: key, baseUrl: `${t.baseUrl}/` }),
      getNode: () => ({ name: 'Hookpost', type: 'hookpost' }),
      continueOnFail: () => false,
      helpers: {
        async httpRequestWithAuthentication(_name: string, opts: any) {
          const url = new URL(opts.url);
          for (const [k, v] of Object.entries(opts.qs || {})) url.searchParams.set(k, String(v));
          const res = await fetch(url, {
            method: opts.method,
            headers: {
              // '={{$credentials.apiKey}}' resolved, as n8n would.
              authorization: header === '={{$credentials.apiKey}}' ? key : header,
              ...(opts.body ? { 'content-type': 'application/json' } : {}),
            },
            body: opts.body ? JSON.stringify(opts.body) : undefined,
          });
          const text = await res.text();
          if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text}`), { httpCode: res.status });
          return text ? JSON.parse(text) : undefined;
        },
      },
    };
    const [items] = await new Hookpost().execute.call(context as any);
    return items.map((item) => item.json as any);
  }

  it('the credential sends the bare key (no Bearer) and tests it on /is-connected', () => {
    const credential = new HookpostApi();
    expect((credential.authenticate as any).properties.headers.Authorization).toBe('={{$credentials.apiKey}}');
    expect(credential.test.request.url).toBe('/public/v1/is-connected');
  });

  it('listChannels lists the workspace channels', async () => {
    const items = await run({ operation: 'listChannels' });
    expect(items.map((c) => c.id)).toContain(channelId);
    expect(JSON.stringify(items)).not.toContain('fake-token');
  });

  it('createPost (draft) -> listPosts -> deletePost', async () => {
    const [created] = await run({
      operation: 'createPost',
      integrationId: channelId,
      content: 'Drafted from n8n',
      type: 'draft',
      date: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const row = await db().post.findUniqueOrThrow({ where: { id: created.postId } });
    expect(row).toMatchObject({ state: 'DRAFT', organizationId: orgId, integrationId: channelId });

    const [listed] = await run({
      operation: 'listPosts',
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
    });
    expect(listed.posts.map((p: any) => p.id)).toContain(created.postId);

    const [deleted] = await run({ operation: 'deletePost', postId: created.postId });
    expect(deleted).toEqual({ success: true, id: created.postId });
  });

  it('createPost (schedule) without a date takes the next free slot and starts publishing', async () => {
    t.temporal.reset();
    const [created] = await run({ operation: 'createPost', integrationId: channelId, content: 'Scheduled from n8n', type: 'schedule' });
    const row = await db().post.findUniqueOrThrow({ where: { id: created.postId } });
    expect(row.state).toBe('QUEUE');
    expect(row.publishDate.getTime()).toBeGreaterThan(Date.now());
    expect(t.temporal.postWorkflows()).toHaveLength(1);
  });

  it('findSlot answers a future time for the channel', async () => {
    const [slot] = await run({ operation: 'findSlot', slotIntegrationId: channelId });
    // The public /find-slot says the zone: ISO 8601 UTC.
    expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
    expect(new Date(slot.date).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('a wrong key fails the node with the 401', async () => {
    await expect(run({ operation: 'listChannels' }, 'wrong-key')).rejects.toThrow(/401/);
  });
});
