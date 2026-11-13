import React from "react";
import Link from "next/link";
import { Metadata } from "next";
import { PUBLISHABLE_CHANNEL_COUNT } from "./channel-count";
import { withSocial } from '../social-meta';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';

export const metadata: Metadata = withSocial({
  title: "Supported Social Media Channels (2026) | Hookpost",
  description:
    `Schedule and auto-publish across ${PUBLISHABLE_CHANNEL_COUNT} social platforms from one dashboard: X, LinkedIn, YouTube, Bluesky, Telegram, Discord and more.`,
  alternates: {
    canonical: "https://hookpost.hookstep.in/channels",
  },
});

// NOTE: this list must cover every key in channel-specs.ts. The page header
// prints PUBLISHABLE_CHANNEL_COUNT, derived from those specs, so a channel
// present in the
// specs but absent here makes the page claim a number larger than the list it
// shows - which is what happened: "18 networks" above a grid of 11, with the
// other seven reachable only by typing the URL.
const CHANNELS = [
  {
    "slug": "lemmy",
    "name": "Lemmy",
    "desc": "Post to federated communities across any Lemmy instance.",
    "icon": "🐭"
  },
  {
    "slug": "nostr",
    "name": "Nostr",
    "desc": "Publish notes to relays on the censorship-resistant protocol.",
    "icon": "🔑"
  },
  {
    "slug": "listmonk",
    "name": "Listmonk",
    "desc": "Send the same update to your self-hosted newsletter list.",
    "icon": "📧"
  },
  {
    "slug": "wordpress",
    "name": "WordPress",
    "desc": "Publish posts and pages to any self-hosted WordPress site.",
    "icon": "📰"
  },
  {
    "slug": "medium",
    "name": "Medium",
    "desc": "Not available: Medium stopped issuing new API tokens. WordPress, Hashnode and Dev.to publish articles today.",
    "icon": "✍️"
  },
  {
    "slug": "hashnode",
    "name": "Hashnode",
    "desc": "Cross-post developer articles to your own domain with series support.",
    "icon": "📝"
  },
  {
    "slug": "devto",
    "name": "DEV.to",
    "desc": "Publish articles with canonical URLs and tags to the DEV community.",
    "icon": "👩‍💻"
  },
  {
    "slug": "instagram",
    "name": "Instagram",
    "desc": "Auto-publish Reels, carousels, and stories to Business & Creator accounts.",
    "icon": "📸"
  },
  {
    "slug": "youtube",
    "name": "YouTube Shorts",
    "desc": "Schedule Shorts and long-form video uploads with SEO titles & tags.",
    "icon": "▶️"
  },
  {
    "slug": "linkedin",
    "name": "LinkedIn",
    "desc": "Schedule personal brand posts, PDF carousels, and company organization updates.",
    "icon": "💼"
  },
  {
    "slug": "x",
    "name": "X (Twitter)",
    "desc": "Draft and publish tweets, multi-post threads, polls, and image grids.",
    "icon": "🐦"
  },
  {
    "slug": "threads",
    "name": "Meta Threads",
    "desc": "Cross-post text threads and visual updates directly to your Threads profile.",
    "icon": "🧵"
  },
  {
    "slug": "tiktok",
    "name": "TikTok",
    "desc": "Schedule short videos and photo carousels to TikTok personal and business accounts.",
    "icon": "🎵"
  },
  {
    "slug": "pinterest",
    "name": "Pinterest",
    "desc": "Schedule image and video Pins to the board you choose, with a title and destination link on each Pin.",
    "icon": "📌"
  },
  {
    "slug": "facebook",
    "name": "Facebook",
    "desc": "Schedule posts and Stories to the Facebook Pages you manage. Personal profiles and Groups are not supported.",
    "icon": "📘"
  },
  {
    "slug": "bluesky",
    "name": "Bluesky",
    "desc": "Automate decentralized social posts across the AT Protocol network.",
    "icon": "🦋"
  },
  {
    "slug": "telegram",
    "name": "Telegram",
    "desc": "Broadcast announcements and media drops to your Telegram channels.",
    "icon": "✈️"
  },
  {
    "slug": "discord",
    "name": "Discord",
    "desc": "Post webhook updates and community announcements to Discord servers.",
    "icon": "💬"
  },
  {
    "slug": "slack",
    "name": "Slack",
    "desc": "Deliver team announcements, product updates, and daily digests to Slack channels.",
    "icon": "📢"
  }
];

