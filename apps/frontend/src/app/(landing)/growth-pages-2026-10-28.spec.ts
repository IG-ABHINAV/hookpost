/**
 * The three pages added on 28 Oct 2026 for the Search Console queries that had
 * impressions and no clicks: /social-media-scheduler (the head term),
 * /discord-post-scheduler (the Discord integration queries) and
 * /planable-vs-buffer-vs-hootsuite (the three-way MCP comparison).
 *
 * What is held here is what SEO work actually gets wrong later:
 *  - the title and H1 still contain the query the page was built for;
 *  - every page is reachable - in the sitemap, the proxy's public allowlist and
 *    llms.txt (a marketing route missing from proxy.ts 307s every crawler to
 *    /auth, which is how three pages were once invisible);
 *  - the JSON-LD parses and declares its own canonical;
 *  - no claim the product cannot keep: no "open source" about Hookpost, no
 *    Postiz, and no person's name (the public founder is Mohan Bhanushali and
 *    public-names.spec.ts owns that rule in general);
 *  - competitor facts carry a source link, so a reader can check them.
 *
 *   pnpm exec jest -c apps/frontend/jest.config.ts growth-pages
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import type { Metadata } from 'next';
import { findDateTimeViolations } from './schema-datetime';
import { LANDING_SEGMENTS } from '../../proxy.routes';

// The same two mocks ad-landing.spec.ts uses: SiteNav is a client component
// with hooks, and next/link renders an <a> so the markup is plain HTML.
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('./site-nav', () => ({ SiteNav: () => null }));

const SRC = path.resolve(__dirname, '../..');
const LANDING = __dirname;
const ORIGIN = 'https://hookpost.hookstep.in';

const PAGES = [
  {
    slug: 'social-media-scheduler',
    // The exact query, which both the <title> and the H1 must contain.
    query: 'social media scheduler',
    inLlms: true,
  },
  {
    slug: 'discord-post-scheduler',
    query: 'discord post scheduler',
    inLlms: true,
  },
  {
    slug: 'planable-vs-buffer-vs-hootsuite',
    query: 'planable vs buffer vs hootsuite',
    inLlms: true,
  },
] as const;

const sourceOf = (slug: string) =>
  fs.readFileSync(path.join(LANDING, slug, 'page.tsx'), 'utf8');

/**
 * Sentences that put Hookpost and "open source" together with no negation.
 * Marketing copy states licence facts in one reviewed place, so a stray
 * sentence like this is flagged for review.
 */
export function openSourceClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /open[- ]source/i.test(s) && /\bHookpost\b/.test(s))
    .filter((s) => !/\bno\b|\bnot\b|\bneither\b|\bwithout\b/i.test(s));
}

/* eslint-disable @typescript-eslint/no-var-requires */
const MODULES: Record<string, () => { default: unknown; metadata: Metadata }> = {
  'social-media-scheduler': () => require('./social-media-scheduler/page'),
  'discord-post-scheduler': () => require('./discord-post-scheduler/page'),
  'planable-vs-buffer-vs-hootsuite': () => require('./planable-vs-buffer-vs-hootsuite/page'),
};
/* eslint-enable @typescript-eslint/no-var-requires */

