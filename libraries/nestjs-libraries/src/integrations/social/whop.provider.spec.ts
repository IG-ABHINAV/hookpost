import 'reflect-metadata';
import { createHash } from 'crypto';

// The provider reaches Whop two ways - plain fetch for auth and the list
// endpoints, SocialAbstract's retrying fetch for posts and file records.
// Both go through the same global, so one scripted Whop covers every call
// the provider makes and nothing leaves the process.
jest.mock('@hookpost/helpers/utils/timer', () => ({
  timer: () => Promise.resolve(),
}));

import { WhopProvider } from '@hookpost/nestjs-libraries/integrations/social/whop.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

type Reply = { status?: number; body: any; headers?: Record<string, string> };

type Call = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
  init: any;
};

const MEDIA = 'https://media.hookstep.in/photo.jpg';
const UPLOAD = 'https://files.whop.com/upload/file-1';

const toResponse = (reply: Reply) => {
  const status = reply.status ?? 200;
  const text =
    typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(reply.headers || {}),
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (key: string) => headers[String(key).toLowerCase()] ?? null,
    },
    text: async () => text,
    json: async () => JSON.parse(text),
    // the media download hands this straight to the upload PUT as its body
    body: Buffer.from('media-bytes'),
  };
};

// A small Whop: OAuth, the company/forum lists, forum posts and the file
// upload handshake. Routes are keyed by URL (longest prefix wins), and any
// call the provider makes that is not scripted throws, which is how a real
// network call would show up in a test run.
const fakeWhop = (overrides: Record<string, (call: Call) => Reply> = {}) => {
  const calls: Call[] = [];
  const posts: any[] = [];
  const fileRecords: any[] = [];
  const original = global.fetch;
  let polls = 0;

  const routes: Record<string, (call: Call) => Reply> = {
    'https://api.whop.com/oauth/token': () => ({
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 1800,
      },
    }),
    'https://api.whop.com/oauth/userinfo': () => ({
      body: {
        sub: 'user-1',
        name: 'Wendy',
        preferred_username: 'wendy',
        picture: 'https://cdn.whop.com/avatar.png',
      },
    }),
    'https://api.whop.com/api/v1/companies': () => ({
      body: {
        data: [{ id: 'c1', title: 'Acme' }, { id: 'c2', title: 'Beta Club' }],
      },
    }),
    'https://api.whop.com/api/v1/forums': () => ({
      body: {
        data: [
          { id: 'f1', experience: { id: 'e1', name: 'Launch' } },
          // a forum Whop answers without an experience object
          { id: 'f2' },
        ],
      },
    }),
    'https://api.whop.com/api/v1/forum_posts': (call) => {
      posts.push(call.body);
      return { body: { id: 'fp-1' } };
    },
    'https://api.whop.com/api/v1/files': (call) => {
      fileRecords.push(call.body);
      return {
        body: {
          id: 'file-1',
          upload_url: UPLOAD,
          upload_headers: { 'x-amz-meta': 'hookpost' },
        },
      };
    },
    'https://api.whop.com/api/v1/files/file-1': () => ({
      body: { upload_status: polls++ === 0 ? 'pending' : 'ready' },
    }),
    [MEDIA]: (call) =>
      call.method === 'HEAD'
        ? { body: null, headers: { 'content-length': '2048' } }
        : { body: 'media-bytes' },
    [UPLOAD]: () => ({ body: '' }),
    ...overrides,
  };

  (global as any).fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    let body: any = init.body;
    if (typeof body === 'string' && body.trimStart().startsWith('{')) {
      body = JSON.parse(body);
    }
    const call: Call = { method, url, headers: init.headers || {}, body, init };
    calls.push(call);
    const exact = routes[url];
    const prefix = Object.keys(routes)
      .filter((key) => url.startsWith(key))
      .sort((a, b) => b.length - a.length)[0];
    const route = exact ?? (prefix ? routes[prefix] : undefined);
    if (!route) {
      throw new Error(`unexpected fetch ${method} ${url}`);
    }
    return toResponse(route(call));
  });

  return {
    calls,
    posts,
    fileRecords,
    find: (needle: string) =>
      calls.filter((c) => `${c.method} ${c.url}`.includes(needle)),
    restore: () => ((global as any).fetch = original),
  };
};

const details = (overrides: any = {}): any => ({
  id: 'post-1',
  message: 'Hello Whop',
  settings: { experience: 'e9', ...(overrides.settings || {}) },
  media: overrides.media || [],
});

const postWith = (provider: WhopProvider, post: any) =>
  provider.post('user-1', 'access-1', [post], {} as any);

beforeAll(() => {
  process.env.WHOP_CLIENT_ID = 'whop-client';
  process.env.FRONTEND_URL = 'https://hookpost.hookstep.in';
});

