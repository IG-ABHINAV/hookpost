import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../../channels/channel-count';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for B2B SaaS Founders | Hookpost',
  description:
    'Distribute launches, changelogs, and thought leadership across LinkedIn, X, Hashnode, and DEV. Scheduling for B2B SaaS and developer tools.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/b2b-saas',
  },
});

export default function B2BSaaSLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "B2B SaaS Teams", item: "https://hookpost.hookstep.in/for/b2b-saas" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can B2B SaaS teams automate founder LinkedIn and X posts?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Connect founders' LinkedIn and X accounts and schedule them from one calendar. Several people can share the workspace on the Hookpost plan (up to 15 team members, owner included).",
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

  const features = [
    { title: '💼 LinkedIn & X Founder Authority Builder', desc: 'Schedule founder breakdown posts, metric milestones, and industry insights across LinkedIn and X.' },
    { title: '🚀 Changelog & Product Launch Distribution', desc: 'Schedule a launch as an X thread, a LinkedIn post and full Dev.to and Hashnode articles from the same calendar.' },
    { title: '👨‍💻 Developer-First Platforms & Webhooks', desc: 'Auto-publish directly to developer hubs including Dev.to, Hashnode, Discord, and Slack channels.' },
    { title: '🤖 AI Drafting', desc: 'Paste your changelog or release notes into the AI assistant and have it draft posts for each network. AI writing is on the Hookpost plan.' },
    { title: '🔁 Repeating Evergreen Posts', desc: 'Set an evergreen post to repeat on a fixed interval, from daily to monthly, so it keeps going out without rescheduling it by hand.' },
    { title: '🔌 API and MCP for your pipeline', desc: 'Queue posts from CI, a CMS or an AI agent through the public API and the MCP server on the Hookpost plan.' },
  ];

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

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-bold text-sm py-1.5 px-4">
        🚀 Hookpost for B2B SaaS — Drive Demos & Revenue with Automated Thought Leadership & Product Launches
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">
            Hook<span className="text-hp-primary-text">post</span>
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/auth/login" className="text-sm font-medium text-hp-text hover:text-hp-primary-text px-4 py-2 border border-hp-border-strong rounded-full">
            Log In
          </Link>
          <Link href="/auth" className="text-sm font-semibold text-black bg-white hover:bg-hp-primary hover:text-hp-on-primary px-5 py-2 rounded-full">
            {offer('Start Free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-16 text-center">

        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50 mb-8">
          <ol className="flex items-center justify-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li><Link href="/for" className="hover:text-hp-text transition-colors">Solutions</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">B2B SaaS Teams</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          SaaS Founders • DevTools • Growth Marketers • Tech Startups
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Distribute Product Launches & Growth <br />
          <span className="text-hp-primary-text">Across LinkedIn, X & Dev Hubs.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Transform your startup's changelogs, feature drops, and founder insights into continuous organic inbound pipeline across {PUBLISHABLE_CHANNEL_COUNT} networks.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free SaaS Workspace (No CC) →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Compare vs Postiz & Buffer
          </Link>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div key={i} className="p-6 rounded-2xl bg-hp-surface/60 border border-hp-border hover:border-hp-primary/50 transition-all">
              <h3 className="text-xl font-bold text-hp-text mb-2">{f.title}</h3>
              <p className="text-hp-text-2 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="w-full max-w-[1100px] mx-auto px-6 py-10 text-left">
        <h2 className="text-2xl font-bold text-hp-text mb-4">Guides that help</h2>
        <ul className="flex flex-wrap gap-2">
          <li>
            <Link href="/guides/claude-code-social-media" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              Post release notes from Claude Code
            </Link>
          </li>
          <li>
            <Link href="/guides/post-to-multiple-social-media-at-once" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              One update to several networks
            </Link>
          </li>
          <li>
            <Link href="/social-media-scheduling-api" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              Scheduling API
            </Link>
          </li>
        </ul>
      </section>

      <SectionFaq items={faqSchema.mainEntity} />



    </div>
  );
}
