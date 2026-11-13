import {
  ArrayMaxSize,
  IsArray,
  IsDefined,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MediaDto } from '@hookpost/nestjs-libraries/dtos/media/media.dto';
import { Type } from 'class-transformer';
import { DevToTagsSettingsDto } from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/dev.to.tags.settings.dto';

export class DevToSettingsDto {
  @IsString()
  @MinLength(2)
  @IsDefined()
  // Dev.to rejects a title over 128 characters, not counting whitespace
  // ("Title is too long (maximum is 128 characters for full_post)"), and
  // only when the scheduled post is published - say so in the composer.
  @Matches(/^\s*(?:\S\s*){1,128}$/, {
    message:
      'Dev.to titles can have at most 128 characters (spaces not counted)',
  })
  title: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => MediaDto)
  main_image?: MediaDto;

  @IsOptional()
  @IsString()
  @ValidateIf((o) => o.canonical && o.canonical.indexOf('(post:') === -1)
  @Matches(
    /^(|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})$/,
    {
      message: 'Invalid URL',
    }
  )
  canonical?: string;

  @IsString()
  @IsOptional()
  organization?: string;

  @IsArray()
  @ArrayMaxSize(4)
  @Type(() => DevToTagsSettingsDto)
  @ValidateNested({ each: true })
  tags: DevToTagsSettingsDto[] = [];
}
