import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { withSocial } from '../social-meta';
import { FREE_POSTS, offer, TRIAL_CTA, TRIAL_SENTENCE } from '../trial-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';
import { HOOKPOST_AI_CREDITS, HOOKPOST_X_POSTS } from '@hookpost/frontend/app/(landing)/usd-offer';

// Targets "social media scheduler India", "... in INR", "... with UPI". No
// competitor in the category mentions INR, UPI or Razorpay on its pricing page
// (GEO research, 8 Sep 2026), which makes this the least contested query set
// Hookpost can honestly win. Prices come from pricing.ts; Buffer's figure was
// read off buffer.com/pricing on 25 Sep 2026. Hootsuite, Zoho, Publer and
// SocialPilot DO localise to INR for Indian visitors (checked 26 Sep 2026), so
// never claim 'they all bill in dollars' - the true gap is UPI and flat pricing.
//
// 11 Oct 2026: Posttely (₹299, cards/PayPal), PostStage (₹499, UPI via
// Razorpay) and Poststack (₹2,000, UPI AutoPay, agencies) also price in rupees,
// so the page no longer implies Hookpost is the only rupee, UPI or UPI Autopay
// option. What it leads with instead: one flat rupee price for 5 channels, the
// price fixed by the mandate, plus the API, MCP server and developer channels.
// Instagram is not headlined: publishing from a normal (non-admin) account is
// not confirmed yet (see channel-specs.ts). This is the product page; the list of tools
// is /best-social-media-scheduler-india. The trial is a per-account
// offer, not universal, so it is no longer promised here.
const CANONICAL = 'https://hookpost.hookstep.in/social-media-scheduler-india';

const { FREE, HOOKPOST } = pricingINR;
const inr = (v: number) => `₹${v.toLocaleString('en-IN')}`;
const BUFFER_PER_CHANNEL_USD = 5;

const FAQ = [
  {
    q: 'Is there a social media scheduler that charges in rupees?',
    a: `Yes. Hookpost bills in Indian rupees through Razorpay. Hookpost is ${HOOKPOST_DISPLAY_PRICE} a month, and ${offer('there is a free plan', `new workspaces get ${FREE_POSTS} first`)}. You can pay with UPI Autopay, a debit or credit card, or NetBanking.`,
  },
  {
    q: 'Can I pay for a social media tool with UPI Autopay?',
    a: 'Yes. When you subscribe, Razorpay sets up a UPI Autopay mandate from your UPI app (Google Pay, PhonePe, Paytm and others). Per RBI rules a small refundable authorisation is taken to set it up. After that the plan renews automatically, and you can cancel from Settings.',
  },
  {
    q: 'Does the price change after I subscribe?',
    a: 'No. A UPI Autopay mandate fixes the amount at signup, so the price you subscribe at is the price you keep.',
  },
  {
    q: 'Why not just use Buffer or Hootsuite?',
    a: `You can. Buffer bills in US dollars and per channel: $${BUFFER_PER_CHANNEL_USD} per channel per month, so ${HOOKPOST.channel} channels cost $${BUFFER_PER_CHANNEL_USD * HOOKPOST.channel} a month on a card that allows international payments. Hootsuite does show rupee prices in India, but its cheapest plan is ₹1,999 per user per month billed yearly${offer(', and there is no free plan', '')}. Neither lists UPI on its pricing page. Hookpost covers ${HOOKPOST.channel} channels for one flat ${HOOKPOST_DISPLAY_PRICE} with UPI Autopay.`,
  },
  {
    q: 'Can I try it before paying?',
    a: offer(
      `Yes. The Free plan (${FREE.channel} channels, ${FREE.posts_per_month} posts a month) has no time limit and needs no card. The paid plan is billed monthly and can be cancelled from Settings.`,
      `Yes. ${TRIAL_SENTENCE} The plan is billed monthly and can be cancelled from Settings.`
    ),
  },
  {
    q: 'Are there other schedulers that bill in rupees?',
    a: 'Yes. Posttely, PostStage and Poststack price in rupees. PostStage takes UPI, and Poststack sets up UPI AutoPay like Hookpost does, starting at ₹2,000 a month for 3 accounts. Hootsuite, Zoho Social, Publer and SocialPilot show rupee prices to Indian visitors. Our side-by-side list of tools for India compares all of them on free plans, rupee prices and UPI.',
  },
  {
    q: 'Is Hookpost an Indian company?',
    a: 'Yes. Hookpost is built by Hookstep in Mumbai, India. Support and billing are handled in India, and support answers in English, Hindi or Punjabi.',
  },
];

