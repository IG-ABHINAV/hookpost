import { MetadataRoute } from 'next';
import { execFileSync } from 'node:child_process';
import { PAIRS, VS_SLUGS, isIndexedPair, isIndexedVs } from './(landing)/compare/competitor-facts';
import { CHANNEL_SPECS, isIndexedChannel } from './(landing)/channels/channel-specs';
import { TRIAL_ONLY } from './(landing)/trial-offer';
import { heroDemoSitemapVideo } from './(landing)/hero-demo.schema';
import { ANSWER_PAGES } from './(landing)/guides/_answer/answer-pages';
import { FESTIVALS } from './(landing)/social-media-calendar-india/festivals';

const baseUrl = 'https://hookpost.hookstep.in';

// lastmod comes from git: the newest commit that touched the files a page is
// built from (its own directory, plus the shared data a page family reads).
//
// It used to be a block of hand-bumped dates. Those went stale within days -
// on 11 Oct the newest was 28 Sep while home, /pricing, the Claude guide and
// the legal pages had all changed since - and Bing schedules recrawls on
// lastmod. Before that it was `new Date()` on every URL, which search engines
// learn to ignore. Real per-page dates are the only version worth sending.
//
// Needs the full history: in a shallow clone every file would date to the one
// commit present, so lastmod is left out instead (deploy-prod.yml checks out
// with fetch-depth: 0). Same when git is not available at all, e.g. a Docker
// build without .git. An absent lastmod is neutral; a wrong one is not.
const LANDING = 'apps/frontend/src/app/(landing)';
const PRICING = 'libraries/nestjs-libraries/src/database/prisma/subscriptions/pricing.ts';

const fileDates = (): Map<string, number> | null => {
  try {
    const run = (args: string[], cwd = process.cwd()) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      });
    if (run(['rev-parse', '--is-shallow-repository']).trim() !== 'false') {
      console.warn('sitemap: shallow git clone, lastmod omitted');
      return null;
    }
    const root = run(['rev-parse', '--show-toplevel']).trim();
    const log = run(['log', '--format=%x00%ct', '--name-only', '--', LANDING, PRICING], root);
    const dates = new Map<string, number>();
    let when = 0;
    for (const line of log.split('\n')) {
      if (line.startsWith('\0')) when = Number(line.slice(1)) * 1000;
      else if (line && when > (dates.get(line) ?? 0)) dates.set(line, when);
    }
    return dates;
  } catch {
    console.warn('sitemap: git history unavailable, lastmod omitted');
    return null;
  }
};

const DATES = fileDates();

