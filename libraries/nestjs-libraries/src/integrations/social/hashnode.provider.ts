import {
  AuthTokenDetails,
  MediaContent,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { tags } from '@hookpost/nestjs-libraries/integrations/social/hashnode.tags';
import { HashnodeSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/hashnode.settings.dto';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';

// Hashnode retired https://gql.hashnode.com when the API went paid (changelog
// 2026-05-13). It now answers every request with a 301 to that changelog page,
// which fetch follows into HTML, so every connect said "Invalid credentials"
// and every publish died on a JSON parse error. The live API is gql-beta
// (what Hashnode's own gql-skill and publish-github-action call).
export const HASHNODE_GQL = 'https://gql-beta.hashnode.com';

// The gql server rejects JSON bodies over 100 KB (express.json limit); keep
// headroom for encoding, the same margin Hashnode's GitHub action uses.
export const HASHNODE_MAX_BODY_BYTES = 95_000;

export const HASHNODE_PRO_PLAN_MESSAGE =
  'Hashnode only publishes posts sent through its API to blogs on a Hashnode Pro plan. Upgrade this blog to Pro in your Hashnode dashboard (Billing), then retry the post.';

export const HASHNODE_BAD_TOKEN_MESSAGE =
  'Hashnode rejected the access token. Create a new Personal Access Token in Hashnode (Account Settings > Developer) and reconnect this channel.';

const TOKEN_HELP =
  'Hashnode did not accept this token. In Hashnode open Account Settings > Developer, generate a Personal Access Token and paste it here.';

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i;

const ME_QUERY = `query HookpostMe { me { id name username profilePicture } }`;

const PUBLICATIONS_QUERY = `query HookpostPublications {
  me { publications(first: 50) { edges { node { id title } } } }
}`;

const PUBLISH_MUTATION = `mutation HookpostPublishPost($input: PublishPostInput!) {
  publishPost(input: $input) { post { id url } }
}`;

const tagsById = new Map(tags.map((t) => [t.objectID, t]));
const tagsBySlug = new Map(tags.map((t) => [t.slug, t]));

// The composer stores the tags it got from tags() as { value, label }, where
// value used to be the Hashnode tag id. publishPost now takes tag slugs, so
// map an id (or a slug, from the MCP tagsList tool) back to the slug.
export const toHashnodeTag = (tag: any): { slug: string; name?: string } | undefined => {
  const value = String(
    typeof tag === 'string' ? tag : tag?.value ?? tag?.slug ?? tag?.objectID ?? ''
  ).trim();
  const label = String(
    typeof tag === 'string' ? '' : tag?.label ?? tag?.name ?? ''
  ).trim();
  const known = tagsById.get(value) || tagsBySlug.get(value.toLowerCase());
  if (known) {
    return { slug: known.slug, name: known.name };
  }

  const slug = (/^[a-z0-9-]+$/i.test(value) && !/^[a-f0-9]{24}$/i.test(value)
    ? value
    : label
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug ? { slug, ...(label ? { name: label } : {}) } : undefined;
};

const isVideo = (path?: string) => !!path && VIDEO_EXTENSION.test(path);

const publicUrl = (path?: string) => {
  if (!path) {
    return '';
  }
  if (path.indexOf('http') === 0) {
    return path;
  }
  return `${process.env.FRONTEND_URL}/${path.replace(/^\/+/, '')}`;
};

// Hashnode articles have no media attachments, so images attached in the
// composer used to be dropped without a word while the post showed as
// published. Append them to the article body instead.
export const appendImages = (markdown: string, media?: MediaContent[]) => {
  const images = (media || [])
    .map((m: any) => ({ url: publicUrl(m?.url || m?.path), alt: m?.alt }))
    .filter(
      (m) =>
        m.url.indexOf('http') === 0 &&
        !isVideo(m.url) &&
        markdown.indexOf(m.url) === -1
    );

  if (!images.length) {
    return markdown;
  }

  return [
    markdown,
    ...images.map(
      (m) => `![${String(m.alt || '').replace(/[[\]\n]/g, ' ')}](${m.url})`
    ),
  ].join('\n\n');
};

const normalizeToken = (value: unknown) =>
  String(value ?? '')
    .trim()
    .replace(/^bearer\s+/i, '')
    .trim();

export class HashnodeProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Hashnode has lenient publishing limits
  identifier = 'hashnode';
  name = 'Hashnode';
  toolTip = 'Publishing through the Hashnode API needs a Pro plan on your Hashnode blog';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'markdown' as const;
  maxLength() {
    return 10000;
  }
  dto = HashnodeSettingsDto;

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  // GraphQL reports UNAUTHENTICATED / FORBIDDEN inside an HTTP 200 body, and
  // validation errors as a 400. Both reach here: this.fetch for non-2xx and
  // gql() below for errors in a 200.
  override handleErrors(body: string) {
    if (/active Pro plan/i.test(body)) {
      return { type: 'bad-body' as const, value: HASHNODE_PRO_PLAN_MESSAGE };
    }

    if (body.indexOf('UNAUTHENTICATED') > -1) {
      return {
        type: 'refresh-token' as const,
        value: HASHNODE_BAD_TOKEN_MESSAGE,
      };
    }

    return undefined;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const [main] = posts ?? [];
    if ((main || []).some((m) => isVideo(m?.path))) {
      return 'Hashnode articles cannot carry video files. Remove the video, or paste a YouTube or Vimeo link into the article text and Hashnode will embed it.';
    }
    return true;
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'Personal Access Token',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
        hint: 'In Hashnode open Account Settings > Developer and generate a Personal Access Token. Publishing through the API needs a Pro plan on your Hashnode blog.',
      },
    ];
  }

  private async gql<T>(
    token: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const body = JSON.stringify({ query, ...(variables ? { variables } : {}) });
    if (Buffer.byteLength(body, 'utf8') > HASHNODE_MAX_BODY_BYTES) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'This article is larger than the 100 KB Hashnode accepts through its API. Shorten it and retry.'
      );
    }

    const response = await this.fetch(
      HASHNODE_GQL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-hashnode-client': 'hookpost',
        },
        body,
      },
      this.identifier
    );

    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new BadBody(
        this.identifier,
        text,
        body,
        `Hashnode answered with a web page instead of API data (HTTP ${response.status}${
          response.url ? `, ${response.url}` : ''
        }). Its API address may have moved.`
      );
    }

    if (Array.isArray(json?.errors) && json.errors.length) {
      const raw = JSON.stringify(json.errors);
      const handled = this.handleErrors(raw);
      if (handled?.type === 'refresh-token') {
        throw new RefreshToken(this.identifier, raw, body, handled.value);
      }

      throw new BadBody(
        this.identifier,
        raw,
        body,
        handled?.value ||
          `Hashnode: ${json.errors[0]?.message || 'the request failed'}`
      );
    }

    if (!json?.data) {
      throw new BadBody(
        this.identifier,
        text,
        body,
        'Hashnode returned an empty response'
      );
    }

    return json.data as T;
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let apiKey = '';
    try {
      apiKey = normalizeToken(
        JSON.parse(Buffer.from(params.code, 'base64').toString())?.apiKey
      );
    } catch (err) {
      apiKey = '';
    }

    if (!apiKey) {
      return TOKEN_HELP;
    }

    try {
      const { me } = await this.gql<{
        me: {
          id: string;
          name: string;
          username: string;
          profilePicture?: string;
        } | null;
      }>(apiKey, ME_QUERY);

      if (!me?.id) {
        return TOKEN_HELP;
      }

      return {
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: apiKey,
        id: me.id,
        name: me.name || me.username,
        picture: me.profilePicture || '',
        username: me.username,
      };
    } catch (err: any) {
      if (err instanceof RefreshToken) {
        return TOKEN_HELP;
      }

      return `Could not check the token with Hashnode. ${
        err?.message || 'The request failed.'
      }`;
    }
  }

  async tags() {
    return tags.map((tag) => ({ value: tag.objectID, label: tag.name }));
  }

  @Tool({ description: 'Tags', dataSchema: [] })
  tagsList() {
    return tags;
  }

  @Tool({ description: 'Publications', dataSchema: [] })
  async publications(accessToken: string) {
    const { me } = await this.gql<{
      me: {
        publications?: {
          edges?: { node: { id: string; title: string } }[];
        };
      } | null;
    }>(accessToken, PUBLICATIONS_QUERY);

    return (me?.publications?.edges || []).map(({ node: { id, title } }) => ({
      id,
      name: title,
    }));
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [first] = postDetails || [];
    const settings: any = first?.settings || {};

    if (!settings.publication) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Choose the Hashnode blog (publication) to publish to in the post settings.'
      );
    }

    const postTags = (Array.isArray(settings.tags) ? settings.tags : [])
      .map(toHashnodeTag)
      .filter(Boolean)
      .slice(0, 15);
    const cover = publicUrl(settings?.main_image?.path);

    const input = {
      publicationId: settings.publication,
      title: settings.title,
      contentMarkdown: appendImages(first?.message || '', first?.media),
      ...(settings.subtitle ? { subtitle: settings.subtitle } : {}),
      ...(settings.canonical ? { originalArticleURL: settings.canonical } : {}),
      ...(cover ? { coverImage: cover } : {}),
      ...(postTags.length ? { tags: postTags } : {}),
    };

    const data = await this.gql<{
      publishPost?: { post?: { id: string; url: string } | null } | null;
    }>(accessToken, PUBLISH_MUTATION, { input });

    const published = data?.publishPost?.post;
    if (!published?.id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(data || {}),
        '{}',
        'Hashnode accepted the request but returned no post. Check your Hashnode blog before retrying.'
      );
    }

    return [
      {
        id: first.id,
        status: 'completed',
        postId: published.id,
        releaseURL: published.url,
      },
    ];
  }
}
