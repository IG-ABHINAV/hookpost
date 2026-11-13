/**
 * The free-posts terms on /mcp, one version per currency checkout can charge.
 * (The file keeps its "trial" name: mcp-trial-terms.spec.ts, the ad pages and
 * about 90 other files import the trial-offer.ts names.)
 *
 * The paid ads land on /mcp and name the offer and the price after it. Since
 * 28 Oct 2026 new workspaces get FREE_POST_LIMIT free posts with no card, then
 * pay at checkout: no time trial. Since 8 Nov 2026 the one paid plan,
 * Hookpost, has a flat monthly price: no first-month discount and no yearly
 * price. They restate, not extend, what the rest of the product says:
 * - /pricing FAQ ("Can I try Hookpost before paying?", "When am I charged?"):
 *   the free posts, then the plan's price, charged when checkout is completed.
 * Workspaces that were already on a trial keep it, and /terms and
 * /cancellation-policy still govern it.
 * Figures come from pricing.ts through trial-offer.ts and usd-offer.ts.
 *
 * Server only: it reads the build-time switches. The page is cached for every
 * visitor, so which version a visitor sees is decided after hydration from
 * /api/public/pricing-context, by trial-terms.client.tsx, which also adds
 * RUPEE_NOTE for a rupee visitor outside India, as /pricing does.
 */
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  FIRST_PAYMENT_WHEN,
  FREE_POSTS,
  TRIAL_AFTER_FREE_POSTS,
  TRIAL_ONLY,
  TRIAL_SENTENCE,
} from '../trial-offer';
import { USD_MARKETED, USD_HOOKPOST_MONTH } from '../usd-offer';
import type { TrialTermsCopy } from './trial-terms.client';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

/** Billed monthly only: there is no yearly price. */
const PERIOD = 'billed monthly';

/**
 * Nothing is charged until the free posts are used, and then at checkout (or,
 * with the trial switch on, when the trial that starts there ends).
 */
const CHARGED = TRIAL_AFTER_FREE_POSTS
  ? FIRST_PAYMENT_WHEN
  : 'Nothing is charged until you choose a plan, and the payment is taken at checkout.';

/** For a visitor billed in rupees. */
export const MCP_TRIAL_TERMS_INR = `${FREE_POSTS}, no card needed. Then Hookpost, ${HOOKPOST_DISPLAY_PRICE} a month, ${PERIOD}. ${CHARGED}`;

/** For a visitor billed in dollars: card only. */
export const MCP_TRIAL_TERMS_USD = `${FREE_POSTS}, no card needed. Then Hookpost, ${USD_HOOKPOST_MONTH} a month, paid by card, ${PERIOD}. ${CHARGED}`;

/**
 * Both rails, each scoped: the sitewide sentence. True for every visitor, so it is what the cached HTML
 * carries in <noscript> for readers that run no JavaScript (ad reviewers, text
 * crawlers), and what a visitor reads when the pricing context never answers.
 */
export const MCP_TRIAL_TERMS_EITHER = `${TRIAL_SENTENCE} ${CHARGED}`;

/**
 * What the page passes to <TrialTerms>: null while new users still get the
 * Free plan (the page names no free-posts offer then), rupees alone while
 * only rupees are sold, and every version once dollars are sold too.
 */
export const MCP_TRIAL_TERMS: TrialTermsCopy | null = !TRIAL_ONLY
  ? null
  : USD_MARKETED
  ? { inr: MCP_TRIAL_TERMS_INR, usd: MCP_TRIAL_TERMS_USD, either: MCP_TRIAL_TERMS_EITHER }
  : { inr: MCP_TRIAL_TERMS_INR };
