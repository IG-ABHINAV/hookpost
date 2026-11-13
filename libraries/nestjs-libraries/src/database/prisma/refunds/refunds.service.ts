import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RefundsRepository } from '@hookpost/nestjs-libraries/database/prisma/refunds/refunds.repository';
import { RazorpayClient } from '@hookpost/nestjs-libraries/services/razorpay.client';
import { randomUUID } from 'crypto';
import { ioRedis, ioRedisIsMock } from '@hookpost/nestjs-libraries/redis/redis.service';
import { AccountCorrectionService } from '@hookpost/nestjs-libraries/services/account.correction.service';

/**
 * notes.service values Hookpost stamps on what it creates on the shared
 * Razorpay account: 'hookpost' on every subscription (and so on its charges),
 * 'hookpost-test' on the owner's own test payment links.
 */
export const HOOKPOST_SERVICES = ['hookpost', 'hookpost-test'];
/**
 * Most payment ids one bulk call refunds: about 1-2 s each at Razorpay, so 50
 * stays inside Cloudflare's 100 s proxy timeout. The page sends 20 at a time.
 */
export const BULK_REFUND_MAX = 50;
/** Razorpay payment ids: pay_ plus 14 letters and digits. */
export const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{14}$/;
const LIST_WINDOW_DAYS = 180; // Razorpay refunds payments up to 6 months old
/**
 * A payment is locked for this long once a refund of it is sent (or while one
 * is in flight), so a double click, a second tab or a retried request cannot
 * send a second refund on top of the first.
 */
const LOCK_SECONDS = 60;
/**
 * Disputes read per page, and the most pages read, when looking for a
 * chargeback on one payment (disputeOn): GET /v1/disputes has no payment
 * filter, only from/skip/count.
 */
const DISPUTE_PAGE = 100;
const DISPUTE_PAGES_MAX = 20;
/**
 * Frees the lock only while it still holds this request's token: a request
 * slower than LOCK_SECONDS must not delete the lock a newer request took.
 */
const RELEASE_LOCK =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const CACHE_MAX = 5000;

export interface RefundAdmin {
  id: string;
  email: string;
}

export interface RefundRequest {
  paymentId: string;
  /** Minor units (paise, cents). Omitted: everything still refundable. */
  amount?: number;
  reason?: string;
  /** Required to refund a payment that is not positively Hookpost's. */
  confirmForeign?: boolean;
  /**
   * Refund everything still refundable, without deducting Razorpay's fee.
   * Only for our own mistakes (a charge after cancel, a double charge). Off
   * by default: an omitted amount means the payment less the fee.
   */
  full?: boolean;
  /**
   * Set only by Hookpost's own automatic refunds (RazorpayService
   * refundChargeAfterCancel), stamped on the refund's notes.auto so the
   * refund webhook knows it: the plan is not ended by it.
   */
  auto?: string;
  /**
   * This payment was a second charge for something already paid for (a plan
   * change that opened a new mandate without retiring the old one, or a
   * Gumroad plan a Razorpay checkout took over). The customer is told we
   * charged them twice and have refunded it
   * (DUPLICATE_CHARGE_REFUNDED); an ordinary refund tells them nothing extra,
   * because Razorpay's own refund webhook already emails them.
   */
  duplicate?: boolean;
}

export interface RefundResult {
  paymentId: string;
  status: 'refunded' | 'refused' | 'failed';
  amount?: number;
  currency?: string;
  refundId?: string;
  refundStatus?: string;
  error?: string;
}

export interface PaymentOwner {
  hookpost: boolean;
  service: string | null;
  organizationId: string | null;
  subscriptionId: string | null;
}

/**
 * Where a refund was made. 'tool': this page (a RefundAudit row names it, or
 * its notes.source is 'hookpost-admin'), or the impersonation bar's older
 * Refund button. 'dashboard': the Razorpay dashboard's
 * refund form, which always stores a notes.comment (empty when nothing was
 * typed). 'other': neither, such as Razorpay's automatic refund of the Rs 5
 * UPI mandate check, which carries no notes at all.
 */
export type RefundMadeFrom = 'tool' | 'dashboard' | 'other';

