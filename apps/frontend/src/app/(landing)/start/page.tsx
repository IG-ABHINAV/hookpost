import { AdLanding, adMetadata } from '../ad-landing/ad-landing';
import { START_PAGE } from '../ad-landing/ad-pages';

// Ad landing page: see ad-landing/ad-landing.tsx for what every claim rests on.
export const metadata = adMetadata(START_PAGE);

export default function Page() {
  return <AdLanding page={START_PAGE} />;
}
