import React from 'react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Metadata } from 'next';
import { SiteNav } from '../site-nav';
import { PUBLISHED_CHECKED, publishedList } from '../channels/published-networks';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import {
  API_KEY_PLAN_NOTE,
  CHATGPT_MCP_URL,
  CHATGPT_SIDE_NOTE,
  CHATGPT_STEPS,
  CHATGPT_TESTED,
  CLAUDE_CODE_CMD,
  CLAUDE_DESKTOP_REMOTE_JSON,
  CLAUDE_MCP_URL,
  CODEX_TOML,
  CURSOR_JSON,
  GEMINI_JSON,
  MCP_CANNOT,
  MCP_TOOLS,
  MCP_URL,
  MCP_URL_WITH_KEY,
  OAUTH_PLAN_NOTE,
  SETUP_CHECKED,
  VSCODE_JSON,
  WINDSURF_JSON,
} from './mcp-setup';
import { FREE_POSTS, TRIAL_ONLY } from '../trial-offer';
import { USD_HOOKPOST_MONTH, usdCopy, usdOffers } from '../usd-offer';
import { MCP_TRIAL_TERMS } from './trial-terms';
import { TrialTerms, VisitorCurrencyProvider } from './trial-terms.client';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { HOOKPOST_AI_CREDITS, HOOKPOST_X_POSTS } from '@hookpost/frontend/app/(landing)/usd-offer';

// The product page for the intent "connect an MCP client to a scheduler".
// Per-client setups are anchored sections here (#claude-code, #cursor, ...),
// not separate pages: the answer is the same server with a different config
// format, and one page per editor would be keyword permutations.
//
// Everything technical comes from mcp-setup.ts (see the sources listed there).
// Corrections made on 11 Oct 2026, so they do not creep back:
// - Claude Desktop does not take {"url": ...} in claude_desktop_config.json;
//   remote servers are custom connectors, or mcp-remote in the config file.
// - The schedule tool is exposed as integrationSchedulePostTool.
// - The server is remote Streamable HTTP (plus a legacy SSE route), not stdio.
// - No LangChain/CrewAI/AutoGen claims: none was tested. ChatGPT (26 Oct):
//   steps, plan note and what was tested come from mcp-setup.ts.
// - The MCP badge shows in the post editor and share preview for everyone; the
//   calendar grid shows it only to admins, so the copy says "open a post".
// - 11 Oct review: /social-media-mcp-servers owns "social media MCP server(s)";
//   this page is titled for the Hookpost server and its setup, so the two do
//   not compete for the same query.
// - The Claude custom-connector steps follow Claude's help page
//   (support.claude.com 11175166). Nobody has run them end to end with a real
//   key, so the copy gives the steps plainly, claims no test, and points to the
//   mcp-remote config file if Claude cannot connect.
const CANONICAL = 'https://hookpost.hookstep.in/mcp';
const { FREE, HOOKPOST } = pricingINR;

// The networks this page names: those that published from production in the
// 30 days to PUBLISHED_CHECKED (channels/published-networks.ts, shared with
// the ad landing pages so every page names the same ten).
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;
// This page is cached for every visitor (NGINX and Cloudflare, across query
// strings), so once dollars are sold (usd-offer.ts) it states both prices
// rather than the rupee one alone. Rupees only while USD_CHECKOUT is off.
// The one shown price ("$7", pricing.ts HOOKPOST_PRICE); no rupee figure.
const monthly = (_usd: string, _rupees: number) => `${HOOKPOST_DISPLAY_PRICE} a month`;
const perMonth = (_usd: string, _rupees: number) => `${HOOKPOST_DISPLAY_PRICE}/month`;

// The hookpost CLI (apps/cli/src/index.ts; npm 0.1.1 was published from
// 0174afaef, and apps/cli has not changed since, 22 Oct 2026). `auth login`
// asks for the key, then for the API host (Enter keeps the default), saves
// both and then checks the key; its key prompt still names "Settings -> Public
// API", a tab now called Developers, so the block names no tab. `channels`
// prints ids; a post with no --now, --draft or --at is scheduled into the
// channel's next free slot (GET /public/v1/find-slot). abc123 is a
// placeholder, as on / and /social-media-scheduling-api: `<id>` would be a
// shell redirect. Every line is 38 characters or fewer, so the block does not
// scroll sideways on a 375px phone (text-xs mono is about 7.2px a character,
// in 301px). Commands only: macOS zsh has interactive_comments off, so a
// comment-only line pasted in prints "command not found: #", and `auth login`
// would read the next pasted lines as the key and host. The prompts are
// explained in the paragraph under the block instead.
const CLI = `npm install -g hookpost
hookpost auth login
hookpost channels
hookpost post "Hello" --channel abc123`;

