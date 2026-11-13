import React from 'react';
import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { COMPETITOR_FACTS } from '../compare/competitor-facts';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';
import { BILLED, planPrice } from '../usd-offer';
import { CHECKED, TEN_CHANNELS, VENDORS } from './facts';

/**
 * Three-way comparison for "planable vs buffer vs hootsuite mcp" (120 Search
 * Console impressions and no clicks in the 28 days to 25 Oct 2026). The query
 * carries "mcp", so the page has to answer the MCP question first - and the
 * honest answer is that all three ship one, which is the opposite of what a
 * vendor page usually says. Saying so is the point: the reader can check it on
 * three pricing pages in a minute, and a comparison that fails that check is
 * worth nothing.
 *
 * It is NOT under /compare/<a>-vs-<b>: that family is generated from PAIRS in
 * competitor-facts.ts, two vendors at a time, and a three-way page does not
 * fit the pair model or its canonical scheme.
 *
 * Competitor figures: facts.ts, quoted from each vendor's own pricing page on
 * CHECKED, with the source link printed next to every row. Hootsuite's rupee
 * entry price comes from competitor-facts.ts, which recorded it from India.
 * Hookpost's figures come from pricing.ts and channel-count.ts.
 */
const CANONICAL = 'https://hookpost.hookstep.in/planable-vs-buffer-vs-hootsuite';

const HOOKPOST = pricingINR.HOOKPOST;
const FREE = pricingINR.FREE;
const HOOTSUITE = COMPETITOR_FACTS.hootsuite;

// Counted from competitor-facts.ts rather than typed, so the sentence below
// cannot go stale when a vendor's `mcp` flag is corrected there. Only vendors
// whose MCP support was actually checked are counted: `mcp` is null for the
// vendors added later for their rupee pricing, and a null must not read as a
// "no". All of them are currently true, which is the point being made, so the
// copy says "every one" rather than "N of N" - a ratio that can only render as
// N of N reads like a typo. The assertion is in growth-pages-2026-10-28.spec.ts:
// if one of them ever ships without MCP, that test fails and this copy has to
// change with it.
const MCP_CHECKED = Object.values(COMPETITOR_FACTS).filter((v) => typeof v.mcp === 'boolean');
const TRACKED_VENDORS = MCP_CHECKED.length;
const MCP_VENDORS = MCP_CHECKED.filter((v) => v.mcp).length;

const ANSWER_FIRST =
  `All three schedule posts and all three now ship an MCP connector, so "which one has MCP" is no longer the question - Planable lists an MCP Connector on every paid plan, Buffer ships Buffer MCP including on its free plan, and Hootsuite lists MCP connectors under Wisdom on every plan. What still separates them is the unit they charge for: Planable charges per workspace (from $33 a month), Buffer per channel (from $5 a channel a month), and Hootsuite per user (from $99 a user a month, billed annually). Pick by how your work is shaped - one brand with many accounts, a few accounts across many clients, or a team of seats - not by the AI feature list. Figures read off each vendor's own pricing page on ${CHECKED}.`;

const MCP_ROWS: readonly (readonly [string, string])[] = [
  ['Planable', VENDORS[0].aiAgents],
  ['Buffer', VENDORS[1].aiAgents],
  ['Hootsuite', VENDORS[2].aiAgents],
  [
    'Hookpost',
    `A hosted MCP server at https://hookpost.hookstep.in/api/mcp, plus a REST API, a CLI (npm install -g hookpost) and an n8n node. An agent can list channels, upload media and create drafts or scheduled posts. All of it needs the Hookpost plan.`,
  ],
];

const WHO_FITS: readonly { name: string; body: string }[] = [
  {
    name: 'Planable fits',
    body: 'An agency or a multi-brand team whose real problem is approval. The workspace is the unit: one per client, with its own calendar, approvers and campaigns, and unlimited users inside it at no extra cost. If five people have to sign off before anything publishes, paying per workspace is the right shape. It gets expensive the other way round - one brand with a handful of accounts still pays for a whole workspace.',
  },
  {
    name: 'Buffer fits',
    body: 'One person or a small team with a few accounts, who wants to add and drop a channel without renegotiating a plan. Per channel means a client leaving costs you nothing next month. It stops being cheap at scale: ten channels on Team is $100 a month, and the same ten on a flat-price tool is one line.',
  },
  {
    name: 'Hootsuite fits',
    body: 'An organisation that is buying listening, an inbox and employee advocacy as well as publishing, and whose seats are the thing it is counting. Its Standard plan starts at $99 a user a month billed annually and caps social accounts at ten; unlimited accounts start at Professional, $199 a user a month. For a one-person account that is the most expensive way on this page to schedule a post.',
  },
  {
    name: 'Hookpost fits',
    body: `Someone who wants a flat monthly price and an AI agent that can actually write into the calendar. Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels, ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month and ${HOOKPOST.team_member_limit} team members, ${BILLED}. It is one price - not per channel, per seat or per workspace. What it does not have: no social listening, no inbox, no approval workflow and no analytics suite. If you need those, the three above are what they are for.`,
  },
];

