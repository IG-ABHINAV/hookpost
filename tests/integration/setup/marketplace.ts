/**
 * A stand-in for api.market's gateway, shared by the integration and E2E
 * suites: the secrets and plan tokens the test backend is configured with,
 * and a client that sends what api.market adds to every forwarded call
 * (x-hookpost-gateway from the Source's API-key auth, x-hookpost-plan from
 * the plan's custom headers where a plan still has one, x-magicapi-user,
 * x-magicapi-plan, x-request-id). Pass `'x-hookpost-plan': undefined` to
 * call the way a plan without custom headers does.
 * Test values only; production secrets live in the server's .env.
 */
import { createHash, randomBytes } from 'crypto';
// Relative, not the @hookpost alias: the E2E specs (Playwright) import this too.
import { MARKETPLACE_PLANS } from '../../../libraries/nestjs-libraries/src/marketplace/marketplace.plans';

export type Product = 'social' | 'linkedin' | 'x' | 'validate';

export const GATEWAY_SECRET: Record<Product, string> = {
  social: 'test-gateway-secret-social-0123456789abcdef',
  linkedin: 'test-gateway-secret-linkedin-0123456789abcdef',
  x: 'test-gateway-secret-x-0123456789abcdef0123',
  validate: 'test-gateway-secret-validate-0123456789abcdef',
};
/** The second secret of a rotation (social only). */
export const NEXT_GATEWAY_SECRET_SOCIAL = 'test-gateway-secret-social-next-0123456789ab';

export const planToken = (product: string, plan: string) =>
  `test-plan-token-${product}-${plan}-0123456789abcdef`;

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

/** The MKT_* variables the test backends run with. */
export function marketplaceEnv(): Record<string, string> {
  return {
    MKT_GATEWAY_SECRETS_SOCIAL: `${GATEWAY_SECRET.social},${NEXT_GATEWAY_SECRET_SOCIAL}`,
    MKT_GATEWAY_SECRETS_LINKEDIN: GATEWAY_SECRET.linkedin,
    MKT_GATEWAY_SECRETS_X: GATEWAY_SECRET.x,
    MKT_GATEWAY_SECRETS_VALIDATE: GATEWAY_SECRET.validate,
    MKT_PLAN_TOKEN_HASHES: Object.values(MARKETPLACE_PLANS)
      .map((p) => `${sha(planToken(p.product, p.plan))}=${p.product}:${p.plan}`)
      .join(','),
    MKT_DISABLED_PRODUCTS: '',
    MKT_TRIAL_X_DAILY_USD: '',
    // High enough that only the rate-limit test reaches them.
    MKT_RATE_WRITE_PER_SEC: '200',
    MKT_RATE_READ_PER_SEC: '200',
  };
}

/**
 * A Discord server the E2E backend's stubbed GET /channels/{id} knows, with
 * its one channel; every other channel id answers as another server's.
 */
export const E2E_DISCORD_SERVER = '1100000000000000001';
export const E2E_DISCORD_CHANNELS = ['1200000000000000002'];

/** A new api.market subscriber id (a cuid's shape). */
export const newSubscriber = () => `c${randomBytes(12).toString('hex')}`.slice(0, 25);

export interface GatewayResponse<T = any> {
  status: number;
  body: T;
  billing: string | null;
  headers: Headers;
}

export interface GatewayCall {
  product: Product;
  plan: string;
  user: string;
  method?: string;
  path: string;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string | undefined>;
  /** x-request-id; a fresh one per call unless given. */
  requestId?: string;
}

/** The plan's title on api.market, which it forwards as x-magicapi-plan. */
export const magicapiPlanName = (plan: string) =>
  plan === 'trial' ? 'Free trial' : plan.charAt(0).toUpperCase() + plan.slice(1);

/** Calls the backend the way api.market forwards a subscriber's call. */
export class Gateway {
  constructor(readonly baseUrl: string) {}

  headers(call: Pick<GatewayCall, 'product' | 'plan' | 'user' | 'requestId' | 'headers'>) {
    const headers: Record<string, string> = {
      'x-hookpost-gateway': GATEWAY_SECRET[call.product],
      'x-hookpost-plan': planToken(call.product, call.plan),
      'x-magicapi-user': call.user,
      'x-magicapi-plan': magicapiPlanName(call.plan),
      'x-request-id': call.requestId ?? randomBytes(8).toString('hex'),
    };
    for (const [k, v] of Object.entries(call.headers || {})) {
      if (v === undefined) delete headers[k];
      else headers[k] = v;
    }
    return headers;
  }

  async call<T = any>(call: GatewayCall): Promise<GatewayResponse<T>> {
    const headers = this.headers(call);
    let body: BodyInit | undefined;
    if (call.form) {
      body = call.form;
    } else if (call.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(call.body);
    }
    const res = await fetch(`${this.baseUrl}/mkt/v1/${call.product}${call.path}`, {
      method: call.method || (call.body !== undefined || call.form ? 'POST' : 'GET'),
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
    return { status: res.status, body: parsed, billing: res.headers.get('x-magicapi-billing'), headers: res.headers };
  }
}

/** A PNG of the given size, for uploads and carousels. */
export async function png(width: number, height: number, color = '#3366ff'): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sharp = require('sharp');
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

export function imageForm(buffer: Buffer, name = 'image.png') {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), name);
  return form;
}
