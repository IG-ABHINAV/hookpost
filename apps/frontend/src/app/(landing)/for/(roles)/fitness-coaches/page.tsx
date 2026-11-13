import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_LIMITS, FREE_PLAN_ANSWER, HOOKPOST_PRICE, FREE_PLAN_QUESTION } from '../plan-copy';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Scheduler for Fitness Coaches | Hookpost',
  description:
    'Schedule Instagram Reels, YouTube Shorts, X, LinkedIn and Facebook Page posts from one calendar. For personal trainers, gym owners and wellness creators.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/fitness-coaches',
  },
});

export default function FitnessCoachesLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Fitness Coaches & Gyms", item: "https://hookpost.hookstep.in/for/fitness-coaches" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can fitness trainers schedule recurring workout tips and transformation videos?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Coaches can schedule weeks of workout videos and nutrition tips in one sitting and set a post to repeat on an interval from daily to monthly. YouTube and Facebook Pages publish today, and Instagram Reels publish at the set time once Meta access is confirmed.",
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
    { title: '🎬 Multi-Platform Video Auto-Publish', desc: 'Shoot one workout demo or transformation video and schedule it to Instagram Reels, YouTube Shorts, X, LinkedIn and your Facebook Page in 1 click. Instagram Reels publish at the set time once Meta access is confirmed.' },
    { title: '📅 Visual Content & Challenge Calendar', desc: 'Map out 30-day fitness challenges, client shoutouts, and nutrition tips weeks in advance so you can focus on training clients.' },
    { title: '🤖 AI Workout & Caption Writer', desc: 'Generate captions, workout breakdowns, rep-set guides and calls-to-action to book coaching calls with the AI assistant (Hookpost plan).' },
    { title: '📨 Telegram & Discord Community Posts', desc: 'Send daily workout tips to your Telegram channel or Discord server on the same schedule as your social posts.' },
    { title: '⏰ Your Own Posting Slots', desc: 'Set the times you want to post on each channel once, and new posts can drop into the next free slot.' },
    offer(
      { title: '💵 Free Plan, Flat Pricing', desc: `Start free with ${FREE_LIMITS}. Hookpost is ${HOOKPOST_PRICE} for ${pricingINR.HOOKPOST.channel} channels and AI captions.` },
      { title: `💵 Flat Pricing, ${FREE_POSTS}`, desc: `Hookpost is ${HOOKPOST_PRICE} for ${pricingINR.HOOKPOST.channel} channels and AI captions. ${TRIAL_SENTENCE}` }
    ),
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
        💪 Hookpost for Fitness Coaches — Turn Social Followers into High-Ticket Coaching Clients
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
            <li className="text-hp-primary-text font-semibold">Fitness Coaches & Gyms</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Personal Trainers • Online Coaches • Gym Studios
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Publish Workouts to Shorts, X & LinkedIn <br />
          <span className="text-hp-primary-text">On Complete Autopilot.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Stop spending 3 hours a day reposting videos across apps. Hookpost publishes your YouTube Shorts, X, LinkedIn and Facebook Page posts together, with captions tuned per network, and your Instagram Reels once Meta access is confirmed.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free (No Credit Card Required) →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Why Coaches Switch from Buffer
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
