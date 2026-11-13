/**
 * The developer tools that sit on the public API, run against the real
 * backend instead of a mock, so a change on either side that breaks the
 * contract fails here:
 *
 *  - the CLI (apps/cli, published as `hookpost`), compiled with its own
 *    tsconfig and run as a child process, as a user runs it;
 *  - the stdio MCP server (mcp-server, published as `hookpost-mcp`), spoken to
 *    by the official MCP client over stdio;
 *  - the Node SDK (apps/sdk, published as `@hookpost/node`).
 *
 * The backend listens on 127.0.0.1 in this process, so every child process is
 * spawned asynchronously (a sync spawn would block the server it calls).
 */
import { spawn, execFileSync } from 'child_process';
import { copyFileSync, mkdtempSync, readFileSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startApp, TestApp } from './setup/app';
import { addChannel, apiKeyOf, db, disconnectDb, givePlan } from './setup/db';

const ROOT = join(__dirname, '..', '..');
// A real 1x1 PNG, so file-type sniffing accepts it.
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000d4944415478da63fccfc0500f000485018084a98c210000000049454e44ae426082',
  'hex'
);

describe('developer tools against the real API', () => {
  let t: TestApp;
  let orgId: string;
  let apiKey: string;
  let channelId: string;
  let secondChannelId: string;

  beforeAll(async () => {
    t = await startApp();
    const owner = await t.api.register({ company: 'Dev Tools Co' });
    orgId = (await owner.self()).orgId;
    await givePlan(orgId, 'STANDARD');
    apiKey = await apiKeyOf(orgId);
    channelId = (await addChannel(orgId, 'bluesky', { name: 'Tools Bluesky' })).id;
    secondChannelId = (await addChannel(orgId, 'mastodon', { name: 'Tools Mastodon' })).id;
  });
  afterAll(async () => {
    await t?.close();
    await disconnectDb();
  });

  const posts = (where: Record<string, unknown> = {}) =>
    db().post.findMany({ where: { organizationId: orgId, deletedAt: null, ...where }, orderBy: { createdAt: 'desc' } });

  describe('CLI (apps/cli)', () => {
    let cliDir: string;
    let home: string;

    beforeAll(() => {
      // Built the way `npm publish` builds it (tsc with apps/cli/tsconfig.json),
      // next to a copy of its package.json for `--version`.
      cliDir = mkdtempSync(join(tmpdir(), 'hookpost-cli-'));
      execFileSync(
        join(ROOT, 'node_modules', '.bin', 'tsc'),
        ['-p', join(ROOT, 'apps/cli/tsconfig.json'), '--outDir', join(cliDir, 'dist')],
        { stdio: 'inherit' }
      );
      copyFileSync(join(ROOT, 'apps/cli/package.json'), join(cliDir, 'package.json'));
      home = mkdtempSync(join(tmpdir(), 'hookpost-cli-home-'));
    });

    function cli(
      args: string[],
      opts: {
        env?: Record<string, string | undefined>;
        stdin?: string;
        // Typed answers: each is written once its prompt has been printed,
        // the way a person at a terminal answers.
        answers?: [RegExp, string][];
      } = {}
    ) {
      return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const env: Record<string, string> = {
          PATH: process.env.PATH || '',
          HOME: home,
          USERPROFILE: home,
          // Never the real API: an unset URL would mean production.
          HOOKPOST_API_URL: t.baseUrl,
          HOOKPOST_API_KEY: apiKey,
          NO_COLOR: '1',
        };
        for (const [k, v] of Object.entries(opts.env || {})) {
          if (v === undefined) delete env[k];
          else env[k] = v;
        }
        const child = spawn(process.execPath, [join(cliDir, 'dist', 'index.js'), ...args], { env });
        let stdout = '';
        let stderr = '';
        const answers = [...(opts.answers || [])];
        child.stdout.on('data', (d) => {
          stdout += d;
          while (answers.length && answers[0][0].test(stdout)) {
            const [, answer] = answers.shift()!;
            child.stdin.write(`${answer}\n`);
            if (!answers.length) child.stdin.end();
          }
        });
        child.stderr.on('data', (d) => (stderr += d));
        if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      });
    }
    // eslint-disable-next-line no-control-regex
    const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

    it('help and --version', async () => {
      const help = await cli(['help']);
      expect(help.code).toBe(0);
      expect(plain(help.stdout)).toMatch(/hookpost <command>/);
      const version = await cli(['--version']);
      expect(version.stdout.trim()).toBe(JSON.parse(readFileSync(join(ROOT, 'apps/cli/package.json'), 'utf8')).version);
    });

    it('channels lists the workspace channels', async () => {
      const res = await cli(['channels']);
      expect(res.code).toBe(0);
      const out = plain(res.stdout);
      expect(out).toContain(channelId);
      expect(out).toContain('Tools Bluesky');
    });

    it('without a key it says how to sign in', async () => {
      const res = await cli(['channels'], { env: { HOOKPOST_API_KEY: undefined } });
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/Not signed in/);
    });

    it('a wrong key fails with the API status', async () => {
      const res = await cli(['channels'], { env: { HOOKPOST_API_KEY: 'wrong-key' } });
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/401/);
    });

    it('post --draft saves a draft on one channel', async () => {
      const res = await cli(['post', 'CLI draft one', '--channel', channelId, '--draft']);
      expect(res.code).toBe(0);
      const [row] = await posts({ content: { contains: 'CLI draft one' } });
      expect(row).toMatchObject({ state: 'DRAFT', integrationId: channelId });
    });

    it('posts made with the CLI are recorded as CLI, not API', async () => {
      // The API records creationMethod CLI only when the body says so
      // (public.integrations.controller.ts); until 22 Oct 2026 apps/cli
      // never sent it.
      await cli(['post', 'CLI creation method', '--channel', channelId, '--draft']);
      const [row] = await posts({ content: { contains: 'CLI creation method' } });
      expect(row.creationMethod).toBe('CLI');
    });

    it('post to several channels: repeated and comma-separated --channel', async () => {
      const res = await cli(['post', 'CLI multi', '--channel', `${channelId},${secondChannelId}`, '--draft']);
      expect(res.code).toBe(0);
      expect(plain(res.stdout)).toMatch(/Created on 2 channels/);
      const rows = await posts({ content: { contains: 'CLI multi' } });
      expect(rows.map((r) => r.integrationId).sort()).toEqual([channelId, secondChannelId].sort());
    });

    it('post without --at schedules at the next free slot and starts publishing', async () => {
      t.temporal.reset();
      const res = await cli(['post', 'CLI scheduled', '--channel', channelId]);
      expect(res.code).toBe(0);
      expect(plain(res.stdout)).toMatch(/next free slot/);
      const [row] = await posts({ content: { contains: 'CLI scheduled' } });
      expect(row.state).toBe('QUEUE');
      expect(row.publishDate.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(t.temporal.postWorkflows().length).toBeGreaterThanOrEqual(1);
    });

    it('--settings with several channels is refused before anything is sent', async () => {
      const before = (await posts()).length;
      const res = await cli(['post', 'CLI bad settings', '--channel', `${channelId},${secondChannelId}`, '--settings', '{"title":"x"}']);
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/single channel/);
      expect((await posts()).length).toBe(before);
    });

    it('post without --channel is refused', async () => {
      const res = await cli(['post', 'no channel']);
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/--channel is required/);
    });

    it('posts lists upcoming posts; delete removes one', async () => {
      await cli(['post', 'CLI to delete', '--channel', channelId, '--at', new Date(Date.now() + 2 * 86400_000).toISOString()]);
      const [row] = await posts({ content: { contains: 'CLI to delete' } });
      const list = await cli(['posts', '--days', '7']);
      expect(list.code).toBe(0);
      expect(plain(list.stdout)).toContain(row.id);

      const del = await cli(['delete', row.id]);
      expect(del.code).toBe(0);
      expect((await db().post.findUniqueOrThrow({ where: { id: row.id } })).deletedAt).not.toBeNull();
    });

    it('slot prints the next free slot for a channel', async () => {
      const res = await cli(['slot', channelId]);
      expect(res.code).toBe(0);
      expect(new Date(JSON.parse(res.stdout).date).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('auth login stores the key (owner-readable only), status, logout', async () => {
      const env = { HOOKPOST_API_KEY: undefined, HOOKPOST_API_URL: undefined };
      const login = await cli(['auth', 'login'], {
        env,
        answers: [
          [/API key/, apiKey],
          [/API host/, t.baseUrl],
        ],
      });
      expect(login.code).toBe(0);
      const config = join(home, '.hookpost', 'config.json');
      expect(existsSync(config)).toBe(true);
      expect(statSync(config).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ apiKey, host: t.baseUrl });

      const status = await cli(['auth', 'status'], { env });
      expect(plain(status.stdout)).toMatch(/Signed in/);
      // The key is never printed in full.
      expect(status.stdout).not.toContain(apiKey);

      expect((await cli(['channels'], { env })).code).toBe(0);
      expect((await cli(['auth', 'logout'], { env })).code).toBe(0);
      expect(existsSync(config)).toBe(false);
    });

    // Until 22 Oct 2026 every question opened its own readline; the first
    // swallowed the whole piped buffer, the host question never got an
    // answer, and the process ended with status 0 and no config written.
    it('auth login with piped input saves the key', async () => {
      const env = { HOOKPOST_API_KEY: undefined, HOOKPOST_API_URL: undefined };
      const config = join(home, '.hookpost', 'config.json');
      const res = await cli(['auth', 'login'], { env, stdin: `${apiKey}\n${t.baseUrl}\n` });
      expect(res.code).toBe(0);
      expect(plain(res.stdout)).toMatch(/Signed in/);
      expect(JSON.parse(readFileSync(config, 'utf8'))).toEqual({ apiKey, host: t.baseUrl });
      expect((await cli(['auth', 'logout'], { env })).code).toBe(0);
    });

    it('auth login with empty piped input exits 1 and saves nothing', async () => {
      const env = { HOOKPOST_API_KEY: undefined, HOOKPOST_API_URL: undefined };
      const res = await cli(['auth', 'login'], { env, stdin: '' });
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/No key entered/);
      expect(existsSync(join(home, '.hookpost', 'config.json'))).toBe(false);
    });

    it('an unknown command fails', async () => {
      const res = await cli(['frobnicate']);
      expect(res.code).toBe(1);
      expect(plain(res.stderr)).toMatch(/Unknown command/);
    });
  });

  describe('stdio MCP server (mcp-server)', () => {
    async function connect(key?: string) {
      const env: Record<string, string> = {
        PATH: process.env.PATH || '',
        HOOKPOST_API_URL: `${t.baseUrl}/public/v1`,
      };
      if (key) env.HOOKPOST_API_KEY = key;
      const transport = new StdioClientTransport({
        command: process.execPath,
        // Run from source the way `tsc` would emit it: the file only has
        // erasable TypeScript.
        args: ['--experimental-strip-types', '--no-warnings', join(ROOT, 'mcp-server/src/index.ts')],
        env,
        stderr: 'ignore',
      });
      const client = new Client({ name: 'integration-test', version: '1.0.0' });
      await client.connect(transport);
      return client;
    }
    const text = (r: any) => r.content?.[0]?.text as string;

    let client: Client;
    beforeAll(async () => {
      client = await connect(apiKey);
    });
    afterAll(async () => {
      await client?.close();
    });

    it('lists its eight tools, with read-only and destructive hints', async () => {
      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name).sort()).toEqual(
        [
          'create_post',
          'delete_post',
          'find_free_slot',
          'get_channel_settings',
          'list_channels',
          'list_groups',
          'list_posts',
          'upload_media_from_url',
        ].sort()
      );
      const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
      expect(byName.list_channels.annotations?.readOnlyHint).toBe(true);
      expect(byName.delete_post.annotations?.destructiveHint).toBe(true);
    });

    it('without HOOKPOST_API_KEY a call says how to get one', async () => {
      const keyless = await connect();
      try {
        const res: any = await keyless.callTool({ name: 'list_channels', arguments: {} });
        expect(res.isError).toBe(true);
        expect(text(res)).toMatch(/HOOKPOST_API_KEY/);
      } finally {
        await keyless.close();
      }
    });

    it('a wrong key comes back as a tool error with the 401 hint', async () => {
      const wrong = await connect('wrong-key');
      try {
        const res: any = await wrong.callTool({ name: 'list_channels', arguments: {} });
        expect(res.isError).toBe(true);
        expect(text(res)).toMatch(/HTTP 401/);
      } finally {
        await wrong.close();
      }
    });

    it('list_channels, get_channel_settings, find_free_slot, list_groups', async () => {
      const channels: any = await client.callTool({ name: 'list_channels', arguments: {} });
      expect(channels.isError).toBeFalsy();
      expect(text(channels)).toContain(channelId);

      const settings: any = await client.callTool({ name: 'get_channel_settings', arguments: { channelId } });
      expect(settings.isError).toBeFalsy();
      expect(JSON.parse(text(settings)).output).toHaveProperty('maxLength', 300);

      const slot: any = await client.callTool({ name: 'find_free_slot', arguments: { channelId } });
      expect(new Date(JSON.parse(text(slot)).date).getTime()).toBeGreaterThan(Date.now() - 60_000);

      const groups: any = await client.callTool({ name: 'list_groups', arguments: {} });
      expect(groups.isError).toBeFalsy();
    });

    it('create_post (draft) -> list_posts -> delete_post', async () => {
      const created: any = await client.callTool({
        name: 'create_post',
        arguments: {
          type: 'draft',
          date: new Date(Date.now() + 86400_000).toISOString(),
          posts: [{ channelId, messages: [{ content: 'From hookpost-mcp' }] }],
        },
      });
      expect(created.isError).toBeFalsy();
      const [{ postId }] = JSON.parse(text(created));
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).state).toBe('DRAFT');

      const listed: any = await client.callTool({
        name: 'list_posts',
        arguments: {
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
        },
      });
      expect(text(listed)).toContain(postId);

      const deleted: any = await client.callTool({ name: 'delete_post', arguments: { postId } });
      expect(deleted.isError).toBeFalsy();
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).deletedAt).not.toBeNull();
    });

    // Until 22 Oct 2026 /find-slot answered a UTC wall time with no zone
    // ("2026-10-22T11:40:00") and create_post accepted only a datetime with Z
    // or an offset, although find_free_slot says to pass its date straight in.
    it('the date find_free_slot returns can be passed to create_post', async () => {
      const slot: any = await client.callTool({ name: 'find_free_slot', arguments: { channelId } });
      const { date } = JSON.parse(text(slot));
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const res: any = await client.callTool({
        name: 'create_post',
        arguments: { type: 'draft', date, posts: [{ channelId, messages: [{ content: 'at the free slot' }] }] },
      });
      expect(res.isError).toBeFalsy();
      const [{ postId }] = JSON.parse(text(res));
      const row = await db().post.findUniqueOrThrow({ where: { id: postId } });
      expect(row.publishDate.toISOString()).toBe(date);
    });

    // A date with no zone is refused rather than guessed: '2026-10-23T09:00:00'
    // meant as 9am in India would otherwise be scheduled for 14:30 IST.
    it('create_post refuses a date with no zone', async () => {
      const wall = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 16) + ':00';
      const before = await db().post.count();
      const res: any = await client.callTool({
        name: 'create_post',
        arguments: { type: 'draft', date: wall, posts: [{ channelId, messages: [{ content: 'zone-less slot' }] }] },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/date/i);
      expect(await db().post.count()).toBe(before);
    });

    it('create_post schedule without a date is refused before calling the API', async () => {
      const res: any = await client.callTool({
        name: 'create_post',
        arguments: { type: 'schedule', posts: [{ channelId, messages: [{ content: 'x' }] }] },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/date/);
    });

    it('upload_media_from_url passes the API refusal of an internal URL through', async () => {
      const res: any = await client.callTool({
        name: 'upload_media_from_url',
        arguments: { url: 'https://169.254.169.254/latest/meta-data.png' },
      });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/HTTP 400/);
    });
  });

  describe('Node SDK (apps/sdk)', () => {
    let Hookpost: any;
    beforeAll(async () => {
      Hookpost = (await import('../../apps/sdk/src/index')).default;
    });

    it('integrations, post (draft), postList, upload, deletePost', async () => {
      const sdk = new Hookpost(apiKey, t.baseUrl);

      const channels = await sdk.integrations();
      expect(channels.map((c: any) => c.id)).toContain(channelId);

      const created = await sdk.post({
        type: 'draft',
        shortLink: false,
        date: new Date(Date.now() + 86400_000).toISOString(),
        tags: [],
        posts: [{ integration: { id: channelId }, value: [{ content: 'From the SDK', image: [] }], settings: {} }],
      });
      const postId = created[0].postId;
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).content).toContain('From the SDK');

      const list = await sdk.postList({
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 7 * 86400_000).toISOString(),
      });
      expect(list.posts.map((p: any) => p.id)).toContain(postId);

      const uploaded = await sdk.upload(PNG_1PX, 'png');
      expect(uploaded.path).toBeTruthy();
      expect((await db().media.findFirstOrThrow({ where: { id: uploaded.id } })).organizationId).toBe(orgId);

      const del = await sdk.deletePost(postId);
      expect(del.status).toBe(200);
      expect((await db().post.findUniqueOrThrow({ where: { id: postId } })).deletedAt).not.toBeNull();
    });

    it('a wrong key gets the API error body back', async () => {
      const sdk = new Hookpost('wrong-key', t.baseUrl);
      const res = await sdk.integrations();
      expect(Array.isArray(res)).toBe(false);
    });
  });
});
