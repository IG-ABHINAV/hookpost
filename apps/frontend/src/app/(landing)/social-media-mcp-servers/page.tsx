import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  COMPETITOR_FACTS,
  CompetitorFacts,
  FACTS_CHECKED,
  priceAmount,
} from '../compare/competitor-facts';
import { withSocial } from '../social-meta';
import {
  CHATGPT_MCP_URL,
  CLAUDE_DESKTOP_REMOTE_JSON,
  MCP_TOOLS,
  MCP_CANNOT,
  OAUTH_PLAN_NOTE,
  SETUP_CHECKED,
} from '../mcp/mcp-setup';
import { FREE_POSTS, offer } from '../trial-offer';
import { planPrice, planPriceInParens } from '../usd-offer';

// Targets "social media mcp server", "best social media mcp servers",
// "social media scheduler mcp" (autocomplete-backed, Veritas run 28 Sep 2026).
// Page 1 is listicles from other schedulers (pallyy, eden, socialync,
// opentweet) plus GitHub repos; /mcp is a product page and does not rank for
// the comparison query.
//
// Honest framing matters here: 10 of the 12 tools in competitor-facts.ts list
// an MCP server, so MCP is NOT a Hookpost differentiator (see /compare). The
// page says so. Competitor rows render from competitor-facts.ts; Hookpost's
// tool names are the ones registered in chat/tools/tool.list.ts (hosted) - keep
// them in sync with the code.
//
// 11 Oct 2026: ChatGPT was no longer named as working with Hookpost. 26 Oct
// 2026: it connects as a custom MCP server at /mcp-oauth (OAuth sign-in),
// checked with a scripted client following OpenAI's flow (mcp/mcp-setup.ts). The hosted tool list now comes from
// mcp/mcp-setup.ts, which uses the exposed names (integrationSchedulePostTool,
// not the internal schedulePostTool). MCP_DETAILS below records how each
// server connects, read on SETUP_CHECKED from each vendor's own MCP page;
// Hookpost's row is read from its code, not from a live end-to-end test.
// The 12-row price table still comes from competitor-facts.ts (FACTS_CHECKED).

const CANONICAL = 'https://hookpost.hookstep.in/social-media-mcp-servers';
const { HOOKPOST } = pricingINR;

const ORDER = ['buffer', 'hootsuite', 'sprout-social', 'metricool', 'publer', 'socialpilot', 'agorapulse', 'zoho-social', 'postiz', 'mixpost', 'later', 'sendible'];

interface McpDetail {
  name: string;
  connect: string;
  drafts: string;
  freePlan: string;
  source: string;
  basis: 'From our code' | 'Vendor says';
}

