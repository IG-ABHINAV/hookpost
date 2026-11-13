import { Redis } from 'ioredis';

// Create a mock Redis implementation for testing environments
class MockRedis {
  private data: Map<string, any> = new Map();

  async get(key: string) {
    return this.data.get(key);
  }

  async set(key: string, value: any) {
    this.data.set(key, value);
    return 'OK';
  }

  async del(key: string) {
    this.data.delete(key);
    return 1;
  }

  // The connect handoff (connect.handoff.ts) redeems with GETDEL and counts
  // with INCR. No expiry here, as with set().
  async getdel(key: string) {
    const value = this.data.get(key) ?? null;
    this.data.delete(key);
    return value;
  }

  async incr(key: string) {
    const next = Number(this.data.get(key) || 0) + 1;
    this.data.set(key, String(next));
    return next;
  }

  async expire() {
    return 1;
  }

  // Add other Redis methods as needed for your tests
}

/**
 * REDIS_KEY_PREFIX puts a second deployment on one Redis without the two ever
 * reading each other's keys. Unset in production, so nothing there moves; the
 * billing sandbox (ops/sandbox) sets it, because the Redis is Upstash,
 * which serves one database only and so has no index to switch to.
 *
 * ioredis applies keyPrefix to every key argument it sends, the KEYS of an
 * eval included - which is what the locks here use - so a prefixed client
 * cannot touch an unprefixed key even by accident.
 */
const keyPrefix = process.env.REDIS_KEY_PREFIX || undefined;

// Use real Redis if REDIS_URL is defined, otherwise use MockRedis
export const ioRedis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      connectTimeout: 10000,
      enableReadyCheck: false,
      ...(keyPrefix ? { keyPrefix } : {}),
    })
  : (new MockRedis() as unknown as Redis); // Type cast to Redis to maintain interface compatibility

/**
 * True when ioRedis is the in-memory stand-in above (no REDIS_URL): its set()
 * ignores NX and EX, so a lock taken with it locks nothing.
 */
export const ioRedisIsMock = ioRedis instanceof MockRedis;

if (ioRedis && typeof (ioRedis as any).on === 'function') {
  (ioRedis as any).on('error', (err: any) => {
    console.warn('[ioredis] Non-fatal Redis connection event:', err?.message || err);
  });
}
