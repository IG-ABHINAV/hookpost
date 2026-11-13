import { CHANNEL_DEEP } from '../channel-deep';
import { CHANNEL_SPECS, isIndexedChannel } from '../channel-specs';
import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { SectionFaq } from '../../SectionFaq';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, usdCopy } from '../../usd-offer';

const { FREE } = pricingINR;

const listedAsLive = (slug: string) =>
  !CHANNEL_SPECS[slug]?.pending;

// "Threads's" read badly in the FAQ and the native-scheduler heading.
const possessive = (name: string) => (name.endsWith('s') ? `${name}'` : `${name}'s`);

// Instagram and Threads connect through Meta's sign-in, but a publish from an
// ordinary customer account is not confirmed yet (see channel-specs.ts), so
// their answers promise publishing once Meta access is confirmed.
const META_PENDING = new Set(['instagram', 'threads']);

// 11 Oct 2026 cleanup. These pages used to promise things the code does not do:
// "best time to post" recommendations (no such feature anywhere), Idea Pins
// (pinterest.provider.ts has none), Facebook Groups (the provider posts to
// Pages only), X polls and "evergreen recycling", LinkedIn analytics (the
// profile provider has none), plus a "N-Day Free Trial ($0)" button (the trial
// is a per-account offer and prices are in rupees). Every line below is now
// read from the provider, its settings or channel-deep.ts; channels with a
// CHANNEL_DEEP entry show that instead of a feature grid, so nothing is said
// twice.
interface ChannelConfig {
  name: string;
  slug: string;
  description: string;
  /** Only for channels without a CHANNEL_DEEP entry. */
  features?: string[];
}

const CHANNELS_DATA: Record<string, ChannelConfig> = {
  instagram: {
    name: 'Instagram',
    slug: 'instagram',
    description:
      'Schedule feed posts, carousels of up to 10 items, Reels and Stories to an Instagram Business or Creator account, on the same calendar as your other networks.',
  },
  pinterest: {
    name: 'Pinterest',
    slug: 'pinterest',
    description:
      'Schedule image and video Pins to the board you choose, with a title and destination link on each Pin.',
  },
  youtube: {
    name: 'YouTube',
    slug: 'youtube',
    description:
      'Schedule YouTube videos and Shorts with the title, description, tags, thumbnail and visibility set at upload.',
  },
  linkedin: {
    name: 'LinkedIn',
    slug: 'linkedin',
    description:
      'Schedule LinkedIn posts to your personal profile: text up to 3,000 characters, images, video and image carousels. Company Pages are not available.',
  },
  facebook: {
    name: 'Facebook',
    slug: 'facebook',
    description:
      'Schedule posts and Stories to the Facebook Pages you manage, alongside Instagram and your other networks. Personal profiles and Groups are not supported.',
    features: [
      'Posts with text, images or video to a Page',
      'Stories, with at least one image or video',
      'Several Pages selected on one post',
      'Page and post analytics in Hookpost',
    ],
  },
  threads: {
    name: 'Threads',
    slug: 'threads',
    description:
      'Schedule Threads posts with text, images or video, and multi-post threads, from the calendar you use for Instagram and the rest.',
    features: [
      'Text, image and video posts',
      'Multi-post threads as reply chains',
      'Each post checked against the 500 limit before it is queued',
      'Post analytics in Hookpost',
    ],
  },
  tiktok: {
    name: 'TikTok',
    slug: 'tiktok',
    description:
      'Schedule TikTok videos and photo carousels with privacy, duet and stitch set per post. Posts publish with the audience your TikTok account allows, or go to your inbox as drafts.',
    features: [
      'Videos and photo carousels',
      'Privacy, comments, duet and stitch set per post',
      'AI-generated content label',
      'Send to your TikTok inbox as a draft to finish in the app',
    ],
  },
  x: {
    name: 'X (Twitter)',
    slug: 'x',
    description:
      'Schedule posts, threads and articles to X, with who-can-reply and Community posting chosen per post.',
  },
  bluesky: {
    name: 'Bluesky',
    slug: 'bluesky',
    description:
      'Schedule Bluesky posts and threads with images, alt text or video. Bluesky has no scheduler of its own, so this is how you post at a set time.',
  },
  discord: {
    name: 'Discord',
    slug: 'discord',
    description:
      'Schedule messages and announcements to a channel in your Discord server, sent by the Hookpost bot, with mentions and follow-ups in a thread.',
  },
  slack: {
    name: 'Slack',
    slug: 'slack',
    description:
      'Schedule messages to a channel in your Slack workspace, sent by the Hookpost app, on the same calendar as your social posts.',
  },
  medium: {
    name: 'Medium',
    slug: 'medium',
    description:
      'Hookpost does not publish to Medium. To schedule articles, use WordPress, Hashnode or Dev.to, which Hookpost publishes to today.',
  },
  telegram: {
    name: 'Telegram',
    slug: 'telegram',
    description:
      'Schedule messages, photos and videos to a Telegram channel or group, sent by the Hookpost bot you add to it.',
  },
};

