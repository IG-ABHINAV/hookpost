export interface PricingInnerInterface {
  current: string;
  month_price: number;
  year_price: number;
  // Not shown anywhere on the site: no customer was ever charged these, and a
  // struck-through "was" price nobody paid is a misleading reference price.
  anchor_month_price?: number;
  anchor_year_price?: number;
  discount_percent?: number;
  channel?: number;
  posts_per_month: number;
  // Cap on AI *text* generations (copilot chat + agent). Images and videos
  // were already metered; text was not, which made it the only unbounded
  // variable cost on the account.
  ai_generation_count: number;
  // X bills Hookpost for every post it creates: $0.015, or $0.20 when the
  // post has a link (docs.x.com/x-api/getting-started/pricing). Both caps are
  // per plan month and enforced at publish time (x.post.cap.ts); every reply
  // in a thread is a post of its own. Sized so the worst case (every capped
  // post used, the link ones at $0.20) stays under 20% of the plan's INR
  // price net of fees; the table is above TIER_LIMITS.
  x_posts_per_month: number;
  x_link_posts_per_month: number;
  team_members: boolean;
  // Hard seat cap for the org, owner included. `team_members` only says whether
  // the feature exists; without a number the plan was effectively unlimited
  // seats, so one TEAM seat could be resold to a whole company.
  team_member_limit: number;
  community_features: boolean;
  featured_by_gitroom: boolean;
  ai: boolean;
  import_from_channels: boolean;
  image_generator?: boolean;
  image_generation_count: number;
  // One monthly pool for AI text and images (AI_CREDIT_COST), where set.
  // ai_generation_count and image_generation_count are then the most of
  // each the pool allows, for display only.
  ai_credits?: number;
  generate_videos: number;
  public_api: boolean;
  webhooks: number;
  autoPost: boolean;
}
export interface PricingInterface {
  [key: string]: PricingInnerInterface;
}

/**
 * Price tables per currency. Which currency a visitor is shown and charged in
 * is decided on the server, in services/billing.currency.ts; nothing in this
 * file reads the request, the environment or the browser.
 *
 * Checkout charges INR, or USD where USD_CHECKOUT turns the USD rail on (it
 * ships off). EUR and GBP have never had a plan on the Razorpay account and
 * are kept only as tables.
 */
export type SupportedCurrency = 'INR' | 'USD' | 'EUR' | 'GBP';

export interface CurrencyConfig {
  code: SupportedCurrency;
  symbol: string;
  minorMultiplier: number;
  label: string;
}

export const CURRENCY_CONFIG: Record<SupportedCurrency, CurrencyConfig> = {
  INR: { code: 'INR', symbol: '₹', minorMultiplier: 100, label: 'INR (₹)' },
  USD: { code: 'USD', symbol: '$', minorMultiplier: 100, label: 'USD ($)' },
  EUR: { code: 'EUR', symbol: '€', minorMultiplier: 100, label: 'EUR (€)' },
  GBP: { code: 'GBP', symbol: '£', minorMultiplier: 100, label: 'GBP (£)' },
};

/*
 * On VPNs and foreign cards. The comment that used to sit here said an INR
 * subscription "needs an Indian instrument (UPI or an Indian card)", so a
 * foreign buyer could not take the rupee price. That was never tested: the
 * account has dcc and international cards switched on, and no payment on it
 * has ever been international (0 of 14 as of 12 Oct 2026), so nobody knows
 * either way. What the code does now is in services/billing.currency.ts: the
 * subscription checkout charges INR unless USD_CHECKOUT puts a workspace on
 * the USD rail, which stays off until a real foreign-card test (the plan's L2)
 * passes. /razorpay/verify logs a foreign card on an INR mandate; nothing
 * refuses one, so NRIs are never locked out.
 *
 * COLLECTABLE_CURRENCIES (INR, USD) used to live here and fed a browser-side
 * country-to-currency guess. Live Razorpay, 12 Oct 2026: 13 USD subscriptions
 * ever created, 0 paid, and no USD payment in any state. There is nothing left
 * for such a list to decide, so it went with the guess.
 */

export const CURRENCY_MINOR_MULTIPLIER = 100;

