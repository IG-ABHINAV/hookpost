# Testing Hookpost

Four suites. Unit tests run on every pull request (`.github/workflows/build.yml`).

| Suite | What it exercises | Needs | Command (repo root) | Time |
|---|---|---|---|---|
| Unit, backend | services, controllers, providers, emails, scripts, orchestrator activities; everything mocked | nothing | `pnpm exec jest -c apps/backend/jest.config.ts --maxWorkers=2` | ~5 min |
| Unit, frontend | helpers, proxy, billing/paywall logic, SEO files, free tools (jsdom) | nothing | `pnpm exec jest -c apps/frontend/jest.config.ts --maxWorkers=2` | ~2 min |
| Integration | the real backend (`AppModule`) in-process over HTTP against Postgres and Redis | test stack | `pnpm exec jest -c tests/integration/jest.config.ts` | ~1 min |
| E2E | a browser against a production build of the frontend and the real backend | test stack, a frontend build, Chrome | `pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=1` | ~4 min (+ build) |

Plus `node --test tests/report/known-bugs.test.mjs scripts/disposable-domains/update.test.mjs`
for the report's and the disposable-domain list's own logic.

**On the development Mac, run every build and test through `~/.local/bin/heavy`**
(one at a time across all sessions; parallel builds rebooted the Mac twice on
22 Oct 2026), and keep `--maxWorkers=2` / `--workers=1`:

```
~/.local/bin/heavy pnpm exec jest -c apps/backend/jest.config.ts --maxWorkers=2
```

## The test stack (integration and E2E)

Postgres 16 on `127.0.0.1:55432` and Redis 7 on `127.0.0.1:56379`, separate
from the development containers so nothing touches local data. Either:

```
docker compose -f tests/stack/docker-compose.test.yaml up -d --wait   # and: down -v
tests/stack/native-stack.sh start                                     # no Docker: brew install postgresql redis
```

CI runs the same images as service containers on the same ports. Both suites
empty their database on every run (`prisma db push --force-reset`) and refuse
to start if `DATABASE_URL`/`REDIS_URL` point anywhere but localhost, so a
production URL in the shell can never be written to. Override the URLs with
`HOOKPOST_TEST_DATABASE_URL`, `HOOKPOST_E2E_DATABASE_URL` and
`HOOKPOST_TEST_REDIS_URL`.

What is faked, and where (everything else is the real code):

- **Temporal** (`tests/integration/setup/fake.temporal.ts`): no server or worker.
  Workflows the backend starts and emails it sends (they go out as a signal to
  `sendEmailWorkflow`) are recorded for the tests to read. Nothing publishes.
- **Razorpay** (`tests/integration/setup/fake.razorpay.ts`): an in-memory account
  behind `RazorpayClient.request`. Plans, customers, subscriptions, cancel and
  invoices behave; any call it does not know fails the test.
- **Resend** (`tests/integration/setup/fake.resend.ts`): the `resend` package
  itself, mapped in `tests/integration/jest.config.ts` (moduleNameMapper) and
  `tests/e2e/server/register.cjs`. The emails the backend sends straight
  through Resend (billing welcome / payment failed / trial ended, the support
  ticket and its auto-reply, `EMAIL_PROVIDER=resend`) are recorded and
  succeed; specs assert on them (`resendSendsTo()`, E2E `control.resendTo()`).
- **Gumroad** (`tests/integration/setup/fake.gumroad.ts`): a local HTTP server
  answering `POST /licenses/verify` and `GET /sales/:id` as Gumroad documents
  them; `GumroadClient.apiBase` points at it, so the real client runs. Tests
  add purchases with `addLicense()` and refund or cancel them by editing the
  returned purchase; the E2E backend serves `POST /gumroad/license` for that.
- **Google's signing certificates** for One Tap: `auth.int.spec.ts` gives
  google-auth-library one test RSA key, so it can check credentials that key
  signed (and refuse the rest) without fetching Google's.
- **Social networks**: only the token exchange (`authenticate`) of the provider
  under test, and in the browser the consent page.

