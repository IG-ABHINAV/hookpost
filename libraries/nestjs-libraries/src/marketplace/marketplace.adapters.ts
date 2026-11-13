/**
 * The API marketplaces that resell Hookpost's products, one adapter each,
 * behind one gateway (apps/backend/src/marketplace-api). An adapter answers
 * the three things that differ between marketplaces; everything else (plans
 * and limits, workspaces, quotas, idempotency, publishing) is the shared core.
 *
 *  1. How the marketplace proves a call came through it: a shared secret in
 *     a header only that marketplace's proxy adds (api.market: the Source's
 *     x-hookpost-gateway; RapidAPI: X-RapidAPI-Proxy-Secret; any other
 *     marketplace: x-hookpost-marketplace-key next to x-hookpost-marketplace).
 *  2. Who the subscriber is and which plan they bought (api.market:
 *     x-magicapi-user and a plan token or x-magicapi-plan; RapidAPI:
 *     X-RapidAPI-User and X-RapidAPI-Subscription; others: headers named in
 *     .env), mapped onto marketplace.plans.ts. Only read after (1) passed.
 *  3. How it wants usage reported (api.market: X-Magicapi-Billing: API=N;
 *     RapidAPI: X-RapidAPI-Billing: <object>=N; others: an optional header).
 *
 * A call is handled by exactly the one adapter whose marker header it
 * carries; a call that carries two marketplaces' markers is refused, so one
 * marketplace's buyer can never be read as another's.
 *
 * Pure: no Nest, Prisma or Redis, so the specs read the same code.
 */
