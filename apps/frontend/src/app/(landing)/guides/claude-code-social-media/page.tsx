import { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import {
  CLAUDE_CODE_CMD,
  CLAUDE_CODE_PROJECT_CMD,
  CLAUDE_CODE_PROJECT_JSON,
} from '../../mcp/mcp-setup';
import { FREE_POSTS, offer } from '../../trial-offer';
import { USD_HOOKPOST_MONTH, usdCopy } from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';

// Targets "schedule social media posts from claude code", "claude code social
// media", "claude code mcp social media", "post to linkedin from terminal".
// Claude chat (claude.ai / Desktop) is a separate intent and lives at
// /guides/claude-mcp-social-media; this page is the terminal workflow.
//
// What is verified, and where:
// - Commands and endpoint: mcp/mcp-setup.ts (start.mcp.ts + Claude Code docs:
//   --header, --scope project writes .mcp.json, ${VAR} expansion in url and
//   headers, claude mcp list, mcp__<server>__<tool> names, -p / --allowedTools).
// - Error strings: live responses on 11 Oct 2026 without a key: no header ->
//   401 "Missing Authorization header"; wrong key -> 401 "Invalid API Key or
//   OAuth token".
// - Drafts: integrationSchedulePostTool takes type draft | schedule | now, and
//   marks posts creationMethod MCP (integration.schedule.post.ts). The editor
//   header and the share preview show that badge to every user; the calendar
//   grid only shows it to admins, so this page does not claim a calendar badge.
// - Failures: post.workflow.v1.1.3.ts sets ERROR (red ring + message in the
//   calendar), creates an in-app notification and emails members who keep
//   failure emails on.
// - Plan gate: public_api is false on FREE, so the Developers tab (and the key)
//   does not exist on Free. MCP does not check monthly quotas itself, so no
//   MCP-specific post limit is printed.
// - CLI: npm hookpost 0.1.1 (npm view, 11 Oct, published 15:25 UTC from
//   0174afae). 0.1.1 takes several channels per post: --channel a,b or a
//   repeated --channel (apps/cli/src/index.ts flags()).
// - OAuth sign-in (/mcp-oauth-claude) is deliberately absent: untested end to end.
const CANONICAL = 'https://hookpost.hookstep.in/guides/claude-code-social-media';
const PUBLISHED = '2026-10-11';

const { HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;
// Cached for every visitor, so once dollars are sold (usd-offer.ts) the page
// states both prices rather than the rupee one alone.
// The one shown price ("$7", pricing.ts HOOKPOST_PRICE); no rupee figure.
const monthly = (_usd: string, _rupees: number) => `${HOOKPOST_DISPLAY_PRICE} a month`;
const inIndia = (_usd: string, _rupees: number) => HOOKPOST_DISPLAY_PRICE;

const FIRST_PROMPT = `List my Hookpost channels. Then read CHANGELOG.md, write a short post about
the newest release for LinkedIn and a shorter one for X, and save both as
drafts in Hookpost. Don't schedule anything yet.`;

const HEADLESS = `claude -p "Read CHANGELOG.md and save a LinkedIn draft in Hookpost about the newest release" \\
  --allowedTools "Read,mcp__hookpost__integrationList,mcp__hookpost__integrationSchema,mcp__hookpost__integrationSchedulePostTool"`;

const CLI = `npm install -g hookpost
export HOOKPOST_API_KEY="your_key"     # or: hookpost auth login

hookpost channels                      # ids of your connected channels
hookpost post "v2.3 is out: faster exports and a new CSV importer." \\
  --channel abc123,def456 --draft      # one post, two channels
hookpost posts --days 7                # what is queued for the next week`;

const PROMPTS: { title: string; prompt: string; note: string }[] = [
  {
    title: 'Release notes to several networks',
    prompt:
      'Read the last 20 commits with git log and the newest CHANGELOG.md entry. Write one LinkedIn post, one X post under 280 characters and one Bluesky post under 300. Save all three as Hookpost drafts for tomorrow 10:00 IST.',
    note: 'Claude reads the repo with its own tools, checks each network’s rules with integrationSchema, then creates the drafts.',
  },
  {
    title: 'A thread from a README section',
    prompt:
      'Turn the "How it works" section of README.md into a 5-post thread for X. Keep every post under 280 characters and save it as one draft.',
    note: 'The first item of postsAndComments is the post; the rest become the thread.',
  },
  {
    title: 'Fill the empty days next week',
    prompt:
      'List my Hookpost posts for next Monday to Friday. For any day with nothing scheduled, draft a LinkedIn post from docs/blog/ and save it as a draft on that day at 09:30 IST.',
    note: 'postsListTool returns what is already queued; Claude picks the gaps.',
  },
  {
    title: 'Check what failed',
    prompt: 'Which Hookpost posts from the last 7 days are in ERROR state, and what does the error say?',
    note: 'Fix and retry the post in the app; the MCP tools cannot edit post text.',
  },
];

const STEPS: { name: string; text: string }[] = [
  {
    name: 'Connect your channels and copy your API key',
    text: `In Hookpost, connect the networks you want to post to, then open Settings > Developers and copy the API key. The Developers tab is on the Hookpost plan (${monthly(USD_HOOKPOST_MONTH, HOOKPOST.month_price)})${offer('; the Free plan has no API key', `, ${FREE_POSTS} included`)}.`,
  },
  {
    name: 'Add Hookpost to Claude Code',
    text: `Run: claude mcp add --transport http hookpost https://hookpost.hookstep.in/api/mcp --header "Authorization: Bearer YOUR_API_KEY". Then run claude mcp list to check that the server connects.`,
  },
  {
    name: 'Ask for drafts first',
    text: 'Start claude in your project and ask it to list your Hookpost channels, then to save posts as drafts rather than schedule them. Review the drafts in the Hookpost calendar before anything goes out.',
  },
  {
    name: 'Schedule when you trust the output',
    text: 'Ask Claude to schedule posts for a date and time instead of saving drafts. Hookpost stores them and publishes at that time, whether or not your terminal is open.',
  },
];

const FAQ = [
  {
    q: 'Do I need an API key to use Hookpost from Claude Code?',
    a: `Yes. Copy it from Settings > Developers in Hookpost and pass it in the Authorization header when you add the server. The Developers tab exists on the Hookpost plan (${monthly(USD_HOOKPOST_MONTH, HOOKPOST.month_price)})${offer(', not on the Free plan', `, ${FREE_POSTS} included`)}. Rotating the key in Settings stops the old one working at once.`,
  },
  {
    q: 'Does Claude get access to my social media logins?',
    a: 'No. Your X, LinkedIn or YouTube tokens stay on Hookpost’s servers, and the MCP tools return channel names and ids, never credentials. What does go through Claude is the text it writes and anything it reads from your project, so keep secrets out of the files you ask it to summarise.',
  },
  {
    q: 'Does Claude Code have to stay open until the post is published?',
    a: 'No. Once Claude creates a scheduled post, Hookpost stores it and publishes at the time set. You can close the terminal.',
  },
  {
    q: 'Can Claude delete or reschedule a post?',
    a: 'Not through MCP. There is no delete tool, on purpose, and no tool changes a post’s text or date. Claude can change the network settings of a post that has not gone out yet. Delete or move posts in the Hookpost calendar, or delete one with the CLI: hookpost delete <postId>.',
  },
  {
    q: 'What happens if a scheduled post fails?',
    a: 'The post turns red in the calendar with the network’s error message, Hookpost adds an in-app notification, and workspace members who keep failure emails on get an email. You can also ask Claude to list posts in ERROR state.',
  },
  {
    q: 'Does the same setup work in Cursor, VS Code or Windsurf?',
    a: 'Yes, the server is the same and only the config format changes. Copy-paste configs for each editor are on the MCP page.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Schedule Social Media Posts from Claude Code | Hookpost',
  description:
    'Add Hookpost to Claude Code with one command, then let Claude draft and schedule posts to X, LinkedIn, Bluesky and more. Posts land in one calendar.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Schedule social media posts from Claude Code',
    description: 'One claude mcp add command, drafts first, and every post lands in the Hookpost calendar.',
    url: CANONICAL,
    type: 'article',
  },
});

const Code = ({ children, label }: { children: string; label?: string }) => (
  <div className="mt-3 min-w-0">
    {label ? <p className="mb-1 font-mono text-xs text-hp-text/50">{label}</p> : null}
    <pre className="overflow-x-auto rounded-xl border border-hp-border bg-white/[0.03] p-4 text-xs leading-relaxed font-mono text-hp-text/90">
      {children}
    </pre>
  </div>
);

const A = ({ href, children }: { href: string; children: ReactNode }) =>
  href.startsWith('http') ? (
    <a href={href} className="text-hp-primary-text underline" rel="nofollow noopener" target="_blank">
      {children}
    </a>
  ) : (
    <Link href={href} className="text-hp-primary-text underline">
      {children}
    </Link>
  );

export default function ClaudeCodeSocialMediaGuide() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${CANONICAL}#article`,
        headline: 'Schedule social media posts from Claude Code',
        url: CANONICAL,
        inLanguage: 'en',
        datePublished: PUBLISHED,
        dateModified: PUBLISHED,
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        about: [
          { '@type': 'Thing', name: 'Claude Code' },
          { '@type': 'Thing', name: 'Model Context Protocol' },
        ],
      },
      {
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to schedule social media posts from Claude Code with Hookpost',
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
          { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://hookpost.hookstep.in/guides' },
          { '@type': 'ListItem', position: 3, name: 'Claude Code', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <Link href="/guides" className="hover:text-hp-primary-text">Guides</Link> / Claude Code
        </nav>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Schedule social media posts from Claude Code
        </h1>
        <p className="article-summary mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Add Hookpost to Claude Code with one <code className="font-mono text-hp-text">claude mcp add</code> command and your API key.
          Then ask Claude to write posts from your changelog, README or git log and save them to Hookpost as drafts or scheduled
          posts. They land in the same calendar as the posts you write by hand, and Hookpost publishes them at the set time.
        </p>
        <p className="mt-4 text-sm text-hp-text/50">By the Hookpost team · Checked against the product on 11 October 2026</p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What you need</h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3 text-hp-text/80">
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">The Hookpost plan.</strong> Hookpost is{' '}
            {usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month`, `${USD_HOOKPOST_MONTH} a month (${HOOKPOST_DISPLAY_PRICE} in India)`)} for{' '}
            {HOOKPOST.channel} channels and {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month.
            {' '}
            {offer('The Free plan has no API key, so it cannot connect.', `The ${FREE_POSTS} includes the key.`)}
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Channels connected in Hookpost.</strong> Claude can post to channels you have already
            connected. It cannot connect a new one, because each network signs you in through its own page.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Your API key.</strong> Settings → Developers → Reveal → Copy. There is one key per
            workspace; Rotate replaces it and the old one stops working.
          </li>
        </ul>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">The setup in four steps</h2>
          {/* The same STEPS feed the HowTo markup, so the two always match. */}
          <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-4 ps-6 text-hp-text/80">
            {STEPS.map((s) => (
              <li key={s.name} className="min-w-0 break-words">
                <strong className="text-hp-text">{s.name}.</strong> {s.text}
              </li>
            ))}
          </ol>
          <p className="mt-6 max-w-[70ch] text-hp-text/60">Each step in detail below.</p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Step 1: add the server</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Run this in your terminal with your own key in place of <code className="font-mono">YOUR_API_KEY</code>. It adds a server
            called <code className="font-mono">hookpost</code> for you, in every project:
          </p>
          <Code>{CLAUDE_CODE_CMD}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Check it with <code className="font-mono">claude mcp list</code>. The hosted endpoint speaks Streamable HTTP and needs
            nothing installed on your machine.
          </p>

          <h3 className="mt-10 text-xl font-bold font-jakarta">Share it with your team (optional)</h3>
          <p className="mt-3 max-w-[70ch] text-hp-text/75">
            Add <code className="font-mono">--scope project</code> and Claude Code writes the server to{' '}
            <code className="font-mono">.mcp.json</code> at the root of the repo, so everyone who clones it gets the same setup. Keep
            the key out of git by referencing an environment variable; Claude Code expands it in the URL and headers. Note the
            single quotes, which stop your shell from writing the key itself into the file:
          </p>
          <Code>{CLAUDE_CODE_PROJECT_CMD}</Code>
          <Code label=".mcp.json (commit this)">{CLAUDE_CODE_PROJECT_JSON}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Each person sets <code className="font-mono">HOOKPOST_API_KEY</code> in their own shell. Claude Code asks for approval
            the first time it sees a project-scoped server.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Step 2: ask for drafts first</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Start <code className="font-mono">claude</code> in your project and give it a job. Asking for drafts means nothing is
            published until you have read it:
          </p>
          <Code label="prompt">{FIRST_PROMPT}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">What happens next, tool by tool:</p>
          <ol className="mt-4 flex max-w-[75ch] list-decimal flex-col gap-3 ps-6 text-hp-text/75">
            <li>
              <code className="font-mono text-hp-text">integrationList</code> returns your connected channels with their ids.
            </li>
            <li>
              <code className="font-mono text-hp-text">integrationSchema</code> returns each network&apos;s rules: 3,000 characters on
              LinkedIn, 280 on X (4,000 on a Premium account), and any settings the post needs.
            </li>
            <li>
              <code className="font-mono text-hp-text">integrationSchedulePostTool</code> creates the posts with{' '}
              <code className="font-mono">type: &quot;draft&quot;</code>. Hookpost runs the same checks as its own editor, and if
              something is wrong the tool returns the error so Claude can fix it and try again.
            </li>
          </ol>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            Claude Code asks your permission before it calls a tool unless you have already allowed it. When the drafts look right,
            ask Claude to schedule them for a date and time instead, or open them in Hookpost and schedule them there.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Where the posts go</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Into the calendar you already use.</strong> Drafts show as &quot;Draft:&quot; on their
              day, and scheduled posts sit next to the ones your team wrote in the browser. Open one and the editor header shows an{' '}
              <strong className="text-hp-text">MCP</strong> badge, so you can tell which posts an agent wrote.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Edit, move or delete in the app.</strong> Drag a post to another day, change its text,
              or delete it. Claude can change a pending post&apos;s network settings, but not its text or date, and it cannot delete
              anything.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Published by Hookpost, not by your terminal.</strong> Scheduled posts are stored on the
              server and go out at their time with Claude Code closed.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Failures are visible.</strong> A post a network rejects turns red in the calendar with
              the error, you get an in-app notification, and members who keep failure emails on get an email.
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Prompts that work well from a repo</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {PROMPTS.map((p) => (
              <div key={p.title} className="min-w-0 rounded-2xl border border-hp-border p-5">
                <h3 className="font-bold font-jakarta text-hp-text">{p.title}</h3>
                <p className="mt-3 rounded-lg bg-white/[0.04] p-3 font-mono text-xs leading-relaxed text-hp-text/85">{p.prompt}</p>
                <p className="mt-3 text-sm text-hp-text/60">{p.note}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Posting the same news to several networks? The{' '}
            <A href="/guides/post-to-multiple-social-media-at-once">limits table for every network</A> shows what breaks when one text
            goes everywhere. Publishing full articles to Dev.to, Hashnode or WordPress is covered in{' '}
            <A href="/guides/cross-post-dev-articles">cross-posting dev articles</A>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Unattended runs and CI</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            <code className="font-mono">claude -p</code> runs one prompt without the interactive session. MCP tools are named{' '}
            <code className="font-mono">mcp__hookpost__&lt;tool&gt;</code>, and listing them in{' '}
            <code className="font-mono">--allowedTools</code> lets the run call them without stopping to ask. The schedule tool can still publish straight away if the prompt asks
            for it, so ask for drafts in jobs nobody watches:
          </p>
          <Code>{HEADLESS}</Code>
          <h3 className="mt-10 text-xl font-bold font-jakarta">Or skip MCP and use the CLI</h3>
          <p className="mt-3 max-w-[70ch] text-hp-text/75">
            If a script already knows the text, the <code className="font-mono">hookpost</code> CLI on npm (version 0.1.1) talks to
            the same account without a model in the loop. Claude Code can run it too.
          </p>
          <Code>{CLI}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            Leave out <code className="font-mono">--at</code> and the post takes the next free slot in your posting schedule. More on
            the CLI, the REST API and the Node SDK: <A href="/social-media-scheduling-api">social media scheduling API</A>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">If it does not connect</h2>
          <dl className="mt-6 flex max-w-[75ch] flex-col gap-5 text-hp-text/75">
            <div>
              <dt className="font-mono text-hp-text">401 Missing Authorization header</dt>
              <dd className="mt-1">The <code className="font-mono">--header</code> part did not make it into the config. Run{' '}
                <code className="font-mono">claude mcp remove hookpost</code> and add it again with the header.</dd>
            </div>
            <div>
              <dt className="font-mono text-hp-text">401 Invalid API Key or OAuth token</dt>
              <dd className="mt-1">The key is wrong or was rotated. Copy it again from Settings → Developers. With the project setup,
                check that <code className="font-mono">HOOKPOST_API_KEY</code> is set in the shell you started Claude Code from.</dd>
            </div>
            <div>
              <dt className="text-hp-text">No Developers tab in Settings</dt>
              <dd className="mt-1">{offer('The workspace is on the Free plan.', 'The workspace has no plan yet, or is on the original free tier.')} The key and MCP come with the Hookpost plan.</dd>
            </div>
            <div>
              <dt className="text-hp-text">A channel is missing from the list</dt>
              <dd className="mt-1">Connect it in Hookpost first; the list only holds channels the workspace has connected. A channel that
                needs reconnecting shows up but cannot publish until you reconnect it in the app.</dd>
            </div>
          </dl>
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
            Using Claude in the browser or the desktop app instead?{' '}
            <A href="/guides/claude-mcp-social-media">Schedule posts from Claude</A>. Configs for Cursor, VS Code, Windsurf, Codex
            and Gemini CLI: <A href="/mcp#cursor">the MCP page</A>. Every tool the server exposes:{' '}
            <A href="/mcp#tools">tool reference</A>.
          </p>
        </div>
      </section>
    </div>
  );
}
