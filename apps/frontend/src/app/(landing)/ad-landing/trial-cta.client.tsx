'use client';

import { useEffect, useState } from 'react';
import {
  ATTRIBUTION_URL_KEYS,
  CLICK_ID_KEYS,
  UTM_KEYS,
  attributionFromDocument,
} from '@hookpost/helpers/utils/attribution';

/**
 * The sign-up button of the ad landing pages. The page's HTML is edge-cached
 * for everyone, so the link is /auth; after hydration it carries the ad's
 * tags, for the analytics that run on /auth (GTM, the pixel) and for a
 * visitor whose first-touch cookie (hp_attr) was lost between the two pages.
 * The sign-up itself records what hp_attr holds, not what this link says.
 *
 * The tags go as one set, never mixed from two visits:
 * - this URL has any utm_* or click id: exactly this URL's utm_* and click
 *   ids (gclid, fbclid, ttclid, msclkid);
 * - otherwise: hp_attr's utm_* only. Its click id is an earlier click: in a
 *   fresh /auth URL Meta's pixel would date it now and take it for a new
 *   one. The sign-up still gets it from hp_attr itself.
 * The "Open in your browser" prompt is different: the other browser has no
 * hp_attr, so it carries everything (urlWithAttribution).
 */
export function TrialCta({ label, className }: { label: string; className?: string }) {
  const [href, setHref] = useState('/auth');
  useEffect(() => {
    try {
      const here = new URLSearchParams(window.location.search);
      const carry = new URLSearchParams();
      if (ATTRIBUTION_URL_KEYS.some((key) => here.get(key))) {
        for (const key of [...UTM_KEYS, ...CLICK_ID_KEYS]) {
          const v = here.get(key);
          if (v) carry.set(key, v);
        }
      } else {
        const first = attributionFromDocument();
        for (const key of UTM_KEYS) {
          const v = first?.[key];
          if (v) carry.set(key, v);
        }
      }
      const q = carry.toString();
      if (q) setHref(`/auth?${q}`);
    } catch {
      // The plain /auth link still works.
    }
  }, []);
  return (
    <a href={href} data-testid="trial-cta" className={className}>
      {label}
    </a>
  );
}
