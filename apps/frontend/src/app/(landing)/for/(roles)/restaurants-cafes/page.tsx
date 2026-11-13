import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Scheduler for Restaurants & Cafes | Hookpost',
  description:
    'Schedule daily specials, menu videos and event posts to Instagram, your Facebook Page and more from one calendar. For restaurants, cafes and bars.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/restaurants-cafes',
  },
});

export default function RestaurantsCafesLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Restaurants & Cafes", item: "https://hookpost.hookstep.in/for/restaurants-cafes" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can restaurants schedule daily menu specials and weekend events?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Hookpost allows cafe owners and restaurant managers to schedule daily specials, happy hour reminders, and chef reels days in advance.",
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
    { title: '📍 Daily Specials, Every Day', desc: 'Queue daily menu specials, happy hour times and holiday hours for Instagram, X, Telegram and your Facebook Page.' },
    { title: '🍔 Visual Food & Drink Reels Scheduler', desc: 'Publish kitchen prep videos and cocktail creation clips to Instagram Reels, YouTube Shorts and your Facebook Page.' },
    { title: '⏰ Day-Part & Weekend Specials Automation', desc: 'Schedule lunch specials at 11:00 AM and weekend brunch promotions on Thursday evening on recurring automated slots.' },
    { title: '🤖 AI Menu & Event Description Assistant', desc: 'Generate appetizing captions for new seasonal dishes, wine tastings, and live music nights with the AI assistant (Hookpost plan).' },
    { title: '👥 Multi-Location Channel Groups', desc: 'Group each branch as a customer and filter the calendar by location. Hookpost covers 20 channels and up to 15 team members.' },
    { title: '📧 Menu Emails via Listmonk', desc: 'Send the weekly menu to your Listmonk mailing list from the same calendar as your social posts.' },
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
        🍽️ Hookpost for Restaurants & Cafes — Pack Tables & Boost Walk-in Foot Traffic with Automated Socials
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
            <li className="text-hp-primary-text font-semibold">Restaurants & Cafes</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Restaurants • Coffee Shops • Bakeries • Bars & Breweries
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Schedule Mouth-Watering Specials <br />
          <span className="text-hp-primary-text">Across YouTube, X & Telegram.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          While you run a bustling kitchen and provide exceptional guest hospitality, Hookpost keeps your social feeds full of daily specials and event promotions.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free (Zero Setup Fees) →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Compare Hookpost vs Competitors
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
