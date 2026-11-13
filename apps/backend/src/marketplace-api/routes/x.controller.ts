import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { checkThread, threadOptionsFor } from '@hookpost/nestjs-libraries/marketplace/marketplace.credits';
import { MarketplaceContext, Mkt } from '@hookpost/backend/marketplace-api/marketplace.context';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import {
  MediaFromUrlDto,
  ThreadDto,
  ThreadEstimateDto,
} from '@hookpost/backend/marketplace-api/marketplace.dto';
import { UPLOAD } from '@hookpost/backend/marketplace-api/routes/social.controller';

/**
 * 3. X Thread API (docs/marketplace/x-threads.openapi.json): threads as an
 * array of tweets, priced before anything is sent. A tweet with a link is
 * refused unless link_policy is "allow", and then costs 10 credits.
 */
@ApiExcludeController()
@Controller('/mkt/v1/x')
@UseInterceptors(MarketplaceInterceptor)
export class MarketplaceXController {
  constructor(private _service: MarketplaceService) {}

  @Post('/threads/estimate')
  @HttpCode(200)
  estimate(@Mkt() ctx: MarketplaceContext, @Body() body: ThreadEstimateDto) {
    const check = checkThread(
      body.tweets.map((t) => ({
        text: t.text,
        media: Array.from({ length: t.media_count || 0 }, () => ({
          type: t.media_type === 'video' ? ('video' as const) : ('image' as const),
        })),
      })),
      threadOptionsFor(ctx.plan, {
        premium: !!body.premium,
        linkPolicy: body.link_policy,
        stripLinks: !!process.env.STRIP_LINKS_FROM_X_POSTS,
      })
    );
    return {
      valid: check.valid,
      credits: check.credits,
      errors: check.errors,
      tweets: check.tweets,
      thread_cap: ctx.plan.threadCap,
      links_included: ctx.plan.allowXLinks,
    };
  }

  @Post('/threads')
  @HttpCode(200)
  create(@Mkt() ctx: MarketplaceContext, @Body() body: ThreadDto) {
    return this._service.createPosts(ctx, {
      channels: [
        {
          channelId: body.channel_id,
          settings: body.who_can_reply ? { who_can_reply_post: body.who_can_reply } : {},
          items: body.tweets.map((t) => ({ text: t.text, mediaIds: t.media_ids || [] })),
        },
      ],
      when: this._service.when(ctx, body.schedule_at),
      linkPolicy: body.link_policy,
    });
  }

  @Get('/threads/:id')
  get(@Mkt() ctx: MarketplaceContext, @Param('id') id: string) {
    return this._service.getPost(ctx, id);
  }

  @Delete('/threads/:id')
  @HttpCode(200)
  remove(@Mkt() ctx: MarketplaceContext, @Param('id') id: string) {
    return this._service.deletePost(ctx, id);
  }

  @Get('/connect')
  connect(@Mkt() ctx: MarketplaceContext, @Query('reconnect') reconnect?: string) {
    return this._service.connect(ctx, 'x', reconnect);
  }

  @Get('/channels')
  channels(@Mkt() ctx: MarketplaceContext) {
    return this._service.channels(ctx);
  }

  @Delete('/channels/:id')
  @HttpCode(200)
  deleteChannel(@Mkt() ctx: MarketplaceContext, @Param('id') id: string) {
    return this._service.deleteChannel(ctx, id);
  }

  @Post('/media')
  @HttpCode(200)
  @UseInterceptors(UPLOAD)
  upload(@Mkt() ctx: MarketplaceContext, @UploadedFile() file: Express.Multer.File) {
    return this._service.upload(ctx, file);
  }

  @Post('/media/from-url')
  @HttpCode(200)
  uploadFromUrl(@Mkt() ctx: MarketplaceContext, @Body() body: MediaFromUrlDto) {
    return this._service.uploadFromUrl(ctx, body.url);
  }

  @Get('/usage')
  usage(@Mkt() ctx: MarketplaceContext) {
    return this._service.usage(ctx);
  }
}
