/**
 * When the in-app review card ("Enjoying Hookpost? A short review helps a
 * lot.") may be shown to a user. Pure: ReviewAskService reads the facts and
 * this decides, so every rule is unit-tested without a database.
 *
 * Asked only right after a real success moment:
 *  - POSTS_PUBLISHED: the user's workspaces have posts actually published at
 *    two different times (state PUBLISHED, not deleted, top level; one post
 *    sent to several channels at once has one publish time, so it counts
 *    once), created since the user joined that workspace, and the latest of
 *    them went out within PUBLISH_WINDOW_DAYS: the visit right after the
 *    second post, or after any later one (scheduled posts go out while the
 *    user is away, so "right after" is their next visit, within 3 days).
 *    A user who already had posts when this shipped is asked on their first
 *    visit if they published in the last 3 days, else after their next
 *    publish; once either way, then the cap. Failed (ERROR), queued, draft and
 *    deleted posts never count. A team member is asked about the team's
 *    posts made while they were in it, never about older ones.
 *  - PAID_PLAN: a workspace the user owns (SUPERADMIN) started a paid plan or
 *    trial within PAID_WINDOW_DAYS (its Subscription row was created then)
 *    and it is not set to end. That window covers the trial start and the
 *    first charge of a 3- or 7-day trial; renewals never re-open it.
 *
 * Never:
 *  - more than once per REVIEW_ASK_COOLDOWN_DAYS: askedAt is stamped when the
 *    card is shown, so closing the tab counts as an ask, and "Not now" too;
 *  - again after the user opened a review page (clickedAt);
 *  - for internal, test and reviewer accounts (internalAccountReason) or a
 *    member of an internal workspace: one with a platform super admin
 *    member, one in FREE_PLAN_SUNSET_EXEMPT_ORGS, or an api.market workspace
 *    (the same lists isInternalWorkspace and the lead drip read);
 *  - while an admin is impersonating the user (the admin would see it and
 *    use up the user's ask);
 *  - for an unconfirmed or deleted account.
 *
 * Store policy (Google Play and G2 both): the card says the same thing to
 * everyone, asks no "do you like it?" first and offers nothing in return.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const REVIEW_ASK_COOLDOWN_DAYS = 60;
export const PUBLISH_WINDOW_DAYS = 3;
export const PAID_WINDOW_DAYS = 10;
/** Published posts (distinct publish times) before the first ask. */
export const REVIEW_ASK_MIN_POSTS = 2;

export type ReviewAskMoment = 'POSTS_PUBLISHED' | 'PAID_PLAN';
export type ReviewAskTarget = 'g2' | 'play';
export const REVIEW_ASK_TARGETS: ReviewAskTarget[] = ['g2', 'play'];

type Env = Record<string, string | undefined>;

/**
 * Our own, test and reviewer accounts, by address. The local part is
 * compared with dots and any +tag removed (Gmail ignores both).
 * REVIEW_ASK_INTERNAL_EMAILS lists full addresses (local part and domain must
 * both match, so a customer who shares a first name is still asked);
 * REVIEW_ASK_INTERNAL_LOCAL_PARTS lists handles distinctive enough to match on
 * any domain. Both are comma-separated and optional.
 */
const INTERNAL_DOMAINS = ['hookstep.in', 'razorpay.com'];
export const REVIEW_ASK_INTERNAL_EMAILS_ENV = 'REVIEW_ASK_INTERNAL_EMAILS';
export const REVIEW_ASK_INTERNAL_LOCAL_PARTS_ENV = 'REVIEW_ASK_INTERNAL_LOCAL_PARTS';

const normalisedAddress = (raw: string) => {
  const e = raw.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e.split('+')[0].replace(/\./g, '');
  return `${e.slice(0, at).split('+')[0].replace(/\./g, '')}@${e.slice(at + 1)}`;
};

