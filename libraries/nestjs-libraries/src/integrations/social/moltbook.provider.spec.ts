import 'reflect-metadata';
import axios, { AxiosRequestConfig } from 'axios';
import {
  MoltbookProvider,
  moltbookError,
  moltbookSubmolt,
  moltbookTitle,
} from '@hookpost/nestjs-libraries/integrations/social/moltbook.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';

const BASE = 'https://www.moltbook.com/api/v1';

// Moltbook's real answer to a wrong key, captured from the live API on
// 2026-10-20 (GET /agents/status with a made-up moltbook_ key).
const INVALID_KEY = {
  statusCode: 401,
  message: 'Invalid API key',
  hint: "API keys start with 'moltbook_'. The key you provided doesn't match any registered agent.",
  suggestion:
    'Double-check your saved Moltbook API key in ~/.config/moltbook/credentials.json, your memory, or environment variables (MOLTBOOK_API_KEY).',
  debug: { keyPrefix: 'moltbook...' },
  timestamp: '2026-10-20T04:59:33.229Z',
  path: '/api/v1/agents/status',
  error: 'Unauthorized',
};

type Reply = { status?: number; body?: any; raw?: string; fail?: Error };
type Call = {
  key: string;
  url: string;
  auth?: string;
  body: any;
  timeout?: number;
};

// A real axios instance whose adapter plays Moltbook: requests are matched by
// "METHOD /path" and answered from `replies`, so the provider's own axios
// options (validateStatus, headers, timeout, JSON parsing) are exercised and
// nothing leaves the process.
const setup = (replies: Record<string, Reply | Reply[]>) => {
  const calls: Call[] = [];
  const client = axios.create({
    adapter: async (config: AxiosRequestConfig) => {
      const url = String(config.url);
      const key = `${String(config.method).toUpperCase()} ${url.replace(
        BASE,
        ''
      )}`;
      const headers: any = config.headers || {};
      calls.push({
        key,
        url,
        auth: headers.get?.('Authorization') ?? headers.Authorization,
        body:
          typeof config.data === 'string'
            ? JSON.parse(config.data)
            : config.data,
        timeout: config.timeout,
      });

      const reply = replies[key];
      const next = Array.isArray(reply) ? reply.shift() : reply;
      if (!next) {
        throw new Error(`unexpected request ${key}`);
      }
      if (next.fail) {
        throw next.fail;
      }

      const status = next.status ?? 200;
      const response: any = {
        data: next.raw ?? JSON.stringify(next.body ?? {}),
        status,
        statusText: '',
        headers: {},
        config,
        request: {},
      };

      if (config.validateStatus && !config.validateStatus(status)) {
        const err: any = new Error(`Request failed with status code ${status}`);
        err.response = response;
        throw err;
      }
      return response;
    },
  });

  const provider: any = new MoltbookProvider();
  provider.getSsrfSafeAxios = () => client;
  provider.wait = jest.fn(async () => undefined);

  return {
    provider: provider as MoltbookProvider & { wait: jest.Mock },
    calls,
  };
};

const integration: any = { id: 'i1', name: 'agent' };
const post = (message: string, extra: any = {}): any => ({
  id: 'p1',
  message,
  settings: {},
  media: [],
  ...extra,
});

const caught = async (promise: Promise<any>) => {
  try {
    await promise;
  } catch (err) {
    return err as any;
  }
  throw new Error('expected a rejection');
};

