/**
 * A channel's credentials never travel in a URL (components/launches/
 * connect.handoff.ts). Skool's session cookies, which the Chrome extension
 * reads, used to reach the callback page as
 * /integrations/social/skool?state=...&code=<base64 of the cookies>, and the
 * custom-field providers' API keys and app passwords the same way. That page
 * loads the Meta pixel, GTM, Sentry, Plausible and Dub, all of which read the
 * page URL.
 *
 * Every third-party request is answered here instead of the network: a script
 * becomes a stand-in tracker that writes down the URL, document.URL and
 * referrer the page shows it when it runs, as a real one reads them, and
 * anything else gets a 204. Every request the page makes is recorded, so the
 * specs can say exactly where a secret went. The extension is stood in for by
 * a chrome.runtime that answers PING and GET_COOKIES as it does.
 */
import { expect, Page, test } from '@playwright/test';
import { addChannelButton, api, BACKEND, control, failOnServerErrors, signUpViaApi } from './support';

interface Seen {
  url: string;
  method: string;
  referer: string;
  body: string;
  type: string;
  thirdParty: boolean;
}

interface TrackerView {
  src: string;
  href: string;
  url: string;
  referrer: string;
}

const isOurs = (raw: string) => {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
};

const TRACKER_STUB = (src: string) => `(function () {
  var w = window;
  (w.__trackersSaw = w.__trackersSaw || []).push({
    src: ${JSON.stringify(src)},
    href: String(w.location.href),
    url: String(document.URL),
    referrer: String(document.referrer)
  });
})();`;

async function watchTraffic(page: Page) {
  const seen: Seen[] = [];
  page.on('request', (req) => {
    seen.push({
      url: req.url(),
      method: req.method(),
      referer: req.headers()['referer'] || '',
      body: req.postData() || '',
      type: req.resourceType(),
      thirdParty: !isOurs(req.url()),
    });
  });
  await page.route(
    (url) => !isOurs(url.href),
    (route) =>
      route.request().resourceType() === 'script'
        ? route.fulfill({ contentType: 'application/javascript', body: TRACKER_STUB(route.request().url()) })
        : route.fulfill({ status: 204, body: '' })
  );
  return {
    seen,
    trackers: () => page.evaluate(() => ((window as any).__trackersSaw || []) as TrackerView[]),
    /** "METHOD /path" of every request whose body contains `secret`. */
    bodiesWith: (secret: string) =>
      seen.filter((r) => r.body.includes(secret)).map((r) => `${r.method} ${new URL(r.url).pathname}`),
    /** Requests whose URL or Referer contains `secret`, optionally first-party ones only. */
    urlsWith: (secret: string) =>
      seen.filter((r) => r.url.includes(secret) || r.referer.includes(secret)),
  };
}

/**
 * The extension's side of the conversation (apps/extension/src/handler.ts).
 * What it was told is kept here, across the page loads of the connect.
 */
async function stubExtension(page: Page, cookies: Record<string, string>) {
  const told: Array<{ id: string; type: string; integrationId?: string; hasJwt: boolean }> = [];
  await page.exposeBinding('__e2eExtensionTold', (_source, m) => {
    told.push(m);
  });
  await page.addInitScript((c) => {
    const w = window as any;
    w.chrome = w.chrome || {};
    w.chrome.runtime = {
      lastError: undefined,
      sendMessage(id: string, message: any, callback: (response: any) => void) {
        w.__e2eExtensionTold({ id, type: message?.type, integrationId: message?.integrationId, hasJwt: !!message?.jwt });
        setTimeout(() => {
          if (message?.type === 'PING') return callback({ status: true });
          if (message?.type === 'GET_COOKIES') return callback({ success: true, cookies: c });
          return callback({ success: true });
        }, 10);
      },
    };
  }, cookies);
  return told;
}

