import { redactSecrets } from '@hookpost/nestjs-libraries/integrations/connect.log';

/**
 * What the browser reports through POST /public/client-event: the failures a
 * person sees that never reach a backend log. Production has no Sentry DSN and
 * no PostHog key, so before this the 7 Oct "Continue with Google" 500 (an
 * endless spinner, a lost signup) and the 22 Oct consent-screen 400 left no
 * trace, and nobody knew a connect had been abandoned.
 *
 * One line per event, grep for "[client]":
 *
 *   [client] spinner_stuck {"path":"/auth","ms":15000,"user":"d936df7d"}
 *
 * Never personal data: an allowlisted event name, a provider id, a path with
 * no query string, a reason with secrets and email addresses removed, and the
 * first 8 characters of the signed-in user's id when there is a session.
 */
export const CLIENT_EVENTS = [
  // A connect that left for the provider and came back with no channel.
  'connect_abandoned',
  // The OAuth callback page showed an error.
  'connect_page_error',
  // Signing up or in with a provider failed on our page.
  'signup_error',
  // A loading spinner stayed on screen for 15 seconds.
  'spinner_stuck',
  // The app's error page (global-error.tsx) was shown.
  'page_error',
] as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[number];

export interface ClientEventBody {
  event?: unknown;
  provider?: unknown;
  path?: unknown;
  reason?: unknown;
  ms?: unknown;
}

const MAX_REASON = 200;
const MAX_PATH = 120;

const isClientEvent = (event: unknown): event is ClientEvent =>
  typeof event === 'string' &&
  (CLIENT_EVENTS as readonly string[]).includes(event);

/** "/integrations/social/x" from "/integrations/social/x?code=..#..". */
export const cleanPath = (path: unknown): string | undefined => {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return undefined;
  }
  const bare = path.split(/[?#]/)[0].slice(0, MAX_PATH);
  return /^[\w\-./~%@]*$/.test(bare) ? bare : undefined;
};

export const cleanReason = (reason: unknown): string | undefined => {
  if (typeof reason !== 'string' || !reason.trim()) {
    return undefined;
  }
  return redactSecrets(reason)
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, '<email>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_REASON);
};

/**
 * The log line for one beacon, or null when it is not one we accept (unknown
 * event, wrong shape). `userId` is the verified session's user id, if any.
 */
export const clientEventLine = (
  body: ClientEventBody | null | undefined,
  userId?: string | null
): string | null => {
  if (!body || !isClientEvent(body.event)) {
    return null;
  }
  const fields: Record<string, string | number> = {};
  if (typeof body.provider === 'string' && /^[a-z0-9-]{1,40}$/.test(body.provider)) {
    fields.provider = body.provider;
  }
  const path = cleanPath(body.path);
  if (path) {
    fields.path = path;
  }
  const reason = cleanReason(body.reason);
  if (reason) {
    fields.reason = reason;
  }
  if (typeof body.ms === 'number' && Number.isFinite(body.ms) && body.ms >= 0) {
    fields.ms = Math.min(Math.round(body.ms), 24 * 3600 * 1000);
  }
  if (userId && typeof userId === 'string') {
    fields.user = userId.slice(0, 8);
  }
  return `[client] ${body.event} ${JSON.stringify(fields)}`;
};

/**
 * At most `limit` beacons per key per window, in memory: an unauthenticated
 * endpoint that writes a log line must not let one client fill the disk.
 *
 * At most `maxKeys` keys are held. Past that, expired windows go first and
 * then the oldest keys, never the whole table: clearing everything let a
 * client that sent enough distinct keys reset every other key's count (the
 * sign-in limiter, auth.rate.limit.ts, counts per email address).
 * `reset(key)` forgets one key (a successful sign-in).
 */
export const createRateLimiter = (
  limit: number,
  windowMs: number,
  maxKeys = 5000
) => {
  const hits = new Map<string, { start: number; count: number }>();
  const allow = (key: string, now = Date.now()): boolean => {
    if (hits.size >= maxKeys && !hits.has(key)) {
      for (const [k, v] of hits) {
        if (now - v.start >= windowMs) hits.delete(k);
      }
      for (const k of hits.keys()) {
        if (hits.size < maxKeys) break;
        hits.delete(k);
      }
    }
    const entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      hits.delete(key);
      hits.set(key, { start: now, count: 1 });
      return 1 <= limit;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
  return Object.assign(allow, {
    reset: (key: string) => {
      hits.delete(key);
    },
  });
};
