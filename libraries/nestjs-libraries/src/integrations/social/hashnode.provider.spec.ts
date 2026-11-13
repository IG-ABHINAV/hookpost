import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  appendImages,
  HASHNODE_BAD_TOKEN_MESSAGE,
  HASHNODE_GQL,
  HASHNODE_PRO_PLAN_MESSAGE,
  HashnodeProvider,
  toHashnodeTag,
} from '@hookpost/nestjs-libraries/integrations/social/hashnode.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { HashnodeSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/hashnode.settings.dto';

// Response bodies below are the ones gql-beta.hashnode.com returned to live
// probes with a deliberately invalid token on 20 Oct 2026.
const UNAUTHENTICATED_ME = {
  errors: [
    {
      message: 'You must be logged in',
      extensions: { code: 'UNAUTHENTICATED' },
      path: ['me'],
    },
  ],
  data: { me: null },
};
const UNAUTHENTICATED_PUBLISH = {
  errors: [
    {
      message:
        'Authentication required. Pass your Personal Access Token in the Authorization header.',
      extensions: { code: 'UNAUTHENTICATED' },
      path: ['publishPost'],
    },
  ],
  data: null,
};
// Documented in Hashnode's gql-skill (errors-and-limits.md).
const PRO_PLAN_FORBIDDEN = {
  errors: [
    {
      message:
        'Publication does not have an active Pro plan. Upgrade in your dashboard to access this via the API.',
      extensions: { code: 'FORBIDDEN' },
    },
  ],
  data: null,
};
const OLD_SHAPE_VALIDATION = {
  errors: [
    {
      message: 'Field "id" is not defined by type "PublishPostTagInput".',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    },
  ],
};

type Reply = { status?: number; body: any; url?: string };

