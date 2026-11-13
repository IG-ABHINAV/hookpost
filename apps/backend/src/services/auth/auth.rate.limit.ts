import { HttpException } from '@nestjs/common';
import { Request } from 'express';
import { createRateLimiter } from '@hookpost/nestjs-libraries/track/client.event';

/**
 * Limits on the signed-out password routes: sign-in, sign-up, forgot
 * password and the activation-email resends (P0-2 of the 1 Nov 2026 review:
 * 12 wrong passwords in 5 s all answered 400, so credential stuffing had no
 * brake). Google, One Tap and the other provider sign-ins are never counted
 * or refused here; neither is a password sign-in by itself, only failures.
 *
 * In memory, like the other limiters built on createRateLimiter: the backend
 * is one PM2 process (ops/ecosystem.config.js, fork mode). A restart forgets
 * the counts, which costs an attacker one restart's worth of guesses.
 *
 * Sign-in failures back off: the 10th wrong password for an address within
 * 15 minutes locks that address for 15 minutes (the 11th attempt answers
 * 429, right password or not), and every further lock inside a day doubles,
 * up to 24 hours. The same per address (50 failures) applies per client IP,
 * which is what stops one host trying a list of addresses. A correct
 * password clears the address's failures, and so does a password reset (the
 * lock's own message points there).
 *
 * Anyone can lock an address by typing it with wrong passwords. So that this
 * does not lock its owner out, an address and IP pair that has signed in
 * before (in this process) may still try while the address is locked, with a
 * lock of its own after 10 failures. Google sign-in is never affected.
 *
 * Requests from this machine (loopback: the test stacks, our own scripts)
 * are not counted per IP; per address they are.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MAX_KEYS = 50_000;

export const AUTH_LIMITS = {
  loginFailuresPerEmail: 10,
  loginFailuresPerIp: 50,
  loginWindowMs: 15 * MINUTE,
  loginInFlightPerEmail: 3,
  loginInFlightPerIp: 10,
  lockMs: 15 * MINUTE,
  maxLockMs: DAY,
  registerPerIp: 20,
  registerPerEmail: 10,
  forgotPerIp: 20,
  forgotPerEmail: 5,
  resendPerIp: 20,
  perHourWindowMs: HOUR,
} as const;

export const TOO_MANY_SIGN_INS =
  'Too many sign-in attempts. For your security, please wait {wait} and try again, or reset your password.';
export const TOO_MANY_REQUESTS =
  'Too many attempts. Please wait {wait} and try again.';

/** "15 minutes", "1 hour", "2 hours": the wait the message names. */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

export class TooManyAttemptsError extends HttpException {
  constructor(readonly retryAfterMs: number, template = TOO_MANY_REQUESTS) {
    super(template.replace('{wait}', describeWait(retryAfterMs)), 429);
  }
  get retryAfterSeconds() {
    return Math.max(1, Math.ceil(this.retryAfterMs / 1000));
  }
}

/**
 * Counts failures per key and locks a key that reaches `maxFailures` within
 * `windowMs`. Each lock lasts `lockMs`, doubled for every earlier lock of the
 * same key in the last day, at most `maxLockMs`.
 */
