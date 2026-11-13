/**
 * Which currency a workspace or visitor is shown and charged. PR-4 of
 * local-assets/trial-usd-plan-2026-10-18.md.
 *
 * Decided on the server only, by one function (decideCheckoutCurrency), which
 * feeds GET /public/pricing-context, GET /billing/pricing-context and
 * RazorpayService.subscribe() alike. The currency shown is always the currency
 * charged: there is no separate "display" currency any more, so a page can
 * never show dollar labels over a rupee checkout (PHASE2.md's "$599" trap).
 *
 * Pure: no Nest, Prisma or Razorpay imports. RazorpayService feeds it the
 * Razorpay and database facts it needs, and scripts/pricing/test-dynamic-
 * pricing.ts runs it with bun.
 *
 * The order, as the plan sets it:
 *   1. The currency of the workspace's live plan (it cannot open a second plan
 *      in another currency beside it). An INR plan whose charge is being
 *      retried (pending, halted) keeps the workspace on rupees too.
 *   2. USD_CHECKOUT=allowlist and the workspace's id or its creator's email is
 *      in USD_ALLOWLIST: USD, whatever the country. This is the L2 card test.
 *   3. The country is India: INR.
 *   4. USD_CHECKOUT=on, GST_LUT_ARN is set and the country is not in
 *      USD_EXCLUDED_COUNTRIES: USD. An unknown country counts as not India,
 *      as it does for the trial cutoff (trial.policy.ts).
 *   5. Otherwise INR.
 *
 * Every switch ships off, so deploying this changes nothing: everyone is
 * charged rupees exactly as before. INTL_CHECKOUT, which this replaces, is no
 * longer read.
 */
import {
  getPricing,
  PRICING_BY_CURRENCY,
  SupportedCurrency,
} from '../database/prisma/subscriptions/pricing';
import { excludedCountries } from '../database/prisma/subscriptions/trial.policy';
import type { FirstMonthOfferTerms } from './first.month.offer';

type Env = Record<string, string | undefined>;
type Warn = (message: string) => void;

const defaultWarn: Warn = (m) => console.warn(m);

/** USD_CHECKOUT. Anything but exactly `allowlist` or `on` is `off`. */
export type UsdCheckoutMode = 'off' | 'allowlist' | 'on';

/** The paid tiers on sale. FREE has no price and TEAM/ULTIMATE are retired. */
export const PRICED_TIERS = ['STANDARD', 'PRO', 'HOOKPOST'] as const;
export type PricedTier = (typeof PRICED_TIERS)[number];

/** What everyone is charged unless the rules below say otherwise. */
export const SUBSCRIPTION_CURRENCY = 'INR';

/**
 * The currency a new subscription is created in. The one plan on sale
 * (HOOKPOST) is one Razorpay INR plan for every buyer, India or not
 * (pricing.ts HOOKPOST_PRICE, the owner, 8 Nov 2026): a foreign card pays it
 * through Razorpay's currency conversion. Any other tier keeps the currency
 * the rules below decided (`decided`).
 */
export function newPurchaseCurrency(billing: string, decided: string): string {
  return billing === 'HOOKPOST' ? SUBSCRIPTION_CURRENCY : decided;
}

/** The currencies a Hookpost checkout can open a subscription in. */
export const CHARGEABLE_CURRENCIES = ['INR', 'USD'] as const;

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * One request header as Cloudflare sends it, or undefined when it is missing
 * or meaningless. XX means Cloudflare could not place the address and T1 means
 * Tor, so both are treated as missing. Moved here from auth.middleware.ts,
 * which uses it for the sign-up location.
 */
export function headerValue(headers: HeaderBag | undefined, name: string) {
  const v = headers?.[name.toLowerCase()];
  const raw = (Array.isArray(v) ? v[0] : v || '').toString().trim();
  if (!raw || raw.toUpperCase() === 'XX' || raw.toUpperCase() === 'T1') {
    return undefined;
  }
  try {
    return decodeURIComponent(raw).slice(0, 80);
  } catch {
    return raw.slice(0, 80);
  }
}

/**
 * The visitor's country from Cloudflare's `cf-ipcountry`, or null.
 *
 * Only this header is read. `x-country` (which the old frontend proxy fell back
 * to) is whatever the client chose to send, so it is never consulted. The
 * header itself could be forged by anyone reaching the origin without going
 * through Cloudflare; nginx.hookpost.conf drops it unless the request came
 * from a Cloudflare address.
 */
