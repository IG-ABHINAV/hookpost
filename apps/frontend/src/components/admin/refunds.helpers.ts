/**
 * Pure helpers of the super-admin Refunds page (admin-refunds.component.tsx):
 * money formatting, what a payment's refund state reads as, and folding a
 * refund made on the page into the rows already on screen, so they change at
 * once instead of after a reload. Amounts are in minor units (paise, cents).
 */

/** From GET /admin/refunds/payments. */
export interface RefundPayment {
  id: string;
  status: string;
  amount: number;
  amountRefunded: number;
  refundable: number;
  /** Razorpay's fee on the payment, GST included (absent before it settles). */
  fee?: number;
  /** The GST inside `fee`. */
  tax?: number;
  /** The default refund: the payment less Razorpay's fee, never more than is left. */
  refundableAfterFee?: number;
  refundStatus: string | null;
  currency: string;
  method: string | null;
  email: string | null;
  description: string | null;
  international: boolean;
  createdAt: string;
  hookpost: boolean;
  service: string | null;
  organizationId: string | null;
  organizationName: string | null;
  subscriptionId: string | null;
}

/** From POST /admin/refunds and /admin/refunds/bulk. */
export interface RefundResult {
  paymentId: string;
  status: 'refunded' | 'refused' | 'failed';
  amount?: number;
  currency?: string;
  refundId?: string;
  refundStatus?: string;
  error?: string;
}

export type RefundMadeFrom = 'tool' | 'dashboard' | 'other';

/** From GET /admin/refunds/history. */
export interface RefundHistoryRow {
  id: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  reference: string | null;
  paymentFound: boolean;
  paymentAmount: number | null;
  email: string | null;
  description: string | null;
  madeFrom: RefundMadeFrom;
  madeBy: string | null;
  reason: string | null;
  hookpost: boolean;
  service: string | null;
  organizationId: string | null;
  organizationName: string | null;
  subscriptionId: string | null;
}

export const money = (minor: number, currency: string) => {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-US', {
      style: 'currency',
      currency: currency || 'INR',
      minimumFractionDigits: 2,
    }).format((minor || 0) / 100);
  } catch {
    return `${((minor || 0) / 100).toFixed(2)} ${currency}`;
  }
};

/**
 * What the Refund button sends: by default the payment less Razorpay's fee
 * and its GST (owner, 29 Oct 2026: refunds are at our discretion and the fee
 * is not ours to give back); everything left only when `full` is ticked, for
 * our own mistakes (a charge after cancel, a double charge). An older backend
 * that sends no fee figures falls back to everything left.
 */
export const defaultRefundMinor = (
  p: Pick<RefundPayment, 'refundable' | 'refundableAfterFee'>,
  full: boolean
) =>
  full
    ? Math.max(0, p.refundable || 0)
    : Math.max(0, Math.min(p.refundable || 0, p.refundableAfterFee ?? p.refundable ?? 0));

export const moneyTotals = (totals: Record<string, number>) => {
  const parts = Object.entries(totals).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(' + ') : '—';
};

export type RefundKind = 'full' | 'partial' | 'none' | 'unpaid';

/**
 * How much of a payment has gone back, in words for the badge:
 * "Fully refunded", "Partly refunded" with "₹693.00 of ₹699.00 refunded ·
 * ₹6.00 left", "Not refunded", or, for a payment that was never captured,
 * what Razorpay calls it (nothing was charged, so nothing can be refunded).
 */
export const refundState = (
  p: Pick<RefundPayment, 'status' | 'amount' | 'amountRefunded' | 'refundable' | 'currency'>
): { kind: RefundKind; label: string; detail: string | null } => {
  const refunded = Math.max(0, p.amountRefunded || 0);
  if (p.status === 'refunded' || (refunded > 0 && refunded >= p.amount)) {
    return {
      kind: 'full',
      label: 'Fully refunded',
      detail: `${money(refunded || p.amount, p.currency)} refunded`,
    };
  }
  if (refunded > 0) {
    const left = p.status === 'captured' ? p.refundable : Math.max(0, p.amount - refunded);
    return {
      kind: 'partial',
      label: 'Partly refunded',
      detail: `${money(refunded, p.currency)} of ${money(p.amount, p.currency)} refunded · ${money(
        left,
        p.currency
      )} left`,
    };
  }
  if (p.status === 'captured') return { kind: 'none', label: 'Not refunded', detail: null };
  return {
    kind: 'unpaid',
    label:
      p.status === 'failed'
        ? 'Payment failed'
        : p.status === 'authorized'
        ? 'Not captured'
        : p.status
        ? `Payment ${p.status}`
        : 'Not paid',
    detail: null,
  };
};

