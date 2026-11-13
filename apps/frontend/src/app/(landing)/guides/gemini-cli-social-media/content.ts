// Targets "Gemini CLI MCP social media", "gemini cli schedule posts"
// (buyer-prompt research, 26 Oct 2026). The settings.json block is GEMINI_JSON
// from mcp/mcp-setup.ts. Re-read against geminicli.com/docs/tools/mcp-server on
// 26 Oct 2026: httpUrl = Streamable HTTP, url = SSE; headers for both;
// ~/.gemini/settings.json (user) and .gemini/settings.json (project);
// `gemini mcp add --transport http --header "..." <name> <url>` with
// -s/--scope user|project, default project; `gemini mcp list`; /mcp.
// The docs only promise environment-variable expansion in the `env` block,
// not in headers, so the page does not show a ${VAR} header for Gemini.
import { GEMINI_JSON, MCP_CANNOT, MCP_URL } from '../../mcp/mcp-setup';
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

export const PATH = '/guides/gemini-cli-social-media';
export const CANONICAL = answerUrl(PATH);
export const UPDATED = ANSWER_PAGES_UPDATED;

export const H1 = 'Schedule social media posts from Gemini CLI';

export const ANSWER = `To let Gemini CLI schedule posts through ${BRAND}, run one gemini mcp add command with your Hookpost API key, or add a hookpost entry to ~/.gemini/settings.json with httpUrl (not url, which Gemini CLI reads as an SSE server). Gemini CLI can then list your connected channels and save posts as drafts, scheduled posts or posts that go out now. The key comes with the Hookpost plan (${HOOKPOST_MONTH_IN_PARENS}).`;

export const DESCRIPTION = `Add Hookpost's hosted MCP server to Gemini CLI with one gemini mcp add command or a settings.json block, then let Gemini draft and schedule posts. From ${HOOKPOST_MONTH}.`;

export const ADD_CMD = `gemini mcp add --transport http --scope user \\
  --header "Authorization: Bearer YOUR_API_KEY" \\
  hookpost ${MCP_URL}`;

export const CHECK = `gemini mcp list        # hookpost should be listed
gemini                 # then type /mcp to see its tools`;

export const FIRST_PROMPT = `List my Hookpost channels. Turn notes/launch.md into one LinkedIn post,
one X post under 280 characters and one Threads post under 500. Save all
three as Hookpost drafts for Monday 09:30 IST. Do not publish anything.`;

export { GEMINI_JSON, MCP_CANNOT };

export const STEPS: Step[] = [
  {
    name: 'Copy your Hookpost API key',
    text: `Connect your social accounts in Hookpost, then open ${KEY_WHERE}.`,
  },
  {
    name: 'Add the server',
    text: `Run gemini mcp add --transport http --scope user --header "Authorization: Bearer YOUR_API_KEY" hookpost ${MCP_URL}. Without --scope user the server is added to the current project only.`,
  },
  {
    name: 'Check it',
    text: 'Run gemini mcp list, or start gemini and type /mcp to see the server, its status and its tools.',
  },
  {
    name: 'Ask for drafts first',
    text: 'Ask Gemini to list your Hookpost channels and save posts as drafts. Review them in the Hookpost calendar before you ask it to schedule.',
  },
];

export const FAQ: Faq[] = [
  {
    q: 'Can Gemini CLI post to social media?',
    a: `Yes, through an MCP server. With ${BRAND}'s hosted server added, Gemini CLI can list the channels connected in your Hookpost workspace, read each network's rules and create draft, scheduled or immediate posts. Hookpost publishes scheduled posts itself, so Gemini CLI does not have to stay open.`,
  },
  {
    q: 'Why httpUrl and not url?',
    a: 'Gemini CLI treats url as a Server-Sent Events endpoint and httpUrl as Streamable HTTP. Hookpost’s server speaks Streamable HTTP, so the entry needs httpUrl; gemini mcp add --transport http writes it for you.',
  },
  {
    q: 'Where does Gemini CLI keep the config?',
    a: 'In ~/.gemini/settings.json for every project, or .gemini/settings.json inside one project. gemini mcp add writes to the project file unless you pass --scope user. A project file holds the key in plain text, so keep it out of git.',
  },
  {
    q: 'Does this work in the Gemini app or Gemini in Google Workspace?',
    a: 'This page covers Gemini CLI, the terminal agent, which reads MCP servers from settings.json. Hookpost has not tested any other Gemini product with its server.',
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
    q: 'Can Gemini delete or edit posts?',
    a: `${MCP_CANNOT} Gemini can change the network settings of a post that has not gone out yet.`,
  },
  {
    q: 'Which networks can it post to?',
    a: `Any channel connected in your workspace: Hookpost connects ${PUBLISHABLE} networks, and in the 30 days to ${PUBLISHED_CHECKED} it published from production to ${publishedList}. ${NOT_SUPPORTED_NETWORKS}`,
  },
];

export const RELATED = [
  { href: '/guides/codex-cli-social-media', label: 'Schedule posts from Codex CLI', note: 'The config.toml block for OpenAI’s terminal agent.' },
  { href: '/guides/claude-code-social-media', label: 'Schedule posts from Claude Code', note: 'claude mcp add, a shared .mcp.json and headless runs in CI.' },
  { href: '/guides/cursor-social-media', label: 'Schedule posts from Cursor', note: 'The mcp.json for Cursor, VS Code and Windsurf.' },
  { href: '/mcp#tools', label: 'MCP tool reference', note: 'Every tool the server exposes and what it takes.' },
] as const;
