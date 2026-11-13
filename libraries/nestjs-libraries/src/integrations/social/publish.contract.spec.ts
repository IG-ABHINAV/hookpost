/**
 * The publish path of the networks real customers post to (Instagram,
 * Facebook Pages, Threads, LinkedIn, Pinterest), driven step by step the way
 * the post workflow drives it: postPending -> checkPostStatus (polled) ->
 * finalizePost. Each provider's `fetch` is replaced by a fake Graph/REST API
 * that records every call; nothing leaves the process.
 *
 * What is pinned down, per network:
 *  - which endpoint each step calls, with which token and body;
 *  - nothing visible is published before finalizePost;
 *  - a post that a crashed run already published is never published again
 *    (the PUBLISHED status, or the arm -> confirm -> publish handshake);
 *  - the post id and URL the calendar shows come back.
 */
import 'reflect-metadata';
import { ThreadsProvider } from './threads.provider';
import { FacebookProvider } from './facebook.provider';
import { InstagramProvider } from './instagram.provider';
import { LinkedinProvider } from './linkedin.provider';
import { PinterestProvider } from './pinterest.provider';

type Call = { url: string; method: string; body?: any; headers?: any };
type Answer = { body?: any; status?: number; headers?: Record<string, string> } | Error;
type Route = [RegExp, (call: Call) => Answer];

/** Replaces provider.fetch with a fake API answering by URL pattern. */
function fakeApi(provider: any, routes: Route[]) {
  const calls: Call[] = [];
  provider.fetch = async (url: string, init: any = {}) => {
    const call: Call = {
      url,
      method: (init.method || 'GET').toUpperCase(),
      body: init.body,
      headers: init.headers,
    };
    calls.push(call);
    const route = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!route) throw new Error(`unexpected call: ${call.method} ${url}`);
    const answer = route[1](call);
    if (answer instanceof Error) throw answer;
    const headers = new Map(Object.entries(answer.headers || {}));
    return {
      status: answer.status ?? 200,
      ok: (answer.status ?? 200) < 400,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      json: async () => answer.body ?? {},
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  };
  return calls;
}

const integration = (over: Record<string, unknown> = {}) =>
  ({ id: 'int-1', internalId: 'ACCOUNT', profile: 'acme', ...over } as any);

const post = (over: Record<string, unknown> = {}) =>
  ({ id: 'post-1', message: 'Hello world', settings: {}, media: [], ...over } as any);

const jsonBody = (c: Call) => (typeof c.body === 'string' ? JSON.parse(c.body) : c.body);

