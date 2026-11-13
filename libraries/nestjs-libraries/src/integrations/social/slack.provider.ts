import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  stripQuery,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { timer } from '@hookpost/helpers/utils/timer';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { SlackDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/slack.dto';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';

export class SlackProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Slack has moderate API limits
  identifier = 'slack';
  name = 'Slack';
  isBetweenSteps = false;
  editor = 'normal' as const;
  scopes = [
    'channels:read',
    'chat:write',
    'users:read',
    'groups:read',
    'channels:join',
    'chat:write.customize',
    // files.getUploadURLExternal / files.completeUploadExternal (video upload)
    'files:write',
  ];
  dto = SlackDto;

  // The whole message goes into one mrkdwn section block, and Slack refuses
  // a section text over 3,000 characters (invalid_blocks).
  maxLength() {
    return 3000;
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 1000000,
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
      url: `https://slack.com/oauth/v2/authorize?client_id=${
        process.env.SLACK_ID
      }&redirect_uri=${encodeURIComponent(
        `${
          process?.env?.FRONTEND_URL?.indexOf('https') === -1
            ? 'https://redirectmeto.com/'
            : ''
        }${process?.env?.FRONTEND_URL}/integrations/social/slack`
      )}&scope=channels:read,chat:write,users:read,groups:read,channels:join,chat:write.customize,files:write&state=${state}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const { access_token, team, bot_user_id, scope } = await (
      await this.fetch(`https://slack.com/api/oauth.v2.access`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: process.env.SLACK_ID!,
          client_secret: process.env.SLACK_SECRET!,
          code: params.code,
          redirect_uri: `${
            process?.env?.FRONTEND_URL?.indexOf('https') === -1
              ? 'https://redirectmeto.com/'
              : ''
          }${process?.env?.FRONTEND_URL}/integrations/social/slack${
            params.refresh ? `?refresh=${params.refresh}` : ''
          }`,
        }),
      })
    ).json();

    this.checkScopes(this.scopes, scope.split(','));

    const { user } = await (
      await fetch(`https://slack.com/api/users.info?user=${bot_user_id}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json();

    return {
      id: team.id,
      name: user.real_name,
      accessToken: access_token,
      refreshToken: 'null',
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      picture: user?.profile?.image_original || '',
      username: user.name,
    };
  }

  @Tool({
    description: 'Get list of channels',
    dataSchema: [],
  })
  async channels(accessToken: string, params: any, id: string) {
    const list = await (
      await fetch(
        `https://slack.com/api/conversations.list?types=public_channel,private_channel`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      )
    ).json();

    return list.channels.map((p: any) => ({
      id: p.id,
      name: p.name,
    }));
  }

  // Slack answers HTTP 200 with {"ok": false, "error": "..."} for almost every
  // failure, so the HTTP status says nothing. These are the codes that have a
  // better explanation than the raw error string.
  override handleErrors(body: string, status: number) {
    let error = '';
    let needed = '';
    try {
      const parsed = JSON.parse(body);
      error = typeof parsed?.error === 'string' ? parsed.error : '';
      needed = typeof parsed?.needed === 'string' ? parsed.needed : '';
    } catch {
      return undefined;
    }

    switch (error) {
      case 'invalid_auth':
      case 'not_authed':
      case 'token_revoked':
      case 'token_expired':
      case 'account_inactive':
        return {
          type: 'refresh-token' as const,
          value:
            'Slack no longer accepts this connection, please reconnect your Slack workspace.',
        };
      case 'missing_scope':
        return {
          type: 'bad-body' as const,
          value: `Slack is missing a permission${
            needed ? ` (${needed})` : ''
          }. Please reconnect your Slack workspace to grant it.`,
        };
      case 'not_in_channel':
        return {
          type: 'bad-body' as const,
          value:
            'The Slack app is not a member of this channel. Invite it with /invite and try again.',
        };
      case 'channel_not_found':
        return {
          type: 'bad-body' as const,
          value:
            'Slack could not find this channel. It may have been deleted, or it is private and the app has not been invited.',
        };
      case 'is_archived':
        return {
          type: 'bad-body' as const,
          value: 'This Slack channel is archived, please pick another one.',
        };
      case 'ratelimited':
      case 'rate_limited':
        return {
          type: 'retry' as const,
          value: 'Slack is rate limiting us, retrying shortly.',
        };
      default:
        return undefined;
    }
  }

  private isVideo(media: { type?: string; path: string }) {
    return (
      media.type === 'video' ||
      /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(stripQuery(media.path))
    );
  }

  // One call to the Slack Web API. Throws when Slack says `ok: false`, with
  // Slack's own error code in the message - never returns a failed reply.
  private async slackCall<T = any>(
    accessToken: string,
    method: string,
    payload: Record<string, any>,
    encoding: 'json' | 'form' | 'query' = 'json',
    attempt = 0
  ): Promise<T> {
    const query = encoding === 'query';
    const response = await fetch(
      `https://slack.com/api/${method}${
        query ? `?${new URLSearchParams(payload).toString()}` : ''
      }`,
      {
        method: query ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(encoding === 'json'
            ? { 'Content-Type': 'application/json' }
            : encoding === 'form'
            ? { 'Content-Type': 'application/x-www-form-urlencoded' }
            : {}),
        },
        ...(query
          ? {}
          : {
              body:
                encoding === 'json'
                  ? JSON.stringify(payload)
                  : new URLSearchParams(payload).toString(),
            }),
      }
    );

    const text = await response.text().catch(() => '{}');
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { ok: false, error: `http_${response.status}` };
    }

    if (json?.ok === true) {
      return json as T;
    }

    const handled = this.handleErrors(JSON.stringify(json), response.status);
    if ((handled?.type === 'retry' || response.status === 429) && attempt < 2) {
      const wait = Number(response.headers.get('retry-after'));
      await timer(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5000);
      return this.slackCall<T>(accessToken, method, payload, encoding, attempt + 1);
    }

    const message =
      handled?.value ||
      `Slack rejected the request (${method}): ${json?.error || 'unknown error'}`;
    if (handled?.type === 'refresh-token') {
      throw new RefreshToken(this.identifier, text, '{}', message);
    }
    throw new BadBody(this.identifier, text, '{}', message);
  }

  // Uploads the videos with Slack's external upload flow
  // (files.getUploadURLExternal -> POST the bytes -> files.completeUploadExternal),
  // which is what files.uploadV2 does. Slack renders a video as a file, not as
  // an image block, so it can never go through chat.postMessage.
  private async uploadVideos(
    accessToken: string,
    channel: string,
    videos: { path: string }[],
    extra: { thread_ts?: string; initial_comment?: string }
  ) {
    const files: { id: string; title: string }[] = [];

    for (const video of videos) {
      const filename = this.fileName(video.path);
      const size = await this.mediaSize(video.path, this.identifier);

      const { upload_url, file_id } = await this.slackCall<{
        upload_url: string;
        file_id: string;
      }>(
        accessToken,
        'files.getUploadURLExternal',
        { filename, length: String(size) },
        'form'
      );

      // runStreamedUpload re-opens the source stream on every attempt
      await this.runStreamedUpload(async () => {
        const stream = await this.mediaStream(video.path, this.identifier);
        await this.getSsrfSafeAxios().post(upload_url, stream, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(size),
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
      }, this.identifier);

      files.push({ id: file_id, title: filename });
    }

    await this.slackCall(accessToken, 'files.completeUploadExternal', {
      files,
      channel_id: channel,
      ...extra,
    });

    return files;
  }

  private async permalink(accessToken: string, channel: string, ts: string) {
    const { permalink } = await this.slackCall<{ permalink?: string }>(
      accessToken,
      'chat.getPermalink',
      { channel, message_ts: ts },
      'query'
    );
    return permalink || '';
  }

  private fileName(path: string) {
    try {
      return (
        decodeURIComponent(stripQuery(path).split('/').pop() || '') ||
        'video.mp4'
      );
    } catch {
      return 'video.mp4';
    }
  }

  // Shared by post and comment. Text and images go out as one chat.postMessage
  // block message; videos are uploaded as files into that message's thread.
  // Every Slack reply is checked, so a post is only reported as posted when
  // Slack accepted it. A post with only a video has no text to anchor the
  // thread to, so its file name is used as the message text - Slack needs a
  // message ts for comments and the permalink.
  private async send(
    accessToken: string,
    channel: string,
    postDetails: PostDetails,
    integration: Integration,
    threadTs?: string
  ): Promise<{ ts: string; releaseURL: string }> {
    const media = postDetails.media || [];
    const videos = media.filter((m) => this.isVideo(m));
    const images = media.filter((m) => !this.isVideo(m));
    const message =
      postDetails.message?.trim() || images.length > 0
        ? postDetails.message || ''
        : videos.length
        ? this.fileName(videos[0].path)
        : '';

    if (!message.trim() && images.length === 0) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'There is nothing to post to Slack: the message and media are both empty.'
      );
    }

    const { ts, channel: responseChannel } = await this.slackCall<{
      ts: string;
      channel: string;
    }>(accessToken, 'chat.postMessage', {
      channel,
      username: integration.name,
      icon_url: integration.picture,
      // plain-text fallback for notifications
      text: message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      blocks: [
        ...(message.trim()
          ? [{ type: 'section', text: { type: 'mrkdwn', text: message } }]
          : []),
        ...images.map((m) => ({
          type: 'image',
          image_url: m.path,
          alt_text: m.alt || '',
        })),
      ],
    });

    if (videos.length) {
      await this.uploadVideos(accessToken, channel, videos, {
        thread_ts: threadTs || ts,
      });
    }

    return {
      ts,
      releaseURL: await this.permalink(
        accessToken,
        responseChannel || channel,
        ts
      ),
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const channel = firstPost.settings.channel;

    // Join the channel first. Best effort: private channels cannot be joined,
    // and a real problem with the channel resurfaces on the post itself.
    await fetch(`https://slack.com/api/conversations.join`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
      }),
    }).catch(() => undefined);

    const { ts, releaseURL } = await this.send(
      accessToken,
      channel,
      firstPost,
      integration
    );

    return [
      {
        id: firstPost.id,
        postId: ts,
        releaseURL,
        status: 'posted',
      },
    ];
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [commentPost] = postDetails;
    const channel = commentPost.settings.channel;
    const threadTs = lastCommentId || postId;

    const { ts, releaseURL } = await this.send(
      accessToken,
      channel,
      commentPost,
      integration,
      threadTs
    );

    return [
      {
        id: commentPost.id,
        postId: ts,
        releaseURL,
        status: 'posted',
      },
    ];
  }

  async changeProfilePicture(id: string, accessToken: string, url: string) {
    return {
      url,
    };
  }

  async changeNickname(id: string, accessToken: string, name: string) {
    return {
      name,
    };
  }
}
