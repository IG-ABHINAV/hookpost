/**
 * The page's HTML starts /user/self (and on /launches the channels) before
 * React loads, and customFetch takes those answers instead of asking again.
 *   pnpm exec jest -c apps/frontend/jest.config.ts early.fetch
 */
import {
  EARLY_FETCH_MAX_AGE_MS,
  earlyFetchScript,
  takeEarlyResponse,
} from '@hookpost/helpers/utils/early.fetch';
import { customFetch } from '@hookpost/helpers/utils/custom.fetch.func';

const BACKEND = 'https://hookpost.hookstep.in/api';

const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: new Map<string, string>() as unknown as Headers,
    json: async () => body,
  } as unknown as Response);

const clearCookies = () => {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
};

const runScript = () => {
  // eslint-disable-next-line no-new-func
  new Function(earlyFetchScript(BACKEND))();
};

let fetchMock: jest.Mock;

beforeEach(() => {
  clearCookies();
  delete window.__hpEarly;
  window.history.pushState({}, '', '/launches');
  fetchMock = jest.fn(async (url: string) => okResponse({ url }));
  (global as any).fetch = fetchMock;
});

describe('earlyFetchScript', () => {
  it('starts /user/self and the channels on /launches for a signed-in browser', () => {
    document.cookie = 'hp_logged_in=1; path=/';
    runScript();
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([`${BACKEND}/user/self`, `${BACKEND}/integrations/list`]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.credentials).toBe('include');
      expect(init.cache).toBe('no-store');
      expect(init.method).toBeUndefined();
    }
    expect(Object.keys(window.__hpEarly!.r)).toEqual(urls);
  });

  it('starts only /user/self on other app pages', () => {
    document.cookie = 'hp_logged_in=1; path=/';
    window.history.pushState({}, '', '/analytics');
    runScript();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      `${BACKEND}/user/self`,
    ]);
  });

  it('sends nothing for a browser that has never signed in', () => {
    runScript();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.__hpEarly).toBeUndefined();
  });

  it('sends nothing when the page carries a loggedAuth token', () => {
    document.cookie = 'hp_logged_in=1; path=/';
    window.history.pushState({}, '', '/launches?loggedAuth=abc');
    runScript();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a readable host-only session copy before sending', () => {
    document.cookie = 'hp_logged_in=1; path=/';
    document.cookie = 'auth=stale; path=/';
    runScript();
    expect(document.cookie).not.toContain('auth=stale');
  });

  it('escapes the backend url so it cannot close the script tag', () => {
    expect(earlyFetchScript('https://x/</script><b>')).not.toContain('</script>');
  });
});

describe('takeEarlyResponse', () => {
  const store = (t = Date.now()) => {
    const p = Promise.resolve(okResponse({}));
    window.__hpEarly = { t, r: { [`${BACKEND}/user/self`]: p } };
    return p;
  };

  it('hands over the early answer once', () => {
    const p = store();
    expect(takeEarlyResponse(`${BACKEND}/user/self`)).toBe(p);
    expect(takeEarlyResponse(`${BACKEND}/user/self`)).toBeUndefined();
  });

  it('never hands over an answer older than the page load window', () => {
    store(Date.now() - EARLY_FETCH_MAX_AGE_MS - 1);
    expect(takeEarlyResponse(`${BACKEND}/user/self`)).toBeUndefined();
  });

  it('only for a plain GET', () => {
    store();
    expect(
      takeEarlyResponse(`${BACKEND}/user/self`, { method: 'POST' })
    ).toBeUndefined();
    expect(
      takeEarlyResponse(`${BACKEND}/user/self`, { headers: { showorg: 'x' } })
    ).toBeUndefined();
    expect(takeEarlyResponse(`${BACKEND}/user/self`, { headers: {} })).toBeDefined();
  });

  it('nothing for a path that was not started early', () => {
    store();
    expect(takeEarlyResponse(`${BACKEND}/posts`)).toBeUndefined();
  });
});

describe('customFetch with an early answer', () => {
  const afterRequest = jest.fn(async () => true);
  const make = (secured = true) =>
    customFetch({ baseUrl: BACKEND, afterRequest }, undefined, undefined, secured);

  beforeEach(() => afterRequest.mockClear());

  it('uses it instead of sending the request again, and still runs afterRequest', async () => {
    const early = okResponse({ id: 'u1' });
    window.__hpEarly = {
      t: Date.now(),
      r: { [`${BACKEND}/user/self`]: Promise.resolve(early) },
    };
    const res = await make()('/user/self');
    expect(res).toBe(early);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(afterRequest).toHaveBeenCalledWith('/user/self', {}, early);

    // The next call is a real request.
    await make()('/user/self');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the request itself when the early one failed', async () => {
    const failed = Promise.reject(new Error('offline'));
    failed.catch(() => undefined);
    window.__hpEarly = { t: Date.now(), r: { [`${BACKEND}/user/self`]: failed } };
    await make()('/user/self');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('is never used under NOT_SECURED, where the session is a header', async () => {
    window.__hpEarly = {
      t: Date.now(),
      r: { [`${BACKEND}/user/self`]: Promise.resolve(okResponse({})) },
    };
    await make(false)('/user/self');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
