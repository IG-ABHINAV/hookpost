import 'reflect-metadata';
import {
  LemmyProvider,
  lemmyOrigin,
} from '@hookpost/nestjs-libraries/integrations/social/lemmy.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { AuthService } from '@hookpost/helpers/auth/auth.service';

type Reply = { status?: number; body?: any; raw?: string };

// Replaces global fetch with a scripted Lemmy instance: each call is matched
// by "METHOD /path" and answered from `replies` in order. Nothing leaves the
// process. Bodies are the shapes Lemmy 0.19 returns, error bodies included
// (checked against lemmy.world and lemmy.ml on 20 Oct 2026).
const setup = (replies: Record<string, Reply[]>) => {
  const calls: { key: string; url: string; auth?: string; body: any }[] = [];
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const parsed = new URL(url);
    const key = `${init.method || 'GET'} ${parsed.pathname}`;
    calls.push({
      key,
      url,
      auth: init.headers?.Authorization,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const next = replies[key]?.shift();
    if (!next) {
      throw new Error(`unexpected call ${key}`);
    }
    const status = next.status ?? 200;
    const text = next.raw ?? JSON.stringify(next.body ?? {});
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: () => null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });

  return { provider: new LemmyProvider() as any, calls };
};

const original = global.fetch;
beforeAll(() => {
  process.env.JWT_SECRET = 'lemmy-spec-secret';
});
afterEach(() => {
  (global as any).fetch = original;
});

const code = (fields: Record<string, string>) =>
  Buffer.from(JSON.stringify(fields)).toString('base64');

const integration = (service = 'https://lemmy.world'): any => ({
  id: 'int-1',
  customInstanceDetails: AuthService.fixedEncryption(
    JSON.stringify({ service, identifier: 'alice', password: 'pw-1234567890' })
  ),
});

const me = {
  my_user: {
    local_user_view: {
      person: {
        id: 42,
        name: 'alice',
        display_name: 'Alice A',
        avatar: 'https://lemmy.world/pictrs/image/a.png',
      },
    },
  },
};

const community = (id: string, label: string, extra: any = {}) => ({
  value: { id, subreddit: label, title: 'Hello Lemmy', url: '', ...extra },
});

const postDetails = (opts: {
  communities?: any[];
  media?: any[];
  message?: string;
}): any[] => [
  {
    id: 'p1',
    message: opts.message ?? 'Body text',
    settings: {
      subreddit: opts.communities ?? [community('7', 'Technology (!technology@lemmy.world)')],
    },
    media: opts.media ?? [],
  },
];

const created = (id: number) => ({ body: { post_view: { post: { id } } } });

