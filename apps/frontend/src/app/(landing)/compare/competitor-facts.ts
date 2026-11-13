// Verified facts on third-party social media tools, for the /compare pages.
//
// Every value was read off the vendor's own pricing page (or GitHub API for
// open-source licences) on FACTS_CHECKED; the URLs are in `sources` and are
// printed on each page. null means the vendor does not state it - never fill
// one from memory. Prices are what an Indian visitor is NOT necessarily shown:
// several vendors (Hootsuite, Zoho, Publer, SocialPilot) localise to INR by IP,
// which is what `inr` records. None of the twelve mention UPI.
//
// Re-check every vendor before bumping FACTS_CHECKED.
//
// A vendor whose entry price alone was read again later says so in
// cheapestPaidChecked, so FACTS_CHECKED keeps meaning one read of all twelve.
// On 21 October 2026 hootsuite.com/plans and sproutsocial.com/pricing were
// re-read for the 20 Oct ad kit (hookpost-ad-2026-10-20/README.md): both
// unchanged, Hootsuite $99 per user a month and Sprout Social $79 per seat a
// month, billed annually. The 24 Oct homepage demo video's price footnote
// said "checked 21 Oct 2026" on the strength of that read (that cut was
// replaced on 25 Oct by one that names no competitor).

export const FACTS_CHECKED = '26 September 2026';

export interface CompetitorFacts {
  slug: string;
  name: string;
  freePlan: string | null;
  freeTrialDays: number | null;
  cheapestPaid: {
    name: string | null;
    price: number;
    currency: string;
    per: string;
    billing: 'annual' | 'monthly' | 'one-time';
    /** Entry price in USD per month, only when directly comparable. */
    usdMonthly: number | null;
    /** Channels the cheapest plan includes, when the vendor states a number. */
    channelsIncluded: number | null;
  } | null;
  /** A later read of cheapestPaid than FACTS_CHECKED that found it unchanged. */
  cheapestPaidChecked?: string | null;
  pricingModel: string | null;
  api: boolean | null;
  mcp: boolean | null;
  openSource: string | null;
  inr: boolean | null;
  networks: string[];
  sources: string[];
  hasAlternativePage: boolean;
  /** UPI named as a payment method on the vendor's own pricing page. */
  upi?: boolean | null;
  /** A rupee price we have actually seen, with what it buys. */
  inrEntry?: string | null;
  /** When inrEntry was read, and from where (it can differ by country). */
  inrChecked?: string | null;
  /** How UPI is offered, as the vendor words it (only when upi is true). */
  upiNote?: string | null;
  /** The same rupee entry as numbers, so pages can do arithmetic on it. */
  inrPlan?: InrPlan | null;
}

/**
 * A vendor price as printed: thousands separators in the vendor's currency
 * style (₹2,000 not ₹2000, $1,200 not $1200), decimals kept as the vendor
 * shows them. Every price helper on /compare, /alternatives, the India list and
 * the MCP roundup goes through this, so none of them prints a bare 2000.
 */
export const priceAmount = (p: { price: number; currency: string }): string =>
  p.price.toLocaleString(p.currency === 'INR' ? 'en-IN' : 'en-US', {
    // $25.50, not $25.5: a price with cents always shows two decimals.
    minimumFractionDigits: Number.isInteger(p.price) ? 0 : 2,
    maximumFractionDigits: 2,
  });

export interface InrPlan {
  name: string;
  /** Rupees a month when billed monthly; null when only a yearly rate is shown. */
  monthly: number | null;
  /** Rupees a month when billed yearly; null when not shown. */
  yearlyPerMonth: number | null;
  per: 'month' | 'account/month' | 'user/month';
  /** Channels (accounts) the price covers: per unit for per-account plans. */
  channels: number | null;
  seats: number | null;
}


