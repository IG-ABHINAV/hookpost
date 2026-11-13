import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { MEDIA_RETENTION_POLICY } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
import { offer, TRIAL_DAYS, TRIAL_ONLY, trialTermsDate } from '../trial-offer';

// Fourth of the four URLs Razorpay's page-compliance check requires. The
// substance already existed in /terms ("Subscriptions renew automatically ...
// unless cancelled prior to renewal", "Cancelling stops future recurring
// charges"); this gives it a dedicated, linkable page.
export const metadata: Metadata = withSocial({
  title: 'Cancellation Policy | Hookpost',
  description:
    'How to cancel your Hookpost subscription, when cancellation takes effect, and what happens to your scheduled posts and connected channels.',
  alternates: { canonical: 'https://hookpost.hookstep.in/cancellation-policy' },
});

const SUPPORT_EMAIL = 'support@hookstep.in';

export default function CancellationPolicyPage() {
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
          Cancellation Policy
        </h1>
        <p className="mt-4 text-[15px] text-hp-text/50">
          Operated by JR Consulting Co. Last updated {offer('8 September 2026', trialTermsDate('day-month'))}.
        </p>

        <div className="mt-12 space-y-8 text-[16px] leading-relaxed text-hp-text/70">
          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              How to cancel
            </h2>
            <p className="mt-3">
              Cancel at any time from <strong className="text-hp-text/90">Settings → Billing</strong>{' '}
              inside your account. There is no cancellation fee, no notice
              period, and no need to contact us first. If you would rather we
              did it for you, email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              from the address on the account.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              When it takes effect
            </h2>
            <p className="mt-3">
              Subscriptions renew automatically at the end of each billing
              period unless cancelled before renewal. Cancelling stops all
              future recurring charges immediately.
            </p>
            <p className="mt-3">
              You keep paid access until the end of the period you have already
              paid for. We do not cut off access on the day you cancel, and we
              do not refund the remainder of the current period — see the{' '}
              <Link
                href="/refund-policy"
                className="text-hp-primary-text hover:underline"
              >
                refund policy
              </Link>
              .
            </p>
          </section>

          {/* The trials already running; new workspaces get free posts and no
              trial (trial-offer.ts). */}
          {TRIAL_ONLY ? (
            <section>
              <h2 className="text-xl font-bold font-jakarta text-hp-text">
                Cancelling a trial
              </h2>
              <p className="mt-3">
                A {TRIAL_DAYS}-day trial that a workspace has already started can be cancelled at any time before its
                first charge, from{' '}
                <strong className="text-hp-text/90">Settings → Billing</strong>.
                Nothing is charged, and you keep access until the date the first
                charge was due. Cancel at least 24 hours before that date: your
                bank may start the debit up to a day early, and if a debit it
                had already started goes through, we refund it in full. A UPI
                AutoPay mandate can also be revoked from your UPI app.
              </p>
            </section>
          ) : null}

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              What happens to your content
            </h2>
            {offer(
              <>
                <p className="mt-3">
                  When the paid period ends your account moves to the free plan
                  rather than being deleted. Posts already published stay published
                  on the social networks they went to — those are your accounts and
                  we have no control over them.
                </p>
                <p className="mt-3">
                  Scheduled posts that exceed the free plan&apos;s limits will not
                  publish. If you intend to cancel and have posts queued, either
                  publish them beforehand or export what you need first.
                </p>
              </>,
              <>
                <p className="mt-3">
                  When the paid period or the trial ends, the workspace is paused
                  rather than deleted: your channels and posts are kept until you
                  choose a plan, and their media files as described below. A workspace that had Hookpost&apos;s original free
                  tier goes back to it instead. Posts already published stay
                  published on the social networks they went to — those are your
                  accounts and we have no control over them.
                </p>
                <p className="mt-3">
                  Scheduled posts will not publish while the workspace is paused,
                  or beyond the original free tier&apos;s limits. If you intend to
                  cancel and have posts queued, either publish them beforehand or
                  export what you need first.
                </p>
              </>
            )}
            {/* MEDIA_RETENTION_POLICY (trial.policy.ts): the rule MediaRetentionService carries out. */}
            <p className="mt-3">{MEDIA_RETENTION_POLICY}</p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Deleting your account entirely
            </h2>
            <p className="mt-3">
              Cancelling a subscription is not the same as deleting your
              account. To remove your account and data, follow the{' '}
              <Link
                href="/data-deletion"
                className="text-hp-primary-text hover:underline"
              >
                data deletion
              </Link>{' '}
              process.
            </p>
          </section>

          <section className="border-t border-hp-border pt-8">
            <p>
              Anything unclear, or a cancellation that did not go through? Email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
