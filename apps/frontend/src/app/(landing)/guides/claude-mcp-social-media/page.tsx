import React from 'react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Metadata } from 'next';
import { SiteNav } from '../../site-nav';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { withSocial } from '../../social-meta';
import { CLAUDE_DESKTOP_REMOTE_JSON, MCP_URL, MCP_URL_WITH_KEY } from '../../mcp/mcp-setup';
import { FREE_POSTS, offer } from '../../trial-offer';
import { planPrice, planPriceInParens } from '../../usd-offer';

// The Claude chat intent: claude.ai and the Claude Desktop app. The terminal
// workflow moved to /guides/claude-code-social-media on 11 Oct 2026 so the two
// pages do not compete for the same queries.
//
// - Remote MCP servers are added in Claude as custom connectors (Customize >
//   Connectors > + Add > Add custom connector), which accept a URL with no
//   sign-in or with fixed request headers; free Claude accounts get one custom
//   connector (support.claude.com 11175166, re-read 11 Oct). claude_desktop_config.json is for
//   local servers, so the file route uses the mcp-remote bridge.
// - Nobody has run the custom-connector steps end to end with a real key, so
//   they are written as plain steps with no claim of a test, plus one line
//   pointing to the config-file method if Claude cannot connect.
// - Instagram: a publish from an ordinary customer account is not confirmed
//   yet (11 Oct), so the copy says posts publish once Meta access is
//   confirmed, not that they publish today. Personal accounts: Instagram's API only lets apps
//   publish automatically to Business or Creator accounts (other tools reach
//   personal ones through reminder publishing), so no "no scheduler can" line.
// - The no-key OAuth endpoint is not offered here until someone completes its
//   browser sign-in end to end.
// - The old example prompt asking Claude to analyse past tweets was removed:
//   the MCP tools return no analytics.
const CANONICAL = 'https://hookpost.hookstep.in/guides/claude-mcp-social-media';

const STEPS: { name: string; text: string }[] = [
  {
    name: 'Connect your channels and copy the API key',
    text: `In Hookpost, connect the networks you post to, then copy the API key from Settings > Developers. The key comes with the Hookpost plan (${planPriceInParens('HOOKPOST', ' a month')}).`,
  },
  {
    name: 'Add Hookpost as a custom connector in Claude',
    text: `In Claude, open Customize > Connectors > + Add > Add custom connector. Name it Hookpost, paste ${MCP_URL_WITH_KEY} with your key in place of YOUR_API_KEY, and choose no sign-in.`,
  },
  {
    name: 'Ask Claude to draft',
    text: 'In a chat, ask Claude to list your Hookpost channels and save posts as drafts. Review them in the Hookpost calendar, then schedule them there or ask Claude to schedule them.',
  },
];

