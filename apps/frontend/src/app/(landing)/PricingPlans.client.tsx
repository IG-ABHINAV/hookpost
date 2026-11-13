'use client';

import { useFestiveCard } from '@hookpost/frontend/components/billing/holiday.offer.banner';
import { useState } from 'react';
import Link from 'next/link';
import {
  HOOKPOST_PRICE,
  PricingInnerInterface,
  pricingUSD,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import {
  planFeatureLabel,
  planLimitItems,
} from '@hookpost/frontend/components/billing/plan.features';
import {
  CHARGE_CURRENCY_NOTE,
  firstMonthOfferOf,
  paymentMethodsFor,
  usePublicPricingContextState,
} from '@hookpost/frontend/components/billing/use.pricing.context';
import { pricingPageOfferLine } from '@hookpost/nestjs-libraries/services/first.month.offer';
import { groupDigits } from '@hookpost/frontend/components/billing/group.digits';

export interface PricingPlansProps {
  id?: string;
  /**
   * New users have no Free plan (a trial cutoff is set): no ₹0 card, the paid
   * cards' button is trialCta, and trialNote says what the free posts and the
   * first payment cost. Passed by the server wrapper in ./PricingPlans, which
   * reads trial-offer.ts at build.
   */
  trialOnly?: boolean;
  /** The free-posts terms, shown under the heading when trialOnly. */
  trialNote?: string;
  /** The paid cards' button label when trialOnly. */
  trialCta?: string;
  /**
   * The dollar plans are sold too (USD_CHECKOUT=on, read at build by the
   * server wrapper from usd-offer.ts). Then this visitor's currency is not
   * known until the pricing context answers, so prices and the currency line
   * show a skeleton until it has, instead of rupees that flip to dollars.
   */
  usdMarketed?: boolean;
  /** trialNote for a visitor billed in dollars (no first-month offer, no UPI). */
  trialNoteUsd?: string;
  /**
   * /pricing only: the first-month offer's line, for a visitor billed in
   * rupees while the server has the offer (pricing context). Not on the
   * homepage.
   */
  firstMonthOffer?: boolean;
  /**
   * holiday.offer.ts currentFestival()?.key at build, from the server
   * wrapper, so the card's festival dressing hydrates as it was rendered.
   */
  festivalKey?: string | null;
}

// Every page that shows these cards is edge-cached by Cloudflare for every
// visitor, so the HTML must not depend on the request: anything picked from
// the country would really be the country of whoever filled the cache after
// the last purge. After hydration the uncached /api/public/pricing-context
// says what this visitor is charged. While only rupees are sold the cards
// render rupees from the start; once dollars are sold too (usdMarketed) they
// render a skeleton until that answer, so nobody sees ₹ turn into $.

// Every limit the plan has (pricing.ts TIER_LIMITS), in the words the app's
// own plan list uses: planLimitItems in plan.features.ts, which the paywall
// and Billing read too. The cards used to print "Unlimited team members" for
// any plan with team_members, while the seat cap is team_member_limit and
// organization.service.ts enforces it, "Public API" on Free, which has
// public_api: false, and nothing about the CLI.
export const planFeatures = (plan: PricingInnerInterface): string[] =>
  planLimitItems(plan).map((f) => planFeatureLabel(f));

/**
 * Shared pricing cards for the homepage and /pricing. Figures live in
 * pricing.ts; do not restate them here or in comments.
 *
 * No struck-through "was" prices and no "% OFF" badges: the anchor figures in
 * pricing.ts were never charged to anyone, and a reference price nobody ever
 * paid is a misleading-pricing claim, not a discount. The real price is the
 * only one shown.
 */
export const PricingPlansClient = ({
  id,
  trialOnly = false,
  trialNote,
  trialCta,
  usdMarketed = false,
  trialNoteUsd,
  firstMonthOffer = false,
  festivalKey,
}: PricingPlansProps) => {
  // Which plan carries the highlight. null = nobody has pointed at a card yet,
  // so the featured plan keeps it. Deliberately NOT cleared on mouse-leave:
  // once you have pointed at a plan, that plan stays lit when the cursor moves
  // away, instead of snapping back to the middle card.
  const [litPlan, setLitPlan] = useState<string | null>(null);

  // The server's answer, or null before it arrives (and if it never does).
  // The cards show whatever it says checkout charges: rupees for everyone
  // while the dollar plans are not sold, and rupees if it never answers.
  const { ctx, settled } = usePublicPricingContextState();
  const festive = useFestiveCard(festivalKey);
  // Shown in dollars to every visitor, India included (pricing.ts
  // HOOKPOST_PRICE, the owner, 8 Nov 2026); checkout charges the one INR
  // plan, so the context no longer decides what these cards print.
  const currency = 'USD';
  const activePricing = pricingUSD;
  const sym = '$';
  // groupDigits, not toLocaleString: these cards render while the homepage
  // hydrates, and a first Intl call loads ICU then (group.digits.ts).
  const money = (n: number) => `${sym}${groupDigits(n, 'en-US')}`;
  const pending = false;
  void usdMarketed;
  void settled;

  // Every new purchase is the INR plan or order: UPI, cards or NetBanking.
  const paymentMethodText = paymentMethodsFor('INR');
  const note = trialNote ?? trialNoteUsd;
  // The first-month offer for new customers (first.month.offer.ts). Not when
  // trialOnly: the free-posts note above already states the offer.
  const offerTerms = firstMonthOffer && !trialOnly ? firstMonthOfferOf(ctx) : null;
  const offerLine = offerTerms && !pending ? pricingPageOfferLine(offerTerms) : null;
  // One paid plan since 8 Nov 2026 (pricing.ts HOOKPOST), monthly only:
  // Standard and Pro are no longer sold (their subscribers keep them).
  const allPlans = [
    {
      name: 'Free',
      price: money(activePricing.FREE.month_price),
      blurb: 'Enough to see whether it fits.',
      features: [...planFeatures(activePricing.FREE), 'Visual calendar'],
      yearly: null as string | null,
      cta: 'Start free',
      featured: false,
    },
    {
      name: 'Hookpost',
      price: money(HOOKPOST_PRICE.displayUsd),
      blurb: 'Every channel and feature. One plan, billed monthly.',
      features: planFeatures(activePricing.HOOKPOST),
      yearly: null as string | null,
      cta: trialOnly && trialCta ? trialCta : 'Choose Hookpost',
      featured: true,
    },
  ];
  // No ₹0 card once new users have to start the trial: there is no Free plan
  // to sign up for.
  const plans = trialOnly
    ? allPlans.filter((p) => p.name !== 'Free')
    : allPlans;

  return (
    <section id={id} className="border-t border-hp-border bg-white/[0.015]">
      <div className="mx-auto w-full max-w-[1280px] px-5 py-20 sm:px-10">
        <div className="flex flex-col items-center gap-6 text-center">
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight font-jakarta sm:text-4xl text-balance">
              Flat pricing, per plan — not per channel
            </h2>
            <p className="mt-3 mx-auto max-w-[60ch] text-hp-text/60">
              No setup fee and no per-channel charge.
              {pending ? null : <> Pay by {paymentMethodText}.</>}
              {/* True for every plan sold here (Razorpay, rupees or dollars):
                  cancel stops Razorpay at once and the plan keeps its paid
                  time (billing sandbox s2, s14). */}
              {' '}Cancel anytime: your plan runs to the end of the period you
              paid for.
            </p>
            {trialOnly && note && !pending ? (
              <p className="mt-3 mx-auto max-w-[60ch] text-hp-text/60">
                {note}
              </p>
            ) : null}
            {offerLine ? (
              <p
                className="mt-3 mx-auto max-w-[60ch] text-hp-text/80"
                data-testid="first-month-offer-line"
              >
                {offerLine}
              </p>
            ) : null}
          </div>

          {/* No currency pill: there is one shown price, in dollars. */}
        </div>

        {/* Centred, whether it holds one card (the plan) or two (Free too). */}
        <div
          data-testid="plan-cards"
          className={
            plans.length === 1
              ? 'mx-auto mt-14 flex max-w-[420px] justify-center'
              : 'mx-auto mt-14 grid max-w-[800px] gap-6 md:grid-cols-2'
          }
        >
          {plans.map((p) => (
            <div
              key={p.name}
              // State, not a CSS :hover. CSS cannot remember which card you
              // pointed at last, and the requirement is that the highlight
              // stays put when the cursor leaves rather than snapping back to
              // the middle card. onMouseEnter only - there is no matching
              // onMouseLeave on purpose. onFocus covers keyboard tabbing, and
              // onTouchStart covers phones, where :hover does not exist at all.
              onMouseEnter={() => setLitPlan(p.name)}
              onFocus={() => setLitPlan(p.name)}
              onTouchStart={() => setLitPlan(p.name)}
              style={p.featured ? festive.cardStyle : undefined}
              className={
                'relative flex w-full flex-col rounded-2xl border p-7 transition-all duration-200 ' +
                ((litPlan === null ? p.featured : litPlan === p.name)
                  ? 'border-hp-primary bg-hp-primary/[0.06] -translate-y-1 ' +
                    'shadow-[0_0_0_1px_rgb(var(--hp-primary-rgb)/0.35),0_18px_40px_-18px_rgb(var(--hp-primary-rgb)/0.45)] '
                  : 'border-hp-border bg-white/[0.02] ') +
                (p.featured ? festive.cardClass : '')
              }
            >
              {/* The festival badge, lit edge and glow (holiday.offer.banner.tsx). */}
              {p.featured ? festive.decoration : null}
              {p.featured && plans.length > 1 && !festive.decoration && (
                <span className="mb-3 inline-block w-fit rounded-full bg-hp-primary px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-hp-on-primary">
                  Most chosen
                </span>
              )}
              <h3 className="text-lg font-bold font-jakarta">{p.name}</h3>
              <p className="mt-1 text-sm text-hp-text/50">{p.blurb}</p>

              <div className="mt-5 flex items-baseline gap-2">
                {pending ? (
                  <span
                    aria-label="Loading price"
                    data-testid="price-skeleton"
                    className="inline-block h-[40px] w-[96px] animate-pulse rounded-lg bg-white/[0.08]"
                  />
                ) : (
                  <span className="text-4xl font-extrabold tracking-tight font-jakarta tabular-nums text-hp-text">
                    {p.price}
                  </span>
                )}
                <span className="text-sm text-hp-text/60">/ month</span>
              </div>
              {p.yearly ? (
                <p className="mt-1 text-sm text-hp-text/60" data-testid="yearly-price">
                  or {p.yearly}
                </p>
              ) : null}

              <ul className="mt-6 flex flex-1 flex-col gap-2.5 text-[15px] text-hp-text/70">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5">
                    <span className="text-hp-primary-text">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <Link
                href="/auth"
                prefetch={false}
                className={
                  'mt-7 rounded-full px-5 py-3 text-center font-semibold transition-opacity hover:opacity-90 ' +
                  (p.featured
                    ? 'bg-hp-primary text-hp-on-primary'
                    : 'border border-hp-border-strong text-hp-text')
                }
              >
                {p.cta}
              </Link>
            </div>
          ))}
        </div>

        <p
          className="mx-auto mt-8 max-w-[70ch] text-center text-sm text-hp-text/70"
          data-testid="charge-currency-note"
        >
          {CHARGE_CURRENCY_NOTE}
        </p>

        {/* Ultimate is no longer sold (PURCHASABLE_TIERS), so it is not
            advertised here. Existing Ultimate subscribers keep their plan. */}
        <p className="mx-auto mt-8 max-w-[70ch] text-center text-sm text-hp-text/60">
          Each connected profile or page counts as one channel, so three Facebook
          pages use three of them. Need more than {activePricing.HOOKPOST.channel}?
          Email us and we will size a plan around you.
        </p>
      </div>
    </section>
  );
};

export default PricingPlansClient;
