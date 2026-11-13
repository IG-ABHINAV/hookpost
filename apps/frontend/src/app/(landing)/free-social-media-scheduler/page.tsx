import { Metadata } from 'next';
import Link from 'next/link';
import { permanentRedirect } from 'next/navigation';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import { TRIAL_ONLY } from '../trial-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// Targets "free social media scheduler" and its variants. Every Hookpost number
// on this page is read from pricing.ts; competitor numbers were read off their
// own pricing pages on COMPETITORS_CHECKED and must be re-checked before that
// date is bumped. A comparison table with one stale figure is worse than none.
const CANONICAL = 'https://hookpost.hookstep.in/free-social-media-scheduler';
const COMPETITORS_CHECKED = '25 September 2026';
// Posttely and PostStage (India-priced, ranking for "free scheduler" queries)
// were read off their pricing pages on this date.
const INDIA_CHECKED = '11 October 2026';
//
// 11 Oct 2026: the title still says "X & LinkedIn" on purpose. Retitle to
// something like "Free Social Media Scheduler: 2 Channels, No Card" only after
// fix/play-readiness ships (a free account could not add Facebook, Instagram or
// YouTube as its second channel) and an Instagram publish from a normal account
// is confirmed. No trial-length promise (it is a per-account offer), and the
// free plan's lack of API/MCP is stated wherever AI assistants come up.

const FREE = pricingINR.FREE;
const HOOKPOST = pricingINR.HOOKPOST;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

// Networks a brand-new user can connect and publish to today. Instagram and
// Threads are left out on purpose while their Meta permissions are in
// review - see channel-specs.ts for the full list and its caveats.
const FREE_NETWORKS = [
  ['X (Twitter)', '/channels/x'],
  ['LinkedIn', '/channels/linkedin'],
  ['YouTube', '/channels/youtube'],
  ['Facebook Pages', '/channels/facebook'],
  ['Bluesky', '/channels/bluesky'],
  ['Discord', '/channels/discord'],
  ['Slack', '/channels/slack'],
  ['Telegram', '/channels/telegram'],
  ['WordPress', '/channels/wordpress'],
  ['Hashnode', '/channels/hashnode'],
  ['Dev.to', '/channels/devto'],
] as const;

const COMPARISON: {
  name: string;
  free: string;
  paid: string;
  source: string;
  highlight?: boolean;
}[] = [
  {
    name: 'Hookpost',
    free: `${FREE.channel} channels, ${FREE.posts_per_month} posts a month, X and LinkedIn included`,
    paid: `${HOOKPOST_DISPLAY_PRICE}/month flat for ${HOOKPOST.channel} channels`,
    source: '/pricing',
    highlight: true,
  },
  {
    name: 'Buffer',
    free: '3 channels, 10 scheduled posts per channel',
    paid: '$5 per channel per month ($60/year per channel)',
    source: 'https://buffer.com/pricing',
  },
  {
    name: 'Metricool',
    free: '1 brand, 20 posts a month, no X or LinkedIn',
    paid: 'Starter from $20/month',
    source: 'https://metricool.com/pricing/',
  },
  {
    name: 'Hootsuite',
    free: 'No free plan (14-day trial)',
    paid: 'Standard $99/month, billed annually',
    source: 'https://www.hootsuite.com/plans',
  },
  {
    name: 'Later',
    free: 'No free plan (14-day trial)',
    paid: 'Starter $18.75/month, billed yearly',
    source: 'https://later.com/pricing/',
  },
  {
    name: 'Posttely',
    free: '1 workspace, 28 scheduled posts a month',
    paid: '₹299/month plus GST for 10 channels',
    source: 'https://posttely.com/pricing',
  },
  {
    name: 'PostStage',
    free: '1 channel, 15 posts a month, no X',
    paid: '₹499/month for 15 channels',
    source: 'https://trypoststage.com/pricing',
  },
];

const FAQ = [
  {
    q: 'Is Hookpost really free?',
    a: `Yes. The Free plan costs ${inr(0)} with no time limit and no card. It includes ${FREE.channel} connected channels and ${FREE.posts_per_month} scheduled posts a month on the visual calendar. It does not include the AI writing assistant or API access.`,
  },
  {
    q: 'What is the best free social media scheduler?',
    a: `It depends on which networks you post to. Buffer's free plan allows 3 channels but only 10 queued posts per channel. Metricool's free plan excludes X and LinkedIn. Hookpost's free plan allows ${FREE.posts_per_month} posts a month across ${FREE.channel} channels, including X and LinkedIn. Hootsuite and Later have no free plan.`,
  },
  {
    q: 'Which networks can I schedule for free?',
    a: 'Any network Hookpost supports, up to two of them: for example X, LinkedIn, YouTube, Facebook Pages, an Instagram Business or Creator account, Threads, Bluesky, Telegram, Discord or Dev.to. TikTok posts publish with the audience your TikTok account allows, or go to your TikTok inbox as drafts.',
  },
  {
    q: 'What happens when I need more than the free plan?',
    a: `Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels and ${HOOKPOST.posts_per_month} posts, with AI writing, the REST API and the MCP server. It is one flat price, not a fee per channel, billed in rupees with UPI Autopay.`,
  },
  {
    q: 'Can I schedule posts from Claude or ChatGPT on the free plan?',
    a: 'No. The free plan has no API key, and the MCP server that lets Claude, Claude Code, Cursor or ChatGPT schedule posts needs the Hookpost plan. On Free you can still draft in any AI chat and paste the text into the Hookpost editor.',
  },
  {
    q: 'Is there a free Instagram scheduler?',
    a: 'Yes: Instagram’s own app and Meta Business Suite schedule posts for free on a Business or Creator account. Hookpost’s free plan adds a second network on the same calendar, for example Instagram plus LinkedIn.',
  },
  {
    q: 'Is there a free LinkedIn post scheduler?',
    a: `LinkedIn has one built in: the clock icon in the post window schedules up to three months ahead. Hookpost’s free plan schedules LinkedIn alongside one other network, with ${FREE.posts_per_month} posts a month.`,
  },
];

