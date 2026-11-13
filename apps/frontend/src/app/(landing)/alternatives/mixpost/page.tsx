import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { SectionFaq } from "../../SectionFaq";
import { IndiaCostNote } from "../IndiaCostNote";
import { SwitchFrom } from "../SwitchFrom";
import { PUBLISHABLE_CHANNEL_COUNT } from "../../channels/channel-count";
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, FACTS_CHECKED, MIXPOST_CLOUD } from '../../compare/competitor-facts';
import { SiteNav } from "../../site-nav";
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_ROW, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, usdCopy } from '../../usd-offer';

const { FREE, HOOKPOST: HP_INR } = pricingINR;
const inr = (n: number) => n.toLocaleString('en-IN');
// One sentence on Hookpost's sold plans, read from pricing.ts so it cannot drift.
const HOOKPOST_PLANS = `${offer(`Hookpost's free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month (no AI or API).`, `Hookpost starts with ${TRIAL_SENTENCE}`)} Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels and ${HP_INR.posts_per_month} posts, with AI, API and MCP. It also covers up to ${HP_INR.team_member_limit} team members.`;
const MIXPOST = COMPETITOR_FACTS.mixpost;
const FACTS = Object.values(COMPETITOR_FACTS);
const MCP_COUNT = FACTS.filter((c) => c.mcp === true).length;

