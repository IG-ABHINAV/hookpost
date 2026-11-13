/**
 * How long a login session lasts. Shared by the backend, which signs and
 * checks sessions (helpers/auth/auth.service.ts, AuthMiddleware), and the
 * frontend, which only routes on them (proxy.ts). No imports, so the proxy
 * and client components can use it without pulling in bcrypt or jsonwebtoken.
 *
 * A session carries iat and exp and lasts 30 days, sliding: once a session
 * is a day old, the next request that uses it gets a fresh one, so a user
 * who opens the app at least once a month is never signed out, and one who
 * stays away for 30 days signs in again.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** A session older than this is re-issued on its next authenticated request. */
export const SESSION_REFRESH_AFTER_SECONDS = 24 * 60 * 60;

export const SESSION_TTL_DAYS = SESSION_TTL_SECONDS / (24 * 60 * 60);

/**
 * The claims of a JWT, decoded WITHOUT checking its signature, or null when it
 * is not a JWT. Only for routing where the backend checks the token on every
 * call anyway (proxy.ts); never for deciding who someone is.
 */
export function unverifiedClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    return claims && typeof claims === 'object' && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * True when `token` looks like a session that has not expired: a JWT with an
 * exp in the future. A token without exp is not one. The signature is not checked (see unverifiedClaims): a token that
 * passes here can still be refused by the backend, for example after a
 * password reset, and the app's 401 handling signs the browser out then.
 */
export function sessionLooksLive(token: unknown, nowMs = Date.now()): boolean {
  const claims = unverifiedClaims(token);
  return !!claims && typeof claims.exp === 'number' && claims.exp * 1000 > nowMs;
}
