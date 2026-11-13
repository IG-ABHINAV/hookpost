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
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiExcludeController } from '@nestjs/swagger';
import { MARKETPLACE_MAX_VIDEO_BYTES } from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';
import { MarketplaceContext, Mkt } from '@hookpost/backend/marketplace-api/marketplace.context';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import { MediaFromUrlDto, SocialPostDto } from '@hookpost/backend/marketplace-api/marketplace.dto';

export const UPLOAD = FileInterceptor('file', {
  limits: { fileSize: MARKETPLACE_MAX_VIDEO_BYTES, files: 1 },
});

/**
 * 1. Hookpost Social Scheduler API (docs/marketplace/social-scheduler.openapi.json):
 * many networks per call, scheduling, the slot finder and a media library.
 * Every success is a 200; POST /posts bills its credits, everything else 0.
 */
@ApiExcludeController()
@Controller('/mkt/v1/social')
@UseInterceptors(MarketplaceInterceptor)
export class MarketplaceSocialController {
  constructor(private _service: MarketplaceService) {}

  @Get('/providers')
  providers(@Mkt() ctx: MarketplaceContext) {
    return this._service.providers(ctx);
  }

  @Get('/connect/:provider')
  connect(
    @Mkt() ctx: MarketplaceContext,
    @Param('provider') provider: string,
    @Query('reconnect') reconnect?: string
  ) {
    return this._service.connect(ctx, provider, reconnect);
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

  @Post('/posts')
  @HttpCode(200)
  create(@Mkt() ctx: MarketplaceContext, @Body() body: SocialPostDto) {
    return this._service.createPosts(ctx, this.input(ctx, body));
  }

  @Post('/posts/validate')
  @HttpCode(200)
  validate(@Mkt() ctx: MarketplaceContext, @Body() body: SocialPostDto) {
    return this._service.createPosts(ctx, { ...this.input(ctx, body), dryRun: true });
  }

  @Get('/posts')
  list(
    @Mkt() ctx: MarketplaceContext,
    @Query('from') from?: string,
    @Query('to') to?: string
  ) {
    return this._service.listPosts(ctx, from, to);
  }

  @Get('/posts/:id')
  get(@Mkt() ctx: MarketplaceContext, @Param('id') id: string) {
    return this._service.getPost(ctx, id);
  }

  @Delete('/posts/:id')
  @HttpCode(200)
  remove(@Mkt() ctx: MarketplaceContext, @Param('id') id: string) {
    return this._service.deletePost(ctx, id);
  }

  @Get('/slots/:channel_id')
  slot(@Mkt() ctx: MarketplaceContext, @Param('channel_id') channelId: string) {
    return this._service.slot(ctx, channelId);
  }

  @Get('/notifications')
  notifications(@Mkt() ctx: MarketplaceContext, @Query('page') page?: string) {
    return this._service.notifications(ctx, Number(page || 0));
  }

  @Get('/usage')
  usage(@Mkt() ctx: MarketplaceContext) {
    return this._service.usage(ctx);
  }

  private input(ctx: MarketplaceContext, body: SocialPostDto) {
    const items = body.content.map((c) => ({ text: c.text, mediaIds: c.media_ids || [] }));
    return {
      channels: body.channels.map((c) => ({ channelId: c.id, settings: c.settings, items })),
      when: this._service.when(ctx, body.schedule_at),
      linkPolicy: body.link_policy,
    };
  }
}
