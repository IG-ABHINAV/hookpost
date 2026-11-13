import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS } from '../../compare/competitor-facts';
import { offer, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, planPriceInParens } from '../../usd-offer';

// Plan lines the /for pages share. Every role page used to type these in as
// two plan names and prices. Since 8 Nov 2026 there
// is one plan, Hookpost. Owner, 11 Oct 2026:
// rupees only (India is the market and no dollar checkout has ever collected),
// and every amount is read from pricing.ts so the pages cannot drift from it.
// Once dollars are sold (usd-offer.ts) the plan prices name both currencies,
// "$7 a month (₹599 in India)", through planPrice().
const { FREE, HOOKPOST } = pricingINR;

export const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

export const FREE_LIMITS = `${FREE.channel} channels and ${FREE.posts_per_month} posts a month`;
export const HOOKPOST_PRICE = planPrice('HOOKPOST', ' a month');
// The same, for a price that already sits in brackets: "Hookpost (…)".
export const HOOKPOST_PRICE_IN_PARENS = planPriceInParens('HOOKPOST', ' a month');

// The role pages' "free to get started?" FAQ, question and answer. Once new
// users have no Free plan (trial-offer.ts) it becomes the free-posts terms.
export const FREE_PLAN_QUESTION = offer(
  'Is Hookpost really free to get started?',
  'Can I try Hookpost before paying?'
);

export const FREE_PLAN_ANSWER = offer(
  `Yes. The free plan covers ${FREE_LIMITS} with no credit card. The Hookpost plan (${HOOKPOST_PRICE_IN_PARENS}) adds AI writing and the public API, and raises that to ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts with up to ${HOOKPOST.team_member_limit} team seats.`,
  `Yes. ${TRIAL_SENTENCE} Hookpost (${HOOKPOST_PRICE_IN_PARENS}) includes ${HOOKPOST.channel} channels, ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month, AI writing, the public API and up to ${HOOKPOST.team_member_limit} team seats.`
);

// Competitor figures from competitor-facts.ts: Buffer only shows dollars;
// Hootsuite shows a rupee price to a visitor in India (inrPlan, read 11 Oct).
const BUFFER = COMPETITOR_FACTS.buffer.cheapestPaid!;
const HOOTSUITE_INR = COMPETITOR_FACTS.hootsuite.inrPlan!;
export const BUFFER_PER_CHANNEL = `$${BUFFER.price} per channel a month (billed yearly, in US dollars)`;
export const HOOTSUITE_PER_USER = `${inr(HOOTSUITE_INR.yearlyPerMonth!)} per user a month in India (billed yearly)`;
