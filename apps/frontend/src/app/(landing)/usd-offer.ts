/**
 * Whether the marketing pages sell in dollars as well as rupees, and the
 * dollar copy and structured data they then carry. PR-4 of
 * local-assets/trial-usd-plan-2026-10-18.md.
 *
 * The switch is the backend's own: usdOnForEveryone() from billing.currency.ts,
 * on the same keys (USD_CHECKOUT=on with GST_LUT_ARN set). USD_CHECKOUT=
 * allowlist does not count: it moves only the listed workspaces, never a
 * signed-out visitor, so the pages stay rupee-only. Off, which is how it
 * ships, every export here is inert and the pages render exactly as before.
 *
 * READ AT BUILD TIME, like trial-offer.ts: the landing pages are prerendered
 * and cached by NGINX and Cloudflare for every visitor, so a changed key
 * reaches them only through a rebuild (scripts/deploy-production.sh pulls
 * USD_CHECKOUT, GST_LUT_ARN and USD_EXCLUDED_COUNTRIES off the server's .env
 * before building). The cached HTML stays country-neutral either way: which
 * currency this visitor sees is asked of the uncached
 * /api/public/pricing-context after hydration, behind a skeleton.
 *
 * Server components only, for the same reason as trial-offer.ts: in the
 * browser process.env.USD_CHECKOUT is undefined. Client components get what
 * they need as props.
 */
import { usdOnForEveryone } from '@hookpost/nestjs-libraries/services/billing.currency';
import { excludedCountries } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import {
  AI_CREDIT_COST,
  HOOKPOST_PRICE,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, THEN_TRIAL, TRIAL_AFTER_FREE_POSTS } from './trial-offer';

const quiet = (): void => undefined;

/**
 * False since 8 Nov 2026 (the owner): every page shows the one plan as $7 to
 * every visitor, and every new purchase is charged on one INR plan or order
 * (pricing.ts HOOKPOST_PRICE), so there is no separate dollar rail to market
 * and the pages take their single-currency copy. The backend's USD rail
 * (usdOnForEveryone) decides nothing for the plan on sale.
 */
export const USD_MARKETED: boolean = false;
void usdOnForEveryone;

/** Where the dollar plans are not sold: India, and USD_EXCLUDED_COUNTRIES. */
const USD_INELIGIBLE: string[] = USD_MARKETED
  ? ['IN', ...[...excludedCountries(process.env, quiet)].sort()]
  : [];

const dollars = (n: number) => `$${n.toLocaleString('en-US')}`;

/** "$7": the Hookpost plan's monthly price as every page shows it. No yearly price. */
export const USD_HOOKPOST_MONTH = dollars(HOOKPOST_PRICE.displayUsd);

/** The same "$7", under the name the copy uses for the one shown price. */
export const HOOKPOST_DISPLAY_PRICE = USD_HOOKPOST_MONTH;

/**
 * The plan's metered allowances in the words every page uses (pricing.ts
 * TIER_LIMITS.HOOKPOST and AI_CREDIT_COST): "100 AI credits/month" and
 * "30 X posts/month".
 */
export const HOOKPOST_AI_CREDITS = `${pricingUSD.HOOKPOST.ai_credits} AI credits/month`;
export const HOOKPOST_AI_CREDITS_DETAIL = `${HOOKPOST_AI_CREDITS} (a post uses 1, an image ${AI_CREDIT_COST.ai_images})`;
export const HOOKPOST_X_POSTS = `${pricingUSD.HOOKPOST.x_posts_per_month} X posts/month`;
export const HOOKPOST_X_POSTS_DETAIL = `${HOOKPOST_X_POSTS}, without links (links on X are not included)`;

/**
 * "35¢": the shown price per channel with every channel in use. In cents, not
 * "$0.35": a figure starting "$0" reads as free (check-free-claims.js).
 */
export const HOOKPOST_DISPLAY_PER_CHANNEL = (() => {
  const usd = HOOKPOST_PRICE.displayUsd / (pricingUSD.HOOKPOST.channel || 1);
  return usd < 1 ? `${Math.round(usd * 100)}¢` : `$${usd.toFixed(2)}`;
})();

/** The free-posts terms for a visitor billed in dollars. */
export const USD_TRIAL_SENTENCE = TRIAL_AFTER_FREE_POSTS
  ? `${FREE_POSTS}, no card needed. ${THEN_TRIAL} Then ${USD_HOOKPOST_MONTH}/month for Hookpost.`
  : `${FREE_POSTS}, no card needed. Then ${USD_HOOKPOST_MONTH}/month for Hookpost, charged to your card.`;

/**
 * Dollar offers for the paid tiers, for a JSON-LD `offers` list beside the
 * rupee ones. Empty while the dollar plans are not sold.
 */
export function usdOffers(
  tiers: readonly string[]
): Array<Record<string, unknown>> {
  if (!USD_MARKETED) return [];
  return tiers
    .filter((tier) => tier !== 'FREE' && pricingUSD[tier])
    .map((tier) => ({
      '@type': 'Offer',
      name: tier.charAt(0) + tier.slice(1).toLowerCase(),
      price: String(pricingUSD[tier].month_price),
      priceCurrency: 'USD',
      ineligibleRegion: USD_INELIGIBLE,
    }));
}

/** The JSON-LD AggregateOffer in dollars for /pricing, or null while not sold. */
export function usdAggregateOffer(
  tiers: readonly string[],
  url: string,
  describe: (tier: string) => string
): Record<string, unknown> | null {
  const paid = tiers.filter((tier) => tier !== 'FREE' && pricingUSD[tier]);
  if (!USD_MARKETED || !paid.length) return null;
  const prices = paid.map((tier) => pricingUSD[tier].month_price);
  return {
    '@type': 'AggregateOffer',
    url,
    priceCurrency: 'USD',
    lowPrice: String(Math.min(...prices)),
    highPrice: String(Math.max(...prices)),
    offerCount: String(paid.length),
    ineligibleRegion: USD_INELIGIBLE,
    offers: paid.map((tier) => ({
      '@type': 'Offer',
      name: `${tier.charAt(0)}${tier.slice(1).toLowerCase()} plan`,
      price: String(pricingUSD[tier].month_price),
      priceCurrency: 'USD',
      url,
      availability: 'https://schema.org/InStock',
      description: describe(tier),
    })),
  };
}

/** The same choice as trial-offer's offer(): rupee-only copy, or both currencies. */
export function usdCopy<R, U>(rupeesOnly: R, withDollars: U): R | U {
  return USD_MARKETED ? withDollars : rupeesOnly;
}

/**
 * The plan's price, for copy every visitor reads: "$7", with `unit` after it
 * ("$7 a month"). Shown in dollars to everyone (pricing.ts HOOKPOST_PRICE);
 * no rupee figure on any page. Only the monthly price exists.
 */
export function planPrice(_tier: 'HOOKPOST' = 'HOOKPOST', unit = ''): string {
  return `${HOOKPOST_DISPLAY_PRICE}${unit}`;
}

/** planPrice() for a figure that already sits in brackets (the same text). */
export function planPriceInParens(_tier: 'HOOKPOST' = 'HOOKPOST', unit = ''): string {
  return `${HOOKPOST_DISPLAY_PRICE}${unit}`;
}

/**
 * How a plan is paid for, for "billed ..." on pages every visitor reads:
 * rupees only, or dollars by card with the rupee rails scoped to India.
 */
export const BILLED =
  'charged in Indian rupees (INR) at checkout, by UPI, cards or NetBanking';
