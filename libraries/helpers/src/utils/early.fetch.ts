/**
 * Requests an app page starts from its HTML, before React has loaded.
 *
 * Every signed-in page used to wait for its JavaScript to load and hydrate
 * (about 1 s after the HTML arrived on a phone in India) before asking for
 * /user/self, and the layout renders nothing until that answers. /launches
 * then asked for /integrations/list only after that, so the calendar's
 * spinner sat through three round trips in a row (~0.5 s each from India,
 * through Cloudflare to the Singapore origin).
 *
 * EARLY_FETCH_SCRIPT runs inline in the (site) layout's HTML and starts those
 * GETs at once, exactly as customFetch would send them with secure cookies.
 * customFetch then takes the answer (takeEarlyResponse) instead of sending
 * the same request again, and passes it through afterRequest like any other,
 * so logout, reload and onboarding handling are unchanged. Each answer is
 * taken once, and only within EARLY_FETCH_MAX_AGE_MS of the page load: a later
 * request (a mutate, a revalidation) always goes to the network.
 */

export const EARLY_FETCH_MAX_AGE_MS = 15000;

/** The paths started early on every app page, and on /launches. */
export const EARLY_FETCH_PATHS = ['/user/self'];
export const EARLY_FETCH_LAUNCHES_PATHS = ['/integrations/list'];

type EarlyStore = { t: number; r: Record<string, Promise<Response> | undefined> };

declare global {
  interface Window {
    __hpEarly?: EarlyStore;
  }
}

/**
 * The inline script. Only for a browser that has signed in here before
 * (hp_logged_in, set when /user/self answered 2xx), so a signed-out visitor
 * never sends a request that can only 401. Before it sends anything it drops
 * the host-only session cookie copies, the same thing
 * clearHostOnlySessionCookies does before the app's first request, so the
 * early request carries the same cookies the app's own would.
 */
export const earlyFetchScript = (backendUrl: string) => {
  const config = JSON.stringify({
    b: backendUrl,
    a: EARLY_FETCH_PATHS,
    l: EARLY_FETCH_LAUNCHES_PATHS,
  }).replace(/</g, '\\u003c');
  return `(function(c){try{if(!/(?:^|;\\s*)hp_logged_in=1/.test(document.cookie)||location.search.indexOf('loggedAuth=')>-1||!window.fetch)return;['auth','showorg','impersonate'].forEach(function(n){document.cookie=n+'=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'});var p=c.a.concat(location.pathname.indexOf('/launches')===0?c.l:[]),r={};p.forEach(function(x){var u=c.b+x;r[u]=fetch(u,{credentials:'include',headers:{'Content-Type':'application/json',Accept:'application/json'},cache:'no-store'});r[u].catch(function(){})});window.__hpEarly={t:Date.now(),r:r}}catch(e){}})(${config});`;
};

/**
 * The early answer for this request, once, or undefined: a plain GET with no
 * body and no extra headers only, started within EARLY_FETCH_MAX_AGE_MS.
 */
export const takeEarlyResponse = (
  url: string,
  options: RequestInit = {},
  now: number = Date.now()
): Promise<Response> | undefined => {
  if (typeof window === 'undefined') return undefined;
  const store = window.__hpEarly;
  if (!store) return undefined;
  if ((options.method || 'GET').toUpperCase() !== 'GET') return undefined;
  if (options.body !== undefined && options.body !== null) return undefined;
  if (
    options.headers &&
    (Object.getPrototypeOf(options.headers) !== Object.prototype ||
      Object.keys(options.headers).length)
  ) {
    return undefined;
  }
  const response = store.r[url];
  if (!response) return undefined;
  store.r[url] = undefined;
  if (now - store.t > EARLY_FETCH_MAX_AGE_MS) return undefined;
  return response;
};
