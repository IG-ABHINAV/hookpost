/**
 * Every JSON-LD datetime this site publishes carries a time zone.
 *
 * The bug this exists to stop: Search Console flagged the homepage's
 * VideoObject on 25 Oct 2026 with "Datetime property 'uploadDate' is missing a
 * time zone" and "Invalid datetime value for 'uploadDate'", because the value
 * was the bare date '2026-10-25'. Fixing the two values alone would not stop
 * the third one, so this spec holds three things at once:
 *
 *   1. the rule itself (findDateTimeViolations in schema-datetime.ts);
 *   2. the JSON-LD the pages that carry a datetime actually emit - the
 *      homepage's VideoObject and the three ad pages' (/claude, /cli, /start);
 *   3. as a backstop, every datetime written as a LITERAL in the files that
 *      build structured data, found by reading the source, so a new page that
 *      hardcodes '2027-01-01' fails here even though no test renders it yet.
 *      Its limits are written out above that block - it is the backstop, not
 *      the guarantee; the render-based checks are.
 *
 *   pnpm exec jest -c apps/frontend/jest.config.ts schema-datetime
 */
import fs from 'fs';
import path from 'path';
import {
  DATETIME_PROPERTIES,
  findDateTimeViolations,
  isSchemaDateTime,
} from './schema-datetime';

const LANDING = __dirname;
const APP = path.resolve(__dirname, '..');

const isSpec = (file: string) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(file);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

describe('isSchemaDateTime', () => {
  it.each([
    '2026-10-25T10:00:00+05:30',
    '2026-10-22T10:00:00+05:30',
    '2026-10-25T04:30:00Z',
    '2026-10-25T04:30:00.123Z',
    '2026-10-25T10:00:00-08:00',
  ])('accepts %p', (value) => {
    expect(isSchemaDateTime(value)).toBe(true);
  });

  it.each([
    // The exact value Search Console rejected.
    '2026-10-25',
    // A local time with no offset: the zone is still missing.
    '2026-10-25T10:00:00',
    // ISO 8601 basic format. XSD dateTime, which schema.org uses, wants the colon.
    '2026-10-25T10:00:00+0530',
    // Not an instant at all.
    '2026-13-45T10:00:00Z',
    'October 25, 2026',
    '',
    undefined,
    null,
    20261025,
  ])('rejects %p', (value) => {
    expect(isSchemaDateTime(value)).toBe(false);
  });
});

describe('findDateTimeViolations', () => {
  it('names the offending node by its @type', () => {
    const graph = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'FAQPage', mainEntity: [] },
        { '@type': 'VideoObject', uploadDate: '2026-10-25' },
      ],
    };
    expect(findDateTimeViolations(graph)).toEqual([
      { path: 'VideoObject.uploadDate', property: 'uploadDate', value: '2026-10-25' },
    ]);
  });

  it('finds nothing in a clean graph, however deeply nested', () => {
    expect(
      findDateTimeViolations({
        '@graph': [
          {
            '@type': 'WebPage',
            datePublished: '2026-10-01T00:00:00+05:30',
            video: [{ '@type': 'VideoObject', uploadDate: '2026-10-25T10:00:00+05:30' }],
          },
        ],
      })
    ).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const found = findDateTimeViolations([
      { '@type': 'VideoObject', uploadDate: '2026-10-25' },
      { '@type': 'Article', datePublished: '2026-10-01', dateModified: '2026-10-02' },
    ]);
    expect(found.map((v) => v.path)).toEqual([
      'VideoObject.uploadDate',
      'Article.datePublished',
      'Article.dateModified',
    ]);
  });
});

