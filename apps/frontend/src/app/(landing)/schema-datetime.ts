/**
 * The one rule for datetimes in this site's JSON-LD: every schema.org property
 * that Google reads as a DateTime carries a time zone.
 *
 * Why this file exists. On 25 Oct 2026 Search Console flagged the homepage's
 * VideoObject twice for one value:
 *
 *     Datetime property 'uploadDate' is missing a time zone
 *     Invalid datetime value for 'uploadDate'
 *
 * The value was `'2026-10-25'`. schema.org lets `uploadDate` be a Date or a
 * DateTime, but Google's video structured data reads it as a DateTime and will
 * not assume a zone for it, so a bare date is rejected rather than widened to
 * midnight-somewhere. The fix is not a different date format per page: it is
 * one rule, checked. See hero-demo.facts.ts and ad-landing.tsx for the two
 * values this site actually publishes.
 *
 * Properties that are plain Dates in our own schema (`priceValidUntil`, a
 * legal page's "Last updated" prose) are NOT in DATETIME_PROPERTIES and are
 * left alone - adding a zone where schema.org asks for a Date would be the
 * mirror-image mistake.
 */

/**
 * The schema.org properties this site emits that Google reads as a DateTime.
 * Add a property here when a page starts emitting it; the spec then holds every
 * page that carries one to the rule below.
 */
export const DATETIME_PROPERTIES = [
  'uploadDate',
  'datePublished',
  'dateModified',
  'dateCreated',
  'startDate',
  'endDate',
  'validFrom',
  'datePosted',
  'validThrough',
] as const;

export type DateTimeProperty = (typeof DATETIME_PROPERTIES)[number];

/**
 * ISO 8601 date and time with a zone: `2026-10-20T10:00:00+05:30`,
 * `2026-10-20T10:00:00Z`, optionally with fractional seconds. A bare date, a
 * local time with no offset, and a lone `+0530` (ISO 8601 basic format, which
 * schema.org's XSD dateTime does not accept) all fail.
 */
export const SCHEMA_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** True when `value` is a full ISO 8601 datetime with a zone AND a real instant. */
export function isSchemaDateTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SCHEMA_DATETIME.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export interface DateTimeViolation {
  /** Where it was found, e.g. `VideoObject.uploadDate` or `@graph[2].startDate`. */
  path: string;
  property: string;
  value: unknown;
}

/**
 * Every DATETIME_PROPERTIES value in `node` (walked recursively, through arrays
 * and `@graph`) that is not a datetime with a zone. An empty array means the
 * JSON-LD is clean.
 *
 * `node` is whatever `JSON.parse` gave back for a `<script type=
 * "application/ld+json">` block, so this works on a rendered page, on a
 * function's return value, and on a fetched production URL alike.
 */
export function findDateTimeViolations(
  node: unknown,
  at = '$'
): DateTimeViolation[] {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) =>
      findDateTimeViolations(child, `${at}[${i}]`)
    );
  }
  if (!node || typeof node !== 'object') return [];

  const entries = Object.entries(node as Record<string, unknown>);
  // Name the node by its @type when it has one, so a failure reads
  // "VideoObject.uploadDate" rather than "$[0]['@graph'][3].uploadDate".
  const type = (node as Record<string, unknown>)['@type'];
  const label = typeof type === 'string' ? type : at;

  return entries.flatMap(([property, value]) => {
    if ((DATETIME_PROPERTIES as readonly string[]).includes(property)) {
      return isSchemaDateTime(value)
        ? []
        : [{ path: `${label}.${property}`, property, value }];
    }
    return findDateTimeViolations(value, `${at}.${property}`);
  });
}
