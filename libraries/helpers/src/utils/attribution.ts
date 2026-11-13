/**
 * Sign-up attribution: which ad, campaign or page a new account came from.
 *
 * The marketing pages are served from Cloudflare's cache, so the server never
 * sees most ad landings (the cache ignores the query string). An inline script
 * (ATTRIBUTION_CAPTURE_SCRIPT, in the (landing) and /auth layouts) records the
 * first touch in a first-party cookie, hp_attr, before anything else runs. The
 * backend reads that cookie when an account is created, whatever the sign-up
 * method (email, Google, One Tap, GitHub...), and stores it with the workspace
 * (SignupAttribution).
 *
 * First touch, with one refinement: an untagged visit (direct, organic,
 * a referral) is kept only until a tagged one (utm_* or an ad click id)
 * arrives; a tagged first touch is never overwritten. Ninety days.
 *
 * No dependencies: the frontend and the backend both import this file.
 */

export const ATTRIBUTION_COOKIE = 'hp_attr';
export const ATTRIBUTION_MAX_AGE_DAYS = 90;

export const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
] as const;
export const CLICK_ID_KEYS = ['gclid', 'fbclid', 'ttclid', 'msclkid'] as const;
export const ATTRIBUTION_URL_KEYS = [...UTM_KEYS, ...CLICK_ID_KEYS] as const;

export type AttributionKey = (typeof ATTRIBUTION_URL_KEYS)[number];

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
  /** Path of the first page (no query string: it can carry tokens). */
  landing_path?: string;
  /** Origin and path of the referring page, never its query string. */
  referrer?: string;
  /** When this touch was recorded, epoch ms (also dates Meta's fbc). */
  first_seen_at?: number;
}

/**
 * Pages whose address carries a secret, opened from an email: a password
 * reset (/auth/forgot/<token>, usable for 20 minutes) and an account
 * activation (/auth/activate/<code>). A visit to one is never a first touch,
 * and its path is never stored, sent or reported.
 */
export const TOKEN_PATH = /^\/auth\/(?:forgot|activate)\/[^/]/;
export const isTokenPath = (path: string) => TOKEN_PATH.test(path);

/** Longest utm_* value kept; the cookie is user-controlled input. */
const MAX_VALUE = 150;
/**
 * Longest ad click id kept. A click id is never shortened: Meta flags a
 * modified fbclid, and a cut id written back into a link (the trial button,
 * "Open in your browser") would end up in the pixel's _fbc. fbclids in the
 * production access log of 19-22 Oct ran to 201 characters, 44 of 61 longer
 * than 150; an id longer than this is dropped, not cut. Meta's fbc check in
 * signup-attribution.service.ts allows the same length.
 */
export const MAX_CLICK_ID = 500;
const MAX_PATH = 200;
const MAX_REFERRER = 300;
/** Longest encoded hp_attr value written; browsers drop a cookie over 4096 bytes. */
const MAX_COOKIE = 3800;

/**
 * Runs inline in <head>, before hydration, on every marketing page and on
 * /auth. ES5 on purpose, every step in try/catch: it must never break a page.
 * Keep it in step with readAttributionCookie below; attribution.spec.ts runs
 * this exact string in a browser-like DOM. Writes nothing on a TOKEN_PATH
 * page. utm_* values are cut to MAX_VALUE; a click id is kept whole or not
 * at all (MAX_CLICK_ID). Should the whole value still pass MAX_COOKIE, the
 * referrer goes first, then nothing is written.
 */