/**
 * THE PRICE OF THE ONE PLAN ON SALE (the owner, 8 Nov 2026), one constant:
 * - displayUsd: what every page, the plan screen, the holiday banner, the
 *   JSON-LD and the llms files show, to every visitor, India included: $7.
 * - chargeInrPaise: what every NEW purchase worldwide is charged, on one
 *   Razorpay INR plan (autopay) or a one-time INR order (the fallback):
 *   Rs 699. A card issued outside India pays the same INR plan; Razorpay's
 *   Dynamic Currency Conversion shows it in the card's currency. There is no
 *   geo split, no FX code and no USD plan for new purchases.
 * Existing subscriptions keep the Razorpay plan they were created on.
 * Change the price here and nowhere else.
 *
 * Entitlements are TIER_LIMITS.HOOKPOST; its worst-case cost is above it.
 */
export const HOOKPOST_PRICE = { displayUsd: 7, chargeInrPaise: 69900 } as const;

/** What a new purchase charges, in major units (one.time.plan.ts). INR only. */
export const ONE_TIME_PLAN_PRICE = {
  INR: HOOKPOST_PRICE.chargeInrPaise / 100,
} as const;

/**
 * AI credits (the HOOKPOST tier's ai_credits pool, one per plan month):
 * one AI text generation (a post, copilot or agent answer) is 1 credit, one
 * AI image 5 (Nano Banana 2.1 at 1K, $0.0336; image.model.ts never switches
 * to a model above $0.04), a video 0 (not offered). Tiers without ai_credits
 * keep their separate ai_generation_count / image_generation_count meters.
 */
export const AI_CREDIT_COST: Record<string, number> = {
  ai_text: 1,
  ai_images: 5,
  generate_videos: 0,
};

/** The credit types that draw on a tier's shared ai_credits pool. */
export const AI_CREDIT_POOL = ['ai_text', 'ai_images'] as const;

export function getCurrencyConfig(currency?: string): CurrencyConfig {
  const code = (currency || 'INR').toUpperCase() as SupportedCurrency;
  return CURRENCY_CONFIG[code] || CURRENCY_CONFIG.INR;
}

/**
 * Highly competitive pricing with 85%+ gross profit margin via Razorpay.
 */
// posts_per_month is a real gate - permissions.service.ts blocks publishing
// once the org's monthly count reaches it. It used to be 1000000 on every paid
// tier (no cap in practice) while the pricing page advertised 400 on Standard,
// and 0 on FREE, which meant the advertised free tier could not publish at all.
//
// Unit costs (Gemini on Vertex since 26 Oct 2026; prices from
// https://aistudio.google.com/docs/pricing, checked 8 Nov 2026):
//   published post          ~$0.00006  (about 30 Redis commands)
//   AI text generation      ~$0.0053   (gemini-3.8-flash at its 1 Jan 2027
//                                       price; gemini-3.5-flash-lite on a 429)
//   AI image                 $0.0336   (gemini-nano-banana-2.1, 1K; the
//                                       resolver never picks one over $0.04)
//   AI video                ~$0.30     (veo3_fast via kie.ai; every tier is 0)
//   X post                   $0.015, $0.20 with a link
// The older per-tier margin figures below (the X table) were written for the
// OpenAI prices and the Rs plans no longer sold; the HOOKPOST worst case is
// the one that matters and sits above TIER_LIMITS.HOOKPOST.
//
// The shape that matters: ONE video costs as much as about 60 AI texts.
// If a quota ever needs raising, raise text and images, never video.
//
// Quotas are per ORGANIZATION, not per user: creditAllowance() reads the org's
// subscription and reserveCredit() keys on organizationId. A Pro team of twenty
// shares one pool, which is why unlimited team members costs us nothing.
//
// X posts (x_posts_per_month / x_link_posts_per_month). X is the one channel
// that costs per post, and a link makes a post 13x dearer: before these caps
// a Standard workspace posting its 500 posts to X with links cost $100 against
// a Rs 599 plan. Worst case = links x $0.20 + (posts - links) x $0.015,
// against 20% of the INR price net of Razorpay's 2% + 18% GST (2.36%), at
// Rs 88 to $1. INR is the binding currency: USD prices are higher.
//
//   Plan       price    20% of net     posts / links   worst case
//   FREE       Rs 0     -               10 / 1         $0.34  (Rs 29)
//   STANDARD   Rs 599   Rs 117 ($1.33)  50 / 3         $1.31  (Rs 115, 19.6%)
//   TEAM       Rs 1,499 Rs 293 ($3.33)  100 / 8        $2.98  (Rs 262, 17.9%)
//   PRO        Rs 1,999 Rs 390 ($4.44)  150 / 10       $4.10  (Rs 361, 18.5%)
//   ULTIMATE   Rs 4,499 Rs 879 ($9.98)  400 / 20       $9.70  (Rs 854, 19.4%)
//
// In USD the same caps are 7% ($19 Standard) and 15% ($29 Pro) of the net
// price. FREE has no price to be a share of; it keeps a token allowance for
// the grandfathered Free workspaces. A lower price needs lower caps: at
// Rs 299 Standard, 20% is $0.66, i.e. about 20 posts with 1 link.
/**
 * Shared tier limits between INR and USD tiers.
 */