// What each network can already do without a tool, from its own help pages or
// announcements (checked 11 Oct 2026; sources in
// guides/social-media-post-schedule-kaise-kare/page.tsx). Rendered as a
// "{name}'s own scheduler vs Hookpost" section and as a FAQ answer, so the
// two always match.
const NATIVE: Record<string, string> = {
  instagram:
    "Instagram's app schedules posts and Reels on a professional account, and Meta Business Suite does the same on desktop, both free. Stories cannot be scheduled in the app. A tool helps when Instagram is one of several networks or a team shares one calendar.",
  facebook:
    'Meta Business Suite schedules Page posts for free. Creator Studio, which older guides describe, was replaced by Business Suite (Meta announced it in January 2023). A tool helps when the same post also goes to LinkedIn, YouTube or X.',
  linkedin:
    "LinkedIn's clock icon schedules profile posts from 10 minutes to 3 months ahead, and Page posts from 1 hour to 3 months ahead, though a Page cannot schedule polls, multi-photo posts or reshares. Hookpost adds a calendar shared with your other networks, carousels and API or AI-agent posting.",
  youtube:
    'YouTube Studio schedules each upload for a date, time and time zone and keeps the video private until then. Hookpost does the same and puts the upload on one calendar with the Reels, posts and threads that promote it.',
  threads:
    "Threads has had scheduling in its own composer since January 2025, but replies cannot be scheduled. Hookpost schedules Threads alongside Instagram and your other networks, including multi-post threads.",
  x: "x.com's composer has a schedule icon on accounts that have it. Hookpost schedules posts and whole threads to X whatever your X plan.",
  bluesky:
    'Bluesky has no scheduler of its own: the app and the AT Protocol publish a post the moment it is created. Scheduling a Bluesky post at a set time needs a tool.',
  telegram:
    "Telegram's own apps can schedule a single message (hold the send button). Hookpost adds a calendar shared with your other networks and posts through a bot you make an admin of the channel.",
};

function getChannelData(slug: string): ChannelConfig {
  const normalized = slug.toLowerCase();
  if (CHANNELS_DATA[normalized]) {
    return CHANNELS_DATA[normalized];
  }
  // Title-casing the slug turned real brands into "Vk", "Devto" and
  // "Wordpress". Getting a brand's own spelling wrong is a bad entity signal,
  // so the ones that do not title-case cleanly are spelled out here.
  const BRAND_NAMES: Record<string, string> = {
    devto: 'DEV.to',
    wordpress: 'WordPress',
    listmonk: 'Listmonk',
    hashnode: 'Hashnode',
    nostr: 'Nostr',
    lemmy: 'Lemmy',
    medium: 'Medium',
  };
  const formattedName =
    BRAND_NAMES[normalized] ||
    slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  const noun = (CONTENT_NOUN[normalized] || 'Posts').toLowerCase();
  return {
    name: formattedName,
    slug,
    description: `Schedule ${noun} to ${formattedName} from the same calendar as your social networks, checked against ${formattedName}'s rules before they are queued.`,
  };
}

// Every channel the sitemap advertises. Only connectable channels are listed:
// a page here is a promise the product has to keep.
const ALL_CHANNEL_SLUGS = [
  ...new Set([
    ...Object.keys(CHANNELS_DATA),
    'lemmy',
    'nostr',
    'listmonk',
    'wordpress',
    'medium',
    'hashnode',
    'devto',
  ]),
];

// /channels/<anything> used to answer 200 with a page built from the slug -
// thin content promising a channel that does not exist. Only the slugs below
// are real; every other one now 404s.
export const dynamicParams = false;

export function generateStaticParams() {
  return ALL_CHANNEL_SLUGS.map((channel) => ({ channel }));
}