/** One row of the refund history (GET /admin/refunds/history). */
export interface RefundHistoryRow {
  id: string;
  paymentId: string;
  /** Minor units (paise, cents). */
  amount: number;
  currency: string;
  /** Razorpay's: pending, processed or failed. */
  status: string;
  createdAt: string;
  /** The bank's reference (ARN or RRN) once Razorpay has it; customers can quote it. */
  reference: string | null;
  /** false when the payment could not be read from Razorpay. */
  paymentFound: boolean;
  paymentAmount: number | null;
  email: string | null;
  description: string | null;
  madeFrom: RefundMadeFrom;
  /** Who refunded it from this page. */
  madeBy: string | null;
  reason: string | null;
  hookpost: boolean;
  service: string | null;
  organizationId: string | null;
  organizationName: string | null;
  subscriptionId: string | null;
}

/** What never changes on a payment, which is all the history needs of it. */
interface PaymentFacts {
  id: string;
  amount: number;
  currency: string;
  email: string | null;
  description: string | null;
  notes: any;
  invoice_id: string | null;
}

/** Razorpay sends notes as [] when there are none. */
const notesOf = (notes: any): Record<string, any> =>
  notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {};

const factsOf = (p: any): PaymentFacts => ({
  id: p.id,
  amount: Number(p.amount || 0),
  currency: String(p.currency || '').toUpperCase(),
  email: p.email || null,
  description: p.description || null,
  notes: p.notes,
  invoice_id: p.invoice_id || null,
});

/** Clamp Razorpay paging: 1-100 per page (its maximum), and a pinned `to`. */
const pageWindow = (params: { skip?: number; count?: number; to?: number }) => {
  const count = Math.min(Math.max(Math.floor(params.count || 50), 1), 100);
  const skip = Math.max(Math.floor(params.skip || 0), 0);
  const to = params.to && params.to > 0 ? Math.floor(params.to) : Math.floor(Date.now() / 1000);
  return { count, skip, to, from: to - LIST_WINDOW_DAYS * 86400 };
};

/** A 4xx is Razorpay's answer about this request (an unknown id, say); anything else is an outage. */
const razorpayError = (e: any) => {
  if (e instanceof BadRequestException) return e;
  const message = `Razorpay: ${e?.message || e}`;
  return /failed \(4\d\d\)/.test(message)
    ? new BadRequestException(message)
    : new ServiceUnavailableException(message);
};

const madeFromOf = (
  refund: any,
  audit?: { adminEmail: string; reason: string | null }
): { madeFrom: RefundMadeFrom; madeBy: string | null; reason: string | null } => {
  const notes = notesOf(refund?.notes);
  if (audit) {
    return { madeFrom: 'tool', madeBy: audit.adminEmail, reason: audit.reason || null };
  }
  if (notes.source === 'hookpost-admin') {
    return {
      madeFrom: 'tool',
      madeBy: typeof notes.refunded_by === 'string' ? notes.refunded_by : null,
      reason: typeof notes.reason === 'string' ? notes.reason : null,
    };
  }
  // The impersonation bar's Refund button before it went through this
  // service (removed 21 Oct 2026) tagged its refunds like this.
  if (notes.reason === 'hookpost_admin_refund') {
    return { madeFrom: 'tool', madeBy: null, reason: null };
  }
  if (Object.prototype.hasOwnProperty.call(notes, 'comment')) {
    return {
      madeFrom: 'dashboard',
      madeBy: null,
      reason: typeof notes.comment === 'string' && notes.comment ? notes.comment : null,
    };
  }
  return { madeFrom: 'other', madeBy: null, reason: null };
};

/** What can still be refunded, in minor units. Only a captured payment can be. */
const refundableOf = (payment: any) =>
  payment?.status === 'captured'
    ? Math.max(0, Number(payment.amount || 0) - Number(payment.amount_refunded || 0))
    : 0;

/** What a refund of a payment comes to, in minor units (paise, cents). */
export interface RefundQuote {
  /** What the customer paid. */
  amount: number;
  /**
   * Razorpay's fee on the payment, GST included: the payment entity's `fee`
   * is "Fee (including GST) charged by Razorpay" and `tax` is the GST part of
   * it (https://razorpay.com/docs/api/payments/fetch-with-id). Deducting
   * fee + tax would take the GST twice.
   */
  fee: number;
  /** The GST inside `fee`, shown on its own in the admin page. */
  tax: number;
  /** Already refunded. */
  refundedBefore: number;
  /** Everything still refundable: the "full" override. */
  full: number;
  /**
   * The default (owner, 29 Oct 2026): a refund is at our discretion and is
   * the payment less Razorpay's fee and the GST on it. The fee is taken once
   * across all refunds of the payment, never more than what is left.
   */
  afterFee: number;
}

