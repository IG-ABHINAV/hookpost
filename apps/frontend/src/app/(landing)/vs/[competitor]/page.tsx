import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SectionFaq } from '../../SectionFaq';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { CHANNEL_SPECS } from '../../channels/channel-specs';
import { COMPETITOR_FACTS, InrPlan, VS_SLUGS, isIndexedVs } from '../../compare/competitor-facts';
import { networkDiff, listJoin } from '../../compare/network-diff';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_ONLY, TRIAL_ROW, TRIAL_SENTENCE } from '../../trial-offer';
import {
  USD_HOOKPOST_MONTH,
  planPrice,
  usdCopy,
} from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE, HOOKPOST_DISPLAY_PER_CHANNEL } from '@hookpost/frontend/app/(landing)/usd-offer';

// Every number below was read off the vendor's own pricing page on
// PRICES_CHECKED (Zoho Social and Sendible via compare/competitor-facts.ts,
// the other four fetched directly). Only facts go in `weaknesses`: a subjective
// line like "Outdated UI" is not something a reader can check, so it is not
// here. Re-check every vendor before bumping the date.
//
// Every Hookpost figure on this page is read from pricing.ts and channel-specs.ts
// (it used to be typed in: "$15 / ₹599", "2 channels and 30 posts"), and the sections below the table are computed from the numbers
// stated here plus those two files. They are what makes each /vs page different
// from its siblings; a sentence with no number behind it does not belong in them.
const PRICES_CHECKED = '26 September 2026';
//
// 11 Oct 2026: Hookpost is priced in rupees only here (owner rule: India is
// the market, no dollar-first copy; dollar checkouts have never collected).
// Once dollars are sold (usd-offer.ts), the pages for dollar-only vendors
// state Hookpost in dollars too, with the rupee price for India beside it;
// the rupee comparison for a vendor that shows rupees in India stays in rupees.
// Where the competitor shows rupees to an Indian visitor (Zoho Social, read
// from India on 11 Oct 2026 into competitor-facts.ts `inrPlan`), the page
// leads with that rupee comparison and does the arithmetic in rupees. Where
// it only shows dollars, both prices are stated in their own currency and the
// page does not convert one into the other, so no "cheaper" verdict is drawn
// from price for those vendors.
const INR_CHECKED = '11 October 2026, from India';

const FREE = pricingINR.FREE;
const HOOKPOST = pricingINR.HOOKPOST;
const usd2 = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

interface CompetitorData {
  name: string;
  category: string;
  tagline: string;
  startingPrice: string;
  /** Free plan as the vendor states it, or null when it offers none. */
  freePlan: string | null;
  /** Channels on the cheapest paid plan, as the vendor states it. */
  entryChannels: string;
  source: string;
  weaknesses: string[];
  /**
   * The numbers behind startingPrice and entryChannels, transcribed from those
   * same strings (not re-read from the vendor), so the sections below can do
   * arithmetic on them.
   */
  entryPlan: string;
  entryUsdMonthly: number;
  /** Whether that monthly figure is the annual-billing price, as the strings above say. */
  entryBilledAnnually: boolean;
  entryChannelCount: number;
  entryUnit: string;
  /** Seats on the entry plan, only where the vendor states it. */
  entrySeats: number | null;
  /** Channels on the free plan, only where it is stated as a channel count. */
  freeChannels: number | null;
  /** The networks the vendor publishes to, only where it is stated as a complete list. */
  networks: string[] | null;
  /** The rupee plan an Indian visitor is shown, when we have read one. */
  inr?: InrPlan | null;
}

