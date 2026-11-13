/**
 * Who may talk to the extension, and where it sends what it reads.
 *
 * Exactly one web origin may message it: the Hookpost app. Not any
 * *.hookstep.in page (tablamigo, media and the other subdomains are other
 * products or hold user uploads), not plain http, and not a local server outside a
 * dev build. manifest.json's externally_connectable says the same thing, so
 * Chrome refuses other pages before they reach this code; this is the second
 * lock.
 *
 * The backend URL is fixed here and never taken from a message. It used to be:
 * STORE_REFRESH_TOKEN carried a backendUrl that the daily refresh then posted
 * the user's Skool cookies to, so any page allowed to send that message could
 * have pointed it at its own server.
 */
export const PRODUCTION_ORIGIN = 'https://hookpost.hookstep.in';
export const PRODUCTION_BACKEND_URL = `${PRODUCTION_ORIGIN}/api`;

const PRODUCTION_ORIGIN_PATTERN = /^https:\/\/hookpost\.hookstep\.in$/;

export interface OriginPolicy {
  /** Origins allowed besides the production one. Only a dev build has any. */
  devOrigins: RegExp | null;
}

export const PRODUCTION_POLICY: OriginPolicy = { devOrigins: null };

// Referenced only from the dev branch of background.ts, so the store build
// drops it (scripts/build.mjs fails if "localhost" is left in background.js).
export const DEV_POLICY: OriginPolicy = {
  devOrigins: /^https?:\/\/localhost(:\d+)?$/,
};

/** Parses to an origin, or undefined. "null" and garbage are undefined. */
function toOrigin(value: string): string | undefined {
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * The sender's origin: sender.origin, or the origin of sender.url on a Chrome
 * old enough not to set it. Parsing (rather than matching the raw string)
 * means userinfo, paths and look-alike suffixes cannot pass:
 * https://hookpost.hookstep.in@example.com has the origin example.com.
 */
export function senderOrigin(sender: {
  origin?: string;
  url?: string;
}): string | undefined {
  const raw = sender.origin ?? sender.url;
  return raw ? toOrigin(raw) : undefined;
}

export function isOriginAllowed(
  origin: string | undefined,
  policy: OriginPolicy = PRODUCTION_POLICY
): boolean {
  if (!origin) return false;
  const normalised = toOrigin(origin);
  if (!normalised) return false;
  if (PRODUCTION_ORIGIN_PATTERN.test(normalised)) return true;
  return !!policy.devOrigins && policy.devOrigins.test(normalised);
}