// The quick start at the top: the OAuth connectors, which need no API key and
// no plan to connect (mcp-setup.ts OAUTH_PLAN_NOTE). Rendered on the page and
// used for the HowTo markup, so the two always match.
const STEPS: { name: string; text: string }[] = [
  {
    name: 'Add Hookpost to Claude or ChatGPT',
    text: `In Claude: Customize → Connectors → + Add → Add custom connector, and paste ${CLAUDE_MCP_URL}. In ChatGPT: Plugins → + → Add custom MCP server, paste ${CHATGPT_MCP_URL} and choose OAuth.`,
  },
  {
    name: 'Sign in and press Authorize',
    text: 'The assistant opens Hookpost: sign in, or create your account, and press Authorize. There is no API key to copy.',
  },
  {
    name: 'Ask for drafts',
    text: 'Ask the assistant to list your Hookpost channels and save posts as drafts, then review them in the Hookpost calendar.',
  },
];

// The same server for clients that take an API key (the Hookpost plan).
const API_KEY_STEPS: { name: string; text: string }[] = [
  {
    name: 'Copy your API key',
    text: 'In Hookpost on the Hookpost plan, open Settings > Developers and copy the API key.',
  },
  {
    name: 'Add the server to your client',
    text: `Point your MCP client at ${MCP_URL} with the header Authorization: Bearer YOUR_API_KEY, or at ${MCP_URL_WITH_KEY} if the client cannot send headers.`,
  },
  {
    name: 'Ask for drafts',
    text: 'Ask the assistant to list your Hookpost channels and save posts as drafts, then review them in the Hookpost calendar.',
  },
];

interface ClientSetup {
  id: string;
  name: string;
  where: string;
  code: string;
  note?: ReactNode;
}

const CLIENTS: ClientSetup[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    where: 'Run in your terminal',
    code: CLAUDE_CODE_CMD,
    note: (
      <>
        Check it with <code className="font-mono">claude mcp list</code>. Team setup with{' '}
        <code className="font-mono">.mcp.json</code>, headless runs and CI:{' '}
        <Link href="/guides/claude-code-social-media" className="text-hp-primary-text underline">Claude Code guide</Link>.
      </>
    ),
  },
  {
    id: 'claude',
    name: 'Claude (claude.ai and Claude Desktop)',
    where: 'Customize → Connectors → + Add → Add custom connector',
    code: CLAUDE_MCP_URL,
    note: (
      <>
        No API key: Claude opens Hookpost, you sign in and press Authorize. With an API key you can paste{' '}
        <code className="font-mono break-all">{MCP_URL_WITH_KEY}</code> instead and choose no sign-in. Claude adds remote servers
        as connectors, not in <code className="font-mono">claude_desktop_config.json</code>; on Claude&apos;s free plan you get one
        custom connector. If Claude can&apos;t connect, use the config file with the{' '}
        <code className="font-mono">mcp-remote</code> bridge below in Claude Desktop. Step by step:{' '}
        <Link href="/guides/claude-mcp-social-media" className="text-hp-primary-text underline">schedule posts from Claude</Link>.
      </>
    ),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    where: '.cursor/mcp.json in a project, or ~/.cursor/mcp.json for all projects',
    code: CURSOR_JSON,
  },
  {
    id: 'vscode',
    name: 'VS Code (Copilot agent mode)',
    where: '.vscode/mcp.json in your workspace',
    code: VSCODE_JSON,
    note: 'VS Code tries Streamable HTTP first and falls back to SSE. Open Copilot Chat in Agent mode to use the tools.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    where: "Windsurf's mcp_config.json",
    code: WINDSURF_JSON,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    where: '~/.codex/config.toml',
    code: CODEX_TOML,
    note: (
      <>
        Codex reads the key from the <code className="font-mono">HOOKPOST_API_KEY</code> environment variable and sends it as a
        Bearer token, so the key never sits in the file.
      </>
    ),
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    where: '~/.gemini/settings.json',
    code: GEMINI_JSON,
    note: (
      <>
        Use <code className="font-mono">httpUrl</code>, not <code className="font-mono">url</code>: in Gemini CLI,{' '}
        <code className="font-mono">url</code> means an SSE server.
      </>
    ),
  },
];

