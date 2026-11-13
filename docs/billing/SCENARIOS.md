# Billing scenarios: the rules every product follows

One spec for subscription billing in every Hookstep product: Hookpost today, Tablamigo next, any later app. It says what must happen in each billing event: the state the account ends in, what the customer can still use, which emails go out, and which tests prove it. The rules are the owner's decisions of 29 Oct 2026 (`~/ops-routines/RESUME-2026-11-01.md`, "Owner decisions") plus later owner rulings noted inline.

Written 2 Nov 2026 against `origin/main` at `ac5479f7c`, from the merged billing code and `docs/billing-test-matrix.md`. How to build this in another product: [PORTING.md](PORTING.md). Every email in detail: `docs/billing-emails.md`. What each payment method allows: `docs/billing-payment-methods.md`.

If code and this file disagree, the code is wrong unless the owner has changed the rule. Then change this file in the same PR.

---

## 1. Words used here

The spec is written for any product. "Account" means the thing that holds the plan: a Hookpost workspace, a Tablamigo user.

| Word | Meaning | Hookpost |
|---|---|---|
| **Gateway** | Whoever holds the mandate and charges it | Razorpay subscriptions (card, UPI Autopay, e-mandate) |
| **Mandate** | The customer's standing approval to be charged each cycle | A Razorpay `sub_…` |
| **Paid end** | The end of the time the customer has actually paid for | `current_end` of the last paid cycle (`paidThrough` in `razorpay.mapping.ts`) |
| **cancelAt** | The second access ends, saved on the plan row | `Subscription.cancelAt` |
| **Variable-cost features** | Features that cost us money per use | AI writing/images and X (Twitter) publishing |
| **No-plan state** | What the product gives an account without a plan | Free posts (new cohort), Free plan (grandfathered), or paused |

### Account states

Every account is in exactly one of these. A product may add its own no-plan states, but these seven and their access rules are fixed.

| State | Means | Access | Hookpost `PlanState` (`trial.policy.ts`) |
|---|---|---|---|
| `none` | No plan, never paid or plan ended | the product's no-plan state | `free`, `free_posts`, `needs_trial`, `locked` |
| `trialing` | Mandate approved, first charge still ahead (trial switch on only) | everything | `trialing` |
| `active` | Paid, renews | everything | `active` |
| `dunning` | A charge failed, the gateway is still retrying | everything **except** variable-cost features | `dunning` |
| `cancelling` | Cancelled, paid time left; gateway already stopped | everything up to `cancelAt`, then `none` | `cancelling` |
| `disputed` | A chargeback was raised; plan ended | nothing paid, no no-plan perks, checkout refused | `none` + `Organization.disputedAt` (`workspaceDisputed`) |
| `lifetime` | Granted by us, never billed | everything; no billing event ever ends it | `active` with `isLifetime` |

### Rules that hold in every scenario

1. **The gateway is stopped at the moment we decide a plan ends**, never left to run to the cycle end. Access is kept on our side with `cancelAt` (owner, 29 Oct).
2. **Gates read `cancelAt <= now` at use time.** Access never depends on a sweep or timer having run (`planLapsed`).
3. **An exact timer fires at `cancelAt`** to close the row and send the one "plan ended" email. An hourly sweep is the backup, never the primary path.
4. **Any refund on the current subscription ends the plan now**, whatever the amount (owner, 29 Oct: "Refund means refund"). A refund on a superseded subscription (a double charge during a plan change) does not.
5. **Every webhook is verified, idempotent and safe out of order.** A forged one changes nothing, a replay sends nothing twice, and a late one never undoes a newer state.
6. **A webhook that never arrives is caught by a reconcile job** that reads the gateway and runs the same handler the webhook would have.
7. **When the gateway can't be read, we refuse or retry (5xx so the gateway redelivers).** We never guess a state, a currency or an amount.
8. **Each customer email goes out once per event** (a send-once key per event id). If the key store is down, nothing is sent: a missing email is easier to fix than a duplicate. Owner alerts go out anyway.
9. **Lifetime, internal and marketplace accounts are never ended by a billing event.**
10. **One rule, one place.** Pure decision functions (`trial.policy.ts`, `razorpay.mapping.ts`, `billing.state.ts`) decide; services only fetch, write and send.

