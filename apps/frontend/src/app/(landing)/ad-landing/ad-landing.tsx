import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { PUBLISHABLE_CHANNEL_COUNT } from '../channels/channel-count';
import { PUBLISHED_CHECKED, publishedList } from '../channels/published-networks';
import { COMPETITOR_FACTS, FACTS_CHECKED, priceAmount } from '../compare/competitor-facts';
import { FREE_POSTS, offer, TRIAL_CTA } from '../trial-offer';
import { USD_HOOKPOST_MONTH, usdCopy, usdOffers } from '../usd-offer';
import { MCP_TRIAL_TERMS } from '../mcp/trial-terms';
import { TrialTerms, VisitorCurrencyProvider } from '../mcp/trial-terms.client';
import { TrialCta } from './trial-cta.client';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

/**
 * The landing pages the paid ads link to: /claude, /cli and /start. One page
 * per ad message, so the page opens on the outcome the ad promised ("We gave
 * Claude one sentence. It drafted a week of posts"), shows the real run, and
 * has one call to action, the trial, with its card/UPI terms right under it
 * in the visitor's currency.
 *
 * What every claim rests on, so it is checked before it changes:
 * - The video is the 22 Oct 2026 face ad (hookpost-face-9x16, round 5: no
 *   trial length in it), 720p for the web. Its screen is a real `claude -p`
 *   session from 21 Oct 2026, replayed from its log at 37x and labelled so:
 *   one prompt plus a notes file, 21 drafts, one a day at 9:00 IST on
 *   LinkedIn, Threads and Facebook for 9-15 Nov. The drafts were deleted
 *   after the recording. Its terminal shots are real CLI output, sped up.
 * - The networks are those that published in production in the 30 days to
 *   PUBLISHED_CHECKED (channels/published-networks.ts), not all that connect.
 * - Competitor prices come from competitor-facts.ts only; Hookpost's from
 *   pricing.ts. The structured data offers match pricing.ts.
 * - "We built", never "I built": the site credits Mohan Bhanushali, and
 *   nothing on the page says who "I" would be, so the headline says "We". No
 *   ChatGPT: no connector has been set up. Hosted only; nothing here says
 *   open source.
 */

export const ORIGIN = 'https://hookpost.hookstep.in';
export const VIDEO = {
  src: '/video/hookpost-claude-run-9x16.mp4',
  poster: '/video/hookpost-claude-run-9x16.jpg',
  width: 720,
  height: 1280,
  durationIso: 'PT27S',
  // A full ISO 8601 instant with an offset, not a bare date: Google reads
  // VideoObject.uploadDate as a datetime and rejects one with no time zone
  // (see schema-datetime.ts). +05:30 is IST, where the site is operated. The
  // date is the observed one; 10:00 is a chosen hour, since the property needs
  // a time and nothing recorded the real minute.
  uploadDate: '2026-10-22T10:00:00+05:30',
};

export const HEADLINE = 'We gave Claude one sentence. It drafted a week of posts.';
export const LEDE =
  'One prompt and a notes file. Claude Code read the notes, checked each network’s limits through Hookpost, and saved 21 drafts into the Hookpost calendar: one a day on LinkedIn, Threads and Facebook for 9–15 November. The video is that session, replayed from its log.';

export interface AdPage {
  /** /claude, /cli or /start. */
  path: string;
  kicker: string;
  /** <title>, short: the layout adds nothing. */
  title: string;
  description: string;
  /** The page's own section, under the hero. */
  howTitle: string;
  how: ReactNode;
  /** The page's line in the JSON-LD and llms.txt. */
  summary: string;
}

const { HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;

export const adMetadata = (page: AdPage): Metadata =>
  withSocial({
    title: page.title,
    description: page.description,
    alternates: { canonical: `${ORIGIN}${page.path}` },
    openGraph: {
      title: page.title,
      description: page.description,
      url: `${ORIGIN}${page.path}`,
      type: 'website',
      images: [{ url: `${ORIGIN}${VIDEO.poster}`, width: 540, height: 960 }],
      videos: [{ url: `${ORIGIN}${VIDEO.src}`, width: VIDEO.width, height: VIDEO.height, type: 'video/mp4' }],
    },
  });

/** Rows of the price comparison: competitor-facts.ts, then Hookpost from pricing.ts. */
export function priceRows() {
  const vendor = (slug: string) => {
    const c = COMPETITOR_FACTS[slug];
    const p = c.cheapestPaid!;
    const per = p.per.replace('/month', '').replace('month', '');
    return {
      name: c.name,
      plan: p.name || '',
      price: `$${priceAmount(p)} ${per ? `per ${per} ` : ''}a month${p.billing === 'annual' ? ', billed yearly' : ''}`,
      channels: p.channelsIncluded,
    };
  };
  return [
    vendor('hootsuite'),
    vendor('sprout-social'),
    vendor('buffer'),
    vendor('postiz'),
    {
      name: 'Hookpost',
      plan: 'Hookpost',
      // Billed monthly only, as the terms under the button say
      // (mcp/trial-terms.ts): there is no yearly price.
      price: usdCopy(
        `${HOOKPOST_DISPLAY_PRICE} a month, billed monthly`,
        `${USD_HOOKPOST_MONTH} a month, billed monthly (${HOOKPOST_DISPLAY_PRICE} a month in India)`
      ),
      channels: HOOKPOST.channel ?? null,
    },
  ];
}

export const videoCaption = usdCopy(
  `A real Claude Code session from 21 October 2026, replayed from its log at 37× speed; the terminal shots are real CLI output, sped up. The video quotes US-dollar prices: Hookpost bills in rupees, and Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month.`,
  `A real Claude Code session from 21 October 2026, replayed from its log at 37× speed; the terminal shots are real CLI output, sped up. The video quotes US-dollar prices; in India Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month.`
);

export function adJsonLd(page: AdPage) {
  const url = `${ORIGIN}${page.path}`;
  const inrOffer = {
    '@type': 'Offer',
    name: 'Hookpost plan',
    price: String(HOOKPOST_PRICE.displayUsd),
    priceCurrency: 'USD',
  };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${url}#page`,
        url,
        name: page.title,
        description: page.summary,
        isPartOf: { '@id': `${ORIGIN}/#website` },
        primaryImageOfPage: `${ORIGIN}${VIDEO.poster}`,
        video: { '@id': `${url}#video` },
      },
      {
        '@type': 'VideoObject',
        '@id': `${url}#video`,
        name: HEADLINE,
        description: LEDE,
        thumbnailUrl: `${ORIGIN}${VIDEO.poster}`,
        contentUrl: `${ORIGIN}${VIDEO.src}`,
        uploadDate: VIDEO.uploadDate,
        duration: VIDEO.durationIso,
        width: VIDEO.width,
        height: VIDEO.height,
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${url}#app`,
        name: 'Hookpost',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web',
        url: ORIGIN,
        publisher: { '@id': `${ORIGIN}/#organization` },
        offers: usdCopy(inrOffer, [
          inrOffer,
          ...usdOffers(['HOOKPOST']).map((o) => ({ ...o, name: 'Hookpost plan' })),
        ]),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: page.kicker, item: url },
        ],
      },
    ],
  };
}

export const Code = ({ children }: { children: string }) => (
  <pre className="mt-3 overflow-x-auto rounded-xl border border-hp-border bg-hp-surface p-4 text-xs leading-relaxed font-mono text-hp-text/85">
    {children}
  </pre>
);

export const A = ({ href, children }: { href: string; children: ReactNode }) => (
  <Link href={href} className="text-hp-primary-text underline">
    {children}
  </Link>
);

const ctaLabel = offer('Start free', TRIAL_CTA);

