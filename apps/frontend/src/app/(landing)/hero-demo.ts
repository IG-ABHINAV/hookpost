/**
 * The homepage demo video, under the hero: the owner's "Script 1" homepage
 * cut, recorded 25 Oct 2026, re-cut on 2 Nov 2026 to drop its closing trial
 * offer (below). It replaced the 24 Oct round-5 ad cuts (which
 * named Hootsuite and Sprout Social), and those a synthetic-voice walkthrough
 * that showed a Free plan, a $15 Standard and a 7-day trial.
 *
 * Source: hookpost-homepage-s1-16x9.mp4 and -9x16.mp4 from the 24-25 Oct ad
 * edit (1080p masters, no longer on disk). Both cuts are 40.3 s and say the
 * same words; only the layout differs (16:9 puts the face beside the panels, 9:16 above or instead
 * of them). Each cut ships in two encodes, and the browser plays the first one
 * it can (hero-demo-video.tsx lists them in this order):
 * - AV1 + Opus WebM (SVT-AV1 CRF 42, Opus 48k): 1.6 MB (16:9) and 1.4 MB
 *   (9:16), for Chrome, Edge, Firefox, and Safari on AV1 hardware.
 * - H.264 High level 3.1 + AAC MP4 (x264 veryslow CRF 27 capped at 900 kb/s,
 *   AAC 64k, faststart, no metadata): 1.7 MB and 1.4 MB, for every other
 *   browser (most iPhones).
 * The 2 Nov re-cut was made from the 25 Oct web MP4s (the masters are gone):
 * the voice's "Start your three-day trial at" (39.27-41.17 s) is cut from
 * picture and sound, and the end card's pill and small print were repainted
 * as "Get 3 free posts →" and a "$19/month" line. His voice is cut, never
 * re-voiced.
 * The 10 Nov re-cut (scripts/brand/hero-video-price-recut.js) removed the
 * rest of the old price from both cuts: the spoken "Plans start at $19 a
 * month." and the Standard $19 / Pro $29 price card (36.10-39.27 s, a 3-frame
 * dissolve from the CLI scene to the end card, sound crossfaded 30 ms), and
 * the end card's small print now reads "No card needed · then $7/month" (two
 * lines in 9:16). Nothing in either cut says or shows $19 or $29 any more.
 * The 9:16 cut is the mobile one: 720x1280 for a box at most 320 CSS px wide.
 * Posters are AVIF (13 KB) with a WebP fallback (24-25 KB), the frame at 2.6 s
 * (the face and the hook caption).
 *
 * What is said and shown, checked by transcript and frames:
 * - Seven networks: Instagram, LinkedIn, X, Threads, Facebook, YouTube and
 *   Pinterest, each one Hookpost has published to (PUBLISHED_NETWORKS).
 * - Said last: "hookpost.hookstep.in", straight after "...the Hookpost CLI.".
 *   On the end card: "Get 3 free posts →" (FREE_POST_LIMIT) and "No card
 *   needed · then $7/month" (pricingUSD.HOOKPOST). No price is said, and no
 *   trial: new users get none since 28 Oct 2026.
 * - No free plan, no competitor, no personal name or title, and no "free"
 *   on screen except the end card's free posts (the 16:9 help excerpt is cut
 *   off before its "next free slot").
 * - The Claude Code session is replayed from its log and labelled so. The
 *   CLI panels differ: 16:9 "real CLI output · sped up · help excerpt" with
 *   a `hookpost post` example; 9:16 "real CLI output · typing re-rendered",
 *   1.5x, showing the install and the help header only.
 * hero-demo.facts.ts holds those figures and hero-demo.spec.ts binds them to
 * their sources.
 *
 * Colours: on 10 Nov 2026 both cuts were re-coloured from the old magenta
 * palette to the brand theme (Tidewire) by `pnpm brand:video`
 * (scripts/brand/hero-video.js). It starts from the magenta originals in git
 * history, moves the old palette's hues to the theme's primary (the face is
 * untouched), puts the theme's mark on the title and end cards, and inks the
 * CTA pill's text in the theme's onPrimary. Frames, audio and copy are the
 * 2 Nov cut's. Re-run it after a theme switch.
 *
 * Every file name carries the first 10 hex digits of the file's own SHA-256
 * (NAME.<hash>.EXT; hero-demo.spec.ts checks each one), so NGINX serves them
 * as immutable for a year (nginx.hookpost.conf) and a re-encode or a new cut
 * is always a new URL that no cache can answer with the old bytes.
 */

/** One breakpoint for the box (Tailwind md), the poster and the <source>. */
export const DESKTOP_QUERY = '(min-width: 768px)';

/**
 * The WebM sources' MIME type: AV1 Main profile, level 3.1 (seq_level_idx 5,
 * up to 1280x720 at 30 fps), 8-bit, with Opus. A browser that cannot decode it
 * answers canPlayType with "" and takes the MP4.
 */
export const WEBM_AV1_TYPE = 'video/webm; codecs="av01.0.05M.08, opus"';

export const HERO_DEMO = {
  desktop: {
    webm: '/video/hookpost-home-s1-16x9.d4d0426f2f.webm',
    mp4: '/video/hookpost-home-s1-16x9.31a51ee739.mp4',
    posterAvif: '/video/hookpost-home-s1-16x9.e86c2e3210.avif',
    posterWebp: '/video/hookpost-home-s1-16x9.a9ca8ae0f1.webp',
    width: 1280,
    height: 720,
  },
  mobile: {
    webm: '/video/hookpost-home-s1-9x16.4f72fe8145.webm',
    mp4: '/video/hookpost-home-s1-9x16.6ba28b4496.mp4',
    posterAvif: '/video/hookpost-home-s1-9x16.9de082db72.avif',
    posterWebp: '/video/hookpost-home-s1-9x16.a645fd3847.webp',
    width: 720,
    height: 1280,
  },
} as const;

export const HERO_DEMO_LABEL =
  'Hookpost demo: connect seven networks once, tell Claude what to post, or post from the Hookpost CLI';
