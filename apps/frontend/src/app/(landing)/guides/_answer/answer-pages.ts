/**
 * The answer pages: one page per question a buyer types into ChatGPT,
 * Perplexity, Gemini or a search box, each opening with a two-to-three
 * sentence direct answer (GEO research, 26 Oct 2026: 25 buyer prompts, Hookpost
 * absent from all of them).
 *
 * One registry so the sitemap, the guides hub, llms.txt and the tests all read
 * the same list; answer-pages.spec.ts fails if a page is added here without a
 * page.tsx, a sitemap entry or an llms.txt line, or the other way round.
 *
 * Folder starts with "_", so Next.js never routes it.
 */
export interface AnswerPageMeta {
  /** URL path under the site, no trailing slash. */
  path: `/guides/${string}`;
  /** Card title on the guides hub. */
  title: string;
  /** Card blurb on the guides hub. */
  blurb: string;
  /** Tag on the guides hub card. */
  tag: string;
  /** The buyer prompts the page answers (from the research), for the record. */
  queries: string[];
}

/** When these pages were written and checked against the code and live site. */
export const ANSWER_PAGES_UPDATED = '2026-10-26';
/** The same date, the way the pages print it. */
export const ANSWER_PAGES_UPDATED_LABEL = '26 October 2026';

export const SITE = 'https://hookpost.hookstep.in';

export const ANSWER_PAGES: readonly AnswerPageMeta[] = [
  {
    path: '/guides/cursor-social-media',
    title: 'Schedule social media posts from Cursor, VS Code or Windsurf',
    blurb:
      'The exact mcp.json for Cursor and VS Code, what the agent can and cannot do, and a first prompt that stops at drafts.',
    tag: 'AI agents',
    queries: ['social media scheduler Cursor MCP', 'cursor mcp schedule posts', 'vscode mcp social media'],
  },
  {
    path: '/guides/codex-cli-social-media',
    title: 'Schedule social media posts from OpenAI Codex CLI',
    blurb:
      'A three-line config.toml table, the key kept in an environment variable, and drafts first from the terminal.',
    tag: 'AI agents',
    queries: ['social media scheduler Codex CLI MCP', 'codex mcp social media'],
  },
  {
    path: '/guides/gemini-cli-social-media',
    title: 'Schedule social media posts from Gemini CLI',
    blurb:
      'One gemini mcp add command or a settings.json block, why it must be httpUrl, and what the agent can post.',
    tag: 'AI agents',
    queries: ['Gemini CLI MCP social media', 'gemini cli schedule posts'],
  },
  {
    path: '/guides/instagram-mcp-server',
    title: 'An MCP server for Instagram posting',
    blurb:
      'Post Instagram images, carousels, Reels and Stories from Claude or Cursor without your own Meta developer app, and the limits that apply.',
    tag: 'AI agents',
    queries: ['MCP server for Instagram posting', 'post reels from Claude', 'instagram mcp claude'],
  },
  {
    path: '/guides/auto-post-x-linkedin-ai',
    title: 'Auto-post to X and LinkedIn with AI',
    blurb:
      'One idea written for each network inside its limits, scheduled to both, with the parts that stay manual said plainly.',
    tag: 'AI agents',
    queries: [
      'AI tool to auto post to X and LinkedIn',
      'schedule LinkedIn posts with AI',
      'Typefully alternative X threads LinkedIn Bluesky',
    ],
  },
  {
    path: '/guides/chatgpt-social-media-scheduling',
    title: 'Can ChatGPT schedule your social media posts?',
    blurb:
      'Add Hookpost to ChatGPT as a custom MCP server with OAuth sign-in, what each plan needs, and the other routes from an OpenAI model into your calendar.',
    tag: 'AI agents',
    queries: ['schedule LinkedIn posts from ChatGPT', 'ChatGPT app connector social media scheduling'],
  },
];

export const answerUrl = (path: string): string => `${SITE}${path}`;
