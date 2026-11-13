import 'reflect-metadata';
import { Readable } from 'stream';

// The Bot API client is replaced by these mocks; everything else (Redis falls
// back to its in-memory mock without REDIS_URL) is the real code.
const mockBot: Record<string, jest.Mock> = {
  getChat: jest.fn(),
  getFileLink: jest.fn(),
  getMe: jest.fn(),
  getChatMember: jest.fn(),
  getUpdates: jest.fn(),
  sendMessage: jest.fn(),
  deleteMessage: jest.fn(),
  sendPhoto: jest.fn(),
  sendVideo: jest.fn(),
  sendAnimation: jest.fn(),
  sendDocument: jest.fn(),
  sendMediaGroup: jest.fn(),
};
jest.mock('node-telegram-bot-api', () =>
  jest.fn().mockImplementation(() => mockBot)
);
const mockTimer = jest.fn(async (_ms: number) => undefined);
jest.mock('@hookpost/helpers/utils/timer', () => ({
  timer: (ms: number) => mockTimer(ms),
}));

import {
  describeTelegramError,
  TelegramProvider,
  toTelegramHtml,
} from '@hookpost/nestjs-libraries/integrations/social/telegram.provider';
import { BadBody } from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { stripHtmlValidation } from '@hookpost/helpers/utils/strip.html.validation';

const MB = 1024 * 1024;
const TOKEN = '123456789:AAFakeTokenForUnitTests_abcdefghijklm';

// The shape node-telegram-bot-api rejects with (checked against the live API
// with an invalid token: code ETELEGRAM, response.body = Telegram's JSON).
const tgError = (
  error_code: number,
  description: string,
  parameters?: Record<string, number>
) =>
  Object.assign(new Error(`ETELEGRAM: ${error_code} ${description}`), {
    code: 'ETELEGRAM',
    response: {
      body: { ok: false, error_code, description, parameters },
      request: {
        uri: { href: `https://api.telegram.org/bot${TOKEN}/sendMessage` },
      },
    },
  });

const setup = (sizes: Record<string, number> = {}) => {
  const provider: any = new TelegramProvider();
  provider.mediaSize = jest.fn(async (path: string) => sizes[path] ?? MB);
  provider.mediaStream = jest.fn(async () =>
    Readable.from([Buffer.from('file-bytes')])
  );
  return provider;
};

const post = (message: string, media: string[] = []): any => ({
  id: 'p1',
  message,
  settings: {},
  media: media.map((path) => ({ type: 'image', path })),
});

beforeEach(() => {
  process.env.TELEGRAM_TOKEN = TOKEN;
  process.env.TELEGRAM_BOT_NAME = 'hookstep_bot';
  Object.values(mockBot).forEach((m) => m.mockReset());
  mockTimer.mockClear();
  mockBot.getMe.mockResolvedValue({ id: 999 });
  mockBot.sendMessage.mockResolvedValue({ message_id: 41 });
  mockBot.sendPhoto.mockResolvedValue({ message_id: 42 });
  mockBot.sendVideo.mockResolvedValue({ message_id: 43 });
  mockBot.sendAnimation.mockResolvedValue({ message_id: 44 });
  mockBot.sendDocument.mockResolvedValue({ message_id: 45 });
  mockBot.sendMediaGroup.mockResolvedValue([
    { message_id: 46 },
    { message_id: 47 },
  ]);
  mockBot.deleteMessage.mockResolvedValue(true);
});

