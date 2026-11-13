import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Automation for Real Estate Agents | Hookpost',
  description:
    'Schedule Just Listed posts, open-house tour videos and property carousels to Instagram, LinkedIn, X and YouTube. Social media scheduling for realtors.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/real-estate',
  },
});

export default function RealEstateLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Real Estate Agents", item: "https://hookpost.hookstep.in/for/real-estate" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can realtors auto-post property video tours and open house flyers?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Realtors can schedule video walkthroughs to YouTube and Instagram Reels, listing photo carousels to Instagram and LinkedIn, and open house dates to X and your Facebook Page.",
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
    { title: '🏡 "Just Listed" & "Open House" Multi-Publishing', desc: 'Promote new listings across Instagram, LinkedIn, X, Bluesky and your Facebook Page simultaneously with property photos and walkthrough videos.' },
    { title: '📸 Multi-Photo Carousel Previews', desc: 'Showcase floorplans, exterior architecture, and interior shots in LinkedIn image carousels.' },
    { title: '🎥 Vertical Video Tours for Reels & Shorts', desc: 'Auto-publish walkthrough video tours to YouTube Shorts and your Facebook Page. Instagram Reels publish at the set time once Meta access is confirmed.' },
    { title: '🤖 AI Real Estate Property Description Writer', desc: 'Turn basic MLS property bullet points into buyer-focused social copy with the AI assistant (Hookpost plan).' },
    { title: '📅 Weekend Open House Blast Schedules', desc: 'Set up recurring reminders on Thursday, Friday, and Saturday mornings to maximize weekend open house turnout.' },
    { title: '👔 Professional LinkedIn Thought Leadership', desc: 'Schedule market updates and neighborhood guides to LinkedIn to position yourself as the local market expert.' },
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
        🏡 Hookpost for Real Estate — Sell Homes Faster with Automated Social Marketing
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
            <li className="text-hp-primary-text font-semibold">Real Estate Agents</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Designed for Realtors, Brokerages & Property Managers
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Promote Every Listing From One Calendar.<br />
          <span className="text-hp-primary-text">
            More Buyer Inquiries, Less Screen Time.
          </span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Spend your time closing deals with clients, not fighting with 4 different social media apps. Hookpost schedules your property posts from listing to sold.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Start Free for Real Estate', TRIAL_CTA)}
          </Link>
          <Link href="/alternatives/later" className="w-full sm:w-auto px-8 py-4 rounded-full border border-hp-border-strong hover:border-white text-hp-text font-medium text-lg">
            Compare with Later
          </Link>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <h2 className="text-3xl font-black text-center mb-12">Built to Showcase High-Value Properties</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((feat, i) => (
            <div key={i} className="p-6 rounded-2xl bg-hp-surface/60 border border-hp-border hover:border-hp-primary/50 transition-all">
              <h3 className="text-xl font-bold mb-3 text-hp-text">{feat.title}</h3>
              <p className="text-hp-text-2 text-sm leading-relaxed">{feat.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <SectionFaq items={faqSchema.mainEntity} />



      <section className="w-full max-w-[900px] mx-auto px-6 py-16 text-center">
        <div className="p-10 rounded-3xl bg-gradient-to-b from-hp-surface to-hp-bg border border-hp-primary/30">
          <h2 className="text-3xl sm:text-4xl font-black mb-4">Turn Listings into Signed Contracts</h2>
          <p className="text-hp-text-2 mb-8 text-lg">Connect a channel and schedule your first listing post in minutes.</p>
          <Link href="/auth" className="inline-block px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Get Started Free', TRIAL_CTA)}
          </Link>
        </div>
      </section>
    </div>
  );
}
