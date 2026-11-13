import Link from 'next/link';
import { ReactNode } from 'react';
import { GooglePlayBadge, PLAY_BADGE_ON_SITE } from './google-play-badge';
import { TWA_HIDE_CLASS } from '@hookpost/frontend/components/layout/twa';
import { TRIAL_ONLY } from './trial-offer';
import { CHROME_EXTENSION_URL } from '@hookpost/frontend/components/layout/chrome.extension.url';

// The one footer for every marketing page, rendered from (landing)/layout.tsx.
//
// Before this, 25 pages carried their own footer - most of them four links
// long - and the rest had none at all. The /vs/ pages were linked from nowhere,
// and the API pages from two pages each, so crawlers and
// visitors could only reach them by typing the URL. Add a new marketing page
// here, not in a per-page footer.
type LinkGroup = [heading: string, links: [label: string, href: string][]];

const PRODUCT: LinkGroup = [
  'Product',
  [
    ['Social media scheduler', '/social-media-scheduler'],
    ['Channels', '/channels'],
    ['Discord post scheduler', '/discord-post-scheduler'],
    ['AI agents & MCP', '/mcp'],
    ['Pricing', '/pricing'],
    // /free-social-media-scheduler redirects to /pricing once new users have
    // no Free plan (trial-offer.ts), so the link goes with it.
    ...(TRIAL_ONLY
      ? []
      : ([['Free plan', '/free-social-media-scheduler']] as [string, string][])),
    ['For India (₹, UPI)', '/social-media-scheduler-india'],
    ['Best schedulers in India', '/best-social-media-scheduler-india'],
    ['By role', '/for'],
    // Only once the extension is in the Chrome Web Store (chrome.extension.url.ts).
    ...(CHROME_EXTENSION_URL
      ? ([['Add to Chrome', CHROME_EXTENSION_URL]] as [string, string][])
      : []),
  ],
];

// Slugs are the ones that actually render: alternatives/<slug>/page.tsx and
// VS_SLUGS in compare/competitor-facts.ts (some of those are noindex, which is
// fine to link: they are `follow`). The other /vs/ slugs 301 to
// /alternatives/ (next.config.js), so they are not linked twice.
const COMPARE: LinkGroup = [
  'Compare',
  [
    ['Compare tools', '/compare'],
    ['All alternatives', '/alternatives'],
    ['Planable vs Buffer vs Hootsuite', '/planable-vs-buffer-vs-hootsuite'],
    ['Open-source vs hosted', '/open-source-social-media-scheduler'],
    ['Buffer alternative', '/alternatives/buffer'],
    ['Hootsuite alternative', '/alternatives/hootsuite'],
    ['Later alternative', '/alternatives/later'],
    ['Sprout Social alternative', '/alternatives/sprout-social'],
    ['Postiz alternative', '/alternatives/postiz'],
    ['Mixpost alternative', '/alternatives/mixpost'],
    ['Publer alternative', '/alternatives/publer'],
    ['SocialPilot alternative', '/alternatives/socialpilot'],
    ['Agorapulse alternative', '/alternatives/agorapulse'],
    ['Metricool alternative', '/alternatives/metricool'],
    ['Planoly alternative', '/alternatives/planoly'],
    ['Typefully alternative', '/alternatives/typefully'],
    ['Hookpost vs Zoho Social', '/vs/zoho-social'],
    ['Hookpost vs Sendible', '/vs/sendible'],
    ['Hookpost vs Loomly', '/vs/loomly'],
    ['Hookpost vs Tailwind', '/vs/tailwind'],
    ['Hookpost vs CoSchedule', '/vs/co-schedule'],
    ['Hookpost vs MeetEdgar', '/vs/meet-edgar'],
  ],
];

const TOOLS: LinkGroup = [
  'Free tools',
  [
    ['Character counter', '/tools/character-counter'],
    ['X character counter', '/tools/x-character-counter'],
    ['LinkedIn character counter', '/tools/linkedin-character-counter'],
    ['Bluesky character counter', '/tools/bluesky-character-counter'],
    ['Thread splitter', '/tools/thread-splitter'],
    ['Social media calendar India', '/social-media-calendar-india'],
  ],
];

const DEVELOPERS: LinkGroup = [
  'Developers',
  [
    ['Public API', '/docs/public-api'],
    ['OAuth apps', '/docs/oauth'],
    ['Scheduling API', '/social-media-scheduling-api'],
    ['MCP servers compared', '/social-media-mcp-servers'],
    ['n8n integration', '/integrations/n8n'],
    ['Guides', '/guides'],
  ],
];

const COMPANY: LinkGroup = [
  'Company',
  [
    ['About', '/about'],
    ['Contact', '/contact'],
    ['Affiliates (earn 30%)', '/affiliates'],
    ['Privacy', '/privacy'],
    ['Terms', '/terms'],
  ],
];

