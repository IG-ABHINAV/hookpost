import { Body, Controller, Get, HttpCode, Post, UseInterceptors } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  PLATFORM_RULES,
  validateDraft,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.validator';
import { MarketplaceContext, Mkt } from '@hookpost/backend/marketplace-api/marketplace.context';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import { ValidatorCheckDto } from '@hookpost/backend/marketplace-api/marketplace.dto';

/**
 * 4. Social Post Validator API (docs/marketplace/post-validator.openapi.json):
 * a draft against each network's rules, nothing connected, no network called.
 */
@ApiExcludeController()
@Controller('/mkt/v1/validate')
@UseInterceptors(MarketplaceInterceptor)
export class MarketplaceValidateController {
  constructor(private _service: MarketplaceService) {}

  @Post('/check')
  @HttpCode(200)
  async check(@Mkt() ctx: MarketplaceContext, @Body() body: ValidatorCheckDto) {
    await this._service.chargeCheck(ctx);
    const results = validateDraft({
      text: body.text,
      media: body.media,
      platforms: [...new Set(body.platforms)],
      xPremium: body.x_premium,
    });
    return { valid: results.every((r) => r.valid), results };
  }

  @Get('/usage')
  usage(@Mkt() ctx: MarketplaceContext) {
    return this._service.usage(ctx);
  }

  @Get('/rules')
  rules() {
    return {
      platforms: PLATFORM_RULES.map((r) => ({
        platform: r.platform,
        name: r.name,
        max_chars: r.maxChars,
        premium_max_chars: r.premiumMaxChars ?? null,
        counting: r.counting,
        min_media: r.minMedia,
        max_media: r.maxMedia,
        video_alone: r.videoAlone,
        requires_video: r.requiresVideo,
        video_needs_cover: r.videoNeedsCover,
        images_same_size: r.imagesSameSize,
      })),
    };
  }
}