const FAQ: readonly { q: string; a: string }[] = [
  { q: 'Planable vs Buffer vs Hootsuite: which has MCP?', a: ANSWER_FIRST },
  {
    q: 'Which is cheapest?',
    a: `It depends entirely on the shape of your accounts, because the three charge for different things. For one person posting to ten accounts: Planable Pro is $49 a month for one workspace of ten pages, Buffer Essentials is 10 × $5 = $50 a month billed yearly, and Hootsuite Standard is $99 a month for one seat with up to ten accounts. Hookpost covers ${HOOKPOST.channel} channels for ${planPrice('HOOKPOST', ' a month')}. All competitor figures were read on ${CHECKED}; follow the source links on this page before relying on them.`,
  },
  {
    q: 'Planable, Buffer or Hootsuite: which has a free plan?',
    a: 'Buffer is the only one of the three with an ongoing free plan: up to 3 channels and 10 scheduled posts per channel, refilling as posts publish. Planable has a free trial of 50 created posts with no time limit, which does not reset. Hootsuite has no free plan, only a 14-day trial in which posting is limited to 10-20 posts per organisation a day and bulk scheduling is off.',
  },
  {
    q: 'Does any of them bill in rupees or take UPI?',
    a: `Hootsuite shows rupee prices to visitors in India - ${HOOTSUITE.inrEntry}, read on ${HOOTSUITE.inrChecked ?? 'its own pricing page'} (the dollar figures on this page were read from outside India on ${CHECKED}; Hootsuite localises by IP, so the two are different reads of the same page rather than a contradiction). Planable states prices in US dollars, taken by card through Stripe, with bank or wire transfer on Enterprise. Buffer prices in US dollars. None of the three names UPI as a payment method on its own pricing page. Hookpost is ${BILLED}.`,
  },
  {
    q: 'Can an AI agent publish on its own, or only draft?',
    a: 'Each vendor describes its own connector differently, and the honest answer is to read theirs: Planable says its MCP Connector lets an assistant "create and manage content across all your workspaces"; Buffer’s MCP page describes drafting, scheduling from a prompt and checking the queue, with review and publishing in Buffer. Hookpost’s MCP server can create a post as a draft or scheduled - the agent chooses - so an agent can be kept to drafts while you review on the calendar.',
  },
  {
    q: 'How many networks does each support?',
    a: `Planable lists nine on its site: Facebook, Instagram, LinkedIn, X, TikTok, YouTube, Pinterest, Threads and Google Business Profile. Buffer lists twelve, adding Bluesky, Mastodon and Substack. Hootsuite prices by the number of social accounts rather than naming a list on its plans page, so no count is quoted for it here. Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT}, including Discord, Slack, Telegram, WordPress, Hashnode and Dev.to.`,
  },
];

