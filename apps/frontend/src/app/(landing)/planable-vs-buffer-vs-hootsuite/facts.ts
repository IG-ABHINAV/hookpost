/**
 * Planable, Buffer and Hootsuite as their own public pages describe them, for
 * /planable-vs-buffer-vs-hootsuite.
 *
 * Why these live here and not in compare/competitor-facts.ts: that file's
 * FACTS_CHECKED means "all twelve vendors read on one day", and Planable is
 * not one of the twelve. Adding a thirteenth with a different date would make
 * that promise untrue. These three were read on CHECKED, below, and every
 * figure is quoted from the page in `source`. A value nobody could read off a
 * public page is absent rather than guessed - there is no "unknown" string
 * here that a reader might mistake for a fact.
 *
 * Re-read all three pages before bumping CHECKED. Hootsuite renders its prices
 * client-side; the figures below come from the JSON-LD and the copy in the
 * page's own HTML ("Plans start at $99/user/month, billed annually", and
 * price 99.00 / 199.00 / 399.00 USD in its Product offers), which is why that
 * row says where it was read.
 */

export const CHECKED = '28 October 2026';

export interface ThreeWayVendor {
  name: string;
  /** The pricing unit, in the vendor's own words. */
  model: string;
  free: string;
  entry: string;
  mid: string;
  /** Networks the vendor lists on its own site. */
  networks: string;
  /** What the vendor says an AI agent can do, in its own words where quoted. */
  aiAgents: string;
  source: string;
  extraSources?: readonly string[];
}

export const VENDORS: readonly ThreeWayVendor[] = [
  {
    name: 'Planable',
    model: 'per workspace, per month. Planable recommends one workspace per brand or client.',
    free:
      'Planable has no free plan; its free trial is 50 created posts, with no time limit and no card needed, and those 50 do not reset monthly. X (Twitter) publishing is not available during a Planable trial.',
    entry:
      'Basic $33 per workspace per month: 60 posts per workspace a month, 4 social pages per workspace, unlimited users, 3 campaigns, 10 GB media. One tweet published per 24 hours.',
    mid:
      'Pro $49 per workspace per month: 150 posts per workspace a month, 10 social pages per workspace, unlimited users, 10 campaigns, 50 GB media, and the public API. Enterprise is custom-priced with unlimited posts and 50 pages per workspace.',
    networks:
      'Nine: Facebook, Instagram, LinkedIn, X (Twitter), TikTok, YouTube, Pinterest, Threads and Google Business Profile.',
    aiAgents:
      'An MCP Connector on every paid plan, to "connect your AI assistant to Planable to create and manage content across all your workspaces". The public API starts on Pro.',
    source: 'https://planable.io/pricing',
  },
  {
    name: 'Buffer',
    model: 'per channel, per month. A channel is one connected account.',
    free:
      'Buffer has a free plan with up to 3 channels and 10 scheduled posts per channel, refilling as posts publish, plus 100 ideas, one user, the AI Assistant, Insights and API access (one key, 1,000 requests per channel a month). Buffer MCP is on it too: buffer.com/mcp says "MCP access is included on every plan, including Free".',
    entry:
      'Essentials $5 per channel per month, $60 a year per channel (Buffer calls that two months free): unlimited scheduled posts per channel, one user, three API keys, hashtag manager, first-comment scheduling. Buffer gives a 14-day free trial on it.',
    mid:
      'Team $10 per channel per month, $120 a year per channel: unlimited team members, access levels, content approval workflows, five API keys.',
    networks:
      'Twelve: Instagram, Facebook, TikTok, LinkedIn, X (Twitter), YouTube, Threads, Pinterest, Google Business Profile, Bluesky, Mastodon and Substack.',
    aiAgents:
      'Buffer MCP, set up from Settings then Integrations, to "draft posts, schedule them, and check what\u2019s coming up right in Claude, ChatGPT, or the other tools you\u2019re already in". Buffer says it is "included on every plan, including Free", and that what an assistant makes "lands in your Buffer queue as drafts or scheduled posts" for review. Buffer also publishes a machine-readable pricing page for AI agents.',
    source: 'https://buffer.com/pricing',
    extraSources: ['https://buffer.com/mcp'],
  },
  {
    name: 'Hootsuite',
    model: 'per user, per month, billed annually.',
    free:
      'Hootsuite has no free plan, and its 14-day trial needs no credit card; a Hootsuite trial account is limited to 10-20 posts per organisation a day and cannot bulk schedule.',
    entry:
      'Standard $99 per user per month, billed annually, for up to 10 social accounts, with as many user seats as you buy.',
    mid:
      'Professional $199 per user per month for unlimited social accounts and inbox automation; Advanced $399 per user per month adds team approvals and message routing; Enterprise is custom-priced.',
    networks:
      'Hootsuite prices by the number of social accounts rather than by naming a list on its plans page, so no count is quoted here.',
    aiAgents:
      'Wisdom, which Hootsuite says runs on "every plan", listed in its feature table as "In-app assistant and MCP connectors".',
    source: 'https://www.hootsuite.com/plans',
  },
];

/**
 * The same three plans priced for one person who posts to ten accounts, which
 * is where three different pricing units stop being comparable in the
 * abstract. Each figure is arithmetic on the row above it, shown so it can be
 * checked. Hookpost's own figure is read from pricing.ts by the page.
 */
export interface TenChannelCost {
  name: string;
  plan: string;
  /** The sum, written out. */
  working: string;
  /** What it comes to a month, as the vendor bills it. */
  monthly: string;
}

export const TEN_CHANNELS: readonly TenChannelCost[] = [
  {
    name: 'Planable',
    plan: 'Pro, one workspace',
    working: '10 social pages is exactly Pro’s per-workspace allowance, so one workspace covers it - if all ten pages belong to one brand.',
    monthly: '$49 a month',
  },
  {
    name: 'Buffer',
    plan: 'Essentials, 10 channels',
    working: '10 channels × $5 per channel a month, billed yearly ($600 a year).',
    monthly: '$50 a month',
  },
  {
    name: 'Hootsuite',
    plan: 'Standard, 1 seat',
    working: 'One seat at $99 a month billed annually covers up to 10 social accounts.',
    monthly: '$99 a month',
  },
];
