import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { SectionFaq } from "../../SectionFaq";
import { IndiaCostNote } from "../IndiaCostNote";
import { SwitchFrom } from "../SwitchFrom";
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, FACTS_CHECKED } from '../../compare/competitor-facts';
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, usdCopy } from '../../usd-offer';

const { FREE, HOOKPOST: HP_INR } = pricingINR;
const inr = (n: number) => n.toLocaleString('en-IN');
// One sentence on Hookpost's sold plans, read from pricing.ts so it cannot drift.
const HOOKPOST_PLANS = `${offer(`Hookpost's free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month (no AI or API).`, `Hookpost starts with ${TRIAL_SENTENCE}`)} Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels and ${HP_INR.posts_per_month} posts, with AI, API and MCP. It also covers up to ${HP_INR.team_member_limit} team members.`;
const HOOKPOST_NETWORKS = `Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok, Bluesky, Discord, Telegram, WordPress and Dev.to.`;
const AGORA = COMPETITOR_FACTS.agorapulse;

const BEST_ALTERNATIVE_ANSWER = `Hookpost is an alternative to Agorapulse with flat plans instead of per-user pricing. Agorapulse's Standard plan is $79 per user per month billed annually ($99 billed monthly) with 10 social profiles per user and a 30-day trial; no free plan is listed on its pricing page. Agorapulse also includes a self-hosted MCP connector for ChatGPT or Claude from Standard. ${HOOKPOST_PLANS} ${HOOKPOST_NETWORKS} Agorapulse prices checked ${FACTS_CHECKED}.`;

export const metadata: Metadata = withSocial({
  title: "Agorapulse Alternative (2026): Flat Team Pricing | Hookpost",
  description: `Compare Hookpost vs Agorapulse: Agorapulse Standard is $79 per user/mo billed annually; Hookpost has ${offer('a free plan', FREE_POSTS)} and Hookpost at ${planPrice('HOOKPOST', '/mo')} flat for ${HP_INR.team_member_limit} team members.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/agorapulse",
  },
});

export default function AgorapulseAlternativePage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://hookpost.hookstep.in",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Alternatives",
        item: "https://hookpost.hookstep.in/alternatives",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Agorapulse Alternative",
        item: "https://hookpost.hookstep.in/alternatives/agorapulse",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is the Best Alternative to Agorapulse in 2026?",
        acceptedAnswer: {
          "@type": "Answer",
          text: BEST_ALTERNATIVE_ANSWER,
        },
      },
      {
        "@type": "Question",
        name: "Does Hookpost support regional payments like UPI?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Hookpost integrates Razorpay for native UPI, NetBanking, and Indian cards.",
        },
      },
    ],
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        Hookpost vs Agorapulse: plans, prices and networks compared
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
            className="text-sm font-medium bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary transition-all px-4 sm:px-5 py-2 rounded-full font-semibold whitespace-nowrap"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1000px] mx-auto px-5 sm:px-8 pt-8 pb-24 space-y-12">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center space-x-2">
            <li>
              <Link href="/" className="hover:text-hp-text transition-colors">Home</Link>
            </li>
            <li>/</li>
            <li>
              <Link href="/alternatives" className="hover:text-hp-text transition-colors">Alternatives</Link>
            </li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Agorapulse Alternative</li>
          </ol>
        </nav>

        <div className="text-center space-y-4">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            2026 comparison
          </div>
          <h1 className="text-[36px] sm:text-[60px] font-black tracking-tight text-hp-text leading-[1.15]">
            Looking for the Best <span className="text-hp-primary-text">Agorapulse Alternative</span>?
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl max-w-[760px] mx-auto leading-relaxed">
            Agorapulse charges per user, $79 a user a month billed yearly on Standard{offer(', and lists no free plan', '')}. Hookpost charges one {usdCopy('rupee', 'flat')} price for the whole team. Here is how the two compare, figure by figure.
          </p>
          <div className="pt-4 flex justify-center gap-4">
            <Link
              href="/auth"
              className="bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary font-bold text-base px-8 py-3.5 rounded-full transition-all shadow-lg shadow-hp-primary/20"
            >
              {offer('Get Started for Free', TRIAL_CTA)} &rarr;
            </Link>
          </div>
        </div>

        {/* Featured Snippet Definition Box */}
        <section className="bg-hp-surface border-l-4 border-hp-primary p-6 sm:p-8 rounded-r-2xl space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-hp-text">
            What is the Best Alternative to Agorapulse in 2026?
          </h2>
          <p className="text-hp-text-2 text-base sm:text-lg leading-relaxed">
            {BEST_ALTERNATIVE_ANSWER}
          </p>
        </section>

        {/* Head-to-Head Table */}
        <section className="space-y-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-hp-text text-center">
            Hookpost vs Agorapulse: Feature Comparison
          </h2>
          <div className="overflow-x-auto border border-hp-border rounded-2xl bg-hp-surface">
            <table className="w-full text-left text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-hp-border bg-hp-elevated">
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Capability</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-primary-text bg-hp-primary/5">Hookpost</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text-3">Agorapulse</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Advantage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hp-border">
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Starting Cost</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">{offer(`✅ Free plan / ${planPrice('HOOKPOST', '/mo')}`, `✅ ${planPrice('HOOKPOST', '/mo')}, ${FREE_POSTS}`)}</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">$79 / user / month billed annually ($99 monthly); no free plan listed on the pricing page</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/20">
                        Hookpost
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Team Seats</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ Up to {HP_INR.team_member_limit} team members at one flat price</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">⚠️ Priced per user; extra profiles $10 each/mo (billed annually)</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/20">
                        Hookpost
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">AI &amp; MCP</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ AI writing, API and MCP server on the Hookpost plan</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">✅ Self-hosted MCP connector for ChatGPT or Claude</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 text-hp-text">
                        Tie
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Global Billing Options</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ Razorpay (UPI, NetBanking &amp; Cards)</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">USD prices; no INR or UPI listed on its pricing page</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/20">
                        Hookpost
                      </span>
                    </td>
                  </tr>
              </tbody>
            </table>
          </div>
        </section>

        <IndiaCostNote slug="agorapulse" />

        <SwitchFrom slug="agorapulse" />


        <SectionFaq items={faqSchema.mainEntity} />

        {/* Sources. Replaced a "verified benchmark" claim that had no published
            methodology or data behind it. */}
        <section className="p-6 sm:p-8 rounded-2xl bg-white/[0.02] border border-hp-border space-y-2">
          <div className="flex items-center gap-2 text-xs text-green-400 font-semibold">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>SOURCES &bull; CHECKED {FACTS_CHECKED.toUpperCase()}</span>
          </div>
          <p className="text-xs sm:text-sm text-hp-text/60 leading-relaxed">
            {AGORA.name} figures were read off its own pricing page ({AGORA.sources.join(', ')}) on {FACTS_CHECKED}; prices can differ by country and billing period. Hookpost figures are its published plans. We do not publish performance benchmarks.
          </p>
        </section>

        {/* CTA */}
        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Try Hookpost next to Agorapulse
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base">
            {offer(`No credit card required. Free plan: ${FREE.channel} channels and ${FREE.posts_per_month} posts a month.`, TRIAL_SENTENCE)}
          </p>
          <Link
            href="/auth"
            className="inline-block bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary font-bold text-base px-10 py-4 rounded-full transition-all"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </div>

    </div>
  );
}
