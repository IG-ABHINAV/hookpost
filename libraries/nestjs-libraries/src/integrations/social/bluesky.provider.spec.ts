import 'reflect-metadata';
import { createHash, randomBytes } from 'crypto';
import sharp from 'sharp';

// The provider talks to Bluesky through the real @atproto/api client; only
// the network is faked here (global fetch), so request shapes, lexicon output
// validation and error parsing are the library's own.

const images = new Map<string, Buffer>();
let dispatcher: any = undefined;
const isSafe = jest.fn(
  async (url: string) => !/127\.0\.0\.1|169\.254|internal/.test(String(url))
);

jest.mock(
  '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator',
  () => ({ isSafePublicHttpsUrl: (url: string) => isSafe(url) })
);
jest.mock(
  '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher',
  () => ({
    getSsrfSafeDispatcher: () => dispatcher,
    getSsrfSafeAxios: () => ({
      get: async (url: string) => {
        const data = images.get(url);
        if (!data) throw new Error(`no image at ${url}`);
        return { data };
      },
    }),
  })
);
jest.mock('@hookpost/helpers/utils/timer', () => ({
  timer: () => Promise.resolve(),
}));

import {
  BlueskyProvider,
  normalizeBlueskyCredentials,
  normalizeBlueskyService,
} from '@hookpost/nestjs-libraries/integrations/social/bluesky.provider';
import {
  BadBody,
  RefreshToken,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { AuthService } from '@hookpost/helpers/auth/auth.service';

const DID = 'did:plc:abcdefghijklmnopqrstuvwx';
const HANDLE = 'alice.bsky.social';

// A real CIDv1 (sha2-256, base32), which the client's lexicon validation
// insists on for blobs and record cids.
const base32 = (bytes: Uint8Array) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
};
const cid = (seed: string, codec = 0x55) =>
  'b' +
  base32(
    Uint8Array.from([
      0x01,
      codec,
      0x12,
      0x20,
      ...createHash('sha256').update(seed).digest(),
    ])
  );

const jwt = (scope: string) =>
  `e30.${Buffer.from(JSON.stringify({ scope, sub: DID })).toString(
    'base64url'
  )}.sig`;

const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

type Call = {
  method: string;
  url: URL;
  headers: Headers;
  body: any;
  init: any;
};