export const ATTRIBUTION_CAPTURE_SCRIPT = `(function(){try{
if(new RegExp(${JSON.stringify(TOKEN_PATH.source)}).test(location.pathname))return;
var K=${JSON.stringify(ATTRIBUTION_COOKIE)},P=${JSON.stringify(ATTRIBUTION_URL_KEYS)},C=${JSON.stringify(CLICK_ID_KEYS)};
var q=new URLSearchParams(location.search),cur={},tagged=false,i,v;
for(i=0;i<P.length;i++){v=q.get(P[i]);if(!v)continue;if(C.indexOf(P[i])>=0){if(v.length>${MAX_CLICK_ID})continue;cur[P[i]]=v;}else{cur[P[i]]=v.slice(0,${MAX_VALUE});}tagged=true;}
var m=document.cookie.match(new RegExp('(?:^|; )'+K+'=([^;]*)')),old=null;
if(m){try{old=JSON.parse(decodeURIComponent(m[1]));}catch(e){old=null;}}
if(old&&typeof old==='object'){var oldTagged=false;for(i=0;i<P.length;i++){if(old[P[i]]){oldTagged=true;}}if(oldTagged||!tagged)return;}
var r='';try{if(document.referrer){var u=new URL(document.referrer);if(u.host!==location.host){r=(u.origin+u.pathname).slice(0,${MAX_REFERRER});}}}catch(e){r='';}
cur.landing_path=location.pathname.slice(0,${MAX_PATH});
if(r){cur.referrer=r;}
cur.first_seen_at=Date.now();
var s=encodeURIComponent(JSON.stringify(cur));
if(s.length>${MAX_COOKIE}&&cur.referrer){delete cur.referrer;s=encodeURIComponent(JSON.stringify(cur));}
if(s.length>${MAX_COOKIE})return;
document.cookie=K+'='+s+'; Path=/; Max-Age=${
  ATTRIBUTION_MAX_AGE_DAYS * 86400
}; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');
}catch(e){}})();`;

const clean = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  // Printable text only: no control characters reach the database or Meta.
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return v || undefined;
};

/** A click id whole, or nothing: never a shortened one (see MAX_CLICK_ID). */
const cleanClickId = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return v && v.length <= MAX_CLICK_ID ? v : undefined;
};

/**
 * The hp_attr cookie, validated. The browser can send anything in it, so only
 * known keys survive, as trimmed strings within the length limits (a click
 * id over MAX_CLICK_ID is dropped, never cut), and a first_seen_at that is a
 * plausible time. Null when there is nothing usable.
 */
