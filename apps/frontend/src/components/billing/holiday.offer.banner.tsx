'use client';

import { CSSProperties, FC, ReactElement, useEffect, useState } from 'react';
import clsx from 'clsx';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  BANNER_DISMISS_KEY,
  bannerStillDismissed,
  countdownLabel,
  FESTIVAL_OFFERS,
  festivalAt,
  FestivalNow,
  FestivalOffer,
  FestivalTheme,
  HOLIDAY_OFFER_PITCH,
} from './holiday.offer';
import styles from './festival.module.scss';

/** The theme's colours as the CSS variables festival.module.scss reads. */
export function themeVars(theme: FestivalTheme): CSSProperties {
  return { '--f-accent': theme.accent, '--f-glow': theme.glow } as CSSProperties;
}

/** "$7": the plan's price as every page shows it (pricing.ts HOOKPOST_PRICE). */
export const HOLIDAY_OFFER_PRICE = `$${HOOKPOST_PRICE.displayUsd}`;

const byKey = (key: string | null | undefined) =>
  FESTIVAL_OFFERS.find((f) => f.key === key) ?? null;

/**
 * The festival to show, kept current in the browser. The marketing pages are
 * prerendered and cached, so their HTML shows the festival of the day they
 * were built: the server page passes its key in (`initialKey`), the first
 * client render uses it so it matches the HTML, and after hydration the
 * browser picks today's (holiday.offer.ts festivalAt) and refreshes the
 * countdown once a minute.
 */
export function useFestival(initialKey?: string | null): {
  current: FestivalNow | null;
  now: number | null;
} {
  const [state, setState] = useState<{ current: FestivalNow | null; now: number | null }>(
    () => {
      if (initialKey === undefined) {
        return { current: festivalAt(), now: Date.now() };
      }
      const f = byKey(initialKey);
      // No countdown until the browser knows the time (it differs from build).
      return { current: f ? { festival: f, running: true } : null, now: null };
    }
  );
  useEffect(() => {
    const tick = () => setState({ current: festivalAt(), now: Date.now() });
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  return state;
}

/** Closed by the visitor within the last 24 hours (localStorage). */
function useDismissed(): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      setDismissed(
        bannerStillDismissed(localStorage.getItem(BANNER_DISMISS_KEY), Date.now())
      );
    } catch {
      /* storage blocked: the banner just shows */
    }
  }, []);
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(BANNER_DISMISS_KEY, String(Date.now()));
    } catch {
      /* nothing to remember it in */
    }
  };
  return [dismissed, dismiss];
}

const Headline: FC<{ festival: FestivalOffer }> = ({ festival }) => (
  <span className={styles.headline}>
    <strong className={styles.name}>{festival.name} offer</strong>
    <span className={styles.pitch}> — {HOLIDAY_OFFER_PITCH} for</span>{' '}
    <span className={styles.price}>{HOLIDAY_OFFER_PRICE}/month</span>
  </span>
);

/** The festival's colour as a small lit dot. */
const Dot: FC = () => <span className={styles.dot} aria-hidden />;

const Chevron: FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={styles.chevron}>
    <path
      d="M4.5 2.5L8 6l-3.5 3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Homepage and /pricing: a slim announcement bar under the nav. Black, with
 * the festival's colour only in the dot, the price and a hairline along the
 * bottom; a countdown to the real end date, "Claim offer" and a close button
 * that hides it for 24 hours. `initialKey` is the server's
 * currentFestival()?.key at build.
 */
export const HolidayOfferStrip: FC<{
  initialKey?: string | null;
  ctaHref?: string;
}> = ({ initialKey, ctaHref = '/auth' }) => {
  const { current, now } = useFestival(initialKey);
  const [dismissed, dismiss] = useDismissed();
  if (!current || dismissed) return null;
  const { festival } = current;
  const countdown = now === null ? null : countdownLabel(now, current);
  return (
    <div
      role="region"
      aria-label={`${festival.name} offer`}
      data-testid="holiday-offer"
      data-festival={festival.key}
      className={styles.banner}
      style={themeVars(festival.theme)}
    >
      <div className={styles.bannerRow}>
        <Dot />
        <span className={styles.copy}>
          <Headline festival={festival} />
          {countdown ? (
            <span className={styles.countdown} data-testid="holiday-offer-countdown">
              {countdown}
            </span>
          ) : null}
        </span>
        <a href={ctaHref} className={styles.cta}>
          Claim offer
          <Chevron />
        </a>
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={dismiss}
        aria-label="Close the offer banner for a day"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
};

/** In-app Plans screen: the same bar, rounded, without the close button. */
export const HolidayOfferBanner: FC<{ className?: string }> = ({ className }) => {
  const { current, now } = useFestival(undefined);
  if (!current) return null;
  const { festival } = current;
  const countdown = now === null ? null : countdownLabel(now, current);
  return (
    <div
      role="note"
      data-testid="holiday-offer"
      data-festival={festival.key}
      className={clsx(styles.banner, styles.inApp, className)}
      style={themeVars(festival.theme)}
    >
      <div className={styles.bannerRow}>
        <Dot />
        <span className={styles.copy}>
          <Headline festival={festival} />
          {countdown ? (
            <span className={styles.countdown} data-testid="holiday-offer-countdown">
              {countdown}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
};

/** "Winter offer | $7/month": the quiet pill above the homepage headline. */
export const FestivalPill: FC<{ initialKey?: string | null }> = ({ initialKey }) => {
  const { current } = useFestival(initialKey);
  if (!current) return null;
  const { festival } = current;
  return (
    <span className={styles.pill} style={themeVars(festival.theme)} data-testid="festival-pill">
      <Dot />
      <span className={styles.pillName}>{festival.name} offer</span>
      <span className={styles.pillRule} aria-hidden />
      <span className={styles.pillPrice}>{HOLIDAY_OFFER_PRICE}/month</span>
    </span>
  );
};

/**
 * A soft glow in the festival's colours behind the homepage hero, rising from
 * behind the terminal. Pure CSS gradients on one layer that drifts slowly
 * (transform only, no canvas, no filter), still under prefers-reduced-motion;
 * absolutely placed, so it never moves the layout. The parent must be
 * position: relative.
 */
export const HeroGlow: FC<{ initialKey?: string | null }> = ({ initialKey }) => {
  const { current } = useFestival(initialKey);
  if (!current) return null;
  return (
    <div
      aria-hidden
      data-testid="festival-glow"
      data-festival={current.festival.key}
      className={styles.heroGlow}
      style={themeVars(current.festival.theme)}
    >
      <div className={styles.aurora} />
    </div>
  );
};

/**
 * The festival dressing for the plan card: a badge on the top edge
 * ("Winter offer"), a lit top edge and the theme's glow (put `cardClass` and
 * `cardStyle` on the card).
 */
export function useFestiveCard(initialKey?: string | null): {
  cardClass: string;
  cardStyle: ReturnType<typeof themeVars> | undefined;
  decoration: ReactElement | null;
} {
  const { current } = useFestival(initialKey);
  if (!current) return { cardClass: '', cardStyle: undefined, decoration: null };
  const { festival } = current;
  return {
    cardClass: styles.festiveCard,
    cardStyle: themeVars(festival.theme),
    decoration: (
      <>
        <span className={styles.cardEdge} aria-hidden />
        <span className={styles.ribbon} data-testid="festival-ribbon">
          <Dot />
          {festival.name} offer
        </span>
      </>
    ),
  };
}
