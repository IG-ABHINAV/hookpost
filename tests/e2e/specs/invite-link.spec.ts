/**
 * Team invite links in the browser (25 Oct 2026).
 *
 * Before: the emailed /?org=<token> opened signed out showed the homepage
 * and kept nothing: Cloudflare caches "/" for signed-out visitors with the
 * query string ignored, so the proxy never saw the request. An invitee who
 * then signed up never joined the team. A signed-in account that had not
 * confirmed its email was sent to /?added=true without being added.
 *
 * Now the email links to /invite/<token> (never edge-cached), and the
 * homepage itself moves an old /?org= link there, which works on a cached
 * copy too: the "cached homepage" test below serves "/?org=..." from the
 * bare homepage's HTML, as Cloudflare does, and the invite still arrives.
 * Confirmation is required here, as in production
 * (POST /email-verification on the control port).
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { sign } from 'jsonwebtoken';
import { BACKEND, PASSWORD, acceptInviteViaApi, api, control, failOnServerErrors, signInContext, uniqueEmail } from './support';

let teams = 0;

/** The `auth` cookie of a context, for API calls as that user. */
async function authOf(context: BrowserContext) {
  return (await context.cookies()).find((c) => c.name === 'auth')?.value;
}

async function register(email: string, company: string) {
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, company, provider: 'LOCAL' }),
  });
  expect(res.status).toBe(200);
  const auth = res.headers.getSetCookie().find((c) => c.startsWith('auth='))!.split(';')[0].slice(5);
  return decodeURIComponent(auth);
}

/** Uses the newest "Confirm your email" link sent to `email`, as its owner would. */
async function confirm(email: string, auth: string) {
  await expect.poll(async () => (await control.emails()).filter((m) => m.to === email).length).toBeGreaterThan(0);
  const mail = (await control.emails()).filter((m) => m.to === email && /Confirm your email/.test(m.subject)).at(-1)!;
  const code = new URL(/href="([^"]*\/auth\/activate\/[^"]+)"/.exec(mail.html)![1]).pathname.split('/').pop()!;
  expect((await api(auth, 'POST', '/auth/activate', { code })).body).toEqual({ can: true });
}