describe('LemmyProvider connect', () => {
  it('signs in once and reads the account from the token, with a trailing slash in the URL and an email login', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/user/login': [{ body: { jwt: 'jwt-1' } }],
      'GET /api/v3/site': [{ body: me }],
    });

    const auth = await provider.authenticate({
      code: code({
        service: 'https://lemmy.world/',
        identifier: 'alice@example.com',
        password: 'pw-1234567890',
      }),
      codeVerifier: '',
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://lemmy.world/api/v3/user/login',
      'https://lemmy.world/api/v3/site',
    ]);
    expect(calls[0].body).toEqual({
      username_or_email: 'alice@example.com',
      password: 'pw-1234567890',
    });
    expect(calls[1].auth).toBe('Bearer jwt-1');
    expect(auth).toMatchObject({
      id: '42@lemmy.world',
      accessToken: 'jwt-1',
      name: 'Alice A',
      username: 'alice@lemmy.world',
      picture: 'https://lemmy.world/pictrs/image/a.png',
    });
  });

  it('returns a clear message for a wrong password', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/user/login': [
        { status: 401, body: { error: 'incorrect_login' } },
      ],
    });

    const auth = await provider.authenticate({
      code: code({ service: 'https://lemmy.ml', identifier: 'x', password: 'y' }),
      codeVerifier: '',
    });

    expect(auth).toBe(
      'lemmy.ml did not accept that username and password. Check they belong to an account on lemmy.ml'
    );
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['rate_limit_error', 'limiting how often Hookpost can sign in'],
    ['missing_totp_token', 'two-factor authentication'],
    ['email_not_verified', 'Verify the account'],
    ['registration_application_is_pending', "haven't approved this account"],
  ])(
    'refuses %s with its own message instead of connecting a channel without a token',
    async (error, expected) => {
      // Lemmy answers these with HTTP 400, which the old code read as a
      // successful sign-in with jwt undefined; GET /user?username= is public,
      // so the channel was created with no usable token.
      const { provider, calls } = setup({
        'POST /api/v3/user/login': [{ status: 400, body: { error } }],
      });

      const auth = await provider.authenticate({
        code: code({ service: 'https://lemmy.world', identifier: 'alice', password: 'pw' }),
        codeVerifier: '',
      });

      expect(typeof auth).toBe('string');
      expect(auth).toContain(expected);
      expect(calls).toHaveLength(1);
    }
  );

  it('says the URL is not a Lemmy instance when the login path 404s', async () => {
    const { provider } = setup({
      'POST /api/v3/user/login': [{ status: 404, raw: '' }],
    });

    const auth = await provider.authenticate({
      code: code({ service: 'https://example.com', identifier: 'alice', password: 'pw' }),
      codeVerifier: '',
    });

    expect(auth).toContain('did not answer like a Lemmy instance (HTTP 404)');
  });

  it('keeps only the origin of the instance URL', () => {
    expect(lemmyOrigin(' https://lemmy.world/ ')).toBe('https://lemmy.world');
    expect(lemmyOrigin('https://lemmy.world/c/technology')).toBe('https://lemmy.world');
    expect(() => lemmyOrigin('ftp://lemmy.world')).toThrow();
  });

  it('accepts instances on long top-level domains in the connect form', async () => {
    const [service] = await new LemmyProvider().customFields();
    const parts = service.validation.split('/');
    const regex = new RegExp(parts.slice(1, -1).join('/'), parts.pop());
    expect(regex.test('https://startrek.website')).toBe(true);
    expect(regex.test('https://lemmy.world')).toBe(true);
    expect(regex.test('lemmy.world')).toBe(false);
  });
});

