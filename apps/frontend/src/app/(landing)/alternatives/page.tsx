import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { SectionFaq } from "../SectionFaq";
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, CompetitorFacts, FACTS_CHECKED } from '../compare/competitor-facts';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { withSocial } from '../social-meta';
import { offer, TRIAL_CTA, TRIAL_FAQ_ANSWER, TRIAL_SENTENCE } from '../trial-offer';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';

// Hub for the /alternatives pages (and the /vs pages that live apart).
//
// Rewritten 11 Oct 2026. The old hub led with Hookpost's dollar prices and a
// dollar-on-dollar "3-year TCO", told readers to "download your scheduled
// posts CSV" (Hookpost has no CSV import), and asked "why do agencies prefer
// Hookpost" with nothing behind it. India is the market (owner rule: no
// dollar-first copy), so Hookpost is priced in rupees only, competitors in
// whatever currency an Indian visitor is shown, and the two are never
// converted into each other. Every competitor figure is read from
// compare/competitor-facts.ts (vendor pricing pages, FACTS_CHECKED; rupee
// figures read from India on 11 Oct 2026); every Hookpost figure from
// pricing.ts. Nothing about a vendor is typed here except the one-line
// "why people look for an alternative", and each of those restates a fact
// from that file.

const { FREE, HOOKPOST } = pricingINR;
const rupees = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const dollars = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const CANONICAL = "https://hookpost.hookstep.in/alternatives";

const FACTS = Object.values(COMPETITOR_FACTS);
const MCP_COUNT = FACTS.filter((c) => c.mcp === true).length;
const RUPEE_TOOLS = FACTS.filter((c) => c.inr).map((c) => c.name);
const CHANNELS_COMPARED = HOOKPOST.channel;

interface Card {
  slug: string;
  name: string;
  href: string;
  why: string;
}

// One line each: the fact that sends people looking for an alternative.
const CARDS: Card[] = [
  { slug: 'buffer', name: 'Buffer', href: '/alternatives/buffer', why: 'Charges per channel, in US dollars: $5 a channel a month billed yearly. Its free plan has 3 channels and includes its AI assistant.' },
  { slug: 'hootsuite', name: 'Hootsuite', href: '/alternatives/hootsuite', why: offer('Charges per user: ₹1,999 a user a month billed yearly in India, no free plan.', 'Charges per user: ₹1,999 a user a month billed yearly in India.') },
  { slug: 'later', name: 'Later', href: '/alternatives/later', why: offer('No free plan and no X. Starter is $18.75 a month billed yearly for 8 profiles.', 'No X. Starter is $18.75 a month billed yearly for 8 profiles.') },
  { slug: 'metricool', name: 'Metricool', href: '/alternatives/metricool', why: 'Its free plan leaves out LinkedIn and X; paid plans are in euros or dollars.' },
  { slug: 'publer', name: 'Publer', href: '/alternatives/publer', why: 'Charges per account: ₹484.15 an account a month on Professional in India, so cost grows with every account.' },
  { slug: 'socialpilot', name: 'SocialPilot', href: '/alternatives/socialpilot', why: offer('No free plan. In India the cheapest plan is ₹2,000 a month for 10 accounts and one user.', 'In India the cheapest plan is ₹2,000 a month for 10 accounts and one user.') },
  { slug: 'sprout-social', name: 'Sprout Social', href: '/alternatives/sprout-social', why: 'Charges per seat: $79 a seat a month billed yearly on Essentials, with 5 channels.' },
  { slug: 'agorapulse', name: 'Agorapulse', href: '/alternatives/agorapulse', why: offer('Charges per user: $79 a user a month billed yearly, no free plan.', 'Charges per user: $79 a user a month billed yearly.') },
  { slug: 'postiz', name: 'Postiz', href: '/alternatives/postiz', why: offer('No hosted free plan (7-day trial); hosted plans are in US dollars from $23 a month billed yearly.', 'Hosted plans are in US dollars from $23 a month billed yearly, so paying from India needs an international card.') },
  { slug: 'mixpost', name: 'Mixpost', href: '/alternatives/mixpost', why: 'Software you host yourself: Pro is a $299 one-time licence, plus your own server.' },
  { slug: 'planoly', name: 'Planoly', href: '/alternatives/planoly', why: 'Built around Instagram and Pinterest planning, priced per social set in US dollars from $14 a month.' },
  { slug: 'typefully', name: 'Typefully', href: '/alternatives/typefully', why: 'Writing-first for X, LinkedIn, Threads, Bluesky and Mastodon; no YouTube or community channels.' },
];