export const COMPETITOR_FACTS: Record<string, CompetitorFacts> = {
  "buffer": {
    "slug": "buffer",
    "name": "Buffer",
    "freePlan": "3 channels, 10 scheduled posts per channel (refills as posts publish)",
    "freeTrialDays": 14,
    "cheapestPaid": {
      "name": "Essentials",
      "price": 5,
      "currency": "USD",
      "per": "channel/month",
      "billing": "annual",
      "usdMonthly": 5.0,
      "channelsIncluded": 1
    },
    "pricingModel": "per channel",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": false,
    "networks": ["Bluesky", "Facebook", "Google Business Profile", "Instagram", "LinkedIn", "Mastodon", "Pinterest", "Substack", "Threads", "TikTok", "X", "YouTube"],
    "sources": [
      "https://buffer.com/pricing",
      "https://buffer.com/mcp"
    ],
    "hasAlternativePage": true
  },
  "hootsuite": {
    "slug": "hootsuite",
    "name": "Hootsuite",
    "freePlan": null,
    "freeTrialDays": 14,
    "cheapestPaid": {
      "name": "Standard",
      "price": 99,
      "currency": "USD",
      "per": "user/month",
      "billing": "annual",
      "usdMonthly": 99.0,
      "channelsIncluded": 10
    },
    "cheapestPaidChecked": "21 October 2026",
    "pricingModel": "per user",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": true,
    "inrEntry": "₹1,999 per user per month, billed annually, for up to 10 accounts (Standard), before tax",
    "inrChecked": "11 October 2026, from India",
    "inrPlan": { name: 'Standard', monthly: null, yearlyPerMonth: 1999, per: 'user/month', channels: 10, seats: 1 },
    "networks": ["Facebook", "Instagram", "LinkedIn", "Threads", "X", "TikTok", "Bluesky", "YouTube", "Pinterest", "WhatsApp", "Google Business Profile"],
    "sources": [
      "https://www.hootsuite.com/plans",
      "https://www.hootsuite.com/integrations/mcp",
      "https://developer.hootsuite.com/docs/using-rest-apis",
      "https://help.hootsuite.com/hc/en-us/articles/204585410-Add-social-networks"
    ],
    "hasAlternativePage": true
  },
  "later": {
    "slug": "later",
    "name": "Later",
    "freePlan": null,
    "freeTrialDays": 14,
    "cheapestPaid": {
      "name": "Starter",
      "price": 18.75,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 18.75,
      "channelsIncluded": 8
    },
    "pricingModel": "flat tiers",
    "api": null,
    "mcp": null,
    "openSource": null,
    "inr": false,
    "networks": ["Instagram", "Facebook", "TikTok", "Pinterest", "LinkedIn", "YouTube", "Threads", "Snapchat"],
    "sources": [
      "https://later.com/pricing/"
    ],
    "hasAlternativePage": true
  },
  "sprout-social": {
    "slug": "sprout-social",
    "name": "Sprout Social",
    "freePlan": null,
    "freeTrialDays": 30,
    "cheapestPaid": {
      "name": "Essentials",
      "price": 79,
      "currency": "USD",
      "per": "user/month",
      "billing": "annual",
      "usdMonthly": 79.0,
      "channelsIncluded": 5
    },
    "cheapestPaidChecked": "21 October 2026",
    "pricingModel": "per user",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": false,
    "networks": ["Facebook", "X", "Instagram", "LinkedIn", "Threads", "Pinterest", "TikTok"],
    "sources": [
      "https://sproutsocial.com/pricing/",
      "https://support.sproutsocial.com/hc/en-us/articles/41236268336653-ChatGPT-Connection-Overview-and-Setup"
    ],
    "hasAlternativePage": true
  },
  "metricool": {
    "slug": "metricool",
    "name": "Metricool",
    "freePlan": "1 brand (all networks except LinkedIn and Twitter/X), 20 posts per month",
    "freeTrialDays": null,
    "cheapestPaid": {
      "name": "Starter",
      "price": 20,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 20.0,
      "channelsIncluded": null
    },
    "pricingModel": "flat tiers",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": false,
    "networks": ["Instagram", "Facebook", "Threads", "TikTok", "YouTube", "Twitch", "LinkedIn", "Pinterest", "Bluesky", "Google Business Profile", "Twitter/X (add-on)", "Web/Blog"],
    "sources": [
      "https://metricool.com/pricing/"
    ],
    "hasAlternativePage": true
  },
  "publer": {
    "slug": "publer",
    "name": "Publer",
    "freePlan": "3 channels, 10 scheduled posts per account",
    "freeTrialDays": 7,
    "cheapestPaid": {
      "name": "Professional",
      "price": 4,
      "currency": "USD",
      "per": "channel/month",
      "billing": "annual",
      "usdMonthly": 4.0,
      "channelsIncluded": 1
    },
    "pricingModel": "per channel",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": true,
    "inrEntry": "₹484.15 a month per social account on Professional (₹387.32 a month billed yearly)",
    "inrChecked": "11 October 2026, from India",
    "inrPlan": { name: 'Professional', monthly: 484.15, yearlyPerMonth: 387.32, per: 'account/month', channels: 1, seats: 1 },
    "networks": ["Facebook", "Instagram", "X", "LinkedIn", "Pinterest", "TikTok", "YouTube", "Google Business Profile", "Threads", "Bluesky", "Mastodon", "Telegram", "WordPress"],
    "sources": [
      "https://publer.com/plans"
    ],
    "hasAlternativePage": true
  },
  "socialpilot": {
    "slug": "socialpilot",
    "name": "SocialPilot",
    "freePlan": null,
    "freeTrialDays": 14,
    "cheapestPaid": {
      "name": "Essentials",
      "price": 25.5,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 25.5,
      "channelsIncluded": 7
    },
    "pricingModel": "flat tiers",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": true,
    "inrEntry": "₹2,000 a month (₹1,700 billed yearly) for 10 accounts and 1 user on Standard, the cheapest plan shown in India",
    "inrChecked": "11 October 2026, from India",
    "inrPlan": { name: 'Standard', monthly: 2000, yearlyPerMonth: 1700, per: 'month', channels: 10, seats: 1 },
    "networks": ["Facebook", "Instagram", "LinkedIn", "X", "Threads", "TikTok", "Pinterest", "YouTube", "Google Business Profile", "Bluesky"],
    "sources": [
      "https://www.socialpilot.co/plans",
      "https://www.socialpilot.co/socialpilot-pricing.md"
    ],
    "hasAlternativePage": true
  },
  "agorapulse": {
    "slug": "agorapulse",
    "name": "Agorapulse",
    "freePlan": null,
    "freeTrialDays": 30,
    "cheapestPaid": {
      "name": "Standard",
      "price": 79,
      "currency": "USD",
      "per": "user/month",
      "billing": "annual",
      "usdMonthly": 79.0,
      "channelsIncluded": 10
    },
    "pricingModel": "per user",
    "api": true,
    "mcp": true,
    "openSource": null,
    "inr": false,
    "networks": ["Facebook", "Instagram", "LinkedIn", "TikTok", "X", "YouTube", "Threads", "Pinterest", "Bluesky", "Google Business Profile"],
    "sources": [
      "https://www.agorapulse.com/pricing/"
    ],
    "hasAlternativePage": true
  },
  "postiz": {
    "slug": "postiz",
    "name": "Postiz",
    "freePlan": null,
    "freeTrialDays": 7,
    "cheapestPaid": {
      "name": "Standard",
      "price": 23,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 23.0,
      "channelsIncluded": 5
    },
    "pricingModel": "flat tiers",
    "api": true,
    "mcp": true,
    "openSource": "AGPL-3.0",
    "inr": false,
    "networks": ["Facebook", "Instagram", "Threads", "LinkedIn", "Bluesky", "X", "TikTok", "YouTube", "Google Business Profile", "Reddit", "Telegram", "Discord", "Slack", "Pinterest", "Dribbble", "Mastodon", "Whop", "Twitch", "Skool", "Kick", "Warpcast", "VK", "Lemmy", "MeWe", "Nostr", "Listmonk", "WordPress", "Medium", "Hashnode", "Dev.to"],
    "sources": [
      "https://postiz.com/pricing",
      "https://api.github.com/repos/gitroomhq/postiz-app"
    ],
    "hasAlternativePage": true
  },
  "mixpost": {
    "slug": "mixpost",
    "name": "Mixpost",
    "freePlan": "unlimited accounts (Facebook Pages, X, Mastodon only)",
    "freeTrialDays": null,
    "cheapestPaid": {
      "name": "Pro",
      "price": 299,
      "currency": "USD",
      "per": "licence (1 domain or subdomain)",
      "billing": "one-time",
      "usdMonthly": null,
      "channelsIncluded": null
    },
    "pricingModel": "self-hosted licence",
    "api": true,
    "mcp": true,
    "openSource": "MIT (Mixpost Lite only; Pro/Enterprise source is delivered but redistribution is prohibited)",
    "inr": false,
    "networks": ["Facebook Pages", "Instagram", "X", "LinkedIn", "YouTube", "TikTok", "Pinterest", "Threads", "Bluesky", "Google Business Profile", "Mastodon", "Pixelfed"],
    "sources": [
      "https://mixpost.app/pricing",
      "https://api.github.com/repos/inovector/mixpost"
    ],
    "hasAlternativePage": true
  },
  "zoho-social": {
    "slug": "zoho-social",
    "name": "Zoho Social",
    "freePlan": "6 channels",
    "freeTrialDays": 15,
    "cheapestPaid": {
      "name": "Standard",
      "price": 10,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 10.0,
      "channelsIncluded": 14
    },
    "pricingModel": "flat tiers",
    "api": null,
    "mcp": true,
    "openSource": null,
    "inr": true,
    "inrEntry": "₹900 a month (₹600 billed yearly) for 13 channels and 1 team member on Standard, plus GST",
    "inrChecked": "11 October 2026, from India",
    "inrPlan": { name: 'Standard', monthly: 900, yearlyPerMonth: 600, per: 'month', channels: 13, seats: 1 },
    "networks": ["Facebook", "X", "Instagram", "LinkedIn", "YouTube", "Pinterest", "TikTok", "Mastodon", "Threads", "Bluesky", "Snapchat", "Arattai", "WhatsApp Business", "Telegram", "Google Business Profile"],
    "sources": [
      "https://www.zoho.com/social/pricing.html",
      "https://www.zoho.com/social/mcp.html"
    ],
    "hasAlternativePage": false
  },
  "sendible": {
    "slug": "sendible",
    "name": "Sendible",
    "freePlan": null,
    "freeTrialDays": 14,
    "cheapestPaid": {
      "name": "Core",
      "price": 30,
      "currency": "USD",
      "per": "month",
      "billing": "annual",
      "usdMonthly": 30.0,
      "channelsIncluded": 6
    },
    "pricingModel": "flat tiers",
    "api": true,
    "mcp": null,
    "openSource": null,
    "inr": false,
    "networks": ["Instagram", "Facebook", "TikTok", "X", "LinkedIn", "Google Business Profile", "YouTube", "WordPress", "Threads", "Bluesky"],
    "sources": [
      "https://www.sendible.com/pricing",
      "https://www.sendible.com/about"
    ],
    "hasAlternativePage": false
  }
};

