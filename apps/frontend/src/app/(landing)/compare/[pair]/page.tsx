import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteNav } from '../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { CHANNEL_SPECS } from '../../channels/channel-specs';
import { COMPETITOR_FACTS, CompetitorFacts, FACTS_CHECKED, MIXPOST_CLOUD, PAIRS, isIndexedPair, priceAmount } from '../competitor-facts';
import { withSocial } from '../../social-meta';
import { FREE_POSTS, offer, TRIAL_ROW } from '../../trial-offer';
import { USD_HOOKPOST_MONTH, planPrice, usdCopy } from '../../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// "<A> vs <B>" pages for two third-party tools, e.g. /compare/buffer-vs-hootsuite.
// People search these far more than "<A> alternative", and AI answers cite a
// neutral side-by-side. Every figure comes from competitor-facts.ts, which was
// read off each vendor's own pricing page on FACTS_CHECKED, with the source URL
// shown on the page. Hookpost appears as a third column, never as the winner of
// a row it does not actually win.

const BASE = 'https://hookpost.hookstep.in/compare';
const { FREE, HOOKPOST } = pricingINR;
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
// Hookpost is quoted in rupees while rupees are all it sells; once dollars
// are sold too (usd-offer.ts), in dollars with the rupee price for India
// beside it. The two competitors are quoted as their pricing pages show them, and
// dollars are never converted to rupees, so no sentence below draws a
// "cheaper" verdict across currencies.

const split = (pair: string): [CompetitorFacts, CompetitorFacts] | null => {
  if (!PAIRS.includes(pair)) return null;
  const [a, b] = pair.split('-vs-');
  const A = COMPETITOR_FACTS[a];
  const B = COMPETITOR_FACTS[b];
  return A && B ? [A, B] : null;
};

const priceText = (c: CompetitorFacts) => {
  const p = c.cheapestPaid;
  if (!p) return 'Not published';
  const sym = p.currency === 'USD' ? '$' : p.currency === 'EUR' ? '€' : p.currency === 'INR' ? '₹' : `${p.currency} `;
  if (p.billing === 'one-time') return `${sym}${priceAmount(p)} one-time, ${p.per}`;
  return `${sym}${priceAmount(p)} per ${p.per.replace('/month', ' per month')}${p.billing === 'annual' ? ', billed annually' : ''}`;
};

const freeText = (c: CompetitorFacts) =>
  c.freePlan ? c.freePlan : c.freeTrialDays ? `No free plan (${c.freeTrialDays}-day trial)` : 'No free plan';

const yesNo = (v: boolean | null | undefined, yes = 'Yes', no = 'No') =>
  v == null ? 'Not stated' : v ? yes : no;

export function generateStaticParams() {
  return PAIRS.map((pair) => ({ pair }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pair: string }>;
}): Promise<Metadata> {
  const { pair } = await params;
  const both = split(pair);
  if (!both) return {};
  const [A, B] = both;
  const title = `${A.name} vs ${B.name}: Pricing, Free Plan & Features (2026)`;
  const description = `${A.name} vs ${B.name} compared side by side: cheapest plan, free plan, pricing model, API and AI-agent support, read from each vendor's pricing page.`;
  return withSocial({
    title,
    description,
    alternates: { canonical: `${BASE}/${pair}` },
    // Two third-party tools and no Hookpost in the pair: kept out of the index
    // until a slug is added to INDEXED_COMPARE_PAIRS in competitor-facts.ts.
    // `follow` stays on so the links on the page still pass through.
    ...(isIndexedPair(pair) ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      title,
      description,
      url: `${BASE}/${pair}`,
      siteName: 'Hookpost',
      type: 'article',
      images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: title }],
    },
    twitter: { card: 'summary_large_image', title, description, images: ['https://hookpost.hookstep.in/og-image.png'] },
  });
}

