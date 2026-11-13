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
import { planPrice } from '../../usd-offer';

const FREE = pricingINR.FREE;
const HP_INR = pricingINR.HOOKPOST;

/** When metricool.com/pricing was last read. Printed on the page. */
const METRICOOL_CHECKED = '28 October 2026';

// Metricool figures re-read at metricool.com/pricing on 28 Oct 2026 and
// unchanged from the 26 Sep read, with two details added: free plan 1 brand
// (every network it supports except LinkedIn and Twitter/X), 20 posts a month,
// AI social media assistant and Metricool MCP; Starter from $20/mo billed
// annually ($25 month-to-month) for up to 5 brands, $36/mo for up to 10;
// LinkedIn starts on Starter; X (Twitter) is a paid add-on on EVERY plan, free
// included; the Metricool API (Zapier, Make) starts on Advanced, from $53/mo
// billed annually; prices are in euros and US dollars only, excluding VAT.
// Re-check the page before bumping METRICOOL_CHECKED.
const BEST_METRICOOL_ANSWER = `Hookpost is an alternative to Metricool for multi-platform publishing. Metricool prices by brand: its free plan covers 1 brand and 20 posts a month but excludes LinkedIn and X, and Starter is $20/month billed annually ($25 month-to-month) for up to 5 brands, with X as a paid add-on. ${offer(`Hookpost's free plan has ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, LinkedIn and X included, and Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels.`, `Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels, LinkedIn and X included, with ${FREE_POSTS}.`)} Both ship an MCP server for Claude and other AI agents. Neither is open source: if you need to self-host, that is a different shortlist. Metricool pricing checked ${METRICOOL_CHECKED}.`;

// The open-source question, answered honestly in one place so the visible
// section, the FAQ and the FAQPage schema cannot drift apart. Hookpost is a
// hosted, proprietary service (LICENSE; every package.json UNLICENSED; the
// repository is private), so this answer must never imply otherwise - and it
// must not pretend the question is unreasonable either. People search
// "metricool open source alternative" because they want to self-host, and the
// useful reply names the self-hosted option and then says what Hookpost is
// instead.
const OPEN_SOURCE_ANSWER =
  `Not Metricool and not Hookpost: both are hosted, closed-source services. Metricool does not publish its source, and Hookpost is a hosted service with no self-hosted edition and no public repository. The open-source option in this category is Mixpost, whose Lite edition is MIT-licensed and runs on your own server with Docker or as a Laravel app; self-hosting it means registering your own developer app with each network and running the database and background workers yourself. If what you actually want from "open source" is to stop paying per brand and to keep X and LinkedIn, Hookpost does that without a server to run: ${offer(`its free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month with LinkedIn and X included`, `Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HP_INR.channel} channels with LinkedIn and X included`)}, at one flat price rather than per brand.`;

