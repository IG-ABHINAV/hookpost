// Targets "schedule LinkedIn posts from ChatGPT" and "ChatGPT app connector
// social media scheduling". ChatGPT sent more visitors than Google in the week
// to 26 Oct 2026, and seven vendors rank for the query.
//
// 26 Oct 2026: Hookpost connects to ChatGPT as a custom MCP server at
// /mcp-oauth with OAuth sign-in. The steps, the plan note and what was tested
// come from mcp/mcp-setup.ts (CHATGPT_*), shared with /mcp and llms.txt. The
// flow was run against production with the official MCP SDK client acting as
// ChatGPT, not yet inside a ChatGPT account: the page says so. Hookpost is not
// in OpenAI's apps directory (not submitted), so nothing here says "app" or
// "listed".
//
// Competitor facts, read 26 Oct 2026 from the vendors' own pages:
// - postbeam.ai/chatgpt-linkedin-connector: "Connect ChatGPT to LinkedIn with
//   Postbeam", "Free 7-day trial, then from $39/mo".
// - posteverywhere.ai/agents/chatgpt: works through a custom MCP server added
//   on chatgpt.com, needs a paid ChatGPT plan; its ChatGPT app is "in review".
// Codex CLI config: see guides/codex-cli-social-media/content.ts.
import { ANSWER_PAGES_UPDATED, answerUrl } from '../_answer/answer-pages';
import type { Faq, Step } from '../_answer/answer-schema';
import { BRAND, PLAN_ACCESS, HOOKPOST_MONTH, HOOKPOST_MONTH_IN_PARENS, TRY_IT } from '../_answer/facts';
import {
  CHATGPT_MCP_URL,
  CHATGPT_PLAN_NOTE,
  CHATGPT_STEPS,
  CHATGPT_TESTED,
  OAUTH_PLAN_NOTE,
} from '../../mcp/mcp-setup';
import { FREE_POSTS, offer } from '../../trial-offer';

export const PATH = '/guides/chatgpt-social-media-scheduling';
export const CANONICAL = answerUrl(PATH);
export const UPDATED = ANSWER_PAGES_UPDATED;

export const H1 = 'Can ChatGPT schedule your social media posts?';

/** OAUTH_PLAN_NOTE as one clause, so the answer stays at three sentences. */
const HOOKPOST_SIDE = offer(
  'It works on every Hookpost plan',
  `Any Hookpost workspace can connect: without a plan it gets ${FREE_POSTS}, then the Hookpost plan`
);

export const ANSWER = `Yes, with ${BRAND} added to ChatGPT as a custom MCP server: use the URL ${CHATGPT_MCP_URL}, sign in to Hookpost when ChatGPT asks, and ChatGPT can list your channels and save drafts or scheduled posts in your Hookpost calendar. ${HOOKPOST_SIDE}; your ChatGPT plan has to allow custom MCP servers (ChatGPT Free does not).`;

export const DESCRIPTION = `Add Hookpost to ChatGPT as a custom MCP server (OAuth sign-in, no API key) and schedule posts from the chat. The steps, what each plan needs, and the other routes.`;

const STEP_NAMES = ['Add a custom MCP server', 'Enter Hookpost’s URL', 'Sign in and authorize', 'Try a first prompt'];
/** CHATGPT_STEPS (mcp-setup.ts) with a name each, for the page and HowTo. */
export const STEPS: Step[] = CHATGPT_STEPS.map((text, i) => ({ name: STEP_NAMES[i], text }));
export const PLAN_NOTE = CHATGPT_PLAN_NOTE;
export const TESTED = CHATGPT_TESTED;
export const MCP_URL_CHATGPT = CHATGPT_MCP_URL;

export const ROUTES_HEAD = ['Route', 'What happens', 'Status with Hookpost'] as const;
export const ROUTES: string[][] = [
  [
    'ChatGPT with Hookpost as a custom MCP server',
    'ChatGPT lists your channels, reads each network’s rules and saves drafts or scheduled posts in Hookpost, asking before it writes.',
    offer(
      'Works: on any Hookpost plan, with a ChatGPT plan that allows custom MCP servers',
      `Works: ${FREE_POSTS}, then a Hookpost plan; needs a ChatGPT plan that allows custom MCP servers`
    ),
  ],
  [
    'Write in ChatGPT, schedule in Hookpost',
    'Ask ChatGPT for a version per network, paste each into Hookpost’s editor, pick a time. Hookpost checks each version against the network’s limit.',
    'Works on any ChatGPT plan',
  ],
  [
    'OpenAI Codex CLI with Hookpost’s MCP server',
    'Codex reads your notes or repo, then lists your channels and saves drafts or scheduled posts in Hookpost.',
    `Works: config from Codex’s docs; needs the Hookpost plan (${HOOKPOST_MONTH_IN_PARENS})`,
  ],
  [
    'A script: OpenAI API writes, Hookpost API or CLI schedules',
    'Your own code calls a model for the text and Hookpost’s REST API or hookpost CLI to schedule it.',
    'Works; needs the Hookpost plan for the API key',
  ],
];

