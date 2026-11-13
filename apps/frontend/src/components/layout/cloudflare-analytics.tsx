'use client';

import { useEffect } from 'react';

/**
 * Cloudflare Web Analytics, loaded by us instead of injected by Cloudflare.
 *
 * With "Automatic setup" on, Cloudflare rewrites every HTML response of the
 * zone to carry <script type="module" src=".../beacon.min.js"> in the markup,
 * where the browser meets it during the first paint (it showed up in the
 * Lighthouse request chain and costs FCP). This does the same job after the
 * page has finished loading and the main thread is idle.
 *
 * It is safe to ship BEFORE the automatic injection is switched off: the loader
 * does nothing if a beacon script is already on the page, so a visit is never
 * counted twice. After the owner turns automatic injection off in the Cloudflare
 * dashboard (Web Analytics -> hookpost.hookstep.in -> Manage site), this is the
 * only beacon left.
 *
 * The token is the site token Cloudflare prints in every public page's HTML
 * (data-cf-beacon), not a secret. It is a constant, not NEXT_PUBLIC_*, on
 * purpose: marketing pages have no providers and NEXT_PUBLIC_* only inlines at
 * module scope, so an env var here would silently be empty.
 *
 * `spa: true` lets the beacon count client-side route changes: the layout that
 * mounts this survives next/link navigations, so the page is not reloaded.
 */
export const CF_BEACON_SRC = 'https://static.cloudflareinsights.com/beacon.min.js';
export const CF_BEACON_TOKEN = '88c7787047e04bab8a994b5bb649e9a1';

const BEACON_PRESENT = 'script[src*="cloudflareinsights.com/beacon"]';

/** Adds the beacon unless one is already on the page. Returns true if it added one. */
export function injectCloudflareBeacon(doc: Document): boolean {
  if (doc.querySelector(BEACON_PRESENT)) return false;
  const script = doc.createElement('script');
  script.defer = true;
  script.src = CF_BEACON_SRC;
  script.setAttribute(
    'data-cf-beacon',
    JSON.stringify({ token: CF_BEACON_TOKEN, spa: true })
  );
  doc.head.appendChild(script);
  return true;
}

/** The only host that reports. Local dev, Lighthouse and E2E stacks carry the same token. */
export const CF_BEACON_HOST = 'hookpost.hookstep.in';

/** After window "load", then when the browser is idle (setTimeout where there is no idle callback). */
export function scheduleCloudflareBeacon(win: Window, doc: Document): void {
  // Anything but the live site would count as a production visit under the same site token.
  if (win.location?.hostname !== CF_BEACON_HOST) return;
  const idle = () => {
    const run = () => injectCloudflareBeacon(doc);
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(run, { timeout: 3000 });
    } else {
      win.setTimeout(run, 1500);
    }
  };
  if (doc.readyState === 'complete') idle();
  else win.addEventListener('load', idle, { once: true });
}

export function CloudflareAnalytics(): null {
  useEffect(() => {
    scheduleCloudflareBeacon(window, document);
  }, []);
  return null;
}
