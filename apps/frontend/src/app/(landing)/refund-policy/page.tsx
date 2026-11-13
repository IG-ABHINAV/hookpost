import { Metadata } from 'next';
import Link from 'next/link';
import { REFUND_ON_REQUEST, REFUND_OUR_MISTAKE, REFUND_SUPPORT_EMAIL } from '../refund-terms';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { FREE_POST_LIMIT, offer, TRIAL_DAYS, trialTermsDate } from '../trial-offer';
import { usdCopy } from '../usd-offer';

// Razorpay's page-compliance check requires four distinct URLs: terms, privacy,
// refund and cancellation. The refund terms already existed inside /terms, but
// there was no dedicated page, and /refund-policy was not in proxy.ts's
// allowlist so it 307'd to /auth. This page restates the existing policy
// verbatim in substance - it does not introduce new commercial terms.
export const metadata: Metadata = withSocial({
  title: 'Refund Policy | Hookpost',
  description:
    'Hookpost refund policy: refunds only on request, at our discretion, less the payment gateway fee and its GST; full refunds for a double charge or a charge after cancelling.',
  alternates: { canonical: 'https://hookpost.hookstep.in/refund-policy' },
});

const SUPPORT_EMAIL = REFUND_SUPPORT_EMAIL;

export default function RefundPolicyPage() {
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm">
      <SiteNav />
      <div className="mx-auto w-full max-w-[820px] px-5 py-20 sm:px-10 sm:py-28">
        <Link
          href="/"
          className="text-sm text-hp-text/50 transition-colors hover:text-hp-primary-text"
        >
          ← Hookpost
        </Link>

        <h1 className="mt-6 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl">
          Refund Policy
        </h1>
        <p className="mt-4 text-[15px] text-hp-text/50">
          Operated by JR Consulting Co. Last updated {offer('2 November 2026', trialTermsDate('day-month'))}.
        </p>

        <div className="mt-12 space-y-8 text-[16px] leading-relaxed text-hp-text/70">
          {/* Once new workspaces get free posts there is no Free plan to
              describe here, and the trial section covers the trials already
              running (trial-offer.ts). */}
          {offer(
            <section>
              <h2 className="text-xl font-bold font-jakarta text-hp-text">
                Free plan
              </h2>
              <p className="mt-3">
                Hookpost has a free tier that does not expire and needs no card.
                Nothing is charged on it, so nothing is refundable. You can
                evaluate the product on the free plan for as long as you like
                before paying anything.
              </p>
            </section>,
            <>
            <section>
              <h2 className="text-xl font-bold font-jakarta text-hp-text">
                Free posts
              </h2>
              <p className="mt-3">
                A new workspace can create {FREE_POST_LIMIT} posts without a payment
                method and with no trial. Nothing is charged on them, so nothing
                is refundable. After that you choose a plan and its first
                payment is taken at checkout; that payment is covered by{' '}
                <strong className="text-hp-text/90">Paid subscriptions</strong> below.
              </p>
            </section>
            <section>
              <h2 className="text-xl font-bold font-jakarta text-hp-text">
                Free trial (workspaces already on one)
              </h2>
              {/* Rupee terms only for rupee plans once dollar plans are sold
                  (usd-offer.ts): a dollar plan is card only, and what its
                  authorisation takes is not known until the live card test,
                  so no amount and no refund of it is promised. */}
              {usdCopy(
                <p className="mt-3">
                  A workspace that started a {TRIAL_DAYS}-day trial keeps it. It
                  needs a payment method: UPI AutoPay or a card. Starting it takes a ₹5
                  check that is refunded straight away; your bank may take 5–7
                  working days to show the refund. Nothing else is charged during
                  the trial.
                </p>,
                <p className="mt-3">
                  A workspace that started a {TRIAL_DAYS}-day trial keeps it. It
                  needs a payment method. On a plan billed in Indian rupees that is UPI
                  AutoPay or a card, and starting it takes a ₹5 check that is
                  refunded straight away; your bank may take 5–7 working days to
                  show the refund. On a plan billed in US dollars it is a card,
                  which is authorised for the plan when you start the trial.
                </p>
              )}
              <p className="mt-3">
                The first charge is taken automatically on the date shown at
                checkout and in the welcome email. Cancel at least 24 hours
                before that date if you do not want to continue, because your
                bank may start the debit up to a day early. Cancelling during the
                trial costs nothing and you keep access until that date. If you
                are charged after cancelling, we refund it in full (see below).
              </p>
            </section>
            </>
          )}

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Paid subscriptions
            </h2>
            {/* refund-terms.ts: the same words as /terms and the FAQs. */}
            <p className="mt-3">{REFUND_ON_REQUEST}</p>
            <p className="mt-3">
              This does not limit any refund you are entitled to under
              applicable consumer law, which takes precedence over this policy.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Duplicate and failed charges
            </h2>
            <p className="mt-3">
              {REFUND_OUR_MISTAKE} Email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              with the payment reference and we will process it.
            </p>
          </section>

          {/* The plan-change rules, as the billing page and the preview under
              each plan state them and as the code carries them out
              (razorpay.mapping.ts): a page that says fees are non-refundable
              has to say what happens to the days already paid for when the
              plan moves, or the two read as a contradiction. */}
          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Changing plan
            </h2>
            <p className="mt-3">
              An upgrade &mdash; a higher tier, or monthly to yearly &mdash;
              takes effect at once, and the unused days of the billing cycle you
              have already paid for are credited against the new plan. Nothing
              is refunded because nothing is lost: that money buys time on the
              new plan instead. No free days are added either.
            </p>
            <p className="mt-3">
              A downgrade takes effect at the start of the next billing cycle.
              You keep the plan you paid for until the last day of the cycle,
              then the lower price starts. Nothing is charged or refunded on the
              day you ask for it, and you can call the change off in Billing
              before it takes effect.
            </p>
            <p className="mt-3">
              A plan change is not available while a payment on the plan has not
              gone through. Settle that payment first, then the change can go
              ahead.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              How refunds are paid
            </h2>
            <p className="mt-3">
              Approved refunds are returned to the original payment method
              through Razorpay. Once we initiate a refund it typically reaches
              your account within 5–7 working days, though the exact time
              depends on your bank or card issuer and is outside our control.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Stopping future charges
            </h2>
            <p className="mt-3">
              Cancelling stops all future recurring charges. See the{' '}
              <Link
                href="/cancellation-policy"
                className="text-hp-primary-text hover:underline"
              >
                cancellation policy
              </Link>{' '}
              for how to cancel and what happens to your data.
            </p>
          </section>

          <section className="border-t border-hp-border pt-8">
            <p>
              Questions about a specific charge? Email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
              . Include the payment reference and we will look it up.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
