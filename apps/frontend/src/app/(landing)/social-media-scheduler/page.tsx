import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';
import { BILLED, planPrice } from '../usd-offer';

/**
 * The head-term page: "social media scheduler".
 *
 * Why it exists. In the 28 days to 25 Oct 2026 that query brought 1,083
 * Search Console impressions and ZERO clicks at an average position of 13.
 * The only page answering it was the homepage, whose <title> is
 * "Hookpost: AI Social Media Scheduler" and whose H1 opens "The social media
 * scheduler your AI agent can use" - a brand page that leads with the AI
 * angle. Someone typing the bare head term has not chosen a vendor yet, so
 * this page answers the category question first and names Hookpost second.
 *
 * It does not compete with the homepage for the brand query: the homepage
 * keeps "hookpost" (position 1.6) and this page keeps its own canonical and a
 * title and H1 that open with the exact phrase searched.
 *
 * Every Hookpost figure is read from pricing.ts and channel-specs.ts. The
 * honest-limits section is deliberate: a page that claims a scheduler is
 * always the answer loses the reader who knows Instagram schedules its own
 * posts for free, and that reader is the one who converts later.
 */
const CANONICAL = 'https://hookpost.hookstep.in/social-media-scheduler';

const FREE = pricingINR.FREE;
const HOOKPOST = pricingINR.HOOKPOST;

// What a visitor can connect and publish to today, by network page. The count
// in the copy comes from channel-count.ts, never typed, so the two cannot
// disagree.
const NETWORKS: readonly (readonly [string, string])[] = [
  ['Instagram', '/channels/instagram'],
  ['LinkedIn', '/channels/linkedin'],
  ['X (Twitter)', '/channels/x'],
  ['Facebook Pages', '/channels/facebook'],
  ['Threads', '/channels/threads'],
  ['YouTube', '/channels/youtube'],
  ['TikTok', '/channels/tiktok'],
  ['Pinterest', '/channels/pinterest'],
  ['Bluesky', '/channels/bluesky'],
  ['Discord', '/channels/discord'],
  ['Slack', '/channels/slack'],
  ['Telegram', '/channels/telegram'],
  ['WordPress', '/channels/wordpress'],
  ['Hashnode', '/channels/hashnode'],
  ['Dev.to', '/channels/devto'],
];

// The answer-first paragraph, used in three places on purpose - the hero, the
// first FAQ answer, and the WebPage description in the JSON-LD - so the page,
// its structured data and any AI summary of it all say the same thing in the
// same words.
const WHAT_IT_IS =
  `A social media scheduler is one tool where you write a post once, pick the date and time it should go out, and let the tool publish it to each network for you - so nothing has to be posted by hand at the moment it is due. Hookpost is a social media scheduler for ${PUBLISHABLE_CHANNEL_COUNT} networks: you plan everything on one visual calendar, Hookpost checks each network's own limits before a post is queued, and it publishes on time whether or not your laptop is open. It also ships a Model Context Protocol server, so Claude, Claude Code, Cursor or another AI agent can draft and queue posts without anyone opening the app.`;

