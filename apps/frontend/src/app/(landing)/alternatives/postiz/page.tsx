import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { SectionFaq } from "../../SectionFaq";
import { IndiaCostNote } from "../IndiaCostNote";
import { SwitchFrom } from "../SwitchFrom";
import { PUBLISHABLE_CHANNEL_COUNT } from "../../channels/channel-count";
import { pricingINR } from "@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing";
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_ROW, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, planPriceInParens, usdCopy } from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

const FREE = pricingINR.FREE;
const HP_INR = pricingINR.HOOKPOST;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// Postiz hosted pricing, checked 26 Sep 2026 at postiz.com/pricing: no free
// hosted plan (7-day trial); Standard $29/mo or $23/mo billed yearly for 5
// channels; Team $39/mo or $31/mo billed yearly, adds unlimited team members.
// Every plan includes its hosted MCP server, CLI and public API. The free
// route is self-hosting the AGPL-3.0 code (github.com/gitroomhq/postiz-app,
// ~36k stars). Other Postiz tiers are not quoted here because they were not
// verified.
const POSTIZ_STD_MONTHLY = 29;
// Postiz's hosted trial, same check. Hookpost has no time trial for new users
// (FREE_POSTS, 28 Oct 2026), so the pages say what each one offers rather than
// "both".
const POSTIZ_TRIAL_DAYS = 7;
const POSTIZ_STD_YEARLY = 23;
const POSTIZ_TEAM_MONTHLY = 39;
const POSTIZ_TEAM_YEARLY = 31;
// 11 Oct 2026: Hookpost is priced in rupees only on this page (owner rule:
// no dollar-first copy, India is the market). Postiz bills only in US dollars,
// so the two are stated in their own currencies and never converted; the old
// dollar "savings" and 3-year totals were dollar-on-dollar and are gone.