/** A confirmed owner of a Pro workspace with its own name, and an invite link into it. */
async function teamWithInvite() {
  const team = `Invite Team ${Date.now().toString(36)}${teams++}`;
  const email = uniqueEmail('team-owner');
  const auth = await register(email, team);
  await confirm(email, auth);
  await control.givePlan(email, 'PRO');
  const invite = await api<{ url: string }>(auth, 'POST', '/settings/team', { role: 'USER', sendEmail: false });
  expect(invite.status).toBe(201);
  const url = new URL(invite.body.url);
  expect(url.pathname).toMatch(/^\/invite\/[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(url.search).toBe('');
  const orgId = (await api(auth, 'GET', '/user/self')).body.orgId as string;
  return { team, orgId, path: url.pathname, token: decodeURIComponent(url.pathname.split('/')[2]) };
}

/** The workspaces `auth` belongs to. */
async function workspacesOf(auth: string) {
  return ((await api<{ id: string }[]>(auth, 'GET', '/user/organizations')).body || []).map((o) => o.id);
}

async function signUpInBrowser(page: Page, email: string) {
  await page.getByPlaceholder('Email Address').fill(email);
  await page.getByPlaceholder('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.waitForURL(/\/launches/);
}

test.beforeAll(async () => {
  expect(await control.post('/email-verification', { required: true })).toEqual({ required: true });
});
test.afterAll(async () => {
  await control.post('/email-verification', { required: false });
});

test.describe('signed out', () => {
  test('the emailed /invite/ link: the sign-up page names the team; a password sign-up is held, then joined by its confirmation', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { team, orgId, path, token } = await teamWithInvite();

    await page.goto(path);
    await page.waitForURL(/\/auth\?invite=1$/);
    await page.waitForLoadState('networkidle');
    const notice = page.getByTestId('invite-notice');
    await expect(notice).toHaveText(`You've been invited to join ${team}. Create your account to join, or sign in if you already have one.`);
    await expect(notice.locator('a')).toHaveCount(0);
    // The token is in an httpOnly cookie, nowhere a script could read it.
    expect(page.url()).not.toContain(token);
    expect(await page.evaluate(() => document.cookie)).not.toContain(token);
    expect(await page.evaluate(() => document.referrer)).not.toContain(token);
    const cookie = (await context.cookies()).find((c) => c.name === 'org');
    expect(cookie).toMatchObject({ value: token, httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

    const email = uniqueEmail('invitee');
    await signUpInBrowser(page, email);
    expect(page.url()).not.toContain('added');
    // Held: the account is not confirmed yet, and the app says which team waits.
    // The whole app is "Check your inbox" until then (the hard gate), and it names the team.
    await expect(page.getByTestId('email-verification-gate')).toBeVisible();
    await expect(page.getByTestId('held-invite-notice').first()).toHaveText(`You've been invited to ${team}. Confirm your email to join.`);
    const auth = (await authOf(context))!;
    // The invite cookie was spent by the sign-up.
    expect((await context.cookies()).find((c) => c.name === 'org')).toBeUndefined();

    await confirm(email, auth);
    expect(await workspacesOf(auth)).toContain(orgId);
    errors.assertNone();
  });

  test('an old /?org= link served from a cached homepage still reaches the invite', async ({ page, context, request }) => {
    const errors = failOnServerErrors(page);
    const { team, token } = await teamWithInvite();

    // What Cloudflare has for "/": the bare homepage, cached once for every
    // query string. Signed out, the origin answers /?org= with that very
    // page too (no redirect, no cookie), so a cached copy is all there is.
    const bare = await request.get('/', { maxRedirects: 0 });
    expect(bare.status()).toBe(200);
    const cachedHtml = await bare.text();
    const origin = await request.get(`/?org=${token}`, { maxRedirects: 0 });
    expect(origin.status()).toBe(200);
    expect(origin.headers()['location']).toBeUndefined();
    expect(origin.headers()['set-cookie'] || '').not.toContain('org=');
    expect(await origin.text()).not.toContain(token);

    let servedFromCache = 0;
    await page.route(
      (url) => url.pathname === '/' && url.searchParams.has('org'),
      (route) => {
        servedFromCache++;
        return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: cachedHtml });
      }
    );
    // 'commit': the page sends itself on before it finishes loading.
    await page.goto(`/?org=${token}`, { waitUntil: 'commit' });
    await page.waitForURL(/\/auth\?invite=1$/);
    expect(servedFromCache).toBe(1);
    await expect(page.getByTestId('invite-notice')).toContainText(team);
    // The token left the address bar before anything recorded the landing.
    const attr = (await context.cookies()).find((c) => c.name === 'hp_attr');
    expect(decodeURIComponent(attr?.value || '')).not.toContain(token);
    expect(await page.evaluate(() => document.referrer)).not.toContain(token);
    errors.assertNone();
  });

  test('an existing account signs in from the invite page: joined, told so, and in that team', async ({ page, context }) => {
    const { team, orgId, path } = await teamWithInvite();
    const email = uniqueEmail('existing-member');
    const auth = await register(email, 'Own Workspace');
    await confirm(email, auth);

    await page.goto(path);
    await page.waitForURL(/\/auth\?invite=1$/);
    await page.getByRole('link', { name: 'Sign In', exact: true }).click();
    await page.waitForURL(/\/auth\/login/);
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('invite-notice')).toHaveText(`You've been invited to join ${team}. Sign in to join.`);
    await page.getByPlaceholder('Email Address').fill(email);
    await page.getByPlaceholder('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(/\/launches/);
    // Named, so joining is never silent about whose team this is.
    await expect(page.getByText(`You've joined ${team}.`)).toBeVisible();
    expect(await workspacesOf(auth)).toContain(orgId);
    expect((await context.cookies()).find((c) => c.name === 'showorg')?.value).toBe(orgId);
    // Said once: a reload does not say it again.
    await page.reload();
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(`You've joined ${team}.`)).toHaveCount(0);
  });

  test('a forged, expired or malformed link says so and keeps nothing', async ({ page, context }) => {
    const { orgId } = await teamWithInvite();
    const forged = sign({ purpose: 'team-invite', orgId, id: 'forge', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
    await page.goto(`/invite/${forged}`);
    await page.waitForURL(/\/auth\?invite=1$/);
    await expect(page.getByTestId('invite-notice')).toHaveText(/This invite link has expired or was already used/);

    await context.clearCookies();
    await page.goto('/invite/not-a-token');
    await page.waitForURL(/\/auth\?invite=invalid$/);
    await expect(page.getByTestId('invite-notice')).toHaveText(/This invite link has expired or was already used/);
    expect((await context.cookies()).find((c) => c.name === 'org')).toBeUndefined();
  });

  test('open-redirect attempts through the invite flow stay on this site', async ({ page, baseURL }) => {
    const { path } = await teamWithInvite();
    for (const attempt of [
      '/invite/%2F%2Fevil.example',
      '/invite/https:%2F%2Fevil.example',
      '/invite//evil.example',
      `${path}?returnUrl=https://evil.example&next=//evil.example`,
      '/?org=%2F%2Fevil.example',
      '/?org=https%3A%2F%2Fevil.example',
      '/auth?org=//evil.example',
    ]) {
      await page.context().clearCookies();
      await page.goto(attempt, { waitUntil: 'commit' });
      await page.waitForURL(/\/auth(\/login)?\?invite=(1|invalid)$/);
      expect(new URL(page.url()).origin, attempt).toBe(new URL(baseURL!).origin);
      expect(page.url(), attempt).toMatch(/\/auth(\/login)?\?invite=(1|invalid)$/);
    }
  });
});

test.describe('signed in: asked first, joined only by the Join button', () => {
  test('an unconfirmed account opening the link: not asked, sent to "Check your inbox"; once confirmed, the link asks and Join joins', async ({ page, context }) => {
    const { team, orgId, path } = await teamWithInvite();
    const email = uniqueEmail('signed-in-pending');
    const auth = await register(email, 'Pending Workspace');
    await signInContext(context, auth);

    const visited: string[] = [];
    page.on('request', (r) => r.isNavigationRequest() && visited.push(r.url()));
    await page.goto(path);
    await page.waitForURL(/\/launches$/);
    await expect(page.getByTestId('email-verification-gate')).toBeVisible();
    expect(visited.join(' ')).not.toContain('added');
    await expect(page.getByText(/You've joined/)).toHaveCount(0);

    await confirm(email, auth);
    expect(await workspacesOf(auth)).not.toContain(orgId);
    await page.goto(path);
    await page.waitForURL(/\/invite$/);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${team}?`);
    await page.getByRole('button', { name: 'Join team' }).click();
    await expect.poll(async () => workspacesOf(auth)).toContain(orgId);
  });

  test('a confirmed account opening an old /?org= link: asked, joins on Join and is told so', async ({ page, context }) => {
    const { team, orgId, token } = await teamWithInvite();
    const email = uniqueEmail('signed-in-confirmed');
    const auth = await register(email, 'Confirmed Workspace');
    await confirm(email, auth);
    await signInContext(context, auth);

    await page.goto(`/?org=${token}`, { waitUntil: 'commit' });
    await page.waitForURL(/\/invite$/);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${team}?`);
    expect(await workspacesOf(auth)).not.toContain(orgId);
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(`You've joined ${team}.`)).toBeVisible();
    expect(await workspacesOf(auth)).toContain(orgId);

    // The same link again: already a member, said on the question itself.
    await page.goto(`/invite/${token}`);
    await page.waitForURL(/\/invite$/);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`You're already a member of ${team}.`);
    await page.getByRole('button', { name: 'Open team' }).click();
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(`You're already a member of ${team}.`)).toBeVisible();
  });

  test('a link someone else already used: not asked, told it is spent, nothing joined', async ({ page, context }) => {
    const { orgId, path, token } = await teamWithInvite();
    const firstEmail = uniqueEmail('first-user');
    const first = await register(firstEmail, 'First Workspace');
    await confirm(firstEmail, first);
    expect((await acceptInviteViaApi(first, token)).body.invite).toBe('joined');

    const email = uniqueEmail('second-user');
    const auth = await register(email, 'Second Workspace');
    await confirm(email, auth);
    await signInContext(context, auth);
    await page.goto(path);
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(/That invite link has expired or was already used/)).toBeVisible();
    expect(await workspacesOf(auth)).not.toContain(orgId);
  });
});