describe('MoltbookProvider connect', () => {
  it('connects a claimed agent and stores its API key as the token', async () => {
    const s = setup({
      'GET /agents/status': { body: { status: 'claimed' } },
      'GET /agents/me': {
        body: {
          success: true,
          agent: {
            id: 'a-uuid',
            name: 'HookpostBot',
            display_name: 'Hookpost Bot',
            avatar_url: 'https://cdn/a.png',
          },
        },
      },
    });

    const auth: any = await s.provider.authenticate({
      code: '  moltbook_good  ',
      codeVerifier: '',
    });

    expect(auth).toMatchObject({
      id: 'HookpostBot',
      name: 'Hookpost Bot',
      username: 'HookpostBot',
      accessToken: 'moltbook_good',
      refreshToken: '',
      picture: 'https://cdn/a.png',
    });
    expect(auth.expiresIn).toBeGreaterThan(60 * 60 * 24 * 365 * 100);
    expect(s.calls.map((c) => c.key)).toEqual([
      'GET /agents/status',
      'GET /agents/me',
    ]);
    // always www: the bare domain's redirect drops the Authorization header
    expect(s.calls.every((c) => c.url.startsWith(BASE))).toBe(true);
    expect(s.calls.every((c) => c.auth === 'Bearer moltbook_good')).toBe(true);
    expect(s.calls.every((c) => c.timeout === 20_000)).toBe(true);
  });

  it("returns Moltbook's reason for a wrong key instead of throwing", async () => {
    const s = setup({
      'GET /agents/status': { status: 401, body: INVALID_KEY },
    });

    const auth = await s.provider.authenticate({
      code: 'moltbook_wrong',
      codeVerifier: '',
    });

    expect(auth).toBe(
      "Moltbook rejected this API key: Invalid API key. API keys start with 'moltbook_'. The key you provided doesn't match any registered agent"
    );
    expect(s.calls).toHaveLength(1);
  });

  it('asks for the key when none was pasted, without calling Moltbook', async () => {
    const s = setup({});
    expect(
      await s.provider.authenticate({ code: '   ', codeVerifier: '' })
    ).toBe('Paste the API key of your Moltbook agent');
    expect(s.calls).toHaveLength(0);
  });

  it('refuses an agent whose owner has not claimed it yet', async () => {
    const s = setup({
      'GET /agents/status': { body: { status: 'pending_claim' } },
    });

    expect(
      await s.provider.authenticate({ code: 'moltbook_new', codeVerifier: '' })
    ).toMatch(/not claimed yet/);
  });

  it('names a suspended agent rather than polling forever', async () => {
    const s = setup({
      'GET /agents/status': {
        status: 403,
        body: {
          statusCode: 403,
          message:
            'Your account is suspended: spam. Suspension ends in 5 hours',
          error: 'Forbidden',
        },
      },
    });

    expect(await s.provider.checkAgentStatus('moltbook_x')).toEqual({
      claimed: false,
      error:
        'Moltbook: Your account is suspended: spam. Suspension ends in 5 hours',
    });
  });

  it('turns a network failure into a message', async () => {
    const s = setup({
      'GET /agents/status': { fail: new Error('getaddrinfo ENOTFOUND') },
    });

    expect(
      await s.provider.authenticate({ code: 'moltbook_k', codeVerifier: '' })
    ).toMatch(/^Could not reach Moltbook.*ENOTFOUND/);
  });

  it('keeps the connect screen waiting through a Moltbook outage', async () => {
    const s = setup({
      'GET /agents/status': [
        { status: 502, raw: '<html>Bad gateway</html>' },
        { body: { status: 'pending_claim' } },
        { body: { status: 'claimed' } },
      ],
    });

    expect(await s.provider.checkAgentStatus('moltbook_k')).toEqual({
      claimed: false,
    });
    expect(await s.provider.checkAgentStatus('moltbook_k')).toEqual({
      claimed: false,
      status: 'pending_claim',
    });
    expect(await s.provider.checkAgentStatus('moltbook_k')).toEqual({
      claimed: true,
      status: 'claimed',
    });
  });
});

describe('MoltbookProvider agent registration', () => {
  it('returns the new agent from the documented body, which has no success field', async () => {
    const s = setup({
      'POST /agents/register': {
        status: 201,
        body: {
          agent: {
            api_key: 'moltbook_new',
            claim_url: 'https://www.moltbook.com/claim/moltbook_claim_x',
            verification_code: 'reef-X4B2',
          },
          important: 'SAVE YOUR API KEY!',
        },
      },
    });

    const agent = await s.provider.registerAgent('HookpostBot', 'scheduler');

    expect(agent.api_key).toBe('moltbook_new');
    expect(s.calls[0].body).toEqual({
      name: 'HookpostBot',
      description: 'scheduler',
    });
    expect(s.calls[0].auth).toBeUndefined();
  });

  it("throws Moltbook's reason when the name is taken", async () => {
    const s = setup({
      'POST /agents/register': {
        status: 409,
        body: {
          success: false,
          error: 'Agent name already taken',
          hint: 'Pick another name',
        },
      },
    });

    await expect(s.provider.registerAgent('Taken', 'x')).rejects.toThrow(
      'Agent name already taken. Pick another name'
    );
  });
});

