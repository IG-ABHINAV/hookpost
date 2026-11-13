import 'reflect-metadata';
import { MeweProvider } from '@hookpost/nestjs-libraries/integrations/social/mewe.provider';

// The provider talks to MeWe with plain global fetch (no axios, no SSRF
// dispatcher), so the network is replaced here with a scripted MeWe: every
// call is matched by "METHOD /path" and answered from `replies` in order.
// Nothing leaves the process.

type Reply = { status?: number; body?: any; raw?: string };
type Call = { url: string; method: string; headers: any; body: any };

const setup = (replies: Record<string, Reply[]>) => {
  const calls: Call[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    const { pathname } = new URL(url);
    calls.push({ url, method, headers: init.headers || {}, body: init.body });
    const next = replies[`${method} ${pathname}`]?.shift();
    if (!next) {
      throw new Error(`unexpected call ${method} ${pathname}`);
    }
    const status = next.status ?? 200;
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    // 204 (MeWe's usual answer to a post) cannot carry a body.
    return new Response(status === 204 ? null : text, { status });
  });

  return {
    provider: new MeweProvider(),
    calls,
    restore: () => ((global as any).fetch = original),
  };
};

const caught = async (promise: Promise<any>) => {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
};

const postDetails = (
  settings: any,
  message = 'Hello from Hookpost',
  media: any[] = []
) => [{ id: 'p1', message, settings, media }] as any;

const integration = (extra: any = {}) =>
  ({ id: 'int1', profile: 'alice', ...extra } as any);

const originalFetch = global.fetch;

afterEach(() => {
  (global as any).fetch = originalFetch;
});

const HOST = 'https://mewe.com';
const APP_ID = 'app-123';
const API_KEY = 'key-456';
const TOKEN = 'api-token-1';

const env = { ...process.env };

beforeAll(() => {
  process.env.JWT_SECRET = 'mewe-spec-secret';
});

beforeEach(() => {
  process.env.MEWE_APP_ID = APP_ID;
  process.env.MEWE_API_KEY = API_KEY;
  process.env.FRONTEND_URL = 'https://hookpost.example.com';
  delete process.env.MEWE_HOST;
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  process.env = { ...env };
  jest.restoreAllMocks();
});

describe('MeweProvider identity', () => {
  it('registers as MeWe with no scopes and the composer length', () => {
    const p = new MeweProvider();
    expect(p.identifier).toBe('mewe');
    expect(p.name).toBe('MeWe');
    expect(p.scopes).toEqual([]);
    expect(p.isBetweenSteps).toBe(false);
    expect(p.editor).toBe('normal');
    expect(p.maxLength()).toBe(63206);
    expect(p.dto).toBeDefined();
  });
});

describe('MeweProvider generateAuthUrl', () => {
  it('points the login screen back at the MeWe connect route', async () => {
    const res = await new MeweProvider().generateAuthUrl();

    expect(res.url).toBe(
      `${HOST}/login?client_id=${APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          'https://hookpost.example.com/integrations/social/mewe'
        )}&state=${res.state}`
    );
    expect(res.state).toMatch(/^[A-Za-z0-9]{6}$/);
    expect(res.codeVerifier).toMatch(/^[A-Za-z0-9]{10}$/);
    // state and verifier are per-request, not constants
    const second = await new MeweProvider().generateAuthUrl();
    expect(second.state).not.toBe(res.state);
    expect(second.codeVerifier).not.toBe(res.codeVerifier);
  });

  it('follows MEWE_HOST when the deployment is not on mewe.com', async () => {
    process.env.MEWE_HOST = 'https://mewe.internal.example';
    const res = await new MeweProvider().generateAuthUrl();
    expect(res.url.startsWith('https://mewe.internal.example/login?')).toBe(
      true
    );
  });
});

describe('MeweProvider refreshToken', () => {
  it('returns an empty token: MeWe issues long-lived tokens, no refresh', async () => {
    expect(await new MeweProvider().refreshToken('anything')).toEqual({
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    });
  });
});

