import '../landing-global.scss';
import { pricingINR } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';
import { FREE_POSTS, LANDING_TIERS, offer } from './trial-offer';
import { usdCopy, usdOffers } from './usd-offer';
import { Metadata, Viewport } from 'next';
import { DM_Sans, Plus_Jakarta_Sans } from 'next/font/google';
import { FAQ_DATA } from './LandingFaq';

// style:['normal'] only. Without it next/font emits the italic face as well, so
// two declared families were loading FOUR woff2 files (102KB) and nothing on the
// marketing pages is italic.
//
// Do NOT add a `weight` array here. These are variable fonts: one file covers
// every weight. Pinning weights makes next/font emit a separate STATIC instance
// per weight - tried it, went from 4 files to 10.
//
// display: 'optional', not 'swap'. With swap, text painted in the fallback and
// then re-flowed when the woff2 arrived; the metric-adjusted fallback that
// next/font generates (adjustFontFallback, on by default) narrows the gap but
// headings still re-wrapped. On a cold desktop load from Europe that was CLS
// 0.28 on a long marketing page and 0.13 on /pricing, and
// Lighthouse with the woff2 blocked measured CLS 0. Both files are preloaded,
// so they are normally in hand for the first paint; when one is not, that page
// view keeps the size-adjusted fallback instead of shifting, and the next page
// uses the cached font. LCP does not wait on the font either way.
const dmSans = DM_Sans({
  subsets: ['latin'],
  style: ['normal'],
  variable: '--font-dm',
  display: 'optional',
  preload: true,
  adjustFontFallback: true,
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  style: ['normal'],
  variable: '--font-jakarta',
  display: 'optional',
  preload: true,
  adjustFontFallback: true,
});

