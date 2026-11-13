// The festival calendar and theme system (holiday.offer.ts). Every instant
// below is written in IST (+05:30), the zone the calendar is in.
//   pnpm exec jest -c apps/frontend/jest.config.ts holiday.offer
import {
  BANNER_DISMISS_MS,
  bannerStillDismissed,
  countdownLabel,
  currentFestival,
  FESTIVAL_OFFERS,
  festivalAt,
  HOLIDAY_OFFER_PITCH,
  holidayOfferActive,
  holidayOfferText,
} from './holiday.offer';
import { HOLIDAY_OFFER_PRICE } from './holiday.offer.banner';

const at = (ist: string) => Date.parse(`${ist}+05:30`);
const keyAt = (ist: string) => currentFestival(at(ist))?.key ?? null;

describe('festivalAt: which festival and theme show, in IST', () => {
  it.each([
    ['2026-11-09T12:00:00', 'winter'],
    ['2026-12-14T23:59:00', 'winter'],
    ['2026-12-15T00:00:00', 'christmas'],
    ['2026-12-26T23:59:00', 'christmas'],
    ['2026-12-27T00:00:00', 'new-year'],
    ['2027-01-05T23:59:00', 'new-year'],
    ['2027-01-13T09:00:00', 'lohri-sankranti'],
    ['2027-01-26T10:00:00', 'republic-day'],
    ['2027-03-22T10:00:00', 'holi'], // Holi (Dhulandi) 22 Mar 2027
  ])('%s IST is %s', (ist, key) => {
    expect(keyAt(ist)).toBe(key);
  });

  it('Diwali is over: it is not in the calendar', () => {
    expect(FESTIVAL_OFFERS.some((f) => /diwali/i.test(f.name))).toBe(false);
  });

  it('switches at midnight IST, not UTC', () => {
    // 15 Dec 00:30 IST is still 14 Dec in UTC: Christmas week in India.
    expect(keyAt('2026-12-14T23:59:59')).toBe('winter');
    expect(keyAt('2026-12-15T00:30:00')).toBe('christmas');
    expect(keyAt('2026-12-27T00:10:00')).toBe('new-year');
  });

  it('in a gap, shows the next festival as not yet running', () => {
    expect(festivalAt(at('2027-01-07T12:00:00'))).toMatchObject({
      festival: { key: 'lohri-sankranti' },
      running: false,
    });
    expect(festivalAt(at('2027-02-15T12:00:00'))?.festival.key).toBe('holi');
    expect(festivalAt(at('2026-12-01T12:00:00'))?.running).toBe(true);
  });

  it('shows nothing once the calendar has run out', () => {
    expect(keyAt('2027-03-28T00:00:01')).toBeNull();
    expect(holidayOfferActive(at('2027-04-10T12:00:00'))).toBe(false);
  });

  it('every festival is a palette and a name: no motifs, no emoji', () => {
    const theme = (k: string) => FESTIVAL_OFFERS.find((f) => f.key === k)!.theme;
    expect(theme('christmas').accent).not.toBe(theme('winter').accent);
    const accents = new Set(FESTIVAL_OFFERS.map((f) => f.theme.accent));
    expect(accents.size).toBe(FESTIVAL_OFFERS.length);
    for (const f of FESTIVAL_OFFERS) {
      expect(Object.keys(f.theme).sort()).toEqual(['accent', 'glow']);
      for (const c of [f.theme.accent, f.theme.glow]) {
        expect(c).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(f).not.toHaveProperty('emoji');
      expect(f.name).toMatch(/^[\w &]+$/);
    }
  });

  it('accents read as text on black (contrast at least 4.5:1)', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    for (const f of FESTIVAL_OFFERS) {
      expect((lum(f.theme.accent) + 0.05) / 0.05).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the calendar is in order, in IST, and no two entries overlap', () => {
    for (const [i, f] of FESTIVAL_OFFERS.entries()) {
      expect(f.start).toMatch(/\+05:30$/);
      expect(f.end).toMatch(/\+05:30$/);
      expect(Date.parse(f.end)).toBeGreaterThan(Date.parse(f.start));
      if (i > 0) {
        expect(Date.parse(f.start)).toBeGreaterThan(Date.parse(FESTIVAL_OFFERS[i - 1].end));
      }
    }
  });
});

describe('countdownLabel: to the real end, never reset', () => {
  it('days and hours, then hours and minutes on the last day', () => {
    const now = at('2026-12-12T09:00:00');
    expect(countdownLabel(now, festivalAt(now))).toBe('Offer ends in 2d 14h');
    const last = at('2026-12-14T20:39:00');
    expect(countdownLabel(last, festivalAt(last))).toBe('Offer ends in 3h 20m');
  });

  it('none for a festival that has not started, or after the end', () => {
    const gap = at('2027-01-07T12:00:00');
    expect(countdownLabel(gap, festivalAt(gap))).toBeNull();
    expect(countdownLabel(at('2027-04-01T00:00:00'), null)).toBeNull();
  });
});

describe('dismissal', () => {
  it('stays closed for 24 hours, then the banner returns', () => {
    const closed = at('2026-11-09T10:00:00');
    expect(bannerStillDismissed(String(closed), closed + 1000)).toBe(true);
    expect(bannerStillDismissed(String(closed), closed + BANNER_DISMISS_MS - 1)).toBe(true);
    expect(bannerStillDismissed(String(closed), closed + BANNER_DISMISS_MS)).toBe(false);
    expect(bannerStillDismissed(null, closed)).toBe(false);
    expect(bannerStillDismissed('garbage', closed)).toBe(false);
    expect(bannerStillDismissed(String(closed + 5000), closed)).toBe(false); // from the future
  });
});

describe('banner copy', () => {
  it('reads as the owner set it, before and during Christmas week', () => {
    const winter = currentFestival(at('2026-11-09T12:00:00'))!;
    const xmas = currentFestival(at('2026-12-20T12:00:00'))!;
    expect(holidayOfferText(winter, HOLIDAY_OFFER_PRICE)).toBe(
      'Winter offer — every channel, every feature for $7/month'
    );
    expect(holidayOfferText(xmas, HOLIDAY_OFFER_PRICE)).toBe(
      'Christmas offer — every channel, every feature for $7/month'
    );
  });

  it('never claims a discount, a reference price, lifetime, free forever or a trial', () => {
    const copy = [
      HOLIDAY_OFFER_PITCH,
      ...FESTIVAL_OFFERS.map((f) => holidayOfferText(f, HOLIDAY_OFFER_PRICE)),
      ...FESTIVAL_OFFERS.map((f) => `${f.name} offer`),
    ].join(' ');
    expect(copy).not.toMatch(/lifetime|free forever|trial|% ?off|\bwas\b|save|starts soon/i);
  });
});
