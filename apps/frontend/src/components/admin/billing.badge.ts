import {
  BILLING_STATES,
  type BillingState,
  type BillingView,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/billing.state';

export type { BillingState, BillingView };

/**
 * How each billing state (billing.state.ts, computed by GET /admin/users)
 * looks on the Users & Billing page: one plain name and one colour per state.
 */
export const BILLING_STATE_META: Record<
  BillingState,
  { chip: string; badge: string; dot: string }
> = {
  free_posts: {
    chip: 'Free posts',
    badge: 'bg-lime-500/15 text-lime-700 dark:text-lime-200 border-lime-500/50',
    dot: 'bg-lime-400',
  },
  paying: {
    chip: 'Paying',
    badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 border-emerald-500/50',
    dot: 'bg-emerald-400',
  },
  first_charge: {
    chip: 'First charge due',
    badge: 'bg-sky-500/15 text-sky-700 dark:text-sky-200 border-sky-500/50',
    dot: 'bg-sky-400',
  },
  gift: {
    chip: 'Free Pro (gift)',
    badge: 'bg-hp-accent/15 text-hp-accent border-hp-accent/50',
    dot: 'bg-hp-accent',
  },
  needs_plan: {
    chip: 'Needs a plan',
    badge: 'bg-red-500/15 text-red-700 dark:text-red-200 border-red-700/70',
    dot: 'bg-red-600',
  },
  cancelled: {
    chip: 'Cancelled',
    badge: 'bg-orange-500/15 text-orange-700 dark:text-orange-200 border-orange-500/50',
    dot: 'bg-orange-400',
  },
  payment_failed: {
    chip: 'Payment failed',
    badge: 'bg-rose-500/20 text-rose-700 dark:text-rose-200 border-rose-500/60',
    dot: 'bg-rose-500',
  },
  free: {
    chip: 'Old Free plan',
    badge: 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-200 border-yellow-500/40',
    dot: 'bg-yellow-400',
  },
  lifetime: {
    chip: 'Lifetime plan',
    badge: 'bg-hp-primary/15 text-hp-primary-text border-hp-primary/50',
    dot: 'bg-hp-primary',
  },
  team: {
    chip: 'Team / review account',
    badge: 'bg-slate-500/15 text-slate-700 dark:text-slate-200 border-slate-500/50',
    dot: 'bg-slate-400',
  },
  marketplace: {
    chip: 'API marketplace',
    badge: 'bg-teal-500/15 text-teal-700 dark:text-teal-200 border-teal-500/50',
    dot: 'bg-teal-400',
  },
  no_workspace: {
    chip: 'No workspace',
    badge: 'bg-white/5 text-newTextColor/60 border-newTableBorder',
    dot: 'bg-white/40',
  },
};

/** The chip order: the same as the backend's BILLING_STATES. */
export const BILLING_CHIP_ORDER: readonly BillingState[] = BILLING_STATES;

/** The chips to show: every state with a row in it, and the selected one. */
export function visibleChips(
  counts: Partial<Record<BillingState, number>> | undefined,
  selected: string
): BillingState[] {
  return BILLING_CHIP_ORDER.filter((s) => (counts?.[s] ?? 0) > 0 || s === selected);
}

/**
 * Rows per state over the rows on screen (after the search), so a chip's
 * count is always the number of rows clicking it shows. A row whose
 * workspaces are in two states counts under both.
 */
export function countRowStates(
  rows: ReadonlyArray<{ billingStates?: BillingState[] | null }>
): Partial<Record<BillingState, number>> {
  const out: Partial<Record<BillingState, number>> = {};
  for (const row of rows) {
    for (const s of new Set(row.billingStates ?? [])) out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/** Whether a row belongs under a chip: any of its workspaces is in that state. */
export function rowInState(
  row: { billingStates?: BillingState[] | null },
  state: BillingState
): boolean {
  return !!row.billingStates?.includes(state);
}

/** The exact time behind a badge's date, for its tooltip, in IST. */
export function billingTooltip(view: Pick<BillingView, 'label' | 'detail' | 'at'>): string {
  if (!view.at) return `${view.label}. ${view.detail}`;
  const when = new Date(view.at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
  return `${view.label}. ${view.detail}. ${when} IST`;
}
