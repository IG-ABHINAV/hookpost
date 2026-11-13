import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteNav } from '../../site-nav';
import { withSocial } from '../../social-meta';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { CalendarRow } from '../calendar-data';
import { FESTIVALS, FestivalPage, festivalBySlug, rowFor } from '../festivals';
import { FREE_POSTS, offer, TRIAL_CTA } from '../../trial-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// Spokes of /social-media-calendar-india: one festival per page, every date
// read from calendar-data.ts through festivals.ts. Server-rendered, no client JS.
const HUB = 'https://hookpost.hookstep.in/social-media-calendar-india';
const { FREE, HOOKPOST } = pricingINR;

export const dynamicParams = false;

export function generateStaticParams() {
  return FESTIVALS.map((f) => ({ festival: f.slug }));
}

const LONG = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
const SHORT = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// ' (subject to moon sighting)' or ', subject to moon sighting' inside the row's
// parentheses: the sentence says it once, in words.
const MOON = / \(subject to moon sighting\)|, subject to moon sighting/;

// "Diwali 2026 is on Sunday, 8 November 2026, a gazetted holiday on the
// Government of India's (DoPT) list." Lunar Islamic dates are stated as
// expected, since the list itself says they depend on the moon sighting.
const dateSentence = (f: FestivalPage, row: CalendarRow) => {
  const moon = row.occasion.includes('moon sighting');
  const kind = row.kind === 'Gazetted holiday' ? 'a gazetted holiday' : 'a restricted holiday';
  return moon
    ? `${f.name}: ${row.occasion.replace(MOON, '')} is expected on ${LONG(row.date)}, subject to moon sighting, ${kind} on the Government of India's (DoPT) list.`
    : `${f.name} is on ${LONG(row.date)}, ${kind} on the Government of India's (DoPT) list.`;
};

const alsoSentence = (row: CalendarRow) =>
  `${row.occasion.replace(MOON, '')} is ${
    row.occasion.includes('moon sighting') ? 'expected on ' : 'on '
  }${LONG(row.date)}.`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ festival: string }>;
}): Promise<Metadata> {
  const { festival } = await params;
  const f = festivalBySlug(festival);
  if (!f) return {};
  return withSocial({
    title: { absolute: f.title },
    description: f.description,
    alternates: { canonical: `${HUB}/${f.slug}` },
  });
}