### Where the tests are

Spec names below are file names. Two names exist twice, so they get a prefix: `frontend/admin-refunds.spec.ts` vs `e2e/admin-refunds.spec.ts`, and `frontend/first.month.offer.spec.ts` vs `first.month.offer.spec.ts` (the backend one in `libraries/nestjs-libraries/src/services/`).

| Kind | Where | Run |
|---|---|---|
| Unit | `libraries/nestjs-libraries/src/**`, `apps/*/src/**` `*.spec.ts` | `pnpm exec jest -c apps/backend/jest.config.ts <pattern>` |
| Integration (real AppModule, Postgres, Redis, fake gateway) | `tests/integration/*.int.spec.ts`, fake in `tests/integration/setup/fake.razorpay.ts` | `pnpm exec jest -c tests/integration/jest.config.ts <pattern>` |
| E2E, Playwright (stand-in Checkout) | `tests/e2e/specs/*.spec.ts` | see `TESTING.md` |
| E2E, sandbox (real Razorpay **test mode**, real Checkout) | `tests/e2e/billing-sandbox/billing-e2e.ts`, scenarios `s0`–`s15`, `t1`–`t3` | `ops/sandbox/README.md` |

---

## 2. Scenarios

Each scenario lists the state, access, customer email(s), owner alert, what we do at the gateway, and the tests. "Email: none" is a rule, not an omission. Email template names are in `libraries/nestjs-libraries/src/emails/templates/billing.emails.ts`.

### SC-01 Trial off: a new account pays at once

The production setting (`TRIAL_CHECKOUT` off). A new sign-up gets its no-plan perk (Hookpost: 3 free posts, once per person and per channel). Then it pays at checkout.

- **State:** `none` → `active` as soon as the checkout handshake verifies (`/razorpay/verify` → `syncSubscriptionById`), without waiting for a webhook.
- **Access:** everything at once.
- **Price:** the first-month offer (Hookpost: 20% off, INR monthly only) if the person never had it (SC-22). A `percentOff` coupon replaces it.
- **Email:** `subscriptionWelcomeEmail`, once per subscription. **Owner:** `FIRST_CHARGE`.
- **Tests:** unit `first.month.offer.spec.ts`, `frontend/first.month.offer.spec.ts`, `razorpay.first-month-offer.spec.ts`, `subscription.trial-gate.spec.ts`; integration `billing-first-month-offer.int.spec.ts`, `free-posts.int.spec.ts`, `trial-switch.int.spec.ts` ("off (production)…"); e2e `billing.spec.ts`, `free-posts.spec.ts`, sandbox `s0`, `s1`.

### SC-02 Trial on: the trial starts

Behind the switch (`TRIAL_CHECKOUT=on`; 3 days from the `TRIAL_DAYS` constant, overridable on the server with `RAZORPAY_TRIAL_DAYS`). The code is complete and tested, but off in production (owner: trials stay off).

- **State:** `none` → `trialing` when the mandate is approved (`subscription.authenticated`). Nothing is charged; the first charge is `TRIAL_DAYS` away.
- **Access:** everything, including variable-cost features.
- **Price:** never the first-month offer on a trial.
- **Email:** welcome that states the first-charge date and amount, and how to stop the mandate for that method. `trialReminderEmail` 24–48 h before the charge. **Owner:** `TRIAL_STARTED`.
- **Break-it:** a client can't ask for a trial the server wouldn't give (tampered body, switch off). A disposable email gets no trial.
- **Tests:** unit `razorpay.trial-length.spec.ts`, `razorpay.trial-policy.spec.ts`, `trial.policy.spec.ts`, `razorpay.trial-reminder.redis.spec.ts`, frontend `trial-offer.spec.ts`; integration `trial-switch.int.spec.ts` ("the switch", "the trial starts"); e2e sandbox `t1`, `t2` (run with the switch on, `SANDBOX_TRIAL_CHECKOUT=on ops/sandbox/restart.sh`).

### SC-03 First charge fails

**Trial off (pay at once):** the payment fails inside Checkout. No subscription is created and the account stays `none`, with no email. **Bank e-mandate:** the first debit lands a banking day later. If it fails, `subscription.halted` sends "your plan didn't start". If it stays `created` with no webhook, the hourly guard ends it after 7 days (`endUnpaidFirstCharge`, `UNPAID_MANDATE_SETTLE_MS`).

