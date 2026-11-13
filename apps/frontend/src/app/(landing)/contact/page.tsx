import { Metadata } from 'next';
import Link from 'next/link';
import { ContactForm } from './contact-form';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';

// There was no contact page at all - /contact 307'd to the login screen. The
// support address existed only inside the terms, privacy and data-deletion
// pages, which is not where anyone looks for it.
export const metadata: Metadata = withSocial({
  title: 'Contact Hookpost | Support & Sales',
  description:
    'Get in touch with the Hookpost team at support@hookstep.in — support, billing, API access, and press.',
  alternates: { canonical: 'https://hookpost.hookstep.in/contact' },
});

const SUPPORT_EMAIL = 'support@hookstep.in';
const LINKEDIN = 'https://www.linkedin.com/company/hookpost';

const REASONS = [
  {
    title: 'Support',
    body: 'A channel that will not connect, a post that did not publish, anything behaving oddly. Include the channel and the scheduled time and we can find it in the logs.',
  },
  {
    title: 'Billing',
    body: 'Invoices, plan changes, refunds, or UPI and card payment questions. Billing runs through Razorpay.',
  },
  {
    title: 'API & partnerships',
    body: 'Building on the public API, OAuth for your own users, or something we have not thought of.',
  },
];

export default function ContactPage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    name: 'Contact Hookpost',
    url: 'https://hookpost.hookstep.in/contact',
    mainEntity: {
      '@type': 'Organization',
      name: 'Hookpost',
      legalName: 'JR Consulting Co.',
      email: SUPPORT_EMAIL,
      address: {
        '@type': 'PostalAddress',
        addressLocality: 'Ghatkopar, Mumbai',
        addressRegion: 'Maharashtra',
        addressCountry: 'IN',
      },
      sameAs: [LINKEDIN],
      contactPoint: {
        '@type': 'ContactPoint',
        email: SUPPORT_EMAIL,
        contactType: 'Customer Support',
        availableLanguage: ['English', 'Hindi', 'Punjabi'],
      },
    },
  };

  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <SiteNav />

      <div className="mx-auto w-full max-w-[900px] px-5 py-20 sm:px-10 sm:py-28">
        <Link
          href="/"
          className="text-sm text-hp-text/50 transition-colors hover:text-hp-primary-text"
        >
          ← Hookpost
        </Link>

        <h1 className="mt-6 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl text-balance">
          Talk to us
        </h1>
        <p className="mt-4 max-w-[56ch] text-[17px] leading-relaxed text-hp-text/60">
          One inbox, read by the people who build Hookpost. We reply in English,
          Hindi or Punjabi.
        </p>

        {/* primary contact */}
        <div className="mt-12 rounded-2xl border border-hp-primary/30 bg-hp-primary/[0.06] p-8">
          <span className="text-xs font-bold uppercase tracking-wider text-hp-primary-text">
            Email us
          </span>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-3 block break-words text-2xl font-bold font-jakarta hover:underline sm:text-3xl"
          >
            {SUPPORT_EMAIL}
          </a>
          <p className="mt-4 text-[15px] text-hp-text/60">
            Support, billing and partnerships all go here.
          </p>
        </div>

        {/* TEMPORARY (11 Oct 2026): the founder's rule since 29 Sep is that only
            the area and city are published. Razorpay's banking partners (19
            retail netbanking requests) require the proprietor's name and the full
            registered (GST) address to be visible, so he approved showing both
            until those requests are decided. Revert this commit and 50068941
            once they are; tracked in local-assets/razorpay-approval-undo.md. */}
        <div className="mt-6 rounded-2xl border border-hp-border bg-white/[0.02] p-8">
          <span className="text-xs font-bold uppercase tracking-wider text-hp-text/50">
            Office
          </span>
          <address className="mt-3 not-italic text-[15px] leading-relaxed text-hp-text/70">
            JR Consulting Co.
            <br />
            Proprietor: Jatinder Mahajan
            <br />
            Ghatkopar, Mumbai
            <br />
            Maharashtra
            <br />
            India
          </address>
          <span className="mt-6 block text-xs font-bold uppercase tracking-wider text-hp-text/50">
            Registered address
          </span>
          <address className="mt-3 not-italic text-[15px] leading-relaxed text-hp-text/70">
            JR Consulting Co.
            <br />
            221, Arya Samaj Gali, Sujanpur
            <br />
            Pathankot, Punjab 145023
            <br />
            India
          </address>
          <p className="mt-4 text-[15px] text-hp-text/50">
            Hookpost is an online service and this office does not take walk-in
            visitors. Please use email or the form below.
          </p>
        </div>

        {/* The form. The email address above stays as the fallback for anyone
            who would rather use their own client. */}
        <div className="mt-10 rounded-2xl border border-hp-border bg-white/[0.02] p-8">
          <h2 className="text-xl font-bold font-jakarta">Or write to us here</h2>
          <p className="mt-2 mb-7 text-[15px] text-hp-text/60">
            Goes to the same inbox. We reply to the address you give.
          </p>
          <ContactForm />
        </div>

        {/* what to write about */}
        <div className="mt-14">
          <h2 className="text-2xl font-bold font-jakarta">What we can help with</h2>
          <div className="mt-7 grid gap-6 sm:grid-cols-2">
            {REASONS.map((r) => (
              <div
                key={r.title}
                className="rounded-2xl border border-hp-border bg-white/[0.02] p-6"
              >
                <h3 className="font-bold font-jakarta">{r.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-hp-text/60">
                  {r.body}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* elsewhere */}
        <div className="mt-14">
          <h2 className="text-2xl font-bold font-jakarta">Elsewhere</h2>
          <div className="mt-6 flex flex-col gap-3">
            <a
              href={LINKEDIN}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between rounded-xl border border-hp-border bg-white/[0.02] px-6 py-4 transition-colors hover:border-hp-primary/40"
            >
              <span className="font-semibold">LinkedIn</span>
              <span className="text-sm text-hp-text/50">
                /company/hookpost&nbsp;↗
              </span>
            </a>
            <Link
              href="/about"
              className="flex items-center justify-between rounded-xl border border-hp-border bg-white/[0.02] px-6 py-4 transition-colors hover:border-hp-primary/40"
            >
              <span className="font-semibold">About the company</span>
              <span className="text-sm text-hp-text/50">JR Consulting Co.</span>
            </Link>
            <Link
              href="/docs/public-api"
              className="flex items-center justify-between rounded-xl border border-hp-border bg-white/[0.02] px-6 py-4 transition-colors hover:border-hp-primary/40"
            >
              <span className="font-semibold">API reference</span>
              <span className="text-sm text-hp-text/50">For developers</span>
            </Link>
          </div>
        </div>

        {/* legal-adjacent, kept plain */}
        <div className="mt-14 border-t border-hp-border pt-8 text-[15px] leading-relaxed text-hp-text/50">
          <p>
            Hookpost is operated by <strong className="text-hp-text/70">JR Consulting Co.</strong>, a sole proprietorship of <strong className="text-hp-text/70">Jatinder Mahajan</strong>.{' '}
            To delete your account and data, follow the steps on the{' '}
            <Link href="/data-deletion" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">
              data deletion
            </Link>{' '}
            page. Our{' '}
            <Link href="/privacy" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">
              privacy policy
            </Link>{' '}
            and{' '}
            <Link href="/terms" className="text-hp-primary-text underline underline-offset-2 decoration-hp-primary-text/40 hover:decoration-hp-primary-text">
              terms
            </Link>{' '}
            set out how we handle your data.
          </p>
        </div>
      </div>
    </div>
  );
}
