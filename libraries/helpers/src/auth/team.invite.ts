/**
 * Team invite links, shared by the backend (redeems them), the proxy (routes
 * them) and the app (says what happened). No imports, so the proxy and
 * client components can use it.
 *
 * The link an invite email carries is /invite/<token>. It used to be
 * /?org=<token>, and Cloudflare caches "/" for signed-out visitors with the
 * query string left out of the cache key (cache rule a0aa6af8..., "Ignore
 * query string"), so the proxy never saw the invite: the visitor got the
 * marketing homepage, and an invitee who then signed up never joined the
 * team (25 Oct 2026). /invite/ is not in that rule. Links already sent as
 * /?org= are moved to /invite/ by a script in the homepage itself
 * (INVITE_LINK_SCRIPT), which runs on the cached copy too.
 */

/**
 * The httpOnly cookie that carries the invite token from the link to the
 * sign-up or sign-in that redeems it (AuthController reads req.cookies.org).
 * Only for a visitor who is signed out: signing up or in from an invite is
 * itself their answer. A signed-in visitor gets INVITE_PENDING_COOKIE and a
 * question instead.
 */
export const INVITE_COOKIE = 'org';

/**
 * An hour: enough to sign up, sign in through Google, or reset a forgotten
 * password, and short enough that a link someone else got the visitor to
 * open does not wait days for their next sign-in (invite fixation, review
 * of 1162ff204). Opening the link again sets it again.
 */
export const INVITE_COOKIE_MAX_AGE_SECONDS = 60 * 60;

/**
 * A readable, short-lived cookie that tells the app what became of the
 * invite (InviteResultToast). One of INVITE_OUTCOMES, nothing else; never a
 * name, so nothing a team's maker typed reaches a toast through it.
 */
export const INVITE_RESULT_COOKIE = 'hp_invite';
export const INVITE_RESULT_MAX_AGE_SECONDS = 10 * 60;

/**
 * - joined: a member now.
 * - held: the account has to confirm its email first; joins through the
 *   emailed link (AuthService.activate).
 * - member: already in that workspace; nothing changed (not the role either).
 * - invalid: forged, expired, already used, or its workspace is gone.
 * - full: every seat of the plan is taken.
 * - unavailable: the workspace's plan has no team members (Free, Standard,
 *   or a workspace that has not started its trial).
 * - error: it could not be held (Redis did not answer).
 */
export const INVITE_OUTCOMES = [
  'joined',
  'held',
  'member',
  'invalid',
  'full',
  'unavailable',
  'error',
] as const;
export type InviteOutcome = (typeof INVITE_OUTCOMES)[number];

export const isInviteOutcome = (value: unknown): value is InviteOutcome =>
  typeof value === 'string' &&
  (INVITE_OUTCOMES as readonly string[]).includes(value);

/**
 * An invite token as signPurposeJWT makes it: three base64url parts. The
 * proxy only checks the shape (the backend checks the signature); anything
 * else is not put in a cookie at all.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
export const MAX_INVITE_TOKEN_LENGTH = 2048;

export const looksLikeInviteToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= MAX_INVITE_TOKEN_LENGTH &&
  TOKEN_SHAPE.test(value);

/** The first path segment of an invite link. */
export const INVITE_SEGMENT = 'invite';

/** The path an invite email links to. */
export const invitePath = (token: string) =>
  `/${INVITE_SEGMENT}/${encodeURIComponent(token)}`;

/**
 * A signed-in visitor who opens /invite/<token> is asked first, on this page:
 * "Join <team>? You were invited by <name>. [Join team] [Not now]". Until 25
 * Oct 2026 the proxy joined them on the GET itself, so a link someone was
 * tricked into opening put them into a stranger's workspace before they saw
 * a thing. The token is never in this page's address.
 */
export const INVITE_CONFIRM_PATH = `/${INVITE_SEGMENT}`;

/**
 * The httpOnly cookie that holds the invite a signed-in visitor is being
 * asked about, between the GET of /invite/<token> (the proxy sets it) and
 * the POST of the Join button (POST /user/invite/accept reads it). Only that
 * POST redeems it; a sign-in never does (that is INVITE_COOKIE, for visitors
 * who are signed out). "Not now" removes it without spending the invite.
 * Same lifetime as INVITE_COOKIE.
 */
export const INVITE_PENDING_COOKIE = 'invite_pending';

/** How much of a team's name, and of an inviter's, a page shows. */
export const TEAM_NAME_MAX = 60;
export const INVITER_NAME_MAX = 60;

// C0/C1 controls, bidirectional overrides and isolates (U+202A-202E,
// U+2066-2069, the marks), zero-width spaces, word joiners and BOMs, line
// or paragraph separators, and characters that draw nothing but are not
// whitespace (the combining grapheme joiner, Hangul fillers, Khmer
// inherent vowels, Mongolian selectors): none belongs in a one-line name,
// a right-to-left override can make "moc.elpmaxe" read as "example.com",
// and a name of fillers looks blank. ZWJ and ZWNJ (U+200C, U+200D) and the
// variation selectors stay: Devanagari conjuncts and emoji need them.
const UNSHOWN =
  /[\u0000-\u001f\u007f-\u009f\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b\u200e\u200f\u2028-\u202e\u2060-\u2069\u3164\ufeff\uffa0]/g;
// Unicode tag characters (invisible; they can carry hidden text).
const TAGS = /[\u{E0000}-\u{E007F}]/gu;
// More than four combining marks in a row is stacking ("Zalgo"), which
// can draw a name over the buttons; real text never needs more.
const STACKED_MARKS = /(\p{M}{4})\p{M}+/gu;

/**
 * A name somebody else typed (a workspace's, an inviter's), made fit to
 * show on one line as text: the characters above removed, runs of
 * whitespace made one space, and at most `max` characters (whole code
 * points, so an emoji is never cut in half), with "…" when it was longer.
 * '' when nothing is left. It does not escape: React does that, and a name
 * is only ever rendered as a text node.
 */
export function displayName(value: unknown, max: number): string {
  if (typeof value !== 'string') {
    return '';
  }
  const clean = value
    .normalize('NFC')
    // Line breaks and tabs are spaces between words, not nothing.
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(UNSHOWN, '')
    .replace(TAGS, '')
    .replace(STACKED_MARKS, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : clean;
}
