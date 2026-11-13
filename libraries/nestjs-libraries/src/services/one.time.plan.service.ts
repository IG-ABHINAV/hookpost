import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { SubscriptionService } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { AffiliateService } from '@hookpost/nestjs-libraries/database/prisma/affiliates/affiliate.service';
import {
  orderSignatureValid,
  RazorpayClient,
} from '@hookpost/nestjs-libraries/services/razorpay.client';
import { ioRedis } from '@hookpost/nestjs-libraries/redis/redis.service';
import { currencyCountry, CurrencyHints } from '@hookpost/nestjs-libraries/services/billing.currency';
import {
  isOrderIdentifier,
  nextPaidUntil,
  oneTimePlanAmountMinor,
  oneTimePlanCheckout,
  oneTimePlanPriceLabel,
  orderCurrencyFor,
  paidOrderRefusal,
  removeOneMonth,
  ONE_TIME_PLAN_NAME,
  ONE_TIME_PLAN_TIER,
  ORDER_FULL_REFUND_SHARE,
  ORDER_KIND,
  ORDER_MAX_AGE_MS,
  OrderCurrency,
} from '@hookpost/nestjs-libraries/database/prisma/subscriptions/one.time.plan';

export type OrderHints = Pick<CurrencyHints, 'requestCountry' | 'tz'>;

