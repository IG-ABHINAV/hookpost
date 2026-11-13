/**
 * The Social Post Validator: a draft checked against each network's rules,
 * with nothing connected and no call to any network. The rules are the ones
 * Hookpost's own providers apply before publishing (their maxLength and
 * checkValidity), written out as data; marketplace.validator.spec.ts fails
 * when a provider's rule changes and this table does not.
 */
import { countLength } from '@hookpost/helpers/utils/count.length';
import { hasLink, X_PREMIUM_LIMIT } from '@hookpost/nestjs-libraries/marketplace/marketplace.credits';
import {
  MARKETPLACE_MAX_IMAGE_BYTES,
  MARKETPLACE_MAX_VIDEO_BYTES,
} from '@hookpost/nestjs-libraries/marketplace/marketplace.plans';

export interface PlatformRule {
  platform: string;
  name: string;
  /** Characters at most (X: weighted, Threads: UTF-8 bytes). */
  maxChars: number;
  /** X Premium accounts. */
  premiumMaxChars?: number;
  /** How the text is counted. */
  counting: 'weighted' | 'utf8_bytes' | 'characters';
  /** Media items at least / at most (null: the network sets no limit we check). */
  minMedia: number;
  maxMedia: number | null;
  /** A video must be the only media item. */
  videoAlone: boolean;
  /** The one media item must be a video. */
  requiresVideo: boolean;
  /** Pinterest: a video needs a cover image (a second item, or a cover set on it). */
  videoNeedsCover: boolean;
  /** Pinterest: several images must share one size. */
  imagesSameSize: boolean;
}

const rule = (r: PlatformRule) => r;

