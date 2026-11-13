import { Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  BILLING_HEADER,
  billingValue,
  GATEWAY_HEADER,
  MAGICAPI_PLAN_HEADER,
  PLAN_HEADER,
  REQUEST_ID_HEADER,
  resolveMagicapiPlan,
  resolvePlanToken,
  sha256Hex,
  SUBSCRIBER_HEADER,
  validSubscriberId,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.gateway';
import { MarketplaceProduct } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

const hashPrefix = (value: unknown) =>
  typeof value === 'string' && value ? sha256Hex(value).slice(0, 12) : null;

/**
 * GET or POST /mkt/v1/<product>/_probe: what api.market forwards, for the
 * checks before launch (a private free plan per product, its own spec in
 * docs/marketplace/probe.openapi.json). Behind the gateway secret like every
 * other route, and it never answers a value of ours or the caller's: header
 * names, true/false flags and 12-character hash prefixes the tester compares
 * with the values they sent.
 *
 *  - Can a client spoof x-hookpost-plan? Send your own; if its hash prefix
 *    comes back, api.market passes it through. (x-magicapi-user and
 *    x-magicapi-plan need no check: api.market confirmed in writing on
 *    26 Oct 2026 that it always overwrites both before forwarding.)
 *  - Is a 201 billed? ?status=201, then read the seller logs.
 *  - Is X-Magicapi-Billing honoured (also past a hard limit)? ?bill=N.
 *  - Is the client's Authorization forwarded? authorization_present.
 *  - What does x-magicapi-plan hold? x_magicapi_plan (a plan name), and
 *    api.market's outbound address (client_ip, from Cloudflare).
 */
@ApiExcludeController()
@Controller('/mkt/v1/:product/_probe')
export class MarketplaceProbeController {
  // @Res() without passthrough: the probe sets its own status (?status=201),
  // which Nest would otherwise reset to the route's 200.
  @Get()
  get(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    this.send(req, res, query);
  }

  @Post()
  @HttpCode(200)
  post(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    this.send(req, res, query);
  }

  private send(req: Request, res: Response, query: Record<string, string>) {
    const probe = (req as any).mktProbe;
    if (!probe) {
      res.status(404).json({ error: 'not_found', message: 'Not found.' });
      return;
    }
    const status = String(query?.status) === '201' ? 201 : 200;
    res.status(status).json(this.answer(req, res, query, status));
  }

  private answer(req: Request, res: Response, query: Record<string, string>, status: number) {
    const probe = (req as any).mktProbe as { product: MarketplaceProduct; secret: number };
    const bill = Math.min(1000, Math.max(0, Math.floor(Number(query?.bill) || 0)));
    res.setHeader(BILLING_HEADER, billingValue(bill));

    const h = req.headers;
    const values = (name: string) => {
      const v = h[name];
      return Array.isArray(v) ? v.length : v === undefined ? 0 : String(v).split(',').length;
    };
    const magicPlan = typeof h[MAGICAPI_PLAN_HEADER] === 'string' ? (h[MAGICAPI_PLAN_HEADER] as string) : '';
    return {
      product: probe.product,
      gateway_secret: { matched: true, index: probe.secret },
      header_names: Object.keys(h)
        .filter((k) => k !== GATEWAY_HEADER)
        .sort(),
      authorization_present: h.authorization !== undefined,
      subscriber: {
        present: h[SUBSCRIBER_HEADER] !== undefined,
        values: values(SUBSCRIBER_HEADER),
        valid_shape: validSubscriberId(h[SUBSCRIBER_HEADER]),
        sha256_prefix: hashPrefix(h[SUBSCRIBER_HEADER]),
      },
      plan_token: {
        present: h[PLAN_HEADER] !== undefined,
        values: values(PLAN_HEADER),
        known: !!resolvePlanToken(h[PLAN_HEADER], probe.product),
        sha256_prefix: hashPrefix(h[PLAN_HEADER]),
      },
      magicapi_plan: {
        present: h[MAGICAPI_PLAN_HEADER] !== undefined,
        values: values(MAGICAPI_PLAN_HEADER),
        maps_to: resolveMagicapiPlan(h[MAGICAPI_PLAN_HEADER], probe.product)?.plan ?? null,
        sha256_prefix: hashPrefix(h[MAGICAPI_PLAN_HEADER]),
      },
      x_magicapi_plan: /^[\w .-]{1,40}$/.test(magicPlan)
        ? magicPlan
        : magicPlan
        ? `<${magicPlan.length} characters>`
        : null,
      request_id_present: h[REQUEST_ID_HEADER] !== undefined,
      client_ip:
        (typeof h['cf-connecting-ip'] === 'string' && h['cf-connecting-ip']) ||
        (typeof h['x-real-ip'] === 'string' && h['x-real-ip']) ||
        null,
      billed: bill,
      status,
    };
  }
}