export default async function FestivalPageView({
  params,
}: {
  params: Promise<{ festival: string }>;
}) {
  const { festival } = await params;
  const f = festivalBySlug(festival);
  if (!f) notFound();

  const main = rowFor(f.main);
  const also = f.alsoMain ? rowFor(f.alsoMain) : null;
  const rows = [main, ...(also ? [also] : []), ...f.related.map(rowFor)].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  const canonical = `${HUB}/${f.slug}`;
  const others = FESTIVALS.filter((o) => o.slug !== f.slug);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        '@id': `${canonical}#article`,
        headline: `${f.name}: date and social media post ideas`,
        description: f.description,
        inLanguage: 'en-IN',
        datePublished: '2026-10-16T00:00:00+05:30',
        image: 'https://hookpost.hookstep.in/og-image.png',
        author: { '@type': 'Organization', '@id': 'https://hookpost.hookstep.in/#organization', name: 'Hookpost' },
        publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
        mainEntityOfPage: canonical,
        isPartOf: { '@id': `${HUB}#article` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Social media calendar India', item: HUB },
          { '@type': 'ListItem', position: 3, name: f.name, item: canonical },
        ],
      },
    ],
  };

  const cell = 'py-3 pe-4 align-top';
  const link = 'text-hp-primary-text underline';
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">
          <Link href="/social-media-calendar-india" className="hover:underline">
            Social media calendar for India
          </Link>
        </p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          {f.name}: date and social media post ideas
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          {dateSentence(f, main)} {also ? `${alsoSentence(also)} ` : ''}{f.context}
        </p>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-12 sm:px-10" aria-labelledby="dates">
        <h2 id="dates" className="text-2xl font-extrabold tracking-tight font-jakarta">
          Dates around {f.name}
        </h2>
        <div className="mt-4 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <caption className="sr-only">Social media dates around {f.name}</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                <th scope="col" className="py-3 pe-4 font-semibold">Date</th>
                <th scope="col" className="py-3 pe-4 font-semibold">Occasion</th>
                <th scope="col" className="py-3 font-semibold">Post idea</th>
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              {rows.map((r) => (
                <tr key={r.date + r.occasion} className="border-b border-hp-border">
                  <td className={`${cell} whitespace-nowrap`}>
                    <span className="font-semibold text-hp-text">{SHORT(r.date)}</span>
                    <span className="block text-xs text-hp-text/50">{r.weekday}</span>
                  </td>
                  <th scope="row" className={`${cell} font-semibold text-hp-text`}>
                    {r.occasion}
                    <span className="block text-xs font-normal text-hp-text/50">{r.kind}</span>
                  </th>
                  <td className="py-3 align-top">{r.idea}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-12 sm:px-10" aria-labelledby="ideas">
        <h2 id="ideas" className="text-2xl font-extrabold tracking-tight font-jakarta">
          Five post ideas for {f.name}
        </h2>
        <ol className="mt-6 flex max-w-[75ch] list-decimal flex-col gap-5 ps-5">
          {f.ideas.map((idea) => (
            <li key={idea.title}>
              <h3 className="text-lg font-bold font-jakarta">{idea.title}</h3>
              <p className="mt-1 text-hp-text/75">{idea.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-12 sm:px-10" aria-labelledby="when">
        <h2 id="when" className="text-2xl font-extrabold tracking-tight font-jakarta">
          When to schedule
        </h2>
        <ul className="mt-6 flex max-w-[75ch] list-disc flex-col gap-3 ps-5 text-hp-text/80">
          {f.timing.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="mt-6 max-w-[75ch] text-hp-text/70">
          Hookpost schedules the same post to several networks at the time you pick, in India time.{' '}
          {/* No Free plan for new users once the trial cutoff is set: the
              free-plan page then redirects to /pricing, so it is neither linked
              nor promised (same rule as the hub, via offer()). */}
          {offer(
            <>
              The <Link href="/free-social-media-scheduler" className={link}>free plan</Link> covers {FREE.channel} channels and{' '}
              {FREE.posts_per_month} posts a month.
            </>,
            <>
              Hookpost is {HOOKPOST_DISPLAY_PRICE} a month for {HOOKPOST.channel} channels, and new workspaces get{' '}
              <Link href="/pricing" className={link}>{FREE_POSTS}</Link> first, no card needed.
            </>
          )}{' '}
          Using Instagram, Facebook or YouTube&apos;s own scheduler instead? The{' '}
          <Link href="/guides/social-media-post-schedule-kaise-kare" className={link}>step-by-step guide in Hinglish</Link>{' '}
          covers each one.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Schedule it free', TRIAL_CTA)}
          </Link>
          <Link href="/social-media-calendar-india" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Full 2026-27 calendar
          </Link>
        </div>
        <p className="mt-8 max-w-[75ch] text-sm text-hp-text/55">
          Dates are from the Government of India, Department of Personnel &amp; Training, holiday lists for 2026 and 2027
          (gazetted and restricted holidays for offices in Delhi/New Delhi). Restricted holidays vary by state, and lunar
          festivals can fall a day apart by region. The full list, with sources and a CSV and calendar download, is on the{' '}
          <Link href="/social-media-calendar-india" className={link}>social media calendar for India</Link>.
        </p>
      </section>

      <nav aria-label="Other festivals" className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-10 sm:px-10">
          <h2 className="text-sm font-bold uppercase tracking-wider text-hp-text/60">Other festivals</h2>
          <ul className="mt-4 flex flex-wrap gap-2">
            {others.map((o) => (
              <li key={o.slug}>
                <Link
                  href={`/social-media-calendar-india/${o.slug}`}
                  className="inline-block rounded-full border border-hp-border-strong px-3 py-1.5 text-sm text-hp-text/75 hover:border-hp-primary hover:text-hp-text"
                >
                  {o.name}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </div>
  );
}
