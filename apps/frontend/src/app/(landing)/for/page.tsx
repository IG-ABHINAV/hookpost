import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { PUBLISHABLE_CHANNEL_COUNT } from "../channels/channel-count";
import { withSocial } from '../social-meta';
import { offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';

export const metadata: Metadata = withSocial({
  title: "Social Media Solutions by Role | Hookpost",
  description:
    "Explore Hookpost tailored social media scheduling solutions for creators, agencies, B2B SaaS, e-commerce, real estate, and small businesses in 2026.",
  alternates: {
    canonical: "https://hookpost.hookstep.in/for",
  },
});

const PERSONAS = [
  { slug: "creators", title: "Content Creators & Influencers", desc: "Batch schedule YouTube Shorts, X threads and LinkedIn carousels, with AI captions on paid plans.", badge: "Creators" },
  { slug: "agencies", title: "Digital Marketing Agencies", desc: "Group channels by client, share preview links for feedback, and add up to 15 team members on the Hookpost plan.", badge: "Agencies" },
  { slug: "b2b-saas", title: "B2B SaaS & Tech Startups", desc: "Automate founder LinkedIn thought leadership, X product updates, and Dev.to and Hashnode launch articles.", badge: "B2B SaaS" },
  { slug: "ecommerce", title: "E-Commerce Brands & Shopify Stores", desc: "Schedule product launches, YouTube demos, and seasonal discount drops to social channels and email.", badge: "E-Commerce" },
  { slug: "small-business", title: "Small & Local Businesses", desc: "Consistent local presence on X, LinkedIn and YouTube with zero complicated setups.", badge: "Small Business" },
  { slug: "solopreneurs-freelancers", title: "Solopreneurs & Freelancers", desc: "One unified calendar to schedule across all your professional channels.", badge: "Solopreneurs" },
  { slug: "real-estate", title: "Real Estate Agents & Brokers", desc: "Showcase property video tours, open-house updates, and listing photos across LinkedIn, X and YouTube.", badge: "Real Estate" },
  { slug: "restaurants-cafes", title: "Restaurants, Cafes & Bars", desc: "Schedule daily menu specials, happy hour reminders, and weekend event teasers seamlessly.", badge: "Food & Beverage" },
  { slug: "fitness-coaches", title: "Fitness Coaches & Gyms", desc: "Post daily workout tips, client transformations, and nutritional guides to build an engaged community.", badge: "Fitness" },
  { slug: "healthcare-clinics", title: "Healthcare & Wellness Clinics", desc: "Build patient trust with educational health content, clinic updates, and doctor spotlights.", badge: "Healthcare" },
  { slug: "crypto-web3", title: "Web3, DeFi & Crypto Projects", desc: "Coordinate X announcements, Telegram community drops, and Discord updates in real time.", badge: "Web3" },
  { slug: "music-artists", title: "Musicians & Recording Artists", desc: `Drop album teasers, Spotify release count-downs, and tour announcements across ${PUBLISHABLE_CHANNEL_COUNT} networks.`, badge: "Music" },
  { slug: "educators-nonprofits", title: "Educators & Nonprofits", desc: offer("Amplify awareness campaigns, student outreach, and donation drives, starting on the free plan.", "Amplify awareness campaigns, student outreach, and donation drives on one flat plan."), badge: "Nonprofit" },
  { slug: "students-young-creators", title: "Students & Young Founders", desc: offer("A free plan to build personal brands, showcase portfolios, and launch side projects.", "One flat plan to build personal brands, showcase portfolios, and launch side projects."), badge: "Students" },
];

export default function ForHubPage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://hookpost.hookstep.in",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Solutions",
        item: "https://hookpost.hookstep.in/for",
      },
    ],
  };

  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Hookpost Industry Solutions Directory (2026)",
    description: "Explore tailored social media scheduling and automation for creators, agencies, B2B SaaS, and local businesses.",
    url: "https://hookpost.hookstep.in/for",
    publisher: {
      "@type": "Organization",
      name: "Hookpost",
      url: "https://hookpost.hookstep.in",
    },
  };

  return (
    <div className="bg-hp-bg text-hp-text min-h-screen font-sans selection:bg-hp-primary selection:text-hp-on-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(collectionSchema) }}
      />

      <div className="w-full bg-hp-primary text-hp-on-primary text-center font-medium text-sm py-1.5 px-4 font-sans">
        Hookpost Tailored Solutions — Built for Creators, High-Growth Teams &amp; Agencies
      </div>

      <header className="flex justify-between items-center w-full max-w-[1440px] mx-auto h-[70px] px-6 sm:px-12">
        <Link href="/" aria-label="Hookpost home" className="flex items-center gap-2 shrink-0">
          <img alt="" src="/brand-logo-96.webp" width="96" height="96" className="h-8 md:h-10 w-auto max-h-[38px] object-contain" />
          {/* Icon only on phones: the wordmark and both buttons need ~365px. */}<span className="hidden sm:inline text-2xl font-black tracking-tight text-hp-text">
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
            className="text-sm font-medium bg-white text-black hover:bg-hp-primary hover:text-hp-on-primary transition-all px-4 sm:px-5 py-2 rounded-full font-semibold whitespace-nowrap"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto px-6 pt-12 pb-24 space-y-16">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <ol className="flex items-center space-x-2">
            <li>
              <Link href="/" className="hover:text-hp-text transition-colors">Home</Link>
            </li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Solutions</li>
          </ol>
        </nav>

        <div className="text-center space-y-4 max-w-[900px] mx-auto">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            Tailored Industry Workflows
          </div>
          <h1 className="text-[34px] sm:text-[56px] font-black tracking-tight text-hp-text leading-[1.15]">
            Social Media Scheduling <br />
            <span className="text-hp-primary-text">Engineered for Your Industry</span>
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl leading-relaxed">
            Whether you are a solo creator, a fast-scaling B2B startup, or an agency juggling several clients, Hookpost adapts to your publishing rhythm.
          </p>
        </div>

        {/* Featured Snippet Definition Box (Position 0 Target) */}
        <div className="bg-hp-elevated border border-hp-primary/30 rounded-2xl p-6 max-w-[900px] mx-auto text-left shadow-[0_0_30px_rgb(var(--hp-primary-rgb)/0.1)]">
          <p className="text-xs uppercase tracking-widest text-hp-primary-text font-bold mb-2">Social Media Solutions Summary</p>
          <p className="text-sm sm:text-base text-hp-text-2 leading-relaxed">
            <strong>Hookpost Solutions</strong> provide specialized social media scheduling workflows tailored for 14 personas, including content creators, marketing agencies, B2B SaaS startups, e-commerce stores, and small businesses. Key capabilities include per-client channel grouping, AI-assisted caption writing on paid plans, and auto-posting to {PUBLISHABLE_CHANNEL_COUNT} networks.
          </p>
        </div>

        <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {PERSONAS.map((p) => (
            <div
              key={p.slug}
              className="bg-hp-surface border border-hp-border hover:border-hp-primary/40 rounded-2xl p-6 sm:p-7 space-y-4 transition-all duration-200 flex flex-col justify-between"
            >
              <div className="space-y-2">
                <span className="text-xs font-semibold bg-hp-primary/10 text-hp-primary-text px-3 py-1 rounded-full border border-hp-primary/20">
                  {p.badge}
                </span>
                <h2 className="text-xl font-bold text-hp-text pt-1">
                  {p.title}
                </h2>
                <p className="text-sm text-hp-text/70 leading-relaxed">
                  {p.desc}
                </p>
              </div>

              <div className="pt-4 border-t border-hp-border">
                <Link
                  href={`/for/${p.slug}`}
                  className="text-hp-primary-text hover:text-hp-text font-semibold text-sm flex items-center gap-1 group transition-colors"
                >
                  Explore {p.badge} Solution
                  <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
                </Link>
              </div>
            </div>
          ))}
        </section>

        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Ready to Automate Your Industry Socials?
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base sm:text-lg">
            {offer('Connect your channels with no credit card required.', TRIAL_SENTENCE)}
          </p>
          <Link
            href="/auth"
            className="inline-block bg-hp-primary text-hp-on-primary hover:bg-white hover:text-black font-bold text-base px-10 py-4 rounded-full transition-all shadow-xl shadow-hp-primary/20"
          >
            {offer('Start free', TRIAL_CTA)} &rarr;
          </Link>
        </div>
      </div>

    </div>
  );
}
