/**
 * The Hookpost products sold on api.market, and every limit of every plan.
 * The one source of truth: the marketplace gateway (apps/backend/src/
 * marketplace-api) enforces these when a call is accepted, and
 * SubscriptionService.publishWithinPlan re-checks them in the orchestrator
 * before anything reaches a network, for every workspace whose plan row has
 * an `apimkt:` identifier.
 *
 * Pure: no Nest, Prisma or Redis imports, so the backend, the orchestrator
 * and the specs read the same table.
 *
 * Billing. api.market bills each 200 response by the `X-Magicapi-Billing:
 * API=N;` header our backend sends (seller-docs/custom-usage). A plan sells
 * `credits` units per month; every action costs CREDIT_COST of them. Reads
 * cost 0. api.market counts them and, with "Stop the calls", refuses calls
 * until its next month.
 *
 * Our own count is a backstop, in case api.market's counter ever misses some.
 * api.market's month runs from the subscription date and it forwards nothing
 * that says when (its docs list no such header; the subscription and usage
 * APIs that show it answer the buyer's own key). So our window starts at the
 * account's first call, and a window can hold the end of one api.market
 * month and the start of the next: a buyer who stays within the plan can
 * still use 2x the credits in one of our windows. A window is 28 days, so it
 * never holds three (an api.market month is at least 28 days). Paid plans
 * are refused only past PAID_CAP_MULTIPLIER (2x) in a window and logged past
 * ALERT_MULTIPLIER (1.2x). A trial does not renew, so it is refused past
 * TRIAL_CAP_MULTIPLIER (1.2x).
 *
 * Profit. X bills Hookpost per post ($0.015, $0.20 with a link). Every other
 * network costs nothing per call. The worst case for a plan that includes X
 * is every credit spent on X: 2 credits a post ($0.0075 a credit) or 20 with
 * a link ($0.01 a credit). Every paid plan below keeps a profit at a 25%
 * marketplace fee (api.market says "up to 20%") with its whole cap used in
 * every window, 2x the credits per 28 days (2.17x a month).
 * marketplace.plans.spec.ts fails the build on a price below that.
 */

export type MarketplaceProduct = 'social' | 'linkedin' | 'x' | 'validate';

export const MARKETPLACE_PRODUCTS: readonly MarketplaceProduct[] = [
  'social',
  'linkedin',
  'x',
  'validate',
];

/** MarketplaceAccount.marketplace for api.market. */
export const API_MARKET = 'API_MARKET';

/** Subscription.identifier of a marketplace workspace: apimkt:<product>:<user>. */
export const MARKETPLACE_IDENTIFIER_PREFIX = 'apimkt:';

export const marketplaceIdentifier = (
  product: MarketplaceProduct,
  externalUserId: string
) => `${MARKETPLACE_IDENTIFIER_PREFIX}${product}:${externalUserId}`;

export const isMarketplaceIdentifier = (identifier?: string | null) =>
  typeof identifier === 'string' &&
  identifier.startsWith(MARKETPLACE_IDENTIFIER_PREFIX);

export const isMarketplaceProduct = (p: unknown): p is MarketplaceProduct =>
  typeof p === 'string' && (MARKETPLACE_PRODUCTS as readonly string[]).includes(p);

/** What each action costs, in credits. */
export const CREDIT_COST = {
  /** One post on one channel that is not X. */
  channelPost: 1,
  /** One X post (each reply of a thread is one) without a link: X bills $0.015. */
  xTweet: 2,
  /** One X post with a link: X bills $0.20 for it, 13x a plain one. */
  xTweetWithLink: 20,
  /** One carousel PDF rendered. */
  carouselRender: 1,
  /** One validator check (any number of platforms). */
  validatorCheck: 1,
} as const;

/** What X bills Hookpost per post (docs.x.com pricing, checked 27 Sep 2026). */
export const X_COST_USD = { tweet: 0.015, tweetWithLink: 0.2 } as const;

/**
 * Our refusal point for a paid plan, as a multiple of its credits in one
 * window: a window can hold two api.market months, each with the full credits.
 */
export const PAID_CAP_MULTIPLIER = 2;

/** A trial's refusal point: its credits never renew inside a window. */
export const TRIAL_CAP_MULTIPLIER = 1.2;

