/**
 * The backend the E2E suite drives through the browser: the real AppModule
 * (every controller, guard, Prisma and Redis) on a fixed port, with the same
 * two stand-ins as the integration suite:
 *
 *  - FakeTemporal: no Temporal server or worker. A scheduled post is saved and
 *    its workflow recorded, never published; emails are recorded, never sent.
 *  - FakeRazorpay: an in-memory Razorpay account, so checkout, the signed
 *    handshake and Cancel run without the network.
 *  - FakeGumroad: Gumroad's license and sales API on 127.0.0.1, so "Bought
 *    on Gumroad? Enter your license key" runs against the real client.
 *
 * and more: LinkedIn's token exchange answers a fake profile for a code
 * that starts with "e2e-", so the connect flow can finish without LinkedIn;
 * Skool (cookies with an auth_token "e2e-...") and Bluesky (a handle
 * "e2e-...") answer fake accounts the same way; and Google sign-in answers a
 * fake Google account for a code that starts with "e2e-google-", so a Google
 * sign-up can run without Google.
 *
 * Unlike the integration suite it runs with secure cookies (NOT_SECURED
 * empty), as production does: the browser keeps the session in the httpOnly
 * `auth` cookie and sends it cross-origin, which needs main.ts's CORS policy.
 *
 * Started by playwright.config.ts (webServer), or by hand from the repo root:
 *
 *   node -r ./tests/e2e/server/register.cjs tests/e2e/server/backend.ts
 *
 * It empties and re-creates its own database (hookpost_e2e by default) on
 * every start and refuses any database that is not local.
 *
 * A second port serves what the browser cannot see, for the specs only. It
 * listens on 127.0.0.1 and exists only here:
 *   GET  /emails                 what the backend tried to send (Temporal)
 *   GET  /resend                 what it sent straight through Resend (fake.resend.ts)
 *   GET  /network                connections to other hosts it was refused (network-guard.cjs)
 *   GET  /workflows              Temporal workflows it started
 *   GET  /razorpay               the fake account's subscriptions and plans
 *   POST /razorpay/offers        {remove?, add?}: an offer id disabled in (or
 *                                back in) the dashboard
 *   POST /trial-used             {email}: that user's workspace has had its trial
 *   POST /razorpay/late-charge   {id}: a renewal debited after cancel, and its
 *                                subscription.charged delivered
 *   POST /razorpay/authorise     {id, trialDays?}: the customer paid (mandate)
 *   POST /razorpay/payment       {email, amount?, currency?, service?}: a captured
 *                                one-off payment tagged as that user's workspace's
 *                                (notes.service, notes.orgId), answers the payment
 *   POST /razorpay/refund        {paymentId, amount, notes?}: a refund made outside
 *                                Hookpost (the Razorpay dashboard), answers it
 *   POST /plan                   {email, tier, startedDaysAgo?}: give that user's
 *                                workspace a plan (bought that many days ago)
 *   POST /gumroad/license        {tier?, recurrence?}: a Gumroad purchase with a
 *                                license key, answers {key, saleId}
 *   POST /channel                {email, provider, name?}: add a connected channel
 *   POST /env                    {KEY: value}: change a policy variable
 *   POST /email-verification     {required}: password sign-ups must confirm
 *                                their email, as in production (off by default)
 *   GET  /posts?email=           that user's workspace's posts (id, content, state)
 *   GET  /attribution?email=     that user's workspace's SignupAttribution row
 *   POST /publish                {postId, minutesAgo?}: publish a post on X,
 *                                LinkedIn or Discord as postWorkflowV114 would
 *                                (like /mkt/publish), published that long ago
 *   GET  /review-ask?email=      that user's ReviewAsk row (the review card)
 *   POST /super-admin            {email}: make that user a platform super admin
 *   POST /error-log              {email, platform?, message?}: a publishing error
 *                                (Errors row, on a post of the user's first
 *                                channel) for the admin Error Logs page
 *   POST /session                {email, issuedSecondsAgo?, legacy?}: a session
 *                                token for that user as the backend would have
 *                                issued it that long ago; legacy: the user row
 *                                signed without exp
 *   POST /mkt/channel            {subscriber, product, provider, name?, internalId?}: a
 *                                connected channel in that api.market subscriber's
 *                                workspace (internalId: a Discord channel's server)
 *   POST /mkt/publish            {postId}: publish it as postWorkflowV114 would
 *                                (the orchestrator's PostActivity; the network's
 *                                post and comment calls are recorded, never sent)
 *   GET  /mkt/calls              those recorded post and comment calls, per network
 *   GET  /mkt/posts?subscriber=&product=  that subscriber's posts (id, state)
 *   GET  /mkt/pdf-pages?url=     pages of a PDF the backend stored (local storage)
 */
