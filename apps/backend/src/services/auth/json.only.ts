import { HttpException } from '@nestjs/common';
import { Request } from 'express';

/**
 * CSRF guard for routes that move money or membership. The auth cookie is
 * SameSite=Lax, which keeps it off another site's form post but not off one
 * from another *.hookstep.in host (the same site) or in a browser that does
 * not enforce SameSite, and Nest also parses urlencoded bodies, so such a
 * page could make a signed-in user's browser POST a form to the API. A form,
 * or a no-cors fetch, cannot send Content-Type application/json without a
 * CORS preflight, and only the frontend's origin passes that (main.ts), so a
 * JSON-only route cannot be reached cross-site.
 *
 * Same idea as the One Tap check in auth.controller, but on the media type
 * itself: "text/plain; x=application/json" is a type a cross-site request may
 * send, and it contains the string.
 */
export function assertJsonRequest(req: Request) {
  const type = String(req?.headers?.['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    throw new HttpException('Send this request as application/json', 415);
  }
}

/** The origins the app's own pages are served from (main.ts CORS, less dev tools). */
export function appOrigins(): Set<string> {
  const out = new Set<string>();
  for (const url of [process.env.FRONTEND_URL, process.env.MAIN_URL]) {
    if (!url) continue;
    try {
      out.add(new URL(url).origin);
    } catch {
      // Not a URL: no origin from it.
    }
  }
  return out;
}

/**
 * The second half of the CSRF guard for a route whose POST changes what an
 * account belongs to (joining a team): the request must come from a page of
 * this app. Browsers put Origin on every POST a page makes, same-origin ones
 * included (the app's Referrer-Policy, strict-origin-when-cross-origin, keeps
 * it a real origin), and a page cannot forge it.
 *
 * SameSite=Lax keeps the session cookie off a cross-site form post, but not
 * off one from another *.hookstep.in host (same site); assertJsonRequest
 * already makes such a post fail its preflight, and this refuses it outright
 * as well, so neither check stands alone. A missing Origin, "null" (a
 * sandboxed frame, a file) or any other origin is a 403.
 */
export function assertAppOrigin(req: Request) {
  const origin = req?.headers?.origin;
  if (typeof origin !== 'string' || !appOrigins().has(origin)) {
    throw new HttpException('This request has to come from the Hookpost app', 403);
  }
}
