import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getCookieUrlFromDomain } from '@hookpost/helpers/subdomain/subdomain.management';
import acceptLanguage from 'accept-language';
import {
  cookieName,
  headerName,
  languages,
} from '@hookpost/react/translation/i18n.config';
import { detectTwaLaunch } from '@hookpost/frontend/components/layout/twa';
import {
  APP_ROUTE_SEGMENTS,
  LANDING_SEGMENTS,
  LOGIN_ALIAS_SEGMENTS,
  firstSegment,
} from '@hookpost/frontend/proxy.routes';
import { sessionLooksLive } from '@hookpost/helpers/auth/session.lifetime';
import {
  INVITE_CONFIRM_PATH,
  INVITE_COOKIE,
  INVITE_PENDING_COOKIE,
  INVITE_SEGMENT,
} from '@hookpost/helpers/auth/team.invite';
import {
  inviteLink,
  invitePathFromQuery,
} from '@hookpost/frontend/proxy.invite';
acceptLanguage.languages(languages);

/**
 * Every `auth` cookie the browser sent. Under NOT_SECURED the app keeps a
 * host-only copy next to the domain one (layout.context.tsx setCookie), and
 * request.cookies keeps only one per name, so the header is read directly.
 */
function authCookieValues(cookieHeader: string | null): string[] {
  if (!cookieHeader) {
    return [];
  }
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('auth='))
    .map((part) => {
      try {
        return decodeURIComponent(part.slice(5));
      } catch {
        return part.slice(5);
      }
    });
}

/**
 * Expires a dead session cookie: the domain-scoped one the backend sets and
 * the host-only copy the app writes under NOT_SECURED. Appended by hand and
 * last, because response.cookies keeps one Set-Cookie per name and rewrites
 * them all on every set().
 */
function clearDeadSession(response: NextResponse) {
  const secured = !process.env.NOT_SECURED;
  const gone = 'auth=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
  const flags = secured ? '; Secure; SameSite=Lax' : '';
  response.headers.append(
    'set-cookie',
    `${gone}; Domain=${getCookieUrlFromDomain(process.env.FRONTEND_URL!)}${flags}${
      secured ? '; HttpOnly' : ''
    }`
  );
  response.headers.append('set-cookie', `${gone}${flags}`);
  return response;
}