**Trial on:** the trial's first charge fails.
- **While the gateway retries (`subscription.pending`):** `trialing` → `dunning`. Only variable-cost features go off; a retry that succeeds brings everything back (owner, 29 Oct 19:19).
- **Halted (all retries failed):** the gateway subscription is cancelled and the plan ends now. The account is `none` and the trial is spent (`endHaltedUnpaidTrial`).
- **Email:** one `paymentFailedEmail` (first-charge variant) per cycle; on halt, `subscriptionCancelledEmail` (`unpaidTrialEnded`). `payment.failed` itself never emails. **Owner:** `PAYMENT_FAILING`, `HALTED`.
- **Tests:** unit `razorpay.webhook-fixtures.spec.ts`, `razorpay.payment-methods.spec.ts` (e-mandate); integration `trial-switch.int.spec.ts` ("the trial's first charge"), `billing-payment-methods.int.spec.ts`; e2e sandbox `s6` (failed first charge leaves no plan). Gap: test mode can't make a real charge fail (any OTP passes; UPI Autopay is QR-only).

### SC-04 Renewal fails, the gateway retries

- **State:** `active` → `dunning` on `subscription.pending`.
- **Access:** everything except variable-cost features. Posting to other channels, scheduling, drafts and media keep working (owner, 29 Oct 19:19).
- **Email:** one `paymentFailedEmail` per billing cycle, however many attempts (`payment-failed:<sub>:<cycleStart>`). `payment.failed` sends nothing. The app shows a "pay from another account" banner. **Owner:** `PAYMENT_FAILING`, once per cycle.
- **A retry succeeds** (`subscription.charged`): `dunning` → `active`, everything back, no extra email. A late `pending` after that success, or an old `activated` redelivered, changes nothing.
- **Plan changes are refused while failing.**
- **Tests:** unit `trial.policy.spec.ts`, `subscription.trial-gate.spec.ts`, `permissions.trial-gate.spec.ts`, `razorpay.billing-emails.spec.ts`, `razorpay.webhook-fixtures.spec.ts`, `payment.failed.banner.spec.ts`; integration `dunning.int.spec.ts`, `billing-plan-change.int.spec.ts` (refusal); e2e `dunning.spec.ts`, sandbox `s6`. Gap: no real failed renewal in test mode.

### SC-05 Renewal halted (retries over)

- **State:** no grace (owner, 29 Oct). `cancelAt` = max(now, paid end) (`scheduleHaltedRenewalEnd`). The usual case is a halt on an unpaid cycle, which is `dunning` → `none` **now** (`endHaltedRenewal`). A halt inside a cycle that was paid for is `cancelling` to that cycle's end, then `none` (SC-08).
- **Gateway:** cancelled (the gateway never cancels a halted subscription itself).
- **Email:** ended now: `subscriptionCancelledEmail` (`unpaidRenewalEnded`), with no separate "renewal paused" email. Paid time left: `paymentFailedEmail` (`isHalted`) with the end date. **Owner:** `HALTED`.
- **Reactivate** in Billing opens a new mandate, which charges the unpaid period on approval.
- **Tests:** unit `razorpay.webhook-fixtures.spec.ts`, `razorpay.billing-emails.spec.ts`; integration `dunning.int.spec.ts`; missed `halted` webhook: `razorpay.reconcile.spec.ts` ("a webhook that never arrived").

### SC-06 Cancel (paid plan)

- **State:** `active` → `cancelling`, `cancelAt` = paid end. At `cancelAt` → `none` (SC-08).
- **Gateway:** cancelled **at once** (`cancel_at_cycle_end: 0`), so the 11 Nov race (a charge at the same second as `cancelAt`) cannot happen.
- **Access:** **everything** up to `cancelAt`, variable-cost features included (owner, 29 Oct).
- **Email:** one `subscriptionCancelledEmail` ("works until <date>"). The `subscription.cancelled` that follows (even twice) adds nothing; a double-clicked Cancel is one cancel. **Owner:** `CANCEL_REQUESTED` with the customer's reason.
- **Edge cases:** a refunded period → ends now (SC-11). A gateway refusal → error with the gateway's reason, nothing saved. Only an admin can cancel (a member can't). Lifetime plans refuse Cancel.
- **Tests:** unit `razorpay.cancel-and-mandates.spec.ts`, `razorpay.reconcile.spec.ts`; integration `billing-reconcile.int.spec.ts`, `billing.int.spec.ts`; e2e `billing.spec.ts`, sandbox `s2`, `s7`, `s14` (USD).