describe('MeweProvider handleErrors', () => {
  const p = new MeweProvider();

  it('classifies the bodies MeWe answers with', () => {
    expect(p.handleErrors('{"error":"Unauthorized"}')).toEqual({
      type: 'refresh-token',
      value: 'Access token expired, please re-authenticate',
    });
    expect(p.handleErrors('Enhance Your Calm')).toEqual({
      type: 'retry',
      value: 'Rate limited, retrying...',
    });
    expect(p.handleErrors('{"code":420}')).toEqual({
      type: 'retry',
      value: 'Rate limited, retrying...',
    });
    expect(p.handleErrors('Forbidden')).toEqual({
      type: 'bad-body',
      value: 'Insufficient permissions for this action',
    });
    expect(p.handleErrors('{"ok":true}')).toBeUndefined();
  });

  it('asks for a re-authentication before anything else', () => {
    // an expired token can arrive inside a body that also mentions 420
    expect(p.handleErrors('Unauthorized and 420 and Forbidden')?.type).toBe(
      'refresh-token'
    );
  });
});

describe('MeweProvider authenticate', () => {
  it('exchanges the login request token and reads the profile', async () => {
    const expiresAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const t = setup({
      'GET /api/dev/token': [{ body: { apiToken: TOKEN, expiresAt } }],
      'GET /api/dev/me': [
        { body: { userId: 'u-1', name: 'Alice', handle: 'alice' } },
      ],
    });

    const auth: any = await t.provider.authenticate({
      code: 'login-request-token',
      codeVerifier: 'verifier',
    });

    expect(auth).toMatchObject({
      id: 'u-1',
      name: 'Alice',
      accessToken: TOKEN,
      refreshToken: '',
      username: 'alice',
      picture: '',
    });
    // ~10 days from the expiresAt MeWe returned, not a fixed constant
    expect(auth.expiresIn).toBeGreaterThan(10 * 86400 - 60);
    expect(auth.expiresIn).toBeLessThanOrEqual(10 * 86400);

    const [token, me] = t.calls;
    expect(token.url).toBe(
      `${HOST}/api/dev/token?loginRequestToken=login-request-token`
    );
    expect(token.method).toBe('GET');
    // the exchange is identified by the app credentials, not a user token
    expect(token.headers).toEqual({
      'X-App-Id': APP_ID,
      'X-Api-Key': API_KEY,
    });
    expect(me.url).toBe(`${HOST}/api/dev/me`);
    expect(me.headers).toMatchObject({
      'X-App-Id': APP_ID,
      'X-Api-Key': API_KEY,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
  });

  it('builds the name from first/last when there is no display name', async () => {
    const t = setup({
      'GET /api/dev/token': [{ body: { apiToken: TOKEN } }],
      'GET /api/dev/me': [
        { body: { userId: 'u-2', firstName: 'Jane', lastName: 'Doe' } },
      ],
    });

    const auth: any = await t.provider.authenticate({
      code: 't',
      codeVerifier: '',
    });

    expect(auth.name).toBe('Jane Doe');
    expect(auth.username).toBe('');
    // no expiresAt: MeWe's own 30-day default, not "expires in 0"
    expect(auth.expiresIn).toBeGreaterThan(29 * 86400);
    expect(auth.expiresIn).toBeLessThanOrEqual(30 * 86400);
    expect(t.calls).toHaveLength(2);
  });

  it('asks for the login request token when the redirect carried none', async () => {
    const t = setup({});
    expect(
      await t.provider.authenticate({ code: '', codeVerifier: '' })
    ).toBe('No login request token received. Please try again.');
    expect(t.calls).toHaveLength(0);
  });

  it('reports a rejected exchange without reading a profile', async () => {
    const t = setup({
      'GET /api/dev/token': [
        { status: 401, body: { error: 'Unauthorized' } },
      ],
    });
    expect(
      await t.provider.authenticate({ code: 'bad', codeVerifier: '' })
    ).toBe('Failed to exchange token. Please try again.');
    expect(t.calls).toHaveLength(1);
  });

  it('waits when the approval has not been tapped on MeWe yet', async () => {
    const t = setup({
      'GET /api/dev/token': [{ body: { pending: true } }],
    });
    expect(
      await t.provider.authenticate({ code: 'pending', codeVerifier: '' })
    ).toBe('Login request is still pending. Please approve on MeWe and try again.');
    expect(t.calls).toHaveLength(1);
  });

  it('says so when the exchange answers without a token', async () => {
    const t = setup({
      'GET /api/dev/token': [{ body: { ok: true } }],
    });
    expect(
      await t.provider.authenticate({ code: 'x', codeVerifier: '' })
    ).toBe('No API token received. Please try again.');
  });

  it('does not connect when the profile read fails', async () => {
    const t = setup({
      'GET /api/dev/token': [{ body: { apiToken: TOKEN } }],
      'GET /api/dev/me': [{ status: 500, raw: '<html>busy</html>' }],
    });
    expect(
      await t.provider.authenticate({ code: 'x', codeVerifier: '' })
    ).toBe('Failed to fetch MeWe profile.');
    expect(t.calls).toHaveLength(2);
  });

  it('turns a network failure into a message instead of a crash', async () => {
    const t = setup({});
    (global as any).fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('fetch failed'));

    expect(
      await t.provider.authenticate({ code: 'x', codeVerifier: '' })
    ).toBe('MeWe authentication failed. Please try again.');
    expect(console.log).toHaveBeenCalled();
    t.restore();
  });
});

describe('MeweProvider groups', () => {
  const groups = (list: any[], nextPage?: string) => ({
    body: { groups: list, ...(nextPage ? { nextPage } : {}) },
  });

  it('maps MeWe groups to the selectable list', async () => {
    const t = setup({
      'GET /api/dev/groups': [
        groups([
          { groupId: 42, name: 'Hookpost users' },
          { groupId: '77', name: 'Second group' },
        ]),
      ],
    });

    const list = await t.provider.groups(
      TOKEN,
      {},
      'int1',
      integration()
    );

    expect(list).toEqual([
      { id: '42', name: 'Hookpost users' },
      { id: '77', name: 'Second group' },
    ]);
    const [first] = t.calls;
    expect(first.url).toBe(`${HOST}/api/dev/groups`);
    expect(first.headers).toMatchObject({
      'X-App-Id': APP_ID,
      'X-Api-Key': API_KEY,
      Authorization: `Bearer ${TOKEN}`,
    });
  });

  it('follows nextPage until MeWe stops handing more over', async () => {
    const t = setup({
      'GET /api/dev/groups': [
        groups([{ groupId: 1, name: 'One' }], '/api/dev/groups?page=2'),
        groups([{ groupId: 2, name: 'Two' }], '/api/dev/groups?page=3'),
        groups([{ groupId: 3, name: 'Three' }]),
      ],
    });

    const list = await t.provider.groups(
      TOKEN,
      {},
      'int1',
      integration()
    );

    expect(list.map((g: any) => g.id)).toEqual(['1', '2', '3']);
    expect(t.calls.map((c) => c.url)).toEqual([
      `${HOST}/api/dev/groups`,
      `${HOST}/api/dev/groups?page=2`,
      `${HOST}/api/dev/groups?page=3`,
    ]);
  });

  it('keeps the groups it already has when a later page fails', async () => {
    const t = setup({
      'GET /api/dev/groups': [
        groups([{ groupId: 1, name: 'One' }], '/api/dev/groups?page=2'),
        { status: 500, raw: '<html>oops</html>' },
      ],
    });

    expect(
      await t.provider.groups(TOKEN, {}, 'int1', integration())
    ).toEqual([{ id: '1', name: 'One' }]);
    expect(t.calls).toHaveLength(2);
  });

  it('returns an empty list when the first page is refused', async () => {
    const t = setup({
      'GET /api/dev/groups': [{ status: 401, body: { error: 'Unauthorized' } }],
    });
    expect(
      await t.provider.groups(TOKEN, {}, 'int1', integration())
    ).toEqual([]);
  });

  it('returns an empty list when MeWe is unreachable', async () => {
    const t = setup({});
    expect(
      await t.provider.groups(TOKEN, {}, 'int1', integration())
    ).toEqual([]);
    // one attempt, then it gives up instead of throwing at the caller
    expect(t.calls).toHaveLength(1);
  });

  it('survives a page that carries no groups key', async () => {
    const t = setup({
      'GET /api/dev/groups': [{ body: {} }],
    });
    expect(
      await t.provider.groups(TOKEN, {}, 'int1', integration())
    ).toEqual([]);
  });
});

describe('MeweProvider publishing', () => {
  it('posts to a group and links to that group', async () => {
    const t = setup({
      'POST /api/dev/group/42/post': [{ status: 204 }],
    });

    const [res] = await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ postType: 'group', group: '42' }, 'Hello group'),
      integration()
    );

    const [call] = t.calls;
    expect(call.url).toBe(`${HOST}/api/dev/group/42/post`);
    expect(call.method).toBe('POST');
    expect(call.headers).toMatchObject({
      'X-App-Id': APP_ID,
      'X-Api-Key': API_KEY,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(call.body)).toEqual({ text: 'Hello group' });
    expect(res).toEqual({
      id: 'p1',
      postId: expect.stringMatching(/^[A-Za-z0-9]{12}$/),
      releaseURL: 'https://mewe.com/group/42',
      status: 'success',
    });
  });

  it('treats a missing postType as a group post, the composer default', async () => {
    const t = setup({
      'POST /api/dev/group/9/post': [{ status: 204 }],
    });

    await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ group: '9' }),
      integration()
    );

    expect(t.calls[0].url).toBe(`${HOST}/api/dev/group/9/post`);
  });

  it('posts to the timeline and links to the profile timeline', async () => {
    const t = setup({
      'POST /api/dev/me/post': [{ status: 204 }],
    });

    const [res] = await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ postType: 'timeline' }, 'Hello timeline'),
      integration({ profile: 'jane' })
    );

    const [call] = t.calls;
    expect(call.url).toBe(`${HOST}/api/dev/me/post`);
    expect(JSON.parse(call.body)).toEqual({ text: 'Hello timeline' });
    expect(res.releaseURL).toBe('https://mewe.com/jane/posts');
    expect(res.status).toBe('success');
  });

  it('uploads a photo first and sends its id with the group post', async () => {
    const t = setup({
      'GET /photo.jpg': [{ raw: 'jpeg-bytes' }],
      'POST /api/dev/photo/upload': [{ body: { id: 'photo-1' } }],
      'POST /api/dev/group/42/post': [{ status: 204 }],
    });

    const [res] = await t.provider.post(
      'int1',
      TOKEN,
      postDetails(
        { postType: 'group', group: '42' },
        'With a photo',
        [{ path: 'https://media.hookstep.in/photo.jpg', alt: 'A red square' }]
      ),
      integration()
    );

    expect(t.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /photo.jpg',
      'POST /api/dev/photo/upload',
      'POST /api/dev/group/42/post',
    ]);

    const [, upload, post] = t.calls;
    expect(upload.headers).toMatchObject({
      'X-App-Id': APP_ID,
      'X-Api-Key': API_KEY,
      Authorization: `Bearer ${TOKEN}`,
    });
    // multipart: the form sets its own boundary, so no JSON content type
    expect(upload.headers['Content-Type']).toBeUndefined();
    expect(upload.body).toBeInstanceOf(FormData);
    const file = (upload.body as FormData).get('file') as File;
    expect(file.name).toBe('photo.jpg');
    expect(file.size).toBeGreaterThan(0);

    expect(JSON.parse(post.body)).toEqual({
      text: 'With a photo',
      uploadedPhotoIds: ['photo-1'],
    });
    expect(res.id).toBe('p1');
    expect(res.status).toBe('success');
  });

  it('uploads every image and leaves the video out of the post', async () => {
    const t = setup({
      'GET /a.png': [{ raw: 'png' }],
      'POST /api/dev/photo/upload': [
        { body: { id: 'photo-a' } },
        { body: { id: 'photo-b' } },
      ],
      'GET /b.jpg': [{ raw: 'jpeg' }],
      'GET /clip.mp4': [{ raw: 'mp4' }],
      'POST /api/dev/me/post': [{ status: 204 }],
    });

    await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ postType: 'timeline' }, 'Two images and a video', [
        { path: 'https://media.hookstep.in/a.png' },
        { path: 'https://media.hookstep.in/clip.mp4' },
        { path: 'https://media.hookstep.in/b.jpg' },
      ]),
      integration()
    );

    const keys = t.calls.map(
      (c) => `${c.method} ${new URL(c.url).pathname}`
    );
    expect(keys).toEqual([
      'GET /a.png',
      'POST /api/dev/photo/upload',
      'GET /b.jpg',
      'POST /api/dev/photo/upload',
      'POST /api/dev/me/post',
    ]);
    expect(JSON.parse(t.calls[4].body)).toEqual({
      text: 'Two images and a video',
      uploadedPhotoIds: ['photo-a', 'photo-b'],
    });
  });

  it('sends no photo ids when the post has no media', async () => {
    const t = setup({
      'POST /api/dev/group/42/post': [{ status: 204 }],
    });

    await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ postType: 'group', group: '42' }, 'Bare'),
      integration()
    );

    expect(t.calls).toHaveLength(1);
    expect(JSON.parse(t.calls[0].body)).toEqual({ text: 'Bare' });
  });

  it('fails the post when the photo upload is rejected', async () => {
    const t = setup({
      'GET /photo.jpg': [{ raw: 'jpeg' }],
      'POST /api/dev/photo/upload': [
        { status: 401, body: { error: 'Unauthorized' } },
      ],
    });

    const err = await caught(
      t.provider.post(
        'int1',
        TOKEN,
        postDetails(
          { postType: 'timeline' },
          'x',
          [{ path: 'https://media.hookstep.in/photo.jpg' }]
        ),
        integration()
      )
    );

    expect(err.message).toMatch(/^Photo upload failed: /);
    expect(err.message).toContain('Unauthorized');
    // the post itself was never attempted
    expect(t.calls).toHaveLength(2);
  });

  it('maps MeWe refusals of the post itself to their messages', async () => {
    const cases: [string, string][] = [
      [
        'Unauthorized',
        'Access token expired, please re-authenticate',
      ],
      ['Enhance Your Calm', 'Rate limited, retrying...'],
      ['{"code":420}', 'Rate limited, retrying...'],
      ['Forbidden', 'Insufficient permissions for this action'],
      ['<html>502 Bad Gateway</html>', 'Failed to create MeWe post'],
    ];

    for (const [raw, message] of cases) {
      const t = setup({
        'POST /api/dev/group/42/post': [{ status: 400, raw }],
      });
      const err = await caught(
        t.provider.post(
          'int1',
          TOKEN,
          postDetails({ postType: 'group', group: '42' }),
          integration()
        )
      );
      expect(err.message).toBe(message);
      t.restore();
    }
  });

  it('accepts the 204 MeWe answers for a post that has no body', async () => {
    const t = setup({
      'POST /api/dev/me/post': [{ status: 204 }],
    });
    const [res] = await t.provider.post(
      'int1',
      TOKEN,
      postDetails({ postType: 'timeline' }),
      integration()
    );
    expect(res.postId).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(res.releaseURL).toBe('https://mewe.com/alice/posts');
  });
});
