import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Automation for E-Commerce Brands | Hookpost',
  description:
    'Schedule product launches to Instagram, YouTube, X, your Facebook Page, Telegram, Discord and your Listmonk email list from one calendar.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/ecommerce',
  },
});

export default function EcommerceLandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "E-Commerce Brands", item: "https://hookpost.hookstep.in/for/ecommerce" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Does Hookpost support product carousels and Pinterest pins?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. LinkedIn image carousels, X image posts, Facebook Page photo posts, Pinterest Pins and YouTube videos publish today. Instagram carousels (up to 10 items) publish at the set time once Meta access is confirmed, and need a Business or Creator account.",
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
    { title: '🛍️ Flash Sale & Drop Countdown Scheduling', desc: 'Pre-schedule multi-day flash sale announcement sequences across Instagram, X, your Facebook Page, Telegram and Discord.' },
    { title: '🎬 YouTube Product Demos', desc: 'Schedule product demos and unboxing videos to YouTube, including Shorts, from the same calendar as your social posts.' },
    { title: '📧 Drop Emails via Listmonk', desc: 'Send the same drop announcement to your Listmonk mailing list from the calendar that schedules your social posts.' },
    { title: '🤖 AI High-Converting Product Copywriter', desc: 'Turn product feature lists into benefit-driven copy, discount announcements and hashtags with the AI assistant (Hookpost plan).' },
    { title: '🔌 Bulk Scheduling via API', desc: 'Queue a whole season of sale posts from your own script or an n8n workflow through the public REST API (Hookpost plan).' },
    { title: '🔁 Repeating Promo Posts', desc: 'Set an always-on offer to repeat on a fixed interval, from daily to monthly, without rescheduling it by hand.' },
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
        🛍️ Hookpost for E-Commerce — Convert Social Followers into Store Revenue
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
            <li className="text-hp-primary-text font-semibold">E-Commerce Brands</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Built For Shopify, DTC Brands & Amazon Sellers
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          Automate Your Product Drops.<br />
          <span className="text-hp-primary-text">
            Scale Traffic, Sales & Social Proof.
          </span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Stop manually posting product links. Hookpost schedules your YouTube demos, X, Facebook Page and Telegram announcements and flash sale emails from one calendar. Instagram and Pinterest follow once those platforms approve the app.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Start Free for E-Commerce', TRIAL_CTA)}
          </Link>
          <Link href="/alternatives/publer" className="w-full sm:w-auto px-8 py-4 rounded-full border border-hp-border-strong hover:border-white text-hp-text font-medium text-lg">
            Compare with Publer
          </Link>
        </div>
      </section>

      <section className="w-full max-w-[1200px] mx-auto px-6 py-12">
        <h2 className="text-3xl font-black text-center mb-12">Everything You Need to Scale DTC Sales</h2>
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
          <h2 className="text-3xl sm:text-4xl font-black mb-4">Turn Social Engagement into Store Orders</h2>
          <p className="text-hp-text-2 mb-8 text-lg">Set up your multi-channel e-commerce calendar in under 5 minutes.</p>
          <Link href="/auth" className="inline-block px-8 py-4 rounded-full bg-hp-primary text-hp-on-primary font-bold text-lg hover:scale-105 transition-all">
            {offer('Get Started Free', TRIAL_CTA)}
          </Link>
        </div>
      </section>
    </div>
  );
}