describe('MoltbookProvider publishing', () => {
  it('posts text with the first line as title and the whole message as body', async () => {
    const s = setup({
      'POST /posts': {
        status: 201,
        body: {
          success: true,
          message: 'Post created!',
          post: { id: 'post-1', title: 'Launch day' },
        },
      },
    });

    const [res] = await s.provider.post(
      'HookpostBot',
      'moltbook_key',
      [
        post('\nLaunch day\n\nWe shipped it.', {
          settings: { submolt: ' m/AIThoughts ' },
        }),
      ],
      integration
    );

    expect(res).toEqual({
      id: 'p1',
      postId: 'post-1',
      releaseURL: 'https://www.moltbook.com/post/post-1',
      status: 'completed',
    });
    expect(s.calls[0]).toMatchObject({
      key: 'POST /posts',
      auth: 'Bearer moltbook_key',
      body: {
        submolt_name: 'aithoughts',
        title: 'Launch day',
        content: '\nLaunch day\n\nWe shipped it.',
      },
    });
    // a write is never cut short client-side (an abandoned POST may be stored)
    expect(s.calls[0].timeout).toBeFalsy();
  });

  it('posts to general when no submolt was picked', async () => {
    const s = setup({
      'POST /posts': { body: { success: true, post: { id: 'p' } } },
    });

    await s.provider.post(
      'a',
      'k',
      [post('hi', { settings: undefined })],
      integration
    );

    expect(s.calls[0].body.submolt_name).toBe('general');
  });

  it('rejects an image in the composer and never uploads it', async () => {
    const s = setup({});

    expect(
      await s.provider.checkValidity([[{ path: 'https://cdn/x.png' }]])
    ).toMatch(/text only/);
    expect(await s.provider.checkValidity([[], []])).toBe(true);

    const err = await caught(
      s.provider.post(
        'a',
        'k',
        [
          post('with image', {
            media: [{ path: 'https://cdn/x.png', type: 'image' }],
          }),
        ],
        integration
      )
    );
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/text only/);
    expect(s.calls).toHaveLength(0);
  });

  it('rejects a video the same way, including on a comment', async () => {
    const s = setup({});

    expect(
      await s.provider.checkValidity([[], [{ path: 'https://cdn/clip.mp4' }]])
    ).toMatch(/text only/);

    const err = await caught(
      s.provider.comment(
        'a',
        'post-1',
        undefined,
        'k',
        [
          post('clip', {
            media: [{ path: 'https://cdn/clip.mp4', type: 'video' }],
          }),
        ],
        integration
      )
    );
    expect(err).toBeInstanceOf(BadBody);
    expect(s.calls).toHaveLength(0);
  });

  it('flags the channel for reconnection when the key was rotated', async () => {
    const s = setup({
      'POST /posts': {
        status: 401,
        body: { ...INVALID_KEY, path: '/api/v1/posts' },
      },
    });

    const err = await caught(
      s.provider.post('a', 'moltbook_old', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(RefreshToken);
    expect(err.message).toMatch(
      /^Moltbook rejected the agent's API key \(Invalid API key\..*\)\. Reconnect the channel/
    );
  });

  it('explains the post cooldown with the wait Moltbook names', async () => {
    const s = setup({
      'POST /posts': {
        status: 429,
        body: {
          statusCode: 429,
          message: 'Rate limit exceeded',
          retry_after_minutes: 17,
        },
      },
    });

    const err = await caught(
      s.provider.post('a', 'k', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      "Moltbook allows one post every 30 minutes, or every 2 hours in an agent's first day. This agent can post again in 17 minutes"
    );
  });

  it('names the submolt that does not exist', async () => {
    const s = setup({
      'POST /posts': {
        status: 404,
        body: {
          statusCode: 404,
          message: 'Submolt not found',
          error: 'Not Found',
        },
      },
    });

    const err = await caught(
      s.provider.post(
        'a',
        'k',
        [post('hi', { settings: { submolt: 'nope' } })],
        integration
      )
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe('Submolt not found (submolt "nope")');
  });

  it('does not report a post held for an AI verification challenge as published', async () => {
    const s = setup({
      'POST /posts': {
        status: 201,
        body: {
          success: true,
          message: 'Post created! Complete verification to publish.',
          verification_required: true,
          post: {
            id: 'post-held',
            verification_status: 'pending',
            verification: {
              verification_code: 'moltbook_verify_abc',
              challenge_text: 'A] lO^bSt-Er ...',
              expires_at: '2026-10-20T12:05:00.000Z',
            },
          },
        },
      },
    });

    const err = await caught(
      s.provider.post('a', 'k', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/AI verification challenge/);
    expect(err.message).toMatch(/not visible on Moltbook/);
    // the challenge code itself is not stored with the post's error
    expect(JSON.stringify(err.details)).not.toContain('moltbook_verify_abc');
  });

  it('fails with the error and hint when Moltbook answers success:false', async () => {
    const s = setup({
      'POST /posts': {
        status: 200,
        body: {
          success: false,
          error: 'Title is required',
          hint: 'Send a title of up to 300 characters',
        },
      },
    });

    const err = await caught(
      s.provider.post('a', 'k', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      'Title is required. Send a title of up to 300 characters'
    );
  });

  it('says a server error may still have stored the post', async () => {
    const s = setup({
      'POST /posts': { status: 502, raw: '<html>502 Bad Gateway</html>' },
    });

    const err = await caught(
      s.provider.post('a', 'k', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      "Moltbook answered HTTP 502. Check the agent's profile on Moltbook before sending this post again"
    );
  });

  it('does not call a 2xx without a post id published', async () => {
    const s = setup({ 'POST /posts': { body: { success: true } } });

    const err = await caught(
      s.provider.post('a', 'k', [post('hi')], integration)
    );

    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(/did not return its id/);
  });
});

describe('MoltbookProvider comments', () => {
  it('replies under the previous comment and links to the post', async () => {
    const s = setup({
      'POST /posts/post-1/comments': {
        status: 201,
        body: { success: true, comment: { id: 'c2' } },
      },
    });

    const [res] = await s.provider.comment(
      'a',
      'post-1',
      'c1',
      'k',
      [post('second', { id: 'p2' })],
      integration
    );

    expect(s.calls[0].body).toEqual({ content: 'second', parent_id: 'c1' });
    expect(res).toEqual({
      id: 'p2',
      postId: 'c2',
      releaseURL: 'https://www.moltbook.com/post/post-1',
      status: 'completed',
    });
  });

  it('waits out the comment cooldown once and sends again', async () => {
    const s = setup({
      'POST /posts/post-1/comments': [
        {
          status: 429,
          body: {
            statusCode: 429,
            message: 'Rate limit exceeded',
            retry_after_seconds: 19.2,
            daily_remaining: 40,
          },
        },
        { status: 201, body: { success: true, comment: { id: 'c1' } } },
      ],
    });

    const [res] = await s.provider.comment(
      'a',
      'post-1',
      undefined,
      'k',
      [post('first')],
      integration
    );

    expect(s.provider.wait).toHaveBeenCalledWith(21_000);
    expect(s.calls).toHaveLength(2);
    expect(res.postId).toBe('c1');
  });

  it('gives up with a clear message when the daily comment limit is hit', async () => {
    const s = setup({
      'POST /posts/post-1/comments': {
        status: 429,
        body: {
          statusCode: 429,
          message: 'Daily comment limit reached',
          retry_after_seconds: 36000,
        },
      },
    });

    const err = await caught(
      s.provider.comment(
        'a',
        'post-1',
        undefined,
        'k',
        [post('first')],
        integration
      )
    );

    expect(s.provider.wait).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toMatch(
      /^Moltbook allows one comment every 20 seconds .* This agent can comment again in 36000 seconds$/
    );
  });
});

describe('Moltbook error mapping', () => {
  it('classifies statuses for the shared error handling', () => {
    const p = new MoltbookProvider();
    expect(p.handleErrors(JSON.stringify(INVALID_KEY), 401)?.type).toBe(
      'refresh-token'
    );
    expect(
      p.handleErrors('{"success":false,"error":"Content too long"}', 400)
    ).toEqual({ type: 'bad-body', value: 'Content too long' });
    expect(p.handleErrors('{}', 200)).toBeUndefined();
  });

  it('reads both the documented and the live error shapes', () => {
    expect(moltbookError(INVALID_KEY, 401)).toMatch(
      /^Invalid API key\. API keys start/
    );
    expect(
      moltbookError({ success: false, error: 'Nope', hint: 'Try X' }, 400)
    ).toBe('Nope. Try X');
    expect(
      moltbookError({ message: ['title too long', 'content empty'] }, 400)
    ).toBe('title too long; content empty');
    expect(moltbookError('<html>oops</html>', 503)).toBe(
      'Moltbook answered HTTP 503'
    );
    expect(moltbookError(undefined, 500)).toBe('Moltbook answered HTTP 500');
  });

  it('normalizes submolt names', () => {
    expect(moltbookSubmolt('m/General')).toBe('general');
    expect(moltbookSubmolt('/m/ai-thoughts/')).toBe('ai-thoughts');
    expect(moltbookSubmolt('')).toBe('general');
    expect(moltbookSubmolt(undefined)).toBe('general');
  });

  it('keeps titles within 300 characters', () => {
    expect(moltbookTitle('Short title\nbody')).toBe('Short title');
    const long = moltbookTitle(`${'word '.repeat(100)}end`);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith('…')).toBe(true);
    expect(moltbookTitle('x'.repeat(400)).length).toBe(300);
  });
});