import { execFileSync } from 'child_process';
import { createServer, IncomingMessage } from 'http';
import { join } from 'path';
import { assertLocalDatabase, testEnv, TEST_REDIS_URL } from '../../integration/setup/test-env';
import {
  E2E_DISCORD_CHANNELS,
  E2E_DISCORD_SERVER,
  marketplaceEnv,
} from '../../integration/setup/marketplace';
import { marketplaceAdaptersEnv } from '../../integration/setup/marketplace-adapters';

export const E2E_BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 53000);
export const E2E_FRONTEND_PORT = Number(process.env.E2E_FRONTEND_PORT || 54200);
export const E2E_CONTROL_PORT = E2E_BACKEND_PORT + 1;
export const E2E_DATABASE_URL =
  process.env.HOOKPOST_E2E_DATABASE_URL ||
  'postgresql://hookpost:hookpost-test-password@127.0.0.1:55432/hookpost_e2e';
/**
 * The cutoff production runs: a workspace created on or after it gets
 * FREE_POST_LIMIT free posts (free_posts, since 28 Oct 2026). free-posts.spec.ts
 * and admin-billing.spec.ts switch to it through POST /env.
 */
export const E2E_TRIAL_CUTOFF = '2026-10-19T00:00:00Z';
/**
 * What the specs about the trial paywall run on by default: a workspace made
 * during a run is BEFORE this cutoff (grandfathered), and the Free plan sunset
 * below has passed, so with no plan it is needs_trial. A workspace created
 * after a cutoff is free_posts, not needs_trial, so a new sign-up cannot be
 * used to reach the paywall any more.
 */
export const E2E_NEEDS_TRIAL_CUTOFF = '2099-01-01T00:00:00Z';
export const E2E_FREE_PLAN_SUNSET = '2026-10-20T00:00:00Z';
// The Gumroad products the E2E backend sells (FakeGumroad knows nothing
// else), shared with the frontend; all empty under E2E_GUMROAD=off.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { GUMROAD_ENV } = require('../frontend-env.cjs');
const E2E_GUMROAD_PRODUCTS = {
  STANDARD: 'e2e-standard-product==',
  PRO: 'e2e-pro-product==',
};