// Mixpost's hosted offer. The 26 Sep Mixpost record above has none, and pages
// that read it said "no hosted plan". On MIXPOST_CLOUD.checked,
// mixpost.app/pricing said "Mixpost Cloud is the same tool you'd self-host,
// hosted by us" and mixpost.app/cloud listed Spark (the cheapest plan) at $29 a
// month or $249 a year, every plan with a 7-day free trial. The same pricing
// page still listed Pro at $299 one-time for 1 domain or subdomain. Kept apart
// from COMPETITOR_FACTS so FACTS_CHECKED keeps meaning one read of all twelve.
export const MIXPOST_CLOUD = {
  checked: '22 October 2026',
  monthly: 29,
  yearly: 249,
  trialDays: 7,
  source: 'https://mixpost.app/cloud',
} as const;

// Schedulers that rank for India queries but are not in the 12 above. Kept
// apart so the "N of the 12 tools we checked on FACTS_CHECKED" counts on the
// /alternatives pages stay true. Read off each vendor's own pricing page on
// INDIA_FACTS_CHECKED. Posttely, PostStage, RecurPost and Predis.ai were read
// from outside India; Poststack and Statusbrew from a browser in India (where
// Statusbrew still shows US dollars). Posttely, PostStage and Poststack price
// in rupees for everyone.
export const INDIA_FACTS_CHECKED = '11 October 2026';

