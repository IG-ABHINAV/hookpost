import 'reflect-metadata';
import {
  DISCORD_MAX_FILE_BYTES,
  DiscordProvider,
} from '@hookpost/nestjs-libraries/integrations/social/discord.provider';
import { BadBody } from '@hookpost/nestjs-libraries/integrations/social.abstract';

const MB = 1024 * 1024;

// The server the integration connected (its internalId), one of its
// channels, and a channel of another server the same Hookpost bot is in.
const GUILD = '1100000000000000001';
const CHANNEL = '1200000000000000002';
const OTHER_GUILD = '1900000000000000009';
const FOREIGN_CHANNEL = '1300000000000000003';
const SERVERS: Record<string, string | null> = {
  [CHANNEL]: GUILD,
  [FOREIGN_CHANNEL]: OTHER_GUILD,
  // A DM channel has no server.
  '1400000000000000004': null,
};

// GET /channels/{id} as Discord answers it to the bot.
const channelLookup = () =>
  jest.fn(async (url: string, options: any) => {
    const id = url.split('/').pop()!;
    if (!(id in SERVERS)) {
      throw new BadBody('discord', '{}', '{}', 'Channel no longer exists');
    }
    return {
      json: async () => ({
        id,
        ...(SERVERS[id] ? { guild_id: SERVERS[id] } : {}),
        auth: options?.headers?.Authorization,
      }),
    };
  });

// What a multipart message carried: its JSON payload and how many files.
const sent = (form: any) => {
  const streams: any[] = form._streams;
  const json = streams.find(
    (s) => typeof s === 'string' && s.startsWith('{"content"')
  );
  return {
    payload: JSON.parse(json),
    files: streams.filter((s) => s === 'STREAM').length,
  };
};

const setup = (size: number | ((path: string) => number)) => {
  const provider: any = new DiscordProvider();
  provider.mediaSize = jest.fn(async (path: string) =>
    typeof size === 'function' ? size(path) : size
  );
  provider.mediaStream = jest.fn(async () => 'STREAM');
  provider.fetch = channelLookup();
  const posts: any[] = [];
  const failures: any[] = [];
  provider.getSsrfSafeAxios = () => ({
    post: async (...args: any[]) => {
      const failure = failures.shift();
      if (failure) {
        throw failure;
      }
      posts.push({ url: args[0], ...sent(args[1]) });
      return { data: { id: `m${posts.length}` } };
    },
  });
  return { provider, posts, failures };
};

const post = (
  path: string | string[],
  message = 'hi',
  channel: string = CHANNEL
): any => ({
  id: 'p1',
  message,
  settings: { channel },
  media: (Array.isArray(path) ? path : [path]).map((p) => ({
    type: 'video',
    path: p,
  })),
});

