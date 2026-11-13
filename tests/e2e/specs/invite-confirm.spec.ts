/**
 * The Join question for a signed-in visitor, in the browser (25 Oct 2026).
 *
 * Before: opening a team invite link while signed in joined at once, on the
 * GET (the proxy posted the token to /user/join-org). A link someone was
 * tricked into opening dropped them into a stranger's workspace; the toast
 * named the team, but the join had happened.
 *
 * Now /invite/<token> moves the token into the httpOnly invite_pending
 * cookie and shows /invite: "Join <team>? You were invited by <name>.
 * [Join team] [Not now]". Only the Join button's POST joins (JSON, from the
 * app's origin, naming the invite it showed). Below: what opening, reloading,
 * "Not now", a replay, another site's forms, fetches and frames, a second
 * link in another tab, a full team, a team that has to start its trial, and
 * markup in the names each do.
 */
import { BrowserContext, expect, Page, test } from '@playwright/test';
import { createHash } from 'crypto';
import { createServer, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { sign } from 'jsonwebtoken';
import { BACKEND, FRONTEND, PASSWORD, api, control, failOnServerErrors, signInContext, uniqueEmail } from './support';

let teams = 0;

/** Signs up through the API (no confirmation needed in this spec) and returns the session token. */
async function register(email: string, company: string) {
  const res = await fetch(`${BACKEND}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, company, provider: 'LOCAL' }),
  });
  expect(res.status).toBe(200);
  return decodeURIComponent(res.headers.getSetCookie().find((c) => c.startsWith('auth='))!.split(';')[0].slice(5));
}

/** A Pro team owned by someone named `ownerName`, and an invite link into it. */
async function teamWithInvite(opts: { team?: string; ownerName?: string } = {}) {
  const team = opts.team ?? `Confirm Team ${Date.now().toString(36)}${teams++}`;
  const ownerEmail = uniqueEmail('confirm-owner');
  const ownerAuth = await register(ownerEmail, team);
  await control.givePlan(ownerEmail, 'PRO');
  if (opts.ownerName !== undefined) await control.setUserName(ownerEmail, opts.ownerName);
  const invite = await api<{ url: string }>(ownerAuth, 'POST', '/settings/team', { role: 'USER', sendEmail: false });
  expect(invite.status).toBe(201);
  const path = new URL(invite.body.url).pathname;
  const orgId = (await api(ownerAuth, 'GET', '/user/self')).body.orgId as string;
  return { team, orgId, ownerEmail, ownerAuth, path, token: decodeURIComponent(path.split('/')[2]) };
}

/** A confirmed account signed in in `context`. */
async function signedIn(context: BrowserContext, tag: string) {
  const email = uniqueEmail(tag);
  const auth = await register(email, `${tag} own workspace`);
  await signInContext(context, auth);
  return { email, auth };
}

const workspacesOf = async (auth: string) =>
  ((await api<{ id: string }[]>(auth, 'GET', '/user/organizations')).body || []).map((o) => o.id);
const membersOf = async (ownerAuth: string) =>
  ((await api<{ users: unknown[] }>(ownerAuth, 'GET', '/settings/team')).body?.users || []).length;
const pendingCookie = async (context: BrowserContext) =>
  (await context.cookies()).find((c) => c.name === 'invite_pending');
/** The ref anyone holding a link can work out (invite.ref.ts): an attacker knows it. */
const refOf = (token: string) => createHash('sha256').update(token).digest('base64url').slice(0, 22);

async function openInvite(page: Page, path: string) {
  await page.goto(path);
  await page.waitForURL(/\/invite$/);
  await expect(page.getByTestId('invite-confirm-title')).toBeVisible();
}

test.describe('opening the link asks; only Join joins', () => {
  test('GET only: opening, reloading and revisiting the link joins nothing, and the token stays out of the page', async ({ page, context }) => {
    const errors = failOnServerErrors(page);
    const { team, orgId, ownerAuth, path, token } = await teamWithInvite({ ownerName: 'Priya Shah' });
    const me = await signedIn(context, 'get-only');

    await openInvite(page, path);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${team}?`);
    await expect(page.getByText(/^You were invited by/)).toHaveText('You were invited by Priya Shah.');
    await expect(page.getByRole('button', { name: 'Join team' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Not now' })).toBeVisible();
    // The token is only in an httpOnly cookie: not the address, a readable
    // cookie, the referrer or the page.
    expect(page.url()).not.toContain(token);
    expect(await page.evaluate(() => document.cookie)).not.toContain(token);
    expect(await page.evaluate(() => document.referrer)).not.toContain(token);
    expect(await page.content()).not.toContain(token);
    expect(await pendingCookie(context)).toMatchObject({ value: token, httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });

    for (let i = 0; i < 3; i++) {
      await page.reload();
      await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${team}?`);
    }
    await openInvite(page, path);
    await openInvite(page, '/invite');
    // GETs straight at the API, with the browser's cookies.
    for (const p of ['/user/invite', '/user/invite/accept', `/user/invite/accept?ref=${refOf(token)}`, `/user/join-org?org=${token}`]) {
      const res = await page.request.get(`${BACKEND}${p}`);
      expect([200, 404], p).toContain(res.status());
    }
    expect(await workspacesOf(me.auth)).not.toContain(orgId);
    expect(await membersOf(ownerAuth)).toBe(1);
    errors.assertNone();
  });

  test('Join joins once and says so; a replayed POST adds nothing; someone else replaying it is refused', async ({ page, context }) => {
    const { team, orgId, ownerAuth, path, token } = await teamWithInvite();
    const me = await signedIn(context, 'joiner');
    await openInvite(page, path);

    const posted = page.waitForRequest((r) => r.url() === `${BACKEND}/user/invite/accept` && r.method() === 'POST');
    await page.getByRole('button', { name: 'Join team' }).click();
    const request = await posted;
    expect(request.headers()['content-type']).toContain('application/json');
    expect(request.postDataJSON()).toEqual({ ref: refOf(token) });
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(`You've joined ${team}.`)).toBeVisible();
    expect(await workspacesOf(me.auth)).toContain(orgId);
    expect(await pendingCookie(context)).toBeUndefined();

    // The same request again, cookies and all, as a replay would send it.
    const replay = (auth: string) =>
      fetch(`${BACKEND}/user/invite/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: FRONTEND, cookie: `auth=${auth}; invite_pending=${token}` },
        body: request.postData()!,
      }).then((r) => r.json());
    expect(await replay(me.auth)).toEqual({ id: orgId, invite: 'member' });
    expect(await replay(me.auth)).toEqual({ id: orgId, invite: 'member' });
    const other = await register(uniqueEmail('replayer'), 'Replayer Co');
    expect(await replay(other)).toEqual({ id: null, invite: 'invalid' });
    expect(await workspacesOf(other)).not.toContain(orgId);
    expect(await membersOf(ownerAuth)).toBe(2);
  });

  test('Not now leaves the invite unused: the link asks again later, and Join then works', async ({ page, context }) => {
    const { team, orgId, path } = await teamWithInvite();
    const me = await signedIn(context, 'later');
    await openInvite(page, path);
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.waitForURL(/\/launches$/);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(/You've joined/)).toHaveCount(0);
    expect(await pendingCookie(context)).toBeUndefined();
    expect(await workspacesOf(me.auth)).not.toContain(orgId);

    await openInvite(page, path);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${team}?`);
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(`You've joined ${team}.`)).toBeVisible();
    expect(await workspacesOf(me.auth)).toContain(orgId);
  });
});

test.describe('another site cannot press Join for the visitor', () => {
  // The attacker's page comes from a real server on this machine: a page
  // Playwright fulfils itself counts as a public address, and Chrome's
  // local-network protection would then block its requests to localhost
  // before they reach the app, which would prove nothing about the app.
  // Another port of the same host is the same site (ports do not count),
  // like another *.hookstep.in host in production: the SameSite=Lax session
  // and question cookies go with its form posts. 127.0.0.1 is another site.
  let attackHtml = '';
  const servers: Server[] = [];
  let port = 0;
  test.beforeAll(async () => {
    const handler = (_req: unknown, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(attackHtml);
    };
    const v4 = createServer(handler);
    await new Promise<void>((resolve) => v4.listen(0, '127.0.0.1', resolve));
    port = (v4.address() as AddressInfo).port;
    servers.push(v4);
    // "localhost" may resolve to ::1 first.
    const v6 = createServer(handler);
    await new Promise<void>((resolve) => v6.once('error', () => resolve()).listen(port, '::1', resolve));
    servers.push(v6);
  });
  test.afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  });

  for (const host of ['localhost', '127.0.0.1']) {
    test(`auto-submitted forms, fetches and a frame from http://${host}:<another port>: nothing joined`, async ({ page, context }) => {
      const { orgId, ownerAuth, path, token } = await teamWithInvite();
      const me = await signedIn(context, 'csrf-victim');
      // The victim opened the attacker's invite link and has not answered.
      await openInvite(page, path);
      const ref = refOf(token);
      const accept = `${BACKEND}/user/invite/accept`;
      attackHtml = `<!doctype html><html><body>
        <iframe name="f1"></iframe><iframe name="f2"></iframe><iframe name="f3"></iframe>
        <iframe id="framed" src="${FRONTEND}/invite"></iframe>
        <form id="urlencoded" method="post" action="${accept}" target="f1"><input name="ref" value="${ref}"></form>
        <form id="plain" method="post" enctype="text/plain" action="${accept}" target="f2"><input name='{"ref":"${ref}","x":"' value='"}'></form>
        <form id="multipart" method="post" enctype="multipart/form-data" action="${accept}" target="f3"><input name="ref" value="${ref}"></form>
        <script>
          window.results = {};
          document.getElementById('urlencoded').submit();
          document.getElementById('plain').submit();
          document.getElementById('multipart').submit();
          fetch(${JSON.stringify(accept)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: ${JSON.stringify(ref)} }) })
            .then((r) => (window.results.cors = r.status), () => (window.results.cors = 'blocked'));
          fetch(${JSON.stringify(accept)}, { method: 'POST', mode: 'no-cors', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: ${JSON.stringify(ref)} }) })
            .then((r) => (window.results.noCors = r.type), () => (window.results.noCors = 'blocked'));
        </script></body></html>`;

      const answers: { status: number; type: string }[] = [];
      page.on('response', (r) => {
        if (r.url() === accept && r.request().method() === 'POST') {
          answers.push({ status: r.status(), type: r.request().headers()['content-type'] || '' });
        }
      });
      const framed = page.waitForResponse((r) => r.url() === `${FRONTEND}/invite`);
      await page.goto(`http://${host}:${port}/attack`);
      // The three forms and the no-cors fetch reach the backend; the CORS
      // fetch never leaves the browser (its preflight is refused).
      await expect.poll(() => answers.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
      await expect.poll(() => page.evaluate(() => (window as any).results?.cors)).toBe('blocked');
      // Same site: the session and question cookies came along, and the
      // backend refused the form itself (415). Another site: SameSite=Lax
      // kept the session cookie off, so there was no one signed in (401).
      const refused = host === 'localhost' ? 415 : 401;
      expect(answers.map((a) => a.status), JSON.stringify(answers)).toEqual(answers.map(() => refused));
      // Nothing JSON got through: the no-cors fetch went as text/plain.
      expect(answers.some((a) => a.type.startsWith('application/json')), JSON.stringify(answers)).toBe(false);

      // The question page will not render inside another site's frame.
      const frameResponse = await framed;
      expect(frameResponse.headers()['x-frame-options']).toBe('DENY');
      expect(frameResponse.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
      for (const frame of page.frames()) {
        const shown = await frame.locator('[data-testid="invite-confirm"]').count().catch(() => 0);
        expect(shown, frame.url()).toBe(0);
      }

      expect(await workspacesOf(me.auth)).not.toContain(orgId);
      expect(await membersOf(ownerAuth)).toBe(1);
      // The question is still there, unanswered, for the visitor to decide.
      expect((await pendingCookie(context))?.value).toBe(token);
      await openInvite(page, '/invite');
      await expect(page.getByRole('button', { name: 'Join team' })).toBeVisible();
    });
  }

  test('a second invite link opened in another tab: Join on the first page joins nothing until it shows the second', async ({ page, context }) => {
    const a = await teamWithInvite();
    const b = await teamWithInvite();
    const me = await signedIn(context, 'swap-victim');
    await openInvite(page, a.path);
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${a.team}?`);
    // A popup (or the attacker's own link) replaces the question cookie.
    const popup = await context.newPage();
    await openInvite(popup, b.path);
    await popup.close();

    await page.getByRole('button', { name: 'Join team' }).click();
    await expect(page.getByTestId('invite-confirm-title')).toHaveText(`Join ${b.team}?`);
    await expect(page.getByText(/A different invite was opened since this page loaded/)).toBeVisible();
    expect(await workspacesOf(me.auth)).not.toContain(a.orgId);
    expect(await workspacesOf(me.auth)).not.toContain(b.orgId);
    await page.getByRole('button', { name: 'Not now' }).click();
    await page.waitForURL(/\/launches$/);
    expect(await workspacesOf(me.auth)).not.toContain(b.orgId);
  });
});

test.describe('links and teams that cannot be joined', () => {
  test('a forged or expired link, signed in: never asked, told it is not valid, nothing joined', async ({ page, context }) => {
    const { orgId } = await teamWithInvite();
    const me = await signedIn(context, 'forged-victim');
    const forged = sign({ purpose: 'team-invite', orgId, id: 'forge', role: 'ADMIN', timeLimit: '2999-01-01 00:00:00' }, 'not-the-key');
    const expired = sign({ purpose: 'team-invite', orgId, id: 'old01', role: 'USER', timeLimit: '2020-01-01 00:00:00' }, 'not-the-key');
    for (const bad of [forged, expired]) {
      await page.goto(`/invite/${bad}`);
      await page.waitForURL(/\/launches$/);
      await expect(page.getByText(/That invite link has expired or was already used/)).toBeVisible();
      expect(await pendingCookie(context)).toBeUndefined();
    }
    // The question page itself, with nothing to ask about.
    await page.goto('/invite');
    await expect(page.locator('[data-invalid="true"]')).toContainText('This invite link has expired or was already used');
    await expect(page.getByRole('button', { name: 'Join team' })).toHaveCount(0);
    expect(await workspacesOf(me.auth)).not.toContain(orgId);
  });

  test('a full team: asked, then Join says there is no free seat, nobody added', async ({ page, context }) => {
    const { orgId, ownerEmail, ownerAuth, path } = await teamWithInvite();
    expect((await control.addSeats(ownerEmail, 14)).members).toBe(15);
    const me = await signedIn(context, 'seat-late');
    await openInvite(page, path);
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(/That team has no free seats/)).toBeVisible();
    expect(await workspacesOf(me.auth)).not.toContain(orgId);
    expect(await membersOf(ownerAuth)).toBe(15);
  });

  // needs_trial: a grandfathered team the Free plan sunset reached, which the
  // E2E backend makes of a fresh workspace whose plan is removed
  // (E2E_NEEDS_TRIAL_CUTOFF in server/backend.ts).
  test('a team that has to start its trial: Join says its plan has no team members, nobody added', async ({ page, context }) => {
    const { orgId, ownerEmail, ownerAuth, path } = await teamWithInvite();
    await control.removePlan(ownerEmail);
    expect((await api(ownerAuth, 'GET', '/user/self')).body.planState).toBe('needs_trial');
    const me = await signedIn(context, 'trial-gate');
    await openInvite(page, path);
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    await expect(page.getByText(/That team's plan doesn't include team members/)).toBeVisible();
    expect(await workspacesOf(me.auth)).not.toContain(orgId);
  });
});

test.describe('no open redirect, signed in', () => {
  test('whatever the link carries, every step stays on this site at a fixed path, Join included', async ({ page, context }) => {
    const { path, orgId } = await teamWithInvite();
    const me = await signedIn(context, 'redirect-victim');
    for (const attempt of [
      `${path}?returnUrl=https://evil.example&next=//evil.example&redirect=https:%2F%2Fevil.example`,
      '/invite/%2F%2Fevil.example',
      '/invite//evil.example',
      '/invite?returnUrl=https://evil.example',
      '/?org=%2F%2Fevil.example',
      '/launches?org=https%3A%2F%2Fevil.example',
    ]) {
      await page.goto(attempt, { waitUntil: 'commit' });
      await page.waitForURL(/\/(invite|launches)$|\/invite\?returnUrl/);
      expect(new URL(page.url()).origin, attempt).toBe(FRONTEND);
    }
    await openInvite(page, `${path}?returnUrl=https://evil.example&next=//evil.example`);
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    expect(new URL(page.url()).origin).toBe(FRONTEND);
    expect(await workspacesOf(me.auth)).toContain(orgId);
  });
});

