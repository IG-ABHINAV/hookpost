/**
 * When the in-app review card may be shown (review.ask.policy.ts).
 *   pnpm exec jest -c apps/backend/jest.config.ts review.ask.policy
 */
import {
  capReason,
  decideReviewAsk,
  internalAccountReason,
  NO_RECENT_SUCCESS,
  PAID_WINDOW_DAYS,
  PUBLISH_WINDOW_DAYS,
  REVIEW_ASK_COOLDOWN_DAYS,
  REVIEW_ASK_MIN_POSTS,
  ReviewAskFacts,
} from '@hookpost/nestjs-libraries/database/prisma/review-ask/review.ask.policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T10:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const facts = (over: Partial<ReviewAskFacts> = {}): ReviewAskFacts => ({
  user: { email: 'creator@example.com', isSuperAdmin: false, activated: true, deletedAt: null },
  impersonating: false,
  state: null,
  internalWorkspace: false,
  publishedPosts: 2,
  latestPublishAt: ago(0.1),
  paidPlanStartedAt: null,
  ...over,
});

describe('the numbers', () => {
  it('2nd post (the owner), 60 days (the owner), 3 days after a publish, 10 after a paid start', () => {
    expect(REVIEW_ASK_MIN_POSTS).toBe(2);
    expect(REVIEW_ASK_COOLDOWN_DAYS).toBe(60);
    expect(PUBLISH_WINDOW_DAYS).toBe(3);
    // Covers the trial start and the first charge of a 3- or 7-day trial.
    expect(PAID_WINDOW_DAYS).toBe(10);
  });
});

describe('decideReviewAsk: success moments', () => {
  it('right after the second published post (or a later one)', () => {
    expect(decideReviewAsk(facts(), NOW)).toEqual({ ask: true, moment: 'POSTS_PUBLISHED' });
  });

  it('not after only one published post', () => {
    expect(decideReviewAsk(facts({ publishedPosts: 1 }), NOW)).toEqual({
      ask: false,
      reason: NO_RECENT_SUCCESS,
    });
    expect(decideReviewAsk(facts({ publishedPosts: 0, latestPublishAt: null }), NOW).ask).toBe(false);
  });

  it('not when the latest publish is older than the window (no success moment now)', () => {
    expect(decideReviewAsk(facts({ latestPublishAt: ago(PUBLISH_WINDOW_DAYS - 0.01) }), NOW).ask).toBe(true);
    expect(decideReviewAsk(facts({ latestPublishAt: ago(PUBLISH_WINDOW_DAYS + 0.01) }), NOW).ask).toBe(false);
  });

  it('a publish date in the future is not a success yet', () => {
    expect(
      decideReviewAsk(facts({ latestPublishAt: new Date(NOW.getTime() + 60_000) }), NOW).ask
    ).toBe(false);
  });

  it('right after a paid plan or trial started, for ten days', () => {
    const paid = facts({ publishedPosts: 0, latestPublishAt: null });
    expect(decideReviewAsk({ ...paid, paidPlanStartedAt: ago(0.01) }, NOW)).toEqual({
      ask: true,
      moment: 'PAID_PLAN',
    });
    expect(decideReviewAsk({ ...paid, paidPlanStartedAt: ago(PAID_WINDOW_DAYS - 0.01) }, NOW).ask).toBe(true);
    expect(decideReviewAsk({ ...paid, paidPlanStartedAt: ago(PAID_WINDOW_DAYS + 0.01) }, NOW).ask).toBe(false);
  });
});

describe('decideReviewAsk: the cap', () => {
  it('at most once per 60 days, counted from when it was shown', () => {
    expect(decideReviewAsk(facts({ state: { askedAt: ago(1) } }), NOW)).toEqual({
      ask: false,
      reason: 'asked recently',
    });
    expect(decideReviewAsk(facts({ state: { askedAt: ago(59.99) } }), NOW).ask).toBe(false);
    expect(decideReviewAsk(facts({ state: { askedAt: ago(60) } }), NOW).ask).toBe(true);
  });

  it('a dismissal counts as an ask (the 60 days run from when it was shown)', () => {
    const state = { askedAt: ago(10), dismissedAt: ago(10) };
    expect(decideReviewAsk(facts({ state }), NOW).ask).toBe(false);
  });

  it('never again once the user opened a review page', () => {
    const state = { askedAt: ago(400), clickedAt: ago(400) };
    expect(decideReviewAsk(facts({ state }), NOW)).toEqual({
      ask: false,
      reason: 'opened a review page',
    });
  });

  it('capReason: none for a user never asked', () => {
    expect(capReason(null, NOW)).toBeNull();
    expect(capReason({ askedAt: null }, NOW)).toBeNull();
  });
});

