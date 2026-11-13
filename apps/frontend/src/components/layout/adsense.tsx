/**
 * Google AdSense auto ads, on the public content pages only (owner's decision,
 * 3 Nov 2026): /guides/* and /alternatives/*, through the layout.tsx in each of
 * those two folders. Which formats run is set in the AdSense console.
 *
 * Never on the app, the homepage, /pricing, sign-up/login or checkout: AdSense
 * picks the ads, and on a page where someone is deciding to buy Hookpost it
 * can show them Buffer or Hootsuite. adsense.spec.ts fails if any other file
 * imports this.
 *
 * Hookstep's publisher id (already live on hookstep.in and Tablamigo's
 * guides). It is public: every page with ads prints it, and public/ads.txt
 * names the same publisher. A constant, not NEXT_PUBLIC_*: marketing pages have
 * no providers and NEXT_PUBLIC_* only inlines at module scope.
 *
 * Consent gate (same as Tablamigo's apps/web/build.py, ADSENSE_CMP = False):
 * Google requires a certified consent tool for ads to visitors in the EEA, the
 * UK and Switzerland, and the AdSense "European regulations" message is not
 * proven to show on these pages yet. So the page does not ship Google's script
 * directly. A small inline loader asks Cloudflare (/cdn-cgi/trace, same host,
 * no cookie) for the visitor's country and adds adsbygoogle.js only when the
 * country is known and NOT in CONSENT_COUNTRIES. Unknown country = no ads.
 * It also waits for the first scroll/tap/key (Core Web Vitals) and runs only
 * on the production host, so local builds and lab runs never request an ad.
 * Lift the gate (ADSENSE_CMP = true) only after an EEA visit shows Google's
 * consent dialog before any ad request.
 */
export const ADSENSE_CLIENT = 'ca-pub-6574958062528034';
export const ADSENSE_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`;
export const ADSENSE_HOST = 'hookpost.hookstep.in';
export const ADSENSE_CMP = false;

// The EEA (27 EU countries, their outermost regions and Aland, plus Iceland,
// Liechtenstein and Norway), the UK with Gibraltar, the Channel Islands and
// the Isle of Man, and Switzerland, as ISO codes Cloudflare reports.
export const CONSENT_COUNTRIES = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'GF',
  'GP',
  'MQ',
  'RE',
  'YT',
  'MF',
  'AX',
  'IS',
  'LI',
  'NO',
  'GB',
  'GI',
  'GG',
  'JE',
  'IM',
  'CH',
] as const;

export function adsenseLoader(cmp: boolean = ADSENSE_CMP): string {
  return (
    `(function(){try{if(location.hostname!==${JSON.stringify(
      ADSENSE_HOST
    )})return;var CMP=${cmp ? 'true' : 'false'},NO=${JSON.stringify(
      CONSENT_COUNTRIES
    )};` +
    `function add(){if(document.querySelector('script[src*="adsbygoogle.js"]'))return;var s=document.createElement('script');s.async=true;s.crossOrigin='anonymous';s.src=${JSON.stringify(
      ADSENSE_SRC
    )};document.head.appendChild(s)}` +
    `function gate(){if(CMP)return add();fetch('/cdn-cgi/trace',{cache:'no-store'}).then(function(r){return r.ok?r.text():''}).then(function(t){var m=/(?:^|\\n)loc=([A-Z]{2})\\b/.exec(t),c=m&&m[1];if(c&&c!=='XX'&&c!=='T1'&&NO.indexOf(c)<0)add()})['catch'](function(){})}` +
    `var ev=['scroll','pointerdown','keydown','touchstart'],done=false;function go(){if(done)return;done=true;ev.forEach(function(e){removeEventListener(e,go,true)});if(window.requestIdleCallback)window.requestIdleCallback(gate,{timeout:3000});else setTimeout(gate,200)}` +
    `ev.forEach(function(e){addEventListener(e,go,{capture:true,passive:true})})}catch(e){}})();`
  );
}

export function AdSenseScript() {
  return (
    <script
      id="adsense-loader"
      dangerouslySetInnerHTML={{ __html: adsenseLoader() }}
    />
  );
}