// What people call a scheduled item on each network, in the words they search
// with. Search Console shows "schedule discord" queries from people who say
// messages, not posts; the blog platforms publish articles.
const CONTENT_NOUN: Record<string, string> = {
  discord: 'Messages',
  slack: 'Messages',
  telegram: 'Messages',
  wordpress: 'Articles',
  medium: 'Articles',
  hashnode: 'Articles',
  devto: 'Articles',
  listmonk: 'Newsletters',
};

// Guides and tools that go deeper on one network. Linked from that network's
// page so the channel page, its how-to and its tool read as one cluster.
const RELATED: Record<string, [string, string][]> = {
  x: [['How to schedule X threads', '/guides/schedule-x-threads'], ['X character counter', '/tools/x-character-counter'], ['Thread splitter', '/tools/thread-splitter'], ['Cross-post to X and Bluesky', '/guides/cross-post-x-bluesky']],
  bluesky: [['Cross-post to X and Bluesky', '/guides/cross-post-x-bluesky'], ['Bluesky character counter', '/tools/bluesky-character-counter'], ['Thread splitter', '/tools/thread-splitter']],
  linkedin: [['LinkedIn character counter', '/tools/linkedin-character-counter']],
  discord: [['Discord post scheduler', '/discord-post-scheduler'], ['How to schedule Discord messages', '/guides/schedule-discord-announcements']],
  devto: [['Cross-post articles to Dev.to, Hashnode and WordPress', '/guides/cross-post-dev-articles']],
  medium: [['Cross-post articles to Dev.to, Hashnode and WordPress', '/guides/cross-post-dev-articles']],
  hashnode: [['Cross-post articles to Dev.to, Hashnode and WordPress', '/guides/cross-post-dev-articles']],
  wordpress: [['Cross-post articles to Dev.to, Hashnode and WordPress', '/guides/cross-post-dev-articles']],
};

// "Schedule X (Twitter) Posts: Free X (Twitter) Scheduler | Hookpost" is 65
// characters and gets cut in results; past 60, the shorter form keeps both
// keywords.
// No "Free" once new users have no Free plan (trial-offer.ts).
const FREE_WORD = offer('Free ', '');
const channelTitle = (name: string, noun: string) => {
  const full = `Schedule ${name} ${noun}: ${FREE_WORD}${name} Scheduler | Hookpost`;
  return full.length <= 60 ? full : `${FREE_WORD}${name} Scheduler for ${noun} | Hookpost`;
};

export async function generateMetadata({ params }: { params: Promise<{ channel: string }> | { channel: string } }): Promise<Metadata> {
  const resolved = await Promise.resolve(params);
  const data = getChannelData(resolved.channel || '');

  return withSocial({
    // Was `${name} Scheduler — ${tagline} | Hookpost`, which ran to 87
    // characters and got truncated. The tagline already appears in the
    // description, so it does not need to be in both.
    // Pending channels do not promise a free scheduler they cannot deliver yet.
    // Medium is not "coming": it stopped issuing API tokens and may never
    // resume, so its title says it is not available.
    title: !listedAsLive(data.slug)
      ? data.slug === 'medium'
        ? `${data.name} Publishing Is Not Available | Hookpost`
        : `${data.name} Scheduler: Not Available Yet | Hookpost`
      : channelTitle(data.name, CONTENT_NOUN[data.slug] || 'Posts'),
    description: data.description,
    alternates: {
      canonical: `https://hookpost.hookstep.in/channels/${data.slug}`,
    },
    ...(isIndexedChannel(data.slug) ? {} : { robots: { index: false, follow: true } }),
  });
}