describe('TelegramProvider connect', () => {
  const channelPost = (update_id: number, text: string, chatId = -1001234) => ({
    update_id,
    channel_post: { message_id: 7, text, chat: { id: chatId } },
  });

  it('finds "/connect@bot word", hands back a one-time token, and authenticate turns it into the chat', async () => {
    const provider = setup();
    mockBot.getUpdates.mockResolvedValue([
      channelPost(500, '/connect@hookstep_bot Ab12Cd34'),
    ]);
    mockBot.getChatMember.mockResolvedValue({
      status: 'administrator',
      can_post_messages: true,
      can_delete_messages: true,
    });

    const found = await provider.getBotId({ word: 'Ab12Cd34' });
    expect(found.chatId).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(found.chatId).not.toContain('1234');
    // the /connect command is tidied away
    expect(mockBot.deleteMessage).toHaveBeenCalledWith(-1001234, 7);

    mockBot.getChat.mockResolvedValue({
      id: -1001234,
      type: 'channel',
      title: 'My Channel',
      username: 'mychannel',
    });
    const auth = await provider.authenticate({
      code: found.chatId,
      codeVerifier: 'x',
    });
    expect(mockBot.getChat).toHaveBeenCalledWith('-1001234');
    expect(auth).toMatchObject({
      id: 'mychannel',
      name: 'My Channel',
      accessToken: '-1001234',
      username: 'mychannel',
    });

    // the token is single use
    expect(
      await provider.authenticate({ code: found.chatId, codeVerifier: 'x' })
    ).toMatch(/expired/);
  });

  it('still accepts the plain "/connect word" form', async () => {
    const provider = setup();
    mockBot.getUpdates.mockResolvedValue([
      {
        update_id: 1,
        message: { message_id: 3, text: '/connect Zz99', chat: { id: -55 } },
      },
    ]);
    mockBot.getChatMember.mockResolvedValue({ status: 'member' });
    const found = await provider.getBotId({ word: 'Zz99' });
    expect(found.chatId).toBeDefined();
    // not an admin: it says so instead of deleting
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      -55,
      expect.stringContaining("don't have admin privileges"),
      { disable_notification: true }
    );
  });

  it('keeps a command another dialog saw, so two people connecting at once both succeed', async () => {
    const provider = setup();
    mockBot.getChatMember.mockResolvedValue({ status: 'member' });
    // dialog A's poll returns B's command, then A confirms it with an offset
    mockBot.getUpdates.mockResolvedValueOnce([
      channelPost(10, '/connect BBBB', -100777),
    ]);
    expect(await provider.getBotId({ word: 'AAAA' })).toEqual({
      lastChatId: 11,
    });
    // Telegram no longer returns it to B
    mockBot.getUpdates.mockResolvedValueOnce([]);
    const found = await provider.getBotId({ word: 'BBBB' });
    expect(found.chatId).toBeDefined();
    expect(await ioRedis.get(`telegram:chat:${found.chatId}`)).toBe(
      '-100777'
    );
  });

  it('never trusts a chat id sent by the browser', async () => {
    const provider = setup();
    const auth = await provider.authenticate({
      code: '-1009876543210',
      codeVerifier: 'x',
    });
    expect(auth).toMatch(/expired/);
    expect(mockBot.getChat).not.toHaveBeenCalled();
  });

  it('refuses a channel where the bot cannot post', async () => {
    const provider = setup();
    await ioRedis.set('telegram:chat:abcdefghijklmnopqrstuvwxyz123456', '-1005');
    mockBot.getChat.mockResolvedValue({ id: -1005, type: 'channel', title: 'C' });
    mockBot.getChatMember.mockResolvedValue({
      status: 'administrator',
      can_post_messages: false,
    });
    const auth = await provider.authenticate({
      code: 'abcdefghijklmnopqrstuvwxyz123456',
      codeVerifier: 'x',
    });
    expect(auth).toBe(
      '@hookstep_bot has to be an admin of this channel with the "Post messages" permission. Give it that permission in the channel settings, then connect again.'
    );
  });

  it('reports a bad bot token as a message instead of crashing the poll, without leaking the token', async () => {
    const provider = setup();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBot.getUpdates.mockRejectedValue(tgError(401, 'Unauthorized'));
    const res = await provider.getBotId({ word: 'Ab12' });
    expect(res.error).toContain('401 Unauthorized');
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    spy.mockRestore();
  });

  it('ignores a malformed word', async () => {
    const provider = setup();
    expect(await provider.getBotId({ word: '../../x' })).toEqual({});
    expect(mockBot.getUpdates).not.toHaveBeenCalled();
  });
});