### SC-07 Cancel during a trial (trial on)

- **State:** `trialing` → `cancelling` until the trial's end; nothing is ever charged. The gateway is stopped now (it refuses a cycle-end cancel on a trial).
- **Access:** to the trial end, **but variable-cost features go off at once** (an unpaid cancelled trial never had paid time). Then the account is locked: the trial is spent.
- **Email:** `subscriptionCancelledEmail` (`trialCancelled`, with `firstDebitMayBeUnderway` when cancelled under 24 h before the charge); `trialAccessEndingEmail` 26–48 h before access ends; `workspacePausedEmail` when it lapses with no Free plan to fall back to.
- **Tests:** unit `razorpay.cancel-and-mandates.spec.ts`, `permissions.trial-gate.spec.ts`, `razorpay.trial-policy.spec.ts`; integration `trial-switch.int.spec.ts` ("cancel during the trial"); e2e sandbox `t1`.

### SC-08 Plan ends at `cancelAt` (the exact timer)

- **State:** `cancelling` → `none` at the second `cancelAt` passes.
- **How:** gates already refuse from `cancelAt` on (rule 2). One durable timer per account (Temporal `planEndWorkflow`, id `plan-end-<org>`, `plan.end.timer.ts`) wakes at `cancelAt` and runs the sweep's own code for that one account. A moved date replaces the timer; a cleared date (Reactivate, renewal paid, new plan) stops it. On waking, it re-reads the row, so a stale timer does nothing. The hourly sweep (`endLapsedCancellations`) ends anything the timer missed and re-arms lost timers.
- **Access:** T−1 min publishes; T+1 min is refused with the plan-gate message. Posts and media are kept, and they publish again after paying.
- **Email:** `planEndedEmail`, exactly once, whether the timer or the sweep got there first. Then the media-retention clock starts (SC-24).
- **Tests:** unit `plan.end.timer.spec.ts`, `subscription.plan-end-timer.spec.ts`, `plan.end.workflow.spec.ts`, `trial.policy.spec.ts`; integration `plan-end-cutoff.int.spec.ts`, `x-publish-gate.int.spec.ts`; e2e `billing.spec.ts` ("the end is timed").

### SC-09 Undo cancel (Reactivate)

- **State:** `cancelling` → `active`. A **new mandate** starts at the old paid end, so nothing is charged today and nothing is charged twice. `cancelAt` is cleared once the new mandate is approved, and the timer is stopped.
- **Email:** none; a replacement mandate sends no welcome. **Owner:** `NEW_MANDATE`.
- **Refused for** a disputed account (`assertNotDisputed`). With no plan row left, it's a new checkout instead.
- **Tests:** unit `razorpay.cancel-and-mandates.spec.ts`; integration `billing-reconcile.int.spec.ts`, `billing-plan-change.int.spec.ts`.

### SC-10 Refund on request, minus the fee

There's no self-serve refund button and no advertised money-back offer. A refund happens only on request to support, at our discretion (owner, 29 Oct 19:24). The Terms and the refund page say exactly that.

