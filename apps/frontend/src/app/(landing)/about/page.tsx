import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import { offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';
import { usdCopy } from '../usd-offer';

export const metadata: Metadata = withSocial({
  title: "About Hookpost — Our Mission",
  description:
    `Learn about Hookpost, a social media management and scheduling platform built by Hookstep, with flat pricing, ${usdCopy('UPI billing', 'billing in dollars or rupees')} and an MCP server for AI agents.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/about",
  },
});

export default function AboutPage() {
  // Reference the sitewide Organization (declared with @id in the landing
  // layout) instead of re-declaring it — two Organization entities with
  // different sameAs handles make the entity ambiguous to search/AI engines.
  const orgSchema = {
    "@context": "https://schema.org",
    "@type": "AboutPage",
    url: "https://hookpost.hookstep.in/about",
    mainEntity: { "@id": "https://hookpost.hookstep.in/#organization" },
  };

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "About", item: "https://hookpost.hookstep.in/about" },
    ],
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(orgSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        Hookpost — Built for Creators, Developers &amp; Agencies
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

      <div className="max-w-[900px] mx-auto px-6 pt-12 pb-24 space-y-16">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">About</li>
          </ol>
        </nav>

        <div className="space-y-6">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            Our Mission &amp; Philosophy
          </div>
          <h1 className="text-[36px] sm:text-[54px] font-black tracking-tight text-hp-text leading-tight">
            We Believe Social Scheduling <span className="text-hp-primary-text">Should Be Fairly Priced</span>
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl leading-relaxed">
            Hookpost was born out of frustration with expensive SaaS monopolies that charge $6 per social profile and force yearly corporate contracts.
          </p>
          {/* Visible, not only in JSON-LD and llms.txt: answer engines weigh
              page text, and "HookPost" also names a Shopify app. */}
          <p className="text-sm text-hp-text/60">
            Hookpost (hookpost.hookstep.in) is unrelated to the HookPost app for Shopify and to Hookle.
          </p>
        </div>

        {/* Core Values */}
        <section className="grid sm:grid-cols-2 gap-6">
          <div className="bg-hp-surface border border-hp-border p-7 rounded-2xl space-y-3">
            <h2 className="text-xl font-bold text-hp-text flex items-center gap-2">
              <span className="text-hp-primary-text">01.</span> Control of Your Accounts
            </h2>
            <p className="text-sm text-hp-text/70 leading-relaxed">
              Your social account tokens stay on the Hookpost server and the MCP tools return channel names and IDs, never credentials. Access is scoped to one workspace's API key.
            </p>
          </div>

          <div className="bg-hp-surface border border-hp-border p-7 rounded-2xl space-y-3">
            <h2 className="text-xl font-bold text-hp-text flex items-center gap-2">
              <span className="text-hp-primary-text">02.</span> AI Agent Native (MCP)
            </h2>
            <p className="text-sm text-hp-text/70 leading-relaxed">
              Hookpost ships a Model Context Protocol (MCP) server, so Claude Desktop, Claude Code, Cursor and other AI agents can list your channels and schedule posts for you. Many schedulers offer one now; ours comes with flat pricing {usdCopy('in rupees', 'in dollars or rupees')}.
            </p>
          </div>

          <div className="bg-hp-surface border border-hp-border p-7 rounded-2xl space-y-3">
            <h2 className="text-xl font-bold text-hp-text flex items-center gap-2">
              <span className="text-hp-primary-text">03.</span> Global &amp; Regional Inclusivity
            </h2>
            <p className="text-sm text-hp-text/70 leading-relaxed">
              {usdCopy(
                'Many schedulers bill in US dollars on an international card. In India, Hookpost bills in rupees through Razorpay: UPI Autopay, RuPay, NetBanking and Indian cards.',
                'Outside India, Hookpost bills in US dollars by card. In India it bills in rupees through Razorpay, with instant UPI (Google Pay, PhonePe, Paytm), RuPay, NetBanking and Indian cards, so no international card is needed.'
              )}
            </p>
          </div>

          <div className="bg-hp-surface border border-hp-border p-7 rounded-2xl space-y-3">
            <h2 className="text-xl font-bold text-hp-text flex items-center gap-2">
              <span className="text-hp-primary-text">04.</span> {offer('Zero Artificial Paywalls', 'Small-Team Pricing')}
            </h2>
            <p className="text-sm text-hp-text/70 leading-relaxed">
              {offer(
                <>Small teams and students should not need a big budget to schedule posts. The free plan has no time limit and needs no card, and paid plans scale from {pricingINR.HOOKPOST.channel} channels up to {pricingINR.HOOKPOST.channel}.</>,
                <>Small teams and students should not need a big budget to schedule posts. Plans are flat, not per channel, and scale from {pricingINR.HOOKPOST.channel} channels up to {pricingINR.HOOKPOST.channel}. {TRIAL_SENTENCE}</>
              )}
            </p>
          </div>
        </section>

        {/* Leadership.
            One operator, "Hookstep", everywhere (owner decision, 11 Oct 2026),
            and one founder, Mohan Bhanushali, which is what our Organization
            schema says. Sakshi's title is her Hookstep role, stated as such
            rather than reframed as a Hookpost title she does not hold. Only
            first names are published on hookstep.in; Mohan's surname is used
            because it already appears in that schema. */}
        <section className="bg-white/[0.02] border border-hp-border rounded-3xl p-8 sm:p-10 space-y-8">
          <div>
            <h2 className="text-2xl font-bold text-hp-text">The people behind Hookpost</h2>
            <p className="mt-3 text-base text-hp-text/70 leading-relaxed">
              Hookpost is built and operated by <strong className="text-hp-text">Hookstep</strong> (based in Ghatkopar, Mumbai, India). The same core team runs both operations and engineering.
            </p>
            <p className="mt-3 text-base text-hp-text/70 leading-relaxed">
              Other products by the same team:{' '}
              <a href="https://tablamigo.hookstep.in" className="text-hp-text underline underline-offset-2 hover:text-hp-primary-text">Tablamigo</a>, an app to meet solo travelers nearby, and{' '}
              <a href="https://hookstep.in" className="text-hp-text underline underline-offset-2 hover:text-hp-primary-text">Hookstep</a>, for hiring vetted tech talent.
            </p>
          </div>

          <div className="grid max-w-[640px] gap-6 sm:grid-cols-2">
            {[
              {
                slug: 'mohan',
                name: 'Mohan Bhanushali',
                role: 'Founder, Hookpost',
                bio: 'Operations lead \u2014 process, partnerships and delivery. Founder of Hookpost.',
              },
              {
                slug: 'sakshi',
                name: 'Sakshi',
                role: 'Head of Sales, Hookstep',
                bio: 'Builds client relationships and helps companies hire exceptional tech talent, fast.',
              },
            ].map((person) => (
              <div
                key={person.slug}
                className="flex flex-col items-center rounded-2xl border border-hp-border bg-white/[0.02] p-6 text-center"
              >
                <img
                  src={`/team/${person.slug}.jpg`}
                  alt={person.name}
                  width={96}
                  height={96}
                  loading="lazy"
                  className="h-24 w-24 rounded-full object-cover ring-2 ring-hp-primary/40"
                />
                <h3 className="mt-4 font-bold text-hp-text">{person.name}</h3>
                <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-hp-primary-text">
                  {person.role}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-hp-text/60">
                  {person.bio}
                </p>
              </div>
            ))}
          </div>

          <p className="text-base text-hp-text/70 leading-relaxed">
            Most of the engineering work is unglamorous: staying inside each
            platform&apos;s API rate limits, and making scheduled publishing
            survive a worker restart by running every post as a Temporal
            workflow.
          </p>
          <div className="flex flex-wrap gap-4 pt-2">
            <Link
              href="/guides/claude-mcp-social-media"
              className="inline-flex items-center gap-2 bg-hp-primary/10 hover:bg-hp-primary/20 text-hp-primary-text font-medium text-sm px-5 py-2.5 rounded-full border border-hp-primary/30 transition-colors"
            >
              Claude MCP Guide &rarr;
            </Link>
          </div>
        </section>

        {/* CTA */}
        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Start scheduling with Hookpost
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base">
            {offer('The free plan has no time limit and needs no card.', TRIAL_SENTENCE)}
          </p>
          <Link
            href="/auth"
            className="inline-block bg-hp-primary text-hp-on-primary hover:bg-white hover:text-black font-bold text-base px-10 py-4 rounded-full transition-all shadow-xl shadow-hp-primary/20"
          >
            {offer('Get Started for Free', TRIAL_CTA)} &rarr;
          </Link>
        </div>
      </div>

    </div>
  );
}