describe('DiscordProvider attachment limit', () => {
  it('uses Discord’s 20 MB default, so the 7 and 8 Oct clips go out as attachments', async () => {
    expect(DISCORD_MAX_FILE_BYTES).toBe(20 * MB);
    for (const size of [10.8 * MB, 14.7 * MB]) {
      const { provider, posts } = setup(size);
      const [res] = await provider.post(GUILD, 'tok', [
        post('https://x/uploads/clip.mp4'),
      ]);
      expect(posts).toHaveLength(1);
      expect(posts[0].files).toBe(1);
      expect(posts[0].payload.content).toBe('hi');
      expect(res).toMatchObject({ postId: 'm1', status: 'success' });
    }
  });

  it('sends a file exactly at the limit as an attachment', async () => {
    const { provider, posts } = setup(DISCORD_MAX_FILE_BYTES);
    await provider.post(GUILD, 'tok', [post('https://x/ok.mp4')]);
    expect(posts[0].files).toBe(1);
    expect(posts[0].payload.attachments).toHaveLength(1);
  });

  it('posts a file over the limit as a link instead of failing', async () => {
    const { provider, posts } = setup(24.3 * MB);

    const [res] = await provider.post(GUILD, 'tok', [
      post('https://x/uploads/big%20clip.mp4?sig=1'),
    ]);

    expect(posts).toHaveLength(1);
    expect(posts[0].files).toBe(0);
    expect(posts[0].payload.attachments).toEqual([]);
    expect(posts[0].payload.content).toBe(
      'hi\nhttps://x/uploads/big%20clip.mp4?sig=1'
    );
    expect(provider.mediaStream).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      postId: 'm1',
      status: 'success',
      releaseURL: `https://discord.com/channels/${GUILD}/${CHANNEL}/m1`,
    });
  });

  it('attaches the files that fit and links the ones that do not, in order', async () => {
    const { provider, posts } = setup((p) =>
      p.includes('big') ? 30 * MB : MB
    );

    await provider.post(GUILD, 'tok', [
      post(['https://x/a.png', 'https://x/big.mp4', 'https://x/b.png']),
    ]);

    expect(posts).toHaveLength(1);
    expect(posts[0].files).toBe(2);
    expect(posts[0].payload.attachments.map((a: any) => a.filename)).toEqual([
      'a.png',
      'b.png',
    ]);
    expect(posts[0].payload.content).toBe('hi\nhttps://x/big.mp4');
  });

  it('sends the links as a follow-up when text plus links would pass 2,000 characters', async () => {
    const { provider, posts } = setup(30 * MB);
    const text = 'x'.repeat(1980);

    const url = 'https://media.example.com/fdFZy4zBH9.mp4';

    const [res] = await provider.post(GUILD, 'tok', [post(url, text)]);

    expect(text.length + 1 + url.length).toBeGreaterThan(2000);
    expect(posts).toHaveLength(2);
    expect(posts[0].payload.content).toBe(text);
    expect(posts[1].payload.content).toBe(url);
    // the post points at the message with the text
    expect(res.postId).toBe('m1');
  });

  it('keeps the post when only the follow-up with the links fails', async () => {
    const { provider, posts } = setup(30 * MB);
    const realAxios = provider.getSsrfSafeAxios;
    let calls = 0;
    provider.getSsrfSafeAxios = () => {
      calls++;
      if (calls === 2) {
        return {
          post: async () => {
            throw new Error('socket hang up');
          },
        };
      }
      return realAxios();
    };
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});

    const [res] = await provider.post(GUILD, 'tok', [
      post('https://media.example.com/fdFZy4zBH9.mp4', 'x'.repeat(1980)),
    ]);

    expect(posts).toHaveLength(1);
    expect(res).toMatchObject({ postId: 'm1', status: 'success' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('falls back to links when Discord itself answers 40005', async () => {
    const { provider, posts, failures } = setup(15 * MB);
    failures.push({
      response: {
        status: 400,
        data: { message: 'Request entity too large', code: 40005 },
      },
    });

    const [res] = await provider.post(GUILD, 'tok', [post('https://x/c.mp4')]);

    expect(posts).toHaveLength(1);
    expect(posts[0].files).toBe(0);
    expect(posts[0].payload.content).toBe('hi\nhttps://x/c.mp4');
    expect(res).toMatchObject({ postId: 'm1', status: 'success' });
  });

  it('does not retry other Discord errors as links', async () => {
    const { provider, posts, failures } = setup(MB);
    failures.push({
      response: {
        status: 403,
        data: { message: 'Missing Access', code: 50001 },
      },
    });

    const err: any = await provider
      .post(GUILD, 'tok', [post('https://x/c.png')])
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe("Bot doesn't have access to this channel");
    expect(posts).toHaveLength(0);
  });

  it('still fails, before sending, for a local file over the limit (nothing to link)', async () => {
    const { provider, posts } = setup(24.3 * MB);

    const err: any = await provider
      .post(GUILD, 'tok', [post('/uploads/big%20clip.mp4')])
      .catch((e: any) => e);

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('"big clip.mp4" is 24.3 MB');
    expect(err.message).toContain('only accepts files up to 20.0 MB');
    expect(posts).toHaveLength(0);
  });

  it('names the limit when Discord reports 40005 for a file it cannot link', () => {
    const provider: any = new DiscordProvider();
    expect(
      provider.handleErrors(
        '{"message": "Request entity too large", "code": 40005}'
      )
    ).toMatchObject({
      type: 'bad-body',
      value: expect.stringContaining('20.0 MB'),
    });
  });

  it('links thread-reply files over the limit too', async () => {
    const { provider, posts } = setup(30 * MB);
    const [res] = await provider.comment(
      GUILD,
      'm0',
      'm9',
      'tok',
      [post('https://x/big.mp4')],
      {} as any
    );
    expect(posts[0].payload.content).toBe('hi\nhttps://x/big.mp4');
    expect(res.status).toBe('success');
  });
});