- **Amount:** the admin Refund button defaults to the payment minus the gateway's fee plus GST (Razorpay's `fee` already includes the GST, so it's taken once). "Full" overrides that, and is reserved for our own mistakes: a charge after cancel, a double charge. Refunds go in the payment's currency.
- **State:** any refund amount on the current subscription → `none` **now** (rule 4). The gateway is cancelled immediately. Ended by the `refund.processed` webhook, whether the refund came from the admin button or the gateway dashboard (one chain).
- **Access:** gone at once; no free-posts perk after a refund.
- **Email:** one `refundEmail` that says the plan ended (the cancelled email is suppressed). `refund.created` while pending waits for `refund.processed`. **Owner:** `REFUND` (or `refund-cancel-refused` with "cancel by hand" if the gateway refuses the cancel; then the customer gets no "it renews" email).
- **Not a plan end:** the ₹5 UPI mandate-check refund, a refund on a superseded subscription, another product's refund on the shared account, or a lifetime account.
- **Admin safety:** super admin only, CSRF-protected, refused while impersonating, audit row written before the refund is sent, a Redis lock plus idempotency key so a double click can't send two (no Redis means refuse), never on a payment with a chargeback.
- **Tests:** unit `refunds.service.spec.ts`, `razorpay.refund-ends-plan.spec.ts`, `razorpay.billing-emails.spec.ts`, frontend `refund-terms.spec.ts`, `frontend/admin-refunds.spec.ts`; integration `admin-refund-fee.int.spec.ts`, `billing-reconcile.int.spec.ts`, `plan-end-cutoff.int.spec.ts`, `admin.int.spec.ts`; e2e `e2e/admin-refunds.spec.ts`, sandbox `s3` (₹1 partial).

### SC-11 Refund, then Cancel days later

- **Refund webhook delivered:** the plan already ended at the refund. Cancel answers "no paid plan to cancel", calls the gateway nothing more and emails nothing.
- **Refund webhook missed:** Cancel reads the refund at the gateway and ends the plan **at once**: not at the paid end, and no grace. One cancelled email; the refund email comes from the refund sweep. The owner hears about the Cancel and the refund once each.
- **Tests:** unit `razorpay.owner-alerts.spec.ts` ("Cancel after a refund of an earlier period" and the tests around it); integration `billing-reconcile.int.spec.ts` (refund 3 days old); e2e sandbox `s4`, `s12`, `s13` (A).

### SC-12 A charge after cancel is refunded by itself

The gateway charged a mandate we had already cancelled. That's our mistake, so it's refunded in full.

- **State:** unchanged; the plan stays `cancelling`/`none` with its saved end. The refund carries `notes.auto`, so its own webhook doesn't end anything.
- **Email:** `refundAfterCancelEmail`, once per refund id. **Owner:** `CHARGED_AFTER_CANCEL` / `AUTO_REFUNDED` info alert.
- **Found by** the `subscription.charged` webhook, or by the hourly guard when that webhook is lost. A forged webhook naming another subscription's payment refunds nothing, and a renewal nobody cancelled is never refunded.
- **Tests:** unit `razorpay.reconcile.spec.ts` ("a charge after cancel is refunded in full"); integration `billing-reconcile.int.spec.ts`; e2e `billing.spec.ts` ("is refunded in full by itself").

### SC-13 Chargeback opened

- **State:** → `disputed` **now** on any `payment.dispute.*` event (matched by prefix, so a new dispute event type still ends the plan). The gateway subscription is cancelled. The account is locked: no Free plan, no free posts, no trial, and checkout is refused with "Contact support".
- **Email:** one neutral `paymentDisputedEmail` per dispute; it claims no penalty, since the first-stage chargeback fee is NIL. **Owner:** `DISPUTE` with "respond within 3 business days", the respond-by date and an auto-built evidence pack.
- **Edge cases:** already refunded, already cancelled, no paid plan, marketplace or lifetime → marked, nothing wrongly cancelled. Gateway unreadable → 5xx and redelivered. A payment under dispute is never refunded on top: the gateway already took the money.
- **Tests:** unit `razorpay.disputes.spec.ts`, `refunds.service.spec.ts`; integration `disputes.int.spec.ts`; e2e `disputes.spec.ts`. Gap: Razorpay test mode can't raise a dispute on a subscription charge.

### SC-14 Chargeback won

- **State:** stays `disputed`. Winning **never** restores the plan by itself, because the owner decides (`won` arriving first still ends the plan).
- **Admin:** restore is refused while the dispute is open, done once when it's won, and never over a newer plan. Clearing the flag lets the account buy again.
- **Email:** the account-correction `PLAN_RESTORED` email, once, when the admin ticks it (off for internal or test accounts). **Owner:** alert per dispute state.
- **Tests:** unit `razorpay.disputes.spec.ts`, `admin.controller.spec.ts`, `workspaces.view.spec.ts`, `account.correction.service.spec.ts`; integration `disputes.int.spec.ts`, `admin-plan-actions.int.spec.ts`; e2e `disputes.spec.ts`, `admin-plan-actions.spec.ts`.

