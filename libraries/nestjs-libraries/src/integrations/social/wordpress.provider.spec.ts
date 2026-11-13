import 'reflect-metadata';
import {
  WordpressProvider,
  decodeWordpressToken,
  normalizeWordpressDomain,
  wordpressFileName,
  wordpressUrl,
} from '@hookpost/nestjs-libraries/integrations/social/wordpress.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

// A fetch Response with the fields the provider reads. `url`/`redirected`
// are read-only getters on a real Response, so they are pinned per instance.
const res = (
  status: number,
  body: unknown,
  extra: {
    url?: string;
    redirected?: boolean;
    headers?: Record<string, string>;
  } = {}
) => {
  const response = new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: extra.headers }
  );
  Object.defineProperty(response, 'url', { value: extra.url || '' });
  Object.defineProperty(response, 'redirected', {
    value: !!extra.redirected,
  });
  return response;
};

const code = (credentials: Record<string, string>) =>
  Buffer.from(JSON.stringify(credentials)).toString('base64');

const CREDS = {
  domain: 'https://site.com',
  username: 'jane',
  password: 'abcd EFGH 1234 ijkl MNOP 5678',
};

const authHeader = `Basic ${Buffer.from(
  `${CREDS.username}:${CREDS.password}`
).toString('base64')}`;

const ME = {
  id: 7,
  name: 'Jane Doe',
  avatar_urls: {
    '24': 'https://g/24',
    '96': 'https://g/96',
    '48': 'https://g/48',
  },
};

let fetchMock: jest.Mock;
const calls = () =>
  fetchMock.mock.calls.map(([url, init]) => ({
    url: String(url),
    method: init?.method || 'GET',
    headers: init?.headers || {},
    body: init?.body,
  }));

