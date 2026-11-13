# Billing and plan emails

Every email the billing/plan system sends, who gets it, what sets it off and
what stops it being sent twice. Written 29 Oct 2026; keep it current when a
billing email is added, renamed or removed.

Two separate delivery paths, both through Resend:

| | Customer emails | Owner alerts |
|---|---|---|
| Sender | `RazorpayService.sendCustomerEmail` (`razorpay.service.ts`) | `OwnerSalesAlertService.deliver` (`owner.sales.alert.service.ts`) |
| Recipient | the workspace's billing contact: the **first** member of the team (`getTeam(orgId).users[0].user.email`) | `OWNER_SALES_ALERT_EMAIL`, one or more addresses |
| From | `Hookpost Billing <support@hookstep.in>` (the welcome email uses `Hookpost Support <…>`) | `Hookpost Sales <support@hookstep.in>` |
| Reply-to | `support@hookstep.in` | — |
| Format | HTML + plain text, rendered through `emails/layout/email.layout.ts` | plain text, one fact per line |
| Send-once | Redis `SET NX` on `razorpay:customer-email:<key>`, TTL 45 days (`EMAIL_ONCE_TTL_SECONDS`) | Redis `SET NX` on `owner-sales-alert:<key>`, TTL 45 days, up to 400 days when the caller asks |
| Redis down | **nothing is sent** (a missing email is easier to put right than a duplicate) | **sent anyway** (for the owner a duplicate beats a missed sale) |
| Send fails | the claim is released (`releaseOnce`), so a webhook redelivery retries | three quick attempts, then a Redis queue retried every 30 min for a day |

The hourly sweeps below run only where `RUN_CRON=true` (production backend and
orchestrator), every 60 minutes, starting two minutes after boot:
`endLapsedCancellations`, `sendTrialReminders`, `sendCancelledTrialReminders`
(`RazorpayService.onModuleInit`).

Internal workspaces (`RazorpayService.isInternalWorkspace`: a platform super
admin is a member, or `FREE_PLAN_SUNSET_EXEMPT_ORGS` lists the org) are skipped
only where the table says so.

---

## Customer emails

| # | Event | Trigger | Timing | Template | Send-once key | Internal skipped |
|---|---|---|---|---|---|---|
| 1 | Welcome / trial started | `createSubscription`, first subscription on file and not a replacement mandate. Webhooks `subscription.authenticated`, `.activated`, `.charged`, `.updated`, and `/razorpay/verify` | at once | `subscriptionWelcomeEmail` | `welcome:<subscription.id>` | no |
| 2 | Payment failing, Razorpay retrying | webhook `subscription.pending` | at once, once per billing cycle | `paymentFailedEmail` | `payment-failed:<sub.id>:<cycleStart>` | no |
| 3 | First charge after a trial declined | `subscription.pending` on a subscription never yet paid | at once | `paymentFailedEmail` → `firstChargeRetryEmail` | same key as #2 | no |
| 4 | Renewal halted | webhook `subscription.halted` on a paid plan (`scheduleHaltedRenewalEnd`: ends at the paid end, no grace) | at once | `paymentFailedEmail` (`isHalted`) | `payment-failed:<sub.id>:<cycleStart>:halted` | no |
| 5 | Trial ends soon | hourly `sendTrialReminders`; first charge 24–48 h away | hourly | `trialReminderEmail` | `trial-reminder:<sub.id>` | no |
| 6 | Cancelled trial still running, reactivate by | hourly `sendCancelledTrialReminders`; access ends in 26–48 h and it was cancelled at least 12 h ago | hourly | `trialAccessEndingEmail` | `trial-access-ending:<sub.id>` | **yes** |
| 7 | Workspace paused (cancelled trial ran out, new cohort) | hourly `endLapsedCancellations`, when there is no Free plan to fall back to | hourly | `workspacePausedEmail` | `trial-ended-paused:<sub.id>` | **yes** |
| 8 | Plan cancelled (seven copy variants, one template) | webhook `subscription.cancelled`; also called straight from `endHaltedUnpaidTrial`, `endHaltedRenewal`, `endRefundedSubscription` and `cancelAtPeriodEnd` on a refunded plan | at once | `subscriptionCancelledEmail` | `cancelled:<sub.id>` | no |
| 9 | Refund on its way | webhook `refund.processed`, and `refund.created` when Razorpay already says processed | at once | `refundEmail` | `refund:<refund.id>` | no |
| 10 | Free plan is ending | `scripts/notify-free-plan-sunset.ts --send`, run by hand | one-off | `freePlanSunsetEmail` | DB row, `UsedCodes.code = notice:free_plan_sunset:<userId>` (no TTL) | **yes** (super-admin owners are skipped) |