### SC-15 Chargeback lost

- **State:** stays `none` + `disputed`. Nothing is restored, and the money is gone.
- **Admin:** may clear the dispute flag so the person can buy again; that's a new checkout, not a restore.
- **Email:** none to the customer beyond SC-13's note. **Owner:** alert for the `lost` state.
- **Tests:** unit `razorpay.disputes.spec.ts` (every dispute state ends, none restores); integration `disputes.int.spec.ts` (clear lets the workspace buy again).

### SC-16 Mandate revoked or paused by the customer

The customer stops the mandate outside our app: they revoke it in the UPI app, or pause or cancel it in their bank's card portal.

- **Revoke / cancel → `subscription.cancelled`:** treated as a cancel. `cancelling` to the paid end, all features kept, one "works until" email, owner `CANCELLED`. If any charge on it was refunded, it ends now.
- **Pause → `subscription.paused`:** we never pause, so the customer did. We cancel at the gateway now and keep the paid time; one email names the pause. A resume in the app afterwards finds the mandate cancelled and charges nothing. A lost `paused` webhook is caught by the hourly guard.
- **E-mandate:** can't be revoked in an app. The bank cancels it, the next debit fails, and SC-04/SC-05 apply.
- **During a trial:** same as Cancel during a trial (SC-07): access to the trial end, variable-cost features off, one email.
- **Reactivate** opens a new mandate from the paid end.
- **Tests:** unit `razorpay.payment-methods.spec.ts`, `razorpay.webhook-fixtures.spec.ts`; integration `billing-payment-methods.int.spec.ts`, `billing.int.spec.ts`, `trial-switch.int.spec.ts` ("a mandate revoked in the UPI app…"); e2e sandbox `s11` (pause API).

### SC-17 Upgrade, prorated

- **State:** `active` with the new plan **at once**, without waiting for a webhook.
- **Amount:** credit = the unused share of what was actually paid, never negative and never above what was paid, rounded down to the paisa (`unusedCreditMinor`). Example: Standard → Pro on day 16 is quoted ₹700, and the gateway takes ₹700.
- **How, per method:** only an international card is re-planned in place (PATCH, the gateway prorates). An Indian card, UPI, e-mandate or unknown method takes a new mandate with the unused days credited as time (`newMandateUpgradeTerms`). The old mandate is retired only after the new one is approved; a late webhook for the old one never takes the account back. A PATCH with no answer is read back: if it was applied, done; otherwise 503 and no second mandate.
- **Refused:** while dunning (SC-04), same plan again, tampered plan or price in the body (the server prices it), another account, a member. A double click upgrades once.
- **Upgrade while cancelling:** fresh mandate, and the plan no longer ends.
- **First-month-discount customers are full customers** for proration.
- **Email:** none from us (the gateway sends its receipt). **Owner:** `PLAN_CHANGED`.
- **Tests:** unit `razorpay.plan-change.spec.ts`, `razorpay.retire-superseded.spec.ts`, `razorpay.payment-methods.spec.ts`, `razorpay.mapping.spec.ts`; integration `billing-plan-change.int.spec.ts`, `billing-payment-methods.int.spec.ts`; e2e `billing-plan-change.spec.ts`, sandbox `s5`, `s9`, `s10`.

### SC-18 Downgrade at the cycle end

- **State:** stays `active` on the higher plan with its higher limits **until the paid end**; the lower plan starts at the next cycle.
- **How:** an international card is PATCHed with `schedule_change_at: cycle_end`; every other method gets a new mandate starting at the paid end.
- **Undo:** the Billing page shows the date and offers undo (`undoScheduledPlanChange`); undo drops the scheduled change. Another account can't see or undo it.
- **During a trial:** a plan change is a new mandate from the same first-charge date; nothing is charged now.
- **Email:** none. **Owner:** `PLAN_CHANGED` when it takes effect.
- **Tests:** unit `razorpay.plan-change.spec.ts`, frontend `billing.actions.spec.ts`; integration `billing-plan-change.int.spec.ts`, `trial-switch.int.spec.ts` ("plan change during the trial"); e2e `billing-plan-change.spec.ts`, sandbox `t2`.

### SC-19 Offer once per person

