/**
 * The OAuth consent page (/oauth/authorize) as ChatGPT opens it when someone
 * adds Hookpost as a custom MCP server: the client was registered by DCR, the
 * query carries PKCE, state, scope and RFC 8707's resource. Authorize sends
 * the browser back to ChatGPT's redirect with a code and the state. An
 * account whose email is not confirmed is told why on the card, which stays
 * usable (the buttons used to stay disabled and nothing was said). The
 * "trial is next" notice is for a workspace that has to start its trial
 * (needs_trial: what the E2E backend makes of a fresh workspace, see
 * E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts); a sign-up after the cutoff is
 * free_posts and is not asked for one.
 */
import { createHash, randomBytes } from 'crypto';
import { expect, Page, test } from '@playwright/test';
import { BACKEND, control, failOnServerErrors, signUpViaApi, visitFrom } from './support';

const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

async function registerChatGpt() {
  const res = await fetch(`${BACKEND}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [CHATGPT_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string; client_secret: string };
}

function consentUrl(clientId: string, challenge: string) {
  return (
    '/oauth/authorize?' +
    new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'chatgpt-state-1',
      scope: 'mcp:read mcp:write',
      resource: 'https://hookpost.hookstep.in/mcp-oauth',
    })
  );
}

/** ChatGPT's redirect page, served locally: nothing leaves the machine. */
async function stubChatGpt(page: Page) {
  const hits: URL[] = [];
  await page.route('https://chatgpt.com/**', async (route) => {
    hits.push(new URL(route.request().url()));
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>back in ChatGPT</p>' });
  });
  return hits;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

test.describe('ChatGPT connector consent', () => {
  test('Authorize sends the browser back to ChatGPT with a code that redeems for a token', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const { email } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    const client = await registerChatGpt();
    const { verifier, challenge } = pkce();
    const hits = await stubChatGpt(page);

    await page.goto(consentUrl(client.client_id, challenge));
    await expect(page.getByRole('heading', { name: 'ChatGPT' })).toBeVisible();
    await page.getByRole('button', { name: 'Authorize' }).click();
    // With a plan, straight back to ChatGPT: no card in between.
    await page.waitForURL(/^https:\/\/chatgpt\.com\//);

    expect(hits).toHaveLength(1);
    const back = hits[0];
    expect(back.origin + back.pathname).toBe(CHATGPT_REDIRECT);
    expect(back.searchParams.get('state')).toBe('chatgpt-state-1');
    const code = back.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // What ChatGPT's server does next.
    const token = await fetch(`${BACKEND}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        code_verifier: verifier,
        redirect_uri: CHATGPT_REDIRECT,
        resource: 'https://hookpost.hookstep.in/mcp-oauth',
      }),
    });
    expect(token.status).toBe(200);
    expect((await token.json()).access_token).toMatch(/^pos_/);
    errors.assertNone();
  });

  test('Deny sends the browser back with access_denied and no code', async ({ page }) => {
    const { email } = await signUpViaApi(page.context());
    await control.givePlan(email, 'STANDARD');
    const client = await registerChatGpt();
    const hits = await stubChatGpt(page);

    await page.goto(consentUrl(client.client_id, pkce().challenge));
    await page.getByRole('button', { name: 'Deny' }).click();
    await page.waitForURL(/^https:\/\/chatgpt\.com\//);
    expect(hits[0].searchParams.get('error')).toBe('access_denied');
    expect(hits[0].searchParams.get('state')).toBe('chatgpt-state-1');
    expect(hits[0].searchParams.get('code')).toBeNull();
  });

  test.describe('a workspace without a plan', () => {
    async function redeem(client: { client_id: string; client_secret: string }, code: string, verifier: string) {
      return fetch(`${BACKEND}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: client.client_id,
          client_secret: client.client_secret,
          code_verifier: verifier,
          redirect_uri: CHATGPT_REDIRECT,
          resource: 'https://hookpost.hookstep.in/mcp-oauth',
        }),
      });
    }

    test('Authorize says the connector is linked and the trial is next; Continue still goes back with a working code', async ({ page }) => {
      const errors = failOnServerErrors(page);
      await signUpViaApi(page.context(), { country: 'IN' });
      await visitFrom(page, 'IN');
      const client = await registerChatGpt();
      const { verifier, challenge } = pkce();
      const hits = await stubChatGpt(page);

      await page.goto(consentUrl(client.client_id, challenge));
      await page.getByRole('button', { name: 'Authorize' }).click();
      const notice = page.getByTestId('connector-trial-notice');
      await expect(notice.getByRole('heading', { name: 'Your connector is linked' })).toBeVisible();
      await expect(notice).toContainText(/Start your \d+-day trial so ChatGPT can publish\./);
      await expect(notice.getByRole('button', { name: 'Start free trial' })).toBeVisible();
      expect(hits).toHaveLength(0);

      await notice.getByRole('button', { name: 'Continue to ChatGPT' }).click();
      await page.waitForURL(/^https:\/\/chatgpt\.com\//);
      expect(hits).toHaveLength(1);
      expect(hits[0].searchParams.get('state')).toBe('chatgpt-state-1');
      const token = await redeem(client, hits[0].searchParams.get('code')!, verifier);
      expect(token.status).toBe(200);
      errors.assertNone();
    });

    test('Start free trial opens the paywall in a new tab and this tab still finishes the connection', async ({ page, context }) => {
      await signUpViaApi(context, { country: 'IN' });
      await visitFrom(page, 'IN');
      const client = await registerChatGpt();
      const { verifier, challenge } = pkce();
      const hits = await stubChatGpt(page);

      await page.goto(consentUrl(client.client_id, challenge));
      await page.getByRole('button', { name: 'Authorize' }).click();
      const [billing] = await Promise.all([
        context.waitForEvent('page'),
        page.getByTestId('connector-trial-notice').getByRole('button', { name: 'Start free trial' }).click(),
      ]);
      await billing.waitForLoadState();
      expect(new URL(billing.url()).pathname).toBe('/billing');
      expect(new URL(billing.url()).searchParams.get('utm_source')).toBe('oauth_connect');
      await expect(billing.getByRole('button', { name: /Start \d+-Day Free Trial/ })).toBeVisible();

      await page.waitForURL(/^https:\/\/chatgpt\.com\//);
      expect(hits).toHaveLength(1);
      expect((await redeem(client, hits[0].searchParams.get('code')!, verifier)).status).toBe(200);
    });
  });

  test.describe('email not confirmed yet', () => {
    test.beforeAll(async () => {
      expect(await control.post('/email-verification', { required: true })).toEqual({ required: true });
    });
    test.afterAll(async () => {
      await control.post('/email-verification', { required: false });
    });

    test('an unconfirmed account gets "Check your inbox", never the consent card, and stays on Hookpost', async ({ page }) => {
      await signUpViaApi(page.context());
      const client = await registerChatGpt();
      const hits = await stubChatGpt(page);

      await page.goto(consentUrl(client.client_id, pkce().challenge));
      // The hard gate (29 Oct 2026): nothing to authorize until the email is confirmed.
      await expect(page.getByTestId('email-verification-gate')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Authorize' })).toHaveCount(0);
      expect(hits).toHaveLength(0);
    });
  });
});
