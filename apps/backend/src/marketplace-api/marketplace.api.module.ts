import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { UploadModule } from '@hookpost/nestjs-libraries/upload/upload.module';
import { MarketplaceAuthMiddleware } from '@hookpost/backend/marketplace-api/marketplace.auth.middleware';
import { MarketplaceLedger } from '@hookpost/backend/marketplace-api/marketplace.ledger';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import { MarketplaceSocialController } from '@hookpost/backend/marketplace-api/routes/social.controller';
import { MarketplaceLinkedInController } from '@hookpost/backend/marketplace-api/routes/linkedin.controller';
import { MarketplaceXController } from '@hookpost/backend/marketplace-api/routes/x.controller';
import { MarketplaceValidateController } from '@hookpost/backend/marketplace-api/routes/validate.controller';
import { MarketplaceProbeController } from '@hookpost/backend/marketplace-api/routes/probe.controller';
import { MarketplaceRootController } from '@hookpost/backend/marketplace-api/routes/root.controller';

/**
 * The Hookpost products sold on api.market, at /api/mkt/v1/<product>/...
 * (docs/marketplace/*.openapi.json). Separate from /public/v1, which keeps its
 * own API-key auth for Hookpost's own customers: nothing here accepts a
 * Hookpost key, and nothing there reaches a marketplace workspace (they have
 * none).
 */
export const marketplaceControllers = [
  MarketplaceSocialController,
  MarketplaceLinkedInController,
  MarketplaceXController,
  MarketplaceValidateController,
  MarketplaceProbeController,
];

@Module({
  imports: [UploadModule],
  // The bare product root (a health answer) stays outside the gateway's auth:
  // it is not in marketplaceControllers, which the middleware covers.
  controllers: process.env.MCP_ONLY ? [] : [...marketplaceControllers, MarketplaceRootController],
  providers: [MarketplaceLedger, MarketplaceService, MarketplaceInterceptor],
})
export class MarketplaceApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MarketplaceAuthMiddleware).forRoutes(...marketplaceControllers);
  }
}
