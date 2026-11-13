import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import dayjs from 'dayjs';
import {
  BadBody,
  SocialAbstract,
  stripQuery,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
//@ts-ignore
import mime from 'mime';
import TelegramBot from 'node-telegram-bot-api';
import { Integration } from '@prisma/client';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { timer } from '@hookpost/helpers/utils/timer';
import { statSync } from 'fs';

// Added to support local storage posting
const frontendURL = process.env.FRONTEND_URL || 'http://localhost:5000';
const mediaStorage = process.env.STORAGE_PROVIDER || 'local';

const MB = 1024 * 1024;

// https://core.telegram.org/bots/api#sending-files
// Telegram fetches a file given by URL itself, up to 5 MB for photos and
// 20 MB for anything else. Uploaded files may be 10 MB (photos) and 50 MB.
export const TELEGRAM_URL_PHOTO_LIMIT = 5 * MB;
export const TELEGRAM_URL_FILE_LIMIT = 20 * MB;
export const TELEGRAM_UPLOAD_PHOTO_LIMIT = 10 * MB;
export const TELEGRAM_UPLOAD_FILE_LIMIT = 50 * MB;
// sendMessage text is 1-4096 characters, a media caption 0-1024, both counted
// after entity parsing (so tags don't count).
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;
// sendMediaGroup takes 2-10 items.
const TELEGRAM_ALBUM_LIMIT = 10;

// How long a /connect command, and the chat it resolved to, stay claimable.
const CONNECT_TTL_SECONDS = 15 * 60;
// How long the compose-time size check waits for a HEAD before giving up.
const SIZE_CHECK_TIMEOUT_MS = 5000;
// A 429 that asks us to wait longer than this is not waited out in-process.
const MAX_RETRY_AFTER_SECONDS = 60;

const toMb = (bytes: number) => `${(bytes / MB).toFixed(1)} MB`;

const fileName = (path: string) => {
  const raw = stripQuery(path).split('/').pop() || 'file';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

const botName = () => (process.env.TELEGRAM_BOT_NAME || '').replace(/^@/, '');
const botHandle = () => (botName() ? `@${botName()}` : 'the Hookpost bot');

// Never log a node-telegram-bot-api error object as is: its `response` carries
// the request, whose URL holds the bot token
// (https://api.telegram.org/bot<token>/method).
export const describeTelegramError = (err: any): string => {
  const body = err?.response?.body;
  if (body && typeof body === 'object' && body.error_code) {
    return `${body.error_code} ${body.description || ''}`.trim();
  }
  return String(err?.message || err || 'Unknown error').replace(
    /bot\d+:[A-Za-z0-9_-]+/g,
    'bot<redacted>'
  );
};

const telegramBody = (
  err: any
):
  | {
      error_code: number;
      description?: string;
      parameters?: { retry_after?: number; migrate_to_chat_id?: number };
    }
  | undefined => {
  const body = err?.response?.body;
  return err?.code === 'ETELEGRAM' && body && typeof body === 'object'
    ? body
    : undefined;
};

const cleanDescription = (description?: string) =>
  (description || '').replace(/^(Bad Request|Forbidden|Unauthorized): /, '');

// Telegram could not fetch the file we gave it by URL. An upload of the same
// file can still work.
const isUrlFetchError = (description: string) =>
  /failed to get HTTP URL content|wrong type of the web page content|wrong file identifier\/HTTP URL specified|wrong remote file identifier|file is too big/i.test(
    description
  );

// Telegram could not use an image as a photo (format or dimensions). The same
// file goes through as a document.
const isPhotoProcessError = (description: string) =>
  /PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|PHOTO_EXT_INVALID|PHOTO_SAVE_FILE_INVALID|PHOTO_INVALID/i.test(
    description
  );

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const escapeAttribute = (text: string) =>
  escapeHtml(text).replace(/"/g, '&quot;');

/**
 * Converts the post body into Telegram's HTML parse mode.
 *
 * The body arrives through stripHtmlValidation('html', ...), which keeps only
 * the editor's structural tags (p, strong, u, a, ul, li, h1-h3) and has
 * already DECODED the text's entities: a user who typed "a < b & c" hands us
 * a raw "<" and "&", and Telegram refuses those with "can't parse entities".
 * So the known editor tags are rebuilt, and everything else - text, and any
 * tag-looking text the user typed - is escaped. Unbalanced tags are closed,
 * since Telegram rejects those too.
 */
export const toTelegramHtml = (message: string): string => {
  const out: string[] = [];
  const open: string[] = [];

  const openTag = (tag: string, html = `<${tag}>`) => {
    open.push(tag);
    out.push(html);
  };
  const closeTag = (tag: string) => {
    const at = open.lastIndexOf(tag);
    if (at === -1) {
      return;
    }
    const closed = open.splice(at);
    for (let i = closed.length - 1; i >= 0; i--) {
      out.push(`</${closed[i]}>`);
    }
    // re-open the formatting that was nested inside the closed tag (a link
    // can't be re-opened without its href, its remaining text stays plain)
    for (const inner of closed.slice(1)) {
      if (inner !== 'a') {
        openTag(inner);
      }
    }
  };

  // exactly the tags stripHtmlValidation('html') keeps, plus <br>
  const tags = /<(\/?)(p|strong|u|a|ul|li|h[1-3]|br)\b([^<>]*)>/gi;
  let last = 0;
  let listItem = 0;
  for (const match of (message || '').matchAll(tags)) {
    out.push(escapeHtml(message.slice(last, match.index)));
    last = (match.index || 0) + match[0].length;
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();

    if (tag === 'br') {
      out.push('\n');
    } else if (tag === 'p') {
      // a list item's own line break ends its paragraph
      if (closing && !listItem) {
        out.push('\n');
      }
    } else if (tag === 'li') {
      listItem = Math.max(0, listItem + (closing ? -1 : 1));
      out.push(closing ? '\n' : '- ');
    } else if (tag === 'ul') {
      // the items carry their own markers and line breaks
    } else if (/^h[1-3]$/.test(tag)) {
      if (closing) {
        closeTag('b');
        out.push('\n');
      } else {
        openTag('b');
      }
    } else if (tag === 'strong') {
      closing ? closeTag('b') : openTag('b');
    } else if (tag === 'u') {
      closing ? closeTag('u') : openTag('u');
    } else if (tag === 'a') {
      if (closing) {
        closeTag('a');
      } else {
        const href = match[3].match(/href\s*=\s*"([^"]*)"/i)?.[1] || '';
        if (/^(https?:\/\/|tg:\/\/|mailto:)/i.test(href.trim())) {
          openTag('a', `<a href="${escapeAttribute(href.trim())}">`);
        }
      }
    }
  }
  out.push(escapeHtml((message || '').slice(last)));
  for (let i = open.length - 1; i >= 0; i--) {
    out.push(`</${open[i]}>`);
  }

  return out.join('').trim();
};

// The text Telegram counts against its limits: tags removed, entities decoded.
export const telegramTextLength = (html: string) => toPlainText(html).length;

export const toPlainText = (html: string) =>
  (html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

type MediaKind = 'photo' | 'video' | 'animation' | 'document';

type ResolvedMedia = {
  kind: MediaKind;
  source: string | Buffer;
  fileOptions: { filename: string; contentType: string };
};

type SendState = {
  chatId: string;
  upload: boolean;
  plain: boolean;
  asDocument: boolean;
};

type Media = NonNullable<PostDetails['media']>[number];

type Step =
  | { type: 'text'; text: string }
  | { type: 'single'; media: Media; caption?: string }
  | { type: 'group'; media: Media[]; caption?: string };

const mediaKind = (path: string): { kind: MediaKind; contentType: string } => {
  const contentType = mime.getType(stripQuery(path)) || 'application/octet-stream';
  if (contentType === 'image/gif') {
    return { kind: 'animation', contentType };
  }
  if (contentType.startsWith('image/')) {
    return { kind: 'photo', contentType };
  }
  if (contentType.startsWith('video/')) {
    return { kind: 'video', contentType };
  }
  return { kind: 'document', contentType };
};

export class TelegramProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Telegram has moderate bot API limits
  identifier = 'telegram';
  name = 'Telegram';
  isBetweenSteps = false;
  isWeb3 = true;
  scopes = [] as string[];
  editor = 'html' as const;
  maxLength(additionalSettings?: any, settings?: any, hasMedia?: boolean) {
    // A caption longer than 1024 characters is sent as its own message right
    // after the media (see buildSteps), so 4096 holds with media too.
    return TELEGRAM_TEXT_LIMIT;
  }

  // Created on first use, not at import: the token is read when a request is
  // made, so a process whose env is loaded after this module still works.
  private static _bot: TelegramBot | undefined;
  private static _botToken: string | undefined;
  protected get bot(): TelegramBot {
    const token = process.env.TELEGRAM_TOKEN || '';
    if (!TelegramProvider._bot || TelegramProvider._botToken !== token) {
      TelegramProvider._bot = new TelegramBot(token);
      TelegramProvider._botToken = token;
    }
    return TelegramProvider._bot;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
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
    const state = makeId(17);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  /**
   * `code` is the one-time token getBotId handed to the browser once the
   * user's /connect command showed up in their chat - never a raw chat id.
   * Accepting a chat id from the browser let anyone connect (and then post
   * to) any chat the shared Hookpost bot is in, other customers' included.
   */
  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const code = String(params.code || '');
    const key = `telegram:chat:${code}`;
    const chatId = /^[A-Za-z0-9]{16,64}$/.test(code)
      ? await ioRedis.get(key)
      : null;
    if (!chatId) {
      return 'This Telegram connection has expired. Open Add Channel, choose Telegram and send the /connect command again.';
    }
    await ioRedis.del(key);

    let chat: TelegramBot.Chat;
    try {
      chat = await this.bot.getChat(chatId);
    } catch (err) {
      console.error('[telegram] getChat failed:', describeTelegramError(err));
      return `Telegram couldn't open this chat (${cleanDescription(
        telegramBody(err)?.description
      ) || 'no answer'}). Make sure ${botHandle()} is still in it, then connect again.`;
    }
    if (!chat?.id) {
      return 'No chat found';
    }

    const rights = await this.checkPostingRights(chat);
    if (rights) {
      return rights;
    }

    let photo = '';
    if (chat?.photo?.big_file_id) {
      try {
        photo = await this.bot.getFileLink(chat.photo.big_file_id);
      } catch (err) {
        console.log(
          '[telegram] could not read the chat photo:',
          describeTelegramError(err)
        );
      }
    }

    // id is chat.username for public groups/channels and chat.id for private
    // ones; the token is always the numeric chat id.
    return {
      id: String(chat.username ? chat.username : chat.id),
      name:
        chat.title ||
        [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
        chat.username ||
        '',
      accessToken: String(chat.id),
      refreshToken: '',
      expiresIn: dayjs().add(200, 'year').unix() - dayjs().unix(),
      picture: photo || '',
      username: chat.username || '',
    };
  }

  // Returns a message when the bot can't post in this chat, so the connect
  // fails with something to act on instead of every post failing later.
  private async checkPostingRights(
    chat: TelegramBot.Chat
  ): Promise<string | undefined> {
    let member: TelegramBot.ChatMember;
    try {
      const me = await this.bot.getMe();
      member = await this.bot.getChatMember(chat.id, me.id);
    } catch (err) {
      // Not decisive: getChat just worked, the first post will tell.
      console.log(
        '[telegram] could not check the bot rights:',
        describeTelegramError(err)
      );
      return undefined;
    }

    if (chat.type === 'channel') {
      const isAdmin =
        member.status === 'creator' || member.status === 'administrator';
      if (!isAdmin || (member as any).can_post_messages === false) {
        return `${botHandle()} has to be an admin of this channel with the "Post messages" permission. Give it that permission in the channel settings, then connect again.`;
      }
      return undefined;
    }

    if (member.status === 'left' || member.status === 'kicked') {
      return `${botHandle()} is not a member of this chat. Add it to the group, then connect again.`;
    }
    if (member.status === 'restricted' && member.can_send_messages === false) {
      return `${botHandle()} is not allowed to send messages in this group. Lift that restriction, then connect again.`;
    }
    return undefined;
  }

  /**
   * Polled by the connect dialog every 2 seconds. Every /connect command found
   * in the bot's updates is parked in Redis under its word, because the
   * `offset` one dialog sends confirms - and so deletes - updates for every
   * other dialog polling at the same time: without this, two people
   * connecting at once could swallow each other's command and leave one of
   * them waiting forever.
   */
  async getBotId(query: { id?: number | string; word: string }) {
    const word = String(query?.word || '').trim();
    if (!/^[A-Za-z0-9]{4,64}$/.test(word)) {
      return {};
    }

    let updates: TelegramBot.Update[] = [];
    try {
      updates = await this.bot.getUpdates({
        ...(query.id ? { offset: Number(query.id) } : {}),
        // message is for groups and private chats, channel_post for channels
        allowed_updates: ['message', 'channel_post'],
        timeout: 0,
      });
    } catch (err) {
      // 409 = a webhook is set on the bot or another getUpdates is running,
      // 401 = the token is wrong. Either way the dialog can't succeed.
      console.error('[telegram] getUpdates failed:', describeTelegramError(err));
      return {
        error: `Couldn't read the bot's messages from Telegram (${describeTelegramError(
          err
        )}). Please try again in a minute.`,
      };
    }

    for (const update of updates || []) {
      const message = update?.message || update?.channel_post;
      const found = (message?.text || '').match(
        /^\/connect(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9]+)\s*$/i
      );
      if (found && message?.chat?.id) {
        await ioRedis.set(
          `telegram:connect:${found[1]}`,
          JSON.stringify({
            chatId: message.chat.id,
            messageId: message.message_id,
          }),
          'EX',
          CONNECT_TTL_SECONDS
        );
      }
    }

    const key = `telegram:connect:${word}`;
    const parked = await ioRedis.get(key);
    if (parked) {
      await ioRedis.del(key);
      const { chatId, messageId } = JSON.parse(parked);
      await this.tidyConnectMessage(chatId, messageId);

      const token = makeId(32);
      await ioRedis.set(
        `telegram:chat:${token}`,
        String(chatId),
        'EX',
        CONNECT_TTL_SECONDS
      );
      return { chatId: token };
    }

    return updates?.length
      ? { lastChatId: updates[updates.length - 1].update_id + 1 }
      : {};
  }

  // Deletes the /connect command and confirms in the chat. Best effort: a
  // failure here must not stop the connection.
  private async tidyConnectMessage(chatId: number, messageId?: number) {
    try {
      const botId = (await this.bot.getMe()).id;
      const canDelete = await this.botIsAdmin(chatId, botId);

      if (!canDelete) {
        await this.bot.sendMessage(
          chatId,
          "Connection Successful. I don't have admin privileges to delete these messages, please go ahead and remove them yourself.",
          { disable_notification: true }
        );
        return;
      }

      if (messageId) {
        await this.bot.deleteMessage(chatId, messageId);
      }
      const success = await this.bot.sendMessage(
        chatId,
        'Connection Successful. Message will be deleted in 10 seconds.',
        { disable_notification: true }
      );
      setTimeout(() => {
        this.bot
          .deleteMessage(chatId, success.message_id)
          .catch((err) =>
            console.log(
              '[telegram] could not delete the confirmation:',
              describeTelegramError(err)
            )
          );
      }, 10000).unref?.();
    } catch (err) {
      console.log(
        '[telegram] could not tidy the /connect message:',
        describeTelegramError(err)
      );
    }
  }

  // Compose-time checks, so a post Telegram will refuse can't be scheduled.
  override async checkValidity(
    posts: Array<ValidityMedia[]>
  ): Promise<string | true> {
    for (const media of posts || []) {
      const items = (media || []).filter((m) => m?.path);
      if (items.length > 1) {
        const kinds = items.map((m) => mediaKind(m.path).kind);
        const visual = kinds.filter(
          (k) => k === 'photo' || k === 'video' || k === 'animation'
        ).length;
        if (visual > 0 && visual < kinds.length) {
          return 'Telegram can’t put audio or other files in the same post as photos and videos. Post them separately.';
        }
      }
    }

    const remote = (posts || [])
      .flat()
      .filter((item) => item?.path?.indexOf('http') === 0);
    const sizes = await Promise.all(
      remote.map(
        (item) =>
          new Promise<number>((resolve) => {
            const t = setTimeout(() => resolve(0), SIZE_CHECK_TIMEOUT_MS);
            this.mediaSize(item.path, this.identifier)
              .catch(() => 0)
              .then((size) => {
                clearTimeout(t);
                resolve(size);
              });
          })
      )
    );
    const tooBig = remote.findIndex(
      (_, i) => sizes[i] > TELEGRAM_UPLOAD_FILE_LIMIT
    );
    if (tooBig > -1) {
      return `"${fileName(remote[tooBig].path)}" is ${toMb(
        sizes[tooBig]
      )}. Telegram bots can send files up to ${toMb(
        TELEGRAM_UPLOAD_FILE_LIMIT
      )}, please use a smaller file.`;
    }

    return true;
  }

  private async sizeOf(path: string): Promise<number | undefined> {
    try {
      return path.indexOf('http') === 0
        ? await this.mediaSize(path, this.identifier)
        : statSync(path).size;
    } catch {
      return undefined;
    }
  }

  private async download(path: string): Promise<Buffer> {
    const stream = await this.mediaStream(path, this.identifier);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > TELEGRAM_UPLOAD_FILE_LIMIT) {
        stream.destroy();
        throw this.tooBig(path, total);
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private tooBig(path: string, size: number) {
    return new BadBody(
      this.identifier,
      '{}',
      Buffer.from('{}'),
      `"${fileName(path)}" is ${toMb(size)}. Telegram bots can send files up to ${toMb(
        TELEGRAM_UPLOAD_FILE_LIMIT
      )}, please use a smaller file.`
    );
  }

  /**
   * Decides how a file reaches Telegram. By URL when Telegram's own download
   * limits allow it (5 MB photos, 20 MB others), uploaded otherwise (10 MB
   * photos, 50 MB others) - before, every file went by URL, so any video over
   * 20 MB failed with "Telegram could not download your media file".
   */
  private async resolveMedia(
    media: Media,
    state: SendState,
    inAlbum: boolean
  ): Promise<ResolvedMedia> {
    let path = media.path;
    if (mediaStorage === 'local' && path.startsWith(frontendURL)) {
      path = path.replace(frontendURL, '');
    }
    const { kind: detected, contentType } = mediaKind(path);
    let kind: MediaKind = state.asDocument && !inAlbum ? 'document' : detected;
    const fileOptions = { filename: fileName(path), contentType };
    const remote = path.indexOf('http') === 0;
    const size = await this.sizeOf(path);

    if (size !== undefined && size > TELEGRAM_UPLOAD_FILE_LIMIT) {
      throw this.tooBig(path, size);
    }
    if (kind === 'photo' && size !== undefined && size > TELEGRAM_UPLOAD_PHOTO_LIMIT) {
      if (inAlbum) {
        throw new BadBody(
          this.identifier,
          '{}',
          Buffer.from('{}'),
          `"${fileName(path)}" is ${toMb(size)}, over Telegram’s ${toMb(
            TELEGRAM_UPLOAD_PHOTO_LIMIT
          )} photo limit. Use a smaller image, or post it on its own to send it as a file.`
        );
      }
      kind = 'document';
    }

    if (!remote) {
      return { kind, source: path, fileOptions };
    }

    const urlLimit =
      kind === 'photo' ? TELEGRAM_URL_PHOTO_LIMIT : TELEGRAM_URL_FILE_LIMIT;
    const upload = state.upload || (size !== undefined && size > urlLimit);
    return {
      kind,
      source: upload ? await this.download(path) : path,
      fileOptions,
    };
  }

  // A post is one or more Telegram calls: the text alone, one file with the
  // text as caption, or albums of up to 10. A caption over Telegram's 1024
  // characters goes out as its own message right after the media instead of
  // failing the post with "message caption is too long".
  private buildSteps(message: PostDetails, text: string): Step[] {
    const media = (message.media || []).filter((m) => m?.path);
    if (!media.length) {
      return [{ type: 'text', text }];
    }

    const captionFits = telegramTextLength(text) <= TELEGRAM_CAPTION_LIMIT;
    const caption = captionFits ? text : undefined;
    const steps: Step[] = [];

    if (media.length === 1) {
      steps.push({ type: 'single', media: media[0], caption });
    } else {
      for (let i = 0; i < media.length; i += TELEGRAM_ALBUM_LIMIT) {
        const chunk = media.slice(i, i + TELEGRAM_ALBUM_LIMIT);
        const first = i === 0 ? caption : undefined;
        steps.push(
          chunk.length === 1
            ? { type: 'single', media: chunk[0], caption: first }
            : { type: 'group', media: chunk, caption: first }
        );
      }
    }

    if (!captionFits && toPlainText(text).trim()) {
      steps.push({ type: 'text', text });
    }
    return steps;
  }

  private async runStep(
    step: Step,
    state: SendState,
    replyTo?: number
  ): Promise<number> {
    const bot: any = this.bot;
    const format = (html?: string) =>
      html === undefined || html === ''
        ? {}
        : state.plain
        ? { caption: toPlainText(html) }
        : { caption: html, parse_mode: 'HTML' };
    const reply = replyTo
      ? {
          reply_parameters: {
            message_id: replyTo,
            allow_sending_without_reply: true,
          },
        }
      : {};

    if (step.type === 'text') {
      const response = await bot.sendMessage(
        state.chatId,
        state.plain ? toPlainText(step.text) : step.text,
        { ...(state.plain ? {} : { parse_mode: 'HTML' }), ...reply }
      );
      return response.message_id;
    }

    if (step.type === 'single') {
      const media = await this.resolveMedia(step.media, state, false);
      const options = { ...format(step.caption), ...reply };
      const method =
        media.kind === 'photo'
          ? 'sendPhoto'
          : media.kind === 'video'
          ? 'sendVideo'
          : media.kind === 'animation'
          ? 'sendAnimation'
          : 'sendDocument';
      const response = await bot[method](
        state.chatId,
        media.source,
        media.kind === 'video' ? { ...options, supports_streaming: true } : options,
        media.fileOptions
      );
      return response.message_id;
    }

    const resolved = await Promise.all(
      step.media.map((m) => this.resolveMedia(m, state, true))
    );
    // an album of photos/videos can't hold documents, and GIFs go in as
    // photos (sendMediaGroup has no animation type)
    const types = resolved.map((m) =>
      m.kind === 'document' ? 'document' : m.kind === 'video' ? 'video' : 'photo'
    );
    if (types.includes('document') && types.some((t) => t !== 'document')) {
      throw new BadBody(
        this.identifier,
        '{}',
        Buffer.from('{}'),
        'Telegram can’t put audio or other files in the same post as photos and videos. Post them separately.'
      );
    }
    const album = resolved.map((m, index) => ({
      type: types[index],
      media: m.source,
      fileOptions: m.fileOptions,
      ...(index === 0 ? format(step.caption) : {}),
    }));
    const response = await bot.sendMediaGroup(state.chatId, album, reply);
    return response[0].message_id;
  }

  // Runs one step, recovering from what Telegram says can be recovered from.
  // Nothing was sent when Telegram answers with an error, so every retry here
  // is safe.
  private async runStepWithRecovery(
    step: Step,
    state: SendState,
    replyTo?: number
  ): Promise<number> {
    let waits = 0;
    let migrated = false;
    for (;;) {
      try {
        return await this.runStep(step, state, replyTo);
      } catch (err: any) {
        const body = telegramBody(err);
        const description = cleanDescription(body?.description);

        if (body?.error_code === 429 && waits < 3) {
          const retryAfter = Number(body.parameters?.retry_after || 1);
          if (retryAfter <= MAX_RETRY_AFTER_SECONDS) {
            waits++;
            await timer(retryAfter * 1000 + 250);
            continue;
          }
        }

        // the group was upgraded to a supergroup, which has a new id
        const migrateTo = body?.parameters?.migrate_to_chat_id;
        if (migrateTo && !migrated) {
          migrated = true;
          state.chatId = String(migrateTo);
          continue;
        }

        if (body?.error_code === 400) {
          if (/can't parse entities/i.test(description) && !state.plain) {
            state.plain = true;
            continue;
          }
          if (isUrlFetchError(description) && !state.upload && this.hasRemoteMedia(step)) {
            state.upload = true;
            continue;
          }
          if (
            isPhotoProcessError(description) &&
            !state.asDocument &&
            step.type === 'single'
          ) {
            state.asDocument = true;
            continue;
          }
        }

        throw this.toFailure(err);
      }
    }
  }

  private hasRemoteMedia(step: Step) {
    if (step.type === 'single') {
      return step.media.path.indexOf('http') === 0;
    }
    if (step.type === 'group') {
      return step.media.some((m) => m.path.indexOf('http') === 0);
    }
    return false;
  }

  // Turns a Telegram error into what the post workflow understands: BadBody
  // for a definitive refusal (the post is marked failed with this message and
  // not retried), a plain Error for anything whose outcome is unknown.
  private toFailure(err: any): Error {
    if (err instanceof BadBody) {
      return err;
    }
    const body = telegramBody(err);
    const fail = (message: string) =>
      new BadBody(
        this.identifier,
        JSON.stringify(body || { message: describeTelegramError(err) }),
        Buffer.from(JSON.stringify(body || {})),
        message
      );

    if (!body) {
      if (/Token not provided/i.test(String(err?.message))) {
        return fail(
          'Telegram posting is not set up on this Hookpost server (no bot token). Please contact support.'
        );
      }
      // network error or an unreadable answer: the post may or may not have
      // gone out, let the workflow decide
      return new Error(`Telegram: ${describeTelegramError(err)}`);
    }

    const description = cleanDescription(body.description);
    switch (body.error_code) {
      case 400:
        if (/chat not found/i.test(description)) {
          return fail(
            `Telegram can't find this channel or group. It may have been deleted, or ${botHandle()} was removed from it. Add the bot back, then reconnect the channel.`
          );
        }
        if (isUrlFetchError(description)) {
          return fail(
            'Telegram could not download your media file, please check the file and try again'
          );
        }
        if (/message is too long/i.test(description)) {
          return fail(
            `This post is over Telegram's ${TELEGRAM_TEXT_LIMIT.toLocaleString(
              'en-US'
            )}-character limit. Shorten it and try again.`
          );
        }
        if (
          /not enough rights|have no rights|need administrator rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED/i.test(
            description
          )
        ) {
          return fail(
            `${botHandle()} doesn't have permission to post this here (${description}). Give it the permission in the chat settings, then retry.`
          );
        }
        return fail(`Telegram rejected the post: ${description}`);
      case 401:
      case 404:
        return fail(
          `Hookpost's Telegram bot is not set up correctly (Telegram answered: ${description}). Please contact support.`
        );
      case 403:
        return fail(
          `${botHandle()} can't post here any more (${description}). Add it back as an admin with permission to post messages, then retry.`
        );
      case 429:
        return fail(
          'Telegram is limiting how fast the bot can post. Please try again in a few minutes.'
        );
      default:
        return new Error(`Telegram: ${describeTelegramError(err)}`);
    }
  }

  // Sends a post (or a reply) and returns the first message, which is what the
  // post links to. Once that first message is live, a failing follow-up (the
  // second album, or a long caption's text) can't fail the post: it would be
  // marked failed - or retried and duplicated - while it is visible.
  private async sendMessage(
    accessToken: string,
    message: PostDetails,
    replyToMessageId?: number
  ): Promise<{ messageId: number; chatId: string }> {
    const state: SendState = {
      chatId: accessToken,
      upload: false,
      plain: false,
      asDocument: false,
    };
    const steps = this.buildSteps(message, toTelegramHtml(message.message || ''));

    let first: number | undefined;
    for (const step of steps) {
      if (first === undefined) {
        first = await this.runStepWithRecovery(step, state, replyToMessageId);
        continue;
      }
      try {
        await this.runStepWithRecovery(step, state);
      } catch (err) {
        console.error(
          `[telegram] post ${message.id} is live as message ${first}, but a follow-up part failed:`,
          (err as any)?.message || describeTelegramError(err)
        );
        break;
      }
    }

    return { messageId: first!, chatId: state.chatId };
  }

  // https://t.me/<username>/<id> for public chats, https://t.me/c/<id>/<id>
  // for private supergroups and channels (their id minus the -100 prefix).
  // Basic groups and private chats have no message links.
  private releaseURL(internalId: string, chatId: string, messageId: number) {
    if (internalId && internalId !== 'undefined' && !/^-?\d+$/.test(internalId)) {
      return `https://t.me/${internalId}/${messageId}`;
    }
    if (chatId.startsWith('-100')) {
      return `https://t.me/c/${chatId.slice(4)}/${messageId}`;
    }
    return '';
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[]
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const { messageId, chatId } = await this.sendMessage(accessToken, firstPost);

    return [
      {
        id: firstPost.id,
        postId: String(messageId),
        releaseURL: this.releaseURL(id, chatId, messageId),
        status: 'completed',
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
    const replyToId = Number(lastCommentId || postId);

    const { messageId, chatId } = await this.sendMessage(
      accessToken,
      commentPost,
      Number.isFinite(replyToId) && replyToId > 0 ? replyToId : undefined
    );

    return [
      {
        id: commentPost.id,
        postId: String(messageId),
        releaseURL: this.releaseURL(id, chatId, messageId),
        status: 'completed',
      },
    ];
  }

  async botIsAdmin(chatId: number, botId: number): Promise<boolean> {
    try {
      const chatMember = await this.bot.getChatMember(chatId, botId);

      if (
        chatMember.status === 'administrator' ||
        chatMember.status === 'creator'
      ) {
        const permissions = chatMember.can_delete_messages;
        return !!permissions; // Return true if bot can delete messages
      }

      return false;
    } catch (error) {
      console.error(
        'Error checking bot privileges:',
        describeTelegramError(error)
      );
      return false;
    }
  }
}