const VS_LINKS = [
  ['Zoho Social', '/vs/zoho-social'],
  ['Sendible', '/vs/sendible'],
  ['Loomly', '/vs/loomly'],
  ['Tailwind', '/vs/tailwind'],
  ['CoSchedule', '/vs/co-schedule'],
  ['MeetEdgar', '/vs/meet-edgar'],
] as const;

interface CostRow {
  name: string;
  href: string;
  plan: string;
  cost: string;
  currency: string;
  /** Rupees per channel at the cheapest billing, when the price is in rupees and flat. */
  perChannel: number | null;
}

// What running CHANNELS_COMPARED channels costs, as an Indian visitor sees each price.
const costFor = (c: CompetitorFacts, href: string): CostRow | null => {
  const r = c.inrPlan;
  if (r) {
    if (r.per === 'account/month') {
      const m = r.monthly ?? r.yearlyPerMonth!;
      return {
        name: c.name, href,
        plan: `${r.name}, ${CHANNELS_COMPARED} accounts`,
        cost: `${rupees(Math.round(m * CHANNELS_COMPARED * 100) / 100)} a month${r.yearlyPerMonth != null && r.monthly != null ? ` (${rupees(Math.round(r.yearlyPerMonth * CHANNELS_COMPARED * 100) / 100)} billed yearly)` : ''}`,
        currency: 'Rupees',
        perChannel: null,
      };
    }
    if (r.per === 'user/month') {
      const m = r.monthly ?? r.yearlyPerMonth!;
      return {
        name: c.name, href,
        plan: `${r.name}, 1 user${r.channels ? `, up to ${r.channels} accounts` : ''}`,
        cost: `${rupees(m)} a month${r.monthly == null ? ' billed yearly' : ''}, per user`,
        currency: 'Rupees',
        perChannel: null,
      };
    }
    const cheapest = Math.min(r.monthly ?? Infinity, r.yearlyPerMonth ?? Infinity);
    return {
      name: c.name, href,
      plan: `${r.name}, ${r.channels} channels${r.seats ? `, ${r.seats} user` : ''}`,
      cost: `${r.monthly != null ? rupees(r.monthly) : rupees(cheapest)} a month${r.monthly != null && r.yearlyPerMonth != null ? ` (${rupees(r.yearlyPerMonth)} billed yearly)` : ''}`,
      currency: 'Rupees',
      perChannel: r.channels ? Math.round((cheapest / r.channels) * 100) / 100 : null,
    };
  }
  const p = c.cheapestPaid;
  if (!p) return null;
  const billed = p.billing === 'annual' ? ' billed yearly' : '';
  if (p.billing === 'one-time') {
    return { name: c.name, href, plan: `${p.name} licence`, cost: `${dollars(p.price)} once, plus your own server`, currency: 'US dollars', perChannel: null };
  }
  if (p.per.startsWith('channel')) {
    return { name: c.name, href, plan: `${p.name}, ${CHANNELS_COMPARED} channels`, cost: `${dollars(Math.round(p.price * CHANNELS_COMPARED * 100) / 100)} a month${billed}`, currency: 'US dollars', perChannel: null };
  }
  if (p.per.startsWith('user')) {
    return { name: c.name, href, plan: `${p.name}, 1 user${p.channelsIncluded ? `, ${p.channelsIncluded} channels` : ''}`, cost: `${dollars(p.price)} a month${billed}, per user`, currency: 'US dollars', perChannel: null };
  }
  return { name: c.name, href, plan: `${p.name}${p.channelsIncluded ? `, ${p.channelsIncluded} channels` : ''}`, cost: `${dollars(p.price)} a month${billed}`, currency: p.currency === 'USD' ? 'US dollars' : p.currency, perChannel: null };
};

