/**
 * GET/HEAD /mkt/v1/<product> (served as /api/mkt/v1/<product>): the bare
 * product root answers 200 without the gateway's auth, over real HTTP with
 * the real MarketplaceApiModule wiring, and every other /mkt/v1 route still
 * refuses a call that carries no gateway secret. Database, Redis and the
 * service are fakes; nothing here reads .env.
 *   pnpm exec jest -c apps/backend/jest.config.ts root.controller
 */
import 'reflect-metadata';
import { Global, INestApplication, Module, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';

jest.mock('@hookpost/nestjs-libraries/redis/redis.service', () => {
  const chain: any = { incr: () => chain, expire: () => chain, exec: async () => [] };
  return { ioRedis: { multi: () => chain }, ioRedisIsMock: false };
});
jest.mock('@hookpost/nestjs-libraries/upload/upload.module', () => {
  const { Module } = jest.requireActual('@nestjs/common');
  @Module({})
  class UploadModule {}
  return { UploadModule };
});
// The service loads every social network (one of them ESM-only).
jest.mock('@hookpost/backend/marketplace-api/marketplace.service', () => ({
  MarketplaceService: class MarketplaceService {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service', () => ({
  MarketplaceAccountService: class MarketplaceAccountService {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository', () => ({
  MarketplaceAccountRepository: class MarketplaceAccountRepository {},
}));
jest.mock('@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service', () => ({
  MarketplaceUsageService: class MarketplaceUsageService {},
  NO_PRODUCT: '-',
  UNKNOWN_MARKETPLACE: 'UNKNOWN',
}));
jest.mock('@hookpost/nestjs-libraries/sentry/initialize.sentry', () => ({ setSentryUserContext: () => undefined }));

import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  MarketplaceApiModule,
  marketplaceControllers,
} from '@hookpost/backend/marketplace-api/marketplace.api.module';
import { MARKETPLACE_DOCS_URL } from '@hookpost/backend/marketplace-api/routes/root.controller';
import { MarketplaceAccountService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service';
import { MarketplaceAccountRepository } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository';
import { MarketplaceUsageService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';

const SECRET = 'g'.repeat(32) + 'root-spec-secret';
const PRODUCTS = ['social', 'linkedin', 'x', 'validate'];

const accounts = { resolve: jest.fn() };
const repository = { organization: jest.fn() };
const usage = { record: jest.fn() };

@Global()
@Module({
  providers: [
    { provide: MarketplaceAccountService, useValue: accounts },
    { provide: MarketplaceAccountRepository, useValue: repository },
    { provide: MarketplaceUsageService, useValue: usage },
  ],
  exports: [MarketplaceAccountService, MarketplaceAccountRepository, MarketplaceUsageService],
})
class FakeDatabaseModule {}

let app: INestApplication;
let base = '';
const saved = { ...process.env };

beforeAll(async () => {
  for (const p of PRODUCTS) process.env[`MKT_GATEWAY_SECRETS_${p.toUpperCase()}`] = SECRET;
  delete process.env.MKT_DISABLED_PRODUCTS;
  const moduleRef = await Test.createTestingModule({
    imports: [FakeDatabaseModule, MarketplaceApiModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});

afterAll(async () => {
  await app?.close();
  process.env = saved;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MKT_DISABLED_PRODUCTS;
});

const call = (path: string, init: RequestInit = {}) => fetch(base + path, init);

describe('the bare product root', () => {
  it.each(PRODUCTS)('GET /mkt/v1/%s answers 200 with no credentials at all', async (product) => {
    const res = await call(`/mkt/v1/${product}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product, status: 'ok', docs: MARKETPLACE_DOCS_URL });
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Nothing billed, in the default marketplace's header only.
    expect(res.headers.get('x-magicapi-billing')).toBe('API=0;');
    expect(res.headers.get('x-rapidapi-billing')).toBeNull();
  });

  it('bills nothing in the header of the marketplace the call names', async () => {
    const res = await call('/mkt/v1/social', { headers: { 'x-rapidapi-proxy-secret': 'anything' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-rapidapi-billing')).toMatch(/=0$/);
    expect(res.headers.get('x-magicapi-billing')).toBeNull();
  });

  it.each(PRODUCTS)('HEAD /mkt/v1/%s answers 200 with no body', async (product) => {
    const res = await call(`/mkt/v1/${product}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('answers the same with a trailing slash, and through the gateway headers too', async () => {
    expect((await call('/mkt/v1/social/')).status).toBe(200);
    const res = await call('/mkt/v1/x', { headers: { 'x-hookpost-gateway': 'wrong', authorization: 'Bearer hp_x' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ product: 'x', status: 'ok', docs: MARKETPLACE_DOCS_URL });
  });

  it('never resolves a workspace, reads a subscriber or counts the call', async () => {
    await call('/mkt/v1/social', { headers: { 'x-magicapi-user': 'cll8kolno0000l808v6p3xvax' } });
    expect(accounts.resolve).not.toHaveBeenCalled();
    expect(repository.organization).not.toHaveBeenCalled();
    expect(usage.record).not.toHaveBeenCalled();
  });

  it('is 404 for a product we do not sell', async () => {
    const res = await call('/mkt/v1/instagram');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: 'No such product.' });
  });

  it('is 503 while the product is paused', async () => {
    process.env.MKT_DISABLED_PRODUCTS = 'linkedin';
    const res = await call('/mkt/v1/linkedin');
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe('paused');
    expect((await call('/mkt/v1/social')).status).toBe(200);
  });

  it('opens GET and HEAD only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await call('/mkt/v1/social', { method })).status).toBe(404);
    }
  });
});

describe('every other route keeps the gateway auth', () => {
  const routes: [string, string][] = [
    ['GET', '/mkt/v1/social/providers'],
    ['GET', '/mkt/v1/social/channels'],
    ['GET', '/mkt/v1/social/posts'],
    ['GET', '/mkt/v1/social/posts/test'],
    ['POST', '/mkt/v1/social/posts/validate'],
    ['GET', '/mkt/v1/social/slots/test'],
    ['GET', '/mkt/v1/social/usage'],
    ['GET', '/mkt/v1/linkedin/usage'],
    ['GET', '/mkt/v1/x/usage'],
    ['GET', '/mkt/v1/validate/rules'],
    ['POST', '/mkt/v1/validate/check'],
    ['GET', '/mkt/v1/social/_probe'],
  ];

  it.each(routes)('%s %s is 401 without the gateway secret', async (method, path) => {
    const res = await call(path, { method });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('unauthorized');
  });

  // Every route of every gated controller, read from the decorators, so a
  // route added later (or a bare @Get() on a product) is covered without
  // editing this list.
  const declared: [string, string][] = marketplaceControllers.flatMap((controller) => {
    const prefix = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const proto = controller.prototype;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined)
      .map((name): [string, string] => {
        const path = `/${[prefix, Reflect.getMetadata(PATH_METADATA, proto[name]) as string]
          .map((p) => p.replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .join('/')}`.replace(/:product/g, 'social').replace(/:[A-Za-z_]+/g, 'test');
        return [RequestMethod[Reflect.getMetadata(METHOD_METADATA, proto[name])], path];
      });
  });

  it('covers every declared route', () => {
    expect(declared.length).toBeGreaterThan(30);
  });

  it.each(declared)('%s %s (declared) is 401 without the gateway secret', async (method, path) => {
    const res = await call(path, { method });
    expect(res.status).toBe(401);
  });

  it('HEAD on a gated GET route is 401 too', async () => {
    expect((await call('/mkt/v1/social/usage', { method: 'HEAD' })).status).toBe(401);
  });

  it.each(routes)('%s %s is 401 with a wrong gateway secret', async (method, path) => {
    const res = await call(path, { method, headers: { 'x-hookpost-gateway': 'g'.repeat(46) } });
    expect(res.status).toBe(401);
  });

  it('reaches the next check once the secret matches (the middleware is wired)', async () => {
    const res = await call('/mkt/v1/social/providers', { headers: { 'x-hookpost-gateway': SECRET } });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('unknown_plan');
    expect(accounts.resolve).not.toHaveBeenCalled();
  });
});
