/**
 * The extension's message handler and daily refresh, with Chrome faked.
 * The point: a page cannot choose where the extension sends a user's Skool
 * cookies, and a page that is not the Hookpost app gets no answer at all.
 *   pnpm exec jest -c apps/extension/jest.config.ts handler
 */
import {
  createExternalMessageHandler,
  createPopupMessageHandler,
  createRefresher,
  ExtensionDeps,
} from './handler';
import { PRODUCTION_BACKEND_URL, PRODUCTION_POLICY } from './config';
import { getAllProviders, getProvider } from './providers/provider.registry';
import { StoredRefreshEntry } from './types/messages';

const APP = { origin: 'https://hookpost.hookstep.in' };
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJpbnRlZ3JhdGlvbklkIjoiYyJ9.c2lnbmF0dXJl';
const HOSTILE = 'https://evil.example/collect';
const SELF = 'fgbeifijcdbemmpfeipilgdfedpjcjig';

function setup(initial: Record<string, StoredRefreshEntry> = {}) {
  let entries: Record<string, StoredRefreshEntry> = JSON.parse(JSON.stringify(initial));
  const fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
  const deps: ExtensionDeps = {
    policy: PRODUCTION_POLICY,
    backendUrl: PRODUCTION_BACKEND_URL,
    appUrl: 'https://hookpost.hookstep.in',
    extensionId: SELF,
    version: '1.0.0',
    getProvider,
    getAllProviders,
    extractCookies: jest.fn(async (provider) => ({
      success: true as const,
      provider: provider.identifier,
      cookies: { client_id: 'cid', auth_token: 'tok' },
    })),
    loadEntries: jest.fn(async () => JSON.parse(JSON.stringify(entries))),
    saveEntries: jest.fn(async (next) => {
      entries = JSON.parse(JSON.stringify(next));
    }),
    ensureAlarm: jest.fn(async () => undefined),
    clearAlarmIfEmpty: jest.fn(async () => undefined),
    fetch: fetchMock as unknown as typeof fetch,
  };
  const handle = createExternalMessageHandler(deps);
  /** Sends a message; resolves with the reply, or 'no reply'. */
  const send = (message: unknown, sender: { origin?: string; url?: string; id?: string } = APP) =>
    new Promise<unknown>((resolve) => {
      const async = handle(message, sender, resolve);
      if (!async) setTimeout(() => resolve('no reply'), 0);
    });
  return { deps, send, fetchMock, entries: () => entries };
}

describe('origin check', () => {
  it('answers the Hookpost app', async () => {
    const { send } = setup();
    await expect(send({ type: 'PING' })).resolves.toEqual({ status: 'ok', version: '1.0.0' });
  });

  it.each([
    [{ origin: 'https://tablamigo.hookstep.in' }],
    [{ origin: 'https://media.hookstep.in' }],
    [{ origin: 'http://hookpost.hookstep.in' }],
    [{ origin: 'http://localhost:4200' }],
    [{ origin: 'https://hookpost.com' }],
    [{ url: 'https://hookpost.hookstep.in.evil.example/x' }],
    // Another extension, even one claiming the app's origin.
    [{ id: 'abcdefghijklmnopabcdefghijklmnop', origin: 'https://hookpost.hookstep.in' }],
    [{}],
  ])('gives no reply to %j', async (sender) => {
    const { send, deps } = setup();
    for (const type of ['PING', 'GET_PROVIDERS']) {
      await expect(send({ type }, sender)).resolves.toBe('no reply');
    }
    await expect(send({ type: 'GET_COOKIES', provider: 'skool' }, sender)).resolves.toBe(
      'no reply'
    );
    await expect(
      send(
        { type: 'STORE_REFRESH_TOKEN', provider: 'skool', integrationId: 'c1', jwt: JWT },
        sender
      )
    ).resolves.toBe('no reply');
    expect(deps.extractCookies).not.toHaveBeenCalled();
    expect(deps.saveEntries).not.toHaveBeenCalled();
  });
});

