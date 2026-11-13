import { Injectable } from '@nestjs/common';
import { ioRedis, ioRedisIsMock } from '@hookpost/nestjs-libraries/redis/redis.service';

/**
 * One amount held against one cap: our credit quota for a 28-day window, an
 * X channel's posts for a day, the YouTube uploads of a day, the X trial
 * budget of a day, or a duplicate-content marker (cap 1).
 */
export interface Hold {
  key: string;
  amount: number;
  cap: number;
  /** Seconds the counter lives after its first hold. */
  ttlSeconds: number;
  /** What the caller answers when this one is over its cap. */
  reason: string;
  /** When the counter starts again (the quota window's end), for the refusal. */
  resetsAt?: Date;
}

/**
 * Every hold or none, in one Lua call: a request that is over any one cap
 * holds nothing. Returns 0, or the 1-based index of the first hold over its
 * cap. Each key is a plain counter (INCRBY), given its TTL on first use.
 */
const RESERVE = `
for i = 1, #KEYS do
  local amount = tonumber(ARGV[(i - 1) * 3 + 1])
  local cap = tonumber(ARGV[(i - 1) * 3 + 2])
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used + amount > cap then
    return i
  end
end
for i = 1, #KEYS do
  local amount = tonumber(ARGV[(i - 1) * 3 + 1])
  local ttl = tonumber(ARGV[(i - 1) * 3 + 3])
  redis.call('INCRBY', KEYS[i], amount)
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return 0
`;

/** Gives holds back (a post that failed to save), never below 0, keeping each TTL. */
const REFUND = `
for i = 1, #KEYS do
  local left = redis.call('DECRBY', KEYS[i], tonumber(ARGV[i]))
  if left <= 0 then
    redis.call('DEL', KEYS[i])
  end
end
return 0
`;

/**
 * A token bucket per key: `rate` tokens a second up to `capacity`. Returns 1
 * when this call may go ahead, else 0.
 */
const BUCKET = `
local rate = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
tokens = math.min(capacity, tokens + math.max(0, now - ts) / 1000 * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000) + 1000)
return allowed
`;

export class LedgerUnavailableError extends Error {}

/**
 * The gateway's own counters, in Redis. Defence in depth: api.market is the
 * one billing, and it stops a hard-limit plan itself; these stop us paying X
 * for more than a plan sells if its counter ever misses some, and keep any
 * one subscriber from spamming a network through our OAuth apps.
 */
@Injectable()
export class MarketplaceLedger {
  private client() {
    // The in-memory stand-in (no REDIS_URL) has no EVAL and no NX: nothing
    // could be capped with it, so the gateway refuses instead.
    if (ioRedisIsMock) throw new LedgerUnavailableError('Redis is not configured');
    return ioRedis;
  }

  /** Holds everything, or nothing and the hold that was over its cap. */
  async reserve(holds: Hold[]): Promise<{ ok: boolean; failed?: Hold }> {
    const live = holds.filter((h) => h.amount > 0);
    if (!live.length) return { ok: true };
    const args = live.flatMap((h) => [
      String(Math.ceil(h.amount)),
      String(Math.floor(h.cap)),
      String(Math.max(1, Math.ceil(h.ttlSeconds))),
    ]);
    const failed = Number(
      await this.client().eval(RESERVE, live.length, ...live.map((h) => h.key), ...args)
    );
    return failed ? { ok: false, failed: live[failed - 1] } : { ok: true };
  }

  async refund(holds: Hold[]): Promise<void> {
    const live = holds.filter((h) => h.amount > 0);
    if (!live.length) return;
    await this.client().eval(
      REFUND,
      live.length,
      ...live.map((h) => h.key),
      ...live.map((h) => String(Math.ceil(h.amount)))
    );
  }

  async used(key: string): Promise<number> {
    return Number((await this.client().get(key)) || 0);
  }

  /** One call through the subscriber's token bucket. */
  async allow(key: string, ratePerSecond: number, capacity: number, now = Date.now()) {
    const allowed = await this.client().eval(
      BUCKET,
      1,
      key,
      String(ratePerSecond),
      String(capacity),
      String(now)
    );
    return Number(allowed) === 1;
  }

  // Idempotency (x-request-id, Idempotency-Key): a marker while the first
  // call runs, then its response for 24 hours.

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.client().set(key, 'pending', 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async read(key: string): Promise<string | null> {
    return this.client().get(key);
  }

  async store(key: string, value: string, ttlSeconds: number) {
    await this.client().set(key, value, 'EX', ttlSeconds);
  }

  async release(key: string) {
    await this.client().del(key);
  }
}

// ---------------------------------------------------------------------------
// Keys (pure, unit-tested)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A UTC day as YYYY-MM-DD. */
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** Seconds from `now` until a day after the end of the UTC day `at` falls in. */
export function secondsUntilDayAfter(at: Date, now: Date): number {
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + 2 * DAY_MS;
  return Math.max(60, Math.ceil((end - now.getTime()) / 1000));
}

export const ledgerKeys = {
  /**
   * The credits of one quota window. Keyed by the account's periodStart as
   * well as the window's index: a plan change resets periodStart, and the new
   * plan must start from 0, not from what the old plan used.
   */
  quota: (accountId: string, periodStart: Date, window: number) =>
    `mkt:q:${accountId}:${periodStart.getTime()}:${window}`,
  /** Set once a quota window passes the plan's alert point, so it is logged once. */
  quotaAlert: (quotaKey: string) => `mkt:qalert:${quotaKey.replace(/^mkt:q:/, '')}`,
  xDay: (channelId: string, day: string) => `mkt:xday:${channelId}:${day}`,
  youtubeAll: (day: string) => `mkt:ytday:all:${day}`,
  youtubeAccount: (accountId: string, day: string) => `mkt:ytday:${accountId}:${day}`,
  trialX: (day: string) => `mkt:trialx:${day}`,
  duplicate: (channelId: string, hash: string) => `mkt:dup:${channelId}:${hash}`,
  bucket: (accountId: string, kind: 'write' | 'read') => `mkt:rl:${accountId}:${kind}`,
  idemRequest: (product: string, user: string, requestId: string) =>
    `mkt:idem:rid:${product}:${user}:${requestId}`,
  idemKey: (product: string, user: string, key: string) =>
    `mkt:idem:key:${product}:${user}:${key}`,
};
