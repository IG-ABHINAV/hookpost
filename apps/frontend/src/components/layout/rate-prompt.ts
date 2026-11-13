// "Enjoying Hookpost? A short review helps a lot." - which review page the
// card links to, and the event that makes it re-check.
//
// Whether the card is due is decided by the server, per user, so the cap
// holds across the website and the Play app (GET /user/review-ask; the rules
// are in libraries/nestjs-libraries/.../review-ask/review.ask.policy.ts):
// right after the user's second published post or a paid plan/trial start,
// at most once per 60 days, never again after a review page was opened, and
// never for our own, test or reviewer accounts. The page claims the ask
// (POST /user/review-ask {action: 'shown'}) right before it shows the card,
// and only shows it if that claim succeeds.
//
// Where the card points:
//  - in a tab the Play app opened (isTwaSession, twa.ts): Google Play only. A
//    Trusted Web Activity cannot call Google's in-app review API (a native
//    Play Core call), so this is a plain link to the listing;
//  - on the website: G2, plus "Rate on Google Play" in an Android browser
//    (the app is on Play; iPhone and desktop visitors cannot install it).
//
// Store policy (Google Play, G2): the same words to everyone, no "do you like
// it?" question before it, no stars in the copy, nothing offered in return.
//
// Logic only (no React), so the spec can drive it; the card is
// rate-prompt.component.tsx.

import { PLAY_STORE_URL } from '@hookpost/frontend/components/layout/twa';

/** G2's "write a review" link for the Hookpost product (signs in first). */
export const G2_REVIEW_URL = 'https://www.g2.com/products/hookpost/take_survey';
export const PLAY_REVIEW_URL = PLAY_STORE_URL;

/** window event: a post was just saved, re-check whether the card is due. */
export const RATE_PROMPT_EVENT = 'hookpost:rate-prompt-check';

export type ReviewTarget = 'g2' | 'play';

export interface ReviewButton {
  target: ReviewTarget;
  href: string;
}

/** The card's buttons: the primary one, and an optional second. */
export const reviewButtons = (p: {
  isTwa: boolean;
  isAndroid: boolean;
}): { primary: ReviewButton; secondary: ReviewButton | null } => {
  const play: ReviewButton = { target: 'play', href: PLAY_REVIEW_URL };
  if (p.isTwa) {
    return { primary: play, secondary: null };
  }
  return {
    primary: { target: 'g2', href: G2_REVIEW_URL },
    secondary: p.isAndroid ? play : null,
  };
};

/** An Android phone or tablet's browser (any of them), from its user agent. */
export const isAndroidUserAgent = (ua: string | null | undefined): boolean =>
  /\bAndroid\b/i.test(ua || '');

/**
 * The composer saved a new scheduled or published post: ask the card to
 * re-check with the server a little later (the publish itself runs on the
 * server). Nothing is stored in the browser.
 */
export const recordSuccessfulPost = (): void => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.dispatchEvent(new Event(RATE_PROMPT_EVENT));
  } catch (e) {
    // Old WebView without the Event constructor: the next page load re-checks.
  }
};
