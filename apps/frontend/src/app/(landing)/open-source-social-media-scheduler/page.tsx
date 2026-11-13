import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, FACTS_CHECKED, MIXPOST_CLOUD, priceAmount } from '../compare/competitor-facts';
import { withSocial } from '../social-meta';
import { FREE_POSTS, offer } from '../trial-offer';
import { BILLED, planPrice } from '../usd-offer';

// Targets "open source social media scheduler" and "self hosted social media
// scheduler" (307 Search Console impressions in the 28 days to 19 Oct 2026,
// while the URL still 301ed to /alternatives, which answered neither).
//
// Framing, rewritten 22 Oct 2026. Hookpost is a hosted service with no
// self-hosted edition, so this page sends people who need to self-host to
// Postiz or Mixpost and says what a hosted scheduler is for. It must not call
// Hookpost open source or describe a self-hosted Hookpost: Hookpost is
// proprietary (owner, 24 Oct 2026; LICENSE, every package.json UNLICENSED).
// The page needs no more than "Hookpost is hosted" to make its point, and it
// lists no open-source parts Hookpost is built on.
//
// Stars, licence and last push: GitHub API (api.github.com/repos/OWNER/REPO),
// read on REPOS_CHECKED. Postiz's hosted price and trial: competitor-facts.ts,
// read off postiz.com/pricing on FACTS_CHECKED. Mixpost Cloud and the Pro
// licence: MIXPOST_CLOUD in the same file, read on its own date because the
// 26 Sep Mixpost record has no hosted offer. Re-check before bumping.
const CANONICAL = 'https://hookpost.hookstep.in/open-source-social-media-scheduler';
const REPOS_CHECKED = '22 October 2026';

const { HOOKPOST } = pricingINR;
const POSTIZ = COMPETITOR_FACTS.postiz;
const MIXPOST = COMPETITOR_FACTS.mixpost;

const postizHosted = POSTIZ.cheapestPaid
  ? `From $${priceAmount(POSTIZ.cheapestPaid)} a month billed yearly for ${POSTIZ.cheapestPaid.channelsIncluded} channels, ${POSTIZ.freeTrialDays}-day trial`
  : 'See its pricing page';
const mixpostPro = MIXPOST.cheapestPaid
  ? `$${priceAmount(MIXPOST.cheapestPaid)} one-time licence for one domain`
  : 'a paid licence';

const REPOS: {
  name: string;
  licence: string;
  stars: string;
  pushed: string;
  runsOn: string;
  hosted: string;
  sources: [label: string, href: string][];
}[] = [
  {
    name: 'Postiz',
    licence: 'AGPL-3.0',
    stars: '37,551',
    pushed: '21 Oct 2026',
    runsOn: 'Docker on your own server',
    hosted: postizHosted,
    sources: [
      ['repo', 'https://github.com/gitroomhq/postiz-app'],
      ['pricing', 'https://postiz.com/pricing'],
    ],
  },
  {
    name: 'Mixpost',
    licence: 'MIT (Lite edition)',
    stars: '3,845',
    pushed: '16 Mar 2026',
    runsOn: 'Docker or a Laravel app',
    hosted: `Mixpost Cloud from $${MIXPOST_CLOUD.monthly} a month ($${MIXPOST_CLOUD.yearly} a year), ${MIXPOST_CLOUD.trialDays}-day trial. Self-hosted Pro is a ${mixpostPro}`,
    sources: [
      ['repo', 'https://github.com/inovector/mixpost'],
      ['pricing', 'https://mixpost.app/pricing'],
      ['cloud', MIXPOST_CLOUD.source],
    ],
  },
];

