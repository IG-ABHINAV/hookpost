import Link from 'next/link';
import { Metadata } from 'next';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import { offer } from '../trial-offer';
import {
  AFFILIATE_COMMISSION_PERCENT,
  AFFILIATE_COOKIE_DAYS,
  AFFILIATE_COUPON_PERCENT,
  AFFILIATE_DEFAULT_COMMISSION_MONTHS,
  AFFILIATE_MIN_PAYOUT_INR,
} from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.terms';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// Public terms for the affiliate programme, read from affiliate.terms.ts: the
// same constants the backend records commissions with and the ?ref cookie
// (components/affiliates/ref-capture.tsx) uses, so they cannot drift apart.
// Since 3 Nov 2026 the standard deal is 30% for the first 12 months of each
// customer (it was lifetime from 22 Oct); partners on a deal agreed with us
// keep their own terms.
const CANONICAL = 'https://hookpost.hookstep.in/affiliates';
const PERCENT = AFFILIATE_COMMISSION_PERCENT;
const MONTHS = AFFILIATE_DEFAULT_COMMISSION_MONTHS;
const COOKIE_DAYS = AFFILIATE_COOKIE_DAYS;
const MIN_PAYOUT = AFFILIATE_MIN_PAYOUT_INR;
const COUPON_PERCENT = AFFILIATE_COUPON_PERCENT;
const { HOOKPOST } = pricingINR;
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
/** What one customer earns you over the commission window, paying monthly. */
// On the shown price ($7): the commission is paid on what the customer pays.
const perYear = (_monthly?: number) =>
  `$${Math.round(HOOKPOST_PRICE.displayUsd * (PERCENT / 100) * 12)}`;

const FAQ = [
  {
    q: 'How much does the Hookpost affiliate programme pay?',
    a: `${PERCENT}% of every payment a customer you refer makes, for their first ${MONTHS} months. A customer on Hookpost (${HOOKPOST_DISPLAY_PRICE} a month) earns you about ${perYear(HOOKPOST.month_price)} over a year of payments.`,
  },
  {
    q: 'For how long do I earn from a customer?',
    a: `For ${MONTHS} months from the day they sign up through your link: every payment they make in that time earns you ${PERCENT}%. If they cancel sooner, the commission stops with their payments. Creators and partners with a bigger audience can agree a longer deal with us: write to support@hookstep.in.`,
  },
  {
    q: 'How long does the referral cookie last?',
    a: `${COOKIE_DAYS} days. If someone clicks your link and creates their Hookpost account within ${COOKIE_DAYS} days, they are yours. If they click several affiliates' links, the last click counts.`,
  },
  {
    q: 'Do the people I refer get a discount?',
    a: `Yes. Your affiliate code is also a coupon: it gives them ${COUPON_PERCENT}% off any paid plan, for as long as they stay subscribed. It is applied automatically when they arrive on your link, and anyone who types it at checkout is credited to you even without the link.`,
  },
  {
    q: 'When and how do I get paid?',
    a: `Once a month, by UPI or bank transfer in India (PayPal outside India), as soon as what you are owed passes ₹${MIN_PAYOUT.toLocaleString('en-IN')}. A commission is held for 30 days after the payment so refunds can be reversed first.`,
  },
  {
    q: 'Who can join?',
    a: offer(
      'Anyone with a Hookpost account, including the free plan. You get your link instantly on the Earn 30% page inside the app. There is no application form.',
      'Anyone using Hookpost, on free posts or a paid plan. You get your link instantly on the Earn 30% page inside the app. There is no application form.'
    ),
  },
  {
    q: 'What is not allowed?',
    a: 'Referring yourself or your own workspaces, bidding on "Hookpost" or its misspellings in search ads, spam (unsolicited email, DMs or comment spam), and coupon or cashback sites. Commissions earned this way are voided and the link is paused.',
  },
];

export const metadata: Metadata = withSocial({
  title: `Hookpost Affiliate Programme: Earn ${PERCENT}% Recurring`,
  description: `Earn ${PERCENT}% of every payment for the first ${MONTHS} months of each customer you refer to Hookpost. ${COOKIE_DAYS}-day cookie, paid monthly by UPI or bank transfer.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: `Hookpost affiliate programme - ${PERCENT}% recurring for ${MONTHS} months`,
    description: `Share Hookpost, earn ${PERCENT}% of every payment for each customer's first ${MONTHS} months. ${COOKIE_DAYS}-day cookie, UPI payouts.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Hookpost affiliate programme',
      },
    ],
  },
});