beforeEach(() => {
  fetchMock = jest.fn();
  (global as any).fetch = fetchMock;
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const connect = (credentials: Record<string, string> = CREDS) =>
  new WordpressProvider().authenticate({
    code: code(credentials),
    codeVerifier: '',
  });

describe('WordPress connect', () => {
  it('checks the login at /wp-json/wp/v2/users/me with Basic auth and stores a normalized token', async () => {
    fetchMock.mockResolvedValueOnce(res(200, ME));

    const auth: any = await connect({
      ...CREDS,
      domain: '  https://site.com/wp-admin/  ',
    });

    expect(calls()[0].url).toBe('https://site.com/wp-json/wp/v2/users/me');
    expect(calls()[0].headers.Authorization).toBe(authHeader);
    expect(auth.id).toBe('https://site.com_7');
    expect(auth.name).toBe('Jane Doe');
    expect(auth.picture).toBe('https://g/96');
    expect(auth.username).toBe('jane');
    expect(decodeWordpressToken(auth.accessToken)).toEqual(CREDS);
  });

  it('decodes credentials whose base64 "+" arrived as a space in the callback query', async () => {
    fetchMock.mockResolvedValue(res(200, ME));
    // A "~" at the right offset makes the base64 carry a "+".
    const credentials = { ...CREDS, domain: 'https://sites.com/~jane' };
    const encoded = code(credentials);
    expect(encoded).toContain('+');

    const auth: any = await new WordpressProvider().authenticate({
      code: encoded.replace(/\+/g, ' '),
      codeVerifier: '',
    });

    expect(typeof auth).toBe('object');
    expect(calls()[0].url).toBe(
      'https://sites.com/~jane/wp-json/wp/v2/users/me'
    );
  });

  it.each([
    [
      'incorrect_password',
      'The provided password is an invalid application password.',
      /Application Password .*not your normal login password/,
    ],
    [
      'invalid_username',
      '<strong>Error:</strong> Unknown username. Check again or try your email address.',
      /doesn't recognise that username/,
    ],
    [
      'application_passwords_disabled',
      'Application passwords are not available.',
      /turned off on this site/,
    ],
    [
      'rest_not_logged_in',
      'You are not currently logged in.',
      /Create an Application Password first.*Authorization header/,
    ],
  ])(
    'maps a 401 %s to a message naming the fix',
    async (wpCode, message, expected) => {
      fetchMock.mockResolvedValueOnce(
        res(401, { code: wpCode, message, data: { status: 401 } })
      );

      const result = await connect();

      expect(typeof result).toBe('string');
      expect(result).toMatch(expected);
    }
  );

  it('tells an http:// site that Application Passwords need HTTPS', async () => {
    fetchMock.mockResolvedValueOnce(
      res(401, {
        code: 'rest_not_logged_in',
        message: 'x',
        data: { status: 401 },
      })
    );

    expect(await connect({ ...CREDS, domain: 'http://site.com' })).toMatch(
      /only work over HTTPS/
    );
  });

  it('re-sends the login to the www/https address the site redirected to (fetch drops it cross-origin)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(
          401,
          { code: 'rest_not_logged_in', message: 'x', data: { status: 401 } },
          {
            redirected: true,
            url: 'https://www.site.com/wp-json/wp/v2/users/me/',
          }
        )
      )
      .mockResolvedValueOnce(res(200, ME));

    const auth: any = await connect({ ...CREDS, domain: 'http://site.com' });

    expect(calls()[1].url).toBe('https://www.site.com/wp-json/wp/v2/users/me');
    expect(calls()[1].headers.Authorization).toBe(authHeader);
    expect(auth.id).toBe('https://www.site.com_7');
    expect(decodeWordpressToken(auth.accessToken).domain).toBe(
      'https://www.site.com'
    );
  });

  it('never re-sends credentials to a different site it was redirected to', async () => {
    fetchMock.mockResolvedValueOnce(
      res(401, '{}', {
        redirected: true,
        url: 'https://other.example/wp-json/wp/v2/users/me',
      })
    );

    expect(await connect()).toMatch(/redirects to https:\/\/other\.example/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('finds the REST API through the Link header when /wp-json/ is missing (plain permalinks)', async () => {
    fetchMock
      .mockResolvedValueOnce(res(404, '<html>not found</html>'))
      .mockResolvedValueOnce(
        res(200, '<html></html>', {
          headers: {
            link: '<https://site.com/?rest_route=/>; rel="https://api.w.org/"',
          },
        })
      )
      .mockResolvedValueOnce(res(200, ME));

    const auth: any = await connect();

    expect(calls()[1].url).toBe('https://site.com/');
    expect(calls()[1].headers.Authorization).toBeUndefined();
    expect(calls()[2].url).toBe('https://site.com/?rest_route=/wp/v2/users/me');
    expect(decodeWordpressToken(auth.accessToken).api).toBe(
      'https://site.com/?rest_route=/'
    );
  });

  it('says the REST API is missing when discovery finds nothing', async () => {
    fetchMock
      .mockResolvedValueOnce(res(404, '<html>not found</html>'))
      .mockResolvedValueOnce(res(200, '<html></html>'));

    expect(await connect()).toMatch(
      /No WordPress REST API found at https:\/\/site\.com/
    );
  });

  it('reports an unreachable site instead of throwing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    expect(await connect()).toMatch(/Could not reach your WordPress site/);
  });

  it('rejects a 200 that is not a WordPress user', async () => {
    fetchMock.mockResolvedValueOnce(res(200, { code: 'rest_disabled' }));

    expect(await connect()).toMatch(/did not return the user/);
  });

  it('normalizes pasted admin and REST addresses', () => {
    expect(
      normalizeWordpressDomain('https://site.com/blog/wp-json/wp/v2')
    ).toBe('https://site.com/blog');
    expect(normalizeWordpressDomain('https://site.com/wp-login.php?x=1')).toBe(
      'https://site.com'
    );
    expect(
      wordpressUrl(
        { domain: 'https://site.com', api: 'https://site.com/?rest_route=/' },
        'wp/v2/tags',
        'per_page=100'
      )
    ).toBe('https://site.com/?rest_route=/wp/v2/tags&per_page=100');
  });
});

describe('WordPress post', () => {
  const token = code(CREDS);

  const setup = () => {
    const provider: any = new WordpressProvider();
    provider.mediaSize = jest.fn(async () => 1234);
    provider.mediaStream = jest.fn(async () => 'STREAM');
    return provider;
  };

  const details = (settings: any, extra: any = {}): any[] => [
    {
      id: 'p1',
      message: '<p>Hello world</p>',
      settings: { title: 'Hello World', type: 'posts', ...settings },
      ...extra,
    },
  ];

  it('publishes text only to wp/v2/{type} and returns the post id and link', async () => {
    fetchMock.mockResolvedValueOnce(
      res(201, { id: 42, link: 'https://site.com/hello-world/' })
    );

    const [result] = await setup().post('id', token, details({}), {} as any);

    const [create] = calls();
    expect(create.url).toBe('https://site.com/wp-json/wp/v2/posts');
    expect(create.method).toBe('POST');
    expect(create.headers.Authorization).toBe(authHeader);
    expect(JSON.parse(create.body)).toEqual({
      title: 'Hello World',
      content: '<p>Hello world</p>',
      slug: 'hello-world',
      status: 'publish',
    });
    expect(result).toEqual({
      id: 'p1',
      status: 'completed',
      postId: '42',
      releaseURL: 'https://site.com/hello-world/',
    });
  });

  it('defaults an empty post type to posts and keeps status, categories and tags', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { id: 1, link: 'l' }));

    await setup().post(
      'id',
      token,
      details({ type: '', status: 'draft', categories: [3, '4'], tags: [9] }),
      {} as any
    );

    const [create] = calls();
    expect(create.url).toBe('https://site.com/wp-json/wp/v2/posts');
    expect(JSON.parse(create.body)).toMatchObject({
      status: 'draft',
      categories: [3, 4],
      tags: [9],
    });
  });

  it('uploads the cover as raw media and sets it as featured_media', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(201, {
          id: 55,
          source_url: 'https://site.com/wp-content/uploads/cover.png',
          mime_type: 'image/png',
        })
      )
      .mockResolvedValueOnce(res(201, { id: 42, link: 'l' }));

    const provider = setup();
    await provider.post(
      'id',
      token,
      details({
        main_image: {
          id: 'm',
          path: 'https://media.hookstep.in/uploads/my cover.png?v=2',
          alt: 'A cover',
        },
      }),
      {} as any
    );

    const [upload, create] = calls();
    expect(upload.url).toBe(
      'https://site.com/wp-json/wp/v2/media?alt_text=A%20cover'
    );
    expect(upload.method).toBe('POST');
    expect(upload.body).toBe('STREAM');
    expect(upload.headers).toMatchObject({
      Authorization: authHeader,
      'Content-Type': 'image/png',
      'Content-Disposition': 'attachment; filename="my-cover.png"',
      'Content-Length': '1234',
    });
    expect(JSON.parse(create.body).featured_media).toBe(55);
  });

  it('uploads editor images and videos and places them after the text', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(201, {
          id: 61,
          source_url: 'https://site.com/u/a.jpg',
          mime_type: 'image/jpeg',
        })
      )
      .mockResolvedValueOnce(
        res(201, {
          id: 62,
          source_url: 'https://site.com/u/b.mp4',
          mime_type: 'video/mp4',
        })
      )
      .mockResolvedValueOnce(res(201, { id: 42, link: 'l' }));

    await setup().post(
      'id',
      token,
      details(
        {},
        {
          media: [
            { type: 'image', path: 'https://m/a.jpg', alt: 'Cat "1"' },
            { type: 'video', path: 'https://m/b.mp4' },
          ],
        }
      ),
      {} as any
    );

    const [image, video, create] = calls();
    expect(image.headers['Content-Type']).toBe('image/jpeg');
    expect(video.headers['Content-Type']).toBe('video/mp4');
    const content = JSON.parse(create.body).content;
    expect(content).toContain('<p>Hello world</p>');
    expect(content).toContain(
      '<img src="https://site.com/u/a.jpg" alt="Cat &quot;1&quot;"/>'
    );
    expect(content).toContain(
      '<video controls src="https://site.com/u/b.mp4">'
    );
    expect(JSON.parse(create.body).featured_media).toBeUndefined();
  });

  it('turns a refused upload into a clear error and publishes nothing', async () => {
    fetchMock.mockResolvedValueOnce(
      res(400, {
        code: 'rest_cannot_create',
        message: 'Sorry, you are not allowed to upload media on this site.',
        data: { status: 400 },
      })
    );

    await expect(
      setup().post(
        'id',
        token,
        details({ main_image: { id: 'm', path: 'https://m/c.png' } }),
        {} as any
      )
    ).rejects.toMatchObject({
      message: expect.stringMatching(
        /not allowed to upload media.*Author role/
      ),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes WordPress’s own reason through when publishing is refused', async () => {
    fetchMock.mockResolvedValueOnce(
      res(403, {
        code: 'rest_cannot_publish',
        message:
          'Sorry, you are not allowed to publish posts in this post type.',
        data: { status: 403 },
      })
    );

    const error = await setup()
      .post('id', token, details({}), {} as any)
      .catch((err: any) => err);

    expect(error).toBeInstanceOf(BadBody);
    expect(error.message).toMatch(/not allowed to publish posts/);
  });

  it('asks for a reconnect when the Application Password was revoked', async () => {
    fetchMock.mockResolvedValueOnce(
      res(401, {
        code: 'incorrect_password',
        message: 'The provided password is an invalid application password.',
        data: { status: 401 },
      })
    );

    const error = await setup()
      .post('id', token, details({}), {} as any)
      .catch((err: any) => err);

    expect(error).toBeInstanceOf(RefreshToken);
    expect(error.message).toMatch(/Application Password/);
  });

  it('does not retry a 500 on create (the post usually exists) and says to check the site', async () => {
    fetchMock.mockResolvedValue(
      res(500, {
        code: 'internal_server_error',
        message: '<p>There has been a critical error on this website.</p>',
        data: { status: 500 },
      })
    );

    const error = await setup()
      .post('id', token, details({}), {} as any)
      .catch((err: any) => err);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(BadBody);
    expect(error.message).toMatch(
      /HTTP 500.*critical error.*check your site before posting again/
    );
  });

  it('names the firewall when a challenge page blocks the publish', async () => {
    fetchMock.mockResolvedValueOnce(
      res(403, '<!DOCTYPE html><title>Just a moment...</title>')
    );

    const error = await setup()
      .post('id', token, details({}), {} as any)
      .catch((err: any) => err);

    expect(error).toBeInstanceOf(BadBody);
    expect(error.message).toMatch(
      /firewall .* blocked the request \(HTTP 403\)/
    );
  });

  it('never marks a 200 without the new post as published', async () => {
    // A redirect turns the POST into a GET, which lists posts.
    fetchMock.mockResolvedValueOnce(res(200, [{ id: 1 }, { id: 2 }]));

    const error = await setup()
      .post('id', token, details({}), {} as any)
      .catch((err: any) => err);

    expect(error).toBeInstanceOf(BadBody);
    expect(error.message).toMatch(/can't confirm it was published/);
  });

  it('posts through ?rest_route= when the site has no pretty permalinks', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { id: 3, link: 'l' }));

    await setup().post(
      'id',
      code({ ...CREDS, api: 'https://site.com/?rest_route=/' }),
      details({ type: 'pages' }),
      {} as any
    );

    expect(calls()[0].url).toBe('https://site.com/?rest_route=/wp/v2/pages');
  });
});

