/**
 * JSON-LD for an answer page: TechArticle, FAQPage, BreadcrumbList and, when
 * the page has numbered steps, HowTo. Built from the same arrays the page
 * renders, so the markup can never say something the visible page does not.
 */
import { SITE } from './answer-pages';
/**
 * A YYYY-MM-DD authoring date as the instant JSON-LD publishes: midnight IST,
 * the zone the site is operated in.
 *
 * The pages are authored as plain dates, which reads better in
 * answer-pages.ts, but `datePublished` and `dateModified` are DateTime
 * properties to Google and a zoneless value is rejected - the same report that
 * flagged the homepage's VideoObject uploadDate on 25 Oct 2026. The conversion
 * belongs here, once, rather than in eight page files.
 * See (landing)/schema-datetime.ts.
 */
export const istInstant = (isoDate: string): string => `${isoDate}T00:00:00+05:30`;

/**
 * Whether a YYYY-MM-DD string is a day that exists.
 *
 * `Date.parse` cannot answer this: V8 rolls an impossible day over rather than
 * returning NaN, for the bare date AND for the full datetime form
 * (`Date.parse('2026-02-31')` and `Date.parse('2026-02-31T00:00:00+05:30')`
 * both succeed, landing on 3 March). So the check is a round trip - parse at
 * UTC and ask whether the date came back as the one that went in - which is
 * the only cheap way to catch 2026-02-31 or 2026-04-31.
 */
function isRealDay(isoDate: string): boolean {
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === isoDate;
}

export interface Faq {
  q: string;
  a: string;
}

export interface Step {
  name: string;
  text: string;
}

export interface AnswerSchemaInput {
  canonical: string;
  headline: string;
  description: string;
  /** ISO date, YYYY-MM-DD. */
  datePublished: string;
  /** ISO date, YYYY-MM-DD; defaults to datePublished. */
  dateModified?: string;
  /** Short crumb label for the page itself. */
  crumb: string;
  faq: readonly Faq[];
  steps?: readonly Step[];
  howToName?: string;
  about?: readonly string[];
}

/** Text for JSON-LD: no doubled spaces or line breaks from template literals. */
export const plain = (s: string): string => s.replace(/\s+/g, ' ').trim();

export function answerJsonLd(input: AnswerSchemaInput): Record<string, unknown> {
  const {
    canonical,
    headline,
    description,
    datePublished,
    dateModified = datePublished,
    crumb,
    faq,
    steps,
    howToName,
    about = [],
  } = input;
  if (!canonical.startsWith(`${SITE}/`)) {
    throw new Error(`answerJsonLd: canonical ${canonical} is not on ${SITE}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePublished) || !/^\d{4}-\d{2}-\d{2}$/.test(dateModified)) {
    throw new Error('answerJsonLd: dates must be YYYY-MM-DD');
  }
  // A string that matches YYYY-MM-DD can still be a day that does not exist.
  if (!isRealDay(datePublished) || !isRealDay(dateModified)) {
    throw new Error('answerJsonLd: dates must be real calendar days');
  }
  const published = istInstant(datePublished);
  const modified = istInstant(dateModified);
  if (!faq.length) throw new Error('answerJsonLd: an answer page needs an FAQ');

  const graph: Record<string, unknown>[] = [
    {
      '@type': 'TechArticle',
      '@id': `${canonical}#article`,
      headline: plain(headline),
      description: plain(description),
      url: canonical,
      mainEntityOfPage: canonical,
      inLanguage: 'en',
      datePublished: published,
      dateModified: modified,
      image: `${SITE}/og-image.png`,
      author: { '@type': 'Organization', name: 'Hookpost by Hookstep', url: `${SITE}/about` },
      publisher: { '@id': `${SITE}/#organization` },
      ...(about.length ? { about: about.map((name) => ({ '@type': 'Thing', name })) } : {}),
    },
    {
      '@type': 'FAQPage',
      '@id': `${canonical}#faq`,
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: plain(f.q),
        acceptedAnswer: { '@type': 'Answer', text: plain(f.a) },
      })),
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
        { '@type': 'ListItem', position: 2, name: 'Guides', item: `${SITE}/guides` },
        { '@type': 'ListItem', position: 3, name: crumb, item: canonical },
      ],
    },
  ];
  if (steps?.length) {
    graph.push({
      '@type': 'HowTo',
      '@id': `${canonical}#howto`,
      name: plain(howToName ?? headline),
      step: steps.map((s, i) => ({
        '@type': 'HowToStep',
        position: i + 1,
        name: plain(s.name),
        text: plain(s.text),
      })),
    });
  }
  return { '@context': 'https://schema.org', '@graph': graph };
}

/**
 * JSON for a <script type="application/ld+json">: "<" escaped so text such as
 * "</script>" inside an answer cannot close the tag early.
 */
export const ldJson = (data: unknown): string => JSON.stringify(data).replace(/</g, '\\u003c');
