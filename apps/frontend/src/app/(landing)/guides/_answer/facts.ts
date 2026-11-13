/**
 * Facts the answer pages share, each read from the code that enforces it so a
 * page can never quote a different number:
 *
 * - Prices and limits: pricing.ts through usd-offer.ts (planPrice prints
 *   "$7 a month (₹599 in India)" once dollars are sold, "₹599 a month"
 *   while only rupees are) and trial-offer.ts (Free plan or trial copy).
 *   Only Hookpost is sold (MARKETED_TIERS); Standard, Pro, Team and Ultimate
 *   keep their limits for old subscribers and are never quoted here.
 * - The API key and MCP: public_api is false on FREE, true on HOOKPOST.
 * - Networks: channel-specs.ts (what can be connected and its limits) and
 *   published-networks.ts (what actually published from production).
 * - MCP setup: mcp/mcp-setup.ts, shared with /mcp and the Claude guides.
 *   Re-read on 26 Oct 2026: Codex (learn.chatgpt.com/docs/extend/mcp:
 *   [mcp_servers.<name>], url, bearer_token_env_var; codex mcp list, /mcp in
 *   the TUI), Gemini CLI (geminicli.com/docs/tools/mcp-server: httpUrl is
 *   Streamable HTTP, url is SSE; gemini mcp add --transport http --header;
 *   /mcp), Cursor (cursor.com/docs/context/mcp: .cursor/mcp.json or
 *   ~/.cursor/mcp.json, url + headers, ${env:NAME} in url and headers; MCP Logs
 *   in the Output panel).
 */
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, NO_TIME_TRIAL, offer, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, planPriceInParens } from '../../usd-offer';
import { CHANNEL_SPECS } from '../../channels/channel-specs';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { PUBLISHED_CHECKED, publishedList } from '../../channels/published-networks';
import { MCP_URL } from '../../mcp/mcp-setup';

export const BRAND = 'Hookpost by Hookstep';

export const { HOOKPOST } = pricingINR;

/** "$7 a month (₹599 in India)" or "₹599 a month". */
export const HOOKPOST_MONTH = planPrice('HOOKPOST', ' a month');
/** For a figure already in brackets: "$7 a month, ₹599 in India". */
export const HOOKPOST_MONTH_IN_PARENS = planPriceInParens('HOOKPOST', ' a month');

/** Which plan includes the API key, MCP server and CLI. */
export const PLAN_ACCESS = `The API key, and with it the MCP server, comes with the Hookpost plan (${HOOKPOST_MONTH_IN_PARENS}: ${HOOKPOST.channel} channels, ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month, up to ${HOOKPOST.team_member_limit} team members).${offer(
  ' The Free plan has no API key, so it cannot connect.',
  ` New workspaces get ${FREE_POSTS} with no card${NO_TIME_TRIAL}, so the key needs one of those plans.`
)}`;

/** The free-posts terms, or the Free plan, for "can I try it" answers. */
export const TRY_IT = offer(
  `Yes, on the Free plan, but it has no API key: the MCP server, API and CLI need the Hookpost plan.`,
  `Yes. ${TRIAL_SENTENCE}`
);

export const PUBLISHABLE = PUBLISHABLE_CHANNEL_COUNT;
export { PUBLISHED_CHECKED, publishedList, CHANNEL_SPECS, MCP_URL };

/** Where the key lives in the app. */
export const KEY_WHERE = 'Settings → Developers → Reveal → Copy';

/** Said on every page that lists what an agent can do. */
export const NOT_SUPPORTED_NETWORKS =
  'LinkedIn Company Pages, Reddit and Mastodon are not supported; Medium stopped issuing new API tokens, so Hookpost does not connect Medium.';

/**
 * The three terminal agents side by side, for the CLI guides. Every cell is
 * from mcp-setup.ts or the client's own docs (see the header).
 */
export const CLI_AGENTS: readonly (readonly string[])[] = [
  [
    'Claude Code',
    'claude mcp add --transport http … --header',
    '~/.claude.json, or .mcp.json with --scope project',
    'Authorization header (or ${VAR} in .mcp.json)',
    'claude mcp list',
  ],
  [
    'Codex CLI',
    'Edit config.toml',
    '~/.codex/config.toml, table [mcp_servers.hookpost]',
    'bearer_token_env_var reads it from an environment variable',
    'codex mcp list, or /mcp inside codex',
  ],
  [
    'Gemini CLI',
    'gemini mcp add --transport http … --header',
    '~/.gemini/settings.json, or .gemini/settings.json in a project',
    'headers, with httpUrl (url means SSE)',
    'gemini mcp list, or /mcp inside gemini',
  ],
];
export const CLI_AGENTS_HEAD = ['Agent', 'Add the server', 'Config file', 'How the key is sent', 'Check it'] as const;
