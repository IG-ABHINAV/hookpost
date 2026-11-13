/**
 * @jest-environment node
 */
/**
 * The sitemap half of what Search Console's Page indexing report flags,
 * caught before deploy:
 *
 *  - a sitemap URL with no page behind it (404), or one the proxy sends to the
 *    login form ("Page with redirect");
 *  - the trial-only build still listing the Free-plan page, which redirects.
 *
 * Static: reads app/sitemap.ts and the route tree, for both builds. Not here:
 *  - robots.txt: robots.spec.ts (every app route disallowed, no sitemap URL
 *    caught, with Google's `*` and `$` matching);
 *  - the live site, including internal links that redirect or 404:
 *    scripts/check-live-sitemap.mjs, run by the nightly prod-smoke job.
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { MetadataRoute } from 'next';
import { APP_ROUTE_SEGMENTS, LOGIN_ALIAS_SEGMENTS } from '../proxy.routes';

const BASE = 'https://hookpost.hookstep.in';
const appDir = __dirname;
const landingDir = join(appDir, '(landing)');

function loadSitemap(trialCutoff: string): MetadataRoute.Sitemap {
  const saved = process.env.TRIAL_REQUIRED_SINCE_IN;
  process.env.TRIAL_REQUIRED_SINCE_IN = trialCutoff;
  try {
    let entries: MetadataRoute.Sitemap = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      entries = require('./sitemap').default();
    });
    return entries;
  } finally {
    if (saved === undefined) delete process.env.TRIAL_REQUIRED_SINCE_IN;
    else process.env.TRIAL_REQUIRED_SINCE_IN = saved;
  }
}

/** The (landing) directory a URL path is served from, or null. */
function pageDirFor(path: string): string | null {
  if (path === '/') return existsSync(join(landingDir, 'page.tsx')) ? landingDir : null;
  let dir = landingDir;
  for (const segment of path.split('/').filter(Boolean)) {
    const children = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
    // Exact segment, then one inside a route group "(x)", then a dynamic "[x]".
    const exact = children.find((d) => d === segment);
    const grouped = children
      .filter((d) => /^\(.+\)$/.test(d))
      .map((g) => join(g, segment))
      .find((d) => existsSync(join(dir, d)));
    const dynamic = children.find((d) => /^\[[^.\]]+\]$/.test(d));
    const next = exact ?? grouped ?? dynamic;
    if (!next) return null;
    dir = join(dir, next);
  }
  return existsSync(join(dir, 'page.tsx')) ? dir : null;
}

const pathOf = (url: string) => (url === BASE ? '/' : url.slice(BASE.length));

describe.each([
  ['Free-plan build (no trial cutoff)', ''],
  ['trial-only build', '2026-10-20T00:00:00Z'],
])('sitemap.xml: %s', (_label, cutoff) => {
  const entries = loadSitemap(cutoff);
  const paths = entries.map((e) => pathOf(e.url));

  it('lists the marketing site (sanity: 80+ URLs)', () => {
    expect(entries.length).toBeGreaterThan(80);
  });

  it('every URL is on the canonical origin, once, without a trailing slash', () => {
    for (const e of entries) {
      expect(e.url === BASE || e.url.startsWith(`${BASE}/`)).toBe(true);
      expect(e.url.endsWith('/') && e.url !== BASE).toBe(false);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('every URL has a page in (landing) (no 404 in the sitemap)', () => {
    const missing = paths.filter((p) => !pageDirFor(p));
    expect(missing).toEqual([]);
  });

  // A sitemap URL under a signed-in segment is fine only when proxy.ts
  // allowlists it (/integrations/n8n); whether each URL really answers 200
  // to an anonymous visitor is checked against the built site by the E2E
  // marketing spec and against the live one by the prod smoke.
  it('no URL is a login alias, and none is the signed-in app itself', () => {
    const redirected = paths.filter((p) => {
      const first = p.split('/')[1] || '';
      return LOGIN_ALIAS_SEGMENTS.has(first) || (APP_ROUTE_SEGMENTS.has(first) && p === `/${first}`);
    });
    expect(redirected).toEqual([]);
  });

  it('priorities are in range and lastmod, when present, is a real date', () => {
    for (const e of entries) {
      expect(e.priority).toBeGreaterThanOrEqual(0);
      expect(e.priority).toBeLessThanOrEqual(1);
      if (e.lastModified) expect(Number.isNaN(new Date(e.lastModified).getTime())).toBe(false);
    }
  });

  it(`the Free-plan landing page is listed only when new users get a Free plan`, () => {
    expect(paths.includes('/free-social-media-scheduler')).toBe(cutoff === '');
  });
});
