import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { DEFAULT_ADAPTER, pickAdapter } from '@hookpost/nestjs-libraries/marketplace/marketplace.adapters';
import { disabledProducts, isMarketplaceProduct } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

export const MARKETPLACE_DOCS_URL = 'https://hookpost.hookstep.in/docs/public-api';

/**
 * GET (and HEAD) /mkt/v1/<product>: the bare product root, which marketplace
 * uptime checks and people trying the base URL call. It answers that the
 * product is up and nothing else, so it runs WITHOUT MarketplaceAuthMiddleware
 * (it is deliberately not in marketplaceControllers): no workspace is resolved,
 * no subscriber is read, nothing is counted, and the billing header says 0.
 * Every other /mkt/v1 route keeps the gateway's auth.
 */
@ApiExcludeController()
@Controller('/mkt/v1/:product')
export class MarketplaceRootController {
  // Express answers HEAD from the GET route (same status and headers, no body).
  @Get()
  root(@Param('product') product: string, @Req() req: Request, @Res() res: Response) {
    // "Nothing billed" in the header of the marketplace the call names, as
    // the middleware starts every answer (api.market when it names none).
    const pick = pickAdapter(req.headers);
    const adapter = pick.kind === 'one' ? pick.adapter : DEFAULT_ADAPTER;
    for (const [name, value] of Object.entries(adapter.billingHeaders(0))) {
      res.setHeader(name, value);
    }
    res.setHeader('Cache-Control', 'no-store');
    if (!isMarketplaceProduct(product)) {
      res.status(404).json({ error: 'not_found', message: 'No such product.' });
      return;
    }
    if (disabledProducts().has(product)) {
      res.status(503).json({ product, status: 'paused', docs: MARKETPLACE_DOCS_URL });
      return;
    }
    res.status(200).json({ product, status: 'ok', docs: MARKETPLACE_DOCS_URL });
  }
}
