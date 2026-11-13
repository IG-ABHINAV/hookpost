import { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';
import { pricing } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { gumroadRedeemEnabled } from '@hookpost/nestjs-libraries/services/gumroad.license';
import {
  planFeatureLabel,
  planLimitItems,
} from '@hookpost/frontend/components/billing/plan.features';

// Where a Gumroad purchase's post-purchase content sends the buyer: how to
// turn the license key into a plan (POST /billing/gumroad/redeem behind the
// "Bought on Gumroad?" link on the paywall and on Billing). A how-to for
// buyers, not a page to rank, so it is noindex and not in the sitemap.
//
// It exists only while redeeming is on: the same rule as the backend
// (gumroadRedeemEnabled: a GUMROAD_PRODUCT_* and GUMROAD_ACCESS_TOKEN set),
// read from the server's .env on every request (deploy.sh links it into
// apps/frontend), so it is never prerendered. Off, it is a 404.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = withSocial({
  title: 'Redeem a Gumroad Purchase | Hookpost',
  description:
    'Bought a Hookpost plan on Gumroad? Activate it with the license key from your Gumroad receipt, in Billing or on the plans screen after you sign up.',
  alternates: { canonical: 'https://hookpost.hookstep.in/redeem' },
  robots: { index: false, follow: true },
});

const SUPPORT_EMAIL = 'support@hookstep.in';
const GUMROAD_LIBRARY = 'https://app.gumroad.com/library';

// What each plan includes: the same lines, from pricing.ts, as the /pricing
// cards and the in-app plan list (plan.features.ts).
const PLANS = [
  { name: 'Hookpost', lines: planLimitItems(pricing.HOOKPOST).map((f) => planFeatureLabel(f)) },
];

const link = 'text-hp-primary-text hover:underline';

export default function RedeemPage() {
  if (!gumroadRedeemEnabled(process.env)) notFound();
  return (
    <div className="min-h-screen bg-hp-bg text-hp-text font-dm">
      <SiteNav />
      <div className="mx-auto w-full max-w-[820px] px-5 py-20 sm:px-10 sm:py-28">
        <Link href="/" className="text-sm text-hp-text/50 transition-colors hover:text-hp-primary-text">
          ← Hookpost
        </Link>

        <h1 className="mt-6 text-4xl font-extrabold tracking-tight font-jakarta sm:text-5xl">
          Redeem a Hookpost plan bought on Gumroad
        </h1>
        <p className="mt-4 text-[17px] leading-relaxed text-hp-text/70">
          Your plan is activated with the license key from your Gumroad receipt. You enter it once,
          in the workspace you want the plan on.
        </p>

        <ol className="mt-12 space-y-8 text-[16px] leading-relaxed text-hp-text/70">
          <li>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">1. Find your license key</h2>
            <p className="mt-3">
              It is in the receipt email from Gumroad, and on the Hookpost product in your{' '}
              <a href={GUMROAD_LIBRARY} className={link} rel="noopener noreferrer" target="_blank">
                Gumroad library
              </a>
              . It looks like{' '}
              <code className="rounded bg-white/10 px-1.5 py-0.5 text-[14px] text-hp-text/90">
                XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
              </code>
              .
            </p>
          </li>
          <li>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              2. Sign in to Hookpost, or create an account
            </h2>
            <p className="mt-3">
              Already have a workspace?{' '}
              <Link href="/auth/login?returnUrl=%2Fbilling" prefetch={false} className={link}>
                Sign in
              </Link>
              . New to Hookpost?{' '}
              <Link href="/auth" prefetch={false} className={link}>
                Create an account
              </Link>
              ; any email works, it does not have to be the one you used on Gumroad.
            </p>
          </li>
          <li>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">3. Enter the key</h2>
            <p className="mt-3">
              Choose <strong className="text-hp-text/90">Bought on Gumroad? Enter your license key</strong>,
              paste the key and press <strong className="text-hp-text/90">Redeem</strong>. A new
              account finds the link on the plans screen it sees after signing up; an existing
              workspace finds it under <strong className="text-hp-text/90">Billing</strong>. Only the
              workspace owner or an admin can enter a key.
            </p>
          </li>
          <li>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">4. Start using your plan</h2>
            <p className="mt-3">
              The plan is active as soon as the key is accepted. Billing then shows it as billed
              through Gumroad.
            </p>
          </li>
        </ol>

        <section className="mt-16">
          <h2 className="text-2xl font-bold font-jakarta text-hp-text">What each plan includes</h2>
          <div className="mt-6 grid gap-4">
            {PLANS.map((plan) => (
              <div key={plan.name} className="rounded-2xl border border-hp-border bg-white/[0.03] p-6">
                <h3 className="text-lg font-bold font-jakarta text-hp-text">{plan.name}</h3>
                <ul className="mt-3 space-y-1.5 text-[15px] text-hp-text/70">
                  {plan.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-4 text-[15px] text-hp-text/50">
            Limits are per workspace, and the monthly ones start again each month. The full list is on
            the{' '}
            <Link href="/pricing" className={link}>
              pricing page
            </Link>
            .
          </p>
        </section>

        <section className="mt-16 space-y-4 text-[16px] leading-relaxed text-hp-text/70">
          <h2 className="text-2xl font-bold font-jakarta text-hp-text">Good to know</h2>
          <p>
            One license key activates one workspace. To move it to another workspace, email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className={link}>
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
          <p>
            Your membership is billed by Gumroad. To cancel it or change how you pay, open your{' '}
            <a href={GUMROAD_LIBRARY} className={link} rel="noopener noreferrer" target="_blank">
              Gumroad library
            </a>
            . A cancelled membership keeps the plan until the end of the period you paid for.
          </p>
          <p>
            Hookpost plans on Gumroad are memberships. If your purchase was a one-time
            payment, or the key is not accepted, email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} className={link}>
              {SUPPORT_EMAIL}
            </a>{' '}
            with your Gumroad receipt and we will sort it out.
          </p>
        </section>
      </div>
    </div>
  );
}