import { brandHtmlAttributes, brandTokens } from '@hookpost/helpers/brand/brand-themes';
import { BrandThemeStyle } from '@hookpost/frontend/components/brand/brand-theme.style';
export const viewport: Viewport = {
  // The browser chrome matches the page: the active theme's dark background.
  themeColor: brandTokens('dark').bg,
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

import { Suspense } from 'react';
import UtmCapture from '@hookpost/helpers/utils/utm.capture';
import { ViewContentTracker } from '@hookpost/frontend/components/layout/view-content.tracker';
import { ATTRIBUTION_CAPTURE_SCRIPT } from '@hookpost/helpers/utils/attribution';
import { OpenInBrowserPrompt } from '@hookpost/frontend/components/auth/in-app-browser-notice';
import { FacebookComponent } from '@hookpost/frontend/components/layout/facebook.component';
import { GoogleTagManagerComponent } from '@hookpost/frontend/components/layout/gtm.component';
import { GoogleOneTap } from '@hookpost/frontend/components/auth/google-one-tap';
import { CloudflareAnalytics } from '@hookpost/frontend/components/layout/cloudflare-analytics';
import { RefCapture } from '@hookpost/frontend/components/affiliates/ref-capture';
import { PUBLISHABLE_CHANNEL_COUNT } from './channels/channel-count';
import { SiteFooter } from './site-footer';
import {
  PLAY_STORE_URL,
  TWA_BOOTSTRAP_SCRIPT,
  TWA_HIDE_CSS,
  TWA_HOME_REDIRECT_SCRIPT,
} from '@hookpost/frontend/components/layout/twa';
import {
  META_AD_BAR_CSS,
  META_AD_BAR_HEIGHT,
  META_AD_BAR_ID,
  META_AD_MODE,
  metaAdRedirectScript,
} from '@hookpost/frontend/components/layout/meta-ad-redirect';
import {
  INVITE_LINK_SCRIPT,
  INVITE_REDIRECTING_CHECK,
} from '@hookpost/frontend/components/layout/invite.link';
import { HOOKPOST_PRICE } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing';

// Module scope, so it is read once at build like every other NEXT_PUBLIC_ value.
const META_AD_REDIRECT_SCRIPT = metaAdRedirectScript(
  process.env.NEXT_PUBLIC_FACEBOOK_PIXEL
);

export const metadata: Metadata = {
  metadataBase: new URL('https://hookpost.hookstep.in'),
  title: {
    // 69 chars was past the truncation point, and the part being cut was
    // This is the sitewide default, which in practice is the homepage title.
    // It named a competitor until the September 2026 rebuild; the homepage is
    // about this product now, and /alternatives/postiz still carries that
    // keyword on a page built for it. 54 chars, inside the truncation limit.
    default: 'Hookpost: AI Social Media Scheduler',
    template: '%s',
  },
  description: `Social media scheduler for ${PUBLISHABLE_CHANNEL_COUNT} networks. Visual calendar, AI drafting, and an MCP server so Claude or Cursor can publish. ${offer('Free plan', `${FREE_POSTS}, no card needed`)}, ${usdCopy('prices in rupees', 'prices in rupees or US dollars')}.`,
  // No `keywords`: Google ignores the tag and Bing has called stuffed ones a
  // spam signal. This one was ~60 terms (1,452 characters) on every page.
  authors: [{ name: 'Hookstep', url: 'https://hookpost.hookstep.in' }],
  creator: 'Hookstep',
  publisher: 'Hookstep',
  applicationName: 'Hookpost',
  generator: 'Next.js',
  manifest: '/site.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.png', type: 'image/png' },
    ],
    shortcut: '/favicon.png',
    apple: '/apple-touch-icon.png',
  },
  // No `languages`: it listed 17 hreflang locales, every one pointing at
  // this same English homepage. There are no translated pages, so the tags
  // claimed alternates that do not exist.
  alternates: {
    canonical: 'https://hookpost.hookstep.in',
  },
  // These describe the HOMEPAGE. Every other landing page sets its own through
  // withSocial() (social-meta.ts); 62 pages used to inherit these instead.
  openGraph: {
    title: 'Hookpost: AI Social Media Scheduler',
    description: `Manage, schedule, and auto-publish across ${PUBLISHABLE_CHANNEL_COUNT} social networks with AI copilot, drag-and-drop calendar, and team workflows. ${offer('Free plan available.', `${FREE_POSTS}, no card needed.`)}`,
    url: 'https://hookpost.hookstep.in',
    siteName: 'Hookpost',
    images: [
      {
        url: 'https://hookpost.hookstep.in/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Hookpost Social Media Scheduler',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hookpost: AI Social Media Scheduler',
    // Listed Instagram, Pinterest and Threads first, none of which can publish
    // for a new account yet (see channel-specs.ts). Named from the publishable
    // set instead.
    description: `Schedule and auto-publish posts to ${PUBLISHABLE_CHANNEL_COUNT} networks, including X, LinkedIn, YouTube, Facebook Pages, TikTok, Bluesky, Discord and Telegram.`,
    images: ['https://hookpost.hookstep.in/og-image.png'],
    // No creator/site: @hookstep is a stranger's account (see sameAs below),
    // and there is no Hookpost brand handle on X to put here instead.
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  // No `other`: coverage, distribution, rating, revisit-after and target are
  // legacy tags no search engine reads, and a single-value priceCurrency meta
  // cannot describe a site priced in two currencies.
};

const globalJsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': 'https://hookpost.hookstep.in/#organization',
      name: 'Hookpost',
      legalName: 'Hookstep',
      url: 'https://hookpost.hookstep.in',
      logo: 'https://hookpost.hookstep.in/brand-logo.png',
      // Hookstep operates Hookpost, and hookstep.in's own Organization node
      // already lists this @id as a subOrganization. Until 28 Oct 2026 that
      // link ran one way only, so a crawler reading this page had nothing
      // pointing back at the parent entity. Tablamigo's site has declared the
      // same parentOrganization since 25 Oct 2026. Both @ids are the ones each
      // site publishes for itself, so the three documents describe one group
      // rather than three unrelated "Hookstep"s - which is the whole point,
      // given that the brand query is outranked by other sites.
      parentOrganization: {
        '@type': 'Organization',
        '@id': 'https://hookstep.in/#organization',
        name: 'Hookstep',
        url: 'https://hookstep.in',
      },
      // "HookPost" collides with an indexed Shopify app and with the GNU
      // debugger's hookpost- command prefix, so search engines substitute
      // "Hookle" for the query and AI models have no clean signal to resolve
      // the entity. Third-party pages we demonstrably control are the only
      // corroboration available: the npm registry entries are independent,
      // dated, and name the product exactly.
      //
      // A 200 is NOT the check. This list used to carry
      // 'https://x.com/hookstep', which returns 200 all day because it is a
      // real account - belonging to "Billy Twotrees", joined June 2026, zero
      // posts, one follower. sameAs asserts identity, so we were telling Google
      // and every AI model that a stranger's empty profile IS Hookpost, on the
      // exact entity signal this array exists to fix. Removed 2026-09-22, the
      // night before the Product Hunt launch.
      //
      // The rule the old comment should have stated: verify each URL is OURS,
      // by name and content, not that it resolves. Re-checked on removal -
      // hookstep.in 200, github.com/hookstep is our org, the LinkedIn company
      // page is ours, and all three npm packages resolve in the registry with
      // Hookpost descriptions (npmjs.com itself 403s a bare curl, which is bot
      // protection, not a dead link).
      //
      // No X account: there is no Hookpost brand handle. The only X channels
      // connected in production are two personal accounts. Add one here when a
      // brand account exists - never the closest-looking name.
      sameAs: [
        'https://hookstep.in',
        // No GitHub entry: the owner keeps the repos private for now, and the
        // hookstep org holds no Hookpost code (removed 11 Oct 2026).
        // Directory listings verified ours by content on 2026-09-25.
        'https://www.producthunt.com/products/hookpost',
        'https://www.saashub.com/hookpost-in',
        'https://www.linkedin.com/company/hookpost',
        'https://www.npmjs.com/package/hookpost',
        'https://www.npmjs.com/package/@hookpost/node',
        'https://www.npmjs.com/package/n8n-nodes-hookpost',
      ],
      // Disambiguation for entity resolution: says plainly what this is, in
      // the terms the colliding results are not about.
      alternateName: 'Hookpost Social Media Scheduler',
      description: `Hookpost is a social media scheduling platform that publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks from one calendar and ships a Model Context Protocol server for AI agents. It is not affiliated with any Shopify application of a similar name.`,
      founder: {
        '@type': 'Person',
        name: 'Mohan Bhanushali',
        jobTitle: 'Founder',
        url: 'https://hookstep.in/founders',
        // No sameAs: the only URLs available were the company's GitHub org
        // and LinkedIn page, and asserting those as a person's identity is
        // wrong. Add his personal LinkedIn/GitHub here when they exist.
      },
      contactPoint: {
        '@type': 'ContactPoint',
        email: 'support@hookstep.in',
        contactType: 'Customer Support',
        availableLanguage: ['English', 'Hindi', 'Punjabi'],
      },
      // Merged from two separate knowsAbout keys on this same object. A
      // duplicate key is not an error in JS - the later one silently won, so
      // the disambiguating terms (content calendar automation, social media
      // API integration) never reached the emitted schema.
      knowsAbout: [
        'Social Media Management',
        'Social Media Scheduling',
        'Content Calendar Automation',
        'Social Media API Integration',
        'Model Context Protocol',
        'AI Agents',
      ],
    },
    {
      '@type': 'WebSite',
      '@id': 'https://hookpost.hookstep.in/#website',
      url: 'https://hookpost.hookstep.in',
      name: 'Hookpost',
      publisher: {
        '@id': 'https://hookpost.hookstep.in/#organization',
      },
      // No SearchAction: it targeted /alternatives?q=, which ignores q - there
      // is no site search - and Google retired the sitelinks search box.
    },
    {
      // The product, as one entity: SoftwareApplication + WebApplication. The
      // homepage used to declare a second, separate SoftwareApplication
      // (#software) with its own offers. The Android app has its own
      // MobileApplication node below.
      '@type': ['SoftwareApplication', 'WebApplication'],
      '@id': 'https://hookpost.hookstep.in/#app',
      name: 'Hookpost: AI Social Scheduler',
      alternateName: ['Hookpost', 'Hookpost Social Media Scheduler'],
      description: `Social media scheduler that publishes to ${PUBLISHABLE_CHANNEL_COUNT} networks from one calendar, with AI drafting and a Model Context Protocol server for AI agents.`,
      publisher: { '@id': 'https://hookpost.hookstep.in/#organization' },
      isSimilarTo: [
        'https://buffer.com',
        'https://hootsuite.com',
        'https://later.com',
        'https://postiz.com',
      ],
      featureList: [
        'Multi-channel visual content calendar',
        `${PUBLISHABLE_CHANNEL_COUNT} supported social platforms`,
        'Instagram (Business or Creator) and Threads publishing',
        'X post and thread scheduling',
        'LinkedIn profile publishing',
        'YouTube video and Shorts auto-publishing',
        'Facebook Page publishing',
        'Pinterest Pin publishing',
        'TikTok video and photo publishing',
        'Bluesky, Telegram, Discord and Slack publishing',
        'AI caption and hashtag generation',
        'Team workspace and role management',
        'Model Context Protocol (MCP) server',
      ],
      operatingSystem: 'All (any modern browser)',
      browserRequirements:
        'Requires JavaScript. Supports Chrome, Firefox, Safari, and Edge.',
      applicationCategory: 'BusinessApplication',
      url: 'https://hookpost.hookstep.in',
      softwareVersion: '1.0.0',
      // No aggregateRating until there are real reviews to point at —
      // fabricated ratings are a Google spam-policy violation that can kill
      // rich results site-wide.
      // Rupees only (owner, 11 Oct 2026): India is the market, the marketing
      // copy is rupee-only and no dollar checkout has ever collected. One offer
      // per sold tier (TEAM and ULTIMATE are retired, see PURCHASABLE_TIERS),
      // every amount read from pricingINR, never typed in. No Free offer once
      // new users have to start the trial (LANDING_TIERS, trial-offer.ts).
      // Once the dollar plans are sold (USD_CHECKOUT=on, usd-offer.ts) a USD
      // offer per paid tier follows, ineligible in India and in any
      // USD_EXCLUDED_COUNTRIES; until then usdOffers() is empty.
      offers: [
        ...LANDING_TIERS.map((tier) => ({
          '@type': 'Offer',
          name: tier === 'FREE' ? 'Free' : tier.charAt(0) + tier.slice(1).toLowerCase(),
          // Shown in dollars to everyone (pricing.ts HOOKPOST_PRICE).
          price: tier === 'FREE' ? '0' : String(HOOKPOST_PRICE.displayUsd),
          priceCurrency: 'USD',
        })),
      ],
    },
    {
      // The Android app on Google Play: a Trusted Web Activity of this site.
      // The listing is public (HTTP 200 logged out, checked 3 Oct 2026); it
      // used to 404, which is why this node was left out until now.
      //
      // The offer is the install, which is free. Paid plans are not sold in
      // the Play app at all - see components/layout/twa.ts - so they are not
      // offered here. Still no aggregateRating: there are no reviews yet.
      '@type': 'MobileApplication',
      '@id': 'https://hookpost.hookstep.in/#android-app',
      name: 'Hookpost',
      operatingSystem: 'ANDROID',
      applicationCategory: 'BusinessApplication',
      installUrl: PLAY_STORE_URL,
      url: PLAY_STORE_URL,
      publisher: {
        '@id': 'https://hookpost.hookstep.in/#organization',
      },
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'INR' },
    },
  ],
};