export default async function ComparePairPage({
  params,
}: {
  params: Promise<{ pair: string }>;
}) {
  const { pair } = await params;
  const both = split(pair);
  if (!both) notFound();
  const [A, B] = both;

  // Row-by-row facts. The verdict is built from these, so it can only say what
  // the table says.
  const rows: [string, string, string, string][] = [
    ['Cheapest paid plan', priceText(A), priceText(B), planPrice('HOOKPOST', ' per month flat')],
    ['Pricing model', A.pricingModel || 'Not stated', B.pricingModel || 'Not stated', 'Flat tiers, no per-channel fee'],
    ['Free plan', freeText(A), freeText(B), offer(`${FREE.channel} channels, ${FREE.posts_per_month} posts a month`, TRIAL_ROW)],
    ['Public API', yesNo(A.api), yesNo(B.api), 'Yes (included)'],
    ['MCP server / AI agents', yesNo(A.mcp), yesNo(B.mcp), 'Yes (included)'],
    // "Shows INR" means the vendor localised its pricing page to rupees for an
    // Indian visitor on the check date. None of them lists UPI on its pricing page.
    ['Prices in rupees (India)', yesNo(A.inr, 'Yes, localised', 'No, USD'), yesNo(B.inr, 'Yes, localised', 'No, USD'), 'Yes, with UPI Autopay'],
  ];

  const cheaper = (() => {
    const a = A.cheapestPaid?.usdMonthly;
    const b = B.cheapestPaid?.usdMonthly;
    if (a == null || b == null || a === b) return null;
    return a < b ? A : B;
  })();

  const verdict: string[] = [];
  if (cheaper) {
    const other = cheaper === A ? B : A;
    verdict.push(
      `${cheaper.name} is cheaper to start: ${priceText(cheaper)} against ${priceText(other)}.`
    );
  }
  // Per-channel against flat pricing: the entry price flatters the per-channel
  // tool, so also price it at the flat plan's channel count.
  for (const [perCh, flat] of [[A, B], [B, A]] as const) {
    const pc = perCh.cheapestPaid;
    const fl = flat.cheapestPaid;
    if (
      perCh.pricingModel === 'per channel' &&
      pc?.usdMonthly != null &&
      fl?.usdMonthly != null &&
      fl.channelsIncluded &&
      fl.channelsIncluded > 1
    ) {
      const total = Math.round(pc.usdMonthly * fl.channelsIncluded * 100) / 100;
      verdict.push(
        `At ${fl.channelsIncluded} channels the gap changes: ${perCh.name} comes to $${priceAmount({ price: total, currency: 'USD' })} a month against ${flat.name}'s $${priceAmount({ price: fl.usdMonthly, currency: 'USD' })}.`
      );
    }
  }
  if (A.freePlan && !B.freePlan) verdict.push(`${A.name} has a free plan; ${B.name} does not.`);
  if (B.freePlan && !A.freePlan) verdict.push(`${B.name} has a free plan; ${A.name} does not.`);
  if (A.pricingModel && B.pricingModel && A.pricingModel !== B.pricingModel) {
    verdict.push(`${A.name} charges ${A.pricingModel}, while ${B.name} charges ${B.pricingModel}, which matters most as you add channels or teammates.`);
  }
  if (A.openSource && !B.openSource) verdict.push(`${A.name} is open source (${A.openSource}) and can be self-hosted.`);
  if (B.openSource && !A.openSource) verdict.push(`${B.name} is open source (${B.openSource}) and can be self-hosted.`);

  const faq = [
    {
      q: `Is ${A.name} cheaper than ${B.name}?`,
      a: cheaper
        ? `${cheaper === A ? 'Yes' : 'No'}, on the cheapest paid plan: ${A.name} starts at ${priceText(A)} and ${B.name} at ${priceText(B)}. Check how each one counts channels and users before comparing totals.`
        : `${A.name} starts at ${priceText(A)} and ${B.name} at ${priceText(B)}. Check how each one counts channels and users before comparing totals.`,
    },
    {
      q: `Does ${A.name} or ${B.name} have a free plan?`,
      a: `${A.name}: ${freeText(A)}. ${B.name}: ${freeText(B)}.`,
    },
    {
      q: `Is there a cheaper alternative to ${A.name} and ${B.name}?`,
      a: `${offer(`Hookpost has a free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month) and a flat ${planPrice('HOOKPOST', ' a month')} plan for ${HOOKPOST.channel} channels, ${usdCopy('billed in rupees with UPI Autopay', 'billed in US dollars by card, or in India in rupees with UPI Autopay')}.`, `Hookpost has a flat ${planPrice('HOOKPOST', ' a month')} plan for ${HOOKPOST.channel} channels with ${FREE_POSTS}, ${usdCopy('billed in rupees with UPI Autopay', 'billed in US dollars by card, or in India in rupees with UPI Autopay')}.`)} It publishes to Instagram Reels, Meta Threads, TikTok, Facebook Pages, X, LinkedIn, YouTube Shorts, Bluesky, Discord, Telegram and more.`,
    },
  ];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Compare', item: BASE },
          { '@type': 'ListItem', position: 3, name: `${A.name} vs ${B.name}`, item: `${BASE}/${pair}` },
        ],
      },
    ],
  };

  // ---- Where Hookpost fits: computed from competitor-facts.ts (vendor pages,
  // FACTS_CHECKED) and Hookpost's own pricing.ts / channel-specs.ts. Nothing
  // here is typed in, so it differs for every pair and cannot drift from the
  // plans or the channel list. ---------------------------------------------
  const NET: Record<string, string> = {
    instagram: 'Instagram', threads: 'Threads', tiktok: 'TikTok', pinterest: 'Pinterest', youtube: 'YouTube',
    linkedin: 'LinkedIn', facebook: 'Facebook Pages', x: 'X', bluesky: 'Bluesky', discord: 'Discord', slack: 'Slack',
    telegram: 'Telegram', lemmy: 'Lemmy', nostr: 'Nostr', listmonk: 'Listmonk', wordpress: 'WordPress',
    hashnode: 'Hashnode', devto: 'Dev.to',
  };
  const publishable = Object.keys(CHANNEL_SPECS).filter((k) => !CHANNEL_SPECS[k].pending);
  const slugOf = (n: string) => {
    const k = n.toLowerCase().replace(/\s*\(.*\)$/, '').replace('facebook pages', 'facebook').replace('twitter/x', 'x');
    return k === 'dev.to' ? 'devto' : k;
  };
  const list = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const hookpostCan = (n: string) => publishable.includes(slugOf(n));
  const bothMissing = A.networks.filter((n) => !hookpostCan(n) && B.networks.some((m) => slugOf(m) === slugOf(n)));
  const aMissing = A.networks.filter((n) => !hookpostCan(n) && !bothMissing.includes(n));
  const bMissing = B.networks.filter((n) => !hookpostCan(n) && !A.networks.some((m) => slugOf(m) === slugOf(n)));
  const listed = new Set([...A.networks, ...B.networks].map(slugOf));
  const hookpostExtra = publishable.filter((k) => !listed.has(k)).map((k) => NET[k] ?? k);

  // What the entry plan of one tool costs against the Hookpost plan with room
  // for the same number of channels, or the stated reason it cannot be compared.
  const fitLine = (c: CompetitorFacts): string => {
    const pl = c.cheapestPaid;
    if (!pl) return `${c.name} does not publish a price we could read, so there is nothing to set against Hookpost's.`;
    const n = pl.channelsIncluded;
    if (pl.billing === 'one-time') {
      return `${c.name} Pro is a one-time ${usd(pl.price)} licence for ${pl.per.replace(/^licence \(|\)$/g, '')}, and on that licence you run the server yourself.${c.slug === 'mixpost' ? ` Its hosted version, Mixpost Cloud, starts at $${MIXPOST_CLOUD.monthly} a month (checked ${MIXPOST_CLOUD.checked}).` : ''} Hookpost is hosted: ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month`, `${USD_HOOKPOST_MONTH} a month (${HOOKPOST_DISPLAY_PRICE} a month in India)`)} for ${HOOKPOST.channel} channels.`;
    }
    if (pl.per.startsWith('channel') && n === 1) {
      const atHookpost = Math.round(pl.price * HOOKPOST.channel * 100) / 100;
      return `${c.name} charges ${usd(pl.price)} per channel per month${pl.billing === 'annual' ? ' billed annually' : ''}: ${usd(atHookpost)} for ${HOOKPOST.channel} channels, in US dollars. Hookpost is flat instead: ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month for ${HOOKPOST.channel} channels, in rupees, billed monthly.`, `${USD_HOOKPOST_MONTH} a month for ${HOOKPOST.channel} channels, in US dollars, billed monthly (${HOOKPOST_DISPLAY_PRICE} in India).`)}`;
    }
    if (n != null) {
      const room = n <= HOOKPOST.channel ? `has room for ${n}` : `covers up to ${HOOKPOST.channel}, short of ${n}`;
      return `${c.name} ${pl.name} is ${usd(pl.price)} a month${pl.billing === 'annual' ? ' billed annually' : ''} for ${n} channels. Hookpost ${room}: ${usdCopy(`${HOOKPOST_DISPLAY_PRICE} a month for up to ${HOOKPOST.channel} channels, in rupees, billed monthly.`, `${USD_HOOKPOST_MONTH} a month for up to ${HOOKPOST.channel} channels, in US dollars, billed monthly (${HOOKPOST_DISPLAY_PRICE} in India).`)}`;
    }
    return `${c.name} ${pl.name} is ${usd(pl.price)} a month${pl.billing === 'annual' ? ' billed annually' : ''} and its pricing page gives no channel count for it, so a per-channel comparison is not possible here. Hookpost is ${planPrice('HOOKPOST', ' a month')} for ${HOOKPOST.channel} channels.`;
  };

  const rupee = [A, B].filter((c) => c.inr);
  const fitPoints: string[] = [
    fitLine(A),
    fitLine(B),
    [
      `Free plans: ${A.name} ${A.freePlan ? `gives ${A.freePlan}` : A.freeTrialDays ? `has no free plan (${A.freeTrialDays}-day trial)` : 'has no free plan'}; ${B.name} ${B.freePlan ? `gives ${B.freePlan}` : B.freeTrialDays ? `has no free plan (${B.freeTrialDays}-day trial)` : 'has no free plan'}. ${offer(`Hookpost Free is ${FREE.channel} channels and ${FREE.posts_per_month} posts a month.`, `Hookpost has no free plan; it starts with ${FREE_POSTS}.`)}`,
      rupee.length === 2
        ? `Both show rupee prices to Indian visitors; Hookpost adds UPI Autopay.`
        : rupee.length === 1
        ? `${rupee[0].name} shows rupee prices to Indian visitors and ${rupee[0] === A ? B.name : A.name} bills in dollars; ${usdCopy('Hookpost bills in rupees with UPI Autopay.', 'Hookpost bills in dollars, and in India in rupees with UPI Autopay.')}`
        : `Both bill in dollars; ${usdCopy('Hookpost bills in rupees with UPI Autopay.', 'so does Hookpost, which bills in rupees with UPI Autopay in India.')}`,
    ].join(' '),
    `Networks: Hookpost publishes to ${publishable.length}.${bothMissing.length ? ` Both tools list ${list(bothMissing)}, which Hookpost does not publish to.` : ''}${aMissing.length ? ` ${A.name} also lists ${list(aMissing)}.` : ''}${bMissing.length ? ` ${B.name} also lists ${list(bMissing)}.` : ''}${hookpostExtra.length ? ` Neither lists ${list(hookpostExtra)}, which Hookpost does.` : ''}`,
  ];

  const others = PAIRS.filter((p) => p !== pair && (p.includes(A.slug) || p.includes(B.slug))).slice(0, 6);

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Comparison · checked {FACTS_CHECKED}</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          {A.name} vs {B.name}
        </h1>
        <div className="mt-5 max-w-[70ch] space-y-3 text-lg text-hp-text/75">
          {verdict.length ? verdict.map((v) => <p key={v}>{v}</p>) : (
            <p>{A.name} and {B.name} side by side, from each vendor&apos;s own pricing page.</p>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-12 sm:px-10">
        <div className="-mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm">
            <caption className="sr-only">{A.name} vs {B.name} compared</caption>
            <thead>
              <tr className="border-b border-hp-border-strong text-hp-text/60">
                <th scope="col" className="py-3 pe-4 font-semibold"> </th>
                <th scope="col" className="py-3 pe-4 font-semibold text-hp-text">{A.name}</th>
                <th scope="col" className="py-3 pe-4 font-semibold text-hp-text">{B.name}</th>
                <th scope="col" className="py-3 font-semibold text-hp-primary-text">Hookpost</th>
              </tr>
            </thead>
            <tbody className="text-hp-text/80">
              {rows.map(([label, a, b, h]) => (
                <tr key={label} className="border-b border-hp-border align-top">
                  <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">{label}</th>
                  <td className="py-4 pe-4">{a}</td>
                  <td className="py-4 pe-4">{b}</td>
                  <td className="py-4">{h}</td>
                </tr>
              ))}
              <tr className="border-b border-hp-border align-top">
                <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">Networks</th>
                <td className="py-4 pe-4">{A.networks.join(', ') || 'Not stated'}</td>
                <td className="py-4 pe-4">{B.networks.join(', ') || 'Not stated'}</td>
                <td className="py-4">Instagram, Threads, TikTok, Facebook Pages, X, LinkedIn, YouTube, Bluesky, Discord, Slack, Telegram, WordPress, Dev.to and more</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-sm text-hp-text/55">
          Sources, read {FACTS_CHECKED}:{' '}
          {[...A.sources, ...B.sources].map((u, i) => (
            <span key={u}>
              {i ? ', ' : ''}
              <a href={u} rel="nofollow noopener" target="_blank" className="underline">
                {u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
              </a>
            </span>
          ))}
          . Prices change; confirm on the vendor&apos;s page before you buy.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Where Hookpost fits</h2>
          <p className="mt-3 max-w-[70ch] text-hp-text/70">
            If you are in India, post to Instagram, Threads, TikTok, Facebook Pages, X, LinkedIn, YouTube or developer and community channels, and would rather pay one flat
            rupee price than a fee per channel, Hookpost is worth a look. It has {offer('a free plan', FREE_POSTS)} and ships an
            MCP server so an AI assistant can schedule for you across all connected channels.
          </p>
          <h3 className="mt-8 text-lg font-bold font-jakarta">{A.name} vs {B.name}, set against Hookpost</h3>
          <ul className="mt-3 flex max-w-[75ch] list-disc flex-col gap-3 ps-5 text-hp-text/75">
            {fitPoints.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-hp-text/50">
            Vendor figures are from the pages linked above, read {FACTS_CHECKED}. Hookpost figures come from its own plan and channel configuration.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link href={offer('/free-social-media-scheduler', '/pricing')} className="rounded-full bg-hp-primary px-5 py-2.5 font-semibold text-hp-on-primary hover:opacity-90">
              {offer('See the free plan', 'See pricing and the free posts')}
            </Link>
            {COMPETITOR_FACTS[A.slug]?.hasAlternativePage && (
              <Link href={`/alternatives/${A.slug}`} className="rounded-full border border-hp-border-strong px-5 py-2.5 font-semibold hover:border-hp-primary">
                Hookpost vs {A.name}
              </Link>
            )}
            {COMPETITOR_FACTS[B.slug]?.hasAlternativePage && (
              <Link href={`/alternatives/${B.slug}`} className="rounded-full border border-hp-border-strong px-5 py-2.5 font-semibold hover:border-hp-primary">
                Hookpost vs {B.name}
              </Link>
            )}
          </div>
        </div>
      </section>

      <section className="border-t border-hp-border bg-white/[0.015]">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Questions</h2>
          <dl className="mt-6 flex flex-col gap-6">
            {faq.map((f) => (
              <div key={f.q}>
                <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
              </div>
            ))}
          </dl>
          {others.length > 0 && (
            <p className="mt-10 text-hp-text/60">
              More comparisons:{' '}
              {others.map((p, i) => {
                const [x, y] = p.split('-vs-');
                return (
                  <span key={p}>
                    {i ? ' · ' : ''}
                    <Link href={`/compare/${p}`} className="text-hp-primary-text underline">
                      {COMPETITOR_FACTS[x].name} vs {COMPETITOR_FACTS[y].name}
                    </Link>
                  </span>
                );
              })}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
