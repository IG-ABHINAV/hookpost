/**
 * The workspace level of the super-admin Users page: the shape of
 * GET /admin/workspaces and the small helpers the Workspaces list, the user
 * rows and the user panel share.
 */
import type { BillingView } from '@hookpost/frontend/components/admin/billing.badge';
import { istTime } from '@hookpost/frontend/components/admin/signup.source.view';

export interface WorkspaceMarketplaceView {
  marketplace: string;
  /** Masked by the server ("usr_…c2"). */
  subscriber: string;
  product: string;
  plan: string;
  status: string;
  lastCallAt: string | null;
  calls7d: number;
}

export interface WorkspaceView {
  id: string;
  name: string;
  source: string;
  sourceLabel: string;
  createdAt: string;
  members: number;
  owner: string | null;
  channels: number;
  posts: number;
  billing: BillingView;
  marketplace: WorkspaceMarketplaceView | null;
  /** A bank's chargeback nobody has cleared yet (GET /admin/workspaces). */
  dispute?: { at: string; reason: string | null; paymentId: string | null } | null;
}

export interface WorkspacesResponse {
  asOf: string;
  workspaces: WorkspaceView[];
}

/** A workspace role in plain words (UserOrganization.role). */
export function roleLabel(role?: string | null): string {
  if (role === 'SUPERADMIN') return 'Owner';
  if (role === 'ADMIN') return 'Admin';
  return 'Member';
}

export const membersLabel = (n?: number | null) =>
  `${n ?? 0} member${(n ?? 0) === 1 ? '' : 's'}`;

/** Rows of one source (null: all), then matching the search (name, owner, id, subscriber). */
export function filterWorkspaces(
  rows: WorkspaceView[],
  source: string | null,
  query = ''
): WorkspaceView[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (w) =>
      (!source || w.source === source) &&
      (!q ||
        w.name.toLowerCase().includes(q) ||
        (w.owner || '').toLowerCase().includes(q) ||
        w.id.toLowerCase() === q ||
        (w.marketplace?.subscriber || '').toLowerCase().includes(q))
  );
}

/** "social · trial · active · 12 calls in 7 days · last call 27 Oct 2026, 08:30 IST" */
export function marketplaceLine(m: WorkspaceMarketplaceView | null | undefined): string | null {
  if (!m) return null;
  const last = istTime(m.lastCallAt);
  return [
    m.product,
    m.plan,
    m.status.toLowerCase(),
    `${m.calls7d} call${m.calls7d === 1 ? '' : 's'} in 7 days`,
    last ? `last call ${last}` : 'never called',
  ].join(' · ');
}

/**
 * The admin's line for a disputed workspace: when the chargeback came, and
 * its reason code. Null for every other workspace.
 */
export function disputeLine(dispute: WorkspaceView['dispute']): string | null {
  if (!dispute) return null;
  return `Chargeback ${istTime(dispute.at)}${dispute.reason ? ` · ${dispute.reason}` : ''}`;
}