describe('decideReviewAsk: never for', () => {
  it.each([
    ['an impersonating admin', { impersonating: true }, 'impersonating'],
    ['a deleted account', { user: { email: 'a@example.com', deletedAt: ago(1) } }, 'deleted'],
    ['an unconfirmed email', { user: { email: 'a@example.com', activated: false } }, 'email not confirmed'],
    ['a platform super admin', { user: { email: 'a@example.com', isSuperAdmin: true } }, 'platform admin'],
    ['a member of an internal workspace', { internalWorkspace: true }, 'internal workspace'],
  ] as [string, Partial<ReviewAskFacts>, string][])('%s', (_name, over, reason) => {
    expect(decideReviewAsk(facts(over), NOW)).toEqual({ ask: false, reason });
  });

  it('our own and reviewer accounts, even with a fresh success', () => {
    for (const email of ['support@hookstep.in', 'reviewer@opo.razorpay.com']) {
      expect(decideReviewAsk(facts({ user: { email } }), NOW).ask).toBe(false);
    }
  });
});

describe('internalAccountReason', () => {
  // Placeholder addresses: the real list comes from the environment.
  const ENV = {
    REVIEW_ASK_INTERNAL_EMAILS: 'owner.one@example.com, ownertwo@mail.example',
    REVIEW_ASK_INTERNAL_LOCAL_PARTS: 'teamtester123;reviewer.handle',
  };

  it.each([
    'support@hookstep.in',
    'Someone@Mail.Hookstep.In',
    'reviewer.7@opo.razorpay.com',
    'ops@razorpay.com',
    'owner.one@example.com',
    'Owner.One+ads@Example.com',
    'ownertwo@mail.example',
    'owner.two+test@mail.example',
    'teamtester123@example.org',
    'team.tester123+ads@example.net',
    'reviewerhandle@example.com',
  ])('%s is internal', (email) => {
    expect(internalAccountReason(email, ENV)).not.toBeNull();
  });

  it.each([
    'creator@example.com',
    'someone.else@example.org',
    'notowner@example.com',
    // Full addresses match on local part AND domain only.
    'owner.one@other.example',
    'ownerone@mail.example',
    'teamtester1234@example.com',
    'someone@hookstep.in.example.com',
    'someone@notrazorpay.com',
  ])('%s is a real user', (email) => {
    expect(internalAccountReason(email, ENV)).toBeNull();
  });

  it('with no lists set, only the internal domains are ours', () => {
    expect(internalAccountReason('owner.one@example.com', {})).toBeNull();
    expect(internalAccountReason('support@hookstep.in', {})).not.toBeNull();
  });

  it('no address is never asked', () => {
    expect(internalAccountReason('', {})).not.toBeNull();
    expect(internalAccountReason(null, {})).not.toBeNull();
    expect(internalAccountReason('nobody', {})).not.toBeNull();
  });

  it('FREE_PLAN_SUNSET_SKIP_EMAILS: exact addresses and domains, any case and separator', () => {
    const env = {
      FREE_PLAN_SUNSET_SKIP_EMAILS: ' Owner.Personal@Gmail.com; @Agency.example partner.example ',
    };
    expect(internalAccountReason('owner.personal@gmail.com', env)).toBe('FREE_PLAN_SUNSET_SKIP_EMAILS');
    expect(internalAccountReason('anyone@agency.example', env)).toBe('FREE_PLAN_SUNSET_SKIP_EMAILS');
    expect(internalAccountReason('anyone@eu.partner.example', env)).toBe('FREE_PLAN_SUNSET_SKIP_EMAILS');
    expect(internalAccountReason('owner.personal2@gmail.com', env)).toBeNull();
  });
});