// A small Bluesky: PDS + video service + public AppView + a media host.
const fakeBluesky = (overrides: Record<string, (c: Call) => any> = {}) => {
  const calls: Call[] = [];
  const records: any[] = [];
  const blobs: { type: string; bytes: Buffer }[] = [];
  let jobPolls = 0;

  const routes: Record<string, (c: Call) => any> = {
    'com.atproto.server.createSession': () =>
      json({
        accessJwt: jwt('com.atproto.appPass'),
        refreshJwt: 'refresh',
        handle: HANDLE,
        did: DID,
        active: true,
      }),
    'app.bsky.actor.getProfile': () =>
      json({
        did: DID,
        handle: HANDLE,
        displayName: 'Alice',
        avatar: 'https://cdn.bsky.app/img/avatar/alice.jpg',
      }),
    'com.atproto.repo.uploadBlob': (c) => {
      blobs.push({ type: c.headers.get('content-type') || '', bytes: c.body });
      return json({
        blob: {
          $type: 'blob',
          ref: { $link: cid(`img${blobs.length}`) },
          mimeType: c.headers.get('content-type'),
          size: c.body.length,
        },
      });
    },
    'com.atproto.repo.createRecord': (c) => {
      records.push(c.body);
      return json({
        uri: `at://${DID}/app.bsky.feed.post/3lpost${records.length}`,
        cid: cid(`rec${records.length}`, 0x71),
      });
    },
    'com.atproto.server.getServiceAuth': () => json({ token: 'svc-token' }),
    'app.bsky.video.getUploadLimits': () =>
      json({ canUpload: true, remainingDailyVideos: 20 }),
    'app.bsky.video.uploadVideo': () =>
      json({ did: DID, jobId: 'job1', state: 'JOB_STATE_CREATED' }),
    'app.bsky.video.getJobStatus': () => {
      jobPolls++;
      return json({
        jobStatus:
          jobPolls < 2
            ? {
                did: DID,
                jobId: 'job1',
                state: 'JOB_STATE_ENCODING',
                progress: 40,
              }
            : {
                did: DID,
                jobId: 'job1',
                state: 'JOB_STATE_COMPLETED',
                blob: {
                  $type: 'blob',
                  ref: { $link: cid('video') },
                  mimeType: 'video/mp4',
                  size: 2048,
                },
              },
      });
    },
    'app.bsky.actor.searchActorsTypeahead': () =>
      json({
        actors: [
          { did: DID, handle: HANDLE, displayName: 'Alice' },
          {
            did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
            handle: 'bob.bsky.social',
          },
        ],
      }),
    'media:clip.mp4': (c) =>
      c.method === 'HEAD'
        ? new Response(null, {
            status: 200,
            headers: { 'content-length': '2048' },
          })
        : new Response(Buffer.alloc(2048), {
            status: 200,
            headers: { 'content-length': '2048' },
          }),
    ...overrides,
  };

  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input: any, init: any = {}) => {
      // Authenticated agent calls arrive as a Request (body inside it),
      // logins and the provider's own calls as (url, init).
      const isRequest =
        input &&
        typeof input === 'object' &&
        !(input instanceof URL) &&
        'method' in input;
      const url = new URL(isRequest ? input.url : String(input));
      const method = String(
        (isRequest ? input.method : init.method) || 'GET'
      ).toUpperCase();
      const headers = new Headers(
        isRequest ? input.headers : init.headers || {}
      );
      let body: any = isRequest
        ? method === 'GET' || method === 'HEAD'
          ? undefined
          : Buffer.from(await input.arrayBuffer())
        : init.body;
      // ArrayBuffer.isView, not instanceof: the client's TextEncoder output
      // comes from another realm than the jest sandbox.
      if (body && (ArrayBuffer.isView(body) || body instanceof ArrayBuffer)) {
        body = Buffer.from(body as any);
      } else if (body && typeof body.arrayBuffer === 'function') {
        body = Buffer.from(await body.arrayBuffer());
      }
      if (
        (Buffer.isBuffer(body) || typeof body === 'string') &&
        (headers.get('content-type') || '').includes('json')
      ) {
        body = JSON.parse(body.toString());
      }
      const call: Call = {
        method,
        url,
        headers,
        body,
        init,
      };
      calls.push(call);
      const key = url.pathname.startsWith('/xrpc/')
        ? url.pathname.slice('/xrpc/'.length)
        : `media:${url.pathname.split('/').pop()}`;
      const route = routes[key];
      if (!route) {
        return json({ error: 'MethodNotImplemented', message: key }, 501);
      }
      return route(call);
    });

  const called = (nsid: string) =>
    calls.filter((c) => c.url.pathname === `/xrpc/${nsid}`);

  return { calls, records, blobs, fetchMock, called };
};

const integration = (creds: any = {}) =>
  ({
    id: 'int1',
    internalId: DID,
    providerIdentifier: 'bluesky',
    customInstanceDetails: AuthService.fixedEncryption(
      JSON.stringify({
        service: 'https://bsky.social',
        identifier: HANDLE,
        password: 'abcd-efgh-ijkl-mnop',
        ...creds,
      })
    ),
  } as any);

const code = (body: any) =>
  Buffer.from(JSON.stringify(body)).toString('base64');

const connect = (provider: BlueskyProvider, body: any) =>
  provider.authenticate({
    code: code({
      service: 'https://bsky.social',
      identifier: HANDLE,
      password: 'abcd-efgh-ijkl-mnop',
      ...body,
    }),
    codeVerifier: 'none',
  });

const xrpcError = (status: number, error: string, message: string) => () =>
  json({ error, message }, status);