export function AdLanding({ page }: { page: AdPage }) {
  const rows = priceRows();
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(adJsonLd(page)) }} />
      <SiteNav />
      <VisitorCurrencyProvider ask={!!MCP_TRIAL_TERMS?.usd}>
        <section className="mx-auto grid w-full max-w-[1100px] gap-10 px-5 pt-12 sm:px-10 md:grid-cols-[minmax(0,1fr)_320px] md:items-start md:pt-16">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">{page.kicker}</p>
            <h1 className="mt-3 text-left text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">{HEADLINE}</h1>
            <p className="mt-5 max-w-[60ch] text-lg text-hp-text/75">{LEDE}</p>
            <div className="mt-8">
              <TrialCta
                label={ctaLabel}
                className="inline-block rounded-full bg-hp-primary px-7 py-3.5 text-lg font-semibold text-hp-on-primary hover:opacity-90"
              />
              {MCP_TRIAL_TERMS ? (
                <p className="mt-4 max-w-[60ch] text-sm text-hp-text/65" data-testid="trial-terms">
                  <TrialTerms {...MCP_TRIAL_TERMS} lines={[6, 4, 3]}>
                    {' '}
                    <A href="/cancellation-policy">How to cancel</A>
                  </TrialTerms>
                </p>
              ) : null}
            </div>
          </div>
          <figure className="mx-auto w-full max-w-[320px]">
            <video
              controls
              playsInline
              preload="none"
              poster={VIDEO.poster}
              width={VIDEO.width}
              height={VIDEO.height}
              className="h-auto w-full rounded-2xl border border-hp-border bg-hp-surface"
              aria-label="Claude drafts a week of posts in Hookpost: a real session, replayed"
            >
              <source src={VIDEO.src} type="video/mp4" />
            </video>
            <figcaption className="mt-3 text-xs text-hp-text/50">{videoCaption}</figcaption>
          </figure>
        </section>

        <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">{page.howTitle}</h2>
          <div className="mt-4 max-w-[75ch] text-hp-text/75">{page.how}</div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Where it publishes</h2>
            <p className="mt-4 max-w-[70ch] text-hp-text/75" data-testid="published-networks">
              In the 30 days to {PUBLISHED_CHECKED}, Hookpost published posts to {publishedList}.{' '}
              <A href="/channels">{PUBLISHABLE_CHANNEL_COUNT} networks can be connected</A> in all.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What it costs, next to the usual tools</h2>
            {/* Wraps instead of scrolling sideways: four short columns fit a 375px phone. */}
            <div className="mt-6">
              <table className="w-full border-collapse text-left text-xs sm:text-sm" data-testid="price-table">
                <caption className="sr-only">Entry plan prices</caption>
                <thead>
                  <tr className="border-b border-hp-border-strong text-hp-text/60">
                    <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                    <th scope="col" className="py-3 pe-4 font-semibold">Entry plan</th>
                    <th scope="col" className="py-3 pe-4 font-semibold">Price</th>
                    <th scope="col" className="py-3 font-semibold">Channels</th>
                  </tr>
                </thead>
                <tbody className="text-hp-text/80">
                  {rows.map((r) => (
                    <tr key={r.name} className={'border-b border-hp-border ' + (r.name === 'Hookpost' ? 'text-hp-text' : '')}>
                      <th scope="row" className="py-3 pe-4 font-semibold">{r.name}</th>
                      <td className="py-3 pe-4">{r.plan}</td>
                      <td className="py-3 pe-4">{r.price}</td>
                      <td className="py-3">{r.channels ?? 'not stated'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 max-w-[75ch] text-sm text-hp-text/55">
              Other tools&apos; prices are their US-dollar entry prices as each vendor&apos;s pricing page showed them on{' '}
              {FACTS_CHECKED}; some show other prices in other countries. Hookpost includes the MCP server, the REST API
              and the CLI. Every limit: <A href="/pricing">pricing</A>.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border bg-white/[0.015]">
          <div className="mx-auto flex w-full max-w-[1100px] flex-col items-start gap-4 px-5 py-14 sm:px-10">
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">
              {offer('Try it on your own channels', `Try ${FREE_POSTS} on your own channels`)}
            </h2>
            <TrialCta
              label={ctaLabel}
              className="inline-block rounded-full bg-hp-primary px-7 py-3.5 text-lg font-semibold text-hp-on-primary hover:opacity-90"
            />
            {MCP_TRIAL_TERMS ? (
              <p className="max-w-[60ch] text-sm text-hp-text/65">
                <TrialTerms {...MCP_TRIAL_TERMS} pending={`New workspaces get ${FREE_POSTS}, no card needed.`} />
              </p>
            ) : null}
          </div>
        </section>
      </VisitorCurrencyProvider>
    </div>
  );
}