/** Holds the callback's POST to the backend until a tracker has run on the page. */
async function holdConnectUntilTrackersRan(page: Page, provider: string) {
  await page.route(`${BACKEND}/integrations/social-connect/${provider}`, async (route) => {
    await page
      .waitForFunction(() => ((window as any).__trackersSaw || []).length > 0, null, { timeout: 15_000 })
      .catch(() => undefined);
    await route.continue();
  });
}

const expectClean = (views: TrackerView[], secrets: string[]) => {
  for (const view of views) {
    for (const secret of secrets) {
      expect(view.href, `${view.src} read location.href`).not.toContain(secret);
      expect(view.url, `${view.src} read document.URL`).not.toContain(secret);
      expect(view.referrer, `${view.src} read document.referrer`).not.toContain(secret);
    }
    expect(view.href).not.toMatch(/[?&](code|handoff)=/);
  }
};

async function paidWorkspace(page: Page) {
  const account = await signUpViaApi(page.context());
  await control.givePlan(account.email, 'STANDARD');
  return account;
}

test.describe('channel credentials never travel in a URL', () => {
  test('Skool: the extension\'s cookies go to the backend in a POST body; the callback URL has a one-time id', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await paidWorkspace(page);
    const id = Date.now().toString(36);
    const cookies = { client_id: `skoolclient${id}SECRET`, auth_token: `e2e-${id}-skooltokenSECRET` };
    const code = Buffer.from(JSON.stringify(cookies)).toString('base64');
    const traffic = await watchTraffic(page);
    const told = await stubExtension(page, cookies);
    await holdConnectUntilTrackersRan(page, 'skool');

    await page.goto('/launches');
    await addChannelButton(page).click();
    await page.getByText('Skool', { exact: true }).first().click();
    await page.getByRole('button', { name: 'I understand, continue' }).click();
    await page.waitForURL(/added=skool/);

    // Connected, with those cookies, and the extension got its refresh token.
    const channels = await api(auth, 'GET', '/integrations/list');
    const row = channels.body.integrations.find((c: any) => c.name === `E2E Skool ${id}`);
    expect(row?.identifier).toBe('skool');
    expect(JSON.stringify(channels.body)).not.toContain(cookies.auth_token);
    await expect.poll(() => told.map((m) => m.type)).toEqual(['PING', 'GET_COOKIES', 'STORE_REFRESH_TOKEN']);
    expect(told[2]).toMatchObject({ id: 'abcdefghijklmnopabcdefghijklmnop', integrationId: row.id, hasJwt: true });

    // The callback page was opened with a handoff id and no code.
    const callback = traffic.seen.find((r) => r.type === 'document' && r.url.includes('/integrations/social/skool'))!;
    expect(callback.url).toMatch(/[?&]handoff=[A-Za-z0-9_-]{43}(&|$)/);
    expect(callback.url).not.toMatch(/[?&]code=/);
    const handoff = new URL(callback.url).searchParams.get('handoff')!;

    // No cookie, and no encoding of them, in any URL or Referer; the encoded
    // cookies are in exactly one request body: the handoff POST.
    for (const secret of [cookies.auth_token, cookies.client_id, code, encodeURIComponent(code)]) {
      expect(traffic.urlsWith(secret).map((r) => r.url)).toEqual([]);
    }
    expect(traffic.bodiesWith(code)).toEqual(['POST /integrations/social-connect/skool/handoff']);
    expect(traffic.bodiesWith(cookies.auth_token)).toEqual([]);
    // The id is redeemed by the page's own POST; no third party ever gets it.
    expect(traffic.seen.filter((r) => r.thirdParty && (r.url + r.referer + r.body).includes(handoff))).toEqual([]);

    // The trackers ran on the callback page and saw neither the cookies nor the id.
    const views = await traffic.trackers();
    expect(views.some((v) => v.href.includes('/integrations/social/skool'))).toBe(true);
    test.info().annotations.push({
      type: 'trackers that ran on the callback page',
      description: [...new Set(views.map((v) => new URL(v.src).host))].join(', '),
    });
    expectClean(views, [cookies.auth_token, cookies.client_id, code, handoff]);
    errors.assertNone();

    // The same callback URL again (Back, a reload, a second tab): already connected, no error.
    await page.unroute(`${BACKEND}/integrations/social-connect/skool`);
    await page.goto(callback.url);
    await page.waitForURL(/\/launches\?msg=/);
    await expect(page.getByText('Could not add provider')).toHaveCount(0);
    const after = await api(auth, 'GET', '/integrations/list');
    expect(after.body.integrations.filter((c: any) => c.identifier === 'skool')).toHaveLength(1);
  });

  test('an old Skool link with the cookies in ?code= still connects, and no tracker sees them', async ({ page }) => {
    const { auth } = await paidWorkspace(page);
    const id = Date.now().toString(36);
    const cookies = { client_id: `oldclient${id}SECRET`, auth_token: `e2e-${id}-oldtokenSECRET` };
    const code = Buffer.from(JSON.stringify(cookies)).toString('base64');
    const traffic = await watchTraffic(page);
    await holdConnectUntilTrackersRan(page, 'skool');
    const state = (await api(auth, 'GET', '/integrations/social/skool')).body.url;
    expect(state).toBeTruthy();

    await page.goto(`/integrations/social/skool?state=${state}&code=${encodeURIComponent(code)}`);
    // Before the page connects: the address bar has lost the code, kept the state.
    await page.waitForFunction(() => ((window as any).__trackersSaw || []).length > 0);
    const params = new URL(page.url()).searchParams;
    expect(params.has('code')).toBe(false);
    expect(params.get('state')).toBe(state);

    await page.waitForURL(/added=skool/);
    const channels = await api(auth, 'GET', '/integrations/list');
    expect(channels.body.integrations.some((c: any) => c.name === `E2E Skool ${id}`)).toBe(true);

    expectClean(await traffic.trackers(), [cookies.auth_token, cookies.client_id, code, encodeURIComponent(code)]);
    for (const secret of [code, encodeURIComponent(code), cookies.auth_token]) {
      expect(traffic.seen.filter((r) => r.thirdParty && (r.url + r.referer + r.body).includes(secret))).toEqual([]);
    }
    // Only our own origin ever saw it: the document request itself, and
    // whatever the browser fetched for that page before the scrub ran (its
    // Referer). Cross-origin Referers are origin-only (strict-origin-when-cross-origin).
    const ownUrls = traffic.urlsWith(encodeURIComponent(code));
    expect(ownUrls.every((r) => !r.thirdParty)).toBe(true);
    test.info().annotations.push({
      type: 'own-origin requests carrying the legacy code (URL or Referer)',
      description: ownUrls.map((r) => `${r.type} ${new URL(r.url).pathname}`).join(', '),
    });
  });

  test('an OAuth callback (LinkedIn): the code leaves the address bar before any tracker runs, and the connect still works', async ({ page }) => {
    const { auth } = await paidWorkspace(page);
    const id = `${Date.now()}`;
    const oauthCode = `e2e-${id}`;
    const traffic = await watchTraffic(page);
    await holdConnectUntilTrackersRan(page, 'linkedin');
    const consent = (await api(auth, 'GET', '/integrations/social/linkedin')).body.url;
    const state = new URL(consent).searchParams.get('state')!;

    await page.goto(`/integrations/social/linkedin?code=${oauthCode}&state=${state}`);
    await page.waitForFunction(() => ((window as any).__trackersSaw || []).length > 0);
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    await page.waitForURL(/added=linkedin/);
    await expect(page.getByText(`E2E LinkedIn ${id}`)).toBeVisible();

    expectClean(await traffic.trackers(), [oauthCode]);
    expect(traffic.seen.filter((r) => r.thirdParty && (r.url + r.referer + r.body).includes(oauthCode))).toEqual([]);

    // A reload of the callback, whose URL no longer has the code: already connected.
    await page.goto(`/integrations/social/linkedin?state=${state}`);
    await page.waitForURL(/\/launches\?msg=/);
    await expect(page.getByText('Could not add provider')).toHaveCount(0);
  });

  test('Bluesky: the app password goes in a POST body, never in a URL', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { auth } = await paidWorkspace(page);
    const id = Date.now().toString(36);
    const handle = `e2e-${id}.bsky.social`;
    const password = `apppass-${id}-SECRET`;
    const traffic = await watchTraffic(page);
    await holdConnectUntilTrackersRan(page, 'bluesky');

    await page.goto('/launches');
    await addChannelButton(page).click();
    await page.getByText('Bluesky', { exact: true }).first().click();
    await page.locator('input[name="identifier"]').fill(handle);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForURL(/added=bluesky/);

    const channels = await api(auth, 'GET', '/integrations/list');
    expect(channels.body.integrations.some((c: any) => c.name === `E2E Bluesky ${id}`)).toBe(true);

    const handoffPosts = traffic.seen.filter((r) => r.url.endsWith('/integrations/social-connect/bluesky/handoff'));
    expect(handoffPosts).toHaveLength(1);
    const code = JSON.parse(handoffPosts[0].body).code;
    expect(JSON.parse(Buffer.from(code, 'base64').toString())).toMatchObject({ identifier: handle, password });
    for (const secret of [password, code, encodeURIComponent(code)]) {
      expect(traffic.urlsWith(secret).map((r) => r.url)).toEqual([]);
    }
    expect(traffic.bodiesWith(code)).toEqual(['POST /integrations/social-connect/bluesky/handoff']);
    expect(traffic.bodiesWith(password)).toEqual([]);
    expectClean(await traffic.trackers(), [password, code]);
    errors.assertNone();
  });

  test('no script on the callback page sees the code: not a tracker, not even Next.js\'s own first chunk', async ({ page }) => {
    const { auth } = await paidWorkspace(page);
    const oauthCode = `e2e-${Date.now()}`;
    const traffic = await watchTraffic(page);
    await holdConnectUntilTrackersRan(page, 'linkedin');
    // Next.js puts its own chunks in <head> as async scripts, ahead of the
    // layout's inline scrub. Each one is made to write down the URL the
    // moment it runs: if any ran before the scrub, it would have the code.
    await page.route('**/_next/static/chunks/**', async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      return route.fulfill({
        response: res,
        body: `(self.__chunksSaw = self.__chunksSaw || []).push(String(location.href));\n${body}`,
      });
    });
    const consent = (await api(auth, 'GET', '/integrations/social/linkedin')).body.url;
    const state = new URL(consent).searchParams.get('state')!;

    const doc = await page.goto(`/integrations/social/linkedin?code=${oauthCode}&state=${state}`);
    await page.waitForFunction(() => ((window as any).__trackersSaw || []).length > 0);
    const chunks: string[] = await page.evaluate(() => (self as any).__chunksSaw || []);
    expect(chunks.length).toBeGreaterThan(0);
    for (const href of chunks) {
      expect(href).not.toContain(oauthCode);
    }
    expectClean(await traffic.trackers(), [oauthCode]);

    // In the HTML: the scrub is an inline, synchronous script in <head>; the
    // only scripts before it are Next.js's own async chunks.
    const html = await doc!.text();
    const head = html.slice(0, html.indexOf('</head>'));
    const scrubAt = head.indexOf('<script>(function(){try{var l=window.location;if(l.pathname.indexOf("/integrations/social/")!==0)return;');
    expect(scrubAt).toBeGreaterThan(0);
    const before = [...head.slice(0, scrubAt).matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of before) {
      expect(tag).toMatch(/^<script src="\/_next\/static\/chunks\/[^"]+\.js" async=""( crossorigin="")?>$/);
    }
    await page.waitForURL(/added=linkedin/);
    // Chunks the calendar is still loading when the test ends.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });
});
