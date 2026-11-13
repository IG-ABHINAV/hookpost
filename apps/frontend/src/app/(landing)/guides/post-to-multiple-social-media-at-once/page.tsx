import { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../../social-meta';
import { CHANNEL_SPECS } from '../../channels/channel-specs';
import { PUBLISHABLE_CHANNEL_COUNT } from '../../channels/channel-count';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../../trial-offer';
import { planPrice, usdCopy } from '../../usd-offer';

// Targets "post to multiple social media at once", "post on all social media at
// once", "cross post to all platforms", "cross posting tool". The ranking pages
// give generic "adapt your content" advice; this one prints the limits the
// composer actually enforces, rendered from channel-specs.ts so it cannot drift
// from the channel pages.
//
// Behaviour described here is read from code:
// - helpers/utils/count.length.ts: X uses twitter-text weighted length, Threads
//   counts UTF-8 bytes, every other network plain string length.
// - new-launch editor (globe icon = shared version, avatar + "Edit content" =
//   per-network copy, "Back to global" discards it), each channel validated
//   separately before queueing (also enforced server-side in posts.service.ts).
// - Public API POST /posts takes several channels in one request; the MCP
//   schedule tool takes several socialPost entries. The CLI on npm (hookpost
//   0.1.1, 11 Oct) takes --channel a,b (apps/cli/src/index.ts flags()).
// - Monthly post quota counts post rows, one per channel (permissions.service.ts).
const CANONICAL = 'https://hookpost.hookstep.in/guides/post-to-multiple-social-media-at-once';
const PUBLISHED = '2026-10-11';
const { FREE, HOOKPOST } = pricingINR;

const NAMES: Record<string, string> = {
  instagram: 'Instagram',
  threads: 'Threads',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  youtube: 'YouTube',
  linkedin: 'LinkedIn',
  facebook: 'Facebook Pages',
  x: 'X (Twitter)',
  bluesky: 'Bluesky',
  discord: 'Discord',
  slack: 'Slack',
  telegram: 'Telegram',
  lemmy: 'Lemmy',
  nostr: 'Nostr',
  listmonk: 'Listmonk',
  wordpress: 'WordPress',
  hashnode: 'Hashnode',
  devto: 'Dev.to',
};

const ROWS = Object.entries(CHANNEL_SPECS)
  .filter(([, spec]) => !spec.pending)
  .map(([slug, spec]) => ({ slug, name: NAMES[slug] || slug, ...spec }));

const STEPS: { name: string; text: string }[] = [
  {
    name: 'Pick the channels',
    text: 'Create a post and click the avatar of every channel it should go to. All of them share one version of the post to start with.',
  },
  {
    name: 'Write the shared version',
    text: 'With the globe icon selected you are editing the text and media that go to every selected channel.',
  },
  {
    name: 'Change one network where it needs it',
    text: 'Click a channel avatar and choose Edit content. That network gets its own copy you can shorten, split into a thread or give other images. The rest keep the shared version. Back to global throws the custom copy away, so Hookpost asks first.',
  },
  {
    name: 'Fill in network settings',
    text: 'Some networks need more than text: a title and visibility on YouTube, a board on Pinterest, at least one image or video on Instagram. The editor asks for them per channel.',
  },
  {
    name: 'Preview and schedule',
    text: 'Check the per-network preview, pick a date and time and add it to the calendar. Each channel is checked against its own limits first; if one fails, the warning names that network and takes you to it.',
  },
];

const EXAMPLE: { network: string; rule: string; text: string }[] = [
  {
    network: 'LinkedIn (3,000 characters)',
    rule: 'Room for context. Lead with the outcome, put the link at the end.',
    text: `We rebuilt our export screen. Reports that took four clicks now take one, and CSV files open cleanly in Excel and Google Sheets.

Three things changed:
- one Export button on every report
- dates in your own time zone
- column names you can rename before downloading

It's live for every account today. Details and screenshots: example.com/changelog`,
  },
  {
    network: 'X thread (280 per post, links count as 23)',
    rule: 'Split it. First post carries the news, replies carry the detail.',
    text: `1/ Exports got simpler: one button on every report, CSVs that open cleanly in Excel and Sheets.

2/ Dates now follow your time zone, and you can rename columns before you download.

3/ Live for everyone today. Screenshots: example.com/changelog`,
  },
  {
    network: 'Bluesky (300, links count in full)',
    rule: 'One post. A long link eats the budget, so use a short one.',
    text: `Exports got simpler: one button on every report, dates in your time zone, and CSVs that open cleanly in Excel and Sheets. Live today. example.com/changelog`,
  },
  {
    network: 'Instagram (2,200, media required)',
    rule: 'No clickable links in captions, so point to the bio. Needs at least one image; a carousel takes up to 10.',
    text: `One button. Every report. ✅
Swipe to see the new export screen →
Changelog link in bio.`,
  },
];

const FAQ = [
  {
    q: 'Is there a way to post to all social media at once?',
    a: `Yes, with a scheduler that connects to each network. In Hookpost you select several channels on one post and it publishes to all of them at the time you set. It supports ${PUBLISHABLE_CHANNEL_COUNT} networks, each checked against its own limits before the post is queued.`,
  },
  {
    q: 'Should I post the exact same caption everywhere?',
    a: 'Only when it fits every network’s rules. A 600-character LinkedIn post will not fit X (280) or Bluesky (300), and Instagram will not post text without an image. Write one shared version and give the short networks their own copy.',
  },
  {
    q: 'Can I post to Instagram, Facebook and LinkedIn at the same time?',
    a: 'Yes. Select all three channels on one post. Instagram needs a Business or Creator account and at least one image or video, Facebook posts go to a Page rather than a personal profile, and LinkedIn posts go to your personal profile.',
  },
  {
    q: 'Does posting to five networks count as one post or five?',
    a: offer(
      `Five. Each network is a separate post toward the monthly limit, so the Free plan’s ${FREE.posts_per_month} posts cover ${Math.floor(FREE.posts_per_month / (FREE.channel || 1))} updates to ${FREE.channel} channels.`,
      `Five. Each network is a separate post toward the monthly limit, so Hookpost’s ${HOOKPOST.posts_per_month} posts cover ${Math.floor(HOOKPOST.posts_per_month / (HOOKPOST.channel || 1))} updates to all ${HOOKPOST.channel} of its channels.`
    ),
  },
  {
    q: offer('Is there a free way to cross-post?', 'Can I try cross-posting before paying?'),
    a: `${offer(`Hookpost’s Free plan connects ${FREE.channel} channels with ${FREE.posts_per_month} posts a month, enough to cross-post between two networks.`, `Yes. ${TRIAL_SENTENCE}`)} Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels.`,
  },
  {
    q: 'Can a script or an AI agent post to several networks in one go?',
    a: 'Yes. One request to the REST API can carry a separate entry per channel, the hookpost CLI takes a list of channels (--channel abc123,def456), and the MCP schedule tool accepts several channels in one call, so Claude or Cursor can do it from a single prompt. All three need an API key, ' + offer('which every paid plan includes and the Free plan does not.', `which every plan includes, the ${FREE_POSTS} too.`),
  },
];

export const metadata: Metadata = withSocial({
  title: 'How to Post to Multiple Social Media at Once | Hookpost',
  description: `Write once and publish everywhere without breaking any network's rules: text and media limits for ${PUBLISHABLE_CHANNEL_COUNT} networks, and how to adapt one post for each.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'How to post to multiple social media platforms at once',
    description: `The limits ${PUBLISHABLE_CHANNEL_COUNT} networks enforce, and a worked example of one post adapted for LinkedIn, X, Bluesky and Instagram.`,
    url: CANONICAL,
    type: 'article',
  },
});

const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-hp-primary-text underline">
    {children}
  </Link>
);

export default function PostToMultipleGuide() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${CANONICAL}#article`,
        headline: 'How to post to multiple social media platforms at once',
        url: CANONICAL,
        inLanguage: 'en',
        datePublished: PUBLISHED,
        dateModified: PUBLISHED,
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/about' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
      },
      {
        '@type': 'HowTo',
        '@id': `${CANONICAL}#howto`,
        name: 'How to post one update to several social networks at once with Hookpost',
        step: STEPS.map((s, i) => ({ '@type': 'HowToStep', position: i + 1, name: s.name, text: s.text })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: 'https://hookpost.hookstep.in/guides' },
          { '@type': 'ListItem', position: 3, name: 'Post to multiple social media at once', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <nav aria-label="Breadcrumb" className="text-sm text-hp-text/50">
          <Link href="/guides" className="hover:text-hp-primary-text">Guides</Link> / Cross-posting
        </nav>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          How to post to multiple social media platforms at once
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Write the post once, give the networks with tight limits their own shorter copy, and schedule all of them together. The
          part that goes wrong is pasting one text everywhere: X stops at 280 characters, Bluesky at 300, Instagram will not post
          without an image and YouTube wants a video and a title. Below are the exact limits for {PUBLISHABLE_CHANNEL_COUNT} networks,
          as Hookpost enforces them, and one announcement adapted four ways.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer(`Try it free on ${FREE.channel} channels`, TRIAL_CTA)}
          </Link>
          <Link href="/tools/character-counter" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Check a post against every limit
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10" aria-labelledby="limits">
        <h2 id="limits" className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
          What breaks when you paste the same post everywhere
        </h2>
        <p className="mt-4 max-w-[70ch] text-hp-text/70">
          These are the limits Hookpost checks before a post is queued, per network. The same table drives the{' '}
          <A href="/channels">channel pages</A>.
        </p>
        <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <caption className="sr-only">Text and media limits per social network</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                <th scope="col" className="py-3 pe-4 font-semibold">Network</th>
                <th scope="col" className="py-3 pe-4 font-semibold">Text limit</th>
                <th scope="col" className="py-3 pe-4 font-semibold">Media and format rules</th>
                <th scope="col" className="py-3 font-semibold">Connects with</th>
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              {ROWS.map((r) => (
                <tr key={r.slug} className="border-b border-hp-border align-top">
                  <th scope="row" className="py-3 pe-4 font-bold text-hp-text">
                    <Link href={`/channels/${r.slug}`} className="hover:text-hp-primary-text">{r.name}</Link>
                  </th>
                  <td className="py-3 pe-4">{r.limit}</td>
                  <td className="py-3 pe-4">{r.rules.join('. ')}</td>
                  <td className="py-3">{r.auth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <h3 className="mt-10 text-xl font-bold font-jakarta">Characters are not counted the same way everywhere</h3>
        <ul className="mt-4 flex max-w-[75ch] list-disc flex-col gap-2 ps-6 text-hp-text/75">
          <li>
            <strong className="text-hp-text">X</strong> weights its count: every link is 23 characters whatever its length, and most
            emoji count as 2. The <A href="/tools/x-character-counter">X character counter</A> uses the same rules.
          </li>
          <li>
            <strong className="text-hp-text">Threads</strong> is checked in bytes, not letters. English text gets close to 500
            characters, but Hindi in Devanagari takes 3 bytes a letter, so a Hindi Threads post stops at about 166 characters.
          </li>
          <li>
            <strong className="text-hp-text">Bluesky and the rest</strong> count characters as written, so a long link costs its full
            length on Bluesky. Shorten it, or keep the link for LinkedIn and X.
          </li>
        </ul>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Doing it in Hookpost, step by step</h2>
          <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-4 ps-6 text-hp-text/80">
            {STEPS.map((s) => (
              <li key={s.name}>
                <strong className="text-hp-text">{s.name}.</strong> {s.text}
              </li>
            ))}
          </ol>
          <p className="mt-6 max-w-[70ch] text-hp-text/60">
            Two networks with their own guides: <A href="/guides/cross-post-x-bluesky">X and Bluesky together</A>, and{' '}
            <A href="/guides/cross-post-dev-articles">one article to Dev.to, Hashnode and WordPress</A> with canonical links.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Worked example: one announcement, four networks</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/70">
            A made-up product update, written once for LinkedIn and then cut down for the others. Each version stays inside its
            network&apos;s limit.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {EXAMPLE.map((e) => (
              <div key={e.network} className="min-w-0 rounded-2xl border border-hp-border p-5">
                <h3 className="font-bold font-jakarta text-hp-text">{e.network}</h3>
                <p className="mt-2 text-sm text-hp-text/60">{e.rule}</p>
                <pre className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-white/[0.04] p-3 font-sans text-sm leading-relaxed text-hp-text/85">
                  {e.text}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">From a script or an AI agent</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            The REST API takes one request with an entry per channel, each with its own text, so a release script can send the
            LinkedIn and X versions together. The MCP server does the same for Claude, Cursor and other AI assistants, which also
            read each network&apos;s limits before writing. Both are on the Hookpost plan.
          </p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {[
              ['Scheduling API with curl examples', '/social-media-scheduling-api'],
              ['Post from Claude Code', '/guides/claude-code-social-media'],
              ['MCP setup for every client', '/mcp'],
              ['n8n workflows', '/integrations/n8n'],
            ].map(([label, href]) => (
              <li key={href}>
                <Link href={href} className="inline-block rounded-full border border-hp-border-strong px-4 py-2 text-sm hover:border-hp-primary">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">{offer('What the free plan covers', 'What the plans cover')}</h2>
          <p className="mt-4 max-w-[70ch] text-hp-text/75">
            {offer(
              <>
                The Free plan connects {FREE.channel} channels and allows {FREE.posts_per_month} posts a month, with no card. Every network a
                post goes to counts as one post, so cross-posting to both channels uses 2 each time. Hookpost is{' '}
                {planPrice('HOOKPOST', ' a month')} for {HOOKPOST.channel} channels and {HOOKPOST.posts_per_month} posts,{' '}
                {usdCopy('billed in rupees with UPI Autopay', 'billed in US dollars by card, or in India in rupees with UPI Autopay')}. <A href="/free-social-media-scheduler">What the free plan includes</A>.
              </>,
              <>
                Every network a post goes to counts as one post, so cross-posting to two channels uses 2 each time. Hookpost is{' '}
                {planPrice('HOOKPOST', ' a month')} for {HOOKPOST.channel} channels and {HOOKPOST.posts_per_month} posts,{' '}
                {usdCopy('billed in rupees with UPI Autopay', 'billed in US dollars by card, or in India in rupees with UPI Autopay')}. {TRIAL_SENTENCE} <A href="/pricing">Pricing</A>.
              </>
            )}
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Questions</h2>
          <dl className="mt-8 flex flex-col gap-8">
            {FAQ.map((f) => (
              <div key={f.q} className="min-w-0">
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