/** Past this multiple of the credits in one window, the account is logged once ("mkt usage alert"). */
export const ALERT_MULTIPLIER = 1.2;

/** api.market's fee ("up to 20%", sell page), and the stress case we price for. */
export const MARKETPLACE_FEE = 0.2;
export const MARKETPLACE_FEE_STRESS = 0.25;

/**
 * How long one quota window is, from the account's periodStart. 28 days: an
 * api.market month is at least that long, so one window holds two of them
 * at most.
 */
export const QUOTA_WINDOW_DAYS = 28;

/** The average month, for how many windows a paid month holds. */
export const AVERAGE_MONTH_DAYS = 365.25 / 12;

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** Upload caps for marketplace workspaces (the app's own video cap is 1 GB). */
export const MARKETPLACE_MAX_IMAGE_BYTES = 10 * MB;
export const MARKETPLACE_MAX_VIDEO_BYTES = 200 * MB;

/** X posts per X channel per publish day, any plan. */
export const X_TWEETS_PER_CHANNEL_PER_DAY = 50;

/** YouTube uploads per publish day across every marketplace workspace. */
export const YOUTUBE_MARKETPLACE_DAILY = 20;

/** Carousel PDFs are kept this long, then purged (expires_at). */
export const CAROUSEL_PDF_TTL_DAYS = 7;

/** Media of a marketplace workspace is purged this long after upload. */
export const MEDIA_RETENTION_DAYS = 45;

/** An account not seen for this long is dormant: its scheduled posts are cancelled. */
export const DORMANT_AFTER_DAYS = 40;

/** Default for MKT_TRIAL_X_DAILY_USD: what every X trial together may cost a day. */
export const TRIAL_X_DAILY_USD_DEFAULT = 3;

/**
 * Networks the Social Scheduler sells (MKT_SOCIAL_PROVIDERS overrides it,
 * within the networks the app has). Each one connects through a plain OAuth
 * link the subscriber opens. Not here on purpose:
 *  - LinkedIn Pages: waiting on LinkedIn's Community Management API review;
 *  - Bluesky, Telegram and every network that asks for credentials, a bot
 *    chat or an instance URL instead of an OAuth link: the subscriber has no
 *    Hookpost screen to type them into.
 * Discord posts through Hookpost's one bot, which is in every server that
 * added it: the gateway and DiscordProvider both refuse a settings.channel
 * outside the channel's own server (DiscordProvider.channelInServer).
 */
export const DEFAULT_SOCIAL_PROVIDERS: readonly string[] = [
  'x',
  'linkedin',
  'threads',
  'facebook',
  'instagram',
  'youtube',
  'pinterest',
  'tiktok',
  'discord',
  'slack',
];

export interface MarketplacePlan {
  product: MarketplaceProduct;
  /** The id the plan token maps to (MKT_PLAN_TOKEN_HASHES). */
  plan: string;
  /** Shown to the subscriber in /usage. */
  name: string;
  /** Monthly price in USD; 0 for the free trial. */
  priceUsd: number;
  /** api.market's 7-day free trial with a hard limit. */
  trial: boolean;
  /** Credits the plan sells per api.market month (the whole trial for a trial). */
  credits: number;
  /** Connected channels at most (0: the product connects none). */
  channels: number;
  /** Stored media at most. */
  storageBytes: number;
  /** May post to X at all. */
  allowX: boolean;
  /** May post an X tweet with a link (link_policy "allow"). */
  allowXLinks: boolean;
  /** Tweets in one thread at most. */
  threadCap: number;
  /** How far ahead a post may be scheduled. */
  scheduleHorizonDays: number;
  /** YouTube uploads per publish day for this subscriber. */
  youtubePerDay: number;
  /** The Subscription row's tier. */
  tier: 'STANDARD' | 'PRO';
}

const plan = (p: MarketplacePlan) => p;

/**
 * Every plan, keyed `<product>:<plan>`. Prices are the owner's to change;
 * the spec re-checks profit on every edit.
 */
export const MARKETPLACE_PLANS: Readonly<Record<string, MarketplacePlan>> = {
  // 1. Hookpost Social Scheduler API (all networks).
  // The trial is for testing, not free use (owner, 26 Oct 2026): 10 credits
  // and 1 channel. It was 100 credits, 2 channels and 250 MB until then
  // (PRIOR_PLAN_LIMITS). api.market's "Free" and "Free trial" plans, and
  // RapidAPI's BASIC, are this plan; "Tester" is Pro.
  'social:trial': plan({
    product: 'social',
    plan: 'trial',
    name: 'Social Scheduler trial',
    priceUsd: 0,
    trial: true,
    credits: 10,
    channels: 1,
    storageBytes: 50 * MB,
    allowX: false,
    allowXLinks: false,
    threadCap: 5,
    scheduleHorizonDays: 7,
    youtubePerDay: 1,
    tier: 'STANDARD',
  }),
  'social:standard': plan({
    product: 'social',
    plan: 'standard',
    name: 'Social Scheduler Standard',
    priceUsd: 19,
    trial: false,
    credits: 500,
    channels: 5,
    storageBytes: 2 * GB,
    allowX: true,
    allowXLinks: true,
    threadCap: 25,
    scheduleHorizonDays: 35,
    youtubePerDay: 3,
    tier: 'STANDARD',
  }),
  'social:pro': plan({
    product: 'social',
    plan: 'pro',
    name: 'Social Scheduler Pro',
    priceUsd: 39,
    trial: false,
    credits: 1200,
    channels: 20,
    storageBytes: 10 * GB,
    allowX: true,
    allowXLinks: true,
    threadCap: 25,
    scheduleHorizonDays: 35,
    youtubePerDay: 3,
    tier: 'PRO',
  }),

  // 2. LinkedIn Carousel & Post API (personal profiles).
  'linkedin:trial': plan({
    product: 'linkedin',
    plan: 'trial',
    name: 'LinkedIn Carousel trial',
    priceUsd: 0,
    trial: true,
    credits: 50,
    channels: 1,
    storageBytes: 250 * MB,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 7,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'linkedin:creator': plan({
    product: 'linkedin',
    plan: 'creator',
    name: 'LinkedIn Carousel Creator',
    priceUsd: 9,
    trial: false,
    credits: 300,
    channels: 2,
    storageBytes: 2 * GB,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 35,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'linkedin:agency': plan({
    product: 'linkedin',
    plan: 'agency',
    name: 'LinkedIn Carousel Agency',
    priceUsd: 29,
    trial: false,
    credits: 1500,
    channels: 10,
    storageBytes: 10 * GB,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 35,
    youtubePerDay: 0,
    tier: 'PRO',
  }),

  // 3. X Thread API.
  'x:trial': plan({
    product: 'x',
    plan: 'trial',
    name: 'X Thread trial',
    priceUsd: 0,
    trial: true,
    // 25 tweets at 2 credits each.
    credits: 50,
    channels: 1,
    storageBytes: 250 * MB,
    allowX: true,
    allowXLinks: false,
    threadCap: 5,
    scheduleHorizonDays: 7,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'x:basic': plan({
    product: 'x',
    plan: 'basic',
    name: 'X Thread Basic',
    priceUsd: 12,
    trial: false,
    credits: 300,
    channels: 2,
    storageBytes: 2 * GB,
    allowX: true,
    allowXLinks: true,
    threadCap: 25,
    scheduleHorizonDays: 35,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'x:pro': plan({
    product: 'x',
    plan: 'pro',
    name: 'X Thread Pro',
    priceUsd: 35,
    trial: false,
    credits: 1000,
    channels: 5,
    storageBytes: 10 * GB,
    allowX: true,
    allowXLinks: true,
    threadCap: 25,
    scheduleHorizonDays: 35,
    youtubePerDay: 0,
    tier: 'PRO',
  }),

  // 4. Social Post Validator API (no channels, no per-call cost).
  'validate:trial': plan({
    product: 'validate',
    plan: 'trial',
    name: 'Post Validator trial',
    priceUsd: 0,
    trial: true,
    credits: 200,
    channels: 0,
    storageBytes: 0,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 0,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'validate:starter': plan({
    product: 'validate',
    plan: 'starter',
    name: 'Post Validator Starter',
    priceUsd: 5,
    trial: false,
    credits: 5000,
    channels: 0,
    storageBytes: 0,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 0,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
  'validate:scale': plan({
    product: 'validate',
    plan: 'scale',
    name: 'Post Validator Scale',
    priceUsd: 15,
    trial: false,
    credits: 30000,
    channels: 0,
    storageBytes: 0,
    allowX: false,
    allowXLinks: false,
    threadCap: 1,
    scheduleHorizonDays: 0,
    youtubePerDay: 0,
    tier: 'STANDARD',
  }),
};

export function marketplacePlan(
  product: string,
  planId: string
): MarketplacePlan | null {
  return MARKETPLACE_PLANS[`${product}:${planId}`] ?? null;
}

export function plansOf(product: MarketplaceProduct): MarketplacePlan[] {
  return Object.values(MARKETPLACE_PLANS).filter((p) => p.product === product);
}

/** The limits PRIOR_PLAN_LIMITS can hold back for the rest of a window. */
export type WindowLimits = Pick<MarketplacePlan, 'credits' | 'channels' | 'storageBytes'>;

/**
 * Limits a plan had before the owner lowered them, keyed like
 * MARKETPLACE_PLANS. An account whose current quota window began before
 * `until` keeps them to the end of that window, so a change never takes away
 * a connected channel or credits mid-window; its next window has the plan's
 * limits. A trial lasts 7 days, inside one 28-day window, so a trial that had
 * started keeps its old limits to its end.
 */
export const PRIOR_PLAN_LIMITS: Readonly<
  Record<string, { until: Date; limits: WindowLimits }>
> = {
  // Owner, 26 Oct 2026: the Social trial went from 100 credits, 2 channels
  // and 250 MB to 10 credits, 1 channel and 50 MB.
  'social:trial': {
    until: new Date('2026-10-26T09:00:00Z'),
    limits: { credits: 100, channels: 2, storageBytes: 250 * MB },
  },
};

/**
 * The plan as it applies to an account in the window `now` falls in: its
 * limits, or PRIOR_PLAN_LIMITS for a window that began before they changed.
 * Everything but credits, channels and storage is the plan's own.
 */
export function planForWindow(p: MarketplacePlan, periodStart: Date, now: Date): MarketplacePlan {
  const prior = PRIOR_PLAN_LIMITS[`${p.product}:${p.plan}`];
  if (!prior) return p;
  return quotaWindow(periodStart, now).start.getTime() < prior.until.getTime()
    ? { ...p, ...prior.limits }
    : p;
}

/**
 * The 28-day quota window `now` falls in, counted from the account's
 * periodStart (which a plan change resets). Its counter is keyed by
 * periodStart and index (ledgerKeys.quota), so a new plan starts at 0.
 */
export function quotaWindow(periodStart: Date, now: Date) {
  const length = QUOTA_WINDOW_DAYS * 86_400_000;
  const start = periodStart.getTime();
  const index = Math.max(0, Math.floor((now.getTime() - start) / length));
  return {
    index,
    start: new Date(start + index * length),
    end: new Date(start + (index + 1) * length),
  };
}

/** The plan's refusal point as a multiple of its credits: 2x paid, 1.2x a trial. */
export function capMultiplier(p: MarketplacePlan): number {
  return p.trial ? TRIAL_CAP_MULTIPLIER : PAID_CAP_MULTIPLIER;
}

/** Our own refusal point in one window. */
export function hardCreditCap(p: MarketplacePlan): number {
  return Math.floor(p.credits * capMultiplier(p));
}

/**
 * Past this in one window the account is logged once, while the call still
 * goes ahead. Null for a trial, whose cap is already 1.2x.
 */
export function alertCreditThreshold(p: MarketplacePlan): number | null {
  const at = Math.floor(p.credits * ALERT_MULTIPLIER);
  return at < hardCreditCap(p) ? at : null;
}

/**
 * The most credits our cap lets through in an average month, with every
 * window used up to its cap: 2x the credits per 28 days is 2.17x a month. A
 * trial lasts 7 days, inside one window.
 */
export function worstCaseMonthlyCredits(p: MarketplacePlan): number {
  if (p.trial) return hardCreditCap(p);
  return (hardCreditCap(p) * AVERAGE_MONTH_DAYS) / QUOTA_WINDOW_DAYS;
}

/**
 * What one credit can cost Hookpost at worst on this plan: the dearer of a
 * plain X post and one with a link for a plan with X links, a plain X post
 * for one with X but no links, and next to nothing otherwise (a carousel
 * render is a second of CPU).
 */
export function worstCaseUsdPerCredit(p: MarketplacePlan): number {
  const plain = X_COST_USD.tweet / CREDIT_COST.xTweet;
  if (p.allowX && p.allowXLinks) {
    return Math.max(plain, X_COST_USD.tweetWithLink / CREDIT_COST.xTweetWithLink);
  }
  if (p.allowX) return plain;
  return p.product === 'linkedin' ? 0.001 : 0.0001;
}

/** Worst-case cost of a month, with `credits` used (default: our cap in every window). */
export function worstCaseCostUsd(
  p: MarketplacePlan,
  credits = worstCaseMonthlyCredits(p)
): number {
  return credits * worstCaseUsdPerCredit(p);
}

/** What api.market pays out for one month of the plan. */
export function netRevenueUsd(p: MarketplacePlan, fee = MARKETPLACE_FEE): number {
  return p.priceUsd * (1 - fee);
}

/**
 * A month's net revenue minus its worst-case cost (our cap used in every
 * window). Must stay above 0 for every paid plan.
 */
export function worstCaseProfitUsd(
  p: MarketplacePlan,
  fee = MARKETPLACE_FEE,
  credits = worstCaseMonthlyCredits(p)
): number {
  return netRevenueUsd(p, fee) - worstCaseCostUsd(p, credits);
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

type Env = Record<string, string | undefined>;

const list = (value?: string) =>
  (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** MKT_DISABLED_PRODUCTS: products switched off (kill switch), e.g. "x,social". */
export function disabledProducts(env: Env = process.env): Set<string> {
  return new Set(list(env.MKT_DISABLED_PRODUCTS).map((s) => s.toLowerCase()));
}

/** The networks a product may connect and post to. */
export function productProviders(
  product: MarketplaceProduct,
  env: Env = process.env
): string[] {
  if (product === 'linkedin') return ['linkedin'];
  if (product === 'x') return ['x'];
  if (product === 'validate') return [];
  const configured = list(env.MKT_SOCIAL_PROVIDERS).map((s) => s.toLowerCase());
  return configured.length ? configured : [...DEFAULT_SOCIAL_PROVIDERS];
}

/** MKT_TRIAL_X_DAILY_USD, or the default when empty or not a positive number. */
export function trialXDailyBudgetUsd(env: Env = process.env): number {
  const raw = (env.MKT_TRIAL_X_DAILY_USD || '').trim();
  if (!raw) return TRIAL_X_DAILY_USD_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : TRIAL_X_DAILY_USD_DEFAULT;
}

// ---------------------------------------------------------------------------
// The publish-time re-check (orchestrator)
// ---------------------------------------------------------------------------

export interface MarketplaceAccountFacts {
  product: string;
  plan: string;
  status: string;
}

const isXProvider = (provider?: string) => provider === 'x' || provider === 'twitter';

/**
 * Why a marketplace workspace may not publish to `provider` now, or null when
 * it may. Read by SubscriptionService.publishWithinPlan before every publish
 * and reply, so a post that reached the orchestrator some other way than the
 * gateway (a re-queue, a repeat) is held to the same plan.
 */
export function marketplacePublishRefusal(
  account: MarketplaceAccountFacts,
  provider: string | undefined,
  env: Env = process.env
): string | null {
  if (account.status === 'BLOCKED') {
    return 'This api.market subscription is blocked. Contact support@hookstep.in.';
  }
  if (disabledProducts(env).has(account.product)) {
    return 'This api.market product is paused. Nothing was published.';
  }
  const p = marketplacePlan(account.product, account.plan);
  if (!p) {
    return 'This api.market plan is not known. Nothing was published.';
  }
  if (!provider) return null;
  if (isXProvider(provider) && !p.allowX) {
    return 'Your api.market plan does not include X. Nothing was published.';
  }
  const allowed = productProviders(p.product, env);
  if (!allowed.includes(isXProvider(provider) ? 'x' : provider)) {
    return `Your api.market product does not post to ${provider}. Nothing was published.`;
  }
  return null;
}
