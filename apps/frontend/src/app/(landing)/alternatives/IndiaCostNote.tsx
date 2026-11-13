import Link from 'next/link';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { COMPETITOR_FACTS, FACTS_CHECKED, priceAmount } from '../compare/competitor-facts';
import { offer, TRIAL_ROW } from '../trial-offer';
import { usdCopy } from '../usd-offer';
import { HOOKPOST_DISPLAY_PRICE } from '@hookpost/frontend/app/(landing)/usd-offer';

// "What it costs from India" block for the /alternatives pages. Reads the same
// verified vendor facts as /compare, so the two can never disagree. It says
// plainly when a competitor already shows rupee prices - several do - because
// the honest difference is UPI Autopay and flat pricing, not the currency.
//
// The heading answers the "<vendor> price in India" query people search
// ("What <vendor> costs in India", reworded on 11 Oct so it reads as a
// sentence and not a pasted keyword): the
// results for it had no rupee answer except one directory's figure (11 Oct
// 2026). A rupee figure is printed only when one was actually seen (inrEntry);
// otherwise the block says the page localises and does not guess a number.
export const IndiaCostNote = ({ slug }: { slug: string }) => {
  const c = COMPETITOR_FACTS[slug];
  if (!c) return null;
  const { HOOKPOST, FREE } = pricingINR;
  const p = c.cheapestPaid;
  const sym = p?.currency === 'USD' ? '$' : p?.currency === 'EUR' ? '€' : '';
  const perChannel = c.pricingModel === 'per channel' && p?.usdMonthly != null;
  const fiveCh = perChannel ? Math.round(p!.usdMonthly! * HOOKPOST.channel * 100) / 100 : null;

  return (
    <section className="bg-hp-surface border border-hp-border rounded-2xl p-6 sm:p-8 space-y-4">
      <h2 className="text-2xl sm:text-3xl font-bold text-hp-text">
        What {c.name} costs in India, next to Hookpost&apos;s plans
      </h2>
      <ul className="space-y-2 text-hp-text-2 leading-relaxed list-disc ps-5">
        <li>
          <strong className="text-hp-text">{c.name}:</strong>{' '}
          {p
            ? `cheapest paid plan ${sym}${priceAmount(p)} ${p.billing === 'one-time' ? 'one-time' : `per ${p.per.replace('/month', ' per month')}`}${p.billing === 'annual' ? ', billed annually' : ''}`
            : 'no published price'}
          {fiveCh != null ? `, so ${HOOKPOST.channel} channels come to ${sym}${priceAmount({ price: fiveCh, currency: p!.currency })} a month` : ''}.{' '}
          {c.inr
            ? c.inrEntry
              ? `Its pricing page shows rupee prices to Indian visitors: ${c.inrEntry}.`
              : 'Its pricing page shows rupee prices to Indian visitors; open it from India to see the current figure.'
            : 'Its pricing page shows US dollars, so you need a card that allows international payments.'}{' '}
          {c.freePlan ? `Free plan: ${c.freePlan}.` : c.freeTrialDays ? `No free plan; ${c.freeTrialDays}-day trial.` : 'No free plan.'}
        </li>
        <li>
          <strong className="text-hp-text">{usdCopy('Hookpost:', 'Hookpost in India:')}</strong> {HOOKPOST_DISPLAY_PRICE} a month flat for {HOOKPOST.channel} channels,
          billed in rupees with UPI Autopay, cards or NetBanking.{' '}
          {offer(`Free plan: ${FREE.channel} channels and ${FREE.posts_per_month} posts a month.`, `${TRIAL_ROW}.`)}
        </li>
      </ul>
      <p className="text-sm text-hp-text/50">
        {c.name} figures read from its pricing page on {FACTS_CHECKED}
        {c.inrEntry && c.inrChecked ? `, and the rupee price on ${c.inrChecked}` : ''}; prices can differ by country.{' '}
        <Link href="/social-media-scheduler-india" className="text-hp-primary-text underline">
          More on paying from India
        </Link>
        .
      </p>
    </section>
  );
};
