import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  COMPETITOR_FACTS,
  CompetitorFacts,
  FACTS_CHECKED,
  INDIA_FACTS,
  INDIA_FACTS_CHECKED,
  priceAmount,
} from '../compare/competitor-facts';
import { withSocial } from '../social-meta';
import { FREE_POSTS, offer, TRIAL_ROW } from '../trial-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// Targets "best social media scheduler India" / "best social media management
// tool India" / "social media scheduling tools India". Page 1 for those is
// global listicles that never mention rupees, UPI or which tools localise to
// INR (Veritas run, 28 Sep 2026), so a roundup built on that one axis is both
// useful and uncontested.
//
// Every competitor figure is read from competitor-facts.ts (vendor pricing
// pages, checked on FACTS_CHECKED); Hookpost's from pricing.ts. Nothing about a
// vendor is typed here - update competitor-facts.ts, not this page. The only
// hand-written text per tool is the "best for" line, and each one is derived
// from a fact in that file.
//
// 11 Oct 2026: added the India-priced tools now ranking (Posttely, PostStage)
// and two dollar-billed ones (RecurPost, Predis.ai) from INDIA_FACTS, checked
// that day. PostStage lists UPI through Razorpay, so the page no longer says
// Hookpost is the only tool that takes UPI. Added the free native schedulers, so the
// page says when no tool is needed. Instagram/Threads/TikTok are no longer
// described as "all live": see channel-specs.ts for why.
//
// Later on 11 Oct 2026: added Poststack (Indian agencies; rupee plans with UPI
// AutoPay) and Statusbrew, both read from a browser in India, and the rupee
// figures Hootsuite, Zoho Social, Publer and SocialPilot show an Indian
// visitor (inrEntry). With Poststack, UPI Autopay is no longer Hookpost-only,
// so nothing here says it is.

