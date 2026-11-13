/**
 * MarketplaceInterceptor: billing header on a 200, and repeats of a POST or
 * DELETE answered from the first call (x-request-id, Idempotency-Key).
 *   pnpm exec jest -c apps/backend/jest.config.ts marketplace.interceptor
 */
import { lastValueFrom, of, throwError } from 'rxjs';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MktError } from '@hookpost/backend/marketplace-api/marketplace.context';
import { apiMarketAdapter, rapidApiAdapter } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';

class MemoryLedger {
  values = new Map<string, string>();
  async claim(key: string) {
    if (this.values.has(key)) return false;
    this.values.set(key, 'pending');
    return true;
  }
  async read(key: string) {
    return this.values.get(key) ?? null;
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
  }
  async release(key: string) {
    this.values.delete(key);
  }
}

const context = (mkt: any, method = 'POST') => {
  const res: any = { headers: {} as Record<string, string>, setHeader(k: string, v: string) { this.headers[k] = v; } };
  const req: any = { method, mkt };
  return {
    res,
    ctx: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any,
  };
};
const mkt = (over: Record<string, unknown> = {}) => ({
  adapter: apiMarketAdapter,
  product: 'x',
  subscriber: 'u1',
  // api.market's subscriber is its own key.
  subscriberKey: (over.subscriber as string) ?? 'u1',
  credits: 0,
  ...over,
});

describe('billing', () => {
  it('bills what the handler accepted, on a read too', async () => {
    const interceptor = new MarketplaceInterceptor(new MemoryLedger() as any);
    const m = mkt();
    const { ctx, res } = context(m, 'GET');
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => { m.credits = 0; return of({ ok: true }); } }));
    expect(res.headers['X-Magicapi-Billing']).toBe('API=0;');

    const p = mkt();
    const post = context(p);
    await lastValueFrom(interceptor.intercept(post.ctx, { handle: () => { p.credits = 11; return of({ ok: true }); } }));
    expect(post.res.headers['X-Magicapi-Billing']).toBe('API=11;');
  });
});

describe('repeats', () => {
  it('answers a repeated x-request-id from the first call, without running it again, billed the same', async () => {
    const ledger = new MemoryLedger();
    const interceptor = new MarketplaceInterceptor(ledger as any);
    const handle = jest.fn();
    const first = mkt({ requestId: 'rid-1' });
    const a = context(first);
    handle.mockImplementationOnce(() => { first.credits = 3; return of({ posts: ['p1'] }); });
    expect(await lastValueFrom(interceptor.intercept(a.ctx, { handle }))).toEqual({ posts: ['p1'] });

    const b = context(mkt({ requestId: 'rid-1' }));
    expect(await lastValueFrom(interceptor.intercept(b.ctx, { handle }))).toEqual({ posts: ['p1'] });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(b.res.headers['X-Magicapi-Billing']).toBe('API=3;');
    expect(b.res.headers['Idempotent-Replay']).toBe('true');
  });

  it('answers a reused Idempotency-Key on a new call from the first, billed 0 (api.market billed the first)', async () => {
    const ledger = new MemoryLedger();
    const interceptor = new MarketplaceInterceptor(ledger as any);
    const handle = jest.fn();
    const first = mkt({ requestId: 'rid-1', idempotencyKey: 'key-123456' });
    handle.mockImplementationOnce(() => { first.credits = 3; return of({ posts: ['p1'] }); });
    await lastValueFrom(interceptor.intercept(context(first).ctx, { handle }));

    const again = context(mkt({ requestId: 'rid-2', idempotencyKey: 'key-123456' }));
    expect(await lastValueFrom(interceptor.intercept(again.ctx, { handle }))).toEqual({ posts: ['p1'] });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(again.res.headers['X-Magicapi-Billing']).toBe('API=0;');
    // The second call's own request id was not left holding anything.
    expect(ledger.values.has('mkt:idem:rid:x:u1:rid-2')).toBe(false);
  });

  it('answers 409 while the first call still runs', async () => {
    const ledger = new MemoryLedger();
    ledger.values.set('mkt:idem:rid:x:u1:rid-1', 'pending');
    const interceptor = new MarketplaceInterceptor(ledger as any);
    const handle = jest.fn();
    await expect(
      lastValueFrom(interceptor.intercept(context(mkt({ requestId: 'rid-1' })).ctx, { handle }))
    ).rejects.toMatchObject({ code: 'request_in_progress', status: 409 });
    expect(handle).not.toHaveBeenCalled();
  });

  it('lets a failed call be retried (a 4xx is never stored)', async () => {
    const ledger = new MemoryLedger();
    const interceptor = new MarketplaceInterceptor(ledger as any);
    const failing = { handle: () => throwError(() => new MktError(402, 'quota_exceeded', 'over')) };
    await expect(
      lastValueFrom(interceptor.intercept(context(mkt({ requestId: 'rid-9' })).ctx, failing))
    ).rejects.toMatchObject({ status: 402 });
    expect(ledger.values.size).toBe(0);
    const ok = { handle: () => of({ ok: 1 }) };
    expect(await lastValueFrom(interceptor.intercept(context(mkt({ requestId: 'rid-9' })).ctx, ok))).toEqual({ ok: 1 });
  });

  it('keeps answers of one subscriber from another', async () => {
    const ledger = new MemoryLedger();
    const interceptor = new MarketplaceInterceptor(ledger as any);
    await lastValueFrom(interceptor.intercept(context(mkt({ requestId: 'same' })).ctx, { handle: () => of({ mine: 1 }) }));
    const other = { handle: jest.fn(() => of({ theirs: 1 })) };
    expect(
      await lastValueFrom(interceptor.intercept(context(mkt({ subscriber: 'u2', requestId: 'same' })).ctx, other))
    ).toEqual({ theirs: 1 });
  });
});

describe('other marketplaces', () => {
  it('bills a RapidAPI call in X-RapidAPI-Billing, never in X-Magicapi-Billing, and records what it billed', async () => {
    const interceptor = new MarketplaceInterceptor(new MemoryLedger() as any);
    const m = mkt({ adapter: rapidApiAdapter, subscriber: 'jane', subscriberKey: 'rapidapi:jane', credits: 3 });
    const { res, ctx } = context(m, 'GET');
    await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ ok: true }) }));
    expect(res.headers).toEqual({ 'X-RapidAPI-Billing': 'Credits=3' });
    expect(m).toMatchObject({ billed: 3 });
  });

  it('keeps one marketplace\'s Idempotency-Key apart from another\'s buyer of the same name', async () => {
    const ledger = new MemoryLedger();
    const interceptor = new MarketplaceInterceptor(ledger as any);
    const first = mkt({ idempotencyKey: 'key-00000001', credits: 1 });
    await lastValueFrom(interceptor.intercept(context(first).ctx, { handle: () => of({ n: 1 }) }));
    const other = mkt({ adapter: rapidApiAdapter, subscriberKey: 'rapidapi:u1', idempotencyKey: 'key-00000001', credits: 1 });
    const { res, ctx } = context(other);
    const body = await lastValueFrom(interceptor.intercept(ctx, { handle: () => of({ n: 2 }) }));
    expect(body).toEqual({ n: 2 });
    expect(res.headers['Idempotent-Replay']).toBeUndefined();
    expect([...ledger.values.keys()]).toEqual(['mkt:idem:key:x:u1:key-00000001', 'mkt:idem:key:x:rapidapi:u1:key-00000001']);
  });
});
