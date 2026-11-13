import { NextResponse } from 'next/server';
import { getCookieUrlFromDomain } from '@hookpost/helpers/subdomain/subdomain.management';
import { internalFetch } from '@hookpost/helpers/utils/internal.fetch';
import {
  INVITE_CONFIRM_PATH,
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE_SECONDS,
  INVITE_PENDING_COOKIE,
  INVITE_RESULT_COOKIE,
  INVITE_RESULT_MAX_AGE_SECONDS,
  InviteOutcome,
  invitePath,
  looksLikeInviteToken,
} from '@hookpost/helpers/auth/team.invite';

/**
 * /invite/<token>, the link in a team invite email (proxy.ts sends every
 * request for it here):
 *
 * - signed out: the token goes into the httpOnly invite cookie and the
 *   visitor to the sign-up page (/auth?invite=1, which names the team and
 *   links to sign-in). Whichever way they then get in, the backend redeems
 *   the cookie (AuthService.routeAuth / redeemInvite): joined at once with
 *   Google or a confirmed account, held until the email is confirmed for a
 *   new password account. Signing up or in from an invite is itself the
 *   visitor's answer. Someone whose session ended goes to the sign-in form
 *   instead, as everywhere else.
 * - signed in: nothing is joined. The token goes into the httpOnly
 *   INVITE_PENDING_COOKIE and the visitor to /invite, which asks "Join
 *   <team>? You were invited by <name>." and joins only on the POST of its
 *   Join button (POST /user/invite/accept). Until 25 Oct 2026 this GET
 *   joined at once, so a link a stranger got someone to open dropped them
 *   into the stranger's workspace. A link that cannot be used (forged,
 *   expired, used, its workspace gone) skips the question: the app says so.
 *
 * Every answer is a redirect to a fixed path on this site: nothing from the
 * request decides where it goes, so the flow cannot be pointed elsewhere.
 * The token never reaches a rendered page (the cookies are httpOnly), and the
 * redirects carry no referrer, so the pages after it cannot leak the link to
 * the trackers they load.
 */
export async function inviteLink(params: {
  pathname: string;
  href: string;
  signedIn: boolean;
  /** The visitor has an account (a dead session, or the login hint). */
  hasAccount: boolean;
  /** Expires the session cookie on a response (proxy.ts clearDeadSession). */
  clearSession: (res: NextResponse) => NextResponse;
}): Promise<NextResponse> {
  const { href, signedIn, hasAccount, clearSession } = params;
  const token = tokenFromPath(params.pathname);
  const go = (path: string) => noStore(NextResponse.redirect(new URL(path, href)));

  if (!signedIn) {
    const signIn = hasAccount ? '/auth/login' : '/auth';
    if (!token) {
      return go(`${signIn}?invite=invalid`);
    }
    const res = go(`${signIn}?invite=1`);
    setInviteCookie(res, token);
    return res;
  }

  if (!token) {
    return withResult(go('/launches'), 'invalid');
  }

  // What the question would show, read with the visitor's session: a GET
  // that joins nothing. Asked here so that a session the backend refuses
  // still goes to the sign-in with the invite kept, and a dead link goes
  // straight to the app, which says so.
  let reply: Response;
  try {
    reply = await internalFetch('/user/invite', {
      method: 'GET',
      headers: { cookie: `${INVITE_PENDING_COOKIE}=${token}` },
    });
  } catch {
    return withResult(go('/launches'), 'error');
  }

  // The session looked live here (an unexpired exp) but the backend refused
  // it (a changed password, a deleted account): signed out after all. Keep
  // the invite for the sign-in, and expire the dead session, or the sign-in
  // form would bounce to /launches on it (review of 1162ff204).
  if (reply.status === 401) {
    const res = go('/auth/login?invite=1');
    setInviteCookie(res, token);
    return clearSession(res);
  }
  if (!reply.ok) {
    return withResult(go('/launches'), 'error');
  }
  const body = (await reply.json().catch(() => null)) as {
    valid?: unknown;
  } | null;
  if (body?.valid !== true) {
    return withResult(go('/launches'), body?.valid === false ? 'invalid' : 'error');
  }

  const res = go(INVITE_CONFIRM_PATH);
  res.cookies.set(INVITE_PENDING_COOKIE, token, {
    ...cookieBase(),
    httpOnly: secured(),
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

/**
 * Where a request carrying the old ?org=<token> goes: the same /invite/ path
 * an email links to now. Anything that is not shaped like a token is sent
 * as "invalid", so nothing from the query string becomes a path.
 */
export const invitePathFromQuery = (org: string) =>
  invitePath(looksLikeInviteToken(org) ? org : 'invalid');

/** The token in /invite/<token>, or null if the path is anything else. */
export function tokenFromPath(pathname: string): string | null {
  const parts = pathname.split('/');
  // ['', 'invite', '<token>'], nothing after it.
  if (parts.length !== 3 || parts[0] !== '' || !parts[2]) {
    return null;
  }
  let token: string;
  try {
    token = decodeURIComponent(parts[2]);
  } catch {
    return null;
  }
  return looksLikeInviteToken(token) ? token : null;
}

const secured = () => !process.env.NOT_SECURED;

/** Domain and path as the backend's own cookies have them (session.cookies.ts). */
const cookieBase = () => ({
  path: '/',
  domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
  ...(secured() ? { secure: true, sameSite: 'lax' as const } : {}),
});

function setInviteCookie(res: NextResponse, token: string) {
  res.cookies.set(INVITE_COOKIE, token, {
    ...cookieBase(),
    httpOnly: secured(),
    maxAge: INVITE_COOKIE_MAX_AGE_SECONDS,
  });
}

function withResult(res: NextResponse, outcome: InviteOutcome) {
  res.cookies.set(INVITE_RESULT_COOKIE, outcome, {
    ...cookieBase(),
    // Read once by the app (InviteResultToast), then removed.
    httpOnly: false,
    maxAge: INVITE_RESULT_MAX_AGE_SECONDS,
  });
  return res;
}

function noStore(res: NextResponse) {
  res.headers.set('Cache-Control', 'private, no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}