describe('WordPress settings helpers', () => {
  const token = code(CREDS);

  it('lists post types, skipping internal ones and keeping a foreign namespace', async () => {
    fetchMock.mockResolvedValueOnce(
      res(200, {
        post: { name: 'Posts', rest_base: 'posts', rest_namespace: 'wp/v2' },
        page: { name: 'Pages', rest_base: 'pages' },
        attachment: { name: 'Media', rest_base: 'media' },
        wp_block: { name: 'Patterns', rest_base: 'blocks' },
        nav_menu_item: { name: 'Menu', rest_base: 'menu-items' },
        product: {
          name: 'Products',
          rest_base: 'products',
          rest_namespace: 'wc/v3',
        },
      })
    );

    expect(await new WordpressProvider().postTypes(token)).toEqual([
      { id: 'posts', name: 'Posts' },
      { id: 'pages', name: 'Pages' },
      { id: 'wc/v3/products', name: 'Products' },
    ]);
  });

  it('throws WordPress’s message instead of listing an error object as post types', async () => {
    fetchMock.mockResolvedValueOnce(
      res(401, {
        code: 'incorrect_password',
        message: 'The provided password is an invalid application password.',
        data: { status: 401 },
      })
    );

    await expect(new WordpressProvider().postTypes(token)).rejects.toThrow(
      /invalid application password/
    );
  });

  it('rejects a video as the cover picture before scheduling', async () => {
    const provider = new WordpressProvider();
    expect(
      await provider.checkValidity([], {
        main_image: { path: 'https://m/v.mp4' },
      })
    ).toMatch(/must be an image/);
    expect(
      await provider.checkValidity([], {
        main_image: { path: 'https://m/c.webp' },
      })
    ).toBe(true);
  });

  it('builds an ASCII upload filename with the right extension', () => {
    expect(wordpressFileName('https://m/uploads/Hindi नमस्ते.jpg?x=1')).toBe(
      'Hindi-.jpg'
    );
    expect(wordpressFileName('https://m/uploads/noext')).toMatch(
      /^hookpost-\w+\.jpg$/
    );
  });
});