export const PLATFORM_RULES: readonly PlatformRule[] = [
  rule({
    platform: 'x',
    name: 'X',
    maxChars: 280,
    premiumMaxChars: X_PREMIUM_LIMIT,
    counting: 'weighted',
    minMedia: 0,
    maxMedia: 4,
    videoAlone: true,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'linkedin',
    name: 'LinkedIn',
    maxChars: 3000,
    counting: 'characters',
    minMedia: 0,
    maxMedia: null,
    videoAlone: true,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'threads',
    name: 'Threads',
    maxChars: 500,
    counting: 'utf8_bytes',
    minMedia: 0,
    maxMedia: null,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'facebook',
    name: 'Facebook',
    maxChars: 63206,
    counting: 'characters',
    minMedia: 0,
    maxMedia: null,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'instagram',
    name: 'Instagram',
    maxChars: 2200,
    counting: 'characters',
    minMedia: 1,
    maxMedia: 10,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'youtube',
    name: 'YouTube',
    maxChars: 5000,
    counting: 'characters',
    minMedia: 1,
    maxMedia: 1,
    videoAlone: true,
    requiresVideo: true,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'pinterest',
    name: 'Pinterest',
    maxChars: 500,
    counting: 'characters',
    minMedia: 1,
    maxMedia: 5,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: true,
    imagesSameSize: true,
  }),
  rule({
    platform: 'tiktok',
    name: 'TikTok',
    maxChars: 2000,
    counting: 'characters',
    minMedia: 1,
    maxMedia: null,
    videoAlone: true,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'discord',
    name: 'Discord',
    maxChars: 1980,
    counting: 'characters',
    minMedia: 0,
    maxMedia: null,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'slack',
    name: 'Slack',
    maxChars: 3000,
    counting: 'characters',
    minMedia: 0,
    maxMedia: null,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'bluesky',
    name: 'Bluesky',
    maxChars: 300,
    counting: 'characters',
    minMedia: 0,
    maxMedia: 4,
    videoAlone: true,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
  rule({
    platform: 'mastodon',
    name: 'Mastodon',
    maxChars: 500,
    counting: 'characters',
    minMedia: 0,
    maxMedia: null,
    videoAlone: false,
    requiresVideo: false,
    videoNeedsCover: false,
    imagesSameSize: false,
  }),
];

export const VALIDATOR_PLATFORMS = PLATFORM_RULES.map((r) => r.platform);

/** At most this many platforms per check, and this many media items. */
export const VALIDATOR_MAX_PLATFORMS = PLATFORM_RULES.length;
export const VALIDATOR_MAX_MEDIA = 20;

export interface ValidatorMedia {
  type: 'image' | 'video';
  bytes?: number;
  width?: number;
  height?: number;
  duration_s?: number;
  /** A video with a cover image set on it (Pinterest). */
  has_cover?: boolean;
}

export interface ValidatorResult {
  platform: string;
  valid: boolean;
  chars: number;
  limit: number;
  errors: string[];
  warnings: string[];
}

export function ruleFor(platform: string): PlatformRule | undefined {
  return PLATFORM_RULES.find((r) => r.platform === platform);
}

/** The media errors of one platform (shared with the parity spec). */
export function mediaErrors(r: PlatformRule, media: ValidatorMedia[]): string[] {
  const errors: string[] = [];
  const videos = media.filter((m) => m.type === 'video');
  const images = media.filter((m) => m.type !== 'video');
  if (media.length < r.minMedia) {
    errors.push(
      r.minMedia === 1
        ? `${r.name} needs at least one image or video.`
        : `${r.name} needs at least ${r.minMedia} media items.`
    );
  }
  if (r.maxMedia !== null && media.length > r.maxMedia) {
    errors.push(`${r.name} takes up to ${r.maxMedia} media items; this has ${media.length}.`);
  }
  if (r.requiresVideo && media.length === 1 && !videos.length) {
    errors.push(`${r.name} needs a video.`);
  }
  if (r.videoAlone && videos.length && media.length > 1) {
    errors.push(`${r.name} takes one video on its own, without other media.`);
  }
  if (r.videoNeedsCover && videos.length) {
    if (media.length > 2) {
      errors.push(`${r.name} takes a video with at most one cover image.`);
    } else if (media.length === 1 && !videos[0].has_cover) {
      errors.push(`${r.name} needs a cover for a video: add a cover image as a second item.`);
    }
  }
  if (r.imagesSameSize && images.length > 1 && !videos.length) {
    const sized = images.filter((m) => m.width && m.height);
    if (
      sized.length === images.length &&
      sized.some((m) => m.width !== sized[0].width || m.height !== sized[0].height)
    ) {
      errors.push(`${r.name} needs every image to have the same width and height.`);
    }
  }
  for (const m of media) {
    if (m.type === 'image' && (m.bytes || 0) > MARKETPLACE_MAX_IMAGE_BYTES) {
      errors.push(`An image is over ${MARKETPLACE_MAX_IMAGE_BYTES / 1024 / 1024} MB, the upload limit.`);
      break;
    }
    if (m.type === 'video' && (m.bytes || 0) > MARKETPLACE_MAX_VIDEO_BYTES) {
      errors.push(`A video is over ${MARKETPLACE_MAX_VIDEO_BYTES / 1024 / 1024} MB, the upload limit.`);
      break;
    }
  }
  return errors;
}

/** One draft against each requested platform. */
export function validateDraft(input: {
  text: string;
  media?: ValidatorMedia[];
  platforms: string[];
  xPremium?: boolean;
}): ValidatorResult[] {
  const text = String(input.text ?? '');
  const media = input.media || [];
  return input.platforms.map((platform) => {
    const r = ruleFor(platform);
    if (!r) {
      return {
        platform,
        valid: false,
        chars: 0,
        limit: 0,
        errors: [`Unknown platform "${platform}". GET /rules lists them.`],
        warnings: [],
      };
    }
    const chars = countLength(platform, text);
    const limit = platform === 'x' && input.xPremium ? r.premiumMaxChars || r.maxChars : r.maxChars;
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!text.trim() && !media.length) {
      errors.push('A post needs text or at least one image or video.');
    }
    if (chars > limit) {
      errors.push(`${chars} ${r.counting === 'utf8_bytes' ? 'bytes' : 'characters'}; ${r.name} allows ${limit}.`);
    }
    errors.push(...mediaErrors(r, media));
    if (platform === 'instagram' && hasLink(text)) {
      warnings.push('Links in Instagram captions are not clickable.');
    }
    if (platform === 'x' && hasLink(text)) {
      warnings.push('X counts every link as 23 characters.');
    }
    return { platform, valid: !errors.length, chars, limit, errors, warnings };
  });
}