/** Only these may be changed through POST /env. */
const POLICY_ENV = new Set([
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
  'FREE_PLAN_SUNSET_AT',
  'FREE_PLAN_SUNSET_EXEMPT_ORGS',
]);

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function main() {
  const root = join(__dirname, '..', '..', '..');
  const frontend = `http://localhost:${E2E_FRONTEND_PORT}`;
  const backend = `http://localhost:${E2E_BACKEND_PORT}`;
  const env: Record<string, string> = {
    ...testEnv(),
    DATABASE_URL: E2E_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    FRONTEND_URL: frontend,
    MAIN_URL: frontend,
    NEXT_PUBLIC_BACKEND_URL: backend,
    BACKEND_INTERNAL_URL: backend,
    // Secure cookies, as in production (Chrome accepts them on localhost).
    NOT_SECURED: '',
    TRIAL_REQUIRED_SINCE_IN: E2E_NEEDS_TRIAL_CUTOFF,
    FREE_PLAN_SUNSET_AT: E2E_FREE_PLAN_SUNSET,
    // The review card (review.ask.policy.ts) never asks the specs' usual
    // accounts, so it cannot cover a button another spec is about to press;
    // review-prompt.spec.ts signs up on another domain.
    FREE_PLAN_SUNSET_SKIP_EMAILS: 'hookpost-test.invalid',
    // The browser keeps calling the API while a spec signs up several users.
    API_LIMIT: '100000',
    LINKEDIN_CLIENT_ID: 'linkedin-client-e2e',
    LINKEDIN_CLIENT_SECRET: 'linkedin-secret-e2e',
    X_API_KEY: 'x-key-e2e',
    X_API_SECRET: 'x-secret-e2e',
    // Google sign-in builds its consent URL locally from this; the code
    // exchange itself is faked below.
    YOUTUBE_CLIENT_ID: 'google-client-e2e.apps.googleusercontent.com',
    YOUTUBE_CLIENT_SECRET: 'google-secret-e2e',
    // Plans sold on Gumroad, verified against FakeGumroad below (unset
    // under E2E_GUMROAD=off).
    ...GUMROAD_ENV,
    // The api.market gateway's test secrets and plan tokens
    // (tests/integration/setup/marketplace.ts); the specs call it as api.market.
    ...marketplaceEnv(),
    // RapidAPI's and a keyed marketplace's (setup/marketplace-adapters.ts).
    ...marketplaceAdaptersEnv(),
  };
  assertLocalDatabase(env.DATABASE_URL, 'DATABASE_URL');
  assertLocalDatabase(env.REDIS_URL, 'REDIS_URL');
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  // A throwaway database (asserted local above), so db push is fine here.
  execFileSync(
    join(root, 'node_modules', '.bin', 'prisma'),
    [
      'db',
      'push',
      '--schema',
      join(root, 'libraries/nestjs-libraries/src/database/prisma/schema.prisma'),
      '--skip-generate',
      '--force-reset',
      '--accept-data-loss',
    ],
    { stdio: process.env.CI ? 'inherit' : 'ignore', env: { ...process.env } }
  );
  const { Redis } = await import('ioredis');
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  await redis.flushall();
  redis.disconnect();

  const { FakeRazorpay } = await import('../../integration/setup/fake.razorpay');
  const { startApp } = await import('../../integration/setup/app');
  const { addChannel, db, givePlan, makeSuperAdmin } = await import('../../integration/setup/db');
  const { IntegrationManager } = await import(
    '@hookpost/nestjs-libraries/integrations/integration.manager'
  );
  const { resendSends } = await import('../../integration/setup/fake.resend');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { takeBlocked } = require('../../integration/setup/network-guard.cjs');
  // Everything refused since start, so GET /network can be read repeatedly.
  const networkBlocked: { where: string; at: string }[] = [];
  const rzp = new FakeRazorpay().install();
  const { FakeGumroad } = await import('../../integration/setup/fake.gumroad');
  const gumroad = await new FakeGumroad().install();
  const app = await startApp({
    port: E2E_BACKEND_PORT,
    mcp: true,
    logger: ['error', 'warn'],
  });

  // LinkedIn's code-for-token exchange, for codes the specs make up.
  const linkedin: any = app
    .get<InstanceType<typeof IntegrationManager>>(IntegrationManager)
    .getSocialIntegration('linkedin');
  const realAuthenticate = linkedin.authenticate.bind(linkedin);
  linkedin.authenticate = async (params: { code: string }, ...rest: any[]) => {
    if (!params.code?.startsWith('e2e-')) return realAuthenticate(params, ...rest);
    const id = params.code.slice(4);
    return {
      id: `li-${id}`,
      name: `E2E LinkedIn ${id}`,
      accessToken: `li-access-${id}`,
      refreshToken: `li-refresh-${id}`,
      expiresIn: 3600 * 24 * 60,
      picture: '',
      username: `e2e-${id}`,
    };
  };

  // Skool's cookies (the Chrome extension reads them), for cookies the specs
  // make up: an auth_token "e2e-<id>-..." is a fake account. The real one
  // asks api2.skool.com who the cookies belong to.
  const manager = app.get<InstanceType<typeof IntegrationManager>>(IntegrationManager);
  const skool: any = manager.getSocialIntegration('skool');
  const realSkool = skool.authenticate.bind(skool);
  skool.authenticate = async (params: { code: string }, ...rest: any[]) => {
    let token = '';
    try {
      token = String(JSON.parse(Buffer.from(params.code, 'base64').toString()).auth_token || '');
    } catch {
      /* not cookies at all: the real one says so */
    }
    if (!token.startsWith('e2e-')) return realSkool(params, ...rest);
    const id = token.slice(4).split('-')[0];
    return {
      id: `skool-${id}`,
      name: `E2E Skool ${id}`,
      accessToken: `skool-access-${id}`,
      refreshToken: '',
      expiresIn: 3600 * 24 * 365,
      picture: '',
      username: `e2e-skool-${id}`,
    };
  };

  // Bluesky (custom fields: handle and app password), for a handle the specs
  // make up: "e2e-<id>.bsky.social". The real one signs in at the PDS.
  const bluesky: any = manager.getSocialIntegration('bluesky');
  const realBluesky = bluesky.authenticate.bind(bluesky);
  bluesky.authenticate = async (params: { code: string }, ...rest: any[]) => {
    let identifier = '';
    try {
      identifier = String(JSON.parse(Buffer.from(params.code, 'base64').toString()).identifier || '');
    } catch {
      /* the real one says what is wrong */
    }
    if (!identifier.startsWith('e2e-')) return realBluesky(params, ...rest);
    const id = identifier.slice(4).split('.')[0];
    return {
      id: `did:plc:e2e${id}`,
      name: `E2E Bluesky ${id}`,
      accessToken: `bsky-access-${id}`,
      refreshToken: `bsky-refresh-${id}`,
      expiresIn: 3600,
      picture: '',
      username: identifier,
    };
  };

  // Google sign-in (redirect flow), for codes the specs make up: the code is
  // "e2e-google-<id>" and the account is <id>@gmail-e2e.invalid.
  const { GoogleProvider } = await import(
    '@hookpost/backend/services/auth/providers/google.provider'
  );
  const google: any = app.get(GoogleProvider);
  const realGetToken = google.getToken.bind(google);
  const realGetUser = google.getUser.bind(google);
  google.getToken = async (code: string, redirectUri?: string) =>
    code?.startsWith('e2e-google-') ? `e2e-google-token-${code.slice(11)}` : realGetToken(code, redirectUri);
  google.getUser = async (token: string) => {
    if (!token?.startsWith('e2e-google-token-')) return realGetUser(token);
    const id = token.slice(17);
    return { id: `google-${id}`, email: `${id}@gmail-e2e.invalid`, name: `E2E Google ${id}`, emailVerified: true };
  };

  // What the networks would have been asked to publish (POST /mkt/publish).
  // FakeTemporal publishes nothing, so no other spec reaches these.
  const mktCalls: Record<string, { posts: number; comments: number }> = {};
  for (const id of ['x', 'linkedin', 'discord']) {
    const network: any = app
      .get<InstanceType<typeof IntegrationManager>>(IntegrationManager)
      .getSocialIntegration(id);
    mktCalls[id] = { posts: 0, comments: 0 };
    let n = 0;
    const answer = (posts: any[]) =>
      posts.map((p) => ({ id: p.id, postId: `${id}-e2e-${++n}`, releaseURL: `https://${id}.example/e2e/${n}`, status: 'success' }));
    network.post = async (_i: string, _t: string, posts: any[]) => {
      mktCalls[id].posts++;
      return answer(posts);
    };
    network.postPending = undefined;
    if (id === 'discord') {
      // Discord's GET /channels/{id}, which the gateway asks before it takes
      // a Discord post: the channels of server E2E_DISCORD_SERVER are the
      // ones in E2E_DISCORD_CHANNELS; any other id is in another server.
      network.channelServer = async (channel: string) =>
        E2E_DISCORD_CHANNELS.includes(channel) ? E2E_DISCORD_SERVER : '1900000000000000009';
    }
    if (network.comment) {
      network.comment = async (_i: string, _p: string, _l: string, _t: string, posts: any[]) => {
        mktCalls[id].comments++;
        return answer(posts);
      };
    }
  }
  const { publishLikeTheWorkflow } = await import('../../integration/setup/publish');
  const { countPdfPages } = await import('@hookpost/nestjs-libraries/integrations/social/carousel.pdf');
  const mktOrgOf = async (subscriber: string, product: string) =>
    (
      await db().marketplaceAccount.findFirstOrThrow({
        where: { externalUserId: String(subscriber), product: String(product) },
      })
    ).organizationId;

  const orgOf = async (email: string) => {
    const user = await db().user.findFirstOrThrow({
      where: { email: email.toLowerCase() },
      include: { organizations: { orderBy: { createdAt: 'asc' } } },
    });
    return user.organizations[0].organizationId;
  };

  createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      const url = new URL(req.url || '/', 'http://control');
      if (req.method === 'GET' && url.pathname === '/emails') {
        res.end(JSON.stringify(app.temporal.emails()));
      } else if (req.method === 'GET' && url.pathname === '/resend') {
        res.end(JSON.stringify(resendSends()));
      } else if (req.method === 'GET' && url.pathname === '/network') {
        networkBlocked.push(...takeBlocked());
        res.end(JSON.stringify({ blocked: networkBlocked.map(({ where, at }) => ({ where, at })) }));
      } else if (req.method === 'GET' && url.pathname === '/razorpay') {
        res.end(
          JSON.stringify({
            subscriptions: [...rzp.subscriptions.values()],
            plans: [...rzp.plans.values()],
          })
        );
      } else if (req.method === 'POST' && url.pathname === '/razorpay/offers') {
        const body = await readJson(req);
        if (body.remove) rzp.offers.delete(String(body.remove));
        if (body.add) rzp.offers.add(String(body.add));
        res.end(JSON.stringify([...rzp.offers]));
      } else if (req.method === 'POST' && url.pathname === '/trial-used') {
        // A workspace that has had its trial: its next plan is charged at
        // checkout (and can carry the first-month offer).
        const body = await readJson(req);
        await db().organization.update({
          where: { id: await orgOf(body.email) },
          data: { allowTrial: false },
        });
        res.end('{}');
      } else if (req.method === 'GET' && url.pathname === '/workflows') {
        res.end(
          JSON.stringify(
            app.temporal.started.map((s) => ({ workflow: s.workflow, id: s.options?.workflowId }))
          )
        );
      } else if (req.method === 'POST' && url.pathname === '/razorpay/payment') {
        const body = await readJson(req);
        const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const id = 'pay_' + Array.from({ length: 14 }, () => alnum[Math.floor(Math.random() * alnum.length)]).join('');
        const payment = {
          id,
          entity: 'payment',
          amount: Number(body.amount || 69900),
          amount_refunded: 0,
          refund_status: null,
          currency: body.currency || 'INR',
          status: 'captured',
          method: 'upi',
          email: String(body.email).toLowerCase(),
          description: 'Hookpost Standard',
          international: false,
          notes: { service: body.service || 'hookpost', orgId: await orgOf(body.email) },
          created_at: Math.floor(Date.now() / 1000),
          // Razorpay's fee (GST included) and the GST part, when the spec gives them.
          ...(body.fee !== undefined ? { fee: Number(body.fee), tax: Number(body.tax || 0) } : {}),
        };
        rzp.payments.set(id, payment);
        res.end(JSON.stringify(payment));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/dispute') {
        // {email}: a captured, invoiced charge on that workspace's Razorpay
        // subscription, and a bank's chargeback on it (FakeRazorpay.dispute).
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        const sub = [...rzp.subscriptions.values()].find((x) => x.notes?.orgId === organizationId);
        if (!sub) throw new Error('no Razorpay subscription for that workspace');
        const payment = rzp.charge(sub.id);
        rzp.invoiceFor(sub.id, payment);
        res.end(JSON.stringify({ payment: rzp.payments.get(payment.id), dispute: rzp.dispute(payment.id), subscriptionId: sub.id }));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/dispute-status') {
        const body = await readJson(req);
        res.end(JSON.stringify(rzp.setDisputeStatus(String(body.id), String(body.status))));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/refund') {
        const body = await readJson(req);
        res.end(JSON.stringify(rzp.refund(String(body.paymentId), Number(body.amount), { notes: body.notes || [] })));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/fail-charge') {
        // {id, status: 'pending' | 'halted'}: the charge failed (FakeRazorpay.failCharge).
        const body = await readJson(req);
        res.end(JSON.stringify(rzp.failCharge(String(body.id), body.status || 'pending')));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/retry-succeeds') {
        const body = await readJson(req);
        res.end(JSON.stringify(rzp.retrySucceeds(String(body.id))));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/late-charge') {
        // {id}: the bank debits a renewal on subscription `id` after it was
        // cancelled (a UPI debit notified before Cancel), and Razorpay's
        // subscription.charged reaches the backend.
        const body = await readJson(req);
        const sub = rzp.subscriptions.get(String(body.id));
        if (!sub) throw new Error(`no subscription ${body.id}`);
        const payment = rzp.charge(sub.id);
        Object.assign(sub, {
          paid_count: Number(sub.paid_count || 1) + 1,
          current_start: sub.current_end,
          current_end: Number(sub.current_end) + 30 * 86400,
        });
        const { RazorpayService } = await import('@hookpost/nestjs-libraries/services/razorpay.service');
        await app.get<InstanceType<typeof RazorpayService>>(RazorpayService).handleWebhook({
          event: 'subscription.charged',
          payload: { subscription: { entity: { ...sub } }, payment: { entity: { ...payment } } },
        });
        res.end(JSON.stringify(payment));
      } else if (req.method === 'POST' && url.pathname === '/razorpay/authorise') {
        const body = await readJson(req);
        res.end(JSON.stringify(rzp.authorise(body.id, { trialDays: body.trialDays })));
      } else if (req.method === 'POST' && url.pathname === '/plan') {
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        let plan = await givePlan(organizationId, body.tier || 'STANDARD');
        if (Number(body.startedDaysAgo) > 0) {
          plan = await db().subscription.update({
            where: { organizationId },
            data: { createdAt: new Date(Date.now() - Number(body.startedDaysAgo) * 86_400_000) },
          });
        }
        res.end(JSON.stringify(plan));
      } else if (req.method === 'POST' && url.pathname === '/publish') {
        const body = await readJson(req);
        const post = await db().post.findFirstOrThrow({ where: { id: String(body.postId) } });
        const result = await publishLikeTheWorkflow(app, post.organizationId, post.id);
        if (Number(body.minutesAgo) > 0) {
          await db().post.update({
            where: { id: post.id },
            data: { publishDate: new Date(Date.now() - Number(body.minutesAgo) * 60_000) },
          });
        }
        res.end(JSON.stringify(result));
      } else if (req.method === 'GET' && url.pathname === '/review-ask') {
        const user = await db().user.findFirst({
          where: { email: String(url.searchParams.get('email') || '').toLowerCase() },
        });
        res.end(
          JSON.stringify(user ? await db().reviewAsk.findUnique({ where: { userId: user.id } }) : null)
        );
      } else if (req.method === 'POST' && url.pathname === '/plan/remove') {
        // {email}: the workspace loses its plan row (a team that has to
        // start its trial, for invite-confirm.spec.ts).
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        await db().subscription.deleteMany({ where: { organizationId } });
        await db().user.updateMany({ where: { email: String(body.email).toLowerCase() }, data: { signupCountry: 'IN' } });
        res.end(JSON.stringify({ organizationId }));
      } else if (req.method === 'POST' && url.pathname === '/seats') {
        // {email, count}: that many more members in the user's first
        // workspace, straight in the database (a full team).
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        for (let i = 0; i < Number(body.count || 0); i++) {
          await db().user.create({
            data: {
              email: `seat.${Date.now().toString(36)}.${i}@hookpost-test.invalid`,
              providerName: 'LOCAL',
              timezone: 0,
              password: '',
              activated: true,
              organizations: { create: { organizationId, role: 'USER' } },
            },
          });
        }
        res.end(JSON.stringify({ members: await db().userOrganization.count({ where: { organizationId } }) }));
      } else if (req.method === 'POST' && url.pathname === '/workspace') {
        // {email, name}: another workspace for that user, as its owner.
        const body = await readJson(req);
        const user = await db().user.findFirstOrThrow({ where: { email: String(body.email).toLowerCase() } });
        const org = await db().organization.create({
          data: {
            name: String(body.name || 'Second workspace'),
            apiKey: `e2e-${Date.now().toString(36)}`,
            allowTrial: true,
            users: { create: { userId: user.id, role: 'SUPERADMIN' } },
          },
        });
        res.end(JSON.stringify({ id: org.id }));
      } else if (req.method === 'POST' && url.pathname === '/user-name') {
        // {email, name}: what the team's members see as that user's name.
        const body = await readJson(req);
        await db().user.updateMany({ where: { email: String(body.email).toLowerCase() }, data: { name: String(body.name) } });
        res.end('{}');
      } else if (req.method === 'POST' && url.pathname === '/gumroad/license') {
        const body = await readJson(req);
        const license = gumroad.addLicense({
          productId: body.tier === 'STANDARD' ? E2E_GUMROAD_PRODUCTS.STANDARD : E2E_GUMROAD_PRODUCTS.PRO,
          recurrence: body.recurrence,
        });
        res.end(JSON.stringify({ key: license.key, saleId: license.purchase.sale_id }));
      } else if (req.method === 'POST' && url.pathname === '/channel') {
        const body = await readJson(req);
        const row = await addChannel(body.organizationId || (await orgOf(body.email)), body.provider || 'bluesky', {
          name: body.name,
          ...(body.internalId ? { internalId: String(body.internalId) } : {}),
          // A connect waiting on its Page / account picker.
          ...(body.inBetweenSteps ? { inBetweenSteps: true } : {}),
        });
        res.end(JSON.stringify({ id: row.id, name: row.name }));
      } else if (req.method === 'GET' && url.pathname === '/posts') {
        const organizationId = await orgOf(url.searchParams.get('email') || '');
        const rows = await db().post.findMany({
          where: { organizationId, deletedAt: null },
          select: { id: true, content: true, state: true, group: true, publishDate: true },
          orderBy: { createdAt: 'asc' },
        });
        res.end(JSON.stringify(rows));
      } else if (req.method === 'GET' && url.pathname === '/attribution') {
        const organizationId = await orgOf(url.searchParams.get('email') || '');
        res.end(
          JSON.stringify(await db().signupAttribution.findUnique({ where: { organizationId } }))
        );
      } else if (req.method === 'POST' && url.pathname === '/error-log') {
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        const integration = await db().integration.findFirstOrThrow({ where: { organizationId, deletedAt: null } });
        const post = await db().post.create({
          data: {
            organizationId,
            integrationId: integration.id,
            content: 'A post that failed',
            group: `e2e-error-${Date.now().toString(36)}`,
            publishDate: new Date(),
            state: 'ERROR',
          },
        });
        const row = await db().errors.create({
          data: {
            organizationId,
            postId: post.id,
            platform: String(body.platform || integration.providerIdentifier),
            message: String(body.message || 'Unknown Error'),
          },
        });
        res.end(JSON.stringify({ id: row.id }));
      } else if (req.method === 'POST' && url.pathname === '/credits') {
        // {email, type, count}: `count` Credits rows of `type` this month for
        // that user's workspace (a meter already partly used, x-post-caps.spec.ts).
        const body = await readJson(req);
        const organizationId = await orgOf(body.email);
        const { count } = await db().credits.createMany({
          data: Array.from({ length: Number(body.count) || 0 }, () => ({
            organizationId,
            credits: 1,
            type: String(body.type),
          })),
        });
        res.end(JSON.stringify({ count }));
      } else if (req.method === 'POST' && url.pathname === '/super-admin') {
        const body = await readJson(req);
        const user = await db().user.findFirstOrThrow({ where: { email: String(body.email).toLowerCase() } });
        await makeSuperAdmin(user.id);
        res.end('{}');
      } else if (req.method === 'POST' && url.pathname === '/session') {
        const body = await readJson(req);
        const { AuthService } = await import('@hookpost/helpers/auth/auth.service');
        const { sign } = await import('jsonwebtoken');
        const user = await db().user.findFirstOrThrow({ where: { email: String(body.email).toLowerCase() } });
        const issuedAt = Math.floor(Date.now() / 1000) - Number(body.issuedSecondsAgo || 0);
        const { password: _password, ...row } = user;
        const token = body.legacy
          ? sign({ ...row, iat: issuedAt }, process.env.JWT_SECRET!)
          : AuthService.signSessionJWT(user, { issuedAt });
        res.end(JSON.stringify({ token }));
      } else if (req.method === 'POST' && url.pathname === '/mkt/channel') {
        const body = await readJson(req);
        const row = await addChannel(await mktOrgOf(body.subscriber, body.product), body.provider, {
          name: body.name,
          internalId: body.internalId ? String(body.internalId) : undefined,
        });
        res.end(JSON.stringify({ id: row.id, name: row.name }));
      } else if (req.method === 'POST' && url.pathname === '/mkt/publish') {
        const body = await readJson(req);
        const post = await db().post.findFirstOrThrow({ where: { id: String(body.postId) } });
        res.end(JSON.stringify(await publishLikeTheWorkflow(app, post.organizationId, post.id)));
      } else if (req.method === 'GET' && url.pathname === '/mkt/calls') {
        res.end(JSON.stringify(mktCalls));
      } else if (req.method === 'GET' && url.pathname === '/mkt/posts') {
        const organizationId = await mktOrgOf(
          url.searchParams.get('subscriber') || '',
          url.searchParams.get('product') || ''
        );
        res.end(
          JSON.stringify(
            await db().post.findMany({
              where: { organizationId, deletedAt: null },
              select: { id: true, state: true, releaseURL: true },
            })
          )
        );
      } else if (req.method === 'GET' && url.pathname === '/mkt/pdf-pages') {
        const { readFileSync } = await import('fs');
        const prefix = `${process.env.FRONTEND_URL}/uploads/`;
        const target = String(url.searchParams.get('url') || '');
        if (!target.startsWith(prefix) || target.includes('..')) throw new Error('not a stored file');
        const pdf = readFileSync(join(process.env.UPLOAD_DIRECTORY!, target.slice(prefix.length)));
        res.end(JSON.stringify({ pages: countPdfPages(pdf) }));
      } else if (req.method === 'POST' && url.pathname === '/email-verification') {
        // {required}: password sign-ups must confirm their email, as in
        // production (EMAIL_PROVIDER=resend). The EmailService's provider is
        // what decides it (hasProvider). Emails still leave as Temporal
        // signals, which FakeTemporal records; nothing reaches Resend.
        const body = await readJson(req);
        const { EmailService } = await import('@hookpost/nestjs-libraries/services/email.service');
        const { ResendProvider } = await import('@hookpost/nestjs-libraries/emails/resend.provider');
        const { EmptyProvider } = await import('@hookpost/nestjs-libraries/emails/empty.provider');
        const emails = app.get<InstanceType<typeof EmailService>>(EmailService);
        emails.emailService = body.required ? new ResendProvider() : new EmptyProvider();
        res.end(JSON.stringify({ required: emails.hasProvider() }));
      } else if (req.method === 'POST' && url.pathname === '/billing-fixture') {
        // {email, country?, org?: {createdAt, allowTrial, isTrailing},
        //  plan?: {tier, isLifetime, cancelAt}, razorpay?: {status, paid_count,
        //  start_at, charge_at, current_end, amount (minor units), currency}}:
        // puts that user's workspace in a billing state for the admin page
        // (admin-billing.spec.ts). A Razorpay subscription and its plan are
        // made on the fake account and linked as the webhook would.
        const body = await readJson(req);
        if (body.razorpay && !body.plan) throw new Error('razorpay needs plan: the subscription is linked to the plan row');
        const organizationId = await orgOf(body.email);
        if (body.country) {
          await db().user.updateMany({
            where: { email: String(body.email).toLowerCase() },
            data: { signupCountry: String(body.country) },
          });
        }
        if (body.org) {
          await db().organization.update({
            where: { id: organizationId },
            data: {
              ...(body.org.createdAt ? { createdAt: new Date(body.org.createdAt) } : {}),
              ...(body.org.allowTrial !== undefined ? { allowTrial: !!body.org.allowTrial } : {}),
              ...(body.org.isTrailing !== undefined ? { isTrailing: !!body.org.isTrailing } : {}),
            },
          });
        }
        if (body.plan) {
          await givePlan(organizationId, body.plan.tier || 'STANDARD');
          let identifier: string | undefined;
          if (body.razorpay) {
            const { amount = 59900, currency = 'INR', ...fields } = body.razorpay;
            const planId = `plan_e2e${amount}${currency}`;
            rzp.plans.set(planId, { id: planId, entity: 'plan', period: 'monthly', item: { amount, currency } });
            identifier = `sub_e2e${Math.random().toString(36).slice(2, 12)}`;
            rzp.subscriptions.set(identifier, {
              id: identifier,
              entity: 'subscription',
              status: 'active',
              paid_count: 1,
              plan_id: planId,
              notes: { service: 'hookpost', orgId: organizationId },
              created_at: Math.floor(Date.now() / 1000),
              ...fields,
            });
            // The charge behind a card mandate, which is where Razorpay says
            // whether the card was issued outside India (card_international).
            if (fields.payment_method === 'card') rzp.charge(identifier, amount);
          }
          await db().subscription.update({
            where: { organizationId },
            data: {
              isLifetime: !!body.plan.isLifetime,
              cancelAt: body.plan.cancelAt ? new Date(body.plan.cancelAt) : null,
              ...(identifier ? { identifier } : {}),
            },
          });
        }
        res.end(JSON.stringify({ organizationId }));
      } else if (req.method === 'POST' && url.pathname === '/env') {
        const body = await readJson(req);
        for (const [k, v] of Object.entries(body)) {
          if (!POLICY_ENV.has(k)) throw new Error(`not a policy variable: ${k}`);
          process.env[k] = String(v ?? '');
        }
        res.end('{}');
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    } catch (e: any) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
  }).listen(E2E_CONTROL_PORT, '127.0.0.1');

  console.log(`E2E backend on ${backend} (control on 127.0.0.1:${E2E_CONTROL_PORT})`);

  const stop = async () => {
    await app.close().catch(() => undefined);
    rzp.uninstall();
    await gumroad.uninstall().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  console.error('E2E backend failed to start:', err);
  process.exit(1);
});
