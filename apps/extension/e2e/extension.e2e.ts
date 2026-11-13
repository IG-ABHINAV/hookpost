/**
 * The store build of the extension, in a real Chromium: the Hookpost app gets
 * answers, every other page gets none, and a backendUrl sent by the app is
 * ignored by the daily refresh. See playwright.config.ts for how to run it.
 */
import { BrowserContext, chromium, expect, Page, test, Worker } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// This package is "type": "module", so there is no __dirname.
const here = dirname(fileURLToPath(import.meta.url));

const root = join(here, '..', '..', '..');
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnRlZ3JhdGlvbklkIjoiYyJ9.c2lnbmF0dXJl';

let tmp: string;
let context: BrowserContext;
let worker: Worker;
let extensionId: string;

test.beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'hookpost-ext-e2e-'));
  const build = join(tmp, 'build');
  execFileSync(
    process.execPath,
    [join(root, 'apps/extension/scripts/build.mjs'), '--out-dir', build, '--no-zip'],
    { cwd: root, stdio: 'pipe' }
  );

  context = await chromium.launchPersistentContext(join(tmp, 'profile'), {
    // New headless mode, which runs extensions.
    channel: process.env.EXTENSION_E2E_CHROMIUM ? undefined : 'chromium',
    executablePath: process.env.EXTENSION_E2E_CHROMIUM || undefined,
    headless: true,
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`],
  });

  // Every page is served here; any other request is refused, so the test
  // cannot reach the network.
  // (http and https only: the extension's own pages, popup.html and popup.js,
  // load from chrome-extension://.)
  await context.route((url) => url.protocol === 'http:' || url.protocol === 'https:', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 404 });
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>${url.host}</title><p>${url.host}</p>`,
    });
  });

  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Sends a message from the page; resolves with the reply or why there was none. */
function sendFrom(page: Page, message: unknown) {
  return page.evaluate(
    ([id, msg]) =>
      new Promise<unknown>((resolve) => {
        const runtime = (globalThis as any).chrome?.runtime;
        if (!runtime?.sendMessage) return resolve({ none: 'no chrome.runtime on this page' });
        setTimeout(() => resolve({ none: 'timeout' }), 5000);
        try {
          runtime.sendMessage(id, msg, (reply: unknown) =>
            resolve(reply === undefined ? { none: runtime.lastError?.message ?? 'empty' } : reply)
          );
        } catch (err: any) {
          resolve({ none: `threw: ${err?.message}` });
        }
      }),
    [extensionId, message] as const
  );
}

test('the Hookpost app gets a reply', async () => {
  const page = await context.newPage();
  await page.goto('https://hookpost.hookstep.in/launches');
  await expect(sendFrom(page, { type: 'PING' })).resolves.toEqual({
    status: 'ok',
    version: '1.0.2',
  });
  await expect(sendFrom(page, { type: 'GET_PROVIDERS' })).resolves.toMatchObject({
    providers: [{ identifier: 'skool' }],
  });
  await page.close();
});

for (const url of [
  'https://tablamigo.hookstep.in/',
  'https://media.hookstep.in/',
  'http://hookpost.hookstep.in/launches',
  'https://hookpost.com/',
  'http://localhost:4200/launches',
]) {
  test(`a page on ${url} gets no reply`, async () => {
    const page = await context.newPage();
    await page.goto(url);
    for (const message of [
      { type: 'PING' },
      { type: 'GET_COOKIES', provider: 'skool' },
    ]) {
      const reply = await sendFrom(page, message);
      expect(reply).toHaveProperty('none');
      expect(reply).not.toHaveProperty('status');
      expect(reply).not.toHaveProperty('cookies');
    }
    await page.close();
  });
}

