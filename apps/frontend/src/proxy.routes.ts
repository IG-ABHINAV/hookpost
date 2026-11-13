/**
 * Which top-level URL segments mean what, for proxy.ts.
 *
 * proxy.ts used to send EVERY anonymous request that was not on its allowlist
 * to /auth, so a mistyped or retired URL answered 307 -> the sign-up page
 * instead of a 404, and Search Console reported "Page with redirect" for it.
 * It now sends an anonymous visitor to /auth only when the first segment is a
 * route of the signed-in app (APP_ROUTE_SEGMENTS) or an old habit worth
 * keeping (LOGIN_ALIAS_SEGMENTS). Anything else falls through to Next's own
 * 404, which already carries noindex.
 *
 * The cost of an incomplete APP_ROUTE_SEGMENTS is that a signed-in page loads
 * for a signed-out visitor instead of bouncing them to /auth, so the list is
 * checked against the route tree by scripts/check-landing-routes.js, which
 * deploy-prod.yml runs before every deploy. Add a segment here when you add a
 * directory under (app), (extension) or (provider).
 */

// First segments of the pages in (app) / (extension) / (provider) that sit
// behind a login. /auth is not in the list on purpose: it is the login page
// itself and proxy.ts handles it separately.
export const APP_ROUTE_SEGMENTS: ReadonlySet<string> = new Set([
  'admin',
  'affiliate',
  'agents',
  'analytics',
  'billing',
  'err',
  'integrations',
  // /invite (the Join question). proxy.ts answers every /invite path itself,
  // before this list is read; listed for check-landing-routes.js.
  'invite',
  'launches',
  'media',
  'modal',
  'oauth',
  'plugs',
  // /reminder/<postId>, "Remind me to post" (components/reminder)
  'reminder',
  'settings',
  'third-party',
]);

// URLs people type or bookmark when they mean "let me sign in". They were never
// pages; they only worked because every unknown URL went to /auth. Kept that
// way so tidying the 404s does not strand a returning customer.
export const LOGIN_ALIAS_SEGMENTS: ReadonlySet<string> = new Set([
  'app',
  'dashboard',
  'log-in',
  'login',
  'sign-in',
  'sign-up',
  'signin',
  'signup',
  'register',
]);

// First segments of the public marketing pages in (landing). Only used to
// 308 a differently-cased URL (/Pricing) to its lowercase page; every marketing
// path is lowercase, so lowercasing the whole path is safe for these and for
// nothing else (/p/<id>, /agents/<id> and friends carry case-sensitive ids).
// A marketing route missing from here simply 404s when typed in capitals;
// /integrations is left out because /integrations/social/<provider> is the
// signed-in app and its provider names are case-sensitive.
export const LANDING_SEGMENTS: ReadonlySet<string> = new Set([
  'about',
  'affiliates',
  'alternatives',
  'best-social-media-scheduler-india',
  'cancellation-policy',
  'channels',
  'claude',
  'cli',
  'compare',
  'contact',
  'data-deletion',
  'discord-post-scheduler',
  'docs',
  'download',
  'for',
  'free-social-media-scheduler',
  'guides',
  'mcp',
  'open-source-social-media-scheduler',
  'planable-vs-buffer-vs-hootsuite',
  'pricing',
  'privacy',
  'redeem',
  'refund-policy',
  'shipping-policy',
  'social-media-calendar-india',
  'social-media-mcp-servers',
  'social-media-scheduler',
  'social-media-scheduler-india',
  'social-media-scheduling-api',
  'start',
  'terms',
  'tools',
  'vs',
]);

export const firstSegment = (pathname: string): string =>
  pathname.split('/')[1] ?? '';