// Only the six competitors that live exclusively under /vs/ are defined. The
// other ten 301 to /alternatives/<slug> (see next.config.js); their old entries
// here carried stale prices and were removed rather than left to drift.
const COMPETITORS: Record<string, CompetitorData> = {
  'zoho-social': {
    name: 'Zoho Social',
    category: 'All-in-One Social Tool',
    tagline: 'Social media management for businesses',
    startingPrice: '₹900/mo in India (₹600 billed annually); $10/mo billed annually elsewhere',
    freePlan: '6 channels',
    entryChannels: '13 channels on Standard in India (14 elsewhere)',
    source: 'https://www.zoho.com/social/pricing.html',
    weaknesses: ['UPI is not listed on its pricing page'],
    entryPlan: 'Standard', entryUsdMonthly: 10, entryBilledAnnually: true, entryChannelCount: 14, entryUnit: 'channels',
    entrySeats: null, freeChannels: 6,
    networks: COMPETITOR_FACTS['zoho-social'].networks,
    inr: COMPETITOR_FACTS['zoho-social'].inrPlan,
  },
  'sendible': {
    name: 'Sendible',
    category: 'Agency Social Media Platform',
    tagline: 'Social media tool built for agencies',
    startingPrice: '$30/mo (Core, billed annually)',
    freePlan: null,
    entryChannels: '6 channels on Core',
    source: 'https://www.sendible.com/pricing',
    weaknesses: ['No free plan, only a 14-day trial', 'Core plan includes 6 channels'],
    entryPlan: 'Core', entryUsdMonthly: 30, entryBilledAnnually: true, entryChannelCount: 6, entryUnit: 'channels',
    entrySeats: null, freeChannels: null,
    networks: COMPETITOR_FACTS['sendible'].networks,
  },
  'loomly': {
    name: 'Loomly',
    category: 'Brand Success Platform',
    tagline: 'Social media calendar and brand manager',
    startingPrice: '$49/mo (Starter, billed annually; $65 month to month)',
    freePlan: null,
    entryChannels: '12 social accounts and 3 users on Starter',
    source: 'https://www.loomly.com/pricing',
    weaknesses: ['No free plan, only a free trial', 'Entry plan is $49/mo billed annually, $65 month to month'],
    entryPlan: 'Starter', entryUsdMonthly: 49, entryBilledAnnually: true, entryChannelCount: 12, entryUnit: 'social accounts',
    entrySeats: 3, freeChannels: null, networks: null,
  },
  'tailwind': {
    name: 'Tailwind',
    category: 'Pinterest, Instagram & Facebook Scheduler',
    tagline: 'Automated marketing for small businesses',
    startingPrice: '$17.99/mo (Pro, billed annually)',
    freePlan: '5 posts a month, 1 Pinterest, 1 Instagram and 1 Facebook account',
    entryChannels: '1 Pinterest, 1 Instagram and 1 Facebook account on Pro',
    source: 'https://www.tailwindapp.com/pricing',
    weaknesses: ['Publishes to Pinterest, Instagram and Facebook only', 'Free plan is capped at 5 posts a month', 'Pro includes one account per network'],
    entryPlan: 'Pro', entryUsdMonthly: 17.99, entryBilledAnnually: true, entryChannelCount: 3, entryUnit: 'social accounts',
    entrySeats: null, freeChannels: 3,
    networks: ['Pinterest', 'Instagram', 'Facebook'],
  },
  'co-schedule': {
    name: 'CoSchedule',
    category: 'Marketing Calendar',
    tagline: 'Organize all your marketing in one place',
    startingPrice: '$29/mo (Starter, billed annually; $39 month to month)',
    freePlan: 'Up to 15 scheduled posts per profile',
    entryChannels: '3 social profiles on Starter (X profiles not included)',
    source: 'https://coschedule.com/pricing',
    weaknesses: ['Starter includes 1 user seat and 3 social profiles, not counting X', 'Extra seats on Professional cost $29/mo each'],
    entryPlan: 'Starter', entryUsdMonthly: 29, entryBilledAnnually: true, entryChannelCount: 3, entryUnit: 'social profiles',
    entrySeats: 1, freeChannels: null, networks: null,
  },
  'meet-edgar': {
    name: 'MeetEdgar',
    category: 'Social Automation Tool',
    tagline: 'Automated evergreen social publishing',
    startingPrice: '$24.91/mo (Eddie, billed annually; $29.99 month to month)',
    freePlan: null,
    entryChannels: '5 social accounts on Eddie',
    source: 'https://meetedgar.com/pricing',
    weaknesses: ['No free plan, only a 30-day trial', 'Eddie plan covers 5 social accounts'],
    entryPlan: 'Eddie', entryUsdMonthly: 24.91, entryBilledAnnually: true, entryChannelCount: 5, entryUnit: 'social accounts',
    entrySeats: null, freeChannels: null, networks: null,
  },
};

// The slugs live in competitor-facts.ts (VS_SLUGS) with the index switch.
const VS_ONLY = VS_SLUGS;

