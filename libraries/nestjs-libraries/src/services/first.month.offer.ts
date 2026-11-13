/**
 * 20% off the first month of a new rupee monthly plan (owner's approval,
 * 22 Oct 2026), through Razorpay Subscription Offers.
 *
 * The offers live in the Razorpay dashboard; Razorpay has no API to create
 * them. There are two, one for UPI and one for cards, each "Single Use",
 * 20% capped at ₹400, and set to let a payment through without the offer
 * when the method does not match. Their ids are read from
 * RAZORPAY_OFFER_FIRST_MONTH_UPI and RAZORPAY_OFFER_FIRST_MONTH_CARD. An
 * unset or malformed id means no offer for that method, and checkout runs
 * exactly as it did before.
 *
 * What Razorpay allows. Sources are its Subscription Offers docs and two
 * live subscriptions created and cancelled on 22 Oct 2026:
 * - A subscription carries one offer_id, and an offer covers one payment
 *   method. So the customer picks UPI or card before the subscription is
 *   created, and the matching offer is attached. Paying another way is
 *   charged the full price, because the offers allow payment without them.
 * - The discount comes off the payment taken at checkout. On a ₹599 plan,
 *   Razorpay's checkout offered ₹479.20 (offer_applicable: plan). Later
 *   months are charged in full.
 * - A subscription that starts later is refused: POST /subscriptions with a
 *   future start_at and an offer_id answered 400 "Offer not applicable for
 *   this subscription". The same offer on the same plan without start_at
 *   was accepted. A trial and a free-months coupon both set start_at, so
 *   neither gets the offer.
 * - An offer can be linked to a live subscription only while it is active,
 *   only from the next cycle, and never on a UPI mandate. So plan changes
 *   and replacement mandates never get one.
 *
 * ONCE PER PERSON (owner, 29 Oct 2026): the offer is for new customers. A
 * workspace whose people already had a paid plan or the offer, here or in
 * another workspace, deleted ones included, does not get it
 * (SubscriptionService.personHadBefore: the owner's email however it is
 * spelled, a channel, a UPI VPA or card; never for a disposable email). It
 * is decided before the subscription is created, and the pricing context
 * already leaves the offer out for such a workspace, so the price the
 * customer is shown is the price they pay. A match found only once the
 * payment is made (the method it was paid with) never changes that charge;
 * it is stored, so the next workspace is refused.
 *
 * Pure functions. The backend decides with them (RazorpayService.subscribe),
 * and the checkout pages use the same functions to decide what to show.
 */

export const FIRST_MONTH_OFFER_PERCENT = 20;
/** Razorpay caps the discount at this many rupees (max_cashback 40000 paise). */
export const FIRST_MONTH_OFFER_CAP_INR = 400;

export type OfferMethod = 'upi' | 'card';
/** In the order the choice is offered: every rupee Hookpost has collected came by UPI. */
export const OFFER_METHODS: readonly OfferMethod[] = ['upi', 'card'];

const ENV_KEY: Record<OfferMethod, string> = {
  upi: 'RAZORPAY_OFFER_FIRST_MONTH_UPI',
  card: 'RAZORPAY_OFFER_FIRST_MONTH_CARD',
};

/** Razorpay's own format: "offer_" and 14 letters or digits, 20 characters. */
const OFFER_ID = /^offer_[A-Za-z0-9]{14}$/;

type Env = Record<string, string | undefined>;
const processEnv = (): Env =>
  typeof process !== 'undefined' && process.env ? process.env : {};

/** The configured offer id per method. A malformed value counts as unset. */
export function firstMonthOfferIds(
  env: Env = processEnv()
): Partial<Record<OfferMethod, string>> {
  const ids: Partial<Record<OfferMethod, string>> = {};
  for (const method of OFFER_METHODS) {
    const raw = (env[ENV_KEY[method]] || '').trim();
    if (OFFER_ID.test(raw)) ids[method] = raw;
  }
  return ids;
}

/** What the pages may say about the offer: sent in the pricing context. */
export interface FirstMonthOfferTerms {
  percent: number;
  capInr: number;
  /** The methods with an offer, UPI first. */
  methods: OfferMethod[];
}

/** The offer's terms for a checkout in `currency`, or null when it has none. */
export function firstMonthOfferTerms(
  currency: string | null | undefined,
  env: Env = processEnv()
): FirstMonthOfferTerms | null {
  if ((currency || '').toUpperCase() !== 'INR') return null;
  const ids = firstMonthOfferIds(env);
  const methods = OFFER_METHODS.filter((m) => !!ids[m]);
  if (!methods.length) return null;
  return {
    percent: FIRST_MONTH_OFFER_PERCENT,
    capInr: FIRST_MONTH_OFFER_CAP_INR,
    methods,
  };
}

