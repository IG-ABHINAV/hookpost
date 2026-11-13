import { AdLanding, adMetadata } from '../ad-landing/ad-landing';
import { CLAUDE_PAGE } from '../ad-landing/ad-pages';

// Ad landing page: see ad-landing/ad-landing.tsx for what every claim rests on.
export const metadata = adMetadata(CLAUDE_PAGE);

export default function Page() {
  return <AdLanding page={CLAUDE_PAGE} />;
}
