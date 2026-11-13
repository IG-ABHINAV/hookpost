import {
  ArrayMinSize,
  IsDefined,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LemmySettingsDtoInner {
  @IsString()
  @MinLength(2)
  @IsDefined()
  subreddit: string;

  @IsString()
  @IsDefined()
  id: string;

  // Lemmy's own rule: 3 to 200 characters, on one line.
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  @IsDefined()
  title: string;

  @ValidateIf((o) => o.url)
  @IsOptional()
  @IsUrl()
  url: string;
}

export class LemmySettingsValueDto {
  @Type(() => LemmySettingsDtoInner)
  @IsDefined()
  @ValidateNested()
  value: LemmySettingsDtoInner;
}

export class LemmySettingsDto {
  @Type(() => LemmySettingsValueDto)
  @ValidateNested({ each: true })
  @ArrayMinSize(1)
  subreddit: LemmySettingsValueDto[];
}