const MCP_DETAILS: McpDetail[] = [
  {
    name: 'Hookpost',
    connect: 'Hosted URL; API key in an Authorization header or in the URL path, or OAuth sign-in (ChatGPT)',
    drafts: 'Yes: draft, schedule or publish now',
    freePlan: 'No, the Hookpost plan',
    source: '/mcp',
    basis: 'From our code',
  },
  {
    name: 'Buffer',
    connect: 'Personal API key or OAuth sign-in',
    drafts: 'Yes: posts land in the queue as drafts or scheduled',
    freePlan: 'Yes, every plan including Free',
    source: 'https://buffer.com/mcp',
    basis: 'Vendor says',
  },
  {
    name: 'Planoly',
    connect: 'Hosted URL (mcp.planoly.com/mcp), OAuth sign-in with your Planoly login',
    drafts: 'Creates, schedules and publishes; Stories are not schedulable through it',
    freePlan: 'No, paid plans',
    source: 'https://www.planoly.com/blog/connect-planoly-claude-chatgpt-gemini-mcp-setup-guide',
    basis: 'Vendor says',
  },
  {
    name: 'Post Bridge',
    connect: 'Hosted URL, OAuth sign-in',
    drafts: 'Recommends asking for drafts first; no separate draft-only setting described',
    freePlan: 'Not stated (free trial)',
    source: 'https://www.post-bridge.com/claude-code',
    basis: 'Vendor says',
  },
  {
    name: 'Ayrshare',
    connect: 'Hosted URL (api.ayrshare.com/mcp), account API key as a Bearer header',
    drafts: 'Not stated on the setup page',
    freePlan: 'Not stated',
    source: 'https://www.ayrshare.com/docs/additional/mcp-action-connect',
    basis: 'Vendor says',
  },
  // The four rows below were read on 11 Oct 2026 from each vendor's own MCP
  // and pricing pages (vistasocial.com/integrations/mcp + insights/what-is-mcp,
  // socialbu.com/mcp + /pricing, posteverywhere.ai/docs/integrations/mcp +
  // /pricing, contentstudio.io/mcp-server + /pricing). None was tested.
  {
    name: 'Vista Social',
    connect: 'Hosted connect link from Settings > Integrations; the API key is part of the URL, so no sign-in step',
    drafts: 'Not stated; 50+ tools across scheduling, analytics, inbox and reporting',
    freePlan: 'No, Advanced plan and higher',
    source: 'https://vistasocial.com/integrations/mcp/',
    basis: 'Vendor says',
  },
  {
    name: 'SocialBu',
    connect: 'Hosted URL (socialbu.com/mcp), OAuth sign-in',
    drafts: 'Yes: draft, schedule, publish now, or send for approval',
    freePlan: 'Not stated on the MCP page',
    source: 'https://socialbu.com/mcp',
    basis: 'Vendor says',
  },
  {
    name: 'PostEverywhere',
    connect: 'Hosted URL (mcp.posteverywhere.ai) with an API key header, OAuth for the claude.ai connector, or a local npx package',
    drafts: 'Yes: drafts, then schedule them in a second step',
    freePlan: 'No free plan; MCP is on every paid plan',
    source: 'https://posteverywhere.ai/docs/integrations/mcp',
    basis: 'Vendor says',
  },
  {
    name: 'ContentStudio',
    connect: 'Hosted URL (mcp.contentstudio.io/v1/mcp), browser sign-in, or the API key in the URL',
    drafts: 'Yes: draft, queued or scheduled',
    freePlan: 'No free plan; Standard and higher',
    source: 'https://contentstudio.io/mcp-server',
    basis: 'Vendor says',
  },
];

const mcpSource = (c: CompetitorFacts) =>
  c.sources.find((s) => /mcp|chatgpt|agent/i.test(s)) || c.sources[0];

const mcpCell = (c: CompetitorFacts) => (c.mcp == null ? 'Not stated' : c.mcp ? 'Yes' : 'No');

const entry = (c: CompetitorFacts) => {
  const p = c.cheapestPaid;
  if (!p) return 'Not published';
  const sym = p.currency === 'USD' ? '$' : `${p.currency} `;
  if (p.billing === 'one-time') return `${sym}${priceAmount(p)} one-time`;
  return `${sym}${priceAmount(p)} / ${p.per.replace('/month', '').replace('month', 'mo')}${p.billing === 'annual' ? ' (yearly)' : ''}`;
};

const withMcp = ORDER.map((k) => COMPETITOR_FACTS[k]).filter((c) => c && c.mcp);

