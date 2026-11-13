// Targets "MCP server for Instagram posting", "post reels from Claude",
// "instagram mcp claude" (buyer-prompt research, 26 Oct 2026: only GitHub repos
// and registry entries rank, each needing your own Meta developer app).
//
// Every Instagram fact here is read from the code:
// - integrations/social/instagram.provider.ts: connects through a Facebook
//   Page (toolTip "Instagram must be business and connected to a Facebook
//   page"); maxLength 2200; at least one media; up to 10 items (carousel); a
//   single video goes out as media_type=REELS, a video inside a carousel as
//   VIDEO; post_type 'story' sends STORIES; trial Reels must be one video;
//   collaborators are not sent on stories; is_ai_generated is opt-in.
// - dtos/posts/providers-settings/instagram.dto.ts: post_type post | story,
//   is_trial_reel, is_ai_generated, collaborators, audio.
// - chat/tools/integration.schedule.post.ts: attachments must be URLs on
//   Hookpost's own upload domain (valid.url.path), so media from elsewhere goes
//   through uploadFromUrlTool first (mcp-setup.ts: images up to 10 MB, video
//   up to 1 GB).
// - instagram-standalone (connect without a Facebook Page) is in
//   HIDDEN_PROVIDERS, so the page says a Page is needed.
// - Instagram is in PUBLISHED_NETWORKS (published from production in the 30
//   days to 22 Oct 2026).
import { MCP_CANNOT } from '../../mcp/mcp-setup';
import { ANSWER_PAGES_UPDATED, answerUrl } from '../_answer/answer-pages';
import type { Faq, Step } from '../_answer/answer-schema';
import {
  BRAND,
  CHANNEL_SPECS,
  KEY_WHERE,
  PLAN_ACCESS,
  PUBLISHED_CHECKED,
  HOOKPOST_MONTH,
  HOOKPOST_MONTH_IN_PARENS,
  TRY_IT,
} from '../_answer/facts';

export const PATH = '/guides/instagram-mcp-server';
export const CANONICAL = answerUrl(PATH);
export const UPDATED = ANSWER_PAGES_UPDATED;

export const IG_LIMIT = CHANNEL_SPECS.instagram.limit; // '2,200 characters'

export const H1 = 'An MCP server for Instagram posting';

export const ANSWER = `${BRAND} runs a hosted MCP server that lets Claude, Cursor, Codex or Gemini CLI publish to Instagram Business and Creator accounts: single images, carousels of up to 10 items, Reels (one video) and Stories, with captions up to ${IG_LIMIT}. You connect Instagram once inside Hookpost through Meta's own sign-in, so you need no Meta developer app or access token of your own, and the AI never sees your Instagram login. It needs the Hookpost plan (${HOOKPOST_MONTH_IN_PARENS}).`;

export const DESCRIPTION = `Post Instagram images, carousels, Reels and Stories from Claude or Cursor through Hookpost's hosted MCP server. No Meta developer app needed. Business or Creator accounts, from ${HOOKPOST_MONTH}.`;

export const STEPS: Step[] = [
  {
    name: 'Connect Instagram in Hookpost',
    text: 'Click Add Channel, choose Instagram and sign in with Facebook. Pick the Facebook Page your Instagram Business or Creator account is linked to; Hookpost finds the Instagram account through that Page.',
  },
  {
    name: 'Add the MCP server to your AI client',
    text: `Copy your API key from ${KEY_WHERE} and add https://hookpost.hookstep.in/api/mcp with an Authorization: Bearer header to Claude, Cursor, Codex or Gemini CLI.`,
  },
  {
    name: 'Give the agent media it can attach',
    text: 'Instagram posts need at least one image or video. Ask the agent to import it from a public URL with uploadFromUrlTool (images up to 10 MB, video up to 1 GB); the post then attaches Hookpost’s copy.',
  },
  {
    name: 'Ask for a draft, then schedule',
    text: 'Ask the agent to write the caption and save the post as a draft on your Instagram channel. Check it in the Hookpost calendar, then schedule it there or ask the agent to.',
  },
];

