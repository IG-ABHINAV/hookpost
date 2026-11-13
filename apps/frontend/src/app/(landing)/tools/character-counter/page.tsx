import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../../site-nav';
import { CharacterCounter } from './counter';
import { COUNTER_NETWORKS } from './networks';
import { withSocial } from '../../social-meta';
import { ScheduleLink } from '../_lib/tool-page';
import { FREE_POSTS } from '../../trial-offer';

// Free tool page. Targets "character counter for X / LinkedIn / Instagram",
// "tweet character counter", "social media character limits". Runs entirely in
// the browser, so it costs nothing to serve beyond the static page.
const CANONICAL = 'https://hookpost.hookstep.in/tools/character-counter';

const FAQ = [
  {
    q: 'What is the character limit on X (Twitter)?',
    a: '280 characters for a standard account and 25,000 on X Premium (Hookpost schedules Premium posts up to 4,000). X counts every link as 23 characters and every emoji as 2. Chinese, Japanese and Korean characters also count as 2; Hindi counts as 1 per character.',
  },
  {
    q: 'What is the LinkedIn post character limit?',
    a: 'LinkedIn posts allow up to 3,000 characters. Only the first two or three lines show before "see more", so put the point first.',
  },
  {
    q: 'What is the Instagram caption limit?',
    a: 'Instagram captions allow up to 2,200 characters.',
  },
  {
    q: 'What are the Bluesky and Threads limits?',
    a: 'Bluesky allows 300 characters per post and Threads allows 500.',
  },
  {
    q: 'Does this tool store what I type?',
    a: 'No. The counting runs in your browser and nothing you type is sent to Hookpost.',
  },
];

export const metadata: Metadata = withSocial({
  title: 'Character Counter for X, LinkedIn & Instagram | Hookpost',
  description:
    'Free character counter: see characters left on X, LinkedIn, Instagram, Threads, Bluesky and YouTube as you type. Counts links and emoji the way X does.',
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Free social media character counter',
    description: 'See characters left on X, LinkedIn, Instagram, Threads, Bluesky and more as you type.',
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Social media character counter' }],
  },
});

export default function CharacterCounterPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': `${CANONICAL}#tool`,
        name: 'Social media character counter',
        url: CANONICAL,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Any',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
        publisher: { '@type': 'Organization', name: 'Hookpost', url: 'https://hookpost.hookstep.in/' },
      },
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Character counter', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1200px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Free tool</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Social media character counter
        </h1>
        <p className="mt-4 max-w-[70ch] text-lg text-hp-text/70">
          This character counter shows how many characters you have left on every network at once: type or paste a post
          to see it. X is counted the way X counts it: links as 23 characters and emoji as 2.
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1200px] px-5 py-10 sm:px-10">
        <CharacterCounter />
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Character limits by network</h2>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[480px] border-collapse text-left text-sm">
              <caption className="sr-only">Character limit per social network</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Network</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Limit</th>
                  <th scope="col" className="py-3 font-semibold">Notes</th>
                </tr>
              </thead>
              <tbody>
                {COUNTER_NETWORKS.map((n) => (
                  <tr key={n.key} className="border-b border-hp-border">
                    <th scope="row" className="py-3 pe-4 font-semibold">
                      <Link href={`/channels/${n.key}`} className="hover:text-hp-primary-text">{n.name}</Link>
                    </th>
                    <td className="py-3 pe-4 tabular-nums text-hp-text/80">{n.limit.toLocaleString()}</td>
                    <td className="py-3 text-hp-text/60">{n.note || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 max-w-[70ch] text-hp-text/70">
            Posting the same message everywhere? Hookpost checks each network&apos;s limit before a post is scheduled and lets you
            write a shorter version per network, so the X copy can be 280 characters while the LinkedIn copy runs longer.{' '}
            <ScheduleLink free="Schedule posts free" trial={`Start ${FREE_POSTS}`} />. Media rules too (Instagram
            needs an image, YouTube a video, Bluesky takes four images):{' '}
            <Link href="/guides/post-to-multiple-social-media-at-once" className="text-hp-primary-text underline">every network&apos;s limits</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
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