const FAQ = [
  {
    q: 'Can Claude schedule social media posts?',
    a: `Yes, once it is connected to a scheduler. With Hookpost added as a connector, Claude can list your channels, read each network's rules and save drafts or scheduled posts for ${PUBLISHABLE_CHANNEL_COUNT} networks. Hookpost publishes them at the set time, with Claude closed.`,
  },
  {
    q: 'Can Claude post to Instagram?',
    a: 'Through Hookpost, to an Instagram Business or Creator account you have connected: Instagram’s API only lets apps publish automatically to Business or Creator accounts. Hookpost connects Instagram through Meta’s sign-in, and posts publish at the set time once Meta access is confirmed. Every Instagram post needs at least one image or video, so give Claude a public image URL (it imports it with the uploadFromUrlTool) or attach the media in Hookpost before scheduling.',
  },
  {
    q: 'Can Claude post to LinkedIn?',
    a: 'To your personal LinkedIn profile, yes: text up to 3,000 characters, images, a video or an image carousel. LinkedIn Company Pages are not available in Hookpost.',
  },
  {
    q: 'Does Claude see my social media passwords?',
    a: 'No. Network tokens stay on Hookpost’s servers and the tools return only channel names and ids. The post text Claude writes, and whatever you paste into the chat, goes through Claude like any other conversation.',
  },
  {
    q: 'Is it free?',
    a: `The connector itself costs nothing, and Claude's free plan allows one custom connector. Hookpost's side needs the Hookpost plan (${planPriceInParens('HOOKPOST', ' a month')})${offer(', because the Free plan has no API key', `, ${FREE_POSTS} included`)}.`,
  },
  {
    q: 'I use Claude Code in the terminal. Is the setup different?',
    a: 'Yes, it is one claude mcp add command, and it can be shared with your team through .mcp.json. See the Claude Code guide.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Schedule Social Media Posts with Claude | Hookpost',
  description: `Add Hookpost to claude.ai or Claude Desktop as a custom connector, and Claude can draft and schedule posts to LinkedIn, X, YouTube and ${PUBLISHABLE_CHANNEL_COUNT - 3} more networks.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'How to schedule social media posts with Claude',
    description: 'Add Hookpost as a custom connector in claude.ai or Claude Desktop and let Claude save drafts to your calendar.',
    url: CANONICAL,
    type: 'article',
  },
});

const Code = ({ children }: { children: string }) => (
  <pre className="mt-3 overflow-x-auto rounded-xl border border-hp-border bg-white/[0.03] p-4 text-xs leading-relaxed font-mono text-hp-text/90">
    {children}
  </pre>
);

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-hp-primary-text underline">
    {children}
  </Link>
);

export default function ClaudeMcpGuidePage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${CANONICAL}#article`,
        headline: 'How to schedule social media posts with Claude',
        url: CANONICAL,
        inLanguage: 'en',
        datePublished: '2026-09-02T08:00:00+00:00',
        dateModified: '2026-10-11T00:00:00+05:30',
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        speakable: { '@type': 'SpeakableSpecification', cssSelector: ['h1', '.article-summary'] },
      },
      {
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to schedule social media posts with Claude and Hookpost',
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
          { '@type': 'ListItem', position: 3, name: 'Schedule posts with Claude', item: CANONICAL },
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
          <Link href="/guides" className="hover:text-hp-primary-text">Guides</Link> / Claude
        </nav>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          How to schedule social media posts with Claude
        </h1>
        <p className="article-summary mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Claude cannot reach your social accounts on its own. Add Hookpost to Claude as a custom connector, with the MCP address
          that carries your API key, and Claude can list your channels, follow each network&apos;s limits and save posts to your
          Hookpost calendar as drafts or scheduled posts. Hookpost then publishes them at the time set.
        </p>
        <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-3 ps-6 text-hp-text/80">
          {STEPS.map((s) => (
            <li key={s.name} className="min-w-0 break-words">
              <strong className="text-hp-text">{s.name}.</strong> {s.text}
            </li>
          ))}
        </ol>
        <p className="mt-4 text-sm text-hp-text/50">By the Hookpost team · Updated 11 October 2026</p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Before you start</h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3 text-hp-text/80">
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">The Hookpost plan.</strong> The API key the connector uses comes with it at{' '}
            {planPrice('HOOKPOST', ' a month')}. {offer('The Free plan has none.', `The ${FREE_POSTS} includes it.`)}
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Channels connected in Hookpost.</strong> X, LinkedIn, YouTube, an Instagram Business or
            Creator account, and <A href="/channels">the rest</A>. Claude cannot connect a channel for you.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">A Claude account.</strong> Claude&apos;s free plan allows one custom connector; paid plans
            allow more.
          </li>
        </ul>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
            Method 1: add a custom connector (claude.ai and Claude Desktop)
          </h2>
          <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-4 ps-6 text-hp-text/80">
            <li>
              In Hookpost, open <strong className="text-hp-text">Settings → Developers</strong> and copy your API key.
            </li>
            <li>
              In Claude, open <strong className="text-hp-text">Customize → Connectors → + Add → Add custom connector</strong>.
            </li>
            <li>
              Name it Hookpost and paste this URL with your key in place of <code className="font-mono">YOUR_API_KEY</code>:
              <Code>{MCP_URL_WITH_KEY}</Code>
            </li>
            <li>
              Choose <strong className="text-hp-text">no sign-in</strong>, since the key is already in the URL. If you would rather keep
              the key out of the URL, use <code className="font-mono break-all">{MCP_URL}</code> and add a request header{' '}
              <code className="font-mono break-all">Authorization: Bearer YOUR_API_KEY</code>.
            </li>
            <li>Start a chat and ask: &quot;List my Hookpost channels.&quot;</li>
          </ol>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            If Claude can&apos;t connect this way, use Method 2 below in Claude Desktop.
          </p>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Treat that URL like a password: anyone who has it can post to your channels. If it leaks, press Rotate next to the key in
            Hookpost and the old URL stops working.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
            Method 2: the Claude Desktop config file
          </h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            <code className="font-mono">claude_desktop_config.json</code> starts local programs, so a hosted server needs a small
            bridge. <code className="font-mono">mcp-remote</code> (a third-party package, run through npx, needs Node.js) does that.
            Open the file from Claude Desktop&apos;s Settings → Developer → Edit Config, or at{' '}
            <code className="font-mono break-all">~/Library/Application Support/Claude/claude_desktop_config.json</code> on macOS and{' '}
            <code className="font-mono break-all">%APPDATA%\Claude\claude_desktop_config.json</code> on Windows:
          </p>
          <Code>{CLAUDE_DESKTOP_REMOTE_JSON}</Code>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">Quit and reopen Claude Desktop; the Hookpost tools then appear in the chat&apos;s tools menu.</p>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Working in the terminal instead? <A href="/guides/claude-code-social-media">Schedule posts from Claude Code</A> covers the
            one-line setup, sharing it with a team and running it in CI.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Prompts to try</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {[
              ['A launch on two networks', 'List my Hookpost channels. We shipped version 2.0 today. Write an X thread of up to 4 posts and a LinkedIn post about it, and save both as drafts for tomorrow 10:00 IST.'],
              ['A week of LinkedIn posts', 'Here are my notes for the week. Turn them into five LinkedIn posts under 1,300 characters each and save them as drafts, Monday to Friday at 9:30 IST.'],
              ['Reuse a blog post', 'Summarise the article I pasted as a Threads post and a Bluesky post, each inside its limit, and save them as drafts.'],
              ['Check the queue', 'What is scheduled in Hookpost for the next 7 days, by channel? Is anything in ERROR state?'],
            ].map(([title, prompt]) => (
              <div key={title} className="min-w-0 rounded-2xl border border-hp-border p-5">
                <h3 className="font-bold font-jakarta">{title}</h3>
                <p className="mt-3 rounded-lg bg-white/[0.04] p-3 font-mono text-xs leading-relaxed text-hp-text/85">{prompt}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            The drafts appear in your Hookpost calendar. Open one and the editor shows an MCP badge, so you know Claude wrote it.
            Edit, move or delete it there; Claude can create posts and change a pending post&apos;s settings, but it cannot delete
            posts, change their text or date, or read analytics.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What goes where</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Stays on Hookpost:</strong> the tokens that let Hookpost post to X, LinkedIn, YouTube and
              the rest. The tools hand Claude channel names and ids, never credentials.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Goes through Claude:</strong> the posts it writes and anything you paste or upload into
              the chat. That is the same as any Claude conversation, under your Claude plan&apos;s terms.
            </li>
          </ul>
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
            Configs for Cursor, VS Code, Windsurf, Codex and Gemini CLI, and every tool the server exposes: <A href="/mcp">MCP server</A>.
            Other schedulers with MCP servers: <A href="/social-media-mcp-servers">compared</A>.
          </p>
        </div>
      </section>
    </div>
  );
}