const postDetails = (message: string, media: any[] = []) =>
  [{ id: 'p1', message, settings: {}, media }] as any;

beforeAll(() => {
  process.env.JWT_SECRET = 'bluesky-spec-secret';
});

beforeEach(() => {
  dispatcher = undefined;
  images.clear();
  isSafe.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Bluesky connect form', () => {
  it('accepts self-hosted PDS addresses the old pattern refused', async () => {
    const fields = await new BlueskyProvider().customFields();
    const service = fields.find((f) => f.key === 'service')!;
    // the way the connect form (CustomVariables) builds its RegExp
    const parts = service.validation.split('/');
    const re = new RegExp(parts.slice(1, -1).join('/'), parts.pop());
    for (const ok of [
      'https://bsky.social',
      'bsky.social',
      'https://pds.example.com',
      'https://puffball.us-east.host.bsky.network',
    ]) {
      expect(re.test(ok)).toBe(true);
    }
    expect(re.test('https://')).toBe(false);
    expect(re.test('localhost')).toBe(false);
    expect(fields.map((f) => f.key)).toEqual([
      'service',
      'identifier',
      'password',
    ]);
  });

  it('normalizes what people actually paste', () => {
    expect(
      normalizeBlueskyCredentials({
        service: ' bsky.social/ ',
        identifier: `${String.fromCharCode(
          0x202a
        )}@alice.bsky.social${String.fromCharCode(0x202c)} `,
        password: ' abcd-efgh-ijkl-mnop\n',
      })
    ).toEqual({
      service: 'https://bsky.social',
      identifier: 'alice.bsky.social',
      password: 'abcd-efgh-ijkl-mnop',
    });
    // an email keeps its @
    expect(
      normalizeBlueskyCredentials({ identifier: 'a@b.com' }).identifier
    ).toBe('a@b.com');
    expect(normalizeBlueskyService('https://bsky.app/profile/alice')).toBe(
      'https://bsky.social'
    );
    expect(normalizeBlueskyService('')).toBe('https://bsky.social');
    expect(normalizeBlueskyService('https://pds.example.com/xrpc')).toBe(
      'https://pds.example.com'
    );
  });
});

