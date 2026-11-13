// Android visitors arriving on the homepage from a Meta ad can be sent to the
// Play listing, in one of two ways (META_AD_MODE), or left on the website:
//
// - AUTO_REDIRECT: the page forwards them on its own, once the pixel PageView
//   has been sent (see below).
// - INSTALL_BAR: no automatic navigation. A full-width sticky "Install on
//   Google Play" bar shows at the top of the page; one tap opens the listing
//   with the same install referrer. The bar is in the HTML for everyone but
//   hidden unless this script marks <html> with META_AD_BAR_ATTR, which it does
//   before the body is parsed, so it never shifts the layout.
// - OFF: no script at all. Ad visitors stay on the web page like everyone else.
//
// OFF since 22 Oct 2026: a new account made in the Play app reaches only
// TWA_PLAN_NOTICE (no trial, no Free plan, no way forward), and 159 devices
// redirected on 17 Oct produced 0 installs. Switch back once the app can take a
// new user from sign-up to a trial.
//
// Either way the eligibility test is the same. The ad itself cannot point at Play: Meta rejects a Play Store URL on
// a Traffic campaign ("App Url is only supported by App Installs objective"),
// so the ad keeps its web URL and the page forwards Android users.
//
// The ad set optimises for Landing Page Views, and Meta only counts one when
// the pixel's PageView reaches facebook.com/tr from this page. So the redirect
// waits for that request to complete, with a hard cap (REDIRECT_CAP_MS) so a
// slow or blocked pixel never strands the visitor. On every other page view the
// pixel library loads only after the first interaction or ~4s
// (when-engaged.ts); for these visitors it is started immediately instead,
// with the same stub, the same queue and the same script id, so
// FacebookComponent finds it already in place and does nothing twice.
//
// Decided in the browser, never on the server: the homepage HTML is cached by
// Cloudflare and NGINX and must stay identical for every visitor.
//
// No 'use client' on purpose, like twa.ts: (landing)/layout.tsx is a server
// component and inlines the string. Plain ES5, not compiled. Everything goes
// through `window` so meta-ad-redirect.spec.ts can run this exact string
// against a stand-in.

import { PLAY_STORE_URL, TWA_HTML_ATTR } from './twa';

/** utm_source values Meta ads carry, including placement suffixes (Facebook_Mobile_Feed). */
export const META_UTM_SOURCE = /^(meta|facebook|fb|instagram|ig)([_\-. ].*)?$/i;

/** Crawlers and audit tools that send an Android UA. They see the page as is. */
export const BOT_UA =
  /googlebot|adsbot|mediapartners|google-inspectiontool|apis-google|bingbot|facebookexternalhit|facebookcatalog|meta-external|meta-webindexer|lighthouse|crawler|spider|bot\//i;

export type MetaAdMode = 'AUTO_REDIRECT' | 'INSTALL_BAR' | 'OFF';
/** Switch between the behaviours here. */
export const META_AD_MODE: MetaAdMode = 'OFF';

/** Set on <html> in INSTALL_BAR mode; META_AD_BAR_CSS shows the bar under it. */
export const META_AD_BAR_ATTR = 'data-hp-adbar';
export const META_AD_BAR_ID = 'hp-ad-install';
export const META_AD_BAR_HEIGHT = 52;
/** Hidden by default; shown, and the sticky site nav pushed below it, under the attribute. */
export const META_AD_BAR_CSS = `#${META_AD_BAR_ID}{display:none}html[${META_AD_BAR_ATTR}] #${META_AD_BAR_ID}{display:flex}html[${META_AD_BAR_ATTR}] .hp-site-nav{top:${META_AD_BAR_HEIGHT}px}`;

export const REDIRECT_CAP_MS = 1500;
/** sessionStorage: this tab has already been sent to Play once. */
export const REDIRECT_DONE_KEY = 'hp_play_redirected';