describe.each(PAGES)('/$slug', ({ slug, query, inLlms }) => {
  const source = () => sourceOf(slug);

  it('exists as a server page with no "use client"', () => {
    expect(fs.existsSync(path.join(LANDING, slug, 'page.tsx'))).toBe(true);
    expect(source()).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it('declares its own canonical', () => {
    expect(source()).toContain(`${ORIGIN}/${slug}`);
    expect(source()).toMatch(/alternates:\s*\{\s*canonical:\s*CANONICAL/);
  });

  it('has the query in both the title and the H1', () => {
    const src = source();
    // The resolved <title>, not a regex over the source: several of these
    // pages have their own `title:` keys in data arrays above the metadata.
    const title = String(MODULES[slug]().metadata.title);
    expect(title.toLowerCase()).toContain(query);
    const h1 = src.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
    // The H1 may interpolate a count, so compare on the words either side.
    const h1Text = h1.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    const head = query.split(' ').slice(0, 3).join(' ');
    expect(h1Text).toContain(head);
  });

  it('is in the sitemap and the proxy’s public routes', () => {
    expect(fs.readFileSync(path.join(SRC, 'app/sitemap.ts'), 'utf8')).toContain(`page('/${slug}',`);
    expect(fs.readFileSync(path.join(SRC, 'proxy.ts'), 'utf8')).toContain(
      `nextUrl.pathname.startsWith('/${slug}')`
    );
    // The lowercasing redirect for a differently-cased URL.
    expect(LANDING_SEGMENTS.has(slug)).toBe(true);
  });

  if (inLlms) {
    it('is listed in llms.txt', () => {
      expect(fs.readFileSync(path.join(SRC, 'llms/llms.txt'), 'utf8')).toContain(`(${ORIGIN}/${slug})`);
    });
  }

  it('is linked from the shared footer', () => {
    expect(fs.readFileSync(path.join(LANDING, 'site-footer.tsx'), 'utf8')).toContain(`'/${slug}'`);
  });

  it('claims nothing it may not: no open source, no Postiz, no personal name', () => {
    const src = source();
    // No sentence may put Hookpost and "open source" together without a
    // negation. These three pages happen to contain no such sentence at all,
    // so the rule is applied through a named helper and the helper is given a
    // positive control below - otherwise the loop would assert nothing and
    // pass for the wrong reason.
    expect(openSourceClaims(src)).toEqual([]);
    expect(src).not.toMatch(/postiz/i);
    expect(src).not.toMatch(/jatinder/i);
  });

  it('loads as a module and exports metadata whose canonical is itself', () => {
    // The module has to evaluate: it reads pricing.ts and channel-specs.ts at
    // module scope, so a broken import here is a build failure, not a runtime
    // one. Static requires, not a templated dynamic import, so jest resolves
    // them the way the bundler will.
    const mod = MODULES[slug]();
    expect(mod.default).toBeInstanceOf(Function);
    expect(String((mod.metadata as Metadata).alternates!.canonical)).toBe(`${ORIGIN}/${slug}`);
  });
});

describe('/planable-vs-buffer-vs-hootsuite facts', () => {
  it('quotes every vendor with a link to that vendor’s own page', async () => {
    const { VENDORS, CHECKED, TEN_CHANNELS } = await import('./planable-vs-buffer-vs-hootsuite/facts');
    expect(VENDORS.map((v) => v.name)).toEqual(['Planable', 'Buffer', 'Hootsuite']);
    for (const v of VENDORS) {
      expect(v.source).toMatch(/^https:\/\//);
      // The source has to be the vendor's own site, not a review blog.
      const host = new URL(v.source).hostname.replace(/^www\./, '');
      expect(host).toContain(v.name.toLowerCase());
      for (const field of [v.model, v.free, v.entry, v.mid, v.networks, v.aiAgents]) {
        expect(field.length).toBeGreaterThan(20);
      }
    }
    // A checked date a reader can act on, not "recently".
    expect(CHECKED).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
    expect(TEN_CHANNELS.map((r) => r.name)).toEqual(['Planable', 'Buffer', 'Hootsuite']);
    // Every cost row shows its arithmetic, which is what makes it checkable.
    for (const row of TEN_CHANNELS) expect(row.working.length).toBeGreaterThan(30);
  });
});

describe('/planable-vs-buffer-vs-hootsuite snippet', () => {
  // The query is "planable vs buffer vs hootsuite mcp" (38 impressions, 0
  // clicks, 21-27 Oct 2026), so the title carries "mcp" too, and the
  // description answers it with prices. Nothing in it may promise a trial:
  // new users get free posts, not a time-limited trial.
  const { metadata } = MODULES['planable-vs-buffer-vs-hootsuite']();
  const title = String(metadata.title);
  const description = String(metadata.description);

  it('has the whole query, mcp included, in the title, short enough not to be cut', () => {
    expect(title.toLowerCase()).toContain('planable vs buffer vs hootsuite mcp');
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it('answers the MCP question and prices all three, plus Hookpost, in the description', async () => {
    const { VENDORS } = await import('./planable-vs-buffer-vs-hootsuite/facts');
    expect(description).toMatch(/All three ship an MCP connector/);
    // Each entry price in the snippet is the one facts.ts quotes from that
    // vendor's own pricing page, so the two cannot drift apart unnoticed.
    const prices = ['$33', '$5', '$99'];
    VENDORS.forEach((v, i) => {
      expect(description).toContain(`${v.name} `);
      expect(description).toContain(`(${prices[i]}/mo)`);
      expect(v.entry).toContain(`${prices[i]} per`);
    });
    // Hookpost's MCP needs the paid plan: priced "from" its one price, never free.
    expect(description).toMatch(/Hookpost's MCP: from (₹599|\$7)\/mo/);
    // Rupee build (dollars off): short enough for the whole snippet to show.
    expect(description.length).toBeLessThanOrEqual(160);
  });

  it('never says "trial" in any of its snippets', () => {
    const og = metadata.openGraph as { title: string; description: string };
    const tw = metadata.twitter as { title: string; description: string };
    for (const text of [title, description, og.title, og.description, tw.title, tw.description]) {
      expect(text).not.toMatch(/trial/i);
      expect(text).not.toMatch(/free MCP|MCP (is )?free/i);
    }
  });
});

describe('/alternatives/metricool', () => {
  const source = fs.readFileSync(path.join(LANDING, 'alternatives/metricool/page.tsx'), 'utf8');

  it('answers the open-source query without claiming Hookpost is open source', () => {
    expect(source).toContain('OPEN_SOURCE_ANSWER');
    expect(source).toContain('id="open-source"');
    // The answer names a self-hosted option.
    expect(source).toMatch(/Mixpost/);
    expect(source).not.toMatch(/postiz/i);
  });

  it('prints the date Metricool’s own pricing page was read, and links it', () => {
    expect(source).toContain('METRICOOL_CHECKED');
    expect(source).toContain('https://metricool.com/pricing/');
  });
});

describe('the rule checks actually bite', () => {
  it('openSourceClaims finds a claim and ignores a denial', () => {
    expect(openSourceClaims('Hookpost is an open-source scheduler.')).toHaveLength(1);
    expect(openSourceClaims('Hookpost is not open source. Mixpost is.')).toEqual([]);
    expect(openSourceClaims('Neither Metricool nor Hookpost is open source.')).toEqual([]);
    // A sentence about someone else is none of this rule's business.
    expect(openSourceClaims('Mixpost Lite is open source.')).toEqual([]);
  });
});

describe('the new pages\u2019 JSON-LD', () => {
  // Rendered for real, then parsed: a regex over the source would pass on a
  // graph that does not serialise. These are server components with no hooks,
  // so Testing Library's render is enough, and the JSON-LD is read back out of
  // the <script type="application/ld+json"> the page emits.
  afterEach(cleanup);

  const graphsOf = (slug: string): Record<string, unknown>[] => {
    const { container } = render(React.createElement(MODULES[slug]().default as React.FC));
    const blocks = [...container.querySelectorAll('script[type="application/ld+json"]')].map(
      (el) => JSON.parse(el.textContent!.replace(/\\u003c/g, '<')) as Record<string, unknown>
    );
    expect(blocks.length).toBeGreaterThan(0);
    return blocks;
  };

  it.each(PAGES.map((p) => p.slug))('%s emits a graph that parses', (slug) => {
    const blocks = graphsOf(slug);
    for (const block of blocks) {
      expect(block['@context']).toBe('https://schema.org');
      expect(Array.isArray(block['@graph'])).toBe(true);
    }
  });

  it.each(PAGES.map((p) => p.slug))('%s anchors every node on its own canonical', (slug) => {
    const nodes = graphsOf(slug).flatMap((b) => b['@graph'] as Record<string, unknown>[]);
    const types = nodes.map((n) => n['@type']);
    expect(types).toContain('FAQPage');
    expect(types).toContain('BreadcrumbList');
    // The node for the document itself, which the other landing families all
    // carry and these three were missing.
    const page = nodes.find((n) => n['@type'] === 'WebPage')!;
    expect(page.url).toBe(`${ORIGIN}/${slug}`);
    expect(page['@id']).toBe(`${ORIGIN}/${slug}`);
    const faq = nodes.find((n) => n['@type'] === 'FAQPage')!;
    expect(faq['@id']).toBe(`${ORIGIN}/${slug}#faq`);
    expect((faq.mainEntity as unknown[]).length).toBeGreaterThan(3);
    const crumbs = nodes.find((n) => n['@type'] === 'BreadcrumbList')!;
    expect(crumbs['@id']).toBe(`${ORIGIN}/${slug}#breadcrumbs`);
    const last = (crumbs.itemListElement as Record<string, unknown>[]).at(-1)!;
    expect(last.item).toBe(`${ORIGIN}/${slug}`);
  });

  it.each(PAGES.map((p) => p.slug))('%s has no datetime without a time zone', (slug) => {
    // Nothing on these pages publishes a datetime today; this holds for the
    // one that gets added. findDateTimeViolations walks the whole graph, so
    // unlike a source regex it cannot be evaded by a constant.
    for (const block of graphsOf(slug)) {
      expect(findDateTimeViolations(block)).toEqual([]);
    }
  });
});
