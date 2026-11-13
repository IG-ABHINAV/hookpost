/**
 * The api.market products end to end: each product's endpoints called the
 * way api.market forwards a subscriber's call (tests/integration/setup/
 * marketplace.ts Gateway) against the E2E backend, and the browser part a
 * subscriber sees, the OAuth callback page, against the production build of
 * the frontend. Publishing runs the orchestrator's real PostActivity on the
 * E2E backend (control POST /mkt/publish); the networks' own post calls are
 * recorded there and never sent.
 *   pnpm exec playwright test -c tests/e2e/playwright.config.ts marketplace
 */
import { expect, test } from '@playwright/test';
import { BACKEND, control, signUpViaApi } from './support';
import {
  E2E_DISCORD_CHANNELS,
  E2E_DISCORD_SERVER,
  Gateway,
  imageForm,
  newSubscriber,
  png,
} from '../../integration/setup/marketplace';

const gw = new Gateway(BACKEND);
const CONNECTED = /connected to your Hookpost API workspace\. You can close this tab/;
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

type Calls = Record<string, { posts: number; comments: number }>;

test.describe('api.market: Social Scheduler', () => {
  test('a post to LinkedIn, X and Discord is billed per channel, publishes through the orchestrator, and reads as published', async () => {
    const user = newSubscriber();
    const call = (c: Omit<Parameters<Gateway['call']>[0], 'product' | 'plan' | 'user'>) =>
      gw.call({ product: 'social', plan: 'standard', user, ...c });

    const providers = await call({ path: '/providers' });
    expect([providers.status, providers.billing]).toEqual([200, 'API=0;']);

    const li = await control.post<{ id: string }>('/mkt/channel', { subscriber: user, product: 'social', provider: 'linkedin' });
    const x = await control.post<{ id: string }>('/mkt/channel', { subscriber: user, product: 'social', provider: 'x' });
    const discord = await control.post<{ id: string }>('/mkt/channel', {
      subscriber: user,
      product: 'social',
      provider: 'discord',
      internalId: E2E_DISCORD_SERVER,
    });
    const channels = await call({ path: '/channels' });
    expect(channels.body.channels.map((c: any) => c.provider).sort()).toEqual(['discord', 'linkedin', 'x']);

    const before = await control.get<Calls>('/mkt/calls');
    const post = (discordChannel: string) =>
      call({
        path: '/posts',
        body: {
          channels: [{ id: li.id }, { id: x.id }, { id: discord.id, settings: { channel: discordChannel } }],
          content: [{ text: 'Release 2.0 is out.' }],
          schedule_at: 'now',
        },
      });

    // A channel of another server the Hookpost bot is in: refused, nothing saved or billed.
    const foreign = await post('1300000000000000003');
    expect([foreign.status, foreign.body.error, foreign.billing]).toEqual([400, 'channel_not_in_server', 'API=0;']);
    expect(await control.get(`/mkt/posts?subscriber=${user}&product=social`)).toEqual([]);

    const res = await post(E2E_DISCORD_CHANNELS[0]);
    expect(res.status).toBe(200);
    // LinkedIn 1, X 2 (one tweet), Discord 1.
    expect(res.billing).toBe('API=4;');
    expect(res.body.posts.map((p: any) => p.provider)).toEqual(['linkedin', 'x', 'discord']);

    for (const post of res.body.posts) {
      expect(await control.post('/mkt/publish', { postId: post.id })).toEqual({ published: true });
      const status = await call({ path: `/posts/${post.id}` });
      expect(status.body).toMatchObject({ status: 'published', provider: post.provider });
      expect(status.body.url).toMatch(new RegExp(`^https://${post.provider}\\.example/e2e/`));
    }
    const after = await control.get<Calls>('/mkt/calls');
    for (const p of ['linkedin', 'x', 'discord']) expect(after[p].posts - before[p].posts).toBe(1);
  });

  test('on the trial, X is not included: the connect link and the post are both refused', async () => {
    const user = newSubscriber();
    const connect = await gw.call({ product: 'social', plan: 'trial', user, path: '/connect/x' });
    expect([connect.status, connect.body.error, connect.billing]).toEqual([402, 'plan_excludes_x', 'API=0;']);
  });
});