Nothing else may leave the machine. `tests/integration/setup/network-guard.cjs`
refuses every connection to a host other than localhost (it patches
`net.Socket.prototype.connect`, which http, https, tls, fetch and ioredis all
end in). In the integration suite the test during which it happened fails
(`setup/after-env.ts`); the E2E backend records it, serves the list as
`GET /network` on its control port, and `tests/e2e/global-teardown.ts` fails the
run. A new outbound call in product code therefore shows up as a test failure
naming the host: fake that client, do not allow the host.

## Integration (`tests/integration`)

One file per area: auth, onboarding and plan states, billing and webhooks,
channels (connect URL per provider, callback, settings), posts (composer
actions, validation, IDOR), public API v1, team invites and seat limits,
workspace resources (media, webhooks, signatures, sets, autopost, settings),
OAuth provider and remote MCP, CLI / stdio MCP server / Node SDK / n8n node
against the real API, AI credits, enterprise endpoints, admin and
impersonation, public endpoints, activation and the API rate limit, health.

- `connect-first.int.spec.ts`: a workspace that has to start its trial
  connects one channel before it (PRE_TRIAL_CHANNEL_LIMIT): the link, the
  callback, two links, a double submit, a re-used custom-fields state, a
  second Bluesky connect through the POST handoff (402), the
  page pick (both routes) and reconnects; then every way to post or use AI
  without the trial (web, AI routes, copilot, PLAN_ACCESS routes, MCP, the
  public API) answers 402 or 401, and members, invitees, paid, locked and
  sunset workspaces get what they got before.
