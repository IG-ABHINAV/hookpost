import {
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@hookpost/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeId } from '@hookpost/nestjs-libraries/services/make.is';
import { setHeartbeatDetails } from '@hookpost/nestjs-libraries/temporal/temporal.heartbeat';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import {
  BskyAgent,
  RichText,
  AppBskyEmbedVideo,
  AppBskyVideoDefs,
  AtpAgent,
  BlobRef,
} from '@atproto/api';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { AuthService } from '@hookpost/helpers/auth/auth.service';
import { serializeError } from '@hookpost/helpers/utils/serialize.error';
import { isSafePublicHttpsUrl } from '@hookpost/nestjs-libraries/dtos/webhooks/webhook.url.validator';
import {
  getSsrfSafeAxios,
  getSsrfSafeDispatcher,
} from '@hookpost/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import sharp from 'sharp';
import { Plug } from '@hookpost/helpers/decorators/plug.decorator';
import { timer } from '@hookpost/helpers/utils/timer';
import { stripHtmlValidation } from '@hookpost/helpers/utils/strip.html.validation';
import { Rules } from '@hookpost/nestjs-libraries/chat/rules.description.decorator';
import { hasExtension } from '@hookpost/helpers/utils/has.extension';

export const BLUESKY_DEFAULT_SERVICE = 'https://bsky.social';
const VIDEO_SERVICE = 'https://video.bsky.app';
const VIDEO_SERVICE_DID = 'did:web:video.bsky.app';
// Unauthenticated Bluesky AppView: read-only lookups (mention search) go here
// so they never spend the account's createSession budget.
const PUBLIC_APPVIEW = 'https://public.api.bsky.app';

type BlueskyCredentials = {
  service: string;
  identifier: string;
  password: string;
};

// Bidi/zero-width marks that ride along when a handle is copied out of an app.
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// The stored credentials are exactly what the connect form submitted (the
// controller saves the raw form, not what authenticate() saw), so every login
// goes through this. It fixes the inputs Bluesky rejects although the user
// typed the right thing:
// - "@alice.bsky.social": the Bluesky app shows handles with an "@", and the
//   server treats anything containing "@" as an email address (live: 400
//   InvalidEmail "Address local part cannot be empty").
// - "bsky.social" without https://, or "https://bsky.app" (the web app, which
//   answers /xrpc with a 404 HTML page) instead of the PDS.
// - stray whitespace around a pasted app password.
export function normalizeBlueskyCredentials(raw: any): BlueskyCredentials {
  const identifier = String(raw?.identifier ?? '')
    .replace(INVISIBLE_CHARS, '')
    .trim();
  return {
    service: normalizeBlueskyService(raw?.service),
    identifier:
      identifier.startsWith('@') && !identifier.slice(1).includes('@')
        ? identifier.slice(1)
        : identifier,
    password: String(raw?.password ?? '').trim(),
  };
}

export function normalizeBlueskyService(value: unknown): string {
  const text = String(value ?? '')
    .replace(INVISIBLE_CHARS, '')
    .trim();
  if (!text) {
    return BLUESKY_DEFAULT_SERVICE;
  }

  try {
    const url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
    );
    const host = url.hostname.toLowerCase();
    if (host === 'bsky.app' || host === 'www.bsky.app') {
      return BLUESKY_DEFAULT_SERVICE;
    }
    // XRPC calls use absolute /xrpc/... paths, so only the origin matters.
    return url.origin;
  } catch {
    return text;
  }
}

// Every request the agent makes goes through the SSRF-safe dispatcher. After
// login the agent switches to the PDS named in the account's DID document,
// which the server we logged in to supplies - so validating the service URL
// once at connect time was not enough to keep the agent off internal hosts.
function createAgent(service: string) {
  const dispatcher = getSsrfSafeDispatcher();
  return new BskyAgent({
    service,
    ...(dispatcher
      ? {
          fetch: ((input: any, init?: any) =>
            globalThis.fetch(input, {
              ...(init || {}),
              dispatcher,
            } as any)) as typeof globalThis.fetch,
        }
      : {}),
  });
}

// What Bluesky said, without the client's stack: XRPCError.message is the
// server's message ("Invalid identifier or password"), .error its code.
function xrpcReason(err: any): string {
  const message = typeof err?.message === 'string' ? err.message.trim() : '';
  const code = typeof err?.error === 'string' ? err.error : '';
  return (message || code || 'Unknown error').slice(0, 300);
}

const isDefinite4xx = (status: unknown) =>
  typeof status === 'number' && status >= 400 && status < 500 && status !== 429;