export const INDIA_FACTS: Record<string, CompetitorFacts> = {
  posttely: {
    slug: 'posttely',
    name: 'Posttely',
    freePlan: '1 workspace, 28 scheduled posts a month',
    freeTrialDays: 30,
    cheapestPaid: { name: 'Elite', price: 299, currency: 'INR', per: 'month', billing: 'monthly', usdMonthly: null, channelsIncluded: 10 },
    pricingModel: 'flat tiers',
    api: null,
    mcp: true,
    openSource: null,
    inr: true,
    upi: false,
    inrEntry: '₹299 a month plus 18% GST for 10 channels (Elite)',
    networks: ['Instagram', 'LinkedIn', 'X', 'Facebook', 'Threads', 'Pinterest', 'Reddit', 'Bluesky', 'Mastodon', 'Google Business Profile'],
    sources: ['https://posttely.com/pricing', 'https://posttely.com/'],
    hasAlternativePage: false,
  },
  poststage: {
    slug: 'poststage',
    name: 'PostStage',
    freePlan: '1 channel, 15 posts a month, X not included',
    freeTrialDays: 14,
    cheapestPaid: { name: 'Starter', price: 499, currency: 'INR', per: 'month', billing: 'monthly', usdMonthly: null, channelsIncluded: 15 },
    pricingModel: 'flat tiers',
    api: null,
    mcp: null,
    openSource: null,
    inr: true,
    upi: true,
    upiNote: 'Yes, through Razorpay',
    inrEntry: '₹499 a month (₹399 billed yearly) for 15 channels and 60 posts per account (Starter)',
    networks: ['Instagram', 'Facebook', 'LinkedIn', 'X (paid add-on on Free)', 'YouTube', 'Threads'],
    sources: ['https://trypoststage.com/pricing'],
    hasAlternativePage: false,
  },
  recurpost: {
    slug: 'recurpost',
    name: 'RecurPost',
    freePlan: null,
    freeTrialDays: 14,
    cheapestPaid: { name: 'Starter', price: 9, currency: 'USD', per: 'month', billing: 'monthly', usdMonthly: 9, channelsIncluded: 2 },
    pricingModel: 'flat tiers',
    api: null,
    mcp: null,
    openSource: null,
    inr: false,
    upi: false,
    inrEntry: null,
    networks: [],
    sources: ['https://recurpost.com/pricing/'],
    hasAlternativePage: false,
  },
  'predis-ai': {
    slug: 'predis-ai',
    name: 'Predis.ai',
    freePlan: null,
    freeTrialDays: 3,
    cheapestPaid: { name: 'Core', price: 24, currency: 'USD', per: 'month', billing: 'annual', usdMonthly: 24, channelsIncluded: 10 },
    pricingModel: 'flat tiers',
    api: null,
    mcp: null,
    openSource: null,
    inr: false,
    upi: false,
    inrEntry: null,
    networks: [],
    sources: ['https://predis.ai/pricing/'],
    hasAlternativePage: false,
  },
  poststack: {
    slug: 'poststack',
    name: 'Poststack',
    freePlan: null,
    freeTrialDays: 15,
    cheapestPaid: { name: 'Creator', price: 2000, currency: 'INR', per: 'month', billing: 'monthly', usdMonthly: null, channelsIncluded: 3 },
    pricingModel: 'base plan plus paid extra accounts and seats',
    api: null,
    mcp: null,
    openSource: null,
    inr: true,
    upi: true,
    upiNote: 'Yes, UPI AutoPay',
    inrEntry: '₹2,000 a month plus GST for 3 accounts (Creator); ₹8,000 for 30 accounts and 4 extra seats (Agency); extra accounts ₹900 a month each',
    networks: ['Instagram', 'Facebook', 'LinkedIn', 'X', 'YouTube', 'Threads'],
    sources: ['https://poststack.ai/pricing', 'https://poststack.ai/'],
    hasAlternativePage: false,
  },
  statusbrew: {
    slug: 'statusbrew',
    name: 'Statusbrew',
    freePlan: null,
    freeTrialDays: 14,
    cheapestPaid: { name: 'Lite', price: 69, currency: 'USD', per: 'month', billing: 'annual', usdMonthly: 69, channelsIncluded: 5 },
    pricingModel: 'flat tiers',
    api: null,
    mcp: true,
    openSource: null,
    inr: false,
    upi: false,
    inrEntry: null,
    networks: [],
    sources: ['https://statusbrew.com/pricing'],
    hasAlternativePage: false,
  },
};