const FAQ = [
  {
    q: 'What is a social media MCP server?',
    a: 'An MCP (Model Context Protocol) server lets an AI assistant call a tool directly. A social media MCP server exposes actions like "list my channels" and "schedule this post", so you can ask Claude, Cursor or another MCP client to plan and publish posts instead of copying text into a scheduler.',
  },
  {
    q: 'Which social media schedulers have an MCP server?',
    a: `Most of them now do. Of the twelve schedulers we checked on ${FACTS_CHECKED}, ${withMcp.length} list an MCP server or AI-assistant connection: ${withMcp.map((c) => c.name).join(', ')}. Hookpost has one too. Later and Sendible did not state one on their pages.`,
  },
  {
    q: 'Can Claude schedule social media posts?',
    a: `Yes, through an MCP server. With Hookpost, add it to claude.ai or Claude Desktop as a custom connector, or to Claude Code with one command, and Claude can list your connected channels, check each network's rules and save drafts or scheduled posts. It needs a Hookpost API key, which comes with the Hookpost plan (${planPriceInParens('HOOKPOST', ' a month')}) and above.`,
  },
  {
    q: 'Can an MCP server read my post analytics?',
    a: "It depends on the tool. Planoly's connector reads recent performance; Hookpost's MCP tools create, list and adjust posts but return no engagement analytics. Check each vendor's MCP documentation for which actions it exposes before you rely on it for reporting.",
  },
  {
    q: 'Which social media MCP servers work with ChatGPT?',
    a: `Buffer, Planoly, Vista Social, PostEverywhere and ContentStudio name ChatGPT among their supported clients on their own pages. Hookpost connects too: add ${CHATGPT_MCP_URL} in ChatGPT as a custom MCP server and sign in to Hookpost. ChatGPT Free cannot add custom MCP servers. ${OAUTH_PLAN_NOTE}`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Social Media MCP Servers Compared (2026) | Hookpost',
  // No tool count here: the price table and the sign-in/drafts table cover
  // different sets of tools, so any single number would be wrong for one.
  description: 'Which social media schedulers ship an MCP server for Claude, Cursor and other AI assistants, compared on price, sign-in method and drafts.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Social media MCP servers compared (2026)',
    description: 'Schedulers with an MCP server for AI assistants, compared on price and tools.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'article',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Social media MCP servers compared' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Social media MCP servers compared (2026)',
    description: 'Schedulers with an MCP server, compared on price, licence and tools.',
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function SocialMediaMcpServersPage() {
  const tools = ORDER.map((k) => COMPETITOR_FACTS[k]).filter(Boolean);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${CANONICAL}#article`,
        headline: 'Social media MCP servers compared',
        datePublished: '2026-09-28T00:00:00+05:30',
        dateModified: '2026-10-11T00:00:00+05:30',
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@type': 'Organization', name: 'Hookstep', url: 'https://hookpost.hookstep.in/about' },
        mainEntityOfPage: CANONICAL,
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
          { '@type': 'ListItem', position: 2, name: 'AI agents & MCP', item: 'https://hookpost.hookstep.in/mcp' },
          { '@type': 'ListItem', position: 3, name: 'Social media MCP servers compared', item: CANONICAL },
        ],
      },
    ],
  };

  const cell = 'py-3 pe-4 align-top';
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">
          Prices checked {FACTS_CHECKED} · MCP details checked {SETUP_CHECKED}
        </p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Social media MCP servers compared
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          An MCP server lets Claude, Cursor or another AI assistant schedule posts for you, and{' '}
          {withMcp.length} of the 12 major schedulers we track now list one. So the useful questions are what it costs, how you sign
          in, whether it can stop at drafts, and what the assistant can actually do once connected.
        </p>
        <p className="mt-4 max-w-[70ch] rounded-xl border border-hp-border bg-white/[0.03] p-4 text-sm text-hp-text/70">
          <strong className="text-hp-text">Disclosure:</strong> we make Hookpost. Every other row comes from the vendor&apos;s own
          pages, linked in the table.
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-10 sm:px-10" aria-labelledby="table">
        <h2 id="table" className="text-2xl font-extrabold tracking-tight font-jakarta">Schedulers and their MCP support</h2>
        <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[820px] border-collapse text-left text-sm">
            <caption className="sr-only">Social media schedulers with MCP servers</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                {['Tool', 'MCP / AI assistant', 'Cheapest paid plan', 'Free plan', 'Source'].map((h) => (
                  <th key={h} scope="col" className="py-3 pe-4 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              <tr className="border-b border-hp-border bg-hp-primary/[0.06]">
                <th scope="row" className={`${cell} font-bold text-hp-text`}>
                  <Link href="/mcp" className="hover:text-hp-primary-text">Hookpost</Link>
                </th>
                <td className={cell}>Yes, hosted endpoint (Hookpost plan)</td>
                <td className={cell}>{planPrice('HOOKPOST', ' / mo')}, {HOOKPOST.channel} channels</td>
                <td className={cell}>{offer('Yes (no API or MCP)', FREE_POSTS)}</td>
                <td className={cell}>
                  <Link href="/mcp" className="underline">/mcp</Link>
                </td>
              </tr>
              {tools.map((c) => (
                <tr key={c.slug} className="border-b border-hp-border">
                  <th scope="row" className={`${cell} font-bold text-hp-text`}>{c.name}</th>
                  <td className={cell}>{mcpCell(c)}</td>
                  <td className={cell}>{entry(c)}</td>
                  <td className={cell}>{c.freePlan ? 'Yes' : c.freeTrialDays ? `${c.freeTrialDays}-day trial` : 'No'}</td>
                  <td className={cell}>
                    <a href={mcpSource(c)} rel="nofollow noopener" target="_blank" className="underline break-all">
                      {mcpSource(c).replace(/^https:\/\/(www\.)?/, '')}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-hp-text/55">
          &quot;Not stated&quot; means the vendor&apos;s pages did not mention an MCP server when we checked, not that one cannot
          exist. Which plan includes MCP differs by vendor: Buffer includes it on its free plan; Hookpost requires its paid plan.
        </p>
      </section>

      <section className="border-t border-hp-border" aria-labelledby="details">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 id="details" className="text-2xl font-extrabold tracking-tight font-jakarta">
            How you connect, and whether it can stop at drafts
          </h2>
          <p className="mt-4 max-w-[75ch] text-hp-text/70">
            Price is only half of it. Before an assistant posts for your brand you want to know how it signs in and whether you can
            keep it to drafts. Read on {SETUP_CHECKED} from each vendor&apos;s own MCP page. &quot;Vendor says&quot; means we
            took the vendor at its word and did not test it; Hookpost&apos;s row is read from its own code.
          </p>
          <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[860px] border-collapse text-left text-sm">
              <caption className="sr-only">How social media MCP servers connect and whether they create drafts</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  {['Tool', 'How you connect', 'Drafts', 'On a free plan', 'Basis'].map((h) => (
                    <th key={h} scope="col" className="py-3 pe-4 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-hp-text/80">
                {MCP_DETAILS.map((d) => (
                  <tr key={d.name} className={`border-b border-hp-border ${d.name === 'Hookpost' ? 'bg-hp-primary/[0.06]' : ''}`}>
                    <th scope="row" className={`${cell} font-bold text-hp-text`}>
                      {d.source.startsWith('http') ? (
                        <a href={d.source} rel="nofollow noopener" target="_blank" className="underline">{d.name}</a>
                      ) : (
                        <Link href={d.source} className="hover:text-hp-primary-text">{d.name}</Link>
                      )}
                    </th>
                    <td className={cell}>{d.connect}</td>
                    <td className={cell}>{d.drafts}</td>
                    <td className={cell}>{d.freePlan}</td>
                    <td className={cell}>{d.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">What Hookpost&apos;s MCP server can do</h2>
          <p className="mt-4 max-w-[75ch] text-hp-text/75">
            One hosted URL and your API key; nothing to install. The tools an assistant sees:
          </p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {MCP_TOOLS.map((t) => (
              <li key={t.name} className="rounded-md bg-white/[0.06] px-2 py-1 font-mono text-xs text-hp-text/80">{t.name}</li>
            ))}
          </ul>
          <p className="mt-4 max-w-[75ch] text-hp-text/70">{MCP_CANNOT}</p>
          <p className="mt-6 text-sm text-hp-text/60">
            In claude.ai or Claude Desktop it goes in as a custom connector. For config-file clients that only start local
            programs, the third-party <code className="font-mono">mcp-remote</code> bridge works:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-xl border border-hp-border bg-hp-surface p-4 text-xs text-hp-text/80">
            {CLAUDE_DESKTOP_REMOTE_JSON}
          </pre>
          <p className="mt-6 max-w-[75ch] text-hp-text/70">
            Setup per client (Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI):{' '}
            <Link href="/mcp" className="text-hp-primary-text underline">the MCP page</Link>. Step by step:{' '}
            <Link href="/guides/claude-mcp-social-media" className="text-hp-primary-text underline">schedule posts with Claude</Link> and{' '}
            <Link href="/guides/claude-code-social-media" className="text-hp-primary-text underline">from Claude Code</Link>. Prefer plain
            HTTP? <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">The scheduling API</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">How to choose</h2>
          <ul className="mt-6 flex max-w-[75ch] list-disc flex-col gap-3 ps-5 text-hp-text/80">
            <li>
              <strong className="text-hp-text">You already use a scheduler:</strong> check whether it lists MCP before switching.
              Most do, and moving tools only for MCP rarely pays off.
            </li>
            <li>
              <strong className="text-hp-text">You pay in rupees:</strong> Hookpost bills in INR with UPI Autopay; see{' '}
              <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">schedulers for India compared</Link>.
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Questions</h2>
          <dl className="mt-6 flex flex-col gap-6">
            {FAQ.map((f) => (
              <div key={f.q}>
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