// The connect form's answer for a failed createSession. Every failure used to
// come back as "Invalid credentials", including an unreachable server, a rate
// limit and an account password with email 2FA on.
function loginFailureMessage(err: any, service: string): string {
  const status = err?.status;
  const code = err?.error;
  if (code === 'AuthFactorTokenRequired') {
    return 'Bluesky asked for an email sign-in code, which means this is your account password. Create an App Password in Bluesky (Settings > Privacy and Security > App Passwords) and paste that instead.';
  }
  if (code === 'AccountTakedown') {
    return 'Bluesky says this account has been taken down, so it cannot be connected.';
  }
  if (status === 429) {
    return 'Bluesky is limiting sign-ins for this account right now. Wait a few minutes and try again.';
  }
  if (
    status === 401 ||
    code === 'AuthenticationRequired' ||
    code === 'InvalidEmail'
  ) {
    return 'Bluesky did not accept this handle and App Password. Use your full handle (for example alice.bsky.social) or your account email, and an App Password from Settings > Privacy and Security > App Passwords.';
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return `${service} did not accept the sign-in (${xrpcReason(
      err
    )}). Check the Service URL: it should be https://bsky.social unless you host your own server.`;
  }
  return `Could not reach a Bluesky server at ${service}. Check the Service URL: it should be https://bsky.social unless you host your own server.`;
}

// An app password session carries the com.atproto.appPass(Privileged) scope; a
// full account login carries com.atproto.access. Only the payload is read, the
// server already verified the token.
function sessionScope(accessJwt: string): string | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(String(accessJwt).split('.')[1] || '', 'base64url').toString()
    );
    return typeof payload?.scope === 'string' ? payload.scope : undefined;
  } catch {
    return undefined;
  }
}

// Downloads an image and gets it ready for Bluesky:
// - .rotate() applies the EXIF orientation and sharp writes no metadata unless
//   asked, so the GPS position and camera details of a phone photo are not
//   published with it (the PDS stores and serves the exact bytes uploaded),
//   and the aspect ratio sent is the one people actually see.
// - shrinks it until it fits the 1,000,000-byte limit older PDS versions
//   still enforce (current lexicon allows 2 MB).
async function prepareImage(url: string, maxBytes = 976 * 1024) {
  try {
    const response = await getSsrfSafeAxios().get(url, {
      responseType: 'arraybuffer',
    });
    const source = Buffer.from(response.data);
    const { format } = await sharp(source).metadata();

    const encode = (input: sharp.Sharp) =>
      (format === 'jpeg' ? input.jpeg({ quality: 90 }) : input).toBuffer({
        resolveWithObject: true,
      });

    let { data: buffer, info } = await encode(sharp(source).rotate());
    let { width, height } = info;

    while (buffer.length > maxBytes && width >= 10 && height >= 10) {
      ({ data: buffer, info } = await encode(
        sharp(buffer).resize({
          width: Math.floor(width * 0.9),
          height: Math.floor(height * 0.9),
        })
      ));
      ({ width, height } = info);
    }

    return {
      width,
      height,
      buffer,
      mimeType: `image/${info.format === 'jpg' ? 'jpeg' : info.format}`,
    };
  } catch (error) {
    console.error('Error processing image:', error);
    throw error;
  }
}

// Best-effort preflight, like the Bluesky app does before every video upload:
// a daily limit or an unverified email is reported before the whole file is
// streamed. Any failure of the check itself is ignored - the upload's own
// answer is checked below.
async function assertCanUploadVideo(agent: AtpAgent) {
  let limits: { canUpload?: boolean; message?: string; error?: string };
  try {
    const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth(
      {
        aud: VIDEO_SERVICE_DID,
        lxm: 'app.bsky.video.getUploadLimits',
        exp: Math.floor(Date.now() / 1000) + 60 * 5,
      }
    );
    const response = await fetch(
      `${VIDEO_SERVICE}/xrpc/app.bsky.video.getUploadLimits`,
      { headers: { Authorization: `Bearer ${serviceAuth.token}` } }
    );
    if (!response.ok) {
      return;
    }
    limits = await response.json();
  } catch (err) {
    return;
  }

  if (limits?.canUpload === false) {
    throw new BadBody(
      'bluesky',
      JSON.stringify(limits),
      {} as any,
      `Bluesky won't take a video from this account right now: ${
        limits.message ||
        limits.error ||
        'the daily video upload limit is reached, or the account email is not verified'
      }. Nothing was published`
    );
  }
}