import {
  gatewaySecrets,
  GATEWAY_HEADER,
  BILLING_HEADER,
  KEYED_SECRET_HEADER,
  RAPIDAPI_SECRET_HEADER,
  billingValue,
  MAGICAPI_PLAN_HEADER,
  matchGatewaySecret,
  normalizePlanName,
  PLAN_HEADER,
  REQUEST_ID_HEADER,
  resolveCallPlan,
  resolveMagicapiPlan,
  singleHeader,
  SUBSCRIBER_HEADER,
  validSubscriberId,
  MAX_PLAN_NAME_LENGTH,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import {
  API_MARKET,
  isMarketplaceProduct,
  MARKETPLACE_PRODUCTS,
  marketplaceIdentifier,
  marketplacePlan,
  MarketplacePlan,
  MarketplaceProduct,
  plansOf,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

type Env = Record<string, string | undefined>;
type Headers = Record<string, unknown>;

/** MarketplaceAccount.marketplace and Organization.source of RapidAPI subscribers. */
export const RAPIDAPI = 'RAPIDAPI';
/** Organization.source of a workspace that signed up on hookpost.hookstep.in. */
export const DIRECT_SOURCE = 'DIRECT';

export { KEYED_SECRET_HEADER, RAPIDAPI_SECRET_HEADER };
export const RAPIDAPI_USER_HEADER = 'x-rapidapi-user';
export const RAPIDAPI_SUBSCRIPTION_HEADER = 'x-rapidapi-subscription';
export const RAPIDAPI_BILLING_HEADER = 'X-RapidAPI-Billing';

/** A keyed marketplace names itself in this header and sends its key in KEYED_SECRET_HEADER. */
export const KEYED_NAME_HEADER = 'x-hookpost-marketplace';

/** Why an adapter refused a call after its secret matched. */
export interface AdapterRefusal {
  status: number;
  error: string;
  message: string;
  /** For the log line: a reason code, never a header value. */
  reason: string;
}

export interface AdapterIdentity {
  subscriber: string;
  plan: MarketplacePlan;
  /** Where the plan came from, for the log (plan_token, magicapi_plan, subscription, default). */
  planSource: string;
  /** The one subscriber of a marketplace that sends no buyer id: every buyer at once. */
  shared?: boolean;
  /** A settings slip worth a log line (plan token and plan name disagree): its kind, then its details. */
  warning?: { kind: string; detail: string };
}

export interface MarketplaceAdapter {
  /** MarketplaceAccount.marketplace and Organization.source: API_MARKET, RAPIDAPI, or a keyed name upper-cased. */
  readonly id: string;
  /** The scope of its secret-hit counters (mkt:secrethits:<scope>:...), for rotations. */
  secretHitScope(product: MarketplaceProduct): string;
  /** How the admin page and the messages name it. */
  readonly label: string;
  /** The call carries this marketplace's marker header (not yet proof). */
  claims(headers: Headers): boolean;
  /** The product's secrets for this marketplace (empty: the product is not sold there). */
  secrets(product: MarketplaceProduct, env?: Env): string[];
  /** Index of the secret the call presents, or -1. Constant time over every secret. */
  matchSecret(headers: Headers, product: MarketplaceProduct, env?: Env): number;
  /** Subscriber and plan, read only after matchSecret accepted the call. */
  identify(
    headers: Headers,
    product: MarketplaceProduct,
    env?: Env
  ): AdapterIdentity | AdapterRefusal;
  /** The response headers that report `credits` of usage (0 on anything not billed). */
  billingHeaders(credits: number, env?: Env): Record<string, string>;
  /** The marketplace's own retry id, when it sets one the buyer cannot. */
  requestId(headers: Headers): string | undefined;
  /** The subscriber as it appears in Redis keys: unique across marketplaces. */
  subscriberKey(subscriber: string): string;
  /** Subscription.identifier of the subscriber's workspace (always starts apimkt:). */
  identifier(product: MarketplaceProduct, subscriber: string): string;
  /** The workspace's name, from the subscriber's hash tag. */
  workspaceName(tag: string): string;
  /** The 401 a caller without this marketplace's secret gets. */
  readonly unauthorizedMessage: string;
  /** The 400 for a buyer who sent an Authorization header. */
  readonly authorizationMessage: string;
  /** Only api.market has the launch probe (/_probe). */
  readonly probe: boolean;
}

export const isRefusal = (r: AdapterIdentity | AdapterRefusal): r is AdapterRefusal =>
  (r as AdapterRefusal).status !== undefined;

const refusal = (status: number, error: string, message: string, reason: string): AdapterRefusal => ({
  status,
  error,
  message,
  reason,
});

/** A marketplace's plan name as it may appear in a log line: short, no control characters. */
const safePlanName = (name?: string) =>
  name ? JSON.stringify(name.slice(0, 40).replace(/[^\w .-]/g, '?')) : 'none';

const credit = (credits: number) =>
  Math.max(0, Math.floor(Number.isFinite(credits) ? credits : 0));

/** A plan's index in its product: 0 is the trial, then the paid plans cheapest first. */
const planAt = (product: MarketplaceProduct, index: number): MarketplacePlan | null => {
  const plans = plansOf(product);
  return plans[Math.min(index, plans.length - 1)] ?? null;
};

/**
 * `<product>:<marketplace plan name>=<our plan>` pairs, comma separated, the
 * names compared as normalizePlanName does. Entries naming an unknown
 * product or plan are dropped.
 */
export function planNameTable(raw: string | undefined): Map<string, MarketplacePlan> {
  const table = new Map<string, MarketplacePlan>();
  for (const entry of (raw || '').split(',')) {
    const eq = entry.lastIndexOf('=');
    const colon = entry.indexOf(':');
    if (eq < 0 || colon < 0 || colon > eq) continue;
    const product = entry.slice(0, colon).trim().toLowerCase();
    const name = normalizePlanName(entry.slice(colon + 1, eq));
    const plan = marketplacePlan(product, entry.slice(eq + 1).trim().toLowerCase());
    if (!isMarketplaceProduct(product) || !name || !plan) continue;
    table.set(`${product}:${name}`, plan);
  }
  return table;
}

const lookupPlanName = (
  table: Map<string, MarketplacePlan>,
  product: MarketplaceProduct,
  name: unknown
): MarketplacePlan | null => {
  if (typeof name !== 'string' || !name || name.length > MAX_PLAN_NAME_LENGTH) return null;
  return table.get(`${product}:${normalizePlanName(name)}`) ?? null;
};

// ---------------------------------------------------------------------------
// api.market (unchanged behaviour: the gateway before adapters, byte for byte)
// ---------------------------------------------------------------------------

export const apiMarketAdapter: MarketplaceAdapter = {
  id: API_MARKET,
  label: 'api.market',
  // The keys it had before adapters.
  secretHitScope: (product) => product,
  claims: (headers) => headers[GATEWAY_HEADER] !== undefined,
  secrets: (product, env = process.env) => gatewaySecrets(product, env),
  matchSecret: (headers, product, env = process.env) =>
    matchGatewaySecret(singleHeader(headers[GATEWAY_HEADER]), gatewaySecrets(product, env)),
  identify(headers, product, env = process.env) {
    const magicPlan = singleHeader(headers[MAGICAPI_PLAN_HEADER]);
    const resolved = resolveCallPlan(
      { planToken: singleHeader(headers[PLAN_HEADER]), magicapiPlan: magicPlan },
      product,
      env
    );
    if (!resolved) {
      return refusal(
        403,
        'unknown_plan',
        'This plan is not set up for this API.',
        `unknown_plan x-magicapi-plan=${safePlanName(magicPlan)}`
      );
    }
    const subscriber = singleHeader(headers[SUBSCRIBER_HEADER]);
    if (!validSubscriberId(subscriber)) {
      return refusal(400, 'invalid_subscriber', 'The call has no valid api.market subscriber.', 'subscriber_id');
    }
    let warning: AdapterIdentity['warning'];
    if (resolved.source === 'magicapi_plan' && headers[PLAN_HEADER] !== undefined) {
      // A plan token was sent but names nothing here (revoked, mistyped,
      // another product's): the plan name decided. Never log the token.
      warning = { kind: 'plan_token_unknown', detail: `plan=${resolved.plan.plan}` };
    } else if (resolved.source === 'plan_token' && magicPlan) {
      const named = resolveMagicapiPlan(magicPlan, product);
      if (named && named.plan !== resolved.plan.plan) {
        // A cross-check only: the token wins, the mismatch is a settings slip.
        warning = {
          kind: 'plan mismatch',
          detail: `token=${resolved.plan.plan} x-magicapi-plan=${safePlanName(magicPlan)}`,
        };
      }
    }
    return { subscriber, plan: resolved.plan, planSource: resolved.source, warning };
  },
  billingHeaders: (credits) => ({ [BILLING_HEADER]: billingValue(credits) }),
  requestId: (headers) => singleHeader(headers[REQUEST_ID_HEADER]),
  subscriberKey: (subscriber) => subscriber,
  identifier: (product, subscriber) => marketplaceIdentifier(product, subscriber),
  workspaceName: (tag) => `api.market subscriber ${tag}`,
  unauthorizedMessage: 'Call this API through api.market.',
  authorizationMessage:
    'Do not send an Authorization header. api.market authenticates you with your x-api-market-key; a Hookpost API key is never needed here.',
  probe: true,
};

// ---------------------------------------------------------------------------
// RapidAPI
// ---------------------------------------------------------------------------

/** RapidAPI's proxy secret is its own random value; shorter than this is not one. */
export const RAPIDAPI_MIN_SECRET_LENGTH = 24;

/** RapidAPI usernames: letters, digits, dot, underscore, hyphen. */
export const RAPIDAPI_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * X-RapidAPI-Subscription to our plan when MKT_RAPIDAPI_PLANS says nothing
 * for the product: BASIC (RapidAPI's free tier) is the trial, PRO the first
 * paid plan, ULTRA and MEGA the top one. CUSTOM is refused until mapped.
 */
const RAPIDAPI_DEFAULT_TIERS: Record<string, number> = { basic: 0, pro: 1, ultra: 2, mega: 2 };

export const rapidApiSecretsEnv = (product: MarketplaceProduct) =>
  `MKT_RAPIDAPI_SECRETS_${product.toUpperCase()}`;

export function rapidApiSecrets(product: MarketplaceProduct, env: Env = process.env): string[] {
  return (env[rapidApiSecretsEnv(product)] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= RAPIDAPI_MIN_SECRET_LENGTH);
}

/** The plan X-RapidAPI-Subscription stands for on this product, or null. */
export function rapidApiPlan(
  subscription: unknown,
  product: MarketplaceProduct,
  env: Env = process.env
): MarketplacePlan | null {
  if (typeof subscription !== 'string' || !subscription || subscription.length > MAX_PLAN_NAME_LENGTH) {
    return null;
  }
  const table = planNameTable(env.MKT_RAPIDAPI_PLANS);
  const productMapped = [...table.keys()].some((k) => k.startsWith(`${product}:`));
  if (productMapped) return lookupPlanName(table, product, subscription);
  const tier = RAPIDAPI_DEFAULT_TIERS[normalizePlanName(subscription)];
  return tier === undefined ? null : planAt(product, tier);
}

export const rapidApiAdapter: MarketplaceAdapter = {
  id: RAPIDAPI,
  label: 'RapidAPI',
  secretHitScope: (product) => `${RAPIDAPI}:${product}`,
  claims: (headers) => headers[RAPIDAPI_SECRET_HEADER] !== undefined,
  secrets: (product, env = process.env) => rapidApiSecrets(product, env),
  matchSecret: (headers, product, env = process.env) =>
    matchGatewaySecret(singleHeader(headers[RAPIDAPI_SECRET_HEADER]), rapidApiSecrets(product, env)),
  identify(headers, product, env = process.env) {
    const plan = rapidApiPlan(singleHeader(headers[RAPIDAPI_SUBSCRIPTION_HEADER]), product, env);
    if (!plan) {
      return refusal(403, 'unknown_plan', 'This plan is not set up for this API.', 'unknown_plan');
    }
    const subscriber = singleHeader(headers[RAPIDAPI_USER_HEADER]);
    if (!subscriber || !RAPIDAPI_USER.test(subscriber)) {
      return refusal(400, 'invalid_subscriber', 'The call has no valid RapidAPI user.', 'subscriber_id');
    }
    return { subscriber, plan, planSource: 'subscription' };
  },
  billingHeaders: (credits, env = process.env) => ({
    [RAPIDAPI_BILLING_HEADER]: `${rapidApiBillingObject(env)}=${credit(credits)}`,
  }),
  // RapidAPI sets no retry id of its own; a buyer's x-request-id is not trusted.
  requestId: () => undefined,
  subscriberKey: (subscriber) => `rapidapi:${subscriber}`,
  identifier: (product, subscriber) => marketplaceIdentifier(product, `rapidapi:${subscriber}`),
  workspaceName: (tag) => `RapidAPI subscriber ${tag}`,
  unauthorizedMessage: 'Call this API through RapidAPI.',
  authorizationMessage:
    'Do not send an Authorization header. RapidAPI authenticates you with your X-RapidAPI-Key; a Hookpost API key is never needed here.',
  probe: false,
};

/** The custom quota object the RapidAPI plans count credits in (MKT_RAPIDAPI_BILLING_OBJECT). */
export function rapidApiBillingObject(env: Env = process.env): string {
  const name = (env.MKT_RAPIDAPI_BILLING_OBJECT || '').trim();
  // RapidAPI refuses a header whose object name has special characters.
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name) ? name : 'Credits';
}

// ---------------------------------------------------------------------------
// Any other marketplace: one key per marketplace (and product)
// ---------------------------------------------------------------------------

/** A keyed marketplace's name in MKT_KEYED_MARKETPLACES. */
export const KEYED_NAME = /^[a-z][a-z0-9]{1,19}$/;
export const KEYED_MIN_SECRET_LENGTH = 32;
/**
 * A keyed marketplace's subscriber id: letters, digits and . _ @ -. Never a
 * colon: the id is a segment of colon-joined Redis keys, so "u1" + key
 * "x:abc" and "u1:x" + key "abc" must not meet.
 */
export const KEYED_USER = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
/** The one subscriber of a keyed marketplace that sends no subscriber header. */
export const SHARED_SUBSCRIBER = 'shared';

/** Products that keep no channels or posts: the only ones a marketplace without per-buyer ids may sell. */
export const STATELESS_PRODUCTS: readonly MarketplaceProduct[] = ['validate'];

const headerName = (value: string | undefined) => {
  const name = (value || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,63}$/.test(name) ? name : undefined;
};

export interface KeyedConfig {
  name: string;
  id: string;
  label: string;
  userHeader?: string;
  planHeader?: string;
  billingHeader?: string;
}

/**
 * MKT_KEYED_MARKETPLACES=zyla,apilayer and, per name (upper-cased):
 *   MKT_KEYED_<NAME>_SECRETS_<PRODUCT>   the key it sends (comma list, rotation)
 *   MKT_KEYED_<NAME>_LABEL               shown on the admin page
 *   MKT_KEYED_<NAME>_USER_HEADER         the header naming the buyer
 *   MKT_KEYED_<NAME>_PLAN_HEADER         the header naming the buyer's plan
 *   MKT_KEYED_<NAME>_PLANS               <product>:<their plan>=<our plan>,...
 *   MKT_KEYED_<NAME>_DEFAULT_PLAN_<PRODUCT>  the plan when no plan header is set
 *   MKT_KEYED_<NAME>_BILLING_HEADER      a response header carrying the credits
 * Names that collide with a built-in id (API_MARKET, RAPIDAPI, DIRECT, UNKNOWN) are dropped.
 */
export function keyedConfigs(env: Env = process.env): KeyedConfig[] {
  const seen = new Set<string>();
  const out: KeyedConfig[] = [];
  for (const raw of (env.MKT_KEYED_MARKETPLACES || '').split(',')) {
    const name = raw.trim().toLowerCase();
    if (!KEYED_NAME.test(name) || seen.has(name)) continue;
    const id = name.toUpperCase();
    // Never an id that already means something: the built-ins, a direct
    // sign-up, or the usage counters' "no marketplace" row.
    if ([API_MARKET, RAPIDAPI, DIRECT_SOURCE, 'APIMARKET', 'UNKNOWN'].includes(id)) continue;
    seen.add(name);
    const key = (suffix: string) => env[`MKT_KEYED_${id}_${suffix}`];
    out.push({
      name,
      id,
      label: (key('LABEL') || name).trim().slice(0, 40) || name,
      userHeader: headerName(key('USER_HEADER')),
      planHeader: headerName(key('PLAN_HEADER')),
      billingHeader: headerName(key('BILLING_HEADER')),
    });
  }
  return out;
}

export function keyedSecrets(
  config: KeyedConfig,
  product: MarketplaceProduct,
  env: Env = process.env
): string[] {
  return (env[`MKT_KEYED_${config.id}_SECRETS_${product.toUpperCase()}`] || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length >= KEYED_MIN_SECRET_LENGTH);
}

export function keyedAdapter(config: KeyedConfig): MarketplaceAdapter {
  return {
    id: config.id,
    label: config.label,
    secretHitScope: (product) => `${config.id}:${product}`,
    claims: (headers) => {
      const named = singleHeader(headers[KEYED_NAME_HEADER]);
      return typeof named === 'string' && named.trim().toLowerCase() === config.name;
    },
    secrets: (product, env = process.env) => keyedSecrets(config, product, env),
    matchSecret: (headers, product, env = process.env) =>
      matchGatewaySecret(singleHeader(headers[KEYED_SECRET_HEADER]), keyedSecrets(config, product, env)),
    identify(headers, product, env = process.env) {
      let plan: MarketplacePlan | null;
      let planSource: string;
      // Without a buyer id every call is the one shared subscriber, whose
      // plan must not flip per call (each change restarts its quota window):
      // the plan header is read only next to a buyer header.
      if (config.planHeader && config.userHeader) {
        plan = lookupPlanName(
          planNameTable(env[`MKT_KEYED_${config.id}_PLANS`]),
          product,
          singleHeader(headers[config.planHeader])
        );
        planSource = 'plan_header';
      } else {
        plan = marketplacePlan(
          product,
          (env[`MKT_KEYED_${config.id}_DEFAULT_PLAN_${product.toUpperCase()}`] || '').trim().toLowerCase()
        );
        planSource = 'default';
      }
      if (!plan) {
        return refusal(403, 'unknown_plan', 'This plan is not set up for this API.', 'unknown_plan');
      }
      if (!config.userHeader) {
        // No per-buyer id: every buyer would share one workspace, so only a
        // product that keeps nothing (the validator) may be sold this way,
        // and its one quota, rate limit and credit window are the whole
        // marketplace's (the middleware also ignores Idempotency-Key here).
        if (!STATELESS_PRODUCTS.includes(product)) {
          return refusal(400, 'invalid_subscriber', `The call has no valid ${config.label} subscriber.`, 'no_user_header');
        }
        return { subscriber: SHARED_SUBSCRIBER, plan, planSource, shared: true };
      }
      const subscriber = singleHeader(headers[config.userHeader]);
      if (!subscriber || !KEYED_USER.test(subscriber)) {
        return refusal(400, 'invalid_subscriber', `The call has no valid ${config.label} subscriber.`, 'subscriber_id');
      }
      return { subscriber, plan, planSource };
    },
    billingHeaders: (credits) =>
      config.billingHeader ? { [config.billingHeader]: String(credit(credits)) } : {},
    requestId: () => undefined,
    subscriberKey: (subscriber) => `${config.name}:${subscriber}`,
    identifier: (product, subscriber) => marketplaceIdentifier(product, `${config.name}:${subscriber}`),
    workspaceName: (tag) => `${config.label} subscriber ${tag}`,
    unauthorizedMessage: `Call this API through ${config.label}.`,
    authorizationMessage: `Do not send an Authorization header. ${config.label} authenticates you; a Hookpost API key is never needed here.`,
    probe: false,
  };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** Every marketplace this backend knows: api.market, RapidAPI, then the keyed ones in .env. */
export function marketplaceAdapters(env: Env = process.env): MarketplaceAdapter[] {
  return [apiMarketAdapter, rapidApiAdapter, ...keyedConfigs(env).map(keyedAdapter)];
}

/** The adapter with this id, or null (an id from the database whose marketplace left .env). */
export function adapterById(id: string, env: Env = process.env): MarketplaceAdapter | null {
  return marketplaceAdapters(env).find((a) => a.id === id) ?? null;
}

/** How the admin page names a source: DIRECT, a known marketplace, or the stored id. */
export function sourceLabel(id: string, env: Env = process.env): string {
  if (id === DIRECT_SOURCE) return 'Direct (hookpost.hookstep.in)';
  return adapterById(id, env)?.label ?? id;
}

/**
 * The marketplace a call that names none is answered as (401 "Call this API
 * through api.market.", X-Magicapi-Billing: API=0;), as before there were
 * adapters.
 */
export const DEFAULT_ADAPTER: MarketplaceAdapter = apiMarketAdapter;

export type AdapterPick =
  | { kind: 'one'; adapter: MarketplaceAdapter }
  | { kind: 'none' }
  | { kind: 'several'; ids: string[] };

/** The one marketplace whose marker the call carries. */
export function pickAdapter(headers: Headers, env: Env = process.env): AdapterPick {
  const claiming = marketplaceAdapters(env).filter((a) => a.claims(headers));
  if (claiming.length === 1) return { kind: 'one', adapter: claiming[0] };
  if (!claiming.length) return { kind: 'none' };
  return { kind: 'several', ids: claiming.map((a) => a.id) };
}

/** The marketplace sells at least one product here (any secret set). */
export function adapterConfigured(adapter: MarketplaceAdapter, env: Env = process.env): boolean {
  return MARKETPLACE_PRODUCTS.some((p) => adapter.secrets(p, env).length > 0);
}

/**
 * Any marketplace sells anything here: the orchestrator then reads the plan
 * row of every workspace it publishes for, so a marketplace workspace is held
 * to its marketplace plan (SubscriptionService.publishWithinPlan).
 */
export function anyMarketplaceEnabled(env: Env = process.env): boolean {
  return marketplaceAdapters(env).some((a) => adapterConfigured(a, env));
}
