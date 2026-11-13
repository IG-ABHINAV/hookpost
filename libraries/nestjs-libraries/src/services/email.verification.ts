import { HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ioRedis, ioRedisIsMock } from '@hookpost/nestjs-libraries/redis/redis.service';

/**
 * A password sign-up gets a session straight away and can set up its
 * workspace (connect a channel, start the trial) before it confirms its
 * email. Until someone in the workspace has confirmed theirs, nothing in it
 * is published, whichever way the post arrives (composer, public API, MCP,
 * CLI, autopost): PostsService refuses with this.
 *
 * Until 25 Oct 2026 the sign-up got no session at all until the emailed
 * link was used. In production none of the five password sign-ups from 19
 * to 25 Oct ever opened that link (nginx: no request for
 * /auth/activate/<token>), three of them inside Instagram's or Facebook's
 * browser, so they never reached onboarding or the paywall.
 */
export const EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED';

export const EMAIL_NOT_VERIFIED_MESSAGE =
  'Confirm your email address to publish. Open the link we emailed you, or send a new one from the banner at the top of Hookpost.';

export class EmailNotVerifiedException extends HttpException {
  constructor(message = EMAIL_NOT_VERIFIED_MESSAGE) {
    super({ code: EMAIL_NOT_VERIFIED, message, statusCode: 403 }, 403);
  }
}

/**
 * THE HARD GATE (owner, 29 Oct 2026, item 10): an email+password account
 * may not use Hookpost at all until it has confirmed its address. It sees
 * only "Check your inbox" (resend, change the address, sign out); the API
 * refuses everything else, and so do its workspace's API keys, MCP and
 * OAuth tokens. An account signed in through a provider that confirmed the
 * address itself (Google and every other OAuth sign-in) is never asked.
 * Deliberately not switchable by environment: there is no flag.
 *
 * This file is the one place the rule lives; the backend (AuthMiddleware,
 * the API key and OAuth token lookups, /user/self) and the frontend
 * (layout.component.tsx) read it from here.
 */
export const EMAIL_VERIFICATION_REQUIRED = 'EMAIL_VERIFICATION_REQUIRED';

export const EMAIL_VERIFICATION_REQUIRED_MESSAGE =
  'Confirm your email address to use Hookpost. Open the link we emailed you, or send a new one.';

export class EmailVerificationRequiredException extends HttpException {
  constructor() {
    super(
      {
        code: EMAIL_VERIFICATION_REQUIRED,
        message: EMAIL_VERIFICATION_REQUIRED_MESSAGE,
        statusCode: 403,
      },
      403
    );
  }
}

/** True for an email+password account that has not confirmed its address. */
export const mustVerifyEmail = (
  user: { providerName?: string | null; activated?: boolean | null } | null | undefined
): boolean => !!user && user.providerName === 'LOCAL' && user.activated !== true;

/**
 * The same rule as a Prisma filter: a user who may use Hookpost. For the
 * lookups that turn an API key or an OAuth token into a workspace, so a key
 * of a workspace with no such member resolves to nothing.
 */
export const CAN_USE_HOOKPOST: Prisma.UserWhereInput = {
  deletedAt: null,
  OR: [{ activated: true }, { providerName: { not: 'LOCAL' } }],
};

/**
 * What an unconfirmed account may still call (signed-in routes; /auth/* is
 * not behind AuthMiddleware at all): itself, signing out, and the
 * confirmation routes (status, resend, change the address).
 */