export interface OrderPaymentHandshake {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface SavedCard {
  /** Razorpay's token id: the only reference to the card kept anywhere here. */
  id: string;
  last4: string;
  network: string;
  expired: boolean;
}

export interface GrantResult {
  granted: boolean;
  paidUntil?: Date | null;
  reason?: 'ALREADY_GRANTED' | 'HAS_PLAN';
}

const CHECKOUT_MESSAGES = {
  HAS_PLAN:
    'Your workspace already has a plan. It stays exactly as it is; manage it on this page.',
  ALREADY_PAID:
    'This month is already paid for. You can renew for another month 3 days before it ends.',
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One-time checkout for the single plan (one.time.plan.ts): creates the
 * Razorpay order at the server's price, confirms the payment the page
 * reports, and grants one month for each captured payment exactly once,
 * whether the page, order.paid or payment.captured gets there first.
 *
 * Nothing here touches a Razorpay subscription: workspaces on one keep it as
 * it is, and cannot buy an order beside it (HAS_PLAN).
 */
@Injectable()
export class OneTimePlanService {
  private readonly logger = new Logger(OneTimePlanService.name);
  private readonly client = new RazorpayClient();

  constructor(
    private _subscriptionService: SubscriptionService,
    @Optional() private _affiliateService?: AffiliateService
  ) {}

  /** The currency a workspace's order charges: its owner's country first, then the request. */
  async currencyFor(organizationId: string, hints: OrderHints = {}): Promise<OrderCurrency> {
    let ownerCountry: string | null = null;
    try {
      ownerCountry =
        (await this._subscriptionService.getCurrencyFacts(organizationId))?.ownerCountry ?? null;
    } catch (e: any) {
      this.logger.warn(
        `Order currency for org ${organizationId} follows the request only: ${e?.message || e}`
      );
    }
    return orderCurrencyFor(
      currencyCountry({
        ownerCountry,
        requestCountry: hints.requestCountry ?? null,
        tz: hints.tz ?? null,
      })
    );
  }

  /** What the Billing page shows: price, and whether checkout opens now. */
  async quote(
    organizationId: string,
    hints: OrderHints = {},
    now = new Date(),
    customerId?: string | null
  ) {
    const currency = await this.currencyFor(organizationId, hints);
    const row = await this._subscriptionService.getSubscription(organizationId);
    const verdict = oneTimePlanCheckout(row, now);
    const paidUntil =
      row && !row.deletedAt && isOrderIdentifier(row.identifier) && row.cancelAt
        ? new Date(row.cancelAt)
        : null;
    return {
      name: ONE_TIME_PLAN_NAME,
      tier: ONE_TIME_PLAN_TIER,
      currency,
      price: (oneTimePlanAmountMinor(currency) as number) / 100,
      label: oneTimePlanPriceLabel(currency),
      canBuy: verdict.ok,
      renew: verdict.ok ? !!verdict.renew : false,
      refusal: verdict.ok ? null : verdict.code,
      paidUntil: paidUntil && paidUntil.getTime() > now.getTime() ? paidUntil.toISOString() : null,
      savedCard: await this.savedCard(customerId, now),
    };
  }

  /**
   * The card Razorpay keeps for this customer, if any (Razorpay's card
   * tokens: the card itself is never seen or stored here, only Razorpay's
   * token id, last 4 digits and network). The newest live one first; an
   * expired one is reported as expired so the page can say so. Null when
   * there is none or Razorpay cannot be read: checkout then simply asks for
   * a card, as on a first payment.
   */
  async savedCard(customerId: string | null | undefined, now = new Date()): Promise<SavedCard | null> {
    if (!customerId) return null;
    let items: any[] = [];
    try {
      items =
        (await this.client.request('GET', `/customers/${encodeURIComponent(customerId)}/tokens`))
          ?.items || [];
    } catch (e: any) {
      this.logger.warn(`Saved cards of ${customerId} not read: ${e?.message || e}`);
      return null;
    }
    const cards = items
      .filter((t) => t?.method === 'card' && t?.id && t?.card)
      .map((t) => ({
        id: String(t.id),
        last4: String(t.card.last4 || ''),
        network: String(t.card.network || 'Card'),
        expired: !!t.expired_at && Number(t.expired_at) * 1000 <= now.getTime(),
        createdAt: Number(t.created_at) || 0,
      }))
      .sort((a, b) => Number(a.expired) - Number(b.expired) || b.createdAt - a.createdAt);
    if (!cards.length) return null;
    const { createdAt: _c, ...card } = cards[0];
    return card;
  }

  /**
   * "Remove saved card": deletes Razorpay's token for this customer. Only a
   * token Razorpay lists for this same customer, so nobody can delete
   * another customer's card by guessing an id.
   */
  async removeSavedCard(customerId: string | null | undefined, tokenId: string) {
    if (!customerId || !tokenId) {
      throw new BadRequestException({ statusCode: 400, code: 'NO_SAVED_CARD', message: 'There is no saved card to remove.' });
    }
    const items: any[] =
      (await this.client.request('GET', `/customers/${encodeURIComponent(customerId)}/tokens`))
        ?.items || [];
    if (!items.some((t) => t?.id === tokenId)) {
      throw new BadRequestException({ statusCode: 400, code: 'NO_SAVED_CARD', message: 'There is no saved card to remove.' });
    }
    await this.client.request(
      'DELETE',
      `/customers/${encodeURIComponent(customerId)}/tokens/${encodeURIComponent(tokenId)}`
    );
    return { removed: true };
  }

  /**
   * Create the Razorpay order for one month. The amount and currency are
   * the server's (ONE_TIME_PLAN_PRICE, currencyFor); the body carries none.
   */
  async createOrder(
    organizationId: string,
    userId: string,
    hints: OrderHints = {},
    now = new Date(),
    customerId?: string | null
  ) {
    const row = await this._subscriptionService.getSubscription(organizationId);
    const verdict = oneTimePlanCheckout(row, now);
    if (!verdict.ok) {
      throw new ConflictException({
        statusCode: 409,
        code: verdict.code,
        message: CHECKOUT_MESSAGES[verdict.code || 'HAS_PLAN'],
      });
    }

    const lockKey = `razorpay:order-lock:${organizationId}`;
    let locked = false;
    try {
      locked = (await (ioRedis as any).set(lockKey, '1', 'EX', 20, 'NX')) === 'OK';
    } catch (e) {
      this.logger.error(`Could not take ${lockKey}: ${e}`);
      locked = true;
    }
    if (!locked) {
      throw new ConflictException({
        statusCode: 409,
        code: 'ORDER_IN_PROGRESS',
        message: 'A checkout for this workspace is already opening. Give it a moment.',
      });
    }

    try {
      const currency = await this.currencyFor(organizationId, hints);
      const amount = oneTimePlanAmountMinor(currency) as number;
      const order = await this.client.request('POST', '/orders', {
        amount,
        currency,
        // Razorpay caps the receipt at 40 characters.
        receipt: `hp_${organizationId.slice(0, 24)}_${now.getTime().toString(36)}`.slice(0, 40),
        notes: {
          service: 'hookpost',
          kind: ORDER_KIND,
          orgId: organizationId,
          userId,
          tier: ONE_TIME_PLAN_TIER,
          months: '1',
          currency,
          amount: String(amount),
          renew: verdict.renew ? 'true' : 'false',
        },
      });
      return {
        orderId: order.id as string,
        keyId: process.env.RAZORPAY_KEY_ID || '',
        amount,
        currency,
        label: oneTimePlanPriceLabel(currency),
        name: ONE_TIME_PLAN_NAME,
        renew: !!verdict.renew,
        // Checkout lists the customer's saved card for one-click renewal and
        // offers to save a new one (with the customer's own consent box).
        customerId: customerId || null,
        savedCard: await this.savedCard(customerId, now),
      };
    } finally {
      await (ioRedis as any).del(lockKey).catch((): void => undefined);
    }
  }

  /**
   * The page's confirmation after Razorpay Checkout: the signature, then
   * Razorpay's own copies of the order and payment (never the browser's),
   * then the month. An authorized payment is captured for exactly the
   * order's amount. Safe to repeat: the month is given once per payment.
   */
  async verify(
    organizationId: string,
    body: OrderPaymentHandshake,
    now = new Date()
  ): Promise<GrantResult & { ok: true }> {
    const orderId = String(body?.razorpay_order_id || '');
    const paymentId = String(body?.razorpay_payment_id || '');
    if (
      !orderSignatureValid(
        orderId,
        paymentId,
        String(body?.razorpay_signature || ''),
        process.env.RAZORPAY_KEY_SECRET || ''
      )
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_SIGNATURE',
        message: 'We could not confirm this payment.',
      });
    }

    const order = await this.client.request('GET', `/orders/${encodeURIComponent(orderId)}`);
    let payment = await this.client.request(
      'GET',
      `/payments/${encodeURIComponent(paymentId)}`
    );
    const refusal = paidOrderRefusal({ order, payment, organizationId, authorizedOk: true });
    if (refusal) {
      this.logger.warn(
        `Order ${orderId} / ${paymentId} refused for org ${organizationId}: ${refusal}`
      );
      throw new BadRequestException({
        statusCode: 400,
        code: refusal,
        message: 'We could not confirm this payment.',
      });
    }

    if (payment.status === 'authorized') {
      // Not captured yet: an order this old is not taken now (Razorpay
      // returns an uncaptured authorization by itself).
      if (Number(order.created_at) * 1000 < now.getTime() - ORDER_MAX_AGE_MS) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'ORDER_EXPIRED',
          message: 'This checkout has expired. Please start a new one.',
        });
      }
      payment = await this.client.request(
        'POST',
        `/payments/${encodeURIComponent(paymentId)}/capture`,
        { amount: order.amount, currency: order.currency }
      );
      if (payment?.status !== 'captured') {
        throw new BadRequestException({
          statusCode: 400,
          code: 'NOT_CAPTURED',
          message: 'We could not confirm this payment.',
        });
      }
    }

    return { ok: true, ...(await this.grant(order, payment, now)) };
  }

  /**
   * order.paid and payment.captured. False for anything that is not one of
   * our one-time orders (a subscription's charge, another product's order),
   * so the caller carries on as before. Duplicate deliveries are dropped by
   * event id first, and in any case give the month once per payment.
   */
  async handleWebhook(type: string, event: any, eventId?: string, now = new Date()) {
    if (type !== 'order.paid' && type !== 'payment.captured') return false;
    const payment = event?.payload?.payment?.entity;
    if (!payment?.order_id || payment.invoice_id || payment.subscription_id) return false;

    let order = event?.payload?.order?.entity;
    if (!order || order.id !== payment.order_id) {
      order = await this.client.request(
        'GET',
        `/orders/${encodeURIComponent(payment.order_id)}`
      );
    }
    if (order?.notes?.service !== 'hookpost' || order?.notes?.kind !== ORDER_KIND) {
      return false;
    }

    if (eventId) {
      const fresh = await (ioRedis as any)
        .set(`razorpay:event:${eventId}`, '1', 'EX', 7 * 86_400, 'NX')
        .catch((): string => 'OK');
      if (fresh !== 'OK') return true;
    }

    const refusal = paidOrderRefusal({ order, payment });
    if (refusal) {
      this.logger.error(
        `${type} for order ${order.id} / ${payment.id} gave no month: ${refusal}`
      );
      return true;
    }
    try {
      await this.grant(order, payment, now);
    } catch (e) {
      // Let Razorpay retry this delivery: the event id must not swallow it.
      if (eventId) {
        await (ioRedis as any).del(`razorpay:event:${eventId}`).catch((): void => undefined);
      }
      throw e;
    }
    return true;
  }

  /**
   * One month for one captured payment, once. The BillingIdentity claim is
   * the idempotency key; the per-workspace lock makes two different payments
   * landing together (paid twice in two tabs) add two months rather than
   * both reading the same end date.
   */
  async grant(order: any, payment: any, now = new Date()): Promise<GrantResult> {
    const organizationId: string = order.notes.orgId;
    const release = await this.lockWorkspace(organizationId);
    try {
      const claimed = await this._subscriptionService.claimOrderPayment(
        organizationId,
        order.id,
        payment.id
      );
      const row = await this._subscriptionService.getSubscription(organizationId);
      if (!claimed) {
        return { granted: false, reason: 'ALREADY_GRANTED', paidUntil: row?.cancelAt ?? null };
      }
      try {
        const verdict = oneTimePlanCheckout(row, now);
        if (!verdict.ok && verdict.code === 'HAS_PLAN') {
          // Paid while another plan was live (opened before it started, or
          // a subscription activated meanwhile). That plan is not touched;
          // the payment stays recorded for the owner to refund.
          this.logger.error(
            `Order ${order.id} (${payment.id}, ${payment.amount} ${payment.currency}) was paid by org ${organizationId}, which has plan ${row?.identifier}: no month given, refund it by hand.`
          );
          return { granted: false, reason: 'HAS_PLAN' };
        }
        const liveOrder =
          !!row &&
          !row.deletedAt &&
          isOrderIdentifier(row.identifier) &&
          !!row.cancelAt &&
          new Date(row.cancelAt).getTime() > now.getTime();
        const paidUntil = nextPaidUntil(liveOrder ? row!.cancelAt : null, now);
        await this._subscriptionService.applyOneTimePlan(organizationId, {
          identifier: liveOrder ? row!.identifier! : order.id,
          cancelAt: paidUntil,
        });
        this.logger.log(
          `Org ${organizationId} paid ${payment.amount} ${payment.currency} (${order.id}); plan until ${paidUntil.toISOString()}.`
        );
        await this._affiliateService?.recordCommission(organizationId, payment);
        return { granted: true, paidUntil };
      } catch (e) {
        await this._subscriptionService
          .releaseOrderPayment(organizationId, payment.id)
          .catch((): void => undefined);
        throw e;
      }
    } finally {
      await release();
    }
  }

  /**
   * refund.created / refund.processed on one of our order payments. A
   * refund of at least ORDER_FULL_REFUND_SHARE of the payment takes its
   * month back; less (goodwill) keeps it. False for any other payment, so
   * the subscription refund handling runs as before.
   */
  async handleRefund(refund: any, payment?: any, now = new Date()) {
    const paymentId = refund?.payment_id || payment?.id;
    if (!paymentId) return false;
    const record = await this._subscriptionService.findOrderPayment(paymentId);
    if (!record) return false;

    const p =
      payment?.id === paymentId
        ? payment
        : await this.client.request('GET', `/payments/${encodeURIComponent(paymentId)}`);
    if (!(p?.amount > 0) || p.amount_refunded / p.amount < ORDER_FULL_REFUND_SHARE) {
      return true;
    }
    const once = await (ioRedis as any)
      .set(`razorpay:order-refunded:${paymentId}`, '1', 'EX', 400 * 86_400, 'NX')
      .catch((): string => 'OK');
    if (once !== 'OK') return true;

    const organizationId = record.organizationId;
    const release = await this.lockWorkspace(organizationId);
    try {
      const row = await this._subscriptionService.getSubscription(organizationId);
      if (!row || row.deletedAt || !isOrderIdentifier(row.identifier) || !row.cancelAt) {
        return true;
      }
      const end = removeOneMonth(new Date(row.cancelAt));
      if (end.getTime() <= now.getTime()) {
        await this._subscriptionService.endOneTimePlan(organizationId, row.identifier!);
      } else {
        await this._subscriptionService.applyOneTimePlan(organizationId, {
          identifier: row.identifier!,
          cancelAt: end,
        });
      }
      this.logger.log(`Refund of ${paymentId} took a paid month back from org ${organizationId}.`);
      return true;
    } catch (e) {
      await (ioRedis as any).del(`razorpay:order-refunded:${paymentId}`).catch((): void => undefined);
      throw e;
    } finally {
      await release();
    }
  }

  /** A short per-workspace lock, waited for (a grant takes well under a second). */
  private async lockWorkspace(organizationId: string): Promise<() => Promise<void>> {
    const key = `razorpay:order-grant:${organizationId}`;
    for (let i = 0; i < 40; i++) {
      let got: string | null = null;
      try {
        got = await (ioRedis as any).set(key, '1', 'EX', 30, 'NX');
      } catch (e) {
        this.logger.error(`Could not take ${key}: ${e}`);
        return async () => undefined;
      }
      if (got === 'OK') {
        return async () => {
          await (ioRedis as any).del(key).catch((): void => undefined);
        };
      }
      await sleep(250);
    }
    throw new ConflictException({
      statusCode: 409,
      code: 'ORDER_IN_PROGRESS',
      message: 'A payment for this workspace is being applied. Refresh in a moment.',
    });
  }
}