/** The inline script for `mode`; empty for OFF, and the layout then ships no tag. */
export const metaAdRedirectScript = (
  pixelId: string | undefined,
  mode: MetaAdMode = META_AD_MODE
) => mode === 'OFF' ? '' : `(function () {
  try {
    var w = window, d = w.document, l = w.location;
    var bar = ${JSON.stringify(mode === 'INSTALL_BAR')};
    if (l.pathname !== '/') return;
    var ua = (w.navigator && w.navigator.userAgent) || '';
    if (!/Android/.test(ua) || ${BOT_UA}.test(ua)) return;
    var q = new w.URLSearchParams(l.search);
    if (!${META_UTM_SOURCE}.test(q.get('utm_source') || '')) return;
    // Already inside the Play app (TWA_BOOTSTRAP_SCRIPT marks <html>, and
    // TWA_HOME_REDIRECT_SCRIPT sends it to /auth), or an installed app window.
    var html = d.documentElement;
    if (html.hasAttribute(${JSON.stringify(TWA_HTML_ATTR)})) return;
    if ((d.referrer || '').indexOf('android-app://') === 0) return;
    if (w.matchMedia && (w.matchMedia('(display-mode: standalone)').matches ||
        w.matchMedia('(display-mode: fullscreen)').matches)) return;
    // Signed-in customers are sent to /launches by the script above.
    if ((';' + d.cookie).replace(/\\s/g, '').indexOf(';hp_logged_in=1') !== -1) return;
    // Once per tab: coming Back from Play must not bounce straight there again.
    if (!bar) {
      try {
        if (w.sessionStorage.getItem(${JSON.stringify(REDIRECT_DONE_KEY)}) === '1') return;
      } catch (e) {}
    }

    // Install referrer for Play Console. utm_content becomes ad_redirect so
    // these installs are told apart from badge taps; the ad's own utm_content
    // (the creative's language) moves to utm_term.
    var playUrl = function () {
      var r = new w.URLSearchParams();
      ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term'].forEach(function (k) {
        var v = q.get(k);
        if (v) r.set(k, v);
      });
      if (q.get('utm_content') && !q.get('utm_term')) r.set('utm_term', q.get('utm_content'));
      r.set('utm_content', bar ? 'ad_install_bar' : 'ad_redirect');
      return ${JSON.stringify(PLAY_STORE_URL)} + '&referrer=' + encodeURIComponent(r.toString());
    };

    var gone = false;
    var go = function () {
      if (bar || gone) return;
      gone = true;
      try { w.sessionStorage.setItem(${JSON.stringify(REDIRECT_DONE_KEY)}, '1'); } catch (e) {}
      l.replace(playUrl());
    };

    if (bar) {
      var attr = ${JSON.stringify(META_AD_BAR_ATTR)};
      html.setAttribute(attr, '');
      // A hydration re-render can drop attributes React did not render (see
      // TWA_BOOTSTRAP_SCRIPT); put it back if that happens.
      if (typeof w.MutationObserver === 'function') {
        new w.MutationObserver(function () {
          if (!html.hasAttribute(attr)) html.setAttribute(attr, '');
        }).observe(html, { attributes: true, attributeFilter: [attr] });
      }
      // The link's href is the plain listing in the HTML (the same for every
      // visitor); the referrer is added at tap time, so hydration never sees a
      // changed attribute.
      d.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.closest && ev.target.closest('#' + ${JSON.stringify(META_AD_BAR_ID)});
        if (a) a.href = playUrl();
      }, true);
    }

    var pixel = ${JSON.stringify(pixelId || '')};
    if (!pixel) { go(); return; }
    if (!bar) w.setTimeout(go, ${REDIRECT_CAP_MS});

    // Load the pixel now rather than after the first interaction, so the
    // PageView (what a Landing Page View counts) is sent before the visitor
    // leaves for Play. Meta's stub, as FacebookComponent installs it: init +
    // PageView queue here and the library drains the queue when it arrives.
    if (!w.fbq) {
      var n = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      w.fbq = n;
      if (!w._fbq) w._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      n('init', pixel);
      n('track', 'PageView');
    }
    ['https://connect.facebook.net', 'https://www.facebook.com'].forEach(function (h) {
      var p = d.createElement('link');
      p.rel = 'preconnect';
      p.href = h;
      d.head.appendChild(p);
    });
    if (!d.getElementById('fb-pixel-lib')) {
      var s = d.createElement('script');
      s.id = 'fb-pixel-lib';
      s.src = '/f.js';
      s.async = true;
      d.head.appendChild(s);
    }
    // A resource entry is recorded when the request completes, so seeing
    // facebook.com/tr here means the PageView has reached Meta.
    if (!bar && w.PerformanceObserver) {
      new w.PerformanceObserver(function (list) {
        var e = list.getEntries();
        for (var i = 0; i < e.length; i++) {
          if (/^https:\\/\\/[a-z.]*facebook\\.com\\/tr\\b/.test(e[i].name)) { go(); return; }
        }
      }).observe({ type: 'resource', buffered: true });
    }
  } catch (e) {}
})();`
    // The // comments above document the script here; they need not ship in
    // every homepage response.
    .replace(/^\s*\/\/.*\n/gm, '');