/**
 * The refund the admin button sends by default, and the full amount it can
 * be overridden to. Pure, so every edge (fee missing, partly refunded,
 * fee larger than what is left) is a unit test.
 */
export function refundQuote(payment: any): RefundQuote {
  const amount = Math.max(0, Math.floor(Number(payment?.amount) || 0));
  const fee = Math.max(0, Math.floor(Number(payment?.fee) || 0));
  const tax = Math.max(0, Math.floor(Number(payment?.tax) || 0));
  const refundedBefore = Math.max(0, Math.floor(Number(payment?.amount_refunded) || 0));
  const full = refundableOf(payment);
  const afterFee = Math.min(full, Math.max(0, amount - fee - refundedBefore));
  return { amount, fee, tax, refundedBefore, full, afterFee };
}

/**
 * The same refund of the same payment in the same state always gets the same
 * key, so Razorpay (X-Refund-Idempotency, and receipt) turns a resent request
 * into the refund it already made. Letters, digits, - and _; under 40 chars.
 */
const idempotencyKey = (paymentId: string, refundedBefore: number, amount: number) =>
  `${paymentId}-${refundedBefore}-${amount}`;

const remember = <V>(map: Map<string, V>, key: string, value: V) => {
  if (map.size >= CACHE_MAX) map.clear();
  map.set(key, value);
};

/**
 * The super-admin Refunds page (/admin/refunds): lists Razorpay payments and
 * refunds them through Razorpay's Refund API, one or in bulk, so refunds
 * never have to be clicked through the Razorpay dashboard.
 *
 * The Razorpay account is shared with other products, so a payment is
 * Hookpost's only when something positively says so: notes.service on the
 * payment ('hookpost', or 'hookpost-test' on our test links), or its invoice
 * belonging to a subscription tagged notes.service = 'hookpost' (subscription
 * charges carry no notes of their own). Anything else is refused unless the
 * request confirms it is another product's payment on purpose.
 *
 * Every request leaves a RefundAudit row. A refund is only sent once its
 * PENDING row is written; if the row cannot be written nothing is sent.
 *
 * listRefunds is the read-only refund history: every refund on the account,
 * including the ones made in the Razorpay dashboard, which have no audit row.
 */
