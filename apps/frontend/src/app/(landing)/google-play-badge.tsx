import {
  playStoreUrl,
  TWA_HIDE_CLASS,
} from '@hookpost/frontend/components/layout/twa';

// Google's own badge artwork, at the URL Google's badge generator hands out,
// so it always matches the brand guidelines. It is 4.9 KB and sets no cookies,
// but Google serves it with `cache-control: private, max-age=0`, so a browser
// re-requests it on each visit. To self-host instead, put the official file in
// public/ and change this one line.
const BADGE_SRC =
  'https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png';

/**
 * Whether the marketing pages show the badge at all. Off since 22 Oct 2026: a
 * new account made in the Play app reaches only TWA_PLAN_NOTICE, with no trial,
 * no Free plan and no way forward, so the badge was sending new visitors into a
 * dead end. Marketing pages are seen signed out (signed-in visitors are sent on
 * to /launches), so this hides it from everyone who would have tapped it.
 * Switch back once the app can take a new user from sign-up to a trial.
 */
export const PLAY_BADGE_ON_SITE: boolean = false;

/**
 * "Get it on Google Play", linking to the listing with an install-referrer tag
 * per placement. Hidden inside the Play app itself by TWA_HIDE_CLASS (the CSS
 * is in (landing)/layout.tsx), since these pages are cached and cannot decide
 * that on the server. Renders nothing while PLAY_BADGE_ON_SITE is off.
 *
 * The PNG carries transparent padding around the black badge, so callers use
 * negative margins to line it up with what sits beside it.
 */
export const GooglePlayBadge = ({
  medium,
  className,
  lazy,
}: {
  medium: 'hero' | 'footer';
  className: string;
  lazy?: boolean;
}) => !PLAY_BADGE_ON_SITE ? null : (
  <a
    href={playStoreUrl(medium)}
    target="_blank"
    rel="noopener"
    className={`${TWA_HIDE_CLASS} inline-block shrink-0`}
  >
    <img
      src={BADGE_SRC}
      alt="Get it on Google Play"
      width={646}
      height={250}
      decoding="async"
      loading={lazy ? 'lazy' : undefined}
      className={className}
    />
  </a>
);
