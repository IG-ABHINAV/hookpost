/**
 * Shared helpers for the E2E specs: the test-only control port of the E2E
 * backend (tests/e2e/server/backend.ts), sign-up through the API for specs
 * that are not about sign-up, and the stand-ins for what sits in front of
 * production (Cloudflare's country header, Razorpay's checkout.js).
 */
import { BrowserContext, Page, expect } from '@playwright/test';
import { createHmac } from 'crypto';

export const BACKEND = `http://localhost:${process.env.E2E_BACKEND_PORT || 53000}`;
/** Where the app's pages are served from (FRONTEND_URL of the E2E backend). */
export const FRONTEND = `http://localhost:${process.env.E2E_FRONTEND_PORT || 54200}`;
const CONTROL = `http://127.0.0.1:${Number(process.env.E2E_BACKEND_PORT || 53000) + 1}`;
/** RAZORPAY_KEY_SECRET of the test backend (tests/integration/setup/test-env.ts). */
const RAZORPAY_TEST_SECRET = 'integration-razorpay-secret';
export const PASSWORD = 'Correct-Horse-9';

let n = 0;
export const uniqueEmail = (tag = 'e2e') =>
  `${tag}.${Date.now().toString(36)}.${(n++).toString(36)}@hookpost-test.invalid`;

export const control = {
  async get<T = any>(path: string): Promise<T> {
    const res = await fetch(CONTROL + path);
    return res.json() as Promise<T>;
  },
  async post<T = any>(path: string, body: unknown): Promise<T> {
    const res = await fetch(CONTROL + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (res.status >= 400) throw new Error(`control ${path}: ${JSON.stringify(json)}`);
    return json as T;
  },
  emails: () => control.get<{ to: string; subject: string; html: string }[]>('/emails'),
  /** Emails sent straight through Resend (billing, support), recorded by the fake. */
  resendTo: async (email: string) =>
    (
      await control.get<{ to: string | string[]; subject: string; html?: string; text?: string }[]>('/resend')
    ).filter((m) => [m.to].flat().some((to) => to.toLowerCase() === email.toLowerCase())),
  workflows: () => control.get<{ workflow: string; id: string }[]>('/workflows'),
  givePlan: (
    email: string,
    tier: 'STANDARD' | 'TEAM' | 'PRO' | 'ULTIMATE' = 'STANDARD',
    opts: { startedDaysAgo?: number } = {}
  ) => control.post('/plan', { email, tier, ...opts }),
  /** Publish a post on X, LinkedIn or Discord as the workflow would, `minutesAgo`. */
  publish: (postId: string, minutesAgo?: number) =>
    control.post<{ published: boolean; error?: string }>('/publish', { postId, minutesAgo }),
  /** That user's ReviewAsk row (the review card), or null. */
  reviewAsk: (email: string) =>
    control.get<Record<string, any> | null>(`/review-ask?email=${encodeURIComponent(email)}`),
  /** That user's workspace loses its plan (it has to start its trial). */
  removePlan: (email: string) => control.post('/plan/remove', { email }),
  /** `count` more members in that user's workspace. */
  addSeats: (email: string, count: number) => control.post<{ members: number }>('/seats', { email, count }),
  setUserName: (email: string, name: string) => control.post('/user-name', { email, name }),
  addChannel: (
    email: string,
    provider = 'bluesky',
    name?: string,
    extra: { internalId?: string; organizationId?: string; inBetweenSteps?: boolean } = {}
  ) => control.post<{ id: string; name: string }>('/channel', { email, provider, name, ...extra }),
  /** Another workspace for that user, as its owner (POST /workspace). */
  addWorkspace: (email: string, name: string) => control.post<{ id: string }>('/workspace', { email, name }),
  makeSuperAdmin: (email: string) => control.post('/super-admin', { email }),
  /** `count` credits of `type` (x_posts, ai_text, ...) already used this month by that user's workspace. */
  useCredits: (email: string, type: string, count: number) =>
    control.post<{ count: number }>('/credits', { email, type, count }),
  errorLog: (email: string, body: { platform?: string; message?: string } = {}) =>
    control.post<{ id: string }>('/error-log', { email, ...body }),
  /** Puts that user's workspace in a billing state (see /billing-fixture in the E2E backend). */
  billingFixture: (body: Record<string, any>) =>
    control.post<{ organizationId: string }>('/billing-fixture', body),
  /** Sets trial-policy variables on the running backend (TRIAL_*, FREE_PLAN_SUNSET_*). */
  setPolicyEnv: (env: Record<string, string>) => control.post('/env', env),
  /** That user's workspace has had its trial: its next plan is charged at checkout. */
  trialUsed: (email: string) => control.post('/trial-used', { email }),
  razorpay: () => control.get<{ subscriptions: any[]; plans: any[] }>('/razorpay'),
  /** A chargeback on a fresh charge of this user's workspace subscription. */
  razorpayDispute: (email: string) =>
    control.post<{ payment: any; dispute: any; subscriptionId: string }>('/razorpay/dispute', { email }),
  razorpayDisputeStatus: (id: string, status: string) =>
    control.post('/razorpay/dispute-status', { id, status }),
  /** The charge on this subscription failed: pending while Razorpay retries, halted after. */
  razorpayFailCharge: (id: string, status: 'pending' | 'halted' = 'pending') =>
    control.post('/razorpay/fail-charge', { id, status }),
  /** A retry went through: the subscription and the captured payment, as subscription.charged carries them. */
  razorpayRetrySucceeds: (id: string) =>
    control.post<{ sub: any; payment: any }>('/razorpay/retry-succeeds', { id }),
  /** A captured payment tagged as that user's workspace's, in the fake Razorpay account. */
  razorpayPayment: (body: { email: string; amount?: number; currency?: string; service?: string; fee?: number; tax?: number }) =>
    control.post<{ id: string; amount: number }>('/razorpay/payment', body),
  /** A refund made in the Razorpay dashboard, not through Hookpost. */
  razorpayRefund: (body: { paymentId: string; amount: number; notes?: Record<string, string> }) =>
    control.post<{ id: string }>('/razorpay/refund', body),
  /** A Gumroad purchase (FakeGumroad) with its license key; a monthly Pro membership by default. */
  gumroadLicense: (body: { tier?: 'STANDARD' | 'PRO'; recurrence?: string | null } = {}) =>
    control.post<{ key: string; saleId: string }>('/gumroad/license', body),
  /** Disable (remove) or restore (add) an offer id on the fake account, as the dashboard would. */
  razorpayOffers: (body: { remove?: string; add?: string }) =>
    control.post<string[]>('/razorpay/offers', body),
  /**
   * A session token for that user, as the backend would have issued it
   * `issuedSecondsAgo` ago; `legacy`: the user row signed without exp.
   */
  session: async (email: string, opts: { issuedSecondsAgo?: number; legacy?: boolean } = {}) =>
    (await control.post<{ token: string }>('/session', { email, ...opts })).token,
  /** The workspace's SignupAttribution row (null when none was recorded). */
  attribution: (email: string) =>
    control.get<Record<string, any> | null>(`/attribution?email=${encodeURIComponent(email)}`),
  posts: (email: string) =>
    control.get<{ id: string; content: string; state: string; group: string }[]>(
      `/posts?email=${encodeURIComponent(email)}`
    ),
};

function cookieValue(res: Response, name: string): string | undefined {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (pair.slice(0, i).trim() === name) return decodeURIComponent(pair.slice(i + 1));
  }
  return undefined;
}

