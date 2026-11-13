/**
 * The festival offer banner and its theme, on the homepage, /pricing and the
 * in-app Plans screen. Everything about it is here: FESTIVAL_OFFERS is a
 * dated calendar (IST), and each entry carries its name and two colours.
 * The banner shows the entry whose dates include today, or, between two of
 * them, the next one coming (without a countdown, since it has not
 * started). After the last entry ends the banner hides by itself, with no
 * deploy. Add next season's festivals here.
 *
 * The price is NOT part of the offer: the banner prints the plan's shown
 * price (pricing.ts HOOKPOST_PRICE), so changing a price never needs a change
 * here. The countdown runs to the entry's real `end`; it never resets.
 *
 * No old or struck-through price and no "% off": the plan has never been
 * sold at a higher price, so any reference price would be invented, which
 * consumer-protection rules forbid. Do not add "lifetime", "free forever" or
 * "trial" either (holiday.offer.spec.ts checks the copy).
 */

/**
 * A festival's look is two colours and its name, nothing else. The banner,
 * hero pill, hero glow and plan-card badge are the same components for every
 * festival; only these colours change. Do not add drawn motifs, particles or
 * emoji art (snowflakes, confetti, kites): the owner rejected the snowfall
 * version of Winter as clip art (Nov 2026). If a festival needs more than a
 * palette, that is a design change to the shared components, not a theme.
 */
export interface FestivalTheme {
  /** The festival's colour: the status dot, the price, borders, the badge. */
  accent: string;
  /**
   * The second colour, mixed with the brand colour (a CSS token, see
   * festival.module.scss) into the soft glow behind the hero and the plan
   * card. Festival colours only: never the brand colour itself.
   */
  glow: string;
}

export interface FestivalOffer {
  /** Stable id, used for the theme class and the dismissal. */
  key: string;
  /** "Christmas": "Christmas offer". */
  name: string;
  /** First moment it shows, ISO with the IST offset. */
  start: string;
  /** Last moment it shows, ISO with the IST offset; the countdown's target. */
  end: string;
  theme: FestivalTheme;
}

/**
 * 2026-27 (IST). Diwali has passed (it ended with Bhai Dooj, 11 Nov), so the
 * season opens with Winter. Lohri is 13 Jan and Makar Sankranti 14 Jan 2027;
 * Holi (Dhulandi) is 22 Mar 2027, so its offer runs 17-27 Mar (Holi ± 5 days).
 * Accents are light enough to read as text on black (WCAG AA at 13px).
 */
export const FESTIVAL_OFFERS: FestivalOffer[] = [
  {
    key: 'winter',
    name: 'Winter',
    start: '2026-11-09T00:00:00+05:30',
    end: '2026-12-14T23:59:59+05:30',
    // Ice blue with a clear winter-sky glow.
    theme: { accent: '#a9c8ff', glow: '#2f7bff' },
  },
  {
    key: 'christmas',
    name: 'Christmas',
    start: '2026-12-15T00:00:00+05:30',
    end: '2026-12-26T23:59:59+05:30',
    // Holly red with a pine glow.
    theme: { accent: '#ff8a8a', glow: '#1f9d6b' },
  },
  {
    key: 'new-year',
    name: 'New Year',
    start: '2026-12-27T00:00:00+05:30',
    end: '2027-01-05T23:59:59+05:30',
    // Champagne gold with a warm amber glow.
    theme: { accent: '#f3d27a', glow: '#c9862b' },
  },
  {
    key: 'lohri-sankranti',
    name: 'Lohri & Makar Sankranti',
    start: '2027-01-10T00:00:00+05:30',
    end: '2027-01-16T23:59:59+05:30',
    // Bonfire amber.
    theme: { accent: '#ffbe5c', glow: '#ff5a1f' },
  },
  {
    key: 'republic-day',
    name: 'Republic Day',
    start: '2027-01-22T00:00:00+05:30',
    end: '2027-01-27T23:59:59+05:30',
    // Saffron with an India-green glow.
    theme: { accent: '#ffad5c', glow: '#138808' },
  },
  {
    key: 'holi',
    name: 'Holi',
    start: '2027-03-17T00:00:00+05:30',
    end: '2027-03-27T23:59:59+05:30',
    // Gulal yellow over the brand pink.
    theme: { accent: '#ffd84d', glow: '#ff3d8b' },
  },
];

/** What every banner says after the festival's name. */
export const HOLIDAY_OFFER_PITCH = 'every channel, every feature';

export interface FestivalNow {
  festival: FestivalOffer;
  /** Its dates include now; false while it is only the next one coming. */
  running: boolean;
}

/**
 * The festival the banner shows at `now` (milliseconds): the entry whose dates
 * include it, else the next one to start, else none once the calendar has run
 * out.
 */
export function festivalAt(
  now: number = Date.now(),
  calendar: FestivalOffer[] = FESTIVAL_OFFERS
): FestivalNow | null {
  const sorted = [...calendar].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start)
  );
  const running = sorted.find(
    (f) => now >= Date.parse(f.start) && now <= Date.parse(f.end)
  );
  if (running) return { festival: running, running: true };
  const next = sorted.find((f) => Date.parse(f.start) > now);
  return next ? { festival: next, running: false } : null;
}

/** The festival entry the banner shows at `now`, or null. */
export function currentFestival(
  now: number = Date.now(),
  calendar: FestivalOffer[] = FESTIVAL_OFFERS
): FestivalOffer | null {
  return festivalAt(now, calendar)?.festival ?? null;
}

/** Whether any banner shows at `now`. */
export function holidayOfferActive(now: number = Date.now()): boolean {
  return festivalAt(now) !== null;
}

/** "Winter offer — every channel, every feature for $7/month" */
export function holidayOfferText(
  festival: Pick<FestivalOffer, 'name'>,
  monthPrice: string
): string {
  return `${festival.name} offer — ${HOLIDAY_OFFER_PITCH} for ${monthPrice}/month`;
}

/**
 * "Offer ends in 2d 14h" until the real end; "Offer ends in 3h 20m" on the
 * last day; null once it has ended or when the festival has not started.
 */
export function countdownLabel(
  now: number,
  festival: FestivalNow | null
): string | null {
  if (!festival?.running) return null;
  const ms = Date.parse(festival.festival.end) - now;
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  return days > 0
    ? `Offer ends in ${days}d ${hours}h`
    : `Offer ends in ${hours}h ${mins}m`;
}

/** How long a closed banner stays closed. */
export const BANNER_DISMISS_MS = 24 * 60 * 60 * 1000;
export const BANNER_DISMISS_KEY = 'hookpost:festival-banner-closed';

/**
 * Whether a banner closed at `closedAt` (a stored timestamp, or anything
 * unreadable) is still closed at `now`.
 */
export function bannerStillDismissed(closedAt: unknown, now: number): boolean {
  const at = Number(closedAt);
  return Number.isFinite(at) && at > 0 && now - at < BANNER_DISMISS_MS && at <= now;
}
