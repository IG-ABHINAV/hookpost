import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../../channels/channel-count';
import { withSocial } from '../../../social-meta';
import { FREE_LIMITS, FREE_PLAN_ANSWER, HOOKPOST_PRICE, HOOKPOST_PRICE_IN_PARENS, FREE_PLAN_QUESTION } from '../plan-copy';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Scheduler for Creators & Influencers | Hookpost',
  description:
    offer(
      'Schedule Instagram Reels, YouTube Shorts, X threads and LinkedIn carousels from one calendar. Free plan for creators and influencers, no card needed.',
      `Schedule Instagram Reels, YouTube Shorts, X threads and LinkedIn carousels from one calendar, for creators and influencers. ${TRIAL_SENTENCE}`
    ),
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/creators',
  },
});

export default function CreatorsLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Content Creators", item: "https://hookpost.hookstep.in/for/creators" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Does Hookpost auto-post Shorts and Reels without mobile notifications?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Hookpost uploads YouTube Shorts through the YouTube Data API, so the video goes live at the scheduled time with nothing to tap. Instagram Reels go through the Instagram Graph API and publish at the set time once Meta access is confirmed. Instagram needs a Business or Creator account.",
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
    { title: '🎬 Multi-Platform Video Auto-Publish', desc: 'Upload once and schedule to Instagram Reels, YouTube Shorts, X, LinkedIn and Bluesky together, with no confirmation notification to tap. Instagram Reels publish at the set time once Meta access is confirmed.' },
    { title: '✍️ Built-in AI Hook & Caption Generator', desc: 'Generate caption variations, hook lines and hashtags with the AI assistant, on the Hookpost plan.' },
    { title: '📅 Visual Drag & Drop Calendar', desc: 'Plan an entire month of content in one sitting, with a preview of how each post will look on its network.' },
    offer(
      { title: '💸 Free Plan for Students & Emerging Creators', desc: `${FREE_LIMITS} for free, no credit card. AI writing is on Hookpost at ${HOOKPOST_PRICE}.` },
      { title: `💸 Flat Pricing, ${FREE_POSTS}`, desc: `${TRIAL_SENTENCE} Hookpost (${HOOKPOST_PRICE_IN_PARENS}) includes AI writing.` }
    ),
    { title: '🧵 X Threads & LinkedIn Carousels', desc: 'Draft and schedule X threads and LinkedIn image carousels from the same editor.' },
    { title: '⏰ Your Own Posting Slots', desc: 'Set the times you want to post on each channel once, and new posts can drop into the next free slot.' },
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

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4">
        ⚡ Hookpost for Creators — Post to {PUBLISHABLE_CHANNEL_COUNT} Networks, {offer('Start Free', FREE_POSTS)}
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
            <li className="text-hp-primary-text font-semibold">Content Creators</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Built For Solo Creators, Reelmakers & YouTubers
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Schedule Once. Publish Across Your Channels.<br />
          <span className="text-hp-primary-text">
            Shorts, X, LinkedIn & Bluesky in 1 Click.
          </span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Stop manually posting on 5 different apps every single day. Hookpost lets you batch-schedule 30 days of video, carousels, and threads in 1 hour.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Get Started Free (No Credit Card)', TRIAL_CTA)}
          </Link>
          <Link href="/compare" className="w-full sm:w-auto px-8 py-4 rounded-full border border-hp-border-strong hover:border-white text-hp-text font-medium text-lg">
            See Hookpost vs Buffer
          </Link>
        </div>

        {/* Entity Facts Block for AI Citability & GEO */}
        <div className="max-w-[860px] mx-auto mt-12 p-6 rounded-2xl bg-hp-surface/80 border border-hp-border text-left">
          <p className="text-sm sm:text-base text-hp-text-2 leading-relaxed">
            <strong className="text-hp-text">Hookpost</strong> is a multi-network social media scheduler built by <strong className="text-hp-text">Hookstep</strong> (founded by Mohan Bhanushali). It serves as a flat-rate, modern alternative to Buffer and Hootsuite, letting creators and influencers auto-publish to X, LinkedIn, YouTube Shorts, Bluesky, Telegram, Discord, and Slack without per-channel fees.
          </p>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <h2 className="text-3xl font-black text-center mb-12">Superpowers Built For Creators</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feat, i) => (
            <div key={i} className="p-6 rounded-2xl bg-hp-surface/60 border border-hp-border hover:border-hp-primary/50 transition-all">
              <h3 className="text-xl font-bold mb-3 text-hp-text">{feat.title}</h3>
              <p className="text-hp-text-2 text-sm leading-relaxed">{feat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="w-full max-w-[1100px] mx-auto px-6 py-10 text-left">
        <h2 className="text-2xl font-bold text-hp-text mb-4">Guides that help</h2>
        <ul className="flex flex-wrap gap-2">
          <li>
            <Link href="/guides/post-to-multiple-social-media-at-once" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              Post to several networks at once
            </Link>
          </li>
          <li>
            <Link href="/guides/social-media-post-schedule-kaise-kare" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              Social media post schedule kaise kare (Hinglish)
            </Link>
          </li>
          <li>
            <Link href={offer('/free-social-media-scheduler', '/pricing')} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              {offer('Free plan explained', `Pricing and the ${FREE_POSTS}`)}
            </Link>
          </li>
        </ul>
      </section>

      <SectionFaq items={faqSchema.mainEntity} />



      <section className="w-full max-w-[900px] mx-auto px-6 py-16 text-center">
        <div className="p-10 rounded-3xl bg-gradient-to-b from-hp-surface to-hp-bg border border-hp-primary/30">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">Ready to Grow Your Audience?</h2>
          <p className="text-hp-text-2 mb-8 text-lg">{offer('Connect a channel and schedule your first post in under five minutes - free, no card required.', `Connect a channel and schedule your first post in under five minutes. ${TRIAL_SENTENCE}`)}</p>
          <Link href="/auth" className="inline-block px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Create Free Account', TRIAL_CTA)}
          </Link>
        </div>
      </section>
    </div>
  );
}