describe('LemmyProvider post', () => {
  it('publishes a text post with the saved token, without signing in again', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/post': [created(901)],
    });

    const [res] = await provider.post('42@lemmy.world', 'jwt-saved', postDetails({}), integration());

    expect(calls.map((c) => c.key)).toEqual(['POST /api/v3/post']);
    expect(calls[0].auth).toBe('Bearer jwt-saved');
    expect(calls[0].body).toEqual({
      community_id: 7,
      name: 'Hello Lemmy',
      body: 'Body text',
      nsfw: false,
    });
    expect(res).toEqual({
      id: 'p1',
      postId: '901',
      releaseURL: 'https://lemmy.world/post/901',
      status: 'published',
    });
  });

  it('makes the image the post itself when there is no link', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/post': [created(902)],
    });

    await provider.post(
      'id',
      'jwt-saved',
      postDetails({
        media: [{ type: 'image', path: 'https://media.hookstep.in/a.png', alt: 'A cat' }],
      }),
      integration()
    );

    expect(calls[0].body).toMatchObject({
      url: 'https://media.hookstep.in/a.png',
      alt_text: 'A cat',
    });
    expect(calls[0].body.custom_thumbnail).toBeUndefined();
  });

  it('uses the image as the thumbnail of a link post', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/post': [created(903)],
    });

    await provider.post(
      'id',
      'jwt-saved',
      postDetails({
        communities: [community('7', 'Tech', { url: 'example.com/article' })],
        media: [{ type: 'image', path: 'https://media.hookstep.in/a.png' }],
      }),
      integration()
    );

    expect(calls[0].body).toMatchObject({
      url: 'https://example.com/article',
      custom_thumbnail: 'https://media.hookstep.in/a.png',
    });
  });

  it('signs in again once when Lemmy rejects the saved token', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/post': [
        { status: 401, body: { error: 'incorrect_login' } },
        created(904),
      ],
      'POST /api/v3/user/login': [{ body: { jwt: 'jwt-new' } }],
    });

    const [res] = await provider.post('id', 'jwt-stale', postDetails({}), integration());

    expect(calls.map((c) => `${c.key} ${c.auth || ''}`.trim())).toEqual([
      'POST /api/v3/post Bearer jwt-stale',
      'POST /api/v3/user/login',
      'POST /api/v3/post Bearer jwt-new',
    ]);
    expect(res.postId).toBe('904');
  });

  it('asks for a reconnect when the saved password no longer works', async () => {
    const { provider } = setup({
      'POST /api/v3/post': [{ status: 401, body: { error: 'incorrect_login' } }],
      'POST /api/v3/user/login': [{ status: 401, body: { error: 'incorrect_login' } }],
    });

    const err = await provider
      .post('id', 'jwt-stale', postDetails({}), integration())
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(RefreshToken);
    expect(err.message).toBe(
      'Lemmy no longer accepts the saved password for this account. Reconnect the channel in Hookpost'
    );
  });

  it('turns a Lemmy refusal into a clear failure instead of a TypeError', async () => {
    const { provider } = setup({
      'POST /api/v3/post': [
        { status: 400, body: { error: 'only_mods_can_post_in_community' } },
      ],
    });

    const err = await provider
      .post('id', 'jwt', postDetails({}), integration())
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe('Only moderators can post in this community');
  });

  it('names an unknown Lemmy error code and keeps its reason', async () => {
    const { provider } = setup({
      'POST /api/v3/post': [
        {
          status: 400,
          body: { error: 'person_is_banned_from_site', message: 'spam' },
        },
      ],
    });

    const err = await provider
      .post('id', 'jwt', postDetails({}), integration())
      .catch((e: any) => e);

    expect(err.message).toBe('This account is banned on the Lemmy instance: spam');
    expect(provider.handleErrors('{"error":"couldnt_create_post"}', 400)).toEqual({
      type: 'bad-body',
      value: 'Lemmy refused it (couldnt create post)',
    });
  });

  it('reports a post live in one community as published, with a warning naming the one that refused', async () => {
    const replies = () => ({
      'POST /api/v3/post': [
        created(905),
        { status: 400, body: { error: 'banned_from_community' } },
      ],
    });
    const communities = [
      community('7', 'Technology (!technology@lemmy.world)'),
      community('8', 'Linux (!linux@lemmy.ml)'),
    ];

    const { provider } = setup(replies());
    const [pending] = await provider.postPending(
      'id',
      'jwt',
      postDetails({ communities }),
      integration()
    );

    expect(pending.status).toBe('pending');
    expect(pending.postId).toBe('905');

    const check = await provider.checkPostStatus('jwt', pending.pendingData, integration());
    expect(check.status).toBe('ready');
    const done = await provider.finalizePost('jwt', check.pendingData, integration());
    expect(done).toEqual({
      status: 'completed',
      postId: '905',
      releaseURL: 'https://lemmy.world/post/905',
      warning:
        "Linux (!linux@lemmy.ml) didn't take the post: This account is banned from the community",
    });

    // older workflows: no warning channel, still published, never failed
    const legacy = setup(replies());
    const [res] = await legacy.provider.post(
      'id',
      'jwt',
      postDetails({ communities }),
      integration()
    );
    expect(res).toMatchObject({ postId: '905', status: 'published' });
  });

  it('publishes straight away through postPending when every community takes it', async () => {
    const { provider } = setup({
      'POST /api/v3/post': [created(906), created(907)],
    });

    const [res] = await provider.postPending(
      'id',
      'jwt',
      postDetails({
        communities: [community('7', 'A'), community('8', 'B')],
      }),
      integration()
    );

    expect(res).toEqual({
      id: 'p1',
      postId: '906,907',
      releaseURL: 'https://lemmy.world/post/906,https://lemmy.world/post/907',
      status: 'published',
    });
  });

  it('fails the post when no community takes it', async () => {
    const { provider } = setup({
      'POST /api/v3/post': [
        { status: 400, body: { error: 'invalid_post_title' } },
        { status: 400, body: { error: 'invalid_post_title' } },
      ],
    });

    const err = await provider
      .postPending(
        'id',
        'jwt',
        postDetails({ communities: [community('7', 'A'), community('8', 'B')] }),
        integration()
      )
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      'Lemmy needs a post title of 3 to 200 characters on a single line'
    );
  });
});

