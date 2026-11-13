import { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '../site-nav';
import { withSocial } from '../social-meta';

// Razorpay's ICICI netbanking confirmation demands a "Shipping and Exchange"
// page in addition to terms/privacy/refund/cancellation/contact. Hookpost ships
// nothing physical, so this page states the delivery model truthfully - instant
// digital provisioning against the account - rather than inventing a courier
// policy. It introduces no new commercial terms.
export const metadata: Metadata = withSocial({
  title: 'Shipping & Delivery Policy | Hookpost',
  description:
    'How Hookpost delivers what you pay for: instant digital provisioning to your account, no physical shipment, and what to do if access does not appear.',
  alternates: { canonical: 'https://hookpost.hookstep.in/shipping-policy' },
});

const SUPPORT_EMAIL = 'support@hookstep.in';

export default function ShippingPolicyPage() {
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
          Shipping &amp; Delivery Policy
        </h1>
        <p className="mt-4 text-[15px] text-hp-text/50">
          Operated by JR Consulting Co. Last updated 8 September 2026.
        </p>

        <div className="mt-12 space-y-8 text-[16px] leading-relaxed text-hp-text/70">
          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Nothing physical is shipped
            </h2>
            <p className="mt-3">
              Hookpost is a software service delivered entirely over the
              internet. There is no physical product, no courier, no tracking
              number and no delivery address. We do not ship goods, and no
              shipping charges are ever added to your order.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              How delivery works
            </h2>
            <p className="mt-3">
              Delivery is the activation of your plan on your Hookpost account.
              When a payment succeeds, the plan is applied to your account
              immediately &mdash; normally within a few seconds of Razorpay
              confirming the payment, and in all cases within 24 hours. You do
              not need to do anything to receive it: sign in and the new limits,
              channels and features are already there.
            </p>
            <p className="mt-3">
              A payment receipt is emailed to the address on your account. Your
              plan, billing period and renewal date are always visible inside
              the app under billing.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Service territory
            </h2>
            <p className="mt-3">
              Hookpost is available worldwide wherever the social networks we
              support are accessible. Because delivery is digital, there are no
              regional shipping restrictions and no customs, duties or import
              charges.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              If your plan does not activate
            </h2>
            <p className="mt-3">
              If you have paid and your plan has not appeared on your account
              within 24 hours, that is a fault on our side. Email{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>{' '}
              with the payment reference from your receipt and we will either
              activate the plan or refund the payment in full.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Exchanges
            </h2>
            <p className="mt-3">
              Because nothing is shipped, there is nothing to return or exchange.
              You can change plans at any time from inside the app &mdash;
              upgrades apply immediately and downgrades apply from your next
              billing period. Cancellation and refund terms are set out in our{' '}
              <Link
                href="/cancellation-policy"
                className="text-hp-primary-text hover:underline"
              >
                Cancellation Policy
              </Link>{' '}
              and{' '}
              <Link
                href="/refund-policy"
                className="text-hp-primary-text hover:underline"
              >
                Refund Policy
              </Link>
              .
            </p>
          </section>

          <section>
            <h2 className="text-xl font-bold font-jakarta text-hp-text">
              Contact
            </h2>
            <p className="mt-3">
              Questions about delivery or billing go to{' '}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="text-hp-primary-text hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
              , or use the form on our{' '}
              <Link href="/contact" className="text-hp-primary-text hover:underline">
                contact page
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