// Pairs worth a page. Weighted to matchups where page 1 is small blogs rather
// than the vendors themselves (keyword map, 26 Sep 2026).
export const PAIRS: string[] = ["postiz-vs-buffer", "postiz-vs-mixpost", "postiz-vs-hootsuite", "postiz-vs-publer", "mixpost-vs-buffer", "publer-vs-buffer", "metricool-vs-buffer", "metricool-vs-later", "socialpilot-vs-buffer", "zoho-social-vs-buffer", "sendible-vs-hootsuite", "publer-vs-later", "buffer-vs-hootsuite", "later-vs-buffer"];

/**
 * The /compare pairs that search engines may index.
 *
 * Every pair above compares two third-party tools; Hookpost is only a third
 * column. The audit of 11 Oct 2026 found 14 pages of ~150 unique words each with
 * 47-62% overlap between siblings, on queries (buffer vs hootsuite) that the 26
 * Sep keyword map already rated unwinnable for six months, so a block of thin
 * pages risks a scaled-content read of the whole directory.
 *
 * Search Console (hookstep.in, three months to 11 Oct 2026, average position
 * 7.1) decided which stay: the six pages with 20 or more impressions are
 * listed below and each has a computed "Where Hookpost fits" section of its own
 * (see [pair]/page.tsx). Impressions: postiz-vs-mixpost 85, metricool-vs-later
 * 51, postiz-vs-publer 48, postiz-vs-buffer 38, metricool-vs-buffer 36,
 * mixpost-vs-buffer 21. The other eight had 17 or fewer.
 *
 * 11 Oct 2026 review: postiz-vs-buffer (15% of its text unique to the page)
 * and metricool-vs-buffer (17%) were still mostly template despite their
 * impressions, so they are noindex too until each has enough of its own
 * content to stand alone. Four pairs stay indexed.
 *
 * A pair that is not listed here is served with `robots: noindex, follow` and
 * is left out of sitemap.xml; people can still reach it by link and the facts
 * on it are intact. To put another page back in search, add its slug here (the
 * same string as in PAIRS) and deploy. It is the only switch: the page and the
 * sitemap both read this list, through isIndexedPair().
 */
