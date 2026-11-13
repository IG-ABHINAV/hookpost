import type { CookieOptions, Request, Response } from 'express';
import { getCookieUrlFromDomain } from '@hookpost/helpers/subdomain/subdomain.management';
import { SESSION_TTL_SECONDS } from '@hookpost/helpers/auth/session.lifetime';
import {
  INVITE_COOKIE,
  INVITE_COOKIE_MAX_AGE_SECONDS,
  INVITE_PENDING_COOKIE,
  INVITE_RESULT_COOKIE,
  INVITE_RESULT_MAX_AGE_SECONDS,
  InviteOutcome,
  looksLikeInviteToken,
} from '@hookpost/helpers/auth/team.invite';

const YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * The auth cookie lives as long as the session inside it (30 days), and is
 * set again whenever the session is (sign-in, and refreshSession).
 */
const SESSION_MS = SESSION_TTL_SECONDS * 1000;
const authCookie = () => sessionCookie({ maxAge: SESSION_MS });

/**
 * With NOT_SECURED empty, session cookies are httpOnly, Secure and
 * SameSite=Lax, and the session token never travels in a response header to
 * the browser. NOT_SECURED is for plain-http development and the integration
 * suite only, where the token comes back in an `auth` header that the
 * frontend copies into a readable cookie.
 */
export const cookiesSecured = () => !process.env.NOT_SECURED;

/**
 * The flags of every cookie that carries a session or picks a workspace:
 * auth, showorg, impersonate and the OAuth sign-in state.
 *
 * - httpOnly: no script on the page can read the session, so an XSS or a
 *   compromised third-party tag cannot take it.
 * - Secure: never sent over plain http.
 * - SameSite=Lax: sent when the app calls its own /api, and on a top-level
 *   navigation from another site (Google or an email link sending the user
 *   back). Never on a cross-site form post or fetch.
 *
 * Domain is the registrable domain (.hookstep.in), the same one a readable
 * copy written under NOT_SECURED has, so setting the cookie replaces such a
 * copy instead of sitting next to it.
 */
export function sessionCookie(extra: CookieOptions = {}): CookieOptions {
  return {
    domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    ...(cookiesSecured()
      ? { secure: true, httpOnly: true, sameSite: 'lax' as const }
      : {}),
    expires: new Date(Date.now() + YEAR_MS),
    ...extra,
  };
}

/**
 * hp_logged_in: a readable "probably signed in" hint for the edge-cached
 * homepage's script. Not a credential; the backend never reads it.
 */
export function hintCookie(extra: CookieOptions = {}): CookieOptions {
  return {
    domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    ...(cookiesSecured()
      ? { secure: true, httpOnly: false, sameSite: 'lax' as const }
      : {}),
    expires: new Date(Date.now() + YEAR_MS),
    ...extra,
  };
}

/** The same cookie, expired: what clears it in the browser. */
export const expired = (options: CookieOptions): CookieOptions => ({
  ...options,
  maxAge: -1,
  expires: new Date(0),
});

/**
 * Signs a browser in: the session cookie and the readable hint.
 *
 * The token goes back in an `auth` header only under NOT_SECURED, or for a
 * client that keeps no cookies and asked for it (`forClient`: the native
 * mobile sign-in, which passes its own redirect_uri). A browser never needs
 * it with secure cookies, and a token in a header is one page scripts can
 * read, so it is not sent.
 */
export function startSession(
  res: Response,
  jwt: string,
  options: { forClient?: boolean } = {}
) {
  res.cookie('auth', jwt, authCookie());
  res.cookie('hp_logged_in', '1', hintCookie());
  if (!cookiesSecured() || options.forClient) {
    res.header('auth', jwt);
  }
}

/**
 * A fresh token for a session in use (AuthMiddleware, once it is a day old),
 * by the same rules as startSession: the cookie, and the header only under
 * NOT_SECURED, where the frontend keeps its own copy of the token. A client
 * that keeps no cookies is never sent the header here, so its session ends 30
 * days after sign-in.
 */
export function refreshSession(res: Response, jwt: string) {
  res.cookie('auth', jwt, authCookie());
  if (!cookiesSecured()) {
    res.header('auth', jwt);
  }
}

/** Selects a workspace for the session (showorg). */
export function selectWorkspace(res: Response, organizationId: string) {
  res.cookie('showorg', organizationId, sessionCookie());
  if (!cookiesSecured()) {
    res.header('showorg', organizationId);
  }
}

/**
 * After a sign-up or sign-in that may have redeemed a team invite: the
 * invite cookie the proxy set is spent (it used to stay for its two days, and
 * every sign-in in that browser would have tried it again), the app is told
 * what became of the invite (INVITE_RESULT_COOKIE, read once by
 * InviteResultToast), and the workspace joined, or already a member of, is
 * the one shown. Nothing happens when there was no invite cookie and nothing
 * was redeemed.
 */
