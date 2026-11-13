import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../../channels/channel-count';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for Musicians & DJs | Hookpost',
  description:
    'Promote releases, tour dates, and behind-the-scenes clips across YouTube, X, Discord, Telegram and Bluesky. For artists, bands, DJs, and labels.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/music-artists',
  },
});

export default function MusicArtistsLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Music Artists & Bands", item: "https://hookpost.hookstep.in/for/music-artists" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "How can musicians coordinate song and album releases?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Hookpost lets artists schedule teaser clips, Spotify drop countdowns, and tour date flyers simultaneously across ${PUBLISHABLE_CHANNEL_COUNT} networks, including Instagram Reels, Meta Threads, TikTok, YouTube Shorts, X, Discord and Telegram.`,
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
    { title: '🎵 Release Day Campaign Countdown', desc: 'Schedule your pre-save announcements, teaser snippets, music video drops, and listening party reminders months in advance.' },
    { title: '🎥 Short-Form Music Video Distribution', desc: 'Push performance clips to Instagram Reels, YouTube Shorts, X and Bluesky together.' },
    { title: '🎧 Tour & Live Show Announcements', desc: 'Broadcast ticket links, venue dates, and VIP pass releases to your entire fanbase across X, Discord and Telegram channels.' },
    { title: '🤖 AI Lyric & Story Prompts', desc: 'Generate hooks, story snippets and behind-the-scenes captions with the AI assistant (Hookpost plan).' },
    { title: '👥 Band & Manager Collaboration', desc: 'Collaborate with your manager, PR team, and bandmates in a shared workspace without sharing master passwords (Hookpost plan, up to 15 team members).' },
    { title: '🔁 Repeating Release Reminders', desc: 'Set a pre-save or ticket reminder to repeat on a daily or weekly interval in the run-up to release day.' },
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
        🎧 Hookpost for Musicians & Artists — Promote Your Releases, Build a Diehard Fanbase
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
            {offer('Launch Free Artist Plan', TRIAL_CTA)}
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
            <li className="text-hp-primary-text font-semibold">Music Artists & Bands</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Singers • Bands • Electronic DJs • Music Producers
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Drop Teasers on Shorts, YouTube & X <br />
          <span className="text-hp-primary-text">While You Make Music.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Focus on your craft in the studio. Hookpost takes care of scheduling release teasers, playlist promos, and fan engagement across {PUBLISHABLE_CHANNEL_COUNT} networks.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free (No Credit Card) →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Compare Hookpost vs Buffer
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

      <SectionFaq items={faqSchema.mainEntity} />



    </div>
  );
}
