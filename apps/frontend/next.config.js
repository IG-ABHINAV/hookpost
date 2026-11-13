// @ts-check
import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Lets a deploy build into a staging directory instead of overwriting the one
  // the running server is reading. `next build` clears distDir before it writes,
  // so building in place on the server took the frontend down for the whole
  // build. Unset at runtime, so `next start` still serves `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  typescript: {
    ignoreBuildErrors: true,
  },
  compress: true,
  poweredByHeader: false,
  compiler: {
    removeConsole:
      process.env.NODE_ENV === 'production'
        ? { exclude: ['error', 'warn'] }
        : false,
  },
  experimental: {
    // Inline the stylesheet into the HTML instead of linking it. LCP on the
    // marketing pages was 90% "render delay" with TBT at 8ms - the page was
    // waiting on the network, not on script - and the remaining blocker was a
    // 22KB stylesheet costing 450ms of round-trip before anything could paint.
    // Inlining removes that request entirely. Safe here because the landing
    // sheet is 23KB transferred after the Polotno/Uppy split; it would have
    // been a bad trade against the old 483KB bundle.
    inlineCss: true,
    proxyTimeout: 90_000,
    optimizePackageImports: [
      '@mantine/core',
      '@mantine/hooks',
      'lodash',
      'dayjs',
      '@blueprintjs/icons',
      'lucide-react',
      'react-icons',
      '@tabler/icons-react',
      'date-fns',
    ],
  },
  // Cache and security headers
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Document-Policy',
            value: 'js-profiling',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            // The site was serving no HSTS header at all, so a first visit
            // over http:// was still downgradeable. Two years, subdomains
            // included. Not adding `preload` — that is a one-way submission
            // to a browser-baked list and should be a deliberate call.
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            // Deny the powerful features this app never uses, so a compromised
            // third-party script cannot reach for them either.
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), interest-cohort=()',
          },
          {
            // same-origin-allow-popups, NOT same-origin: every social channel
            // connects through an OAuth popup, and strict same-origin severs
            // window.opener so the popup cannot hand the token back. That would
            // break connecting every provider - the whole product.
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups',
          },
          {
            // REPORT-ONLY on purpose. A wrong CSP takes the site down, and this
            // app loads Next's inlined bootstrap, Sentry, GTM and the Meta
            // pixel on (app) routes, plus Polotno. Ship it in report-only,
            // read the violations, then promote to enforcing once the policy
            // is known to be complete. Promoting this without reading reports
            // first would be a self-inflicted outage.
            key: 'Content-Security-Policy-Report-Only',
            value: [
              "default-src 'self'",
              // checkout.razorpay.com is the payment modal. It is absent from
              // this policy today, which is harmless only because the header is
              // report-only - promoting it to enforcing without these three
              // Razorpay origins would stop every customer paying. Added now so
              // the promotion is safe whenever someone does it.
              // pagead2/googlesyndication/doubleclick/adtrafficquality: AdSense auto ads on
              // /guides and /alternatives (components/layout/adsense.tsx).
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.googletagmanager.com https://connect.facebook.net https://static.cloudflareinsights.com https://checkout.razorpay.com https://accounts.google.com https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://fundingchoicesmessages.google.com",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
              "font-src 'self' https://fonts.gstatic.com data:",
              "img-src 'self' data: blob: https:",
              // cloudflareinsights is Cloudflare's Web Analytics beacon: script-src
              // above, connect-src here. It is injected by the CDN while automatic
              // setup is on, and loaded by components/layout/cloudflare-analytics.tsx
              // once that is off. Omitting it made our own report-only policy the sole
              // entry in Chrome's Issues panel, costing a Best Practices point for a
              // self-inflicted report.
              "connect-src 'self' https://www.google-analytics.com https://www.facebook.com https://*.sentry.io https://cloudflareinsights.com https://api.razorpay.com https://lumberjack.razorpay.com https://accounts.google.com https://*.googlesyndication.com https://*.doubleclick.net https://*.adtrafficquality.google https://fundingchoicesmessages.google.com",
              // The Razorpay modal renders its card/UPI form in an iframe it
              // creates itself, so frame-src has to allow it explicitly -
              // default-src 'self' would otherwise blank the payment form.
              "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://accounts.google.com https://*.googlesyndication.com https://*.doubleclick.net https://www.google.com https://*.adtrafficquality.google",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
      {
        // The Join question for a team invite (app/(app)/invite): never in a
        // frame, not even one of this site, so no page can get someone to
        // press Join under a decoy. Enforced, unlike the report-only policy
        // above; frame-ancestors restricts nothing else. Listed after
        // '/:path*' so its X-Frame-Options wins.
        source: '/invite',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
      {
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable',
          },
        ],
      },
      {
        source: '/(favicon.ico|favicon.png|apple-touch-icon.png|brand/:path*|svgs/:path*|icons/:path*|pngs/:path*)',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, max-age=2592000, immutable',
          },
        ],
      },
    ];
  },
  reactStrictMode: false,
  transpilePackages: ['crypto-hash'],
  productionBrowserSourceMaps: false,

  // Custom webpack config optimized for speed and lean bundles
  webpack: (config, { dev }) => {
    if (!dev) {
      config.devtool = false;
    }
    return config;
  },
  async redirects() {
    return [
      // HIDE PUBLIC SOURCE (owner decision, 11 Oct 2026): the page whose whole
      // premise was self-hosting Hookpost redirects. Hookpost is proprietary
      // (owner, 24 Oct 2026; LICENSE), so there is no self-hosted Hookpost to
      // describe: the page's file was deleted then, and the 301 stays because
      // the URL was indexed. /open-source-social-media-scheduler used to 301
      // to /alternatives too; since 22 Oct 2026 it is an "open-source vs
      // hosted" page that says plainly Hookpost is hosted.
      {
        source: '/guides/docker-self-hosting',
        destination: '/guides',
        statusCode: 301,
      },
      // Its premise was self-hosting behind a corporate firewall (title, FAQ,
      // hero), so it goes with the others; its file was deleted on 24 Oct
      // 2026 too. /for/agencies is the closest live page for teams.
      {
        source: '/for/enterprise-teams',
        destination: '/for/agencies',
        statusCode: 301,
      },
      // /guides/why-we-rewrote-postiz is gone. It was titled "Why We Rewrote
      // Postiz" and described as a "post-mortem of rebuilding Postiz into
      // Hookpost", which positions this product as the Postiz project rather
      // than an alternative to it. 301 rather than 404: the URL was indexed and
      // linked from llms.txt, and /alternatives/postiz covers the same search
      // intent with the framing we actually want.
      {
        source: '/guides/why-we-rewrote-postiz',
        destination: '/alternatives/postiz',
        permanent: true,
      },
      // URLs AI assistants send people to that never existed. ChatGPT
      // referrals in the nginx logs (4-16 Oct 2026) landed on /for-agencies,
      // which 404'd; /docs is the path assistants guess most after /blog
      // (redirected further down). Config redirects run before proxy.ts, so
      // none of these need an allowlist entry there. The slugs are the role
      // pages in (landing)/for/personas.ts; redirects.guessed-urls.spec.ts
      // keeps the two lists equal.
      {
        source:
          '/for-:slug(agencies|creators|small-business|students-young-creators|solopreneurs-freelancers|educators-nonprofits|real-estate|ecommerce|crypto-web3|fitness-coaches|music-artists|restaurants-cafes|healthcare-clinics|b2b-saas)',
        destination: '/for/:slug',
        permanent: true,
      },
      {
        source: '/docs',
        destination: '/docs/public-api',
        permanent: true,
      },
      {
        source: '/privacy-policy',
        destination: '/privacy',
        permanent: true,
      },
      {
        source: '/terms-and-conditions',
        destination: '/terms',
        permanent: true,
      },
      {
        source: '/terms-of-service',
        destination: '/terms',
        permanent: true,
      },
      {
        source: '/terms-of-use',
        destination: '/terms',
        permanent: true,
      },
      {
        source: '/contact-us',
        destination: '/contact',
        permanent: true,
      },
      {
        source: '/about-us',
        destination: '/about',
        permanent: true,
      },
      {
        source: '/shipping-and-delivery',
        destination: '/shipping-policy',
        permanent: true,
      },
      {
        source: '/shipping',
        destination: '/shipping-policy',
        permanent: true,
      },
      {
        source: '/cancellation-and-refund',
        destination: '/refund-policy',
        permanent: true,
      },
      {
        source: '/cancellation-and-refund-policy',
        destination: '/refund-policy',
        permanent: true,
      },
      {
        source: '/cancellation',
        destination: '/cancellation-policy',
        permanent: true,
      },
      {
        source: '/refund',
        destination: '/refund-policy',
        permanent: true,
      },
      {
        source: '/refunds',
        destination: '/refund-policy',
        permanent: true,
      },
      {
        source: '/alternatives/postiz/public-api',
        destination: '/docs/public-api',
        permanent: true,
      },
      // "Blog" sat in the nav until September 2026 and Googlebot still asks for
      // it (Search Console 404, last crawled 15 Oct). The guides hub is the
      // articles a visitor clicking "Blog" wanted.
      {
        source: '/blog',
        destination: '/guides',
        permanent: true,
      },
      // The five tools live under /tools/<name> and there is no /tools index,
      // so the parent URL 404'd. The all-network counter links to the others.
      {
        source: '/tools',
        destination: '/tools/character-counter',
        permanent: true,
      },
      // Channels we no longer offer. These pages were indexed and linked, so a
      // 404 would waste the accumulated authority and strand anyone arriving
      // from search. 301 to the channel index instead, which lists what is
      // genuinely connectable. If a channel becomes available again, remove it
      // from HIDDEN_PROVIDERS, restore its channel-specs entry, and delete the
      // redirect - in that order.
      {
        source: '/channels/reddit',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/dribbble',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/mastodon',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/google-business',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/whop',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/twitch',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/skool',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/kick',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/warpcast',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/vk',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/mewe',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/channels/tumblr',
        destination: '/channels',
        permanent: true,
      },
      {
        source: '/api/uploads/:path*',
        destination:
          process.env.STORAGE_PROVIDER === 'local' ? '/uploads/:path*' : '/404',
        permanent: true,
      },
      // /vs/<x> and /alternatives/<x> were two pages chasing the same query
      // with near-identical titles, splitting their own ranking signals. The
      // /alternatives/ pages are the longer and better-linked of the pair, so
      // the overlapping /vs/ ten fold into them. The six competitors that only
      // exist under /vs/ (zoho-social, sendible, loomly, tailwind, co-schedule,
      // meet-edgar) are untouched and still live there.
      {
        // Was -> /channels/google-business, which itself redirects to
        // /channels (Google Business is no longer offered): two hops. Straight
        // to the final page instead.
        source: '/channels/google-my-business',
        destination: '/channels',
        permanent: true,
      },
      ...[
        'buffer',
        'postiz',
        'hootsuite',
        'sprout-social',
        'later',
        'metricool',
        'publer',
        'socialpilot',
        'planoly',
        'agorapulse',
        // /alternatives/mixpost is in the sitemap but /vs/mixpost 404'd.
        'mixpost',
      ].map((slug) => ({
        source: `/vs/${slug}`,
        destination: `/alternatives/${slug}`,
        permanent: true,
      })),
    ];
  },
  async rewrites() {
    return [
      {
        source: '/uploads/:path*',
        destination:
          process.env.STORAGE_PROVIDER === 'local'
            ? '/api/uploads/:path*'
            : '/404',
      },
    ];
  },
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Sourcemap configuration optimized for monorepo
  sourcemaps: {
    disable: false,
    // More comprehensive asset patterns for monorepo
    assets: [
      '.next/static/**/*.js',
      '.next/static/**/*.js.map',
      '.next/server/**/*.js',
      '.next/server/**/*.js.map',
    ],
    ignore: [
      '**/node_modules/**',
      '**/*hot-update*',
      '**/_buildManifest.js',
      '**/_ssgManifest.js',
      '**/*.test.js',
      '**/*.spec.js',
    ],
    deleteSourcemapsAfterUpload: true,
  },

  // Release configuration
  release: {
    create: true,
    finalize: true,
    // Use git commit hash for releases in monorepo
    name:
      process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || undefined,
  },

  // NextJS specific optimizations for monorepo
  widenClientFileUpload: true,

  // Additional configuration
  telemetry: false,
  silent: process.env.NODE_ENV === 'production',
  debug: process.env.NODE_ENV === 'development',

  // Error handling for CI/CD
  errorHandler: (error) => {
    console.warn('Sentry build error occurred:', error.message);
    console.warn(
      'This might be due to missing Sentry environment variables or network issues'
    );
    // Don't fail the build if Sentry upload fails in monorepo context
    return;
  },
});