- `placeholder-sweep.int.spec.ts`: the unfinished-connect sweep
  (PLACEHOLDER_SWEEP) against real rows; only two-step logins nobody finished,
  older than 24 h, are removed, and never a Tumblr blog (its id can be the
  login's) or a LinkedIn Page row (its login id is a personal LinkedIn
  channel's id).
- `secure-cookies.int.spec.ts`: the backend with NOT_SECURED empty, as
  production runs it: every sign-in sets httpOnly, Secure, SameSite=Lax
  cookies and sends no token header; the cookie wins over a header, a
  readable session copy is set again httpOnly, impersonation starts and
  stops through the cookie only, and the first-touch copy (hp_attr_s) is
  locked down too (the rest of the suite uses NOT_SECURED).
- `session-expiry.int.spec.ts`: login sessions carry iat, a 30-day exp and a
  password stamp; one past exp, one without exp or one from before a
  password reset is refused with a 401; a day-old one is
  re-issued. Then one test each for what must not change: API keys (public
  API, MCP, the CLI), OAuth apps, /enterprise, invites and reset links,
  impersonation, the cookie the Play app uses, One Tap, preview links and
  Temporal. `AuthService.signSessionJWT(row, { issuedAt })` makes an older
  session.
- `signup-attribution.int.spec.ts`: the first-touch cookie (hp_attr) stored
  for email, Google, One Tap and GitHub sign-ups, Meta's CompleteRegistration
  (TrackService spied, nothing sent), the backend's HttpOnly copy of it
  (hp_attr_s, set by POST /public/t) standing in once Safari has dropped
  hp_attr, and the campaign report (GET /admin/attribution).
- `owner-sales-alerts.int.spec.ts`: the owner's sale alert
  (OWNER_SALES_ALERT_EMAIL) for signed webhooks: one email for a trial
  however often it is delivered (with the checkout handshake racing it),
  the first charge and a renewal, Cancel in Billing with the reason; none
  for a forged, unsigned or tampered webhook or another product's event;
  Resend down (`setResendFailure`) never fails the webhook and the queued
  alert goes out once it is back; a replayed live payload carries no card
  or UPI detail. `tests/e2e/specs/owner-alerts.spec.ts` does the trial,
  the cancel and the alert's admin link in the browser.

- `INTEGRATION_LOGS=1` shows the backend's own log.
- Tests named `BUG: ...` pin real product bugs found while writing the suite
  (`setup/known-bug.ts`). They are skipped so the nightly stays green; run them
  with `RUN_KNOWN_BUGS=1 pnpm exec jest -c tests/integration/jest.config.ts -t BUG:`
  to see whether a fix landed, then turn the fixed one into a normal `it`.
  Because a skipped test never fails a run, the nightly runs them once more
  (informational, never failing) and lists every one in the run summary with
  "still reproduces" or "test passes now" (`tests/report/known-bugs.mjs`).

## E2E (`tests/e2e`)

The frontend is built once with the E2E URLs baked in, into
`apps/frontend/.next-e2e` (never your `.next`):

```
node tests/e2e/build-frontend.cjs                       # after any frontend change
E2E_BROWSER_CHANNEL=chrome pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=1
```

`E2E_BROWSER_CHANNEL=chrome` uses the installed Google Chrome; without it run
`pnpm exec playwright install chromium` once. Playwright starts both servers
(backend on :53000, frontend on :54200) and stops them afterwards; outside CI
it reuses servers already listening (restart a backend started before
22 Oct 2026: it has no network guard or Resend fake). To start them by hand:

```
node -r ./tests/e2e/server/register.cjs tests/e2e/server/backend.ts
NEXT_DIST_DIR=.next-e2e ... next start -p 54200   # env: tests/e2e/frontend-env.cjs
```

The backend runs like production: secure httpOnly cookies, billing on, and a
trial cutoff, so a new workspace from India (Cloudflare's `cf-ipcountry`,
added by the specs) lands on the trial paywall. Razorpay's `checkout.js` is
replaced in the browser by a stand-in that completes the mandate with a
correctly signed response. A control port on `127.0.0.1:53001` (E2E only)
lets specs read sent emails (Temporal and Resend), started workflows, the fake
Razorpay account and refused outbound connections, give a workspace a plan
or a channel, and hand out a user's session as issued N days ago, or as a
token without exp (`control.session`, for `session-expiry.spec.ts`).

Reports: `test-results/e2e/report` (HTML, `pnpm exec playwright show-report
test-results/e2e/report`), `junit.xml`, and a trace for every failure.
`E2E_RESULTS_DIR` moves them.

Trial copy is matched as `\d+-day`, so the specs pass whatever the trial
length is.

`session-cookies.spec.ts` starts impersonation from /admin/users and stops it
from the banner, through the backend's httpOnly cookie. Chrome keeps one
cookie per name on localhost (`Domain=localhost` and a host-only cookie are
the same cookie), so a host-only copy next to a cookie on the registrable
domain, as on a real host, is tested in jsdom instead
(`apps/frontend/src/components/layout/session-cookies.spec.ts`).

`@playwright/test` (1.58.2) is in `pnpm-lock.yaml` as an auto-installed peer
of `@browserbasehq/stagehand`; with `node-linker=hoisted` it lands in the root
`node_modules`. Add it to the root `devDependencies` when the lockfile is next
regenerated, so the E2E suite does not depend on that peer.

## Writing tests

- Backend unit specs: `*.spec.ts` next to the code under `apps/backend/src`,
  `libraries/nestjs-libraries/src`, `apps/orchestrator/src` or `scripts/`.
- Frontend unit specs: `*.spec.ts` (no JSX) under `apps/frontend/src`; add
  `@jest-environment node` for anything that reads files or uses `Response`.
- Integration: `tests/integration/*.int.spec.ts`; `startApp()` boots the
  backend, `t.api.register()` gives a signed-in session, `setup/db.ts` arranges
  state the API cannot (a paid plan, a connected channel).
- E2E: `tests/e2e/specs/*.spec.ts`; `support.ts` signs up through the API for
  specs that are not about sign-up, and stubs what sits in front of production.
  `control.attribution(email)` reads a workspace's SignupAttribution row; the
  E2E backend fakes Google sign-in for codes starting `e2e-google-`.
- A test that finds a real bug: `knownBug('BUG: ...')` with a comment saying
  what is wrong, and report it. Do not fix product code in a test change.
- Except a security hole: the repository is public and the nightly lists
  every `BUG:` title in an open issue, so never pin one. Fix it first, or
  push the fix and its (normal) test together.