const scripted = (...replies: Reply[]) => {
  const calls: { url: string; init: any; body: any }[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    calls.push({
      url,
      init,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const reply = replies.shift();
    if (!reply) {
      throw new Error(`unexpected fetch ${url}`);
    }
    const text =
      typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return {
      status: reply.status ?? 200,
      url: reply.url ?? url,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  });
  return { calls, restore: () => ((global as any).fetch = original) };
};

const code = (data: any) =>
  Buffer.from(JSON.stringify(data)).toString('base64');

const baseSettings = {
  title: 'Shipping a GraphQL API',
  publication: '64a1b2c3d4e5f60718293a4b',
  tags: [{ value: '56744721958ef13879b94cad', label: 'JavaScript' }],
};

const details = (overrides: any = {}): any => ({
  id: 'post-1',
  message: '# Intro\n\nBody in **markdown**.',
  settings: { ...baseSettings, ...(overrides.settings || {}) },
  media: overrides.media || [],
});

describe('HashnodeProvider', () => {
  let net: ReturnType<typeof scripted> | undefined;
  afterEach(() => net?.restore());

  describe('connect', () => {
    it('reads the profile from gql-beta with the token as a Bearer header', async () => {
      net = scripted({
        body: {
          data: {
            me: {
              id: 'u1',
              name: 'Jane',
              username: 'janedoe',
              profilePicture: 'https://cdn.hashnode.com/p.png',
            },
          },
        },
      });

      const auth: any = await new HashnodeProvider().authenticate({
        code: code({ apiKey: '  Bearer pat-123  ' }),
        codeVerifier: '',
      });

      expect(auth).toMatchObject({
        id: 'u1',
        name: 'Jane',
        username: 'janedoe',
        picture: 'https://cdn.hashnode.com/p.png',
        accessToken: 'pat-123',
      });
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0].url).toBe(HASHNODE_GQL);
      expect(net.calls[0].url).not.toContain('gql.hashnode.com');
      expect(net.calls[0].init.headers.Authorization).toBe('Bearer pat-123');
      expect(net.calls[0].body.query).toContain('me {');
    });

    it('tells the user where to make a token when Hashnode rejects it', async () => {
      net = scripted({ body: UNAUTHENTICATED_ME });

      const auth = await new HashnodeProvider().authenticate({
        code: code({ apiKey: 'not-a-real-token' }),
        codeVerifier: '',
      });

      expect(typeof auth).toBe('string');
      expect(auth).toContain('Account Settings > Developer');
    });

    it('says the API answered with a page, not "Invalid credentials", when it moves again', async () => {
      // What the retired gql.hashnode.com does today: a 301 that fetch
      // follows into the changelog HTML.
      net = scripted({
        body: '<!DOCTYPE html><html>GraphQL API is moving</html>',
        url: 'https://hashnode.com/changelog/2026-05-13-graphql-api-paid-access',
      });

      const auth = await new HashnodeProvider().authenticate({
        code: code({ apiKey: 'pat-123' }),
        codeVerifier: '',
      });

      expect(auth).toContain('web page instead of API data');
      expect(auth).toContain('changelog');
    });

    it('asks for the token when the field is blank, without calling Hashnode', async () => {
      net = scripted();
      const auth = await new HashnodeProvider().authenticate({
        code: code({ apiKey: '   ' }),
        codeVerifier: '',
      });
      expect(typeof auth).toBe('string');
      expect(net.calls).toHaveLength(0);
    });

    it('labels the connect field as a Personal Access Token with a hint', async () => {
      const [field] = await new HashnodeProvider().customFields();
      expect(field.key).toBe('apiKey');
      expect(field.label).toBe('Personal Access Token');
      expect(field.hint).toContain('Pro plan');
    });
  });

  describe('publications', () => {
    it('lists the blogs the token can publish to', async () => {
      net = scripted({
        body: {
          data: {
            me: {
              publications: {
                edges: [{ node: { id: 'p1', title: 'My blog' } }],
              },
            },
          },
        },
      });

      await expect(
        new HashnodeProvider().publications('pat-123')
      ).resolves.toEqual([{ id: 'p1', name: 'My blog' }]);
      expect(net.calls[0].url).toBe(HASHNODE_GQL);
    });

    it('asks for a reconnect when the token was revoked', async () => {
      net = scripted({ body: UNAUTHENTICATED_ME });
      await expect(
        new HashnodeProvider().publications('pat-123')
      ).rejects.toBeInstanceOf(RefreshToken);
    });
  });

  describe('post', () => {
    it('publishes a text-only article with tag slugs and variables', async () => {
      net = scripted({
        body: {
          data: {
            publishPost: {
              post: { id: 'h1', url: 'https://blog.example.dev/shipping' },
            },
          },
        },
      });

      const [res] = await new HashnodeProvider().post(
        'u1',
        'pat-123',
        [details({ settings: { canonical: 'https://example.com/orig' } })],
        {} as any
      );

      expect(res).toEqual({
        id: 'post-1',
        status: 'completed',
        postId: 'h1',
        releaseURL: 'https://blog.example.dev/shipping',
      });
      const { query, variables } = net.calls[0].body;
      expect(query).toContain('publishPost(input: $input)');
      expect(variables.input).toEqual({
        publicationId: baseSettings.publication,
        title: baseSettings.title,
        contentMarkdown: '# Intro\n\nBody in **markdown**.',
        originalArticleURL: 'https://example.com/orig',
        tags: [{ slug: 'javascript', name: 'JavaScript' }],
      });
      // the old input fields gql-beta rejects
      expect(variables.input.coverImageOptions).toBeUndefined();
      expect(JSON.stringify(variables.input.tags)).not.toContain('"id"');
    });

    it('sends the cover as coverImage and appends attached images to the body', async () => {
      net = scripted({
        body: { data: { publishPost: { post: { id: 'h2', url: 'https://b/x' } } } },
      });

      await new HashnodeProvider().post(
        'u1',
        'pat-123',
        [
          details({
            settings: {
              main_image: { id: 'm1', path: 'https://media.hookstep.in/cover.png' },
            },
            media: [
              {
                type: 'image',
                path: 'https://media.hookstep.in/a.jpg',
                url: 'https://media.hookstep.in/a.jpg',
                alt: 'diagram [v2]',
              },
            ],
          }),
        ],
        {} as any
      );

      const { input } = net.calls[0].body.variables;
      expect(input.coverImage).toBe('https://media.hookstep.in/cover.png');
      expect(input.contentMarkdown).toBe(
        '# Intro\n\nBody in **markdown**.\n\n![diagram  v2 ](https://media.hookstep.in/a.jpg)'
      );
    });

    it('does not repeat an image that is already in the article', () => {
      const md = 'see ![x](https://m/a.png)';
      expect(
        appendImages(md, [{ type: 'image', path: 'https://m/a.png' }])
      ).toBe(md);
    });

    it('refuses a video attachment before scheduling, since Hashnode cannot host one', async () => {
      const provider = new HashnodeProvider();
      await expect(
        provider.checkValidity([[{ path: 'https://media.hookstep.in/clip.mp4' }]])
      ).resolves.toContain('cannot carry video');
      await expect(
        provider.checkValidity([[{ path: 'https://media.hookstep.in/a.png' }]])
      ).resolves.toBe(true);
      expect(
        appendImages('body', [{ type: 'image', path: 'https://m/clip.mp4' }])
      ).toBe('body');
    });

    it('explains the Pro plan instead of crashing on the FORBIDDEN error', async () => {
      net = scripted({ body: PRO_PLAN_FORBIDDEN });

      const err: any = await new HashnodeProvider()
        .post('u1', 'pat-123', [details()], {} as any)
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toBe(HASHNODE_PRO_PLAN_MESSAGE);
      expect(err.nonRetryable).toBe(true);
      expect(net.calls).toHaveLength(1);
    });

    it('asks for a reconnect when Hashnode no longer accepts the token', async () => {
      net = scripted({ body: UNAUTHENTICATED_PUBLISH });

      const err: any = await new HashnodeProvider()
        .post('u1', 'pat-123', [details()], {} as any)
        .catch((e) => e);

      expect(err).toBeInstanceOf(RefreshToken);
      expect(err.message).toBe(HASHNODE_BAD_TOKEN_MESSAGE);
    });

    it('surfaces Hashnode’s validation message from a 400', async () => {
      net = scripted({ status: 400, body: OLD_SHAPE_VALIDATION });

      const err: any = await new HashnodeProvider()
        .post('u1', 'pat-123', [details()], {} as any)
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('PublishPostTagInput');
    });

    it('never reports a post as published when Hashnode returns no post', async () => {
      net = scripted({ body: { data: { publishPost: { post: null } } } });

      await expect(
        new HashnodeProvider().post('u1', 'pat-123', [details()], {} as any)
      ).rejects.toBeInstanceOf(BadBody);
    });

    it('fails without calling Hashnode when no publication was picked', async () => {
      net = scripted();
      const err: any = await new HashnodeProvider()
        .post('u1', 'pat-123', [details({ settings: { publication: '' } })], {} as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('publication');
      expect(net.calls).toHaveLength(0);
    });

    it('stops an article over the 100 KB API limit before sending it', async () => {
      net = scripted();
      const big = details();
      big.message = 'x'.repeat(120_000);
      const err: any = await new HashnodeProvider()
        .post('u1', 'pat-123', [big], {} as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toContain('100 KB');
      expect(net.calls).toHaveLength(0);
    });

    it('still publishes when tags are missing (API or MCP callers)', async () => {
      net = scripted({
        body: { data: { publishPost: { post: { id: 'h3', url: 'https://b/y' } } } },
      });
      await new HashnodeProvider().post(
        'u1',
        'pat-123',
        [details({ settings: { tags: undefined } })],
        {} as any
      );
      expect(net.calls[0].body.variables.input.tags).toBeUndefined();
    });
  });

  describe('toHashnodeTag', () => {
    it('maps a stored tag id, a slug, or a free label to a slug', () => {
      expect(
        toHashnodeTag({ value: '56744721958ef13879b94cad', label: 'JavaScript' })
      ).toEqual({ slug: 'javascript', name: 'JavaScript' });
      expect(toHashnodeTag('nodejs')).toEqual({ slug: 'nodejs', name: 'Node.js' });
      expect(toHashnodeTag({ value: 'ffffffffffffffffffffffff', label: 'My Tag' })).toEqual({
        slug: 'my-tag',
        name: 'My Tag',
      });
    });
  });

  describe('settings DTO', () => {
    it('rejects an empty publication with a readable message', async () => {
      const errors = await validate(
        plainToInstance(HashnodeSettingsDto, { ...baseSettings, publication: '' })
      );
      const pub = errors.find((e) => e.property === 'publication');
      expect(Object.values(pub?.constraints || {})).toContain(
        'Select the Hashnode blog (publication) to publish to'
      );
    });

    it('accepts a complete article', async () => {
      const errors = await validate(
        plainToInstance(HashnodeSettingsDto, baseSettings)
      );
      expect(errors).toHaveLength(0);
    });
  });
});
