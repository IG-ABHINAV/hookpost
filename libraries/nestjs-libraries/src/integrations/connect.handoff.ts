import { randomBytes } from 'crypto';

/**
 * A short-lived, one-time server-side handoff for the credentials of a
 * channel that connects without OAuth: the custom-field providers (Bluesky's
 * app password, a Dev.to or WordPress key, a Nostr key...) and Skool, whose
 * session cookies the Chrome extension reads.
 *
 * Those credentials used to travel to the callback page as
 * /integrations/social/<provider>?state=...&code=<base64 of the credentials>.
 * That page loads the Meta pixel, GTM, Sentry, Plausible and Dub, every one
 * of which reads the page URL, and the URL also lands in the nginx,
 * Cloudflare and Next.js request logs. Now the Add Channel page POSTs them
 * here, gets back a random id, and the callback URL carries only that id;
 * POST /integrations/social-connect/<provider> redeems it once, on the
 * server, and the credentials never come back out.
 *
 * Kept free of the Redis client so the DTO can import the constants; the
 * controller passes ioRedis in.
 */
export interface ConnectHandoff {
  state: string;
  provider: string;
  code: string;
}

/** Long enough to open the callback page; it is redeemed within seconds. */
export const CONNECT_HANDOFF_TTL_SECONDS = 300;

/** Credentials are small: a few fields, or two cookies. */
export const CONNECT_HANDOFF_MAX_CODE_LENGTH = 16 * 1024;

/** 32 random bytes, base64url: what storeConnectHandoff makes and nothing else. */
export const CONNECT_HANDOFF_ID = /^[A-Za-z0-9_-]{43}$/;

/**
 * Handoffs one connect state may make. A person retrying the form a few
 * times stays far below it; a script cannot park unbounded data in Redis.
 */
export const CONNECT_HANDOFFS_PER_STATE = 5;

const key = (id: string) => `connect-handoff:${id}`;
const countKey = (state: string) => `connect-handoff-count:${state}`;

interface HandoffRedis {
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Stores the credentials and answers the id the callback URL carries, or
 * null once this state has made CONNECT_HANDOFFS_PER_STATE handoffs.
 */
export async function storeConnectHandoff(
  redis: HandoffRedis,
  handoff: ConnectHandoff
): Promise<string | null> {
  const made = await redis.incr(countKey(handoff.state));
  if (made === 1) {
    await redis.expire(countKey(handoff.state), 3600);
  }
  if (made > CONNECT_HANDOFFS_PER_STATE) {
    return null;
  }
  const id = randomBytes(32).toString('base64url');
  await redis.set(
    key(id),
    JSON.stringify(handoff),
    'EX',
    CONNECT_HANDOFF_TTL_SECONDS
  );
  return id;
}

/**
 * The handoff, removed in the same step (GETDEL), so it can be redeemed once
 * even by two requests at the same moment. Null when there is none, it
 * expired, or the id is not one we make.
 */
export async function takeConnectHandoff(
  redis: HandoffRedis,
  id: unknown
): Promise<ConnectHandoff | null> {
  if (typeof id !== 'string' || !CONNECT_HANDOFF_ID.test(id)) {
    return null;
  }
  const raw = await redis.getdel(key(id));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.state === 'string' &&
      typeof parsed?.provider === 'string' &&
      typeof parsed?.code === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}