/** The facts about one checkout that decide whether it gets the offer. */
export interface OfferCheckout {
  currency: string | null | undefined;
  period: string | null | undefined;
  /** Any website coupon, affiliate codes included. The coupon wins. */
  coupon: boolean;
  /** The first charge is later (start_at): a trial, or a free-months coupon. */
  startsLater: boolean;
  /** The workspace has no subscription on file: not a plan change or upgrade. */
  newSubscription: boolean;
  /**
   * Someone behind the workspace already had a paid plan or the offer
   * (SubscriptionService.personHadBefore). Absent means not asked.
   */
  usedBefore?: boolean;
}

/** Whether the offer may go on this checkout. See the rules at the top. */
export function firstMonthOfferApplies(c: OfferCheckout): boolean {
  return (
    (c.currency || '').toUpperCase() === 'INR' &&
    (c.period || '').toUpperCase() === 'MONTHLY' &&
    !c.coupon &&
    !c.startsLater &&
    c.newSubscription &&
    !c.usedBefore
  );
}

/**
 * The method whose offer goes on the subscription: the one asked for when it
 * has an offer, else the first that has one.
 */
export function pickOfferMethod(
  methods: readonly OfferMethod[],
  payWith?: string | null
): OfferMethod | null {
  const asked = (payWith || '').toLowerCase() as OfferMethod;
  if (methods.includes(asked)) return asked;
  return methods[0] ?? null;
}

/** The offer to attach to this checkout, or null. */
export function firstMonthOfferFor(
  c: OfferCheckout & { payWith?: string | null },
  env: Env = processEnv()
): { offerId: string; method: OfferMethod } | null {
  if (!firstMonthOfferApplies(c)) return null;
  const ids = firstMonthOfferIds(env);
  const method = pickOfferMethod(
    OFFER_METHODS.filter((m) => !!ids[m]),
    c.payWith
  );
  return method ? { offerId: ids[method]!, method } : null;
}

/** The first month's price after the offer, in rupees (paise kept): 599 -> 479.2. */
export function firstMonthPrice(
  monthPrice: number,
  terms: Pick<FirstMonthOfferTerms, 'percent' | 'capInr'> = {
    percent: FIRST_MONTH_OFFER_PERCENT,
    capInr: FIRST_MONTH_OFFER_CAP_INR,
  }
): number {
  const off = Math.min((monthPrice * terms.percent) / 100, terms.capInr);
  return Math.round((monthPrice - off) * 100) / 100;
}

/** "₹599", or "₹479.20" when there are paise. */
export function formatRupees(amount: number): string {
  const whole = Number.isInteger(amount);
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "First month 20% off (new customers), up to ₹400" */
export function firstMonthOfferHeadline(
  terms: Pick<FirstMonthOfferTerms, 'percent' | 'capInr'> = {
    percent: FIRST_MONTH_OFFER_PERCENT,
    capInr: FIRST_MONTH_OFFER_CAP_INR,
  }
): string {
  return `First month ${terms.percent}% off (new customers), up to ${formatRupees(terms.capInr)}`;
}

const METHOD_WORD: Record<OfferMethod, string> = { upi: 'UPI', card: 'card' };

/**
 * /pricing, rupee view: "First month 20% off (new customers), up to ₹400,
 * on a monthly plan paid by UPI or card."
 */
export function pricingPageOfferLine(terms: FirstMonthOfferTerms): string {
  return `${firstMonthOfferHeadline(
    terms
  )}, on a monthly plan paid by ${offerMethodsText(terms.methods)}.`;
}

/** "UPI", "card", or "UPI or card". */
export function offerMethodsText(methods: readonly OfferMethod[]): string {
  return methods.map((m) => METHOD_WORD[m]).join(' or ');
}

/**
 * The line under the headline at checkout, for the method chosen: what the
 * first month costs that way, what it costs after, and that another method
 * pays the full price.
 */
export function firstMonthOfferDetail(input: {
  terms: FirstMonthOfferTerms;
  method: OfferMethod;
  /**
   * The plan's monthly price in rupees. Without one (a page listing several
   * plans) the line names no amount.
   */
  monthPrice?: number;
}): string {
  const { terms, method, monthPrice } = input;
  if (!(Number(monthPrice) > 0)) {
    return `Pay by ${METHOD_WORD[method]} and the first month of a monthly plan is ${terms.percent}% off; later months are the full price. Paying another way is charged the full price.`;
  }
  const full = formatRupees(monthPrice!);
  const first = formatRupees(firstMonthPrice(monthPrice!, terms));
  return `Pay by ${METHOD_WORD[method]} and your first month is ${first}, then ${full} a month. Paying another way is charged ${full}.`;
}
