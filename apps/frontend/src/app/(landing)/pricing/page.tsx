import { Metadata } from 'next';
import { HolidayOfferStrip } from '@hookpost/frontend/components/billing/holiday.offer.banner';
import { currentFestival } from '@hookpost/frontend/components/billing/holiday.offer';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { PricingPlans } from '../PricingPlans';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { COMPETITOR_FACTS, FACTS_CHECKED } from '../compare/competitor-facts';
import {
  pricingINR,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import {
  planFeatureLabel,
  planLimitCells,
  planLimitItems,
} from '@hookpost/frontend/components/billing/plan.features';
import {
  FIRST_PAYMENT_WHEN,
  FREE_POSTS,
  LANDING_TIERS,
  offer,
  TRIAL_ONLY,
  TRIAL_SENTENCE,
} from '../trial-offer';
import {
  USD_MARKETED,
  USD_HOOKPOST_MONTH,
  usdAggregateOffer,
  usdCopy,
} from '../usd-offer';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// Read the prices rather than retyping them. This paragraph used to hardcode
// a list of prices; when the paid tiers were repriced the cards below
// updated from pricing.ts and this sentence did not, so the page stated two
// different prices at once. Derived strings cannot drift.
// One plan is sold (HOOKPOST, 8 Nov 2026); Standard, Pro, Team and Ultimate
// are retired and only exist for the workspaces that already have them.
const HOOKPOST_INR = pricingINR.HOOKPOST;
// The one shown price, to every visitor (pricing.ts HOOKPOST_PRICE).
const priceINR = HOOKPOST_DISPLAY_PRICE;
// AI videos are only advertised while the sold plan actually grants them; the
// kie.ai balance is 0, so generate_videos is 0 and this column disappears.
const SHOW_VIDEOS = !!HOOKPOST_INR.generate_videos;

/**
 * /pricing. Cloudflare caches this page for every visitor, so nothing here may
 * depend on the request's country: whatever the server picked from the geo
 * headers was really the country of the first visitor after a purge (usually a
 * US crawler). Everything is in rupees, which is all checkout charges while
 * international checkout is off (PHASE2.md). The plan cards ask the uncached
 * /api/public/pricing-context whether to add a line for visitors abroad.
 * Actual figures come from pricing.ts - do not restate them here.
 */

const CANONICAL = 'https://hookpost.hookstep.in/pricing';

export const metadata: Metadata = withSocial({
  title: 'Hookpost Pricing: One flat plan, no per-channel fee',
  description: offer(
    `Hookpost pricing: a free plan, then one flat monthly plan at ${USD_HOOKPOST_MONTH} with no per-channel fee. Every limit listed, from posts per month to AI captions.`,
    `Hookpost pricing: ${FREE_POSTS}, then one flat monthly plan at ${USD_HOOKPOST_MONTH} with no per-channel fee. Every limit listed, from posts per month to AI captions.`
  ),
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Hookpost Pricing — one flat plan, no per-channel fee',
    description: offer(
      'Free tier plus one paid plan with every limit listed, including posts per month and AI generation caps.',
      `${FREE_POSTS}, then one plan with every limit listed, including posts per month and AI generation caps.`
    ),
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Hookpost Pricing Plans',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hookpost Pricing — one flat plan, no per-channel fee',
    description: offer(
      'Free tier plus one paid plan. No per-channel fee and no setup fee.',
      `${FREE_POSTS}, then one plan. No per-channel fee and no setup fee.`
    ),
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

/** A plan's limits as one line for structured data: the cards' lines, in order. */
const limitsLine = (plan: (typeof pricingINR)[string]) =>
  `${planLimitItems(plan)
    .map((f) => planFeatureLabel(f))
    .join('; ')}.`;

/**
 * The rupee AggregateOffer as it is, or beside a dollar one once the dollar
 * plans are sold (usd-offer.ts).
 */
const withUsdOffer = (inr: Record<string, unknown>) => {
  const usd = usdAggregateOffer(LANDING_TIERS, CANONICAL, (tier) => {
    return limitsLine(pricingUSD[tier]);
  });
  return usd ? [inr, usd] : inr;
};

// While a Free plan exists, the first answer describes it. Once new users have
// none, it describes the free posts and what comes after them.
const FREE_PLAN_FAQ = offer(
  {
    q: 'Is there a free plan?',
    a: 'Yes. The Free plan costs nothing, does not expire and includes 2 channels, 30 posts a month and the visual calendar. It does not include AI generation or API access.',
  },
  {
    q: 'Can I try Hookpost before paying?',
    a: `${TRIAL_SENTENCE} ${FIRST_PAYMENT_WHEN}`,
  }
);

const CHARGE_FAQ = {
  // UPI is rupees only: once dollars are sold too, the question is general.
  q: usdCopy('When is my card or UPI charged?', 'When am I charged?'),
  a: `Not for the ${FREE_POSTS}, which need no payment method. ${FIRST_PAYMENT_WHEN} Hookpost is ${priceINR} a month${usdCopy('', ` (${USD_HOOKPOST_MONTH} outside India)`)}, the same price every month, and the billing page shows when your current month ends.`,
};

// Hookpost is billed monthly only: pricing.ts has year_price 0 for it.
const YEARLY_FAQ = {
  q: 'Is there a yearly plan?',
  a: `No. Hookpost is billed monthly only, at ${priceINR} a month${usdCopy('', ` (${USD_HOOKPOST_MONTH} outside India)`)}. There is no yearly price and no first-month discount.`,
};

// The three the owner measures Hookpost against (22 Oct 2026): Buffer, which
// bills per channel and has a free plan; Hootsuite, which bills per user; and
// Postiz, the closest product, with no hosted free plan and a trial. Every
// figure is read from competitor-facts.ts and pricing.ts, so a price change
// there changes this answer too.
const BUFFER = COMPETITOR_FACTS.buffer;
const HOOTSUITE = COMPETITOR_FACTS.hootsuite;
const POSTIZ = COMPETITOR_FACTS.postiz;
const COMPETITOR_FAQ = {
  q: 'How does this compare with Buffer, Hootsuite and Postiz?',
  a: [
    `Buffer charges per channel, $${BUFFER.cheapestPaid!.price} a channel a month billed yearly, so ${HOOKPOST_INR.channel} channels cost $${BUFFER.cheapestPaid!.price * (HOOKPOST_INR.channel ?? 0)} a month; it also has a free plan (${BUFFER.freePlan}).`,
    `Hootsuite charges per user: ₹${HOOTSUITE.inrPlan!.yearlyPerMonth!.toLocaleString('en-IN')} a user a month billed yearly in India, for up to ${HOOTSUITE.inrPlan!.channels} accounts.`,
    `Postiz Standard is $${POSTIZ.cheapestPaid!.price} a month billed yearly for ${POSTIZ.cheapestPaid!.channelsIncluded} channels, after a ${POSTIZ.freeTrialDays}-day trial.`,
    `Hookpost is ${priceINR} a month${usdCopy('', ` (${USD_HOOKPOST_MONTH} outside India)`)} for ${HOOKPOST_INR.channel} channels and up to ${HOOKPOST_INR.team_member_limit} team members, ${offer('with a Free plan to start', `after ${FREE_POSTS}`)}.`,
    `Competitor prices are from each vendor's pricing page, checked ${FACTS_CHECKED}; Hootsuite's rupee price on ${HOOTSUITE.inrChecked}.`,
  ].join(' '),
};

const FAQ = [
  {
    q: 'Does Hookpost charge per social channel?',
    a: 'No. Hookpost is one flat monthly price, and the channel count is a limit inside the plan, not a per-channel fee. Each connected profile or page counts as one channel.',
  },
  {
    q: 'What currencies can I pay in?',
    a: usdCopy(
      'Hookpost is billed in Indian rupees through Razorpay: UPI, a debit or credit card, or NetBanking. A card issued outside India may be declined; if yours is, email support@hookstep.in.',
      `In India, Hookpost is billed in Indian rupees through Razorpay: UPI, a debit or credit card, or NetBanking. Outside India it is billed in US dollars by card, ${USD_HOOKPOST_MONTH} a month. The plan card on this page show the currency you would be billed in; if it looks wrong, email support@hookstep.in.`
    ),
  },
  FREE_PLAN_FAQ,
  {
    q: 'What happens when I hit the monthly post limit?',
    a: 'Publishing is blocked for the rest of the billing month once the plan limit is reached. The limits are enforced in code, not just advertised, so the number on this page is the number you get.',
  },
  CHARGE_FAQ,
  YEARLY_FAQ,
  COMPETITOR_FAQ,
];

export default function PricingPage() {
  // Limits are the same in every currency; prices are read per currency below.
  const activePricing = pricingINR;

  // LANDING_TIERS, not a retyped list - TEAM and ULTIMATE are retired and
  // this comparison table was still the one place advertising them. Free is
  // left out once new users have no Free plan (trial-offer.ts).
  const TIERS = LANDING_TIERS.map(
    (tier) => {
      const plan = activePricing[tier];
      return {
        name: `${tier.charAt(0)}${tier.slice(1).toLowerCase()}`,
        // Rupees: this page is cached for every visitor, so it cannot vary by
        // country. Once dollars are sold too, both prices, so the table is
        // true wherever it is read.
        priceFormatted:
          plan.month_price === 0
            ? 'Free'
            : HOOKPOST_DISPLAY_PRICE,
        // Rupees: the structured data below quotes INR only.
        priceNumber: plan.month_price === 0 ? '0' : String(HOOKPOST_PRICE.displayUsd),
        // Every limit, from planLimitCells: the same figures, in the same
        // words, as the plan cards above and the app's own plan list
        // (plan.features.ts). Team members is the enforced seat cap, owner
        // included (organization.service.ts refuses an invite past it).
        ...planLimitCells(plan),
        limits: limitsLine(plan),
      };
    }
  );

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Product',
        '@id': `${CANONICAL}#product`,
        name: 'Hookpost',
        description:
          `AI social media scheduling and publishing for ${PUBLISHABLE_CHANNEL_COUNT} networks, with a native MCP server.`,
        brand: { '@type': 'Brand', name: 'Hookpost' },
        // From pricing.ts, never the request's currency: it used to take that,
        // so the cached page told crawlers USD or INR depending on who filled
        // the cache. One currency per AggregateOffer: rupees, and once the
        // dollar plans are sold (usd-offer.ts) a second one in dollars, with
        // the rupee one marked for India. Rupees only is the object it always
        // was, so that build's structured data is unchanged.
        offers: withUsdOffer({
          '@type': 'AggregateOffer',
          url: CANONICAL,
          // Shown in dollars to everyone (pricing.ts HOOKPOST_PRICE).
          priceCurrency: 'USD',
          // The cheapest plan a new user can get: Free, or Hookpost once
          // every new workspace gets free posts and then pays.
          lowPrice: TRIAL_ONLY ? String(HOOKPOST_PRICE.displayUsd) : '0',
          highPrice: String(HOOKPOST_PRICE.displayUsd),
          offerCount: String(TIERS.length),
          offers: TIERS.map((t) => ({
            '@type': 'Offer',
            name: `${t.name} plan`,
            price: t.priceNumber,
            priceCurrency: 'USD',
            url: CANONICAL,
            availability: 'https://schema.org/InStock',
            description: t.limits,
          })),
        }),
      },
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
        '@id': `${CANONICAL}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Pricing', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav />
      {/* The current festival's offer and theme (holiday.offer.ts); gone once the calendar runs out. */}
      <HolidayOfferStrip initialKey={currentFestival()?.key ?? null} />

      <section className="mx-auto w-full max-w-[1280px] px-5 pt-16 text-center sm:px-10">
        <h1 className="text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Hookpost pricing
        </h1>
        <p className="mx-auto mt-4 max-w-[62ch] text-lg text-hp-text/70 text-balance">
          {offer(
            <>
              Hookpost is free on the Free plan, and the paid plan costs {priceINR} a month.
              There is no per-channel fee and no setup fee.
            </>,
            `Hookpost is one plan, ${priceINR} a month, after ${FREE_POSTS} with no card. There is no per-channel fee and no setup fee.`
          )}
          {usdCopy(null, ` Outside India the same plan is ${USD_HOOKPOST_MONTH} a month.`)}
          {' It is billed monthly, with no yearly price.'}
        </p>
      </section>

      <PricingPlans />

      {/* --------------------------------------------------- full tier table */}
      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
            Every limit, in one table
          </h2>
          <p className="mt-3 max-w-[62ch] text-hp-text/60">
            These are enforced limits, not guidance. Publishing stops when the
            monthly post count is reached.
          </p>

          <div className="mt-10 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[960px] border-collapse text-left text-sm">
              <caption className="sr-only">
                Hookpost plan limits by tier
              </caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pr-4 font-semibold">Plan</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Price / mo</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Channels</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Posts / month</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">Team members (you included)</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">AI credits / month</th>
                  <th scope="col" className="py-3 pr-4 font-semibold">AI images</th>
                  {SHOW_VIDEOS && (
                    <th scope="col" className="py-3 pr-4 font-semibold">AI videos / month</th>
                  )}
                  <th scope="col" className="py-3 pr-4 font-semibold">Public API, MCP server &amp; CLI</th>
                  <th scope="col" className="py-3 font-semibold">Webhooks</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {TIERS.map((t) => (
                  <tr key={t.name} className="border-b border-white/[0.08]">
                    <th scope="row" className="py-3 pr-4 font-semibold text-hp-text">{t.name}</th>
                    <td className="py-3 pr-4 font-semibold text-hp-primary-text">{t.priceFormatted}</td>
                    <td className="py-3 pr-4 text-hp-text/70">{t.channels}</td>
                    <td className="py-3 pr-4 text-hp-text/70">{t.posts}</td>
                    <td className="py-3 pr-4 text-hp-text/70">{t.team}</td>
                    <td className="py-3 pr-4 text-hp-text/70">{t.aiText}</td>
                    <td className="py-3 pr-4 text-hp-text/70">{t.aiImages}</td>
                    {SHOW_VIDEOS && (
                      <td className="py-3 pr-4 text-hp-text/70">{t.aiVideos}</td>
                    )}
                    <td className="py-3 pr-4 text-hp-text/70">{t.apiMcpCli}</td>
                    <td className="py-3 text-hp-text/70">{t.webhooks}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- faq */}
      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-20 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
            Pricing questions
          </h2>
          <dl className="mt-10 flex flex-col gap-8">
            {FAQ.map((f) => (
              <div key={f.q} className="min-w-0">
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>

          <p className="mt-12 text-hp-text/60">
            <Link href="/contact" className="text-hp-primary-text underline">
              Ask us
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
