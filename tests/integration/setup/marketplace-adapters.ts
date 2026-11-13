/**
 * Stand-ins for the other marketplaces' proxies, next to setup/marketplace.ts
 * (api.market): RapidAPI (X-RapidAPI-Proxy-Secret, X-RapidAPI-User,
 * X-RapidAPI-Subscription) and one keyed marketplace, "zyla"
 * (x-hookpost-marketplace + x-hookpost-marketplace-key, buyer and plan in
 * headers named in .env). Test values only; production secrets live in the
 * server's .env. Shared by the integration and E2E suites.
 */
import { randomBytes } from 'crypto';
import { Product } from './marketplace';

export const RAPIDAPI_SECRET: Record<Product, string> = {
  social: 'test-rapidapi-proxy-secret-social-0123456789',
  linkedin: 'test-rapidapi-proxy-secret-linkedin-0123456',
  x: 'test-rapidapi-proxy-secret-x-0123456789abcd',
  validate: 'test-rapidapi-proxy-secret-validate-012345',
};

export const ZYLA_SECRET: Record<Product, string> = {
  social: 'test-zyla-marketplace-key-social-0123456789ab',
  linkedin: 'test-zyla-marketplace-key-linkedin-0123456789',
  x: 'test-zyla-marketplace-key-x-0123456789abcdef01',
  validate: 'test-zyla-marketplace-key-validate-0123456789',
};

/** A keyed marketplace with no buyer header: it may sell the validator only. */
export const SHAREDHUB_SECRET = 'test-sharedhub-marketplace-key-0123456789abc';

/** The MKT_RAPIDAPI_* and MKT_KEYED_* variables the test backends run with. */
export function marketplaceAdaptersEnv(): Record<string, string> {
  return {
    MKT_RAPIDAPI_SECRETS_SOCIAL: RAPIDAPI_SECRET.social,
    MKT_RAPIDAPI_SECRETS_LINKEDIN: RAPIDAPI_SECRET.linkedin,
    MKT_RAPIDAPI_SECRETS_X: RAPIDAPI_SECRET.x,
    MKT_RAPIDAPI_SECRETS_VALIDATE: RAPIDAPI_SECRET.validate,
    MKT_RAPIDAPI_PLANS: '',
    MKT_RAPIDAPI_BILLING_OBJECT: '',
    MKT_KEYED_MARKETPLACES: 'zyla,sharedhub',
    MKT_KEYED_ZYLA_LABEL: 'Zyla API Hub',
    MKT_KEYED_ZYLA_SECRETS_SOCIAL: ZYLA_SECRET.social,
    MKT_KEYED_ZYLA_SECRETS_VALIDATE: ZYLA_SECRET.validate,
    MKT_KEYED_ZYLA_USER_HEADER: 'x-zyla-user',
    MKT_KEYED_ZYLA_PLAN_HEADER: 'x-zyla-plan',
    MKT_KEYED_ZYLA_PLANS: 'social:Basic=trial,social:Pro=standard,validate:Basic=trial,validate:Pro=starter',
    MKT_KEYED_ZYLA_BILLING_HEADER: 'x-zyla-units',
    MKT_KEYED_SHAREDHUB_LABEL: 'Shared Hub',
    MKT_KEYED_SHAREDHUB_SECRETS_VALIDATE: SHAREDHUB_SECRET,
    MKT_KEYED_SHAREDHUB_SECRETS_SOCIAL: SHAREDHUB_SECRET,
    MKT_KEYED_SHAREDHUB_DEFAULT_PLAN_VALIDATE: 'starter',
    MKT_KEYED_SHAREDHUB_DEFAULT_PLAN_SOCIAL: 'standard',
  };
}

/** A RapidAPI username. */
export const newRapidUser = () => `rapid_${randomBytes(5).toString('hex')}`;

export interface AdapterResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

interface Call {
  product: Product;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}

async function send<T>(baseUrl: string, call: Call, headers: Record<string, string>): Promise<AdapterResponse<T>> {
  for (const [k, v] of Object.entries(call.headers || {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  let body: string | undefined;
  if (call.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(call.body);
  }
  const res = await fetch(`${baseUrl}/mkt/v1/${call.product}${call.path}`, {
    method: call.method || (call.body !== undefined ? 'POST' : 'GET'),
    headers,
    body,
  });
  const text = await res.text();
  let parsed: any = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** Calls the backend the way RapidAPI's proxy forwards a subscriber's call. */
export class RapidGateway {
  constructor(readonly baseUrl: string) {}

  call<T = any>(c: Call & { user: string; subscription: string }) {
    return send<T>(this.baseUrl, c, {
      'x-rapidapi-proxy-secret': RAPIDAPI_SECRET[c.product],
      'x-rapidapi-user': c.user,
      'x-rapidapi-subscription': c.subscription,
      'x-rapidapi-version': '1.2.8',
      'x-rapidapi-host': `hookpost-${c.product}.p.rapidapi.com`,
    });
  }
}

/** Calls the backend the way a keyed marketplace ("zyla", or "sharedhub") forwards a call. */
export class KeyedGateway {
  constructor(readonly baseUrl: string) {}

  zyla<T = any>(c: Call & { user: string; plan: string }) {
    return send<T>(this.baseUrl, c, {
      'x-hookpost-marketplace': 'zyla',
      'x-hookpost-marketplace-key': ZYLA_SECRET[c.product],
      'x-zyla-user': c.user,
      'x-zyla-plan': c.plan,
    });
  }

  shared<T = any>(c: Call) {
    return send<T>(this.baseUrl, c, {
      'x-hookpost-marketplace': 'sharedhub',
      'x-hookpost-marketplace-key': SHAREDHUB_SECRET,
    });
  }
}
