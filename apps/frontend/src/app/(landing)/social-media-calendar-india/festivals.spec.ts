/**
 * @jest-environment node
 */
/**
 * The festival pages under /social-media-calendar-india/<slug> state dates
 * that come only from calendar-data.ts (the DoPT lists). These pin that every
 * page resolves its rows, that the rows are the ones its name promises, that
 * titles and descriptions fit a search result, and that the static route, the
 * sitemap and the hub all list the same five pages.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CALENDAR } from './calendar-data';
import { FESTIVALS, festivalBySlug, rowFor } from './festivals';
import { generateStaticParams, dynamicParams } from './[festival]/page';

const SITE = 'https://hookpost.hookstep.in';

describe('festival pages', () => {
  it('has the five pages, each with a unique slug', () => {
    const slugs = FESTIVALS.map((f) => f.slug);
    expect(slugs).toEqual([
      'diwali-2026',
      'holi-2027',
      'republic-day-2027',
      'independence-day-2027',
      'eid-2027',
    ]);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(FESTIVALS.map((f) => [f.slug, f] as const))(
    '%s: every row it names is in calendar-data.ts, in the year its slug says',
    (slug, f) => {
      const year = slug.slice(-4);
      const refs = [f.main, ...(f.alsoMain ? [f.alsoMain] : []), ...f.related];
      for (const ref of refs) {
        const row = rowFor(ref);
        expect(CALENDAR).toContain(row);
        expect(row.date.startsWith(`${ref.year}-`)).toBe(true);
      }
      expect(rowFor(f.main).date.startsWith(`${year}-`)).toBe(true);
      expect(f.name).toContain(year);
    }
  );

  it('states the dates the DoPT rows hold (spot checks against the list)', () => {
    const date = (slug: string) => rowFor(festivalBySlug(slug)!.main).date;
    expect(date('diwali-2026')).toBe('2026-11-08');
    expect(date('republic-day-2027')).toBe('2027-01-26');
    expect(date('independence-day-2027')).toBe('2027-08-15');
    expect(date('holi-2027')).toBe('2027-03-23');
    // Diwali also has a 2027 row; the 2026 page must not pick it up.
    expect(CALENDAR.filter((r) => r.occasion === 'Diwali').length).toBeGreaterThan(1);
  });

  it('a row that does not exist fails loudly instead of printing a wrong date', () => {
    expect(() => rowFor({ occasion: 'Diwali', year: 2031 })).toThrow(/no "Diwali" in 2031/);
  });

  it.each(FESTIVALS.map((f) => [f.slug, f] as const))(
    '%s: title fits 60 characters, description 160, five ideas',
    (_slug, f) => {
      expect(f.title.length).toBeLessThanOrEqual(60);
      expect(f.title.endsWith('| Hookpost')).toBe(true);
      expect(f.description.length).toBeGreaterThan(50);
      expect(f.description.length).toBeLessThanOrEqual(160);
      expect(f.ideas).toHaveLength(5);
    }
  );

  it('festivalBySlug finds each page and nothing else', () => {
    for (const f of FESTIVALS) expect(festivalBySlug(f.slug)).toBe(f);
    expect(festivalBySlug('diwali-2027')).toBeUndefined();
    expect(festivalBySlug('')).toBeUndefined();
  });

  it('the route builds exactly these pages and 404s any other slug', () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual(FESTIVALS.map((f) => ({ festival: f.slug })));
  });

  it('the sitemap lists every festival page', () => {
    let urls: string[] = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      urls = require('../../sitemap')
        .default()
        .map((e: { url: string }) => e.url);
    });
    for (const f of FESTIVALS) {
      expect(urls).toContain(`${SITE}/social-media-calendar-india/${f.slug}`);
    }
  });

  it('the hub links to every festival page', () => {
    const hub = readFileSync(join(__dirname, 'page.tsx'), 'utf8');
    expect(hub).toMatch(/FESTIVALS\.map/);
    expect(hub).toMatch(/\/social-media-calendar-india\/\$\{f\.slug\}/);
  });
});