export const metadata: Metadata = withSocial({
  title: "Mixpost Alternative: Hosted, No Server | Hookpost",
  description:
    `Hookpost vs Mixpost: a hosted plan with nothing to install against software you mostly run yourself, and ${offer(`a free plan with ${usdCopy('rupee', 'flat')} pricing`, `${usdCopy('rupee', 'flat')} pricing with ${FREE_POSTS}`)} against a $299 licence.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/mixpost",
  },
  openGraph: {
    title: "Mixpost Alternative: Hosted, No Server | Hookpost",
    description:
      `Compare Hookpost vs Mixpost: publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, an MCP server on paid plans, and a hosted service with nothing to install.`,
    url: "https://hookpost.hookstep.in/alternatives/mixpost",
    siteName: "Hookpost",
    images: [
      {
        url: "https://hookpost.hookstep.in/og-image.png",
        width: 1200,
        height: 630,
        alt: "Hookpost vs Mixpost comparison",
      },
    ],
    locale: "en_US",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Mixpost Alternative: Hosted, No Server | Hookpost",
    description: `Compare Hookpost vs Mixpost. Publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, a hosted service with nothing to install, and ${usdCopy('rupee billing with UPI', 'billing in dollars, or in rupees with UPI in India')}.`,
    images: ["https://hookpost.hookstep.in/og-image.png"],
  },
});

export default function MixpostAlternativePage() {
  const comparisonData = [
    {
      feature: "Supported Social Networks",
      hookpost: `${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok, Bluesky, Discord, Slack, Telegram and WordPress`,
      mixpost: "12 networks on Pro, including Instagram, TikTok, Pinterest, Threads, Mastodon and Pixelfed; Lite covers Facebook Pages, X and Mastodon only",
      winner: "Tie",
    },
    {
      feature: "Architecture & Stack",
      hookpost: "TypeScript (Next.js, NestJS, Temporal workflows, Redis), run for you",
      mixpost: "PHP / Laravel + Horizon Queue Worker",
      winner: "Depends",
    },
    {
      feature: "AI Agent & MCP Integration",
      hookpost: "✅ MCP server on the Hookpost plan, for Claude Desktop, Claude Code, Cursor and other MCP clients",
      mixpost: "✅ MCP server included with Mixpost Pro",
      winner: "Tie",
    },
    {
      feature: "Deployment Options",
      hookpost: "✅ Managed cloud, nothing to install",
      mixpost: `Self-hosted (Lite free, Pro a one-time licence), or Mixpost Cloud from $${MIXPOST_CLOUD.monthly} a month`,
      winner: "Tie",
    },
    {
      feature: "Video & Reels Auto-Publishing",
      hookpost: "Video publishing to YouTube (including Shorts), X, LinkedIn, Facebook Pages and others; TikTok publishing with the audience the account allows, or as inbox drafts",
      mixpost: "✅ Video publishing on its supported networks, which include Instagram and TikTok",
      winner: "Mixpost",
    },
    {
      feature: "Payment Methods & Regional Access",
      hookpost: usdCopy("✅ Monthly plans billed in INR via Razorpay (UPI Autopay, NetBanking, cards)", "✅ Monthly plans billed in USD by card; in India, in INR via Razorpay (UPI Autopay, NetBanking, cards)"),
      mixpost: "One-time USD licence ($299 Pro), paid by card or PayPal",
      winner: "Hookpost",
    },
    {
      feature: "Team & Account Limits",
      hookpost: `${HP_INR.channel} channels and up to ${HP_INR.team_member_limit} team members`,
      mixpost: "Pro: unlimited accounts on 1 domain or subdomain",
      winner: "Mixpost",
    },
    {
      feature: "Free Starter Tier",
      hookpost: offer(`✅ Free cloud plan (${FREE.channel} channels, ${FREE.posts_per_month} posts/month, no AI or API, no credit card required)`, TRIAL_ROW),
      mixpost: "⚠️ Mixpost Lite: free and open source (MIT), self-hosted only; Facebook Pages, X and Mastodon only",
      winner: offer("Hookpost", "Mixpost"),
    },
  ];

  const faqItems = [
    {
      name: "What is the main difference between Hookpost and Mixpost?",
      acceptedAnswer: {
        text: "Hosting. Hookpost is only a hosted service you sign up for; Mixpost is mainly a PHP/Laravel application you install and run on your own server, and it also sells a hosted version, Mixpost Cloud, from $" + MIXPOST_CLOUD.monthly + " a month. Both ship a Model Context Protocol (MCP) server (Hookpost on the Hookpost plan, Mixpost with its Pro licence). Mixpost Pro is paid once; Hookpost is a monthly " + usdCopy("rupee ", "") + "subscription with " + offer("a free plan", FREE_POSTS) + ".",
      },
    },
    {
      name: "Does Hookpost support more networks than Mixpost?",
      acceptedAnswer: {
        text: `Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok, Bluesky, Discord, Slack, Telegram, WordPress, Hashnode, Dev.to, Nostr and Lemmy. Mixpost Pro lists 12, including Mastodon and Pixelfed, which Hookpost does not publish to.`,
      },
    },
    {
      name: "How does pricing compare between Hookpost and Mixpost?",
      acceptedAnswer: {
        text: `${HOOKPOST_PLANS} Hookpost bills monthly via Razorpay (UPI, NetBanking, cards). Mixpost Lite is free and open source (MIT) but self-hosted; Mixpost Pro is a $299 one-time licence for one domain (1 year of updates included), plus your own server costs; Mixpost Cloud, the hosted version, starts at $${MIXPOST_CLOUD.monthly} a month ($${MIXPOST_CLOUD.yearly} a year) with a ${MIXPOST_CLOUD.trialDays}-day trial. Mixpost licence prices checked ${FACTS_CHECKED}, Mixpost Cloud ${MIXPOST_CLOUD.checked}.`,
      },
    },
    {
      name: "Does Hookpost have an AI scheduler or MCP server?",
      acceptedAnswer: {
        text: `Yes, on the Hookpost plan${offer(' (not on Free)', '')}. You can run the CLI (npm package hookpost) or connect the hosted MCP server to Claude Desktop, Claude Code, Cursor or another MCP client to draft and schedule posts. It is not unique: Mixpost Pro also ships an MCP server, and ${MCP_COUNT} of the ${FACTS.length} social media tools we checked on ${FACTS_CHECKED} offer one.`,
      },
    },
  ];

  // The only /alternatives page that had no page-level JSON-LD. Same two
  // blocks as alternatives/postiz: the breadcrumb, and the FAQ built from the
  // exact items SectionFaq renders below, so the two cannot drift.
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Alternatives", item: "https://hookpost.hookstep.in/alternatives" },
      { "@type": "ListItem", position: 3, name: "Mixpost Alternative", item: "https://hookpost.hookstep.in/alternatives/mixpost" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqItems.map((item) => ({
      "@type": "Question",
      name: item.name,
      acceptedAnswer: { "@type": "Answer", text: item.acceptedAnswer.text },
    })),
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <SiteNav />

      {/* Hero Section */}
      <section className="relative overflow-hidden pt-28 pb-20 px-6 sm:px-12 max-w-6xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.06] border border-hp-border text-xs font-semibold uppercase tracking-wider text-hp-primary-text mb-6">
          <span>⚡ Comparison</span>
        </div>

        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight text-hp-text mb-6 leading-tight">
          Hookpost vs Mixpost: <br className="hidden sm:inline" />
          The Hosted Mixpost Alternative (2026)
        </h1>

        <p className="text-lg sm:text-xl text-hp-text/70 max-w-3xl mx-auto mb-10 leading-relaxed">
          Mixpost is mainly software you host yourself, bought once (it also sells Mixpost Cloud from ${MIXPOST_CLOUD.monthly} a month). Hookpost is a hosted scheduler you pay for monthly {usdCopy('in rupees', 'in dollars, or rupees in India')},
          with {offer('a free plan', FREE_POSTS)}. If you would rather not run a server, here is how the two compare.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            href="/auth"
            className="w-full sm:w-auto px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-base hover:opacity-90 transition-opacity shadow-lg shadow-cyan-500/20"
          >
            {offer('Get Started Free (No Card Required)', TRIAL_CTA)}
          </Link>
          <Link
            href="/mcp"
            className="w-full sm:w-auto px-8 py-4 rounded-full bg-white/[0.08] hover:bg-white/[0.14] border border-hp-border-strong text-hp-text font-semibold text-base transition-colors"
          >
            Explore AI Agent MCP Server →
          </Link>
        </div>
      </section>

      {/* Comparison Table */}
      <section className="px-6 sm:px-12 max-w-6xl mx-auto py-12">
        <h2 className="text-3xl font-bold text-center mb-4">
          Feature-by-Feature Comparison
        </h2>
        <p className="text-center text-hp-text/60 mb-10 max-w-2xl mx-auto">
          See how Hookpost and Mixpost compare on platform coverage, automation, architecture, and pricing.
        </p>

        <div className="overflow-x-auto rounded-2xl border border-hp-border bg-white/[0.02]">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-hp-border bg-white/[0.04]">
                <th className="py-4 px-6 text-sm font-semibold text-hp-text/80">Feature</th>
                <th className="py-4 px-6 text-sm font-bold text-hp-primary-text">Hookpost</th>
                <th className="py-4 px-6 text-sm font-semibold text-hp-text/60">Mixpost</th>
                <th className="py-4 px-6 text-sm font-semibold text-hp-text/80">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-sm">
              {comparisonData.map((row, idx) => (
                <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-4 px-6 font-medium text-hp-text/90">{row.feature}</td>
                  <td className="py-4 px-6 text-hp-text font-medium">{row.hookpost}</td>
                  <td className="py-4 px-6 text-hp-text/70">{row.mixpost}</td>
                  <td className="py-4 px-6">
                    <span
                      className={`inline-block px-2.5 py-1 rounded-full text-xs font-semibold ${
                        row.winner === "Hookpost"
                          ? "bg-cyan-500/10 text-hp-primary-text border border-cyan-500/20"
                          : "bg-white/10 text-hp-text/70"
                      }`}
                    >
                      {row.winner}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-center text-xs text-hp-text/50 mt-4">
          {MIXPOST.name} figures read off {MIXPOST.sources[0]} on {FACTS_CHECKED}. Hookpost figures are its published plans.
        </p>
      </section>

      {/* Deep Dive Pillars */}
      <section className="px-6 sm:px-12 max-w-6xl mx-auto py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-8 rounded-2xl border border-hp-border bg-white/[0.02]">
            <div className="text-3xl mb-4">🚀</div>
            <h3 className="text-xl font-bold mb-3 text-hp-text">Publishing that retries</h3>
            <p className="text-hp-text/70 text-sm leading-relaxed">
              Mixpost runs publishing on PHP/Laravel queue workers. Hookpost runs it as Temporal.io workflows, which keep their state across restarts and retry failed steps.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-hp-border bg-white/[0.02]">
            <div className="text-3xl mb-4">🤖</div>
            <h3 className="text-xl font-bold mb-3 text-hp-text">An MCP server on paid plans</h3>
            <p className="text-hp-text/70 text-sm leading-relaxed">
              On the Hookpost plan, connect Hookpost to Claude Desktop, Cursor or another MCP client and schedule posts from your terminal or AI IDE. Mixpost Pro ships an MCP server too.
            </p>
          </div>

          <div className="p-8 rounded-2xl border border-hp-border bg-white/[0.02]">
            <div className="text-3xl mb-4">💳</div>
            <h3 className="text-xl font-bold mb-3 text-hp-text">{usdCopy('Flat rupee pricing and UPI', 'Flat pricing, and UPI in India')}</h3>
            <p className="text-hp-text/70 text-sm leading-relaxed">
              Hookpost has {offer(`a free cloud plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month) and flat monthly plans from ${planPrice('HOOKPOST')}`, `flat monthly plans from ${planPrice('HOOKPOST')}, after ${FREE_POSTS}`)}, {usdCopy('paid with Razorpay UPI (Google Pay, PhonePe, Paytm) or cards', 'paid by card, or in India with Razorpay UPI (Google Pay, PhonePe, Paytm) or cards')}. Mixpost Pro is a $299 one-time licence you host yourself (prices checked {FACTS_CHECKED}).
            </p>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <section className="px-6 sm:px-12 max-w-4xl mx-auto py-16">
        <IndiaCostNote slug="mixpost" />

        <div className="mt-8">
          <SwitchFrom slug="mixpost" />
        </div>

        <SectionFaq items={faqItems} title="Frequently Asked Questions: Hookpost vs Mixpost" />
      </section>

      {/* Final Call to Action */}
      <section className="px-6 sm:px-12 max-w-5xl mx-auto py-20 text-center">
        <div className="p-12 rounded-3xl border border-hp-border-strong bg-gradient-to-b from-white/[0.06] to-transparent">
          <h2 className="text-3xl sm:text-4xl font-extrabold mb-4">
            Try Hookpost, the Social Scheduler
          </h2>
          <p className="text-hp-text/70 max-w-2xl mx-auto mb-8 text-base sm:text-lg">
            Publish to {PUBLISHABLE_CHANNEL_COUNT} networks from one calendar, with AI writing and API access on the Hookpost plan.
          </p>
          <Link
            href="/auth"
            className="inline-block px-10 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:opacity-90 transition-opacity shadow-xl shadow-cyan-500/20"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </section>
    </div>
  );
}
