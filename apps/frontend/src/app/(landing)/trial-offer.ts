/**
 * What the marketing pages offer someone who signs up today: the Free plan, or
 * (once a cutoff is set) FREE_POST_LIMIT free posts with no card, then the one
 * paid plan, Hookpost, at its flat monthly price (no first-month discount, no
 * yearly price: the owner, 8 Nov 2026). PR-3 of
 * local-assets/trial-usd-plan-2026-10-18.md; the card or UPI AutoPay trial it
 * first carried was replaced on 28 Oct 2026 (the owner's call).
 *
 * The names keep "trial" (TRIAL_ONLY, TRIAL_SENTENCE, TRIAL_ROW, TRIAL_CTA,
 * offer()'s second argument) because about 90 files import them: the "trial"
 * branch of offer() now carries the free-posts copy. There is no time trial
 * for new users any more, so no page aimed at them may print TRIAL_DAYS; it
 * stays exported only for the legal pages, which still govern the workspaces
 * that are on a trial (trial-offer.spec.ts fails on a new-user page that says
 * "N-day trial").
 *
 * The switch is the backend's own: trialPolicyActive() from trial.policy.ts,
 * on the same two keys (TRIAL_REQUIRED_SINCE_IN, TRIAL_REQUIRED_SINCE_GLOBAL)
 * and the same strict parse, so an empty, unparseable or too-early value means
 * the Free copy, exactly as it means no gate on the backend.
 *
 * Any valid cutoff switches the copy, including one still in the future. That
 * is what makes "copy first, never the reverse" hold: set the cutoff a little
 * ahead, rebuild, and the pages stop offering Free before the first workspace
 * that has to start a trial is created. Either cutoff counts: these pages are
 * cached for every visitor, so they cannot say Free to one country and not to
 * another, and saying "trial" to someone who would still get Free costs nothing.
 *
 * READ AT BUILD TIME. Every page under (landing) is statically prerendered and
 * cached by NGINX and Cloudflare, so a changed key reaches them only through a
 * rebuild: run the deploy workflow, which pulls both keys off the server's .env
 * before building (scripts/deploy-production.sh, Step 0). Restarting the
 * backend alone gates new workspaces while these pages still say Free.
 *
 * Server components only. In a client component process.env.TRIAL_REQUIRED_*
 * is undefined in the browser, so it would hydrate back to the Free copy;
 * trial-offer.spec.ts fails if a 'use client' file imports this module. Client
 * components (site-nav, PricingPlans) get the copy as props from a server
 * wrapper instead.
 */