/**
 * A new email/password account made through the API (no browser), signed in
 * in `context` with the same cookies the backend sets on the real sign-up.
 * For specs whose subject is not the sign-up form itself.
 */
export async function signUpViaApi(
  context: BrowserContext,
  opts: {
    email?: string;
    country?: string;
    /** The first touch the marketing pages keep in the hp_attr cookie (utm_source, referrer, landing_path, ...). */
    attribution?: Record<string, unknown>;
  } = {}
): Promise<{ email: string; password: string; auth: string }> {
  const email = opts.email || uniqueEmail();
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.country ? { 'cf-ipcountry': opts.country } : {}),
      ...(opts.attribution
        ? {
            cookie: `hp_attr=${encodeURIComponent(
              JSON.stringify({ first_seen_at: Date.now() - 60_000, ...opts.attribution })
            )}`,
          }
        : {}),
    },
    body: JSON.stringify({ email, password: PASSWORD, company: 'E2E Co', provider: 'LOCAL' }),
  });
  const auth = cookieValue(res, 'auth');
  if (res.status !== 200 || !auth) {
    throw new Error(`register failed: ${res.status} ${await res.text()}`);
  }
  // The first signed-in request records the sign-up country (AuthMiddleware),
  // which decides the trial cohort.
  await fetch(`${BACKEND}/user/self`, {
    headers: { cookie: `auth=${auth}`, ...(opts.country ? { 'cf-ipcountry': opts.country } : {}) },
  });
  await signInContext(context, auth);
  return { email, password: PASSWORD, auth };
}

export async function signInContext(context: BrowserContext, auth: string) {
  // The flags the backend sets (session.cookies.ts): httpOnly, Secure, Lax.
  const common = { domain: 'localhost', path: '/', secure: true, sameSite: 'Lax' as const };
  await context.addCookies([
    { name: 'auth', value: auth, httpOnly: true, ...common },
    { name: 'hp_logged_in', value: '1', httpOnly: false, ...common },
  ]);
}

/**
 * Presses Join on a team invite from the spec, the way the /invite page does
 * (components/invite/invite.confirm.tsx): the invite in the invite_pending
 * cookie the proxy sets, the question read first for its ref, then JSON from
 * the app's origin.
 */
export async function acceptInviteViaApi(auth: string, token: string) {
  const headers = { auth, cookie: `invite_pending=${token}`, origin: FRONTEND, 'content-type': 'application/json' };
  const question = await (await fetch(`${BACKEND}/user/invite`, { headers })).json();
  const res = await fetch(`${BACKEND}/user/invite/accept`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: question?.ref ?? '' }),
  });
  return { status: res.status, body: await res.json() };
}

