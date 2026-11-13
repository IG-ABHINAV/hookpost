import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { offer, TRIAL_CTA, TRIAL_ROW } from '../../trial-offer';
import { USD_HOOKPOST_MONTH, planPrice, usdCopy } from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// Targets "typefully alternative", "typefully pricing" and "cheaper typefully
// alternative". Hookpost numbers are read from pricing.ts. Typefully numbers
// were read off typefully.com/pricing on TYPEFULLY_CHECKED (the page renders
// prices client-side, so they were read in a browser, loaded from India):
//   Free $0: 1 social set, 1 user, 10 posts/month, API + MCP, no AI
//   Creator $99/year, annual billing only: 1,000 posts/month, AI, X analytics
//   Business $18/mo per social set billed yearly, $20 monthly: up to 50 social
//     sets, unlimited users, 1,500 posts/month
//   Networks (comparison table, every plan): X, Bluesky, LinkedIn, Threads,
//     Mastodon; plus Substack Notes (typefully.com/changelog/substack-notes)
// Re-check all of it before bumping the date. Typefully is not in
// competitor-facts, which is why IndiaCostNote is not used here.
const CANONICAL = 'https://hookpost.hookstep.in/alternatives/typefully';
const TYPEFULLY_CHECKED = '26 September 2026';
const TF_PRICING = 'https://typefully.com/pricing';
const TF_SOCIAL_SETS = 'https://support.typefully.com/en/articles/8717684-social-sets-and-accounts';
const TF_SUBSTACK = 'https://typefully.com/changelog/substack-notes';

const FREE = pricingINR.FREE;
const HP_INR = pricingINR.HOOKPOST;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

const HOOKPOST_ONLY = [
  ['YouTube', '/channels/youtube'],
  ['Discord', '/channels/discord'],
  ['Slack', '/channels/slack'],
  ['Telegram', '/channels/telegram'],
  ['WordPress', '/channels/wordpress'],
  ['Hashnode', '/channels/hashnode'],
  ['Dev.to', '/channels/devto'],
  ['Lemmy', '/channels/lemmy'],
  ['Nostr', '/channels/nostr'],
  ['Listmonk', '/channels/listmonk'],
] as const;

