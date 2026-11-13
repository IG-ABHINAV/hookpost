/**
 * The figures burned into the homepage demo video's cuts (hero-demo.ts). They
 * are pixels and speech in the MP4s, so a change elsewhere never reaches them.
 * hero-demo.spec.ts holds every one against its source:
 * - The end card's "then $7/month": pricingUSD.HOOKPOST.month_price in
 *   libraries/nestjs-libraries/src/database/prisma/subscriptions/pricing.ts.
 * - The end card's free posts: FREE_POST_LIMIT in trial.policy.ts (same folder).
 * - The networks: PUBLISHED_NETWORKS in channels/published-networks.ts.
 *
 * When a source changes, these do not change on their own: re-cut the video
 * and publish it under new file names (hero-demo.ts says why), then update
 * this file to match the new cut.
 */
export const HERO_DEMO_FACTS = {
  /**
   * End card small print "No card needed · then $7/month" (re-cut 10 Nov 2026). The Standard $19 / Pro $29 price
   * card and the spoken "Plans start at $19 a month." are cut from both cuts.
   */
  plan: { usdPerMonth: 7 },
  /** End card: "Get 3 free posts →" (no trial since 28 Oct 2026). */
  freePosts: 3,
  /** Said, with an icon each: the seven networks, in the order said. */
  networks: ['Instagram', 'LinkedIn', 'X', 'Threads', 'Facebook', 'YouTube', 'Pinterest'],
} as const;

/**
 * The 16:9 cut as the homepage VideoObject and the video sitemap describe it
 * (hero-demo.schema.ts). durationSeconds is ffprobe's format duration of
 * the 16:9 MP4 (HERO_DEMO.desktop.mp4); hero-demo.spec.ts reads the same
 * figure from the file's mvhd box, so a re-cut that changes the length fails
 * there.
 *
 * uploadDate is the day the cut went live on the homepage, as a full ISO 8601
 * instant WITH an offset: 10 Nov 2026, the re-cut without the $19 line (2 Nov: without
 * the trial line; the first Script 1 cut went live on 25 Oct). The TIME is not the real minute -
 * 10:00 is the hour first picked when the offset was added on 28 Oct 2026,
 * kept for the re-cut, because the property needs one. Google only needs
 * the instant to be valid and not in the future.
 * A bare '2026-10-25' is what Search Console rejected
 * on 25 Oct 2026 - "Datetime property 'uploadDate' is missing a time zone" and
 * "Invalid datetime value for 'uploadDate'" - because Google reads uploadDate
 * as a datetime, not a date, and will not guess the zone. The offset is IST
 * (+05:30), the zone the site is operated in. schema-datetime.ts holds the
 * rule and schema-datetime.spec.ts fails on any JSON-LD datetime without one.
 */
export const HERO_DEMO_VIDEO_FACTS = {
  durationSeconds: 40.3,
  uploadDate: '2026-11-10T10:00:00+05:30',
} as const;