describe('TelegramProvider text', () => {
  it('survives the stripHtmlValidation step the post activity runs first', () => {
    // what the editor stores for: Q&A <3 **bold**, and "a < b" in a list
    const stored =
      '<p>Q&amp;A &lt;3 <strong>bold</strong>&nbsp;x</p><ul><li><p>a &lt; b</p></li></ul>';
    const received = stripHtmlValidation('html', stored, true, false, false);
    expect(toTelegramHtml(received)).toBe(
      'Q&amp;A &lt;3 <b>bold</b> x\n- a &lt; b'
    );
  });

  it('shows tag-looking text the user typed instead of formatting it', () => {
    expect(toTelegramHtml('<p>use <b> for bold</p>')).toBe(
      'use &lt;b&gt; for bold'
    );
    expect(toTelegramHtml('AT&T <3')).toBe('AT&amp;T &lt;3');
  });

  it('escapes what the user typed and keeps the editor formatting', () => {
    expect(
      toTelegramHtml('<p>I <strong>love</strong> <u>this</u> & a < b <3</p><p>2nd</p>')
    ).toBe('I <b>love</b> <u>this</u> &amp; a &lt; b &lt;3\n2nd');
  });

  it('turns headings and lists into text Telegram accepts', () => {
    expect(
      toTelegramHtml('<h2>Title</h2><ul><li><p>one</p></li><li><p>two</p></li></ul>')
    ).toBe('<b>Title</b>\n- one\n- two');
  });

  it('closes unbalanced tags and drops unsafe links', () => {
    expect(toTelegramHtml('<strong>bold <u>both</strong> under')).toBe(
      '<b>bold <u>both</u></b><u> under</u>'
    );
    expect(toTelegramHtml('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(toTelegramHtml('<a href="https://a.b/?x=1&y=2">link</a>')).toBe(
      '<a href="https://a.b/?x=1&amp;y=2">link</a>'
    );
  });

  it('describeTelegramError never prints the token', () => {
    expect(describeTelegramError(tgError(400, 'Bad Request: x'))).toBe(
      '400 Bad Request: x'
    );
    expect(
      describeTelegramError(new Error(`connect to /bot${TOKEN}/getMe failed`))
    ).not.toContain(TOKEN);
  });
});

describe('TelegramProvider post', () => {
  it('posts text only with HTML formatting and links a public channel', async () => {
    const provider = setup();
    const [res] = await provider.post('mychannel', '-1001234', [
      post('<p>Hello <strong>world</strong> & co</p>'),
    ]);
    expect(mockBot.sendMessage).toHaveBeenCalledWith(
      '-1001234',
      'Hello <b>world</b> &amp; co',
      { parse_mode: 'HTML' }
    );
    expect(res).toEqual({
      id: 'p1',
      postId: '41',
      releaseURL: 'https://t.me/mychannel/41',
      status: 'completed',
    });
  });

  it('links a private channel through /c/ and gives a basic group no link', async () => {
    const provider = setup();
    const [priv] = await provider.post('-1009876', '-1009876', [post('hi')]);
    expect(priv.releaseURL).toBe('https://t.me/c/9876/41');
    const [group] = await provider.post('-4567', '-4567', [post('hi')]);
    expect(group.releaseURL).toBe('');
  });

  it('posts an image by URL with the text as caption', async () => {
    const provider = setup({ 'https://m/a.jpg': 2 * MB });
    const [res] = await provider.post('ch', '-1001', [
      post('<p>caption</p>', ['https://m/a.jpg']),
    ]);
    expect(mockBot.sendPhoto).toHaveBeenCalledWith(
      '-1001',
      'https://m/a.jpg',
      { caption: 'caption', parse_mode: 'HTML' },
      { filename: 'a.jpg', contentType: 'image/jpeg' }
    );
    expect(res.postId).toBe('42');
  });

  it('uploads an image over the 5 MB URL limit, and sends one over 10 MB as a file', async () => {
    const provider = setup({
      'https://m/big.png': 7 * MB,
      'https://m/huge.png': 12 * MB,
    });
    await provider.post('ch', '-1001', [post('x', ['https://m/big.png'])]);
    expect(Buffer.isBuffer(mockBot.sendPhoto.mock.calls[0][1])).toBe(true);

    // a document may be fetched by URL up to 20 MB
    await provider.post('ch', '-1001', [post('x', ['https://m/huge.png'])]);
    expect(mockBot.sendDocument.mock.calls[0][1]).toBe('https://m/huge.png');
  });

  it('posts a video by URL up to 20 MB and uploads it up to 50 MB', async () => {
    const provider = setup({
      'https://m/small.mp4': 15 * MB,
      'https://m/reel.mp4': 30 * MB,
    });
    await provider.post('ch', '-1001', [post('v', ['https://m/small.mp4'])]);
    expect(mockBot.sendVideo.mock.calls[0][1]).toBe('https://m/small.mp4');
    expect(mockBot.sendVideo.mock.calls[0][2]).toMatchObject({
      supports_streaming: true,
    });

    const [res] = await provider.post('ch', '-1001', [
      post('v', ['https://m/reel.mp4']),
    ]);
    expect(Buffer.isBuffer(mockBot.sendVideo.mock.calls[1][1])).toBe(true);
    expect(res.postId).toBe('43');
  });

  it('refuses a video over 50 MB with a clear message, before calling Telegram', async () => {
    const provider = setup({ 'https://m/long.mp4': 56 * MB });
    const err = await provider
      .post('ch', '-1001', [post('v', ['https://m/long.mp4'])])
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      '"long.mp4" is 56.0 MB. Telegram bots can send files up to 50.0 MB, please use a smaller file.'
    );
    expect(mockBot.sendVideo).not.toHaveBeenCalled();
  });

  it('sends a GIF as an animation', async () => {
    const provider = setup();
    await provider.post('ch', '-1001', [post('g', ['https://m/a.gif'])]);
    expect(mockBot.sendAnimation).toHaveBeenCalled();
  });

  it('sends a caption over 1024 characters as its own message after the media', async () => {
    const provider = setup();
    const long = 'a'.repeat(1500);
    const [res] = await provider.post('ch', '-1001', [
      post(`<p>${long}</p>`, ['https://m/a.jpg']),
    ]);
    expect(mockBot.sendPhoto.mock.calls[0][2]).toEqual({});
    expect(mockBot.sendMessage).toHaveBeenCalledWith('-1001', long, {
      parse_mode: 'HTML',
    });
    expect(res.postId).toBe('42');
  });

  it('posts several images as an album with the caption on the first', async () => {
    const provider = setup();
    const [res] = await provider.post('ch', '-1001', [
      post('album', ['https://m/1.jpg', 'https://m/2.mp4']),
    ]);
    const [chat, album] = mockBot.sendMediaGroup.mock.calls[0];
    expect(chat).toBe('-1001');
    expect(album.map((m: any) => m.type)).toEqual(['photo', 'video']);
    expect(album[0]).toMatchObject({ caption: 'album', parse_mode: 'HTML' });
    expect(album[1].caption).toBeUndefined();
    expect(res.postId).toBe('46');
  });

  it('sends 11 files as an album of 10 and a single file, never a 1-item album', async () => {
    const provider = setup();
    const files = Array.from({ length: 11 }, (_, i) => `https://m/${i}.jpg`);
    await provider.post('ch', '-1001', [post('x', files)]);
    expect(mockBot.sendMediaGroup).toHaveBeenCalledTimes(1);
    expect(mockBot.sendMediaGroup.mock.calls[0][1]).toHaveLength(10);
    expect(mockBot.sendPhoto).toHaveBeenCalledTimes(1);
  });

  it('replies to the previous message for a comment, even if it was deleted', async () => {
    const provider = setup();
    await provider.comment('ch', '41', '50', '-1001', [post('reply')], {});
    expect(mockBot.sendMessage).toHaveBeenCalledWith('-1001', 'reply', {
      parse_mode: 'HTML',
      reply_parameters: { message_id: 50, allow_sending_without_reply: true },
    });
  });
});

