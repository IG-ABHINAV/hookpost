import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { BUFFER_PER_CHANNEL, FREE_PLAN_ANSWER, HOOTSUITE_PER_USER, HOOKPOST_PRICE, FREE_PLAN_QUESTION } from '../plan-copy';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for Small Businesses | Hookpost',
  description:
    'Schedule posts to Instagram, Facebook Pages, X, LinkedIn, YouTube and more in minutes. Simple social media for shops, clinics and cafes.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/small-business',
  },
});

export default function SmallBusinessLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Small Businesses", item: "https://hookpost.hookstep.in/for/small-business" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Why is Hookpost better than Buffer or Hootsuite for local shops?",
        acceptedAnswer: {
          "@type": "Answer",
          text: `Buffer charges ${BUFFER_PER_CHANNEL} and Hootsuite starts at ${HOOTSUITE_PER_USER}. ${offer(`Hookpost has a free plan for ${pricingINR.FREE.channel} channels, and Hookpost covers`, 'Hookpost covers')} ${pricingINR.HOOKPOST.channel} channels for ${HOOKPOST_PRICE} with no per-channel fee.`,
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
    { title: '📍 Local Offers on Every Channel', desc: 'Publish special offers, opening-hours changes and photos to Instagram, X, LinkedIn, Bluesky and your Facebook Page on a schedule.' },
    { title: '⚡ 1-Click Multi-Posting', desc: 'Publish one post to several channels at once, with per-network tweaks where you need them.' },
    { title: '🤖 AI Copywriter for Busy Owners', desc: 'No marketing degree needed. Type what you sell, and the AI assistant writes captions, offers and hashtags for you (Hookpost plan).' },
    { title: '⏰ Set-and-Forget Weekly Scheduling', desc: 'Dedicate 20 minutes on Monday morning to schedule all your weekly promos, then focus 100% on running your business.' },
    { title: '💳 Affordable Plans with Zero Surprise Fees', desc: offer(`Start free, or move to Hookpost at ${HOOKPOST_PRICE} for ${pricingINR.HOOKPOST.channel} channels and AI captions. No per-channel fee.`, `Hookpost is ${HOOKPOST_PRICE} for ${pricingINR.HOOKPOST.channel} channels and AI captions, after ${FREE_POSTS} with no card. No per-channel fee.`) },
    { title: '📱 Clean, Non-Technical Dashboard', desc: 'No confusing tech jargon, APIs, or complex graphs. Clean, visual calendar anyone on your staff can use.' },
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
        🏪 Hookpost for Small Business — Attract Local Customers Without the Headache
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
            {offer('Try Free', TRIAL_CTA)}
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
            <li className="text-hp-primary-text font-semibold">Small Businesses</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Built For Local Stores, Clinics, Restaurants & Services
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Put Your Social Media on Autopilot.<br />
          <span className="text-hp-primary-text">
            More Local Customers, Zero Hassle.
          </span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          You have a business to run. Let Hookpost automatically publish your promotions, menus, and updates to X, LinkedIn, YouTube and more every week.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Start Free for Your Business', TRIAL_CTA)}
          </Link>
          <Link href="/alternatives/hootsuite" className="w-full sm:w-auto px-8 py-4 rounded-full border border-hp-border-strong hover:border-white text-hp-text font-medium text-lg">
            Compare with Hootsuite
          </Link>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <h2 className="text-3xl font-black text-center mb-12">Everything Your Business Needs to Stay Active</h2>
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
            <Link href="/social-media-calendar-india" className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
              Festival calendar for India
            </Link>
          </li>
        </ul>
      </section>

      <SectionFaq items={faqSchema.mainEntity} />



      <section className="w-full max-w-[900px] mx-auto px-6 py-16 text-center">
        <div className="p-10 rounded-3xl bg-gradient-to-b from-hp-surface to-hp-bg border border-hp-primary/30">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">Start Growing Your Business Today</h2>
          <p className="text-hp-text-2 mb-8 text-lg">Set up in 2 minutes. No technical background required.</p>
          <Link href="/auth" className="inline-block px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Get Started Free', TRIAL_CTA)}
          </Link>
        </div>
      </section>
    </div>
  );
}
