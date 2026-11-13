import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import {
  BadBody,
  SocialAbstract,
  stripQuery,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { DiscordDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/discord.dto';
import { Tool } from '@hookpost/nestjs-libraries/integrations/tool.decorator';
import FormDataUpload from 'form-data';

// Discord's default per-file upload limit. It was 10 MiB until Discord raised
// it to 20 MiB for everyone on 14 Aug 2026 (docs.discord.com/developers/
// reference, "Uploading Files"); boosted servers allow more. Files above it
// are posted as a link instead of as an attachment.
export const DISCORD_MAX_FILE_BYTES = 20 * 1024 * 1024;

// Discord refuses message content longer than this.
const DISCORD_MAX_CONTENT = 2000;

const toMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// How long the compose-time size check waits for a HEAD before giving up.
const SIZE_CHECK_TIMEOUT_MS = 5000;

// A Discord id (a snowflake): a 64-bit number written in decimal. A channel
// id goes into the API path, so nothing else is ever sent.
const SNOWFLAKE = /^\d{1,20}$/;

const fileName = (path: string) => {
  const raw = stripQuery(path).split('/').pop() || 'file';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

// Discord's own "Request entity too large" (code 40005), as runStreamedUpload
// rethrows it.
const isTooLarge = (err: any) =>
  (err?.details || []).some((d: any) =>
    String(d?.json || '').includes('40005')
  );

// Splits link lines into as few messages as fit Discord's content limit.
const packLines = (lines: string[]) => {
  const out: string[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.length + 1 + line.length <= DISCORD_MAX_CONTENT
    ) {
      out[out.length - 1] = `${last}\n${line}`;
    } else {
      out.push(line);
    }
  }
  return out;
};

export class DiscordProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 5; // Discord has generous rate limits for webhook posting
  identifier = 'discord';
  name = 'Discord';
  isBetweenSteps = false;
  editor = 'markdown' as const;
  scopes = ['identify', 'guilds'];
  maxLength() {
    return 1980;
  }
  dto = DiscordDto;

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    const { access_token, expires_in, refresh_token } = await (
      await this.fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            process.env.DISCORD_CLIENT_ID +
              ':' +
              process.env.DISCORD_CLIENT_SECRET
          ).toString('base64')}`,
        },
      })
    ).json();

    const { application } = await (
      await this.fetch('https://discord.com/api/oauth2/@me', {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json();

    return {
      refreshToken: refresh_token,
      expiresIn: expires_in,
      accessToken: access_token,
      id: '',
      name: application.name,
      picture: '',
      username: '',
    };
  }
  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: `https://discord.com/oauth2/authorize?client_id=${
        process.env.DISCORD_CLIENT_ID
      }&permissions=377957124096&response_type=code&redirect_uri=${encodeURIComponent(
        `${process.env.FRONTEND_URL}/integrations/social/discord`
      )}&integration_type=0&scope=bot+identify+guilds&state=${state}`,
      codeVerifier: makeId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const { access_token, expires_in, refresh_token, scope, guild } = await (
      await this.fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        body: new URLSearchParams({
          code: params.code,
          grant_type: 'authorization_code',
          redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/discord`,
        }),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(
            process.env.DISCORD_CLIENT_ID +
              ':' +
              process.env.DISCORD_CLIENT_SECRET
          ).toString('base64')}`,
        },
      })
    ).json();

    this.checkScopes(this.scopes, scope.split(' '));

    const { application } = await (
      await this.fetch('https://discord.com/api/oauth2/@me', {
        headers: {
          Authorization: `Bearer ${access_token}`,
        },
      })
    ).json();

    return {
      id: guild.id,
      name: application.name,
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresIn: expires_in,
      picture: `https://cdn.discordapp.com/avatars/${application.bot.id}/${application.bot.avatar}.png`,
      username: application.bot.username,
    };
  }

  @Tool({ description: 'Channels', dataSchema: [] })
  async channels(accessToken: string, params: any, id: string) {
    const list = await (
      await this.fetch(`https://discord.com/api/guilds/${id}/channels`, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
        },
      })
    ).json();

    return list
      .filter((p: any) => p.type === 0 || p.type === 5 || p.type === 15)
      .map((p: any) => ({
        id: String(p.id),
        name: p.name,
      }));
  }

  // The server (guild id) a channel is in, read with the bot token; null for
  // a channel outside any server (a DM). A channel the bot cannot see or
  // that does not exist is a BadBody from handleErrors (50001, 10003).
  async channelServer(channel: string): Promise<string | null> {
    const found = await (
      await this.fetch(
        `https://discord.com/api/channels/${channel}`,
        {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
          },
        },
        this.identifier
      )
    ).json();
    return found?.guild_id ? String(found.guild_id) : null;
  }

  // Every message goes out through Hookpost's one bot, which is in every
  // server that added it: a channel id alone would reach any of them,
  // another workspace's included. So a post or reply goes only to a channel
  // of the server this integration connected (its internalId is the guild
  // id). Returns the channel id; anything else is a BadBody, before a
  // message is sent.
  async channelInServer(server: string, channel: unknown): Promise<string> {
    const id = typeof channel === 'string' ? channel.trim() : '';
    if (!SNOWFLAKE.test(id)) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The Discord channel must be a channel id (digits only).'
      );
    }
    if ((await this.channelServer(id)) !== String(server)) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'That Discord channel is not in the server this channel is connected to. Nothing was posted.'
      );
    }
    return id;
  }

  // A file over Discord's limit is posted as a link to the file instead of as
  // an attachment (Discord unfurls a direct media link into a preview), so
  // the post still goes out. Only a local file (no URL to link)
  // over the limit still fails. Transcoding is not an option: the worker image
  // ships without ffmpeg. The link must outlive the 7-day video purge, so
  // scripts/cleanup-expired-media.js keeps every file a Discord post uses.
  private splitBySize(media: PostDetails['media'], sizes: number[]) {
    const attach: { path: string; size: number }[] = [];
    const link: string[] = [];
    (media || []).forEach((item, i) => {
      if (sizes[i] <= DISCORD_MAX_FILE_BYTES) {
        attach.push({ path: item.path, size: sizes[i] });
        return;
      }
      if (item.path.indexOf('http') !== 0) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          `"${fileName(item.path)}" is ${toMb(
            sizes[i]
          )}, but Discord only accepts files up to ${toMb(
            DISCORD_MAX_FILE_BYTES
          )}. Please compress or shorten it (or attach a smaller file) and try again.`
        );
      }
      link.push(item.path);
    });
    return { attach, link };
  }

  // Compose time (/posts/valid): says which files will go out as a link, so
  // the user can swap in a smaller file first. Never blocks the save, because
  // the post publishes either way. A size that can't be read (HEAD refused,
  // slow CDN, a local path) says nothing.
  override async mediaNotices(
    posts: Array<ValidityMedia[]>
  ): Promise<string[]> {
    const items = (posts || [])
      .flat()
      .filter((item) => item?.path?.indexOf('http') === 0);

    const sizes = await Promise.all(
      items.map(
        (item) =>
          new Promise<number>((resolve) => {
            const timer = setTimeout(() => resolve(0), SIZE_CHECK_TIMEOUT_MS);
            this.mediaSize(item.path, this.identifier)
              .catch(() => 0)
              .then((size) => {
                clearTimeout(timer);
                resolve(size);
              });
          })
      )
    );

    return items
      .map((item, i) => ({ path: item.path, size: sizes[i] }))
      .filter((item) => item.size > DISCORD_MAX_FILE_BYTES)
      .map(
        (item) =>
          `"${fileName(item.path)}" is ${toMb(
            item.size
          )}, over Discord's ${toMb(
            DISCORD_MAX_FILE_BYTES
          )} upload limit, so it will be posted as a link to the file instead of as an attachment.`
      );
  }

  // Sends one message: the text, the files that fit as attachments, and the
  // links of the files that don't. When text plus links would pass Discord's
  // 2,000 characters, the links follow in their own message(s). Returns the
  // first message, which is the one the post points to.
  private async sendMessage(
    channel: string,
    content: string,
    attach: { path: string; size: number }[],
    link: string[]
  ) {
    const inline = [content, ...link].filter(Boolean).join('\n');
    const fitsInline = inline.length <= DISCORD_MAX_CONTENT;
    const first = await this.sendOne(
      channel,
      fitsInline ? inline : content,
      attach
    );
    if (!fitsInline) {
      // The post already exists: a failed follow-up is logged, never thrown,
      // so a Temporal retry can't post the text a second time.
      for (const extra of packLines(link)) {
        try {
          await this.sendOne(channel, extra, []);
        } catch (err) {
          console.error(
            `Discord: posted message ${first?.id} but not its file links`,
            err
          );
        }
      }
    }
    return first;
  }

  // Builds the multipart message and streams each attachment straight from its
  // source (size from a HEAD request) so files are never buffered in memory.
  // runStreamedUpload rebuilds the whole form per attempt (a consumed stream
  // can't be replayed) and keeps handleErrors classification.
  private async sendOne(
    channel: string,
    content: string,
    attach: { path: string; size: number }[]
  ) {
    return this.runStreamedUpload(async () => {
      const form = new FormDataUpload();
      form.append(
        'payload_json',
        JSON.stringify({
          content,
          attachments: attach.map((p, index) => ({
            id: index,
            description: `Picture ${index}`,
            filename: p.path.split('/').pop(),
          })),
        })
      );

      let index = 0;
      for (const item of attach) {
        const stream = await this.mediaStream(item.path, this.identifier);
        form.append(`files[${index}]`, stream, {
          filename: item.path.split('/').pop(),
          knownLength: item.size,
        });
        index++;
      }

      const { data } = await this.getSsrfSafeAxios().post(
        `https://discord.com/api/channels/${channel}/messages`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
          },
        }
      );

      return data;
    }, this.identifier);
  }

  private async sendMessageWithMedia(
    channel: string,
    message: string,
    media: PostDetails['media']
  ) {
    const content = message.replace(/\[\[\[(@.*?)]]]/g, (match, p1) => {
      return `<${p1}>`;
    });

    const sizes: number[] = [];
    for (const item of media || []) {
      sizes.push(await this.mediaSize(item.path, this.identifier));
    }
    const { attach, link } = this.splitBySize(media, sizes);

    try {
      return await this.sendMessage(channel, content, attach, link);
    } catch (err) {
      // Discord refused the upload as too large (40005) although every file
      // is under the limit we know of, so nothing was posted: send the same
      // message with every file as a link. A local file can't be linked.
      const linkable = attach.every((a) => a.path.indexOf('http') === 0);
      if (!attach.length || !isTooLarge(err) || !linkable) {
        throw err;
      }
      return this.sendMessage(
        channel,
        content,
        [],
        [...attach.map((a) => a.path), ...link]
      );
    }
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const channel = await this.channelInServer(id, firstPost.settings?.channel);

    const data = await this.sendMessageWithMedia(
      channel,
      firstPost.message,
      firstPost.media
    );

    return [
      {
        id: firstPost.id,
        releaseURL: `https://discord.com/channels/${id}/${channel}/${data.id}`,
        postId: data.id,
        status: 'success',
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
    const channel = await this.channelInServer(
      id,
      commentPost.settings?.channel
    );

    // For Discord, we create a thread from the original message for comments
    // If we don't have a thread yet, create one
    let threadChannel = channel;

    // Create thread if this is the first comment
    if (!lastCommentId) {
      const { id: threadId } = await (
        await this.fetch(
          `https://discord.com/api/channels/${channel}/messages/${postId}/threads`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'Thread',
              auto_archive_duration: 1440,
            }),
          }
        )
      ).json();
      threadChannel = threadId;
    }

    const data = await this.sendMessageWithMedia(
      threadChannel,
      commentPost.message,
      commentPost.media
    );

    return [
      {
        id: commentPost.id,
        releaseURL: `https://discord.com/channels/${id}/${threadChannel}/${data.id}`,
        postId: data.id,
        status: 'success',
      },
    ];
  }

  async changeNickname(id: string, accessToken: string, name: string) {
    await (
      await this.fetch(`https://discord.com/api/guilds/${id}/members/@me`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          nick: name,
        }),
      })
    ).json();

    return {
      name,
    };
  }

  override async mention(
    token: string,
    data: { query: string },
    id: string,
    integration: Integration
  ) {
    const allRoles = await (
      await this.fetch(`https://discord.com/api/guilds/${id}/roles`, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
          'Content-Type': 'application/json',
        },
      })
    ).json();

    const matching = allRoles
      .filter((role: any) =>
        role.name.toLowerCase().includes(data.query.toLowerCase())
      )
      .filter((f: any) => f.name !== '@everyone' && f.name !== '@here');

    const list = await (
      await this.fetch(
        `https://discord.com/api/guilds/${id}/members/search?query=${data.query}`,
        {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN_ID}`,
            'Content-Type': 'application/json',
          },
        }
      )
    ).json();

    return [
      ...[
        {
          id: String('here'),
          label: 'here',
          image: '',
          doNotCache: true,
        },
        {
          id: String('everyone'),
          label: 'everyone',
          image: '',
          doNotCache: true,
        },
      ].filter((role: any) => {
        return role.label.toLowerCase().includes(data.query.toLowerCase());
      }),
      ...matching.map((p: any) => ({
        id: String('&' + p.id),
        label: p.name.split('@')[1],
        image: '',
        doNotCache: true,
      })),
      ...list.map((p: any) => ({
        id: String(p.user.id),
        label: p.user.global_name || p.user.username,
        image: `https://cdn.discordapp.com/avatars/${p.user.id}/${p.user.avatar}.png`,
      })),
    ];
  }

  mentionFormat(idOrHandle: string, name: string) {
    if (name === '@here' || name === '@everyone') {
      return name;
    }
    return `[[[@${idOrHandle.replace('@', '')}]]]`;
  }

  override handleErrors(
    body: string
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    if (body.includes('50001')) {
      return {
        type: 'bad-body',
        value: "Bot doesn't have access to this channel",
      };
    }

    if (body.includes('50013')) {
      return {
        type: 'bad-body',
        value: 'Bot lacks permission to send messages in this channel',
      };
    }

    if (body.includes('10003')) {
      return {
        type: 'bad-body',
        value: 'Channel no longer exists',
      };
    }

    if (body.includes('40005')) {
      return {
        type: 'bad-body',
        value: `An attachment is larger than Discord's ${toMb(
          DISCORD_MAX_FILE_BYTES
        )} limit. Please use a smaller file.`,
      };
    }

    if (body.includes('20028')) {
      return {
        type: 'retry',
        value: 'Rate limited by Discord',
      };
    }

    return undefined;
  }
}
