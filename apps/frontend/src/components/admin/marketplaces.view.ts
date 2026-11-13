/**
 * The shape of GET /admin/marketplaces (MarketplaceUsageService.overview)
 * and the small helpers the Marketplaces page and its spec share.
 */

export interface MarketplaceTotals {
  calls: number;
  ok: number;
  unauthorized: number;
  forbidden: number;
  rateLimited: number;
  clientErrors: number;
  serverErrors: number;
  credits: number;
}

export interface MarketplaceRow {
  id: string;
  label: string;
  configured: boolean;
  products: string[];
  subscribers: {
    total: number;
    paying: number;
    free: number;
    active: number;
    dormant: number;
    blocked: number;
    new7d: number;
    new30d: number;
    byProduct: Record<string, number>;
  };
  today: MarketplaceTotals;
  last7d: MarketplaceTotals;
  last30d: MarketplaceTotals;
  lastCallAt: string | null;
  daily: { day: string; calls: number; errors: number }[];
}

export interface MarketplacesResponse {
  asOf: string;
  day: string;
  marketplaces: MarketplaceRow[];
  unattributed: {
    today: MarketplaceTotals;
    last7d: MarketplaceTotals;
    last30d: MarketplaceTotals;
    lastCallAt: string | null;
  };
  sources: { id: string; label: string; workspaces: number }[];
}

export type WindowKey = 'today' | '7d' | '30d';

export const WINDOWS: { key: WindowKey; label: string; field: 'today' | 'last7d' | 'last30d' }[] = [
  { key: 'today', label: 'Today', field: 'today' },
  { key: '7d', label: '7 days', field: 'last7d' },
  { key: '30d', label: '30 days', field: 'last30d' },
];

/** Every call that was not answered 2xx. */
export const errorsOf = (t: MarketplaceTotals) => Math.max(0, t.calls - t.ok);