describe('WhopProvider', () => {
  let net: ReturnType<typeof fakeWhop> | undefined;
  afterEach(() => net?.restore());

  describe('generateAuthUrl', () => {
    it('builds an S256 PKCE challenge from the code verifier it returns', async () => {
      const { url, codeVerifier, state } = await new WhopProvider().generateAuthUrl();

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        'https://api.whop.com/oauth/authorize'
      );
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('client_id')).toBe('whop-client');
      expect(parsed.searchParams.get('redirect_uri')).toBe(
        'https://hookpost.hookstep.in/integrations/social/whop'
      );
      expect(parsed.searchParams.get('scope')).toBe(
        'openid profile email forum:post:create forum:read company:basic:read'
      );
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')).toBe(
        createHash('sha256').update(codeVerifier).digest('base64url')
      );
      expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('nonce')).toHaveLength(16);
    });
  });

  describe('authenticate', () => {
    it('exchanges the code and reads the profile with the new token', async () => {
      net = fakeWhop();

      const auth: any = await new WhopProvider().authenticate({
        code: 'code-1',
        codeVerifier: 'verifier-1',
      });

      expect(auth).toEqual({
        id: 'user-1',
        name: 'Wendy',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
        picture: 'https://cdn.whop.com/avatar.png',
        username: 'wendy',
      });
      const [token, info] = net.calls;
      expect(token.url).toBe('https://api.whop.com/oauth/token');
      expect(token.method).toBe('POST');
      expect(token.body).toEqual({
        grant_type: 'authorization_code',
        code: 'code-1',
        redirect_uri: 'https://hookpost.hookstep.in/integrations/social/whop',
        client_id: 'whop-client',
        code_verifier: 'verifier-1',
      });
      expect(info.url).toBe('https://api.whop.com/oauth/userinfo');
      expect(info.headers.Authorization).toBe('Bearer access-1');
    });

    it('keeps the refresh round-trip on the redirect uri Whop will return to', async () => {
      net = fakeWhop();

      await new WhopProvider().authenticate({
        code: 'code-1',
        codeVerifier: 'verifier-1',
        refresh: 'yes',
      });

      expect(net.calls[0].body.redirect_uri).toBe(
        'https://hookpost.hookstep.in/integrations/social/whop?refresh=yes'
      );
    });

    it('falls back to the username and a one-hour expiry when Whop omits them', async () => {
      net = fakeWhop({
        'https://api.whop.com/oauth/token': () => ({ body: { access_token: 'a' } }),
        'https://api.whop.com/oauth/userinfo': () => ({
          body: { sub: 'user-2', preferred_username: 'wendy2' },
        }),
      });

      const auth: any = await new WhopProvider().authenticate({
        code: 'code-1',
        codeVerifier: 'v',
      });

      expect(auth).toMatchObject({
        id: 'user-2',
        name: 'wendy2',
        username: 'wendy2',
        picture: '',
        expiresIn: 3600,
      });
    });

    it('reports the OAuth error instead of calling userinfo', async () => {
      net = fakeWhop({
        'https://api.whop.com/oauth/token': () => ({
          body: { error: 'invalid_grant', error_description: 'Code expired' },
        }),
      });

      const res = await new WhopProvider().authenticate({
        code: 'code-1',
        codeVerifier: 'v',
      });

      expect(res).toBe('Authentication failed: Code expired');
      expect(net.calls).toHaveLength(1);
    });

    it('names the raw error when Whop sends no description', async () => {
      net = fakeWhop({
        'https://api.whop.com/oauth/token': () => ({
          body: { error: 'invalid_client' },
        }),
      });

      const res = await new WhopProvider().authenticate({
        code: 'code-1',
        codeVerifier: 'v',
      });

      expect(res).toBe('Authentication failed: invalid_client');
    });
  });

  describe('refreshToken', () => {
    it('posts the refresh grant and maps the new tokens onto the profile', async () => {
      net = fakeWhop();

      const auth: any = await new WhopProvider().refreshToken('old-refresh');

      expect(net.calls[0].url).toBe('https://api.whop.com/oauth/token');
      expect(net.calls[0].body).toEqual({
        grant_type: 'refresh_token',
        refresh_token: 'old-refresh',
        client_id: 'whop-client',
      });
      expect(net.calls[1].headers.Authorization).toBe('Bearer access-1');
      expect(auth).toEqual({
        id: 'user-1',
        name: 'Wendy',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 1800,
        picture: 'https://cdn.whop.com/avatar.png',
        username: 'wendy',
      });
    });

    it('assumes an hour when the token response has no expiry', async () => {
      net = fakeWhop({
        'https://api.whop.com/oauth/token': () => ({
          body: { access_token: 'a', refresh_token: 'r' },
        }),
      });

      const auth: any = await new WhopProvider().refreshToken('old-refresh');

      expect(auth.expiresIn).toBe(3600);
    });
  });

  describe('companies and experiences', () => {
    it('maps companies to the options the post settings list', async () => {
      net = fakeWhop();

      const companies = await new WhopProvider().companies(
        'access-1',
        {},
        'int-1'
      );

      expect(companies).toEqual([
        { id: 'c1', name: 'Acme' },
        { id: 'c2', name: 'Beta Club' },
      ]);
      const [list] = net.calls;
      expect(list.url).toBe('https://api.whop.com/api/v1/companies?first=50');
      expect(list.headers.Authorization).toBe('Bearer access-1');
    });

    it('lists the forums of a company, preferring the experience it embeds', async () => {
      net = fakeWhop();

      const forums = await new WhopProvider().experiences(
        'access-1',
        { id: 'c1' },
        'int-1'
      );

      expect(forums).toEqual([
        { id: 'e1', name: 'Launch' },
        // no experience object: the forum id is all there is to show
        { id: 'f2', name: 'f2' },
      ]);
      const [list] = net.calls;
      expect(list.url).toBe(
        'https://api.whop.com/api/v1/forums?company_id=c1&first=50'
      );
      expect(list.headers.Authorization).toBe('Bearer access-1');
    });

    it('returns no forums when no company was picked', async () => {
      net = fakeWhop();

      await expect(
        new WhopProvider().experiences('access-1', {}, 'int-1')
      ).resolves.toEqual([]);
      expect(net.calls).toHaveLength(0);
    });

    it('returns empty lists instead of failing the post when Whop is unreachable', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/companies': () => {
          throw new Error('fetch failed');
        },
        'https://api.whop.com/api/v1/forums': () => {
          throw new Error('fetch failed');
        },
      });

      await expect(
        new WhopProvider().companies('access-1', {}, 'int-1')
      ).resolves.toEqual([]);
      await expect(
        new WhopProvider().experiences('access-1', { id: 'c1' }, 'int-1')
      ).resolves.toEqual([]);
    });
  });

  describe('post', () => {
    it('creates the forum post and returns the published id', async () => {
      net = fakeWhop();

      const [res] = await postWith(
        new WhopProvider(),
        details({ settings: { experience: 'e9' } })
      );

      expect(res).toEqual({
        id: 'post-1',
        postId: 'fp-1',
        releaseURL: 'https://whop.com/experiences/e9/fp-1',
        status: 'success',
      });
      expect(net.posts).toEqual([{ experience_id: 'e9', content: 'Hello Whop' }]);
      const [post] = net.find('POST https://api.whop.com/api/v1/forum_posts');
      expect(post.headers.Authorization).toBe('Bearer access-1');
      expect(post.headers['Content-Type']).toBe('application/json');
      // no media: no file record and no upload
      expect(net.find('https://api.whop.com/api/v1/files')).toHaveLength(0);
    });

    it('sends the title only when one was written', async () => {
      net = fakeWhop();

      await postWith(
        new WhopProvider(),
        details({ settings: { experience: 'e9', title: 'Big news' } })
      );

      expect(net.posts[0]).toEqual({
        experience_id: 'e9',
        content: 'Hello Whop',
        title: 'Big news',
      });
    });

    it('asks for a reconnect when Whop no longer accepts the token', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/forum_posts': () => ({
          status: 401,
          body: { error: 'invalid_grant' },
        }),
      });

      const err: any = await postWith(new WhopProvider(), details())
        .catch((e) => e);

      expect(err).toBeInstanceOf(RefreshToken);
      expect(err.message).toBe('Invalid token, please re-authenticate');
    });

    it('names the missing permission when the scope was not granted', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/forum_posts': () => ({
          status: 403,
          body: { error: 'insufficient_scope' },
        }),
      });

      const err: any = await postWith(new WhopProvider(), details())
        .catch((e) => e);

      expect(err).toBeInstanceOf(RefreshToken);
      expect(err.message).toBe(
        'Insufficient permissions, please re-authenticate with required scopes'
      );
    });

    it('surfaces Whop\'s complaint about the request body', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/forum_posts': () => ({
          status: 400,
          body: { error: 'invalid_request', error_description: 'content required' },
        }),
      });

      const err: any = await postWith(new WhopProvider(), details())
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toBe('Invalid request parameters');
    });

    it('says the forum or experience is gone when Whop 404s the post', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/forum_posts': () => ({
          status: 404,
          body: { error: 'not_found' },
        }),
      });

      const err: any = await postWith(new WhopProvider(), details())
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toBe('Forum or experience not found');
      expect(net.find('https://api.whop.com/api/v1/files')).toHaveLength(0);
    });
  });

  describe('comment', () => {
    it('replies under the newest comment when there is one', async () => {
      net = fakeWhop();

      const [res] = await new WhopProvider().comment(
        'user-1',
        'fp-0',
        'fp-9',
        'access-1',
        [details()],
        {} as any
      );

      expect(net.posts[0]).toEqual({
        experience_id: 'e9',
        content: 'Hello Whop',
        parent_id: 'fp-9',
      });
      expect(res.postId).toBe('fp-1');
      // the release url keeps pointing at the post being replied to
      expect(res.releaseURL).toBe('https://whop.com/experiences/e9/fp-0');
      expect(res.status).toBe('success');
    });

    it('threads a first reply under the post itself', async () => {
      net = fakeWhop();

      await new WhopProvider().comment(
        'user-1',
        'fp-0',
        undefined,
        'access-1',
        [details()],
        {} as any
      );

      expect(net.posts[0].parent_id).toBe('fp-0');
    });
  });

  describe('media upload', () => {
    it('sizes the file, uploads it and attaches it to the post', async () => {
      net = fakeWhop();

      const [res] = await postWith(
        new WhopProvider(),
        details({ media: [{ path: MEDIA, alt: 'cover' }] })
      );

      expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
        `HEAD ${MEDIA}`,
        'POST https://api.whop.com/api/v1/files',
        `GET ${MEDIA}`,
        `PUT ${UPLOAD}`,
        // first poll still pending, second says ready
        'GET https://api.whop.com/api/v1/files/file-1',
        'GET https://api.whop.com/api/v1/files/file-1',
        'POST https://api.whop.com/api/v1/forum_posts',
      ]);
      expect(net.fileRecords).toEqual([{ filename: 'photo.jpg' }]);
      const put = net.calls.find((c) => c.method === 'PUT')!;
      expect(put.init.headers['Content-Length']).toBe('2048');
      expect(put.init.headers['x-amz-meta']).toBe('hookpost');
      expect(net.posts[0]).toEqual({
        experience_id: 'e9',
        content: 'Hello Whop',
        attachments: [{ id: 'file-1' }],
      });
      expect(res.postId).toBe('fp-1');
    });

    it('fails before creating a file record when the size is unknown', async () => {
      net = fakeWhop({
        [MEDIA]: () => ({ body: null, headers: {} }),
      });

      const err: any = await postWith(
        new WhopProvider(),
        details({ media: [{ path: MEDIA }] })
      ).catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toBe(
        'Could not determine the media size for upload'
      );
      expect(net.find('POST https://api.whop.com/api/v1/files')).toHaveLength(0);
      expect(net.find('https://api.whop.com/api/v1/forum_posts')).toHaveLength(0);
    });

    it('fails the post when Whop rejects the upload', async () => {
      net = fakeWhop({
        [UPLOAD]: () => ({ status: 500, body: 'nope' }),
      });

      const err: any = await postWith(
        new WhopProvider(),
        details({ media: [{ path: MEDIA }] })
      ).catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toBe('Failed to upload the media file');
      expect(net.find('https://api.whop.com/api/v1/forum_posts')).toHaveLength(0);
    });

    it('stops when Whop reports the upload failed', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/files/file-1': () => ({
          body: { upload_status: 'failed' },
        }),
      });

      await expect(
        postWith(
          new WhopProvider(),
          details({ media: [{ path: MEDIA }] })
        )
      ).rejects.toThrow('File upload failed');
    });

    it('attaches a file record Whop created without an upload url', async () => {
      net = fakeWhop({
        'https://api.whop.com/api/v1/files': () => ({ body: { id: 'file-9' } }),
      });

      await postWith(
        new WhopProvider(),
        details({ media: [{ path: MEDIA }] })
      );

      expect(net.posts[0].attachments).toEqual([{ id: 'file-9' }]);
      expect(net.find(`GET ${MEDIA}`)).toHaveLength(0);
      expect(net.find('PUT')).toHaveLength(0);
    });
  });

  describe('handleErrors', () => {
    const provider = new WhopProvider();

    it('maps Whop\'s error codes onto the right failure type', () => {
      expect(provider.handleErrors('{"error":"invalid_grant"}')).toEqual({
        type: 'refresh-token',
        value: 'Invalid token, please re-authenticate',
      });
      expect(provider.handleErrors('{"error":"insufficient_scope"}')).toEqual({
        type: 'refresh-token',
        value:
          'Insufficient permissions, please re-authenticate with required scopes',
      });
      expect(provider.handleErrors('{"error":"invalid_request"}')).toEqual({
        type: 'bad-body',
        value: 'Invalid request parameters',
      });
      expect(provider.handleErrors('{"error":"not_found"}')).toEqual({
        type: 'bad-body',
        value: 'Forum or experience not found',
      });
      expect(provider.handleErrors('{"error":"server_wobble"}')).toBeUndefined();
    });
  });

  describe('maxLength', () => {
    it('allows a long markdown post on a forum', () => {
      expect(new WhopProvider().maxLength()).toBe(50000);
    });
  });
});
