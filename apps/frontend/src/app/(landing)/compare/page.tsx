import Link from 'next/link';
import { Metadata } from 'next';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, CompetitorFacts, FACTS_CHECKED, PAIRS, priceAmount } from './competitor-facts';
import { withSocial } from '../social-meta';
import { FREE_POSTS, offer } from '../trial-offer';
import { planPrice } from '../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// The comparison hub. Every competitor figure is read from competitor-facts.ts
// (vendor pricing pages, checked on FACTS_CHECKED); Hookpost's from pricing.ts.
// This page used to hand-type its matrix and had drifted into claims like a
// "$0 tier with AI" (Free has no AI) and Buffer "AI extra cost" (Buffer's free
// plan includes its AI assistant). Nothing here is typed by hand any more.

const CANONICAL = 'https://hookpost.hookstep.in/compare';
const { FREE, HOOKPOST } = pricingINR;

const price = (c: CompetitorFacts) => {
  const p = c.cheapestPaid;
  if (!p) return 'Not published';
  const sym = p.currency === 'USD' ? '$' : p.currency === 'EUR' ? '€' : `${p.currency} `;
  if (p.billing === 'one-time') return `${sym}${priceAmount(p)} one-time`;
  return `${sym}${priceAmount(p)} / ${p.per.replace('/month', '').replace('month', 'mo')}${p.billing === 'annual' ? ' (annual)' : ''}`;
};

const free = (c: CompetitorFacts) =>
  c.freePlan ? 'Yes' : c.freeTrialDays ? `${c.freeTrialDays}-day trial` : 'No';

const ORDER = ['buffer', 'hootsuite', 'later', 'sprout-social', 'metricool', 'publer', 'socialpilot', 'agorapulse', 'postiz', 'mixpost', 'zoho-social', 'sendible'];

const FAQ = [
  {
    q: 'Which social media scheduler has the best free plan?',
    a: `It depends on your networks. Buffer's free plan gives 3 channels with 10 queued posts per channel and includes its AI assistant. Metricool's free plan allows 20 posts a month but leaves out X and LinkedIn. ${offer(`Hookpost's free plan gives ${FREE.channel} channels and ${FREE.posts_per_month} posts a month including X and LinkedIn, without AI.`, `Hookpost has no free plan: it starts with ${FREE_POSTS}, no card needed.`)} Hootsuite, Later, Sprout Social and SocialPilot have trials, not free plans.`,
  },
  {
    q: 'Which schedulers have an MCP server for AI agents?',
    a: 'Most of them now do. Of the twelve tools checked, ten list an MCP server or AI-agent integration, including Buffer (on its free plan), Hootsuite, Postiz and Metricool. Hookpost has one too, on the Hookpost plan.',
  },
  {
    q: 'Can I pay for a social media scheduler in rupees with UPI?',
    a: `Hootsuite, Zoho Social, Publer and SocialPilot show rupee prices to Indian visitors, but none of the twelve lists UPI. Hookpost bills in rupees with UPI Autopay: Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels.`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Compare Social Media Schedulers: 12 Tools, Real Prices',
  description:
    'Buffer, Hootsuite, Later, Sprout, Metricool, Publer, Postiz, Mixpost and more compared on price, free plan, API and MCP, from vendor pages.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Compare social media schedulers - 12 tools, real prices',
    description: 'Cheapest plan, free plan, API and MCP for 12 schedulers, read from each vendor page.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Social media scheduler comparison' }],
  },
});

export default function ComparePage() {
  const tools = ORDER.map((k) => COMPETITOR_FACTS[k]).filter(Boolean);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Compare', item: CANONICAL },
        ],
      },
    ],
  };

  const cell = 'py-3 pe-4 align-top';
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1200px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Checked {FACTS_CHECKED}</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Social media schedulers compared
        </h1>
        <p className="mt-4 max-w-[70ch] text-lg text-hp-text/70">
          Twelve schedulers and Hookpost on the things that decide the bill: the cheapest paid plan, how it is priced, whether
          there is a free plan, and whether you get an API or an MCP server for AI agents. Every figure was
          read off the vendor&apos;s own pricing page, linked on each comparison.
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1200px] px-5 py-10 sm:px-10">
        <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[900px] border-collapse text-left text-sm">
            <caption className="sr-only">Social media schedulers compared</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                {['Tool', 'Cheapest paid plan', 'Pricing model', 'Free plan', 'API', 'MCP / AI agents', 'Rupee prices'].map((h) => (
                  <th key={h} scope="col" className="py-3 pe-4 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              <tr className="border-b border-hp-border bg-hp-primary/[0.06]">
                <th scope="row" className={`${cell} font-bold text-hp-text`}>Hookpost</th>
                <td className={cell}>{planPrice('HOOKPOST', ' / mo')}</td>
                <td className={cell}>flat tiers</td>
                <td className={cell}>{offer('Yes', FREE_POSTS)}</td>
                <td className={cell}>Yes</td>
                <td className={cell}>Yes</td>
                <td className={cell}>Yes, UPI Autopay</td>
              </tr>
              {tools.map((c) => (
                <tr key={c.slug} className="border-b border-hp-border">
                  <th scope="row" className={`${cell} font-bold text-hp-text`}>
                    {c.hasAlternativePage ? (
                      <Link href={`/alternatives/${c.slug}`} className="hover:text-hp-primary-text">{c.name}</Link>
                    ) : (
                      c.name
                    )}
                  </th>
                  <td className={cell}>{price(c)}</td>
                  <td className={cell}>{c.pricingModel || '—'}</td>
                  <td className={cell}>{free(c)}</td>
                  <td className={cell}>{c.api == null ? 'Not stated' : c.api ? 'Yes' : 'No'}</td>
                  <td className={cell}>{c.mcp == null ? 'Not stated' : c.mcp ? 'Yes' : 'No'}</td>
                  <td className={cell}>{c.inr == null ? 'Not stated' : c.inr ? 'Yes (localised)' : 'No, USD'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-hp-text/55">
          USD prices are the cheapest plan as listed; annual means billed yearly. Several vendors change prices and currency by
          country. Confirm on the vendor&apos;s page before you buy.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1200px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Head-to-head comparisons</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {PAIRS.map((p) => {
              const [a, b] = p.split('-vs-');
              return (
                <li key={p}>
                  <Link
                    href={`/compare/${p}`}
                    className="block rounded-xl border border-hp-border px-4 py-3 font-semibold transition-colors hover:border-hp-primary/50 hover:text-hp-primary-text"
                  >
                    {COMPETITOR_FACTS[a].name} vs {COMPETITOR_FACTS[b].name}
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="mt-8 text-hp-text/60">
            Looking for a replacement rather than a matchup? See{' '}
            <Link href="/alternatives" className="text-hp-primary-text underline">alternatives</Link>
            {offer(
              <>
                ,{' '}
                <Link href="/free-social-media-scheduler" className="text-hp-primary-text underline">free plans compared</Link>
              </>,
              null
            )}
            . Buying from India? <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">Schedulers compared in rupees</Link>.
            Want an AI assistant to post? <Link href="/social-media-mcp-servers" className="text-hp-primary-text underline">MCP servers compared</Link>.
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