// Razorpay's payment-method review looks for these policy pages linked from
// the site, not just reachable by URL.
const POLICIES: LinkGroup = [
  'Policies',
  [
    ['Refunds', '/refund-policy'],
    ['Cancellation', '/cancellation-policy'],
    ['Shipping & delivery', '/shipping-policy'],
    ['Data deletion', '/data-deletion'],
  ],
];

// Inside the Google Play app (TWA_HIDE_CLASS, see components/layout/twa.ts) the
// footer drops everything that sells or prices a plan: the Product group
// (Pricing, Free plan, For India with rupee prices), every Compare page (they
// are price comparisons) and the affiliate programme. Policies, Company and
// Developers stay, because the app links to its policy pages.
const HIDDEN_IN_TWA = ['/affiliates'];

const Group = ({
  group: [heading, links],
  wide,
  extra,
  hideInTwa,
}: {
  group: LinkGroup;
  wide?: boolean;
  /** The whole group is hidden inside the Google Play app. */
  hideInTwa?: boolean;
  /** Rendered as a last list item, after the links. */
  extra?: ReactNode;
}) => (
  <div
    className={[wide ? 'sm:col-span-2' : '', hideInTwa ? TWA_HIDE_CLASS : '']
      .filter(Boolean)
      .join(' ') || undefined}
  >
    <h2 className="text-xs font-bold uppercase tracking-wider text-hp-text/60">{heading}</h2>
    <ul className={`mt-4 grid gap-2.5 text-sm ${wide ? 'sm:grid-cols-2 sm:gap-x-6' : ''}`}>
      {links.map(([label, href]) => (
        <li key={href} className={HIDDEN_IN_TWA.includes(href) ? TWA_HIDE_CLASS : undefined}>
          <Link href={href} prefetch={false} className="text-hp-text/65 transition-colors hover:text-hp-primary-text">
            {label}
          </Link>
        </li>
      ))}
      {extra ? <li>{extra}</li> : null}
    </ul>
  </div>
);

export const SiteFooter = () => (
  <footer className="border-t border-hp-border bg-hp-bg text-hp-text font-dm">
    <div className="mx-auto w-full max-w-[1280px] px-5 py-14 sm:px-10">
      <div className="flex items-center gap-2.5">
        <img src="/brand-logo-96.webp" width="28" height="28" alt="" className="h-7 w-7 object-contain" />
        <span className="font-extrabold tracking-tight">Hookpost</span>
      </div>
      <p className="mt-4 max-w-[48ch] text-sm leading-relaxed text-hp-text/50">
        Social media scheduling, by Hookstep
      </p>
      <p className="mt-2 max-w-[48ch] text-sm leading-relaxed text-hp-text/50">
        Hookpost (hookpost.hookstep.in) is unrelated to the HookPost app for Shopify and to Hookle.
      </p>
      <p className="mt-2 max-w-[48ch] text-sm leading-relaxed text-hp-text/50">
        Also by Hookstep:{' '}
        <a href="https://tablamigo.hookstep.in" className="text-hp-text/70 underline-offset-2 hover:text-hp-primary-text hover:underline">
          Tablamigo, meet solo travelers nearby
        </a>
      </p>

      <div className="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-7">
        <Group
          group={PRODUCT}
          hideInTwa
          extra={
            // Fills the column up to 140px: at lg the seven columns are only
            // about 100px wide, and a fixed height squashed the image. No
            // empty list item while the badge is switched off.
            PLAY_BADGE_ON_SITE ? (
              <GooglePlayBadge
                medium="footer"
                lazy
                className="h-auto w-full max-w-[140px] -ml-[6px]"
              />
            ) : undefined
          }
        />
        <Group group={COMPARE} wide hideInTwa />
        <Group group={TOOLS} />
        <Group group={DEVELOPERS} />
        <Group group={COMPANY} />
        <Group group={POLICIES} />
      </div>

      <div className="mt-12 flex flex-col gap-3 border-t border-hp-border pt-7 text-sm text-hp-text/60 sm:flex-row sm:items-center sm:justify-between">
        {/* No address here: /contact shows the area only (Ghatkopar, Mumbai),
            on the founder's instruction. Never print the street address. */}
        <p>
          © {new Date().getFullYear()} Hookstep.
        </p>
        <div className="flex flex-wrap items-center gap-6">
          <a
            href="https://www.linkedin.com/company/hookpost"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-hp-primary-text"
          >
            LinkedIn
          </a>
          <a href="mailto:support@hookstep.in" className="hover:text-hp-primary-text">
            support@hookstep.in
          </a>
        </div>
      </div>
    </div>
  </footer>
);
