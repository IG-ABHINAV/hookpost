import 'reflect-metadata';
import { SlackProvider } from '@hookpost/nestjs-libraries/integrations/social/slack.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

type Reply = { status?: number; body: any };

// Replaces global fetch with a scripted Slack: each call is matched by API
// method name and answered from `replies`. Nothing leaves the process.
const setup = (replies: Record<string, Reply | Reply[]>) => {
  const calls: { method: string; body: any }[] = [];
  const original = global.fetch;
  (global as any).fetch = jest.fn(async (url: string, init: any = {}) => {
    const method = String(url).split('/api/')[1].split('?')[0];
    let body: any = init.body;
    if (typeof body === 'string' && body.startsWith('{')) {
      body = JSON.parse(body);
    }
    calls.push({ method, body });
    const reply = replies[method];
    const next = Array.isArray(reply) ? reply.shift()! : reply;
    const { status = 200, body: json } = next || { body: { ok: true } };
    return {
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(json),
    };
  });

  const provider: any = new SlackProvider();
  provider.mediaSize = jest.fn(async () => 1234);
  provider.mediaStream = jest.fn(async () => 'STREAM');
  const uploads: any[] = [];
  provider.getSsrfSafeAxios = () => ({
    post: async (...args: any[]) => {
      uploads.push(args);
      return { status: 200 };
    },
  });

  return {
    provider,
    calls,
    uploads,
    restore: () => ((global as any).fetch = original),
  };
};

const integration: any = { name: 'Hookpost', picture: 'https://x/p.png' };
const post = (message: string, media: any[] = []): any => ({
  id: 'p1',
  message,
  settings: { channel: 'C1' },
  media,
});

describe('SlackProvider publishing', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('posts a text message and returns its permalink', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '1.1', channel: 'C1' } },
      'chat.getPermalink': { body: { ok: true, permalink: 'https://s/p' } },
    });
    restore = s.restore;

    const [res] = await s.provider.post('T1', 'tok', [post('hello')], integration);

    expect(res).toMatchObject({ postId: '1.1', releaseURL: 'https://s/p', status: 'posted' });
  });

  it('fails with Slack\'s error when chat.postMessage says ok:false', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: false, error: 'invalid_blocks' } },
    });
    restore = s.restore;

    await expect(
      s.provider.post('T1', 'tok', [post('hello')], integration)
    ).rejects.toThrow(/invalid_blocks/);
    // and never asks for a permalink of a message that does not exist
    expect(s.calls.map((c) => c.method)).not.toContain('chat.getPermalink');
  });

  it('turns not_in_channel into an actionable message', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: false, error: 'not_in_channel' } },
    });
    restore = s.restore;

    const err: any = await s.provider
      .post('T1', 'tok', [post('hello')], integration)
      .catch((e: any) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/not a member of this channel/);
  });

  it('asks to reconnect when the token is revoked', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: false, error: 'token_revoked' } },
    });
    restore = s.restore;

    await expect(
      s.provider.post('T1', 'tok', [post('hello')], integration)
    ).rejects.toBeInstanceOf(RefreshToken);
  });

  it('names the missing scope when the app lacks files:write', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '1.1', channel: 'C1' } },
      'files.getUploadURLExternal': {
        body: { ok: false, error: 'missing_scope', needed: 'files:write' },
      },
    });
    restore = s.restore;

    await expect(
      s.provider.post(
        'T1',
        'tok',
        [post('clip', [{ type: 'video', path: 'https://x/a.mp4' }])],
        integration
      )
    ).rejects.toThrow(/missing a permission \(files:write\)/);
  });

  it('uploads a video as a file in the message thread, not as an image block', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '1.1', channel: 'C1' } },
      'files.getUploadURLExternal': {
        body: { ok: true, upload_url: 'https://files.slack.com/up/1', file_id: 'F1' },
      },
      'files.completeUploadExternal': { body: { ok: true, files: [{ id: 'F1' }] } },
      'chat.getPermalink': { body: { ok: true, permalink: 'https://s/p' } },
    });
    restore = s.restore;

    const [res] = await s.provider.post(
      'T1',
      'tok',
      [post('watch this', [{ type: 'video', path: 'https://x/a.mp4?sig=1' }])],
      integration
    );

    const message = s.calls.find((c) => c.method === 'chat.postMessage')!.body;
    expect(message.blocks.some((b: any) => b.type === 'image')).toBe(false);

    const getUrl = s.calls.find((c) => c.method === 'files.getUploadURLExternal')!;
    expect(String(getUrl.body)).toContain('filename=a.mp4');
    expect(String(getUrl.body)).toContain('length=1234');

    expect(s.uploads).toHaveLength(1);
    expect(s.uploads[0][0]).toBe('https://files.slack.com/up/1');

    const complete = s.calls.find((c) => c.method === 'files.completeUploadExternal')!.body;
    expect(complete).toMatchObject({
      channel_id: 'C1',
      thread_ts: '1.1',
      files: [{ id: 'F1', title: 'a.mp4' }],
    });
    expect(res.postId).toBe('1.1');
  });

  it('detects a video by extension when the media has no type', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '1.1', channel: 'C1' } },
      'files.getUploadURLExternal': {
        body: { ok: true, upload_url: 'https://files.slack.com/up/1', file_id: 'F1' },
      },
    });
    restore = s.restore;

    await s.provider.post(
      'T1',
      'tok',
      [post('x', [{ path: 'https://x/a.MOV' }, { path: 'https://x/b.png' }])],
      integration
    );

    const message = s.calls.find((c) => c.method === 'chat.postMessage')!.body;
    expect(message.blocks.filter((b: any) => b.type === 'image')).toEqual([
      { type: 'image', image_url: 'https://x/b.png', alt_text: '' },
    ]);
    expect(s.calls.some((c) => c.method === 'files.getUploadURLExternal')).toBe(true);
  });

  it('fails the post when the video upload step is rejected', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '1.1', channel: 'C1' } },
      'files.getUploadURLExternal': {
        body: { ok: true, upload_url: 'https://files.slack.com/up/1', file_id: 'F1' },
      },
      'files.completeUploadExternal': { body: { ok: false, error: 'channel_not_found' } },
    });
    restore = s.restore;

    await expect(
      s.provider.post(
        'T1',
        'tok',
        [post('x', [{ type: 'video', path: 'https://x/a.mp4' }])],
        integration
      )
    ).rejects.toThrow(/could not find this channel/);
  });

  it('replies in the existing thread for comments', async () => {
    const s = setup({
      'chat.postMessage': { body: { ok: true, ts: '2.2', channel: 'C1' } },
      'chat.getPermalink': { body: { ok: true, permalink: 'https://s/c' } },
    });
    restore = s.restore;

    const [res] = await s.provider.comment('T1', '1.1', undefined, 'tok', [post('reply')], integration);

    expect(s.calls.find((c) => c.method === 'chat.postMessage')!.body.thread_ts).toBe('1.1');
    expect(res.postId).toBe('2.2');
  });
});

describe('SlackProvider.maxLength', () => {
  it('matches the 3,000 characters a mrkdwn section block takes', () => {
    expect(new SlackProvider().maxLength()).toBe(3000);
  });
});