// Streams the video bytes to the Bluesky video service and returns the job
// status - it does NOT wait for the processing. The blob only exists once the
// job completes; a BlobRef can't survive JSON serialization through the
// workflow history, so callers re-read it from getVideoJobStatus when needed.
async function startVideoUpload(
  agent: AtpAgent,
  videoPath: string
): Promise<AppBskyVideoDefs.JobStatus> {
  setHeartbeatDetails('bluesky: video upload limits');
  await assertCanUploadVideo(agent);

  const { data: serviceAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${agent.dispatchUrl.host}`,
    lxm: 'com.atproto.repo.uploadBlob',
    // exp is an integer in the lexicon and Bluesky's PDS rejects a fractional
    // one (live: 400 "Expected integer value type"). The pinned xrpc client
    // happens to truncate it; the lex client the Bluesky app moved to doesn't.
    exp: Math.floor(Date.now() / 1000) + 60 * 30, // 30 minutes
  });

  // The video is never buffered in memory: the size comes from a HEAD request
  // and the bytes are streamed straight from the source into the upload.
  setHeartbeatDetails('bluesky: video size');
  const headResponse = await fetch(videoPath, {
    method: 'HEAD',
    // identity encoding so content-length matches the bytes the GET streams
    headers: { 'accept-encoding': 'identity' },
    // @ts-ignore - undici-only option; blocks SSRF to internal IPs
    dispatcher: getSsrfSafeDispatcher(),
  });
  const videoSize = Number(headResponse.headers.get('content-length') || 0);
  if (!headResponse.ok || !videoSize) {
    throw new BadBody(
      'bluesky',
      '{}',
      {} as any,
      'Could not determine the video size for Bluesky upload'
    );
  }

  setHeartbeatDetails('bluesky: read video');
  const videoResponse = await fetch(videoPath, {
    headers: { 'accept-encoding': 'identity' },
    // @ts-ignore - undici-only option; blocks SSRF to internal IPs
    dispatcher: getSsrfSafeDispatcher(),
  });
  if (!videoResponse.ok || !videoResponse.body) {
    throw new Error(`Failed to fetch video: ${videoResponse.statusText}`);
  }

  console.log('Uploading video', videoPath, videoSize);

  const uploadUrl = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.append('did', agent.session!.did);
  uploadUrl.searchParams.append('name', videoPath.split('/').pop()!);

  setHeartbeatDetails('bluesky: upload video');
  const uploadResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceAuth.token}`,
      'Content-Type': 'video/mp4',
      'Content-Length': videoSize.toString(),
    },
    body: videoResponse.body,
    // Required by undici when streaming a request body.
    duplex: 'half',
  } as any);

  // The video service answers failures with a JobStatus-shaped body and an
  // empty jobId (live: 401 {"did":"","error":"invalid token","jobId":"",
  // "state":""}). That used to be returned as a job: the empty jobId made the
  // post look image-only, and finalizePost then tried the whole upload again
  // inside the publish step before failing with an unrelated message.
  const text = await uploadResponse.text().catch(() => '');
  let parsed: any = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  // The lexicon wraps it as { jobStatus }, the service sends it bare.
  const jobStatus = (parsed?.jobStatus ?? parsed) as
    | AppBskyVideoDefs.JobStatus
    | undefined;
  console.log('JobId:', jobStatus?.jobId, 'status:', uploadResponse.status);

  if (jobStatus?.state === 'JOB_STATE_FAILED') {
    throw new BadBody(
      'bluesky',
      truncateJson(jobStatus),
      {} as any,
      videoJobFailedMessage(jobStatus)
    );
  }

  // A jobId is a job to follow - including the 409 "already_exists" answer for
  // a video the service has already processed.
  if (jobStatus?.jobId) {
    return jobStatus;
  }

  const reason =
    jobStatus?.message ||
    jobStatus?.error ||
    uploadResponse.statusText ||
    `HTTP ${uploadResponse.status}`;

  if (uploadResponse.status === 429) {
    throw new BadBody(
      'bluesky',
      text.slice(0, 2000),
      {} as any,
      `Bluesky's video service is limiting uploads from this account right now (${reason}). Nothing was published, try again later`
    );
  }

  if (isDefinite4xx(uploadResponse.status)) {
    throw new BadBody(
      'bluesky',
      text.slice(0, 2000),
      {} as any,
      `Bluesky's video service rejected the video (${reason}). Nothing was published`
    );
  }

  // 5xx or an unreadable answer: transient, nothing was published.
  throw new Error(
    `Bluesky video upload failed with HTTP ${uploadResponse.status}: ${reason}`
  );
}

function truncateJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return '{}';
  }
}

function videoJobFailedMessage(status?: { message?: string; error?: string }) {
  const reason = status?.message || status?.error;
  return reason
    ? `Bluesky could not process the video (${reason}). Nothing was published`
    : 'Bluesky could not process the video. Nothing was published';
}

// Single read of the processing job - the endpoint is public (no login), so
// status checks never spend Bluesky's strict createSession rate limits.
async function getVideoJobStatus(
  jobId: string
): Promise<AppBskyVideoDefs.JobStatus> {
  const videoAgent = new AtpAgent({ service: VIDEO_SERVICE });
  const { data: status } = await videoAgent.app.bsky.video.getJobStatus({
    jobId,
  });
  return status.jobStatus;
}

