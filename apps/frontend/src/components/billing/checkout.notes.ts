/**
 * What a rupee payment above UPI AutoPay's limit means at checkout.
 *
 * Razorpay's Subscriptions FAQ: UPI is shown at checkout only while the
 * amount is under ₹15,000, and a card mandate needs the customer's approval
 * (additional factor authentication) for every debit above ₹15,000. Pro
 * yearly (₹19,990) is over it, so its checkout has no UPI and each yearly
 * renewal on a card waits for the customer. Standard yearly (₹5,990) is
 * well under it.
 */
export const UPI_AUTOPAY_CAP_INR = 15000;

/** The note for a plan costing `amount` (major units), or null when none is needed. */
export function upiCapNote(
  currency: string | null | undefined,
  amount: number,
  planName = 'This plan'
): string | null {
  if ((currency || 'INR').toUpperCase() !== 'INR') return null;
  if (!(amount > UPI_AUTOPAY_CAP_INR)) return null;
  return `UPI AutoPay covers payments up to ₹${UPI_AUTOPAY_CAP_INR.toLocaleString(
    'en-IN'
  )}, so ${planName} is paid by card or NetBanking. A card asks you to approve each renewal.`;
}
