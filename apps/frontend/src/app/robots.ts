import { MetadataRoute } from 'next';
import { NAMED_AGENTS } from './robots.agents';

// Paths no crawler should fetch. Kept in one constant because it has to appear
// in EVERY user-agent group - see the note on the named-agent group below.
//
// No trailing slashes. `Disallow: /launches/` does NOT match `/launches`, and
// `/launches` is exactly what Googlebot kept fetching - it 307s to /auth, so
// Search Console filed it under "Page with redirect" along with every other
// bare app route. A robots.txt path is a prefix match, so `/launches` covers
// both the route and everything under it.
//
// Every route under app/(app)/(site) belongs here; none of the marketing paths
// start with one of these prefixes, so nothing crawlable is caught. `/posts`
// is in the list because docs/public-api documents `/posts/:id/settings` as
// text and Googlebot went and fetched that literal URL.
//
// Two app routes share a prefix with a marketing page, so they are anchored
// with `$` (end of URL) or narrowed to the app's own sub-path: /affiliate is the
// signed-in dashboard and /affiliates the public programme page;
// /integrations/social/<provider> is the app and /integrations/n8n a guide.
// robots.spec.ts checks every APP_ROUTE_SEGMENTS entry is covered and no
// sitemap URL is caught.
const PRIVATE_PATHS = [
  '/api',
  '/admin',
  '/affiliate$',
  '/agents',
  '/analytics',
  '/billing',
  '/err',
  '/integrations$',
  '/integrations/social',
  // Team invite links (proxy.invite.ts, a token in the path) and /invite,
  // the page that asks a signed-in visitor whether to join.
  '/invite',
  '/launches',
  '/media',
  '/modal',
  '/oauth',
  '/plugs',
  '/posts',
  '/reminder',
  '/settings',
  '/third-party',
  '/cdn-cgi',
];

export default function robots(): MetadataRoute.Robots {
  const baseUrl = 'https://hookpost.hookstep.in';

  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/about',
          '/contact',
          '/mcp',
          '/channels',
          '/channels/',
          '/alternatives',
          '/alternatives/',
          '/for',
          '/for/',
          '/vs/',
          '/compare',
          '/guides',
          '/guides/',
          '/docs/',
          '/auth',
          '/auth/login',
          '/privacy',
          '/terms',
          '/data-deletion',
          '/llms.txt',
          '/llms-full.txt',
          '/.well-known/',
        ],
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: [...NAMED_AGENTS],
        allow: '/',
        // The same disallow list, repeated on purpose. A crawler obeys ONLY its
        // most specific matching group, so naming Googlebot here meant it never
        // read the '*' group's disallows at all - it was free to crawl /api/,
        // /admin/, /settings/ and /launches/. /api/mcp answers 401, which is
        // exactly the "Blocked due to unauthorised request (401)" that Search
        // Console started reporting. Naming an agent to grant it access silently
        // revokes every restriction you set for everyone.
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