export function settleInvite(
  req: Request,
  res: Response,
  redeemed: { outcome: InviteOutcome; organizationId?: string } | null
) {
  if (!req.cookies?.[INVITE_COOKIE] && !redeemed) {
    return;
  }
  res.cookie(INVITE_COOKIE, '', expired(sessionCookie({ path: '/' })));
  res.cookie(
    INVITE_RESULT_COOKIE,
    redeemed?.outcome ?? 'invalid',
    hintCookie({ path: '/', maxAge: INVITE_RESULT_MAX_AGE_SECONDS * 1000 })
  );
  if (redeemed?.organizationId) {
    selectWorkspace(res, redeemed.organizationId);
  }
}

/**
 * A sign-in nobody chose (Google One Tap's automatic sign-in of a returning
 * account) must not redeem the invite in the sign-in cookie: anyone who can
 * get a browser signed out and onto the invite page would otherwise get its
 * Google user joined without a click. The invite becomes the question a
 * signed-in visitor answers instead (INVITE_PENDING_COOKIE, the flags the
 * proxy uses), and the sign-in cookie is spent. True when there was one.
 */
export function askAboutInvite(req: Request, res: Response): boolean {
  const token = req.cookies?.[INVITE_COOKIE];
  if (!looksLikeInviteToken(token)) {
    return false;
  }
  res.cookie(
    INVITE_PENDING_COOKIE,
    token,
    sessionCookie({ path: '/', maxAge: INVITE_COOKIE_MAX_AGE_SECONDS * 1000 })
  );
  res.cookie(INVITE_COOKIE, '', expired(sessionCookie({ path: '/' })));
  return true;
}

/**
 * Removes the invite a signed-in visitor was asked about
 * (INVITE_PENDING_COOKIE), with the flags the proxy set it with. Nothing
 * else changes: the invite itself is not spent, so its link still works
 * until it expires ("Not now").
 */
export function clearPendingInvite(res: Response) {
  res.cookie(INVITE_PENDING_COOKIE, '', expired(sessionCookie({ path: '/' })));
}

/**
 * After the Join button (POST /user/invite/accept): the question is
 * answered, so its cookie goes whatever the outcome; the app says what
 * happened (INVITE_RESULT_COOKIE, read once by InviteResultToast); and the
 * workspace joined, or already a member of, is the one shown.
 */
export function settlePendingInvite(
  res: Response,
  redeemed: { outcome: InviteOutcome; organizationId?: string }
) {
  clearPendingInvite(res);
  res.cookie(
    INVITE_RESULT_COOKIE,
    redeemed.outcome,
    hintCookie({ path: '/', maxAge: INVITE_RESULT_MAX_AGE_SECONDS * 1000 })
  );
  if (redeemed.organizationId) {
    selectWorkspace(res, redeemed.organizationId);
  }
}

/** Ends impersonation: the cookie expires (an empty value would linger a year). */
export function stopImpersonation(res: Response) {
  res.cookie('impersonate', '', expired(sessionCookie()));
}

const headerValue = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

/**
 * The session token of a request: the cookie first. The `auth` header is for
 * clients that keep no cookies (the native mobile app, the frontend's own
 * server-side fetches), and for a browser that can still read a cookie
 * written under NOT_SECURED, which sends that copy as a header. When both
 * arrive, the cookie is the one the backend set last.
 */
export const sessionToken = (req: Request): string | undefined =>
  req.cookies?.auth || headerValue(req.headers?.auth);

/**
 * The UserOrganization a super admin is looking at, or undefined. With secure
 * cookies only the httpOnly cookie counts: POST /user/impersonate is the one
 * way to set it and the stop button the one way to clear it, so a value a
 * page script copied into a header can never keep impersonation going after
 * the cookie was cleared.
 */
export const impersonationTarget = (req: Request): string | undefined =>
  req.cookies?.impersonate ||
  (cookiesSecured() ? undefined : headerValue(req.headers?.impersonate));

/**
 * A session cookie set without the secure flags (in NOT_SECURED mode) is
 * one the frontend sends back as an `auth` header too. When a request
 * carries the cookie and the same token as that header, and cookies are
 * secured, set the cookie again with the secure flags: same name, domain
 * and path, so it replaces that copy. Two different tokens mean two
 * cookies of one name; nothing is set then, so a newer sign-in is never
 * overwritten with an older one.
 * (The frontend removes the host-only copies, which a domain cookie set here
 * cannot reach: libraries/helpers/src/utils/custom.fetch.func.ts.)
 */
export function upgradeReadableSession(req: Request, res: Response) {
  if (!cookiesSecured()) return false;
  const cookie = req.cookies?.auth;
  if (!cookie || headerValue(req.headers?.auth) !== cookie) return false;
  startSession(res, cookie);
  return true;
}

/** Clears every session cookie (sign-out, a deleted account). */
export function endSession(res: Response) {
  res.cookie('auth', '', expired(sessionCookie()));
  res.cookie('hp_logged_in', '', expired(hintCookie()));
  res.cookie('showorg', '', expired(sessionCookie()));
  res.cookie('impersonate', '', expired(sessionCookie()));
  // A question about an invite is for the account that was signed in.
  clearPendingInvite(res);
}
