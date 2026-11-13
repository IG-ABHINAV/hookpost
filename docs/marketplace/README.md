# Hookpost on api.market

Four products, each its own api.market Source and OpenAPI file. Buyers never get a Hookpost key: api.market forwards each call with our shared secret, and the first call of a subscriber creates an isolated workspace for them (no users, no API key, a plan row `apimkt:<product>:<subscriber>`).

| Product | Base URL (Source) | Spec | Call that needs nothing connected |
|---|---|---|---|
| Hookpost Social Scheduler API | `https://hookpost.hookstep.in/api/mkt/v1/social` | `social-scheduler.openapi.json` | `GET /providers` |
| LinkedIn Carousel & Post API | `https://hookpost.hookstep.in/api/mkt/v1/linkedin` | `linkedin-carousel.openapi.json` | `POST /carousels/render` |
| X Thread API | `https://hookpost.hookstep.in/api/mkt/v1/x` | `x-threads.openapi.json` | `POST /threads/estimate` |
| Social Post Validator API | `https://hookpost.hookstep.in/api/mkt/v1/validate` | `post-validator.openapi.json` | `GET /rules` |

`probe.openapi.json` is for a private plan only (see "Before launch").

Code: `apps/backend/src/marketplace-api` (routes, gateway middleware, ledger), `libraries/nestjs-libraries/src/marketplace` (plans, credits, validator rules: the one source of truth for prices and limits), `libraries/nestjs-libraries/src/database/prisma/marketplace` (accounts, daily sweep). Regenerate the specs with `node scripts/marketplace/build-openapi.mjs` after a route change.

## How a call is trusted