The first-month offer goes once per **person**, not per account (owner, 29 Oct).

- **Who counts as the same person:** the same email identity (Gmail dots and `+tags` folded; a `+tag` on a company domain too), a channel that was connected in an account that paid (Hookpost: social account id per network), the same UPI VPA, or the same card (network, last4, issuer, cardholder name, spelling-tolerant) once an approved mandate has shown it (see the open hole below). An admin who paid before, buying from someone else's account. A deleted account still counts through its hashed identity rows (`BillingIdentity`, hashes only). A disposable email never gets the offer.
- **Doesn't count:** someone else's account that only tried (no plan), and internal, marketplace or lifetime accounts.
- **Outcome:** checkout opens at full price, and the page says so before checkout. The rule is one function, `SubscriptionService.personHadBefore`, shared with the trial (SC-20).
- **Tests:** unit `subscription.offer-once.spec.ts`, `razorpay.first-month-offer.spec.ts`; integration `billing-first-month-offer-once.int.spec.ts`. **Gap:** no sandbox/e2e scenario. **Open hole (red team, 2 Nov):** a reused card at checkout is only logged, not refused.

### SC-20 Trial once per person (trial on)

- Same identity rule as SC-19 (`personHadBefore` with `PAID`, `OFFER`, `TRIAL`). An account never gets a second trial.
- **Race:** two checkouts side by side, same person. Both pass checkout; the one approved second is refused at approval and nothing is charged (`secondTrialRefusedEmail`). A payment taken at once is never refused. With the switch off, a trial mandate is never refused at approval.
- **An employee later added as a member of a paying client's account keeps their own trial** (only owners count).
- **Tests:** unit `subscription.trial-gate.spec.ts`, `trial.policy.spec.ts`; integration `trial-switch.int.spec.ts` ("once per person"); e2e sandbox `t3`.

### SC-21 Missed webhook: the reconcile job

A webhook may never arrive (endpoint down, gateway bug). The hourly job (`RazorpayService.onModuleInit` → `reconcileBilling`, `sweepMissedRefunds`, `sweepMissedDisputes`, `endLapsedCancellations`, `armPlanEndTimers`) reads the gateway and runs **the same handler** the webhook would have:

| Lost event | Caught by | Result |
|---|---|---|
| `refund.*` | `sweepMissedRefunds` (gateway refunds of the last 3 days) | plan ends, once; a late webhook adds nothing |
| `payment.dispute.*` | `sweepMissedDisputes` (gateway disputes of the last 45 days, once per dispute and status) | as SC-13/14/15; covers a live webhook that was never subscribed to dispute events |
| `subscription.cancelled` / `completed` / `expired` | `missedEndEvent`, 1 h after `ended_at`, never over a newer approved mandate | same as the webhook |
| `subscription.halted` | `missedEndEvent`, at once (halted has no timestamp; the handler is safe beside a late webhook) | as SC-05 |
| `subscription.paused` | the guard | as SC-16 |
| `subscription.charged` after cancel | the guard | as SC-12 |
| e-mandate first debit never landed | the guard after 7 days | as SC-03 |

**"Charge roka" (stop the charge), owner rule:** when the DB says a plan is ending but the gateway could still charge within 48 h (`PRE_CHARGE_GUARD_MS`), the guard cancels it at the gateway and keeps the access already paid for. Three cases: (1) refunded but the gateway is still live; (2) a cancel that didn't stick; (3) the plan ended here but the gateway will charge. Each sends one `chargeStoppedEmail` and one owner `GUARD_CANCELLED` alert. A refused guard cancel is retried at 5 min, 30 min, 2 h and 6 h, never within 6 h of the charge.

The reverse direction (the gateway charging with no row here, or the gateway done while our row is live) is **reported to the owner only** (`BILLING_MISMATCH`), never acted on. The job never touches a paying customer with no end date, a retrying renewal, lifetime/marketplace rows, or anything it couldn't read. It's safe to run in several processes at once.