export const INDEXED_COMPARE_PAIRS: string[] = [
  "postiz-vs-mixpost",
  "metricool-vs-later",
  "postiz-vs-publer",
  "mixpost-vs-buffer",
];

export const isIndexedPair = (pair: string): boolean =>
  INDEXED_COMPARE_PAIRS.includes(pair);

/** Derived, for reports and checks: the pairs currently noindexed. */
export const NOINDEX_COMPARE_PAIRS: string[] = PAIRS.filter((p) => !isIndexedPair(p));

/**
 * The competitors that live only under /vs/<slug> (the other /vs slugs 301 to
 * /alternatives/<slug>, see next.config.js). vs/[competitor]/page.tsx renders
 * these; the footer and the /alternatives hub link to all of them.
 */
export const VS_SLUGS: string[] = ['zoho-social', 'sendible', 'loomly', 'tailwind', 'co-schedule', 'meet-edgar'];

/**
 * The /vs pages search engines may index: the same one switch as
 * INDEXED_COMPARE_PAIRS. The page's robots tag and sitemap.xml both read
 * isIndexedVs(); a slug left out is served `noindex, follow`, stays linked
 * from the /alternatives hub and the footer, and is left out of the sitemap
 * and the llms files.
 *
 * 11 Oct 2026 review: /vs/loomly, /vs/co-schedule and /vs/meet-edgar had 28-31%
 * of their text unique to the page and about 65% shared with their siblings,
 * which reads as doorway pages (/vs/zoho-social, for comparison, is 64%
 * unique). They are noindex until each has per-vendor facts of its own. To put
 * one back, add its slug here and deploy.
 */
export const INDEXED_VS: string[] = ['zoho-social', 'sendible', 'tailwind'];

export const isIndexedVs = (slug: string): boolean => INDEXED_VS.includes(slug);