// Files directly inside a landing directory (not its child routes).
const dirFiles = (dir: string) => {
  const prefix = `${LANDING}/${dir}/`;
  return [...(DATES?.keys() ?? [])].filter(
    (f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')
  );
};

// The sources a route is built from. Shared chrome (layout, nav, footer) is
// deliberately not counted: a footer link is not a change to every page.
const sourcesOf = (route: string): string[] => {
  const [, family, slug] = route.split('/');
  if (route === '/') {
    return [
      ...['page.tsx', 'LandingFaq.tsx', 'PricingPlans.tsx', 'PricingPlans.client.tsx', 'PricingContrast.tsx', 'AeoAnswerCapsule.tsx', 'SeoSchemas.tsx', 'hero-demo.ts', 'hero-demo.facts.ts', 'hero-demo.schema.ts'].map(
        (f) => `${LANDING}/${f}`
      ),
      PRICING,
    ];
  }
  // The plan cards are drawn by PricingPlans.client.tsx (the yearly price and
  // the first-month offer line live there), so it dates the page too.
  if (route === '/pricing') return [...dirFiles('pricing'), `${LANDING}/PricingPlans.tsx`, `${LANDING}/PricingPlans.client.tsx`, PRICING];
  if (family === 'channels') {
    const data = ['channel-specs.ts', 'channel-deep.ts'].map((f) => `${LANDING}/channels/${f}`);
    return slug ? [...dirFiles('channels/[channel]'), ...data] : [...dirFiles('channels'), ...data];
  }
  if (family === 'compare') {
    const data = `${LANDING}/compare/competitor-facts.ts`;
    return slug ? [...dirFiles('compare/[pair]'), data] : [...dirFiles('compare'), data];
  }
  if (route === '/claude' || route === '/cli' || route === '/start') {
    return [
      ...dirFiles(route.slice(1)),
      ...dirFiles('ad-landing'),
      `${LANDING}/compare/competitor-facts.ts`,
      `${LANDING}/channels/published-networks.ts`,
      PRICING,
    ];
  }
  // Answer pages (guides/_answer/answer-pages.ts) are also built from the
  // shared frame and facts in guides/_answer.
  if (ANSWER_PAGES.some((p) => p.path === route)) {
    return [...dirFiles(route.slice(1)), ...dirFiles('guides/_answer')];
  }
  if (family === 'vs' && slug) return dirFiles('vs/[competitor]');
  if (family === 'for' && slug) return dirFiles(`for/(roles)/${slug}`);
  if (family === 'tools' && slug) return [...dirFiles(`tools/${slug}`), ...dirFiles('tools/_lib')];
  if (family === 'social-media-calendar-india' && slug) {
    return [
      ...dirFiles('social-media-calendar-india/[festival]'),
      `${LANDING}/social-media-calendar-india/festivals.ts`,
      `${LANDING}/social-media-calendar-india/calendar-data.ts`,
    ];
  }
  return dirFiles(route.slice(1));
};

const lastmodOf = (route: string): string | undefined => {
  if (!DATES) return undefined;
  const newest = Math.max(0, ...sourcesOf(route).map((f) => DATES.get(f) ?? 0));
  return newest ? new Date(newest).toISOString() : undefined;
};

type Entry = MetadataRoute.Sitemap[number];

const page = (
  path: string,
  priority: number,
  changeFrequency: Entry['changeFrequency']
): Entry => {
  const lastModified = lastmodOf(path);
  return {
    url: path === '/' ? baseUrl : `${baseUrl}${path}`,
    ...(lastModified ? { lastModified } : {}),
    changeFrequency,
    priority,
  };
};

export default function sitemap(): MetadataRoute.Sitemap {
  // Priorities are only useful as a *relative* ranking. Previously 82 of 86
  // URLs sat at >= 0.85, which told crawlers nothing. These spread across the
  // full range so the hubs and money pages actually stand out.
  const core: Entry[] = [
    // The demo video under the hero, as a video sitemap entry
    // (hero-demo.schema.ts; the VideoObject in the homepage JSON-LD matches).
    { ...page('/', 1.0, 'weekly'), videos: [heroDemoSitemapVideo()] },
    page('/mcp', 0.9, 'weekly'),
    // The paid ads' landing pages (ad-landing/, 22 Oct 2026).
    page('/claude', 0.85, 'monthly'),
    page('/cli', 0.8, 'monthly'),
    page('/start', 0.8, 'monthly'),
    // High-intent money page. Did not exist until pricing moved off the
    // homepage fragment.
    page('/pricing', 0.9, 'weekly'),
    page('/alternatives', 0.9, 'weekly'),
    page('/channels', 0.8, 'monthly'),
    page('/for', 0.8, 'monthly'),
    page('/compare', 0.8, 'monthly'),
    page('/about', 0.7, 'monthly'),
    page('/contact', 0.7, 'monthly'),
    // The guides hub. LandingFaq linked here long before the page existed.
    page('/guides', 0.75, 'monthly'),
    // Search landing pages and free tools (added 2026-09-25).
    // Redirects to /pricing once new users have no Free plan (trial-offer.ts),
    // and a redirect does not belong in a sitemap.
    ...(TRIAL_ONLY ? [] : [page('/free-social-media-scheduler', 0.9, 'monthly')]),
    page('/social-media-scheduler-india', 0.9, 'monthly'),
    page('/tools/character-counter', 0.8, 'monthly'),
    // Round 2 (2026-09-26), picked from the SERP-backed keyword map.
    page('/social-media-scheduling-api', 0.85, 'monthly'),
    page('/integrations/n8n', 0.8, 'monthly'),
    page('/guides/schedule-discord-announcements', 0.8, 'monthly'),
    page('/guides/schedule-x-threads', 0.8, 'monthly'),
    page('/guides/cross-post-x-bluesky', 0.8, 'monthly'),
    page('/guides/cross-post-dev-articles', 0.75, 'monthly'),
    page('/alternatives/typefully', 0.8, 'monthly'),
    page('/tools/x-character-counter', 0.75, 'monthly'),
    page('/tools/bluesky-character-counter', 0.75, 'monthly'),
    page('/tools/linkedin-character-counter', 0.75, 'monthly'),
    page('/tools/thread-splitter', 0.75, 'monthly'),
    page('/affiliates', 0.6, 'monthly'),
    // Veritas SEO run (2026-09-28): India roundup, festival calendar, MCP roundup.
    page('/best-social-media-scheduler-india', 0.9, 'monthly'),
    page('/social-media-calendar-india', 0.8, 'monthly'),
    // One page per big festival (16 Oct 2026), spokes of the calendar above.
    ...FESTIVALS.map((f) => page(`/social-media-calendar-india/${f.slug}`, 0.7, 'monthly')),
    page('/social-media-mcp-servers', 0.8, 'monthly'),
    // Back from a 301 to /alternatives (22 Oct 2026): open-source vs hosted,
    // and honest that Hookpost is the hosted kind.
    page('/open-source-social-media-scheduler', 0.75, 'monthly'),
    // Search Console round, 28 Oct 2026: the three queries with impressions and
    // no clicks. The head term ("social media scheduler", 1,083 impressions,
    // 0 clicks, position 13), the Discord integration queries (211 together),
    // and the three-way MCP comparison (120).
    page('/social-media-scheduler', 0.95, 'weekly'),
    page('/discord-post-scheduler', 0.85, 'monthly'),
    page('/planable-vs-buffer-vs-hootsuite', 0.8, 'monthly'),
    // Only the pairs listed in INDEXED_COMPARE_PAIRS; the rest are noindex and
    // a noindex URL does not belong in a sitemap.
    ...PAIRS.filter(isIndexedPair).map((pair) => page(`/compare/${pair}`, 0.7, 'monthly')),
  ];

  // Developer docs — these were live and indexable but missing from the
  // sitemap entirely, so nothing pointed crawlers at them.
  const docs: Entry[] = [
    page('/docs/public-api', 0.85, 'monthly'),
    page('/docs/oauth', 0.8, 'monthly'),
  ];

  const guides: Entry[] = [
    'claude-mcp-social-media',
    // Keyword-page plan (2026-10-11): one page per search intent.
    'claude-code-social-media',
    'post-to-multiple-social-media-at-once',
    'social-media-post-schedule-kaise-kare',
  ].map((slug) => page(`/guides/${slug}`, 0.85, 'monthly'));

  // Answer pages (GEO research, 26 Oct 2026): one buyer question each.
  const answers: Entry[] = ANSWER_PAGES.map((p) => page(p.path, 0.8, 'monthly'));

  const alternatives: Entry[] = [
    'postiz',
    'buffer',
    'hootsuite',
    'sprout-social',
    'later',
    'metricool',
    'publer',
    'socialpilot',
    'agorapulse',
    'planoly',
    'mixpost',
  ].map((slug) =>
    page(`/alternatives/${slug}`, slug === 'postiz' ? 0.9 : 0.75, 'monthly')
  );

  // Only the competitors that do NOT have an /alternatives page. The ten that
  // overlap are canonicalised onto /alternatives/<slug>, so listing them here
  // too would submit a URL that points its canonical somewhere else.
  // Only the slugs in INDEXED_VS; the others are noindex.
  const vs: Entry[] = VS_SLUGS.filter(isIndexedVs).map((slug) => page(`/vs/${slug}`, 0.6, 'monthly'));

  const personas: Entry[] = [
    'creators',
    'agencies',
    'small-business',
    'students-young-creators',
    'solopreneurs-freelancers',
    'educators-nonprofits',
    'real-estate',
    'ecommerce',
    'crypto-web3',
    'fitness-coaches',
    'music-artists',
    'restaurants-cafes',
    'healthcare-clinics',
    'b2b-saas',
  ].map((slug) => page(`/for/${slug}`, 0.55, 'monthly'));

  // Every channel with a spec entry, i.e. every channel page that renders. A
  // hand-typed list here had 18 slugs and missed /channels/tiktok, a live,
  // indexable page.
  // Pages in NOINDEX_CHANNELS (Medium) are noindex, so they stay out.
  const channels: Entry[] = Object.keys(CHANNEL_SPECS)
    .filter(isIndexedChannel)
    .map((slug) => page(`/channels/${slug}`, 0.5, 'monthly'));

  // Legal pages stay listed so the entity looks complete, but at low priority.
  // /auth and /auth/login are deliberately absent: a login form has nothing to
  // rank for, and submitting it just spends crawl budget.
  const legal: Entry[] = [
    page('/privacy', 0.3, 'yearly'),
    page('/terms', 0.3, 'yearly'),
    page('/data-deletion', 0.3, 'yearly'),
    // Linked from every footer (Razorpay's review wants them) but were missing
    // here, so the sitemap under-described the site.
    page('/refund-policy', 0.3, 'yearly'),
    page('/cancellation-policy', 0.3, 'yearly'),
    page('/shipping-policy', 0.3, 'yearly'),
  ];

  return [
    ...core,
    ...docs,
    ...guides,
    ...answers,
    ...alternatives,
    ...vs,
    ...personas,
    ...channels,
    ...legal,
  ];
}
