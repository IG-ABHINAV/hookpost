import { SectionFaq } from "../../../SectionFaq";
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { withSocial } from '../../../social-meta';
import { FREE_PLAN_ANSWER, FREE_PLAN_QUESTION } from '../plan-copy';
import { offer, TRIAL_CTA } from '../../../trial-offer';

export const metadata: Metadata = withSocial({
  title: 'Social Media Management for Web3 & Crypto | Hookpost',
  description:
    'Auto-publish to X, Discord, Telegram, Bluesky, Nostr, and Lemmy from one calendar. Built for Web3 builders, crypto protocols, and DAOs.',
  alternates: {
    canonical: 'https://hookpost.hookstep.in/for/crypto-web3',
  },
});

export default function CryptoWeb3LandingPage() {

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Solutions", item: "https://hookpost.hookstep.in/for" },
      { "@type": "ListItem", position: 3, name: "Web3 & Crypto Projects", item: "https://hookpost.hookstep.in/for/crypto-web3" },
    ],
  };

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: "Can Hookpost schedule announcements across X and Telegram?",
        acceptedAnswer: {
          "@type": "Answer",
          text: "Yes. Hookpost allows Web3 teams to simultaneously publish announcements across X, Telegram, Discord, Bluesky, Nostr and LinkedIn from a single dashboard.",
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
    { title: '🪐 Native Web3 & Decentralized Socials', desc: 'Publish simultaneously to Nostr, Bluesky, Lemmy, and X (Twitter) without copying and pasting across tabs.' },
    { title: '📢 Discord & Telegram Announcement Bot', desc: 'Broadcast alpha, roadmap updates, and community news straight into Telegram channels and Discord announcement feeds on a timed schedule.' },
    { title: '⚡ 24/7 Global Timezone Scheduling', desc: 'Your crypto audience never sleeps. Queue 24-hour round-the-clock dispatches targeting Asia, Europe, and US market sessions.' },
    { title: '🛡️ Multi-Admin Access', desc: 'Invite community managers and moderators as team members (Hookpost plan, up to 15 seats) without handing out raw social account logins.' },
    { title: '🤖 AI Token & Community Copilot', desc: 'Paste a whitepaper section or release notes into the AI assistant and have it draft an X thread, a Discord update and a Nostr note (Hookpost plan).' },
    { title: '🔌 API, Webhooks & n8n', desc: 'Queue announcements from your own bots or an n8n workflow through the public REST API, and get webhooks when posts publish (Hookpost plan).' },
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
        ⚡ Hookpost for Web3 — The Unified Social Operating System for Crypto, DAOs & Protocol Teams
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
            {offer('Launch Free Web3 Workspace', TRIAL_CTA)}
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
            <li className="text-hp-primary-text font-semibold">Web3 & Crypto Projects</li>
          </ol>
        </nav>

        <div className="inline-block px-4 py-1.5 rounded-full border border-hp-primary/40 bg-hp-primary/10 text-hp-primary-text text-xs font-bold uppercase tracking-wider mb-6">
          Web3, Decentralized Social & Crypto Marketing
        </div>
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight text-hp-text leading-tight mb-6">
          One Calendar for X, Telegram, Discord, <br />
          <span className="text-hp-primary-text">Nostr, Bluesky & Beyond.</span>
        </h1>
        <p className="text-lg sm:text-xl text-hp-text-2 max-w-[800px] mx-auto mb-10 leading-relaxed">
          Traditional schedulers ignore Web3. Hookpost natively integrates Web2 (X, YouTube, LinkedIn, Discord) and Web3 (Nostr, Bluesky, Lemmy) into one high-speed AI calendar.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link href="/auth" className="w-full sm:w-auto px-8 py-4 bg-hp-primary text-hp-on-primary font-bold rounded-full text-base hover:opacity-90">
            {offer('Start Free (No CC Required) →', `${TRIAL_CTA} →`)}
          </Link>
          <Link href="/alternatives/buffer" className="w-full sm:w-auto px-8 py-4 bg-white/5 border border-hp-border text-hp-text font-bold rounded-full text-base hover:bg-white/10">
            Compare vs Buffer & Postiz
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
