import {
  createParamDecorator,
  ExecutionContext,
  HttpException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  MarketplacePlan,
  MarketplaceProduct,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { MarketplaceAdapter } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';

/** What the gateway middleware learned about the call, for the handlers. */
export interface MarketplaceContext {
  /** The marketplace the call came through (marketplace.adapters.ts). */
  adapter: MarketplaceAdapter;
  product: MarketplaceProduct;
  plan: MarketplacePlan;
  account: {
    id: string;
    product: string;
    plan: string;
    status: string;
    organizationId: string;
    periodStart: Date;
    externalUserId: string;
  };
  organizationId: string;
  /** The marketplace's buyer id (x-magicapi-user, X-RapidAPI-User, ...). */
  subscriber: string;
  /** The subscriber in Redis keys, unique across marketplaces (adapter.subscriberKey). */
  subscriberKey: string;
  /** Its hash prefix, for logs. */
  tag: string;
  requestId?: string;
  idempotencyKey?: string;
  /** Set by the handler: what a 200 bills (the adapter's billing header). */
  credits: number;
  /** Set by MarketplaceInterceptor: what the response billed, for the usage counters. */
  billed?: number;
}

export type MarketplaceRequest = Request & { mkt?: MarketplaceContext };

/** The call's MarketplaceContext (set by MarketplaceAuthMiddleware). */
export const Mkt = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): MarketplaceContext => {
    const req = ctx.switchToHttp().getRequest<MarketplaceRequest>();
    if (!req.mkt) throw new MktError(401, 'unauthorized', 'Not a marketplace call.');
    return req.mkt;
  }
);

/**
 * Every refusal the marketplace API answers with: `{ error, message }` plus
 * whatever names the item at fault. A 4xx or 5xx is never billed (only a 200
 * is), and its body never names another workspace or a secret.
 */
export class MktError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    extra: Record<string, unknown> = {}
  ) {
    super({ error: code, message, ...extra }, status);
  }
}