describe('the JSON-LD the pages emit', () => {
  it('the homepage VideoObject has an uploadDate with a time zone', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { heroDemoVideoObject } = require('./hero-demo.schema') as typeof import('./hero-demo.schema');
    const video = heroDemoVideoObject();
    expect(isSchemaDateTime(video.uploadDate)).toBe(true);
    expect(findDateTimeViolations(video)).toEqual([]);
  });

  it('the video sitemap entry for / publishes the same instant', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { heroDemoSitemapVideo } = require('./hero-demo.schema') as typeof import('./hero-demo.schema');
    // <video:publication_date> takes a W3C datetime, the same format, so the
    // sitemap and the VideoObject cannot disagree about the zone.
    expect(isSchemaDateTime(heroDemoSitemapVideo().publication_date as string)).toBe(true);
  });

  it('every answer page TechArticle has a datePublished and dateModified with a zone', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { answerJsonLd } = require('./guides/_answer/answer-schema') as typeof import('./guides/_answer/answer-schema');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ANSWER_PAGES, ANSWER_PAGES_UPDATED, SITE } = require('./guides/_answer/answer-pages') as typeof import('./guides/_answer/answer-pages');
    expect(ANSWER_PAGES.length).toBeGreaterThan(0);
    for (const page of ANSWER_PAGES) {
      const ld = answerJsonLd({
        canonical: `${SITE}${page.path}`,
        headline: page.title,
        description: page.blurb,
        datePublished: ANSWER_PAGES_UPDATED,
        crumb: page.tag,
        faq: [{ q: 'q', a: 'a' }],
      });
      expect(findDateTimeViolations(ld)).toEqual([]);
    }
  });

  it.each(['claude', 'cli', 'start'])('the /%s ad page JSON-LD is clean', (slug) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { adJsonLd } = require('./ad-landing/ad-landing') as typeof import('./ad-landing/ad-landing');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { AD_PAGES } = require('./ad-landing/ad-pages') as typeof import('./ad-landing/ad-pages');
    const page = AD_PAGES.find((p) => p.path === `/${slug}`)!;
    expect(findDateTimeViolations(adJsonLd(page))).toEqual([]);
  });
});

/**
 * The backstop: a scan of the source for a datetime written as a literal.
 *
 * What it does NOT do, so nobody trusts it further than it reaches:
 *  - it only sees a literal next to the property name, so `uploadDate:
 *    UPLOAD_DATE`, `[prop]: '2026-01-01'` and any concatenation slip past. The
 *    render-based checks above are what cover those, by walking the graph the
 *    pages actually emit.
 *  - it reads raw source, comments included, so a date in a doc comment or a
 *    /docs code sample would fail it. That has not happened yet; if it does,
 *    the fix is to exclude that file here, not to "correct" the prose.
 *
 * It is scoped to files that build structured data - the ones containing an
 * ld+json script or a schema.org @context - because `startDate`, `endDate`,
 * `validFrom` and `validThrough` are ordinary variable names too. A date-range
 * filter with `startDate: '2026-01-01'` is correct code, and appending an
 * offset to it would be the mirror-image mistake.
 */
describe('datetime literals in the files that build structured data', () => {
  // `uploadDate: '2026-10-25'`, `"datePosted": "2026-10-25T00:00:00Z"`, and the
  // same inside a JSON-LD object literal spread over several lines.
  const LITERAL = new RegExp(
    `["']?(${DATETIME_PROPERTIES.join('|')})["']?\\s*:\\s*(['"\`])([^'"\`]*)\\2`,
    'g'
  );

  const BUILDS_SCHEMA = /application\/ld\+json|['"]@context['"]|schema\.org/;

  const files = [
    ...walk(LANDING)
      .filter((f) => /\.(tsx?|jsx?)$/.test(f) && !isSpec(f))
      .filter((f) => BUILDS_SCHEMA.test(fs.readFileSync(f, 'utf8'))),
    // Always read, whether or not it matches: sitemap.ts is a structured-data
    // route handler (it carries the video entry for /), and <lastmod> and
    // <video:publication_date> both take a W3C datetime.
    path.join(APP, 'sitemap.ts'),
  ].filter((f) => fs.existsSync(f));

  it('finds the files that build structured data, including the two that hold a literal', () => {
    expect(files.length).toBeGreaterThan(20);
    const rel = files.map((f) => path.relative(APP, f));
    expect(rel).toContain('(landing)/hero-demo.schema.ts');
    expect(rel).toContain('sitemap.ts');
  });

  it('writes none of them as a bare date or a zoneless time', () => {
    const bad: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [, property, , value] of source.matchAll(LITERAL)) {
        // Template values (`${...}`) and empty strings are computed elsewhere;
        // only a literal instant is judged here.
        if (!value || value.includes('${')) continue;
        if (!isSchemaDateTime(value)) {
          bad.push(`${path.relative(APP, file)}: ${property} = ${JSON.stringify(value)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('bites: the value Search Console rejected would fail this scan', () => {
    // A positive control, so an empty `bad` can never mean "the regex matched
    // nothing" rather than "every value is fine".
    const sample = `const x = { uploadDate: '2026-10-25' };`;
    const hits = [...sample.matchAll(LITERAL)].map(([, , , value]) => value);
    expect(hits).toEqual(['2026-10-25']);
    expect(isSchemaDateTime(hits[0])).toBe(false);
  });
});