describe('STORE_REFRESH_TOKEN', () => {
  it('ignores a hostile backendUrl: it is not stored, and the refresh posts to Hookpost', async () => {
    const { send, deps, fetchMock, entries } = setup();
    await expect(
      send({
        type: 'STORE_REFRESH_TOKEN',
        provider: 'skool',
        integrationId: 'cmu5ayoqf00093ecwco9dsdlc',
        jwt: JWT,
        backendUrl: HOSTILE,
      })
    ).resolves.toEqual({ success: true });

    expect(entries()).toEqual({
      cmu5ayoqf00093ecwco9dsdlc: { jwt: JWT, provider: 'skool' },
    });
    expect(JSON.stringify(entries())).not.toContain('evil');
    expect(deps.ensureAlarm).toHaveBeenCalled();

    await createRefresher(deps)();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://hookpost.hookstep.in/api/integrations/extension-refresh');
    expect(JSON.parse(String(init.body))).toEqual({
      jwt: JWT,
      cookies: Buffer.from(JSON.stringify({ client_id: 'cid', auth_token: 'tok' })).toString(
        'base64'
      ),
    });
  });

  it.each([
    ['an unknown provider', { provider: 'instagram' }],
    ['a provider that is not a string', { provider: { identifier: 'skool' } }],
    ['__proto__ as the integration id', { integrationId: '__proto__' }],
    ['an integration id with a slash', { integrationId: '../x' }],
    ['an empty integration id', { integrationId: '' }],
    ['a jwt that is not a JWT', { jwt: 'not a token' }],
    ['a jwt that is too long', { jwt: `${'a'.repeat(9000)}.b.c` }],
    ['no jwt', { jwt: undefined }],
  ])('refuses %s', async (_label, override) => {
    const { send, deps } = setup();
    await expect(
      send({
        type: 'STORE_REFRESH_TOKEN',
        provider: 'skool',
        integrationId: 'cmu5ayoqf00093ecwco9dsdlc',
        jwt: JWT,
        ...override,
      })
    ).resolves.toEqual({ success: false, error: 'Invalid refresh token' });
    expect(deps.saveEntries).not.toHaveBeenCalled();
  });
});