const TIER_LIMITS = {
  FREE: {
    channel: 2,
    image_generation_count: 0,
    posts_per_month: 30,
    ai_generation_count: 0,
    x_posts_per_month: 10,
    x_link_posts_per_month: 1,
    team_members: false,
    team_member_limit: 1,
    community_features: false,
    featured_by_gitroom: false,
    ai: false,
    import_from_channels: false,
    image_generator: false,
    public_api: false,
    webhooks: 0,
    autoPost: false,
    generate_videos: 0,
  },
  STANDARD: {
    channel: 5,
    posts_per_month: 500,
    ai_generation_count: 500,
    x_posts_per_month: 50,
    x_link_posts_per_month: 3,
    image_generation_count: 20,
    team_members: false,
    team_member_limit: 1,
    ai: true,
    community_features: false,
    featured_by_gitroom: false,
    import_from_channels: true,
    image_generator: false,
    public_api: true,
    webhooks: 2,
    autoPost: false,
    generate_videos: 0,
  },
  TEAM: {
    channel: 10,
    posts_per_month: 1500,
    ai_generation_count: 1500,
    x_posts_per_month: 100,
    x_link_posts_per_month: 8,
    image_generation_count: 100,
    community_features: true,
    team_members: true,
    team_member_limit: 5,
    featured_by_gitroom: true,
    ai: true,
    import_from_channels: true,
    image_generator: true,
    public_api: true,
    webhooks: 10,
    autoPost: true,
    generate_videos: 10,
  },
  PRO: {
    // 20, not 30: the add-channel screen offers 20 platforms, so quoting 30
    // reads as "30 platforms" to anyone who has not read the channel FAQ.
    channel: 20,
    // 2,000 not 5,000. 5,000 across 30 channels is 5.6 posts per channel per
    // day, which the platforms themselves would treat as spam - LinkedIn's
    // Community Management dev tier alone is 500 calls/day. A quota nobody can
    // reach is not generosity, it is a number that invites a support ticket.
    // 2,000 over 20 channels is 3.3/day, the same intensity as Standard.
    posts_per_month: 2000,
    ai_generation_count: 1000,
    x_posts_per_month: 150,
    x_link_posts_per_month: 10,
    image_generation_count: 100,
    community_features: true,
    team_members: true,
    team_member_limit: 15,
    featured_by_gitroom: true,
    ai: true,
    import_from_channels: true,
    image_generator: true,
    public_api: true,
    webhooks: 30,
    autoPost: true,
    // ZERO until the kie.ai balance is topped up. The account has 0 generation
    // credits and veo3_fast costs 60 credits ($0.30) a clip, so advertising a
    // video allowance would promise something the first customer cannot use.
    // The pricing card omits the video line entirely while this is 0, so
    // restoring it is a one-number change once credits exist: put 3 back on
    // Standard and 10 on PRO. Cost model for that: 10 videos is Rs260, about
    // half of PRO's entire worst-case COGS.
    //
    // Veo3 fast costs ~$0.30 (Rs 26) per generation at kie.ai, so the video
    // allowance is the single most expensive thing a plan can hand out. Held
    // to roughly 17% of plan price on every tier, matching the worst-case
    // discipline applied to posts above.
    generate_videos: 0,
  },
  // THE ONE PLAN ON SALE (the owner, 8 Nov 2026): every platform, channel
  // and seat PRO has, with the three things that cost Hookpost money per use
  // capped: 100 AI credits a month (text 1, image 5, video 0), and X at 30
  // posts a month with no link posts (a link makes an X post 13x dearer).
  //
  // Worst case a month, USD, every cap used (the AI pool goes to one kind):
  //   AI images  20 x $0.0336 (Nano Banana 2.1, 1K)        $0.67
  //   or AI text 100 x $0.0053 (gemini-3.8-flash at its
  //              1 Jan 2027 price, $1.50 / $7.50 per 1M)   $0.53
  //   X posts    30 x $0.015, no links                     $0.45
  //   max                                                  about $1.12
  // against about $6.75 net of a $7 price (Rs 699 less Razorpay's fee and
  // GST, or the DCC-converted equivalent). Fixed infra is not in this. Raise
  // a cap only after redoing this sum; image.model.ts holds images to $0.04.
  HOOKPOST: {
    channel: 20,
    posts_per_month: 2000,
    ai_credits: 100,
    // the most of each the 100 credits allow (display only)
    ai_generation_count: 100,
    x_posts_per_month: 30,
    x_link_posts_per_month: 0,
    image_generation_count: 20,
    community_features: true,
    team_members: true,
    team_member_limit: 15,
    featured_by_gitroom: true,
    ai: true,
    import_from_channels: true,
    image_generator: true,
    public_api: true,
    webhooks: 30,
    autoPost: true,
    generate_videos: 0,
  },
  ULTIMATE: {
    channel: 100,
    posts_per_month: 15000,
    ai_generation_count: 6000,
    x_posts_per_month: 400,
    x_link_posts_per_month: 20,
    image_generation_count: 500,
    community_features: true,
    team_members: true,
    team_member_limit: 100,
    featured_by_gitroom: true,
    ai: true,
    import_from_channels: true,
    image_generator: true,
    public_api: true,
    webhooks: 10000,
    autoPost: true,
    generate_videos: 25,
  },
};

