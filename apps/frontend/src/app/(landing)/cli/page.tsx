import { AdLanding, adMetadata } from '../ad-landing/ad-landing';
import { CLI_PAGE } from '../ad-landing/ad-pages';

// Ad landing page: see ad-landing/ad-landing.tsx for what every claim rests on.
export const metadata = adMetadata(CLI_PAGE);

export default function Page() {
  return <AdLanding page={CLI_PAGE} />;
}