export default function LandingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the TWA bootstrap below may add data-hp-twa to
    // <html> before React hydrates it.
    <html
      lang="en"
      {...brandHtmlAttributes()}
      style={{ ['--new-bgColor' as any]: 'var(--hp-bg)' }}
      suppressHydrationWarning
    >
      <head>
        <BrandThemeStyle />
        {/* favicon.ico, favicon.png, apple-touch-icon, the manifest,
            theme-color and application-name come from `metadata` / `viewport`
            above. They were ALSO hand-written here, so every page carried two
            of each. Only tags metadata does not emit stay. */}
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/favicon-32x32.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/favicon-16x16.png"
        />
        <meta
          name="p:domain_verify"
          content="173f3dbe31873eabc4da7e0962f5a07f"
        />
        <meta name="apple-mobile-web-app-title" content="Hookpost" />
        <meta name="format-detection" content="telephone=no" />
        {/* Must stay above the signed-in redirect below: the Play app opens /
            with an android-app:// referrer that the redirect to /launches
            loses, so it has to be recorded first. Marks <html> so the Play
            badges hide inside the Play app (TWA_HIDE_CSS). These pages are
            cached by Cloudflare, so this cannot be decided on the server. */}
        <script dangerouslySetInnerHTML={{ __html: TWA_BOOTSTRAP_SCRIPT }} />
        {/* An old team invite link (/?org=<token>) goes on to /invite/: the
            proxy never sees it, because Cloudflare serves "/" from its cache
            whatever the query string. Before the attribution script, so the
            token is out of the address bar before anything records it. See
            components/layout/invite.link.ts. */}
        <script dangerouslySetInnerHTML={{ __html: INVITE_LINK_SCRIPT }} />
        {/* First-touch attribution (utm_*, ad click ids, landing page,
            referrer) into the hp_attr cookie, which every sign-up method
            reads on the server. Inline and first: this HTML is edge-cached,
            so the server never sees the landing, and the redirects below
            must not run before it. See utils/attribution.ts. */}
        <script dangerouslySetInnerHTML={{ __html: ATTRIBUTION_CAPTURE_SCRIPT }} />
        {/* Inside the Play app, / (prices, "via Razorpay") goes to /auth. */}
        <script dangerouslySetInnerHTML={{ __html: TWA_HOME_REDIRECT_SCRIPT }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                // The homepage is served from the Cloudflare cache even to
                // signed-in users, so the middleware never sees those requests
                // and this is what sends them to the app. It used to redirect
                // on the readable hint alone. A hint outlives its session, so a
                // signed-out visitor went / -> /launches -> /auth, which is the
                // SIGN-UP page, and a returning customer could not get back to
                // the homepage at all. Now it asks the backend first: 200 goes
                // to the app, 401 deletes the stale hint in both the domain and
                // host-only shapes it can be stored in, and the visitor stays.
                try {
                  if (window.location.pathname !== '/') return;
                  // On its way to /invite/ (INVITE_LINK_SCRIPT): the proxy
                  // takes a signed-in visitor on from there.
                  if (${INVITE_REDIRECTING_CHECK}) return;
                  var hinted = document.cookie.split(';').some(function (c) {
                    return c.trim().indexOf('hp_logged_in=1') === 0;
                  });
                  if (!hinted) return;
                  fetch('/api/user/self', { credentials: 'include', cache: 'no-store' })
                    .then(function (r) {
                      if (r.ok) { window.location.replace('/launches'); return; }
                      if (r.status === 401) {
                        var h = window.location.hostname.split('.');
                        var d = h.length > 2 ? '; domain=.' + h.slice(-2).join('.') : '';
                        document.cookie = 'hp_logged_in=; path=/; max-age=0';
                        document.cookie = 'hp_logged_in=; path=/; max-age=0' + d;
                      }
                    })
                    .catch(function () {});
                } catch (e) {}
              })();
            `,
          }}
        />
        {/* Android visitors from a Meta ad go on to the Play listing: either
            automatically once the pixel PageView has been sent (capped at
            1.5s), or through a one-tap install bar, per META_AD_MODE. OFF
            ships no tag. Client-side because the homepage HTML is
            edge-cached. See meta-ad-redirect.ts. */}
        {META_AD_REDIRECT_SCRIPT ? (
          <script dangerouslySetInnerHTML={{ __html: META_AD_REDIRECT_SCRIPT }} />
        ) : null}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body { background-color: var(--hp-bg) !important; color: var(--hp-text); margin: 0; }
              img, svg { max-width: 100%; height: auto; }
              nav img, header img, [class*="logo"] img, .brand-logo { max-width: 42px !important; max-height: 42px !important; object-fit: contain; }
              a { color: inherit; text-decoration: none; }
              ${TWA_HIDE_CSS}
              ${META_AD_MODE === 'INSTALL_BAR' ? META_AD_BAR_CSS : ''}
            `,
          }}
        />
      </head>
      <body
        className={`${dmSans.variable} ${plusJakartaSans.variable}`}
        style={{
          margin: 0,
          color: 'var(--hp-text)',
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        {/*
          deferUntilEngaged on all three third-party loaders: One Tap, the Meta
          pixel and GTM/gtag load together on the first pointerdown, keydown,
          scroll or touchstart, or after ~4s. lazyOnload alone still put them
          inside the page load, and GTM + gtag (~427KB, ~258ms blocking) took
          mobile Performance on / from 100 to 76. fbq and gtag/dataLayer stubs
          are installed immediately, so every event fired before the scripts
          arrive is queued and replayed. See components/layout/when-engaged.ts.
        */}
        {META_AD_MODE === 'INSTALL_BAR' && (
          // Hidden unless meta-ad-redirect marks <html> before first paint;
          // it adds the install referrer to href at tap time.
          <a
            id={META_AD_BAR_ID}
            href={PLAY_STORE_URL}
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 10000,
              height: META_AD_BAR_HEIGHT,
              boxSizing: 'border-box',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '0 16px',
              background: '#01875f',
              color: '#fff',
              fontWeight: 700,
              fontSize: 16,
            }}
          >
            Install on Google Play
            <span aria-hidden="true">&rarr;</span>
          </a>
        )}
        {/* Visitors in Instagram's, Facebook's, LinkedIn's or TikTok's
            built-in browser (where Google sign-in fails): "Open in your
            browser", the address with the ad's utm tags, Copy link, and on
            Android an Open in Chrome button. Client-only: this HTML is
            edge-cached for everyone, so it renders nothing until it has read
            the user agent. */}
        <OpenInBrowserPrompt variant="bar" />
        <GoogleOneTap deferUntilEngaged />
        <RefCapture />
        {/*
          Analytics were mounted only in (app)/layout.tsx - the logged-in app -
          so every marketing page was completely untracked: the homepage, the
          ten /alternatives/ pages, the fifteen /for/ pages, /mcp and the
          guides. That is precisely where paid traffic lands, which meant an ad
          click could never be tied to a signup and no retargeting audience
          could be built at all.

          Both components return null when their env var is unset, so this stays
          inert until NEXT_PUBLIC_FACEBOOK_PIXEL / NEXT_PUBLIC_GTM_ID exist.
        */}
        {/*
          These were deliberately left off the marketing pages while nothing was
          being spent: gtm.js 114KB + f.js 81KB + the pixel config 12KB measured
          208KB on the live homepage, 46% of its JavaScript, and they were the
          only reason Best Practices failed on third-party cookies. The note
          left here said to put them back the day paid campaigns start, because
          that is when match quality from the _fbp cookie is worth the weight.

          That day is 2026-09-18: Meta campaigns go live on these pages. Without
          the pixel here the landing view carries no _fbp, so no retargeting
          audience of visitors can be built at all and click attribution rests
          entirely on the Conversions API. ViewContentTracker still sends the
          server-side copy with event-ID deduplication, so the two do not double
          count.

          If the campaigns are stopped, take these back out - the page weight is
          only worth paying for while it is buying something.
        */}
        <FacebookComponent deferUntilEngaged />
        <GoogleTagManagerComponent
          gtmId={process.env.NEXT_PUBLIC_GTM_ID}
          googleAdsId={process.env.NEXT_PUBLIC_GOOGLE_ADS_ID}
          deferUntilEngaged
        />
        {/*
          UtmSaver was mounted only in (app)/(provider)/(extension), never here.
          Paid traffic lands on these marketing pages carrying ?utm_source=...,
          so the tag was read for the first time on /auth/register - by which
          point the parameters are long gone and landingUrl/referrer record an
          internal hop. Every ad-sourced signup attributed to nothing.

          It reads useSearchParams, which opts a route into dynamic rendering
          unless it sits behind a Suspense boundary; these landing pages are
          statically prerendered and must stay that way.

          UtmCapture, not UtmSaver: same localStorage writes, without the
          `?check=` event code that pulled posthog-js (61KB gzipped) onto every
          marketing page. That code never ran here. See utm.capture.tsx.
        */}
        <Suspense fallback={null}>
          <UtmCapture />
        </Suspense>
        {/*
          TrackEnum.ViewContent was defined but nothing ever sent it, so the
          pixel had no top-of-funnel signal: no audience of people who read a
          landing page and left, and nothing for the algorithm to learn from
          but the few who converted. Landing routes only - firing this on every
          logged-in screen in (app) would bury the marketing signal.
        */}
        <ViewContentTracker />
        {/* Cloudflare Web Analytics, loaded after window load + idle instead
            of being injected into the HTML by Cloudflare. Adds nothing while
            Cloudflare's automatic injection is still on. */}
        <CloudflareAnalytics />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(globalJsonLd) }}
        />
        {/* <main>, not <div>: Lighthouse flagged "Document does not have a main
            landmark" on every marketing page, and screen-reader users lose the
            skip-to-content target without it. */}
        <main style={{ background: 'var(--hp-bg)', minHeight: '100vh' }}>
          {children}
        </main>
        {/* After </main>, not inside it: a footer outside the main landmark is
            the page's contentinfo landmark. Pages must not render their own. */}
        <SiteFooter />
      </body>
    </html>
  );
}