test.describe('api.market: connecting an account in the browser', () => {
  test('the connect link ends on "connected, close this tab", and the channel is in /channels', async ({ page }) => {
    const user = newSubscriber();
    const link = await gw.call({ product: 'linkedin', plan: 'trial', user, path: '/connect' });
    expect(link.status).toBe(200);
    const state = new URL(link.body.url).searchParams.get('state')!;
    // LinkedIn sends the subscriber back to our callback with a code (the
    // E2E backend answers codes starting "e2e-" with a fake profile).
    await page.goto(`/integrations/social/linkedin?state=${encodeURIComponent(state)}&code=e2e-mkt-${user.slice(-6)}`);
    await expect(page.getByText('Channel Connected!')).toBeVisible();
    await expect(page.getByText(CONNECTED)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/integrations/social/linkedin');

    const channels = await gw.call({ product: 'linkedin', plan: 'trial', user, path: '/channels' });
    expect(channels.body.channels).toEqual([expect.objectContaining({ provider: 'linkedin' })]);
  });

  test('signed in to a Hookpost account in the same browser, it still ends there, not on that account\'s calendar', async ({ page }) => {
    await signUpViaApi(page.context(), { country: 'US' });
    const user = newSubscriber();
    const link = await gw.call({ product: 'linkedin', plan: 'creator', user, path: '/connect' });
    const state = new URL(link.body.url).searchParams.get('state')!;
    await page.goto(`/integrations/social/linkedin?state=${encodeURIComponent(state)}&code=e2e-mkt-signed-${user.slice(-6)}`);
    await expect(page.getByText(CONNECTED)).toBeVisible();
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe('/integrations/social/linkedin');
    const channels = await gw.call({ product: 'linkedin', plan: 'creator', user, path: '/channels' });
    expect(channels.body.channels).toHaveLength(1);
  });
});

test.describe('api.market: LinkedIn Carousel', () => {
  test('three uploaded images render as a three-page PDF, billed 1 credit', async () => {
    const user = newSubscriber();
    const ids: string[] = [];
    for (const color of ['#e11d48', '#16a34a', '#2563eb']) {
      const up = await gw.call({ product: 'linkedin', plan: 'trial', user, path: '/media', form: imageForm(await png(800, 1000, color)) });
      expect([up.status, up.billing]).toEqual([200, 'API=0;']);
      ids.push(up.body.id);
    }
    const res = await gw.call({
      product: 'linkedin',
      plan: 'trial',
      user,
      path: '/carousels/render',
      body: { images: ids, title: 'Three slides', size: 'portrait' },
    });
    expect([res.status, res.billing]).toEqual([200, 'API=1;']);
    expect(res.body).toMatchObject({ pages: 3, width: 1080, height: 1350 });
    const stored = await control.get<{ pages: number }>(`/mkt/pdf-pages?url=${encodeURIComponent(res.body.pdf_url)}`);
    expect(stored.pages).toBe(3);
  });
});

test.describe('api.market: X Threads', () => {
  test('a thread with a link is refused under link_policy reject, and nothing reaches X', async () => {
    const user = newSubscriber();
    const estimate = await gw.call({
      product: 'x',
      plan: 'basic',
      user,
      path: '/threads/estimate',
      body: { tweets: [{ text: 'Thread 🧵' }, { text: 'Full write-up: https://example.com/post' }] },
    });
    expect([estimate.status, estimate.billing, estimate.body.valid]).toEqual([200, 'API=0;', false]);

    const channel = await control.post<{ id: string }>('/mkt/channel', { subscriber: user, product: 'x', provider: 'x' });
    const before = await control.get<Calls>('/mkt/calls');
    const res = await gw.call({
      product: 'x',
      plan: 'basic',
      user,
      path: '/threads',
      body: {
        channel_id: channel.id,
        tweets: [{ text: 'Thread 🧵' }, { text: 'Full write-up: https://example.com/post' }],
        schedule_at: 'now',
        link_policy: 'reject',
      },
    });
    expect([res.status, res.body.error, res.billing]).toEqual([400, 'invalid_thread', 'API=0;']);
    expect(await control.get(`/mkt/posts?subscriber=${user}&product=x`)).toEqual([]);
    expect((await control.get<Calls>('/mkt/calls')).x).toEqual(before.x);
  });

  test('a plain thread publishes every tweet as a reply chain', async () => {
    const user = newSubscriber();
    // The first call through the gateway creates the subscriber's workspace.
    expect((await gw.call({ product: 'x', plan: 'pro', user, path: '/usage' })).status).toBe(200);
    const channel = await control.post<{ id: string }>('/mkt/channel', { subscriber: user, product: 'x', provider: 'x' });
    const before = await control.get<Calls>('/mkt/calls');
    const res = await gw.call({
      product: 'x',
      plan: 'pro',
      user,
      path: '/threads',
      body: { channel_id: channel.id, tweets: [{ text: 'one' }, { text: 'two' }], schedule_at: tomorrow() },
    });
    expect([res.status, res.billing]).toEqual([200, 'API=4;']);
    expect(await control.post('/mkt/publish', { postId: res.body.posts[0].id })).toEqual({ published: true });
    const after = await control.get<Calls>('/mkt/calls');
    expect([after.x.posts - before.x.posts, after.x.comments - before.x.comments]).toEqual([1, 1]);
    const status = await gw.call({ product: 'x', plan: 'pro', user, path: `/threads/${res.body.posts[0].id}` });
    expect(status.body.replies).toEqual([expect.objectContaining({ status: 'published' })]);
  });
});

test.describe('api.market: Post Validator', () => {
  test('checks one draft for several networks, 1 credit; the rules are 0', async () => {
    const user = newSubscriber();
    const rules = await gw.call({ product: 'validate', plan: 'trial', user, path: '/rules' });
    expect([rules.status, rules.billing]).toEqual([200, 'API=0;']);
    const res = await gw.call({
      product: 'validate',
      plan: 'trial',
      user,
      path: '/check',
      body: { text: 'a'.repeat(300), platforms: ['x', 'linkedin', 'bluesky'] },
    });
    expect([res.status, res.billing]).toEqual([200, 'API=1;']);
    expect(res.body.results.map((r: any) => [r.platform, r.valid])).toEqual([
      ['x', false],
      ['linkedin', true],
      ['bluesky', true],
    ]);
  });
});

test('api.market: without the gateway secret nothing answers', async () => {
  const res = await fetch(`${BACKEND}/mkt/v1/social/providers`);
  expect(res.status).toBe(401);
});