export async function generateStaticParams() {
  return VS_ONLY.filter((slug) => COMPETITORS[slug]).map((competitor) => ({
    competitor,
  }));
}

export async function generateMetadata({ params }: { params: Promise<{ competitor: string }> }): Promise<Metadata> {
  const { competitor } = await params;
  const comp = COMPETITORS[competitor];
  if (!comp) return {};

  return withSocial({
    // Kept under the ~60/~160 character limits so neither gets truncated in
    // results. Leads with "<name> Alternative", the phrase people search.
    title: `${comp.name} Alternative (2026): AI Scheduler | Hookpost`,
    description: comp.inr
      ? `${comp.name} vs Hookpost in rupees: ${comp.name} ${comp.inr.name} is ${inr(comp.inr.monthly ?? comp.inr.yearlyPerMonth!)} a month in India, Hookpost from ${HOOKPOST_DISPLAY_PRICE} with UPI Autopay. Plans, channels and networks compared.`
      : `Compare Hookpost and ${comp.name} on price, channels and plan limits: ${PUBLISHABLE_CHANNEL_COUNT} networks, AI drafting and flat plans billed ${usdCopy('in rupees with UPI Autopay', 'in dollars, or in rupees with UPI Autopay in India')}.`,
    alternates: {
      canonical: `https://hookpost.hookstep.in/vs/${competitor}`,
    },
    ...(isIndexedVs(competitor) ? {} : { robots: { index: false, follow: true } }),
  });
}