/**
 * The plans we actually SELL. Four paid tiers was over-segmentation for a
 * product with a single-digit customer count: it multiplied the Razorpay plan
 * objects (13 exist, of which 3 are leftover test plans and one is an orphan at
 * a price we never offered), and every extra tier is another thing to keep
 * correct on the pricing page, in the FAQ and in the JSON-LD.
 *
 * TEAM and ULTIMATE keep their TIER_LIMITS entries on purpose. Entitlements are
 * resolved as `pricing[tier]`, and subscription.service.ts:52 treats a missing
 * tier as FREE - so deleting them would silently drop existing TEAM and
 * ULTIMATE subscribers to free-tier limits. There are live rows on both. They
 * are no longer purchasable; they still work for whoever already has them.
 */
export const PURCHASABLE_TIERS = ['FREE', 'HOOKPOST'] as const;

/**
 * One plan since 8 Nov 2026 (HOOKPOST). STANDARD and PRO are no longer sold
 * either; like TEAM and ULTIMATE they keep their tables so their subscribers
 * keep exactly what they have.
 */

/**
 * The plans the marketing pages advertise once new workspaces have to start
 * the trial (TRIAL_DAYS, a TRIAL_REQUIRED_SINCE_* cutoff is set): the paid ones only.
 * The landing pages pick between this and PURCHASABLE_TIERS through
 * LANDING_TIERS in apps/frontend/src/app/(landing)/trial-offer.ts.
 *
 * PURCHASABLE_TIERS keeps FREE on purpose: main.billing and first.billing read
 * it too, and workspaces created before the cutoff keep the Free plan.
 */
export const MARKETED_TIERS = ['HOOKPOST'] as const;

/**
 * INR Pricing (₹) - Regional Purchasing Power Parity (58% off global anchor).
 */