export default function ChannelsHubPage() {
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Channels", item: "https://hookpost.hookstep.in/channels" },
    ],
  };

  const collectionSchema = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Hookpost Supported Social Media Networks & Channels (2026)",
    description: "Directory of supported social media networks for multi-platform scheduling and automation.",
    url: "https://hookpost.hookstep.in/channels",
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
        Hookpost Platform Directory — One Visual Calendar for {PUBLISHABLE_CHANNEL_COUNT} Social Media Networks
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
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">Channels</li>
          </ol>
        </nav>

        <div className="text-center space-y-4 max-w-[900px] mx-auto">
          <div className="inline-block bg-hp-primary/10 border border-hp-primary/30 text-hp-primary-text text-xs font-semibold px-4 py-1.5 rounded-full uppercase tracking-wider">
            Supported Integrations
          </div>
          <h1 className="text-[34px] sm:text-[56px] font-black tracking-tight text-hp-text leading-[1.15]">
            Connect, Schedule &amp; Publish <br />
            <span className="text-hp-primary-text">Across {PUBLISHABLE_CHANNEL_COUNT} Social Networks</span>
          </h1>
          <p className="text-hp-text-2 text-lg sm:text-xl leading-relaxed">
            Stop switching tabs between different social platforms. Upload your content once, optimize it with AI, and schedule to all your accounts simultaneously.
          </p>
        </div>

        {/* Featured Snippet Definition Box (Position 0 Target) */}
        <div className="bg-hp-elevated border border-hp-primary/30 rounded-2xl p-6 max-w-[900px] mx-auto text-left shadow-[0_0_30px_rgb(var(--hp-primary-rgb)/0.1)]">
          <p className="text-xs uppercase tracking-widest text-hp-primary-text font-bold mb-2">Supported Social Channels Summary</p>
          <p className="text-sm sm:text-base text-hp-text-2 leading-relaxed">
            <strong>Hookpost</strong> supports multi-channel social media publishing across {PUBLISHABLE_CHANNEL_COUNT} networks, including Instagram Reels, Meta Threads, TikTok, Pinterest Pins, Facebook Pages, YouTube Shorts, LinkedIn, X, Bluesky, Discord and Telegram. Users can draft once, customize captions with AI, and schedule posts across all connected channels simultaneously from a unified visual calendar.
          </p>
          <p className="mt-3 text-sm text-hp-text-2">
            Every network&apos;s text and media limits in one table, with a worked example:{' '}
            <Link href="/guides/post-to-multiple-social-media-at-once" className="text-hp-primary-text underline">how to post to multiple social media at once</Link>.
          </p>
        </div>

        <section className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {CHANNELS.map((ch) => (
            <div
              key={ch.slug}
              className="bg-hp-surface border border-hp-border hover:border-hp-primary/40 rounded-2xl p-6 sm:p-7 space-y-4 transition-all duration-200 flex flex-col justify-between"
            >
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{ch.icon}</span>
                  <h2 className="text-xl font-bold text-hp-text">
                    {ch.name}
                  </h2>
                </div>
                <p className="text-sm text-hp-text/70 leading-relaxed">
                  {ch.desc}
                </p>
              </div>

              <div className="pt-4 border-t border-hp-border">
                <Link
                  href={"/channels/" + ch.slug}
                  className="text-hp-primary-text hover:text-hp-text font-semibold text-sm flex items-center gap-1 group transition-colors"
                >
                  {ch.slug === 'medium' ? 'Why Medium is not available' : `Explore ${ch.name} Scheduling`}
                  <span className="group-hover:translate-x-1 transition-transform">&rarr;</span>
                </Link>
              </div>
            </div>
          ))}
        </section>

        <div className="bg-gradient-to-b from-hp-elevated to-hp-surface border border-hp-border-strong rounded-3xl p-8 sm:p-12 text-center space-y-5">
          <h2 className="text-3xl sm:text-4xl font-bold text-hp-text">
            Ready to Connect Your Social Channels?
          </h2>
          <p className="text-hp-text-3 max-w-lg mx-auto text-base sm:text-lg">
            {offer(`Start on the free plan: ${pricingINR.FREE.channel} channels and ${pricingINR.FREE.posts_per_month} posts a month, no credit card.`, TRIAL_SENTENCE)}
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