const TRADE_OFFS: [string, string, string][] = [
  [
    'What you pay for',
    `The code costs nothing (Mixpost Pro is a ${mixpostPro}). You pay for the server, the database, backups and the hours spent on upkeep.`,
    `A monthly plan. Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels.`,
  ],
  [
    'Who runs it',
    'You: the app, a database, Redis and the background workers that publish on time.',
    'The vendor. Nothing to install or patch.',
  ],
  [
    'Network developer apps',
    'You register your own app with Meta, LinkedIn, X, TikTok and the rest, and some of them review it before it may post for anyone but you.',
    'The vendor’s apps. You sign in with each network.',
  ],
  [
    'When a network changes its API',
    'You update and redeploy.',
    'The vendor ships the fix.',
  ],
  [
    'Where posts and tokens live',
    'Your own database.',
    'The vendor’s servers.',
  ],
  [
    'The source code',
    'Yours to read, change and audit.',
    'You use the vendor’s running copy and cannot change it.',
  ],
];

const FAQ = [
  {
    q: 'Can I self-host Hookpost?',
    a: 'No. Hookpost is a hosted service and there is no self-hosted edition. If you need the scheduler on your own server, use Postiz or Mixpost.',
  },
  {
    q: 'What is the best open source social media scheduler?',
    a: `For most teams that want to self-host, Postiz: AGPL-3.0, 37,551 GitHub stars and a push on 21 October 2026 (GitHub API, ${REPOS_CHECKED}). Mixpost Lite (MIT) suits teams already running Laravel; its last push was 16 March 2026.`,
  },
  {
    q: 'Is a self-hosted social media scheduler cheaper?',
    a: 'The code costs nothing; running it does not. You pay for a server, a database, Redis and backups, and you spend time on updates. You also register and maintain your own developer app with every network, and some networks review that app before it can publish for anyone but you.',
  },
  {
    q: 'When is a hosted scheduler the better choice?',
    a: 'When nobody on the team wants to run servers or own the network apps, or you need posts going out this week rather than after an app review. You give up control of the code in exchange for a monthly fee.',
  },
  {
    q: 'Can an AI assistant schedule posts through Hookpost?',
    a: 'Yes. Hookpost runs a hosted MCP server. Add it to Claude Code, Claude, Cursor, VS Code, Windsurf, Codex or Gemini CLI with your API key, and the assistant can list your channels and save drafts or scheduled posts in your Hookpost calendar. The setup for each client is on hookpost.hookstep.in/mcp.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Open-Source vs Hosted Social Media Scheduler | Hookpost',
  description:
    'Postiz and Mixpost are open source and self-hostable; Hookpost is hosted. What each route costs in servers, network app reviews and upkeep, with GitHub data.',
  alternates: { canonical: CANONICAL },
});

const A = ({ href, children }: { href: string; children: React.ReactNode }) =>
  href.startsWith('http') ? (
    <a href={href} className="text-hp-primary-text underline" rel="nofollow noopener" target="_blank">
      {children}
    </a>
  ) : (
    <Link href={href} className="text-hp-primary-text underline">
      {children}
    </Link>
  );

