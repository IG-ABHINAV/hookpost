import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../../channels/channel-count';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION, HOOKPOST_PRICE } from '../plan-copy';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../../trial-offer';
import { usdCopy } from '../../../usd-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for Non-Profits | Hookpost',
  description:
    offer(
      'Affordable and free social media management for educators, universities, charities, NGOs, and non-profit organizations worldwide.',
      'Affordable social media management for educators, universities, charities, NGOs, and non-profit organizations worldwide.'
    ),
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/educators-nonprofits',
  },
});

export default function EducatorsNonprofitsPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Educators & Nonprofits", item: "https://hookpost.hookstep.in/for/educators-nonprofits" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: offer("Is Hookpost free for educational projects and charities?", "What does Hookpost cost for educational projects and charities?"),
        acceptedAnswer: {
          "@type": "Answer",
          text: offer("Yes. The free plan does not expire: 2 channels and 30 posts a month at zero cost, no credit card.", `Hookpost is ${HOOKPOST_PRICE}, one flat price with no per-channel fee. ${TRIAL_SENTENCE}`),
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
        Empowering Educators, Charities & Non-Profits Around the Globe 🌍🤝
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
          For Non-Profits, NGOs & Educators
        </span>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight leading-[1.1] mb-6 max-w-4xl mx-auto">
          Amplify Your Mission Without Draining Your Budget. <span className="text-hp-primary-text">{offer('Start free.', `Get ${FREE_POSTS}.`)}</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 leading-relaxed mb-8 max-w-2xl mx-auto">
          Share your cause across {PUBLISHABLE_CHANNEL_COUNT} social channels, coordinate community volunteers, and keep donors updated without paying extortionate enterprise software subscriptions.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center mb-16">
          <Link href="/auth" className="bg-hp-primary text-hp-on-primary font-bold px-8 py-4 rounded-xl text-lg hover:bg-white transition-all shadow-[0_0_30px_rgb(var(--hp-primary-rgb)/0.4)]">
            {offer('Start Free for Non-Profits', TRIAL_CTA)}
          </Link>
        </div>
        {/* Persona-specific detail. This page previously stopped after the hero
            and FAQ - about 120 words against 290-460 on its sibling /for/ pages -
            which reads as an unfinished template rather than a page worth
            ranking. Every claim below is checked against pricing.ts. */}
        <section className="w-full max-w-[1200px] mx-auto px-6 py-12 text-left">
          <h2 className="text-3xl font-black text-center mb-12">Made to work on a small budget</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
            offer(
              { title: 'A free tier that does not expire', desc: '2 channels and 30 posts a month, no credit card, no trial clock. Enough for a department or a small charity to run its whole calendar.' },
              { title: `Try ${FREE_POSTS} first`, desc: `Run your real calendar before you pay. ${TRIAL_SENTENCE}` }
            ),
            { title: 'No per-channel fee', desc: offer('Flat plans: one price per plan, not a fee for every connected channel, and a free plan that does not expire.', 'Flat plans: one price per plan, not a fee for every connected channel.') },
            { title: 'Reach students where they already are', desc: 'Discord, Telegram, Lemmy and Bluesky alongside X and YouTube — the places a campus audience actually reads.' },
            { title: 'Publish to a blog in the same breath', desc: 'WordPress, Hashnode and DEV are channels here, so a long-form update and its social posts go out together.' },
            usdCopy(
              { title: 'Pay in rupees', desc: 'Billing runs through Razorpay with UPI and NetBanking, so there is no foreign-card requirement or forex markup.' },
              { title: 'Pay in dollars or rupees', desc: 'Billed in US dollars by card, or in India in rupees through Razorpay with UPI and NetBanking, so there is no foreign-card requirement or forex markup there.' }
            ),
            { title: 'Hand over without retraining', desc: 'A visual calendar that a volunteer or a student worker can pick up, and up to 15 team members on the Hookpost plan.' },
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