describe('DiscordProvider at compose time (POST /posts/valid)', () => {
  it('never blocks the save on file size', async () => {
    const { provider } = setup(30 * MB);
    await expect(
      provider.checkValidity([[{ path: 'https://x/big.mp4' }]], {}, [])
    ).resolves.toBe(true);
  });

  it('gives a notice for a file that will be posted as a link', async () => {
    const { provider } = setup(24.3 * MB);
    await expect(
      provider.mediaNotices([[{ path: 'https://x/uploads/fdFZy4zBH9.mp4' }]])
    ).resolves.toEqual([
      expect.stringContaining(
        '"fdFZy4zBH9.mp4" is 24.3 MB, over Discord\'s 20.0 MB upload limit, so it will be posted as a link to the file'
      ),
    ]);
  });

  it('checks attachments in thread replies too', async () => {
    const { provider } = setup((p) => (p.includes('big') ? 21 * MB : MB));
    await expect(
      provider.mediaNotices([
        [{ path: 'https://x/small.png' }],
        [{ path: 'https://x/big.mp4' }],
      ])
    ).resolves.toEqual([expect.stringContaining('"big.mp4" is 21.0 MB')]);
  });

  it('says nothing for files within the limit, or posts with no media', async () => {
    const { provider } = setup(DISCORD_MAX_FILE_BYTES);
    await expect(
      provider.mediaNotices([[{ path: 'https://x/ok.mp4' }]])
    ).resolves.toEqual([]);
    await expect(provider.mediaNotices([[]])).resolves.toEqual([]);
  });

  it('says nothing for a size it cannot read, and never reads a local path', async () => {
    const provider: any = new DiscordProvider();
    provider.mediaSize = jest.fn(async () => {
      throw new Error('HEAD refused');
    });
    await expect(
      provider.mediaNotices([[{ path: 'https://x/clip.mp4' }]])
    ).resolves.toEqual([]);
    await expect(
      provider.mediaNotices([[{ path: '/etc/passwd' }]])
    ).resolves.toEqual([]);
    expect(provider.mediaSize).toHaveBeenCalledTimes(1);
  });
});

describe('DiscordProvider posts only to channels of its own server', () => {
  it('reads the server with the bot token, from GET /channels/{id}', async () => {
    const { provider } = setup(MB);
    const saved = process.env.DISCORD_BOT_TOKEN_ID;
    process.env.DISCORD_BOT_TOKEN_ID = 'bot-token-test';
    try {
      await expect(provider.channelServer(CHANNEL)).resolves.toBe(GUILD);
      expect(provider.fetch).toHaveBeenCalledWith(
        `https://discord.com/api/channels/${CHANNEL}`,
        { headers: { Authorization: 'Bot bot-token-test' } },
        'discord'
      );
      await expect(provider.channelServer('1400000000000000004')).resolves.toBeNull();
    } finally {
      if (saved === undefined) delete process.env.DISCORD_BOT_TOKEN_ID;
      else process.env.DISCORD_BOT_TOKEN_ID = saved;
    }
  });

  it('refuses a channel of another server before sending anything', async () => {
    const { provider, posts } = setup(MB);
    const err: any = await provider
      .post(GUILD, 'tok', [post('https://x/a.png', 'hi @everyone', FOREIGN_CHANNEL)])
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/not in the server this channel is connected to/);
    expect(posts).toHaveLength(0);
    expect(provider.mediaSize).not.toHaveBeenCalled();
  });

  it('refuses a DM channel (no server) and a channel Discord does not know', async () => {
    const { provider, posts } = setup(MB);
    for (const channel of ['1400000000000000004', '1500000000000000005']) {
      const err: any = await provider
        .post(GUILD, 'tok', [post('https://x/a.png', 'hi', channel)])
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(BadBody);
    }
    expect(posts).toHaveLength(0);
  });

  it('refuses anything but a channel id without asking Discord, so nothing reaches another API path', async () => {
    const { provider, posts } = setup(MB);
    for (const channel of [
      `${FOREIGN_CHANNEL}/messages`,
      `../guilds/${GUILD}`,
      '',
      ' ',
      123 as any,
    ]) {
      const err: any = await provider
        .post(GUILD, 'tok', [post('https://x/a.png', 'hi', channel)])
        .catch((e: any) => e);
      expect(err).toBeInstanceOf(BadBody);
      expect(err.message).toMatch(/must be a channel id/);
    }
    const noChannel: any = await provider
      .post(GUILD, 'tok', [{ ...post('https://x/a.png'), settings: {} }])
      .catch((e: any) => e);
    expect(noChannel).toBeInstanceOf(BadBody);
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it('checks a thread reply too, before it opens a thread or sends', async () => {
    const { provider, posts } = setup(MB);
    const err: any = await provider
      .comment(GUILD, 'm0', undefined, 'tok', [post('https://x/a.png', 'hi', FOREIGN_CHANNEL)], {} as any)
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(BadBody);
    // Only the lookup: no thread was opened.
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(0);
  });

  it('posts to its own server\'s channel, with or without spaces around the id', async () => {
    const { provider, posts } = setup(MB);
    const [res] = await provider.post(GUILD, 'tok', [post('https://x/a.png', 'hi', ` ${CHANNEL} `)]);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`https://discord.com/api/channels/${CHANNEL}/messages`);
    expect(res.releaseURL).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/m1`);
  });
});