export default function AffiliatesPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
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
          { '@type': 'ListItem', position: 2, name: 'Affiliates', item: CANONICAL },
        ],
      },
    ],
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <div>
        <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
          <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Affiliate programme</p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
            Earn {PERCENT}% recurring for every customer you send
          </h1>
          <p className="mt-5 max-w-[65ch] text-lg text-hp-text/70">
            Recommend Hookpost to creators, agencies and developers. When someone signs up through your link and pays,
            you get {PERCENT}% of every payment they make for their first {MONTHS} months, paid out monthly by UPI or
            bank transfer.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/auth"
              prefetch={false}
              className="inline-flex h-12 items-center rounded-xl bg-hp-primary px-6 font-bold text-hp-on-primary"
            >
              Get your affiliate link
            </Link>
            <Link
              href="/affiliate"
              prefetch={false}
              rel="nofollow"
              className="inline-flex h-12 items-center rounded-xl border border-hp-border-strong px-6 font-semibold text-hp-text/90 hover:border-hp-primary/60"
            >
              Already a user? Open your dashboard
            </Link>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10" aria-labelledby="numbers">
          <h2 id="numbers" className="sr-only">Programme terms at a glance</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [`${PERCENT}%`, `of every payment, for ${MONTHS} months`],
              [perYear(HOOKPOST.month_price), `per Hookpost customer over ${MONTHS} months`],
              [`${COUPON_PERCENT}% off`, 'for your audience, with your code'],
              [`₹${MIN_PAYOUT.toLocaleString('en-IN')}`, 'minimum payout, sent monthly'],
            ].map(([big, small]) => (
              <li key={small} className="rounded-2xl border border-hp-border bg-white/[0.03] p-6">
                <div className="text-3xl font-extrabold font-jakarta text-hp-primary-text">{big}</div>
                <div className="mt-2 text-hp-text/70">{small}</div>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-t border-hp-border">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">How it works</h2>
            <ol className="mt-6 grid gap-4 sm:grid-cols-3">
              {[
                ['Get your link', offer('Create a free Hookpost account and open Earn 30% in the sidebar. Your link is ready instantly.', 'Create a Hookpost account and open Earn 30% in the sidebar. Your link is ready instantly.')],
                ['Share it', 'In a video, a newsletter, a blog post or a tweet thread. Add ?ref=yourcode to any Hookpost page, such as a comparison or guide.'],
                ['Get paid', `Every time someone you referred is charged, ${PERCENT}% lands in your dashboard. We pay out monthly.`],
              ].map(([t, d], i) => (
                <li key={t} className="rounded-2xl border border-hp-border p-6">
                  <div className="text-sm font-bold text-hp-primary-text">Step {i + 1}</div>
                  <h3 className="mt-1 text-lg font-bold font-jakarta">{t}</h3>
                  <p className="mt-2 text-hp-text/70">{d}</p>
                </li>
              ))}
            </ol>
            <p className="mt-8 max-w-[70ch] text-hp-text/60">
              Good pages to link to: the{' '}
              {offer(
                <Link href="/free-social-media-scheduler" className="text-hp-primary-text underline">free plan</Link>,
                <Link href="/pricing" className="text-hp-primary-text underline">pricing page</Link>
              )},{' '}
              <Link href="/social-media-scheduler-india" className="text-hp-primary-text underline">India pricing in rupees</Link>,{' '}
              <Link href="/compare" className="text-hp-primary-text underline">comparisons</Link> and the{' '}
              <Link href="/mcp" className="text-hp-primary-text underline">MCP server for AI agents</Link>.
            </p>
          </div>
        </section>

        <section className="border-t border-hp-border bg-white/[0.015]">
          <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
            <h2 className="text-2xl font-extrabold tracking-tight font-jakarta">Questions</h2>
            <dl className="mt-6 flex flex-col gap-6">
              {FAQ.map((f) => (
                <div key={f.q}>
                  <dt className="text-lg font-bold font-jakarta">{f.q}</dt>
                  <dd className="mt-2 max-w-[70ch] text-hp-text/70">{f.a}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-10 text-sm text-hp-text/50">
              Questions about a payout? Write to{' '}
              <a href="mailto:support@hookstep.in" className="underline">support@hookstep.in</a>. We may change these
              terms with 30 days' notice; commissions already earned are paid on the terms they were earned under.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
