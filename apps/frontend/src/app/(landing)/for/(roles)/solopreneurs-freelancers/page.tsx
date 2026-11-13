import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, HOOKPOST_PRICE, FREE_PLAN_QUESTION } from '../plan-copy';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Scheduler for Solopreneurs | Hookpost',
  description:
    'Grow your personal brand on autopilot. Social media scheduling for consultants, developers, solo founders, and freelance professionals.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/solopreneurs-freelancers',
  },
});

export default function SolopreneursFreelancersPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Solopreneurs & Freelancers", item: "https://hookpost.hookstep.in/for/solopreneurs-freelancers" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How much time does Hookpost save freelancers?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Hookpost puts X, LinkedIn, Threads, Instagram, Bluesky and your blog channels into one calendar, with AI drafting on the Hookpost plan, so a week of posts can be scheduled in one sitting.",
        },
      },
      {
        "@type": "Question",
        name: FREE_PLAN_QUESTION,
        acceptedAnswer: {
          "@type": "Answer",
          text: FREE_PLAN_ANSWER,
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

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4">
        Built for Independent Founders, Consultants & Freelancers Worldwide 💼⚡
      </div>
      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">Hook<span className="text-hp-primary-text">post</span></span>
        </Link>
        <div className="flex items-center gap-2 sm:gap-4">
          <Link href="/auth/login" className="text-sm font-medium text-hp-text hover:text-hp-primary-text transition-colors px-3 sm:px-4 py-2 whitespace-nowrap border border-hp-border-strong rounded-full hover:border-hp-primary">Log In</Link>
          <Link href="/auth" className="text-sm font-bold bg-hp-primary text-hp-on-primary px-5 py-2 rounded-full hover:bg-white transition-all shadow-[0_0_20px_rgb(var(--hp-primary-rgb)/0.5)]">{offer('Start Free', TRIAL_CTA)}</Link>
        </div>
      </header>
      <div className="max-w-[1200px] mx-auto px-6 sm:px-12 pt-16 pb-24 text-center">
        <span className="inline-block px-4 py-1.5 rounded-full bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-bold uppercase tracking-widest mb-6">
          For Solopreneurs & Freelance Professionals
        </span>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] mb-6 max-w-4xl mx-auto">
          Turn Your Expertise Into Inbound Leads. <span className="text-hp-primary-text">Without Working 24/7.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 leading-relaxed mb-8 max-w-2xl mx-auto">
          Batch schedule an entire month of LinkedIn insights, X threads and Bluesky posts in one afternoon. Let Hookpost publish around the clock while you focus on client work.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
          <Link href="/auth" className="bg-hp-primary text-hp-on-primary font-bold px-8 py-4 rounded-xl text-lg hover:bg-white transition-all shadow-[0_0_30px_rgb(var(--hp-primary-rgb)/0.4)]">
            {offer('Create Free Account', TRIAL_CTA)}
          </Link>
        </div>
        {/* Persona-specific detail. This page previously stopped after the hero
            and FAQ - about 120 words against 290-460 on its sibling /for/ pages -
            which reads as an unfinished template rather than a page worth
            ranking. Every claim below is checked against pricing.ts. */}
        <section className="w-full max-w-[1200px] mx-auto px-6 py-12 text-left">
          <h2 className="text-3xl font-black text-center mb-12">For one person doing all of it</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
            { title: 'Batch a month in one sitting', desc: 'Drag posts around a visual calendar, set your posting times once, and let new drafts fall into the next free slot automatically.' },
            { title: 'Let an AI agent do the drafting', desc: 'The MCP server connects Claude Code, Cursor or Windsurf directly, so you can ask for a week of posts and approve rather than write.' },
            { title: 'One draft, adjusted per network', desc: 'Write the thought once, then tune it per channel — a thread on X, a carousel on LinkedIn, a long-form article on Hashnode.' },
            { title: 'Build in public where developers are', desc: 'DEV, Hashnode and WordPress publish from the same calendar as your social channels.' },
            { title: `${HOOKPOST_PRICE}, not per channel`, desc: `${pricingINR.HOOKPOST.channel} channels and ${pricingINR.HOOKPOST.posts_per_month} posts on Hookpost. No per-seat fee and no per-channel fee.` },
            { title: 'Automate the repetitive part', desc: 'A public REST API, an n8n community node and webhooks, so your existing workflows can queue posts without you in the loop.' },
            ].map((feat, i) => (
              <div key={i} className="p-6 rounded-2xl bg-hp-surface/60 border border-hp-border hover:border-hp-primary/50 transition-all">
                <h3 className="text-xl font-bold mb-3 text-hp-text">{feat.title}</h3>
                <p className="text-hp-text-2 text-sm leading-relaxed">{feat.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <SectionFaq items={faqSchema.mainEntity} />

      </div>
    </div>
  );
}