export function readAttributionCookie(raw?: string | null): Attribution | null {
  if (!raw) return null;
  // Express's cookie parser hands it over decoded; document.cookie does not.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      parsed = JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const src = parsed as Record<string, unknown>;
  const out: Attribution = {};
  for (const key of UTM_KEYS) {
    const v = clean(src[key], MAX_VALUE);
    if (v) out[key] = v;
  }
  for (const key of CLICK_ID_KEYS) {
    const v = cleanClickId(src[key]);
    if (v) out[key] = v;
  }
  const path = clean(src.landing_path, MAX_PATH);
  // A token-bearing path written before the capture script skipped them.
  if (path && path.startsWith('/') && !isTokenPath(path)) out.landing_path = path;
  const ref = clean(src.referrer, MAX_REFERRER);
  if (ref && /^https?:\/\//i.test(ref)) out.referrer = ref;
  const at = Number(src.first_seen_at);
  // Not before Hookpost existed, not in the future (one day of clock skew).
  if (Number.isFinite(at) && at > Date.UTC(2026, 0, 1) && at < Date.now() + 86_400_000) {
    out.first_seen_at = Math.floor(at);
  }
  return Object.keys(out).length ? out : null;
}

/** True when the touch came from a tagged link (utm_* or an ad click id). */
export const isTagged = (a: Attribution | null | undefined) =>
  !!a && ATTRIBUTION_URL_KEYS.some((k) => !!a[k]);

/**
 * The backend's own copy of the first touch, an HttpOnly cookie. Safari
 * (ITP) keeps a cookie written by page script, as hp_attr is, for 7 days,
 * and for 24 hours when the visit came through a link a tracker decorated
 * (an fbclid from facebook.com); a cookie the site's own server sets is not
 * shortened. The marketing pages post hp_attr to /public/t with their
 * ViewContent event, the backend keeps the first touch here, and a sign-up
 * reads both (firstTouch).
 */
export const SERVER_ATTRIBUTION_COOKIE = 'hp_attr_s';

/**
 * The first touch of two recorded ones, by the rule the capture script
 * follows: a tagged touch over an untagged one, else the earlier one. A tie
 * goes to `a`. Either may be missing.
 */
export function firstTouch(
  a: Attribution | null | undefined,
  b: Attribution | null | undefined
): Attribution | null {
  if (!a) return b || null;
  if (!b) return a;
  if (isTagged(a) !== isTagged(b)) return isTagged(a) ? a : b;
  const seenA = a.first_seen_at ?? Number.POSITIVE_INFINITY;
  const seenB = b.first_seen_at ?? Number.POSITIVE_INFINITY;
  return seenB < seenA ? b : a;
}

/**
 * Longest encoded SERVER_ATTRIBUTION_COOKIE value written. The browser sends
 * it with every request to the site for up to 90 days, next to hp_attr (up
 * to MAX_COOKIE) and the session, and an oversized Cookie header is refused
 * at the edge; so the server copy stays well under hp_attr's size, whatever
 * a link puts in it.
 */
export const MAX_SERVER_COOKIE = 1536;

/** True when the encoded JSON of `a` fits in MAX_SERVER_COOKIE. */
const fitsServerCookie = (a: Attribution) =>
  encodeURIComponent(JSON.stringify(a)).length <= MAX_SERVER_COOKIE;

/**
 * The server copy of a touch, within MAX_SERVER_COOKIE: everything when it
 * fits, else without the referrer, else without the landing path too, else
 * with only the first click id (gclid, fbclid, ttclid, msclkid order). A
 * real ad link fits whole: its utm tags, one click id, a short path. Null
 * when even that is over, or when what is left no longer says where the
 * touch came from (a tag or the landing page).
 */
function serverCopyOf(touch: Attribution): Attribution | null {
  const { referrer: _referrer, ...noReferrer } = touch;
  const { landing_path: _path, ...noPath } = noReferrer;
  const firstClick = CLICK_ID_KEYS.find((key) => noPath[key]);
  const oneClick: Attribution = { ...noPath };
  for (const key of CLICK_ID_KEYS) {
    if (key !== firstClick) delete oneClick[key];
  }
  const candidates: Attribution[] = [touch, noReferrer, noPath, oneClick];
  const copy = candidates.find(fitsServerCookie);
  return copy && (isTagged(copy) || copy.landing_path || copy.referrer)
    ? copy
    : null;
}

/**
 * What /public/t writes into SERVER_ATTRIBUTION_COOKIE for the first touch a
 * page posted (hp_attr, as an object or as the cookie's raw value), given
 * what the cookie holds: the value (JSON, at most MAX_SERVER_COOKIE encoded:
 * serverCopyOf) and when it expires, ATTRIBUTION_MAX_AGE_DAYS after the
 * touch. Null when there is nothing to write: nothing valid was posted, the
 * cookie already holds this touch or an earlier one, or the touch cannot be
 * kept within the limit.
 */
export function serverAttributionUpdate(
  existingRaw: string | null | undefined,
  posted: unknown,
  now = Date.now()
): { value: string; expires: Date } | null {
  const incoming =
    typeof posted === 'string'
      ? readAttributionCookie(posted)
      : posted && typeof posted === 'object' && !Array.isArray(posted)
      ? readAttributionCookie(JSON.stringify(posted))
      : null;
  // A touch says where it came from: a tag, the landing page or a referrer.
  if (!incoming || !(isTagged(incoming) || incoming.landing_path || incoming.referrer)) {
    return null;
  }
  if (firstTouch(readAttributionCookie(existingRaw), incoming) !== incoming) {
    return null;
  }
  const expires = new Date(
    (incoming.first_seen_at ?? now) + ATTRIBUTION_MAX_AGE_DAYS * 86_400_000
  );
  if (expires.getTime() <= now) return null;
  const copy = serverCopyOf(incoming);
  return copy ? { value: JSON.stringify(copy), expires } : null;
}

/**
 * Meta's fbc value for a click id, as its pixel writes the _fbc cookie:
 * fb.1.<when the click was first seen, ms>.<fbclid>. A value that is already
 * an fbc is kept as it is.
 */
export function toFbc(fbclidOrFbc?: string | null, seenAt?: number): string | undefined {
  if (!fbclidOrFbc) return undefined;
  if (/^fb\.\d\.\d+\./.test(fbclidOrFbc)) return fbclidOrFbc;
  return `fb.1.${Math.floor(seenAt || Date.now())}.${fbclidOrFbc}`;
}

/** Reads hp_attr from document.cookie (browser only). */
export function attributionFromDocument(): Attribution | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${ATTRIBUTION_COOKIE}=([^;]*)`));
  return m ? readAttributionCookie(m[1]) : null;
}

export type InAppBrowser =
  | 'instagram'
  | 'facebook'
  | 'messenger'
  | 'threads'
  | 'linkedin'
  | 'tiktok'
  | 'twitter'
  | 'snapchat'
  | 'pinterest'
  | 'line'
  | 'wechat';

/**
 * The app whose built-in browser this is, from the user agent, or null for a
 * real browser. Google refuses its sign-in inside every one of these
 * (disallowed_useragent), which is why /auth leads with email there.
 */
export function inAppBrowser(ua?: string | null): InAppBrowser | null {
  const s = ua || '';
  if (/Instagram/i.test(s)) return 'instagram';
  if (/Barcelona/.test(s)) return 'threads';
  if (/FB_IAB|FBAN|FBAV|FB4A|FBIOS/.test(s)) {
    return /Messenger|Orca-Android/i.test(s) ? 'messenger' : 'facebook';
  }
  if (/LinkedInApp/i.test(s)) return 'linkedin';
  if (/musical_ly|BytedanceWebview|TikTok|trill_\d|ByteLocale/i.test(s)) return 'tiktok';
  if (/Twitter|TwitterAndroid/i.test(s)) return 'twitter';
  if (/Snapchat/i.test(s)) return 'snapchat';
  if (/Pinterest/i.test(s)) return 'pinterest';
  if (/\bLine\//.test(s)) return 'line';
  if (/MicroMessenger/i.test(s)) return 'wechat';
  return null;
}

export type DeviceClass = 'mobile' | 'tablet' | 'desktop';

/** Phone, tablet or computer, from the user agent. */
export function deviceClass(ua?: string | null): DeviceClass {
  const s = ua || '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(s) || (/Android/i.test(s) && !/Mobile/i.test(s))) {
    return 'tablet';
  }
  if (/Mobi|iPhone|iPod|Android|Windows Phone|IEMobile|BlackBerry|Opera Mini/i.test(s)) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * The page's own address with the first-touch tags added back (those it does
 * not already carry), so a visitor who opens it in another browser lands with
 * the same attribution. Used by the "open in your browser" prompts.
 */
export function urlWithAttribution(href: string, a: Attribution | null): string {
  try {
    const url = new URL(href);
    if (a) {
      for (const key of ATTRIBUTION_URL_KEYS) {
        const v = a[key];
        if (v && !url.searchParams.has(key)) url.searchParams.set(key, v);
      }
    }
    return url.toString();
  } catch {
    return href;
  }
}


export const IN_APP_NAMES: Record<InAppBrowser, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  messenger: 'Messenger',
  threads: 'Threads',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  twitter: 'X',
  snapchat: 'Snapchat',
  pinterest: 'Pinterest',
  line: 'LINE',
  wechat: 'WeChat',
};


/**
 * Android hands a page to Chrome with an intent: URL; it works from the
 * Instagram, Facebook, LinkedIn and TikTok browsers when the visitor taps it
 * (never navigated to automatically). browser_fallback_url keeps them on the
 * page if Chrome is missing.
 */
export function chromeIntentUrl(href: string): string {
  try {
    const u = new URL(href);
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=${u.protocol.replace(
      ':',
      ''
    )};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(href)};end`;
  } catch {
    return href;
  }
}
