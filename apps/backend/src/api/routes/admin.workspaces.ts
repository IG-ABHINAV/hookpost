/**
 * GET /admin/workspaces: every live workspace in one plain list for the
 * super-admin Users page (name, source, members, billing state, channels,
 * posts, created), and for a marketplace subscriber workspace its masked
 * subscriber id, product, plan, status, last call and calls in the last 7
 * days. Pure helpers; the queries are in AdminController.listWorkspaces.
 */
import type { BillingView } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/billing.state';

/**
 * A marketplace buyer id with the middle hidden ("usr_8f…c2"): enough to
 * tell two subscribers apart and match a support mail, not to impersonate
 * one (the gateway trusts the marketplace's headers, not this id alone, but
 * it is still the buyer's identifier at the marketplace).
 */
export function maskSubscriber(id?: string | null): string {
  const s = (id ?? '').trim();
  if (!s) return '—';
  if (s.length <= 4) return `${s[0]}…`;
  if (s.length <= 8) return `${s.slice(0, 2)}…${s.slice(-1)}`;
  return `${s.slice(0, 4)}…${s.slice(-2)}`;
}

export interface WorkspaceMarketplaceInfo {
  marketplace: string;
  subscriber: string;
  product: string;
  plan: string;
  status: string;
  lastCallAt: string | null;
  calls7d: number;
}

/** One workspace's payment dispute (Organization.disputedAt), for the page. */
export interface WorkspaceDisputeInfo {
  at: string;
  reason: string | null;
  paymentId: string | null;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  /** DIRECT or the marketplace id. */
  source: string;
  sourceLabel: string;
  createdAt: string;
  members: number;
  owner: string | null;
  channels: number;
  posts: number;
  billing: BillingView;
  marketplace: WorkspaceMarketplaceInfo | null;
  /** Null unless a bank reported a chargeback nobody has cleared yet. */
  dispute: WorkspaceDisputeInfo | null;
}

export interface WorkspaceRowInput {
  id: string;
  name: string;
  source?: string | null;
  createdAt: Date | string;
  members: number;
  owner?: string | null;
  channels: number;
  posts: number;
  billing: BillingView;
  account?: {
    id: string;
    marketplace: string;
    externalUserId: string;
    product: string;
    plan: string;
    status: string;
    lastSeenAt?: Date | string | null;
  } | null;
  calls7d?: number;
  disputedAt?: Date | string | null;
  disputeReason?: string | null;
  disputePaymentId?: string | null;
}

export function workspaceRow(
  input: WorkspaceRowInput,
  label: (sourceId: string) => string
): WorkspaceRow {
  const source = input.source || 'DIRECT';
  const a = input.account;
  return {
    id: input.id,
    name: input.name,
    source,
    sourceLabel: source === 'DIRECT' ? 'Direct' : label(source),
    createdAt: new Date(input.createdAt).toISOString(),
    members: input.members,
    owner: input.owner ?? null,
    channels: input.channels,
    posts: input.posts,
    billing: input.billing,
    marketplace: a
      ? {
          marketplace: label(a.marketplace),
          subscriber: maskSubscriber(a.externalUserId),
          product: a.product,
          plan: a.plan,
          status: a.status,
          lastCallAt: a.lastSeenAt ? new Date(a.lastSeenAt).toISOString() : null,
          calls7d: input.calls7d ?? 0,
        }
      : null,
    dispute: input.disputedAt
      ? {
          at: new Date(input.disputedAt).toISOString(),
          reason: input.disputeReason ?? null,
          paymentId: input.disputePaymentId ?? null,
        }
      : null,
  };
}
