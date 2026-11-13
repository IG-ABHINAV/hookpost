# Billing on every payment method

What a Razorpay subscription can be paid with, what each method does not
support, and the path Hookpost takes for each billing rule. Written 1 Nov 2026
from Razorpay's docs (links below) and the code on
`feat/billing-all-methods-2026-10-29`. The rules live in one place:
`mandateRules()` and `mandateMethod()` in
`libraries/nestjs-libraries/src/services/razorpay.mapping.ts`.

## The methods

| Method (`payment_method`) | How the customer approves it | Max amount | Re-planned in place (PATCH)? | Customer can stop it outside Hookpost | Retries on a failed charge |
|---|---|---|---|---|---|
| Card, issued in India (`card`) | Card details + 3DS/OTP, card tokenised | ₹15,000 per debit without the customer; above that every debit needs the customer's approval (AFA link, 72 h), and Razorpay says those "automatically fail" for domestic cards | **No**: "for Subscriptions created using domestic cards, you can update only the offer" | Pause, resume or cancel in the bank's card portal | T+1, T+2, T+3, then `halted` |
| Card, issued abroad (`card`, payment `international: true`) | Card details + 3DS | No RBI cap | **Yes** (the only one) | Depends on the bank | T+1, T+2, T+3, then `halted` |
| UPI Autopay (`upi`) | VPA or QR, approved in the UPI app | ₹15,000 per debit (₹1 lakh mandate); UPI is not offered for a plan above ₹15,000 | **No**: "you cannot update a Subscription authorised via UPI" | Pause or revoke in the UPI app | T+1, T+2, T+3, then `halted`; debits complete by 9 PM IST, retries may spill to T+1 |
| Bank e-mandate / eNACH (`emandate`, also seen as `nach`) via netbanking, debit card or Aadhaar | At the bank | ₹1 crore (HDFC direct: ₹1 lakh) | **No**: "you cannot modify or edit a mandate that has already been created" | Cannot pause or cancel in an app; can ask the bank to cancel, and the next debit then fails | Only after the bank answers (can take over 24 h); debit moves earlier over bank holidays. First debit lands a banking day after registration; until then the subscription is `created`, and a failed first debit leaves it `created` with no webhook |
| Anything else Razorpay reports, or nothing yet | – | – | Treated as **no** | – | – |

Prices that touch the limits: INR yearly Pro (₹19,990) and Ultimate (₹43,990)
are above ₹15,000, so UPI is not offered for them, and an Indian card's yearly
renewal needs the customer to approve it (AFA). A missed AFA is a failed
renewal: the dunning path below handles it like any other.

## Method x rule

"Safe path" = a new mandate; the old one is cancelled only once the new one is
approved, so nothing is charged twice and the workspace is never without a
mandate.

| Rule | Indian card | International card | UPI | E-mandate | Unknown |
|---|---|---|---|---|---|
| Pay | Checkout, plan at once | same | same | Plan at once at checkout; the debit lands a banking day later. Not a trial while it waits (`isTrialSubscription` needs a start_at). A failed first debit: halted -> "Your plan didn't start", or still `created` after 7 days -> the hourly guard ends it (`endUnpaidFirstCharge`) | same as its route |
| Renew | Razorpay charges; > ₹15,000 needs AFA | same, no AFA | same | same | same |
| Cancel | Razorpay cancelled at once, paid time kept (`cancelAtPeriodEnd`) | same | same | same | same |
| Refund full/partial | Ends the plan now (`handleRefund`), method-agnostic | same | same | same | same |
| Chargeback | Ends the plan now (`handleDispute`) | same | same | same (bank dispute) | same |
| Failed payment + retries | `pending`: AI and X off; `halted`: plan ends | same | same | same, slower (bank answer) | same |
| Customer stops it outside Hookpost | Bank portal cancel -> `subscription.cancelled`, paid time kept. Bank portal **pause** -> `subscription.paused` -> Hookpost cancels at Razorpay, paid time kept, "you paused AutoPay" email (`handlePausedByCustomer`); lost webhook caught by the hourly guard | same | App revoke -> `subscription.cancelled`; app pause -> as card | Bank cancel -> next debit fails -> dunning path | as its webhook says |
| Upgrade | Safe path, unused days credited as time | In place (PATCH), Razorpay prorates | Safe path | Safe path | Safe path |
| Downgrade | Safe path, new mandate from the paid end | In place, `cycle_end` | Safe path | Safe path | Safe path |
| Change payment method | New mandate from the paid end (`startReplacementMandate`) | same | same | same | same |
| Reactivate | New mandate from the old paid end | same | same | same | same |

A PATCH that gets no answer (timeout, 5xx, 408/429) is read back: applied is
done, anything else answers 503 `RAZORPAY_NO_ANSWER` and opens nothing. For 2
minutes nothing is re-sent; after that the subscription takes the new-mandate
route (a PATCH that landed late is found first, on either route). Only a 4xx
refusal falls through to a new mandate at once.

Found live in the sandbox, 1 Nov 2026:
- The Update API refuses `notes` (400 "notes is/are not required and should
  not be sent"). The plan-change PATCH sent them from 29 Oct, so no in-place
  change ever happened until #107; the fakes now refuse them too.
- Test mode answers 500 to an international card's prorated update: it raises
  the proration invoice, fails the charge and leaves the plan (#109 handles
  it). Whether live does the same is unknown: no international card has paid
  Hookpost yet.
- A domestic card's PATCH is refused, as the docs say (sandbox `s9`).

## Test mode

| Method | Razorpay Test mode | Where it is tested |
|---|---|---|
| Indian card | Yes (4718 6091 0820 4366) | sandbox `s1`-`s5`, `s9` |
| International card | Yes (5104 0155 5555 5558; Checkout asks the name and offers DCC) | sandbox `s10` |
| UPI Autopay | QR only in Checkout; `success@razorpay` collect | sandbox `s6` |
| E-mandate | Offered in test Checkout ("EMandate" tab), not driven: its bank pages are not automated here | unit + integration only |
| Pause by customer | No app or bank portal; the pause API raises the same webhook | sandbox `s11` |
| Failed renewal | Dashboard "Charge as failure" only, not over the API | unit + integration |

## Sources

- Supported methods and limits: https://razorpay.com/docs/payments/subscriptions/supported-payment-methods/
- Settings (₹15,000 for cards and UPI): https://razorpay.com/docs/payments/subscriptions/settings/
- Update (domestic cards: offer only): https://razorpay.com/docs/payments/subscriptions/update/
- FAQs (update only on cards, UPI/e-mandate limits, card AFA, cardholder pause/cancel, e-mandate `created` until T+1, customer cancel): https://razorpay.com/docs/payments/subscriptions/faqs/
- Retries per method: https://razorpay.com/docs/payments/subscriptions/payment-retries/
- States: https://razorpay.com/docs/payments/subscriptions/states/
- Webhooks (incl. `subscription.paused` / `resumed`): https://razorpay.com/docs/webhooks/subscriptions/
- Test cards and simulated charges: https://razorpay.com/docs/payments/subscriptions/test/