test('a backendUrl from the app is ignored: the refresh posts to Hookpost', async () => {
  await context.addCookies(
    ['client_id', 'auth_token'].map((name) => ({
      name,
      value: `test-${name}`,
      domain: '.skool.com',
      path: '/',
      secure: true,
    }))
  );

  const page = await context.newPage();
  await page.goto('https://hookpost.hookstep.in/launches');
  await expect(
    sendFrom(page, {
      type: 'STORE_REFRESH_TOKEN',
      provider: 'skool',
      integrationId: 'cmu5ayoqf00093ecwco9dsdlc',
      jwt: JWT,
      backendUrl: 'https://evil.example/collect',
    })
  ).resolves.toEqual({ success: true });

  const stored = await worker.evaluate(
    async () => (await chrome.storage.local.get('refreshEntries')).refreshEntries
  );
  expect(stored).toEqual({ cmu5ayoqf00093ecwco9dsdlc: { jwt: JWT, provider: 'skool' } });

  // Record the refresh's requests instead of sending them, then fire it.
  await worker.evaluate(() => {
    const g = globalThis as any;
    g.__posts = [];
    g.fetch = async (url: string, init: RequestInit) => {
      g.__posts.push({ url: String(url), body: String(init?.body) });
      return new Response('{}', { status: 200 });
    };
    chrome.alarms.create('cookie-refresh', { when: Date.now() + 100 });
  });

  await expect
    .poll(() => worker.evaluate(() => (globalThis as any).__posts.length), { timeout: 60_000 })
    .toBeGreaterThan(0);
  const posts = await worker.evaluate(() => (globalThis as any).__posts);
  expect(posts).toHaveLength(1);
  expect(posts[0].url).toBe('https://hookpost.hookstep.in/api/integrations/extension-refresh');
  const body = JSON.parse(posts[0].body);
  expect(body.jwt).toBe(JWT);
  expect(JSON.parse(Buffer.from(body.cookies, 'base64').toString())).toEqual({
    client_id: 'test-client_id',
    auth_token: 'test-auth_token',
  });
  await page.close();
});

test('the toolbar popup says what is connected and opens Add Channel', async () => {
  // Hookpost's health check, answered here (the refresh test above already
  // swapped the worker's fetch; this keeps it independent of order).
  await worker.evaluate(() => {
    const g = globalThis as any;
    g.__healthChecks = [];
    g.fetch = async (url: string) => {
      g.__healthChecks.push(String(url));
      return new Response('{"status":"ok"}', { status: 200 });
    };
  });
  await context.addCookies(
    ['client_id', 'auth_token'].map((name) => ({
      name,
      value: `test-${name}`,
      domain: '.skool.com',
      path: '/',
      secure: true,
    }))
  );
  // One channel connected through this browser, as the app's connect does.
  await worker.evaluate(() => chrome.storage.local.clear());
  const app = await context.newPage();
  await app.goto('https://hookpost.hookstep.in/launches');
  await expect(
    sendFrom(app, {
      type: 'STORE_REFRESH_TOKEN',
      provider: 'skool',
      integrationId: 'cmu5ayoqf00093ecwco9dsdlp',
      jwt: JWT,
    })
  ).resolves.toEqual({ success: true });
  await app.close();
  const popup = await context.newPage();
  const errors: string[] = [];
  popup.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const rows = popup.locator('#rows li');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Reachable');
  await expect(rows.nth(1)).toContainText('Signed in on skool.com');
  await expect(rows.nth(2)).toContainText('1 Skool channel');
  await expect(popup.locator('#open')).toHaveText('Open Hookpost → Add Channel → Skool');
  await expect(popup.locator('#open')).toHaveAttribute(
    'href',
    'https://hookpost.hookstep.in/launches?add_channel=1'
  );
  await expect(popup.locator('#how')).toContainText('Add Channel');
  await expect(popup.locator('#footer')).toHaveText('Version 1.0.2');
  // The popup page sees no cookie value.
  expect(await popup.content()).not.toContain('test-auth_token');
  expect(await worker.evaluate(() => (globalThis as any).__healthChecks)).toEqual([
    'https://hookpost.hookstep.in/api/health',
  ]);
  if (process.env.EXTENSION_E2E_SCREENSHOTS) {
    await popup.setViewportSize({ width: 320, height: 400 });
    await popup.screenshot({ path: join(process.env.EXTENSION_E2E_SCREENSHOTS, 'popup-signed-in.png') });
  }

  // Signed out of Skool: the popup says so.
  await context.clearCookies({ domain: '.skool.com' });
  await popup.reload();
  await expect(popup.locator('#rows li').nth(1)).toContainText('Not signed in. Log in at skool.com');
  if (process.env.EXTENSION_E2E_SCREENSHOTS) {
    await popup.screenshot({ path: join(process.env.EXTENSION_E2E_SCREENSHOTS, 'popup-signed-out.png') });
  }

  // The button opens the app in a new tab (recorded here, so the test does
  // not load the real site).
  await popup.evaluate(() => {
    const w = window as any;
    w.__opened = [];
    chrome.tabs.create = ((props: { url: string }) => w.__opened.push(props.url)) as any;
    w.close = () => w.__opened.push('closed');
  });
  await popup.locator('#open').click();
  expect(await popup.evaluate(() => (window as any).__opened)).toEqual([
    'https://hookpost.hookstep.in/launches?add_channel=1',
    'closed',
  ]);
  expect(errors).toEqual([]);
  await popup.close();
});
