# Billing test matrix

Every billing rule Hookpost runs, with the tests that hold it up. The product-agnostic version, by scenario, is `docs/billing/SCENARIOS.md`. First
written 29 Oct 2026 against `0c46c29d3`; rewritten 1 Nov 2026 against
`origin/main` once every billing branch of 29-31 Oct had merged (#68-#76,
#81, #88, #89, #93), by reading the code and running all three suites plus
the sandbox scenarios. Reviewed again on 2 Nov 2026 in the final architecture
review of the 29 Oct work (branch `review/final-architecture-2026-10-29`).

How to run what the Status column is based on (repo root, one at a time
through `~/.local/bin/heavy`; see `TESTING.md`):

```
pnpm exec jest -c apps/backend/jest.config.ts  --maxWorkers=2    # unit, backend + libraries
pnpm exec jest -c apps/frontend/jest.config.ts --maxWorkers=2    # unit, frontend
tests/stack/native-stack.sh start                                # Postgres :55432, Redis :56379
pnpm exec jest -c tests/integration/jest.config.ts               # integration (real AppModule)
node tests/e2e/build-frontend.cjs && E2E_BROWSER_CHANNEL=chrome \
  pnpm exec playwright test -c tests/e2e/playwright.config.ts --workers=1
```

Status words:

- **covered** — the rule has a spec that would fail if the rule broke.
- **partial** — some of the rule is pinned, a named part of it is not.
- **missing** — no test; a change to the code would go unnoticed.
- **failing** — a test exists and does not pass on `main` today.

The E2E column names Playwright specs (`tests/e2e/specs/`, a stand-in
`checkout.js` that signs a correct handshake) and sandbox scenarios `s0`-`s15` and `t1`-`t3`
(`tests/e2e/billing-sandbox/billing-e2e.ts`, run as its README says: the live release with its own DB
and Razorpay **test-mode** keys, paying through real Checkout; see
`ops/sandbox/README.md`).

Nothing in this matrix talks to a live-mode Razorpay account. Unit specs fake
`RazorpayClient.request`; the integration suite uses
`tests/integration/setup/fake.razorpay.ts` (with `unavailable` for 503s and
`refuseCancel` for refused cancels).

---

## 1. Free posts + abuse guard

New sign-ups get 3 free posts instead of a trial, once per person and once
per channel (`FREE_POST_LIMIT`, `freePostKey`, `emailIdentity`,
`disposableEmail` in
`libraries/nestjs-libraries/src/database/prisma/subscriptions/trial.policy.ts`;
`signupGetsFreePosts` in `organization.service.ts`; `assertFreePostAllowed`
and `freePostsUsage` in `subscription.service.ts`).

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| 3 posts, the 4th is 402 `FREE_POSTS_USED` and saves nothing | `subscription.trial-gate.spec.ts`, `trial.policy.spec.ts` | `free-posts.int.spec.ts` ("3 posts work … the 4th is 402") | `tests/e2e/specs/free-posts.spec.ts` | covered |
| One post across two channels is one post; a draft counts; deleting a draft gives it back | `subscription.trial-gate.spec.ts` | `free-posts.int.spec.ts` | — | covered |
| The same social account in a second workspace is refused, naming it | `subscription.trial-gate.spec.ts` (channel abuse block) | `free-posts.int.spec.ts` (6 tests) | — | covered |
| A deleted channel / deleted workspace still counts | — | `free-posts.int.spec.ts` | — | covered |
| Gmail dots and `+tags` are the same person; disposable domains get 0 | `trial.policy.spec.ts` (`emailIdentity`, `disposableEmail`) | `free-posts.int.spec.ts` (email identity block) | — | covered |
| Our own workspaces (platform super admin) are never refused | — | `free-posts.int.spec.ts` | — | covered |
| Grandfathered and trialing workspaces are not on free posts | `billing.state.spec.ts` | `free-posts.int.spec.ts` | — | covered |
| Posts saved one by one at the same minute each cost a free post (#88) | `subscription.trial-gate.spec.ts`, `trial.policy.spec.ts` | `free-posts.int.spec.ts` | sandbox `s0` | covered |
| `FREE_POSTS_USED` copy with "Switch to your workspace"; disposable list from the open-source feed (#93) | `disposable.email.spec.ts`, `decision-modal.spec.ts`, `plan.dialog.spec.ts` | `free-posts.int.spec.ts` | `free-posts-copy.spec.ts`, sandbox `s8` | covered |
| Free posts spent → pay now, no trial offered | `apps/frontend/src/components/layout/trial.cta.spec.ts` | `free-posts.int.spec.ts` (`/billing/embedded` has no `start_at`) | `billing.spec.ts`, sandbox `s1` | covered |

## 2. Pay at once + first-month offer

20% off the first month, rupee monthly only, attached as a Razorpay offer
(`libraries/nestjs-libraries/src/services/first.month.offer.ts`, applied in
`RazorpayService.subscribe`).

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Offer only on INR monthly, only when paying at once | `first.month.offer.spec.ts`, `razorpay.first-month-offer.spec.ts` | `billing-first-month-offer.int.spec.ts` | `billing.spec.ts` ("the card offer goes on the subscription") | covered |
| Never on a trial, never yearly, never on a plan change | `razorpay.first-month-offer.spec.ts` | `billing-first-month-offer.int.spec.ts` | `billing.spec.ts` | covered |
| A `percentOff` coupon beats the offer | `razorpay.first-month-offer.spec.ts`, `razorpay.currency.spec.ts` | `billing-first-month-offer.int.spec.ts` | — | covered |
| Razorpay refusing the offer: checkout opens at full price, the page stops promising it | `razorpay.first-month-offer.spec.ts` | — | `billing.spec.ts` | covered |
| Copy and price shown | `apps/frontend/src/components/billing/first.month.offer.spec.ts`, `plan.card.price.spec.ts` | — | `marketing.spec.ts` | covered |
| Once per person: email identity, a channel of an account that paid, UPI VPA or card, hashed rows of a deleted account (`personHadBefore`, #96) | `subscription.offer-once.spec.ts`, `razorpay.first-month-offer.spec.ts` | `billing-first-month-offer-once.int.spec.ts` | — | partial — a reused card at checkout is only logged (red team, 2 Nov); no sandbox scenario |

## 3. Cancel runs to the cycle end

`RazorpayService.cancelAtPeriodEnd`, `handleCancelled`,
`endLapsedCancellations`. Since #71 Cancel stops Razorpay **at once**
(`cancel_at_cycle_end 0`) and the plan row alone keeps paid access until
`cancelAt`; since #73 a Temporal timer ends it at that second
(`plan.end.timer.ts`), the hourly sweep is the backup.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Cancel: Razorpay cancelled now, `cancelAt` = `current_end`, one "works until" email | `razorpay.cancel-and-mandates.spec.ts`, `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | `billing.spec.ts`, sandbox `s2` | covered |
| The `subscription.cancelled` that follows (twice) neither ends early nor emails again; double-submitted Cancel is one | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | sandbox `s7` | covered |
| The plan ends at `cancelAt` to the second (Temporal timer), one "plan ended" email | `plan.end.timer.spec.ts`, `subscription.plan-end-timer.spec.ts`, `plan.end.workflow.spec.ts` | `plan-end-cutoff.int.spec.ts` | `billing.spec.ts` ("the end is timed") | covered |
| Reactivate after Cancel: new mandate starting at the old paid end, nothing today | `razorpay.cancel-and-mandates.spec.ts` | `billing-reconcile.int.spec.ts`, `billing-plan-change.int.spec.ts` | — | covered |
| A second click reports the saved date, calls Razorpay once | `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |
| The hourly sweep downgrades only after `current_end`, and only a really cancelled Razorpay sub | `razorpay.billing-emails.spec.ts`, `razorpay.webhook-fixtures.spec.ts` | `billing.int.spec.ts` ("subscription.cancelled after the paid period ends the plan") | — | covered |
| A trial's mandate is stopped now (Razorpay refuses a cycle-end cancel), the trial keeps its days | `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |
| A cycle-end cancel whose period is already over ends now | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| A refused cancel is an error with Razorpay's reason, nothing saved | `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |
| A member (USER role) cannot cancel | — | `billing.int.spec.ts` | — | covered |
| Lifetime plans refuse Cancel | `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |

## 4. Refund ends the plan now

Owner-issued from the Razorpay dashboard, or the admin Refund button
(`POST /admin/refunds`, `RefundsService.refund`). Either way the plan is ended
by the `refund.created` / `refund.processed` webhook, in
`RazorpayService.handleRefund` → `endRefundedSubscription`, and since this
branch also by the hourly `sweepMissedRefunds` when the webhook never comes.
Any amount counts (owner, 29 Oct 2026). Refunds are on request only, less
Razorpay's fee + GST by default (#75).

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Dashboard refund → webhook cancels at Razorpay and ends the plan now | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | `plan-end-cutoff.int.spec.ts` (owner refund), `billing-reconcile.int.spec.ts` | sandbox `s3` | covered |
| Admin Refund button → the same webhook → the same end (one chain, button to plan) | `razorpay.refund-ends-plan.spec.ts` | `billing-reconcile.int.spec.ts` ("the admin Refund button … ends the plan", ₹1, added 1 Nov) | `admin-refunds.spec.ts` | covered |
| A partial refund (any amount) ends the plan | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | `billing-reconcile.int.spec.ts` (₹1 admin, ₹1 dashboard) | sandbox `s3` (₹1) | covered |
| A refund during the cancellation grace period ends that grace now | `razorpay.billing-emails.spec.ts` | — | — | covered |
| A refund on an old cycle of the plan the workspace is still on ends it | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| A refund on a superseded subscription leaves the current plan alone | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| Double-charge refunded during a plan change keeps the new plan | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| The ₹5 UPI mandate check refund changes no plan | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| Another product's refund on the shared account is ignored | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| A lifetime workspace is never ended by a refund | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| `refund.created` while still pending waits for `refund.processed` | `razorpay.billing-emails.spec.ts` | — | — | covered |
| Both refund events for one refund send one customer email | `razorpay.billing-emails.spec.ts` | — | — | covered |
| Razorpay refusing the cancel: nothing changes, the owner is told to cancel by hand, no "it renews" email | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| **Razorpay 5xx/timeout reading the payment, invoice or subscription on `refund.processed`: 500, Razorpay redelivers** (was: swallowed, plan stayed on for good; fixed on this branch) | `razorpay.refund-ends-plan.spec.ts` (4 tests) | `billing-reconcile.int.spec.ts` ("Razorpay down while refund.processed is handled") | — | covered |
| **The refund webhook never arrives: the hourly sweep (`GET /refunds`, last 3 days) ends the plan, once; a late webhook adds nothing** (was: plan stayed on; fixed on this branch) | `razorpay.refund-ends-plan.spec.ts` (7 tests) | `billing-reconcile.int.spec.ts` | not possible in test mode (Razorpay always delivers) | covered |
| Refund then Cancel days later with the refund webhook missed: Cancel reads the refund at Razorpay and ends at once; one cancelled email, one refund email (sweep), the owner told of the Cancel and the refund once each | `razorpay.owner-alerts.spec.ts` ("Cancel after a refund of an earlier period" and 4 more) | `billing-reconcile.int.spec.ts` (refund 3 days old) | sandbox `s4`, `s13` (A: refunded while the webhook endpoint was down) | covered |
| Refund then Cancel days later with the refund webhook delivered: the plan already ended; Cancel answers "no paid plan to cancel", calls Razorpay and emails nothing | `razorpay.owner-alerts.spec.ts` | `billing-reconcile.int.spec.ts` | sandbox `s12` | covered |
| A payment with a chargeback is never refunded on top (Razorpay takes the disputed amount when the dispute opens): admin button and the automatic refund refuse, any status but `won`; Razorpay unreadable refuses too (billing benchmark 1 Nov) | `refunds.service.spec.ts` (8 tests), `razorpay.reconcile.spec.ts` | `disputes.int.spec.ts` | — (test mode cannot raise a dispute on a subscription charge) | covered |
| Admin button deducts Razorpay's fee + GST unless Full; USD too; bulk too | `refunds.service.spec.ts`, `admin-refunds.spec.ts` (frontend) | `admin-refund-fee.int.spec.ts` | `admin-refunds.spec.ts` | covered |
| No self-serve refund; Terms and refund page say "on request, at our discretion, less the fee" | `refund-terms.spec.ts` | `admin-refund-fee.int.spec.ts` | — | covered |
| An admin request cannot stamp `notes.auto` (which would keep a refunded plan on) | `refunds.service.spec.ts` | — | — | covered |
| Admin button: the payment must be Hookpost's unless confirmed foreign | `admin-refunds.spec.ts` (frontend), `refunds.service.spec.ts` | — | `admin-refunds.spec.ts` | covered |
| Admin button: a double click cannot send two refunds (Redis lock, idempotency key) | `refunds.service.spec.ts` | — | — | covered |
| Admin button: no Redis → refuse, nothing sent | `refunds.service.spec.ts` | — | — | covered |
| Admin button: the audit row is written before the refund is sent | `refunds.service.spec.ts` | `admin-refund-fee.int.spec.ts` | `admin-refunds.spec.ts` | covered |
| Refunds are CSRF-protected and super-admin only | `refunds.csrf.spec.ts` | `admin-refund-fee.int.spec.ts`, `admin.int.spec.ts` | `admin-refunds.spec.ts` ("an ordinary user gets no refund data") | covered |
| Refund while impersonating is refused | — | `admin.int.spec.ts` ("no refunds while impersonating") | — | covered |

## 4b. A charge after cancel is refunded by itself (#81)

`RazorpayService.settleChargeAfterCancel` / `refundChargeAfterCancel`, from
the `subscription.charged` webhook and the hourly guard. The plan stays
cancelled and keeps its saved end; the refund carries `notes.auto`, which
`handleRefund` reads so its own refund does not end the plan.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| A charge after Cancel is refunded in full once, recorded, one email, owner info alert, plan end kept | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | `billing.spec.ts` ("is refunded in full by itself") | covered |
| A lost `charged` webhook: the hourly guard finds and refunds it, once | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |
| A forged webhook naming another subscription's payment refunds nothing; a renewal nobody cancelled is never refunded | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |
| A refused guard cancel is retried on a backoff, not handed to the owner | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |

## 5. Chargeback ends the plan now (#74)

`RazorpayService.handleDispute`: every `payment.dispute.*` event marks the
workspace disputed (locked: no Free plan, no free posts, no trial, checkout
refused), ends its Razorpay plan now, alerts the owner with the respond-by
date and an evidence pack. A super admin restores the plan once won.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| `dispute.created` ends the plan now, locks the workspace, owner alert with deadline + evidence, one neutral customer email | `razorpay.disputes.spec.ts` | `disputes.int.spec.ts` | `disputes.spec.ts` | covered |
| `won` arriving first still ends the plan; winning never restores by itself | `razorpay.disputes.spec.ts` | `disputes.int.spec.ts` | — | covered |
| Forged / replayed dispute webhooks: nothing / one alert, one email | `razorpay.disputes.spec.ts` | `disputes.int.spec.ts` | — | covered |
| Already refunded / already cancelled / no paid plan / marketplace / lifetime: marked, nothing wrongly cancelled | `razorpay.disputes.spec.ts` | — | — | covered |
| Razorpay down on the lookup: 5xx and redelivered, never written off | `razorpay.disputes.spec.ts` | — | — | covered |
| A dispute whose webhook never came (or the live webhook lacks the dispute events) is caught by the hourly `sweepMissedDisputes`: plan ended once, owner alerted once per status, retried next hour when Razorpay is down, two processes cancel once (2 Nov) | `razorpay.disputes.spec.ts` ("the hourly sweep", 6 tests) | — | — | covered |
| A dispute the owner cleared in Admin is settled: a later status webhook, a redelivery or the sweep never re-locks the workspace or ends a plan bought since; a different payment disputed later still does (2 Nov break-it) | `razorpay.disputes.spec.ts` ("a dispute the owner already cleared") | — | — | covered |
| Admin restore refused while open, done once won, never over a live new plan (a lapsed row does not block it); clear lets the workspace buy again. Rule in `AdminPlanActionsService.restoreAfterWonDispute` | `admin.controller.spec.ts` (through the real service), `workspaces.view.spec.ts` | `disputes.int.spec.ts` | `disputes.spec.ts` | covered |
| Gumroad chargeback / dispute ends the Gumroad plan | `gumroad.license.spec.ts`, `gumroad.license.service.spec.ts` | `gumroad-license.int.spec.ts` | `gumroad.spec.ts` | covered |
| A dispute in Razorpay test mode | — | — | — | missing: test mode cannot raise a dispute on a subscription charge |

## 6. Payment failure, retry and halt (#70)

`subscription.pending` / `subscription.halted` → `markPaymentFailing`
(only AI and X go off while Razorpay retries; trial.policy.ts `dunning`),
`endHaltedUnpaidTrial`, `scheduleHaltedRenewalEnd` (halted ends the plan now,
never before time already paid for). `payment.failed` emails nothing.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Pending: AI and X refused with the pay link, other channels keep publishing; a retry that charges restores everything | `trial.policy.spec.ts`, `subscription.trial-gate.spec.ts`, `permissions.trial-gate.spec.ts` | `dunning.int.spec.ts` | `dunning.spec.ts` | covered |
| Trial first charge halted (`paid_count` 0): cancelled at Razorpay, plan ends now, "trial has ended" email | `razorpay.webhook-fixtures.spec.ts` | — | — | covered |
| Renewal halted: the plan ends now, no grace; no "renewal paused" email beside the ending | `razorpay.webhook-fixtures.spec.ts`, `razorpay.billing-emails.spec.ts` | `dunning.int.spec.ts` | — | covered |
| A late `pending` after the retry went through, or an old `activated` redelivered, does not flip AI/X | `razorpay.webhook-fixtures.spec.ts` | `dunning.int.spec.ts` | sandbox `s6` (unconfirmed pending/halted) | covered |
| A `pending` naming another workspace touches neither; another product's charge clears nothing | — | `dunning.int.spec.ts` | — | covered |
| One failure email per cycle, however many attempts | `razorpay.billing-emails.spec.ts` | — | — | covered |
| `payment.failed` sends nothing | `razorpay.billing-emails.spec.ts` | — | — | covered |
| The pay-from-another-account banner | `payment.failed.banner.spec.ts` | — | `dunning.spec.ts` | covered |
| A real failed charge at Razorpay | — | — | — | missing: test mode passes any OTP and UPI Autopay is QR-only (sandbox report) |

## 7. Upgrade / downgrade / proration (#72)

Upgrade now with exact proration (credit of the unused share of what was
paid), downgrade at the cycle end with undo; the rules in `razorpay.mapping.ts`
(`planChangeDirection`, `inPlaceChangeMinor`, `unusedCreditMinor`), `RazorpayService` plan-change paths.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Upgrade/downgrade direction, credit never negative, never above what was paid, paise rounded down | `razorpay.plan-change.spec.ts` (47 tests) | — | — | covered |
| Standard → Pro on day 16: quotes ₹700, Razorpay takes ₹700, Pro at once without waiting for a webhook | `razorpay.plan-change.spec.ts` | `billing-plan-change.int.spec.ts` | `billing-plan-change.spec.ts`, sandbox `s5` | covered |
| Downgrade keeps Pro to the renewal, shows the date, undo drops it | `razorpay.plan-change.spec.ts`, `billing.actions.spec.ts` | `billing-plan-change.int.spec.ts` | `billing-plan-change.spec.ts` | covered |
| Double click upgrades once; tampered plan or price in the body refused/ignored; another workspace cannot see or undo; a member cannot | `razorpay.plan-change.spec.ts` | `billing-plan-change.int.spec.ts` | — | covered |
| A failing renewal cannot change plan; the same plan again opens nothing | `razorpay.plan-change.spec.ts` | `billing-plan-change.int.spec.ts` | — | covered |
| Upgrade while a cancellation is pending: fresh mandate, the plan no longer ends | — | `billing-plan-change.int.spec.ts` | — | covered |
| The old plan is retired only after the new mandate is approved; a late webhook for it never takes the workspace back | `razorpay.retire-superseded.spec.ts`, `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |
| A double charge refunded during a plan change keeps the new plan | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| Plan-change owner alerts | `razorpay.owner-alerts.spec.ts` | `owner-sales-alerts.int.spec.ts` | `owner-alerts.spec.ts` | covered |

## 8. Cross-currency

`libraries/nestjs-libraries/src/services/billing.currency.ts`,
`resolveCheckoutCurrency`, `CurrencyLockUnknownError`,
`noteInternationalInrAuth`.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Which currency a checkout opens in (country, time zone, `USD_CHECKOUT` modes) | `billing.currency.spec.ts` (~28 tests) | `billing.int.spec.ts` (`pricing-context`) | sandbox `s14`, `s15` (USD) | covered |
| A live plan locks the currency; a stale page gets a 409 | `razorpay.currency.spec.ts` | — | — | covered |
| Razorpay unreadable → `CurrencyLockUnknownError` → 503, never a guessed currency | `razorpay.currency.spec.ts` | — | — | covered |
| A USD plan changes plan in dollars, in place | `razorpay.currency.spec.ts` | — | — | covered |
| `prorate` prices in INR whatever the page sends | `razorpay.currency.spec.ts` | — | — | covered |
| An international card authorising in INR is recorded | `razorpay.currency.spec.ts`, `razorpay.controller.spec.ts` | — | — | covered |
| The page's own currency handling | `apps/frontend/src/proxy.currency.spec.ts`, `pricing.context.spec.ts` | — | — | covered |
| A refund in the payment's currency, never the workspace's | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |

## 9. Coupons

`Coupon` / `CouponRedemption` tables, `validateCoupon`,
`redeemCouponByCode`, `recordCouponRedemption`. `LAUNCH50` is seeded by
`scripts/create-launch50.ts`; affiliate codes are created per affiliate.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| `LAUNCH50`: 50% off, 100 uses, until 31 Dec 2026 IST; refused after either | `razorpay.coupon.spec.ts` | — | — | covered |
| Validated however the buyer types it | `razorpay.coupon.spec.ts` | — | — | covered |
| An unknown coupon is refused | — | `billing.int.spec.ts` | — | covered |
| Counted once per workspace, however often the activation webhook arrives | `razorpay.coupon.spec.ts`, `razorpay.webhook-fixtures.spec.ts` | — | — | covered |
| A `percentOff` coupon in USD buys its own discounted dollar plan | `razorpay.currency.spec.ts` | — | — | covered |
| `applyCoupon` after checkout is an explicit stub in the controller (`coupons_not_supported_on_razorpay`) | `billing.controller.spec.ts` | — | — | partial — the stub is pinned, there is no feature to test |
| The price shown is the amount charged: one `couponPrice` / `couponPriceMinor` (`pricing.ts`) for checkout, `/billing/coupon/validate` and the cards (2 Nov) | `razorpay.coupon.spec.ts` | `billing.int.spec.ts` | — | covered |
| Only a free-months coupon skips the second-trial refusal at approval; a percent-off coupon does not (2 Nov) | — | `trial-switch.int.spec.ts` | — | covered |

## 10. Lifetime, internal, marketplace, Gumroad

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| A lifetime plan refuses Cancel, is never ended by a refund, a halt or the sunset | `razorpay.cancel-and-mandates.spec.ts`, `razorpay.refund-ends-plan.spec.ts`, `razorpay.webhook-fixtures.spec.ts`, `subscription.trial-gate.spec.ts` | — | — | covered |
| A lifetime plan in another workspace of the same owner is left alone | `subscription.org-resolution.spec.ts` | — | — | covered |
| Internal / exempt workspaces: Free (exempt) before and after the sunset, alerts marked `[INTERNAL]` | `razorpay.trial-policy.spec.ts`, `owner.sales.alert.service.spec.ts`, `billing.state.spec.ts` | `admin-billing-states.int.spec.ts` | `admin-billing.spec.ts` | covered |
| Marketplace (`apimkt:`) workspaces keep their own plan; every Razorpay sweep ignores those rows | `subscription.marketplace-gate.spec.ts`, `marketplace.plans.spec.ts` | `marketplace.int.spec.ts`, `marketplace-adapters.int.spec.ts` | — | covered |
| Gumroad licence redeem, daily re-verify, refund / chargeback / cancel | `gumroad.license.spec.ts`, `gumroad.license.service.spec.ts`, `subscription.gumroad-end.spec.ts`, `gumroad.redeem.spec.ts` | `gumroad-license.int.spec.ts` | `gumroad.spec.ts` | covered |
| A Gumroad plan replaced by a paid plan alerts support (double pay) | `razorpay.webhook-fixtures.spec.ts` | — | — | covered |

## 11. Webhook signature, redelivery, out-of-order

Signature in `apps/backend/src/api/routes/razorpay.controller.ts:34-49`
(`RazorpayClient.verifyWebhook`). There is no webhook event store on `main`:
every handler is made idempotent on its own side effect (Redis `sendOnce`
keys for customer emails, `OwnerSalesAlertService` keys for owner alerts,
upserts for entitlements).

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| A forged, tampered or missing signature changes nothing (400) | `razorpay.controller.spec.ts` | `billing.int.spec.ts`, `billing-reconcile.int.spec.ts`, `dunning.int.spec.ts`, `disputes.int.spec.ts` | sandbox `s7` | covered |
| An event for another product on the shared account is ignored | `razorpay.billing-emails.spec.ts` | `billing.int.spec.ts` | — | covered |
| A redelivered webhook is idempotent and the welcome is sent once | `razorpay.webhook-fixtures.spec.ts` | `billing.int.spec.ts` | — | covered |
| The same owner-alert key twice sends one email | `owner.sales.alert.service.spec.ts` | `owner-sales-alerts.int.spec.ts` | `owner-alerts.spec.ts` | covered |
| Out of order: `cancelled` before `charged`, `charged` after a cancel the customer made | `razorpay.webhook-fixtures.spec.ts`, `razorpay.cancel-and-mandates.spec.ts` | — | — | covered |
| Out of order: `refund.processed` before `refund.created`, and a refund webhook before the charge that it refunds is known | `razorpay.refund-ends-plan.spec.ts` | — | — | covered |
| A webhook arriving 24 h late (Razorpay's retry window) still settles | `razorpay.refund-ends-plan.spec.ts`, `razorpay.webhook-fixtures.spec.ts` | — | — | covered |
| Razorpay 5xx / timeouts while a refund or dispute webhook is handled: 500 and redelivered, never guessed | `razorpay.refund-ends-plan.spec.ts`, `razorpay.disputes.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |
| A webhook that never arrives: refunds swept hourly; charges after cancel found by the guard | `razorpay.refund-ends-plan.spec.ts`, `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |
| Redelivery and out-of-order against real Razorpay test mode | — | — | sandbox `s7` | covered |
| Resend down never fails a webhook; the queued alert goes out once it is back | — | `owner-sales-alerts.int.spec.ts` | — | covered |

## 12. DB vs Razorpay reconciliation (#71)

`RazorpayService.reconcileBilling` (the hourly pre-charge guard) acts in one
direction only: a plan the DB says is ending whose Razorpay subscription
could still charge within 48 h is cancelled at Razorpay, access kept. The
other direction (charging with no row, a plan Razorpay finished with) only
reports to the owner.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| `syncSubscriptionById` after the checkout handshake provisions the plan | `razorpay.webhook-fixtures.spec.ts` | `billing.int.spec.ts` | `billing.spec.ts`, sandbox `s1` | covered |
| The guard cancels at the 11 Nov race (charge_at == cancelAt), keeps access, emails once, alerts the owner | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` (legacy cycle-end cancel, and a Cancel that did not stick) | sandbox `s13` (R) | covered |
| Charge roka 1: refunded but Razorpay live, nobody pressed Cancel: ended before the next charge, one "stopped a charge" email, one owner alert | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | sandbox `s13` (B, through the missed-refund sweep; the near-charge path needs a charge within 48 h, which test mode cannot make on a paid plan) | covered |
| Charge roka 3: the plan ended here but Razorpay will still charge: stopped, one email, one owner alert, then the sweep ends it | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | sandbox `s13` (E) | covered |
| Never touches a paying customer with no end date, a retrying or halted renewal, lifetime/Gumroad/marketplace, or acts on a failed read | `razorpay.reconcile.spec.ts` | `billing-reconcile.int.spec.ts` | — | covered |
| Report-only direction (`planMismatch`), dry run | `razorpay.reconcile.spec.ts` | — | — | covered |
| Admin billing falls back to the database when Razorpay fails, and says so | `billing.badge.spec.ts` | `admin-billing-states.int.spec.ts` | `admin-billing.spec.ts` | covered |
| A DB `cancelAt` while Razorpay is still `active` (only via a cancel webhook Razorpay did not perform): Cancel answers "already scheduled", the guard stops it before the charge | `razorpay.reconcile.spec.ts` | — | sandbox `sub_TunHWcjGzWcSLl`, recheck 30 Nov | partial (open, low; sandbox report item 4) |

## 13. Emails per event

Every send goes through `RazorpayService.sendOnce(key)` (Redis `SET NX`, 45
days), so a redelivery sends nothing twice and a failed send frees the claim.

| Event | Email | Spec | Status |
|---|---|---|---|
| `subscription.authenticated` / `.activated` / `.charged` (first) | `subscriptionWelcomeEmail` | `razorpay.billing-emails.spec.ts`, `razorpay.webhook-fixtures.spec.ts` | covered |
| A replacement mandate (Reactivate, Change payment method) | none | `razorpay.cancel-and-mandates.spec.ts` | covered |
| `subscription.pending` / `.halted` | `paymentFailedEmail` (trial variant for a first charge) | `razorpay.billing-emails.spec.ts` | covered |
| `payment.failed` | none | `razorpay.billing-emails.spec.ts` | covered |
| `subscription.cancelled`, and every Hookpost-initiated end | `subscriptionCancelledEmail` | `razorpay.billing-emails.spec.ts` | covered |
| `refund.created` / `.processed` | `refundEmail` (says whether the plan ended) | `razorpay.billing-emails.spec.ts`, `razorpay.refund-ends-plan.spec.ts` | covered |
| Trial reminder sweep | `trialReminderEmail` | `razorpay.billing-emails.spec.ts`, `razorpay.trial-reminder.redis.spec.ts` | covered |
| Yearly plan renews in 30 days (once per renewal; never for monthly, ending, halted, final-cycle, another product, deleted or internal; amount never guessed) | `renewalReminderEmail` | `razorpay.reconcile.spec.ts` (8), `billing-reconcile.int.spec.ts` | covered (no sandbox: test mode cannot bring a yearly renewal 30 days near) |
| Cancelled-trial sweep | `trialAccessEndingEmail` | `razorpay.trial-policy.spec.ts` | covered |
| A cancelled trial lapsing with no Free plan | `workspacePausedEmail` | `razorpay.billing-emails.spec.ts` | covered |
| Owner sale / cancel / refund / failure alerts | `OwnerSalesAlertService` | `razorpay.owner-alerts.spec.ts`, `owner.sales.alert.service.spec.ts` | covered |
| No email names the legal entity or a street address | — | `razorpay.billing-emails.spec.ts` | covered |
| Charge after cancel refunded | `refundAfterCancel` (once per refund id, shared with the webhook) | `razorpay.reconcile.spec.ts` | covered |
| Guard stopped a charge | `chargeStoppedEmail` (one template for the guard and admin End plan) | `razorpay.reconcile.spec.ts`, `account.correction.emails.spec.ts` | covered |
| Chargeback | one neutral customer note; owner alert per dispute state | `razorpay.disputes.spec.ts` | covered |
| Account corrections (plan wrongly ended / restored / duplicate charge refunded) | `account.correction.emails.ts`, once per correction | `account.correction.service.spec.ts`, `account.correction.emails.spec.ts`, `admin-plan-actions.int.spec.ts`, `admin-plan-actions.spec.ts` | covered |
| Plan ended at `cancelAt` | "plan has ended", exactly once (timer + sweep) | `plan-end-cutoff.int.spec.ts` (#76) | covered |

## 14. Where a plan ends, for posts, AI and X (#68, #73)

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| T-1 min publishes, T+1 min refused with the plan-gate message, post and media kept, publishes after paying again | `trial.policy.spec.ts`, `subscription.trial-gate.spec.ts` | `plan-end-cutoff.int.spec.ts` (for refund, immediate cancel and swept cancel) | — | covered |
| Cancelled but paid: every channel, X and AI work up to `cancelAt`; a cancelled trial that never charged loses X and AI at once | `permissions.trial-gate.spec.ts` | `plan-end-cutoff.int.spec.ts`, `x-publish-gate.int.spec.ts` | `billing.spec.ts` | covered |
| Past `cancelAt` with the row still there: refused, and the app already says the plan ended | `trial.policy.spec.ts` | `plan-end-cutoff.int.spec.ts` | — | covered |
| The public API and MCP keys refuse a plan past `cancelAt` the same way (`planLapsed` in `public.auth.middleware.ts`, 2 Nov) | — | `public-api.int.spec.ts` | — | covered |
| Plan-end timer at `cancelAt`, exactly one "plan ended" email | `plan.end.timer.spec.ts`, `subscription.plan-end-timer.spec.ts`, `plan.end.workflow.spec.ts` | `plan-end-cutoff.int.spec.ts` | — | covered |
| X caps per plan (monthly X posts, X link posts) | `x.post.cap.spec.ts` | `x-publish-gate.int.spec.ts` | — | covered |
| AI image credits and the publish meter follow the tier | `subscription.image-credits.spec.ts`, `subscription.publish-meter.spec.ts` | `ai-credits.int.spec.ts` | — | covered |

## 15. Every payment method

Card (Indian and international), UPI Autopay, bank e-mandate and any method
Razorpay may report later. What each allows: `docs/billing-payment-methods.md`;
the rules: `mandateRules()` in `razorpay.mapping.ts`.

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Only an international card is re-planned in place; Indian card, UPI, e-mandate, unknown and an unreadable card take a new mandate, quote and change alike, never a PATCH | `razorpay.payment-methods.spec.ts`, `razorpay.currency.spec.ts`, `razorpay.cancel-and-mandates.spec.ts` | `billing-payment-methods.int.spec.ts`, `billing-plan-change.int.spec.ts` | `billing-plan-change.spec.ts` (Indian card, foreign card); sandbox `s9`, `s10` | covered |
| A plan PATCH with no answer (timeout, 5xx, 408/429) is read back: applied is done, otherwise 503 and no second mandate; a 4xx falls through to a new mandate | `razorpay.payment-methods.spec.ts` (5 tests, upgrade and downgrade) | — | — | covered |
| The customer pauses AutoPay in the UPI app or bank portal: cancelled at Razorpay, paid time kept, one email naming the pause; redelivery and the following `cancelled` add nothing; a refused cancel ends at the paid end through the sweep; a lost webhook is caught by the hourly guard | `razorpay.payment-methods.spec.ts` | `billing-payment-methods.int.spec.ts` | sandbox `s11` (pause API) | covered |
| E-mandate paid at once is not a trial while its first debit waits (no trialing flag, plan welcome email) | `razorpay.payment-methods.spec.ts` | `billing-payment-methods.int.spec.ts` | — | covered |
| E-mandate first debit failed: halted -> "didn't start" email; left `created` with no webhook -> ended by the guard after 7 days, once | `razorpay.payment-methods.spec.ts` | `billing-payment-methods.int.spec.ts` | not possible in test mode (e-mandate bank pages not automated) | covered |
| The trial emails say how to stop each mandate (UPI app, card portal, bank) | `razorpay.payment-methods.spec.ts` | — | — | covered |

## 16. Trials behind `TRIAL_CHECKOUT` (off in production)

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| One trial length for checkout, `/user/self`, the paywall, MCP and the channel gate: `baseTrialDays()` (`RAZORPAY_TRIAL_DAYS` else `TRIAL_DAYS`); 7 days for the sunset-notice workspaces (2 Nov) | `trial.sunset-notice.spec.ts`, `razorpay.trial-length.spec.ts` | `trial-switch.int.spec.ts` | sandbox `t1` | covered |
| Every 29 Oct trial case (first charge fails, cancel, refund, chargeback, revoked mandate, plan change, once per person) with the switch on and off | `subscription.trial-gate.spec.ts`, `trial.policy.spec.ts`, `razorpay.trial-policy.spec.ts` | `trial-switch.int.spec.ts` (27 tests) | sandbox `t1`-`t3` | covered |

## 17. Media retention after the plan ends (#106)

| Rule | Unit | Integration | E2E | Status |
|---|---|---|---|---|
| Notice on day 0, reminder on day 23, unpublished media removed on day 30; paying again clears it | `trial.policy.media-retention.spec.ts`, `media.retention.service.spec.ts` | `media-retention.int.spec.ts` | — | covered |

---

## Runs behind this matrix

1 Nov 2026, on this branch rebased on `origin/main`:

| Suite | Command | Result |
|---|---|---|
| Unit, backend + libraries, billing paths | `jest -c apps/backend/jest.config.ts --testPathPattern='(razorpay\|billing\|refund\|subscription\|coupon\|gumroad\|trial\|plan\|dispute\|dunning\|reconcile\|admin\|free\|correction)'` | on `main`: 1710 passed, **2 suites failed to compile** (`razorpay.reconcile.spec.ts`, `account.correction.service.spec.ts`: merge drift between #69 and #71/#81; CI transpiles without type-checking so it never saw it). Fixed here: 48 suites, 1798 passed, 0 failed |
| Unit, frontend, billing paths | `jest -c apps/frontend/jest.config.ts --testPathPattern='(billing\|refund\|plan\|trial\|coupon\|gumroad\|payment\|pricing\|dispute\|admin\|free\|decision)'` | 409 passed |
| Integration, billing paths | `jest -c tests/integration/jest.config.ts --testPathPattern='(billing\|refund\|dispute\|dunning\|reconcile\|plan\|free-posts\|gumroad\|owner-sales\|admin\|marketplace\|affiliate\|email-verification\|x-publish)'` | 421 passed on `main`; 424 with the 3 added here (`billing-reconcile.int.spec.ts` 17/17) |
| Sandbox e2e | `ts-node tests/e2e/billing-sandbox/billing-e2e.ts` | 9/9 passed on the release with #95 (1 Nov, 16:57 IST) |

2 Nov 2026, final review branch: the suites touched by the review (disputes, trial switch, public API, admin, coupon, plan actions, mapping, reconcile) all pass; numbers in `~/ops-routines/reports/final-review-2026-10-29.md`.