// Blocking upload+wait, used by the paths that still resolve everything inside
// one activity (comments, and post() for pre-v1.0.6 workflows).
async function uploadVideo(
  agent: AtpAgent,
  videoPath: string
): Promise<AppBskyEmbedVideo.Main> {
  const jobStatus = await startVideoUpload(agent, videoPath);
  let blob: BlobRef | undefined = jobStatus.blob;

  let attempts = 0;
  const maxAttempts = 18; // ~9 minutes at 30s interval
  while (!blob) {
    if (attempts++ >= maxAttempts) {
      throw new BadBody(
        'bluesky',
        JSON.stringify({}),
        {} as any,
        'Video upload timed out, job did not complete'
      );
    }

    const status = await getVideoJobStatus(jobStatus.jobId);
    console.log('Status:', status.state, status.progress || '');
    if (status.blob) {
      blob = status.blob;
      break;
    }

    if (status.state === 'JOB_STATE_FAILED') {
      throw new BadBody(
        'bluesky',
        truncateJson(status),
        {} as any,
        videoJobFailedMessage(status)
      );
    }

    await timer(30000);
  }

  console.log('posting video...');

  return {
    $type: 'app.bsky.embed.video',
    video: blob,
  } satisfies AppBskyEmbedVideo.Main;
}

// Travels through the workflow history between postPending, checkPostStatus
// and finalizePost - keep it small JSON: the video job id and the post
// content, never a BlobRef (it does not survive JSON serialization).
type BlueskyPendingData = {
  jobId: string; // empty for image-only posts (no asynchronous processing)
  message: string;
  media: { path: string; alt?: string }[];
  // Arm -> confirm -> publish handshake (same as the Facebook story flow):
  // finalizePost arms without mutating, checkPostStatus witnesses, and only a
  // witnessed attempt runs the create - so a create that dies with an unknown
  // outcome is detected instead of run again.
  attempting?: boolean;
  confirmed?: boolean;
  // Consecutive finalize preparation failures (login, image upload): bounded
  // so a dead integration fails with an accurate error instead of burning the
  // whole check budget and ending in a misleading "couldn't confirm" warning.
  prepFailures?: number;
};

