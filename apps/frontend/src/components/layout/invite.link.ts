/**
 * Invite links sent before 25 Oct 2026 point at /?org=<token>. Cloudflare
 * caches "/" for signed-out visitors with the query string left out of the
 * cache key, so the request never reaches the proxy: the visitor got the
 * marketing homepage and the invite was dropped. The server cannot tell such
 * a visitor apart (and must not try: one cached redirect would send every
 * homepage visitor into that team's invite for a day), so the homepage
 * itself moves ?org= to /invite/<token> as its first act, which works on
 * the cached copy too. New emails link to /invite/ directly (team.invite.ts).
 *
 * Runs before the attribution and redirect scripts in the landing <head>.
 * The token leaves the address bar first, so the landing page and referrer
 * that later scripts record never carry it, and <html> is marked so the
 * signed-in and Play-app redirects stand aside.
 *
 * Every reference goes through `window`, so the spec can run the exact
 * string against a stand-in (jsdom cannot navigate).
 */
export const INVITE_HTML_ATTR = 'data-hp-invite';

export const INVITE_LINK_SCRIPT = `(function () {
  try {
    var w = window;
    if (w.location.pathname !== '/') return;
    var org = new w.URLSearchParams(w.location.search).get('org');
    if (!org) return;
    w.document.documentElement.setAttribute(${JSON.stringify(INVITE_HTML_ATTR)}, '');
    try { w.history.replaceState(null, '', '/'); } catch (e) {}
    w.location.replace('/invite/' + encodeURIComponent(org));
  } catch (e) {}
})();`;

/** A guard for the other inline scripts: an invite redirect is under way. */
export const INVITE_REDIRECTING_CHECK = `document.documentElement.hasAttribute(${JSON.stringify(
  INVITE_HTML_ATTR
)})`;
