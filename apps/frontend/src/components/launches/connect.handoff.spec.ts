/**
 * Credentials never travel in the connect callback URL (connect.handoff.ts),
 * and the callback page's address bar loses its secrets before any other
 * script runs.
 *   pnpm exec jest -c apps/frontend/jest.config.ts connect.handoff
 */
import {
  CONNECT_URL_SCRUB_SCRIPT,
  encodeCredentials,
  handOffConnectCode,
  handoffCallbackPath,
  SECRET_CALLBACK_PARAMS,
  withoutSecretParams,
} from '@hookpost/frontend/components/launches/connect.handoff';

const HANDOFF = 'Q2xpZW50SWRBbmRUb2tlbk5ldmVySW5BVXJsXzEyMzQ1'.slice(0, 43);
const COOKIES = { client_id: 'skool-client-SECRET', auth_token: 'eyJhbGciOi.SECRET.sig' };

const respond = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);

describe('handOffConnectCode', () => {
  it('POSTs the credentials in the body and goes to a URL without them', async () => {
    const fetch = jest.fn(async () => respond(200, { handoff: HANDOFF }));
    const result = await handOffConnectCode(fetch, {
      provider: 'skool',
      state: 'st4te1',
      code: encodeCredentials(COOKIES),
      onboarding: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/integrations/social-connect/skool/handoff');
    expect(url).not.toContain('SECRET');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    expect(body.state).toBe('st4te1');
    expect(JSON.parse(Buffer.from(body.code, 'base64').toString())).toEqual(COOKIES);

    expect(result).toEqual({
      path: `/integrations/social/skool?state=st4te1&handoff=${HANDOFF}&onboarding=true`,
    });
    const path = (result as { path: string }).path;
    expect(path).not.toMatch(/SECRET|code=/);
    expect(path).not.toContain(body.code);
  });

  it.each([
    ['the link expired', respond(400, { statusCode: 400, message: 'This connect link was already used or has expired. Add the channel again from Add Channel.' }), 'This connect link was already used or has expired. Add the channel again from Add Channel.'],
    ['too many tries', respond(429, { statusCode: 429, message: 'Too many attempts for this connect.' }), 'Too many attempts for this connect.'],
    ['a validation error (message is a list)', respond(400, { message: ['code must be a string'] }), 'Could not connect to the platform'],
    ['no handoff in the answer', respond(200, {}), 'Could not connect to the platform'],
    ['a body that is not JSON', { ok: true, status: 200, json: async () => { throw new Error('bad'); } } as unknown as Response, 'Could not connect to the platform'],
  ])('%s: no navigation, and why', async (_what, response, error) => {
    const fetch = jest.fn(async () => response);
    expect(
      await handOffConnectCode(fetch, { provider: 'bluesky', state: 's', code: 'x' })
    ).toEqual({ error });
  });

  it('a network failure is an error, not a throw', async () => {
    const fetch = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(
      await handOffConnectCode(fetch, { provider: 'bluesky', state: 's', code: 'x' })
    ).toEqual({ error: 'Could not connect to the platform' });
  });
});

describe('encodeCredentials', () => {
  it('is base64 of the UTF-8 JSON, which is what the backend decodes', () => {
    const fields = { identifier: 'नमस्ते.bsky.social', password: 'app-pass-1234' };
    expect(JSON.parse(Buffer.from(encodeCredentials(fields), 'base64').toString('utf8'))).toEqual(
      fields
    );
  });

  it('is the same without Buffer (btoa), as in a browser', () => {
    const fields = { identifier: 'नमस्ते.bsky.social', password: 'p' };
    const withBuffer = encodeCredentials(fields);
    const saved = (global as any).Buffer;
    try {
      (global as any).Buffer = undefined;
      expect(encodeCredentials(fields)).toBe(withBuffer);
    } finally {
      (global as any).Buffer = saved;
    }
  });
});

describe('handoffCallbackPath', () => {
  it('escapes what it is given', () => {
    expect(
      handoffCallbackPath({ provider: 'skool', state: 'a&code=x', handoff: HANDOFF })
    ).toBe(`/integrations/social/skool?state=a%26code%3Dx&handoff=${HANDOFF}`);
  });
});

describe('the callback URL loses its secrets', () => {
  const URLS: Array<[string, string, string | null]> = [
    ['/integrations/social/skool', '?state=abc&code=SECRET', 'state=abc'],
    ['/integrations/social/skool', '?state=abc&handoff=H&onboarding=true', 'state=abc&onboarding=true'],
    ['/integrations/social/linkedin', '?code=oauth-code&state=abc', 'state=abc'],
    ['/integrations/social/x', '?oauth_token=t&oauth_verifier=SECRET', 'oauth_token=t'],
    ['/integrations/social/tiktok-business', '?auth_code=SECRET&state=s', 'state=s'],
    ['/integrations/social/mewe', '?state=s&loginRequestToken=SECRET', 'state=s'],
    ['/integrations/social/skool', '?state=abc', null],
    ['/integrations/social/skool', '', null],
    // Not the callback page: left alone.
    ['/auth', '?provider=GITHUB&code=abc', null],
    ['/launches', '?code=abc', null],
    ['/integrations/socialx', '?code=abc', null],
  ];

  it.each(URLS)('withoutSecretParams(%s%s) = %j', (path, search, expected) => {
    expect(withoutSecretParams(path, search)).toBe(expected);
  });

  const run = (url: string, state: unknown = { keep: 1 }) => {
    window.history.replaceState(state, '', url);
    new Function(CONNECT_URL_SCRUB_SCRIPT)();
    return window.location;
  };

  it.each(URLS)('the inlined script does the same: %s%s', (path, search, expected) => {
    const location = run(`${path}${search}#frag`);
    expect(location.pathname).toBe(path);
    expect(location.hash).toBe('#frag');
    const left = location.search.replace(/^\?/, '');
    expect(left).toBe(expected === null ? search.replace(/^\?/, '') : expected);
    for (const name of SECRET_CALLBACK_PARAMS) {
      if (path.startsWith('/integrations/social/')) {
        expect(new URLSearchParams(location.search).has(name)).toBe(false);
      }
    }
  });

  it('keeps the history entry state (Next.js stores its own there)', () => {
    run('/integrations/social/skool?state=s&code=SECRET', { __NA: true, tree: 'x' });
    expect(window.history.state).toEqual({ __NA: true, tree: 'x' });
    expect(window.location.href).not.toContain('SECRET');
    expect(document.URL).not.toContain('SECRET');
  });

  it('never throws, even without history', () => {
    window.history.replaceState(null, '', '/integrations/social/skool?code=SECRET');
    const spy = jest.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(() => new Function(CONNECT_URL_SCRUB_SCRIPT)()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('is plain ES5: no arrow functions, let/const or template strings', () => {
    expect(CONNECT_URL_SCRUB_SCRIPT).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });
});