const COST_ORDER: [string, string][] = [
  ['zoho-social', '/vs/zoho-social'],
  ['publer', '/alternatives/publer'],
  ['socialpilot', '/alternatives/socialpilot'],
  ['hootsuite', '/alternatives/hootsuite'],
  ['buffer', '/alternatives/buffer'],
  ['later', '/alternatives/later'],
  ['postiz', '/alternatives/postiz'],
  ['sprout-social', '/alternatives/sprout-social'],
  ['agorapulse', '/alternatives/agorapulse'],
];
const COST_ROWS = COST_ORDER.map(([slug, href]) => (COMPETITOR_FACTS[slug] ? costFor(COMPETITOR_FACTS[slug], href) : null)).filter(
  (r): r is CostRow => Boolean(r)
);
const HOOKPOST_PER_CHANNEL = Math.round((HOOKPOST.month_price / HOOKPOST.channel) * 100) / 100;
const CHEAPEST_RUPEE = COST_ROWS.filter((r) => r.perChannel != null).sort((a, b) => a.perChannel! - b.perChannel!)[0];

const FAQ = [
  {
    name: "What is the best alternative to Buffer or Hootsuite?",
    acceptedAnswer: {
      text: `It depends on why you are leaving. If it is Buffer's per-channel price or Hootsuite's per-user price, look at flat-priced tools: Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels and up to ${HOOKPOST.team_member_limit} team members, billed in rupees with UPI Autopay. Zoho Social Standard is ₹900 a month for 13 channels in India (₹600 billed yearly). Hootsuite is ₹1,999 per user a month billed yearly in India, and Buffer $5 per channel a month billed yearly, in dollars. Buffer and Hootsuite both have MCP servers, so that is not a reason to move. Prices checked ${FACTS_CHECKED}; rupee figures from India on 11 October 2026.`,
    },
  },
  {
    name: "Which social media schedulers show prices in rupees?",
    acceptedAnswer: {
      text: `Of the ${FACTS.length} tools we track, ${RUPEE_TOOLS.join(', ')} show rupee prices to Indian visitors; none of them lists UPI on its pricing page. Hookpost bills in rupees through Razorpay, with UPI Autopay, cards and NetBanking. The rest bill in US dollars or euros, which needs a card that allows international payments. More tools priced for India, including Posttely, PostStage and Poststack, are on our list of the best schedulers for India.`,
    },
  },
  {
    name: `What does it cost to run ${CHANNELS_COMPARED} channels from India?`,
    acceptedAnswer: {
      text: `Hookpost: ${HOOKPOST_DISPLAY_PRICE} a month. ${COST_ROWS.map((r) => `${r.name} ${r.plan}: ${r.cost}`).join('. ')}. Rupee and dollar prices are shown as each vendor shows them to an Indian visitor; we do not convert between them.`,
    },
  },
  {
    name: "Do these tools have MCP servers for Claude and other AI assistants?",
    acceptedAnswer: {
      text: `Most do: ${MCP_COUNT} of the ${FACTS.length} tools we checked on ${FACTS_CHECKED} list an MCP server, including Buffer, Hootsuite, Publer and Postiz. Hookpost's is included on the Hookpost plan${offer(', not on Free', '')}.`,
    },
  },
  {
    name: "How do I move my scheduled posts to Hookpost?",
    acceptedAnswer: {
      text: "Connect your channels in Hookpost first; each network signs you in through its own page, and a few (Bluesky, Telegram, WordPress, Dev.to) take an app password, bot or API key instead. Hookpost has no CSV import, so recreate upcoming posts in the editor, or on the Hookpost plan create them through the public API, the CLI or an AI assistant over MCP. Keep the old tool until its queue has gone out.",
    },
  },
  {
    name: offer("Is Hookpost free?", "How much does Hookpost cost?"),
    acceptedAnswer: {
      text: offer(
        `The free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, with no time limit and no card. It has no AI writing, API or MCP; those are on the Hookpost plan at ${HOOKPOST_DISPLAY_PRICE} a month.`,
        `${TRIAL_FAQ_ANSWER} AI writing, the API and MCP come with the Hookpost plan (${HOOKPOST_DISPLAY_PRICE} a month).`
      ),
    },
  },
];