export const metadata: Metadata = withSocial({
  // Written for the query "planable vs buffer vs hootsuite mcp" (38
  // impressions, 0 clicks, Search Console 21-27 Oct 2026): the exact query
  // first, then what the reader gets - which connectors exist and what each
  // costs - with the prices in the snippet so it reads as an answer.
  title: 'Planable vs Buffer vs Hootsuite MCP: Connectors & Pricing',
  description: `All three ship an MCP connector. Planable bills per workspace ($33/mo), Buffer per channel ($5/mo), Hootsuite per user ($99/mo). Hookpost's MCP: from ${planPrice('HOOKPOST', '/mo')}.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Planable vs Buffer vs Hootsuite MCP: connectors and pricing',
    description:
      'All three ship an MCP connector. Per workspace, per channel or per user - and what each connector actually does. With source links.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Planable vs Buffer vs Hootsuite compared',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Planable vs Buffer vs Hootsuite MCP: connectors and pricing',
    description: 'Per workspace, per channel or per user - and what each MCP connector does.',
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function PlanableVsBufferVsHootsuitePage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'ItemList',
        '@id': `${CANONICAL}#tools`,
        name: 'Social media schedulers compared on pricing model and MCP support',
        itemListElement: [...VENDORS, { name: 'Hookpost', source: 'https://hookpost.hookstep.in/pricing' }].map(
          (v, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            item: { '@type': 'SoftwareApplication', name: v.name, applicationCategory: 'BusinessApplication', url: v.source },
          })
        ),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${CANONICAL}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Alternatives', item: 'https://hookpost.hookstep.in/alternatives' },
          { '@type': 'ListItem', position: 3, name: 'Planable vs Buffer vs Hootsuite', item: CANONICAL },
        ],
      },
      // The page itself. Without it the graph described the FAQ, the list and
      // the breadcrumbs but never the document they are on, which is the node
      // the other landing families all carry.
      {
        '@type': 'WebPage',
        '@id': CANONICAL,
        url: CANONICAL,
        name: 'Planable vs Buffer vs Hootsuite, with MCP and AI agents',
        description: ANSWER_FIRST,
        inLanguage: 'en',
        isPartOf: { '@id': 'https://hookpost.hookstep.in/#website' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        breadcrumb: { '@id': `${CANONICAL}#breadcrumbs` },
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center gap-2">
            <li>
              <Link href="/" className="hover:text-hp-text">Home</Link>
            </li>
            <li>/</li>
            <li>
              <Link href="/alternatives" className="hover:text-hp-text">Alternatives</Link>
            </li>
            <li>/</li>
            <li className="font-semibold text-hp-primary-text">Planable vs Buffer vs Hootsuite</li>
          </ol>
        </nav>
        <h1 className="mt-6 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Planable vs Buffer vs Hootsuite, with MCP and AI agents
        </h1>
        <p className="mt-5 max-w-[74ch] text-lg text-hp-text/75">{ANSWER_FIRST}</p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
          MCP and AI agents: what each one says it does
        </h2>
        <p className="mt-3 max-w-[74ch] text-hp-text/60">
          In each vendor&apos;s own words, from the pages linked below, read on {CHECKED}. MCP support is a tie; what differs is
          whether an agent can be held to drafts and what the plan it needs costs.
        </p>
        <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[640px] border-collapse text-left text-sm">
            <caption className="sr-only">MCP and AI agent support compared</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                <th scope="col" className="py-3 font-semibold">What an AI agent can do</th>
              </tr>
            </thead>
            <tbody>
              {MCP_ROWS.map(([name, body]) => (
                <tr key={name} className={`border-b border-hp-border ${name === 'Hookpost' ? 'bg-hp-primary/[0.06]' : ''}`}>
                  <th scope="row" className="py-4 pe-4 align-top font-bold">{name}</th>
                  <td className="py-4 text-hp-text/80">{body}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 max-w-[74ch] text-hp-text/70">
          Every one of the {TRACKED_VENDORS} schedulers whose MCP support we have checked ships one, so treat
          &quot;has MCP&quot; as table stakes rather than a reason to switch. Which ones, how each signs in, and the exact
          tools Hookpost&apos;s server exposes:{' '}
          <Link href="/social-media-mcp-servers" className="text-hp-primary-text underline">social media MCP servers compared</Link>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Plans and prices, side by side</h2>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[840px] border-collapse text-left text-sm">
              <caption className="sr-only">Planable, Buffer and Hootsuite plans compared</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Charged by</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Free</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Entry plan</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Next plan up</th>
                  <th scope="col" className="py-3 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {VENDORS.map((v) => (
                  <tr key={v.name} className="border-b border-hp-border align-top">
                    <th scope="row" className="py-4 pe-4 font-bold">{v.name}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{v.model}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{v.free}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{v.entry}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{v.mid}</td>
                    <td className="py-4">
                      <a href={v.source} rel="nofollow noopener" target="_blank" className="text-hp-primary-text underline">
                        pricing page
                      </a>
                      {v.extraSources?.map((s) => (
                        <React.Fragment key={s}>
                          {', '}
                          <a href={s} rel="nofollow noopener" target="_blank" className="text-hp-primary-text underline">
                            MCP page
                          </a>
                        </React.Fragment>
                      ))}
                    </td>
                  </tr>
                ))}
                <tr className="border-b border-hp-border bg-hp-primary/[0.06] align-top">
                  <th scope="row" className="py-4 pe-4 font-bold">Hookpost</th>
                  <td className="py-4 pe-4 text-hp-text/80">
                    per plan, per month. Flat - not per channel, per seat or per workspace.
                  </td>
                  <td className="py-4 pe-4 text-hp-text/80">
                    {offer(
                      `A free plan: ${FREE.channel} channels and ${FREE.posts_per_month} scheduled posts a month, no card, no time limit. No AI, API or MCP on it.`,
                      `${FREE_POSTS} for a new workspace, no card needed, then a paid plan.`
                    )}
                  </td>
                  <td className="py-4 pe-4 text-hp-text/80">
                    {planPrice('HOOKPOST', ' a month')}: {HOOKPOST.channel} channels, {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a
                    month, AI drafting, REST API, CLI and the MCP server, {HOOKPOST.team_member_limit} team members.
                  </td>
                  <td className="py-4 pe-4 text-hp-text/80">
                    None: one flat plan.
                  </td>
                  <td className="py-4">
                    <Link href="/pricing" className="text-hp-primary-text underline">our pricing</Link>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[74ch] text-sm text-hp-text/55">
            Planable, Buffer and Hootsuite figures were read off the pages linked above on {CHECKED} and exclude tax. Prices
            change; follow the link before relying on one. Hookpost&apos;s figures are read from its own live pricing
            configuration at build time, so this table cannot drift from what checkout charges.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
            The same job, priced three ways: one person, ten accounts
          </h2>
          <p className="mt-3 max-w-[74ch] text-hp-text/60">
            Per workspace, per channel and per user are not comparable in the abstract, so here is one concrete case with the
            arithmetic shown.
          </p>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <caption className="sr-only">Cost of scheduling to ten accounts</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Plan</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">How it adds up</th>
                  <th scope="col" className="py-3 font-semibold">Monthly</th>
                </tr>
              </thead>
              <tbody>
                {TEN_CHANNELS.map((row) => (
                  <tr key={row.name} className="border-b border-hp-border align-top">
                    <th scope="row" className="py-4 pe-4 font-bold">{row.name}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{row.plan}</td>
                    <td className="py-4 pe-4 text-hp-text/70">{row.working}</td>
                    <td className="py-4 font-semibold text-hp-text">{row.monthly}</td>
                  </tr>
                ))}
                <tr className="border-b border-hp-border bg-hp-primary/[0.06] align-top">
                  <th scope="row" className="py-4 pe-4 font-bold">Hookpost</th>
                  <td className="py-4 pe-4 text-hp-text/80">Hookpost</td>
                  <td className="py-4 pe-4 text-hp-text/70">
                    Hookpost includes {HOOKPOST.channel} channels, so ten is inside the plan with room left over. No per-channel addition
                    to do.
                  </td>
                  <td className="py-4 font-semibold text-hp-text">{planPrice('HOOKPOST', ' a month')}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[74ch] text-hp-text/70">
            Two honest caveats. Planable&apos;s $49 assumes all ten pages belong to one brand; a second client means a second
            workspace and $49 again. And the three above sell things Hookpost does not - social listening, a unified inbox, a
            multi-step approval chain, a full analytics suite - so for a team that needs those, the cheaper line here is not
            the better buy. The rupee figures are not a currency conversion of the dollar ones; they are what each tool charges
            in the currency it bills.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Which one fits</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {WHO_FITS.map((w) => (
              <div
                key={w.name}
                className={`rounded-2xl border p-6 ${w.name === 'Hookpost fits' ? 'border-hp-primary/30 bg-hp-primary/[0.05]' : 'border-hp-border'}`}
              >
                <h3 className="text-xl font-bold font-jakarta">{w.name}</h3>
                <p className="mt-3 text-[15px] text-hp-text/75">{w.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 max-w-[74ch] text-hp-text/60">
            One-to-one comparisons with each:{' '}
            <Link href="/alternatives/buffer" className="text-hp-primary-text underline">Hookpost vs Buffer</Link>,{' '}
            <Link href="/alternatives/hootsuite" className="text-hp-primary-text underline">Hookpost vs Hootsuite</Link>. The whole
            set: <Link href="/alternatives" className="text-hp-primary-text underline">alternatives</Link> and{' '}
            <Link href="/compare" className="text-hp-primary-text underline">compare</Link>. If you are starting from the category
            rather than a vendor:{' '}
            <Link href="/social-media-scheduler" className="text-hp-primary-text underline">what a social media scheduler does</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Questions</h2>
          <dl className="mt-8 flex flex-col gap-8">
            {FAQ.map((f) => (
              <div key={f.q} className="min-w-0">
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[74ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-12 rounded-3xl border border-hp-border-strong bg-gradient-to-b from-hp-elevated to-hp-surface p-8 text-center sm:p-12">
            <h2 className="text-3xl font-bold font-jakarta sm:text-4xl">Try the flat-price one</h2>
            <p className="mx-auto mt-4 max-w-lg text-hp-text/70">
              {offer(
                `${FREE.channel} channels and ${FREE.posts_per_month} posts a month free, no card.`,
                TRIAL_SENTENCE
              )}
            </p>
            <Link
              href="/auth"
              prefetch={false}
              className="mt-6 inline-block rounded-full bg-white px-10 py-4 text-base font-bold text-black transition-all hover:bg-hp-primary hover:text-hp-on-primary"
            >
              {offer('Start free', TRIAL_CTA)}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
