import React from 'react';
import Link from 'next/link';
import { Metadata } from 'next';
import { SiteNav } from '../../../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS } from '../../../compare/competitor-facts';
import { withSocial } from '../../../social-meta';
import { offer, TRIAL_CTA } from '../../../trial-offer';
import { BILLED, planPrice, planPriceInParens, usdCopy } from '../../../usd-offer';

// Agencies page, rebuilt 11 Oct 2026 around what the product really does for
// client work, read from code:
// - Channels grouped by customer: customer.modal.tsx / select.customer.tsx; the
//   calendar filters by customer (calendar.context.tsx).
// - Client review: any post has a public preview at /p/<id> (proxy.ts lets it
//   through without a session). It renders without an account; comments need
//   the visitor to sign in or register (preview/comments.components.tsx). There
//   is NO approval workflow: post states are QUEUE, DRAFT, PUBLISHED, ERROR.
// - Seats: team_member_limit in pricing.ts, owner included, enforced in
//   organization.repository.ts.
// - No GST-invoice claim: nothing in the code produces one.
// Competitor per-seat prices come from competitor-facts.ts. Hootsuite is quoted
// in rupees, from the price it shows a visitor in India (inrPlan, read 11 Oct);
// Sprout Social shows no rupee price, so it stays in dollars. The two are never
// converted into each other.
const CANONICAL = 'https://hookpost.hookstep.in/for/agencies';
const { FREE, HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;
const SPROUT = COMPETITOR_FACTS['sprout-social'].cheapestPaid!;
const HOOTSUITE_INR = COMPETITOR_FACTS.hootsuite.inrPlan!;
const HOOTSUITE_SEAT = HOOTSUITE_INR.yearlyPerMonth!;
const TEAM = 5;

const STEPS = [
  {
    title: 'Group each client’s channels',
    body: 'Assign every connected channel to a customer. Switch the calendar to one customer and you see only that brand’s posts; switch back to see the whole agency week.',
  },
  {
    title: 'Write the post and save it as a draft',
    body: 'Drafts sit on the calendar marked “Draft:” and never publish on their own.',
  },
  {
    title: 'Send the client a preview link',
    body: `Every post has a preview page. Copy its link and send it on WhatsApp or email; the client opens it in any browser without an account. To leave a comment on it, they sign in or create a ${offer('free ', '')}Hookpost account.`,
  },
  {
    title: 'Schedule once they are happy',
    body: 'Make their changes, then schedule. Hookpost publishes at the time you set and shows a failed post in red with the network’s error.',
  },
];

const FAQ = [
  {
    q: 'How do agencies manage several clients in Hookpost?',
    a: `Assign each connected channel to a customer, then filter the calendar to one customer at a time. Hookpost covers ${HOOKPOST.channel} channels and up to ${HOOKPOST.team_member_limit} team members, owner included, for ${planPrice('HOOKPOST', ' a month')} with no per-client or per-seat fee.`,
  },
  {
    q: 'Can clients approve posts before they go out?',
    a: 'Through preview links. Save the post as a draft and send the client its preview link; they can read it without an account and comment once signed in. There is no approve button: you schedule the post yourself when the client is happy.',
  },
  {
    q: 'Do my clients need a Hookpost account?',
    a: `Not to view a preview. Only to comment on it, and ${offer('a free account', 'any Hookpost account')} is enough for that. Their social accounts connect to your workspace through each network’s own sign-in, so you never need their passwords.`,
  },
  {
    q: 'How many team members can I add?',
    a: `Up to ${HOOKPOST.team_member_limit} on Hookpost (${planPriceInParens('HOOKPOST', ' a month')}), owner included, as Admin or User${offer(`. Free covers ${FREE.channel} channels for one person`, '')}.`,
  },
  {
    q: 'Is pricing per client or per seat?',
    a: `Neither. Hookpost is one flat ${planPrice('HOOKPOST', ' a month')}, ${BILLED}. For comparison, Hootsuite ${HOOTSUITE_INR.name} is ${inr(HOOTSUITE_SEAT)} per user a month in India and Sprout Social's entry plan is $${SPROUT.price} per user a month, both billed yearly.`,
  },
];

export const metadata: Metadata = withSocial({
  title: 'Social Media Management Tool for Agencies | Hookpost',
  description: `Group channels by client, send preview links clients can open from WhatsApp, and add up to ${HOOKPOST.team_member_limit} team members on Hookpost for ${planPrice('HOOKPOST', ' a month')}, with no per-seat fee.`,
  alternates: { canonical: CANONICAL },
});

export default function AgenciesLandingPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        '@id': `${CANONICAL}#faq`,
        mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://hookpost.hookstep.in/' },
          { '@type': 'ListItem', position: 2, name: 'Who it is for', item: 'https://hookpost.hookstep.in/for' },
          { '@type': 'ListItem', position: 3, name: 'Agencies', item: CANONICAL },
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
          <Link href="/for" className="hover:text-hp-primary-text">Who it is for</Link> / Agencies
        </nav>
        <h1 className="mt-4 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Run every client&apos;s social media from one calendar
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Group each client&apos;s channels, send them a preview link they can open from WhatsApp, and schedule once they are
          happy. Hookpost is <strong className="text-hp-text">{planPrice('HOOKPOST', ' a month')} flat</strong> for {HOOKPOST.channel} channels,{' '}
          {HOOKPOST.posts_per_month.toLocaleString('en-IN')} posts and up to {HOOKPOST.team_member_limit} team members,{' '}
          {usdCopy('billed in rupees', 'billed in US dollars, or in rupees in India')}. No
          fee per client and none per seat.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <Link href="/alternatives/sprout-social" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Compare with Sprout Social
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">How client review works</h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-hp-border p-6">
              <span className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">Step {i + 1}</span>
              <h3 className="mt-2 text-lg font-bold font-jakarta">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-hp-text/70">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-[70ch] text-hp-text/60">
          Said plainly: there is no approve button or approval queue. The preview link and its comments are the review step, and
          scheduling stays with your team.
        </p>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What else agencies use</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Team seats with roles.</strong> Invite people as Admin or User, up to{' '}
              {HOOKPOST.team_member_limit} on Hookpost including you. Channels connect through each network&apos;s own sign-in, so nobody
              shares a client&apos;s password.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Repeating posts and signatures.</strong> Repeat a post daily, weekly or monthly, and
              save signatures to drop into any client&apos;s posts.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              <strong className="text-hp-text">Bulk work from code or AI.</strong> The REST API and the MCP server can list one
              customer&apos;s channels and posts, and create posts for them. <Link href="/social-media-scheduling-api" className="text-hp-primary-text underline">API</Link>,{' '}
              <Link href="/mcp" className="text-hp-primary-text underline">MCP</Link>.
            </li>
            <li className="rounded-2xl border border-hp-border p-5">
              {usdCopy(
                <>
                  <strong className="text-hp-text">Indian billing.</strong> One subscription in rupees through Razorpay with UPI Autopay,
                  cards or NetBanking, at the price you subscribed at.
                </>,
                <>
                  <strong className="text-hp-text">One subscription.</strong> In US dollars by card, or in India in rupees through
                  Razorpay with UPI Autopay, cards or NetBanking, at the price you subscribed at.
                </>
              )}
            </li>
          </ul>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-14 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">What 5 people cost</h2>
          <div className="mt-6 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <caption className="sr-only">Monthly cost for a five-person agency team</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold">Tool</th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Pricing</th>
                  <th scope="col" className="py-3 font-semibold">{TEAM} people, per month</th>
                </tr>
              </thead>
              <tbody className="text-hp-text/80">
                <tr className="border-b border-hp-border bg-hp-primary/[0.06]">
                  <th scope="row" className="py-3 pe-4 font-bold text-hp-text">Hookpost</th>
                  <td className="py-3 pe-4">Flat, {HOOKPOST.channel} channels</td>
                  <td className="py-3">{planPrice('HOOKPOST')}</td>
                </tr>
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-3 pe-4 font-bold text-hp-text">Sprout Social Essentials</th>
                  <td className="py-3 pe-4">${SPROUT.price} per user, billed yearly (US dollars)</td>
                  <td className="py-3">${SPROUT.price * TEAM}</td>
                </tr>
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-3 pe-4 font-bold text-hp-text">Hootsuite {HOOTSUITE_INR.name}</th>
                  <td className="py-3 pe-4">{inr(HOOTSUITE_SEAT)} per user, billed yearly (price shown in India)</td>
                  <td className="py-3">{inr(HOOTSUITE_SEAT * TEAM)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-hp-text/55">
            Competitor prices from their pricing pages, as recorded on our <Link href="/compare" className="underline">comparison page</Link>. They
            include features Hookpost does not have, such as social listening and approval workflows; compare what you need, not
            only the price.
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