describe('Bluesky connect (createSession)', () => {
  it('connects with an app password and reads the profile', async () => {
    const bsky = fakeBluesky();
    const res: any = await connect(new BlueskyProvider(), {
      service: 'bsky.social',
      identifier: ' @alice.bsky.social',
    });

    expect(res).toMatchObject({
      id: DID,
      name: 'Alice',
      username: HANDLE,
      picture: 'https://cdn.bsky.app/img/avatar/alice.jpg',
      accessToken: expect.any(String),
    });
    const [login] = bsky.called('com.atproto.server.createSession');
    expect(login.url.origin).toBe('https://bsky.social');
    expect(login.method).toBe('POST');
    expect(login.body).toEqual({
      identifier: HANDLE,
      password: 'abcd-efgh-ijkl-mnop',
    });
  });

  it('sends a bsky.app service URL to bsky.social instead of the web app', async () => {
    const bsky = fakeBluesky();
    await connect(new BlueskyProvider(), { service: 'https://bsky.app' });
    expect(bsky.called('com.atproto.server.createSession')[0].url.origin).toBe(
      'https://bsky.social'
    );
  });

  it('explains bad credentials instead of "Invalid credentials"', async () => {
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        401,
        'AuthenticationRequired',
        'Invalid identifier or password'
      ),
    });
    const res = await connect(new BlueskyProvider(), {});
    expect(res).toEqual(
      expect.stringContaining('did not accept this handle and App Password')
    );
  });

  it('tells someone using their account password with email 2FA what to do', async () => {
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        401,
        'AuthFactorTokenRequired',
        'A sign in code has been sent to your email address'
      ),
    });
    const res = await connect(new BlueskyProvider(), {});
    expect(res).toEqual(
      expect.stringContaining('this is your account password')
    );
  });

  it('refuses a full account password even without 2FA', async () => {
    const bsky = fakeBluesky({
      'com.atproto.server.createSession': () =>
        json({
          accessJwt: jwt('com.atproto.access'),
          refreshJwt: 'r',
          handle: HANDLE,
          did: DID,
        }),
    });
    const res = await connect(new BlueskyProvider(), {});
    expect(res).toEqual(expect.stringContaining('account password'));
    expect(bsky.called('app.bsky.actor.getProfile')).toHaveLength(0);
  });

  it('reports a sign-in rate limit and an unreachable server for what they are', async () => {
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        429,
        'RateLimitExceeded',
        'Rate Limit Exceeded'
      ),
    });
    expect(await connect(new BlueskyProvider(), {})).toEqual(
      expect.stringContaining('limiting sign-ins')
    );

    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed'));
    expect(await connect(new BlueskyProvider(), {})).toEqual(
      expect.stringContaining(
        'Could not reach a Bluesky server at https://bsky.social'
      )
    );
  });

  it('still connects when the profile read fails', async () => {
    fakeBluesky({
      'app.bsky.actor.getProfile': xrpcError(
        400,
        'InvalidRequest',
        'Profile not found'
      ),
    });
    const res: any = await connect(new BlueskyProvider(), {});
    expect(res).toMatchObject({
      id: DID,
      name: HANDLE,
      username: HANDLE,
      picture: '',
    });
  });

  it('refuses an internal service URL before sending anything', async () => {
    const bsky = fakeBluesky();
    const res = await connect(new BlueskyProvider(), {
      service: 'https://127.0.0.1:2583',
    });
    expect(res).toBe('Invalid service URL: must be a public HTTPS address');
    expect(bsky.calls).toHaveLength(0);
  });

  it('refuses an account whose DID document points the agent at an internal host', async () => {
    const bsky = fakeBluesky({
      'com.atproto.server.createSession': () =>
        json({
          accessJwt: jwt('com.atproto.appPass'),
          refreshJwt: 'r',
          handle: HANDLE,
          did: DID,
          didDoc: {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: DID,
            alsoKnownAs: [`at://${HANDLE}`],
            verificationMethod: [],
            service: [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: 'http://169.254.169.254',
              },
            ],
          },
        }),
    });
    const res = await connect(new BlueskyProvider(), {});
    expect(res).toEqual(expect.stringContaining('not public HTTPS'));
    expect(bsky.called('app.bsky.actor.getProfile')).toHaveLength(0);
  });

  it('routes every agent request through the SSRF-safe dispatcher', async () => {
    dispatcher = { name: 'ssrf-safe' };
    const bsky = fakeBluesky();
    await connect(new BlueskyProvider(), {});
    const sent = bsky.calls.filter(
      (c) => c.url.origin === 'https://bsky.social'
    );
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const c of sent) {
      expect(c.init.dispatcher).toBe(dispatcher);
    }
  });
});