import {
  excludedCountries,
  FREE_POST_LIMIT,
  TRIAL_DAYS,
  trialCheckoutOn,
  trialCutoffs,
  trialPolicyActive,
  usdRailLive,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  MARKETED_TIERS,
  HOOKPOST_PRICE,
  PURCHASABLE_TIERS,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

const CUTOFFS = trialCutoffs(process.env);

/** True once new workspaces have to start the trial: no Free plan to sell. */
export const TRIAL_ONLY: boolean = trialPolicyActive(CUTOFFS);

// The earlier of the two cutoffs: when the trial terms took effect.
const TRIAL_SINCE: Date | null =
  [CUTOFFS.IN, CUTOFFS.GLOBAL]
    .filter((d): d is Date => !!d)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

/**
 * When the terms last changed: the trial went from 7 days to TRIAL_DAYS (3) on
 * 22 Oct 2026, and on 28 Oct 2026 new workspaces stopped getting a trial at all
 * (FREE_POST_LIMIT free posts instead). /terms, /refund-policy and
 * /cancellation-policy state both, so their "Last updated" moves with it.
 */
const TRIAL_LENGTH_CHANGED = new Date('2026-10-28T00:00:00+05:30');

/**
 * The date the trial terms took effect, for a legal page's "Last updated",
 * in India's calendar: "22 October 2026" (day-month) or "October 22, 2026"
 * (month-day), matching how each page already writes its date. The later of
 * the earlier cutoff and the last change to the terms (TRIAL_LENGTH_CHANGED).
 * Empty while there is no cutoff.
 */
export function trialTermsDate(style: 'day-month' | 'month-day'): string {
  if (!TRIAL_SINCE) return '';
  const since =
    TRIAL_SINCE.getTime() > TRIAL_LENGTH_CHANGED.getTime()
      ? TRIAL_SINCE
      : TRIAL_LENGTH_CHANGED;
  return since.toLocaleDateString(
    style === 'day-month' ? 'en-GB' : 'en-US',
    { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }
  );
}

/** The Free-plan copy while there is a Free plan for new users, else the free-posts copy (the "trial" argument). */
export function offer<F, T>(free: F, trial: T): F | T {
  return TRIAL_ONLY ? trial : free;
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/**
 * The length of the trial that workspaces already on one keep, from
 * trial.policy.ts. New users get no trial, so only the legal pages (which
 * still govern those trials) print it.
 */
export { TRIAL_DAYS };

/** How many posts a new workspace gets free, with no card (trial.policy.ts). */
export { FREE_POST_LIMIT };

/** "3 free posts": the building block for sentences that cannot use the full one. */
export const FREE_POSTS = `${FREE_POST_LIMIT} free posts`;

/**
 * Hookpost monthly as every page shows it ("$7", pricing.ts HOOKPOST_PRICE),
 * what the first payment is for once the free posts are used. Checkout
 * charges it in INR; no rupee figure is printed.
 */
export const TRIAL_PRICE_AFTER = `$${HOOKPOST_PRICE.displayUsd}`;
void rupees;

/**
 * The trial switch at build time (TRIAL_CHECKOUT, trial.policy.ts "TRIALS
 * BEHIND A SWITCH"): a card or UPI trial follows the free posts instead of
 * the first-month offer, which Razorpay never puts on a trial. Off in
 * production; every sentence below is then exactly what it was.
 */
export const TRIAL_AFTER_FREE_POSTS: boolean = trialCheckoutOn(process.env);

/** What follows the free posts while the trial switch is on. */
export const THEN_TRIAL = `Then a ${TRIAL_DAYS}-day trial on your card or UPI: nothing is charged until it ends, cancel any time before.`;

/** The same inside a sentence: "3 free posts, no card needed, then ...". */
export const THEN_TRIAL_TERMS = `then a ${TRIAL_DAYS}-day trial on your card or UPI before the first charge`;

/**
 * When the first payment is taken, for "when am I charged" answers: at
 * checkout, or with the trial switch on when the trial that starts there ends.
 */
export const FIRST_PAYMENT_WHEN = TRIAL_AFTER_FREE_POSTS
  ? `Choosing a plan starts a ${TRIAL_DAYS}-day trial, and the first payment is taken when it ends; nothing is charged if you cancel before.`
  : 'The first payment is taken at checkout once you choose a plan.';

/** ", and there is no time-limited trial" while there is none, else nothing. */
// Empty: public copy does not mention a trial at all (owner, 9 Nov 2026).
export const NO_TIME_TRIAL = '';

/** The plan's India copy rule, word for word. */
export const TRIAL_SENTENCE_IN = TRIAL_AFTER_FREE_POSTS
  ? `${FREE_POSTS}, no card needed. ${THEN_TRIAL}`
  : `${FREE_POSTS}, no card needed. Then ${TRIAL_PRICE_AFTER}/month.`;

// Whether dollars are sold too: the same switch as USD_MARKETED in
// usd-offer.ts (usdOnForEveryone, USD_CHECKOUT=on with an LUT). Read here
// rather than imported, because usd-offer.ts imports this file.
const quiet = (): void => undefined;
const SELLS_DOLLARS = usdRailLive(process.env);
const ELSEWHERE = excludedCountries(process.env, quiet).size
  ? 'in most other countries'
  : 'elsewhere';

/**
 * The free-posts terms on pages every visitor gets (home, FAQ, comparisons,
 * role pages and their structured data). While rupees are all that is sold,
 * the India rule above. Once dollars are sold too, both rails. The plan cards, which know the visitor's
 * currency, use TRIAL_SENTENCE_IN or USD_TRIAL_SENTENCE instead.
 */
export const TRIAL_SENTENCE = TRIAL_SENTENCE_IN;
void SELLS_DOLLARS;
void ELSEWHERE;

/**
 * The answer to "Is there a free trial?" on pages every visitor gets: says
 * plainly there is no time-limited trial, then the free-posts terms.
 */
export const TRIAL_FAQ_ANSWER = TRIAL_AFTER_FREE_POSTS
  ? `Yes, after your free posts. ${TRIAL_SENTENCE}`
  : TRIAL_SENTENCE;

/** Hookpost's cell in a comparison row about free plans. */
export const TRIAL_ROW = `${FREE_POSTS}, no card needed`;

/** Sign-up buttons. */
export const TRIAL_CTA = `Get ${FREE_POSTS}`;

/**
 * The tiers the landing pages list and put in JSON-LD: Free and Hookpost
 * while new users get Free, Hookpost only once they do not.
 */
export const LANDING_TIERS: readonly (typeof PURCHASABLE_TIERS)[number][] =
  TRIAL_ONLY ? MARKETED_TIERS : PURCHASABLE_TIERS;
