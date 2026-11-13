/**
 * The one-time handoff that carries a channel's credentials from the Add
 * Channel page to the connect callback without a URL (connect.handoff.ts).
 *   pnpm exec jest -c apps/backend/jest.config.ts connect.handoff
 */
import {
  CONNECT_HANDOFF_ID,
  CONNECT_HANDOFF_TTL_SECONDS,
  storeConnectHandoff,
  takeConnectHandoff,
} from '@hookpost/nestjs-libraries/integrations/connect.handoff';

const fakeRedis = () => {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn(async (key: string, value: string) => {
      data.set(key, value);
      return 'OK';
    }),
    getdel: jest.fn(async (key: string) => {
      const value = data.get(key) ?? null;
      data.delete(key);
      return value;
    }),
    incr: jest.fn(async (key: string) => {
      const next = Number(data.get(key) || 0) + 1;
      data.set(key, String(next));
      return next;
    }),
    expire: jest.fn(async () => 1),
  };
};

const HANDOFF = { state: 's1', provider: 'skool', code: 'Y29va2llcw==' };

describe('connect handoff', () => {
  it('stores for a few minutes under 256 random bits, and redeems exactly once', async () => {
    const redis = fakeRedis();
    const id = (await storeConnectHandoff(redis, HANDOFF))!;
    expect(id).toMatch(CONNECT_HANDOFF_ID);
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    expect(redis.set).toHaveBeenCalledWith(
      `connect-handoff:${id}`,
      JSON.stringify(HANDOFF),
      'EX',
      CONNECT_HANDOFF_TTL_SECONDS
    );
    expect(CONNECT_HANDOFF_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(await takeConnectHandoff(redis, id)).toEqual(HANDOFF);
    expect(await takeConnectHandoff(redis, id)).toBeNull();
    // GETDEL, so two requests at once cannot both have it.
    expect(redis.getdel).toHaveBeenCalledWith(`connect-handoff:${id}`);
  });

  it('two redeems at the same moment: one wins', async () => {
    const redis = fakeRedis();
    const id = (await storeConnectHandoff(redis, HANDOFF))!;
    const results = await Promise.all([
      takeConnectHandoff(redis, id),
      takeConnectHandoff(redis, id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it.each([
    [undefined],
    [42],
    [''],
    ['short'],
    ['connect-handoff:x'],
    ['*'],
    ['A'.repeat(44)],
  ])('an id that is not ours (%p) is not even looked up', async (id) => {
    const redis = fakeRedis();
    expect(await takeConnectHandoff(redis, id)).toBeNull();
    expect(redis.getdel).not.toHaveBeenCalled();
  });

  it('a stored value that is not a handoff is null', async () => {
    const redis = fakeRedis();
    const id = 'B'.repeat(43);
    redis.data.set(`connect-handoff:${id}`, 'not json');
    expect(await takeConnectHandoff(redis, id)).toBeNull();
    redis.data.set(`connect-handoff:${id}`, JSON.stringify({ state: 's' }));
    expect(await takeConnectHandoff(redis, id)).toBeNull();
  });

  it('a connect state can make 5, then none', async () => {
    const redis = fakeRedis();
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await storeConnectHandoff(redis, HANDOFF));
    expect(ids.slice(0, 5).every((id) => typeof id === 'string')).toBe(true);
    expect(ids[5]).toBeNull();
    expect(redis.expire).toHaveBeenCalledTimes(1);
    // Another state is counted on its own.
    expect(await storeConnectHandoff(redis, { ...HANDOFF, state: 's2' })).toMatch(CONNECT_HANDOFF_ID);
  });
});
