import {
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { LemmySettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/lemmy.dto';
import { getSsrfSafeDispatcher } from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';

// Lemmy API v3. Every large instance runs 0.19.x (lemmy.world, lemmy.ml,
// beehaw.org, programming.dev, sh.itjust.works on 20 Oct 2026, none answers
// /api/v4), and Lemmy 1.0 keeps v3 working.
//
// Errors come back as {"error": "<snake_case code>"} (plus "message" for a
// few): 401 for incorrect_login, which is also the answer to a missing or
// revoked jwt, and 400 for everything else, rate limits included.
const LEMMY_ERRORS: Record<string, string> = {
  rate_limit_error:
    'The Lemmy instance is limiting how often Hookpost can sign in or post. Try again later',
  only_mods_can_post_in_community: 'Only moderators can post in this community',
  banned_from_community: 'This account is banned from the community',
  person_is_banned_from_community: 'This account is banned from the community',
  person_is_banned_from_site: 'This account is banned on the Lemmy instance',
  site_ban: 'This account is banned on the Lemmy instance',
  banned: 'This account is banned on the Lemmy instance',
  deleted: 'This Lemmy account, or the community, was deleted',
  cannot_create_post_or_comment_in_deleted_or_removed_community:
    'The community was deleted or removed',
  couldnt_find_community:
    'Lemmy could not find this community. Pick it again in the post settings',
  community_is_blocked: 'This account has blocked the community',
  instance_is_blocked: "This account has blocked the community's instance",
  invalid_post_title:
    'Lemmy needs a post title of 3 to 200 characters on a single line',
  invalid_body_field:
    'The text is too long for Lemmy (50,000 characters for a post, 10,000 for a comment)',
  alt_text_length_overflow: 'The image description is over 1,500 characters',
  invalid_url: 'Lemmy rejected the post URL',
  invalid_url_scheme: 'The post URL has to start with http:// or https://',
  url_length_overflow: 'The post URL is over 2,000 characters',
  blocked_url: 'The Lemmy instance blocks a link in this post',
  slurs: "The Lemmy instance's word filter rejected the text",
  language_not_allowed:
    "The community doesn't accept your account's default language. Set one it allows in your Lemmy account settings",
  locked: 'The post is locked, so it takes no comments',
  post_is_locked: 'The post is locked, so it takes no comments',
  max_comment_depth_reached: 'The comment thread is too deep for Lemmy',
  email_not_verified:
    "Verify the account's email address on the Lemmy instance, then connect again",
  registration_application_is_pending:
    "The instance's admins haven't approved this account yet",
  registration_denied: "The instance's admins denied this account's registration",
  missing_totp_token:
    "This Lemmy account uses two-factor authentication, which Hookpost can't sign in with yet",
  incorrect_totp_token:
    "This Lemmy account uses two-factor authentication, which Hookpost can't sign in with yet",
};

const SIGNED_OUT =
  'Lemmy signed Hookpost out of this account. Reconnect the channel in Hookpost';

const VIDEO = /\.(mp4|mov|m4v|avi|webm|mkv)(?:[?#]|$)/i;

type LemmyDetails = { service: string; identifier: string; password: string };

type LemmySession = LemmyDetails & { jwt: string; relogged: boolean };

type LemmyPendingData = { postId: string; releaseURL: string; warning: string };

export const lemmyErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error === 'string' ? parsed.error : undefined;
  } catch {
    return undefined;
  }
};

// The connect form allows "https://lemmy.world/" or a pasted community link;
// Lemmy answers 404 to "//api/v3/...", so only the origin is kept.
export const lemmyOrigin = (service: string): string => {
  const url = new URL(String(service || '').trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('unsupported protocol');
  }
  return url.origin;
};

const lemmyMessage = (code: string, body?: string) => {
  const known = LEMMY_ERRORS[code];
  let reason = '';
  try {
    const message = JSON.parse(body || '{}')?.message;
    reason = typeof message === 'string' && message.trim() ? message.trim() : '';
  } catch {
    reason = '';
  }

  const base = known || `Lemmy refused it (${code.replace(/_/g, ' ')})`;
  return reason ? `${base}: ${reason}` : base;
};

export class LemmyProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Lemmy instances typically have moderate limits
  identifier = 'lemmy';
  name = 'Lemmy';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'normal' as const;
  maxLength() {
    // Lemmy takes 50,000 characters in a post body but 10,000 in a comment,
    // and the same limit covers both here.
    return 10000;
  }
  dto = LemmySettingsDto;

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    const code = lemmyErrorCode(body);
    if (!code) {
      return undefined;
    }

    if (code === 'incorrect_login' || code === 'not_logged_in') {
      return { type: 'refresh-token', value: SIGNED_OUT };
    }

    return { type: 'bad-body', value: lemmyMessage(code, body) };
  }

  // A post is one image (sent as the post URL, the way lemmy-ui makes an
  // image post); comments carry theirs as markdown images. There is no video
  // upload: a video could only be a link to our copy, and that copy is purged
  // seven days after publishing (scripts/cleanup-expired-media.js).
  override async checkValidity(
    items: Array<ValidityMedia[]>
  ): Promise<string | true> {
    const all = (items || []).flat().filter(Boolean);
    if (all.some((m) => VIDEO.test(m?.path || ''))) {
      return "Lemmy doesn't take videos. Add a link to the video in the text or the post URL instead";
    }

    if ((items?.[0]?.length || 0) > 1) {
      return 'A Lemmy post takes one image';
    }

    return true;
  }

  async customFields() {
    return [
      {
        key: 'service',
        label: 'Instance URL',
        defaultValue: 'https://lemmy.world',
        hint: 'The Lemmy site your account is on, for example https://lemmy.world',
        validation: `/^https?:\\/\\/(www\\.)?[-a-zA-Z0-9@:%._\\+~#=]{1,256}\\.[a-zA-Z0-9()]{1,63}\\b([-a-zA-Z0-9()@:%_\\+.~#?&//=]*)$/`,
        type: 'text' as const,
      },
      {
        key: 'identifier',
        label: 'Username or email',
        validation: `/^.{3,}$/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        label: 'Password',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
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

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  // One sign-in. POST /user/login shares the instance's *register* rate
  // limit, per IP: 5 a day on lemmy.world, 10 an hour on lemmy.ml (20 Oct
  // 2026), and every Hookpost channel signs in from the same server. So the
  // jwt is kept as the channel's token and this runs again only when Lemmy
  // rejects that token.
  private async login(
    details: LemmyDetails
  ): Promise<
    | { jwt: string }
    | { error: string; code?: string; status: number; body: string }
  > {
    const host = new URL(details.service).host;
    let response: Response;
    try {
      response = await fetch(`${details.service}/api/v3/user/login`, {
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
        body: JSON.stringify({
          username_or_email: details.identifier,
          password: details.password,
        }),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      return {
        error: `Could not reach ${host}. Check the instance URL`,
        status: 0,
        body: '{}',
      };
    }

    const body = await response.text().catch(() => '');
    const code = lemmyErrorCode(body);

    if (code === 'incorrect_login') {
      return {
        error: `${host} did not accept that username and password. Check they belong to an account on ${host}`,
        code,
        status: response.status,
        body,
      };
    }

    if (code) {
      return { error: lemmyMessage(code, body), code, status: response.status, body };
    }

    let jwt: string | undefined;
    try {
      jwt = JSON.parse(body)?.jwt;
    } catch {
      jwt = undefined;
    }

    if (!response.ok || !jwt) {
      return {
        error: `${host} did not answer like a Lemmy instance (HTTP ${response.status}). Check the instance URL, for example https://lemmy.world`,
        status: response.status,
        body,
      };
    }

    return { jwt };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let details: LemmyDetails;
    try {
      const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
      details = {
        service: lemmyOrigin(body.service),
        identifier: String(body.identifier || '').trim(),
        password: String(body.password || ''),
      };
    } catch {
      return 'Enter the URL of your Lemmy instance, for example https://lemmy.world';
    }

    const login = await this.login(details);
    if ('error' in login) {
      return login.error;
    }

    const host = new URL(details.service).host;

    // The signed-in account, from the token itself: the identifier can be an
    // email address, which GET /user?username= can't look up.
    let person: any;
    try {
      const site = await fetch(`${details.service}/api/v3/site`, {
        // @ts-ignore - undici-only option; blocks SSRF to internal IPs
        dispatcher: getSsrfSafeDispatcher(),
        headers: {
          Authorization: `Bearer ${login.jwt}`,
        },
      });
      person = (await site.json())?.my_user?.local_user_view?.person;
    } catch (err) {
      person = undefined;
    }

    if (!person?.id) {
      return `Signed in to ${host}, but it did not return the account. Try again`;
    }

    return {
      refreshToken: login.jwt,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: login.jwt,
      // Person ids are per instance: without the host, accounts on two
      // instances can share an id and overwrite each other's channel.
      id: `${person.id}@${host}`,
      name: person.display_name || person.name || '',
      picture: person.avatar || '',
      username: `${person.name}@${host}`,
    };
  }

  private session(integration: Integration, accessToken: string): LemmySession {
    const body = JSON.parse(
      AuthService.fixedDecryption(integration.customInstanceDetails!)
    );

    return {
      service: lemmyOrigin(body.service),
      identifier: String(body.identifier || '').trim(),
      password: String(body.password || ''),
      jwt: accessToken,
      relogged: false,
    };
  }

  // Signs in again when the saved token is rejected. A rejected password
  // means the user changed it: the channel needs a reconnect.
  private async relogin(session: LemmySession) {
    const login = await this.login(session);
    if ('jwt' in login) {
      session.jwt = login.jwt;
      session.relogged = true;
      return;
    }

    if (login.code === 'incorrect_login') {
      throw new RefreshToken(
        this.identifier,
        login.body,
        '{}',
        'Lemmy no longer accepts the saved password for this account. Reconnect the channel in Hookpost'
      );
    }

    throw new BadBody(this.identifier, login.body, '{}', login.error);
  }

  private async api<T = any>(
    session: LemmySession,
    path: string,
    init: { method?: string; body?: any } = {}
  ): Promise<T> {
    if (!session.jwt) {
      await this.relogin(session);
    }

    try {
      const response = await this.fetch(session.service + path, {
        method: init.method || 'GET',
        headers: {
          Authorization: `Bearer ${session.jwt}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      });
      return (await response.json()) as T;
    } catch (err) {
      if (!(err instanceof RefreshToken) || session.relogged) {
        throw err;
      }

      await this.relogin(session);
      return this.api<T>(session, path, init);
    }
  }

  private mediaUrl(media: { path: string; url?: string } | undefined) {
    const candidate = (media as any)?.url || media?.path || '';
    return candidate.indexOf('http') === 0 ? candidate : '';
  }

  // Publishes to every picked community. One community refusing must not
  // throw away the ones that already published: marking that post failed
  // invites a retry that duplicates it everywhere it is live.
  private async publish(
    postDetails: PostDetails<LemmySettingsDto>[],
    integration: Integration,
    accessToken: string
  ) {
    const [firstPost] = postDetails;
    const communities = firstPost?.settings?.subreddit || [];
    if (!communities.length) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'Pick at least one Lemmy community in the post settings'
      );
    }

    const session = this.session(integration, accessToken);
    const image = firstPost.media?.[0];
    const imageUrl = this.mediaUrl(image);

    const published: { postId: string; releaseURL: string }[] = [];
    const failed: { community: string; error: any }[] = [];

    for (const community of communities) {
      const value = community.value;
      const link = value.url
        ? value.url.indexOf('http') === -1
          ? `https://${value.url}`
          : value.url
        : '';

      try {
        const { post_view } = await this.api(session, '/api/v3/post', {
          method: 'POST',
          body: {
            community_id: +value.id,
            name: value.title,
            body: firstPost.message,
            // With a link the image is its thumbnail; without one the image
            // is the post itself (Lemmy shows custom_thumbnail only on link
            // posts).
            ...(link
              ? {
                  url: link,
                  ...(imageUrl ? { custom_thumbnail: imageUrl } : {}),
                }
              : imageUrl
              ? { url: imageUrl }
              : {}),
            ...(imageUrl && !link && image?.alt ? { alt_text: image.alt } : {}),
            nsfw: false,
          },
        });

        if (!post_view?.post?.id) {
          throw new BadBody(
            this.identifier,
            '{}',
            '{}',
            'Lemmy accepted the post but did not return it. Check the community before posting again'
          );
        }

        published.push({
          postId: String(post_view.post.id),
          releaseURL: `${session.service}/post/${post_view.post.id}`,
        });
      } catch (error) {
        // Every community would refuse the same sign-in.
        if (error instanceof RefreshToken && !published.length) {
          throw error;
        }
        failed.push({ community: value.subreddit || String(value.id), error });
      }
    }

    if (!published.length) {
      throw failed[0].error;
    }

    return {
      id: firstPost.id,
      postId: published.map((p) => p.postId).join(','),
      releaseURL: published.map((p) => p.releaseURL).join(','),
      warning: failed.length
        ? failed
            .map(
              (f) =>
                `${f.community} didn't take the post: ${
                  f.error?.message || 'unknown error'
                }`
            )
            .join('. ')
        : '',
    };
  }

  // Used by workflows before postPending existed: no warning channel there,
  // so a partly published post is reported as published.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails<LemmySettingsDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const result = await this.publish(postDetails, integration, accessToken);
    return [
      {
        id: result.id,
        postId: result.postId,
        releaseURL: result.releaseURL,
        status: 'published',
      },
    ];
  }

  // Everything is published here. Only a partial failure goes through
  // checkPostStatus / finalizePost, so finalizePost can hand the workflow the
  // "published, with a warning" notice; neither calls Lemmy.
  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails<LemmySettingsDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const result = await this.publish(postDetails, integration, accessToken);
    if (!result.warning) {
      return [
        {
          id: result.id,
          postId: result.postId,
          releaseURL: result.releaseURL,
          status: 'published',
        },
      ];
    }

    return [
      {
        id: result.id,
        postId: result.postId,
        releaseURL: result.releaseURL,
        status: 'pending',
        pendingData: {
          postId: result.postId,
          releaseURL: result.releaseURL,
          warning: result.warning,
        } as LemmyPendingData,
      },
    ];
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: LemmyPendingData
  ): Promise<PendingCheckResponse> {
    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: LemmyPendingData
  ): Promise<PendingCheckResponse> {
    return {
      status: 'completed',
      postId: pendingData.postId,
      releaseURL: pendingData.releaseURL,
      ...(pendingData.warning ? { warning: pendingData.warning } : {}),
    };
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<LemmySettingsDto>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const session = this.session(integration, accessToken);

    // Lemmy comments are markdown and have no attachments.
    const images = (commentPost.media || [])
      .map((m) => ({ url: this.mediaUrl(m), alt: m.alt || '' }))
      .filter((m) => m.url)
      .map((m) => `![${m.alt.replace(/[[\]]/g, '')}](${m.url})`);
    const content = [commentPost.message, ...images]
      .filter((p) => p && p.trim())
      .join('\n\n');

    // postId is comma-separated when the post went to several communities
    const postIds = postId.split(',').filter(Boolean);
    const published: { postId: string; releaseURL: string }[] = [];
    let firstError: any;

    for (const singlePostId of postIds) {
      try {
        const { comment_view } = await this.api(session, '/api/v3/comment', {
          method: 'POST',
          body: {
            post_id: +singlePostId,
            content,
          },
        });

        if (!comment_view?.comment?.id) {
          throw new BadBody(
            this.identifier,
            '{}',
            '{}',
            'Lemmy accepted the comment but did not return it. Check the post before commenting again'
          );
        }

        published.push({
          postId: String(comment_view.comment.id),
          releaseURL: `${session.service}/comment/${comment_view.comment.id}`,
        });
      } catch (error) {
        if (error instanceof RefreshToken && !published.length) {
          throw error;
        }
        firstError = firstError || error;
      }
    }

    // Same rule as the post: a comment live under one community stays
    // reported as published.
    if (!published.length) {
      throw (
        firstError ||
        new BadBody(this.identifier, '{}', '{}', 'There is no Lemmy post to comment on')
      );
    }

    return [
      {
        id: commentPost.id,
        postId: published.map((p) => p.postId).join(','),
        releaseURL: published.map((p) => p.releaseURL).join(','),
        status: 'published',
      },
    ];
  }

  @Tool({
    description: 'Search for Lemmy communities by keyword',
    dataSchema: [
      {
        key: 'word',
        type: 'string',
        description: 'Keyword to search for',
      },
    ],
  })
  async subreddits(
    accessToken: string,
    data: any,
    id: string,
    integration: Integration
  ) {
    const session = this.session(integration, accessToken);

    const { communities = [] } = await this.api(
      session,
      `/api/v3/search?type_=Communities&sort=Active&q=${encodeURIComponent(
        String(data?.word || '')
      )}`
    );

    // Search covers every federated instance, and titles repeat ("Technology"
    // exists on dozens), so the label carries the community's handle.
    return communities.map((p: any) => {
      let host = '';
      try {
        host = new URL(p.community.actor_id).host;
      } catch {
        host = '';
      }
      const label = `${p.community.title || p.community.name} (!${
        p.community.name
      }${host ? `@${host}` : ''})`;
      return {
        title: label,
        name: label,
        id: p.community.id,
      };
    });
  }
}