export const pricingINR: PricingInterface = {
  FREE: { current: 'FREE', month_price: 0, year_price: 0, ...TIER_LIMITS.FREE },
  STANDARD: { current: 'STANDARD', month_price: 599, year_price: 5990, anchor_month_price: 1699, anchor_year_price: 16990, discount_percent: 65, ...TIER_LIMITS.STANDARD },
  TEAM: { current: 'TEAM', month_price: 1499, year_price: 13990, anchor_month_price: 3499, anchor_year_price: 34990, discount_percent: 57, ...TIER_LIMITS.TEAM },
  PRO: { current: 'PRO', month_price: 1999, year_price: 19990, anchor_month_price: 5499, anchor_year_price: 54990, discount_percent: 64, ...TIER_LIMITS.PRO },
  HOOKPOST: { current: 'HOOKPOST', month_price: ONE_TIME_PLAN_PRICE.INR, year_price: 0, ...TIER_LIMITS.HOOKPOST },
  ULTIMATE: { current: 'ULTIMATE', month_price: 4499, year_price: 43990, anchor_month_price: 9999, anchor_year_price: 99990, discount_percent: 55, ...TIER_LIMITS.ULTIMATE },
};

/**
 * USD Pricing ($): the USD rail of PR-4 (local-assets/trial-usd-plan-2026-10-18.md),
 * sold only where billing.currency.ts says so (USD_CHECKOUT). Standard $19 and
 * Pro $29 a month; yearly is ten months, $190 and $290 (the plan's default,
 * the owner's call to change).
 *
 * The live plan plan_TcvgEaf5Av5gBI (STANDARD|MONTHLY|1900|USD) is what a
 * Standard monthly checkout finds and reuses; no USD Pro plan exists yet, so
 * findOrCreatePlan creates STANDARD|... or PRO|...|2900|USD on the first
 * checkout that asks for one. Changing a figure here provisions a new plan
 * rather than repricing anyone.
 *
 * Rule: every tier must sit strictly BELOW both competitors at the same channel
 * count. Buffer charges $5/channel (5ch $25, 20ch $100); Postiz charges $29 /
 * $39 / $49 / $99 for 5 / 10 / 30 / 100 channels. Standard (5 channels) at $19
 * and Pro (20 channels) at $29 are under both.
 *
 * The floor is worst-case COGS from the unit costs documented above - every
 * quota maxed, an AI caption on every post, every video generated:
 *
 *   STANDARD  $2.05   TEAM  $8.04   PRO  $20.06   ULTIMATE  $38.35
 *
 * Fees: Razorpay's international card fee is 3% plus 0.9% currency
 * conversion, both with 18% GST, so (3% + 0.9%) x 1.18 = 4.6% of the price.
 * Net of that, per month:
 *
 *   STANDARD  $19 -> $18.13, worst case leaves $16.08 (85% of the price)
 *   PRO       $29 -> $27.67, worst case leaves  $7.61 (26%)
 *   PRO yearly $290 -> $276.66 against 12 x $20.06 = $240.72, leaves 12%
 *
 * PRO is thin: it is the first tier that goes under water if a quota rises or
 * a price is cut, and the yearly price is thinner still. Recompute this table
 * before touching either. TEAM and ULTIMATE are not sold (PURCHASABLE_TIERS)
 * and keep their figures only for the record.
 */
export const pricingUSD: PricingInterface = {
  FREE: { current: 'FREE', month_price: 0, year_price: 0, ...TIER_LIMITS.FREE },
  STANDARD: { current: 'STANDARD', month_price: 19, year_price: 190, ...TIER_LIMITS.STANDARD },
  TEAM: { current: 'TEAM', month_price: 35, year_price: 350, anchor_month_price: 59, anchor_year_price: 590, discount_percent: 41, ...TIER_LIMITS.TEAM },
  PRO: { current: 'PRO', month_price: 29, year_price: 290, ...TIER_LIMITS.PRO },
  HOOKPOST: { current: 'HOOKPOST', month_price: HOOKPOST_PRICE.displayUsd, year_price: 0, ...TIER_LIMITS.HOOKPOST },
  ULTIMATE: { current: 'ULTIMATE', month_price: 89, year_price: 890, anchor_month_price: 239, anchor_year_price: 2390, discount_percent: 63, ...TIER_LIMITS.ULTIMATE },
};