const ROWS: [string, string, string][] = [
  ['Free plan', '1 social set, 1 user, 10 posts a month', offer(`${FREE.channel} channels, ${FREE.posts_per_month} posts a month`, TRIAL_ROW)],
  ['API and MCP on the free plan', 'Yes', offer('No, on the Hookpost plan', 'No free plan; on the Hookpost plan')],
  ['AI writing', 'Creator and Business', 'the Hookpost plan'],
  ['Cheapest paid plan', 'Creator, $99 a year, annual billing only, 1,000 posts a month', `Hookpost, ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month`, `${USD_HOOKPOST_MONTH} a month (${HOOKPOST_DISPLAY_PRICE} in India)`)}, ${HP_INR.channel} channels, ${HP_INR.posts_per_month.toLocaleString('en-IN')} posts`],
  ['Next plan up', 'Business, $18 per social set a month billed yearly, $20 monthly', 'No other paid plan: one flat price'],
  ['Networks', 'X, LinkedIn, Threads, Bluesky, Mastodon, Substack Notes', 'X, LinkedIn profiles, YouTube, Facebook Pages, Bluesky, Discord, Slack, Telegram, WordPress, Hashnode, Dev.to, Lemmy, Nostr, Listmonk'],
  ['Currency from India', 'US dollars', 'Rupees'],
];

const FAQ = [
  {
    q: 'How much does Typefully cost?',
    a: `On ${TYPEFULLY_CHECKED} Typefully's pricing page listed Free at $0, Creator at $99 a year (annual billing only) and Business at $18 per social set a month billed yearly, or $20 billed monthly. Enterprise is priced on request.`,
  },
  {
    q: 'Does Typefully have a free plan?',
    a: 'Yes. It allows 1 social set, 1 user and 10 posts a month, and includes its API and MCP server. AI writing and X analytics start on Creator.',
  },
  {
    q: 'Is Hookpost a cheaper Typefully alternative?',
    a: `It depends on what you post to and how you pay. Typefully Creator is $99 a year, paid in dollars, for one social set. Hookpost is ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month, paid in rupees, for ${HP_INR.channel} channels; which is cheaper depends on the rate your card gives you for dollars.`, `${USD_HOOKPOST_MONTH} a month for ${HP_INR.channel} channels, paid in dollars by card; in India it is ${HOOKPOST_DISPLAY_PRICE} a month, paid in rupees.`)} If you only write for X and LinkedIn and want the API on a free plan, Typefully fits. If you also publish to YouTube, Discord, Telegram, Slack or a developer blog, Hookpost covers them.`,
  },
  {
    q: 'Can Hookpost post to Mastodon or Threads?',
    a: 'Mastodon, no. Threads is one of Hookpost’s channels: text, image or video posts up to 500 characters (counted in bytes, so fewer in Hindi). Typefully supports both Threads and Mastodon.',
  },
  {
    q: 'Does Hookpost have an API and MCP server?',
    a: `Yes, on the Hookpost plan. Claude, Cursor and other MCP clients can list your channels and schedule posts. ${offer('Unlike Typefully, the free plan does not include them.', 'Typefully includes them on its free plan; Hookpost has no free plan.')}`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Typefully Alternative & Pricing Compared | Hookpost',
  description:
    'Typefully costs $99/year for Creator and $18 per social set on Business. How Hookpost compares on price, ' + offer('free plan limits', 'trials') + ' and networks, checked Sep 2026.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Typefully alternative: pricing and networks compared - Hookpost',
    description: `Typefully is writing-first for X, LinkedIn, Threads, Bluesky and Mastodon. Hookpost covers ${PUBLISHABLE_CHANNEL_COUNT} networks at a flat price.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'article',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Typefully alternative - Hookpost' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Typefully alternative: pricing and networks compared - Hookpost',
    description: `Typefully is writing-first for X, LinkedIn, Threads, Bluesky and Mastodon. Hookpost covers ${PUBLISHABLE_CHANNEL_COUNT} networks at a flat price.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function TypefullyAlternativePage() {
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
          { '@type': 'ListItem', position: 2, name: 'Alternatives', item: 'https://hookpost.hookstep.in/alternatives' },
          { '@type': 'ListItem', position: 3, name: 'Typefully alternative', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Alternatives · Typefully</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          A Typefully alternative for more than X and LinkedIn
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Typefully is a writing-first tool for X, LinkedIn, Threads, Bluesky, Mastodon and Substack Notes, and it does that well. Hookpost is
          a scheduler that also publishes to YouTube, Discord, Slack, Telegram and developer blogs, at a flat{' '}
          <strong className="text-hp-text">{planPrice('HOOKPOST', ' a month')}</strong> for {HP_INR.channel} channels. Here is where each one is
          the better pick.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            See every plan limit
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Typefully pricing today</h2>
        <p className="mt-3 max-w-[70ch] text-hp-text/60">
          Read off{' '}
          <a href={TF_PRICING} rel="nofollow noopener" target="_blank" className="text-hp-primary-text underline">typefully.com/pricing</a>{' '}
          on {TYPEFULLY_CHECKED}. Prices change; follow the link to confirm.
        </p>
        <ul className="mt-6 grid gap-3 sm:grid-cols-3 text-hp-text/80">
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Free, $0.</strong> 1 social set, 1 user, 10 posts a month, limited media uploads. Includes the
            API, MCP server and AI agent integrations. No AI writing or analytics.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Creator, $99 a year.</strong> Annual billing only. 1 social set, 1 user, 1,000 posts a month, AI
            writing features, X analytics and unlimited media uploads.
          </li>
          <li className="rounded-2xl border border-hp-border p-5">
            <strong className="text-hp-text">Business, $18 per social set a month</strong> billed yearly, or $20 monthly. Up to 50 social sets,
            unlimited users, 1,500 posts a month, team roles and Slack notifications.
          </li>
        </ul>
        <p className="mt-6 max-w-[70ch] text-hp-text/60">
          A{' '}
          <a href={TF_SOCIAL_SETS} rel="nofollow noopener" target="_blank" className="text-hp-primary-text underline">social set</a>{' '}
          groups the accounts of one person or brand across Typefully&apos;s networks. Every plan can publish to all of them, including{' '}
          <a href={TF_SUBSTACK} rel="nofollow noopener" target="_blank" className="text-hp-primary-text underline">Substack Notes</a>.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Typefully and Hookpost side by side</h2>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] border-collapse text-left text-sm">
              <caption className="sr-only">Typefully and Hookpost compared</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold"></th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Typefully</th>
                  <th scope="col" className="py-3 font-semibold">Hookpost</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map(([label, tf, hp]) => (
                  <tr key={label} className="border-b border-hp-border">
                    <th scope="row" className="py-4 pe-4 font-bold">{label}</th>
                    <td className="py-4 pe-4 text-hp-text/80">{tf}</td>
                    <td className="py-4 text-hp-text/80">{hp}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10 grid gap-10 md:grid-cols-2">
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold tracking-tight font-jakarta text-balance">Where Typefully is stronger</h2>
            <ul className="mt-5 flex flex-col gap-3 text-hp-text/75 list-disc ps-6">
              <li>{offer("Its free plan includes the API and MCP server. Hookpost's free plan does not.", 'Its free plan includes the API and MCP server, where Hookpost has no free plan.')}</li>
              <li>Mastodon and Substack Notes. Hookpost publishes to neither.</li>
              <li>Dedicated long-form X analytics, a writing assistant built around threads, and shared drafts with comments.</li>
              <li>Business has unlimited users. For one writer on X and LinkedIn, Creator at $99 a year is cheaper than Hookpost.</li>
            </ul>
          </div>
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold tracking-tight font-jakarta text-balance">Where Hookpost is stronger</h2>
            <ul className="mt-5 flex flex-col gap-3 text-hp-text/75 list-disc ps-6">
              <li>Ten networks Typefully does not publish to (listed below), on the same calendar as X, LinkedIn and Bluesky.</li>
              {offer(<li>A bigger free plan: {FREE.posts_per_month} posts a month on {FREE.channel} channels, against 10 posts on Typefully Free.</li>, null)}
              <li>Flat plans. Hookpost is {HP_INR.channel} channels for one price, not a fee per social set.</li>
              <li>Monthly billing on every paid plan, where Typefully Creator is annual only.</li>
              <li>Rupee pricing with UPI for Indian customers.</li>
            </ul>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[1100px] px-5 pb-16 sm:px-10">
          <h3 className="text-xl font-bold font-jakarta">Networks on Hookpost that Typefully does not cover</h3>
          <ul className="mt-4 flex flex-wrap gap-2">
            {HOOKPOST_ONLY.map(([name, href]) => (
              <li key={href}>
                <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  {name}
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-4 max-w-[70ch] text-sm text-hp-text/55">
            Hookpost&apos;s LinkedIn support covers personal profiles, not Company Pages. X threads are supported.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">From India</h2>
          <p className="mt-6 max-w-[70ch] text-hp-text/75">
            When we loaded Typefully&apos;s pricing page from India on {TYPEFULLY_CHECKED}, it showed prices in US dollars, so you pay by
            international card at your bank&apos;s exchange rate. Hookpost bills Indian customers in rupees through Razorpay:{' '}
            {HOOKPOST_DISPLAY_PRICE} a month, with UPI, cards and net banking.
          </p>
          <p className="mt-4 text-hp-text/60">
            More on{' '}
            <Link href="/social-media-scheduler-india" className="text-hp-primary-text underline">rupee pricing and UPI Autopay</Link>.
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
            Other comparisons:{' '}
            <Link href="/alternatives/buffer" className="text-hp-primary-text underline">Buffer</Link>,{' '}
            <Link href="/alternatives/publer" className="text-hp-primary-text underline">Publer</Link>
            {offer(
              <>
                ,{' '}
                <Link href="/free-social-media-scheduler" className="text-hp-primary-text underline">free schedulers</Link>
              </>,
              null
            )}
            .
          </p>
        </div>
      </section>
    </div>
  );
}