const FAQ: readonly { q: string; a: string }[] = [
  { q: 'What is a social media scheduler?', a: WHAT_IT_IS },
  {
    q: 'Do I need a social media scheduler at all?',
    a: `Not always, and it is worth knowing when. Instagram's own app and Meta Business Suite schedule Instagram and Facebook Page posts for free on a professional account. LinkedIn's clock icon schedules profile posts up to three months ahead. YouTube Studio schedules each upload. If one network is all you post to, those are enough. A scheduler earns its place when the same week has to go out on several networks, when a team shares one calendar, or when a network has no scheduler of its own - Bluesky publishes the instant a post is created, so scheduling a Bluesky post needs a tool.`,
  },
  {
    q: 'How many networks can Hookpost schedule to?',
    a: `${PUBLISHABLE_CHANNEL_COUNT}, including Instagram, LinkedIn, X, Facebook Pages, Threads, YouTube, TikTok, Pinterest, Bluesky, Discord, Slack, Telegram, WordPress, Hashnode and Dev.to. TikTok posts publish to your TikTok account with the audience your account allows (Everyone, Friends, Followers or Only me), or go to your TikTok inbox as drafts if you choose that mode. Instagram needs a Business or Creator account, which is what Instagram's own API allows apps to publish to. LinkedIn Company Pages and Reddit are not supported.`,
  },
  {
    q: 'What does Hookpost cost?',
    a: offer(
      `There is a free plan: ${FREE.channel} channels and ${FREE.posts_per_month} scheduled posts a month, with no time limit and no card. Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month, and adds AI drafting, the REST API, the CLI and the MCP server. It covers up to ${HOOKPOST.team_member_limit} team members. It is one flat price, not a fee per channel, ${BILLED}.`,
      `${TRIAL_SENTENCE} Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts a month, with AI drafting, the REST API, the CLI and the MCP server. It covers up to ${HOOKPOST.team_member_limit} team members. It is one flat price, not a fee per channel, ${BILLED}.`
    ),
  },
  {
    q: 'Can an AI agent schedule the posts for me?',
    a: `Yes. Hookpost's hosted MCP server lets an AI assistant list your connected channels, upload media and create draft or scheduled posts. In Claude Code: claude mcp add --transport http hookpost https://hookpost.hookstep.in/api/mcp --header "Authorization: Bearer YOUR_API_KEY". Cursor, VS Code, Windsurf, Codex and Gemini CLI are set up the same way. The MCP server, the REST API and the CLI need the Hookpost plan.`,
  },
  {
    q: 'Does scheduling a post hurt reach?',
    a: 'Nothing in any network’s published documentation says a scheduled post is treated differently from one posted by hand. Instagram, Facebook, LinkedIn, X and YouTube all ship their own schedulers, and posts from an approved third-party app go through the same publishing API. What does matter is posting at a time your audience is awake, which is the reason to schedule in the first place.',
  },
  {
    q: 'What happens if a network rejects a post?',
    a: 'Hookpost checks each network’s character limit and media rules before a post is queued, so most problems surface while you are still writing rather than at 9 a.m. If a network still refuses the post - an expired connection, a permission revoked on their side - the post is marked as failed with the network’s own error, and the other networks on the same post are unaffected.',
  },
];