export function allowedBeforeVerification(method: string, path: string): boolean {
  const p = (path.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  const m = method.toUpperCase();
  if (m === 'GET' && p === '/user/self') return true;
  if (m === 'POST' && p === '/user/logout') return true;
  if (p === '/verify-email' && m === 'GET') return true;
  if (m === 'POST' && (p === '/verify-email/resend' || p === '/verify-email/change')) return true;
  return false;
}

/**
 * Whether a new account starts confirmed. Every OAuth sign-in does (the
 * provider confirmed the address). An email+password one does only where no
 * email can be sent at all (local development and the test suites, which run
 * without EMAIL_PROVIDER) - never in production, so a missing or broken email
 * setting there can never switch the gate off: the sign-up then waits for a
 * link instead of being let in (review of the gate PR, 1 Nov 2026).
 */
export function signUpStartsConfirmed(
  provider: string,
  hasEmailProvider: boolean,
  nodeEnv = process.env.NODE_ENV
): boolean {
  if (provider !== 'LOCAL') return true;
  return !hasEmailProvider && nodeEnv !== 'production';
}

/** How long an activation link works. A signed-in user can send a new one. */
export const ACTIVATION_LINK_TTL = '7d';

/**
 * Links sent before 25 Oct 2026 carry no exp. They are taken for this long
 * after they were issued, then refused like an expired one.
 */
export const LEGACY_ACTIVATION_LINK_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** retryAfterSeconds is 0 when allowed. */
export type Allowance = { allowed: boolean; retryAfterSeconds: number };

const ALLOWED: Allowance = { allowed: true, retryAfterSeconds: 0 };

export type ThrottleRule = {
  /** Seconds before the same key may go again. */
  cooldownSeconds: number;
  /** Most uses of the key in 24 hours. */
  dailyLimit: number;
};

/** One activation email per address per minute, and at most five a day. */
export const ACTIVATION_SEND: ThrottleRule = { cooldownSeconds: 60, dailyLimit: 5 };

/**
 * Moving an unconfirmed account to another address: a few tries, so the
 * "already has an account" answer cannot be used to test addresses in bulk.
 */
export const EMAIL_CHANGE: ThrottleRule = { cooldownSeconds: 10, dailyLimit: 5 };

/** How long the throttle waits for Redis before letting the send go. */
export const THROTTLE_REDIS_TIMEOUT_MS = 1500;

/**
 * Whether `key` may be used once more under `rule` now, counted in Redis so
 * every backend process agrees, and records the use when it is allowed. Keys
 * are lowercased and never leave Redis.
 *
 * Without Redis (ioRedisIsMock: no REDIS_URL, local development only) there
 * is nothing shared to count in, so everything is allowed. When Redis errors
 * or is slower than THROTTLE_REDIS_TIMEOUT_MS the send is allowed too: this
 * runs inside sign-up, and the client retries forever by design
 * (maxRetriesPerRequest: null), so an outage must not hold a sign-up open.
 * The email queue itself sends one email per 700 ms.
 */
export async function takeAllowance(
  scope: string,
  key: string,
  rule: ThrottleRule,
  now = Date.now(),
  timeoutMs = THROTTLE_REDIS_TIMEOUT_MS
): Promise<Allowance> {
  if (ioRedisIsMock) {
    return ALLOWED;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([countUse(scope, key, rule, now), timeout]);
    if (result === 'timeout') {
      console.warn(`[throttle] ${scope}: Redis did not answer in ${timeoutMs} ms; allowed`);
      return ALLOWED;
    }
    return result;
  } catch (err) {
    console.warn(`[throttle] ${scope}: Redis failed (${(err as Error)?.message}); allowed`);
    return ALLOWED;
  } finally {
    clearTimeout(timer);
  }
}

async function countUse(
  scope: string,
  key: string,
  rule: ThrottleRule,
  now: number
): Promise<Allowance> {
  const id = `${scope}:${String(key || '').trim().toLowerCase()}`;
  const cooldownKey = `throttle:cooldown:${id}`;
  const dayKey = `throttle:day:${id}:${new Date(now).toISOString().slice(0, 10)}`;

  const taken = await ioRedis.set(cooldownKey, '1', 'EX', rule.cooldownSeconds, 'NX');
  if (taken !== 'OK') {
    const ttl = await ioRedis.ttl(cooldownKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : rule.cooldownSeconds };
  }

  const count = await ioRedis.incr(dayKey);
  if (count === 1) {
    await ioRedis.expire(dayKey, 24 * 60 * 60);
  }
  if (count > rule.dailyLimit) {
    const ttl = await ioRedis.ttl(dayKey);
    return { allowed: false, retryAfterSeconds: ttl > 0 ? ttl : 24 * 60 * 60 };
  }
  return ALLOWED;
}

/**
 * A team invite redeemed at sign-up by an account that has to confirm its
 * email first. It is held, not joined: an invite link is not tied to an
 * address, so an unconfirmed account in someone's workspace could be the
 * owner of that address put there by whoever typed it (re-review of
 * f77349f66). The emailed link joins it (AuthService.activate); a takeover
 * of the address (Google, a reset link) drops it.
 */
export type HeldInvite = {
  orgId: string;
  id: string;
  role: 'USER' | 'ADMIN';
  timeLimit: string;
};

const heldInviteKey = (userId: string) => `held-invite:${userId}`;

/** Resolves to `fallback` instead of waiting on Redis past the timeout or on its error. */
async function redisOr<T>(work: Promise<T>, fallback: T, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[held-invite] ${what}: Redis did not answer in ${THROTTLE_REDIS_TIMEOUT_MS} ms`);
          resolve(fallback);
        }, THROTTLE_REDIS_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.warn(`[held-invite] ${what}: Redis failed (${(err as Error)?.message})`);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps the invite until it expires (at most its two days). */
export async function holdInvite(userId: string, invite: HeldInvite, now = Date.now()) {
  const seconds = Math.ceil((Date.parse(invite.timeLimit) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return false;
  }
  return redisOr(
    ioRedis
      .set(heldInviteKey(userId), JSON.stringify(invite), 'EX', Math.min(seconds, 2 * 24 * 3600))
      .then(() => true),
    false,
    'hold'
  );
}

/** The held invite, left in place (for "You've been invited to ..."); null when none. */
export async function peekHeldInvite(userId: string, now = Date.now()): Promise<HeldInvite | null> {
  const raw = await redisOr(
    ioRedis.get(heldInviteKey(userId)).then((v) => v ?? null),
    null as string | null,
    'peek'
  );
  return parseHeldInvite(raw, now);
}

function parseHeldInvite(raw: string | null, now: number): HeldInvite | null {
  if (!raw) {
    return null;
  }
  try {
    const invite = JSON.parse(raw) as HeldInvite;
    if (
      typeof invite?.orgId !== 'string' ||
      typeof invite?.id !== 'string' ||
      (invite.role !== 'USER' && invite.role !== 'ADMIN') ||
      !(Date.parse(invite.timeLimit) > now)
    ) {
      return null;
    }
    return invite;
  } catch {
    return null;
  }
}

/** The held invite, removed in the same step; null when there is none or it has expired. */
export async function takeHeldInvite(userId: string, now = Date.now()): Promise<HeldInvite | null> {
  const raw = await redisOr(
    (async () => {
      const value = await ioRedis.get(heldInviteKey(userId));
      if (value) {
        await ioRedis.del(heldInviteKey(userId));
      }
      return value ?? null;
    })(),
    null as string | null,
    'take'
  );
  return parseHeldInvite(raw, now);
}

/**
 * An invite id that has been used. The database only remembers the last
 * invite a user joined with (User.inviteId), so once that user joined
 * another team the first link worked again for anyone who had it (a
 * forwarded email). Kept as long as the invite could still be valid; the
 * database check stays behind it when Redis does not answer.
 */
const usedInviteKey = (inviteId: string) => `invite-used:${inviteId}`;

export async function markInviteUsed(
  inviteId: string,
  timeLimit: string,
  now = Date.now()
) {
  const seconds = Math.ceil((Date.parse(timeLimit) - now) / 1000);
  const ttl = Math.min(
    Number.isFinite(seconds) && seconds > 0 ? seconds : 2 * 24 * 3600,
    2 * 24 * 3600
  );
  return redisOr(
    ioRedis.set(usedInviteKey(inviteId), '1', 'EX', ttl).then(() => true),
    false,
    'mark used'
  );
}

export async function inviteMarkedUsed(inviteId: string) {
  return redisOr(
    ioRedis.get(usedInviteKey(inviteId)).then((v) => v === '1'),
    false,
    'used?'
  );
}

/** "jo@gmail.com" -> "j***@gmail.com", for log lines. */
export const maskEmail = (email: string) =>
  String(email || '').replace(/^(.)[^@]*(@.*)$/, '$1***$2');