export default function OpenSourceVsHostedPage() {
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
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Open-source vs hosted social media scheduler', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Self-host or hosted</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Open-source vs hosted social media scheduler
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          If you need to run the scheduler on your own server, or read and change its code, use an open-source one:{' '}
          <strong className="text-hp-text">Postiz</strong> or <strong className="text-hp-text">Mixpost</strong>. If you would
          rather not run servers or deal with each network&apos;s developer app, use a hosted one.{' '}
          <strong className="text-hp-text">Hookpost is hosted.</strong> There is no self-hosted edition, so it is not an
          answer to the first need.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/mcp" className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            Set up the MCP server
          </Link>
          <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            See pricing
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What each route costs you</h2>
        <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <caption className="sr-only">Self-hosted open-source scheduler compared with a hosted scheduler</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                <th scope="col" className="py-3 pe-4 font-semibold"></th>
                <th scope="col" className="py-3 pe-4 font-semibold">Open source, self-hosted</th>
                <th scope="col" className="py-3 font-semibold">Hosted</th>
              </tr>
            </thead>
            <tbody>
              {TRADE_OFFS.map(([row, self, hosted]) => (
                <tr key={row} className="border-b border-hp-border align-top">
                  <th scope="row" className="py-4 pe-4 font-bold">{row}</th>
                  <td className="py-4 pe-4 text-hp-text/80">{self}</td>
                  <td className="py-4 text-hp-text/80">{hosted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-6 max-w-[70ch] text-hp-text/60">
          The network apps are the part people underestimate. Our own Meta app needed two rounds of review: the first
          submission, on 25 September 2026, was refused the Instagram and Threads publishing permissions; the second, on
          9 October, was approved. TikTok's Direct Post access needs its own audit, which Hookpost passed on 10 November 2026 and which a self-hosted app has to pass for itself. On a self-hosted install, every one of those reviews is yours to pass.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Open-source schedulers you can self-host</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/60">
            Licence, stars and last push from the GitHub API on {REPOS_CHECKED}. Hosted plans from each vendor&apos;s own
            pages: Postiz on {FACTS_CHECKED}, Mixpost on {MIXPOST_CLOUD.checked}. Follow the links to confirm.
          </p>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[820px] border-collapse text-left text-sm">
              <caption className="sr-only">Open-source social media schedulers compared</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Project</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Licence</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">GitHub stars</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Last push</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Runs on</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Hosted plan</th>
                  <th scope="col" className="py-3 font-semibold">Sources</th>
                </tr>
              </thead>
              <tbody>
                {REPOS.map((row) => (
                  <tr key={row.name} className="border-b border-hp-border align-top">
                    <th scope="row" className="py-4 pe-4 font-bold">{row.name}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{row.licence}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.stars}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.pushed}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.runsOn}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.hosted}</td>
                    <td className="py-4 text-hp-text/80">
                      {row.sources.map(([label, href], i) => (
                        <span key={href}>
                          {i > 0 ? ' · ' : null}
                          <A href={href}>{label}</A>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Postiz is the project with the momentum: nearly ten times Mixpost&apos;s stars and a push the day before we
            checked. Mixpost&apos;s open-source repository is the Lite edition of a commercial product. Both licences
            allow commercial use. Deeper comparisons: <A href="/alternatives/postiz">Hookpost vs Postiz</A>,{' '}
            <A href="/alternatives/mixpost">Hookpost vs Mixpost</A>, <A href="/compare/postiz-vs-mixpost">Postiz vs Mixpost</A>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Where Hookpost fits</h2>
          <p className="mt-6 max-w-[70ch] text-hp-text/75">
            Hookpost is for people who chose hosted. We run the servers and the network apps; you connect your
            accounts and schedule. It has an AI writing assistant in the post editor and a hosted{' '}
            <A href="/mcp">MCP server</A>, so Claude, Cursor or VS Code can draft and schedule posts straight into your
            calendar. On 21 October 2026 we asked Claude Code to turn a notes file into a week of LinkedIn, Threads and
            Facebook posts: it saved 21 drafts in one call, 91.6 seconds end to end. The{' '}
            <A href="https://www.npmjs.com/package/hookpost">hookpost CLI</A> on npm takes the same API key.
          </p>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            {offer(
              `There is a Free plan (${pricingINR.FREE.channel} channels, ${pricingINR.FREE.posts_per_month} posts a month); `,
              `New workspaces start with ${FREE_POSTS}, no card needed; `
            )}
            Hookpost is {planPrice('HOOKPOST', ' a month')} for {HOOKPOST.channel} channels, {BILLED}. Full limits are on{' '}
            <A href="/pricing">pricing</A>.
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
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-10 text-hp-text/60">
            Next: <A href="/mcp">connect Claude or Cursor</A>, or <A href="/pricing">compare the plans</A>.
          </p>
        </div>
      </section>
    </div>
  );
}