const envList = (env: Env, key: string) =>
  String(env[key] || '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(normalisedAddress);

/** Extra addresses or domains to leave out, shared with the lead drip. */
export const REVIEW_ASK_SKIP_ENV = 'FREE_PLAN_SUNSET_SKIP_EMAILS';

const domainMatches = (domain: string, d: string) =>
  !!d && (domain === d || domain.endsWith(`.${d}`));

/** Why this address is one of ours (never asked), or null. */
export function internalAccountReason(
  email: string | null | undefined,
  env: Env = process.env
): string | null {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return 'no address';
  const domain = e.slice(at + 1);
  const local = e.slice(0, at).split('+')[0].replace(/\./g, '');

  const d = INTERNAL_DOMAINS.find((x) => domainMatches(domain, x));
  if (d) return `internal domain ${d}`;
  if (envList(env, REVIEW_ASK_INTERNAL_EMAILS_ENV).includes(`${local}@${domain}`)) {
    return 'internal address';
  }
  if (envList(env, REVIEW_ASK_INTERNAL_LOCAL_PARTS_ENV).includes(local)) {
    return 'internal address';
  }

  for (const raw of String(env[REVIEW_ASK_SKIP_ENV] || '').split(/[\s,;]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const i = entry.lastIndexOf('@');
    if (i > 0 ? entry === e : domainMatches(domain, entry.slice(i + 1))) {
      return `${REVIEW_ASK_SKIP_ENV}`;
    }
  }
  return null;
}

export interface ReviewAskState {
  askedAt: Date | null;
  dismissedAt?: Date | null;
  clickedAt?: Date | null;
}

export interface ReviewAskFacts {
  user: {
    email: string;
    isSuperAdmin?: boolean | null;
    activated?: boolean | null;
    deletedAt?: Date | null;
  };
  impersonating: boolean;
  state: ReviewAskState | null;
  /** A workspace the user is an active member of is internal (see above). */
  internalWorkspace: boolean;
  /** Published posts at distinct times counted for POSTS_PUBLISHED, capped at 2. */
  publishedPosts: number;
  /** When the latest of those went out. */
  latestPublishAt: Date | null;
  /** When the newest live paid plan of a workspace the user owns started. */
  paidPlanStartedAt: Date | null;
}

/** The only refusal that more facts (posts, a plan) could still turn into an ask. */
export const NO_RECENT_SUCCESS = 'no recent success';

export type ReviewAskDecision =
  | { ask: true; moment: ReviewAskMoment }
  | { ask: false; reason: string };

/** Asked within the cooldown, or done for good: no ask whatever happened. */
export function capReason(
  state: ReviewAskState | null,
  now: Date
): string | null {
  if (!state) return null;
  if (state.clickedAt) return 'opened a review page';
  if (
    state.askedAt &&
    now.getTime() - new Date(state.askedAt).getTime() <
      REVIEW_ASK_COOLDOWN_DAYS * DAY_MS
  ) {
    return 'asked recently';
  }
  return null;
}

const within = (at: Date | null, now: Date, days: number) =>
  !!at &&
  new Date(at).getTime() <= now.getTime() &&
  now.getTime() - new Date(at).getTime() <= days * DAY_MS;

/** The whole decision. */
export function decideReviewAsk(
  facts: ReviewAskFacts,
  now: Date = new Date()
): ReviewAskDecision {
  if (facts.impersonating) return { ask: false, reason: 'impersonating' };
  if (facts.user.deletedAt) return { ask: false, reason: 'deleted' };
  if (facts.user.activated === false) {
    return { ask: false, reason: 'email not confirmed' };
  }
  if (facts.user.isSuperAdmin) return { ask: false, reason: 'platform admin' };
  const internal = internalAccountReason(facts.user.email);
  if (internal) return { ask: false, reason: internal };
  if (facts.internalWorkspace) {
    return { ask: false, reason: 'internal workspace' };
  }
  const capped = capReason(facts.state, now);
  if (capped) return { ask: false, reason: capped };

  if (
    facts.publishedPosts >= REVIEW_ASK_MIN_POSTS &&
    within(facts.latestPublishAt, now, PUBLISH_WINDOW_DAYS)
  ) {
    return { ask: true, moment: 'POSTS_PUBLISHED' };
  }
  if (within(facts.paidPlanStartedAt, now, PAID_WINDOW_DAYS)) {
    return { ask: true, moment: 'PAID_PLAN' };
  }
  return { ask: false, reason: NO_RECENT_SUCCESS };
}
