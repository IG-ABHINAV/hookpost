/**
 * The OpenAPI files api.market imports (docs/marketplace/*.openapi.json,
 * written by scripts/marketplace/build-openapi.mjs) against the routes the
 * backend has: every spec path is a route, every route is in its spec, no
 * route the marketplace must not sell is reachable, and the copy follows the
 * listing rules (no "unlimited", no "free", no names).
 *   pnpm exec jest -c apps/backend/jest.config.ts openapi.contract
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

// The service loads every social network (one of them ESM-only); routes are
// all this needs.
jest.mock('@hookpost/backend/marketplace-api/marketplace.service', () => ({
  MarketplaceService: class MarketplaceService {},
}));

import { MarketplaceSocialController } from '@hookpost/backend/marketplace-api/routes/social.controller';
import { MarketplaceLinkedInController } from '@hookpost/backend/marketplace-api/routes/linkedin.controller';
import { MarketplaceXController } from '@hookpost/backend/marketplace-api/routes/x.controller';
import { MarketplaceValidateController } from '@hookpost/backend/marketplace-api/routes/validate.controller';
import { MarketplaceProbeController } from '@hookpost/backend/marketplace-api/routes/probe.controller';

const DOCS = join(__dirname, '..', '..', '..', '..', 'docs', 'marketplace');
const ORIGIN = 'https://hookpost.hookstep.in/api';

const PRODUCTS = [
  { file: 'social-scheduler.openapi.json', base: '/mkt/v1/social', controller: MarketplaceSocialController },
  { file: 'linkedin-carousel.openapi.json', base: '/mkt/v1/linkedin', controller: MarketplaceLinkedInController },
  { file: 'x-threads.openapi.json', base: '/mkt/v1/x', controller: MarketplaceXController },
  { file: 'post-validator.openapi.json', base: '/mkt/v1/validate', controller: MarketplaceValidateController },
];

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

const join2 = (a: string, b: string) => `/${[a, b].map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

function routesOf(controller: any): string[] {
  const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const proto = controller.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]) !== undefined)
    .map((name) => {
      const path = join2(base, Reflect.getMetadata(PATH_METADATA, proto[name]) as string).replace(/:([A-Za-z_]+)/g, '{$1}');
      return `${METHODS[Reflect.getMetadata(METHOD_METADATA, proto[name])]} ${path}`;
    })
    .sort();
}

const load = (file: string) => JSON.parse(readFileSync(join(DOCS, file), 'utf8'));

function specRoutes(doc: any, base: string): string[] {
  return Object.entries(doc.paths)
    .flatMap(([path, ops]: [string, any]) =>
      Object.keys(ops)
        .filter((m) => ['get', 'post', 'put', 'delete', 'patch'].includes(m))
        .map((m) => `${m} ${base}${path}`)
    )
    .sort();
}

const operations = (doc: any) =>
  Object.entries(doc.paths).flatMap(([path, ops]: [string, any]) =>
    Object.entries(ops).map(([method, op]: [string, any]) => ({ path, method, op }))
  );

describe.each(PRODUCTS)('$file', ({ file, base, controller }) => {
  const doc = load(file);

  it('lists exactly the routes the controller serves', () => {
    expect(specRoutes(doc, base)).toEqual(routesOf(controller));
  });

  it('points its server at the product base and declares no security scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: `${ORIGIN}${base}` }]);
    expect(doc.security).toBeUndefined();
    expect(doc.components?.securitySchemes).toBeUndefined();
    for (const { op } of operations(doc)) expect(op.security).toBeUndefined();
  });

  it('gives every operation a unique id, a tag and a 200 with the billing header', () => {
    const ids = operations(doc).map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { op, path, method } of operations(doc)) {
      expect({ path, method, id: op.operationId }).toEqual({ path, method, id: expect.any(String) });
      expect(op.tags?.length).toBeGreaterThan(0);
      expect(op.responses['200']).toBeDefined();
      expect(op.responses['200'].headers['X-Magicapi-Billing']).toBeDefined();
      expect(op.responses['201']).toBeUndefined();
    }
  });

  it('declares every path parameter and resolves every $ref', () => {
    for (const { path, op } of operations(doc)) {
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      const declared = (op.parameters || []).filter((p: any) => p.in === 'path').map((p: any) => p.name).sort();
      expect(declared).toEqual(inPath);
    }
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
    for (const name of refs) expect(doc.components.schemas[name]).toBeDefined();
  });

  it('follows the listing copy rules', () => {
    const text = JSON.stringify(doc).toLowerCase();
    const found = [/unlimited/g, /\bfree\b/g, /stripe/g, /chatgpt/g, /jr consulting/g, /jatinder/g, /mohan/g, /founder/g]
      .flatMap((banned) => [...text.matchAll(banned)])
      .map((m) => text.slice(Math.max(0, m.index! - 40), m.index! + 40));
    expect(found).toEqual([]);
  });
});

describe('what the marketplace never sells', () => {
  const all = [...PRODUCTS.flatMap((p) => routesOf(p.controller)), ...routesOf(MarketplaceProbeController)];
  it.each(['analytics', 'video', 'users', 'integration-trigger', 'release-id', 'upload-from-url', 'is-connected'])(
    'has no %s route',
    (word) => {
      expect(all.filter((r) => r.split(' ')[1].includes(word))).toEqual([]);
      for (const p of PRODUCTS) {
        expect(Object.keys(load(p.file).paths).filter((path) => path.includes(word))).toEqual([]);
      }
    }
  );

  it('keeps the probe out of every product spec (it has its own, for a private plan)', () => {
    for (const p of PRODUCTS) expect(Object.keys(load(p.file).paths)).not.toContain('/_probe');
    expect(Object.keys(load('probe.openapi.json').paths)).toEqual(['/_probe']);
    expect(routesOf(MarketplaceProbeController)).toEqual(['get /mkt/v1/{product}/_probe', 'post /mkt/v1/{product}/_probe']);
  });

  it('has a call per product that needs nothing connected (the reviewer\'s test call)', () => {
    expect(routesOf(MarketplaceSocialController)).toContain('get /mkt/v1/social/providers');
    expect(routesOf(MarketplaceLinkedInController)).toContain('post /mkt/v1/linkedin/carousels/render');
    expect(routesOf(MarketplaceXController)).toContain('post /mkt/v1/x/threads/estimate');
    expect(routesOf(MarketplaceValidateController)).toContain('get /mkt/v1/validate/rules');
  });
});
