/**
 * The `Hookpost` client in src/index.ts: every method hits the right
 * /public/v1/... URL with the right verb, carries the API key in the
 * Authorization header, and hands back the parsed JSON. node-fetch is mocked
 * (the SDK imports fetch and FormData from it), so nothing here opens a
 * socket. The Authorization header carries the raw API key, with no "Bearer"
 * prefix — the assertions below pin exactly what the client sends.
 *   pnpm exec jest -c apps/sdk/jest.config.ts
 */
import fetch, { FormData } from 'node-fetch';
import Hookpost from './index';

jest.mock('node-fetch', () => {
  class FormDataMock {
    entries: unknown[][] = [];

    append(...args: unknown[]) {
      this.entries.push(args);
    }
  }

  return {
    __esModule: true,
    default: jest.fn(),
    FormData: FormDataMock,
  };
});

const mockedFetch = fetch as unknown as jest.Mock;

const API = 'https://hookpost.hookstep.in/api';
const KEY = 'sk-test-key';

/** What the SDK's `(...).json()` reads off the mocked response. */
function respondWith(payload: unknown) {
  const json = jest.fn().mockResolvedValue(payload);
  mockedFetch.mockResolvedValue({ json });
  return json;
}

/** The single call the SDK made, as [url, init]. */
function onlyCall(): [string, Record<string, any>] {
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  return mockedFetch.mock.calls[0] as [string, Record<string, any>];
}

beforeEach(() => {
  mockedFetch.mockReset();
});

describe('post', () => {
  it('POSTs JSON to /public/v1/posts with the API key and returns the parsed body', async () => {
    const json = respondWith({ id: 'post-1' });
    const posts = { platform: 'twitter', content: 'hello' };

    const result = await new Hookpost(KEY).post(posts as any);

    const [url, init] = onlyCall();
    expect(url).toBe(`${API}/public/v1/posts`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(KEY);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(posts));
    expect(json).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'post-1' });
  });
});

describe('postList', () => {
  it('turns the filters into the query string on a GET to /public/v1/posts', async () => {
    respondWith({ posts: [] });

    await new Hookpost(KEY).postList({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      customer: 'acme corp',
      includeAttachments: true,
    } as any);

    const [url, init] = onlyCall();
    expect(url).toBe(
      `${API}/public/v1/posts?startDate=2026-01-01&endDate=2026-01-31` +
        '&customer=acme+corp&includeAttachments=true'
    );
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(KEY);
    expect(init.body).toBeUndefined();
  });

  it('leaves undefined and null filters out of the query string', async () => {
    respondWith({ posts: [] });

    await new Hookpost(KEY).postList({
      startDate: '2026-01-01',
      endDate: undefined,
      customer: null,
      includeAttachments: undefined,
    } as any);

    const [url] = onlyCall();
    expect(url).toBe(`${API}/public/v1/posts?startDate=2026-01-01`);
  });

  it('returns the parsed JSON', async () => {
    const payload = { posts: [{ id: 'post-1' }], total: 1 };
    respondWith(payload);

    const result = await new Hookpost(KEY).postList({} as any);

    expect(result).toEqual(payload);
  });
});

describe('upload', () => {
  it('POSTs a FormData body to /public/v1/upload with the API key', async () => {
    const json = respondWith({ url: 'https://cdn.example/file.png' });

    const result = await new Hookpost(KEY).upload(
      Buffer.from('png-bytes'),
      'png'
    );

    const [url, init] = onlyCall();
    expect(url).toBe(`${API}/public/v1/upload`);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(KEY);
    // multipart bodies get their boundary from node-fetch, not a set header.
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);
    expect(json).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ url: 'https://cdn.example/file.png' });
  });

  it('appends the buffer as a file field named "file" with the extension as its name', async () => {
    respondWith({});

    await new Hookpost(KEY).upload(Buffer.from('png-bytes'), 'png');

    const [, init] = onlyCall();
    const entries = (init.body as FormData & {
      entries: unknown[][];
    }).entries;
    expect(entries).toHaveLength(1);
    const [field, blob, filename] = entries[0];
    expect(field).toBe('file');
    expect(filename).toBe('png');
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe('image/png');
  });

  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    // Anything else falls through to image/jpeg.
    ['webp', 'image/jpeg'],
  ])('maps the %s extension to %s', async (extension, expectedType) => {
    respondWith({});

    await new Hookpost(KEY).upload(Buffer.from('bytes'), extension);

    const [, init] = onlyCall();
    const entries = (init.body as FormData & {
      entries: unknown[][];
    }).entries;
    expect((entries[0][1] as Blob).type).toBe(expectedType);
  });
});

describe('integrations', () => {
  it('GETs /public/v1/integrations with the API key and returns the parsed body', async () => {
    const json = respondWith({ integrations: ['twitter'] });

    const result = await new Hookpost(KEY).integrations();

    const [url, init] = onlyCall();
    expect(url).toBe(`${API}/public/v1/integrations`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(KEY);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(json).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ integrations: ['twitter'] });
  });
});

describe('deletePost', () => {
  it('DELETEs /public/v1/posts/:id with the API key', async () => {
    respondWith({});

    await new Hookpost(KEY).deletePost('post-42');

    const [url, init] = onlyCall();
    expect(url).toBe(`${API}/public/v1/posts/post-42`);
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe(KEY);
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('returns the response itself, without reading the body', async () => {
    const json = respondWith({});

    const response = await new Hookpost(KEY).deletePost('post-42');

    expect(response).toEqual({ json: expect.any(Function) });
    expect(json).not.toHaveBeenCalled();
  });
});

describe('base path', () => {
  const original = process.env.HOOKPOST_API_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.HOOKPOST_API_URL;
    } else {
      process.env.HOOKPOST_API_URL = original;
    }
  });

  it('uses the hosted API URL when neither the env var nor a path is set', async () => {
    delete process.env.HOOKPOST_API_URL;
    respondWith({});

    await new Hookpost(KEY).integrations();

    expect(onlyCall()[0]).toBe(`${API}/public/v1/integrations`);
  });

  it('reads HOOKPOST_API_URL when no path argument is given', async () => {
    process.env.HOOKPOST_API_URL = 'http://localhost:4000/api';
    respondWith({});

    await new Hookpost(KEY).integrations();

    expect(onlyCall()[0]).toBe(
      'http://localhost:4000/api/public/v1/integrations'
    );
  });

  it('prefers the path argument over HOOKPOST_API_URL', async () => {
    process.env.HOOKPOST_API_URL = 'http://from-env.example/api';
    respondWith({});

    await new Hookpost(KEY, 'http://from-arg.example/api').integrations();

    expect(onlyCall()[0]).toBe(
      'http://from-arg.example/api/public/v1/integrations'
    );
  });
});