export const metadata: Metadata = withSocial({
  title: offer("Postiz Alternative: Rupee Billing, Free Plan | Hookpost", "Postiz Alternative: Rupee Billing & UPI AutoPay | Hookpost"),
  description:
    `Compare Hookpost and Postiz: both ship an MCP server. ${offer('Hookpost adds rupee billing (Razorpay UPI and cards) and a hosted free plan.', 'Hookpost adds rupee billing with UPI AutoPay or cards, through Razorpay.')} Prices checked 26 Sep 2026.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/postiz",
  },
  openGraph: {
    title: offer("Postiz Alternative: Rupee Billing, Free Plan | Hookpost", "Postiz Alternative: Rupee Billing & UPI AutoPay | Hookpost"),
    description:
      `Compare Hookpost vs Postiz. Publishing to ${PUBLISHABLE_CHANNEL_COUNT} networks, Razorpay UPI & card billing, ${offer('a hosted free plan, ', '')}and a 3-year cost comparison.`,
    url: "https://hookpost.hookstep.in/alternatives/postiz",
    siteName: "Hookpost",
    images: [
      {
        url: "https://hookpost.hookstep.in/og-image.png",
        width: 1200,
        height: 630,
        alt: "Hookpost vs Postiz comparison",
      },
    ],
    locale: "en_US",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: offer("Postiz Alternative: Rupee Billing, Free Plan | Hookpost", "Postiz Alternative: Rupee Billing & UPI AutoPay | Hookpost"),
    description: `Compare Hookpost vs Postiz. Publishing to ${PUBLISHABLE_CHANNEL_COUNT} networks, ${offer('a hosted free plan, and UPI/Razorpay billing', 'rupee pricing, and UPI AutoPay through Razorpay')}.`,
    images: ["https://hookpost.hookstep.in/og-image.png"],
  },
});

export default function PostizAlternativePage() {
  const comparisonData = [
    { feature: "Supported Platforms", hookpost: `${PUBLISHABLE_CHANNEL_COUNT}, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, Bluesky, Discord, Telegram, WordPress and Dev.to`, postiz: "30 listed, incl. Instagram, Facebook, TikTok, Reddit, Pinterest", winner: "Postiz" },
    { feature: "Global & Indian Payment Gateways", hookpost: "✅ Razorpay (INR, UPI, Cards, NetBanking)", postiz: "❌ USD pricing; no INR or UPI listed", winner: "Hookpost" },
    // This row claimed Postiz was "Web AI Copilot Only". That is false and
    // trivially disproven: Postiz ships an MCP server and an agents CLI
    // (github.com/gitroomhq/postiz-agent, 450 stars, not archived, "connect it
    // to Claude / OpenClaw / etc, to schedule social media posts"), verified
    // against the GitHub API on 2026-09-08, and postiz.com/pricing (26 Sep 2026)
    // says every plan includes the hosted MCP server. Publishing a checkable falsehood
    // about the one competitor most likely to be fact-checked alongside us
    // discredits every other claim on the page.
    { feature: "AI Agents & MCP Server Integration", hookpost: "✅ Hosted MCP server and a CLI (npm hookpost), on the Hookpost plan", postiz: "✅ Hosted MCP server + CLI on every plan", winner: "Tie" },
    { feature: "Multi-Channel Calendar & Auto-Publishing", hookpost: "✅ Visual Drag & Drop Calendar", postiz: "✅ Visual Calendar", winner: "Tie" },
    { feature: "Team Members", hookpost: `Up to ${HP_INR.team_member_limit}, ${planPrice('HOOKPOST', '/mo')}`, postiz: `Unlimited on Team, $${POSTIZ_TEAM_MONTHLY}/mo or $${POSTIZ_TEAM_YEARLY}/mo billed yearly`, winner: "Postiz" },
    { feature: "Hosted Free Plan", hookpost: offer(`✅ ${FREE.channel} channels, ${FREE.posts_per_month} posts/month, no AI`, TRIAL_ROW), postiz: "❌ None on the hosted service (7-day trial)", winner: offer("Hookpost", "Tie") },
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
        name: "Postiz Alternative",
        item: "https://hookpost.hookstep.in/alternatives/postiz",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What makes Hookpost a good alternative to Postiz?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Both ship an MCP server for Claude and other AI agents. The differences are billing and the entry price: Hookpost bills ${usdCopy('in INR through Razorpay (UPI, NetBanking, Indian cards)', 'in USD by card, or in India in INR through Razorpay (UPI, NetBanking, Indian cards)')}, ${offer(`has a hosted free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month), and Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels. Postiz's hosted service has no free plan (7-day trial), and its Standard plan is`, `takes UPI AutoPay${usdCopy('', ' in India')}, and Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels. Hookpost gives ${FREE_POSTS} with no card, and Postiz's hosted service has a ${POSTIZ_TRIAL_DAYS}-day trial. Postiz's Standard plan is`)} $${POSTIZ_STD_MONTHLY}/month, or $${POSTIZ_STD_YEARLY}/month billed yearly, for 5 channels. Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, Bluesky, Discord, Telegram, WordPress and Dev.to. Postiz lists more networks, including Reddit and Mastodon.`,
        },
      },
      {
        "@type": "Question",
        name: "How does Hookpost pricing compare to Postiz and Buffer?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `${offer("Postiz's hosted service has no free plan; Hookpost is", "Postiz's hosted Standard plan is")} $${POSTIZ_STD_MONTHLY}/month ($${POSTIZ_STD_YEARLY} billed yearly) for 5 channels and Team is $${POSTIZ_TEAM_MONTHLY}/month ($${POSTIZ_TEAM_YEARLY} billed yearly) with unlimited team members, priced in USD. Hookpost bills ${usdCopy('in rupees', 'in US dollars, or rupees in India')}: ${offer(`a free plan (${FREE.channel} channels), Hookpost at`, 'Hookpost at')} ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels with AI and API access and up to ${HP_INR.team_member_limit} team members. Buffer charges $5 per channel per month billed yearly ($6 month-to-month) and has a free plan with 3 channels. Competitor prices checked 26 September 2026.`,
        },
      },
      {
        "@type": "Question",
        name: "How do I migrate my scheduled posts and queues from Postiz to Hookpost?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Migration takes three steps: (1) Re-connect your channels in Hookpost - OAuth for most networks, your own credentials for a few such as Bluesky, (2) recreate your scheduled queue in the Hookpost calendar or push it through the public API on the Hookpost plan, and (3) point your AI assistant at Hookpost's hosted MCP server with your API key (Claude Code: claude mcp add --transport http hookpost https://hookpost.hookstep.in/api/mcp --header 'Authorization: Bearer YOUR_API_KEY').",
        },
      },
      {
        "@type": "Question",
        name: "Does Hookpost support native Model Context Protocol (MCP) for Claude Desktop?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes, on the Hookpost plan. Hookpost runs a hosted MCP server that Claude (as a custom connector), Claude Code, Cursor, VS Code and other MCP clients can use to list your channels, check each network's rules and save drafts or scheduled posts. Postiz also includes a hosted MCP server on every plan.",
        },
      },
      {
        "@type": "Question",
        name: "Can I pay for Postiz or Hookpost with UPI?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Postiz prices its hosted plans in USD and lists no INR or UPI option, so Indian buyers pay with an internationally enabled card. Hookpost integrates Razorpay for domestic UPI, RuPay, and NetBanking payments at regional pricing (${HOOKPOST_DISPLAY_PRICE}/mo), plus Indian debit and credit cards.`,
        },
      },
      {
        "@type": "Question",
        name: "How does Hookpost compare to Mixpost?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Mixpost Lite is free and MIT-licensed but supports only Facebook Pages, X and Mastodon; Mixpost Pro is a $299 one-time licence per domain (Enterprise $1,199) and ships an MCP server. Hookpost runs on a TypeScript, Next.js and Node.js stack, with its own MCP server. Mixpost pricing checked 26 September 2026 at mixpost.app/pricing.",
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
        Hookpost vs Postiz: plans, prices and networks compared
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
            <li className="text-hp-primary-text font-semibold">Postiz Alternative</li>
          </ol>
        </nav>

        <div className="text-center space-y-4">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            2026 Comprehensive Comparison
          </div>
          <h1 className="text-[36px] sm:text-[60px] font-black tracking-tight text-hp-text leading-[1.15]">
            Looking for the Best <span className="text-hp-primary-text">Postiz Alternative</span>?
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl max-w-[760px] mx-auto leading-relaxed">
            Postiz and Hookpost both schedule to many networks and both ship an MCP server. The differences are {offer('a hosted free plan, rupee billing with UPI', 'rupee billing with UPI AutoPay')}, and price. Here they are, figure by figure.
          </p>
          <div className="pt-4 flex justify-center gap-4">
            <Link
              href="/auth"
              className="bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary font-bold text-base px-8 py-3.5 rounded-full transition-all shadow-lg shadow-hp-primary/20"
            >
              {offer('Get Started for Free', TRIAL_CTA)} &rarr;
            </Link>
          </div>

          {/* Author Byline & E-E-A-T Verification */}
          <div className="pt-6 flex flex-wrap items-center justify-center gap-2 sm:gap-4 text-xs text-hp-text/60 border-t border-hp-border max-w-[700px] mx-auto">
            <span>By <strong className="text-hp-text">Mohan Bhanushali</strong></span>
            <span>&bull;</span>
            <span>Founder, Hookpost</span>
            <span>&bull;</span>
            <span>Updated September 2026</span>
            <span>&bull;</span>
            <span className="text-hp-primary-text font-semibold">Prices checked 26 September 2026</span>
          </div>
        </div>

        {/* Market Landscape Context: Publer, Mixpost, Hootsuite & Postiz */}
        <section className="bg-gradient-to-r from-white/[0.03] to-white/[0.01] border border-hp-border rounded-2xl p-6 sm:p-8 space-y-4">
          <div className="flex items-center gap-2 text-xs text-hp-primary-text font-bold uppercase tracking-wider">
            <span>Market Context &bull; 2026 Landscape</span>
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-hp-text">
            Where Hookpost, Postiz, Mixpost, Publer &amp; Hootsuite Fit in 2026
          </h2>
          <p className="text-sm sm:text-base text-hp-text/80 leading-relaxed">
            The social media scheduling market in 2026 splits three ways: per-seat suites like <strong>Hootsuite</strong> ($99 per user per month billed annually), cloud schedulers like <strong>Publer</strong> (from $4 per channel per month billed yearly, with a free plan), and self-hostable tools like <strong>Mixpost</strong> (free MIT Lite edition; Pro is a $299 one-time licence) and <strong>Postiz</strong> (AGPL-3.0; hosted plans from $23/mo billed yearly). Prices checked 26 September 2026.
          </p>
          <p className="text-sm sm:text-base text-hp-text/70 leading-relaxed">
            <strong>Hookpost</strong> offers rupee billing through Razorpay (UPI &amp; cards), {offer(`a hosted free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month), and paid plans from ${planPrice('HOOKPOST', ' a month')}`, `and plans from ${planPrice('HOOKPOST', ' a month')}, after ${FREE_POSTS}`)}. Like Postiz, it ships an MCP server for Claude &amp; Cursor.
          </p>
        </section>

        {/* Featured Snippet Answer Block */}
        <section className="bg-hp-surface border-l-4 border-hp-primary p-6 sm:p-8 rounded-r-2xl space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-hp-text">
            What is the Best Alternative to Postiz?
          </h2>
          <p className="text-hp-text-2 text-base sm:text-lg leading-relaxed">
            Both ship an MCP server. Hookpost adds Razorpay UPI and card billing in rupees{offer(' and a hosted free plan', '')}, and publishes to {PUBLISHABLE_CHANNEL_COUNT} networks. Postiz lists more networks and allows unlimited team members on its Team plan.
          </p>
          <p className="text-sm text-hp-text/50 pt-1">
            Hookpost publishes to X, LinkedIn, YouTube, Facebook Pages, Pinterest, Bluesky, Discord, Slack, Telegram, WordPress, Hashnode, Dev.to, Lemmy, Nostr and Listmonk, plus Instagram, Threads and TikTok (TikTok publishes with the audience the account allows, or as inbox drafts).
          </p>
        </section>

        {/* Comparison Table */}
        <section className="space-y-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-hp-text text-center">
            Feature Comparison: Hookpost vs Postiz
          </h2>
          <div className="overflow-x-auto border border-hp-border rounded-2xl bg-hp-surface">
            <table className="w-full text-left text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-hp-border bg-hp-elevated">
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Feature</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-primary-text bg-hp-primary/5">Hookpost</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text-3">Postiz</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Advantage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hp-border">
                {comparisonData.map((row, idx) => (
                  <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">{row.feature}</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">{row.hookpost}</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">{row.postiz}</td>
                    <td className="p-4 sm:p-5">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${row.winner === "Hookpost" ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-white/10 text-hp-text"}`}>
                        {row.winner}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Key Reasons Hookpost Wins */}
        <section className="space-y-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-hp-text">
            Where Hookpost Differs from Postiz
          </h2>
          <div className="grid sm:grid-cols-2 gap-6">
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-6 space-y-3">
              <h3 className="text-lg font-bold text-hp-primary-text">1. Rupee billing with UPI</h3>
              <p className="text-sm text-hp-text-2 leading-relaxed">
                Postiz prices its hosted plans in USD and lists no INR or UPI option. Hookpost bills in rupees through <strong>Razorpay (UPI Autopay, NetBanking, Indian cards)</strong>, so no international card is needed.
              </p>
            </div>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-6 space-y-3">
              <h3 className="text-lg font-bold text-hp-primary-text">{offer('2. A Hosted Free Plan', '2. UPI AutoPay, in Rupees')}</h3>
              <p className="text-sm text-hp-text-2 leading-relaxed">
                {offer(
                  <>Postiz's hosted service has no free plan, only a 7-day trial. Hookpost's hosted free plan keeps {FREE.channel} channels and {FREE.posts_per_month} posts a month free. Both ship an MCP server and CLI for AI agents.</>,
                  <>Postiz prices its hosted plans in US dollars, so paying from India takes an internationally enabled card. Hookpost bills in rupees through Razorpay and renews by UPI AutoPay or card, from {HOOKPOST_DISPLAY_PRICE} a month. Both ship an MCP server and CLI for AI agents.</>
                )}
              </p>
            </div>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-6 space-y-3">
              <h3 className="text-lg font-bold text-hp-primary-text">3. Entry price, in each currency</h3>
              <p className="text-sm text-hp-text-2 leading-relaxed">
                Hookpost is {planPrice('HOOKPOST', ' a month')} for {HP_INR.channel} channels, {usdCopy('paid in rupees', 'paid in dollars, or in rupees in India')}. Postiz Standard is ${POSTIZ_STD_MONTHLY} a month, or ${POSTIZ_STD_YEARLY} billed yearly, for 5 channels, paid in dollars. For teams, Postiz Team (${POSTIZ_TEAM_MONTHLY} a month) allows unlimited members; Hookpost ({planPriceInParens('HOOKPOST')}) allows up to {HP_INR.team_member_limit}.
              </p>
            </div>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-6 space-y-3">
              <h3 className="text-lg font-bold text-hp-primary-text">4. Support from India</h3>
              <p className="text-sm text-hp-text-2 leading-relaxed">
                Hookpost is run by Hookstep in Mumbai, and support answers in English, Hindi or Punjabi through the <Link href="/contact" className="text-hp-primary-text underline">contact page</Link>.
              </p>
            </div>
          </div>
        </section>

        {/* Verified Tier-by-Tier Pricing Comparison */}
        <section className="space-y-6">
          <div className="text-center space-y-2">
            <h2 className="text-2xl sm:text-3xl font-bold text-hp-text">
              Plan by plan: Postiz vs Hookpost
            </h2>
            <p className="text-sm text-hp-text-2 max-w-2xl mx-auto">
              Postiz's hosted plans are priced in USD. Standard and Team below were read from postiz.com/pricing on 26 September 2026:
            </p>
          </div>

          <div className="overflow-x-auto border border-hp-border rounded-2xl bg-hp-surface">
            <table className="w-full text-left text-xs sm:text-sm border-collapse min-w-[650px]">
              <thead>
                <tr className="border-b border-hp-border bg-hp-elevated">
                  <th className="p-4 font-bold text-hp-text">Plan Tier</th>
                  <th className="p-4 font-bold text-hp-text-3">Postiz Cloud (USD Only)</th>
                  <th className="p-4 font-bold text-hp-primary-text bg-hp-primary/5">Hookpost Equivalent</th>
                  <th className="p-4 font-bold text-hp-text">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hp-border text-hp-text-2">
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-semibold text-hp-text">Free / Trial</td>
                  <td className="p-4">No hosted free plan (7-day trial)</td>
                  <td className="p-4 text-hp-text bg-hp-primary/5 font-bold">{offer(`Free: ${FREE.channel} channels, ${FREE.posts_per_month} posts/month`, TRIAL_ROW)}</td>
                  <td className="p-4 text-emerald-400 font-semibold">{offer('Hosted free plan', `No hosted free plan on either: ${FREE_POSTS} on Hookpost, a ${POSTIZ_TRIAL_DAYS}-day trial on Postiz`)}</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-semibold text-hp-text">Standard</td>
                  <td className="p-4 font-mono">${POSTIZ_STD_MONTHLY} / month, or ${POSTIZ_STD_YEARLY} billed yearly (5 channels)</td>
                  <td className="p-4 text-hp-text bg-hp-primary/5 font-bold">{planPrice('HOOKPOST', '/mo')}{usdCopy(' with UPI', '')}, {HP_INR.channel} channels</td>
                  <td className="p-4">{usdCopy('Same channel count; Hookpost in rupees, Postiz in US dollars', 'Same channel count, both in US dollars; Hookpost in rupees in India')}</td>
                </tr>
                <tr className="hover:bg-white/[0.02]">
                  <td className="p-4 font-semibold text-hp-text">Team</td>
                  <td className="p-4 font-mono">${POSTIZ_TEAM_MONTHLY} / month, or ${POSTIZ_TEAM_YEARLY} billed yearly (unlimited team members)</td>
                  <td className="p-4 text-hp-text bg-hp-primary/5 font-bold">Hookpost: {planPrice('HOOKPOST', '/mo')}{usdCopy(' with UPI', '')}, {HP_INR.channel} channels, up to {HP_INR.team_member_limit} team members</td>
                  <td className="p-4">Postiz allows unlimited members; Hookpost caps at {HP_INR.team_member_limit}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Real Technical Data-Migration Steps */}
        <section className="bg-hp-surface border border-hp-border rounded-2xl p-6 sm:p-8 space-y-6">
          <div className="text-center space-y-2">
            <span className="text-xs uppercase tracking-widest text-hp-primary-text font-bold">Migration</span>
            <h2 className="text-2xl sm:text-3xl font-bold text-hp-text">
              How to move from Postiz to Hookpost
            </h2>
            <p className="text-hp-text-2 text-sm max-w-xl mx-auto">
              Three steps for your queued posts, media and automations:
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 pt-2">
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-3">
              <div className="w-8 h-8 rounded-full bg-hp-primary text-hp-on-primary font-black flex items-center justify-center text-sm">1</div>
              <h3 className="font-bold text-hp-text text-base">Export Post Queue &amp; Assets</h3>
              <p className="text-xs sm:text-sm text-hp-text/70 leading-relaxed">
                Copy your scheduled content out of Postiz - from its database if you self-host, or from the calendar - including media URLs, captions, timestamps and target channels.
              </p>
            </div>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-3">
              <div className="w-8 h-8 rounded-full bg-hp-primary text-hp-on-primary font-black flex items-center justify-center text-sm">2</div>
              <h3 className="font-bold text-hp-text text-base">Channel OAuth Re-linking</h3>
              <p className="text-xs sm:text-sm text-hp-text/70 leading-relaxed">
                Connect your accounts in Hookpost - OAuth for Instagram, Threads, TikTok, Facebook Pages, X, LinkedIn, YouTube and most others, your own credentials for a few such as Bluesky.
              </p>
            </div>
            <div className="bg-hp-elevated border border-hp-border rounded-xl p-5 space-y-3">
              <div className="w-8 h-8 rounded-full bg-hp-primary text-hp-on-primary font-black flex items-center justify-center text-sm">3</div>
              <h3 className="font-bold text-hp-text text-base">Move automations and AI agents</h3>
              <p className="text-xs sm:text-sm text-hp-text/70 leading-relaxed">
                Point n8n workflows and Zapier or Make HTTP requests at the Hookpost REST API with your new API key. For Claude Code, run{' '}
                <code className="text-hp-primary-text break-all">claude mcp add --transport http hookpost https://hookpost.hookstep.in/api/mcp --header &quot;Authorization: Bearer YOUR_API_KEY&quot;</code>
                ; other clients are on the <Link href="/mcp" className="text-hp-primary-text underline">MCP page</Link>.
              </p>
            </div>
          </div>
        </section>

        {/* Visible FAQ Section */}
        <IndiaCostNote slug="postiz" />

        <SwitchFrom slug="postiz" steps={false} networks={false} />

        <SectionFaq items={faqSchema.mainEntity} />

        {/* E-E-A-T Benchmark Section */}
        <section className="p-6 sm:p-8 rounded-2xl bg-white/[0.02] border border-hp-border space-y-2">
          <div className="flex items-center gap-2 text-xs text-green-400 font-semibold">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>FACTS CHECKED &bull; 26 SEPTEMBER 2026</span>
          </div>
          <p className="text-xs sm:text-sm text-hp-text/60 leading-relaxed">
            Postiz's prices and plans were read from postiz.com/pricing on 26 September 2026. Hookpost's figures come from its live pricing configuration.
          </p>
        </section>

        {/* Bottom CTA */}
        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Try Hookpost next to Postiz
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base sm:text-lg">
            {offer(`The free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, with no credit card.`, TRIAL_SENTENCE)}
          </p>
          <Link
            href="/auth"
            className="inline-block bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary font-bold text-base px-10 py-4 rounded-full transition-all"
          >
            {offer('Create Your Free Account', TRIAL_CTA)}
          </Link>
        </div>
      </div>

    </div>
  );
}
