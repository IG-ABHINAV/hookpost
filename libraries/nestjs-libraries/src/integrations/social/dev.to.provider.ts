import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  BadBody,
  SocialAbstract,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { DevToSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/dev.to.settings.dto';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';

const API = 'https://dev.to/api';

// Dev.to has no API for uploading a video file (articles only take a YouTube/
// Vimeo-style embed in the markdown), so an attached video can't be published.
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'];

const isVideo = (path?: string | null) => {
  const clean = (path || '').split('?')[0].toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => clean.endsWith(ext));
};

// Media paths are stored either as full URLs (R2) or as a bare key under the
// upload directory (local storage). Dev.to fetches images itself, so it needs
// the public URL - posts.service.updateMedia builds it the same way.
const publicUrl = (path?: string | null) => {
  if (!path) {
    return '';
  }
  if (path.indexOf('http') === 0) {
    return path;
  }
  return `${process.env.FRONTEND_URL}/${
    process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY || ''
  }${path}`;
};

// `![alt](url)` breaks on a `]` in the alt text or a space/paren in the URL.
const markdownImage = (url: string, alt = '') =>
  `![${alt.replace(/[\[\]\n]/g, ' ').trim()}](${url
    .replace(/ /g, '%20')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')})`;

const INVALID_KEY =
  'Dev.to rejected this API key. Create a new one at https://dev.to/settings/extensions (DEV Community API Keys > Generate API Key) and paste it here.';