const FAQ = [
  {
    q: 'What is a social media MCP server?',
    a: `An MCP (Model Context Protocol) server gives an AI assistant tools it can call. Hookpost's lists your connected channels, reads each network's rules and creates posts, so you can ask Claude or Cursor to draft and schedule posts on ${publishedList} instead of copying text into a scheduler.`,
  },
  {
    q: 'Which Hookpost plan includes the MCP server?',
    a: `Through the Claude or ChatGPT connector (OAuth, no API key): ${OAUTH_PLAN_NOTE} ${API_KEY_PLAN_NOTE.replace(/\.$/, '')}: the Hookpost plan (${monthly(USD_HOOKPOST_MONTH, HOOKPOST.month_price)}), under Settings > Developers.`,
  },
  {
    q: 'Can an AI agent publish without me reviewing it?',
    a: 'It can, if you ask it to: the schedule tool creates drafts, scheduled posts or posts that go out now. Ask for drafts and review them in the calendar first. Most MCP clients, including Claude Code, also ask your permission before they run a tool.',
  },
  {
    q: 'Does the AI see my social media passwords or tokens?',
    a: 'No. Network tokens stay on Hookpost’s servers and the tools return channel names and ids, never credentials. The text of the posts, and anything the assistant reads to write them, does pass through the AI model you use.',
  },
  {
    q: 'Can the agent delete or edit posts?',
    a: 'It can change the network settings of a post that has not gone out. There is no delete tool, and no tool changes a post’s text or date or reads analytics. Do those in the Hookpost app.',
  },
  {
    q: 'Does it work with ChatGPT?',
    a: `Yes, as a custom MCP server: in ChatGPT add ${CHATGPT_MCP_URL} with OAuth sign-in, then sign in to Hookpost and press Authorize. No API key is needed for it. ${OAUTH_PLAN_NOTE} ${CHATGPT_SIDE_NOTE} ${CHATGPT_TESTED}`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Hookpost MCP Server: Claude, Cursor & VS Code Setup',
  description: `Connect ChatGPT, Claude, Cursor, VS Code, Windsurf, Codex or Gemini CLI to Hookpost's hosted MCP server; your AI assistant drafts and schedules posts to Instagram, X, LinkedIn and more.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Hookpost MCP server: setup for Claude, Cursor and VS Code',
    description: `One hosted MCP server for ChatGPT, Claude, Cursor, VS Code, Windsurf, Codex and Gemini CLI. Posts land in your Hookpost calendar.`,
    url: CANONICAL,
    type: 'article',
  },
});

const Code = ({ children }: { children: string }) => (
  <pre className="mt-3 overflow-x-auto rounded-xl border border-hp-border bg-hp-surface p-4 text-xs leading-relaxed font-mono text-hp-text/85">
    {children}
  </pre>
);

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-hp-primary-text underline">
    {children}
  </Link>
);

export default function McpPage() {
  const inrOffer = {
    '@type': 'Offer',
    name: 'Hookpost plan',
    price: String(HOOKPOST_PRICE.displayUsd),
    priceCurrency: 'USD',
  };
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${CANONICAL}#mcp-server`,
        name: 'Hookpost MCP server',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any (hosted, Streamable HTTP)',
        url: CANONICAL,
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        isPartOf: { '@id': 'https://hookpost.hookstep.in/#app' },
        description: `Hosted Model Context Protocol server that lets AI assistants such as Claude Code, Cursor and VS Code list channels and create draft or scheduled posts on ${publishedList}.`,
        // The server authenticates with an API key, which Settings only issues on
        // the Hookpost plan, the only plan with public_api.
        offers: usdCopy(inrOffer, [
          inrOffer,
          ...usdOffers(['HOOKPOST']).map((o) => ({ ...o, name: 'Hookpost plan' })),
        ]),
      },
      {
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to connect an AI assistant to Hookpost over MCP',
        step: STEPS.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'MCP server', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />
      {/* One currency answer for the trial terms in the hero and under Plans. */}
      <VisitorCurrencyProvider ask={!!MCP_TRIAL_TERMS?.usd}>
        <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
          <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">MCP server · Claude, ChatGPT, Cursor and more</p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
            Connect Claude, Cursor or any MCP client to Hookpost
          </h1>
          <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
            Hookpost runs a hosted MCP server. Paste one URL into Claude or ChatGPT and the assistant can see your connected channels,
            read each network&apos;s rules and save posts to your Hookpost calendar as drafts or scheduled posts. In the 30 days to{' '}
            {PUBLISHED_CHECKED}, Hookpost published posts on {publishedList};{' '}
            <A href="/channels">{PUBLISHABLE_CHANNEL_COUNT} networks can be connected</A> in all.
          </p>

          {/* The setup that needs nothing but a URL comes first (mcp-setup.ts). */}
          <div
            data-testid="mcp-quick-start"
            className="mt-8 max-w-[900px] rounded-2xl border border-hp-primary/40 bg-hp-primary/[0.05] p-6"
          >
            <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">One-line setup: no API key</h2>
            <div className="mt-4 grid gap-5 md:grid-cols-2">
              <div className="min-w-0">
                <h3 className="font-bold font-jakarta">Claude</h3>
                <p className="mt-1 text-xs font-mono text-hp-text/50">Customize → Connectors → + Add → Add custom connector</p>
                <Code>{CLAUDE_MCP_URL}</Code>
              </div>
              <div className="min-w-0">
                <h3 className="font-bold font-jakarta">ChatGPT</h3>
                <p className="mt-1 text-xs font-mono text-hp-text/50">Plugins → + → Add custom MCP server · OAuth</p>
                <Code>{CHATGPT_MCP_URL}</Code>
              </div>
            </div>
            <ol className="mt-5 flex list-decimal flex-col gap-2 ps-6 text-hp-text/80">
              {STEPS.map((s) => (
                <li key={s.name} className="min-w-0 break-words">
                  <strong className="text-hp-text">{s.name}.</strong> {s.text}
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-hp-text/75">{OAUTH_PLAN_NOTE}</p>
          </div>

          <p className="mt-8 max-w-[70ch] text-hp-text/75">
            {API_KEY_PLAN_NOTE} From{' '}
            <strong className="text-hp-text">
              {usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month`, `${USD_HOOKPOST_MONTH} a month (${HOOKPOST_DISPLAY_PRICE} in India)`)}
            </strong>
            .
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/auth" prefetch={false} className="rounded-full border border-hp-primary px-6 py-3 font-semibold hover:bg-hp-primary/10">
              Get an API key
            </Link>
            <a href="#setup" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
              Setup for your client
            </a>
            <a href="#cli" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
              Post from the terminal
            </a>
          </div>
          {MCP_TRIAL_TERMS ? (
            <p className="mt-5 max-w-[70ch] text-sm text-hp-text/65">
              {/* The lines the dollar terms take (measured 22 Oct: 6 at 375-430px,
                  4 from sm, 3 from md), so for most visitors the answer moves nothing. */}
              <TrialTerms {...MCP_TRIAL_TERMS} lines={[6, 4, 3]}>
                {' '}
                <A href="/cancellation-policy">How to cancel</A>
              </TrialTerms>
            </p>
          ) : null}
          <p className="mt-6 text-sm text-hp-text/50">By the Hookpost team · Updated {SETUP_CHECKED}</p>
        </section>

        <section id="setup" className="mx-auto w-full max-w-[1100px] scroll-mt-24 px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Set it up in your client</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Claude and ChatGPT connect with the URLs above and a sign-in. Every other client talks to the same endpoint, <code className="font-mono text-hp-text">{MCP_URL}</code>, with your key in an{' '}
            <code className="font-mono">Authorization: Bearer</code> header. Copy the key from Settings → Developers in Hookpost (the
            app also generates these snippets with your key filled in). For a client that cannot send headers, put the key in the path:{' '}
            <code className="font-mono break-all">{MCP_URL_WITH_KEY}</code>. Behind a gateway that keeps the{' '}
            <code className="font-mono">Authorization</code> header for itself, such as Smithery, send the key as{' '}
            <code className="font-mono">x-hookpost-api-key: YOUR_API_KEY</code> instead; if both headers arrive,{' '}
            <code className="font-mono">Authorization</code> wins.
          </p>
          <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-3 ps-6 text-hp-text/80">
            {API_KEY_STEPS.map((s) => (
              <li key={s.name} className="min-w-0 break-words">
                <strong className="text-hp-text">{s.name}.</strong> {s.text}
              </li>
            ))}
          </ol>
          <nav aria-label="Clients" className="mt-6">
            <ul className="flex flex-wrap gap-2">
              {CLIENTS.map((c) => (
                <li key={c.id}>
                  <a href={`#${c.id}`} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                    {c.name.split(' (')[0]}
                  </a>
                </li>
              ))}
              <li>
                <a href="#chatgpt" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  ChatGPT
                </a>
              </li>
            </ul>
          </nav>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {CLIENTS.map((c) => (
              <div key={c.id} id={c.id} className="min-w-0 scroll-mt-24 rounded-2xl border border-hp-border bg-white/[0.02] p-6">
                <h3 className="text-lg font-bold font-jakarta">{c.name}</h3>
                <p className="mt-1 text-xs font-mono text-hp-text/50">{c.where}</p>
                <Code>{c.code}</Code>
                {c.note ? <p className="mt-3 text-sm text-hp-text/65">{c.note}</p> : null}
              </div>
            ))}
            <div className="min-w-0 rounded-2xl border border-hp-border bg-white/[0.02] p-6">
              <h3 className="text-lg font-bold font-jakarta">Config-file clients without HTTP support</h3>
              <p className="mt-1 text-xs font-mono text-hp-text/50">e.g. claude_desktop_config.json</p>
              <Code>{CLAUDE_DESKTOP_REMOTE_JSON}</Code>
              <p className="mt-3 text-sm text-hp-text/65">
                <code className="font-mono">mcp-remote</code> is a third-party bridge that runs locally (it needs Node.js) and forwards
                to the hosted server.
              </p>
            </div>
            <div id="chatgpt" className="min-w-0 scroll-mt-24 rounded-2xl border border-hp-border bg-white/[0.02] p-6">
              <h3 className="text-lg font-bold font-jakarta">ChatGPT</h3>
              <p className="mt-1 text-xs font-mono text-hp-text/50">Custom MCP server, OAuth sign-in (no API key)</p>
              <Code>{CHATGPT_MCP_URL}</Code>
              <ol className="mt-3 flex list-decimal flex-col gap-2 ps-5 text-sm text-hp-text/75">
                {CHATGPT_STEPS.map((step) => (
                  <li key={step} className="min-w-0 break-words">
                    {step}
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm text-hp-text/65">{OAUTH_PLAN_NOTE} {CHATGPT_SIDE_NOTE}</p>
              <p className="mt-2 text-xs text-hp-text/50">{CHATGPT_TESTED}</p>
            </div>
          </div>
        </section>

        <section id="cli" className="border-t border-hp-border scroll-mt-24">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Prefer the terminal?</h2>
            <p className="mt-4 max-w-[70ch] text-hp-text/75">
              The <code className="font-mono">hookpost</code> CLI takes the same API key. Install it from npm (it needs Node.js 18 or
              later), sign in once, and post in one line:
            </p>
            <Code>{CLI}</Code>
            <p className="mt-3 max-w-[70ch] text-sm text-hp-text/65">
              Run the commands one at a time: <code className="font-mono">hookpost auth login</code> asks for your API key, then
              the API host (press Enter to keep the default). Replace <code className="font-mono">abc123</code> with an id
              from <code className="font-mono">hookpost channels</code>.
              With no <code className="font-mono">--at</code>, the post is scheduled into the next free slot in your posting schedule;
              add <code className="font-mono">--at</code> and an ISO date for an exact time, <code className="font-mono">--now</code> to
              publish straight away or <code className="font-mono">--draft</code> to save a draft. In CI, set{' '}
              <code className="font-mono">HOOKPOST_API_KEY</code> instead of signing in.
            </p>
            <p className="mt-3 text-sm text-hp-text/55">
              <a href="https://www.npmjs.com/package/hookpost" target="_blank" rel="noreferrer" className="text-hp-primary-text underline">
                hookpost on npm
              </a>{' '}
              (its README lists every command) · More examples, and the Node SDK:{' '}
              <A href="/social-media-scheduling-api#terminal">CLI and SDK</A>
            </p>
          </div>
        </section>

        <section id="calendar" className="border-t border-hp-border scroll-mt-24">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Where agent posts land</h2>
            <p className="mt-4 max-w-[70ch] text-hp-text/75">
              In the same calendar as everything else. A post queued from Cursor sits next to the one your colleague wrote in the
              browser, so there is one place to see what goes out when.
            </p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">Drafts are marked.</strong> A draft shows as &quot;Draft:&quot; on its day and in the
                list view&apos;s draft filter. Scheduled posts show at their time.
              </li>
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">You can tell who wrote it.</strong> Open a post and the editor header shows a badge for
                how it was created: <strong className="text-hp-text">MCP</strong> for an AI assistant, API or CLI for code, WEB for the
                app.
                The share preview shows it too.
              </li>
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">Same checks as the editor.</strong> Posts from MCP go through the validation the app
                runs: character limits, media rules and required settings. A failure comes back to the assistant with the reason.
              </li>
              <li className="rounded-2xl border border-hp-border p-5">
                <strong className="text-hp-text">Failures are visible.</strong> If a network rejects a post at publish time, it turns red
                in the calendar with the error, and you get an in-app notification and, unless you turned them off, an email.
              </li>
            </ul>
          </div>
        </section>

        <section id="tools" className="border-t border-hp-border scroll-mt-24">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Tools the assistant gets</h2>
            <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                <caption className="sr-only">Hookpost MCP tools</caption>
                <thead>
                  <tr className="border-b border-hp-border-strong text-hp-text/60">
                    <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                    <th scope="col" className="py-3 pe-4 font-semibold">What it does</th>
                    <th scope="col" className="py-3 font-semibold">Input</th>
                  </tr>
                </thead>
                <tbody className="text-hp-text/80">
                  {MCP_TOOLS.map((t) => (
                    <tr key={t.name} className="border-b border-hp-border align-top">
                      <th scope="row" className="py-3 pe-4 font-mono text-xs text-hp-primary-text">{t.name}</th>
                      <td className="py-3 pe-4">{t.does}</td>
                      <td className="py-3 font-mono text-xs text-hp-text/60">{t.input}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[75ch] text-hp-text/70">{MCP_CANNOT}</p>
            <p className="mt-3 max-w-[75ch] text-sm text-hp-text/55">
              How this compares with Buffer, Hootsuite, Planoly and others:{' '}
              <A href="/social-media-mcp-servers">social media MCP servers compared</A>.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Prompts to start with</h2>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              {[
                ['Launch thread', 'List my Hookpost channels. Write a 4-post launch thread for X and one post for Bluesky about our release, check both against the network limits, and save them as drafts for tomorrow 9:00 IST.'],
                ['Blog post to LinkedIn and Threads', 'Summarise the blog post at this URL as a LinkedIn post and a shorter Threads post. Save both as drafts in Hookpost.'],
                ['Gaps in the calendar', 'List my Hookpost posts for the next 14 days. Tell me which days have nothing scheduled on LinkedIn and draft a post for each of them.'],
                ['Weekly recap', 'List every post Hookpost published in the last 7 days, group them by channel, and flag any post in ERROR state with its error.'],
              ].map(([title, prompt]) => (
                <div key={title} className="min-w-0 rounded-2xl border border-hp-border p-5">
                  <h3 className="font-bold font-jakarta">{title}</h3>
                  <p className="mt-3 rounded-lg bg-white/[0.04] p-3 font-mono text-xs leading-relaxed text-hp-text/85">{prompt}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Plans</h2>
            {/* No Free card once new users have no Free plan (trial-offer.ts). */}
            <div className={TRIAL_ONLY ? 'mt-6 grid gap-4' : 'mt-6 grid gap-4 sm:grid-cols-2'}>
              {TRIAL_ONLY ? null : (
                <div className="rounded-2xl border border-hp-border p-6">
                  <div className="text-lg font-bold font-jakarta">Free</div>
                  <p className="mt-2 text-sm text-hp-text/70">
                    No API key, but the Claude and ChatGPT connectors work. The calendar on {FREE.channel} channels with {FREE.posts_per_month} posts a month.
                  </p>
                </div>
              )}
              <div className="rounded-2xl border border-hp-primary/40 bg-hp-primary/[0.05] p-6">
                <div className="text-lg font-bold font-jakarta">Hookpost · {perMonth(USD_HOOKPOST_MONTH, HOOKPOST.month_price)}</div>
                <p className="mt-2 text-sm text-hp-text/70">
                  MCP, REST API and CLI. {HOOKPOST.channel} channels, {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month,{' '}
                  {HOOKPOST_AI_CREDITS}, {HOOKPOST_X_POSTS} and up to {HOOKPOST.team_member_limit} team members.
                </p>
              </div>
            </div>
            <p className="mt-4 text-sm text-hp-text/55">
              {usdCopy(
                'Billed in rupees through Razorpay with UPI AutoPay, cards or NetBanking.',
                'Billed in US dollars by card; in India, in rupees through Razorpay with UPI AutoPay, cards or NetBanking.'
              )}{' '}
              {MCP_TRIAL_TERMS ? (
                <>
                  {/* Until the currency is known, the fact that holds for everyone. */}
                  <TrialTerms {...MCP_TRIAL_TERMS} pending={`New workspaces get ${FREE_POSTS}, no card needed.`} />{' '}
                </>
              ) : null}
              All limits: <A href="/pricing">pricing</A>.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">How the server works</h2>
            <dl className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
              <div className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">Transport</dt>
                <dd className="mt-2 text-sm">
                  Remote Streamable HTTP at <code className="font-mono">{MCP_URL}</code>, stateless, with JSON responses. A legacy
                  HTTP+SSE route stays available for older clients. There is no stdio package to install.
                </dd>
              </div>
              <div className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">Authentication</dt>
                <dd className="mt-2 text-sm">
                  OAuth sign-in on <code className="font-mono">/mcp-oauth</code> (ChatGPT) and{' '}
                  <code className="font-mono">/mcp-oauth-claude</code> (Claude). Elsewhere, your workspace API key, as a Bearer
                  header, an <code className="font-mono">x-hookpost-api-key</code> header, or in the URL path. One key per workspace; rotating it in Settings stops
                  the old one at once.
                </dd>
              </div>
              <div className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">What the model sees</dt>
                <dd className="mt-2 text-sm">
                  Channel names and ids, network rules and your posts. Never the network tokens, which stay on Hookpost&apos;s servers.
                </dd>
              </div>
              <div className="rounded-2xl border border-hp-border p-5">
                <dt className="font-bold text-hp-text">Errors without a key</dt>
                <dd className="mt-2 text-sm">
                  <code className="font-mono">401 Missing Authorization header</code>, or{' '}
                  <code className="font-mono">401 Invalid API Key or OAuth token</code> for a wrong or rotated key.
                </dd>
              </div>
            </dl>
            <p className="mt-6 max-w-[70ch] text-hp-text/70">
              Prefer plain HTTP from your own code? The same key works with the <A href="/social-media-scheduling-api">REST API</A>, the{' '}
              <a href="#cli" className="text-hp-primary-text underline">
                <code className="font-mono">hookpost</code> CLI
              </a>{' '}
              and the <A href="/integrations/n8n">n8n node</A>.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border bg-white/[0.015]">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Questions</h2>
            <dl className="mt-8 flex flex-col gap-8">
              {FAQ.map((f) => (
                <div key={f.q} className="min-w-0">
                  <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                  <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-10 text-hp-text/60">
              Guides: <A href="/guides/claude-code-social-media">Claude Code</A>,{' '}
              <A href="/guides/claude-mcp-social-media">Claude in the browser or desktop app</A>,{' '}
              <A href="/guides/post-to-multiple-social-media-at-once">one post to several networks</A>.
            </p>
          </div>
        </section>
      </VisitorCurrencyProvider>
    </div>
  );
}