// With the trial required the page only redirects (below), so its head says
// nothing about a Free plan either.
export const metadata: Metadata = TRIAL_ONLY
  ? { title: 'Hookpost Pricing', robots: { index: false, follow: true } }
  : withSocial({
  title: 'Free Social Media Scheduler for X & LinkedIn | Hookpost',
  description: `Schedule ${FREE.posts_per_month} posts a month to X, LinkedIn, YouTube and Bluesky free, no card. Compared with the free plans of Buffer, Metricool and Hootsuite.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Free social media scheduler - Hookpost',
    description: `${FREE.channel} channels, ${FREE.posts_per_month} posts a month, X and LinkedIn included. No card needed.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Hookpost free social media scheduler' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Free social media scheduler - Hookpost',
    description: `${FREE.channel} channels, ${FREE.posts_per_month} posts a month, X and LinkedIn included.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function FreeSchedulerPage() {
  // Once new users have no Free plan (a trial cutoff is set, trial-offer.ts),
  // this page has nothing true left to say: it redirects permanently to
  // /pricing, and the sitemap, the footer and llms.txt stop listing it. The
  // plan's default (local-assets/trial-usd-plan-2026-10-18.md, owner decision
  // 6); a rewrite around the trial is the alternative. Decided at build, like
  // the rest of the copy.
  if (TRIAL_ONLY) permanentRedirect('/pricing');

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
          { '@type': 'ListItem', position: 2, name: 'Free social media scheduler', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Free plan · no card</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          A free social media scheduler that includes X and LinkedIn
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Hookpost is a free social media scheduler: its Free plan lets you schedule <strong className="text-hp-text">{FREE.posts_per_month} posts a month</strong> across{' '}
          <strong className="text-hp-text">{FREE.channel} channels</strong> for {inr(0)}, with no time limit and no card. You plan
          everything on one visual calendar and Hookpost publishes at the time you pick.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            Start free
          </Link>
          <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            See every plan limit
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What the free plan includes</h2>
        <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
          <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">{FREE.channel} connected channels.</strong> Any two of the networks below, for example one X account and one LinkedIn profile.</li>
          <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">{FREE.posts_per_month} scheduled posts a month.</strong> Counted across all channels and reset every billing month. The limit is enforced in code, so it is exactly what you get.</li>
          <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">Visual calendar.</strong> Drag posts between days, preview them per network, and see what goes out when.</li>
          <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">Per-network checks before publishing.</strong> Character limits and media rules are validated before a post is queued, not after it fails.</li>
        </ul>
        <p className="mt-6 max-w-[70ch] text-hp-text/60">
          Not included on Free: the AI writing assistant, AI images, the REST API and the MCP server. Those are on the Hookpost plan at{' '}
          {HOOKPOST_DISPLAY_PRICE} a month.
        </p>

        <h3 className="mt-12 text-xl font-bold font-jakarta">Networks you can schedule for free</h3>
        <ul className="mt-4 flex flex-wrap gap-2">
          {FREE_NETWORKS.map(([name, href]) => (
            <li key={href}>
              <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                {name}
              </Link>
            </li>
          ))}
        </ul>
        <p className="mt-4 max-w-[70ch] text-sm text-hp-text/55">
          Instagram (Business or Creator account), Threads, Pinterest and TikTok can be one of your two channels too; TikTok posts
          publish with the audience your TikTok account allows, or go to your TikTok inbox as drafts. Full list:{' '}
          <Link href="/channels" className="underline">all channels</Link>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Free plans compared</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/60">
            Read off each company&apos;s own pricing page on {COMPETITORS_CHECKED} (Posttely and PostStage on {INDIA_CHECKED}).
            Prices change; follow the source link to confirm.
          </p>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <caption className="sr-only">Free social media scheduler plans compared</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Free plan</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Cheapest paid plan</th>
                  <th scope="col" className="py-3 font-semibold">Source</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON.map((row) => (
                  <tr key={row.name} className={`border-b border-hp-border ${row.highlight ? 'bg-hp-primary/[0.06]' : ''}`}>
                    <th scope="row" className="py-4 pe-4 font-bold">{row.name}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{row.free}</td>
                    <td className="py-4 pe-4 text-hp-text/80">{row.paid}</td>
                    <td className="py-4">
                      <a
                        href={row.source}
                        className="text-hp-primary-text underline"
                        {...(row.source.startsWith('http') ? { rel: 'nofollow noopener', target: '_blank' } : {})}
                      >
                        {row.source.startsWith('http') ? 'pricing page' : 'our pricing'}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            The honest summary: Buffer gives you one more channel and its AI assistant for free, but caps each channel at 10 queued posts. Metricool leaves
            out X and LinkedIn entirely. Posttely&apos;s free plan allows 28 posts a month and its paid plan is the cheapest here in
            rupees. If X or LinkedIn is where you post, Hookpost&apos;s free plan goes further than Metricool&apos;s or
            PostStage&apos;s. When you outgrow it, you pay one flat price instead of a fee per channel.
          </p>
          <p className="mt-4 text-hp-text/60">
            Detailed comparisons:{' '}
            <Link href="/alternatives/buffer" className="text-hp-primary-text underline">Buffer</Link>,{' '}
            <Link href="/alternatives/metricool" className="text-hp-primary-text underline">Metricool</Link>,{' '}
            <Link href="/alternatives/hootsuite" className="text-hp-primary-text underline">Hootsuite</Link>,{' '}
            <Link href="/alternatives/later" className="text-hp-primary-text underline">Later</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border" id="by-network">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Free options by what you need</h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">A free Instagram scheduler</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                Instagram&apos;s app and Meta Business Suite already schedule posts and Reels for free on a Business or Creator
                account, so for Instagram alone you need nothing else. A tool helps when Instagram is one of several networks.
                Instagram&apos;s API only lets apps publish automatically to Business or Creator accounts, so Hookpost connects those.{' '}
                <Link href="/channels/instagram" className="text-hp-primary-text underline">Scheduling Instagram posts in Hookpost</Link>.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">A free LinkedIn post scheduler</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                LinkedIn&apos;s clock icon schedules profile posts up to three months ahead. Hookpost&apos;s free plan schedules
                LinkedIn posts, image carousels and video to your profile next to one other network, and checks the 3,000-character
                limit before queueing. Company Pages are not available in Hookpost.{' '}
                <Link href="/channels/linkedin" className="text-hp-primary-text underline">Scheduling LinkedIn posts in Hookpost</Link>.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">A free scheduler in India</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                Free plans do not need a card, so currency only matters when you upgrade. Hookpost&apos;s paid plans are in rupees
                with UPI Autopay; Posttely and PostStage also price in rupees.{' '}
                <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">All the India options compared</Link>.
              </p>
            </div>
            <div className="rounded-2xl border border-hp-border p-6">
              <h3 className="text-xl font-bold font-jakarta">A free Buffer alternative</h3>
              <p className="mt-3 text-[15px] text-hp-text/70">
                Buffer&apos;s free plan gives 3 channels with 10 queued posts each, then charges per channel in US dollars.
                Hookpost&apos;s gives {FREE.channel} channels and {FREE.posts_per_month} posts a month, then one flat rupee price for{' '}
                {HOOKPOST.channel} channels.{' '}
                <Link href="/alternatives/buffer" className="text-hp-primary-text underline">Hookpost vs Buffer in detail</Link>.
              </p>
            </div>
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/60">
            How each network&apos;s own scheduler works, step by step in Hinglish:{' '}
            <Link href="/guides/social-media-post-schedule-kaise-kare" className="text-hp-primary-text underline">social media post schedule kaise kare</Link>.
            Posting one update to both your free channels:{' '}
            <Link href="/guides/post-to-multiple-social-media-at-once" className="text-hp-primary-text underline">post to several networks at once</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Schedule your first post in three steps</h2>
          <ol className="mt-6 flex flex-col gap-4 text-hp-text/80 list-decimal ps-6">
            <li><strong className="text-hp-text">Sign up</strong> with Google or email. Choose &quot;Continue with Free Plan&quot; on the plan screen.</li>
            <li><strong className="text-hp-text">Connect a channel</strong>, for example your X account or LinkedIn profile. Most networks connect with one OAuth click.</li>
            <li><strong className="text-hp-text">Write the post, pick a date and time</strong>, and add it to the calendar. Hookpost publishes it then, even if your laptop is closed.</li>
          </ol>
          <p className="mt-6 text-hp-text/60">
            Checking length first? Use the free{' '}
            <Link href="/tools/character-counter" className="text-hp-primary-text underline">character counter</Link>{' '}
            to test a post against every network&apos;s limit.
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
            In India? See{' '}
            <Link href="/social-media-scheduler-india" className="text-hp-primary-text underline">rupee pricing and UPI Autopay</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