export class DevToProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Dev.to has moderate publishing limits
  identifier = 'devto';
  name = 'Dev.to';
  isBetweenSteps = false;
  editor = 'markdown' as const;
  scopes = [] as string[];
  maxLength() {
    return 100000;
  }
  dto = DevToSettingsDto;

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  // Dev.to answers every error as {"error": "<sentence>", "status": <code>}.
  // The sentence is already user-readable and reaches the post through
  // extractProviderMessage; only the cases that need a different action or
  // a clearer hint are mapped here.
  override handleErrors(body: string, status?: number) {
    if (body.indexOf('Canonical url has already been taken') > -1) {
      return {
        type: 'bad-body' as const,
        value:
          'Dev.to already has an article with this canonical URL. Change the canonical link or leave it empty.',
      };
    }

    // A revoked/regenerated key, or an account dev.to no longer lets publish
    // (Pundit denials are also rendered as 401 "unauthorized"). There is no
    // refresh for an API key, so the channel is marked for a reconnect.
    if (status === 401 || body.indexOf('"unauthorized"') > -1) {
      return {
        type: 'refresh-token' as const,
        value:
          'Dev.to rejected the API key (it was revoked or regenerated, or the account is not allowed to publish). Create a new key at https://dev.to/settings/extensions and reconnect the channel.',
      };
    }

    return undefined;
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

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
        hint: 'On dev.to open Settings > Extensions (dev.to/settings/extensions), under "DEV Community API Keys" add a description, click Generate API Key and paste the key here.',
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let apiKey = '';
    try {
      apiKey = String(
        JSON.parse(Buffer.from(params.code, 'base64').toString())?.apiKey || ''
      ).trim();
    } catch (err) {
      return INVALID_KEY;
    }

    if (!apiKey) {
      return INVALID_KEY;
    }

    let response: Response;
    try {
      response = await fetch(`${API}/users/me`, {
        headers: {
          'api-key': apiKey,
        },
      });
    } catch (err) {
      return 'Could not reach dev.to, please try again in a minute.';
    }

    // An invalid key is a 401 {"error":"unauthorized"} - its JSON parsed fine
    // and used to fall through with an undefined id.
    if (response.status === 401 || response.status === 403) {
      return INVALID_KEY;
    }

    if (!response.ok) {
      return `Dev.to did not answer (HTTP ${response.status}), please try again in a minute.`;
    }

    let user: any;
    try {
      user = await response.json();
    } catch (err) {
      return 'Dev.to sent an unexpected answer, please try again in a minute.';
    }

    if (!user?.id) {
      return INVALID_KEY;
    }

    return {
      refreshToken: '',
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: apiKey,
      id: String(user.id),
      name: user.name || user.username || '',
      picture: user.profile_image || '',
      username: user.username || '',
    };
  }

  @Tool({ description: 'Tag list', dataSchema: [] })
  async tags(token: string) {
    const response = await fetch(`${API}/tags?per_page=1000&page=1`, {
      headers: {
        'api-key': token,
      },
    });
    const tags = response.ok ? await response.json() : [];

    return (Array.isArray(tags) ? tags : []).map((p: any) => ({
      value: p.id,
      label: p.name,
    }));
  }

  // Dev.to has no "my organizations" endpoint: the organizations are read off
  // the user's own articles, so an organization only shows up once the user
  // has published under it at least once.
  @Tool({ description: 'Organization list', dataSchema: [] })
  async organizations(token: string) {
    const response = await fetch(`${API}/articles/me/all?per_page=1000`, {
      headers: {
        'api-key': token,
      },
    });
    const articles = response.ok ? await response.json() : [];

    const allOrgs: string[] = [
      ...new Set(
        (Array.isArray(articles) ? articles : [])
          .map((article: any) => article?.organization?.username)
          .filter((f: string) => f)
      ),
    ] as string[];
    const fullDetails = await Promise.all(
      allOrgs.map(async (org: string) => {
        try {
          const orgResponse = await fetch(
            `${API}/organizations/${encodeURIComponent(org)}`,
            {
              headers: {
                'api-key': token,
              },
            }
          );
          return orgResponse.ok ? await orgResponse.json() : undefined;
        } catch (err) {
          return undefined;
        }
      })
    );

    return fullDetails
      .filter((org: any) => org?.id)
      .map((org: any) => ({
        id: org.id,
        name: org.name,
        username: org.username,
      }));
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>,
    settings?: any,
    additionalSettings?: any[]
  ): Promise<string | true> {
    if (
      (posts || []).some((media) => (media || []).some((m) => isVideo(m?.path)))
    ) {
      return 'Dev.to cannot host video files. Remove the video and paste a YouTube or Vimeo link into the text instead; dev.to shows it as an embedded player.';
    }

    return true;
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails || [];
    const settings = firstPost?.settings || {};
    const media = firstPost?.media || [];

    // checkValidity stops this in the composer; the API/MCP paths can still
    // send one, and publishing the article without it would lose it silently.
    if (media.some((m) => isVideo(m?.path))) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Dev.to cannot host video files. Remove the video and paste a YouTube or Vimeo link into the text instead.'
      );
    }

    // Dev.to has no attachments: an article's pictures live in its markdown,
    // so the post's images are appended as markdown images (dev.to fetches
    // and re-hosts them through its own image CDN).
    const images = media
      .map((m) => ({
        url: publicUrl(
          (m as any)?.url?.indexOf?.('http') === 0 ? (m as any).url : m?.path
        ),
        alt: m?.alt || '',
      }))
      .filter((m) => m.url.indexOf('http') === 0)
      .map((m) => markdownImage(m.url, m.alt));

    const body_markdown = [firstPost?.message || '', ...images]
      .filter((part) => part.trim())
      .join('\n\n');

    const mainImage = publicUrl(settings?.main_image?.path);
    const organizationId = Number(settings?.organization);
    const tags = (settings?.tags || [])
      .map((t: any) => t?.label)
      .filter((t: any) => typeof t === 'string' && t);

    const response = await this.fetch(
      `${API}/articles`,
      {
        method: 'POST',
        body: JSON.stringify({
          article: {
            title: settings.title,
            body_markdown,
            published: true,
            ...(mainImage ? { main_image: mainImage } : {}),
            ...(tags.length ? { tags } : {}),
            // the select sends the id as a string, and "" for "none"
            ...(organizationId > 0 ? { organization_id: organizationId } : {}),
            ...(settings.canonical
              ? { canonical_url: settings.canonical }
              : {}),
          },
        }),
        headers: {
          'Content-Type': 'application/json',
          'api-key': accessToken,
        },
      },
      this.identifier
    );

    // A 201 means the article is live. If its body can't be read, still
    // report it as published: throwing here would retry the activity and
    // publish the same article a second time.
    let article: any = {};
    try {
      article = await response.json();
    } catch (err) {
      article = {};
    }

    return [
      {
        id: firstPost?.id,
        status: 'completed',
        postId: article?.id ? String(article.id) : '',
        releaseURL: article?.url || '',
      },
    ];
  }
}