export function createFailureBackoff(options: {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  maxLockMs: number;
  maxKeys?: number;
}) {
  const maxKeys = options.maxKeys ?? MAX_KEYS;
  // allow() turns false on the maxFailures-th failure, which is the one that
  // locks: the attempt after it is refused before the password is checked.
  const failures = createRateLimiter(
    options.maxFailures - 1,
    options.windowMs,
    maxKeys
  );
  const locks = new Map<string, { until: number; strikes: number; at: number }>();

  const trim = (now: number) => {
    if (locks.size < maxKeys) return;
    for (const [k, v] of locks) {
      if (now - v.at >= DAY) locks.delete(k);
    }
    for (const k of locks.keys()) {
      if (locks.size < maxKeys) break;
      locks.delete(k);
    }
  };

  return {
    /** Milliseconds this key must still wait, 0 when it may try. */
    retryAfterMs(key: string, now = Date.now()): number {
      const lock = locks.get(key);
      return lock && lock.until > now ? lock.until - now : 0;
    },
    fail(key: string, now = Date.now()) {
      if (failures(key, now)) return;
      failures.reset(key);
      const previous = locks.get(key);
      const strikes =
        previous && now - previous.at < DAY ? previous.strikes + 1 : 1;
      const ms = Math.min(
        options.lockMs * 2 ** (strikes - 1),
        options.maxLockMs
      );
      trim(now);
      locks.delete(key);
      locks.set(key, { until: now + ms, strikes, at: now });
    },
    /** A correct password: forget the failures, keep any strike history. */
    succeed(key: string) {
      failures.reset(key);
    },
    /** A password reset: forget the failures and the lock. */
    clear(key: string) {
      failures.reset(key);
      locks.delete(key);
    },
  };
}

const isLoopback = (ip: string) =>
  !ip ||
  ip === '::1' ||
  ip.startsWith('127.') ||
  ip.startsWith('::ffff:127.');

/**
 * The visitor's address. nginx.hookpost.conf sets CF-Connecting-IP on every
 * request it passes to the backend: Cloudflare's value when the request came
 * from a Cloudflare address, else the address nginx saw. The header is
 * believed only from loopback (nginx, on the same box); a request that
 * reached the backend's port some other way is the address it came from.
 * Not nestjs-real-ip: that trusts X-Client-IP and X-Forwarded-For, which any
 * client can set.
 */
export function clientIp(req: Request | undefined): string {
  const peer = req?.socket?.remoteAddress || req?.ip || '';
  if (!isLoopback(peer)) return peer;
  const header = req?.headers?.['cf-connecting-ip'];
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  return value || peer;
}

const normalise = (email: unknown) =>
  typeof email === 'string' ? email.trim().toLowerCase() : '';

