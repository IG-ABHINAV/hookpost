import React from 'react';
import { A, AdPage, Code } from './ad-landing';
import { CLAUDE_CODE_CMD, MCP_URL, MCP_URL_WITH_KEY } from '../mcp/mcp-setup';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer } from '../trial-offer';
import { usdCopy, USD_HOOKPOST_MONTH } from '../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

const { HOOKPOST } = pricingINR;
const hookpostPrice = usdCopy(
  `${HOOKPOST_DISPLAY_PRICE} a month`,
  `${USD_HOOKPOST_MONTH} a month (${HOOKPOST_DISPLAY_PRICE} in India)`
);
const afterTrial = offer('', ` after ${FREE_POSTS}`);

// Same block as /mcp#cli (apps/cli/src/index.ts, npm `hookpost`): commands
// only, 38 characters a line at most, abc123 a placeholder channel id.
export const CLI_BLOCK = `npm install -g hookpost
hookpost auth login
hookpost channels
hookpost post "Hello" --channel abc123`;

// A prompt in the spirit of the run in the video, not its exact words.
const PROMPT =
  'Read my-notes.md and draft one post a day for next week on LinkedIn, Threads and Facebook, at 9 am. Save them as drafts in Hookpost.';

export const CLAUDE_PAGE: AdPage = {
  path: '/claude',
  kicker: 'Claude + Hookpost',
  title: 'Claude drafts a week of posts in Hookpost',
  description: `A real Claude Code run: one prompt and a notes file became 21 drafts in the Hookpost calendar. Connect Claude to Hookpost with one command; Hookpost is ${hookpostPrice}${afterTrial}.`,
  summary:
    'A real Claude Code session in which one prompt and a notes file became 21 drafts in the Hookpost calendar, and the one command that connects Claude Code to Hookpost.',
  howTitle: 'Connect Claude in two minutes',
  how: (
    <>
      <ol className="flex list-decimal flex-col gap-4 ps-6">
        <li>
          <strong className="text-hp-text">Sign up, then copy your API key</strong> from Settings → Developers. The
          MCP server comes with the Hookpost plan ({hookpostPrice}).
        </li>
        <li className="min-w-0">
          <strong className="text-hp-text">Add Hookpost to Claude Code</strong>, in your terminal:
          <Code>{CLAUDE_CODE_CMD}</Code>
          <span className="mt-2 block text-sm text-hp-text/60">
            In claude.ai or Claude Desktop: Customize → Connectors → Add custom connector, with{' '}
            <code className="break-all font-mono">{MCP_URL_WITH_KEY}</code>.
          </span>
        </li>
        <li className="min-w-0">
          <strong className="text-hp-text">Ask for drafts</strong>, for example:
          <p className="mt-3 rounded-lg bg-white/[0.04] p-3 font-mono text-xs leading-relaxed text-hp-text/85">{PROMPT}</p>
          <span className="mt-2 block text-sm text-hp-text/60">
            The posts land in your Hookpost calendar as drafts. Read them, edit them, and schedule the ones you like.
          </span>
        </li>
      </ol>
      <p className="mt-6 text-sm text-hp-text/60">
        Every client uses the same server, <code className="font-mono">{MCP_URL}</code>: setups for Cursor, VS Code, Windsurf,
        Codex and Gemini CLI are on the <A href="/mcp">MCP page</A>. Prefer a terminal command? <A href="/cli">The CLI</A>.
      </p>
    </>
  ),
};

export const CLI_PAGE: AdPage = {
  path: '/cli',
  kicker: 'Hookpost CLI',
  title: 'Post to every channel from your terminal',
  description: `npm install -g hookpost, sign in with your API key, and post to LinkedIn, X, Threads and more in one line. Hookpost is ${hookpostPrice}${afterTrial}.`,
  summary:
    'The hookpost CLI from npm: sign in with an API key and post to every connected channel in one line, into the next free slot of your schedule.',
  howTitle: 'Install, sign in, post',
  how: (
    <>
      <p>
        The <code className="font-mono">hookpost</code> CLI is on npm and needs Node.js 18 or later. Sign up, copy your
        API key from Settings → Developers, then:
      </p>
      <Code>{CLI_BLOCK}</Code>
      <p className="mt-3 text-sm text-hp-text/65">
        Run the commands one at a time: <code className="font-mono">hookpost auth login</code> asks for your API key, then the
        API host (press Enter to keep the default). Replace <code className="font-mono">abc123</code> with an id from{' '}
        <code className="font-mono">hookpost channels</code>. With no <code className="font-mono">--at</code>, the post goes into
        the next free slot of your posting schedule; add <code className="font-mono">--at</code> and an ISO date for an exact
        time, <code className="font-mono">--now</code> to publish straight away or <code className="font-mono">--draft</code> to
        save a draft. In CI, set <code className="font-mono">HOOKPOST_API_KEY</code> instead of signing in.
      </p>
      <p className="mt-6 text-sm text-hp-text/60">
        The same key connects Claude and other AI assistants (<A href="/claude">Claude</A>, <A href="/mcp">every MCP client</A>)
        and the <A href="/social-media-scheduling-api">REST API</A>.
      </p>
    </>
  ),
};

export const START_PAGE: AdPage = {
  path: '/start',
  kicker: 'Hookpost',
  title: 'Schedule a week of posts: with Claude, the CLI or the calendar',
  description: `Hookpost schedules posts to Instagram, LinkedIn, X, Threads, YouTube and more: ask Claude, use the CLI, or the calendar in your browser. Hookpost is ${hookpostPrice}${afterTrial}.`,
  summary:
    'Hookpost in one page: the three ways to fill a week of posts (Claude over MCP, the CLI, the web calendar), the networks it publishes to, and what it costs next to Hootsuite, Sprout Social, Buffer and Postiz.',
  howTitle: 'Three ways to fill the week',
  how: (
    <ul className="grid gap-4 md:grid-cols-3">
      <li className="rounded-2xl border border-hp-border p-5">
        <strong className="text-hp-text">Ask Claude.</strong> Connect Claude Code or Claude to Hookpost&apos;s MCP server with your
        API key and ask for a week of drafts, as in the video. <A href="/claude">How to connect Claude</A>.
      </li>
      <li className="rounded-2xl border border-hp-border p-5">
        <strong className="text-hp-text">From the terminal.</strong>{' '}
        <code className="font-mono">npm install -g hookpost</code>, sign in once, and post in one line, into your next free
        slot. <A href="/cli">The CLI</A>.
      </li>
      <li className="rounded-2xl border border-hp-border p-5">
        <strong className="text-hp-text">In the calendar.</strong> Write a post once, pick the channels, adjust it per network
        and schedule it, in the browser. Drafts from Claude and the CLI land in the same calendar.
      </li>
    </ul>
  ),
};

export const AD_PAGES = [CLAUDE_PAGE, CLI_PAGE, START_PAGE];