export const metadata: Metadata = withSocial({
  title: "Social Media Scheduler Alternatives (2026) | Hookpost",
  description: `Alternatives to Buffer, Hootsuite, Later, Publer, SocialPilot and 7 more, priced as an Indian buyer sees them, in rupees where the vendor shows them.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: "Social media scheduler alternatives, priced for India",
    description: "Buffer, Hootsuite, Later, Publer, SocialPilot, Sprout Social and more: what each costs from India and why people switch.",
    url: CANONICAL,
    siteName: "Hookpost",
    images: [{ url: "https://hookpost.hookstep.in/og-image.png", width: 1200, height: 630, alt: "Social media scheduler alternatives" }],
    locale: "en_IN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Social media scheduler alternatives, priced for India",
    description: "What Buffer, Hootsuite, Publer, SocialPilot and others cost from India, next to Hookpost.",
    images: ["https://hookpost.hookstep.in/og-image.png"],
  },
});

export default function AlternativesHubPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        "@id": `${CANONICAL}#page`,
        name: "Social media scheduler alternatives",
        url: CANONICAL,
        inLanguage: "en-IN",
        dateModified: "2026-10-11T00:00:00+05:30",
        publisher: { "@type": "Organization", name: "Hookstep", url: "https://hookpost.hookstep.in/about" },
        hasPart: CARDS.map((c) => ({ "@type": "WebPage", name: `${c.name} alternative`, url: `https://hookpost.hookstep.in${c.href}` })),
      },
      {
        "@type": "FAQPage",
        "@id": `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({ "@type": "Question", name: f.name, acceptedAnswer: { "@type": "Answer", text: f.acceptedAnswer.text } })),
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in/" },
          { "@type": "ListItem", position: 2, name: "Alternatives", item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" aria-label="Hookpost home" className="flex items-center gap-2 shrink-0">
          <img alt="" src="/brand-logo-96.webp" width="96" height="96" className="h-8 md:h-10 w-auto max-h-[38px] object-contain" />
          {/* Icon only on phones: the wordmark and both buttons need ~365px. */}<span className="hidden sm:inline text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/auth/login"
            className="text-sm font-medium text-hp-text hover:text-hp-primary-text transition-colors px-3 sm:px-4 py-2 whitespace-nowrap border border-hp-border-strong rounded-full hover:border-hp-primary"
          >
            Log In
          </Link>
          <Link
            href="/auth"
            className="text-sm font-medium bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary transition-all px-4 sm:px-5 py-2 rounded-full font-semibold whitespace-nowrap"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-5 sm:px-6 pt-12 pb-24 space-y-16">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center space-x-2">
            <li>
              <Link href="/" className="hover:text-hp-text transition-colors">Home</Link>
            </li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Alternatives</li>
          </ol>
        </nav>

        <div className="space-y-4 max-w-[900px]">
          <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">
            Prices checked {FACTS_CHECKED} · rupee prices read from India on 11 October 2026
          </p>
          <h1 className="text-[34px] sm:text-[52px] font-black tracking-tight text-hp-text leading-[1.15]">
            Social media scheduler alternatives, priced as an Indian buyer sees them
          </h1>
          <p className="text-hp-text-2 text-lg leading-relaxed">
            Most comparisons quote US dollar list prices. This one shows each tool the way it charges a buyer in India: rupees
            where the vendor shows them, dollars where it does not, and whether it charges per channel, per user or one flat price.
            We make Hookpost, so it is on every page; each page also says where the other tool is the better pick.
          </p>
        </div>

        <section aria-labelledby="pages" className="space-y-6">
          <h2 id="pages" className="text-2xl sm:text-3xl font-extrabold text-hp-text">Compare one tool with Hookpost</h2>
          <div className="grid md:grid-cols-2 gap-5">
            {CARDS.map((c) => (
              <Link
                key={c.slug}
                href={c.href}
                className="block bg-hp-surface border border-hp-border hover:border-hp-primary/40 rounded-2xl p-6 transition-colors"
              >
                <h3 className="text-xl font-bold text-hp-text">{c.name} alternative</h3>
                <p className="mt-2 text-sm text-hp-text/70 leading-relaxed">{c.why}</p>
                <span className="mt-3 inline-block text-sm font-semibold text-hp-primary-text">Hookpost vs {c.name} &rarr;</span>
              </Link>
            ))}
          </div>
          <p className="text-sm text-hp-text/60">
            Also compared:{' '}
            {VS_LINKS.map(([name, href], i) => (
              <React.Fragment key={href}>
                {i ? ', ' : ''}
                <Link href={href} className="text-hp-primary-text underline">{name}</Link>
              </React.Fragment>
            ))}
            . Two competitors side by side: <Link href="/compare" className="text-hp-primary-text underline">comparisons</Link>. Three at
            once, on pricing model and MCP:{' '}
            <Link href="/planable-vs-buffer-vs-hootsuite" className="text-hp-primary-text underline">Planable vs Buffer vs Hootsuite</Link>. Tools
            built for India: <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">the best schedulers for India</Link>.
          </p>
        </section>

        <section aria-labelledby="cost" className="space-y-5">
          <h2 id="cost" className="text-2xl sm:text-3xl font-extrabold text-hp-text">What {CHANNELS_COMPARED} channels cost a month, from India</h2>
          <p className="text-hp-text-2 max-w-[75ch] leading-relaxed">
            Each vendor&apos;s cheapest plan that covers {CHANNELS_COMPARED} channels, in the currency its pricing page shows an Indian visitor. We
            do not convert dollars to rupees: your card&apos;s rate and any foreign-transaction fee decide that.
          </p>
          <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[680px] text-left text-sm border-collapse">
              <caption className="sr-only">Monthly cost of {CHANNELS_COMPARED} channels by tool, as shown in India</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  {['Tool', 'Plan', 'Cost', 'Currency'].map((h) => (
                    <th key={h} scope="col" className="py-3 pe-4 font-semibold">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="text-hp-text/80">
                <tr className="border-b border-hp-border bg-hp-primary/[0.06]">
                  <th scope="row" className="py-3 pe-4 font-bold text-hp-text">Hookpost</th>
                  <td className="py-3 pe-4">Hookpost, {HOOKPOST.channel} channels</td>
                  <td className="py-3 pe-4">{HOOKPOST_DISPLAY_PRICE} a month</td>
                  <td className="py-3 pe-4">Rupees, UPI Autopay</td>
                </tr>
                {COST_ROWS.map((r) => (
                  <tr key={r.name} className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-bold text-hp-text">
                      <Link href={r.href} className="hover:text-hp-primary-text">{r.name}</Link>
                    </th>
                    <td className="py-3 pe-4">{r.plan}</td>
                    <td className="py-3 pe-4">{r.cost}</td>
                    <td className="py-3 pe-4">{r.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {CHEAPEST_RUPEE ? (
            <p className="text-sm text-hp-text/65 max-w-[75ch]">
              {CHEAPEST_RUPEE.perChannel! < HOOKPOST_PER_CHANNEL
                ? `Per channel, ${CHEAPEST_RUPEE.name} is the cheapest rupee option here: ${rupees(CHEAPEST_RUPEE.perChannel!)} a channel at its cheapest billing, against ${HOOKPOST_DISPLAY_PER_CHANNEL} on Hookpost with all ${HOOKPOST.channel} in use. Hookpost costs less in total when ${HOOKPOST.channel} channels are all you need.`
                : `Per channel, Hookpost (${HOOKPOST_DISPLAY_PER_CHANNEL} with all ${HOOKPOST.channel} in use) costs less than any other rupee-priced flat plan here.`}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="checks" className="space-y-5">
          <h2 id="checks" className="text-2xl sm:text-3xl font-extrabold text-hp-text">Pricing details to check before you pay</h2>
          <ul className="grid sm:grid-cols-2 gap-4 text-sm text-hp-text/75">
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="text-hp-text">Per channel adds up.</strong> Buffer is $5 a channel a month billed yearly and Publer
              ₹484.15 an account a month in India, so the bill grows with every account. Flat plans (Hookpost, Zoho Social,
              SocialPilot, Later) cost the same until you outgrow the tier.
            </li>
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="text-hp-text">Per seat multiplies.</strong> Hootsuite (₹1,999 a user in India), Sprout Social ($79 a
              seat) and Agorapulse ($79 a user) charge again for each teammate. Hookpost is {HOOKPOST_DISPLAY_PRICE} for up to{' '}
              {HOOKPOST.team_member_limit} people.
            </li>
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="text-hp-text">Headline prices are often yearly.</strong> Most rates above are billed yearly; monthly
              billing costs more. Hookpost&apos;s {HOOKPOST_DISPLAY_PRICE} is the price billed monthly, and there is no yearly price.
            </li>
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="text-hp-text">Currency and UPI.</strong> {RUPEE_TOOLS.join(', ')} show rupees in India but do not list
              UPI. Dollar billing needs an international card, and the rupee cost moves with the exchange rate.
            </li>
          </ul>
        </section>

        <section aria-labelledby="move" className="space-y-5">
          <h2 id="move" className="text-2xl sm:text-3xl font-extrabold text-hp-text">Moving to Hookpost</h2>
          <ol className="grid sm:grid-cols-3 gap-4 text-sm text-hp-text/75 list-none">
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="block text-hp-text">1. Check your networks</strong>
              Hookpost publishes to {PUBLISHABLE_CHANNEL_COUNT} networks. Each comparison page lists the ones the other tool has and
              Hookpost does not, such as Google Business Profile, WhatsApp, Mastodon and Reddit. See the{' '}
              <Link href="/channels" className="text-hp-primary-text underline">channel list</Link>.
            </li>
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="block text-hp-text">2. Connect and rebuild the queue</strong>
              {offer('Connect your channels, two on the free plan to start.', `Connect your channels, up to ${HOOKPOST.channel} on Hookpost.`)}{' '}
              There is no CSV import, so copy upcoming posts into the editor,
              or on the Hookpost plan create them with the <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">API or CLI</Link>{' '}
              or an AI assistant over <Link href="/mcp" className="text-hp-primary-text underline">MCP</Link>.
            </li>
            <li className="bg-hp-surface border border-hp-border rounded-xl p-5">
              <strong className="block text-hp-text">3. Run both, then cancel</strong>
              Keep the old tool until its queue has gone out. If you pay it yearly, time the move for the renewal date.
            </li>
          </ol>
        </section>

        <SectionFaq items={FAQ} title="Questions about alternatives" />

        <section className="p-6 sm:p-8 rounded-2xl bg-white/[0.02] border border-hp-border space-y-3">
          <h2 className="text-xl font-bold text-hp-text">How these comparisons are made</h2>
          <p className="text-sm text-hp-text/70 leading-relaxed">
            Every competitor figure comes from that competitor&apos;s own pricing page or documentation and is dated where it
            appears, so you can check it against the source. Rupee figures for Hootsuite, Zoho Social, Publer and SocialPilot were
            read from a browser in India on 11 October 2026; the rest on {FACTS_CHECKED}. Hookpost&apos;s figures come from its
            own plan settings. We do not publish performance benchmarks, and where the other tool comes out ahead we say so.
          </p>
        </section>

        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">Try Hookpost next to the tool you use now</h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base sm:text-lg">
            {offer(`The free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, with no card.`, TRIAL_SENTENCE)}
          </p>
          <Link
            href="/auth"
            className="inline-block bg-hp-primary text-hp-on-primary hover:bg-white hover:text-black font-bold text-base px-10 py-4 rounded-full transition-all"
          >
            {offer('Start free', TRIAL_CTA)} &rarr;
          </Link>
        </div>
      </div>
    </div>
  );
}