/**
 * The payment as it stands after refunds made on this page since the list
 * loaded. `refundedTotal` is its amount_refunded after those refunds; the
 * larger of it and the server's figure wins, so a reload that already has
 * them changes nothing.
 */
export const withLocalRefund = (p: RefundPayment, refundedTotal?: number): RefundPayment => {
  if (!refundedTotal || refundedTotal <= p.amountRefunded) return p;
  const amountRefunded = Math.min(refundedTotal, p.amount);
  const full = amountRefunded >= p.amount;
  return {
    ...p,
    amountRefunded,
    refundable: p.status === 'captured' && !full ? p.amount - amountRefunded : 0,
    status: full ? 'refunded' : p.status,
    refundStatus: full ? 'full' : 'partial',
  };
};

/**
 * Adds the refunds that went through to `prev` (payment id -> amount_refunded
 * after them). `refundedBefore(id)` is the server's figure for the payment.
 */
export const nextLocalRefunds = (
  prev: Record<string, number>,
  results: RefundResult[],
  refundedBefore: (paymentId: string) => number
): Record<string, number> => {
  const next = { ...prev };
  for (const r of results) {
    if (r.status !== 'refunded' || !r.amount) continue;
    next[r.paymentId] = Math.max(next[r.paymentId] || 0, refundedBefore(r.paymentId)) + r.amount;
  }
  return next;
};

/**
 * History rows for refunds just made on this page, shown until Razorpay's
 * list has them. `payment` gives the customer and product of each.
 */
export const historyRowsFromResults = (
  results: RefundResult[],
  payment: (paymentId: string) => RefundPayment | undefined,
  adminEmail: string | null,
  now: Date = new Date()
): RefundHistoryRow[] =>
  results
    .filter((r) => r.status === 'refunded' && r.refundId)
    .map((r) => {
      const p = payment(r.paymentId);
      return {
        id: r.refundId!,
        paymentId: r.paymentId,
        amount: r.amount || 0,
        currency: r.currency || p?.currency || '',
        status: r.refundStatus || 'pending',
        createdAt: now.toISOString(),
        reference: null,
        paymentFound: !!p,
        paymentAmount: p ? p.amount : null,
        email: p?.email || null,
        description: p?.description || null,
        madeFrom: 'tool' as const,
        madeBy: adminEmail,
        reason: null,
        hookpost: p ? p.hookpost : true,
        service: p?.service || null,
        organizationId: p?.organizationId || null,
        organizationName: p?.organizationName || null,
        subscriptionId: p?.subscriptionId || null,
      };
    });

/**
 * Razorpay's rows, with the ones made here that it does not list yet on top.
 * A refund Razorpay lists replaces the local copy. Newest first.
 */
export const mergeHistory = (
  server: RefundHistoryRow[],
  local: RefundHistoryRow[],
  scope: 'hookpost' | 'all'
): RefundHistoryRow[] => {
  const listed = new Set(server.map((r) => r.id));
  const seen = new Set<string>();
  return [...local.filter((r) => !listed.has(r.id) && (scope === 'all' || r.hookpost)), ...server]
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
};

export const madeFromLabel = (r: Pick<RefundHistoryRow, 'madeFrom'>) =>
  r.madeFrom === 'tool'
    ? 'This tool'
    : r.madeFrom === 'dashboard'
    ? 'Razorpay dashboard'
    : 'Outside this tool';

/** Razorpay's refund status, for people: pending money is on its way. */
export const refundStatusLabel = (status: string) =>
  status === 'processed'
    ? 'Processed'
    : status === 'pending'
    ? 'Pending'
    : status === 'failed'
    ? 'Failed'
    : status;