export function trustedCountry(headers: HeaderBag | undefined): string | null {
  const v = headerValue(headers, 'cf-ipcountry');
  if (!v) return null;
  const code = v.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Browser timezone as sent by the page, trimmed to something harmless. */
export function sanitizeTz(tz: unknown): string {
  return typeof tz === 'string' ? tz.trim().slice(0, 64) : '';
}

export function tzSaysIndia(tz: unknown): boolean {
  const t = sanitizeTz(tz).toLowerCase();
  return t.includes('kolkata') || t.includes('calcutta');
}

export interface Region {
  country: string | null;
  tzSaysIndia: boolean;
  ipSaysIndia: boolean;
}

/** Both location signals of one request, each reported separately. */
export function resolveRegion(headers: HeaderBag | undefined, tz: unknown): Region {
  const country = trustedCountry(headers);
  return {
    country,
    tzSaysIndia: tzSaysIndia(tz),
    ipSaysIndia: country === 'IN',
  };
}

/** An ISO 3166 alpha-2 code, upper-cased, or null (XX and T1 are null). */
function countryCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const c = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) && c !== 'XX' && c !== 'T1' ? c : null;
}

/** Where a workspace (or a signed-out visitor) is, for the currency. */
export interface CurrencyHints {
  /**
   * signupCountry of the workspace's creator (its first SUPERADMIN), the same
   * field trial.policy.ts reads. Recorded from Cloudflare on their first
   * signed-in request; every signup since 10 Oct 2026 has one.
   */
  ownerCountry?: string | null;
  /** trustedCountry() of the request, on the owner's own browser requests. */
  requestCountry?: string | null;
  /** The browser's IANA timezone, where the page sent one. */
  tz?: string | null;
}

/**
 * The country the currency follows: the creator's signup country, so an
 * Indian owner on a trip or a VPN keeps rupees and UPI. Without one (accounts
 * from before 10 Oct 2026, a signed-out visitor), India if either the request
 * or the browser's timezone says India (a VPN moves the IP, not the clock),
 * else the request's country, else null (unknown).
 */
export function currencyCountry(hints: CurrencyHints): string | null {
  const owner = countryCode(hints.ownerCountry);
  if (owner) return owner;
  const request = countryCode(hints.requestCountry);
  if (request === 'IN' || tzSaysIndia(hints.tz)) return 'IN';
  return request;
}

