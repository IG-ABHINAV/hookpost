import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { MarketplaceAccountService } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.service';
import { MarketplaceAccountRepository } from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.account.repository';
import {
  MarketplaceUsageService,
  NO_PRODUCT,
  UNKNOWN_MARKETPLACE,
} from '@hookpost/nestjs-libraries/database/prisma/marketplace/marketplace.usage.service';
import {
  disabledProducts,
  isMarketplaceProduct,
  MarketplaceProduct,
  planForWindow,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import {
  IDEMPOTENCY_HEADER,
  sha256Hex,
  singleHeader,
  subscriberTag,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import {
  DEFAULT_ADAPTER,
  isRefusal,
  MarketplaceAdapter,
  pickAdapter,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import { ioRedis, ioRedisIsMock } from '@hookpost/nestjs-libraries/redis/redis.service';
import { setSentryUserContext } from '@hookpost/nestjs-libraries/sentry/initialize.sentry';
import { MarketplaceRequest } from '@hookpost/backend/marketplace-api/marketplace.context';
import { ledgerKeys, MarketplaceLedger } from '@hookpost/backend/marketplace-api/marketplace.ledger';

const PATH = /^\/mkt\/v1\/([a-z_]+)(?:[/?]|$)/;
const PROBE = /^\/mkt\/v1\/[a-z]+\/_probe(?:[/?]|$)/;

/** Per-subscriber token buckets (MKT_RATE_WRITE_PER_SEC / MKT_RATE_READ_PER_SEC). */
const rate = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const marketplaceProductOf = (url: string): MarketplaceProduct | null => {
  const match = PATH.exec(url || '');
  return match && isMarketplaceProduct(match[1]) ? match[1] : null;
};

/**
 * Who is calling /mkt/v1/<product>/..., in this order. One gateway for every
 * marketplace: what differs between api.market, RapidAPI and the keyed
 * marketplaces is in their adapter (marketplace.adapters.ts), the rest is
 * the same for all.
 *
 *  0. The marketplace: the one adapter whose marker header the call carries
 *     (x-hookpost-gateway, X-RapidAPI-Proxy-Secret, x-hookpost-marketplace).
 *     None, or two at once: 401.
 *  1. Its secret must match one of the product's secrets for that
 *     marketplace (api.market: MKT_GATEWAY_SECRETS_<PRODUCT>; RapidAPI:
 *     MKT_RAPIDAPI_SECRETS_<PRODUCT>; keyed: MKT_KEYED_<NAME>_SECRETS_<PRODUCT>):
 *     401 otherwise, and while none is configured every call is refused.
 *  2. A buyer's Authorization header is refused (400): a Hookpost key must
 *     never pass through a marketplace, which keeps request logs.
 *  3. The plan and the subscriber, as the adapter reads them (api.market: a
 *     plan token or x-magicapi-plan, then x-magicapi-user; RapidAPI:
 *     X-RapidAPI-Subscription, then X-RapidAPI-User): 403 for a plan that
 *     names none of this product's, 400 for a missing or malformed buyer id.
 *     Trusted only because (1) proved which marketplace sent them.
 *  4. The subscriber's workspace for this marketplace and product is found
 *     or created (MarketplaceAccountService.resolve) and becomes req.org. No
 *     role is injected; the handlers enforce the plan themselves.
 *
 * Every response starts as "nothing billed" in the marketplace's own header
 * (api.market: `X-Magicapi-Billing: API=0;`, as before adapters) and only a
 * handler that accepted the call raises it. Secrets are compared as digests
 * and only a hash prefix of the one that matched is counted
 * (mkt:secrethits:*), so a rotation can tell when the old one stopped being
 * used. Every call, refused or not, is counted per marketplace, product and
 * day (MarketplaceUsageService) once its response is sent.
 */
@Injectable()
export class MarketplaceAuthMiddleware implements NestMiddleware {
  private readonly logger = new Logger('Marketplace');

  constructor(
    private _accounts: MarketplaceAccountService,
    private _repository: MarketplaceAccountRepository,
    private _ledger: MarketplaceLedger,
    private _usage: MarketplaceUsageService
  ) {}

  async use(req: MarketplaceRequest, res: Response, next: NextFunction) {
    // 0. The marketplace: the one whose marker the call carries. Every
    // answer starts as "nothing billed" in its billing header; a call that
    // names none (or two) reads as the default marketplace's, as before
    // there were adapters.
    const pick = pickAdapter(req.headers);
    const adapter: MarketplaceAdapter = pick.kind === 'one' ? pick.adapter : DEFAULT_ADAPTER;
    this.setBilling(res, adapter, 0);
    res.setHeader('Cache-Control', 'no-store');
    const refuse = (status: number, error: string, message: string) => {
      res.status(status).json({ error, message });
    };

    // A call is counted against its marketplace once it names exactly one
    // (its refusals included); its last call only moves once its secret
    // matched (MarketplaceUsageService.record ignores a 401 for it).
    let counted = { marketplace: UNKNOWN_MARKETPLACE, product: NO_PRODUCT };
    if (typeof res.once === 'function') {
      res.once('finish', () => {
        this._usage.record(counted.marketplace, counted.product, res.statusCode, req.mkt?.billed ?? 0);
        // Per subscriber workspace, for the admin Workspaces list: only calls
        // that got past the secret and found an account.
        if (req.mkt?.account?.id) this._usage.recordAccount(req.mkt.account.id);
      });
    }

    const url = req.originalUrl || req.url;
    const product = marketplaceProductOf(url);
    if (!product) {
      return refuse(404, 'not_found', 'No such product.');
    }
    counted = { ...counted, product };

    if (pick.kind === 'several') {
      this.logger.warn(`refused product=${product} reason=several_marketplaces marketplaces=${pick.ids.join('+')}`);
      return refuse(401, 'unauthorized', 'Call this API through one marketplace.');
    }
    if (pick.kind === 'one') {
      counted = { ...counted, marketplace: adapter.id };
    }

    // 1. The marketplace's secret.
    const secrets = adapter.secrets(product);
    const matched = pick.kind === 'one' ? adapter.matchSecret(req.headers, product) : adapter.matchSecret({}, product);
    if (matched < 0) {
      this.logger.warn(
        `refused product=${product} reason=${secrets.length ? 'gateway_secret' : 'gateway_not_configured'} marketplace=${counted.marketplace}`
      );
      return refuse(401, 'unauthorized', adapter.unauthorizedMessage);
    }
    this.countSecretHit(adapter, product, secrets[matched]);

    if (disabledProducts().has(product)) {
      return refuse(503, 'product_paused', 'This API is paused. Nothing was done; try again later.');
    }

    if (PROBE.test(url)) {
      if (!adapter.probe) {
        return refuse(404, 'not_found', 'Not found.');
      }
      // The probe answers only what the gateway forwards (probe.controller.ts).
      (req as any).mktProbe = { product, secret: matched };
      return next();
    }

    if (ioRedisIsMock) {
      return refuse(503, 'unavailable', 'The API is not available right now.');
    }

    // 2. An Authorization header is refused whatever else the call carries,
    // so a buyer who pasted a Hookpost key learns at once.
    if (req.headers.authorization !== undefined) {
      return refuse(400, 'authorization_not_accepted', adapter.authorizationMessage);
    }

    // 3. The plan and the subscriber.
    const identity = adapter.identify(req.headers, product);
    if (isRefusal(identity)) {
      this.logger.warn(`refused product=${product} reason=${identity.reason} marketplace=${adapter.id}`);
      return refuse(identity.status, identity.error, identity.message);
    }
    const { subscriber, plan } = identity;
    const tag = subscriberTag(adapter.subscriberKey(subscriber));
    if (identity.warning) {
      this.logger.warn(
        `${identity.warning.kind} product=${product} ${identity.warning.detail} subscriber=${tag} marketplace=${adapter.id}`
      );
    }

    // 4. The workspace.
    const now = new Date();
    let resolved;
    try {
      resolved = await this._accounts.resolve(subscriber, plan, now, adapter);
    } catch (e: any) {
      this.logger.error(
        `provisioning failed marketplace=${adapter.id} product=${product} subscriber=${tag}: ${e?.message || e}`
      );
      return refuse(503, 'unavailable', 'The API is not available right now.');
    }
    const { account } = resolved;
    if (account.status === 'BLOCKED') {
      return refuse(403, 'account_blocked', 'This subscription is blocked. Contact support@hookstep.in.');
    }

    const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    try {
      const allowed = await this._ledger.allow(
        ledgerKeys.bucket(account.id, write ? 'write' : 'read'),
        write ? rate('MKT_RATE_WRITE_PER_SEC', 2) : rate('MKT_RATE_READ_PER_SEC', 10),
        write ? rate('MKT_RATE_WRITE_PER_SEC', 2) * 2 : rate('MKT_RATE_READ_PER_SEC', 10) * 2
      );
      if (!allowed) {
        res.setHeader('Retry-After', '1');
        return refuse(429, 'rate_limited', 'Too many calls a second. Slow down and retry.');
      }
    } catch (e: any) {
      this.logger.error(`rate limit unavailable: ${e?.message || e}`);
      return refuse(503, 'unavailable', 'The API is not available right now.');
    }

    const org = await this._repository.organization(account.organizationId);
    if (!org || org.deletedAt) {
      return refuse(403, 'account_blocked', 'This subscription is blocked. Contact support@hookstep.in.');
    }

    // @ts-ignore - req.org is what GetOrgFromRequest and the throttler read
    req.org = org;
    const requestId = adapter.requestId(req.headers);
    // The shared subscriber of a marketplace without buyer ids is every
    // buyer at once: a replay could hand one buyer another's answer.
    const idempotencyKey =
      identity.shared ? undefined : singleHeader(req.headers[IDEMPOTENCY_HEADER]);
    req.mkt = {
      adapter,
      product,
      // A window that began before the plan's limits were lowered keeps the
      // old ones to its end (PRIOR_PLAN_LIMITS).
      plan: planForWindow(plan, account.periodStart, now),
      account,
      organizationId: account.organizationId,
      subscriber,
      subscriberKey: adapter.subscriberKey(subscriber),
      tag,
      requestId: requestId && requestId.length <= 128 ? requestId : undefined,
      idempotencyKey:
        idempotencyKey && /^[\w.:-]{8,128}$/.test(idempotencyKey) ? idempotencyKey : undefined,
      credits: 0,
    };
    setSentryUserContext({ orgId: account.organizationId });
    next();
  }

  private setBilling(res: Response, adapter: MarketplaceAdapter, credits: number) {
    for (const [name, value] of Object.entries(adapter.billingHeaders(credits))) {
      res.setHeader(name, value);
    }
  }

  private countSecretHit(adapter: MarketplaceAdapter, product: MarketplaceProduct, secret: string) {
    if (ioRedisIsMock) return;
    const key = `mkt:secrethits:${adapter.secretHitScope(product)}:${sha256Hex(secret).slice(0, 8)}:${new Date()
      .toISOString()
      .slice(0, 10)}`;
    ioRedis
      .multi()
      .incr(key)
      .expire(key, 9 * 86400)
      .exec()
      .catch(() => undefined);
  }
}
