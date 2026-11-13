import {
  IsBoolean, ValidateIf, IsIn, IsString, MaxLength, IsOptional, IsDefined, IsNumber, Min, Max, ValidateNested,
  Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments
} from 'class-validator';
import { Type } from 'class-transformer';
import { JSONSchema } from 'class-validator-jsonschema';

export class TikTokMusic {
  @IsDefined()
  @IsString()
  @JSONSchema({
    description:
      'The commercial music library track id, taken from the "id" returned by the musicSearch function.',
  })
  id: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  artist?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  audio_volume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  video_volume?: number;
}

export class TikTokLocation {
  @IsDefined()
  @IsString()
  @JSONSchema({
    description:
      'The location tag id, taken from the "id" returned by the locationSearch function.',
  })
  id: string;

  @IsDefined()
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  address?: string;
}

// TikTok only honors most of these settings on a DIRECT_POST. With
// content_posting_method=UPLOAD the media lands in the user's TikTok inbox as a
// draft, and TikTok's inbox/upload endpoints accept nothing but the title /
// description - every other field below is silently discarded.
// video_made_with_ai / duet / stitch are additionally video-only: TikTok's photo
// post_info has no is_aigc, disable_duet or disable_stitch field.
// music / location are TikTok Business only: the legacy TikTok provider ignores
// them (its Content Posting API has no music_sound_info / location fields).
// Fields stay required here (existing clients depend on it); the constraints are
// documented, not enforced.
const isDirectPost = (o: any) => o?.content_posting_method !== 'UPLOAD';

// TikTok Content Sharing Guidelines, commercial content disclosure: branded
// content can't be private.
@ValidatorConstraint({ name: 'tiktokBrandedNotPrivate', async: false })
class TiktokBrandedNotPrivate implements ValidatorConstraintInterface {
  validate(value: string, args: ValidationArguments) {
    const o: any = args.object;
    // A post saved before `disclose` existed still sends its brand toggle.
    return !(
      isDirectPost(o) &&
      o.disclose !== false &&
      o.brand_content_toggle &&
      value === 'SELF_ONLY'
    );
  }
  defaultMessage() {
    return 'Branded content visibility cannot be set to private ("Only me").';
  }
}

// With disclosure switched on, the creator has to say whose brand it is.
@ValidatorConstraint({ name: 'tiktokDiscloseNeedsChoice', async: false })
class TiktokDiscloseNeedsChoice implements ValidatorConstraintInterface {
  validate(value: boolean, args: ValidationArguments) {
    const o: any = args.object;
    return !(
      isDirectPost(o) &&
      value &&
      !o.brand_organic_toggle &&
      !o.brand_content_toggle
    );
  }
  defaultMessage() {
    return 'You need to indicate if your content promotes yourself, a third party, or both.';
  }
}

// The composer copies these from the creator's creator_info and the selected
// video, so a post TikTok would refuse is stopped before it is scheduled.
export const TIKTOK_UNAUDITED_PUBLIC_MESSAGE =
  "TikTok hasn't finished reviewing Hookpost yet, so it won't accept direct posts from a public TikTok account. Choose \"Upload content to TikTok without posting it\" to send this to your TikTok inbox and publish it from the TikTok app.";

@ValidatorConstraint({ name: 'tiktokCreatorCanPost', async: false })
class TiktokCreatorCanPost implements ValidatorConstraintInterface {
  validate(value: string) {
    return !value;
  }
  defaultMessage(args: ValidationArguments) {
    if (args.value === 'creator_info_unavailable') {
      return "Couldn't load your TikTok account details. Please try again.";
    }
    // Set by the composer while Hookpost is unaudited and the TikTok account
    // is public: TikTok refuses every direct post from it.
    if (args.value === 'unaudited_public_account') {
      return TIKTOK_UNAUDITED_PUBLIC_MESSAGE;
    }
    return 'TikTok says this account cannot post right now. Please try again later.';
  }
}

@ValidatorConstraint({ name: 'tiktokVideoDuration', async: false })
class TiktokVideoDuration implements ValidatorConstraintInterface {
  validate(value: number, args: ValidationArguments) {
    const o: any = args.object;
    return !(value && o.video_duration_sec && o.video_duration_sec > value);
  }
  defaultMessage(args: ValidationArguments) {
    return `This video is longer than the ${(args.object as any).max_video_duration_sec} seconds TikTok allows for this account.`;
  }
}

export class TikTokDto {
  @ValidateIf((p) => p.title)
  @MaxLength(90)
  @JSONSchema({
    description:
      'Used as the title of the post. The only setting TikTok keeps when content_posting_method=UPLOAD.',
  })
  title: string;