export const OTHERS_HEAD = ['Scheduler', 'How it works with ChatGPT, per its own page', 'Entry price, per its own page'] as const;
export const OTHERS: string[][] = [
  ['Postbeam', 'A ChatGPT-to-LinkedIn connector: approve and schedule posts without leaving ChatGPT', '7-day trial, then from $39 a month'],
  ['PostEverywhere', 'A custom MCP server you add on chatgpt.com; needs a paid ChatGPT plan, and its ChatGPT app is listed as in review', 'See their pricing page'],
];

export const PROMPT = `Write a LinkedIn post (under 1,300 characters, ending with a question)
and an X post (under 280 characters) announcing <your news>. Plain text,
no hashtags in the X post. Label them LINKEDIN and X.`;

export const FIRST_PROMPT = `List my Hookpost channels. Then write a LinkedIn post and an X post
announcing <your news>, check each against the network's rules, and save
both as drafts for tomorrow 10:00 my time. Show me both before saving.`;

export const FAQ: Faq[] = [
  {
    q: 'Can ChatGPT post to LinkedIn or X for me?',
    a: `Yes, through ${BRAND}: add it as a custom MCP server and ChatGPT can save drafts or scheduled posts to your connected LinkedIn and X channels. Hookpost publishes them at the time you set. ChatGPT asks before anything that writes.`,
  },
  {
    q: 'What URL do I add in ChatGPT?',
    a: `${CHATGPT_MCP_URL}, with OAuth as the authentication. Leave the client ID and secret empty: ChatGPT registers itself, then sends you to Hookpost to sign in and press Authorize. No API key is involved.`,
  },
  {
    q: 'Which ChatGPT plan do I need?',
    a: 'One that lets you add a custom MCP server. OpenAI decides which plans can, and whether they may use write actions such as scheduling; ChatGPT Free cannot, and on Business, Enterprise and Edu an admin may have to allow it first.',
  },
  {
    q: 'Which Hookpost plan do I need?',
    a: `${OAUTH_PLAN_NOTE} Pasting ChatGPT drafts into the editor works on any plan. ${PLAN_ACCESS}`,
  },
  {
    q: 'Has Hookpost been tested in ChatGPT?',
    a: CHATGPT_TESTED,
  },
  {
    q: 'Is Hookpost in ChatGPT’s app directory?',
    a: 'Not yet. Add it yourself as a custom MCP server with the URL above.',
  },
  {
    q: 'How do I disconnect ChatGPT?',
    a: 'Remove the server in ChatGPT, or revoke ChatGPT in Hookpost under Settings → Approved Apps. A revoked connection stops working at once, and ChatGPT asks you to sign in again before it can use Hookpost.',
  },
  {
    q: 'Which other AI assistants work with Hookpost?',
    a: 'Claude (claude.ai and Claude Desktop, as a custom connector), Claude Code, Cursor, VS Code, Windsurf, Codex CLI and Gemini CLI, all through the same hosted MCP server.',
  },
  {
    q: 'Can I try it before paying?',
    a: TRY_IT,
  },
];

export const RELATED = [
  { href: '/mcp#chatgpt', label: 'Hookpost MCP server: ChatGPT setup', note: 'The same steps, next to every other client.' },
  { href: '/guides/codex-cli-social-media', label: 'Schedule posts from Codex CLI', note: 'The config.toml block and a first prompt.' },
  { href: '/guides/auto-post-x-linkedin-ai', label: 'Auto-post to X and LinkedIn with AI', note: 'One idea, a version per network, both scheduled.' },
  { href: '/guides/claude-mcp-social-media', label: 'Schedule posts with Claude', note: 'Add Hookpost to Claude as a custom connector.' },
  { href: '/mcp', label: 'Hookpost MCP server', note: `Every supported client, from ${HOOKPOST_MONTH}.` },
] as const;