/** An authenticated API call from the spec (outside the browser). */
export async function api<T = any>(auth: string, method: string, path: string, body?: unknown) {
  const res = await fetch(BACKEND + path, {
    method,
    headers: { auth, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json as T };
}

/**
 * The calendar's button that starts connecting a channel. It reads "Add
 * Channel", or "Connect your first channel" while the workspace has none
 * (add.provider.component.tsx, since 982e0ac83); the compact variant carries
 * "Add Channel" as its aria-label.
 */
export const addChannelButton = (page: Page) =>
  page.getByRole('button', { name: /^(Add Channel|Connect your first channel)$/ }).first();

/**
 * "Skip for now" on the connect step a new workspace that has to start its
 * trial sees before the paywall (connect.first.ts), done the way the button
 * does it, for specs about the paywall itself.
 */
export async function skipConnectStep(page: Page, auth: string) {
  const { orgId } = (await api(auth, 'GET', '/user/self')).body;
  await page.addInitScript((id: string) => {
    try {
      window.localStorage.setItem(`hookpost_connect_first_skipped:${id}`, '1');
    } catch {
      /* a private window: the connect step shows */
    }
  }, orgId);
}

/**
 * Cloudflare's country header on every call the page makes to the API, as
 * production gets it (nginx only trusts it from Cloudflare).
 */
export async function visitFrom(page: Page, country: string) {
  await page.route(`${BACKEND}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), 'cf-ipcountry': country } })
  );
}

/**
 * Replaces Razorpay's checkout.js with a stand-in whose open() behaves like a
 * customer who completes the mandate: the fake Razorpay account marks the
 * subscription paid (trial: authenticated), and the page's handler gets a
 * correctly signed response, which it POSTs to /razorpay/verify for real.
 * `outcome: 'dismiss'` closes the modal instead.
 */
export async function stubRazorpayCheckout(
  page: Page,
  opts: { trialDays?: number; outcome?: 'pay' | 'dismiss' } = {}
) {
  const opened: string[] = [];
  await page.exposeFunction('__e2eRazorpayPay', async (subscriptionId: string) => {
    opened.push(subscriptionId);
    await control.post('/razorpay/authorise', { id: subscriptionId, trialDays: opts.trialDays });
    const paymentId = `pay_e2e${Date.now()}`;
    const signature = createHmac('sha256', RAZORPAY_TEST_SECRET)
      .update(`${paymentId}|${subscriptionId}`)
      .digest('hex');
    return { paymentId, signature };
  });
  const outcome = opts.outcome || 'pay';
  await page.route('https://checkout.razorpay.com/v1/checkout.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
        window.Razorpay = function (options) { this.options = options; this.events = {}; };
        window.Razorpay.prototype.on = function (name, fn) { this.events[name] = fn; };
        window.Razorpay.prototype.open = function () {
          var o = this.options;
          window.__e2eRazorpayOptions = { key: o.key, subscription_id: o.subscription_id, currency: o.currency, description: o.description };
          if (${JSON.stringify(outcome)} === 'dismiss') { setTimeout(function () { o.modal && o.modal.ondismiss && o.modal.ondismiss(); }, 50); return; }
          window.__e2eRazorpayPay(o.subscription_id).then(function (r) {
            o.handler({ razorpay_payment_id: r.paymentId, razorpay_subscription_id: o.subscription_id, razorpay_signature: r.signature });
          });
        };
      `,
    })
  );
  return { opened };
}

/**
 * Opens a page with a form and waits until it has hydrated: text typed into a
 * server-rendered input before React takes over is silently reset.
 */
export async function gotoForm(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/** Fails the test on any 5xx the page gets from the frontend or the API. */
export function failOnServerErrors(page: Page) {
  const errors: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 500) errors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  return {
    errors,
    assertNone: () => expect(errors, 'server errors seen by the page').toEqual([]),
  };
}

/**
 * Text drawn in the colour of what is behind it (contrast under 1.5:1), in
 * `scope`. Catches hard-coded white text on a page in the light theme
 * (2 Nov 2026 UI sweep). A background image or gradient is skipped.
 */
export async function invisibleText(page: Page, scope = 'main', minRatio = 1.5) {
  return page.evaluate(({ scope, minRatio }) => {
    const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
    const lum = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const behind = (el: Element | null): number[] => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.backgroundImage !== 'none') return [];
        const c = rgb(s.backgroundColor);
        if (c.length >= 3 && (c[3] ?? 1) > 0.5) return c;
      }
      return [255, 255, 255];
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll(`${scope} *`)) {
      if (![...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || '').trim().length > 1)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      const bg = behind(el);
      if (!bg.length) continue;
      const a = lum(rgb(getComputedStyle(el).color));
      const b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < minRatio) out.push(`${el.tagName} "${(el.textContent || '').trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    return out.slice(0, 10);
  }, { scope, minRatio });
}

/** The app's theme cookie (mode.component.tsx), for the light theme. */
export async function setLightTheme(context: BrowserContext, browserName: string) {
  await context.addCookies([
    { name: 'mode', value: 'light', domain: 'localhost', path: '/', secure: browserName !== 'webkit', sameSite: 'Lax' },
  ]);
}