/**
 * EUR Pricing (€) - European Union (35% off launch offer).
 */
export const pricingEUR: PricingInterface = {
  FREE: { current: 'FREE', month_price: 0, year_price: 0, ...TIER_LIMITS.FREE },
  STANDARD: { current: 'STANDARD', month_price: 15, year_price: 150, anchor_month_price: 29, anchor_year_price: 290, discount_percent: 48, ...TIER_LIMITS.STANDARD },
  TEAM: { current: 'TEAM', month_price: 35, year_price: 350, anchor_month_price: 59, anchor_year_price: 590, discount_percent: 41, ...TIER_LIMITS.TEAM },
  PRO: { current: 'PRO', month_price: 39, year_price: 390, anchor_month_price: 119, anchor_year_price: 1190, discount_percent: 67, ...TIER_LIMITS.PRO },
  HOOKPOST: { current: 'HOOKPOST', month_price: HOOKPOST_PRICE.displayUsd, year_price: 0, ...TIER_LIMITS.HOOKPOST },
  ULTIMATE: { current: 'ULTIMATE', month_price: 89, year_price: 890, anchor_month_price: 239, anchor_year_price: 2390, discount_percent: 63, ...TIER_LIMITS.ULTIMATE },
};

/**
 * GBP Pricing (£) - United Kingdom (36% off launch offer).
 */
export const pricingGBP: PricingInterface = {
  FREE: { current: 'FREE', month_price: 0, year_price: 0, ...TIER_LIMITS.FREE },
  STANDARD: { current: 'STANDARD', month_price: 16, year_price: 150, anchor_month_price: 25, anchor_year_price: 250, discount_percent: 36, ...TIER_LIMITS.STANDARD },
  TEAM: { current: 'TEAM', month_price: 29, year_price: 290, anchor_month_price: 49, anchor_year_price: 490, discount_percent: 41, ...TIER_LIMITS.TEAM },
  PRO: { current: 'PRO', month_price: 37, year_price: 370, anchor_month_price: 99, anchor_year_price: 990, discount_percent: 63, ...TIER_LIMITS.PRO },
  HOOKPOST: { current: 'HOOKPOST', month_price: HOOKPOST_PRICE.displayUsd, year_price: 0, ...TIER_LIMITS.HOOKPOST },
  ULTIMATE: { current: 'ULTIMATE', month_price: 74, year_price: 740, anchor_month_price: 199, anchor_year_price: 1990, discount_percent: 63, ...TIER_LIMITS.ULTIMATE },
};

export const PRICING_BY_CURRENCY: Record<SupportedCurrency, PricingInterface> = {
  INR: pricingINR,
  USD: pricingUSD,
  EUR: pricingEUR,
  GBP: pricingGBP,
};

/** Unknown or missing currency gives the INR table, the one checkout charges. */
export function getPricing(currency?: string): PricingInterface {
  if (currency && PRICING_BY_CURRENCY[currency.toUpperCase() as SupportedCurrency]) {
    return PRICING_BY_CURRENCY[currency.toUpperCase() as SupportedCurrency];
  }
  return pricingINR;
}

/**
 * A price after a percent-off coupon, to the paisa (or cent): what checkout
 * charges (RazorpayService.subscribe, in minor units through
 * couponPriceMinor), what GET /billing/coupon/validate answers and what the
 * plan cards show. No coupon, or 0%, is the price itself.
 */
export function couponPrice(price: number, percentOff?: number | null): number {
  return percentOff ? Math.round(price * (100 - percentOff)) / 100 : price;
}

/** couponPrice for an amount in minor units (paise), as Razorpay takes it. */
export function couponPriceMinor(amountMinor: number, percentOff?: number | null): number {
  return percentOff ? Math.round((amountMinor * (100 - percentOff)) / 100) : amountMinor;
}

/**
 * Backward compatibility: export default `pricing` aliased to INR.
 */
export const pricing: PricingInterface = pricingINR;
