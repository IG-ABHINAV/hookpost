/**
 * The Source cell on the super-admin Users page: where the sign-up came from
 * (GET /admin/users -> organization.signupSource, built by the backend's
 * signup.source.ts) next to the marketplace the workspace belongs to
 * (organization.source: DIRECT or a marketplace id).
 */

export interface SignupSourceView {
  label: string;
  kind: 'utm' | 'click_id' | 'referral' | 'direct';
  campaign: string | null;
  landingPath: string | null;
}

export interface SourceCell {
  /** "claude.ai", "google / cpc", "direct", or "unknown" with no attribution. */
  primary: string;
  known: boolean;
  /** The landing path (the campaign is in the label already), else null. */
  detail: string | null;
  /** "Direct" or the marketplace's name ("api.market"). */
  marketplace: string;
  viaMarketplace: boolean;
  /** Tooltip: everything the cell knows, in one line. */
  title: string;
}

export function sourceCell(
  org:
    | { signupSource?: SignupSourceView | null; source?: string | null }
    | null
    | undefined,
  marketplaces: { id: string; label: string }[] = []
): SourceCell {
  const s = org?.signupSource ?? null;
  const sourceId = org?.source || 'DIRECT';
  const viaMarketplace = sourceId !== 'DIRECT';
  const marketplace = viaMarketplace
    ? marketplaces.find((m) => m.id === sourceId)?.label || sourceId
    : 'Direct';
  const detail = s ? s.landingPath || (s.kind === 'utm' ? null : s.campaign) || null : null;
  const title = s
    ? [
        `Source: ${s.label}`,
        s.campaign ? `campaign ${s.campaign}` : null,
        s.landingPath ? `landed on ${s.landingPath}` : null,
        `workspace: ${marketplace}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : `No sign-up attribution recorded (sign-ups before 23 Oct 2026 and marketplace workspaces have none) · workspace: ${marketplace}`;
  return {
    primary: s ? s.label : 'unknown',
    known: !!s,
    detail,
    marketplace,
    viaMarketplace,
    title,
  };
}

/** GET /admin/users/:id/journey -> signup (signup.source.ts signupDetails). */
export interface SignupDetailsView {
  workspaceId: string | null;
  source: SignupSourceView | null;
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

/** GET /admin/checkout-signals, one workspace (Razorpay). */
export interface CheckoutSignalView {
  checkoutsOpened: number;
  currencies: string[];
  lastOpenedAt: string | null;
  authenticated: boolean;
  pastDue?: boolean;
  payments: {
    status: string;
    amount: number;
    currency: string;
    method?: string;
    at: string;
    error: string | null;
  }[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "27 Oct 2026, 10:19 IST" (IST is UTC+5:30 all year, no zone library needed). */
export function istTime(value?: string | null): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  const d = new Date(t + 330 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())} IST`;
}

const amount = (n: number, currency: string) =>
  `${currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency + ' '}${n}`;

/**
 * The last checkout in plain words. `loaded` false: Razorpay was not read
 * (yet), so "not known" rather than "never".
 */
export function checkoutSummary(
  signal: CheckoutSignalView | undefined | null,
  loaded: boolean
): string {
  if (!signal) return loaded ? 'Never opened checkout' : 'Not known (Razorpay not read)';
  const latest = [...(signal.payments || [])].sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const when = istTime(latest && (!signal.lastOpenedAt || latest.at > signal.lastOpenedAt) ? latest.at : signal.lastOpenedAt);
  const cur = signal.currencies.length ? ` (${signal.currencies.join('/')})` : '';
  let result: string;
  if (latest && latest.status === 'failed') {
    result = `payment of ${amount(latest.amount, latest.currency)} failed${latest.error ? `: ${latest.error}` : ''}`;
  } else if (latest && ['captured', 'authorized'].includes(latest.status)) {
    result = `paid ${amount(latest.amount, latest.currency)}`;
  } else if (latest && latest.status === 'refunded') {
    result = `card/UPI check of ${amount(latest.amount, latest.currency)} passed and was refunded (card or UPI added)`;
  } else if (signal.pastDue) {
    result = 'card or UPI added, a charge is failing';
  } else if (signal.authenticated) {
    result = 'card or UPI added';
  } else if (signal.checkoutsOpened > 0) {
    result = 'opened checkout, did not finish';
  } else {
    result = 'no checkout';
  }
  const times = signal.checkoutsOpened > 1 ? ` · ${signal.checkoutsOpened} checkouts` : '';
  return `${when ? `${when} — ` : ''}${result}${cur}${times}`;
}

/** The panel's rows: [label, plain-words value]. */
export function signupRows(
  d: SignupDetailsView,
  signal: CheckoutSignalView | undefined | null,
  signalsLoaded: boolean
): [string, string][] {
  const not = (v: string | null | undefined, none = 'Not recorded') => v || none;
  const utm = [d.utmSource, d.utmMedium, d.utmCampaign].some(Boolean)
    ? [d.utmSource, d.utmMedium, d.utmCampaign].map((v) => v || '—').join(' / ')
    : null;
  return [
    ['Source', d.source ? d.source.label : 'Unknown (no attribution recorded)'],
    ['UTM (source / medium / campaign)', not(utm, 'None')],
    ['Came from (referrer)', not(d.referrerHost, 'No referrer (typed in, app or bookmark)')],
    ['First page', not(d.landingPath)],
    ['Country', d.country ? `${d.country}${d.city ? ` (${d.city})` : ''}` : 'Not recorded'],
    ['Device', d.device ? `${d.device}${d.inApp ? `, inside the ${d.inApp} app` : ''}` : 'Not recorded'],
    ['Signed up with', not(d.method)],
    ['Signed up at', istTime(d.signedUpAt) || '—'],
    ['First channel connected', istTime(d.firstChannelAt) || 'Never'],
    ['Card or UPI added', istTime(d.trialStartedAt) || 'No'],
    ['Paid', istTime(d.paidAt) || 'No'],
    ['Channels / posts', `${d.channels} channel${d.channels === 1 ? '' : 's'}, ${d.posts} post${d.posts === 1 ? '' : 's'}`],
    ['Last checkout', checkoutSummary(signal, signalsLoaded)],
  ];
}