describe('Threads', () => {
  const statusRoute = (status: string, extra: Record<string, unknown> = {}): Route => [
    /^GET .*fields=status,error_message/,
    () => ({ body: { status, ...extra } }),
  ];

  it('text post: one TEXT container, nothing published until finalizePost', async () => {
    const p: any = new ThreadsProvider();
    const calls = fakeApi(p, [[/^POST .*\/U1\/threads$/, () => ({ body: { id: 'c1' } })]]);
    const [res] = await p.postPending('U1', 'TOK', [post()], integration());
    expect(res).toMatchObject({ status: 'pending', pendingData: { step: 'container', containerId: 'c1' } });
    expect(calls).toHaveLength(1);
    const form: FormData = calls[0].body;
    expect(form.get('media_type')).toBe('TEXT');
    expect(form.get('text')).toBe('Hello world');
    expect(form.get('access_token')).toBe('TOK');
    expect(calls.some((c) => c.url.includes('threads_publish'))).toBe(false);
  });

  it('one image or one video: a single media container of the right type', async () => {
    for (const [path, type, param] of [
      ['https://cdn.test/a.jpg', 'IMAGE', 'image_url'],
      ['https://cdn.test/a.mp4', 'VIDEO', 'video_url'],
    ]) {
      const p: any = new ThreadsProvider();
      const calls = fakeApi(p, [[/^POST .*\/U1\/threads\?/, () => ({ body: { id: 'c1' } })]]);
      await p.postPending('U1', 'TOK', [post({ media: [{ path }] })], integration());
      const q = new URL(calls[0].url).searchParams;
      expect(q.get('media_type')).toBe(type);
      expect(q.get(param)).toBe(path);
      expect(q.get('is_carousel_item')).toBeNull();
    }
  });

  it('polling: IN_PROGRESS waits, FINISHED is ready, ERROR fails with the reason', async () => {
    const p: any = new ThreadsProvider();
    const pending = { step: 'container', containerId: 'c1' };
    fakeApi(p, [statusRoute('IN_PROGRESS')]);
    expect((await p.checkPostStatus('TOK', pending, integration())).status).toBe('pending');
    fakeApi(p, [statusRoute('FINISHED')]);
    expect((await p.checkPostStatus('TOK', pending, integration())).status).toBe('ready');
    fakeApi(p, [statusRoute('ERROR', { error_message: 'Media too large' })]);
    await expect(p.checkPostStatus('TOK', pending, integration())).rejects.toMatchObject({
      message: expect.stringContaining('Media too large'),
    });
  });

  it('a container a crashed run already published is reported, never published again', async () => {
    const p: any = new ThreadsProvider();
    const calls = fakeApi(p, [statusRoute('PUBLISHED')]);
    const res = await p.checkPostStatus('TOK', { step: 'container', containerId: 'c1' }, integration());
    expect(res).toEqual({ status: 'completed', postId: 'c1', releaseURL: 'https://www.threads.net/@acme' });
    expect(calls.some((c) => c.url.includes('threads_publish'))).toBe(false);
  });

  it('finalizePost publishes the container on the channel account and returns the permalink', async () => {
    const p: any = new ThreadsProvider();
    const calls = fakeApi(p, [
      [/^POST .*\/ACCOUNT\/threads_publish\?creation_id=c1&access_token=TOK$/, () => ({ body: { id: 't1' } })],
      [/^GET .*\/t1\?fields=id,permalink/, () => ({ body: { permalink: 'https://www.threads.net/@acme/post/X' } })],
    ]);
    const res = await p.finalizePost('TOK', { step: 'container', containerId: 'c1' }, integration());
    expect(res).toEqual({ status: 'completed', postId: 't1', releaseURL: 'https://www.threads.net/@acme/post/X' });
    expect(calls.filter((c) => c.url.includes('threads_publish'))).toHaveLength(1);
  });

  it('a failing permalink lookup never fails a live post', async () => {
    const p: any = new ThreadsProvider();
    fakeApi(p, [
      [/threads_publish/, () => ({ body: { id: 't1' } })],
      [/fields=id,permalink/, () => new Error('boom')],
    ]);
    const res = await p.finalizePost('TOK', { step: 'container', containerId: 'c1' }, integration());
    expect(res).toMatchObject({ status: 'completed', postId: 't1', releaseURL: 'https://www.threads.net/@acme' });
  });

  it('carousel: carousel-item children first, then the CAROUSEL container, then publish', async () => {
    const p: any = new ThreadsProvider();
    let n = 0;
    const calls = fakeApi(p, [
      [/^POST .*\/threads\?/, () => ({ body: { id: `c${++n}` } })],
      statusRoute('FINISHED'),
    ]);
    const media = [{ path: 'https://cdn.test/1.jpg' }, { path: 'https://cdn.test/2.jpg' }];
    const [res] = await p.postPending('U1', 'TOK', [post({ media })], integration());
    expect(res.pendingData).toEqual({ step: 'children', childIds: ['c1', 'c2'], message: 'Hello world' });
    for (const c of calls) expect(new URL(c.url).searchParams.get('is_carousel_item')).toBe('true');

    expect((await p.checkPostStatus('TOK', res.pendingData, integration())).status).toBe('ready');
    const next = await p.finalizePost('TOK', res.pendingData, integration());
    const carousel = new URL(calls[calls.length - 1].url).searchParams;
    expect(carousel.get('media_type')).toBe('CAROUSEL');
    expect(carousel.get('children')).toBe('c1,c2');
    expect(next).toEqual({ status: 'pending', pendingData: { step: 'container', containerId: 'c3' } });
  });
});

