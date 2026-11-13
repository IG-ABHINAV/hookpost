# Porting Hookpost billing to another product

How to give another product (Tablamigo next, any later app) the same billing behaviour as Hookpost. [SCENARIOS.md](SCENARIOS.md) is the contract: every `SC-` scenario must hold in the new product, with tests that carry the same ID. This file covers how to build it and which Hookpost code to read for each part. The last section is a recommendation on one shared payment service versus a module per product.

Written 2 Nov 2026 against `origin/main` at `ac5479f7c`. Tablamigo facts were read from `~/Desktop/tablamigo` (read-only) the same day.

---

## 1. The parts, in build order

| # | Part | What it does | Hookpost reference |
|---|---|---|---|
| 1 | State and policy (pure) | Turns stored facts into an account state and an access answer. No I/O. | `trial.policy.ts` (`PlanState`, `planLapsed`, `workspaceDisputed`, dunning), `billing.state.ts`, `razorpay.mapping.ts` (`paidThrough`, `isUnpaidTrial`, `canStillCharge`, `preChargeVerdict`, `missedEndEvent`, `planChangeDirection`, `unusedCreditMinor`, `mandateRules`) |
| 2 | Gates | One call per feature at use time, in every entry point | `apps/backend/src/services/auth/permissions/permissions.service.ts`, `subscription.service.ts` (`assertFreePostAllowed`), `trial.policy.ts` (`allowsVariableCostFeatures`, `allowsXPublishing`), orchestrator publish checks |
| 3 | Webhook handler | Verify, route, re-read, apply, send once | `apps/backend/src/api/routes/razorpay.controller.ts`, `RazorpayService.handleWebhook` |
| 4 | Customer actions | Checkout, cancel, reactivate, change plan, change method | `billing.controller.ts`; `RazorpayService.subscribe`, `cancelAtPeriodEnd`, `startReplacementMandate`, `prorate`, `undoScheduledPlanChange` |
| 5 | Plan-end timer | Ends the row and sends "plan ended" at `cancelAt` | `plan.end.timer.ts`, `apps/orchestrator/src/workflows/plan.end.workflow.ts` |
| 6 | Reconcile job | Hourly: catch lost webhooks, stop charges that shouldn't happen | `RazorpayService.onModuleInit` → `reconcileBilling`, `sweepMissedRefunds`, `endLapsedCancellations`, `armPlanEndTimers` |
| 7 | Refunds and disputes (admin) | Fee-deducting refund button, dispute lock, evidence pack, restore | `refunds.service.ts`, `RazorpayService.handleDispute`, `dispute.evidence.ts`, `admin.plan.actions.service.ts` |
| 8 | Emails and owner alerts | One template per event, send-once keys | `billing.emails.ts`, `owner.sales.alert.service.ts`, `docs/billing-emails.md` |
| 9 | Test harness | Unit + integration with a fake gateway + sandbox against gateway test mode | `tests/integration/setup/fake.razorpay.ts`, `tests/e2e/billing-sandbox/`, `ops/sandbox/` |

Build 1 and 2 first and test them in isolation. Every later part only writes facts that 1 reads.

## 2. State machine

### Stored facts (the minimum)

Store facts, not states. The state is computed on read (part 1), so it can't go stale.

| Fact | Why |
|---|---|
| `gatewaySubscriptionId` (current) | Which mandate is this account's now. Events for any other id never change the plan (rule 4's superseded exception, retire-after-approval). |
| `cancelAt` (nullable) | The second access ends. The single source of truth for gates. |
| `paymentFailingSince` (nullable) | `dunning`. Set on the gateway's "retrying" event, cleared on a successful charge. |
| `disputedAt` (nullable) | `disputed`. Cleared only by an admin. |
| `isLifetime` | Never ended by a billing event. |
| `tier`, `period`, `currency` | The plan; currency locks while a plan is live. |
| Identity hashes (`BillingIdentity`: email identity, channel, VPA, card) | Once-per-person offer and trial. Hashes only. |
| Trial used / offer used | Spent at approval, not at checkout. |

### Normalised events