describe('LemmyProvider media rules', () => {
  const provider = new LemmyProvider();

  it('takes one image on the post and images on comments', async () => {
    expect(await provider.checkValidity([[{ path: 'https://m/a.png' }]])).toBe(true);
    expect(
      await provider.checkValidity([[], [{ path: 'https://m/a.webp' }, { path: 'https://m/b.jpg' }]])
    ).toBe(true);
  });

  it('refuses a second image on the post', async () => {
    expect(
      await provider.checkValidity([[{ path: 'https://m/a.png' }, { path: 'https://m/b.png' }]])
    ).toBe('A Lemmy post takes one image');
  });

  it('refuses video, which Lemmy cannot upload', async () => {
    expect(await provider.checkValidity([[{ path: 'https://m/clip.mp4?x=1' }]])).toContain(
      "Lemmy doesn't take videos"
    );
  });
});

describe('LemmyProvider comment', () => {
  it('comments under every community post and carries images as markdown', async () => {
    const { provider, calls } = setup({
      'POST /api/v3/comment': [
        { body: { comment_view: { comment: { id: 11 } } } },
        { body: { comment_view: { comment: { id: 12 } } } },
      ],
    });

    const [res] = await provider.comment(
      'id',
      '905,906',
      undefined,
      'jwt',
      [
        {
          id: 'c1',
          message: 'More detail',
          settings: {},
          media: [{ type: 'image', path: 'https://media.hookstep.in/b.png', alt: 'Chart' }],
        },
      ],
      integration()
    );

    expect(calls.map((c) => c.body)).toEqual([
      { post_id: 905, content: 'More detail\n\n![Chart](https://media.hookstep.in/b.png)' },
      { post_id: 906, content: 'More detail\n\n![Chart](https://media.hookstep.in/b.png)' },
    ]);
    expect(res).toEqual({
      id: 'c1',
      postId: '11,12',
      releaseURL: 'https://lemmy.world/comment/11,https://lemmy.world/comment/12',
      status: 'published',
    });
  });

  it('fails a comment Lemmy refuses with its reason', async () => {
    const { provider } = setup({
      'POST /api/v3/comment': [{ status: 400, body: { error: 'locked' } }],
    });

    const err = await provider
      .comment('id', '905', undefined, 'jwt', [{ id: 'c1', message: 'x', settings: {} }], integration())
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe('The post is locked, so it takes no comments');
  });
});

describe('LemmyProvider community search', () => {
  it('encodes the query and labels each community with its handle', async () => {
    const { provider, calls } = setup({
      'GET /api/v3/search': [
        {
          body: {
            communities: [
              {
                community: {
                  id: 3,
                  name: 'technology',
                  title: 'Technology',
                  actor_id: 'https://lemmy.world/c/technology',
                },
              },
            ],
          },
        },
      ],
    });

    const res = await provider.subreddits('jwt', { word: 'a&b' }, 'id', integration());

    expect(calls[0].url).toBe(
      'https://lemmy.world/api/v3/search?type_=Communities&sort=Active&q=a%26b'
    );
    expect(calls[0].auth).toBe('Bearer jwt');
    expect(res).toEqual([
      {
        id: 3,
        name: 'Technology (!technology@lemmy.world)',
        title: 'Technology (!technology@lemmy.world)',
      },
    ]);
  });
});
