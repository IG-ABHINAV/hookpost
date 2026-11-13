/**
 * Where a workspace's sign-up came from, as one short label for the admin
 * Users page ("claude.ai", "meta / hp_in_sales_23oct", "google / cpc",
 * "direct"): utm source / campaign (or medium without a campaign).
 *
 * Same precedence as SignupAttributionService.report() (utm_source, then the
 * ad click ids, then the referrer, then direct), except that a referral is
 * named by its host instead of being lumped into "(referral)": on 27 Oct 2026
 * twelve sign-ups came from claude.ai and the page could not tell them apart
 * from typed-in visits.
 *
 * No SignupAttribution row (sign-ups before 23 Oct 2026, api.market
 * workspaces) is null: unknown, not direct.
 */
export interface SignupSourceInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  landingPath?: string | null;
  gclid?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  ttclid?: string | null;
  msclkid?: string | null;
}

export type SignupSourceKind = 'utm' | 'click_id' | 'referral' | 'direct';

export interface SignupSource {
  /** e.g. "claude.ai", "meta / hp_in_sales_23oct", "google (gclid)", "direct". */
  label: string;
  kind: SignupSourceKind;
  campaign: string | null;
  landingPath: string | null;
}

/** Hookpost's own sites: a referrer from these is internal navigation. */
const OWN_HOST = /(^|\.)hookstep\.in$/i;
const MAX = 60;

const clean = (v?: string | null) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX) : null;
};

/** The referrer's host, without www. and Meta's link-shim prefixes. */
export function referrerHost(referrer?: string | null): string | null {
  const raw = clean(referrer);
  if (!raw) return null;
  let host: string;
  try {
    const url = new URL(raw);
    host = url.hostname || url.href.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');
  } catch {
    host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0];
  }
  host = host.toLowerCase().replace(/^www\./, '');
  // l.facebook.com, lm.facebook.com, m.facebook.com, l.instagram.com
  host = host.replace(/^(?:l|lm|m)\.(facebook|instagram)\.com$/, '$1.com');
  return host ? host.slice(0, MAX) : null;
}

export function signupSource(a?: SignupSourceInput | null): SignupSource | null {
  if (!a) return null;
  const campaign = clean(a.utmCampaign);
  const landingPath = clean(a.landingPath);
  const out = (label: string, kind: SignupSourceKind): SignupSource => ({
    label,
    kind,
    campaign,
    landingPath,
  });

  // "meta / hp_in_sales_23oct": the campaign says which ad, the medium is
  // the fallback when a link has no campaign.
  const source = clean(a.utmSource);
  if (source) {
    const second = campaign || clean(a.utmMedium);
    return out(second ? `${source} / ${second}` : source, 'utm');
  }
  if (clean(a.gclid)) return out('google (gclid)', 'click_id');
  if (clean(a.fbclid)) return out('meta (fbclid)', 'click_id');
  if (clean(a.ttclid)) return out('tiktok (ttclid)', 'click_id');
  if (clean(a.msclkid)) return out('bing (msclkid)', 'click_id');

  const host = referrerHost(a.referrer);
  if (host && !OWN_HOST.test(host)) return out(host, 'referral');
  return out('direct', 'direct');
}

/**
 * The "Sign-up" block of the admin user panel (GET /admin/users/:id/journey):
 * everything we know about how one workspace's owner arrived and how far
 * they got, in plain fields. Dates are ISO strings (the page shows IST).
 */
export interface SignupDetailsInput {
  user: {
    createdAt: Date | string;
    providerName?: string | null;
    signupCountry?: string | null;
    signupCity?: string | null;
  };
  attribution?:
    | (SignupSourceInput & {
        method?: string | null;
        device?: string | null;
        inApp?: string | null;
        country?: string | null;
        firstChannelAt?: Date | string | null;
        trialStartedAt?: Date | string | null;
        paidAt?: Date | string | null;
      })
    | null;
  /** Earliest finished channel, for workspaces from before firstChannelAt existed. */
  firstChannelFallback?: Date | string | null;
  channels: number;
  posts: number;
  workspaceId: string | null;
}

export interface SignupDetails {
  workspaceId: string | null;
  source: SignupSource | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  inApp: string | null;
  method: string | null;
  signedUpAt: string;
  firstChannelAt: string | null;
  trialStartedAt: string | null;
  paidAt: string | null;
  channels: number;
  posts: number;
}

const iso = (v?: Date | string | null) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function signupDetails(input: SignupDetailsInput): SignupDetails {
  const a = input.attribution ?? null;
  return {
    workspaceId: input.workspaceId,
    source: signupSource(a),
    utmSource: clean(a?.utmSource),
    utmMedium: clean(a?.utmMedium),
    utmCampaign: clean(a?.utmCampaign),
    referrerHost: referrerHost(a?.referrer),
    landingPath: clean(a?.landingPath),
    country: clean(a?.country) || clean(input.user.signupCountry),
    city: clean(input.user.signupCity),
    device: clean(a?.device),
    inApp: clean(a?.inApp),
    method: clean(a?.method) || clean(input.user.providerName),
    signedUpAt: iso(input.user.createdAt) as string,
    firstChannelAt: iso(a?.firstChannelAt) || iso(input.firstChannelFallback),
    trialStartedAt: iso(a?.trialStartedAt),
    paidAt: iso(a?.paidAt),
    channels: input.channels,
    posts: input.posts,
  };
}