### The variants of #8

One template, `subscriptionCancelledEmail`, picks its copy from the flags the
caller passes:

| Variant | Flags | When |
|---|---|---|
| Trial cancelled, still running | `trialCancelled`, `accessUntil` | the customer cancelled a trial before its first charge |
| Trial cancelled late | + `firstDebitMayBeUnderway` | cancelled under 24 h before the first charge, so the debit may already be at the bank |
| Unpaid trial ended | `unpaidTrialEnded` | every retry of the first charge failed |
| Unpaid renewal ended | `unpaidRenewalEnded` | a halted renewal was not paid by the end of its paid time |
| Ended by a refund | `endedByRefund`, no `accessUntil` | any refund on the workspace's current subscription |
| Cancelled, paid time left | `accessUntil` | an ordinary cancel mid-cycle |
| Cancelled, ended now | `accessUntil: null` | nothing left to run |

No customer email goes out when the cancellation is a plan switch
(`hasReplacementSubscription`): the new mandate's own emails cover it.

---

### Added by the 29 Oct - 1 Nov billing PRs (#70, #71, #73, #74, #76, #81)

| # | Event | Trigger | Timing | Template | Send-once key | Internal skipped |
|---|---|---|---|---|---|---|
| A1 | Plan has ended | Temporal timer at `cancelAt` (`planEndDue`, #73); the hourly sweep is backup only and sends nothing a second time (#76) | at the second the plan ends | `planEndedEmail` | `plan-ended:<sub.id>` | no |
| A2 | Charge stopped ("charge roka") | hourly guard `reconcileBilling` cancels a Razorpay mandate that could still charge: refunded but live, a cancel that did not stick, DB ended but Razorpay would charge (#71); also admin "End plan now" with that reason | hourly / at once | `chargeStoppedEmail` (billing.emails.ts, the one template for it) | `charge-stopped:<sub.id>` | **yes** |
| A3 | Charge after cancel refunded | guard finds a payment taken after the cancel and refunds it in full on its own (#81) | hourly | `refundAfterCancelEmail` | `refund:<refund.id>` | no |
| A4 | Chargeback: plan ended | webhook `payment.dispute.*` (#74) | at once | `paymentDisputedEmail` | `dispute:<dispute.id>` | no |
| A5 | Renewal halted | webhook `subscription.halted`: the plan ends at the paid end, never later (#70); replaces row 4's grace | at once | `paymentFailedEmail` (`isHalted`) | as row 4 | no |
| A6 | Yearly plan renews in 30 days | hourly `sendRenewalReminders`: a YEARLY row with no end date, Razorpay `active` and set to renew, charge 3-30 days away (big-company practice and California's 15-45 day notice, billing benchmark 1 Nov) | hourly, once per renewal | `renewalReminderEmail` | `renewal-reminder:<sub.id>:<charge_at>` | **yes** |

## Owner alerts

All of these render through `ownerSaleAlertEmail` and go to
`OWNER_SALES_ALERT_EMAIL`. `[TEST]` in the subject means fake money (a Razorpay
test key or a provider test purchase); `[INTERNAL]` means real money on one of
our own workspaces.

| Event | Trigger | Alert key |
|---|---|---|
| `TRIAL_STARTED` | a new trial mandate is on file | `start:<sub.id>` |
| `FIRST_CHARGE` | the first real charge of a subscription | `charge:<payment.id>` |
| `NEW_PLAN_CHARGE` | the first charge of a mandate opened for a UPI plan change | `charge:<payment.id>` |
| `RENEWAL` | any later charge | `charge:<payment.id>` |
| `PLAN_CHANGED` | tier or period differs from the previous paid plan | `plan:<sub.id>:<from>-><to>` |
| `NEW_MANDATE` | same plan, new mandate (Reactivate, change payment method) | `mandate:<sub.id>` |
| `CANCEL_REQUESTED` | the customer pressed Cancel in Billing | `cancel:<sub.id>`, longer TTL |
| `CANCELLED` | webhook `subscription.cancelled` | `cancel:<sub.id>` |
| `PAYMENT_FAILING` | webhook `subscription.pending` | `failing:<sub.id>:<cycle>` |
| `HALTED` | webhook `subscription.halted` | `halted:<sub.id>:<cycle>` |
| `REFUND` | `handleRefund` | `refund:<refund.id>`, or `refund-cancel-refused:<refund.id>` when Razorpay refused the cancel |
| `GUMROAD_REDEEMED` | a Gumroad license key is bound to a workspace | `gumroad-redeem:<saleId>` |
| `GUMROAD_CHANGED` | the daily Gumroad re-check found a status change | `gumroad:<license.id>:<status>` |

A `CANCEL_REQUESTED` alert claims `cancel:<sub.id>` before the call to
Razorpay and marks it (`OwnerSalesAlertService.mark`), so the
`subscription.cancelled` webhook that follows stands back and the alert that
goes out is the one carrying the customer's reason.

Owner alerts added by the same PRs (all through `OwnerSalesAlertService`, once per key): `GUARD_CANCELLED` (`guard-cancel:<sub.id>`), `CHARGED_AFTER_CANCEL`, `AUTO_REFUNDED`, `DISPUTE` (with the 3-business-day deadline and the evidence pack), `BILLING_MISMATCH` (the guard found the DB and Razorpay disagreeing and changed nothing), `PLAN_CHANGED`, `CANCEL_REQUESTED`.

## Internal notes (not to a customer)

| What | To | Trigger | Send-once key |
|---|---|---|---|
| A Razorpay checkout took over a Gumroad plan: the customer may be paying twice | `EMAIL_FROM_ADDRESS` (the support inbox) | `RazorpayService` sees a Razorpay subscription replace a live Gumroad plan | `gumroad-plan-replaced:<subscriptionId>` |

---

## Account correction emails

Added 29 Oct 2026. These are not driven by a Razorpay webhook: they say that
**we** got something wrong and have now put it right. Each one is sent by
`AccountCorrectionService.notify` (`services/account.correction.service.ts`),
which renders the template, sends it once, and raises the matching owner alert.

| Event | What it says | Sent by | Send-once key | Owner alert |
|---|---|---|---|---|
| `PLAN_CORRECTED_ENDED` | our records showed a plan that had already ended or was never paid; we have ended it | admin "End plan now" (the reconcile job never ends a plan by itself: it stops the charge and sends `CHARGE_STOPPED`, row A2) | `plan-corrected-ended:<orgId>:<ref>` | `PLAN_CORRECTED_ENDED` |
| `CHARGE_STOPPED` | a mandate at Razorpay could still have charged after the plan ended; we stopped it (the guard's own template, row A2) | the billing reconcile job; admin "End plan now" when it also cancels at Razorpay | `charge-stopped:<orgId>:<ref>` | `CHARGE_STOPPED` |
| `PLAN_RESTORED` | the workspace was paused or ended by mistake and access is back | admin "Restore plan" | `plan-restored:<orgId>:<ref>` | `PLAN_RESTORED` |
| `DUPLICATE_CHARGE_REFUNDED` | a charge taken twice has been refunded | admin, after refunding the duplicate | `duplicate-charge-refunded:<orgId>:<ref>` | `DUPLICATE_CHARGE_REFUNDED` |
| `REFUND_ENDED_PLAN` | a payment we refunded earlier should have ended the plan at the time; it has ended now | admin; the billing reconcile job | `refund-ended-plan:<orgId>:<ref>` | `REFUND_ENDED_PLAN` |

`<ref>` is the thing the correction is about (a Razorpay subscription or
refund id), so one correction of one subscription sends one email however many
times the job runs. Without one the key falls back to the India calendar day,
which keeps a job that reruns within a day from emailing twice.

Correction emails are **not** sent to an internal workspace (the same test as
everywhere else: a platform super admin is a member, or
`FREE_PLAN_SUNSET_EXEMPT_ORGS` lists it), and an admin can switch the customer
email off per action with the opt-out checkbox. The owner alert always goes out,
so a suppressed email is still visible.

### Why these five

Each is a class of bug that has actually happened:

- **`PLAN_CORRECTED_ENDED`** — RK DEFENCE ACADEMY (org `d936df7d`, 29 Oct
  2026): a trial cancelled at Razorpay on 21 Oct with nothing ever charged, and
  a Subscription row still live in our database with `cancelAt` on 11 Nov. The
  hourly sweep would not have ended it before that date. Also the halted-renewal
  bug of 20 Oct (org `1afc0283`), where a halted subscription kept its plan
  indefinitely because Razorpay never auto-cancels one.
- **`CHARGE_STOPPED`** — 13 Oct 2026: `getCustomerSubscriptions` had been
  passing `customer_id` to `GET /subscriptions`, which Razorpay answers with a
  400, and the catch returned an empty list. Superseded mandates were therefore
  never retired, and a stray subscription (`sub_TnNpH2wiQSoryO`, starting 2036)
  was created by a cancel that misread `end_at`.
- **`PLAN_RESTORED`** — the other direction of the same reconciliation: a
  workspace ended or locked by a sweep, a guard or an admin on facts that turn
  out to be wrong.
- **`DUPLICATE_CHARGE_REFUNDED`** — Sept 2026: a Standard→Pro upgrade on a UPI
  mandate cannot be PATCHed, so `changeSubscription` opened a fresh mandate
  without cancelling the old one and the workspace was billed for both plans
  every month. The Gumroad takeover alert is the same class across two
  providers.
- **`REFUND_ENDED_PLAN`** — JR Consulting (org `a8bed6eb`): the 10 Oct renewal
  was refunded on 11 Oct and the plan carried on anyway, with the next charge
  still set for 10 Nov. Since PR #64/#65 a *new* refund ends the plan, but
  nothing goes back and corrects a refund from before that. This event is for
  those.

A correction event is not the same thing as the `endedByRefund` flag on
`refundEmail` and `subscriptionCancelledEmail`. That flag is part of handling a
refund as it happens; `REFUND_ENDED_PLAN` is for a refund we failed to act on at
the time.

---

## Admin actions

Superadmin only, on the Users & Billing page (`/admin/users`):

| Action | Endpoint | What it runs | Email | Audit |
|---|---|---|---|---|
| End plan now | `POST /admin/plan/end` | `RazorpayService.cancelSubscription` when a Razorpay subscription is still live, otherwise `SubscriptionService.deleteSubscriptionByOrg` — the same paths the app uses | `PLAN_CORRECTED_ENDED`, or `REFUND_ENDED_PLAN` / `CHARGE_STOPPED` when the admin picks that reason | `PlanActionAudit` |
| Restore plan | `POST /admin/plan/restore` | `SubscriptionService.addSubscription` (the existing superadmin add-subscription path) | `PLAN_RESTORED` | `PlanActionAudit` |

Both need a written reason, are refused while impersonating (as refunds are),
and write a `PlanActionAudit` row before anything changes, which is then
finished with the outcome.

---

## Gaps

Billing state changes that send the customer nothing today. Listed so the next
person does not have to rediscover them; none of them is necessarily wrong.

| What happens | Who hears about it |
|---|---|
| `subscription.completed` / `subscription.expired` | nobody; the plan is just downgraded |
| A paid plan's cancellation grace runs out in `endLapsedCancellations` | nobody — the trial path has `workspacePausedEmail`, the paid path has no equivalent |
| A trial's grace runs out on a grandfathered workspace, which moves to the Free plan | nobody (the paused email is only for the new cohort) |
| A halted renewal is paid before its paid time runs out and the plan is saved | the owner gets `RENEWAL`; the customer gets no "you're back" email |
| A charge succeeds after one or more failures | the owner only |
| Gumroad: redeemed, refunded, cancelled, membership ended | the owner only; there is no customer-facing Gumroad email at all |
| `payment.failed` on its own | nobody; `subscription.pending` and `.halted` own the failure messages |
| A plan switch (the old subscription is cancelled) | nobody is told the old plan ended; the new plan's welcome has to carry it |
| The Free plan sunset date passing | nobody, unless the one-off script is run |
| A lifetime, marketplace or admin-granted plan starting or ending | nobody |
| An admin changes a workspace's tier from the admin page | nobody (before this change; `End plan now` and `Restore plan` now do email) |

Two more worth knowing about:

- With Redis unreachable no customer billing email is sent at all, by design.
  The plan change still happens, so a Redis outage is silent to the customer.
- The billing contact is the **first** member of the workspace, which is not
  necessarily the person who paid.
