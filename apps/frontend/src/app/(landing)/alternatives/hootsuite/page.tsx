import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { SectionFaq } from "../../SectionFaq";
import { IndiaCostNote } from "../IndiaCostNote";
import { SwitchFrom } from "../SwitchFrom";
import { PUBLISHABLE_CHANNEL_COUNT } from "../../channels/channel-count";
import { pricingINR } from "@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing";
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA } from '../../trial-offer';
import { planPrice, usdCopy } from '../../usd-offer';

const FREE = pricingINR.FREE;
const HP_INR = pricingINR.HOOKPOST;

export const metadata: Metadata = withSocial({
  title: offer("Hootsuite Alternative (2026): Free Plan | Hookpost", "Hootsuite Alternative (2026): Flat Team Pricing | Hookpost"),
  description:
    `${offer('Hootsuite is ₹1,999 per user a month in India, with no free plan. Hookpost has a free plan and a paid plan at', `Hootsuite is ₹1,999 per user a month in India. Hookpost has ${FREE_POSTS} and then a paid plan at`)} ${planPrice('HOOKPOST', ' a month')} for up to ${HP_INR.team_member_limit} team members.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/hootsuite",
  },
});

export default function HootsuiteAlternativePage() {
  const comparisonData = [
    // Hootsuite figures checked 26 Sep 2026 at hootsuite.com/plans: Standard
    // $99/user/mo billed annually, 10 channels, 14-day trial, no free plan.
    // Indian visitors are shown Rs 1,999/user/mo billed annually (re-read from
    // India on 11 Oct 2026), so it is not dollars-only and the page leads with
    // the rupee figure.
    { feature: "Starting Monthly Price", hookpost: offer(`Free / ${planPrice('HOOKPOST', '/mo')}`, `${planPrice('HOOKPOST', '/mo')}, ${FREE_POSTS}`), hootsuite: "₹1,999 / user / month billed annually in India ($99 elsewhere); no free plan, 14-day trial", winner: "Hookpost" },
    { feature: "Supported Social Channels", hookpost: `${PUBLISHABLE_CHANNEL_COUNT}, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok, Bluesky, Discord, Telegram, WordPress and Dev.to`, hootsuite: "11 networks, incl. Instagram, Facebook, TikTok, WhatsApp, X", winner: "Depends" },
    { feature: "Payment Methods", hookpost: "✅ Razorpay (UPI, NetBanking, Cards)", hootsuite: "INR prices shown in India; UPI not listed", winner: "Hookpost" },
    { feature: "Teams", hookpost: `Up to ${HP_INR.team_member_limit} team members, flat ${planPrice('HOOKPOST', '/mo')} for ${HP_INR.channel} channels`, hootsuite: "Priced per user: ₹1,999 / user / month on Standard in India", winner: "Hookpost" },
  ];

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
        name: "Hootsuite Alternative",
        item: "https://hookpost.hookstep.in/alternatives/hootsuite",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: offer("Is there a free alternative to Hootsuite?", "Is there a cheaper alternative to Hootsuite?"),
        acceptedAnswer: {
          "@type": "Answer",
          text: `${offer(`Hootsuite has no free plan (it offers a 14-day trial), and Standard costs ₹1,999 per user per month billed annually for Indian visitors ($99 elsewhere). Hookpost has a free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month), publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, and paid plans start at ${planPrice('HOOKPOST', ' a month')} with UPI, NetBanking and card support via Razorpay.`, `Hootsuite Standard costs ₹1,999 per user per month billed annually for Indian visitors ($99 elsewhere), with a 14-day trial. Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, and plans start at ${planPrice('HOOKPOST', ' a month')} for the workspace after ${FREE_POSTS}, with UPI, NetBanking and card support via Razorpay.`)} Hootsuite pricing read at hootsuite.com/plans, from India on 11 October 2026.`,
        },
      },
      {
        "@type": "Question",
        name: "Can I manage agency clients on Hookpost instead of Hootsuite?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Yes. Hookpost includes up to ${HP_INR.team_member_limit} team members and ${HP_INR.channel} channels for a flat ${planPrice('HOOKPOST', ' a month')}, and channels can be grouped by client. Hootsuite prices per user: Hootsuite Standard is ₹1,999 per user per month billed annually in India, so a three-person team starts at ₹5,997 a month.`,
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
        Hootsuite starts at ₹1,999 per user per month in India. Hookpost starts {offer('free', `at ${planPrice('HOOKPOST', ' a month')}`)}.
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" aria-label="Hookpost home" className="flex items-center gap-2 shrink-0">
          <img alt="" src="/brand-logo-96.webp" width="96" height="96" className="h-8 md:h-10 w-auto max-h-[38px] object-contain" />
          {/* Icon only on phones: the wordmark and both buttons need ~365px. */}<span className="hidden sm:inline text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-4">
          <Link href="/auth/login" className="text-sm font-medium text-hp-text hover:text-hp-primary-text transition-colors px-3 sm:px-4 py-2 whitespace-nowrap border border-hp-border-strong rounded-full hover:border-hp-primary">
            Log In
          </Link>
          <Link href="/auth" className="text-sm font-medium bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary transition-all px-4 sm:px-5 py-2 rounded-full font-semibold whitespace-nowrap">
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1100px] mx-auto px-6 py-12 text-center space-y-12">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50 text-left">
          <ol className="flex items-center space-x-2">
            <li>
              <Link href="/" className="hover:text-hp-text transition-colors">Home</Link>
            </li>
            <li>/</li>
            <li>
              <Link href="/alternatives" className="hover:text-hp-text transition-colors">Alternatives</Link>
            </li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Hootsuite Alternative</li>
          </ol>
        </nav>

        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-hp-primary-text text-xs font-semibold uppercase tracking-wider mb-6 border border-hp-border">
            Hootsuite alternative, 2026
          </div>
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] mb-6">
            The Hootsuite alternative <br className="hidden sm:block" />
            <span className="text-hp-primary-text">
              without per-user pricing.
            </span>
          </h1>
          <p className="text-lg text-hp-text/70 max-w-2xl mx-auto mb-8">
            Hootsuite {offer('has no free plan and prices', 'prices')} every seat, from ₹1,999 a month in India. Hookpost publishes to {PUBLISHABLE_CHANNEL_COUNT} networks, starts {offer('free', `with ${FREE_POSTS}`)}, and charges one {usdCopy('rupee', 'flat')} price for a team of up to {HP_INR.team_member_limit}.
          </p>

          <div className="flex flex-col sm:flex-row justify-center items-center gap-4 mb-8">
            <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary hover:bg-hp-primary-hover text-hp-on-primary font-bold text-lg rounded-full shadow-lg shadow-hp-primary/25 transition-all">
              {offer('Start free', TRIAL_CTA)} →
            </Link>
            <Link href="/compare" className="w-full sm:w-auto px-8 py-4 bg-white/10 hover:bg-white/20 text-hp-text font-medium text-lg rounded-full border border-hp-border transition-all">
              Compare All Competitors
            </Link>
          </div>
        </div>

        {/* Featured Snippet Answer Box */}
        <section className="bg-hp-surface border-l-4 border-hp-primary p-6 sm:p-8 rounded-r-2xl space-y-3 text-left">
          <h2 className="text-xl sm:text-2xl font-bold text-hp-text">
            What is the Best Alternative to Hootsuite in 2026?
          </h2>
          <p className="text-hp-text-2 text-base sm:text-lg leading-relaxed">
            If per-user pricing is the problem, Hookpost is worth a look. Hootsuite Standard is ₹1,999 per user a month billed yearly in India; Hookpost is {planPrice('HOOKPOST', ' a month')} for up to {HP_INR.team_member_limit} people and {HP_INR.channel} channels, and {offer(`there is a free plan with ${FREE.channel} channels and ${FREE.posts_per_month} posts a month`, `new workspaces start with ${FREE_POSTS}`)}. If you need Hootsuite&apos;s inbox, listening or WhatsApp, Hookpost does not have them.
          </p>
        </section>

        <div className="overflow-x-auto rounded-2xl border border-hp-border bg-white/[0.02] p-4 sm:p-8 backdrop-blur-xl text-left">
          <h2 className="text-2xl font-bold mb-6 text-center">Head-to-Head Comparison: Hookpost vs Hootsuite</h2>
          <table className="w-full text-sm sm:text-base border-collapse">
            <thead>
              <tr className="border-b border-hp-border text-hp-text/50">
                <th className="py-4 px-4 font-semibold">Feature / Capability</th>
                <th className="py-4 px-4 font-bold text-hp-primary-text text-center">Hookpost</th>
                <th className="py-4 px-4 font-semibold text-center">Hootsuite</th>
                <th className="py-4 px-4 font-semibold text-center">Advantage</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {comparisonData.map((row, idx) => (
                <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-4 px-4 font-medium text-hp-text">{row.feature}</td>
                  <td className="py-4 px-4 text-center text-hp-text/90 font-semibold">{row.hookpost}</td>
                  <td className="py-4 px-4 text-center text-hp-text/50">{row.hootsuite}</td>
                  <td className="py-4 px-4 text-center font-bold text-hp-primary-text">{row.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <IndiaCostNote slug="hootsuite" />

        <SwitchFrom slug="hootsuite" />


        <SectionFaq items={faqSchema.mainEntity} />
      </div>

    </div>
  );
}