export const metadata: Metadata = withSocial({
  // Opens with the exact phrase searched, then differentiates from the sitewide
  // layout description, which also begins "Social media scheduler for N
  // networks." - the two closest-matching strings on the site for this query.
  title: `Social Media Scheduler: What It Does, and Which to Pick | Hookpost`,
  description: `A social media scheduler that publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks from one visual calendar, with an MCP server so Claude or Cursor can post for you. ${offer('Free plan', FREE_POSTS)}, flat monthly pricing.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: `Social media scheduler for ${PUBLISHABLE_CHANNEL_COUNT} networks`,
    description: `One calendar, ${PUBLISHABLE_CHANNEL_COUNT} networks, per-network checks before a post is queued, and an MCP server for AI agents.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Hookpost social media scheduler',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: `Social media scheduler for ${PUBLISHABLE_CHANNEL_COUNT} networks`,
    description: `One calendar, ${PUBLISHABLE_CHANNEL_COUNT} networks, and an MCP server for AI agents.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function SocialMediaSchedulerPage() {
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
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to schedule a social media post',
        step: [
          {
            '@type': 'HowToStep',
            position: 1,
            name: 'Connect a channel',
            text: 'Sign in to Hookpost and connect an account. Most networks connect with one OAuth click; Discord, Slack and Telegram add a bot to the server, workspace or channel.',
          },
          {
            '@type': 'HowToStep',
            position: 2,
            name: 'Write the post',
            text: 'Write once and adapt per network where you want to. Hookpost checks each network’s character limit and media rules as you write.',
          },
          {
            '@type': 'HowToStep',
            position: 3,
            name: 'Pick a date and time',
            text: 'Drop the post on the calendar at the slot you want. Hookpost publishes it then, from its own servers.',
          },
        ],
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${CANONICAL}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Social media scheduler', item: CANONICAL },
        ],
      },
      // The page itself. Without it the graph described the FAQ, the steps and
      // the breadcrumbs but never the document they are on.
      {
        '@type': 'WebPage',
        '@id': CANONICAL,
        url: CANONICAL,
        name: `Social media scheduler for ${PUBLISHABLE_CHANNEL_COUNT} networks`,
        description: WHAT_IT_IS,
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
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">
          {PUBLISHABLE_CHANNEL_COUNT} networks &middot; one calendar
        </p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Social media scheduler for {PUBLISHABLE_CHANNEL_COUNT} networks
        </h1>
        <p className="mt-5 max-w-[72ch] text-lg text-hp-text/75">{WHAT_IT_IS}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            See every plan limit
          </Link>
        </div>
        <p className="mt-5 max-w-[70ch] text-sm text-hp-text/60">
          {offer(
            `The free plan is ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, with no time limit and no card. Paid plans start at ${planPrice('HOOKPOST', ' a month')}.`,
            TRIAL_SENTENCE
          )}
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What a scheduler has to get right</h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Publishing that does not need you.</strong> Posts go out from Hookpost&apos;s own
            servers at the time you picked, not from a browser tab that has to stay open.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Per-network checks before queueing.</strong> Each network&apos;s character limit and
            media rules are validated as you write - 3,000 characters on LinkedIn, 1,980 on Discord, and so on - so a post
            fails in the editor rather than at 9 a.m.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">One draft, adapted per network.</strong> Write once, then change the version that
            goes to X or LinkedIn without starting again.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">A calendar you can read.</strong> Drag posts between days, preview them the way each
            network will render them, and see the whole week at once.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">A way in for software.</strong> A REST API, a{' '}
            <Link href="/cli" className="text-hp-primary-text underline">command-line tool</Link>, an n8n node and an{' '}
            <Link href="/mcp" className="text-hp-primary-text underline">MCP server</Link> for AI agents - so the calendar can be
            filled by a script or an assistant, not only by hand.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">A price that does not scale with channels.</strong> One flat monthly price per plan.
            Tools that charge per channel get expensive exactly when you add the network you were testing.
          </li>
        </ul>
        <p className="mt-6 max-w-[72ch] text-hp-text/60">
          Not in Hookpost today, so you know before you sign up: there is no CSV bulk import, no &quot;best time to post&quot;
          recommendation and no approval workflow. Every plan limit:{' '}
          <Link href="/pricing" className="text-hp-primary-text underline">pricing</Link>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Networks you can schedule to</h2>
          <ul className="mt-6 flex flex-wrap gap-2">
            {NETWORKS.map(([name, href]) => (
              <li key={href}>
                <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  {name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-5 max-w-[72ch] text-sm text-hp-text/60">
            Each page above lists that network&apos;s real limits and posting rules. The full list, including Lemmy, Nostr and
            Listmonk: <Link href="/channels" className="text-hp-primary-text underline">all {PUBLISHABLE_CHANNEL_COUNT} channels</Link>.
            Scheduling messages to a Discord server has its own page:{' '}
            <Link href="/discord-post-scheduler" className="text-hp-primary-text underline">Discord post scheduler</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Schedule your first post in three steps</h2>
          <ol className="mt-6 flex flex-col gap-4 text-hp-text/80 list-decimal ps-6">
            <li>
              <strong className="text-hp-text">Connect a channel.</strong> Most networks connect with one OAuth click. Discord,
              Slack and Telegram add the Hookpost bot or app to the server, workspace or channel it should post in.
            </li>
            <li>
              <strong className="text-hp-text">Write the post.</strong> One draft for every network, edited per network where you
              want to. Length and media are checked as you type.
            </li>
            <li>
              <strong className="text-hp-text">Pick a date and time.</strong> Drop it on the calendar. Hookpost publishes it then.
            </li>
          </ol>
          <p className="mt-6 max-w-[72ch] text-hp-text/60">
            Prefer to let an assistant do it? <Link href="/guides/claude-code-social-media" className="text-hp-primary-text underline">Schedule from Claude Code</Link>,{' '}
            <Link href="/guides/cursor-social-media" className="text-hp-primary-text underline">from Cursor or VS Code</Link>, or straight from{' '}
            <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">the REST API</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">When you do not need a scheduler</h2>
          <p className="mt-4 max-w-[72ch] text-hp-text/75">
            Most networks now schedule their own posts, free, and for a single network that is usually the better answer.
            Instagram&apos;s app and Meta Business Suite schedule Instagram and Facebook Page posts on a professional account.
            LinkedIn&apos;s clock icon schedules profile posts up to three months ahead. YouTube Studio schedules each upload.
            Threads has had scheduling in its own composer since January 2025.
          </p>
          <p className="mt-4 max-w-[72ch] text-hp-text/75">
            A scheduler is worth paying for when the same week has to go out on several networks at once, when a team shares one
            calendar, or when the network has no scheduler at all - Bluesky publishes a post the moment it is created, so there
            is no way to schedule one without a tool. Step-by-step on each network&apos;s own scheduler, in Hinglish:{' '}
            <Link href="/guides/social-media-post-schedule-kaise-kare" className="text-hp-primary-text underline">
              social media post schedule kaise kare
            </Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Comparing schedulers</h2>
          <p className="mt-4 max-w-[72ch] text-hp-text/75">
            Every comparison below is built from figures read off each vendor&apos;s own pricing page, with the date and a link
            to the source on the page, so you can check them rather than take our word for it.
          </p>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <li className="rounded-2xl border border-hp-border p-5">
              <Link href="/planable-vs-buffer-vs-hootsuite" className="font-bold text-hp-text hover:text-hp-primary-text">
                Planable vs Buffer vs Hootsuite
              </Link>
              <p className="mt-2 text-[15px] text-hp-text/70">
                Three pricing models - per workspace, per channel and per user - and what each one&apos;s AI agent and MCP
                connector can actually do.
              </p>
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <Link href="/alternatives/metricool" className="font-bold text-hp-text hover:text-hp-primary-text">
                Metricool alternative
              </Link>
              <p className="mt-2 text-[15px] text-hp-text/70">
                Metricool prices by brand and treats X as an add-on. What that costs, and the open-source question answered
                honestly.
              </p>
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <Link href="/alternatives" className="font-bold text-hp-text hover:text-hp-primary-text">
                All alternatives
              </Link>
              <p className="mt-2 text-[15px] text-hp-text/70">
                Buffer, Hootsuite, Later, Sprout Social, Publer, SocialPilot, Agorapulse, Planoly and more, side by side.
              </p>
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <Link href="/best-social-media-scheduler-india" className="font-bold text-hp-text hover:text-hp-primary-text">
                Best schedulers in India
              </Link>
              <p className="mt-2 text-[15px] text-hp-text/70">
                Sixteen tools on rupee pricing, UPI and pricing model, including the India-priced ones.
              </p>
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Questions</h2>
          <dl className="mt-8 flex flex-col gap-8">
            {FAQ.map((f) => (
              <div key={f.q} className="min-w-0">
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[72ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-12 rounded-3xl border border-hp-border-strong bg-gradient-to-b from-hp-elevated to-hp-surface p-8 text-center sm:p-12">
            <h2 className="text-3xl font-bold font-jakarta sm:text-4xl">Put next week on the calendar</h2>
            <p className="mx-auto mt-4 max-w-lg text-hp-text/70">
              {offer(
                `Free plan: ${FREE.channel} channels, ${FREE.posts_per_month} posts a month, no card.`,
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