- **Tests:** unit `razorpay.reconcile.spec.ts` (guard, refunded period, "a webhook that never arrived", "the other direction", charge after cancel, retries, several processes), `razorpay.refund-ends-plan.spec.ts` (the refund sweep), `razorpay.payment-methods.spec.ts`; integration `billing-reconcile.int.spec.ts`; e2e sandbox `s13` (refund swept, cancel that didn't stick, ended here but the gateway would charge, the 11 Nov race). Partial: a DB `cancelAt` while the gateway is still `active` (matrix §12, recheck 30 Nov).

### SC-22 Foreign cards and USD

- **Currency:** decided by the account's signup country (time zone as a hint; `USD_CHECKOUT` modes, `USD_EXCLUDED_COUNTRIES`); India pays INR, the rest USD ($19/$29 monthly, $190/$290 yearly). A live plan locks its currency, and a stale page gets 409. If the gateway can't be read → 503, never a guessed currency.
- **No first-month offer in USD;** a `percentOff` coupon in USD buys its own discounted dollar plan.
- **Plan changes:** an international card is the only method re-planned in place (SC-17). In test mode the gateway answers 500 to a prorated international update, so that path falls back to a new mandate after 2 min; live behaviour is unconfirmed (no foreign payer yet).
- **An international card authorising in INR** is recorded (`noteInternationalInrAuth`).
- **Refunds** go in the payment's currency, with the fee deducted the same way (about 3% on a foreign card, per the refund terms).
- **Every other scenario is unchanged.** Cancel, refund, chargeback and dunning don't care about currency.
- **Tests:** unit `billing.currency.spec.ts`, `razorpay.currency.spec.ts`, `razorpay.payment-methods.spec.ts`, frontend `pricing-plans.spec.ts`, `proxy.currency.spec.ts`, `pricing.context.spec.ts`; integration `billing.int.spec.ts` (`pricing-context`), `billing-payment-methods.int.spec.ts`; e2e `billing-plan-change.spec.ts` (foreign card), `marketing.spec.ts`, sandbox `s10`, `s14`, `s15`. Open (red team): a Tor signup with `tz: Asia/Kolkata` gets INR.

### SC-23 Forged, replayed and out-of-order webhooks

Cuts across every scenario above.

- A bad or missing signature → 400, nothing changes.
- An event for another product on the shared gateway account (`notes.service` isn't ours) is ignored, or forwarded to its product (`tablamigo.forward.ts`).
- A replay is idempotent: entitlements are upserted, emails and alerts are sent once per key.
- Out of order: `cancelled` before `charged`; `refund.processed` before `refund.created`; a refund before its charge is known; an event 24 h late. Each settles to the correct state, and a late event never undoes a newer one.
- Gateway 5xx while handling → 500, so the gateway redelivers.
- **Tests:** unit `razorpay.controller.spec.ts`, `razorpay.webhook-fixtures.spec.ts`, `razorpay.refund-ends-plan.spec.ts`, `razorpay.disputes.spec.ts`; integration `billing.int.spec.ts`, `billing-reconcile.int.spec.ts`, `dunning.int.spec.ts`, `disputes.int.spec.ts`; e2e sandbox `s7`.

### SC-24 After any plan end: data retention

Every path into `none` (cancel ran out, refund, halt, chargeback, free posts used) starts one clock:

- Day 0: email with the removal date. Day 23: reminder.
- Day 30: the media of queued, draft and failed posts and the media library are purged, unless another account uses them. Post text, published posts, channels and settings stay.
- Paying again clears the clock. The privacy policy says this (`MEDIA_RETENTION_POLICY`).
- **Tests:** unit `trial.policy.media-retention.spec.ts`; integration `media-retention.int.spec.ts`.

---

## 3. Exceptions and known gaps

- **Lifetime, internal, marketplace, Gumroad:** never ended by a refund, halt or sweep (matrix §10). Gumroad has its own refund and chargeback path (`gumroad.license.ts`).
- **Can't be proven in Razorpay test mode:** a dispute on a subscription charge, a real failed renewal, a real e-mandate debit, a yearly renewal reminder 30 days out. Unit and integration tests cover these; the sandbox can't.
- **Open owner calls (red team, 2 Nov):** coupon limits checked only at checkout and per workspace, not per person; a reused card gets the offer again (logged only); autopost keeps generating AI text after the plan ends; tz-based INR for Tor signups.
- **Config:** `TRIAL_CHECKOUT` isn't listed in `.env.example` yet (only `ops/sandbox/restart.sh` writes it). Add the name when the trial is next touched.
