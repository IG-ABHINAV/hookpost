/**
 * The refund policy, in one place (owner, 29 Oct 2026). /terms,
 * /refund-policy, the home page FAQ (FAQPage structured data) and the billing
 * FAQ all read these lines, so they can never say different things.
 *
 * - No self-serve refund button and no money-back offer: customers get
 *   Cancel, which runs to the end of the period paid for.
 * - A refund happens only on request to support, at our discretion, and is
 *   the payment less the payment gateway's (Razorpay's) fee and the GST on
 *   that fee. The admin refund button deducts it by default
 *   (refunds.service.ts refundQuote).
 * - A full refund only when the mistake is ours: a charge after cancelling,
 *   or a double charge.
 */
export const REFUND_SUPPORT_EMAIL = 'support@hookstep.in';

/** The rule itself, one paragraph. */
export const REFUND_ON_REQUEST = `Payments are not refunded automatically and there is no money-back guarantee. Cancelling stops future charges and your plan runs to the end of the period you have paid for. If something has gone wrong, email ${REFUND_SUPPORT_EMAIL}: any refund is at our discretion, and is the amount you paid less the payment gateway's fee (about 2%, or about 3% on a card issued outside India) and the GST on that fee, which the gateway does not return to us.`;

/** Where we made the mistake, the whole payment comes back. */
export const REFUND_OUR_MISTAKE = `If you are charged twice for the same period, or charged after cancelling, that is our mistake and we refund it in full, fee included.`;

/** For the FAQs: the question and its answer. */
export const REFUND_FAQ = {
  q: 'Can I get a refund?',
  a: `${REFUND_ON_REQUEST} ${REFUND_OUR_MISTAKE}`,
};

/** Wording a page about refunds must never use (refund-terms.spec.ts). */
export const NEVER_PROMISED = [
  /(?<!no )money[- ]back guarantee/i,
  /no questions asked/i,
  /\d+[- ]day (?:money[- ]back|refund)/i,
  /request a refund (?:in|from) (?:billing|settings)/i,
];