  // Only a direct post has a privacy level; on UPLOAD the field is hidden and
  // TikTok asks inside its own app, so it must not block the post.
  @ValidateIf((o) => isDirectPost(o))
  @IsIn(
    [
      'PUBLIC_TO_EVERYONE',
      'MUTUAL_FOLLOW_FRIENDS',
      'FOLLOWER_OF_CREATOR',
      'SELF_ONLY',
    ],
    { message: 'Choose who can see this post.' }
  )
  @Validate(TiktokBrandedNotPrivate)
  @IsString()
  @JSONSchema({
    description:
      'Applied only when content_posting_method=DIRECT_POST. Ignored by TikTok on UPLOAD.',
  })
  privacy_level:
    | 'PUBLIC_TO_EVERYONE'
    | 'MUTUAL_FOLLOW_FRIENDS'
    | 'FOLLOWER_OF_CREATOR'
    | 'SELF_ONLY';

  // Optional: photo posts have no Duet/Stitch, so the composer doesn't show or
  // send them; missing means not allowed.
  @IsBoolean()
  @IsOptional()
  @JSONSchema({
    description:
      'Video posts only, and only when content_posting_method=DIRECT_POST. TikTok has no duet setting for photo posts. Omitted means not allowed.',
  })
  duet?: boolean;

  @IsBoolean()
  @IsOptional()
  @JSONSchema({
    description:
      'Video posts only, and only when content_posting_method=DIRECT_POST. TikTok has no stitch setting for photo posts. Omitted means not allowed.',
  })
  stitch?: boolean;

  @IsBoolean()
  @JSONSchema({
    description:
      'Applied only when content_posting_method=DIRECT_POST. Ignored by TikTok on UPLOAD.',
  })
  comment: boolean;

  // Optional: video posts have no auto-add music, so the composer hides it for
  // them; missing means "no".
  @IsIn(['yes', 'no'])
  @IsOptional()
  @JSONSchema({
    description:
      'Photo posts only, and only when content_posting_method=DIRECT_POST. Ignored by TikTok on UPLOAD and for video posts. Omitted means "no". ' +
      'On TikTok Business, "yes" attaches a random commercial music library track and overrides the music setting; ' +
      'on legacy TikTok, "yes" lets TikTok auto-add its recommended music.',
  })
  autoAddMusic?: 'yes' | 'no';

  @IsBoolean()
  @JSONSchema({
    description:
      'Applied only when content_posting_method=DIRECT_POST. Ignored by TikTok on UPLOAD.',
  })
  brand_content_toggle: boolean;

  @IsBoolean()
  @IsOptional()
  @JSONSchema({
    description:
      'Labels the post as AI generated. Video posts only, and only when content_posting_method=DIRECT_POST. TikTok has no AI-generated label for photo posts, and discards it on UPLOAD.',
  })
  video_made_with_ai: boolean;

  @IsBoolean()
  @JSONSchema({
    description:
      'Applied only when content_posting_method=DIRECT_POST. Ignored by TikTok on UPLOAD.',
  })
  brand_organic_toggle: boolean;

  @Type(() => TikTokMusic)
  @ValidateNested()
  @IsOptional()
  @JSONSchema({
    description:
      'TikTok Business only, and only when content_posting_method=DIRECT_POST. Attaches a commercial music library track to the post (use the musicSearch function to find one). audio_volume / video_volume apply to video posts only. For photos, ignored when autoAddMusic is "yes" (a random track is attached instead).',
  })
  music?: TikTokMusic;

  @Type(() => TikTokLocation)
  @ValidateNested()
  @IsOptional()
  @JSONSchema({
    description:
      'TikTok Business only, and only when content_posting_method=DIRECT_POST. Tags the post with a location (use the locationSearch function to find one).',
  })
  location?: TikTokLocation;

  @IsBoolean()
  @IsOptional()
  @Validate(TiktokDiscloseNeedsChoice)
  @JSONSchema({
    description:
      'Commercial content disclosure. When true on a DIRECT_POST, brand_organic_toggle and/or brand_content_toggle must be true.',
  })
  disclose?: boolean;

  @IsString()
  @IsOptional()
  @Validate(TiktokCreatorCanPost)
  @JSONSchema({
    description:
      'Set by the composer from creator_info when TikTok says the creator cannot post right now. Omit it.',
  })
  creator_cannot_post?: string;

  @IsNumber()
  @IsOptional()
  @Validate(TiktokVideoDuration)
  @JSONSchema({
    description:
      "Set by the composer from creator_info: the longest video this creator may post, in seconds. Omit it.",
  })
  max_video_duration_sec?: number;

  @IsNumber()
  @IsOptional()
  @JSONSchema({
    description: 'Set by the composer: the selected video length in seconds. Omit it.',
  })
  video_duration_sec?: number;

  @IsIn(['DIRECT_POST', 'UPLOAD'])
  @IsString()
  @JSONSchema({
    description:
      'Required. Use "DIRECT_POST" to actually publish the post to TikTok. ' +
      '"UPLOAD" does NOT publish: it only sends the media to the user\'s TikTok app inbox, ' +
      'where they must manually finish and publish it within 24 hours or it is discarded, ' +
      'and it makes TikTok ignore every other setting here. ' +
      'Only use "UPLOAD" when the user explicitly asks to review or edit the post inside the TikTok app before publishing.',
  })
  content_posting_method: 'DIRECT_POST' | 'UPLOAD';
}
