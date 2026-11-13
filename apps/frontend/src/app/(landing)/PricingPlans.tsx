// Server component. The cards are a client component (the highlight state and
// the visitor's pricing context), so they cannot read the trial cutoff
// themselves: in the browser process.env.TRIAL_REQUIRED_* is undefined. This
// wrapper decides at build (trial-offer.ts) whether there is a Free plan to
// show, and (usd-offer.ts) whether dollars are sold too, and passes that down.
import {
  PricingPlansClient,
  type PricingPlansProps,
} from './PricingPlans.client';
import { TRIAL_CTA, TRIAL_ONLY, TRIAL_SENTENCE_IN } from './trial-offer';
import { USD_MARKETED, USD_TRIAL_SENTENCE } from './usd-offer';
import { currentFestival } from '@hookpost/frontend/components/billing/holiday.offer';

export type { PricingPlansProps };

// The trial strings are passed only when they are shown: client props travel
// in the page's RSC payload, and the Free-plan build should not carry them.
// Likewise the dollar props (usd-offer.ts) only once dollars are sold, so the
// rupee-only build renders exactly as before.
export const PricingPlans = ({ id }: Pick<PricingPlansProps, 'id'>) => {
  const usd = USD_MARKETED
    ? {
        usdMarketed: true,
        ...(TRIAL_ONLY ? { trialNoteUsd: USD_TRIAL_SENTENCE } : {}),
      }
    : {};
  const festivalKey = currentFestival()?.key ?? null;
  return TRIAL_ONLY ? (
    <PricingPlansClient
      id={id}
      festivalKey={festivalKey}
      trialOnly
      // Shown to a visitor billed in rupees; dollars get trialNoteUsd.
      trialNote={TRIAL_SENTENCE_IN}
      trialCta={TRIAL_CTA}
      {...usd}
    />
  ) : (
    <PricingPlansClient id={id} festivalKey={festivalKey} {...usd} />
  );
};

export default PricingPlans;
