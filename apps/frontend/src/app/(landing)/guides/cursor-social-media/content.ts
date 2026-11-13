// Targets "social media scheduler Cursor MCP", "cursor mcp schedule posts",
// "vscode mcp social media" (buyer-prompt research, 26 Oct 2026: Postiz,
// bundle.social, SocialChamp and PostEverywhere rank; Hookpost had only an
// anchor on /mcp). Configs come from mcp/mcp-setup.ts, the same strings /mcp
// prints; the ${env:...} variant is from cursor.com/docs/context/mcp, read 26
// Oct 2026. Windsurf's docs name a different config path from the one the app
// shows, so no Windsurf path is printed (mcp-setup.ts).
import { CURSOR_JSON, MCP_CANNOT, MCP_URL, VSCODE_JSON, WINDSURF_JSON } from '../../mcp/mcp-setup';
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
  TRY_IT,
  publishedList,
} from '../_answer/facts';

export const PATH = '/guides/cursor-social-media';
export const CANONICAL = answerUrl(PATH);
export const UPDATED = ANSWER_PAGES_UPDATED;

export const H1 = 'Schedule social media posts from Cursor, VS Code or Windsurf';

export const ANSWER = `Add ${BRAND}'s hosted MCP server to Cursor's mcp.json with your API key, and Cursor's agent can list your connected social channels and save posts as drafts, schedule them for a time, or publish them now. The same server works in VS Code (Copilot agent mode) and Windsurf; only the config format changes. It needs the Hookpost plan, from ${HOOKPOST_MONTH}.`;

export const DESCRIPTION = `Connect Cursor, VS Code or Windsurf to Hookpost's hosted MCP server with one mcp.json block. The agent drafts and schedules posts to X, LinkedIn, Instagram and more, from ${HOOKPOST_MONTH}.`;

export const CURSOR_ENV_JSON = `{
  "mcpServers": {
    "hookpost": {
      "url": "${MCP_URL}",
      "headers": { "Authorization": "Bearer \${env:HOOKPOST_API_KEY}" }
    }
  }
}`;

export { CURSOR_JSON, VSCODE_JSON, WINDSURF_JSON, MCP_CANNOT };

export const FIRST_PROMPT = `List my Hookpost channels. Then read CHANGELOG.md and write one LinkedIn
post and one X post (under 280 characters) about the newest release.
Save both as drafts in Hookpost. Do not schedule or publish anything.`;

export const STEPS: Step[] = [
  {
    name: 'Copy your Hookpost API key',
    text: `Connect your social accounts in Hookpost first, then open ${KEY_WHERE}. There is one key per workspace; Rotate replaces it and the old key stops working at once.`,
  },
  {
    name: 'Add the server to mcp.json',
    text: `Put the hookpost block in ~/.cursor/mcp.json to use it in every project, or in .cursor/mcp.json to use it in one. The endpoint is ${MCP_URL} and the key goes in an Authorization: Bearer header.`,
  },
  {
    name: 'Check that Cursor connects',
    text: 'Cursor lists the server and its tools in its MCP settings. If it shows an error, open the Output panel and choose MCP Logs: a 401 there means the header is missing or the key is wrong.',
  },
  {
    name: 'Ask the agent for drafts first',
    text: 'In Agent mode, ask Cursor to list your Hookpost channels and save posts as drafts. Review them in the Hookpost calendar, then ask for scheduled posts once you trust the output.',
  },
];

export const CLIENT_TABLE_HEAD = ['Editor', 'Config file', 'Top-level key', 'URL field', 'Key sent as'] as const;
export const CLIENT_TABLE: string[][] = [
  ['Cursor', '~/.cursor/mcp.json or .cursor/mcp.json', 'mcpServers', 'url', 'headers.Authorization'],
  ['VS Code (Copilot agent mode)', '.vscode/mcp.json in the workspace', 'servers, with "type": "http"', 'url', 'headers.Authorization'],
  ['Windsurf', "Windsurf's mcp_config.json (open it from Windsurf's MCP settings)", 'mcpServers', 'serverUrl', 'headers.Authorization'],
];

export const FAQ: Faq[] = [
  {
    q: 'Can Cursor post to social media?',
    a: `Yes, through an MCP server. Cursor's agent cannot reach X or LinkedIn on its own; with ${BRAND}'s MCP server added it can list the channels connected in your Hookpost workspace and create draft, scheduled or immediate posts on them. Hookpost does the publishing, so Cursor does not need to stay open.`,
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
    q: 'How do I keep the API key out of git?',
    a: 'In Cursor, reference an environment variable instead of the key: "Authorization": "Bearer ${env:HOOKPOST_API_KEY}". Cursor resolves ${env:NAME} in the url and headers fields, so a project .cursor/mcp.json can be committed while each person sets HOOKPOST_API_KEY in their own shell. Otherwise keep the key in ~/.cursor/mcp.json, which lives outside the repo.',
  },
  {
    q: 'Does Cursor see my social media passwords?',
    a: 'No. Network tokens stay on Hookpost’s servers, and the tools return channel names and ids, never credentials. The post text, and anything the agent reads from your project to write it, does go through the model Cursor uses.',
  },
  {
    q: 'Can the agent delete or edit posts?',
    a: `${MCP_CANNOT} The agent can change the network settings of a post that has not gone out yet.`,
  },
  {
    q: 'Which networks can it post to?',
    a: `Any channel connected in your workspace: Hookpost connects ${PUBLISHABLE} networks, and in the 30 days to ${PUBLISHED_CHECKED} it published from production to ${publishedList}. ${NOT_SUPPORTED_NETWORKS}`,
  },
  {
    q: 'Does the same setup work in VS Code and Windsurf?',
    a: 'Yes. It is the same hosted server; VS Code wants a "servers" object with "type": "http", and Windsurf calls the URL field serverUrl. Both configs are on this page.',
  },
];

export const RELATED = [
  { href: '/mcp', label: 'Hookpost MCP server', note: 'Every client config, the full tool reference and how the server works.' },
  { href: '/guides/claude-code-social-media', label: 'Schedule posts from Claude Code', note: 'One claude mcp add command, a shared .mcp.json and headless runs.' },
  { href: '/guides/codex-cli-social-media', label: 'Schedule posts from Codex CLI', note: 'The config.toml block for OpenAI’s terminal agent.' },
  { href: '/social-media-mcp-servers', label: 'Social media MCP servers compared', note: 'How other schedulers’ MCP servers sign in and what they cost.' },
] as const;