export default async function ChannelLandingPage({ params }: { params: Promise<{ channel: string }> | { channel: string } }) {
  const resolved = await Promise.resolve(params);
  const data = getChannelData(resolved.channel || '');
  // Title, badge, H1 and FAQ schema all follow listedAsLive, so they agree.
  const pending = !listedAsLive(data.slug);

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: "https://hookpost.hookstep.in" },
      { "@type": "ListItem", position: 2, name: "Channels", item: "https://hookpost.hookstep.in/channels" },
      { "@type": "ListItem", position: 3, name: data.name + " Scheduler", item: `https://hookpost.hookstep.in/channels/${data.slug}` },
    ],
  };

  const noun = (CONTENT_NOUN[data.slug] || 'Posts').toLowerCase();
  const scheduleAnswer = pending
    ? `${data.slug === 'medium' ? 'No' : 'Not yet'}. ${CHANNEL_SPECS[data.slug].pending}`
    : data.slug === 'tiktok'
    ? 'Yes. Hookpost publishes them to your TikTok account at the time you set, with the audience your account allows (Everyone, Friends, Followers or Only me). You can also send them to your TikTok inbox as drafts and publish from the TikTok app.'
    : data.slug === 'instagram'
    ? 'Yes, for an Instagram Business or Creator account: Instagram\'s API only lets apps publish automatically to Business or Creator accounts. Hookpost connects Instagram through Meta\'s sign-in, and posts publish at the time you set once Meta access is confirmed.'
    : META_PENDING.has(data.slug)
    ? `Yes. Hookpost connects ${data.name} through Meta's sign-in, and posts publish at the time you set once Meta access is confirmed.`
    : `Yes. Hookpost publishes through ${possessive(data.name)} official API at the time you set, so there is no reminder to finish the post by hand.`;

  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [
      {
        "@type": "Question",
        name: `Can I schedule ${noun} to ${data.name} with Hookpost?`,
        acceptedAnswer: {
          "@type": "Answer",
          // Structured data is read as a factual answer, so it must follow the
          // channel's real status: a pending channel cannot publish yet.
          text: scheduleAnswer,
        },
      },
      {
        "@type": "Question",
        name: offer(`Is ${data.name} scheduling supported on the free plan?`, `Is ${data.name} scheduling included in the ${FREE_POSTS}?`),
        acceptedAnswer: {
          "@type": "Answer",
          text: pending
            ? `${data.slug === 'medium' ? `No: ${data.name} is not available on any plan.` : `Not yet: ${data.name} is not publishing on any plan until it opens.`} ${offer(`Hookpost's free plan covers ${FREE.channel} channels and ${FREE.posts_per_month} posts a month on the networks that are live, with no card required.`, `Every Hookpost plan, and its ${FREE_POSTS}, covers the networks that are live.`)}`
            : offer(`Yes. Hookpost's free plan includes ${FREE.channel} channels and ${FREE.posts_per_month} posts a month, with no time limit and no card.`, `Yes. ${data.name} is on every plan, including the ${FREE_POSTS}. ${TRIAL_SENTENCE}`),
        },
      },
      ...(NATIVE[data.slug]
        ? [
            {
              "@type": "Question",
              name: `Can't I just use ${possessive(data.name)} own scheduler?`,
              acceptedAnswer: { "@type": "Answer", text: NATIVE[data.slug] },
            },
          ]
        : []),
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

      <SiteNav />

      <div className="max-w-[1200px] mx-auto px-6 pt-10 pb-24 text-center">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50 mb-8">
          <ol className="flex items-center justify-center space-x-2">
            <li><Link href="/" className="hover:text-hp-text transition-colors">Home</Link></li>
            <li>/</li>
            <li><Link href="/channels" className="hover:text-hp-text transition-colors">Channels</Link></li>
            <li>/</li>
            <li className="text-hp-primary-text font-semibold">{data.name}</li>
          </ol>
        </nav>

        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-hp-border text-hp-text/70 text-sm font-medium mb-8">
          {pending
            ? data.slug === 'medium'
              ? `${data.name} is not available`
              : `${data.name} is not publishing yet`
            : `${data.name} · ${CHANNEL_SPECS[data.slug]?.auth || 'Connect once'}`}
        </div>

        {/*
          min-h reserves the heading's space so the CTA below it does not move
          when the web font swaps in (measured CLS 0.144 on this template before).
          Two lines at each breakpoint (text-4xl 36px and sm:text-6xl 60px, both
          at leading-tight 1.25).
        */}
        <h1 className="text-4xl sm:text-6xl font-black tracking-tight max-w-4xl mx-auto leading-tight mb-6 min-h-[5.625rem] sm:min-h-[9.375rem]">
          {pending && data.slug === 'medium' ? (
            // Not "coming": Medium stopped issuing tokens and may never resume
            // (see MEDIUM_PENDING in channel-specs.ts).
            <>
              <span className="text-hp-primary-text">{data.name} publishing</span> is not available in Hookpost
            </>
          ) : pending ? (
            <>
              <span className="text-hp-primary-text">{data.name} scheduling</span> is coming to Hookpost
            </>
          ) : (
            <>
              Schedule <span className="text-hp-primary-text">{data.name}</span> {noun} with Hookpost
            </>
          )}
        </h1>

        <p className="text-lg sm:text-xl text-hp-text/70 max-w-2xl mx-auto mb-10 leading-relaxed">
          {data.description}
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-6">
          <Link
            href="/auth"
            prefetch={false}
            className="w-full sm:w-auto bg-hp-primary hover:bg-hp-primary-hover text-hp-on-primary font-bold text-lg px-8 py-4 rounded-full transition-all duration-200 flex items-center justify-center gap-2"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <Link
            href="/pricing"
            className="w-full sm:w-auto bg-white/10 hover:bg-white/20 text-hp-text font-semibold text-lg px-8 py-4 rounded-full transition-all duration-200 border border-hp-border"
          >
            See pricing
          </Link>
        </div>

        <p className="text-xs text-hp-text/50 mb-16">
          {offer(
            <>
              Free plan: {FREE.channel} channels and {FREE.posts_per_month} posts a month, no card. Paid plans{' '}
              {usdCopy('in rupees ', '')}from {planPrice('HOOKPOST', ' a month')}.
            </>,
            TRIAL_SENTENCE
          )}
        </p>

        {data.features && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-left max-w-4xl mx-auto mb-20">
            {data.features.map((feature) => (
              <div key={feature} className="p-5 rounded-2xl bg-white/[0.03] border border-hp-border">
                <h2 className="text-base font-bold text-hp-text">{feature}</h2>
              </div>
            ))}
          </div>
        )}

        {/*
          Real, per-network specification. Every channel page used to run within
          twenty words of every other one - the same template with a name
          swapped, which is the clearest signal of scaled content there is and
          gave a reader nothing they could not have guessed. These limits are
          the ones Hookpost actually enforces, so they differ genuinely from
          page to page and are worth landing on.
        */}
        {/* A channel that can be connected but cannot yet publish says so here,
            above its own specification. Selling a scheduler for a platform that
            returns 403 on publish is worse than not listing the platform. */}
        {CHANNEL_SPECS[data.slug]?.pending && (
          <div className="mx-auto mb-12 max-w-3xl rounded-2xl border border-amber-400/40 bg-amber-400/[0.07] p-6 text-left">
            <p className="text-xs font-bold uppercase tracking-wider text-amber-300">
              {data.slug === 'medium' ? 'Not available' : 'Not publishing yet'}
            </p>
            <p className="mt-2 text-[15px] leading-relaxed text-hp-text/80">
              {CHANNEL_SPECS[data.slug].pending}
            </p>
          </div>
        )}

        {/* A channel nobody can connect gets no limits or feature detail: it
            would describe an integration the reader cannot use. */}
        {CHANNEL_SPECS[data.slug] && !pending && (
          <div className="mx-auto mb-20 max-w-5xl text-left">
            <h2 className="mb-6 text-center text-2xl font-bold text-hp-text">
              {data.name} posting limits
            </h2>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-2xl border border-hp-border bg-white/[0.03] p-6">
                <div className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                  Caption limit
                </div>
                <div className="mt-2 text-lg font-bold text-hp-text">
                  {CHANNEL_SPECS[data.slug].limit}
                </div>
              </div>

              <div className="rounded-2xl border border-hp-border bg-white/[0.03] p-6">
                <div className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                  Connecting
                </div>
                <div className="mt-2 text-lg font-bold text-hp-text">
                  {CHANNEL_SPECS[data.slug].auth}
                </div>
              </div>

              <div className="rounded-2xl border border-hp-border bg-white/[0.03] p-6">
                <div className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">
                  Media rules
                </div>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm text-hp-text/70">
                  {CHANNEL_SPECS[data.slug].rules.length ? (
                    CHANNEL_SPECS[data.slug].rules.map((r) => (
                      <li key={r} className="flex gap-2">
                        <span className="text-hp-primary-text">·</span>
                        <span>{r}</span>
                      </li>
                    ))
                  ) : (
                    <li className="text-hp-text/50">
                      Text, images and video, as {data.name} allows.
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        )}

        {/* Long-form detail, only for the channels that have it written. The
            others keep the specification block alone rather than getting
            padding, which would put the templated-content problem straight
            back. */}
        {CHANNEL_DEEP[data.slug] && !pending && (
          <div className="mx-auto mb-20 max-w-4xl text-left">
            <p className="text-base leading-relaxed text-hp-text/70">
              {CHANNEL_DEEP[data.slug].intro}
            </p>

            <h2 className="mb-6 mt-12 text-2xl font-bold text-hp-text">
              What you can publish to {data.name}
            </h2>
            <div className="flex flex-col gap-5">
              {CHANNEL_DEEP[data.slug].publish.map((item) => (
                <div
                  key={item.title}
                  className="rounded-2xl border border-hp-border bg-white/[0.02] p-6"
                >
                  <h3 className="font-bold text-hp-text">{item.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-hp-text/60">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>

            <h2 className="mb-5 mt-12 text-2xl font-bold text-hp-text">
              Set on each post
            </h2>
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {CHANNEL_DEEP[data.slug].perPost.map((f) => (
                <li key={f} className="flex gap-2.5 text-[15px] text-hp-text/70">
                  <span className="text-hp-primary-text">✓</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>

            <div className="mt-12 rounded-2xl border border-hp-primary/30 bg-hp-primary/[0.06] p-6">
              <h3 className="font-bold text-hp-text">
                {CHANNEL_DEEP[data.slug].gotcha.title}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-hp-text/70">
                {CHANNEL_DEEP[data.slug].gotcha.body}
              </p>
            </div>
          </div>
        )}

        {NATIVE[data.slug] && (
          <div className="mx-auto mb-16 max-w-4xl text-left">
            <h2 className="mb-4 text-2xl font-bold text-hp-text">
              {possessive(data.name)} own scheduler, or Hookpost?
            </h2>
            <p className="text-base leading-relaxed text-hp-text/70">{NATIVE[data.slug]}</p>
            <p className="mt-4 text-sm text-hp-text/55">
              Step-by-step native scheduling for Instagram, Facebook, YouTube, LinkedIn, X and Threads:{' '}
              <Link href="/guides/social-media-post-schedule-kaise-kare" className="text-hp-primary-text underline">
                social media post schedule kaise kare
              </Link>{' '}
              (Hinglish). Posting one update to several networks:{' '}
              <Link href="/guides/post-to-multiple-social-media-at-once" className="text-hp-primary-text underline">
                every network&apos;s limits
              </Link>
              .
            </p>
          </div>
        )}

        {RELATED[data.slug] && (
          <div className="mx-auto mb-12 max-w-3xl text-left">
            <h2 className="mb-4 text-2xl font-bold text-hp-text">
              {pending && data.slug === 'medium' ? 'Publish articles with Hookpost' : `Guides and free tools for ${data.name}`}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {RELATED[data.slug].map(([label, href]) => (
                <li key={href}>
                  <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm text-hp-text/80 hover:border-hp-primary hover:text-hp-text">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
        <SectionFaq items={faqSchema.mainEntity} />

        <div className="p-10 rounded-3xl bg-white/[0.03] border border-hp-primary/30 max-w-4xl mx-auto text-center">
          {/* Medium cannot publish, so its closing call to action points at the article networks
              that can. Any other pending channel gets neutral wording that promises neither
              articles nor itself. */}
          <h2 className="text-3xl font-black mb-4">
            {pending && data.slug === 'medium' ? (
              <>Schedule articles with the rest of your channels</>
            ) : pending ? (
              <>Schedule the channels that are live today</>
            ) : (
              <>
                Schedule <span className="text-hp-primary-text">{data.name}</span> with the rest of your channels
              </>
            )}
          </h2>
          <p className="text-hp-text/70 max-w-xl mx-auto mb-8">
            {(pending && data.slug === 'medium'
              ? 'Hookpost publishes articles to WordPress, Hashnode and Dev.to on the same calendar as your social posts.'
              : pending
              ? 'One calendar for every network Hookpost publishes to today.'
              : `One calendar for ${data.name} and every other network you post to.`) +
              offer(' The free plan needs no card and does not expire.', ` ${TRIAL_SENTENCE}`)}
          </p>
          <Link
            href="/auth"
            prefetch={false}
            className="inline-flex bg-hp-primary hover:bg-hp-primary-hover text-hp-on-primary font-bold text-lg px-10 py-4 rounded-full transition-all duration-200"
          >
            {offer('Start free', TRIAL_CTA)}
          </Link>
        </div>
      </div>

    </div>
  );
}
