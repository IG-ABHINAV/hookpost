import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { VALIDATOR_PLATFORMS } from '@hookpost/nestjs-libraries/marketplace/marketplace.validator';

const LINK_POLICIES = ['reject', 'allow'] as const;
const WHO_CAN_REPLY = ['everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'] as const;
/** Longest text any network takes (Facebook, 63,206), with room. */
const MAX_TEXT = 70_000;

// --- shared ------------------------------------------------------------------

export class MediaFromUrlDto {
  @IsUrl({ protocols: ['https', 'http'], require_protocol: true })
  @MaxLength(2048)
  url: string;
}

// --- 1. Social Scheduler -----------------------------------------------------

export class ChannelTargetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  id: string;

  /** The network's own settings (GET /providers lists each one's schema). */
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}

export class ContentItemDto {
  @IsString()
  @MaxLength(MAX_TEXT)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  media_ids?: string[];
}

export class SocialPostDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ChannelTargetDto)
  channels: ChannelTargetDto[];

  /** The post, then its thread replies (one X post each). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => ContentItemDto)
  content: ContentItemDto[];

  /** An ISO 8601 time with a zone, "now", or "draft". */
  @IsString()
  @MaxLength(40)
  schedule_at: string;

  @IsOptional()
  @IsIn(LINK_POLICIES)
  link_policy?: (typeof LINK_POLICIES)[number];
}

// --- 2. LinkedIn Carousel & Post --------------------------------------------

export class CarouselRenderDto {
  /** 2 to 20 image URLs or media ids, in page order. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  images: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  title?: string;

  @IsOptional()
  @IsIn(['square', 'portrait'])
  size?: 'square' | 'portrait';
}

export class LinkedInCarouselDto {
  @IsString()
  @MaxLength(64)
  channel_id: string;

  /** The document's title on LinkedIn. */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  /** 2 to 20 image URLs or media ids, in page order. */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  images: string[];

  @IsString()
  @MaxLength(3000)
  text: string;

  @IsString()
  @MaxLength(40)
  schedule_at: string;
}

export class LinkedInPostDto {
  @IsString()
  @MaxLength(64)
  channel_id: string;

  @IsString()
  @MaxLength(3000)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  media_ids?: string[];

  @IsString()
  @MaxLength(40)
  schedule_at: string;
}

// --- 3. X Threads ------------------------------------------------------------

export class TweetEstimateDto {
  @IsString()
  @MaxLength(10_000)
  text: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  media_count?: number;

  @IsOptional()
  @IsIn(['image', 'video'])
  media_type?: 'image' | 'video';
}

export class ThreadEstimateDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => TweetEstimateDto)
  tweets: TweetEstimateDto[];

  @IsOptional()
  @IsBoolean()
  premium?: boolean;

  @IsOptional()
  @IsIn(LINK_POLICIES)
  link_policy?: (typeof LINK_POLICIES)[number];
}

export class TweetDto {
  @IsString()
  @MaxLength(10_000)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsString({ each: true })
  media_ids?: string[];
}

export class ThreadDto {
  @IsString()
  @MaxLength(64)
  channel_id: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => TweetDto)
  tweets: TweetDto[];

  @IsString()
  @MaxLength(40)
  schedule_at: string;

  @IsOptional()
  @IsIn(WHO_CAN_REPLY)
  who_can_reply?: (typeof WHO_CAN_REPLY)[number];

  @IsOptional()
  @IsIn(LINK_POLICIES)
  link_policy?: (typeof LINK_POLICIES)[number];
}

// --- 4. Validator -------------------------------------------------------------

export class ValidatorMediaDto {
  @IsIn(['image', 'video'])
  type: 'image' | 'video';

  @IsOptional()
  @IsInt()
  @Min(0)
  bytes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  duration_s?: number;

  @IsOptional()
  @IsBoolean()
  has_cover?: boolean;
}

export class ValidatorCheckDto {
  @IsString()
  @MaxLength(MAX_TEXT)
  text: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ValidatorMediaDto)
  media?: ValidatorMediaDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(VALIDATOR_PLATFORMS.length)
  @IsIn(VALIDATOR_PLATFORMS, { each: true })
  platforms: string[];

  @IsOptional()
  @IsBoolean()
  x_premium?: boolean;
}