describe('Bluesky publishing', () => {
  it('posts text only: logs in up front, then creates the record once', async () => {
    const bsky = fakeBluesky();
    const provider = new BlueskyProvider();

    const [res] = await provider.post(
      DID,
      'token',
      postDetails('Hello from Hookpost https://hookstep.in #bsky'),
      integration({ service: 'bsky.social', identifier: '@alice.bsky.social ' })
    );

    expect(res).toMatchObject({
      id: 'p1',
      status: 'completed',
      postId: `at://${DID}/app.bsky.feed.post/3lpost1`,
      releaseURL: `https://bsky.app/profile/${DID}/post/3lpost1`,
    });
    expect(bsky.records).toHaveLength(1);
    const { record, repo, collection } = bsky.records[0];
    expect(repo).toBe(DID);
    expect(collection).toBe('app.bsky.feed.post');
    expect(record.text).toBe('Hello from Hookpost https://hookstep.in #bsky');
    expect(record.embed).toBeUndefined();
    expect(record.facets.map((f: any) => f.features[0].$type).sort()).toEqual([
      'app.bsky.richtext.facet#link',
      'app.bsky.richtext.facet#tag',
    ]);
    // stored "@alice.bsky.social " still logs in as alice.bsky.social
    for (const login of bsky.called('com.atproto.server.createSession')) {
      expect(login.body.identifier).toBe(HANDLE);
    }
  });

  it('posts an image without its EXIF data, upright, with the right aspect ratio', async () => {
    const bsky = fakeBluesky();
    // stored 200x100 with "rotate 90°" orientation: people see it 100x200
    const photo = await sharp({
      create: { width: 200, height: 100, channels: 3, background: '#c33' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Make: 'SpecCam', Model: 'GPS-1' } })
      .toBuffer();
    expect((await sharp(photo).metadata()).exif).toBeDefined();
    images.set('https://media.hookstep.in/photo.jpg', photo);

    const [res] = await new BlueskyProvider().post(
      DID,
      'token',
      postDetails('With a photo', [
        { path: 'https://media.hookstep.in/photo.jpg', alt: 'A red square' },
      ]),
      integration()
    );

    expect(res.status).toBe('completed');
    expect(bsky.blobs).toHaveLength(1);
    expect(bsky.blobs[0].type).toBe('image/jpeg');
    const uploaded = await sharp(bsky.blobs[0].bytes).metadata();
    expect(uploaded.exif).toBeUndefined();
    expect(uploaded.orientation).toBeUndefined();
    expect([uploaded.width, uploaded.height]).toEqual([100, 200]);

    const { embed } = bsky.records[0].record;
    expect(embed.$type).toBe('app.bsky.embed.images');
    expect(embed.images).toHaveLength(1);
    expect(embed.images[0]).toMatchObject({
      alt: 'A red square',
      aspectRatio: { width: 100, height: 200 },
      image: { $type: 'blob', mimeType: 'image/jpeg' },
    });
  });

  it('shrinks an image over the blob limit before uploading it', async () => {
    const bsky = fakeBluesky();
    const noise = randomBytes(900 * 900 * 3);
    const big = await sharp(noise, {
      raw: { width: 900, height: 900, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(big.length).toBeGreaterThan(976 * 1024);
    images.set('https://media.hookstep.in/big.png', big);

    await new BlueskyProvider().post(
      DID,
      'token',
      postDetails('Big one', [{ path: 'https://media.hookstep.in/big.png' }]),
      integration()
    );

    expect(bsky.blobs[0].type).toBe('image/png');
    expect(bsky.blobs[0].bytes.length).toBeLessThanOrEqual(976 * 1024);
    const ratio = bsky.records[0].record.embed.images[0].aspectRatio;
    expect(ratio.width).toBeLessThan(900);
    expect(ratio.width).toBe(ratio.height);
  });

  it('posts a video: limits check, upload, processing, then one record', async () => {
    const bsky = fakeBluesky();
    const provider = new BlueskyProvider();
    const media = [{ path: 'https://media.hookstep.in/clip.mp4', alt: '' }];

    const [pending] = await provider.postPending(
      DID,
      'token',
      postDetails('Watch this', media),
      integration()
    );
    expect(pending).toMatchObject({
      status: 'pending',
      pendingData: { jobId: 'job1' },
    });

    // the token is asked for with an integer exp, as the PDS requires
    const [, uploadAuth] = bsky.called('com.atproto.server.getServiceAuth');
    expect(uploadAuth.url.searchParams.get('lxm')).toBe(
      'com.atproto.repo.uploadBlob'
    );
    expect(uploadAuth.url.searchParams.get('exp')).toMatch(/^\d+$/);
    const [upload] = bsky.called('app.bsky.video.uploadVideo');
    expect(upload.url.origin).toBe('https://video.bsky.app');
    expect(upload.url.searchParams.get('did')).toBe(DID);
    expect(upload.headers.get('authorization')).toBe('Bearer svc-token');
    expect(upload.headers.get('content-type')).toBe('video/mp4');
    expect(upload.headers.get('content-length')).toBe('2048');
    expect(bsky.called('app.bsky.video.getUploadLimits')).toHaveLength(1);

    // still encoding
    let check = await provider.checkPostStatus(
      'token',
      pending.pendingData,
      integration()
    );
    expect(check.status).toBe('pending');
    expect(bsky.records).toHaveLength(0);

    // drive the arm -> confirm -> publish handshake to the end
    let data: any = pending.pendingData;
    let result: any;
    for (let i = 0; i < 6 && result?.status !== 'completed'; i++) {
      check = await provider.checkPostStatus('token', data, integration());
      data = (check as any).pendingData;
      if (check.status === 'ready') {
        result = await provider.finalizePost('token', data, integration());
        if (result.status === 'pending') data = result.pendingData;
      }
    }

    expect(result).toMatchObject({
      status: 'completed',
      postId: `at://${DID}/app.bsky.feed.post/3lpost1`,
    });
    expect(bsky.records).toHaveLength(1);
    expect(bsky.records[0].record.embed).toMatchObject({
      $type: 'app.bsky.embed.video',
      video: {
        $type: 'blob',
        mimeType: 'video/mp4',
        ref: { $link: cid('video') },
      },
    });
  });

  it('follows the existing job when the service already has the video (409)', async () => {
    fakeBluesky({
      'app.bsky.video.uploadVideo': () =>
        json(
          {
            did: DID,
            jobId: 'job-old',
            state: 'JOB_STATE_COMPLETED',
            error: 'already_exists',
          },
          409
        ),
    });
    const [pending] = await new BlueskyProvider().postPending(
      DID,
      'token',
      postDetails('Again', [{ path: 'https://media.hookstep.in/clip.mp4' }]),
      integration()
    );
    expect(pending.pendingData.jobId).toBe('job-old');
  });
});

describe('Bluesky platform errors', () => {
  it('fails a rejected video upload with the reason, instead of treating it as an image post', async () => {
    const bsky = fakeBluesky({
      // the live answer to a bad token, 20 Oct 2026
      'app.bsky.video.uploadVideo': () =>
        json({ did: '', error: 'invalid token', jobId: '', state: '' }, 401),
    });
    const err = await new BlueskyProvider()
      .postPending(
        DID,
        'token',
        postDetails('x', [{ path: 'https://media.hookstep.in/clip.mp4' }]),
        integration()
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('rejected the video (invalid token)');
    expect(err.message).toContain('Nothing was published');
    expect(bsky.records).toHaveLength(0);
  });

  it('stops before streaming the file when the account cannot upload video today', async () => {
    const bsky = fakeBluesky({
      'app.bsky.video.getUploadLimits': () =>
        json({
          canUpload: false,
          message: 'You have reached your daily video upload limit',
        }),
    });
    const err = await new BlueskyProvider()
      .postPending(
        DID,
        'token',
        postDetails('x', [{ path: 'https://media.hookstep.in/clip.mp4' }]),
        integration()
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('daily video upload limit');
    expect(bsky.called('app.bsky.video.uploadVideo')).toHaveLength(0);
  });

  it('fails a video the service could not process with its message', async () => {
    fakeBluesky({
      'app.bsky.video.getJobStatus': () =>
        json({
          jobStatus: {
            did: DID,
            jobId: 'job1',
            state: 'JOB_STATE_FAILED',
            error: 'Video is too long',
            message: 'Video is too long (max 3 minutes)',
          },
        }),
    });
    const err = await new BlueskyProvider()
      .checkPostStatus(
        'token',
        { jobId: 'job1', message: 'x', media: [] },
        integration()
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      'Bluesky could not process the video (Video is too long (max 3 minutes)). Nothing was published'
    );
  });

  it("shows Bluesky's own reason when it rejects the record", async () => {
    fakeBluesky({
      'com.atproto.repo.createRecord': xrpcError(
        400,
        'InvalidRequest',
        'Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes'
      ),
    });
    const err = await new BlueskyProvider()
      .finalizePost(
        'token',
        {
          jobId: '',
          message: 'x'.repeat(301),
          media: [],
          attempting: true,
          confirmed: true,
        },
        integration()
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe(
      'Invalid app.bsky.feed.post record: Record/text must not be longer than 300 graphemes. Nothing was published'
    );
  });

  it('asks for a reconnect, with the reason, when the app password is revoked', async () => {
    const bsky = fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        401,
        'AuthenticationRequired',
        'Invalid identifier or password'
      ),
    });
    const err = await new BlueskyProvider()
      .postPending(DID, 'token', postDetails('text only'), integration())
      .catch((e) => e);
    expect(err).toBeInstanceOf(RefreshToken);
    expect(err.message).toContain('Invalid identifier or password');
    expect(err.message).toContain('Reconnect the channel');
    expect(bsky.records).toHaveLength(0);
  });

  it('says nothing was published when the login is refused at publish time', async () => {
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        401,
        'AuthenticationRequired',
        'Invalid identifier or password'
      ),
    });
    const err = await new BlueskyProvider()
      .finalizePost(
        'token',
        {
          jobId: '',
          message: 'x',
          media: [],
          attempting: true,
          confirmed: true,
        },
        integration()
      )
      .catch((e) => e);
    // a RefreshToken here makes the workflow warn "we couldn't confirm your post"
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toContain('Nothing was published');
  });

  it('fails fast on a sign-in rate limit, and keeps a Bluesky outage transient', async () => {
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        429,
        'RateLimitExceeded',
        'Rate Limit Exceeded'
      ),
    });
    const limited = await new BlueskyProvider()
      .postPending(DID, 'token', postDetails('x'), integration())
      .catch((e) => e);
    expect(limited).toBeInstanceOf(BadBody);
    expect(limited.message).toContain('limiting sign-ins');

    jest.restoreAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    fakeBluesky({
      'com.atproto.server.createSession': xrpcError(
        502,
        'UpstreamFailure',
        'Upstream Failure'
      ),
    });
    const outage = await new BlueskyProvider()
      .postPending(DID, 'token', postDetails('x'), integration())
      .catch((e) => e);
    expect(outage).not.toBeInstanceOf(BadBody);
    expect(outage).not.toBeInstanceOf(RefreshToken);
  });

  it('fails a rejected thread reply instead of leaving it to five retries', async () => {
    fakeBluesky({
      'app.bsky.feed.getPostThread': () =>
        json({
          thread: {
            $type: 'app.bsky.feed.defs#threadViewPost',
            post: {
              uri: `at://${DID}/app.bsky.feed.post/3lroot`,
              cid: cid('root', 0x71),
              author: { did: DID, handle: HANDLE },
              record: {
                $type: 'app.bsky.feed.post',
                text: 'root',
                createdAt: new Date().toISOString(),
              },
              indexedAt: new Date().toISOString(),
            },
          },
        }),
      'com.atproto.repo.createRecord': xrpcError(
        400,
        'InvalidRequest',
        'Invalid reply reference'
      ),
    });
    const err = await new BlueskyProvider()
      .comment(
        DID,
        `at://${DID}/app.bsky.feed.post/3lroot`,
        undefined,
        'token',
        postDetails('a reply'),
        integration()
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadBody);
    expect(err.message).toBe('Invalid reply reference. Nothing was published');
  });
});

describe('Bluesky mentions', () => {
  it('searches the public AppView without logging in', async () => {
    const bsky = fakeBluesky();
    const list = await new BlueskyProvider().mention(
      'token',
      { query: '@ali' },
      DID,
      integration()
    );
    expect(bsky.called('com.atproto.server.createSession')).toHaveLength(0);
    const [search] = bsky.called('app.bsky.actor.searchActorsTypeahead');
    expect(search.url.origin).toBe('https://public.api.bsky.app');
    expect(search.url.searchParams.get('q')).toBe('ali');
    expect(list).toEqual([
      { label: 'Alice', id: HANDLE, image: undefined },
      { label: 'bob.bsky.social', id: 'bob.bsky.social', image: undefined },
    ]);
  });
});
