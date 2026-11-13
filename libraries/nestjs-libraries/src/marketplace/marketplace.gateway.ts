/**
 * What the marketplace gateway trusts about a request, as pure functions:
 * the shared secret api.market sends, the plan token each plan adds, and the
 * subscriber id api.market sets. Secrets are compared as SHA-256 digests with
 * crypto.timingSafeEqual, every configured secret every time, so neither the
 * secret's length nor which one matched shows in the response time. Nothing
 * here returns or logs a value; callers log the matched index only.
 */
import { createHash, timingSafeEqual } from 'crypto';
import {
  isMarketplaceProduct,
  MARKETPLACE_PRODUCTS,
  marketplacePlan,
  MarketplacePlan,
  MarketplaceProduct,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

type Env = Record<string, string | undefined>;

/** The header the api.market Source sends our shared secret in (API Key auth). */
export const GATEWAY_HEADER = 'x-hookpost-gateway';
/** The custom header each pricing plan adds: a random token naming the tier. */
export const PLAN_HEADER = 'x-hookpost-plan';
/** api.market's subscriber id and plan name (seller docs). */
export const SUBSCRIBER_HEADER = 'x-magicapi-user';
export const MAGICAPI_PLAN_HEADER = 'x-magicapi-plan';
export const REQUEST_ID_HEADER = 'x-request-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** The usage header api.market bills from. */
export const BILLING_HEADER = 'X-Magicapi-Billing';

/**
 * Redis marker of an OAuth connect a marketplace subscriber started; the
 * callback (no.auth.integrations.controller.ts) then answers `marketplace:
 * true` and the page ends on "connected, close this tab".
 */
export const MARKETPLACE_CONNECT_KEY = (state: string) => `mkt:connect:${state}`;

/** RapidAPI's per-API proxy secret (marketplace.adapters.ts). */
export const RAPIDAPI_SECRET_HEADER = 'x-rapidapi-proxy-secret';
/** The key a keyed marketplace sends (marketplace.adapters.ts). */
export const KEYED_SECRET_HEADER = 'x-hookpost-marketplace-key';

/** Headers Sentry and our logs must never carry: every marketplace's secret. */
export const SECRET_HEADERS = [
  GATEWAY_HEADER,
  PLAN_HEADER,
  RAPIDAPI_SECRET_HEADER,
  KEYED_SECRET_HEADER,
] as const;

/** A shared secret shorter than this is treated as not configured. */
export const MIN_SECRET_LENGTH = 32;

/** api.market's subscriber ids are cuids: lowercase letters and digits. */
export const SUBSCRIBER_ID = /^[a-z0-9]{20,40}$/;

export const sha256Hex = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/** MKT_GATEWAY_SECRETS_<PRODUCT>, e.g. MKT_GATEWAY_SECRETS_SOCIAL. */
export const gatewaySecretsEnv = (product: MarketplaceProduct) =>
  `MKT_GATEWAY_SECRETS_${product.toUpperCase()}`;

/**
 * The product's shared secrets: a comma list, current first and the next one
 * during a rotation. Entries shorter than MIN_SECRET_LENGTH are dropped, so
 * a typo or a placeholder never opens the gateway.
 */
export function gatewaySecrets(product: MarketplaceProduct, env: Env = process.env): string[] {
  return (env[gatewaySecretsEnv(product)] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SECRET_LENGTH);
}

/** Any product has a usable gateway secret: the marketplace is on here. */
export function marketplaceEnabled(env: Env = process.env): boolean {
  return MARKETPLACE_PRODUCTS.some((p) => gatewaySecrets(p, env).length > 0);
}

/**
 * Index of the configured secret `presented` equals, or -1. Compares against
 * every secret (no early exit), over fixed-length digests.
 */
export function matchGatewaySecret(presented: unknown, secrets: string[]): number {
  if (typeof presented !== 'string' || !presented || !secrets.length) {
    // Still spend one comparison, so a missing header looks like a wrong one.
    timingSafeEqual(sha256('x'), sha256('y'));
    return -1;
  }
  const given = sha256(presented);
  let found = -1;
  secrets.forEach((secret, i) => {
    const equal = timingSafeEqual(given, sha256(secret));
    if (equal && found === -1) found = i;
  });
  return found;
}

export interface PlanTokenEntry {
  product: MarketplaceProduct;
  plan: string;
}

/**
 * MKT_PLAN_TOKEN_HASHES: `<sha256 of the token>=<product>:<plan>`, comma
 * separated. Only hashes live in .env; the tokens themselves only in
 * api.market's plan settings. Entries naming an unknown plan are dropped.
 */
export function planTokenTable(env: Env = process.env): Map<string, PlanTokenEntry> {
  const table = new Map<string, PlanTokenEntry>();
  for (const raw of (env.MKT_PLAN_TOKEN_HASHES || '').split(',')) {
    const entry = raw.trim();
    const eq = entry.indexOf('=');
    if (eq < 0) continue;
    const hash = entry.slice(0, eq).trim().toLowerCase();
    const [product, plan] = entry.slice(eq + 1).trim().split(':');
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    if (!isMarketplaceProduct(product) || !marketplacePlan(product, plan)) continue;
    table.set(hash, { product, plan });
  }
  return table;
}

/** The plan a token names, or null when it names none (or another product's). */
export function resolvePlanToken(
  token: unknown,
  product: MarketplaceProduct,
  env: Env = process.env
): MarketplacePlan | null {
  if (typeof token !== 'string' || token.length < 16 || token.length > 512) return null;
  const entry = planTokenTable(env).get(sha256Hex(token));
  if (!entry || entry.product !== product) return null;
  return marketplacePlan(entry.product, entry.plan);
}

/**
 * api.market's own plan name (x-magicapi-plan, the plan's title in the seller
 * dashboard) to our plan, per product. api.market sets the header itself on
 * every forwarded call, so once the gateway secret has proved the call came
 * through api.market the plans need no custom header. Only the names listed
 * here are accepted: any other plan (such as "Starter") or a renamed one is
 * refused with 403 unless it sends a plan token. Names are compared case- and
 * whitespace-insensitively (normalizePlanName).
 *
 * "Tester" is api.market's private plan for its review team (support, 26 Oct
 * 2026): reviewers get Pro limits so they can try everything. Social only.
 *
 * "Free" is what api.market calls a free plan (support, 26 Oct 2026); the
 * Social "Free trial" plan is being renamed to it. "Free trial" stays until
 * the rename is live everywhere, then can go.
 */
export const MAGICAPI_PLAN_NAMES: Readonly<
  Partial<Record<MarketplaceProduct, Readonly<Record<string, string>>>>
> = {
  social: {
    'free trial': 'trial',
    free: 'trial',
    standard: 'standard',
    pro: 'pro',
    tester: 'pro',
  },
};

/** Longest x-magicapi-plan value read; anything longer names no plan. */
export const MAX_PLAN_NAME_LENGTH = 64;

/**
 * A plan name as compared: trimmed, inner whitespace runs (spaces, tabs,
 * non-breaking spaces) to one space, lower case. So "Free trial",
 * " FREE  TRIAL " and "Free" + NBSP + "Trial" are the same plan. No Unicode
 * folding: look-alike letters name no plan.
 */
export const normalizePlanName = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The plan api.market's plan name (x-magicapi-plan) stands for on this
 * product, or null. Trust it only after matchGatewaySecret has accepted the
 * call: without the secret anyone can send this header.
 */
export function resolveMagicapiPlan(
  name: unknown,
  product: MarketplaceProduct
): MarketplacePlan | null {
  if (typeof name !== 'string' || !name || name.length > MAX_PLAN_NAME_LENGTH) return null;
  const names = MAGICAPI_PLAN_NAMES[product];
  if (!names) return null;
  const key = normalizePlanName(name);
  if (!Object.prototype.hasOwnProperty.call(names, key)) return null;
  return marketplacePlan(product, names[key]);
}

/**
 * The call's plan, once the gateway secret matched. A plan token that
 * resolves wins (it can only come from a plan's custom headers, never from a
 * buyer); otherwise api.market's plan name. Null names no plan (403).
 */
export function resolveCallPlan(
  headers: { planToken?: string; magicapiPlan?: string },
  product: MarketplaceProduct,
  env: Env = process.env
): { plan: MarketplacePlan; source: 'plan_token' | 'magicapi_plan' } | null {
  const byToken = headers.planToken ? resolvePlanToken(headers.planToken, product, env) : null;
  if (byToken) return { plan: byToken, source: 'plan_token' };
  const byName = resolveMagicapiPlan(headers.magicapiPlan, product);
  if (byName) return { plan: byName, source: 'magicapi_plan' };
  return null;
}

/** A header's single value: a repeated header (an array) is refused as missing. */
export function singleHeader(value: unknown): string | undefined {
  if (Array.isArray(value)) return undefined;
  return typeof value === 'string' ? value : undefined;
}

export function validSubscriberId(value: unknown): value is string {
  return typeof value === 'string' && SUBSCRIBER_ID.test(value);
}

/** A short, stable, non-reversible tag for a subscriber in logs and names. */
export const subscriberTag = (externalUserId: string) => sha256Hex(externalUserId).slice(0, 8);

/** The header value api.market reads: API=N; (seller-docs/custom-usage). */
export const billingValue = (credits: number) =>
  `API=${Math.max(0, Math.floor(Number.isFinite(credits) ? credits : 0))};`;

/**
 * Drops the gateway secret and plan token from a Sentry event's request
 * headers (api.market sends both on every call). Returns the event.
 */
export function scrubSecretHeaders<T extends { request?: { headers?: Record<string, unknown> } }>(
  event: T
): T {
  const headers = event?.request?.headers;
  if (headers && typeof headers === 'object') {
    for (const key of Object.keys(headers)) {
      if ((SECRET_HEADERS as readonly string[]).includes(key.toLowerCase())) {
        headers[key] = '[Filtered]';
      }
    }
  }
  return event;
}