const CANONICAL = 'https://hookpost.hookstep.in/best-social-media-scheduler-india';
const { FREE, HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

// Order: Hookpost first (disclosed below), then the tools that show rupee
// prices to Indian visitors, then the dollar-billed ones.
const ORDER = ['posttely', 'poststage', 'poststack', 'zoho-social', 'publer', 'socialpilot', 'hootsuite', 'buffer', 'metricool', 'later', 'recurpost', 'predis-ai', 'statusbrew', 'postiz', 'mixpost'];
const FACTS: Record<string, CompetitorFacts> = { ...COMPETITOR_FACTS, ...INDIA_FACTS };
// Counted from the rows that actually render (Hookpost plus every ORDER slug
// that has facts), so the number in the title, intro and llms.txt matches the table.
const TOOLS = ORDER.map((k) => FACTS[k]).filter(Boolean);
const TOOL_COUNT = TOOLS.length + 1;

const BEST_FOR: Record<string, string> = {
  posttely: 'The lowest rupee price here: 10 channels for ₹299 a month plus GST, and a free plan with 28 posts a month. Pays by card or PayPal; UPI is not listed.',
  poststage: 'Rupee plans paid by UPI, cards or NetBanking through Razorpay, with GST invoices. 15 channels from ₹499 a month, but the free plan is 1 channel without X.',
  recurpost: 'Recycling evergreen posts from content libraries. US dollars from $9 a month for 2 accounts; no free plan.',
  'predis-ai': 'Generating the post creative with AI first and scheduling second. US dollars, no free plan, a 3-day trial that needs a card.',
  poststack: 'Indian agencies that want client review links with no login, rupee plans with UPI AutoPay and GST invoices. Starts at ₹2,000 a month for 3 accounts, so it costs more than the others for one brand.',
  statusbrew: 'Teams that want an inbox, comment moderation and reporting with scheduling. US dollars from India, $69 a month billed yearly for 5 profiles; MCP only on Enterprise.',
  'zoho-social': 'The biggest free plan here (6 channels), Standard at ₹900 a month for 13 channels, and WhatsApp Business and Arattai support.',
  publer: 'One or two accounts: ₹484.15 a month per account on Professional, shown in rupees in India. Cost grows with every account you add.',
  socialpilot: 'Small agencies: in India the entry plan is Standard, ₹2,000 a month (₹1,700 billed yearly) for 10 accounts and 1 user.',
  hootsuite: 'Teams that want an established enterprise suite and can budget per user: ₹1,999 per user a month (billed yearly) for 10 accounts.',
  buffer: 'Trying a scheduler for free on 3 channels. Paid plans are per channel, in US dollars.',
  metricool: 'Instagram and Facebook-first brands. The free plan allows 20 posts a month but leaves out X and LinkedIn.',
  later: 'Instagram and TikTok-first brands: 8 channels on the entry plan, no free plan.',
  postiz: 'Developers who want the larger project, hosted in US dollars.',
  mixpost: 'Self-hosting on your own server with a one-time licence instead of a subscription.',
};

const price = (c: CompetitorFacts) => {
  const p = c.cheapestPaid;
  if (!p) return 'Not published';
  const sym = p.currency === 'USD' ? '$' : p.currency === 'INR' ? '₹' : `${p.currency} `;
  if (p.billing === 'one-time') return `${sym}${priceAmount(p)} one-time`;
  return `${sym}${priceAmount(p)} / ${p.per.replace('/month', '').replace('month', 'mo')}${p.billing === 'annual' ? ' (billed yearly)' : ''}`;
};

const freeCell = (c: CompetitorFacts) =>
  c.freePlan ? c.freePlan : c.freeTrialDays ? `No (${c.freeTrialDays}-day trial)` : 'No';

const rupeeCell = (c: CompetitorFacts) =>
  c.inr == null
    ? 'Not stated'
    : c.inr
    ? c.cheapestPaid?.currency === 'INR'
      ? 'Yes, priced in rupees'
      : 'Yes, localised'
    : 'No, US dollars';

const upiCell = (c: CompetitorFacts) => (c.upi ? c.upiNote || 'Yes' : 'Not listed');

const FAQ = [
  {
    q: 'What is the best social media scheduler in India?',
    a: `It depends on how you want to pay and how many accounts you run. The cheapest rupee plan we found is Posttely at ₹299 a month plus GST for 10 channels. For UPI Autopay with an API, MCP server and developer channels, Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels. For an agency that wants client review links, Poststack starts at ₹2,000 a month. For the largest free plan, Zoho Social gives 6 channels free. For an established enterprise suite, Hootsuite is ₹1,999 per user a month in India.`,
  },
  {
    q: 'Which social media schedulers accept UPI?',
    a: 'Three on this page name UPI on their pricing pages. Hookpost and Poststack set up UPI AutoPay for the subscription; PostStage lists UPI alongside cards and NetBanking through Razorpay. Posttely bills in rupees by card or PayPal. Hootsuite, Zoho Social, Publer and SocialPilot show rupee prices to Indian visitors but do not list UPI. The rest bill in US dollars, which needs a card enabled for international payments.',
  },
  {
    q: 'Is there a free social media scheduler for Indian businesses?',
    a: `Yes. Zoho Social's free plan covers 6 channels, Buffer's covers 3 channels with 10 queued posts each, Posttely's allows 28 posts a month, Metricool's 20 posts a month without X or LinkedIn, ${offer(`PostStage's 1 channel and 15 posts, and Hookpost's ${FREE.channel} channels and ${FREE.posts_per_month} posts a month including X and LinkedIn. Hootsuite, Later and SocialPilot offer trials, not free plans.`, `and PostStage's 1 channel and 15 posts. Hootsuite, Later and SocialPilot offer trials, not free plans; Hookpost gives ${FREE_POSTS} with no card.`)} And for one network, its own scheduler is free: Meta Business Suite for Facebook and Instagram, LinkedIn's clock icon, YouTube Studio.`,
  },
  {
    q: 'Per channel, per user or flat: which pricing is cheapest?',
    a: `Per-channel plans (Buffer, Publer) are cheapest for one or two accounts and grow with every account you add. Per-user plans (Hootsuite, Sprout Social, Agorapulse) grow with your team. Flat tiers (Hookpost, Zoho Social, SocialPilot, Later) cost the same until you outgrow the tier: Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels and up to ${HOOKPOST.team_member_limit} team members.`,
  },
  {
    q: 'Can I schedule Instagram posts from India with these tools?',
    a: 'Yes, every tool here lists Instagram. Instagram’s API only lets apps publish automatically to Business or Creator accounts, so use one of those. If Instagram is your only network, Instagram’s own app and Meta Business Suite schedule posts for free.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Best Social Media Schedulers in India (2026) | Hookpost',
  description: `${TOOL_COUNT} social media schedulers compared for Indian teams: free plans, rupee prices, UPI and per-channel vs flat pricing, read off each vendor's pricing page.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Best social media schedulers in India (2026), compared in rupees',
    description: `Free plans, rupee prices, UPI and pricing models for ${TOOL_COUNT} schedulers, read off each vendor page.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'article',
    locale: 'en_IN',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Best social media schedulers in India' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Best social media schedulers in India (2026)',
    description: `${TOOL_COUNT} tools compared on free plans, rupee prices and UPI.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function BestSchedulerIndiaPage() {
  const tools = TOOLS;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${CANONICAL}#article`,
        headline: 'The best social media schedulers for India in 2026',
        inLanguage: 'en-IN',
        datePublished: '2026-09-28T00:00:00+05:30',
        dateModified: '2026-10-11T00:00:00+05:30',
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@type': 'Organization', name: 'Hookstep', url: 'https://hookpost.hookstep.in/about' },
        mainEntityOfPage: CANONICAL,
      },
      {
        '@type': 'ItemList',
        '@id': `${CANONICAL}#list`,
        name: 'Social media schedulers for India',
        itemListElement: [{ name: 'Hookpost', url: 'https://hookpost.hookstep.in/' }, ...tools.map((t) => ({ name: t.name, url: t.sources[0] }))].map(
          (t, i) => ({ '@type': 'ListItem', position: i + 1, name: t.name, url: t.url })
        ),
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
          { '@type': 'ListItem', position: 2, name: 'Best social media schedulers in India', item: CANONICAL },
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
          Prices checked {FACTS_CHECKED} and {INDIA_FACTS_CHECKED}
        </p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          The best social media schedulers for India in 2026
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Most &quot;best scheduler&quot; lists are written for US buyers, so they never tell you which tools show rupee prices,
          which take UPI, or whether you pay per channel, per user or one flat fee. This one does. {TOOL_COUNT} tools, including
          three that price in rupees for everyone, with every figure read off the vendor&apos;s own pricing page.
        </p>
        <p className="mt-4 max-w-[70ch] rounded-xl border border-hp-border bg-white/[0.03] p-4 text-sm text-hp-text/70">
          <strong className="text-hp-text">Disclosure:</strong> we make Hookpost, so it is listed first. Every other tool is
          described from its own pricing page, linked below, and the &quot;best for&quot; line under each one says who should
          pick it over us.
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-10 sm:px-10" aria-labelledby="short-answer">
        <h2 id="short-answer" className="text-2xl font-extrabold tracking-tight font-jakarta">The short answer</h2>
        <ul className="mt-4 flex max-w-[75ch] flex-col gap-2 text-hp-text/80">
          <li>
            <strong className="text-hp-text">Lowest rupee price:</strong> Posttely, ₹299 a month plus GST for 10 channels.
          </li>
          <li>
            <strong className="text-hp-text">UPI Autopay, API and AI-agent support:</strong> Hookpost, {HOOKPOST_DISPLAY_PRICE} a
            month for {HOOKPOST.channel} channels, {offer('free plan included', `${FREE_POSTS} first`)}.
          </li>
          <li>
            <strong className="text-hp-text">Rupee plans paid by UPI, more channels:</strong> PostStage, 15 channels from ₹499 a month.
          </li>
          <li>
            <strong className="text-hp-text">Agencies that need client review links:</strong> Poststack, from ₹2,000 a month for
            3 accounts, UPI AutoPay.
          </li>
          <li>
            <strong className="text-hp-text">Biggest free plan:</strong> Zoho Social, 6 channels free.
          </li>
          <li>
            <strong className="text-hp-text">An established enterprise suite:</strong> Hootsuite, priced per user.
          </li>
          <li>
            <strong className="text-hp-text">Self-host on your own server:</strong> Postiz (AGPL-3.0), or Mixpost with a
            one-time licence.
          </li>
        </ul>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 pb-10 sm:px-10" aria-labelledby="table">
        <h2 id="table" className="text-2xl font-extrabold tracking-tight font-jakarta">All {TOOL_COUNT} side by side</h2>
        <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[860px] border-collapse text-left text-sm">
            <caption className="sr-only">Social media schedulers for India compared</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                {['Tool', 'Free plan', 'Cheapest paid plan', 'Pricing model', 'Rupee prices in India', 'UPI listed'].map((h) => (
                  <th key={h} scope="col" className="py-3 pe-4 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              <tr className="border-b border-hp-border bg-hp-primary/[0.06]">
                <th scope="row" className={`${cell} font-bold text-hp-text`}>Hookpost</th>
                <td className={cell}>{offer(`${FREE.channel} channels, ${FREE.posts_per_month} posts a month`, TRIAL_ROW)}</td>
                <td className={cell}>{HOOKPOST_DISPLAY_PRICE} / mo for {HOOKPOST.channel} channels</td>
                <td className={cell}>flat tiers</td>
                <td className={cell}>Yes, billed in rupees</td>
                <td className={cell}>Yes, UPI Autopay</td>
              </tr>
              {tools.map((c) => (
                <tr key={c.slug} className="border-b border-hp-border">
                  <th scope="row" className={`${cell} font-bold text-hp-text`}>{c.name}</th>
                  <td className={cell}>{freeCell(c)}</td>
                  <td className={cell}>{price(c)}</td>
                  <td className={cell}>{c.pricingModel || 'Not stated'}</td>
                  <td className={cell}>{rupeeCell(c)}</td>
                  <td className={cell}>{upiCell(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-hp-text/55">
          &quot;Rupee prices in India&quot; means the vendor&apos;s pricing page switched to INR for an Indian visitor when we checked.
          The cheapest paid plan is shown as the vendor lists it, which for most is a US-dollar figure. Vendors change prices and
          currency by country, so confirm on their page before you buy. Posttely, PostStage, Poststack, Statusbrew, RecurPost and
          Predis.ai were checked on {INDIA_FACTS_CHECKED}, as were the rupee figures for Hootsuite, Zoho Social, Publer and
          SocialPilot (from India); the rest on {FACTS_CHECKED}. Rupee prices exclude GST unless the vendor says otherwise.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Each tool, and who it suits</h2>
          <div className="mt-8 flex flex-col gap-6">
            <article className="rounded-2xl border border-hp-primary/40 p-6">
              <h3 className="text-xl font-bold font-jakarta">1. Hookpost</h3>
              <p className="mt-2 text-hp-text/75">
                An AI social media scheduler made in India and billed in rupees through Razorpay, with UPI Autopay, cards and
                NetBanking. {offer(`Free plan for ${FREE.channel} channels;`, `${FREE_POSTS};`)} Hookpost is {HOOKPOST_DISPLAY_PRICE} a month for {HOOKPOST.channel} channels and{' '}
                {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts, with AI captions, the API and an MCP server for
                Claude and Cursor, and up to {HOOKPOST.team_member_limit} team members.
              </p>
              <p className="mt-2 text-sm text-hp-text/60">
                <strong className="text-hp-text/80">Best for:</strong> UPI Autopay at one flat price, teams that want an API or an
                AI assistant to post for them, and anyone who also posts to developer and community channels such as Bluesky,
                Telegram, Discord and Dev.to.
              </p>
              <p className="mt-3 text-sm">
                <Link href="/social-media-scheduler-india" className="text-hp-primary-text underline">Hookpost for India</Link>
                {' · '}
                <Link href="/pricing" className="text-hp-primary-text underline">Every plan limit</Link>
              </p>
            </article>
            {tools.map((c, i) => (
              <article key={c.slug} className="rounded-2xl border border-hp-border p-6">
                <h3 className="text-xl font-bold font-jakarta">
                  {i + 2}. {c.name}
                </h3>
                <p className="mt-2 text-hp-text/75">
                  Free plan: {c.freePlan || 'none'}
                  {!c.freePlan && c.freeTrialDays ? ` (${c.freeTrialDays}-day trial)` : ''}. Cheapest paid plan:{' '}
                  {c.cheapestPaid?.name ? `${c.cheapestPaid.name}, ` : ''}
                  {price(c)}
                  {c.cheapestPaid?.channelsIncluded ? `, ${c.cheapestPaid.channelsIncluded} channel${c.cheapestPaid.channelsIncluded === 1 ? '' : 's'} included` : ''}.
                  {' '}Rupee prices in India: {rupeeCell(c).toLowerCase()}.
                  {c.inrEntry && c.cheapestPaid?.currency !== 'INR' ? ` Seen from India: ${c.inrEntry}.` : ''}
                  {c.openSource ? ` Licence: ${c.openSource}.` : ''}
                </p>
                <p className="mt-2 text-sm text-hp-text/60">
                  <strong className="text-hp-text/80">Best for:</strong> {BEST_FOR[c.slug]}
                </p>
                <p className="mt-3 text-sm text-hp-text/55">
                  Source:{' '}
                  <a href={c.sources[0]} rel="nofollow noopener" target="_blank" className="underline">
                    {c.sources[0].replace('https://', '')}
                  </a>
                  {c.hasAlternativePage ? (
                    <>
                      {' · '}
                      <Link href={`/alternatives/${c.slug}`} className="text-hp-primary-text underline">
                        Hookpost vs {c.name}
                      </Link>
                    </>
                  ) : null}
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border" id="free-native">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">When you do not need a tool at all</h2>
          <p className="mt-4 max-w-[75ch] text-hp-text/75">
            If you post to one or two networks, their own schedulers are free and good enough:
          </p>
          <ul className="mt-4 flex max-w-[75ch] list-disc flex-col gap-2 ps-5 text-hp-text/80">
            <li><strong className="text-hp-text">Facebook Page and Instagram:</strong> Meta Business Suite schedules both from one screen.</li>
            <li><strong className="text-hp-text">LinkedIn:</strong> the clock icon in the post window, up to three months ahead.</li>
            <li><strong className="text-hp-text">YouTube:</strong> YouTube Studio&apos;s Schedule option when you upload.</li>
            <li><strong className="text-hp-text">Threads:</strong> Schedule in the composer&apos;s menu. <strong className="text-hp-text">X:</strong> the schedule icon on x.com, where your account has it.</li>
          </ul>
          <p className="mt-4 max-w-[75ch] text-hp-text/70">
            A tool earns its price when the same update goes to three or more networks, when a team shares one calendar, or when
            scripts and AI assistants post for you. Step-by-step native scheduling in Hinglish:{' '}
            <Link href="/guides/social-media-post-schedule-kaise-kare" className="text-hp-primary-text underline">
              social media post schedule kaise kare
            </Link>
            .
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">How to choose, in three questions</h2>
          <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-4 ps-5 text-hp-text/80">
            <li>
              <strong className="text-hp-text">How will you pay?</strong> A dollar-billed tool needs a card enabled for
              international payments, and the rupee cost moves with the exchange rate. Posttely, PostStage and Poststack price
              in rupees for everyone, and four more show rupee prices to Indian visitors. UPI is listed by Hookpost and Poststack
              (as Autopay for the subscription) and by PostStage.
            </li>
            <li>
              <strong className="text-hp-text">How many accounts, and how many people?</strong> Per-channel pricing is cheapest for
              one or two accounts; per-user pricing gets expensive as the team grows; flat tiers stay the same until you outgrow
              them.
            </li>
            <li>
              <strong className="text-hp-text">Which networks matter?</strong> WhatsApp Business is on Zoho Social and Hootsuite.
              Poststack covers six networks: Instagram, Facebook, LinkedIn, X, YouTube and Threads.
              Dev.to, Hashnode, Discord, Telegram and Bluesky are on Hookpost. Check the{' '}
              <Link href="/channels" className="text-hp-primary-text underline">channel list</Link> before you commit.
            </li>
          </ol>
          <p className="mt-8 text-hp-text/60">
            More comparisons: <Link href="/compare" className="text-hp-primary-text underline">12 tools on price, API and MCP</Link>,{' '}
            {offer(
              <>
                <Link href="/free-social-media-scheduler" className="text-hp-primary-text underline">free plans compared</Link>,{' '}
              </>,
              null
            )}
            <Link href="/alternatives" className="text-hp-primary-text underline">alternatives</Link>.
          </p>
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