@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);
  private readonly client = new RazorpayClient();
  /** invoice id -> subscription id. Fixed once an invoice exists. */
  private readonly invoiceSubscriptions = new Map<string, string | null>();
  /** subscription id -> its notes. Set when the subscription is created. */
  private readonly subscriptionNotes = new Map<string, Record<string, any>>();
  /** payment id -> what never changes on it (amount, email, notes, invoice). */
  private readonly paymentFacts = new Map<string, PaymentFacts>();
  /** Pause between two refunds of a bulk call; Razorpay rate-limits. */
  protected bulkDelayMs = 250;

  constructor(
    private _refundsRepository: RefundsRepository,
    private _accountCorrectionService: AccountCorrectionService
  ) {}

  // ---------------------------------------------------------------------------
  // Whose payment is it
  // ---------------------------------------------------------------------------

  async ownerOf(payment: any): Promise<PaymentOwner> {
    const notes = notesOf(payment?.notes);
    if (typeof notes.service === 'string' && notes.service) {
      const hookpost = HOOKPOST_SERVICES.includes(notes.service);
      return {
        hookpost,
        service: notes.service,
        organizationId: hookpost ? notes.orgId || null : null,
        subscriptionId: null,
      };
    }
    if (payment?.invoice_id) {
      const sub = await this.subscriptionOfInvoice(payment.invoice_id);
      if (sub) {
        const service = typeof sub.notes.service === 'string' ? sub.notes.service : null;
        const hookpost = !!service && HOOKPOST_SERVICES.includes(service);
        return {
          hookpost,
          service,
          organizationId: hookpost ? sub.notes.orgId || null : null,
          subscriptionId: sub.id,
        };
      }
    }
    return { hookpost: false, service: null, organizationId: null, subscriptionId: null };
  }

  /** A failed read is not cached, and leaves the payment unidentified (not ours). */
  private async subscriptionOfInvoice(
    invoiceId: string
  ): Promise<{ id: string; notes: Record<string, any> } | null> {
    let subscriptionId = this.invoiceSubscriptions.get(invoiceId);
    if (subscriptionId === undefined) {
      const invoice = await this.client
        .request('GET', `/invoices/${encodeURIComponent(invoiceId)}`)
        .catch(() => null);
      if (!invoice) return null;
      subscriptionId = invoice.subscription_id || null;
      remember(this.invoiceSubscriptions, invoiceId, subscriptionId);
    }
    if (!subscriptionId) return null;

    let notes = this.subscriptionNotes.get(subscriptionId);
    if (!notes) {
      const sub = await this.client
        .request('GET', `/subscriptions/${encodeURIComponent(subscriptionId)}`)
        .catch(() => null);
      if (!sub) return null;
      notes = notesOf(sub.notes);
      remember(this.subscriptionNotes, subscriptionId, notes);
    }
    return { id: subscriptionId, notes };
  }

  // ---------------------------------------------------------------------------
  // Listing
  // ---------------------------------------------------------------------------

  /**
   * Payments of the last 180 days, newest first, one Razorpay page at a time
   * (skip/count are Razorpay's). `to` pins the window across pages so new
   * payments do not shift them. Only Hookpost's unless `all`. `paymentId`
   * looks up that one payment instead, of any date or product.
   */
  async listPayments(params: {
    skip?: number;
    count?: number;
    to?: number;
    all?: boolean;
    paymentId?: string;
  }) {
    const { count, skip, to, from } = pageWindow(params);

    let items: any[];
    try {
      if (params.paymentId) {
        const id = params.paymentId.trim();
        if (!PAYMENT_ID_RE.test(id)) {
          throw new BadRequestException('Not a Razorpay payment id (pay_ and 14 characters)');
        }
        items = [await this.client.request('GET', `/payments/${id}`)];
      } else {
        const page = await this.client.request(
          'GET',
          `/payments?from=${from}&to=${to}&count=${count}&skip=${skip}`
        );
        items = page?.items || [];
      }
    } catch (e: any) {
      throw razorpayError(e);
    }

    // A few at a time: each unidentified charge may need its invoice and
    // subscription read (cached after the first time).
    const rows: any[] = [];
    for (let i = 0; i < items.length; i += 5) {
      rows.push(
        ...(await Promise.all(
          items.slice(i, i + 5).map(async (p) => {
            // The refund history needs the same payments: no second read.
            if (p?.id && PAYMENT_ID_RE.test(p.id)) {
              remember(this.paymentFacts, p.id, factsOf(p));
            }
            const owner = await this.ownerOf(p);
            const quote = refundQuote(p);
            return {
              id: p.id,
              status: p.status,
              amount: Number(p.amount || 0),
              amountRefunded: Number(p.amount_refunded || 0),
              refundable: refundableOf(p),
              // The default refund (payment less Razorpay's fee, GST
              // included) and the figures behind it, shown before confirm.
              fee: quote.fee,
              tax: quote.tax,
              refundableAfterFee: quote.afterFee,
              refundStatus: p.refund_status || null,
              currency: String(p.currency || '').toUpperCase(),
              method: p.method || null,
              email: p.email || null,
              description: p.description || null,
              international: !!p.international,
              createdAt: new Date(Number(p.created_at || 0) * 1000).toISOString(),
              ...owner,
            };
          })
        ))
      );
    }

    const visible = params.all || params.paymentId ? rows : rows.filter((r) => r.hookpost);
    const names = await this.organizationNames(visible);

    return {
      payments: visible.map((r) => ({
        ...r,
        organizationName: (r.organizationId && names.get(r.organizationId)) || null,
      })),
      scanned: items.length,
      nextSkip: skip + items.length,
      hasMore: !params.paymentId && items.length === count,
      from,
      to,
    };
  }

  /**
   * Every refund on the Razorpay account in the last 180 days, newest first,
   * one Razorpay page at a time (GET /v1/refunds; skip/count/to work as in
   * listPayments): the ones made here and the ones made in the Razorpay
   * dashboard or by Razorpay itself. Read-only. Each refund carries its
   * payment's customer and product, decided like listPayments does, so only
   * Hookpost's unless `all`; `hidden` says how many of the page were not.
   */
  async listRefunds(params: { skip?: number; count?: number; to?: number; all?: boolean }) {
    const { count, skip, to, from } = pageWindow(params);

    let items: any[];
    try {
      const page = await this.client.request(
        'GET',
        `/refunds?from=${from}&to=${to}&count=${count}&skip=${skip}`
      );
      items = page?.items || [];
    } catch (e: any) {
      throw razorpayError(e);
    }

    const refundIds = items.map((r) => r.id).filter(Boolean);
    // Before the audit migration is applied there is nothing to match; the
    // notes still tell this tool's refunds apart.
    const audits = new Map(
      (refundIds.length
        ? await this._refundsRepository.auditByRefundIds(refundIds).catch((e) => {
            this.logger.warn(`RefundAudit not readable (migration applied?): ${e}`);
            return [];
          })
        : []
      ).map((a) => [a.refundId as string, a])
    );

    const rows: Omit<RefundHistoryRow, 'organizationName'>[] = [];
    for (let i = 0; i < items.length; i += 5) {
      rows.push(
        ...(await Promise.all(
          items.slice(i, i + 5).map(async (r) => {
            const payment = await this.paymentFactsOf(r.payment_id);
            const owner: PaymentOwner = payment
              ? await this.ownerOf(payment)
              : { hookpost: false, service: null, organizationId: null, subscriptionId: null };
            const acquirer = r.acquirer_data || {};
            return {
              id: r.id,
              paymentId: r.payment_id,
              amount: Number(r.amount || 0),
              currency: String(r.currency || payment?.currency || '').toUpperCase(),
              status: r.status || 'pending',
              createdAt: new Date(Number(r.created_at || 0) * 1000).toISOString(),
              reference: acquirer.arn || acquirer.rrn || null,
              paymentFound: !!payment,
              paymentAmount: payment ? payment.amount : null,
              email: payment?.email || null,
              description: payment?.description || null,
              ...madeFromOf(r, audits.get(r.id)),
              ...owner,
            };
          })
        ))
      );
    }

    // A refund whose payment could not be read (Razorpay rate-limited it, say)
    // may well be Hookpost's: shown as an unknown payment, never hidden.
    const visible = params.all ? rows : rows.filter((r) => r.hookpost || !r.paymentFound);
    const names = await this.organizationNames(visible);

    return {
      refunds: visible.map(
        (r): RefundHistoryRow => ({
          ...r,
          organizationName: (r.organizationId && names.get(r.organizationId)) || null,
        })
      ),
      scanned: items.length,
      hidden: rows.length - visible.length,
      nextSkip: skip + items.length,
      hasMore: items.length === count,
      from,
      to,
    };
  }

  /**
   * A chargeback on this payment that was not settled in our favour (any
   * status but `won`), or null. Razorpay deducts the disputed amount from
   * the balance when a dispute opens and keeps it if the dispute is lost
   * (docs: Disputes), and its payment entity says nothing about disputes, so
   * they are read: GET /v1/disputes from the payment's own creation, newest
   * first, paged. Throws when Razorpay cannot be read, so the caller refuses
   * rather than refund blind.
   */
  private async disputeOn(payment: any): Promise<{ id: string; status: string } | null> {
    const from = Math.max(0, Number(payment.created_at || 0));
    for (let page = 0; page < DISPUTE_PAGES_MAX; page++) {
      const res = await this.client.request(
        'GET',
        `/disputes?from=${from}&count=${DISPUTE_PAGE}&skip=${page * DISPUTE_PAGE}`
      );
      const items: any[] = res?.items || [];
      const hit = items.find((d) => d?.payment_id === payment.id && d?.status !== 'won');
      if (hit) return { id: String(hit.id), status: String(hit.status) };
      if (items.length < DISPUTE_PAGE) return null;
    }
    throw new Error(`more than ${DISPUTE_PAGE * DISPUTE_PAGES_MAX} disputes since the payment`);
  }

  /**
   * The payment a refund belongs to. Only what never changes is kept, so a
   * reload does not read the same payments again. A failed read is not cached.
   */
  private async paymentFactsOf(paymentId: string): Promise<PaymentFacts | null> {
    if (!paymentId || !PAYMENT_ID_RE.test(paymentId)) return null;
    const known = this.paymentFacts.get(paymentId);
    if (known) return known;
    const p = await this.client.request('GET', `/payments/${paymentId}`).catch((e) => {
      this.logger.warn(`Refund history: payment ${paymentId} not readable: ${e?.message || e}`);
      return null;
    });
    if (!p) return null;
    const facts = factsOf({ ...p, id: paymentId });
    remember(this.paymentFacts, paymentId, facts);
    return facts;
  }

  private async organizationNames(rows: { organizationId: string | null }[]) {
    const orgIds = [...new Set(rows.map((r) => r.organizationId).filter(Boolean))] as string[];
    return new Map(
      (orgIds.length
        ? await this._refundsRepository.organizationNames(orgIds).catch(() => [])
        : []
      ).map((o) => [o.id, o.name])
    );
  }

  /** The newest audit rows. `available: false` until the migration is applied. */
  async listAudit(limit = 50) {
    try {
      const rows = await this._refundsRepository.listAudit(
        Math.min(Math.max(Math.floor(limit) || 50, 1), 200)
      );
      return { available: true, rows };
    } catch (e) {
      this.logger.warn(`RefundAudit not readable (migration applied?): ${e}`);
      return { available: false, rows: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Refunding
  // ---------------------------------------------------------------------------

  /**
   * Refund one payment. Never throws: the answer, including Razorpay's own
   * error message, is in the result. Checked against the live payment, never
   * against a list the page loaded earlier.
   */
  async refund(admin: RefundAdmin, req: RefundRequest): Promise<RefundResult> {
    const paymentId = String(req.paymentId || '').trim();
    const reason = req.reason?.trim().slice(0, 200) || null;
    const confirmed = !!req.confirmForeign;
    const duplicate = !!req.duplicate;
    // Recorded on the audit row: the payment is not identified as Hookpost's.
    let foreign = false;
    const audit = (
      status: 'REFUSED' | 'FAILED',
      error: string,
      extra: { amount?: number; currency?: string; organizationId?: string | null } = {}
    ) =>
      this._refundsRepository
        .createAudit({
          adminUserId: admin.id,
          adminEmail: admin.email,
          paymentId,
          // The column is a 32-bit Int; a refused nonsense amount is kept as 0.
          amount:
            Number.isInteger(extra.amount) && Math.abs(extra.amount!) <= 2 ** 31 - 1
              ? extra.amount!
              : 0,
          currency: extra.currency || '',
          reason,
          foreign,
          status,
          error,
          organizationId: extra.organizationId || null,
        })
        .catch((e) => this.logger.error(`Refund audit of ${paymentId} not written: ${e}`));
    const refuse = async (error: string, extra?: Parameters<typeof audit>[2]) => {
      await audit('REFUSED', error, extra);
      return { paymentId, status: 'refused' as const, error, amount: extra?.amount, currency: extra?.currency };
    };

    if (!PAYMENT_ID_RE.test(paymentId)) {
      return refuse('Not a Razorpay payment id (pay_ and 14 characters).');
    }

    if (ioRedisIsMock) {
      return refuse(
        'Refunds need Redis, and REDIS_URL is not set: without it the lock that stops a double refund does nothing. Nothing was refunded.'
      );
    }

    const lockKey = `razorpay:admin-refund:${paymentId}`;
    const lockToken = `${admin.email}:${randomUUID()}`;
    try {
      const claimed =
        (await (ioRedis as any).set(lockKey, lockToken, 'EX', LOCK_SECONDS, 'NX')) === 'OK';
      if (!claimed) {
        return refuse(
          'A refund of this payment was sent or started less than a minute ago. Reload the list and check it before trying again.'
        );
      }
    } catch (e) {
      this.logger.error(`Could not lock ${lockKey}: ${e}`);
      return refuse('Could not take the refund lock (Redis is unreachable). Nothing was refunded.');
    }

    // Kept after a refund went out (or might have), so it cannot be repeated
    // for a minute; released when nothing was sent.
    let keepLock = false;
    try {
      let payment: any;
      try {
        payment = await this.client.request('GET', `/payments/${paymentId}`);
      } catch (e: any) {
        const error = String(e?.message || e);
        await audit('FAILED', error);
        return { paymentId, status: 'failed', error };
      }

      const owner = await this.ownerOf(payment);
      const currency = String(payment.currency || '').toUpperCase();
      const refundedBefore = Number(payment.amount_refunded || 0);
      const remaining = refundableOf(payment);
      const quote = refundQuote(payment);
      // An explicit amount is sent as typed. Otherwise the default is the
      // payment less Razorpay's fee (GST included); `full` overrides that.
      const explicit = req.amount !== undefined && req.amount !== null;
      const amount = explicit ? Number(req.amount) : req.full ? quote.full : quote.afterFee;
      const context = { amount, currency, organizationId: owner.organizationId };

      foreign = !owner.hookpost;
      if (foreign && !confirmed) {
        return refuse(
          `Not a Hookpost payment (notes.service: ${owner.service || 'none'}). Refund it only on purpose, with "confirm foreign product payment".`,
          context
        );
      }
      if (payment.status === 'refunded' || (payment.status === 'captured' && remaining <= 0)) {
        return refuse('Already fully refunded.', context);
      }
      if (payment.status !== 'captured') {
        return refuse(
          `The payment is ${payment.status}; only a captured payment can be refunded.`,
          context
        );
      }
      // A chargeback has already taken the money back through the bank: a
      // refund on top would pay the customer twice.
      let dispute: { id: string; status: string } | null;
      try {
        dispute = await this.disputeOn(payment);
      } catch (e: any) {
        return refuse(
          `Could not check Razorpay for a chargeback on this payment (${String(e?.message || e)}). Nothing was refunded; try again in a few minutes.`,
          context
        );
      }
      if (dispute) {
        return refuse(
          `This payment has a chargeback (${dispute.id}, ${dispute.status}). Razorpay takes the disputed amount from the balance when a dispute opens, so a refund would pay the customer twice. Answer the dispute instead.`,
          context
        );
      }
      if (!explicit && !req.full && remaining > 0 && amount < 1) {
        return refuse(
          `Nothing is left after Razorpay's fee (${quote.fee} ${currency} minor units). Refund in full only if this was our mistake.`,
          context
        );
      }
      if (!Number.isInteger(amount) || amount < 1) {
        return refuse('The amount must be a whole number of paise/cents, at least 1.', context);
      }
      if (amount > remaining) {
        return refuse(
          `${amount} is more than the ${remaining} still refundable (${currency} minor units).`,
          context
        );
      }

      const key = idempotencyKey(paymentId, refundedBefore, amount);
      let row: { id: string };
      try {
        row = await this._refundsRepository.createAudit({
          adminUserId: admin.id,
          adminEmail: admin.email,
          paymentId,
          amount,
          currency,
          reason,
          foreign,
          status: 'PENDING',
          idempotencyKey: key,
          organizationId: owner.organizationId,
        });
      } catch (e) {
        this.logger.error(`Refund of ${paymentId} not sent, audit row not written: ${e}`);
        return {
          paymentId,
          status: 'refused',
          amount,
          currency,
          error:
            'Could not write the audit record (has refund-audit.migration.sql been applied?). Nothing was refunded.',
        };
      }

      let refund: any;
      try {
        refund = await this.client.request(
          'POST',
          `/payments/${paymentId}/refund`,
          {
            amount,
            speed: 'normal',
            receipt: key,
            notes: {
              source: 'hookpost-admin',
              refunded_by: admin.email,
              ...(reason ? { reason } : {}),
              // Only Hookpost's own automatic refunds (a system actor, never
              // an admin request) may say so: the refund webhook leaves the
              // plan on for those.
              ...(req.auto && admin.id.startsWith('system:') ? { auto: req.auto } : {}),
            },
          },
          { 'X-Refund-Idempotency': key }
        );
      } catch (e: any) {
        const raw = String(e?.message || e);
        const code = Number(/failed \((\d{3})\)/.exec(raw)?.[1] || 0);
        // Razorpay answered with a 4xx: it refused, nothing moved. Except a
        // 409: a request with this idempotency key is still being processed.
        // Anything else (a timeout, a 5xx) may have refunded. Those two keep
        // the lock.
        keepLock = !(code >= 400 && code < 500 && code !== 409);
        const error =
          code === 409
            ? `${raw} A refund of this payment may be in progress: check the audit log and the payment in Razorpay before retrying.`
            : keepLock
              ? `${raw} The refund may still have gone through: reload in a minute and check before trying again.`
              : raw;
        await this._refundsRepository
          .finishAudit(row.id, { status: 'FAILED', error })
          .catch((err) => this.logger.error(`Refund audit ${row.id} not updated: ${err}`));
        return { paymentId, status: 'failed', amount, currency, error };
      }

      // Razorpay made a refund, so the lock stays even if it failed.
      keepLock = true;
      if (refund?.status === 'failed') {
        // A refund Razorpay could not process (a payment older than six
        // months, say): it comes back with a 2xx, but no money moved.
        const error = `Razorpay could not process refund ${refund?.id || ''} (status failed). Nothing was refunded.`;
        await this._refundsRepository
          .finishAudit(row.id, { status: 'FAILED', refundId: refund?.id || null, error })
          .catch((e) => this.logger.error(`Refund audit ${row.id} not updated: ${e}`));
        return {
          paymentId,
          status: 'failed',
          amount,
          currency,
          refundId: refund?.id,
          refundStatus: 'failed',
          error,
        };
      }
      await this._refundsRepository
        .finishAudit(row.id, { status: 'SUCCESS', refundId: refund?.id || null })
        .catch((e) =>
          this.logger.error(`Refund ${refund?.id} of ${paymentId} sent, audit ${row.id} not updated: ${e}`)
        );
      this.logger.log(`Refund ${refund?.id} of ${paymentId}: ${amount} ${currency} by ${admin.email}`);
      if (duplicate && owner.organizationId && refund?.id) {
        // Fire and forget: the money has moved, and a mail provider outage
        // must not turn a finished refund into a failed one.
        void this._accountCorrectionService
          .notify({
            organizationId: owner.organizationId,
            facts: {
              event: 'DUPLICATE_CHARGE_REFUNDED',
              amount: Number(refund?.amount ?? amount) / 100,
              currency,
              refundId: refund.id,
              paymentId,
              refundedAt: new Date(),
            },
            reference: refund.id,
            reason: reason || 'Duplicate charge refunded from the Refunds page',
            by: admin.email,
            amount: Number(refund?.amount ?? amount) / 100,
            currency,
            ids: { refund: refund.id, payment: paymentId, subscription: owner.subscriptionId },
          })
          .catch((e) =>
            this.logger.error(`Refund ${refund.id} sent, duplicate-charge email not sent: ${e}`)
          );
      }
      return {
        paymentId,
        status: 'refunded',
        amount: Number(refund?.amount ?? amount),
        currency,
        refundId: refund?.id,
        refundStatus: refund?.status,
      };
    } finally {
      if (!keepLock) {
        await (ioRedis as any)
          .eval(RELEASE_LOCK, 1, lockKey, lockToken)
          .catch((e: any) => this.logger.warn(`Could not release ${lockKey}: ${e}`));
      }
    }
  }

  /**
   * Refund each payment, one after another, with a short pause in between:
   * less Razorpay's fee by default, everything left with `full`. A payment that is refused or fails does not stop the rest.
   */
  async refundBulk(
    admin: RefundAdmin,
    paymentIds: string[],
    opts: { reason?: string; confirmForeign?: boolean; full?: boolean } = {}
  ) {
    const ids = [...new Set((paymentIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (!ids.length) throw new BadRequestException('No payment ids');
    if (ids.length > BULK_REFUND_MAX) {
      throw new BadRequestException(`At most ${BULK_REFUND_MAX} payments per call`);
    }

    const results: RefundResult[] = [];
    for (const [i, paymentId] of ids.entries()) {
      if (i > 0 && this.bulkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.bulkDelayMs));
      }
      results.push(await this.refund(admin, { paymentId, ...opts }));
    }

    const refundedTotals: Record<string, number> = {};
    for (const r of results) {
      if (r.status === 'refunded' && r.currency) {
        refundedTotals[r.currency] = (refundedTotals[r.currency] || 0) + (r.amount || 0);
      }
    }
    return {
      results,
      summary: {
        requested: ids.length,
        refunded: results.filter((r) => r.status === 'refunded').length,
        refused: results.filter((r) => r.status === 'refused').length,
        failed: results.filter((r) => r.status === 'failed').length,
        refundedTotals,
      },
    };
  }
}