Write handlers against these, then map each gateway's events onto them. The Hookpost column is what the code handles today. The Play column is my mapping for Tablamigo's Android subscriptions (from Play's RTDN types, not yet built or tested); check it against Google's current docs when porting.

| Normalised event | Transition (SC) | Razorpay | Google Play (RTDN) |
|---|---|---|---|
| `started` | `none` → `active`, or `trialing` with a first charge ahead (SC-01, SC-02) | `subscription.authenticated` / `.activated`; checkout handshake | `SUBSCRIPTION_PURCHASED` |
| `charged` | → `active`, clears dunning (SC-04) | `subscription.charged` | `SUBSCRIPTION_RENEWED`, `SUBSCRIPTION_RECOVERED` |
| `payment_failing` | → `dunning`, variable-cost features off (SC-03, SC-04) | `subscription.pending` | `SUBSCRIPTION_IN_GRACE_PERIOD` |
| `halted` | → `none` now (SC-03, SC-05) | `subscription.halted` | `SUBSCRIPTION_ON_HOLD` |
| `cancelled_by_customer` | → `cancelling` to the paid end (SC-16) | `subscription.cancelled` not started by us | `SUBSCRIPTION_CANCELED` |
| `paused_by_customer` | cancel at the gateway, keep paid time (SC-16) | `subscription.paused` | `SUBSCRIPTION_PAUSED`. Better: turn pause off on the base plan |
| `restarted` | `cancelling` → `active` (SC-09) | (Reactivate opens a new mandate) | `SUBSCRIPTION_RESTARTED` |
| `refunded` | → `none` now (SC-10) | `refund.processed` | `SUBSCRIPTION_REVOKED`, `voidedPurchaseNotification` (refund) |
| `disputed` | → `disputed` now (SC-13) | `payment.dispute.*` | `voidedPurchaseNotification` (chargeback) |
| `ended` | → `none` (SC-08) | `subscription.completed` / `.expired` | `SUBSCRIPTION_EXPIRED` |

Customer actions are events too. Our own `cancel` → `cancelling`. `upgrade` → `active` on the new plan now (SC-17). `downgrade` → scheduled at the paid end (SC-18).

**Where Play differs, so the product spec has to say so:**
- Google charges and refunds. "Refund minus our fee" (SC-10) applies only to payments we take through our own gateway, because a Play refund is whole.
- Play keeps access to expiry on CANCELED by itself, and its grace period length is set in the Play Console, not by us.
- Upgrade and downgrade are Play replacement modes (prorated now, or deferred to renewal), which match SC-17 and SC-18 in effect.

## 3. Webhook handler contract

Every product's billing webhook must do these, in this order:

1. **Verify the signature on the raw body** before parsing anything. Bad or missing → 400, nothing written (`razorpay.controller.spec.ts`).
2. **Route by product.** On a shared gateway account, only act on objects stamped with this product (`notes.service`). A refund carries no notes, so the payment's notes decide (`tablamigo.forward.ts`, `eventService`). Ignore anything else with 200 so the gateway stops retrying.
3. **Treat the event as a nudge: re-read the object from the gateway** before acting. That makes forged-but-signed payloads, out-of-order delivery and stale payloads harmless (Tablamigo already does this).
4. **Positively identify the account:** the gateway id must match the stored `gatewaySubscriptionId`, or a known superseded one. No match means no action and no email.
5. **Apply idempotently:** upserts for entitlements, a send-once key per email (`<kind>:<event or object id>`), a separate key per owner alert. A replay changes nothing.
6. **Never move backwards:** a late event can't undo a newer state. Examples: `pending` after `charged`, an old `activated` after a cancel, an event for the mandate a plan change replaced.
7. **Gateway unreadable → 5xx**, so the gateway redelivers. Never guess and never write the event off.
8. **Return fast.** Slow side work (forwarding, analytics) is fire-and-forget and can't fail the response.

## 4. Reconcile job contract

One hourly job, in the repo and installed by the repo (owner rule, 29 Oct: no hand-made crontab). Hookpost runs it in-process where `RUN_CRON=true`, on the shared hourly DB slot. It must:

- **Replay lost webhooks with the same handler** the webhook would have used: refunds of the last 3 days; `cancelled`/`completed`/`expired` 1 h after `ended_at`; `halted` at once; `paused`; a charge after cancel; a first debit that never landed after 7 days.
- **Stop charges that shouldn't happen ("charge roka"):** if our row is ending or ended but the gateway can still charge within 48 h, cancel at the gateway, keep paid access, send one email and one owner alert. Retry refused cancels on a backoff.
- **Report, don't act, in the other direction:** a gateway charging an account with no live row here, or a gateway finished while our row is live, goes to the owner as a mismatch.
- **Be safe in several processes at once and on a failed read:** a read that fails skips that account; a lock or an idempotent write means two runs do the work once.
- **Re-arm lost plan-end timers.**
- **Support a dry run** that lists what it would do.

## 5. Plan-end timer

The contract is set by the owner's no-gap rule: gates already refuse from `cancelAt` (rule 2), and the timer only closes the row and sends "plan ended" at that second.

- One timer per account, keyed by account id. Writing a new `cancelAt` replaces it, and clearing `cancelAt` stops it.
- On waking, it re-reads the row and does nothing if the date moved or the plan already ended, so a duplicate or stale timer is harmless.
- It runs the reconcile job's own end-of-plan code for that one account; never a second implementation.
- If the timer system is down, the hourly job ends the row and re-arms the timer.

Hookpost uses Temporal (`planEndWorkflow`, `TERMINATE_EXISTING` / `USE_EXISTING`). A product without Temporal (Tablamigo has none) can use a `plan_end_at` column plus a once-a-minute job in its existing in-repo scheduler (`apps/api/src/lib/scheduler.ts`) that ends due rows. That gives minute precision, and access is exact anyway because gates read `cancelAt`.

## 6. Gates

- **One pure function answers "may this account use feature F now?"** from the stored facts and `now`. Every entry point calls it at use time: web API, background jobs (publishing, autopost), public API keys, MCP/agents.
- **Feature classes:** everything; variable-cost (off in `dunning` and in a cancelled unpaid trial); and the no-plan perk (free posts in Hookpost).
- **Fail-open on an unreadable date, fail-closed on money.** A row the gate can't parse doesn't lock a paying customer. A gateway it can't read never grants a discount or a currency.
- Hookpost lesson: entry points added later are where gates are missed. Two of them came up in the 2 Nov red team. MCP `ask_hookpost` was fixed in #124. Autopost AI after the plan ends is still open. List every entry point when porting.

## 7. Test harness

The same three layers in every product. Name tests after the scenario (`SC-10 refund ends the plan now`) so the coverage table in SCENARIOS.md can be checked with grep.

| Layer | Must have |
|---|---|
| Unit | The pure policy and mapping functions, every edge (clock edges at `cancelAt` ±1 s, rounding, unknown method, unreadable date). The webhook handler with a faked gateway client: every SC row, replay, out-of-order. |
| Integration | The real app module against a real DB and Redis, with an in-process fake gateway that can be told to be `unavailable` (503) or to `refuseCancel` (Hookpost: `tests/integration/setup/fake.razorpay.ts`). Signed webhooks go in through HTTP. |
| Sandbox e2e | The real build against the gateway's test mode with its own DB, paying through the real checkout (Hookpost: `ops/sandbox/` up/down, `tests/e2e/billing-sandbox/billing-e2e.ts`). Torn down after testing, recreated with one command. |
| Feature switches | Every switch (trial on/off, USD on/off) runs both ways (`SANDBOX_TRIAL_CHECKOUT=on|off`). |
| Break-it | Before the PR: forged/replayed webhooks, IDOR on another account, double submit, tampered plan or amount, race at plan end, refund-then-cancel, cancel-then-resubscribe, missing webhooks. A failing test for each hole, then the fix. |

## 8. Porting checklist

- [ ] The stored facts of section 2 exist (migration, safe on prod data)
- [ ] The pure state and gate functions exist, with unit tests for every SC row that applies
- [ ] Every entry point calls the gate
- [ ] The webhook follows section 3, with the product stamped on every gateway object it creates
- [ ] The reconcile job follows section 4, is installed by the repo and is dry-run tested
- [ ] The plan-end timer follows section 5
- [ ] Admin refund with the fee deducted by default, and the dispute lock and restore
- [ ] Emails: one per event, send-once keys, the copy reviewed against SCENARIOS.md
- [ ] Terms and refund page: "on request, at our discretion, less the gateway fee"
- [ ] The three test layers, sandbox scenarios for every SC that test mode can reach
- [ ] SCENARIOS.md gets a column or note for the new product's differences

**Tablamigo today** (read 2 Nov, not tested). It takes Razorpay subscriptions and one-time Trip Passes, plus Google Play subscriptions. Plus is derived on read (`plus_until` from live subscriptions, passes and comps in `lib/play.ts`), which already matches "facts, not states". Its Razorpay events come through Hookpost's forward (`lib/razorpay-webhook.ts`), and handlers re-read from Razorpay and are idempotent. I found no handling of `payment.dispute.*` (SC-13–15), and no reconcile job for Razorpay (SC-21). That matters more there than in Hookpost, because a forward that fails is only logged on Hookpost's side.

**Tablamigo chargebacks very likely reach nobody today** (from reading the code, not tested). A dispute event carries no `notes.service` on the dispute, and a subscription charge's payment carries no notes either. `isTablamigoEvent` (`tablamigo.forward.ts`) looks up the payment only for refunds, so the event is not forwarded. Hookpost's `handleDispute` then finds the subscription isn't Hookpost's and leaves it. Tablamigo's port of SC-13 must include getting dispute events to it, whether by forward or by its own webhook.

---

## 9. Separate payment service, or a module per product?

**Recommendation: a module per product, held to this one spec. Don't build a shared payment service at our scale.** One exception: fix the webhook ingress (below) now.

### The facts behind it

- **Volume:** 33 payments in total on the shared Razorpay account as of 29 Oct 2026, none international, and about ₹26 in lifetime gateway fees (Razorpay snapshot and second-gateway report). Two products bill today (Hookpost, Tablamigo); VetNow shares the account.
- **Different stacks:** Hookpost is NestJS + Prisma + Temporal + Jest. Tablamigo's API is Fastify + postgres.js + Vitest, with no Temporal, and its Android app must sell through Google Play Billing.
- **The isolation rule (AGENTS.md):** each product owns its own process, database and admin panel, and must be movable to another server on its own. The shared Razorpay account is already listed as something to split at the GCP move.
- **Size:** Hookpost's billing is about 11,500 lines of service and pure rules (`razorpay.service.ts` 8,884, `razorpay.mapping.ts` 1,284, `trial.policy.ts` 1,366), plus the tests. Much of that is Hookpost-specific: free posts, channels as identity, AI/X as the variable-cost features, marketplace, Gumroad.

### Trade-offs

| | Shared payment service | Module per product (recommended) |
|---|---|---|
| One implementation of the hard parts (reconcile, refunds, disputes, plan changes) | Yes | No: each product ports them, and a fix must be ported too |
| Rules can't drift between products | Mostly, but product-specific rules still leak in as flags | Only with discipline: this spec, SC-named tests, a review that checks the spec |
| A second gateway (Cashfree) added once | Yes | Once per product, behind each product's `PaymentProvider` interface (planned in `~/ops-routines/reports/second-gateway-integration-plan.md`, not built) |
| New infrastructure to run and watch | A service, a DB, a deploy, uptime, secrets, for one person | None |
| Gates | A network hop, or a cached entitlement that can go stale: the exact lag the owner removed on 29 Oct | Local and synchronous; `cancelAt` is read at use time |
| Fits Play Billing and product-specific perks | Poorly: needs plug-ins or product `if`s | Naturally |
| Isolation rule | Breaks it: every product depends on one more shared box | Keeps it |
| Migration risk | Moving live Hookpost billing (prod, paying users) to a new service is the riskiest change we could make for the least customer benefit | None for Hookpost; Tablamigo grows into the spec |

Big companies run a central billing service because they have a team on it and many products on one ledger. We have neither yet. At 33 payments, the cost of a service (ops, migration risk, a new failure point) far outweighs the cost of porting a few hundred lines of rules per product. That last comparison is my judgment, not a measurement.

### What to share without a service

- **This spec and the SC IDs** are the shared contract. Tests in every product carry them.
- **The pure decision functions** are copied, with a header naming the Hookpost file and SC IDs as the source. If a third product starts billing, move them into a small private TypeScript package. They have no I/O, so they'll run in both stacks.
- **Later, a conformance fixture set:** JSON files of event sequences in, expected state, access and emails out. Each product runs them through its own handler. That's the cheapest way to prove the products agree.

### The exception: webhook ingress, worth fixing now

Today Hookpost holds the only Razorpay webhook and forwards Tablamigo's events fire-and-forget (5 s timeout, errors only logged, `tablamigo.forward.ts`). If Hookpost is down or deploying, Tablamigo silently misses billing events, and it has no reconcile job to catch them. Two ways out, either one enough:

1. **Give Tablamigo its own Razorpay webhook** for the account, verified with its own secret, keeping the `notes.service` filter. I believe Razorpay allows more than one webhook URL per account, but I didn't check the dashboard in this run; confirm under Dashboard → Webhooks first. This also gets ahead of the account split at the GCP move.
2. **Build Tablamigo's reconcile job (SC-21) first**, so a missed forward is caught within the hour either way. It must list disputes too (Razorpay's disputes API), because dispute events aren't forwarded today (section 8).

My order: 2 now (it's needed anyway), then 1 at the GCP move.

### When to revisit

Build a shared service only if one of these becomes true (my thresholds, a judgment call):
- a third product starts billing on the same account;
- the second gateway goes live in two products at once;
- billing becomes someone's full-time job (roughly 1,000+ live subscriptions across products).