// This function can be marked `async` if using `await` inside
export async function proxy(request: NextRequest) {
  const nextUrl = request.nextUrl;
  // `hp_logged_in` is deliberately NOT here. It is a readable hint for the
  // landing nav, not a credential, and it outlives the session it describes:
  // when `auth` expires or is rejected, the hint stays behind (and the app shell
  // used to re-set it on every mount before knowing whether the user was signed
  // in). With the hint counted as auth, a visitor whose session had died was
  // bounced from "/" and from /auth/login to /launches, flashed the calendar
  // shell, took a 401 and only then reached the login form - and never saw the
  // homepage at all. That broke the hard rule that /auth/login must never be
  // redirect-bounced. Verified 2026-09-23: with only `hp_logged_in=1`, both "/"
  // and /auth/login returned 307 -> /launches.
  //
  // `auth` is httpOnly but scoped to .hookstep.in, so this middleware reads it
  // on every request; the hint was never needed for redirect decisions.
  //
  // Only a session that has not expired counts (sessionLooksLive: a future
  // exp, unverified; the backend checks the signature on every call). An
  // `auth` value that is not one (past its exp, without one, not a JWT) is
  // signed out here as well, so /auth/login is never bounced to /launches;
  // it is expired on the response (deadSession). A session left unused for
  // 30 days usually arrives as no cookie at all, because the cookie's
  // Max-Age ends with the token; the hint below is what still tells the
  // proxy this visitor has an account.
  const presented = [
    ...authCookieValues(request.headers.get('cookie')),
    request.headers.get('auth'),
    nextUrl.searchParams.get('loggedAuth'),
  ].filter((token): token is string => !!token);
  const authCookie = presented.find((token) => sessionLooksLive(token));
  const deadSession = !authCookie && presented.length > 0;
  const signedOut = (response: NextResponse) =>
    deadSession ? clearDeadSession(response) : response;
  const staleLoginHint =
    !authCookie && request.cookies.get('hp_logged_in')?.value === '1';
  const lng = request.cookies.has(cookieName)
    ? acceptLanguage.get(request.cookies.get(cookieName).value)
    : acceptLanguage.get(
        request.headers.get('Accept-Language') ||
          request.headers.get('accept-language')
      );

  // /Pricing, /Alternatives/Buffer: marketing paths are all lowercase, and the
  // capitalised form used to answer 307 -> /auth. 308 to the real page, once,
  // and only for marketing paths (see LANDING_SEGMENTS for why not the rest).
  const lowerPath = nextUrl.pathname.toLowerCase();
  if (
    lowerPath !== nextUrl.pathname &&
    LANDING_SEGMENTS.has(firstSegment(lowerPath))
  ) {
    const lowered = nextUrl.clone();
    lowered.pathname = lowerPath;
    return NextResponse.redirect(lowered, 308);
  }

  const requestHeaders = new Headers(request.headers);
  if (lng) {
    requestHeaders.set(headerName, lng);
  }

  const topResponse = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  if (lng) {
    topResponse.headers.set(cookieName, lng);
  }

  // A hint with no session behind it makes the landing nav offer "Dashboard"
  // to someone who is signed out. Clear the domain-scoped copy the backend sets.
  // The client helper also writes a host-only copy (hence two identical cookies
  // in a browser that hit this); NextResponse keeps one Set-Cookie per name, so
  // a second, host-only clear here is silently dropped - verified with curl.
  // The landing layout's inline script removes that copy after a 401 instead.
  if (staleLoginHint) {
    topResponse.cookies.set('hp_logged_in', '', {
      path: '/',
      maxAge: -1,
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    });
  }

  // No currency work here. This used to set a hookpost_currency cookie on every
  // response (falling back to the client-sent x-country header) and three
  // x-hookpost-* request headers that nothing read; checkout ignored all of it.
  // The backend decides now: services/billing.currency.ts, via
  // /api/public/pricing-context and /api/billing/pricing-context.

  // A team invite link (proxy.invite.ts). Before everything else that reads
  // the URL, so nothing below can swallow it.
  if (firstSegment(nextUrl.pathname) === INVITE_SEGMENT) {
    // A link is a GET. A form on another site posting here arrives without
    // the SameSite=Lax session cookie, so it would look signed out and plant
    // the sign-in invite cookie in a browser that is signed in (review of
    // 6b39f4692). Nothing is set for any other method.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new NextResponse(null, {
        status: 405,
        headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store' },
      });
    }
    // /invite itself (no token) is the page that asks a signed-in visitor
    // whether to join (app/(app)/invite). Never stored by any cache.
    if (authCookie && nextUrl.pathname === INVITE_CONFIRM_PATH) {
      topResponse.headers.set('Cache-Control', 'private, no-store');
      return topResponse;
    }
    const res = await inviteLink({
      pathname: nextUrl.pathname,
      href: nextUrl.href,
      signedIn: !!authCookie,
      hasAccount: deadSession || staleLoginHint,
      clearSession: clearDeadSession,
    });
    return authCookie ? res : signedOut(res);
  }

  if (nextUrl.pathname.startsWith('/modal/') && !authCookie) {
    return signedOut(
      NextResponse.redirect(new URL(`/auth/login-required`, nextUrl.href))
    );
  }

  if (
    nextUrl.pathname.startsWith('/uploads/') ||
    nextUrl.pathname.startsWith('/p/') ||
    nextUrl.pathname.startsWith('/provider/') ||
    nextUrl.pathname.startsWith('/icons/') ||
    nextUrl.pathname.startsWith('/svgs/') ||
    nextUrl.pathname.startsWith('/pngs/') ||
    nextUrl.pathname.startsWith('/privacy') ||
    nextUrl.pathname.startsWith('/terms') ||
    nextUrl.pathname.startsWith('/data-deletion') ||
    nextUrl.pathname.startsWith('/refund') ||
    nextUrl.pathname.startsWith('/cancellation') ||
    nextUrl.pathname.startsWith('/shipping') ||
    // /pricing is the page a payment reviewer clicks to find checkout, and the
    // homepage footer links straight to it. Without this entry it 307s to
    // /auth, so an anonymous visitor asking "what does it cost" hits a login
    // wall - which is what Razorpay's banking partners reported as "no option
    // to proceed to the checkout page", holding up 19 netbanking requests.
    nextUrl.pathname.startsWith('/pricing') ||
    nextUrl.pathname.startsWith('/about') ||
    nextUrl.pathname.startsWith('/alternatives') ||
    nextUrl.pathname.startsWith('/channels') ||
    nextUrl.pathname.startsWith('/compare') ||
    nextUrl.pathname.startsWith('/for') ||
    nextUrl.pathname.startsWith('/guides') ||
    nextUrl.pathname.startsWith('/download') ||
    // How to redeem a plan bought on Gumroad: the products' post-purchase
    // content links here, for buyers who have no account yet.
    nextUrl.pathname.startsWith('/redeem') ||
    // Developer documentation is public by design - the product links to it
    // from the Public API and OAuth screens, and it is indexed for search.
    // Without this the middleware bounces /docs to /auth before Next ever
    // serves the (landing) page.
    nextUrl.pathname.startsWith('/docs') ||
    nextUrl.pathname.startsWith('/contact') ||
    nextUrl.pathname.startsWith('/mcp') ||
    // The paid ads' landing pages (ad-landing/), 22 Oct 2026.
    nextUrl.pathname.startsWith('/claude') ||
    nextUrl.pathname.startsWith('/cli') ||
    nextUrl.pathname.startsWith('/start') ||
    nextUrl.pathname.startsWith('/vs') ||
    // Search landing pages and free tools. A new marketing route that is not
    // listed here 307s to /auth for every crawler and logged-out visitor.
    nextUrl.pathname.startsWith('/free-social-media-scheduler') ||
    nextUrl.pathname.startsWith('/social-media-scheduler-india') ||
    nextUrl.pathname.startsWith('/tools') ||
    nextUrl.pathname.startsWith('/integrations/n8n') ||
    nextUrl.pathname.startsWith('/social-media-scheduling-api') ||
    nextUrl.pathname.startsWith('/open-source-social-media-scheduler') ||
    // Veritas SEO run (28 Sep 2026).
    nextUrl.pathname.startsWith('/best-social-media-scheduler-india') ||
    nextUrl.pathname.startsWith('/social-media-calendar-india') ||
    nextUrl.pathname.startsWith('/social-media-mcp-servers') ||
    // Search Console round (28 Oct 2026). /social-media-scheduler is a PREFIX
    // of /social-media-scheduler-india above, so this line already covers both
    // and the order of the two does not matter: every branch here returns the
    // same thing, and both paths are public. The india line is left in place
    // because it documents its own route.
    nextUrl.pathname.startsWith('/social-media-scheduler') ||
    nextUrl.pathname.startsWith('/discord-post-scheduler') ||
    nextUrl.pathname.startsWith('/planable-vs-buffer-vs-hootsuite') ||
    // Public affiliate terms. The signed-in dashboard is /affiliate (singular)
    // and stays behind auth.
    nextUrl.pathname.startsWith('/affiliates') ||
    // security.txt (RFC 9116) and the other static files nginx serves from
    // public/.well-known. In production nginx answers these itself; this is
    // for `next start` and for the oauth discovery paths, which never belong
    // to the login redirect.
    nextUrl.pathname.startsWith('/.well-known/') ||
    nextUrl.pathname === '/sitemap.xml' ||
    nextUrl.pathname === '/robots.txt' ||
    nextUrl.pathname === '/manifest.json'
  ) {
    return topResponse;
  }

  if (
    nextUrl.pathname.startsWith('/integrations/social/') &&
    nextUrl.href.indexOf('state=login') === -1
  ) {
    return topResponse;
  }

  // If the URL is logout, delete the cookie and redirect to login
  if (nextUrl.href.indexOf('/auth/logout') > -1) {
    // Not when another site sent the browser here (a link, a popup, a
    // redirect): signing a visitor out from elsewhere was the first step of
    // getting them onto an invite page signed out (review of 6b39f4692). The
    // app's own sign-out is POST /user/logout; this path stays for its links,
    // typed URLs (Sec-Fetch-Site "none") and browsers that send no such header.
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return NextResponse.redirect(new URL('/launches', nextUrl.href));
    }
    const response = NextResponse.redirect(
      new URL('/auth/login', nextUrl.href)
    );
    response.cookies.set('auth', '', {
      path: '/',
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
          }
        : {}),
      maxAge: -1,
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    });
    response.cookies.set('hp_logged_in', '', {
      path: '/',
      maxAge: -1,
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    });
    // An invite the signed-in account was asked about is not for whoever
    // signs in next on this browser (proxy.invite.ts).
    response.cookies.set(INVITE_PENDING_COOKIE, '', {
      path: '/',
      ...(!process.env.NOT_SECURED
        ? { secure: true, httpOnly: true, sameSite: 'lax' }
        : {}),
      maxAge: -1,
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    });
    return response;
  }

  if (
    nextUrl.pathname.startsWith('/auth/register') &&
    process.env.DISABLE_REGISTRATION === 'true'
  ) {
    return NextResponse.redirect(new URL('/auth/login', nextUrl.href));
  }

  // The old shape of an invite link, /?org=<token> (emails sent before 25
  // Oct 2026), and /auth?org= or any app path with it.
  // An empty ?org= is no invite.
  const org = nextUrl.searchParams.get(INVITE_COOKIE) || null;
  const url = new URL(nextUrl).search;

  // Anonymous visitors get the public marketing page at "/" instead of being
  // bounced straight to the login form. Logged-in users have no use for it, so
  // send them to the app.
  if (nextUrl.pathname === '/') {
    if (!authCookie) {
      // The same page whatever the query string, ?org= included: Cloudflare
      // caches "/" for signed-out visitors with the query string left out of
      // the key, so whatever is answered here is what every visitor gets for
      // a day. A redirect or a cookie set here for one invite would go to
      // everyone. The homepage's own INVITE_LINK_SCRIPT moves ?org= to
      // /invite/ in the browser, which works on the cached copy too.
      return signedOut(topResponse);
    }
    if (org !== null) {
      return NextResponse.redirect(
        new URL(invitePathFromQuery(org), nextUrl.href)
      );
    }
    const launches = new URL(`/launches${url}`, nextUrl.href);
    // The Google Play app opens / with an android-app:// referrer, and this
    // redirect would lose it before the page's own script could record it.
    // Carry it over as ?source=twa (see components/layout/twa.ts). A
    // redirect, so never cached - unlike a cookie set on /.
    if (detectTwaLaunch(request.headers.get('referer') || '', '')) {
      launches.searchParams.set('source', 'twa');
    }
    return NextResponse.redirect(launches);
  }

  // Every other ?org= (/auth?org=, /launches?org=, a sign-in page the Play
  // app opened with it) is handled in one place, /invite/. These paths are
  // never edge-cached.
  if (org !== null) {
    return signedOut(
      NextResponse.redirect(new URL(invitePathFromQuery(org), nextUrl.href))
    );
  }

  if (!nextUrl.pathname.startsWith('/auth') && !authCookie) {
    // Only the signed-in app (and the usual "take me to sign in" spellings)
    // sends an anonymous visitor to /auth. Any other path is not a page, so it
    // goes on to Next's 404 (status 404, noindex) rather than a redirect to the
    // sign-up form. See proxy.routes.ts.
    const segment = firstSegment(nextUrl.pathname);
    if (!APP_ROUTE_SEGMENTS.has(segment) && !LOGIN_ALIAS_SEGMENTS.has(segment)) {
      return topResponse;
    }
    // "Manage your plan" links (the Free-plan sunset email among them) point
    // at /billing, and whoever follows one already has an account. The
    // sign-up form gave them nothing to do; the login form with returnUrl
    // brings them back here once signed in. returnUrl is built from this
    // request's own path, and the login page only ever follows a same-origin
    // path (safeReturnPath in auth/return.url.component.tsx).
    if (segment === 'billing') {
      const login = new URL('/auth/login', nextUrl.href);
      login.searchParams.set('returnUrl', nextUrl.pathname + nextUrl.search);
      return signedOut(NextResponse.redirect(login));
    }
    // An app asking for access (Claude's connector, /oauth/authorize?client_id=
    // ...) to someone who is not signed in. The query used to be copied onto
    // /auth as-is, so after signing up or in they landed on /launches and the
    // app never got its code: on 27 Oct 2026, 24 Claude connector clients were
    // registered and 1 authorization completed. returnUrl brings them back to
    // the consent screen, the same way as /billing above. New visitors get the
    // sign-up form, a visitor whose session ended gets the login form.
    if (segment === 'oauth') {
      const auth = new URL(
        deadSession || staleLoginHint ? '/auth/login' : '/auth',
        nextUrl.href
      );
      auth.searchParams.set('returnUrl', nextUrl.pathname + nextUrl.search);
      return signedOut(NextResponse.redirect(auth));
    }
    // A session that ended: the visitor has an account, so the login form
    // rather than the sign-up one. Either the dead cookie came with the
    // request (deadSession, which is also expired here), or the browser
    // already dropped it at the end of its Max-Age and only the year-long
    // hp_logged_in hint is left (staleLoginHint; /auth/login clears it).
    if (deadSession || staleLoginHint) {
      return signedOut(
        NextResponse.redirect(new URL('/auth/login', nextUrl.href))
      );
    }
    const providers = ['google', 'settings'];
    const findIndex = providers.find((p) => nextUrl.href.indexOf(p) > -1);
    const additional = !findIndex
      ? ''
      : (url.indexOf('?') > -1 ? '&' : '?') +
        `provider=${(findIndex === 'settings'
          ? process.env.HOOKPOST_GENERIC_OAUTH
            ? 'generic'
            : 'github'
          : findIndex
        ).toUpperCase()}`;
    return NextResponse.redirect(
      new URL(`/auth${url}${additional}`, nextUrl.href)
    );
  }

  // Never intercept OAuth callbacks (e.g. Google, GitHub, etc.) - they must reach /auth to exchange the code
  const isOAuthCallback =
    nextUrl.searchParams.has('code') ||
    nextUrl.searchParams.has('provider') ||
    nextUrl.searchParams.has('state');

  // Redirect authenticated users away from login/register/auth forms to the dashboard
  if (
    nextUrl.pathname.startsWith('/auth') &&
    !nextUrl.pathname.startsWith('/auth/logout') &&
    !nextUrl.pathname.startsWith('/auth/activate') &&
    !isOAuthCallback &&
    authCookie
  ) {
    return NextResponse.redirect(new URL(`/launches${url}`, nextUrl.href));
  }
  if (nextUrl.pathname.startsWith('/auth') && !authCookie) {
    return signedOut(topResponse);
  }
  try {
    if (nextUrl.pathname === '/') {
      return NextResponse.redirect(
        new URL(
          !!process.env.IS_GENERAL ? '/launches' : `/analytics`,
          nextUrl.href
        )
      );
    }

    return topResponse;
  } catch (err) {
    console.log('err', err);
    return NextResponse.redirect(new URL('/auth/logout', nextUrl.href));
  }
}

// See "Matching Paths" below to learn more
export const config = {
  matcher: '/((?!api/|_next/|_static/|_vercel|[\\w-]+\\.\\w+).*)',
};