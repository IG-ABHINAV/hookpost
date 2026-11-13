import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  MarketplaceUsageRepository,
  UsageIncrement,
} from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.repository';
import {
  adapterConfigured,
  DIRECT_SOURCE,
  marketplaceAdapters,
  sourceLabel,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import {
  MARKETPLACE_PRODUCTS,
  marketplacePlan,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';

/** A call no adapter could be picked for (no marketplace header, or two). */
export const UNKNOWN_MARKETPLACE = 'UNKNOWN';
/** The product of a path that names none. */
export const NO_PRODUCT = '-';

/** How often the counters held in memory are added to the database. */
export const USAGE_FLUSH_MS = 15_000;
/** At most this many distinct rows are held between flushes (a flood of junk paths cannot grow memory). */
const MAX_PENDING_ROWS = 500;

const DAY_MS = 86_400_000;
/** lastCallAt of a row that holds only refused-at-the-door calls (401s): read as no call. */
const NEVER = new Date(0);
const callTime = (at: Date | null | undefined) =>
  at && at.getTime() > NEVER.getTime() ? at.toISOString() : null;
export const utcDay = (at: Date) => at.toISOString().slice(0, 10);
const dayBefore = (at: Date, days: number) => utcDay(new Date(at.getTime() - days * DAY_MS));

/**
 * Calls per marketplace subscriber workspace and UTC day, in Redis (the
 * MarketplaceUsageDay rows are per marketplace and product only). Kept 9 days:
 * enough for "the last 7 days" on the admin Workspaces list. Counting began
 * on 27 Oct 2026, so earlier days read as 0.
 */
export const ACCOUNT_CALLS_KEY = (accountId: string, day: string) => `mkt:acalls:${accountId}:${day}`;
const ACCOUNT_CALLS_TTL_S = 9 * 86_400;

type Counters = Omit<UsageIncrement, 'marketplace' | 'product' | 'day' | 'lastCallAt'>;
const COUNTERS: (keyof Counters)[] = [
  'calls',
  'ok',
  'unauthorized',
  'forbidden',
  'rateLimited',
  'clientErrors',
  'serverErrors',
  'credits',
];
const zero = (): Counters => ({
  calls: 0,
  ok: 0,
  unauthorized: 0,
  forbidden: 0,
  rateLimited: 0,
  clientErrors: 0,
  serverErrors: 0,
  credits: 0,
});

/** The counter a response status adds to (besides calls). */
export function statusBucket(status: number): keyof Counters {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'serverErrors';
  return 'clientErrors';
}

export interface WindowTotals extends Counters {}

export interface MarketplaceOverviewRow {
  id: string;
  label: string;
  /** A secret is set for at least one product: the marketplace can send calls. */
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
  today: WindowTotals;
  last7d: WindowTotals;
  last30d: WindowTotals;
  lastCallAt: string | null;
  /** Calls per UTC day, oldest first, the last 30 days. */
  daily: { day: string; calls: number; errors: number }[];
}

/**
 * Counts every call through the marketplace gateway by marketplace, product
 * and UTC day, without a database write per call: the counts are held in
 * memory and added to MarketplaceUsageDay every USAGE_FLUSH_MS (and on
 * shutdown). A crash loses at most that many seconds of counts; the calls
 * themselves are unaffected, since recording never throws.
 *
 * overview() is the admin Marketplaces page: subscribers (paying and free
 * among the active ones, dormant, blocked) from MarketplaceAccount, calls and refusals today / 7 /
 * 30 days and the last call from the counters, per marketplace.
 */
@Injectable()
export class MarketplaceUsageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Marketplace');
  private pending = new Map<string, UsageIncrement>();
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(private _repository: MarketplaceUsageRepository) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.flush().catch(() => undefined);
    }, USAGE_FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.flush().catch(() => undefined);
  }

  /** One finished call. Never throws. */
  record(marketplace: string, product: string, status: number, credits = 0, at = new Date()) {
    try {
      const day = utcDay(at);
      const key = `${marketplace}|${product}|${day}`;
      let row = this.pending.get(key);
      if (!row) {
        if (this.pending.size >= MAX_PENDING_ROWS) return;
        row = { marketplace, product, day, ...zero(), lastCallAt: NEVER };
        this.pending.set(key, row);
      }
      row.calls++;
      row[statusBucket(status)]++;
      if (status >= 200 && status < 300 && credits > 0) {
        row.credits += Math.floor(credits);
      }
      // A 401 is a call whose secret did not match: anyone can send one
      // naming a marketplace, so it never makes that marketplace look alive.
      if (status !== 401 && at > row.lastCallAt) row.lastCallAt = at;
    } catch {
      /* counting must never fail a call */
    }
  }

  /** One call that reached a subscriber's workspace (any answer). Never throws, never waits. */
  recordAccount(accountId: string | undefined | null, at = new Date()) {
    if (!accountId) return;
    try {
      const key = ACCOUNT_CALLS_KEY(accountId, utcDay(at));
      Promise.resolve(ioRedis.incr(key))
        .then((n) => (n === 1 ? ioRedis.expire(key, ACCOUNT_CALLS_TTL_S) : undefined))
        .catch(() => undefined);
    } catch {
      /* counting must never fail a call */
    }
  }

  /** Calls per account over the last `days` UTC days, today included; 0 when Redis cannot answer. */
  async accountCalls(accountIds: string[], days = 7, now = new Date()): Promise<Record<string, number>> {
    const out: Record<string, number> = Object.fromEntries(accountIds.map((id) => [id, 0]));
    const dayList = Array.from({ length: days }, (_, i) => dayBefore(now, i));
    await Promise.all(
      accountIds.map(async (id) => {
        try {
          const values = await Promise.all(
            dayList.map((d) => Promise.resolve(ioRedis.get(ACCOUNT_CALLS_KEY(id, d))))
          );
          out[id] = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
        } catch {
          out[id] = 0;
        }
      })
    );
    return out;
  }

  /** Adds what is held to the database. One flush at a time; a failed row is held for the next. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const rows = [...this.pending.values()];
      this.pending = new Map();
      for (const row of rows) {
        try {
          await this._repository.add(row);
        } catch (e: any) {
          this.logger.warn(`usage flush kept ${row.marketplace}/${row.product}/${row.day}: ${e?.message || e}`);
          this.merge(row);
        }
      }
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private merge(row: UsageIncrement) {
    const key = `${row.marketplace}|${row.product}|${row.day}`;
    const held = this.pending.get(key);
    if (!held) {
      this.pending.set(key, row);
      return;
    }
    for (const c of COUNTERS) held[c] += row[c];
    if (row.lastCallAt > held.lastCallAt) held.lastCallAt = row.lastCallAt;
  }

  /** Live workspaces per source (DIRECT, API_MARKET, RAPIDAPI, ...), each with its label. */
  async sources() {
    const counts = await this._repository.sources();
    const ids = new Set([DIRECT_SOURCE, ...marketplaceAdapters().map((a) => a.id), ...Object.keys(counts)]);
    return [...ids].map((id) => ({ id, label: sourceLabel(id), workspaces: counts[id] ?? 0 }));
  }

  async overview(now = new Date()) {
    await this.flush();
    const today = utcDay(now);
    const from30 = dayBefore(now, 29);
    const from7 = dayBefore(now, 6);
    const [days, lastCalls, accounts, new7, new30] = await Promise.all([
      this._repository.days(from30),
      this._repository.lastCalls(),
      this._repository.accounts(),
      this._repository.newAccounts(new Date(`${from7}T00:00:00.000Z`)),
      this._repository.newAccounts(new Date(`${from30}T00:00:00.000Z`)),
    ]);

    const adapters = marketplaceAdapters();
    const ids = [
      ...adapters.map((a) => a.id),
      ...new Set(
        [...accounts.map((a) => a.marketplace), ...days.map((d) => d.marketplace)].filter(
          (id) => id !== UNKNOWN_MARKETPLACE && !adapters.some((a) => a.id === id)
        )
      ),
    ];
    const last = new Map(lastCalls.map((l) => [l.marketplace, l._max.lastCallAt]));
    const dayList = Array.from({ length: 30 }, (_, i) => dayBefore(now, 29 - i));

    const totals = (id: string, from: string) => {
      const t = zero();
      for (const d of days) {
        if (d.marketplace !== id || d.day < from || d.day > today) continue;
        for (const c of COUNTERS) t[c] += d[c];
      }
      return t;
    };

    const rows: MarketplaceOverviewRow[] = ids.map((id) => {
      const adapter = adapters.find((a) => a.id === id);
      // Rows of (product, plan, status) with their count.
      const mine = accounts.filter((a) => a.marketplace === id);
      const sum = (rows: typeof mine) => rows.reduce((n, a) => n + a.count, 0);
      // Paying and free: active subscribers only. A dormant one has not
      // called for DORMANT_AFTER_DAYS (usually it stopped paying), a blocked
      // one is refused; both are counted on their own.
      const active = mine.filter((a) => a.status === 'ACTIVE');
      const paid = (a: { product: string; plan: string }) =>
        (marketplacePlan(a.product, a.plan)?.priceUsd ?? 0) > 0;
      const byProduct: Record<string, number> = {};
      for (const a of mine) byProduct[a.product] = (byProduct[a.product] ?? 0) + a.count;
      return {
        id,
        label: sourceLabel(id),
        configured: adapter ? adapterConfigured(adapter) : false,
        products: adapter
          ? MARKETPLACE_PRODUCTS.filter((p) => adapter.secrets(p).length > 0)
          : [],
        subscribers: {
          total: sum(mine),
          paying: sum(active.filter(paid)),
          free: sum(active.filter((a) => !paid(a))),
          active: sum(active),
          dormant: sum(mine.filter((a) => a.status === 'DORMANT')),
          blocked: sum(mine.filter((a) => a.status === 'BLOCKED')),
          new7d: new7[id] ?? 0,
          new30d: new30[id] ?? 0,
          byProduct,
        },
        today: totals(id, today),
        last7d: totals(id, from7),
        last30d: totals(id, from30),
        lastCallAt: callTime(last.get(id)),
        daily: dayList.map((day) => {
          const t = zero();
          for (const d of days) {
            if (d.marketplace === id && d.day === day) {
              for (const c of COUNTERS) t[c] += d[c];
            }
          }
          return { day, calls: t.calls, errors: t.calls - t.ok };
        }),
      };
    });

    return {
      asOf: now.toISOString(),
      day: today,
      marketplaces: rows,
      unattributed: {
        today: totals(UNKNOWN_MARKETPLACE, today),
        last7d: totals(UNKNOWN_MARKETPLACE, from7),
        last30d: totals(UNKNOWN_MARKETPLACE, from30),
        lastCallAt: callTime(last.get(UNKNOWN_MARKETPLACE)),
      },
      sources: await this.sources(),
    };
  }
}
