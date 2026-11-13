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
  ValidityMedia,
} from '@hookpost/nestjs-libraries/integrations/social.abstract';
import { timer } from '@hookpost/helpers/utils/timer';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';

// Always www: Moltbook's skill.md warns that the bare domain redirects and
// the redirect drops the Authorization header.
const MOLTBOOK_API_BASE = 'https://www.moltbook.com/api/v1';
const MOLTBOOK_WEB = 'https://www.moltbook.com';

// From https://www.moltbook.com/skill.md (v1.12.0, read 2026-10-20).
const MAX_TITLE = 300;
const MAX_CONTENT = 40_000;

const TEXT_ONLY =
  'Moltbook posts are text only and its API has no media upload, so remove the image or video for this channel';

type MoltbookReply = { status: number; data: any };

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Moltbook's own explanation of a failed call. Its docs show
 * {"success": false, "error": "<what>", "hint": "<how to fix>"}; the live API
 * (probed 2026-10-20) answers NestJS-style instead,
 * {"statusCode": 401, "message": "Invalid API key", "hint": "...", "error": "Unauthorized"},
 * where `error` is only the HTTP reason phrase. So `message` wins, `error`
 * is the fallback, and the hint is appended.
 */
export function moltbookError(data: any, status: number): string {
  let body = data;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }

  const message = Array.isArray(body?.message)
    ? body.message.map(text).filter(Boolean).join('; ')
    : text(body?.message);
  const main = (
    message ||
    text(body?.error) ||
    `Moltbook answered HTTP ${status}`
  ).replace(/[.\s]+$/, '');
  // no trailing full stop: callers append their own sentence after it
  const hint = text(body?.hint)?.replace(/[.\s]+$/, '');

  return (hint && !main.includes(hint) ? `${main}. ${hint}` : main).slice(
    0,
    300
  );
}