describe('TelegramProvider platform errors', () => {
  const fails = async (provider: any, message = post('hi')) =>
    provider.post('ch', '-1001', [message]).catch((e: any) => e);

  it('a bot removed from the channel is a clear, final failure', async () => {
    const provider = setup();
    mockBot.sendMessage.mockRejectedValue(
      tgError(403, 'Forbidden: bot was kicked from the channel chat')
    );
    const err = await fails(provider);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      "@hookstep_bot can't post here any more (bot was kicked from the channel chat). Add it back as an admin with permission to post messages, then retry."
    );
    expect(JSON.stringify(err)).not.toContain(TOKEN);
  });

  it('a deleted chat says so', async () => {
    const provider = setup();
    mockBot.sendMessage.mockRejectedValue(
      tgError(400, 'Bad Request: chat not found')
    );
    const err = await fails(provider);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/can't find this channel or group/);
  });

  it('a wrong bot token is a final failure that points at us, not the user', async () => {
    const provider = setup();
    mockBot.sendMessage.mockRejectedValue(tgError(401, 'Unauthorized'));
    const err = await fails(provider);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/not set up correctly/);
  });

  it('formatting Telegram cannot parse is resent as plain text', async () => {
    const provider = setup();
    mockBot.sendMessage
      .mockRejectedValueOnce(
        tgError(400, "Bad Request: can't parse entities: unexpected end tag")
      )
      .mockResolvedValueOnce({ message_id: 60 });
    const [res] = await provider.post('ch', '-1001', [
      post('<p><strong>a</strong> < b</p>'),
    ]);
    expect(mockBot.sendMessage.mock.calls[1]).toEqual(['-1001', 'a < b', {}]);
    expect(res.postId).toBe('60');
  });

  it('a file Telegram could not download is uploaded instead', async () => {
    const provider = setup();
    mockBot.sendPhoto
      .mockRejectedValueOnce(
        tgError(400, 'Bad Request: failed to get HTTP URL content')
      )
      .mockResolvedValueOnce({ message_id: 61 });
    const [res] = await provider.post('ch', '-1001', [
      post('x', ['https://m/a.jpg']),
    ]);
    expect(Buffer.isBuffer(mockBot.sendPhoto.mock.calls[1][1])).toBe(true);
    expect(res.postId).toBe('61');
  });

  it('waits out a 429 and retries', async () => {
    const provider = setup();
    mockBot.sendMessage
      .mockRejectedValueOnce(
        tgError(429, 'Too Many Requests: retry after 3', { retry_after: 3 })
      )
      .mockResolvedValueOnce({ message_id: 62 });
    const [res] = await provider.post('ch', '-1001', [post('x')]);
    expect(mockTimer).toHaveBeenCalledWith(3250);
    expect(res.postId).toBe('62');
  });

  it('follows a group that became a supergroup', async () => {
    const provider = setup();
    mockBot.sendMessage
      .mockRejectedValueOnce(
        tgError(400, 'Bad Request: group chat was upgraded to a supergroup chat', {
          migrate_to_chat_id: -1004444,
        })
      )
      .mockResolvedValueOnce({ message_id: 63 });
    const [res] = await provider.post('-77', '-77', [post('x')]);
    expect(mockBot.sendMessage.mock.calls[1][0]).toBe('-1004444');
    expect(res.releaseURL).toBe('https://t.me/c/4444/63');
  });

  it('a network error stays retryable and carries no token', async () => {
    const provider = setup();
    mockBot.sendMessage.mockRejectedValue(
      Object.assign(new Error('EFATAL: Error: read ECONNRESET'), {
        code: 'EFATAL',
      })
    );
    const err = await fails(provider);
    expect(err).not.toBeInstanceOf(BadBody);
    expect(err.message).toBe('Telegram: EFATAL: Error: read ECONNRESET');
  });

  it('a missing bot token is a final failure', async () => {
    const provider = setup();
    mockBot.sendMessage.mockRejectedValue(
      Object.assign(new Error('EFATAL: Telegram Bot Token not provided!'), {
        code: 'EFATAL',
      })
    );
    const err = await fails(provider);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/not set up on this Hookpost server/);
  });

  it('once the media is live, a failing follow-up text does not fail the post', async () => {
    const provider = setup();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBot.sendMessage.mockRejectedValue(tgError(403, 'Forbidden: x'));
    const [res] = await provider.post('ch', '-1001', [
      post('a'.repeat(1100), ['https://m/a.jpg']),
    ]);
    expect(res).toMatchObject({ postId: '42', status: 'completed' });
    spy.mockRestore();
  });
});

describe('TelegramProvider checkValidity', () => {
  it('accepts photos and videos together', async () => {
    const provider = setup();
    expect(
      await provider.checkValidity([
        [{ path: 'https://m/a.jpg' }, { path: 'https://m/b.mp4' }],
      ])
    ).toBe(true);
  });

  it('refuses audio mixed with photos, which Telegram cannot put in one album', async () => {
    const provider = setup();
    expect(
      await provider.checkValidity([
        [{ path: 'https://m/a.jpg' }, { path: 'https://m/b.mp3' }],
      ])
    ).toMatch(/can’t put audio/);
  });

  it('refuses a file over 50 MB at compose time', async () => {
    const provider = setup({ 'https://m/long.mp4': 56 * MB });
    expect(
      await provider.checkValidity([[{ path: 'https://m/long.mp4' }]])
    ).toMatch(/"long.mp4" is 56.0 MB/);
  });
});