export const FIRST_PROMPT = `List my Hookpost channels and find my Instagram channel. Import
https://example.com/launch/photo-1.jpg and photo-2.jpg with uploadFromUrlTool.
Write a caption under 2,200 characters with 5 hashtags at the end, and save
a carousel draft with both images for Friday 18:00 IST. Do not publish.`;

export const FORMATS_HEAD = ['Format', 'What to attach', 'Notes from Hookpost’s Instagram code'] as const;
export const FORMATS: string[][] = [
  ['Image post', 'One image', `Caption up to ${IG_LIMIT}.`],
  ['Carousel', '2 to 10 images or videos', 'The caption goes on the carousel, not on each item.'],
  ['Reel', 'One video', 'A single video always goes out as a Reel. Trial Reels (shown to non-followers first) are a per-post setting and must be one video.'],
  ['Story', 'Image or video', 'Set the post type to story. Collaborators are not sent on Stories.'],
];

export const VS_HEAD = ['', `Hookpost (hosted)`, 'Self-hosted Instagram MCP servers on GitHub (typical setup)'] as const;
export const VS_ROWS: string[][] = [
  ['What you set up', 'Add one URL and an API key to your AI client', 'Create a Meta developer app, get an access token, run the server on your machine'],
  ['Who holds the Instagram token', 'Hookpost’s servers; the AI sees channel names and ids only', 'Your config or environment, read by the local server'],
  ['Scheduling for later', 'Yes: Hookpost stores the post and publishes at the set time', 'Usually publishes when called; scheduling needs something else running'],
  ['Other networks from the same server', 'Every channel in your Hookpost workspace (X, LinkedIn, Threads, YouTube and more)', 'Usually Instagram only'],
  ['Cost', `Hookpost, ${HOOKPOST_MONTH}`, 'Free software; you run and maintain it'],
];

export const FAQ: Faq[] = [
  {
    q: 'Is there an MCP server for Instagram?',
    a: `Yes. ${BRAND}'s hosted MCP server posts to Instagram along with the other networks connected to your Hookpost workspace, and in the 30 days to ${PUBLISHED_CHECKED} Hookpost published Instagram posts from production. There are also self-hosted Instagram MCP servers on GitHub; those need your own Meta developer app and access token.`,
  },
  {
    q: 'Can Claude post Instagram Reels?',
    a: 'Yes, through the MCP server. Attach one video and Hookpost publishes it as a Reel. The video has to be imported into Hookpost first, from a public URL with uploadFromUrlTool, because posts only attach media from Hookpost’s own storage.',
  },
  {
    q: 'Does it work with a personal Instagram account?',
    a: 'No. Instagram only allows publishing through its API to Business and Creator accounts, and Hookpost reaches the account through the Facebook Page it is linked to. Switching a personal account to Creator is free in the Instagram app.',
  },
  {
    q: 'Do I need a Meta developer account or an access token?',
    a: 'No. Hookpost uses its own Meta app; you sign in with Facebook inside Hookpost and pick your Page. Your token stays on Hookpost’s servers and is never sent to the AI.',
  },
  {
    q: 'Can the agent read Instagram comments or analytics?',
    a: `Not through MCP. ${MCP_CANNOT}`,
  },
  {
    q: 'Which Hookpost plan do I need?',
    a: PLAN_ACCESS,
  },
  {
    q: 'Can I try it before paying?',
    a: TRY_IT,
  },
];

export const RELATED = [
  { href: '/channels/instagram', label: 'Scheduling to Instagram', note: 'Every Instagram rule Hookpost checks before a post is queued.' },
  { href: '/guides/claude-mcp-social-media', label: 'Schedule posts with Claude', note: 'Add Hookpost to claude.ai or Claude Desktop as a custom connector.' },
  { href: '/guides/cursor-social-media', label: 'Schedule posts from Cursor', note: 'The mcp.json for Cursor, VS Code and Windsurf.' },
  { href: '/social-media-mcp-servers', label: 'Social media MCP servers compared', note: 'Which schedulers ship an MCP server and how each signs in.' },
] as const;
