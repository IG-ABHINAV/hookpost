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
import { MarketplaceContext, Mkt } from '@hookpost/backend/marketplace-api/marketplace.context';
import { MarketplaceInterceptor } from '@hookpost/backend/marketplace-api/marketplace.interceptor';
import { MarketplaceService } from '@hookpost/backend/marketplace-api/marketplace.service';
import {
  CarouselRenderDto,
  LinkedInCarouselDto,
  LinkedInPostDto,
  MediaFromUrlDto,
} from '@hookpost/backend/marketplace-api/marketplace.dto';
import { UPLOAD } from '@hookpost/backend/marketplace-api/routes/social.controller';

/**
 * 2. LinkedIn Carousel & Post API (docs/marketplace/linkedin-carousel.openapi.json).
 * POST /carousels/render needs no connected account. Personal profiles only:
 * posting as a LinkedIn Page waits on LinkedIn's Community Management review.
 */
@ApiExcludeController()
@Controller('/mkt/v1/linkedin')
@UseInterceptors(MarketplaceInterceptor)
export class MarketplaceLinkedInController {
  constructor(private _service: MarketplaceService) {}

  @Post('/carousels/render')
  @HttpCode(200)
  render(@Mkt() ctx: MarketplaceContext, @Body() body: CarouselRenderDto) {
    return this._service.renderCarousel(ctx, body);
  }

  @Post('/carousels')
  @HttpCode(200)
  async carousel(@Mkt() ctx: MarketplaceContext, @Body() body: LinkedInCarouselDto) {
    const when = this._service.when(ctx, body.schedule_at);
    const mediaIds = await this._service.carouselMediaIds(ctx, body.images);
    return this._service.createPosts(ctx, {
      channels: [{ channelId: body.channel_id, items: [{ text: body.text, mediaIds }] }],
      when,
      forcedSettings: { post_as_images_carousel: true, carousel_name: body.title },
    });
  }

  @Post('/posts')
  @HttpCode(200)
  post(@Mkt() ctx: MarketplaceContext, @Body() body: LinkedInPostDto) {
    return this._service.createPosts(ctx, {
      channels: [
        {
          channelId: body.channel_id,
          items: [{ text: body.text, mediaIds: body.media_ids || [] }],
        },
      ],
      when: this._service.when(ctx, body.schedule_at),
      forcedSettings: { post_as_images_carousel: false },
    });
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

  @Get('/connect')
  connect(@Mkt() ctx: MarketplaceContext, @Query('reconnect') reconnect?: string) {
    return this._service.connect(ctx, 'linkedin', reconnect);
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