/** "m/General " -> "general". Lookups are case-insensitive, the m/ prefix 404s. */
export function moltbookSubmolt(value: unknown): string {
  const name = String(value ?? '')
    .trim()
    .replace(/^\/?m\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
  return name || 'general';
}

/**
 * Moltbook needs a title (max 300) as well as the body. The first non-empty
 * line is the title, cut at a word boundary; the whole message is the body.
 */
export function moltbookTitle(message: string): string {
  const firstLine =
    (message || '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || '';

  if (firstLine.length <= MAX_TITLE) {
    return firstLine;
  }

  const cut = firstLine.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > MAX_TITLE / 2 ? cut.slice(0, space) : cut}…`;
}

export class MoltbookProvider extends SocialAbstract implements SocialProvider {
  // Moltbook rate-limits per API key (one post per 30 minutes, 30 writes a
  // minute), not per app, so many agents can publish at once.
  override maxConcurrentJob = 100;
  identifier = 'moltbook';
  name = 'Moltbook';
  isBetweenSteps = false;
  scopes = [] as string[];
  isWeb3 = true;
  editor = 'normal' as const;

  maxLength() {
    return MAX_CONTENT;
  }

  // An API key does not expire. When Moltbook rejects it (rotated from the
  // owner dashboard, agent deleted) there is nothing to refresh: an empty
  // token makes the refresh service mark the channel for reconnection.
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

  // seam for tests
  protected wait(ms: number) {
    return timer(ms);
  }

  // Every status comes back here so Moltbook's explanation can be read: axios
  // would otherwise throw "Request failed with status code 401" and the body
  // that says why is lost.
  private async call(
    method: 'GET' | 'POST',
    path: string,
    apiKey?: string,
    body?: any
  ): Promise<MoltbookReply> {
    const response = await this.getSsrfSafeAxios().request({
      method,
      url: `${MOLTBOOK_API_BASE}${path}`,
      ...(body !== undefined ? { data: body } : {}),
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      // Reads serve the connect screen, so a stalled Moltbook must not hang it.
      // Writes get no client timeout: an abandoned POST /posts may still be
      // stored, and the activity's own timeout reports that as unconfirmed.
      ...(method === 'GET' ? { timeout: 20_000 } : {}),
      validateStatus: () => true,
    });

    return { status: response.status, data: response.data };
  }

  private ok(reply: MoltbookReply) {
    return (
      reply.status >= 200 && reply.status < 300 && reply.data?.success !== false
    );
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry' | 'disconnect';
        value: string;
      }
    | undefined {
    if (status === 401) {
      return {
        type: 'refresh-token',
        value: `Moltbook rejected the agent's API key (${moltbookError(
          body,
          status
        )}). Reconnect the channel with the agent's current key`,
      };
    }

    if (status >= 400) {
      return { type: 'bad-body', value: moltbookError(body, status) };
    }

    return undefined;
  }

  private rateLimited(data: any, what: 'post' | 'comment') {
    const minutes = Number(data?.retry_after_minutes);
    const seconds = Number(data?.retry_after_seconds);
    const wait =
      minutes > 0
        ? `${Math.ceil(minutes)} minute${Math.ceil(minutes) === 1 ? '' : 's'}`
        : seconds > 0
        ? `${Math.ceil(seconds)} seconds`
        : '';

    return what === 'post'
      ? `Moltbook allows one post every 30 minutes, or every 2 hours in an agent's first day${
          wait ? `. This agent can post again in ${wait}` : ''
        }`
      : `Moltbook allows one comment every 20 seconds (60 in an agent's first day) and 50 a day${
          wait ? `. This agent can comment again in ${wait}` : ''
        }`;
  }

  private fail(
    reply: MoltbookReply,
    what: 'post' | 'comment',
    extra = ''
  ): never {
    const json = JSON.stringify(reply.data ?? {});
    if (reply.status === 429) {
      throw new BadBody(
        this.identifier,
        json,
        '{}',
        this.rateLimited(reply.data, what)
      );
    }

    const handled = this.handleErrors(json, reply.status);
    if (handled?.type === 'refresh-token') {
      throw new RefreshToken(this.identifier, json, '{}', handled.value);
    }

    // A server error does not say whether the post was stored: tell the user
    // to look before sending it again (and spending the 30 minute cooldown).
    const unsure =
      reply.status >= 500
        ? `. Check the agent's profile on Moltbook before sending this ${what} again`
        : '';

    throw new BadBody(
      this.identifier,
      json,
      '{}',
      `${
        handled?.value || moltbookError(reply.data, reply.status)
      }${extra}${unsure}`
    );
  }

  /**
   * Moltbook answers 2xx for content it then hides: an agent it does not trust
   * yet gets an AI verification challenge (an obfuscated maths problem to answer
   * at POST /verify within 5 minutes) and the post or comment stays out of every
   * feed until it is answered. Reporting that as published would link the user
   * to a post nobody can see, so it fails with Moltbook's reason instead.
   */
  private assertVisible(data: any, what: 'post' | 'comment') {
    const item = data?.[what];
    const pending =
      data?.verification_required === true ||
      item?.verification_status === 'pending' ||
      (!!item?.verification?.verification_code &&
        item?.verification_status !== 'verified');

    if (pending) {
      throw new BadBody(
        this.identifier,
        JSON.stringify({
          verification_required: true,
          [what]: {
            id: item?.id,
            verification_status: item?.verification_status,
          },
        }),
        '{}',
        `Moltbook is holding this ${what} back until the agent solves Moltbook's AI verification challenge, which Hookpost can't do, so it is not visible on Moltbook. Agents Moltbook trusts skip the challenge. Moltbook suspends an agent after 10 unsolved challenges in a row, so avoid retrying`
      );
    }
  }

  override async checkValidity(
    posts: Array<ValidityMedia[]>
  ): Promise<string | true> {
    return (posts || []).some((media) => (media || []).length > 0)
      ? TEXT_ONLY
      : true;
  }

  async registerAgent(name: string, description: string) {
    const reply = await this.call('POST', '/agents/register', undefined, {
      name,
      description,
    });

    // The documented success body is {"agent": {...}, "important": "..."},
    // with no `success` field. Requiring success: true used to throw away the
    // API key of an agent Moltbook had just created.
    const agent = reply.data?.agent;
    if (reply.status >= 200 && reply.status < 300 && agent?.api_key) {
      return agent;
    }

    throw new Error(
      reply.status === 429
        ? `Moltbook is limiting agent registrations right now: ${moltbookError(
            reply.data,
            reply.status
          )}`
        : moltbookError(reply.data, reply.status)
    );
  }

  /**
   * One status read for the connect screen. `error` means the key itself is
   * wrong (stop polling); no `error` with claimed false means keep waiting.
   */
  async checkAgentStatus(
    apiKey: string
  ): Promise<{ claimed: boolean; status?: string; error?: string }> {
    const reply = await this.call('GET', '/agents/status', apiKey);

    if (reply.status === 401) {
      return {
        claimed: false,
        error: `Moltbook rejected this API key: ${moltbookError(
          reply.data,
          reply.status
        )}`,
      };
    }

    // 403 and the like (suspended or deactivated agent): waiting cannot help
    // either. 429 and 5xx are passing, so the caller keeps polling.
    if (reply.status >= 400 && reply.status < 500 && reply.status !== 429) {
      return {
        claimed: false,
        error: `Moltbook: ${moltbookError(reply.data, reply.status)}`,
      };
    }

    if (reply.status !== 200) {
      return { claimed: false };
    }

    const status = text(reply.data?.status);
    return { claimed: status === 'claimed', ...(status ? { status } : {}) };
  }

  async getAgentProfile(apiKey: string) {
    const reply = await this.call('GET', '/agents/me', apiKey);
    const agent = reply.data?.agent ?? reply.data?.data?.agent;

    if (!this.ok(reply) || !agent) {
      throw new Error(moltbookError(reply.data, reply.status));
    }

    return agent;
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }): Promise<AuthTokenDetails | string> {
    const apiKey = String(params.code || '').trim();
    if (!apiKey) {
      return 'Paste the API key of your Moltbook agent';
    }

    let status: Awaited<ReturnType<MoltbookProvider['checkAgentStatus']>>;
    try {
      status = await this.checkAgentStatus(apiKey);
    } catch (err: any) {
      return `Could not reach Moltbook to check this agent (${
        err?.message || 'network error'
      }). Try again in a minute`;
    }

    if (status.error) {
      return status.error;
    }

    // An unclaimed agent is not activated yet: its owner still has to verify
    // by email and X before it can take part.
    if (status.status === 'pending_claim') {
      return 'This Moltbook agent is not claimed yet. Open its claim link, finish the email and X verification, then connect it again';
    }

    if (status.status && status.status !== 'claimed') {
      return `Moltbook reports this agent as "${status.status}", so it cannot post yet`;
    }

    let profile: any;
    try {
      profile = await this.getAgentProfile(apiKey);
    } catch (err: any) {
      return `Moltbook could not load this agent: ${
        err?.message || 'unknown error'
      }`;
    }

    return {
      id: profile.name || profile.id,
      name: profile.display_name || profile.name,
      accessToken: apiKey,
      refreshToken: '',
      expiresIn: dayjs().add(200, 'year').unix() - dayjs().unix(),
      picture: text(profile.avatar_url) || '',
      username: profile.name,
    };
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const results: PostResponse[] = [];

    for (const post of postDetails) {
      // checkValidity blocks media in the composer; the public API and MCP
      // can still send it, and dropping it silently would publish a
      // different post from the one the user wrote.
      if (post.media?.length) {
        throw new BadBody(this.identifier, '{}', '{}', TEXT_ONLY);
      }

      const submolt = moltbookSubmolt(post.settings?.submolt);
      const reply = await this.call('POST', '/posts', accessToken, {
        submolt_name: submolt,
        title: moltbookTitle(post.message),
        content: post.message,
      });

      if (!this.ok(reply)) {
        this.fail(
          reply,
          'post',
          reply.status === 404 ? ` (submolt "${submolt}")` : ''
        );
      }

      const created = reply.data?.post;
      if (!created?.id) {
        throw new BadBody(
          this.identifier,
          JSON.stringify(reply.data ?? {}),
          '{}',
          "Moltbook accepted the post but did not return its id. Check the agent's profile on Moltbook before posting again"
        );
      }

      this.assertVisible(reply.data, 'post');

      results.push({
        id: post.id,
        postId: String(created.id),
        releaseURL: `${MOLTBOOK_WEB}/post/${created.id}`,
        status: 'completed',
      });
    }

    return results;
  }

  async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const results: PostResponse[] = [];

    for (const post of postDetails) {
      if (post.media?.length) {
        throw new BadBody(this.identifier, '{}', '{}', TEXT_ONLY);
      }

      const commentData: { content: string; parent_id?: string } = {
        content: post.message,
      };

      if (lastCommentId) {
        commentData.parent_id = lastCommentId;
      }

      const path = `/posts/${encodeURIComponent(postId)}/comments`;
      let reply = await this.call('POST', path, accessToken, commentData);

      // A thread's comments go out back to back and Moltbook enforces a
      // 20 second gap (60 for a new agent). A 429 created nothing, so wait
      // out the cooldown it names once and send again.
      if (reply.status === 429) {
        const seconds = Number(reply.data?.retry_after_seconds);
        if (seconds > 0 && seconds <= 90) {
          await this.wait((Math.ceil(seconds) + 1) * 1000);
          reply = await this.call('POST', path, accessToken, commentData);
        }
      }

      if (!this.ok(reply)) {
        this.fail(reply, 'comment');
      }

      const created = reply.data?.comment;
      if (!created?.id) {
        throw new BadBody(
          this.identifier,
          JSON.stringify(reply.data ?? {}),
          '{}',
          'Moltbook accepted the comment but did not return its id. Check the post on Moltbook before adding it again'
        );
      }

      this.assertVisible(reply.data, 'comment');

      results.push({
        id: post.id,
        postId: String(created.id),
        releaseURL: `${MOLTBOOK_WEB}/post/${postId}`,
        status: 'completed',
      });
    }

    return results;
  }
}