1. `x-hookpost-gateway`: the Source's API-key auth. Must match `MKT_GATEWAY_SECRETS_<PRODUCT>` (401 otherwise). This is the only proof that a call came through api.market: api.market sends no secret or signature of its own, and its egress addresses (seen: several in OVH US 40.160.0.0/16) are neither documented nor exclusive to it, so no IP allowlist.
2. The plan, trusted only after step 1:
   - `x-hookpost-plan` (optional): a random token in a plan's custom headers. Its sha256 in `MKT_PLAN_TOKEN_HASHES` names the plan. A token that resolves wins.
   - Otherwise `x-magicapi-plan`, api.market's own plan title, mapped in `MAGICAPI_PLAN_NAMES` (marketplace.gateway.ts), ignoring case and extra whitespace. Social: "Free" -> trial (api.market's name for a free plan; the old title "Free trial" also maps to trial while the plan is renamed), "Standard" -> standard, "Pro" -> pro, and "Tester" (api.market's private plan for its review team) -> pro. So Social plans need no custom headers.
   - api.market confirmed in writing (support, Shashank, 26 Oct 2026) that it always overwrites `x-magicapi-plan` and `x-magicapi-user` before forwarding, so a buyer cannot spoof either header.
   - Neither names a plan of this product: 403 `unknown_plan` (the log line shows the plan name received). A token that is sent but names nothing falls back to the plan name and logs `plan_token_unknown`, so revoking a Social plan means removing its name from `MAGICAPI_PLAN_NAMES`. Renaming a plan on api.market, or another private plan, needs an entry in `MAGICAPI_PLAN_NAMES` or a plan token.
3. `x-magicapi-user`: api.market's subscriber id (400 unless a cuid).
4. Any `Authorization` header is refused (400): a Hookpost key must never pass through api.market, which keeps request logs.

Every 200 carries `X-Magicapi-Billing: API=<credits>;`; everything else is `API=0;` and api.market bills only 200s.

## Other marketplaces: one gateway, one adapter each

The same four products, routes, plans, limits and workspaces serve every marketplace. What differs is in `libraries/nestjs-libraries/src/marketplace/marketplace.adapters.ts`: how the marketplace proves a call came through it, how it names the buyer and the plan, and how it wants usage reported. A call is handled by the one adapter whose marker header it carries; a call carrying two marketplaces' markers is refused (401), and one carrying none gets api.market's 401 as before.

| Marketplace | Proof (marker) | Buyer | Plan | Usage report | Base URL |
|---|---|---|---|---|---|
| api.market (`API_MARKET`) | `x-hookpost-gateway` = `MKT_GATEWAY_SECRETS_<PRODUCT>` | `x-magicapi-user` | plan token or `x-magicapi-plan` | `X-Magicapi-Billing: API=N;` | `/api/mkt/v1/<product>` |
| RapidAPI (`RAPIDAPI`) | `X-RapidAPI-Proxy-Secret` = `MKT_RAPIDAPI_SECRETS_<PRODUCT>` (one RapidAPI API per product, each with its own secret) | `X-RapidAPI-User` | `X-RapidAPI-Subscription`: BASIC trial, PRO first paid plan, ULTRA/MEGA top plan (`MKT_RAPIDAPI_PLANS` overrides) | `X-RapidAPI-Billing: Credits=N` (a custom quota object "Credits" on the plans) | same |
| Any other (`MKT_KEYED_MARKETPLACES`) | `x-hookpost-marketplace: <name>` + `x-hookpost-marketplace-key` = `MKT_KEYED_<NAME>_SECRETS_<PRODUCT>` | the header in `_USER_HEADER` (none: validator only, one shared subscriber) | `_PLAN_HEADER` + `_PLANS`, or `_DEFAULT_PLAN_<PRODUCT>` | `_BILLING_HEADER: N`, or none | same |

- One buyer id on two marketplaces is two accounts and two workspaces (`MarketplaceAccount.marketplace`); outside api.market the plan row is `apimkt:<product>:<marketplace>:<buyer>` and Redis idempotency keys carry the marketplace too. RapidAPI sets no retry id of its own, so a buyer's `x-request-id` is ignored there; `Idempotency-Key` works everywhere.
- Every workspace has `Organization.source`: `DIRECT` for sign-ups on hookpost.hookstep.in, else the marketplace id. Calls are counted per marketplace, product and UTC day in `MarketplaceUsageDay` (in memory, added every 15 s). Both show on the super-admin page `/admin/marketplaces` (and the source split on `/admin/users`).
- Adding a marketplace: set its secrets in `.env` (backend and orchestrator) and restart; no code change unless it authenticates in a way none of the three adapters does.

## Plans (marketplace.plans.ts)

| Product | Plan id | Price | Credits / month | Channels |
|---|---|---|---|---|
| social | trial | $0, 7 days, hard limit | 10 (was 100 until 26 Oct 2026) | 1 (was 2), no X |
| social | standard | $19 | 500 | 5 |
| social | pro | $39 | 1,200 | 20 |
| linkedin | trial | $0, 7 days | 50 | 1 |
| linkedin | creator | $9 | 300 | 2 |
| linkedin | agency | $29 | 1,500 | 10 |
| x | trial | $0, 7 days | 50 (25 tweets, no links, 5 tweets a thread) | 1 |
| x | basic | $12 | 300 | 2 |
| x | pro | $35 | 1,000 | 5 |
| validate | trial | $0, 7 days | 200 | - |
| validate | starter | $5 | 5,000 | - |
| validate | scale | $15 | 30,000 | - |

The Social trial is for testing, not free use (owner, 26 Oct 2026): 10 credits, 1 channel, 50 MB, 7 days, no X. A subscriber whose 28-day window began before 26 Oct 2026 09:00 UTC keeps the old 100 credits, 2 channels and 250 MB to the end of that window (`PRIOR_PLAN_LIMITS` and `planForWindow` in marketplace.plans.ts, applied by the gateway middleware); the next window has the new limits. A lowered limit never deletes anything: over the channel limit, new connects and posts answer 402 until a channel is removed; over storage, uploads answer 402.

Credits: 1 per channel a post goes to; X 2 per tweet, 20 per tweet with a link (refused unless `link_policy: "allow"`); 1 per carousel render or validator check; reads, uploads, connects and deletes 0. X bills us $0.015 a tweet and $0.20 with a link, so an X credit costs us $0.0075 or $0.01. `marketplace.plans.spec.ts` fails the build if a price stops covering the worst case: every credit on X links, our whole cap used in every window (2x the credits per 28 days, 2.17x a month), a 25% fee. At that worst case Social Standard keeps $3.38 a month, Social Pro $3.16, X Basic $2.48, X Pro $4.51.

## Setting up a product on api.market

1. Generate the product's secret and one token per plan, keep them out of chat and git:
   `openssl rand -hex 32` (secret), `openssl rand -base64 32` (each plan token).
2. Server `.env` (backend and orchestrator): `MKT_GATEWAY_SECRETS_<PRODUCT>="<secret>"` and add `<sha256 of token>=<product>:<plan>` to `MKT_PLAN_TOKEN_HASHES` (`printf %s "$TOKEN" | shasum -a 256`). Restart both.
3. Source: import the product's spec, base URL from the table, Authentication "API Key", header name `x-hookpost-gateway`, value the secret.
4. Each plan: billing unit "Per call" (our header sets the units), the included units = credits from the table, "Stop the calls" when they run out, every endpoint of the spec. Custom headers: none on a product listed in `MAGICAPI_PLAN_NAMES` (Social; the plan title must be one of the mapped names), otherwise `{"x-hookpost-plan": "<that plan's token>"}`.
5. Never reuse a token for another plan: subscribers stay on the plan version they bought, with its headers.

Secret rotation: put the new secret after the old one (`old,new`), update the Source, wait until `redis-cli --scan --pattern 'mkt:secrethits:<product>:<first 8 hex of sha256(old)>:*'` shows nothing for 7 days, then remove the old one.

## Before launch (per product)

A private free plan on a separate Source that imports `probe.openapi.json` (base URL of the product). Call `GET /_probe` through api.market and check: sending your own `x-hookpost-plan` must NOT come back as your value's hash (`x-magicapi-user` and `x-magicapi-plan` no longer need this check: api.market confirmed in writing on 26 Oct 2026 that it always overwrites both before forwarding, so a buyer cannot act as another subscriber or pick a plan); `?status=201` shows whether a 201 is billed; `?bill=5` whether the header is honoured (also past a hard limit); `authorization_present`; `x_magicapi_plan`; `client_ip` for a Cloudflare allowlist; and `header_names`, for anything that dates the subscriber's api.market month (if there is one, the quota window can start there instead of at the first call, and the paid cap can come down from 2x).

## Running it

- Kill switch: `MKT_DISABLED_PRODUCTS="x"` (backend and orchestrator) refuses calls (503) and publishes nothing of that product.
- Block one subscriber: `UPDATE "MarketplaceAccount" SET status = 'BLOCKED' WHERE "externalUserId" = '<id>' AND product = '<product>';` (gateway 403, orchestrator refuses its posts).
- Limits we hold ourselves (Redis): credits per 28-day window from the account's first call (a plan change starts a new one at 0): 2x the plan on a paid plan, because api.market's month starts on the subscription date, which it does not forward, so one window can hold the end of one paid month and the start of the next; 1.2x on a trial, which never renews. Past 1.2x a paid account is logged once per window: `mkt usage alert account=... used=... included=...` in the backend log (a buyer across a renewal, or api.market's counter missing calls). Then 50 X tweets a day per channel, YouTube 20 uploads a day across all subscribers (1 a day on a trial, 3 on paid), X trials together $3 a day (`MKT_TRIAL_X_DAILY_USD`), 2 writes and 10 reads a second per subscriber, storage 50 MB on the Social trial (250 MB on the other trials) / 2 GB / 10 GB, images 10 MB, videos 200 MB (95 MB through Cloudflare: larger ones via `/media/from-url`).
- Daily sweep (where `RUN_CRON=true`): accounts unseen for 40 days go DORMANT and their scheduled posts are cancelled (api.market sends no cancellation); media is removed 45 days after upload and carousel PDFs after 7, except files a scheduled post still uses.
