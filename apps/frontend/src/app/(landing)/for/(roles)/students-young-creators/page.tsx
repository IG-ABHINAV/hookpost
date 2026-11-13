import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_LIMITS, FREE_PLAN_ANSWER, HOOTSUITE_PER_USER, FREE_PLAN_QUESTION, HOOKPOST_PRICE } from '../plan-copy';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: offer('Free Social Media Scheduler for Students | Hookpost', 'Social Media Scheduler for Students | Hookpost'),
  description:
    offer(
      'Schedule Instagram Reels, YouTube Shorts, X, Discord and Telegram posts. Free plan for students and young creators, no card needed.',
      `Schedule Instagram Reels, YouTube Shorts, X, Discord and Telegram posts. For students and young creators. ${TRIAL_SENTENCE}`
    ),
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/students-young-creators',
  },
});

export default function StudentsYoungCreatorsPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Students & Young Creators", item: "https://hookpost.hookstep.in/for/students-young-creators" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: offer("Can students build a personal brand for free with Hookpost?", "What does Hookpost cost for students?"),
        acceptedAnswer: {
          "@type": "Answer",
          text: offer("Yes. The free plan covers 2 channels and 30 posts a month with no credit card, enough to keep LinkedIn and X active while you build a portfolio. AI writing is on the paid plans.", `Hookpost is ${HOOKPOST_PRICE} for ${pricingINR.HOOKPOST.channel} channels with AI writing, enough to keep LinkedIn and X active while you build a portfolio. ${TRIAL_SENTENCE}`),
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
        {offer('A Free Plan for Students & Emerging Creators Worldwide', 'Flat Pricing for Students & Emerging Creators Worldwide')} 🎓🚀
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" className="flex items-center gap-2">
          <span className="text-2xl font-black tracking-tight text-hp-text">
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
            className="text-sm font-bold bg-hp-primary text-hp-on-primary px-5 py-2 rounded-full hover:bg-white transition-all shadow-[0_0_20px_rgb(var(--hp-primary-rgb)/0.5)]"
          >
            {offer('Get Free Access', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 sm:px-12 pt-16 pb-24">
        <div className="text-center max-w-3xl mx-auto mb-16">
          <span className="inline-block px-4 py-1.5 rounded-full bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-bold uppercase tracking-widest mb-6">
            For Students, Gamers & Young Creators
          </span>
          <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] mb-6">
            Build Your Audience While You Sleep or Study. <span className="text-hp-primary-text">{offer('Free to Start.', `Get ${FREE_POSTS}.`)}</span>
          </h1>
          <p className="text-lg sm:text-xl text-hp-text-2 leading-relaxed mb-8">
            Never stress about posting times between classes. Auto-post your short-form videos and clips to Instagram Reels, Threads, YouTube Shorts, X, Discord, Telegram and Bluesky from a single dashboard.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="/auth"
              className="bg-hp-primary text-hp-on-primary font-bold px-8 py-4 rounded-xl text-lg hover:bg-white transition-all shadow-[0_0_30px_rgb(var(--hp-primary-rgb)/0.4)]"
            >
              {offer('Start Free Today (No Card Required)', TRIAL_CTA)}
            </Link>
            <Link
              href="/alternatives/postiz"
              className="bg-hp-surface border border-hp-border-strong text-white font-medium px-8 py-4 rounded-xl text-lg hover:border-hp-border-strong transition-all"
            >
              Compare Features
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-20">
          <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
            <div className="text-3xl mb-4">⚡</div>
            <h2 className="text-xl font-bold mb-2">Cross-Post Short Form Video</h2>
            <p className="text-hp-text-2 text-sm leading-relaxed">
              Upload your video once and schedule it to Instagram Reels, YouTube Shorts, X, Bluesky and your Facebook Page together.
            </p>
          </div>
          <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
            <div className="text-3xl mb-4">🤖</div>
            <h2 className="text-xl font-bold mb-2">AI Caption & Hook Ideas</h2>
            <p className="text-hp-text-2 text-sm leading-relaxed">
              Stuck on titles? The AI assistant drafts hooks, captions and hashtags. It is on the Hookpost plan{offer(', not the free plan', '')}.
            </p>
          </div>
          <div className="bg-hp-bg border border-hp-border p-8 rounded-2xl">
            <div className="text-3xl mb-4">💰</div>
            <h2 className="text-xl font-bold mb-2">{offer('A Free Plan That Does Not Expire', 'One Flat Price, Not Per Seat')}</h2>
            <p className="text-hp-text-2 text-sm leading-relaxed">
              {offer(
                <>Buffer&apos;s free plan covers 3 channels and 10 scheduled posts per channel; Hootsuite has no free plan and starts at {HOOTSUITE_PER_USER}. Hookpost&apos;s free plan gives you {FREE_LIMITS}, no card required. AI writing and the API are on paid plans.</>,
                <>Hootsuite starts at {HOOTSUITE_PER_USER}. Hookpost is {HOOKPOST_PRICE} for {pricingINR.HOOKPOST.channel} channels, AI writing and the API included. {TRIAL_SENTENCE}</>
              )}
            </p>
          </div>
        </div>
        <section className="w-full max-w-[1100px] mx-auto px-6 py-10 text-left">
          <h2 className="text-2xl font-bold text-hp-text mb-4">Guides that help</h2>
          <ul className="flex flex-wrap gap-2">
            <li>
              <Link href="/guides/social-media-post-schedule-kaise-kare" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
                Social media post schedule kaise kare (Hinglish)
              </Link>
            </li>
            <li>
              <Link href="/guides/post-to-multiple-social-media-at-once" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
                Post to several networks at once
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

      </div>
    </div>
  );
}