describe('Facebook Pages', () => {
  it('text post: one /feed call with the message, published', async () => {
    const p: any = new FacebookProvider();
    const calls = fakeApi(p, [
      [/^POST .*\/PAGE\/feed\?access_token=TOK/, () => ({ body: { id: 'PAGE_1', permalink_url: 'https://facebook.com/PAGE_1' } })],
    ]);
    const [res] = await p.postPending('PAGE', 'TOK', [post({ settings: { url: 'https://hookstep.in' } })], integration());
    expect(res).toEqual({ id: 'post-1', postId: 'PAGE_1', releaseURL: 'https://facebook.com/PAGE_1', status: 'success' });
    expect(jsonBody(calls[0])).toEqual({ message: 'Hello world', published: true, link: 'https://hookstep.in' });
  });

  it('photos: uploaded unpublished, then attached to one feed post', async () => {
    const p: any = new FacebookProvider();
    let n = 0;
    const calls = fakeApi(p, [
      [/^POST .*\/PAGE\/photos/, () => ({ body: { id: `ph${++n}` } })],
      [/^POST .*\/PAGE\/feed/, () => ({ body: { id: 'PAGE_2', permalink_url: 'u' } })],
    ]);
    await p.postPending(
      'PAGE',
      'TOK',
      [post({ media: [{ path: 'https://cdn.test/1.jpg' }, { path: 'https://cdn.test/2.jpg' }] })],
      integration()
    );
    const photos = calls.filter((c) => c.url.includes('/photos'));
    expect(photos.map(jsonBody)).toEqual([
      { url: 'https://cdn.test/1.jpg', published: false },
      { url: 'https://cdn.test/2.jpg', published: false },
    ]);
    expect(jsonBody(calls[calls.length - 1]).attached_media).toEqual([{ media_fbid: 'ph1' }, { media_fbid: 'ph2' }]);
  });

  it('a video goes out as a reel from its file URL', async () => {
    const p: any = new FacebookProvider();
    const calls = fakeApi(p, [[/^POST .*\/PAGE\/videos/, () => ({ body: { id: 'V1' } })]]);
    const [res] = await p.postPending('PAGE', 'TOK', [post({ media: [{ path: 'https://cdn.test/v.mp4' }] })], integration());
    expect(jsonBody(calls[0])).toEqual({ file_url: 'https://cdn.test/v.mp4', description: 'Hello world', published: true });
    expect(res).toMatchObject({ postId: 'V1', releaseURL: 'https://www.facebook.com/reel/V1', status: 'success' });
  });

  it('a background preset Facebook rejects is dropped and the post goes out as text', async () => {
    const p: any = new FacebookProvider();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let first = true;
    const calls = fakeApi(p, [
      [
        /^POST .*\/PAGE\/feed/,
        () => {
          if (first) {
            first = false;
            return Object.assign(new Error('Bad request'), {
              details: [{ json: '{"error":{"message":"(#100) Invalid text_format_preset_id","code":100}}' }],
            });
          }
          return { body: { id: 'PAGE_3', permalink_url: 'u' } };
        },
      ],
    ]);
    const [res] = await p.postPending('PAGE', 'TOK', [post({ settings: { text_format_preset_id: '123' } })], integration());
    expect(res.postId).toBe('PAGE_3');
    expect(jsonBody(calls[0]).text_format_preset_id).toBe('123');
    expect(jsonBody(calls[1]).text_format_preset_id).toBeUndefined();
    warn.mockRestore();
  });

  it('an expired token is not retried without the preset', async () => {
    const p: any = new FacebookProvider();
    const calls = fakeApi(p, [
      [
        /^POST .*\/PAGE\/feed/,
        () =>
          Object.assign(new Error('Bad request'), {
            details: [{ json: '{"error":{"message":"Error validating access token","code":190}}' }],
          }),
      ],
    ]);
    await expect(
      p.postPending('PAGE', 'TOK', [post({ settings: { text_format_preset_id: '123' } })], integration())
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  describe('stories: arm -> confirm -> publish, one story at a time', () => {
    const story = () =>
      post({
        settings: { post_type: 'story' },
        media: [{ path: 'https://cdn.test/1.jpg' }, { path: 'https://cdn.test/2.jpg' }],
      });

    it('uploads are invisible; each story is published only after a witnessed arm', async () => {
      const p: any = new FacebookProvider();
      let n = 0;
      let storyN = 0;
      const calls = fakeApi(p, [
        [/^POST .*\/PAGE\/photos/, () => ({ body: { id: `ph${++n}` } })],
        [/^POST .*\/ACCOUNT\/photo_stories\?photo_id=ph\d/, () => ({ body: { post_id: `S${++storyN}` } })],
      ]);
      const [res] = await p.postPending('PAGE', 'TOK', [story()], integration());
      expect(res.status).toBe('pending');
      expect(calls.filter((c) => c.url.includes('photo_stories'))).toHaveLength(0);

      let data = res.pendingData;
      // Drive the workflow loop: check, finalize, until completed.
      let result: any;
      for (let i = 0; i < 10; i++) {
        const check = await p.checkPostStatus('TOK', data, integration());
        expect(check.status).toBe('ready');
        result = await p.finalizePost('TOK', check.pendingData, integration());
        if (result.status === 'completed') break;
        data = result.pendingData;
      }
      expect(result).toEqual({ status: 'completed', postId: 'S2', releaseURL: 'https://www.facebook.com/stories/S2' });
      expect(calls.filter((c) => c.url.includes('photo_stories')).map((c) => new URL(c.url).searchParams.get('photo_id'))).toEqual([
        'ph1',
        'ph2',
      ]);
    });

    it('an armed and witnessed attempt that comes back means a run died mid-publish: stop, never repeat', async () => {
      const p: any = new FacebookProvider();
      const calls = fakeApi(p, []);
      await expect(
        p.checkPostStatus(
          'TOK',
          { postType: 'story', items: [{ kind: 'photo', mediaId: 'ph1' }], publishedCount: 0, lastPostId: '', attempting: 0, confirmed: true },
          integration()
        )
      ).rejects.toMatchObject({ message: expect.stringContaining('may have already published') });
      expect(calls).toHaveLength(0);
    });
  });
});

describe('Instagram (via Facebook Login and standalone)', () => {
  const TOKEN = 'PAGETOK___USERTOK';

  it('single image: a container with the caption, published on finalize with the page token', async () => {
    const p: any = new InstagramProvider();
    const calls = fakeApi(p, [
      [/^POST https:\/\/graph\.facebook\.com\/v[\d.]+\/IG1\/media\?/, () => ({ body: { id: 'c1' } })],
      [/^GET .*\/c1\?access_token=USERTOK&fields=status_code,status/, () => ({ body: { status_code: 'FINISHED' } })],
      [/^POST .*\/ACCOUNT\/media_publish\?creation_id=c1&access_token=PAGETOK/, () => ({ body: { id: 'M1' } })],
      [/^GET .*\/M1\?fields=permalink&access_token=USERTOK/, () => ({ body: { permalink: 'https://instagram.com/p/X' } })],
    ]);
    const [res] = await p.postPending(
      'IG1',
      TOKEN,
      [post({ message: 'Hi #tag & more', settings: { post_type: 'post' }, media: [{ path: 'https://cdn.test/a.jpg' }] })],
      integration()
    );
    expect(res.pendingData).toMatchObject({ postType: 'single', containers: ['c1'], type: 'graph.facebook.com' });
    const create = new URL(calls[0].url).searchParams;
    expect(create.get('image_url')).toBe('https://cdn.test/a.jpg');
    expect(create.get('caption')).toBe('Hi #tag & more');
    expect(create.get('access_token')).toBe('PAGETOK');
    expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);

    const check = await p.checkPostStatus(TOKEN, res.pendingData, integration());
    expect(check.status).toBe('ready');
    const done = await p.finalizePost(TOKEN, check.pendingData, integration());
    expect(done).toEqual({ status: 'completed', postId: 'M1', releaseURL: 'https://instagram.com/p/X' });
  });

  it('a single video is a reel; a story is a story', async () => {
    const p: any = new InstagramProvider();
    const calls = fakeApi(p, [[/\/media\?/, () => ({ body: { id: 'c1' } })]]);
    await p.postPending('IG1', TOKEN, [post({ settings: { post_type: 'post' }, media: [{ path: 'https://cdn.test/v.mp4' }] })], integration());
    await p.postPending('IG1', TOKEN, [post({ settings: { post_type: 'story' }, media: [{ path: 'https://cdn.test/s.jpg' }] })], integration());
    expect(new URL(calls[0].url).searchParams.get('media_type')).toBe('REELS');
    expect(new URL(calls[1].url).searchParams.get('media_type')).toBe('STORIES');
  });

  it('carousel: children without captions, then a CAROUSEL container, then publish that', async () => {
    const p: any = new InstagramProvider();
    let n = 0;
    const calls = fakeApi(p, [
      [/^POST .*\/IG1\/media\?/, () => ({ body: { id: `c${++n}` } })],
      [/^POST .*\/ACCOUNT\/media\?.*media_type=CAROUSEL/, () => ({ body: { id: 'car1' } })],
      [/fields=status_code,status/, () => ({ body: { status_code: 'FINISHED' } })],
      [/^POST .*\/ACCOUNT\/media_publish\?creation_id=car1/, () => ({ body: { id: 'M2' } })],
      [/fields=permalink/, () => ({ body: { permalink: 'https://instagram.com/p/C' } })],
    ]);
    const media = [{ path: 'https://cdn.test/1.jpg' }, { path: 'https://cdn.test/2.jpg' }];
    const [res] = await p.postPending('IG1', TOKEN, [post({ settings: { post_type: 'post' }, media })], integration());
    for (const c of calls) {
      const q = new URL(c.url).searchParams;
      expect(q.get('is_carousel_item')).toBe('true');
      expect(q.get('caption')).toBeNull();
    }
    let data = res.pendingData;
    expect((await p.checkPostStatus(TOKEN, data, integration())).status).toBe('ready');
    const container = await p.finalizePost(TOKEN, data, integration());
    expect(container).toMatchObject({ status: 'pending', pendingData: { carouselId: 'car1' } });
    data = container.pendingData;
    expect((await p.checkPostStatus(TOKEN, data, integration())).status).toBe('ready');
    expect(await p.finalizePost(TOKEN, data, integration())).toEqual({
      status: 'completed',
      postId: 'M2',
      releaseURL: 'https://instagram.com/p/C',
    });
    const carousel = new URL(calls.find((c) => c.url.includes('CAROUSEL'))!.url).searchParams;
    expect(carousel.get('children')).toBe('c1,c2');
    expect(carousel.get('caption')).toBe('Hello world');
  });

  it('a single post a crashed run already published is reported, never published again', async () => {
    const p: any = new InstagramProvider();
    const calls = fakeApi(p, [[/fields=status_code,status/, () => ({ body: { status_code: 'PUBLISHED' } })]]);
    const res = await p.checkPostStatus(
      TOKEN,
      { type: 'graph.facebook.com', postType: 'single', containers: ['c1'] },
      integration()
    );
    expect(res).toEqual({ status: 'completed', postId: 'c1', releaseURL: 'https://www.instagram.com/acme' });
    expect(calls.some((c) => c.url.includes('media_publish'))).toBe(false);
  });

  it('stories resume after a crash: containers already published are skipped', async () => {
    const p: any = new InstagramProvider();
    const calls = fakeApi(p, [
      [/\/s1\?.*fields=status_code/, () => ({ body: { status_code: 'PUBLISHED' } })],
      [/\/s2\?.*fields=status_code/, () => ({ body: { status_code: 'FINISHED' } })],
      [/media_publish\?creation_id=s2/, () => ({ body: { id: 'M3' } })],
      [/fields=permalink/, () => ({ body: { permalink: 'https://instagram.com/stories/acme/M3' } })],
    ]);
    const res = await p.finalizePost(
      TOKEN,
      { type: 'graph.facebook.com', postType: 'stories', containers: ['s1', 's2'] },
      integration()
    );
    expect(res).toMatchObject({ status: 'completed', postId: 'M3' });
    expect(calls.filter((c) => c.url.includes('media_publish'))).toHaveLength(1);
  });

  it('a container Instagram could not process fails with its reason', async () => {
    const p: any = new InstagramProvider();
    fakeApi(p, [[/fields=status_code,status/, () => ({ body: { status_code: 'ERROR', status: 'Unsupported aspect ratio' } })]]);
    await expect(
      p.checkPostStatus(TOKEN, { type: 'graph.facebook.com', postType: 'single', containers: ['c1'] }, integration())
    ).rejects.toMatchObject({ message: expect.stringContaining('Unsupported aspect ratio') });
  });

  it('standalone Instagram (Instagram Login) talks to graph.instagram.com', async () => {
    const p: any = new InstagramProvider();
    const calls = fakeApi(p, [[/^POST https:\/\/graph\.instagram\.com\//, () => ({ body: { id: 'c1' } })]]);
    const [res] = await p.postPending(
      'IG1',
      'IGTOKEN',
      [post({ settings: { post_type: 'post' }, media: [{ path: 'https://cdn.test/a.jpg' }] })],
      integration(),
      'graph.instagram.com'
    );
    expect(res.pendingData.type).toBe('graph.instagram.com');
    expect(calls[0].url.startsWith('https://graph.instagram.com/')).toBe(true);
  });
});

describe('LinkedIn (personal profile)', () => {
  const drive = async (p: any, data: any) => {
    let result: any;
    for (let i = 0; i < 10; i++) {
      const check = await p.checkPostStatus('TOK', data, integration());
      if (check.status === 'pending') {
        data = check.pendingData;
        continue;
      }
      result = await p.finalizePost('TOK', check.pendingData, integration());
      if (result.status === 'completed') return result;
      data = result.pendingData;
    }
    return result;
  };

  it('text post: created only after the arm is witnessed, as the person, escaped', async () => {
    const p: any = new LinkedinProvider();
    const calls = fakeApi(p, [
      [/^POST https:\/\/api\.linkedin\.com\/rest\/posts$/, () => ({ status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } })],
    ]);
    const [res] = await p.postPending('PERSON', 'TOK', [post({ message: 'Launch (beta) #1 _now_' })], integration());
    expect(res.status).toBe('pending');
    expect(calls).toHaveLength(0);

    // The first finalize only arms; nothing is created yet.
    const armed = await p.finalizePost('TOK', (await p.checkPostStatus('TOK', res.pendingData, integration())).pendingData, integration());
    expect(armed).toMatchObject({ status: 'pending', pendingData: { attempting: true, confirmed: false } });
    expect(calls).toHaveLength(0);

    const done = await drive(p, armed.pendingData);
    expect(done).toEqual({
      status: 'completed',
      postId: 'urn:li:share:1',
      releaseURL: 'https://www.linkedin.com/feed/update/urn:li:share:1',
    });
    expect(calls).toHaveLength(1);
    const payload = jsonBody(calls[0]);
    expect(payload).toMatchObject({ author: 'urn:li:person:PERSON', visibility: 'PUBLIC', lifecycleState: 'PUBLISHED' });
    expect(payload.commentary).toBe('Launch \\(beta\\) \\#1 \\_now\\_');
    expect(calls[0].headers.Authorization).toBe('Bearer TOK');
  });

  it('a witnessed attempt that comes back is never created twice', async () => {
    const p: any = new LinkedinProvider();
    const calls = fakeApi(p, []);
    await expect(
      p.checkPostStatus(
        'TOK',
        { authorId: 'PERSON', postType: 'personal', message: 'x', isPdf: false, mediaIds: [], poll: [], graceChecks: 0, attempting: true, confirmed: true },
        integration()
      )
    ).rejects.toMatchObject({ message: expect.stringContaining('may have already published') });
    expect(calls).toHaveLength(0);
  });

  it('LinkedIn refusing the post fails it', async () => {
    const p: any = new LinkedinProvider();
    fakeApi(p, [[/rest\/posts$/, () => ({ status: 422, body: {} })]]);
    await expect(
      p.finalizePost(
        'TOK',
        { authorId: 'PERSON', postType: 'personal', message: 'x', isPdf: false, mediaIds: [], poll: [], graceChecks: 0, attempting: true, confirmed: true },
        integration()
      )
    ).rejects.toMatchObject({ message: 'Error posting to LinkedIn' });
  });

  it('media processing: waits while PROCESSING, fails on PROCESSING_FAILED with the reason', async () => {
    const p: any = new LinkedinProvider();
    const data = {
      authorId: 'PERSON',
      postType: 'personal',
      message: 'x',
      isPdf: false,
      mediaIds: ['urn:li:video:1'],
      poll: [{ urn: 'urn:li:video:1', endpoint: 'videos' }],
      graceChecks: 0,
    };
    fakeApi(p, [[/rest\/videos\//, () => ({ body: { status: 'PROCESSING' } })]]);
    expect((await p.checkPostStatus('TOK', data, integration())).status).toBe('pending');
    fakeApi(p, [[/rest\/videos\//, () => ({ body: { status: 'PROCESSING_FAILED', processingFailureReason: 'Bad codec' } })]]);
    await expect(p.checkPostStatus('TOK', data, integration())).rejects.toMatchObject({
      message: 'LinkedIn video processing failed: Bad codec',
    });
  });

  it('a broken status endpoint gives up after 10 stalls, with nothing published', async () => {
    const p: any = new LinkedinProvider();
    fakeApi(p, [[/rest\/videos\//, () => new Error('503')]]);
    const data = {
      authorId: 'PERSON',
      postType: 'personal',
      message: 'x',
      isPdf: false,
      mediaIds: ['urn:li:video:1'],
      poll: [{ urn: 'urn:li:video:1', endpoint: 'videos' }],
      graceChecks: 0,
      statusStalls: 9,
    };
    const stalled = await p.checkPostStatus('TOK', data, integration());
    expect(stalled).toMatchObject({ status: 'pending', pendingData: { statusStalls: 10 } });
    await expect(p.checkPostStatus('TOK', stalled.pendingData, integration())).rejects.toMatchObject({
      message: expect.stringContaining('nothing was published'),
    });
  });

  it('a company page posts as the organization', async () => {
    const p: any = new LinkedinProvider();
    const calls = fakeApi(p, [[/rest\/posts$/, () => ({ status: 201, headers: { 'x-restli-id': 'urn:li:share:2' } })]]);
    await p.finalizePost(
      'TOK',
      { authorId: 'ORG', postType: 'company', message: 'x', isPdf: false, mediaIds: [], poll: [], graceChecks: 0, attempting: true, confirmed: true },
      integration()
    );
    expect(jsonBody(calls[0]).author).toBe('urn:li:organization:ORG');
  });
});

describe('Pinterest', () => {
  it('image pin: armed, witnessed, then one /pins call on the chosen board', async () => {
    const p: any = new PinterestProvider();
    const calls = fakeApi(p, [[/^POST .*\/v5\/pins$/, () => ({ body: { id: 'PIN1' } })]]);
    const [res] = await p.postPending(
      'U',
      'TOK',
      [post({ settings: { board: 'B1', title: 'Title', link: 'https://hookstep.in' }, media: [{ path: 'https://cdn.test/a.jpg' }] })]
    );
    expect(calls).toHaveLength(0);
    let data = res.pendingData;
    let result: any;
    for (let i = 0; i < 5; i++) {
      const check = await p.checkPostStatus('TOK', data, integration());
      result = await p.finalizePost('TOK', check.pendingData, integration());
      if (result.status === 'completed') break;
      data = result.pendingData;
    }
    expect(result).toEqual({ status: 'completed', postId: 'PIN1', releaseURL: 'https://www.pinterest.com/pin/PIN1' });
    expect(calls).toHaveLength(1);
    expect(jsonBody(calls[0])).toEqual({
      link: 'https://hookstep.in',
      title: 'Title',
      description: 'Hello world',
      board_id: 'B1',
      media_source: { source_type: 'image_url', url: 'https://cdn.test/a.jpg' },
    });
  });

  it('several images become a multi-image pin', async () => {
    const p: any = new PinterestProvider();
    const calls = fakeApi(p, [[/\/v5\/pins$/, () => ({ body: { id: 'PIN2' } })]]);
    await p.finalizePost(
      'TOK',
      {
        mediaId: '',
        message: 'm',
        settings: { board: 'B1' },
        imagePaths: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'],
        attempting: true,
        confirmed: true,
      },
      integration()
    );
    expect(jsonBody(calls[0]).media_source).toEqual({
      source_type: 'multiple_image_urls',
      items: [{ url: 'https://cdn.test/1.jpg' }, { url: 'https://cdn.test/2.jpg' }],
    });
  });

  it('video: waits for processing; a failed upload fails the post', async () => {
    const p: any = new PinterestProvider();
    const data = { mediaId: 'MED1', message: 'm', settings: { board: 'B1' }, imagePaths: [] };
    fakeApi(p, [[/\/v5\/media\/MED1$/, () => ({ body: { status: 'processing' } })]]);
    expect((await p.checkPostStatus('TOK', data, integration())).status).toBe('pending');
    fakeApi(p, [[/\/v5\/media\/MED1$/, () => ({ body: { status: 'failed' } })]]);
    await expect(p.checkPostStatus('TOK', data, integration())).rejects.toMatchObject({
      message: 'The file is corrupted and cannot be uploaded',
    });
  });

  it('a witnessed attempt that comes back is never created twice', async () => {
    const p: any = new PinterestProvider();
    const calls = fakeApi(p, []);
    await expect(
      p.checkPostStatus(
        'TOK',
        { mediaId: '', message: 'm', settings: { board: 'B1' }, imagePaths: [], attempting: true, confirmed: true },
        integration()
      )
    ).rejects.toMatchObject({ message: expect.stringContaining('may have already published') });
    expect(calls).toHaveLength(0);
  });
});
