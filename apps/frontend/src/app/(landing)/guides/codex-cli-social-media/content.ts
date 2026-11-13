// Targets "social media scheduler Codex CLI MCP" (buyer-prompt research, 26 Oct
// 2026: PostEverywhere, PostSyncer, PostSider and Postiz-through-Composio
// rank). The config block is CODEX_TOML from mcp/mcp-setup.ts, the string /mcp
// prints. Re-read against learn.chatgpt.com/docs/extend/mcp on 26 Oct 2026:
// [mcp_servers.<name>] tables, url, bearer_token_env_var ("environment
// variable name for a bearer token to send in Authorization"), codex mcp list,
// and /mcp inside the TUI. The docs show no codex mcp add flag for a bearer
// token, so the page edits config.toml rather than printing a command.
import { CODEX_TOML, MCP_CANNOT } from '../../mcp/mcp-setup';
import { ANSWER_PAGES_UPDATED, answerUrl } from '../_answer/answer-pages';
import type { Faq, Step } from '../_answer/answer-schema';
import {
  BRAND,
  KEY_WHERE,
  NOT_SUPPORTED_NETWORKS,
  PLAN_ACCESS,
  PUBLISHABLE,
  PUBLISHED_CHECKED,
  HOOKPOST_MONTH,
  HOOKPOST_MONTH_IN_PARENS,
  TRY_IT,
  publishedList,
} from '../_answer/facts';

export const PATH = '/guides/codex-cli-social-media';
export const CANONICAL = answerUrl(PATH);
export const UPDATED = ANSWER_PAGES_UPDATED;

export const H1 = 'Schedule social media posts from OpenAI Codex CLI';

export const ANSWER = `To let OpenAI's Codex CLI schedule posts through ${BRAND}, add a three-line [mcp_servers.hookpost] table to ~/.codex/config.toml and put your Hookpost API key in the HOOKPOST_API_KEY environment variable. Codex can then list your connected channels and create draft, scheduled or immediate posts, and Hookpost publishes them at the set time with the terminal closed. The key comes with the Hookpost plan (${HOOKPOST_MONTH_IN_PARENS}).`;

export const DESCRIPTION = `Connect OpenAI Codex CLI to Hookpost's hosted MCP server with three lines of config.toml, keep the key in an environment variable, and let Codex draft and schedule posts. From ${HOOKPOST_MONTH}.`;

export { CODEX_TOML, MCP_CANNOT };

export const EXPORT_KEY = `# in ~/.zshrc or ~/.bashrc, so every new shell has it
export HOOKPOST_API_KEY="your_key"`;

export const CHECK = `codex mcp list        # hookpost should be listed
codex                 # then type /mcp to see its tools`;

export const FIRST_PROMPT = `List my Hookpost channels. Read the last 15 commits with git log and
write one LinkedIn post and one X post under 280 characters about what
shipped. Save both as Hookpost drafts for tomorrow at 10:00 IST.
Do not publish anything.`;

export const STEPS: Step[] = [
  {
    name: 'Copy your Hookpost API key',
    text: `Connect your social accounts in Hookpost, then open ${KEY_WHERE}.`,
  },
  {
    name: 'Put the key in an environment variable',
    text: 'Add export HOOKPOST_API_KEY="your_key" to your shell profile and open a new terminal. Codex reads the key from there, so it never sits in config.toml.',
  },
  {
    name: 'Add the server to config.toml',
    text: 'Add a [mcp_servers.hookpost] table to ~/.codex/config.toml with url = "https://hookpost.hookstep.in/api/mcp" and bearer_token_env_var = "HOOKPOST_API_KEY".',
  },
  {
    name: 'Check it and ask for drafts',
    text: 'Run codex mcp list, start codex and type /mcp to see the tools, then ask Codex to save posts as drafts before you let it schedule anything.',
  },
];

export const FAQ: Faq[] = [
  {
    q: 'Can Codex CLI post to social media?',
    a: `Yes, with an MCP server that does the posting. ${BRAND}'s hosted server gives Codex tools to list your connected channels, read each network's rules and create posts as drafts, scheduled for a time, or published now.`,
  },
  {
    q: 'Why does nothing show up after I edit config.toml?',
    a: 'Codex only reads tables named [mcp_servers.<name>], so check the spelling: mcp_servers, with an underscore and a plural. Then check that HOOKPOST_API_KEY is set in the shell you started codex from; without it Codex has no key to send and Hookpost refuses the connection with a 401.',
  },
  {
    q: 'Is this the same as using ChatGPT?',
    a: 'No. Codex CLI is OpenAI’s terminal coding agent, and this setup, with an API key in config.toml, is for Codex. ChatGPT connects differently: as a custom MCP server with OAuth sign-in and no API key (see the ChatGPT guide).',
  },
  {
    q: 'Which Hookpost plan do I need?',
    a: PLAN_ACCESS,
  },
  {
    q: 'Can I try it before paying?',
    a: TRY_IT,
  },
  {
    q: 'Can Codex delete or reschedule posts?',
    a: `${MCP_CANNOT} Codex can change the network settings of a post that has not gone out yet.`,
  },
  {
    q: 'Which networks can Codex post to?',
    a: `Any channel connected in your workspace: Hookpost connects ${PUBLISHABLE} networks, and in the 30 days to ${PUBLISHED_CHECKED} it published from production to ${publishedList}. ${NOT_SUPPORTED_NETWORKS}`,
  },
];

export const RELATED = [
  { href: '/guides/chatgpt-social-media-scheduling', label: 'Can ChatGPT schedule your posts?', note: 'Add Hookpost to ChatGPT as a custom MCP server.' },
  { href: '/guides/gemini-cli-social-media', label: 'Schedule posts from Gemini CLI', note: 'The settings.json block and why it must be httpUrl.' },
  { href: '/guides/claude-code-social-media', label: 'Schedule posts from Claude Code', note: 'claude mcp add, a shared .mcp.json and headless runs in CI.' },
  { href: '/cli', label: 'Hookpost CLI', note: 'Post from a script without a model in the loop.' },
] as const;