// One log line per misconfiguration, not one per request.
const warned = new Set<string>();
function warnOnce(warn: Warn, key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

/** For tests: let the same misconfiguration warn again. */
export function resetUsdCheckoutWarnings() {
  warned.clear();
}

/**
 * USD_CHECKOUT, read from the environment on every call so a restart with a
 * changed .env applies without a code change. Rollback is setting it to off
 * (or empty), never deleting the line: the backend's env override only
 * applies keys present in .env.
 */
export function usdCheckoutMode(
  env: Env = process.env,
  warn: Warn = defaultWarn
): UsdCheckoutMode {
  if ((env.INTL_CHECKOUT || '').trim()) {
    warnOnce(
      warn,
      'INTL_CHECKOUT',
      'INTL_CHECKOUT is no longer read; USD_CHECKOUT (off, allowlist or on) replaced it.'
    );
  }
  const raw = (env.USD_CHECKOUT || '').trim().toLowerCase();
  if (raw === 'allowlist' || raw === 'on') return raw;
  if (raw && raw !== 'off') {
    warnOnce(
      warn,
      `USD_CHECKOUT=${raw}`,
      `USD_CHECKOUT="${raw}" is not off, allowlist or on; treating it as off, so everyone is charged rupees.`
    );
  }
  return 'off';
}

/** An LUT on file: selling abroad without one means 18% IGST on every sale. */
export function hasGstLut(env: Env = process.env): boolean {
  return !!(env.GST_LUT_ARN || '').trim();
}

/**
 * Whether USD_CHECKOUT=on actually sells in dollars: only with GST_LUT_ARN
 * set. `on` without it is logged once and charges rupees, as `off` does.
 */
export function usdOnForEveryone(
  env: Env = process.env,
  warn: Warn = defaultWarn
): boolean {
  if (usdCheckoutMode(env, warn) !== 'on') return false;
  if (hasGstLut(env)) return true;
  warnOnce(
    warn,
    'USD_CHECKOUT=on without LUT',
    'USD_CHECKOUT=on is ignored because GST_LUT_ARN is empty; everyone outside the allowlist is charged rupees.'
  );
  return false;
}

/**
 * USD_ALLOWLIST: workspace ids and creator emails, separated by commas or
 * spaces. Compared case-insensitively.
 */
export function usdAllowlist(env: Env = process.env): Set<string> {
  return new Set(
    String(env.USD_ALLOWLIST ?? '')
      .split(/[\s,;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** The workspace a checkout is for, as far as the allowlist needs it. */
export interface CurrencySubject {
  orgId?: string | null;
  /** Email of the workspace's creator (its first SUPERADMIN). */
  ownerEmail?: string | null;
  /** currencyCountry() of the workspace or visitor. */
  country: string | null;
}

export function onUsdAllowlist(
  subject: CurrencySubject,
  env: Env = process.env
): boolean {
  const list = usdAllowlist(env);
  if (!list.size) return false;
  const id = (subject.orgId || '').trim().toLowerCase();
  const email = (subject.ownerEmail || '').trim().toLowerCase();
  return (!!id && list.has(id)) || (!!email && list.has(email));
}

/**
 * Whether the decision for this workspace can depend on who it is (its
 * creator's country and email), so RazorpayService only reads those when it
 * matters: with USD_CHECKOUT off nothing new is read at all.
 */
export function currencyNeedsSubject(env: Env = process.env): boolean {
  const mode = usdCheckoutMode(env, () => undefined);
  if (mode === 'on') return true;
  return mode === 'allowlist' && usdAllowlist(env).size > 0;
}

/** Upper-cased ISO code, or null for anything that is not one. */
export function normaliseCurrencyCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

function isChargeable(code: string | null): code is (typeof CHARGEABLE_CURRENCIES)[number] {
  return !!code && (CHARGEABLE_CURRENCIES as readonly string[]).includes(code);
}

/** Razorpay subscription states that hold an org to its plan's currency. */
export const LOCKING_STATES = ['active', 'authenticated'];

/**
 * Razorpay states of a plan whose charge is being retried. An INR plan in one
 * of them keeps the workspace on rupees (it is a paying customer in dunning),
 * though it does not lock: a new checkout may still replace it.
 */
export const DUNNING_STATES = ['pending', 'halted'];

export interface EntitlementRow {
  identifier?: string | null;
  isLifetime?: boolean | null;
  deletedAt?: Date | string | null;
  cancelAt?: Date | string | null;
}

/**
 * Whether an org's stored subscription still holds it to that plan's currency.
 *
 * It does while the plan is live: Razorpay says `authenticated` (a trial, or
 * paid up front a moment ago) or `active`, or a cancellation is scheduled for a
 * date still in the future, so the customer keeps the plan until then.
 *
 * `halted` and `pending` do not lock. A customer whose mandate stopped paying
 * (an Indian card that no longer works abroad, say) must be able to buy again,
 * and the replacement retires the old subscription once it is authorised.
 * `created` is a checkout nobody completed. Lifetime rows have no Razorpay
 * subscription behind them and never lock.
 */
export function entitlementLocks(input: {
  row: EntitlementRow | null | undefined;
  remoteStatus?: string | null;
  now?: Date;
}): boolean {
  const { row, remoteStatus } = input;
  const now = input.now || new Date();
  if (!row || row.deletedAt || row.isLifetime || !row.identifier) return false;
  if (remoteStatus && LOCKING_STATES.includes(remoteStatus)) return true;
  if (row.cancelAt && new Date(row.cancelAt).getTime() > now.getTime()) {
    return true;
  }
  return false;
}

/** Why a checkout charges what it does. */
export type CurrencyReason =
  /** The workspace's live (or retrying INR) plan. */
  | 'plan'
  /** USD_CHECKOUT=allowlist and the workspace is on USD_ALLOWLIST. */
  | 'allowlist'
  /** The country is India. */
  | 'india'
  /** USD_CHECKOUT=on, an LUT on file, a country the rail sells to. */
  | 'usd'
  /** None of the above: rupees, as before PR-4. */
  | 'default';

export interface CheckoutDecision {
  /** The currency this org is, or would be, billed in and shown. */
  chargeCurrency: string;
  lockedCurrency: string | null;
  /** False means the subscription checkout must answer 409 CURRENCY_LOCKED. */
  allowed: boolean;
  reason: CurrencyReason;
}

/**
 * What a subscription checkout charges, in the order at the top of this file.
 *
 * `lockedCurrency` is the currency of the live plan on file (entitlementLocks),
 * `dunningCurrency` that of a plan on file whose charge is being retried.
 * Neither is ever a reason to switch a workspace off rupees on its own: a
 * locked USD plan keeps dollars because it is already billed in them.
 *
 * A live plan in a currency no checkout opens (EUR, GBP: never sold) keeps
 * that currency for display and is refused (allowed false), so support can end
 * the old plan first rather than a second plan opening beside it.
 */
export function decideCheckoutCurrency(input: {
  lockedCurrency?: string | null;
  dunningCurrency?: string | null;
  subject?: CurrencySubject | null;
  env?: Env;
  warn?: Warn;
}): CheckoutDecision {
  const env = input.env || process.env;
  const warn = input.warn || defaultWarn;
  const locked = normaliseCurrencyCode(input.lockedCurrency);

  if (locked) {
    return {
      chargeCurrency: locked,
      lockedCurrency: locked,
      allowed: isChargeable(locked),
      reason: 'plan',
    };
  }
  if (normaliseCurrencyCode(input.dunningCurrency) === 'INR') {
    return { chargeCurrency: 'INR', lockedCurrency: null, allowed: true, reason: 'plan' };
  }

  const subject = input.subject || { country: null };
  const mode = usdCheckoutMode(env, warn);
  if (mode === 'allowlist' && onUsdAllowlist(subject, env)) {
    return { chargeCurrency: 'USD', lockedCurrency: null, allowed: true, reason: 'allowlist' };
  }
  const country = countryCode(subject.country);
  if (country === 'IN') {
    return { chargeCurrency: 'INR', lockedCurrency: null, allowed: true, reason: 'india' };
  }
  if (
    usdOnForEveryone(env, warn) &&
    !(country && excludedCountries(env, warn).has(country))
  ) {
    return { chargeCurrency: 'USD', lockedCurrency: null, allowed: true, reason: 'usd' };
  }
  return {
    chargeCurrency: SUBSCRIPTION_CURRENCY,
    lockedCurrency: null,
    allowed: true,
    reason: 'default',
  };
}

export interface PricingContext {
  /** Always equal to chargeCurrency; kept for pages that read this name. */
  displayCurrency: string;
  chargeCurrency: string;
  lockedCurrency: string | null;
  /** False when checkout would refuse with 409 CURRENCY_LOCKED. */
  checkoutAllowed: boolean;
  /** The request's own location signals, for the "paying from abroad" line. */
  region: Region;
  /** Monthly and yearly list prices of the paid tiers, in chargeCurrency. */
  prices: Record<PricedTier, { month: number; year: number }>;
  /**
   * The first-month offer's terms when checkout in chargeCurrency has one
   * (first.month.offer.ts), else null. Set by RazorpayService.getPricingContext,
   * which reads the offer ids; absent from older backends.
   */
  firstMonthOffer?: FirstMonthOfferTerms | null;
  /**
   * The single plan on sale, paid one month at a time (one.time.plan.ts),
   * in the currency its order charges: USD outside India, INR in India.
   * Set by RazorpayService.getPricingContext; absent from older backends.
   */
  oneTimePlan?: {
    name: string;
    tier: string;
    currency: string;
    price: number;
    label: string;
  };
}

function isPricedCurrency(code: string): code is SupportedCurrency {
  return Object.prototype.hasOwnProperty.call(PRICING_BY_CURRENCY, code);
}

/**
 * The body of GET /public/pricing-context and GET /billing/pricing-context:
 * the decision, with the list prices in the currency it charges.
 */
export function buildPricingContext(input: {
  decision: CheckoutDecision;
  region: Region;
}): PricingContext {
  const { decision } = input;
  const chargeCurrency = isPricedCurrency(decision.chargeCurrency)
    ? decision.chargeCurrency
    : SUBSCRIPTION_CURRENCY;
  const table = getPricing(chargeCurrency);
  const prices = {} as PricingContext['prices'];
  for (const tier of PRICED_TIERS) {
    prices[tier] = {
      month: table[tier].month_price,
      year: table[tier].year_price,
    };
  }
  return {
    displayCurrency: chargeCurrency,
    chargeCurrency,
    lockedCurrency: decision.lockedCurrency,
    checkoutAllowed: decision.allowed,
    region: input.region,
    prices,
  };
}
