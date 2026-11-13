import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { DevToProvider } from '@hookpost/nestjs-libraries/integrations/social/dev.to.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { DevToSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/dev.to.settings.dto';

// this.fetch waits 5s between retries of a 429/500; nothing to wait for here.
jest.mock('@hookpost/helpers/utils/timer', () => ({
  timer: jest.fn(async () => undefined),
}));

type Reply = { status?: number; body: any; raw?: boolean };

// Replaces global fetch with a scripted dev.to. Every reply is a real
// Response, so `ok`, `status`, `json()` and `text()` behave like undici's.
// Error bodies are the shape dev.to really sends - checked live on
// 2026-10-20 with a deliberately invalid key:
//   GET /api/users/me, POST /api/articles -> 401 {"error":"unauthorized","status":401}
const setup = (replies: Reply[]) => {
  const calls: { url: string; method: string; headers: any; body: any }[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    const next = replies.shift();
    if (!next) {
      throw new Error(`unexpected call to ${url}`);
    }
    const { status = 200, body, raw } = next;
    return new Response(raw ? body : JSON.stringify(body), { status });
  });

  return {
    provider: new DevToProvider(),
    calls,
    restore: () => ((global as any).fetch = original),
  };
};

const code = (apiKey: string) =>
  Buffer.from(JSON.stringify({ apiKey })).toString('base64');

const post = (settings: any, message = 'Hello **dev.to**', media: any[] = []) =>
  [{ id: 'p1', message, settings, media }] as any;

const created = {
  status: 201,
  body: {
    type_of: 'article',
    id: 2049871,
    url: 'https://dev.to/janedoe/hello-devto-3k2a',
  },
};

describe('DevToProvider connect', () => {
  let restore = () => {};
  afterEach(() => restore());

  it('connects with a valid key and stores the trimmed key', async () => {
    const t = setup([
      {
        body: {
          type_of: 'user',
          id: 1234567,
          username: 'janedoe',
          name: 'Jane',
          profile_image: 'https://media2.dev.to/p.png',
        },
      },
    ]);
    restore = t.restore;

    const auth: any = await t.provider.authenticate({
      code: code('  abcDEF123key \n'),
      codeVerifier: '',
    });

    expect(t.calls[0].url).toBe('https://dev.to/api/users/me');
    expect(t.calls[0].headers['api-key']).toBe('abcDEF123key');
    expect(auth).toMatchObject({
      id: '1234567',
      name: 'Jane',
      username: 'janedoe',
      picture: 'https://media2.dev.to/p.png',
      accessToken: 'abcDEF123key',
      refreshToken: '',
    });
    expect(auth.expiresIn).toBeGreaterThan(60 * 60 * 24 * 365 * 50);
  });

  it('refuses a bad key with a message that says where to get a new one', async () => {
    const t = setup([
      { status: 401, body: { error: 'unauthorized', status: 401 } },
    ]);
    restore = t.restore;

    const auth = await t.provider.authenticate({
      code: code('not-a-real-key'),
      codeVerifier: '',
    });

    // used to come back as a token with an undefined id
    expect(typeof auth).toBe('string');
    expect(auth).toContain('dev.to/settings/extensions');
  });

  it('does not call a dev.to outage an invalid key', async () => {
    const t = setup([{ status: 503, body: '<html>busy</html>', raw: true }]);
    restore = t.restore;

    const auth = await t.provider.authenticate({
      code: code('abcDEF123key'),
      codeVerifier: '',
    });

    expect(auth).toBe(
      'Dev.to did not answer (HTTP 503), please try again in a minute.'
    );
  });

  it('refuses an empty or unreadable key without calling dev.to', async () => {
    const t = setup([]);
    restore = t.restore;

    expect(
      typeof (await t.provider.authenticate({
        code: code('   '),
        codeVerifier: '',
      }))
    ).toBe('string');
    expect(
      typeof (await t.provider.authenticate({ code: '%%%', codeVerifier: '' }))
    ).toBe('string');
    expect(t.calls).toHaveLength(0);
  });
});