/** One set of limiters per backend process. */
export function createAuthRateLimits(limits = AUTH_LIMITS) {
  const backoff = (maxFailures: number) =>
    createFailureBackoff({
      maxFailures,
      windowMs: limits.loginWindowMs,
      lockMs: limits.lockMs,
      maxLockMs: limits.maxLockMs,
    });
  const perHour = (limit: number) =>
    createRateLimiter(limit, limits.perHourWindowMs, MAX_KEYS);

  const loginByEmail = backoff(limits.loginFailuresPerEmail);
  const loginByIp = backoff(limits.loginFailuresPerIp);
  const loginByKnownPair = backoff(limits.loginFailuresPerEmail);
  // Address and IP pairs that signed in with a password, and when: known
  // for a day after each sign-in, at most MAX_KEYS (oldest go first).
  const knownPairSeen = new Map<string, number>();
  // Sign-ins being checked right now, per address and per IP.
  const inFlight = new Map<string, number>();
  const pairKey = (email: unknown, ip: string) => `p:${normalise(email)}|${ip}`;
  const isKnownPair = (key: string, now: number) => {
    const at = knownPairSeen.get(key);
    return at !== undefined && now - at < DAY;
  };
  const hourly = {
    registerIp: perHour(limits.registerPerIp),
    registerEmail: perHour(limits.registerPerEmail),
    forgotIp: perHour(limits.forgotPerIp),
    forgotEmail: perHour(limits.forgotPerEmail),
    resendIp: perHour(limits.resendPerIp),
  };

  /** Counts one attempt per key; throws when any key is over its hour. */
  const hourlyAttempt = (
    checks: Array<[ReturnType<typeof perHour>, string]>,
    now: number
  ) => {
    // Every key is counted, so one that is over cannot be used to probe the
    // others for free.
    const over = checks
      .filter(([, key]) => !!key)
      .map(([allow, key]) => allow(key, now))
      .some((ok) => !ok);
    if (over) {
      throw new TooManyAttemptsError(limits.perHourWindowMs);
    }
  };

  return {
    /**
     * Before checking a password: throws while the address or IP is locked,
     * or while too many of its sign-ins are already being checked (failures
     * are counted when they finish, so without this a burst sent in parallel
     * would all be checked). Returns the release to call when it finishes.
     */
    beforeLogin(email: unknown, ip: string, now = Date.now()): () => void {
      const pair = pairKey(email, ip);
      // A device that signed in to this address before skips the address's
      // lock (which a stranger can set off), not its own one.
      const emailWait = isKnownPair(pair, now)
        ? loginByKnownPair.retryAfterMs(pair, now)
        : loginByEmail.retryAfterMs(`e:${normalise(email)}`, now);
      const wait = Math.max(
        emailWait,
        isLoopback(ip) ? 0 : loginByIp.retryAfterMs(`i:${ip}`, now)
      );
      if (wait > 0) throw new TooManyAttemptsError(wait, TOO_MANY_SIGN_INS);

      const keys: Array<[string, number]> = [
        [`e:${normalise(email)}`, limits.loginInFlightPerEmail],
        ...(isLoopback(ip)
          ? []
          : ([[`i:${ip}`, limits.loginInFlightPerIp]] as Array<[string, number]>)),
      ];
      if (keys.some(([key, max]) => (inFlight.get(key) || 0) >= max)) {
        throw new TooManyAttemptsError(MINUTE, TOO_MANY_SIGN_INS);
      }
      for (const [key] of keys) inFlight.set(key, (inFlight.get(key) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const [key] of keys) {
          const n = (inFlight.get(key) || 1) - 1;
          if (n > 0) inFlight.set(key, n);
          else inFlight.delete(key);
        }
      };
    },
    loginFailed(email: unknown, ip: string, now = Date.now()) {
      loginByEmail.fail(`e:${normalise(email)}`, now);
      const pair = pairKey(email, ip);
      if (isKnownPair(pair, now)) loginByKnownPair.fail(pair, now);
      if (!isLoopback(ip)) loginByIp.fail(`i:${ip}`, now);
    },
    loginSucceeded(email: unknown, ip = '', now = Date.now()) {
      loginByEmail.succeed(`e:${normalise(email)}`);
      const pair = pairKey(email, ip);
      loginByKnownPair.succeed(pair);
      if (ip && !isLoopback(ip)) {
        knownPairSeen.delete(pair);
        knownPairSeen.set(pair, now);
        if (knownPairSeen.size > MAX_KEYS) {
          knownPairSeen.delete(knownPairSeen.keys().next().value as string);
        }
      }
    },
    /** A password reset went through: the address may sign in again at once. */
    passwordReset(email: unknown) {
      loginByEmail.clear(`e:${normalise(email)}`);
    },
    register(email: unknown, ip: string, now = Date.now()) {
      hourlyAttempt(
        [
          [hourly.registerIp, isLoopback(ip) ? '' : ip],
          [hourly.registerEmail, normalise(email)],
        ],
        now
      );
    },
    forgot(email: unknown, ip: string, now = Date.now()) {
      hourlyAttempt(
        [
          [hourly.forgotIp, isLoopback(ip) ? '' : ip],
          [hourly.forgotEmail, normalise(email)],
        ],
        now
      );
    },
    /**
     * The activation-email resends. Per address they are already held to
     * 1 a minute and 5 a day in Redis (AuthService.sendActivation); this is
     * the per-IP half.
     */
    resend(ip: string, now = Date.now()) {
      hourlyAttempt([[hourly.resendIp, isLoopback(ip) ? '' : ip]], now);
    },
  };
}

export type AuthRateLimits = ReturnType<typeof createAuthRateLimits>;

/** The process-wide limiters the auth routes share. */
export const authRateLimits = createAuthRateLimits();
