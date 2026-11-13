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
import { USD_HOOKPOST_MONTH, planPrice, usdCopy } from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

const FREE = pricingINR.FREE;
const HP_INR = pricingINR.HOOKPOST;
const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

// Buffer Essentials for ten channels, checked 26 Sep 2026 at buffer.com/pricing:
// $5/channel/mo billed yearly ($600/yr), $6 month-to-month ($720/yr).
// Hookpost is priced in rupees for India (owner rule: no dollar-first copy),
// and Buffer only in dollars, so the page states both in their own currency
// and never converts one into the other.
const BUFFER_10CH_YEARLY = 600;
const BUFFER_10CH_MONTHLY = 720;

export const metadata: Metadata = withSocial({
  title: "Buffer Alternative (2026): No Per-Channel Pricing | Hookpost",
  description:
    `Hookpost vs Buffer: Buffer bills per channel in US dollars; Hookpost is ${planPrice('HOOKPOST', ' a month')} flat for ${HP_INR.channel} channels, ${usdCopy('paid in rupees with UPI', 'paid by card, or by UPI in India')}${offer(', plus a free plan', `, with ${FREE_POSTS}`)}.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/buffer",
  },
  openGraph: {
    title: "Buffer Alternative (2026): No Per-Channel Pricing | Hookpost",
    description:
      `Compare Hookpost vs Buffer. No per-channel billing: ${HP_INR.channel} channels, publishing to ${PUBLISHABLE_CHANNEL_COUNT} networks.`,
    url: "https://hookpost.hookstep.in/alternatives/buffer",
    siteName: "Hookpost",
    images: [
      {
        url: "https://hookpost.hookstep.in/og-image.png",
        width: 1200,
        height: 630,
        alt: "Buffer Competitors - Hookpost vs Buffer",
      },
    ],
    locale: "en_US",
    type: "article",
  },
  twitter: {
    card: "summary_large_image",
    title: "Buffer Alternative (2026): No Per-Channel Pricing | Hookpost",
    description: `Buffer bills per channel in US dollars. Hookpost bundles channels into flat ${usdCopy('rupee ', '')}plans, from ${offer('free', planPrice('HOOKPOST'))} to ${planPrice('HOOKPOST', ' a month')}.`,
    images: ["https://hookpost.hookstep.in/og-image.png"],
  },
});

export default function BufferAlternativePage() {
  const comparisonData = [
    // Basis stated explicitly. Buffer's headline price is $5/channel/mo
    // billed yearly ($60/yr); $6 is the month-to-month rate. Quoting $6
    // unlabelled reads as wrong to anyone who opens buffer.com/pricing.
    // Checked 26 Sep 2026 against buffer.com/pricing.
    { feature: "Channel Pricing Model", hookpost: "✅ Channels bundled into the plan", buffer: "Per channel: $5/mo billed yearly, $6 month-to-month", winner: "Hookpost" },
    // One plan is sold (HOOKPOST), so ten channels fit inside it.
    { feature: "Cost for 10 social accounts", hookpost: `${planPrice('HOOKPOST', '/mo')} — up to ${HP_INR.channel} channels`, buffer: "$50/mo billed yearly, $60 month-to-month", winner: usdCopy("At your exchange rate", "Hookpost") },
    // Buffer's AI assistant is on every plan including Free, and its MCP
    // server is too (buffer.com/pricing, buffer.com/mcp, 26 Sep 2026).
    { feature: "AI Assistant & MCP Server", hookpost: offer("AI on the Hookpost plan (not on Free); MCP server", "AI and MCP server on the Hookpost plan"), buffer: "✅ AI assistant and MCP server on every plan, including Free", winner: "Buffer" },
    { feature: "Supported Networks", hookpost: `${PUBLISHABLE_CHANNEL_COUNT}, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, Bluesky, Discord, Telegram, WordPress and Dev.to`, buffer: "12, incl. Instagram, Facebook, TikTok, Pinterest, Threads, X", winner: "Hookpost" },
    // Scoring "Buffer: Foreign Credit Card Only" as a Hookpost win read exactly
    // backwards to the buyer this page is for - an ordinary credit card is what
    // they want. Stated as fact, with no winner claimed.
    { feature: "Billing & Payment Methods", hookpost: usdCopy("Billed in INR — UPI, NetBanking & Indian cards", "Billed in USD by card; in India, INR — UPI, NetBanking & Indian cards"), buffer: "Billed in USD — no INR pricing", winner: "Tie" },
    { feature: "Free Plan", hookpost: offer(`${FREE.channel} channels, ${FREE.posts_per_month} posts/month, no AI`, TRIAL_ROW), buffer: "3 channels, 10 scheduled posts per channel, AI assistant included", winner: "Buffer" },
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
        name: "Buffer Competitors",
        item: "https://hookpost.hookstep.in/alternatives/buffer",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How does Hookpost compare with Buffer in 2026?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Buffer prices per channel: $5 per channel per month billed yearly, or $6 month-to-month, so ten channels costs $50-$60 a month. Hookpost bundles channels into flat ${usdCopy('rupee ', '')}plans - ${HP_INR.channel} channels on Standard at ${planPrice('HOOKPOST', ' a month')} and ${HP_INR.channel} channels on Pro at ${planPrice('HOOKPOST', ' a month')} - publishing to ${PUBLISHABLE_CHANNEL_COUNT} networks, ${offer(`with a free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month). Buffer's free plan has one more channel (3) and includes its AI assistant, which Hookpost's free plan does not.`, `starting with ${FREE_POSTS}, no card needed. Buffer has a free plan, with 3 channels and its AI assistant; Hookpost does not.`)} Buffer pricing checked 26 September 2026 at buffer.com/pricing.`,
        },
      },
      {
        "@type": "Question",
        name: "What do ten channels cost on Buffer and on Hookpost?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Ten profiles on Buffer Essentials cost $${BUFFER_10CH_YEARLY} a year billed yearly, or $${BUFFER_10CH_MONTHLY} month-to-month, paid in US dollars on a card that allows international payments. Hookpost has one plan, at ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month for up to ${HP_INR.channel} channels, paid in rupees. Compare the two at your card's exchange rate, including any foreign-transaction fee.`, `${USD_HOOKPOST_MONTH} a month for up to ${HP_INR.channel} channels, paid in US dollars by card; in India it is ${HOOKPOST_DISPLAY_PRICE} a month, paid in rupees.`)} Hookpost is not like-for-like here, because it includes ${HP_INR.channel} channels, not 10.`,
        },
      },
      {
        "@type": "Question",
        name: "Does Hookpost support AI agents and Claude Desktop via MCP?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes, on the Hookpost plan. Hookpost runs a hosted MCP server that Claude, Claude Code, Cursor, VS Code and other MCP clients can use to list your channels, read your scheduled posts, check each network's rules and save drafts or scheduled posts. Buffer also has an MCP server, included on every plan including Free.",
        },
      },
      {
        "@type": "Question",
        name: "How do I migrate from Buffer to Hookpost with zero downtime?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Migration takes 3 steps: (1) Connect your channels in Hookpost - OAuth for most networks, your own credentials for a few such as Bluesky, (2) recreate your scheduled queue in the Hookpost calendar, or push it through the public API on the Hookpost plan, and (3) optionally schedule from an AI assistant such as Claude Code or Cursor through Hookpost's hosted MCP server (setup on the MCP page).",
        },
      },
      {
        "@type": "Question",
        name: "Does Hookpost support Indian payment methods like UPI and RuPay?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Yes. Hookpost bills through Razorpay and supports UPI, RuPay, NetBanking and Indian cards at rupee pricing (${HOOKPOST_DISPLAY_PRICE}/mo). Buffer shows USD prices only, with no INR option.`,
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
        Buffer bills per channel. Hookpost bundles channels into flat plans, starting at {offer('₹0', `${planPrice('HOOKPOST', ' a month')}`)}.
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
            <li className="text-hp-primary-text font-semibold">Buffer Alternative</li>
          </ol>
        </nav>

        <div className="text-center space-y-4">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            Buffer Alternative 2026
          </div>
          <h1 className="text-[36px] sm:text-[60px] font-black tracking-tight text-hp-text leading-[1.15]">
            The <span className="text-hp-primary-text">Buffer Alternative</span> <br />
            Without Per-Channel Pricing
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl max-w-[760px] mx-auto leading-relaxed">
            Buffer charges for every connected account, in US dollars. Hookpost bundles channels into flat {usdCopy('rupee ', '')}plans - {HP_INR.channel} channels - {offer(`with a free plan for ${FREE.channel}`, `with ${FREE_POSTS} to start`)}.
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

        {/* Featured Snippet Box */}
        <section className="bg-hp-surface border-l-4 border-hp-primary p-6 sm:p-8 rounded-r-2xl space-y-3">
          <h2 className="text-xl sm:text-2xl font-bold text-hp-text">
            What is the Best Alternative to Buffer in 2026?
          </h2>
          <p className="text-hp-text-2 text-base sm:text-lg leading-relaxed">
            If per-channel billing is what bothers you about Buffer, Hookpost is the one to look at: it bundles channels into flat plans billed {usdCopy('in rupees through Razorpay (UPI, cards, NetBanking)', 'in US dollars by card, or in India in rupees through Razorpay (UPI, cards, NetBanking)')}, publishes to {PUBLISHABLE_CHANNEL_COUNT} networks, {offer('and has AI writing on paid plans and a free plan. If you want AI on a free plan, Buffer includes its assistant there and Hookpost does not.', `and has AI writing on both plans, with ${FREE_POSTS} to start. If you want a free plan, Buffer has one, with its AI assistant, and Hookpost does not.`)}
          </p>
        </section>

        {/* Comparison Table */}
        <section className="space-y-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-hp-text text-center">
            Side-by-Side Comparison: Hookpost vs Buffer
          </h2>
          <div className="overflow-x-auto border border-hp-border rounded-2xl bg-hp-surface">
            <table className="w-full text-left text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-hp-border bg-hp-elevated">
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Feature</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-primary-text bg-hp-primary/5">Hookpost</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text-3">Buffer</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Advantage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hp-border">
                {comparisonData.map((row, idx) => (
                  <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">{row.feature}</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">{row.hookpost}</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">{row.buffer}</td>
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

        {/* Why Hookpost Beats Buffer */}
        <div className="grid sm:grid-cols-3 gap-6">
          <div className="bg-hp-elevated border border-hp-border rounded-2xl p-6 space-y-3">
            <h3 className="text-xl font-bold text-hp-text">No per-channel fee</h3>
            <p className="text-sm text-hp-text-3">
              Buffer bills per channel: $5 a month each billed yearly, $6 month-to-month, so 10 channels is $50-$60 a month. Hookpost bundles channels - {HP_INR.channel} on Pro at {planPrice('HOOKPOST', ' a month')}, {HP_INR.channel} on Standard at {planPrice('HOOKPOST')}{offer(`, and ${FREE.channel} on the free plan`, '')}.
            </p>
          </div>
          <div className="bg-hp-elevated border border-hp-border rounded-2xl p-6 space-y-3">
            <h3 className="text-xl font-bold text-hp-text">{PUBLISHABLE_CHANNEL_COUNT} networks</h3>
            <p className="text-sm text-hp-text-3">
              X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok and Bluesky, plus community and developer channels Buffer does not list: Discord, Slack, Telegram, WordPress, Hashnode, Dev.to, Lemmy, Nostr and Listmonk.
            </p>
          </div>
          <div className="bg-hp-elevated border border-hp-border rounded-2xl p-6 space-y-3">
            <h3 className="text-xl font-bold text-hp-text">AI writing and MCP</h3>
            <p className="text-sm text-hp-text-3">
              Draft and rewrite posts with the AI assistant on paid plans, and schedule from Claude, Cursor and other MCP clients through the hosted MCP server. Buffer has an MCP server too, on every plan.
            </p>
          </div>
        </div>

        {/* Visible FAQ Section */}
        <IndiaCostNote slug="buffer" />

        <SwitchFrom slug="buffer" />

        <SectionFaq
          items={faqSchema.mainEntity}
          title="Frequently Asked Questions: Buffer Competitors &amp; Migration"
        />

        {/* CTA */}
        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Try Hookpost next to Buffer
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base">
            {offer(`No credit card required. The free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month.`, TRIAL_SENTENCE)}
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
