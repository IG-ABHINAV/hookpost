/**
 * The homepage demo video as structured data: a schema.org VideoObject in the
 * homepage's JSON-LD (SeoSchemas.tsx) and a video entry on / in sitemap.xml
 * (sitemap.ts). Both describe the 16:9 cut, the one desktop plays, with the
 * fields ad-landing.tsx gives its own video.
 *
 * - URLs are absolute, on the canonical origin, built from HERO_DEMO: the
 *   H.264 MP4 (every client plays it) and the WebP poster (the thumbnail
 *   formats Google lists include WebP; AVIF is the page's own choice).
 * - Length and upload date: HERO_DEMO_VIDEO_FACTS (hero-demo.facts.ts). The
 *   duration is whole seconds, the unit the video sitemap takes.
 * - No embedUrl: the cut has no player page of its own.
 * - The description names no one and says "free" only in the sign-up offer.
 *   Its plan figures come from pricing.ts (the retired pricingUSD.STANDARD and PRO tables the cut shows), in
 *   dollars because the cut shows dollars; hero-demo.spec.ts holds the cut's
 *   figures against the same files. The offer is today's (TRIAL_SENTENCE,
 *   trial-offer.ts), not the cut's closing trial line: new users get no
 *   trial, and the page transcript says the cut's offer has changed.
 * - Next writes the sitemap's video fields into the XML unescaped, so the name
 *   and description must not contain &, < or > (hero-demo.spec.ts checks).
 *
 * Server only: it reads pricing.ts, which the client video component
 * (hero-demo-video.tsx) must not pull into the browser bundle.
 */
import type { MetadataRoute } from 'next';
import { pricingUSD } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { HERO_DEMO, HERO_DEMO_LABEL } from './hero-demo';
import { HERO_DEMO_FACTS, HERO_DEMO_VIDEO_FACTS } from './hero-demo.facts';
import { offer, TRIAL_SENTENCE } from './trial-offer';

/** "Instagram, LinkedIn, ... and Pinterest": the networks the cut names. */
const networkList = `${HERO_DEMO_FACTS.networks.slice(0, -1).join(', ')} and ${
  HERO_DEMO_FACTS.networks[HERO_DEMO_FACTS.networks.length - 1]
}`;

const ORIGIN = 'https://hookpost.hookstep.in';
const CUT = HERO_DEMO.desktop;
const STD = pricingUSD.STANDARD;

/** A length in seconds as an ISO 8601 duration of whole seconds: PT46S, PT1M5S. */
export function isoDuration(seconds: number): string {
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `PT${m ? `${m}M` : ''}${s || !m ? `${s}S` : ''}`;
}

const PRO = pricingUSD.PRO;

export const HERO_DEMO_VIDEO_DESCRIPTION =
  `Connect ${networkList} to Hookpost once, then tell Claude what you want. ` +
  'Claude writes a post in each network’s style and drops it into your Hookpost calendar; you review it ' +
  'and everything goes out on time. The same works from the Hookpost CLI. ' +
  offer('There is a free tier with no card needed.', TRIAL_SENTENCE);

/** The VideoObject node for the homepage @graph. */
export function heroDemoVideoObject() {
  return {
    '@type': 'VideoObject',
    '@id': `${ORIGIN}/#demo-video`,
    name: HERO_DEMO_LABEL,
    description: HERO_DEMO_VIDEO_DESCRIPTION,
    thumbnailUrl: `${ORIGIN}${CUT.posterWebp}`,
    contentUrl: `${ORIGIN}${CUT.mp4}`,
    uploadDate: HERO_DEMO_VIDEO_FACTS.uploadDate,
    duration: isoDuration(HERO_DEMO_VIDEO_FACTS.durationSeconds),
    width: CUT.width,
    height: CUT.height,
  };
}

type SitemapVideo = NonNullable<MetadataRoute.Sitemap[number]['videos']>[number];

/** The same video as a <video:video> entry for / in sitemap.xml. */
export function heroDemoSitemapVideo(): SitemapVideo {
  return {
    title: HERO_DEMO_LABEL,
    description: HERO_DEMO_VIDEO_DESCRIPTION,
    thumbnail_loc: `${ORIGIN}${CUT.posterWebp}`,
    content_loc: `${ORIGIN}${CUT.mp4}`,
    duration: Math.round(HERO_DEMO_VIDEO_FACTS.durationSeconds),
    publication_date: HERO_DEMO_VIDEO_FACTS.uploadDate,
  };
}