export const metadata: Metadata = withSocial({
  title: offer("Metricool Alternative: Free Plan Includes X | Hookpost", "Metricool Alternative: LinkedIn & X Included | Hookpost"),
  description: `Compare Hookpost vs Metricool: Metricool prices by brand and sells X as an add-on. Hookpost publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks at one flat price, with an MCP server and ${offer('a free plan that includes LinkedIn and X', 'LinkedIn and X on every plan')}. The open-source question answered honestly.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/alternatives/metricool",
  },
});

export default function MetricoolAlternativePage() {
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
        name: "Metricool Alternative",
        item: "https://hookpost.hookstep.in/alternatives/metricool",
      },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "What is the Best Alternative to Metricool in 2026?",
        acceptedAnswer: {
          "@type": "Answer",
          text: BEST_METRICOOL_ANSWER,
        },
      },
      {
        "@type": "Question",
        name: "Is there an open-source Metricool alternative?",
        acceptedAnswer: {
          "@type": "Answer",
          text: OPEN_SOURCE_ANSWER,
        },
      },
      {
        "@type": "Question",
        name: "Can I self-host Hookpost instead of Metricool?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "No. Hookpost is a hosted service with no self-hosted edition and its source is not public, so if self-hosting is the requirement, Hookpost is not the tool. What it replaces is the hosted-SaaS part of the decision: it publishes to the networks Metricool's free plan leaves out, prices flat rather than by brand, and bills in rupees.",
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
        Hookpost vs Metricool: plans, prices and networks compared
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
            <li className="text-hp-primary-text font-semibold">Metricool Alternative</li>
          </ol>
        </nav>

        <div className="text-center space-y-4">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            2026 comparison
          </div>
          <h1 className="text-[36px] sm:text-[60px] font-black tracking-tight text-hp-text leading-[1.15]">
            Looking for the Best <span className="text-hp-primary-text">Metricool Alternative</span>?
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl max-w-[760px] mx-auto leading-relaxed">
            Metricool's free plan leaves out LinkedIn and X, and its paid plans are in euros or US dollars. Here is how Hookpost compares, figure by figure.
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
            What is the Best Alternative to Metricool in 2026?
          </h2>
          <p className="text-hp-text-2 text-base sm:text-lg leading-relaxed">
            {BEST_METRICOOL_ANSWER}
          </p>
        </section>

        {/* Head-to-Head Table */}
        <section className="space-y-6">
          <h2 className="text-2xl sm:text-3xl font-bold text-hp-text text-center">
            Hookpost vs Metricool: Feature Comparison
          </h2>
          <div className="overflow-x-auto border border-hp-border rounded-2xl bg-hp-surface">
            <table className="w-full text-left text-sm sm:text-base border-collapse">
              <thead>
                <tr className="border-b border-hp-border bg-hp-elevated">
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Capability</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-primary-text bg-hp-primary/5">Hookpost</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text-3">Metricool</th>
                  <th className="p-4 sm:p-5 font-bold text-hp-text">Advantage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hp-border">
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">AI Agent & MCP Integration</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ MCP server and a CLI (npx hookpost); API on the Hookpost plan</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">✅ Metricool MCP listed from the free plan; API from Advanced</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 text-hp-text">
                        Tie
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Supported Networks</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">{PUBLISHABLE_CHANNEL_COUNT}, including X, LinkedIn, YouTube, Facebook Pages, Pinterest, TikTok, Bluesky, Discord, Telegram, WordPress and Dev.to</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">Instagram, Facebook, Threads, TikTok, YouTube, Twitch, Pinterest, Bluesky, Google Business Profile and a web/blog; LinkedIn from Starter; X (Twitter) is a paid add-on on every plan</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 text-hp-text">
                        Depends
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Regional Currency Pricing</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ Razorpay (UPI, NetBanking, Cards)</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">❌ EUR and USD prices only; no INR</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/20">
                        Hookpost
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Free Plan</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">{offer(`${FREE.channel} channels, ${FREE.posts_per_month} posts/month, LinkedIn & X included; no AI`, TRIAL_ROW)}</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">1 brand, 20 posts/month, no LinkedIn or X; AI assistant included</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 text-hp-text">
                        {offer('Depends', 'Metricool')}
                      </span>
                    </td>
                  </tr>
                  <tr className="hover:bg-white/[0.02] transition-colors">
                    <td className="p-4 sm:p-5 font-medium text-hp-text">Pricing</td>
                    <td className="p-4 sm:p-5 text-hp-text bg-hp-primary/5 font-semibold">✅ {offer('Free / ', '')}{planPrice('HOOKPOST', '/mo')}, {HP_INR.channel} channels; {planPrice('HOOKPOST', '/mo')}, {HP_INR.channel} channels</td>
                    <td className="p-4 sm:p-5 text-hp-text-3">$20/mo Starter billed annually ($25 monthly), up to 5 brands</td>
                    <td className="p-4 sm:p-5">
                      <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-white/10 text-hp-text">
                        Depends
                      </span>
                    </td>
                  </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* "metricool open source alternative" and "metricool alternative" are
            two different intents landing on one page, so the open-source one
            gets its own section rather than a line in the FAQ. It says plainly
            that Hookpost is hosted and closed-source and names the self-hosted
            option, because a visitor who wants to self-host is better served by
            a straight answer than by a sidestep. */}
        <section id="open-source" className="space-y-4 rounded-2xl border border-hp-border bg-hp-surface p-6 sm:p-8">
          <h2 className="text-2xl font-bold text-hp-text sm:text-3xl">
            Is there an open-source Metricool alternative?
          </h2>
          <p className="text-base leading-relaxed text-hp-text-2 sm:text-lg">{OPEN_SOURCE_ANSWER}</p>
          <div className="grid gap-4 pt-2 sm:grid-cols-2">
            <div className="rounded-xl border border-hp-border p-5">
              <h3 className="font-bold text-hp-text">If you want to self-host</h3>
              <p className="mt-2 text-sm leading-relaxed text-hp-text/70">
                You own the server, the database, the background workers and a developer app registered with each network -
                some of which review an app before it may post for anyone but you. What that trade actually costs, with the
                licences and repository activity:{' '}
                <Link href="/open-source-social-media-scheduler" className="text-hp-primary-text underline">
                  open-source vs hosted schedulers
                </Link>.
              </p>
            </div>
            <div className="rounded-xl border border-hp-border p-5">
              <h3 className="font-bold text-hp-text">If you wanted the price, not the source</h3>
              <p className="mt-2 text-sm leading-relaxed text-hp-text/70">
                Metricool charges by brand and bills in euros or dollars. Hookpost is one flat price per plan, in rupees with
                UPI Autopay, and both LinkedIn and X are included rather than sold as an add-on.{' '}
                <Link href="/pricing" className="text-hp-primary-text underline">Every plan limit</Link>.
              </p>
            </div>
          </div>
        </section>

        <IndiaCostNote slug="metricool" />

        <SwitchFrom slug="metricool" />

        <section className="space-y-3">
          <h2 className="text-2xl font-bold text-hp-text">Keep comparing</h2>
          <p className="text-base leading-relaxed text-hp-text/70">
            <Link href="/planable-vs-buffer-vs-hootsuite" className="text-hp-primary-text underline">
              Planable vs Buffer vs Hootsuite
            </Link>{' '}
            sets three different pricing units side by side (per workspace, per channel, per user) and says what each one&apos;s
            MCP connector does.{' '}
            <Link href="/social-media-scheduler" className="text-hp-primary-text underline">What a social media scheduler does</Link>{' '}
            starts from the category rather than a vendor, and{' '}
            <Link href="/alternatives" className="text-hp-primary-text underline">alternatives</Link> has the rest of the shortlist.
          </p>
        </section>


        <SectionFaq items={faqSchema.mainEntity} />

        {/* E-E-A-T Benchmark Section */}
        <section className="p-6 sm:p-8 rounded-2xl bg-white/[0.02] border border-hp-border space-y-2">
          <div className="flex items-center gap-2 text-xs text-green-400 font-semibold">
            <span className="w-2 h-2 rounded-full bg-green-400"></span>
            <span>FACTS CHECKED &bull; {METRICOOL_CHECKED.toUpperCase()}</span>
          </div>
          <p className="text-xs sm:text-sm text-hp-text/60 leading-relaxed">
            Metricool&apos;s prices, plans and networks were read from{' '}
            <a href="https://metricool.com/pricing/" rel="nofollow noopener" target="_blank" className="underline">metricool.com/pricing</a>{' '}
            on {METRICOOL_CHECKED}, and exclude VAT. Hookpost&apos;s figures are read from its own live pricing configuration at
            build time, so this page cannot drift from what checkout charges.
          </p>
        </section>

        {/* CTA */}
        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Try Hookpost next to Metricool
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
