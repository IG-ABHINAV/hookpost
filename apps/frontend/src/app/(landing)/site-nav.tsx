// Server component. The nav is a client component (the menu toggle and the
// signed-in check), so it cannot read the trial cutoff itself: in the browser
// process.env.TRIAL_REQUIRED_* is undefined. This wrapper decides the sign-up
// label at build (trial-offer.ts) and hands it down.
import { SiteNavClient } from './site-nav.client';
import { offer, TRIAL_CTA } from './trial-offer';

export const SiteNav = () => (
  <SiteNavClient ctaLabel={offer('Start free', TRIAL_CTA)} />
);