export const metadata: Metadata = withSocial({
  title: `Social Media Scheduler in India, ${HOOKPOST_DISPLAY_PRICE}/mo with UPI | Hookpost`,
  description: `Schedule LinkedIn, YouTube, X and Bluesky posts, billed in rupees. ${offer('Free plan', FREE_POSTS)}, then ${HOOKPOST_DISPLAY_PRICE}/month flat for ${HOOKPOST.channel} channels with UPI Autopay.`,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: 'Social media scheduler for India - pay in rupees with UPI',
    description: `${offer('Free plan', FREE_POSTS)}, then ${HOOKPOST_DISPLAY_PRICE}/month flat. UPI Autopay, cards, NetBanking.`,
    url: CANONICAL,
    siteName: 'Hookpost',
    type: 'website',
    locale: 'en_IN',
    images: [{ url: 'https://hookpost.hookstep.in/og-image.png', width: 1200, height: 630, alt: 'Hookpost social media scheduler for India' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Social media scheduler for India - pay in rupees with UPI',
    description: `${offer('Free plan', FREE_POSTS)}, then ${HOOKPOST_DISPLAY_PRICE}/month flat for ${HOOKPOST.channel} channels.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
  },
});

export default function IndiaSchedulerPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
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
          { '@type': 'ListItem', position: 2, name: 'Social media scheduler for India', item: CANONICAL },
        ],
      },
    ],
  };

  const plans = [
    // No Free card once new users have no Free plan (trial-offer.ts).
    ...offer([{ name: 'Free', t: FREE, extra: 'Calendar scheduling. No AI or API.' }], []),
    { name: 'Hookpost', t: HOOKPOST, extra: `${HOOKPOST_AI_CREDITS}, ${HOOKPOST_X_POSTS}, API and MCP, up to ${HOOKPOST.team_member_limit} team members.` },
  ];

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm selection:bg-hp-primary selection:text-hp-on-primary">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteNav />

      <section className="mx-auto w-full max-w-[1100px] px-5 pt-16 sm:px-10">
        <p className="text-sm font-semibold uppercase tracking-wider text-hp-primary-text">Made in India · billed in ₹</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          A social media scheduler for India, billed in rupees with UPI Autopay
        </h1>
        <p className="mt-5 max-w-[70ch] text-lg text-hp-text/75">
          Hookpost is a social media scheduler for India: it schedules posts to LinkedIn, YouTube, X, Pinterest, TikTok, Bluesky,
          Telegram and more, and bills in rupees.{' '}
          {offer('Start on the free plan, then pay', `Start with ${FREE_POSTS}, no card needed, then pay`)}{' '}
          <strong className="text-hp-text">{HOOKPOST_DISPLAY_PRICE} a month flat for {HOOKPOST.channel} channels</strong>{' '}
          through Razorpay with UPI Autopay, a card or NetBanking. No fee per channel, and no international card needed.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/auth" prefetch={false} className="rounded-full bg-hp-primary px-6 py-3 font-semibold text-hp-on-primary hover:opacity-90">
            {offer('Start free', TRIAL_CTA)}
          </Link>
          <Link href="/pricing" className="rounded-full border border-hp-border-strong px-6 py-3 font-semibold hover:border-hp-primary">
            Full pricing
          </Link>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
        <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Plans, paid in rupees</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {plans.map(({ name, t, extra }) => (
            <div key={name} className="rounded-2xl border border-hp-border p-6">
              <div className="text-lg font-bold font-jakarta">{name}</div>
              <div className="mt-2 text-3xl font-extrabold">
                {/* The shown price ($7, pricing.ts HOOKPOST_PRICE); checkout charges it in INR. */}
                {t.month_price === 0 ? '$0' : HOOKPOST_DISPLAY_PRICE}
                <span className="text-base font-normal text-hp-text/60">/month</span>
              </div>
              <ul className="mt-4 flex flex-col gap-1 text-sm text-hp-text/75">
                <li>{t.channel} channels</li>
                <li>{t.posts_per_month.toLocaleString('en-IN')} posts a month</li>
                <li>{extra}</li>
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Rupees vs dollars, for 5 channels</h2>
          <div className="mt-8 -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
            <table className="w-full min-w-[620px] border-collapse text-left text-sm">
              <caption className="sr-only">Monthly cost for five channels</caption>
              <thead>
                <tr className="border-b border-hp-border-strong text-hp-text/60">
                  <th scope="col" className="py-3 pe-4 font-semibold"> </th>
                  <th scope="col" className="py-3 pe-4 font-semibold">Hookpost</th>
                  <th scope="col" className="py-3 font-semibold">Buffer Essentials</th>
                </tr>
              </thead>
              <tbody className="text-hp-text/80">
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">5 channels, monthly</th>
                  <td className="py-4 pe-4">{HOOKPOST_DISPLAY_PRICE} flat</td>
                  <td className="py-4">${BUFFER_PER_CHANNEL_USD * 5} (${BUFFER_PER_CHANNEL_USD} × 5 channels)</td>
                </tr>
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">Currency</th>
                  <td className="py-4 pe-4">Indian rupees</td>
                  <td className="py-4">US dollars</td>
                </tr>
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">UPI Autopay</th>
                  <td className="py-4 pe-4">Yes</td>
                  <td className="py-4">No, international card needed</td>
                </tr>
                <tr className="border-b border-hp-border">
                  <th scope="row" className="py-4 pe-4 font-semibold text-hp-text">Adding a 6th channel</th>
                  <td className="py-4 pe-4">Included, up to {HOOKPOST.channel} channels</td>
                  <td className="py-4">+${BUFFER_PER_CHANNEL_USD}/month per channel</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-sm text-hp-text/55">
            Buffer&apos;s price from{' '}
            <a href="https://buffer.com/pricing" rel="nofollow noopener" target="_blank" className="underline">buffer.com/pricing</a>, checked 25 September 2026.
            Full comparison: <Link href="/alternatives/buffer" className="text-hp-primary-text underline">Hookpost vs Buffer</Link>.
          </p>
        </div>
      </section>

      <section className="border-t border-hp-border">
        <div className="mx-auto w-full max-w-[1100px] px-5 py-16 sm:px-10">
          <h2 className="text-3xl font-extrabold tracking-tight font-jakarta text-balance">Built for how Indian teams post</h2>
          <ul className="mt-6 grid gap-3 sm:grid-cols-2 text-hp-text/80">
            <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">Schedule in IST.</strong> The calendar follows your browser&apos;s time zone by default (you can change it in Settings), so a 9 AM post goes out at 9 AM India time.</li>
            <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">LinkedIn profiles.</strong> Schedule posts, carousels and video to your personal LinkedIn profile.</li>
            <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">YouTube uploads and Shorts.</strong> Title, description and visibility set per post.</li>
            <li className="rounded-2xl border border-hp-border p-5"><strong className="text-hp-text">Telegram channels and groups.</strong> Broadcast to a Telegram channel on the same schedule as everything else.</li>
          </ul>
          <p className="mt-6 max-w-[70ch] text-sm text-hp-text/55">
            Write captions in Hindi, Hinglish or any language: Hookpost posts your text as written. The app itself is in English.
            New to scheduling? The <Link href="/guides/social-media-post-schedule-kaise-kare" className="text-hp-primary-text underline">Hinglish guide to scheduling posts</Link>{' '}
            covers Instagram, Facebook, YouTube and LinkedIn&apos;s own schedulers too.
          </p>
          <p className="mt-6 text-hp-text/60">
            Who uses it:{' '}
            <Link href="/for/small-business" className="text-hp-primary-text underline">small businesses</Link>,{' '}
            <Link href="/for/agencies" className="text-hp-primary-text underline">agencies</Link>,{' '}
            <Link href="/for/creators" className="text-hp-primary-text underline">creators</Link>,{' '}
            <Link href="/for/solopreneurs-freelancers" className="text-hp-primary-text underline">freelancers</Link>.
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
          <p className="mt-10 text-hp-text/60">
            {offer(
              <>
                Just want to try it?{' '}
                <Link href="/free-social-media-scheduler" className="text-hp-primary-text underline">What the free plan includes</Link>.
                {' '}
              </>,
              null
            )}
            Comparing tools?{' '}
            <Link href="/best-social-media-scheduler-india" className="text-hp-primary-text underline">The best schedulers for India, compared in rupees</Link>.
            {' '}Planning festival posts?{' '}
            <Link href="/social-media-calendar-india" className="text-hp-primary-text underline">Social media calendar for India</Link>.
          </p>
        </div>
      </section>
    </div>
  );
}
