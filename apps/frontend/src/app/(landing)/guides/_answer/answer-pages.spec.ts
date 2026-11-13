/**
 * @jest-environment node
 */
/**
 * The answer pages (answer-pages.ts): every page is registered everywhere it
 * has to be, opens with a short direct answer naming "Hookpost by Hookstep",
 * quotes only prices pricing.ts sells, never offers a Free plan in a trial
 * build, gives ChatGPT's route from mcp-setup.ts, and links only to pages
 * that exist. Run for every build the pages can be made in: Free or trial,
 * rupees only or rupees and dollars.
 *
 *   pnpm exec jest -c apps/frontend/jest.config.ts answer-pages
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { MetadataRoute } from 'next';
import { ANSWER_PAGES, SITE, answerUrl } from './answer-pages';
import { answerJsonLd, ldJson, plain } from './answer-schema';
import { CHATGPT_MCP_URL, CHATGPT_SIDE_NOTE, CHATGPT_STEPS, CHATGPT_TESTED } from '../../mcp/mcp-setup';
import {
  HOOKPOST_PRICE,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const landingDir = join(__dirname, '..', '..');
const guidesDir = join(__dirname, '..');
const llmsDir = join(__dirname, '..', '..', '..', '..', 'llms');

const BUILDS = [
  { label: 'Free plan, rupees only', env: { TRIAL_REQUIRED_SINCE_IN: '', USD_CHECKOUT: '', GST_LUT_ARN: '' } },
  { label: 'trial, rupees only', env: { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T00:00:00Z', USD_CHECKOUT: '', GST_LUT_ARN: '' } },
  {
    label: 'trial, rupees and dollars (production today)',
    env: { TRIAL_REQUIRED_SINCE_IN: '2026-10-20T00:00:00Z', USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0000000000000' },
  },
] as const;

/** Load modules with a build's environment, the way next build reads it. */
function withEnv<T>(env: Record<string, string>, load: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    let out: T | undefined;
    jest.isolateModules(() => {
      out = load();
    });
    return out as T;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

interface Content {
  PATH: string;
  CANONICAL: string;
  UPDATED: string;
  H1: string;
  ANSWER: string;
  DESCRIPTION: string;
  FAQ: { q: string; a: string }[];
  RELATED: readonly { href: string; label: string; note: string }[];
  [k: string]: unknown;
}

const slugOf = (path: string) => path.split('/').pop() as string;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loadContent = (path: string): Content => require(join(guidesDir, slugOf(path), 'content'));

/** Every string a page renders from its content module, tables included. */
function allText(c: Content, skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  Object.entries(c)
    .filter(([k]) => !skip.includes(k))
    .forEach(([, v]) => walk(v));
  return out;
}

/** The (landing) directory a URL path is served from, or null. */
function pageDirFor(path: string): string | null {
  if (path === '/') return landingDir;
  let dir = landingDir;
  for (const segment of path.split('/').filter(Boolean)) {
    const children = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
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

describe('the registry', () => {
  it('lists 6 or more pages, each once, all under /guides', () => {
    expect(ANSWER_PAGES.length).toBeGreaterThanOrEqual(6);
    const paths = ANSWER_PAGES.map((p) => p.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/guides\/[a-z0-9-]+$/);
  });

  it.each(ANSWER_PAGES.map((p) => [p.path]))('%s has a page.tsx and a content.ts', (path) => {
    expect(existsSync(join(guidesDir, slugOf(path), 'page.tsx'))).toBe(true);
    expect(existsSync(join(guidesDir, slugOf(path), 'content.ts'))).toBe(true);
  });

  it('every guide with a content.ts is registered (no orphan answer page)', () => {
    const withContent = readdirSync(guidesDir)
      .filter((d) => !d.startsWith('_') && existsSync(join(guidesDir, d, 'content.ts')))
      .map((d) => `/guides/${d}`);
    expect(withContent.sort()).toEqual(ANSWER_PAGES.map((p) => p.path).sort());
  });

  it('the guides hub lists them', () => {
    expect(readFileSync(join(guidesDir, 'page.tsx'), 'utf8')).toMatch(/\.\.\.ANSWER_PAGES\.map/);
  });

  it('llms.txt links every page exactly once', () => {
    const text = readFileSync(join(llmsDir, 'llms.txt'), 'utf8');
    const counts = ANSWER_PAGES.map((p) => [p.path, text.split(`(${SITE}${p.path})`).length - 1]);
    expect(counts).toEqual(ANSWER_PAGES.map((p) => [p.path, 1]));
  });
});

describe.each(BUILDS.map((b) => [b.label, b.env]))('sitemap.xml, %s', (_label, env) => {
  const entries = withEnv(env as Record<string, string>, () =>
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    (require('../../../sitemap').default as () => MetadataRoute.Sitemap)()
  );
  const urls = entries.map((e) => e.url);

  it('lists every answer page once', () => {
    for (const p of ANSWER_PAGES) {
      expect(urls.filter((u) => u === answerUrl(p.path))).toHaveLength(1);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe.each(BUILDS.map((b) => [b.label, b.env, b.env.TRIAL_REQUIRED_SINCE_IN !== '', b.env.USD_CHECKOUT === 'on']))(
  'content, %s',
  (_label, env, trial, usd) => {
    const pages = withEnv(env as Record<string, string>, () =>
      ANSWER_PAGES.map((p) => ({ meta: p, c: loadContent(p.path) }))
    );

    it.each(ANSWER_PAGES.map((p) => [p.path]))('%s: canonical, date and H1', (path) => {
      const { c } = pages.find((p) => p.meta.path === path)!;
      expect(c.PATH).toBe(path);
      expect(c.CANONICAL).toBe(`${SITE}${path}`);
      expect(c.UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(c.H1.length).toBeGreaterThan(10);
    });

    it.each(ANSWER_PAGES.map((p) => [p.path]))(
      '%s: the answer is 2 or 3 sentences and names Hookpost by Hookstep',
      (path) => {
        const { c } = pages.find((p) => p.meta.path === path)!;
        // Sentence ends: ". " / "? " / end, not the dots in file names or "₹5,990".
        const sentences = c.ANSWER.split(/(?<=[.?!])\s+(?=[A-Z])/).filter(Boolean);
        expect(sentences.length).toBeGreaterThanOrEqual(2);
        expect(sentences.length).toBeLessThanOrEqual(3);
        // The brand line comes before any bare "Hookpost" (name collision with a Shopify app).
        expect(c.ANSWER.indexOf('Hookpost by Hookstep')).toBeGreaterThanOrEqual(0);
        expect(c.ANSWER.indexOf('Hookpost')).toBe(c.ANSWER.indexOf('Hookpost by Hookstep'));
        expect(c.ANSWER.length).toBeLessThan(700);
        expect(c.DESCRIPTION.length).toBeLessThanOrEqual(220);
      }
    );

    it.each(ANSWER_PAGES.map((p) => [p.path]))('%s: an FAQ of 5+ distinct questions', (path) => {
      const { c } = pages.find((p) => p.meta.path === path)!;
      expect(c.FAQ.length).toBeGreaterThanOrEqual(5);
      expect(new Set(c.FAQ.map((f) => f.q)).size).toBe(c.FAQ.length);
      for (const f of c.FAQ) expect(f.a.length).toBeGreaterThan(40);
    });

    it('quotes only the $7 Hookpost price (HOOKPOST_PRICE) and named competitor prices, and no rupee figure', () => {
      const dollars = new Set([HOOKPOST_PRICE.displayUsd]);
      // Postbeam's own price, quoted as theirs on the ChatGPT page.
      const competitorDollars = new Set([39]);
      const bad: string[] = [];
      for (const { meta, c } of pages) {
        for (const s of allText(c)) {
          // No rupee figure at all: the plan shows as $7 to everyone, India included.
          for (const m of s.matchAll(/₹\s?([\d,]+)(?! today)/g)) {
            bad.push(`${meta.path}: ${m[0]} in "${s.slice(0, 80)}"`);
          }
          for (const m of s.matchAll(/\$([\d,]+)/g)) {
            const n = Number(m[1].replace(/,/g, ''));
            if (!dollars.has(n) && !competitorDollars.has(n)) bad.push(`${meta.path}: ${m[0]} in "${s.slice(0, 80)}"`);
          }
        }
      }
      expect(bad).toEqual([]);
    });

    it('names the $7 price on every page, whatever the dollar switches say, and never "in India" price copy', () => {
      for (const { c } of pages) {
        const text = allText(c).join(' ');
        expect(text).toContain(`$${HOOKPOST_PRICE.displayUsd} a month`);
        expect(text).not.toMatch(/\bStandard\b|\bPro\b/);
        expect(text).not.toMatch(/\$7 a month in India|in India, or \$7|\$7 outside India|\(₹/);
        // The quotas are the plan's own: AI credits and X posts, not the old counts.
        expect(text).not.toMatch(/500 AI|20 AI images|50 X posts|3 with a link/);
      }
    });

    it('never quotes Team or Ultimate, which are not sold', () => {
      const text = pages.flatMap(({ c }) => allText(c)).join('\n');
      expect(text).not.toMatch(/\bTeam plan\b|\bUltimate\b|₹1,499|₹4,499/);
    });

    it(trial ? 'offers no Free plan, free start or "no card" (trial build)' : 'still passes the Free-plan copy check only for its own Free lines', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { checkText, loadAllow } = require('../../../../../../../scripts/check-free-claims.js');
      const hits = pages.flatMap(({ meta, c }) => checkText(meta.path, allText(c), loadAllow()));
      if (trial) expect(hits).toEqual([]);
      else expect(hits.every((h: { sentence: string }) => /Free plan/i.test(h.sentence))).toBe(true);
    });

    // 28 Oct 2026: new workspaces get 3 free posts with no card, and no time
    // trial. The "trial" build's pages say so; none still sells "a 3-day trial".
    it(trial ? 'says 3 free posts then the flat price, and no 3-day trial (free-posts build)' : 'keeps the 3-day trial copy while there is a Free plan', () => {
      const text = pages.flatMap(({ c }) => allText(c)).join('\n');
      if (trial) {
        expect(text).toContain(`3 free posts, no card needed. Then $${HOOKPOST_PRICE.displayUsd}/month`);
        expect(text).not.toMatch(/\b3-day trial|₹0 today|24 hours before the first charge/i);
        expect(text).not.toMatch(/first month 20% off|% off/i);
      } else {
        expect(text).not.toContain('3 free posts');
      }
    });

    // Since 26 Oct 2026 ChatGPT connects (custom MCP server at /mcp-oauth),
    // checked with a scripted client, not yet inside a ChatGPT account. The
    // pages give the route from mcp-setup.ts, say what was tested, and never
    // claim an app in OpenAI's directory (none was submitted).
    it('says how ChatGPT connects, what each side needs, and what was tested', () => {
      const chatgpt = pages.find((p) => p.meta.path === '/guides/chatgpt-social-media-scheduling')!;
      expect(chatgpt.c.ANSWER).toMatch(/^Yes, with Hookpost by Hookstep added to ChatGPT as a custom MCP server/);
      expect(chatgpt.c.ANSWER).toContain(CHATGPT_MCP_URL);
      expect(chatgpt.c.ANSWER).toMatch(/ChatGPT Free does not/);
      expect(chatgpt.c.ANSWER).toMatch(trial ? /3 free posts[^.]*the Hookpost plan/ : /every Hookpost plan/);
      expect(chatgpt.c.ANSWER).not.toMatch(/\btrial\b/);
      const text = allText(chatgpt.c).join('\n');
      expect(text).toContain(CHATGPT_TESTED);
      expect(CHATGPT_TESTED).toMatch(/Not yet run inside a ChatGPT account/);
      // The note is build-aware (free posts or Free plan): read it from this build.
      expect(text).toContain(chatgpt.c.PLAN_NOTE);
      expect(chatgpt.c.PLAN_NOTE).toContain(CHATGPT_SIDE_NOTE);
      for (const step of CHATGPT_STEPS) expect(text).toContain(step);
      expect((chatgpt.c.STEPS as { text: string }[]).map((s) => s.text)).toEqual([...CHATGPT_STEPS]);
      // No answer page sends ChatGPT to the API-key endpoint.
      for (const { meta, c } of pages) {
        for (const sentence of allText(c, ['OTHERS']).flatMap((s) => s.split(/(?<=[.?!])\s+/))) {
          if (/ChatGPT/.test(sentence) && /\/api\/mcp\b/.test(sentence)) {
            throw new Error(`${meta.path}: ChatGPT pointed at the API-key endpoint: ${sentence}`);
          }
        }
      }
    });

    it('never claims a Hookpost app in ChatGPT or its directory', () => {
      for (const { meta, c } of pages) {
        for (const sentence of allText(c, ['OTHERS']).flatMap((s) => s.split(/(?<=[.?!])\s+/))) {
          if (sentence.endsWith('?')) continue;
          expect({ page: meta.path, sentence }).not.toEqual({
            page: meta.path,
            sentence: expect.stringMatching(/\bChatGPT app\b|official ChatGPT|(is|are) (now )?(listed|available) in (the )?ChatGPT|in ChatGPT’s (app )?directory(?! yet)/),
          });
        }
      }
    });

    it('keeps the founder and the owner off the pages', () => {
      const text = pages.flatMap(({ c }) => allText(c)).join('\n');
      expect(text).not.toMatch(/Jatinder|Mahajan/i);
      expect(text).not.toMatch(/\bunlimited\b/i);
      expect(text).not.toMatch(/\branked\b|\bleading\b|\b(is|as) the best\b|#1\b/i);
    });
  }
);

describe('internal links', () => {
  const hrefs = ANSWER_PAGES.flatMap((p) => {
    const dir = join(guidesDir, slugOf(p.path));
    const src = ['page.tsx', 'content.ts'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    return [...src.matchAll(/href(?:=|:\s*)["'`](\/[^"'`]*)["'`]/g)].map((m) => ({ page: p.path, href: m[1] }));
  });

  it('finds links to check (sanity)', () => {
    expect(hrefs.length).toBeGreaterThan(ANSWER_PAGES.length * 4);
  });

  it('every internal link points at a page that exists', () => {
    // A dynamic route ([channel], [pair], ...) matches any slug, so a slug is
    // only real if that route renders it: channel pages come from CHANNEL_SPECS,
    // and no answer page links into another dynamic route.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { CHANNEL_SPECS } = require('../../channels/channel-specs');
    const exists = (href: string) => {
      const path = href.split('#')[0];
      const [, family, slug, ...rest] = path.split('/');
      if (family === 'channels' && slug) return !rest.length && slug in CHANNEL_SPECS;
      const dir = pageDirFor(path);
      return !!dir && !/\[[^\]]+\]/.test(dir.slice(landingDir.length));
    };
    const broken = hrefs.filter(({ href }) => !exists(href));
    expect(broken).toEqual([]);
  });

  it('each page links to at least two other answer pages or guides', () => {
    for (const p of ANSWER_PAGES) {
      const own = hrefs.filter((h) => h.page === p.path && h.href.startsWith('/guides/') && h.href !== p.path);
      expect({ page: p.path, n: own.length >= 2 }).toEqual({ page: p.path, n: true });
    }
  });
});

describe('answerJsonLd', () => {
  const base = {
    canonical: `${SITE}/guides/example`,
    headline: 'Example  headline\n',
    description: 'What it is.',
    datePublished: '2026-10-26',
    crumb: 'Example',
    faq: [{ q: 'Q one?', a: 'Answer one.' }],
  };

  it('builds an article, an FAQPage and breadcrumbs, and HowTo only with steps', () => {
    const graph = answerJsonLd(base)['@graph'] as Record<string, any>[];
    expect(graph.map((n) => n['@type'])).toEqual(['TechArticle', 'FAQPage', 'BreadcrumbList']);
    expect(graph[0].headline).toBe('Example headline');
    // Authored as a plain date, published as an instant with the IST offset
    // (answer-schema.ts istInstant; see (landing)/schema-datetime.ts).
    expect(graph[0].datePublished).toBe('2026-10-26T00:00:00+05:30');
    expect(graph[0].dateModified).toBe('2026-10-26T00:00:00+05:30');
    expect(graph[0].author.name).toBe('Hookpost by Hookstep');
    expect(graph[1].mainEntity[0]).toEqual({
      '@type': 'Question',
      name: 'Q one?',
      acceptedAnswer: { '@type': 'Answer', text: 'Answer one.' },
    });
    expect(graph[2].itemListElement[2].item).toBe(base.canonical);

    const withSteps = answerJsonLd({ ...base, steps: [{ name: 'A', text: 'Do  a.' }] })['@graph'] as Record<string, any>[];
    expect(withSteps[3]['@type']).toBe('HowTo');
    expect(withSteps[3].step[0]).toEqual({ '@type': 'HowToStep', position: 1, name: 'A', text: 'Do a.' });
  });

  it('refuses another origin, a bad date or an empty FAQ', () => {
    expect(() => answerJsonLd({ ...base, canonical: 'https://example.com/x' })).toThrow(/not on/);
    expect(() => answerJsonLd({ ...base, datePublished: '26 Oct 2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => answerJsonLd({ ...base, faq: [] })).toThrow(/FAQ/);
  });

  it('escapes < so text cannot close the script tag', () => {
    const out = ldJson({ a: '</script><script>alert(1)</script>' });
    expect(out).not.toContain('<');
    expect(JSON.parse(out).a).toBe('</script><script>alert(1)</script>');
  });

  it('plain() collapses whitespace', () => {
    expect(plain('  a\n  b  ')).toBe('a b');
  });

  it.each(BUILDS.map((b) => [b.label, b.env]))('every real page builds valid JSON-LD (%s)', (_l, env) => {
    withEnv(env as Record<string, string>, () => {
      for (const p of ANSWER_PAGES) {
        const c = loadContent(p.path);
        const ld = answerJsonLd({
          canonical: c.CANONICAL,
          headline: c.H1,
          description: c.DESCRIPTION,
          datePublished: c.UPDATED,
          crumb: 'x',
          faq: c.FAQ,
          steps: (c.STEPS as { name: string; text: string }[] | undefined) ?? undefined,
        });
        const parsed = JSON.parse(ldJson(ld));
        const faq = parsed['@graph'].find((n: any) => n['@type'] === 'FAQPage');
        expect(faq.mainEntity).toHaveLength(c.FAQ.length);
      }
    });
  });
});