describe('daily refresh', () => {
  it('posts to Hookpost even for an entry an older build stored with its own backendUrl', async () => {
    const legacy = { jwt: JWT, provider: 'skool', backendUrl: HOSTILE } as StoredRefreshEntry;
    const { deps, fetchMock } = setup({ c1: legacy });
    await createRefresher(deps)();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://hookpost.hookstep.in/api/integrations/extension-refresh',
      expect.anything(),
    ]);
  });

  it.each([
    ['401 (token refused)', () => new Response('{"message":"Invalid token"}', { status: 401 })],
    ['404 (channel deleted)', () => new Response('{"message":"Integration not found"}', { status: 404 })],
    [
      'account_mismatch (signed in to another Skool account)',
      () => new Response('{"success":false,"reason":"account_mismatch"}', { status: 201 }),
    ],
  ])('drops the entry after %s, so it is not sent again', async (_label, reply) => {
    const { deps, fetchMock, entries } = setup({
      c1: { jwt: JWT, provider: 'skool' },
      c2: { jwt: `${JWT}x`, provider: 'skool' },
    });
    fetchMock.mockImplementationOnce(async () => reply());
    await createRefresher(deps)();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.keys(entries())).toEqual(['c2']);
    expect(deps.clearAlarmIfEmpty).toHaveBeenCalled();
  });

  it.each([
    ['success', () => new Response('{"success":true}', { status: 201 })],
    // Not the endpoint's own answer: a misrouted /api or a renamed route.
    ['a 404 page from elsewhere', () => new Response('<html>Not Found</html>', { status: 404 })],
    ['a 404 with another message', () => new Response('{"message":"Cannot POST /x"}', { status: 404 })],
    ['a 401 from elsewhere', () => new Response('Unauthorized', { status: 401 })],
    ['a 400 (Skool hiccup)', () => new Response('{"message":"Invalid cookie data"}', { status: 400 })],
    ['a 502', () => new Response('bad gateway', { status: 502 })],
  ])('keeps the entry after %s', async (_label, reply) => {
    const { deps, fetchMock, entries } = setup({ c1: { jwt: JWT, provider: 'skool' } });
    fetchMock.mockImplementationOnce(async () => reply());
    await createRefresher(deps)();
    expect(Object.keys(entries())).toEqual(['c1']);
    expect(deps.saveEntries).not.toHaveBeenCalled();
  });

  it('keeps an entry that was replaced with a new token during the run', async () => {
    const { deps, fetchMock, entries } = setup({ c1: { jwt: JWT, provider: 'skool' } });
    fetchMock.mockImplementationOnce(async () => {
      // A reconnect stores a fresh token while the refresh is in flight.
      await deps.saveEntries({ c1: { jwt: `${JWT}new`, provider: 'skool' } });
      return new Response('{}', { status: 404 });
    });
    await createRefresher(deps)();
    expect(entries()).toEqual({ c1: { jwt: `${JWT}new`, provider: 'skool' } });
  });

  it('skips an entry whose cookies are gone', async () => {
    const { deps, fetchMock } = setup({ c1: { jwt: JWT, provider: 'skool' } });
    (deps.extractCookies as jest.Mock).mockResolvedValue({
      success: false,
      provider: 'skool',
      error: 'Missing required cookies: auth_token',
    });
    await createRefresher(deps)();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('other messages', () => {
  it('GET_COOKIES returns the provider cookies to the app', async () => {
    const { send } = setup();
    await expect(send({ type: 'GET_COOKIES', provider: 'skool' })).resolves.toEqual({
      success: true,
      provider: 'skool',
      cookies: { client_id: 'cid', auth_token: 'tok' },
    });
  });

  it('GET_COOKIES refuses an unknown provider without reading cookies', async () => {
    const { send, deps } = setup();
    await expect(send({ type: 'GET_COOKIES', provider: 'facebook' })).resolves.toMatchObject({
      success: false,
    });
    expect(deps.extractCookies).not.toHaveBeenCalled();
  });

  it('REMOVE_REFRESH_TOKEN removes the entry', async () => {
    const { send, entries } = setup({ c1: { jwt: JWT, provider: 'skool' } });
    await expect(send({ type: 'REMOVE_REFRESH_TOKEN', integrationId: 'c1' })).resolves.toEqual({
      success: true,
    });
    expect(entries()).toEqual({});
  });

  it.each([[null], ['PING'], [42], [{ type: 'NOPE' }]])('answers %j with an error', async (msg) => {
    const { send } = setup();
    await expect(send(msg)).resolves.toHaveProperty('error');
  });
});

describe('popup status (the toolbar button)', () => {
  const POPUP = { id: SELF, url: `chrome-extension://${SELF}/popup.html` };

  function popup(initial: Record<string, StoredRefreshEntry> = {}) {
    const ctx = setup(initial);
    const handle = createPopupMessageHandler(ctx.deps);
    const ask = (sender: { id?: string; url?: string; origin?: string } = POPUP, message: unknown = { type: 'POPUP_STATUS' }) =>
      new Promise<unknown>((resolve) => {
        const async = handle(message, sender, resolve);
        if (!async) setTimeout(() => resolve('no reply'), 0);
      });
    return { ...ctx, ask };
  }

  it('reports Hookpost reachable, the Skool session and the channels this browser keeps fresh', async () => {
    const { ask, fetchMock } = popup({ c1: { jwt: JWT, provider: 'skool' } });
    fetchMock.mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));
    await expect(ask()).resolves.toEqual({
      version: '1.0.0',
      hookpostReachable: true,
      skoolSignedIn: true,
      connectedChannels: 1,
      addChannelUrl: 'https://hookpost.hookstep.in/launches?add_channel=1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe('https://hookpost.hookstep.in/api/health');
  });

  it('never hands the popup a cookie value', async () => {
    const { ask } = popup();
    const reply = JSON.stringify(await ask());
    expect(reply).not.toContain('tok');
    expect(reply).not.toContain('cid');
  });

  it('says signed out of Skool when the cookies are missing', async () => {
    const { ask, deps } = popup();
    (deps.extractCookies as jest.Mock).mockResolvedValueOnce({
      success: false,
      provider: 'skool',
      error: 'Missing required cookies',
      missingCookies: ['auth_token'],
    });
    await expect(ask()).resolves.toMatchObject({ skoolSignedIn: false, connectedChannels: 0 });
  });

  it('says unreachable when Hookpost does not answer, or answers an error', async () => {
    const down = popup();
    down.fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(down.ask()).resolves.toMatchObject({ hookpostReachable: false });
    const error = popup();
    error.fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }));
    await expect(error.ask()).resolves.toMatchObject({ hookpostReachable: false });
  });

  it.each([
    [{ origin: 'https://hookpost.hookstep.in' }],
    [{ id: 'abcdefghijklmnopabcdefghijklmnop', url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html' }],
    [{ id: SELF, url: 'https://www.skool.com/' }],
    [{}],
  ])('gives no reply to %j', async (sender) => {
    const { ask, fetchMock } = popup();
    await expect(ask(sender)).resolves.toBe('no reply');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores other message types from the popup', async () => {
    const { ask } = popup();
    await expect(ask(POPUP, { type: 'GET_COOKIES', provider: 'skool' })).resolves.toBe('no reply');
  });
});