export default async function CompetitorComparisonPage({ params }: { params: Promise<{ competitor: string }> }) {
  const { competitor } = await params;
  const comp = COMPETITORS[competitor];
  if (!comp) notFound();

  // ---- Computed comparison (see the note at the top of the file) ------------
  // The one Hookpost plan, set against the competitor's entry plan.
  const r = comp.inr ?? null;
  const entryChannels = r?.channels ?? comp.entryChannelCount;
  const fit = { name: 'Hookpost', plan: HOOKPOST, usdMonth: USD_HOOKPOST_MONTH };
  const fitPerChannel = Math.round((fit.plan.month_price / fit.plan.channel) * 100) / 100;
  const billing = comp.entryBilledAnnually ? ', billed annually' : '';
  const compFacts = COMPETITOR_FACTS[competitor] ?? null;

  // Rupee arithmetic, only when the competitor shows rupees in India.
  const rupee = r
    ? (() => {
        const monthly = r.monthly ?? r.yearlyPerMonth!;
        const perChannel = r.channels ? Math.round((monthly / r.channels) * 100) / 100 : null;
        const yearlyPerChannel = r.channels && r.yearlyPerMonth != null ? Math.round((r.yearlyPerMonth / r.channels) * 100) / 100 : null;
        return { monthly, perChannel, yearlyPerChannel, cheaperSticker: monthly < fit.plan.month_price, cheaperPerChannel: perChannel != null && perChannel < fitPerChannel };
      })()
    : null;

  // Networks, only where the vendor's list is stated in full. Matching is by
  // name against channel-specs.ts, so a network Hookpost cannot publish to (for
  // example Snapchat, Mastodon or Google Business Profile) is never claimed.
  const diff = comp.networks ? networkDiff(comp.networks) : null;
  const shared = diff ? diff.shared : [];
  const onlyComp = diff ? diff.onlyCompetitor : [];
  const onlyHookpost = diff ? diff.onlyHookpost : [];

  // The channel rules that matter when moving a calendar over: the networks
  // both tools publish to if the list is known, else four of the biggest.
  const moveSlugs = (diff && diff.sharedSlugs.length ? diff.sharedSlugs : ['x', 'linkedin', 'youtube', 'facebook'])
    .filter((k) => CHANNEL_SPECS[k])
    .slice(0, 4);
  const NAME_OF: Record<string, string> = { x: 'X', linkedin: 'LinkedIn', youtube: 'YouTube', facebook: 'Facebook Pages', instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', pinterest: 'Pinterest', bluesky: 'Bluesky', telegram: 'Telegram', discord: 'Discord', slack: 'Slack' };

  const priceAnswer = r
    ? `In India, ${comp.name} ${r.name} is ${inr(rupee!.monthly)} a month${r.yearlyPerMonth != null && r.monthly != null ? ` (${inr(r.yearlyPerMonth)} billed yearly)` : ''} for ${r.channels} channels${r.seats ? ` and ${r.seats} user` : ''}, with a free plan of ${comp.freePlan ?? 'none'} (read ${INR_CHECKED}). Hookpost has ${offer(`a free plan of ${FREE.channel} channels and ${FREE.posts_per_month} posts a month`, FREE_POSTS)}, a paid plan at ${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels with AI writing, billed in rupees with UPI Autopay.`
    : `${comp.name} starts at ${comp.startingPrice}${comp.freePlan ? `, with a free plan of ${comp.freePlan}` : ' and has no free plan'} (checked ${PRICES_CHECKED}), billed in US dollars. Hookpost has ${offer(`a free plan of ${FREE.channel} channels and ${FREE.posts_per_month} posts a month`, FREE_POSTS)}, a paid plan at ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month with AI writing and ${HOOKPOST.channel} channels, billed in rupees with UPI Autopay.`, `${USD_HOOKPOST_MONTH} a month with AI writing and ${HOOKPOST.channel} channels, billed in US dollars by card (in India ${HOOKPOST_DISPLAY_PRICE} and ${HOOKPOST_DISPLAY_PRICE}, with UPI Autopay).`)} It publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks.`;

  const fitAnswer = r
    ? `${comp.name} ${r.name} covers ${r.channels} channels at ${inr(rupee!.monthly)} a month in India. Hookpost: ${HOOKPOST_DISPLAY_PRICE} a month for up to ${fit.plan.channel} channels and ${fit.plan.posts_per_month.toLocaleString('en-IN')} posts, with AI writing, the API and the MCP server. ${rupee!.cheaperSticker ? `${comp.name} is cheaper on price` : `Hookpost is cheaper on price`}${rupee!.cheaperPerChannel ? ` and per channel (${inr(rupee!.perChannel!)} against ${HOOKPOST_DISPLAY_PER_CHANNEL})` : rupee!.perChannel != null ? `, and per channel Hookpost comes to ${HOOKPOST_DISPLAY_PER_CHANNEL} at full use against ${inr(rupee!.perChannel)}` : ''}.`
    : `${comp.name} ${comp.entryPlan} covers ${comp.entryChannelCount} ${comp.entryUnit} at ${usd2(comp.entryUsdMonthly)} a month${billing}, in US dollars. Hookpost: ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month for up to ${fit.plan.channel} channels and ${fit.plan.posts_per_month.toLocaleString('en-IN')} posts, in rupees. We do not convert between the two; your card's exchange rate and fees decide which costs less.`, `${fit.usdMonth} a month for up to ${fit.plan.channel} channels and ${fit.plan.posts_per_month.toLocaleString('en-IN')} posts, in US dollars (${HOOKPOST_DISPLAY_PRICE} in India).`)}`;

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Alternatives", item: "https://hookpost.hookstep.in/alternatives" },
      { "@type": "ListItem", position: 3, name: `Hookpost vs ${comp.name}`, item: `https://hookpost.hookstep.in/vs/${competitor}` },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `How does Hookpost compare with ${comp.name} on price?`,
        acceptedAnswer: { "@type": "Answer", text: priceAnswer },
      },
      {
        "@type": "Question",
        name: `Which Hookpost plan matches ${comp.name} ${r ? r.name : comp.entryPlan}?`,
        acceptedAnswer: { "@type": "Answer", text: fitAnswer },
      },
      ...(diff
        ? [
            {
              "@type": "Question",
              name: `Does Hookpost publish to the same networks as ${comp.name}?`,
              acceptedAnswer: {
                "@type": "Answer",
                text: `Hookpost publishes to ${shared.length ? listJoin(shared) : 'none of the networks'} that ${comp.name} lists${onlyComp.length ? `, but not to ${listJoin(onlyComp)}` : ''}. Hookpost also publishes to ${onlyHookpost.length} networks ${comp.name} does not list: ${listJoin(onlyHookpost)}. Network lists as stated by the vendor on ${PRICES_CHECKED}.`,
              },
            },
          ]
        : []),
    ],
  };

  const comparisonRows = [
    { feature: 'Free plan', hookpost: offer(`✅ ${FREE.channel} channels, ${FREE.posts_per_month} posts a month`, TRIAL_ROW), competitor: comp.freePlan ? `✅ ${comp.freePlan}` : '❌ None' },
    { feature: 'Cheapest paid plan', hookpost: `${r ? `${HOOKPOST_DISPLAY_PRICE} a month` : planPrice('HOOKPOST', ' a month')}`, competitor: comp.startingPrice },
    { feature: 'Channels on cheapest paid plan', hookpost: `${HOOKPOST.channel}`, competitor: comp.entryChannels },
    { feature: 'Currency and UPI (India)', hookpost: '✅ Rupees, UPI Autopay via Razorpay', competitor: compFacts?.inr ? 'Rupee prices shown to Indian visitors; UPI not listed on its pricing page' : 'US dollars; UPI not listed on its pricing page' },
  ];

  const compStronger: string[] = [];
  const hookpostStronger: string[] = [];
  if (rupee) {
    if (rupee.cheaperSticker) {
      compStronger.push(`Lower monthly price in India: ${inr(rupee.monthly)} against ${HOOKPOST_DISPLAY_PRICE} for the Hookpost plan that fits (${fit.name}).`);
    } else {
      hookpostStronger.push(`Lower monthly price: ${HOOKPOST_DISPLAY_PRICE} for ${fit.name} against ${inr(rupee.monthly)} for ${comp.name} ${r!.name}.`);
    }
    if (rupee.perChannel != null) {
      if (rupee.cheaperPerChannel) {
        compStronger.push(`Lower price per channel: ${inr(rupee.perChannel)} a month${rupee.yearlyPerChannel != null ? ` (${inr(rupee.yearlyPerChannel)} billed yearly)` : ''} against ${HOOKPOST_DISPLAY_PER_CHANNEL} on Hookpost ${fit.name} at full use.`);
      } else {
        hookpostStronger.push(`Lower price per channel: ${HOOKPOST_DISPLAY_PER_CHANNEL} at full use of ${fit.name}, against ${inr(rupee.perChannel)} on ${comp.name}.`);
      }
    }
  }
  // Once new users have no Free plan (trial-offer.ts), any free plan the
  // competitor has is a point in its favour, and "a free plan" stops being one
  // in Hookpost's.
  if (TRIAL_ONLY) {
    if (comp.freePlan) {
      compStronger.push(`${comp.name} has a free plan (${comp.freePlan}); Hookpost does not, it starts with ${FREE_POSTS}.`);
    }
  } else {
    if (comp.freeChannels != null && comp.freeChannels > FREE.channel) {
      compStronger.push(`A free plan that covers more channels: ${comp.freePlan}, against ${FREE.channel} channels and ${FREE.posts_per_month} posts a month on Hookpost Free.`);
    }
    if (!comp.freePlan) {
      hookpostStronger.push(`A free plan: ${FREE.channel} channels and ${FREE.posts_per_month} posts a month. ${comp.name} lists none.`);
    }
  }
  if (comp.entrySeats != null && comp.entrySeats > fit.plan.team_member_limit) {
    compStronger.push(`More seats on the entry plan: ${comp.entrySeats}, against ${fit.plan.team_member_limit} on Hookpost ${fit.name}.`);
  }
  if (!r && comp.entryChannelCount > fit.plan.channel) {
    compStronger.push(`More channels on its entry plan: ${comp.entryChannelCount} ${comp.entryUnit}, against ${fit.plan.channel} on Hookpost ${fit.name}.`);
  }
  const compMcp = compFacts?.mcp ? compFacts.sources.find((u) => u.includes('mcp')) : undefined;
  if (compMcp) {
    compStronger.push(`It has an MCP server of its own (${compMcp.replace(/^https?:\/\/(www\.)?/, '')}), so MCP support alone is not a reason to move.`);
  }
  if (onlyComp.length) {
    compStronger.push(`Networks Hookpost does not publish to: ${listJoin(onlyComp)}.`);
  }
  if (!compFacts?.inr) {
    hookpostStronger.push(
      usdCopy(
        `Billed in rupees with UPI Autopay; ${comp.name} bills in US dollars, which needs an international card.`,
        `Billed in rupees with UPI Autopay in India, where ${comp.name} bills in US dollars and needs an international card.`
      )
    );
  } else if (!compFacts.upi) {
    hookpostStronger.push(`Pays by UPI Autopay as well as cards and NetBanking; ${comp.name} shows rupee prices but does not list UPI.`);
  }
  const compSeats = r?.seats ?? comp.entrySeats;
  if (compSeats != null && fit.plan.team_member_limit > compSeats) {
    hookpostStronger.push(`More people on one plan: up to ${fit.plan.team_member_limit} on Hookpost ${fit.name}, against ${compSeats} on ${comp.name} ${r ? r.name : comp.entryPlan}.`);
  }
  if (diff && onlyHookpost.length) {
    hookpostStronger.push(`${onlyHookpost.length} networks that ${comp.name} does not list: ${listJoin(onlyHookpost)}.`);
  }

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        Hookpost vs {comp.name}: prices checked {r ? INR_CHECKED : PRICES_CHECKED}
      </div>

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
            className="text-sm font-bold bg-hp-primary text-hp-on-primary px-5 py-2 rounded-full hover:bg-white transition-all"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-5 sm:px-12 pt-8 pb-24">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50 mb-8">
          <ol className="flex items-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li><Link href="/alternatives" className="hover:text-hp-text transition-colors">Alternatives</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Hookpost vs {comp.name}</li>
          </ol>
        </nav>

        <div className="text-center max-w-3xl mx-auto mb-16">
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] mb-6">
            Looking for a <span className="text-hp-primary-text">{comp.name} Alternative</span>?
          </h1>
          <p className="text-lg sm:text-xl text-hp-text-2 leading-relaxed mb-8">
            {r
              ? `${comp.name} is ${inr(rupee!.monthly)} a month in India for ${r.channels} channels. Hookpost is ${HOOKPOST_DISPLAY_PRICE} for ${HOOKPOST.channel} channels and up to ${HOOKPOST.team_member_limit} team members, billed in rupees with UPI Autopay. Here is where each one wins.`
              : `Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks from one calendar, with AI writing from ${planPrice('HOOKPOST', ' a month')} and up to ${HOOKPOST.team_member_limit} team members, ${usdCopy('billed in rupees', 'billed in dollars, or in rupees in India')}.`}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/auth"
              className="bg-hp-primary text-hp-on-primary font-bold px-8 py-4 rounded-xl text-lg hover:bg-white transition-all"
            >
              {offer('Start free (no credit card)', TRIAL_CTA)}
            </Link>
          </div>
        </div>

        {/* Quick answer: self-contained and citable. */}
        <div className="max-w-3xl mx-auto mb-16 bg-hp-bg border border-hp-primary/30 rounded-2xl p-6 sm:p-8">
          <h2 className="text-sm font-bold uppercase tracking-widest text-hp-primary-text mb-3">
            Hookpost vs {comp.name}: the short answer
          </h2>
          <p className="text-base sm:text-lg text-hp-text leading-relaxed">
            Hookpost is an AI social media scheduler by Hookstep (Mumbai) that publishes to {PUBLISHABLE_CHANNEL_COUNT} networks,
            including X, LinkedIn, YouTube, Facebook Pages, TikTok, Bluesky, Discord and Telegram, from one calendar. It has {offer('a free plan', FREE_POSTS)},
            a paid plan at <strong>{planPrice('HOOKPOST', ' a month')}</strong>,{' '}
            {usdCopy('billed through Razorpay (UPI, NetBanking and cards)', 'billed in US dollars by card, or in India through Razorpay (UPI, NetBanking and cards)')}. {comp.name} is {/^[aeiou]/i.test(comp.category) ? 'an' : 'a'} {comp.category.toLowerCase()} starting at {comp.startingPrice}{' '}
            (<a href={comp.source} className="underline" rel="nofollow noopener" target="_blank">pricing page</a>, checked{' '}
            {r ? INR_CHECKED : PRICES_CHECKED}).
          </p>
        </div>

        <div className="w-full overflow-x-auto mb-20">
          <table className="w-full text-left border-collapse bg-hp-bg border border-hp-border rounded-2xl overflow-hidden">
            <thead>
              <tr className="border-b border-hp-border bg-hp-surface/50">
                <th className="p-5 font-bold text-hp-text text-lg">Key feature</th>
                <th className="p-5 font-bold text-hp-primary-text text-lg">Hookpost</th>
                <th className="p-5 font-bold text-hp-text-2 text-lg">{comp.name}</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row, idx) => (
                <tr key={idx} className="border-b border-hp-border/60 hover:bg-white/[0.02] transition-colors">
                  <td className="p-5 font-medium text-hp-text">{row.feature}</td>
                  <td className="p-5 text-hp-text">{row.hookpost}</td>
                  <td className="p-5 text-hp-text-2">{row.competitor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Computed comparison: every figure comes from the numbers stated on
            this page (competitor) or pricing.ts / channel-specs.ts (Hookpost). */}
        <section className="mb-20">
          <h2 className="text-2xl sm:text-3xl font-bold mb-4">
            {comp.name} {r ? r.name : comp.entryPlan} against the Hookpost plan that fits
          </h2>
          <p className="max-w-3xl text-hp-text-2 leading-relaxed">{fitAnswer}</p>
          <div className="mt-6 w-full overflow-x-auto">
            <table className="w-full text-left border-collapse bg-hp-bg border border-hp-border rounded-2xl overflow-hidden text-sm">
              <caption className="sr-only">{comp.name} against Hookpost</caption>
              <thead>
                <tr className="border-b border-hp-border bg-hp-surface/50">
                  <th scope="col" className="p-4 font-bold text-hp-text"> </th>
                  <th scope="col" className="p-4 font-bold text-hp-text-2">{comp.name} {r ? r.name : comp.entryPlan}</th>
                  <th scope="col" className="p-4 font-bold text-hp-primary-text">Hookpost</th>
                </tr>
              </thead>
              <tbody className="text-hp-text-2">
                <tr className="border-b border-hp-border/60">
                  <th scope="row" className="p-4 font-medium text-hp-text">Monthly price</th>
                  <td className="p-4">
                    {r
                      ? `${inr(rupee!.monthly)} month to month${r.yearlyPerMonth != null && r.monthly != null ? `, ${inr(r.yearlyPerMonth)} billed yearly` : ''}`
                      : `${usd2(comp.entryUsdMonthly)}${billing} (US dollars)`}
                  </td>
                  <td className="p-4">
                    {/* Billed monthly only: no yearly price. */}
                    {r
                      ? `${HOOKPOST_DISPLAY_PRICE} a month`
                      : usdCopy(
                          `${HOOKPOST_DISPLAY_PRICE} a month`,
                          `${fit.usdMonth} a month (${HOOKPOST_DISPLAY_PRICE} in India)`
                        )}
                  </td>
                </tr>
                <tr className="border-b border-hp-border/60">
                  <th scope="row" className="p-4 font-medium text-hp-text">Channels included</th>
                  <td className="p-4">{r ? `${r.channels} channels` : `${comp.entryChannelCount} ${comp.entryUnit}`}</td>
                  <td className="p-4">Up to {fit.plan.channel}</td>
                </tr>
                {rupee && rupee.perChannel != null ? (
                  <tr className="border-b border-hp-border/60">
                    <th scope="row" className="p-4 font-medium text-hp-text">Price per channel</th>
                    <td className="p-4">{inr(rupee.perChannel)}{rupee.yearlyPerChannel != null ? ` (${inr(rupee.yearlyPerChannel)} billed yearly)` : ''}</td>
                    <td className="p-4">{HOOKPOST_DISPLAY_PER_CHANNEL} at full use</td>
                  </tr>
                ) : null}
                <tr>
                  <th scope="row" className="p-4 font-medium text-hp-text">Team seats</th>
                  <td className="p-4">{r?.seats != null ? r.seats : comp.entrySeats != null ? comp.entrySeats : 'Not stated here'}</td>
                  <td className="p-4">
                    {fit.plan.team_member_limit > 1 ? `Up to ${fit.plan.team_member_limit}, owner included` : '1 (single-user plan)'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
              <h3 className="text-xl font-bold mb-4 text-hp-text">Where {comp.name} is the stronger choice</h3>
              {compStronger.length ? (
                <ul className="space-y-3 text-sm text-hp-text-2">
                  {compStronger.map((t) => (
                    <li key={t} className="flex items-start gap-3"><span className="text-hp-text/50">•</span><span>{t}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-hp-text-2">
                  On the figures this page compares, nothing favours {comp.name}. Look at what it does that is not measured here before you decide.
                </p>
              )}
            </div>
            <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
              <h3 className="text-xl font-bold mb-4 text-hp-primary-text">Where Hookpost is the stronger choice</h3>
              {hookpostStronger.length ? (
                <ul className="space-y-3 text-sm text-hp-text-2">
                  {hookpostStronger.map((t) => (
                    <li key={t} className="flex items-start gap-3"><span className="text-green-400">✓</span><span>{t}</span></li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-hp-text-2">
                  On the figures this page compares, nothing favours Hookpost over {comp.name}.
                </p>
              )}
            </div>
          </div>

          {diff && (
            <p className="mt-8 max-w-3xl text-sm text-hp-text-2 leading-relaxed">
              <strong className="text-hp-text">Networks.</strong> {comp.name} lists {comp.networks!.length}: {comp.networks!.join(', ')}.
              Hookpost publishes to {shared.length ? listJoin(shared) : 'none of them'}
              {onlyComp.length ? `, and not to ${listJoin(onlyComp)}` : ''}. Hookpost adds {onlyHookpost.length} that {comp.name} does not
              list: {listJoin(onlyHookpost)}. Lists as the vendor states them on {PRICES_CHECKED}.
            </p>
          )}

          <h3 className="mt-10 text-xl font-bold text-hp-text">If you move: what each channel needs on Hookpost</h3>
          <p className="mt-2 max-w-3xl text-sm text-hp-text-2">
            Every channel connects once. These are the limits and rules for {diff && diff.sharedSlugs.length ? 'the networks both tools publish to' : 'four of the biggest networks'}, from Hookpost&apos;s channel specs.
            Hookpost has no CSV import, so recreate queued posts in the editor, or on the Hookpost plan through the API, CLI or MCP.
          </p>
          <ul className="mt-4 grid gap-3 md:grid-cols-2 text-sm text-hp-text-2">
            {moveSlugs.map((k) => (
              <li key={k} className="rounded-xl border border-hp-border bg-hp-bg p-4">
                <strong className="text-hp-text">{NAME_OF[k] ?? k}</strong>: {CHANNEL_SPECS[k].limit}. {CHANNEL_SPECS[k].auth}.{' '}
                {CHANNEL_SPECS[k].rules.slice(0, 2).join('. ')}.
              </li>
            ))}
          </ul>
        </section>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-20">
          <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
            <h2 className="text-2xl font-bold mb-4 text-hp-primary-text">Why people look past {comp.name}</h2>
            <ul className="space-y-3">
              {/* A competitor's missing or small free plan is no weakness next
                  to a Hookpost that has none either (trial-offer.ts). */}
              {comp.weaknesses.filter((w) => !TRIAL_ONLY || !/free plan/i.test(w)).map((w, idx) => (
                <li key={idx} className="flex items-start gap-3 text-hp-text-2 text-sm">
                  <span className="text-red-400 font-bold">✕</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
            <h2 className="text-2xl font-bold mb-4 text-hp-primary-text">What you get with Hookpost</h2>
            <ul className="space-y-3">
              <li className="flex items-start gap-3 text-hp-text-2 text-sm">
                <span className="text-green-400 font-bold">✓</span>
                <span>Publish to {PUBLISHABLE_CHANNEL_COUNT} networks from one drag-and-drop calendar</span>
              </li>
              <li className="flex items-start gap-3 text-hp-text-2 text-sm">
                <span className="text-green-400 font-bold">✓</span>
                <span>{offer(`Free plan with ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, no credit card`, TRIAL_SENTENCE)}</span>
              </li>
              <li className="flex items-start gap-3 text-hp-text-2 text-sm">
                <span className="text-green-400 font-bold">✓</span>
                <span>{usdCopy('Billed in rupees through Razorpay: UPI Autopay, NetBanking and cards', 'Billed in US dollars by card, or in India in rupees through Razorpay: UPI Autopay, NetBanking and cards')}</span>
              </li>
            </ul>
          </div>
        </div>

        <SectionFaq items={faqSchema.mainEntity} />

        <p className="mt-10 text-sm text-hp-text-2">
          More comparisons: <Link href="/alternatives" className="text-hp-primary-text underline">all alternatives</Link>,{' '}
          <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">the best schedulers for India</Link>.
        </p>
      </div>
    </div>
  );
}