test.describe('the page itself', () => {
  test('markup in the team and inviter names is shown as text, cut to 60 characters', async ({ page, context }) => {
    const team = `<img src=x onerror="window.__xss=1"><svg onload="window.__xss=2">${'X'.repeat(50)}`;
    const ownerName = '<script>window.__xss=3</script><a href="https://evil.example">Hookpost Support</a>';
    const { path } = await teamWithInvite({ team, ownerName });
    await signedIn(context, 'xss-victim');
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      d.dismiss();
    });
    await openInvite(page, path);
    const shown = page.getByTestId('invite-team');
    const text = (await shown.textContent())!;
    expect([...text]).toHaveLength(60);
    expect(text.startsWith('<img src=x onerror="window.__xss=1"><svg onload=')).toBe(true);
    expect(text.endsWith('\u2026')).toBe(true);
    expect(await shown.locator('*').count()).toBe(0);
    await expect(page.getByTestId('invite-inviter')).toHaveText(ownerName.slice(0, 59) + '\u2026');
    expect(await page.getByTestId('invite-confirm').locator('img, svg, script, a').count()).toBe(0);
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(dialogs).toEqual([]);
  });

  test('a Hindi team name is shown whole (vowel signs above the line are not cut)', async ({ page, context }, testInfo) => {
    const team = 'हिन्दी क्रिएटर्स की टीम';
    const { path } = await teamWithInvite({ team, ownerName: 'रवि' });
    await signedIn(context, 'hindi');
    await openInvite(page, path);
    await expect(page.getByTestId('invite-team')).toHaveText(team);
    await expect(page.getByTestId('invite-inviter')).toHaveText('रवि');
    // Nothing clips the title: its box is as tall as what it draws.
    const clipped = await page.getByTestId('invite-confirm-title').evaluate((el) => {
      const style = getComputedStyle(el);
      return style.overflow !== 'visible' || el.scrollHeight > el.clientHeight + 1;
    });
    expect(clipped).toBe(false);
    await page.getByTestId('invite-confirm').screenshot({ path: testInfo.outputPath('hindi-team.png') });
  });

  test('phone width: the question fits and both buttons work', async ({ page, context }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const { path, orgId } = await teamWithInvite({ ownerName: 'Ravi' });
    const me = await signedIn(context, 'phone');
    await openInvite(page, path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const name of ['Join team', 'Not now']) {
      const box = (await page.getByRole('button', { name }).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
      expect(box.height).toBeGreaterThanOrEqual(36);
    }
    await page.getByRole('button', { name: 'Join team' }).click();
    await page.waitForURL(/\/launches$/);
    expect(await workspacesOf(me.auth)).toContain(orgId);
  });
});