describe('DevToProvider publishing', () => {
  let restore = () => {};
  const env = { ...process.env };
  afterEach(() => {
    restore();
    process.env = { ...env };
  });

  it('publishes a text-only article', async () => {
    const t = setup([created]);
    restore = t.restore;

    const [res] = await t.provider.post(
      '1234567',
      'abcDEF123key',
      post({ title: 'Hello dev.to', tags: [], organization: '' }),
      {} as any
    );

    expect(t.calls[0]).toMatchObject({
      url: 'https://dev.to/api/articles',
      method: 'POST',
      headers: { 'api-key': 'abcDEF123key' },
    });
    expect(t.calls[0].body).toEqual({
      article: {
        title: 'Hello dev.to',
        body_markdown: 'Hello **dev.to**',
        published: true,
      },
    });
    expect(res).toEqual({
      id: 'p1',
      status: 'completed',
      postId: '2049871',
      releaseURL: 'https://dev.to/janedoe/hello-devto-3k2a',
    });
  });

  it('puts attached images into the markdown and sends cover, tags, org and canonical', async () => {
    process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
    process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY = 'uploads/';
    const t = setup([created]);
    restore = t.restore;

    await t.provider.post(
      '1234567',
      'abcDEF123key',
      post(
        {
          title: 'With pictures',
          main_image: { id: 'm0', path: '2026/10/cover.png' },
          tags: [
            { value: 8, label: 'webdev' },
            { value: 307, label: 'ai' },
          ],
          organization: '2575',
          canonical: 'https://hookstep.in/blog/with-pictures',
        },
        'Body',
        [
          {
            type: 'image',
            path: 'https://media.hookstep.in/a b(1).png',
            alt: 'a [chart]',
          },
          { type: 'image', path: 'https://media.hookstep.in/b.jpg' },
        ]
      ),
      {} as any
    );

    expect(t.calls[0].body.article).toEqual({
      title: 'With pictures',
      body_markdown:
        'Body\n\n![a  chart](https://media.hookstep.in/a%20b%281%29.png)\n\n![](https://media.hookstep.in/b.jpg)',
      published: true,
      main_image: 'https://hookpost.hookstep.in/uploads/2026/10/cover.png',
      tags: ['webdev', 'ai'],
      organization_id: 2575,
      canonical_url: 'https://hookstep.in/blog/with-pictures',
    });
  });

  it('uses the public url of a locally stored image, not its disk path', async () => {
    const t = setup([created]);
    restore = t.restore;

    await t.provider.post(
      '1234567',
      'abcDEF123key',
      post({ title: 'Local' }, '', [
        {
          type: 'image',
          path: '/var/uploads/2026/x.png',
          url: 'https://hookpost.hookstep.in/uploads/2026/x.png',
        },
      ]),
      {} as any
    );

    expect(t.calls[0].body.article.body_markdown).toBe(
      '![](https://hookpost.hookstep.in/uploads/2026/x.png)'
    );
  });

  it('refuses a video before publishing instead of dropping it', async () => {
    const t = setup([]);
    restore = t.restore;

    expect(
      await t.provider.checkValidity(
        [[{ path: 'https://media.hookstep.in/clip.MP4?v=1' }]],
        {},
        []
      )
    ).toContain('cannot host video');
    expect(
      await t.provider.checkValidity(
        [[{ path: 'https://media.hookstep.in/a.png' }]],
        {},
        []
      )
    ).toBe(true);

    await expect(
      t.provider.post(
        '1234567',
        'abcDEF123key',
        post({ title: 'Video' }, 'x', [
          { type: 'video', path: 'https://media.hookstep.in/clip.mp4' },
        ]),
        {} as any
      )
    ).rejects.toBeInstanceOf(BadBody);
    expect(t.calls).toHaveLength(0);
  });

  it('fails with dev.to’s own sentence on a validation error', async () => {
    const t = setup([
      {
        status: 422,
        body: {
          error: 'Title is too long (maximum is 128 characters for full_post)',
          status: 422,
        },
      },
    ]);
    restore = t.restore;

    const err = await t.provider
      .post('1', 'k', post({ title: 'x' }), {} as any)
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      'Title is too long (maximum is 128 characters for full_post)'
    );
  });

  it('explains a duplicate canonical url', async () => {
    const t = setup([
      {
        status: 422,
        body: { error: 'Canonical url has already been taken', status: 422 },
      },
    ]);
    restore = t.restore;

    const err = await t.provider
      .post(
        '1',
        'k',
        post({ title: 'x', canonical: 'https://a.b/c' }),
        {} as any
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('canonical URL');
  });

  it('asks for a reconnect when the key was revoked', async () => {
    const t = setup([
      { status: 401, body: { error: 'unauthorized', status: 401 } },
    ]);
    restore = t.restore;

    const err = await t.provider
      .post('1', 'k', post({ title: 'x' }), {} as any)
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(RefreshToken);
    expect(err.message).toContain('reconnect the channel');
  });

  it('retries a rate limit and then reports it', async () => {
    const limited = {
      status: 429,
      body: {
        error: 'Rate limit reached, try again in 300 seconds',
        status: 429,
      },
    };
    const t = setup([limited, limited, limited, limited]);
    restore = t.restore;

    const err = await t.provider
      .post('1', 'k', post({ title: 'x' }), {} as any)
      .catch((e: any) => e);

    expect(t.calls).toHaveLength(4);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe('Rate limit reached, try again in 300 seconds');
  });

  it('keeps a created article as published even if its body is unreadable', async () => {
    const t = setup([{ status: 201, body: 'not json', raw: true }]);
    restore = t.restore;

    const [res] = await t.provider.post(
      '1',
      'k',
      post({ title: 'x' }),
      {} as any
    );

    expect(res.status).toBe('completed');
  });
});

describe('DevToProvider settings helpers', () => {
  let restore = () => {};
  afterEach(() => restore());

  it('returns no tags or organizations instead of throwing on an error', async () => {
    const t = setup([
      { status: 503, body: 'down', raw: true },
      { status: 401, body: { error: 'unauthorized', status: 401 } },
    ]);
    restore = t.restore;

    expect(await t.provider.tags('k')).toEqual([]);
    expect(await t.provider.organizations('k')).toEqual([]);
  });

  it('lists the organizations the user has published under', async () => {
    const t = setup([
      {
        body: [
          { id: 1, organization: { username: 'github' } },
          { id: 2, organization: { username: 'github' } },
          { id: 3 },
        ],
      },
      { body: { id: 2575, name: 'GitHub', username: 'github' } },
    ]);
    restore = t.restore;

    expect(await t.provider.organizations('k')).toEqual([
      { id: 2575, name: 'GitHub', username: 'github' },
    ]);
    expect(t.calls[1].url).toBe('https://dev.to/api/organizations/github');
  });
});

describe('DevToSettingsDto title', () => {
  const errors = async (title: string) =>
    validate(plainToInstance(DevToSettingsDto, { title, tags: [] }));

  it('allows 128 characters, not counting spaces', async () => {
    expect(await errors('a'.repeat(128))).toHaveLength(0);
    expect(await errors(`${'ab '.repeat(64)}`)).toHaveLength(0);
  });

  it('refuses a title dev.to would reject at publish time', async () => {
    const [err] = await errors('a'.repeat(129));
    expect(Object.values(err.constraints || {})[0]).toContain('128');
  });
});
