/**
 * A checkout this tab opened whose result the page may never see.
 *
 * Paying with UPI AutoPay on Android sends the customer to PhonePe or GPay.
 * Chrome often discards or reloads our tab meanwhile, so Razorpay's success
 * handler never runs, and the reloaded page can ask /user/self before our
 * webhook has created the plan. On 21 Oct the first trial customer's page
 * loaded about 2 s before the webhook and showed him "Start 7-day trial"
 * again, for a trial he had just approved.
 *
 * So the subscription id is kept in sessionStorage (per tab, survives a reload)
 * right before the modal opens. A paywall that loads with one waits for the
 * webhook instead of offering the checkout again.
 */
export const PENDING_CHECKOUT_KEY = 'hookpost_pending_checkout';

/** Older than this, the checkout was abandoned, not in progress. */
export const PENDING_CHECKOUT_MAX_AGE_MS = 30 * 60 * 1000;
export const PENDING_CHECKOUT_POLL_MS = 2000;
export const PENDING_CHECKOUT_TIMEOUT_MS = 45000;
/**
 * How long the wait shows no way out. A remembered checkout only means this
 * tab opened the modal: a reload after the customer cancelled in GPay or
 * PhonePe, or a refresh with the modal open, leaves one too. From then on,
 * "Back to plans" shows while the wait goes on.
 */
export const PENDING_CHECKOUT_LEAVE_AFTER_MS = 10000;

export interface PendingCheckout {
  /** The Razorpay subscription the checkout was opened for. */
  id: string;
  /** When the checkout was opened, ms since the epoch. */
  at: number;
  /** A trial checkout: success goes to TRIAL_STARTED_URL, not a reload. */
  trial: boolean;
}

/**
 * Whether this page itself has the Razorpay modal open. Then the modal's own
 * success handler finishes the checkout, and coming back to the tab from the
 * UPI app must not start a second, competing wait. A reloaded page starts
 * with it false, which is exactly the case the wait is for.
 */
let checkoutOpen = false;
export const setCheckoutOpenInThisPage = (open: boolean) => {
  checkoutOpen = open;
};
export const checkoutOpenInThisPage = () => checkoutOpen;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const sessionStore = (): Store | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Storage blocked: the page behaves as it did before this existed.
    return null;
  }
};

export function rememberPendingCheckout(
  pending: PendingCheckout,
  store: Store | null = sessionStore()
): void {
  try {
    store?.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(pending));
  } catch {
    // Quota or blocked storage: nothing to remember, nothing breaks.
  }
}

export function forgetPendingCheckout(store: Store | null = sessionStore()): void {
  try {
    store?.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    // Nothing to clean up.
  }
}

/** The checkout this tab is waiting on, or null. Drops a stale or broken one. */
export function readPendingCheckout(
  now: number = Date.now(),
  store: Store | null = sessionStore()
): PendingCheckout | null {
  let raw: string | null = null;
  try {
    raw = store?.getItem(PENDING_CHECKOUT_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.id === 'string' &&
      parsed.id &&
      typeof parsed.at === 'number' &&
      now - parsed.at >= 0 &&
      now - parsed.at <= PENDING_CHECKOUT_MAX_AGE_MS
    ) {
      return { id: parsed.id, at: parsed.at, trial: parsed.trial !== false };
    }
  } catch {
    // Not ours or corrupted: drop it below.
  }
  forgetPendingCheckout(store);
  return null;
}

export type PendingCheckoutOutcome = 'confirmed' | 'timeout' | 'stopped';

/**
 * Asks `check` every `intervalMs` until it says the subscription exists, for
 * at most `timeoutMs`. A failed check (network, 5xx) counts as "not yet".
 * Never creates anything: it only reads.
 */
export async function waitForPendingCheckout(opts: {
  check: () => Promise<boolean>;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** True once the page no longer wants the answer (unmounted). */
  stopped?: () => boolean;
}): Promise<PendingCheckoutOutcome> {
  const interval = opts.intervalMs ?? PENDING_CHECKOUT_POLL_MS;
  const timeout = opts.timeoutMs ?? PENDING_CHECKOUT_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const stopped = opts.stopped ?? (() => false);
  const started = now();

  for (;;) {
    if (stopped()) return 'stopped';
    let found = false;
    try {
      found = await opts.check();
    } catch {
      found = false;
    }
    if (stopped()) return 'stopped';
    if (found) return 'confirmed';
    if (now() - started + interval > timeout) return 'timeout';
    await sleep(interval);
  }
}