@Rules(
  'Bluesky can have maximum 1 video or 4 pictures in one post, it can also be without attachments'
)
export class BlueskyProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 2; // Bluesky has moderate rate limits
  identifier = 'bluesky';
  name = 'Bluesky';
  // The previous text told people to switch their two-factor authentication
  // off, which is both unnecessary and bad advice to give anyone. Bluesky's own
  // documentation is explicit that the email auth factor is not applied to app
  // password logins - an app password works with 2FA left on. The real problem
  // was that this asked for the account password instead of an app password.
  toolTip =
    'Use an App Password, not your account password. Create one in Bluesky under Settings > Privacy and Security > App Passwords. App passwords work with two-factor authentication left switched on.';
  isBetweenSteps = false;
  scopes = ['write:statuses', 'profile', 'write:media'];
  editor = 'normal' as const;
  maxLength() {
    return 300;
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>
  ): Promise<string | true> {
    if (
      posts?.some(
        (p) =>
          p?.some((a) => (a?.path?.indexOf?.('mp4') ?? -1) > -1) &&
          (p?.length ?? 0) > 1
      )
    ) {
      return 'You can only upload one video per post.';
    }

    if (posts?.some((p) => (p?.length ?? 0) > 4)) {
      return 'There can be maximum 4 pictures in a post.';
    }
    return true;
  }

  async customFields() {
    return [
      {
        key: 'service',
        label: 'Service URL',
        defaultValue: BLUESKY_DEFAULT_SERVICE,
        hint: 'Leave https://bsky.social unless your account lives on your own PDS, e.g. https://pds.example.com',
        // Any host name with a dot. The old pattern allowed one dot and a TLD
        // of at most 6 letters, so the usual self-hosted form
        // https://pds.example.com was refused by the form. The backend
        // normalizes the value and checks it is a public HTTPS address.
        validation: `/^\\s*(https?:\\/\\/)?[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+(:[0-9]{1,5})?(\\/\\S*)?\\s*$/`,
        type: 'text' as const,
      },
      {
        key: 'identifier',
        label: 'Handle or email',
        hint: 'Your full handle without the @, e.g. alice.bsky.social, or the email you sign in with',
        validation: `/^.+$/`,
        type: 'text' as const,
      },
      {
        key: 'password',
        // Named for what Bluesky actually wants. Labelling it "Password"
        // invited people to paste their real account credentials, which is the
        // one input that does trip the 2FA requirement.
        label: 'App Password',
        hint: 'Create one in Bluesky under Settings > Privacy and Security > App Passwords. Not your account password.',
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

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    let raw: any;
    try {
      raw = JSON.parse(Buffer.from(params.code, 'base64').toString());
    } catch {
      return 'Could not read the connection details, please try again';
    }
    const credentials = normalizeBlueskyCredentials(raw);

    // Bluesky talks to a user-supplied service URL via BskyAgent (not our
    // `this.fetch`), so check it at the connection chokepoint as well: an
    // internal/private address can never be saved as an integration.
    // Opt-out matches the dispatcher env.
    const ssrfChecks = process.env.DISABLE_SSRF_PROTECTION !== 'true';
    if (ssrfChecks && !(await isSafePublicHttpsUrl(credentials.service))) {
      return 'Invalid service URL: must be a public HTTPS address';
    }

    if (!credentials.identifier || !credentials.password) {
      return 'Enter your Bluesky handle and an App Password';
    }

    const agent = createAgent(credentials.service);

    let session: {
      accessJwt: string;
      refreshJwt: string;
      handle: string;
      did: string;
      active?: boolean;
      status?: string;
    };
    try {
      ({ data: session } = await agent.login({
        identifier: credentials.identifier,
        password: credentials.password,
      }));
    } catch (e: any) {
      console.log(
        '[bluesky] createSession failed',
        e?.status,
        e?.error,
        e?.message
      );
      return loginFailureMessage(e, credentials.service);
    }

    // The label and tooltip ask for an App Password, but a full account
    // password also logs in when email 2FA is off - and it would then sit in
    // our database with the power to change the account's email or delete it.
    if (sessionScope(session.accessJwt) === 'com.atproto.access') {
      return 'That is your Bluesky account password. Create an App Password in Bluesky (Settings > Privacy and Security > App Passwords) and use it here instead.';
    }

    if (session.active === false) {
      return `This Bluesky account is ${
        session.status || 'not active'
      }, so it cannot post. Reactivate it in Bluesky, then connect it again.`;
    }

    // After login the agent uses the PDS from the account's DID document,
    // which the server supplies. Refuse one that points somewhere internal.
    if (
      ssrfChecks &&
      agent.pdsUrl &&
      !(await isSafePublicHttpsUrl(agent.pdsUrl.toString()))
    ) {
      return 'Invalid service URL: the account is hosted on an address that is not public HTTPS';
    }

    // The profile only decorates the channel: a failed read must not fail a
    // login that worked (it used to come back as "Invalid credentials").
    let profile: { displayName?: string; avatar?: string; handle?: string } =
      {};
    try {
      ({ data: profile } = await agent.getProfile({ actor: session.did }));
    } catch (e: any) {
      console.log('[bluesky] getProfile failed', e?.status, e?.message);
    }

    return {
      refreshToken: session.refreshJwt,
      expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
      accessToken: session.accessJwt,
      id: session.did,
      name: profile.displayName || profile.handle || session.handle,
      picture: profile.avatar || '',
      username: profile.handle || session.handle,
    };
  }

  private async getAgent(integration: Integration) {
    const credentials = normalizeBlueskyCredentials(
      JSON.parse(
        AuthService.fixedDecryption(integration.customInstanceDetails!)
      )
    );
    const agent = createAgent(credentials.service);

    try {
      await agent.login({
        identifier: credentials.identifier,
        password: credentials.password,
      });
    } catch (err: any) {
      const status = err?.status;

      // createSession is limited per account (30 per 5 minutes, 300 a day,
      // and far fewer failed attempts): an immediate retry is pointless and
      // the old path retried five times before reporting "couldn't confirm".
      if (status === 429) {
        throw new BadBody(
          'bluesky',
          serializeError(err),
          {} as any,
          'Bluesky is limiting sign-ins for this account right now. Nothing was published, try again in a few minutes'
        );
      }

      // Only a definite 4xx (bad password, account taken down) means the
      // credentials are broken. A 5xx or network error is Bluesky being
      // unavailable: let it propagate as a transient failure instead of
      // marking the channel as disconnected.
      if (isDefinite4xx(status)) {
        // serializeError: JSON.stringify(err) is '{}' for a real Error, so the
        // reason this token was considered dead was being thrown away. The
        // message is what the reconnect notification shows.
        throw new RefreshToken(
          'bluesky',
          serializeError(err),
          {} as BodyInit,
          `Bluesky no longer accepts this channel's login (${xrpcReason(
            err
          )}). The App Password may have been revoked. Reconnect the channel with a new App Password`
        );
      }

      throw err;
    }

    return agent;
  }

  private async uploadMediaForPost(
    agent: BskyAgent,
    post: PostDetails
  ): Promise<{ embed: any; images: any[] }> {
    // Separate images and videos
    const imageMedia =
      post.media?.filter((p) => !hasExtension(p.path, 'mp4')) || [];
    const videoMedia =
      post.media?.filter((p) => hasExtension(p.path, 'mp4')) || [];

    // Upload images
    const images = await Promise.all(
      imageMedia.map(async (p) => {
        const { buffer, width, height, mimeType } = await prepareImage(p.path);
        return {
          width,
          height,
          buffer: await (async () => {
            setHeartbeatDetails('bluesky: upload blob');
            // Without an encoding the blob went up as
            // application/octet-stream; Bluesky's PDS sniffs the real type,
            // a PDS that doesn't would store a blob the image embed rejects.
            return agent.uploadBlob(new Blob([buffer], { type: mimeType }), {
              encoding: mimeType,
            });
          })(),
        };
      })
    );

    // Upload videos (only one video per post is supported by Bluesky)
    let videoEmbed: AppBskyEmbedVideo.Main | null = null;
    if (videoMedia.length > 0) {
      videoEmbed = await uploadVideo(agent, videoMedia[0].path);
    }

    // Determine embed based on media types
    let embed: any = {};
    if (videoEmbed) {
      embed = videoEmbed;
    } else if (images.length > 0) {
      embed = {
        $type: 'app.bsky.embed.images',
        images: images.map((p, index) => ({
          alt: imageMedia?.[index]?.alt || '',
          image: p.buffer.data.blob,
          aspectRatio: {
            width: p.width,
            height: p.height,
          },
        })),
      };
    }

    return { embed, images };
  }

  async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const videoMedia =
      firstPost.media?.filter((p) => hasExtension(p.path, 'mp4')) || [];

    // Log in here for every post, not only for videos. A revoked App Password
    // used to surface first in finalizePost, after the post was already
    // pending - where the workflow can only say "we couldn't confirm your post,
    // check your account before posting again", although nothing was sent.
    // Failing here goes through the normal reconnect path instead.
    const agent = await this.getAgent(integration);

    // Only the video has an asynchronous processing step: start its upload job
    // now, the wait moves to checkPostStatus. Images are uploaded by
    // finalizePost (their BlobRefs can't survive JSON serialization through
    // the workflow history). Nothing here is irreversible - an unused video
    // job leaves no post behind.
    let jobId = '';
    if (videoMedia.length > 0) {
      const jobStatus = await startVideoUpload(agent, videoMedia[0].path);
      jobId = jobStatus.jobId;
    }

    return [
      {
        id: firstPost.id,
        releaseURL: '',
        postId: '',
        status: 'pending',
        pendingData: {
          jobId,
          message: firstPost.message,
          media: (firstPost.media || []).map((m) => ({
            path: m.path,
            alt: m.alt || '',
          })),
        } as BlueskyPendingData,
      },
    ];
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: BlueskyPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // A confirmed create attempt died without reporting its result: never run
    // the create again - stop with an explicit warning instead.
    if (pendingData.attempting && pendingData.confirmed) {
      throw new BadBody(
        'bluesky',
        JSON.stringify({}),
        {} as any,
        'Bluesky may have already published this post, please check your account before posting again to avoid duplicates'
      );
    }

    // witness the armed create so finalizePost knows the attempt is uniquely
    // accounted for before it mutates anything
    const witness = (): PendingCheckResponse =>
      pendingData.attempting && !pendingData.confirmed
        ? {
            status: 'ready',
            pendingData: { ...pendingData, confirmed: true },
          }
        : { status: 'ready', pendingData };

    // Image-only posts have no asynchronous processing step.
    if (!pendingData.jobId) {
      return witness();
    }

    let status: AppBskyVideoDefs.JobStatus;
    try {
      status = await getVideoJobStatus(pendingData.jobId);
    } catch (err) {
      if (err instanceof RefreshToken) {
        throw err;
      }

      // Transient status-check error: the job may finish processing just
      // fine, keep polling - if the video service stays broken the workflow
      // exhausts its checks and warns the user properly.
      return { status: 'pending', pendingData };
    }

    if (status.state === 'JOB_STATE_FAILED') {
      throw new BadBody(
        'bluesky',
        truncateJson(status),
        {} as any,
        videoJobFailedMessage(status)
      );
    }

    if (status.blob) {
      return witness();
    }

    return { status: 'pending', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: BlueskyPendingData,
    integration: Integration
  ): Promise<PendingCheckResponse> {
    // Create with an arm -> confirm -> publish handshake: the create only runs
    // after checkPostStatus witnessed the intent, so a run that dies
    // mid-create is detectable and the post is never published twice.
    if (!pendingData.attempting || !pendingData.confirmed) {
      return {
        status: 'pending',
        pendingData: { ...pendingData, attempting: true, confirmed: false },
      };
    }

    // Everything up to the create itself is preparation: none of it mutates
    // the account, so a failure here must NOT leave the confirmed handshake
    // armed - the next check would report a false "may already be published"
    // warning. Disarm and hand back to the workflow to try again instead; the
    // only unknown-outcome window left is agent.post below.
    let agent: BskyAgent;
    let embed: any = {};
    let rt: RichText;
    try {
      agent = await this.getAgent(integration);

      if (pendingData.jobId) {
        // Re-read the blob from the job (a BlobRef never travels through the
        // workflow history).
        const status = await getVideoJobStatus(pendingData.jobId);

        if (status.state === 'JOB_STATE_FAILED') {
          throw new BadBody(
            'bluesky',
            truncateJson(status),
            {} as any,
            videoJobFailedMessage(status)
          );
        }

        if (!status.blob) {
          // The blob disappeared between the check and now (or the check was
          // skipped): hand back to the workflow to keep polling.
          return {
            status: 'pending',
            pendingData: {
              ...pendingData,
              attempting: false,
              confirmed: false,
            },
          };
        }

        embed = {
          $type: 'app.bsky.embed.video',
          video: status.blob,
        } satisfies AppBskyEmbedVideo.Main;
      } else {
        const built = await this.uploadMediaForPost(agent, {
          media: pendingData.media,
        } as PostDetails);
        embed = built.embed;
      }

      rt = new RichText({
        text: pendingData.message,
      });

      await rt.detectFacets(agent);
    } catch (err) {
      // Explicit verdicts keep their meaning: a failed video job fails the
      // post.
      if (err instanceof BadBody) {
        throw err;
      }

      // postPending logged in a moment ago, so a login refused here is a
      // password revoked in between. Nothing was created; a RefreshToken from
      // this step would end the workflow with "we couldn't confirm your post,
      // check your account before posting again". Say what happened instead -
      // the next post's postPending flags the channel for reconnecting.
      if (err instanceof RefreshToken) {
        throw new BadBody(
          'bluesky',
          JSON.stringify(err.details ?? []).slice(0, 2000),
          {} as any,
          `${
            err.message || "Bluesky no longer accepts this channel's login"
          }. Nothing was published`
        );
      }

      // Repeated preparation failures mean the integration is broken, not
      // flaky: fail with an accurate message - nothing was ever created, so
      // this is safe and beats exhausting the check budget into a misleading
      // "check your account" warning.
      if ((pendingData.prepFailures || 0) >= 4) {
        throw new BadBody(
          'bluesky',
          JSON.stringify({}),
          {} as any,
          'Could not prepare the post for Bluesky, nothing was published, please try again'
        );
      }

      // Transient preparation error, nothing was created: disarm so the
      // workflow keeps polling and a later cycle re-arms.
      return {
        status: 'pending',
        pendingData: {
          ...pendingData,
          attempting: false,
          confirmed: false,
          prepFailures: (pendingData.prepFailures || 0) + 1,
        },
      };
    }

    let uri: string;
    try {
      setHeartbeatDetails('bluesky: create post');
      // @ts-ignore
      const created = await agent.post({
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
        ...(Object.keys(embed).length > 0 ? { embed } : {}),
      });
      uri = created.uri;
    } catch (err: any) {
      // A definite 4xx rejection (invalid record, payload too large) means
      // the post was NOT created: fail it properly instead of leaving the
      // armed handshake to report a false "may already be published" warning.
      // Ambiguous answers (network errors, 5xx, 429) stay on the conservative
      // unknown-outcome path. No 408 exclusion: the xrpc client maps every
      // status it does not know - including 408 - to 400 before we see it.
      if (isDefinite4xx(err?.status)) {
        // The workflow shows this as "Bluesky rejected the post: <message>",
        // so the message is Bluesky's reason (e.g. "Record/text must not be
        // longer than 300 graphemes"), not a generic sentence.
        throw new BadBody(
          'bluesky',
          JSON.stringify(err?.error || err?.message || {}),
          {} as any,
          `${xrpcReason(err)}. Nothing was published`
        );
      }

      throw err;
    }

    return {
      status: 'completed',
      postId: uri,
      releaseURL: `https://bsky.app/profile/${integration.internalId}/post/${uri
        .split('/')
        .pop()}`,
    };
  }

  // Old blocking behavior, kept for workflow versions before v1.0.6 that still
  // run and don't know how to resolve a `pending` response - they wait for the
  // processing and create the post inside the activity like before.
  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [response] = await this.postPending(
      id,
      accessToken,
      postDetails,
      integration
    );

    let pendingData = response.pendingData;
    const started = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Cap below the 10-minute activity timeout of the old workflows using
      // this method: failing here is safe (the post is only created once the
      // video is processed), timing the activity out is not - a retried
      // activity would upload and publish again.
      if (Date.now() - started > 8 * 60 * 1000) {
        throw new BadBody(
          'bluesky',
          JSON.stringify({}),
          {} as any,
          'Video upload timed out, job did not complete'
        );
      }

      const check = await this.checkPostStatus(
        accessToken,
        pendingData,
        integration
      );

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(20000);
        continue;
      }

      const result =
        check.status === 'ready'
          ? await this.finalizePost(accessToken, check.pendingData, integration)
          : check;

      if (result.status === 'completed') {
        return [
          {
            id: response.id,
            postId: result.postId,
            status: 'completed',
            releaseURL: result.releaseURL,
          },
        ];
      }

      pendingData = result.pendingData;

      // An armed pending just loops into the witnessing check; a de-armed one
      // is a transient preparation failure (login, image upload) - back off
      // before retrying instead of hammering the login endpoint.
      if (!(result.pendingData as BlueskyPendingData)?.attempting) {
        await timer(20000);
      }
    }
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const agent = await this.getAgent(integration);
    const [commentPost] = postDetails;

    const { embed } = await this.uploadMediaForPost(agent, commentPost);

    const rt = new RichText({
      text: commentPost.message,
    });

    await rt.detectFacets(agent);

    // Get the parent post info to get its CID
    const parentUri = lastCommentId || postId;

    // Fetch the parent post to get its CID
    const parentThread = await agent.getPostThread({
      uri: parentUri,
      depth: 0,
    });

    // @ts-ignore
    const parentCid = parentThread.data.thread.post?.cid;
    // @ts-ignore
    const rootUri = parentThread.data.thread.post?.record?.reply?.root?.uri || postId;
    // @ts-ignore
    const rootCid = parentThread.data.thread.post?.record?.reply?.root?.cid || parentCid;

    setHeartbeatDetails('bluesky: create post');
    let uri: string;
    try {
      // @ts-ignore
      ({ uri } = await agent.post({
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
        ...(Object.keys(embed).length > 0 ? { embed } : {}),
        reply: {
          root: {
            uri: rootUri,
            cid: rootCid,
          },
          parent: {
            uri: parentUri,
            cid: parentCid,
          },
        },
      }));
    } catch (err: any) {
      // Same rule as finalizePost: a definite 4xx means the reply was not
      // created. As a raw error the workflow retried it five times and then
      // reported "we couldn't confirm its comment was added".
      if (isDefinite4xx(err?.status)) {
        throw new BadBody(
          'bluesky',
          JSON.stringify(err?.error || err?.message || {}),
          {} as any,
          `${xrpcReason(err)}. Nothing was published`
        );
      }
      throw err;
    }

    return [
      {
        id: commentPost.id,
        postId: uri,
        status: 'completed',
        releaseURL: `https://bsky.app/profile/${id}/post/${uri
          .split('/')
          .pop()}`,
      },
    ];
  }

  @Plug({
    identifier: 'bluesky-autoRepostPost',
    title: 'Auto Repost Posts',
    description:
      'When a post reaches a certain number of likes, repost it to increase engagement (1 week old posts)',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
    ],
  })
  async autoRepostPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string }
  ) {
    // Same login path as posting: normalized credentials, SSRF-safe fetch.
    const agent = await this.getAgent(integration);

    const getThread = await agent.getPostThread({
      uri: id,
      depth: 0,
    });

    // @ts-ignore
    if (getThread.data.thread.post?.likeCount >= +fields.likesAmount) {
      await timer(2000);
      await agent.repost(
        // @ts-ignore
        getThread.data.thread.post?.uri,
        // @ts-ignore
        getThread.data.thread.post?.cid
      );
      return true;
    }

    return true;
  }

  @Plug({
    identifier: 'bluesky-autoPlugPost',
    title: 'Auto plug post',
    description:
      'When a post reaches a certain number of likes, add another post to it so your followers get notified about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    // Same login path as posting: normalized credentials, SSRF-safe fetch.
    const agent = await this.getAgent(integration);

    const getThread = await agent.getPostThread({
      uri: id,
      depth: 0,
    });

    // @ts-ignore
    if (getThread.data.thread.post?.likeCount >= +fields.likesAmount) {
      await timer(2000);
      const rt = new RichText({
        text: stripHtmlValidation('normal', fields.post, true),
      });

      await agent.post({
        text: rt.text,
        facets: rt.facets,
        createdAt: new Date().toISOString(),
        reply: {
          root: {
            // @ts-ignore
            uri: getThread.data.thread.post?.uri,
            // @ts-ignore
            cid: getThread.data.thread.post?.cid,
          },
          parent: {
            // @ts-ignore
            uri: getThread.data.thread.post?.uri,
            // @ts-ignore
            cid: getThread.data.thread.post?.cid,
          },
        },
      });
      return true;
    }

    return true;
  }

  // Mention search runs on every pause while someone types "@name" in the
  // editor. It used to log in for each one, spending the account's
  // createSession budget (30 per 5 minutes) that the scheduled posts need.
  // Bluesky's public AppView answers the same typeahead without a login.
  override async mention(
    token: string,
    d: { query: string },
    id: string,
    integration: Integration
  ) {
    const query = String(d?.query || '')
      .replace(/^@/, '')
      .trim();
    if (!query) {
      return [];
    }

    const appView = new AtpAgent({ service: PUBLIC_APPVIEW });
    const list = await appView.app.bsky.actor.searchActorsTypeahead({
      q: query,
      limit: 10,
    });

    return list.data.actors.map((p) => ({
      label: p.displayName || p.handle,
      id: p.handle,
      image: p.avatar,
    }));
  }

  mentionFormat(idOrHandle: string, name: string) {
    return `@${idOrHandle}`;
  }
}
