'use client';

import {
  FC,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  PostComment,
  withProvider,
} from '@hookpost/frontend/components/new-launch/providers/high.order.provider';
import {
  TikTokDto,
  TIKTOK_UNAUDITED_PUBLIC_MESSAGE,
} from '@hookpost/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { useSettings } from '@hookpost/frontend/components/launches/helpers/use.values';
import { Select } from '@hookpost/react/form/select';
import { Checkbox } from '@hookpost/react/form/checkbox';
import clsx from 'clsx';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useIntegration } from '@hookpost/frontend/components/launches/helpers/use.integration';
import { Input } from '@hookpost/react/form/input';
import { TiktokPreview } from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.preview';
import { TikTokMusicSelector } from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.music';
import { TikTokLocationSelector } from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.location';
import { useCustomProviderFunction } from '@hookpost/frontend/components/launches/helpers/use.custom.provider.function';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import { tiktokDirectPostGate } from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.direct.post.gate';

// creator_info (TiktokProvider.creatorInfo). TikTok's Content Sharing
// Guidelines require the Post to TikTok screen to be rendered from it.
type CreatorInfo = {
  creator_nickname?: string;
  creator_username?: string;
  creator_avatar_url?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
  error_code?: string;
  error_message?: string;
  // Added by Hookpost: false until TikTok's Content Posting audit passes.
  hookpost_direct_post_audited?: boolean;
};

// 600 -> "10 min", 90 -> "1 min 30 sec", 3600 -> "1 hr".
const formatDuration = (seconds: number) => {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h} hr`, m && `${m} min`, s && `${s} sec`]
    .filter(Boolean)
    .join(' ');
};

export const TikTokSettings: FC<{
  values?: any;
}> = (props) => {
  const { watch, register, setValue, getValues } = useSettings();
  const setPublishBlocked = useLaunchStore((state) => state.setPublishBlocked);
  const { value, integration } = useIntegration();
  const customFunc = useCustomProviderFunction();
  const t = useT();

  // Music and location come from the Business API (v1.3) - the legacy Content
  // Posting API used by the "tiktok" identifier has no such fields.
  const isBusiness = integration?.identifier === 'tiktok-business';

  const isTitle = useMemo(() => {
    return value?.[0]?.image?.some((p) => (p?.path?.indexOf?.('mp4') ?? -1) === -1);
  }, [value]);

  const hasMedia = (value?.[0]?.image?.length ?? 0) > 0;
  const isVideo = hasMedia && !isTitle;

  const disclose = watch('disclose');
  const privacy_level = watch('privacy_level');
  const comment = watch('comment');
  const duet = watch('duet');
  const stitch = watch('stitch');
  const autoAddMusic = watch('autoAddMusic');
  const brand_organic_toggle = watch('brand_organic_toggle');
  const brand_content_toggle = watch('brand_content_toggle');
  const content_posting_method = watch('content_posting_method');
  const isUploadMode = content_posting_method === 'UPLOAD';

  // TikTok ignores every setting except the title / content when the posting
  // method is UPLOAD, so we hide them rather than pretend they apply. The fields
  // stay mounted and registered: their values must survive the switch, and
  // TikTokDto still requires most of them at save time.
  const directPostOnly = clsx(isUploadMode && 'invisible h-0 overflow-hidden');

  // Fetched fresh every time this screen opens (undefined = loading, null =
  // could not load). TikTok Business uses a different API without it.
  const [creator, setCreator] = useState<CreatorInfo | null | undefined>(
    isBusiness ? null : undefined
  );
  const [reloadCreator, setReloadCreator] = useState(0);
  useEffect(() => {
    if (isBusiness || !integration?.id) {
      setCreator(null);
      return;
    }
    let alive = true;
    setCreator(undefined);
    customFunc
      .get('creatorInfo')
      .then((data: any) => {
        if (alive) {
          setCreator(data && typeof data === 'object' ? data : null);
        }
      })
      .catch(() => alive && setCreator(null));
    return () => {
      alive = false;
    };
  }, [integration?.id, isBusiness, reloadCreator]);

  const cannotPost =
    !!creator?.error_code && creator.error_code !== 'ok' ? creator : undefined;
  // Without creator_info the screen can't be built the way TikTok requires,
  // so a direct post waits until it loads (TikTok Business doesn't use it).
  const creatorUnavailable =
    !isBusiness &&
    (creator === null ||
      (!!creator && !cannotPost && !creator.privacy_level_options?.length));

  // While TikTok hasn't audited Hookpost: privacy narrowed to "Only me", and
  // a direct post from a public account blocked (see tiktokDirectPostGate).
  const { unaudited, allowedPrivacyLevels } = useMemo(
    () => tiktokDirectPostGate(creator, isBusiness, false),
    [creator, isBusiness]
  );
  const { unauditedPublic } = tiktokDirectPostGate(
    creator,
    isBusiness,
    isUploadMode
  );

  // Length of the selected video, to check against max_video_post_duration_sec.
  const videoPath = isVideo ? value?.[0]?.image?.[0]?.path : undefined;
  const [videoDuration, setVideoDuration] = useState<number | undefined>();
  useEffect(() => {
    setVideoDuration(undefined);
    if (!videoPath) {
      return;
    }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      if (Number.isFinite(video.duration)) {
        setVideoDuration(Math.ceil(video.duration));
      }
    };
    video.src = videoPath;
    return () => {
      video.onloadedmetadata = null;
      video.removeAttribute('src');
    };
  }, [videoPath]);

  const maxDuration = creator?.max_video_post_duration_sec;
  const tooLong =
    !isUploadMode && !!maxDuration && !!videoDuration && videoDuration > maxDuration;

  // Copy what creator_info says into the settings so TikTokDto (on screen and
  // again on the server) refuses a post TikTok would reject.
  useEffect(() => {
    register('creator_cannot_post');
    register('max_video_duration_sec');
    register('video_duration_sec');
  }, []);
  useEffect(() => {
    setValue(
      'creator_cannot_post',
      isUploadMode
        ? ''
        : cannotPost?.error_code ||
            (creatorUnavailable ? 'creator_info_unavailable' : '') ||
            (unauditedPublic ? 'unaudited_public_account' : ''),
      { shouldValidate: true }
    );
    setValue(
      'max_video_duration_sec',
      !isUploadMode && maxDuration ? maxDuration : undefined,
      { shouldValidate: true }
    );
    setValue('video_duration_sec', videoDuration, { shouldValidate: true });
  }, [
    isUploadMode,
    cannotPost?.error_code,
    creatorUnavailable,
    unauditedPublic,
    maxDuration,
    videoDuration,
  ]);

  // A saved post keeps its privacy level only if this account still offers
  // it; the option list arrives after the first render, so write the value
  // back into the <select> once it exists (or clear it to force a choice).
  useEffect(() => {
    if (creator === undefined) {
      return;
    }
    const current = getValues('privacy_level');
    if (!current) {
      return;
    }
    setValue(
      'privacy_level',
      allowedPrivacyLevels.includes(current) ? current : '',
      { shouldValidate: true }
    );
  }, [creator, allowedPrivacyLevels]);

  // Switching disclosure off clears both choices, so nothing is labelled or
  // agreed to that the creator can no longer see. Switching it on brings the
  // two options into view: the settings pane shows roughly 440px of a form
  // twice that long. Only on the switch, so opening a post that already
  // discloses doesn't jump the pane.
  const discloseOptions = useRef<HTMLDivElement>(null);
  const previousDisclose = useRef(disclose);
  useEffect(() => {
    if (previousDisclose.current && !disclose) {
      if (brand_organic_toggle) {
        setValue('brand_organic_toggle', false, { shouldValidate: true });
      }
      if (brand_content_toggle) {
        setValue('brand_content_toggle', false, { shouldValidate: true });
      }
    }
    if (!previousDisclose.current && disclose) {
      discloseOptions.current?.scrollIntoView?.({ block: 'nearest' });
    }
    previousDisclose.current = disclose;
  }, [disclose]);

  // TikTok: the publish button stays disabled until these are resolved.
  const blockReason = isUploadMode
    ? ''
    : cannotPost
    ? t(
        'tiktok_cannot_post_now',
        'TikTok says this account cannot post right now. Please try again later.'
      )
    : creatorUnavailable
    ? t(
        'tiktok_creator_info_unavailable',
        "Couldn't load your TikTok account details. Please try again."
      )
    : unauditedPublic
    ? t('tiktok_unaudited_public', TIKTOK_UNAUDITED_PUBLIC_MESSAGE)
    : disclose && !brand_organic_toggle && !brand_content_toggle
    ? t(
        'tiktok_disclose_choose',
        'You need to indicate if your content promotes yourself, a third party, or both.'
      )
    : tooLong
    ? t('tiktok_video_too_long_short', 'This video is too long for this TikTok account.')
    : '';
  useEffect(() => {
    if (!integration?.id) {
      return;
    }
    setPublishBlocked(integration.id, blockReason);
    return () => setPublishBlocked(integration.id, '');
  }, [integration?.id, blockReason]);

  // An interaction the creator switched off in TikTok can't be turned on here.
  useEffect(() => {
    if (creator?.comment_disabled && comment) {
      setValue('comment', false, { shouldValidate: true });
    }
    if (creator?.duet_disabled && duet) {
      setValue('duet', false, { shouldValidate: true });
    }
    if (creator?.stitch_disabled && stitch) {
      setValue('stitch', false, { shouldValidate: true });
    }
  }, [creator, comment, duet, stitch]);

  const tiktokRestrictionNotice = useMemo(() => {
    if (!hasMedia || !isVideo) return null;
    if (!isUploadMode) {
      return t(
        'tiktok_restriction_direct_video',
        'TikTok restriction: For direct post with video, your post content is used as the title. A separate title field is not available.'
      );
    }
    // TikTok's inbox video upload has no caption field, and we add nothing of
    // our own (no hashtag) to the draft.
    return t(
      'tiktok_upload_video_no_caption',
      "TikTok doesn't take a caption for video drafts. You'll add your caption in the TikTok app before posting."
    );
  }, [hasMedia, isUploadMode, isVideo, t]);

  const privacyLabels: Record<string, string> = {
    PUBLIC_TO_EVERYONE: t('public_to_everyone', 'Everyone'),
    MUTUAL_FOLLOW_FRIENDS: t('mutual_follow_friends', 'Friends'),
    FOLLOWER_OF_CREATOR: t('follower_of_creator', 'Followers'),
    SELF_ONLY: t('self_only', 'Only me'),
  };
  const privacyLevel = allowedPrivacyLevels.map((level) => ({
    value: level,
    label: privacyLabels[level] || level,
  }));
  const contentPostingMethod = [
    {
      value: 'DIRECT_POST',
      label: t(
        'post_content_directly_to_tiktok',
        'Post content directly to TikTok'
      ),
    },
    {
      value: 'UPLOAD',
      label: t(
        'upload_content_to_tiktok_without_posting',
        'Upload content to TikTok without posting it'
      ),
    },
  ];
  const yesNo = [
    {
      value: 'yes',
      label: t('yes', 'Yes'),
    },
    {
      value: 'no',
      label: t('no', 'No'),
    },
  ];

  return (
    <div className="flex flex-col">
      {!!creator?.creator_nickname && (
        <div className="flex items-center gap-[10px] mb-[18px] text-[14px]">
          {!!creator.creator_avatar_url && (
            <img
              src={creator.creator_avatar_url}
              alt=""
              className="w-[32px] h-[32px] rounded-full"
            />
          )}
          <div>
            {t('tiktok_posting_to', 'Posting to TikTok as')}{' '}
            <b>{creator.creator_nickname}</b>
            {!!creator.creator_username && ` (@${creator.creator_username})`}
          </div>
        </div>
      )}
      {!isUploadMode && !!cannotPost && (
        <div className="text-red-600 text-[14px] mb-[18px] text-balance">
          {t(
            'tiktok_cannot_post_now',
            'TikTok says this account cannot post right now. Please try again later.'
          )}
          {!!cannotPost.error_message && ` (${cannotPost.error_message})`}
        </div>
      )}
      {!isUploadMode && creatorUnavailable && (
        <div className="text-red-600 text-[14px] mb-[18px] text-balance">
          {t(
            'tiktok_creator_info_unavailable',
            "Couldn't load your TikTok account details. Please try again."
          )}{' '}
          <span
            className="underline cursor-pointer"
            onClick={() => setReloadCreator((n) => n + 1)}
          >
            {t('retry', 'Retry')}
          </span>
        </div>
      )}
      {!isUploadMode && unaudited && !cannotPost && (
        <div
          className={clsx(
            'text-[14px] mb-[18px] text-balance',
            unauditedPublic && 'text-red-600'
          )}
        >
          {unauditedPublic
            ? t('tiktok_unaudited_public', TIKTOK_UNAUDITED_PUBLIC_MESSAGE)
            : t(
                'tiktok_unaudited_private',
                'TikTok hasn\'t finished reviewing Hookpost yet, so a direct post can only be seen by you ("Only me"). To post publicly, send it to your TikTok inbox and publish it from the TikTok app.'
              )}{' '}
          <span
            className="underline cursor-pointer"
            onClick={() =>
              setValue('content_posting_method', 'UPLOAD', {
                shouldValidate: true,
              })
            }
          >
            {t('tiktok_send_to_inbox_instead', 'Send to my TikTok inbox instead')}
          </span>
        </div>
      )}
      {tooLong && (
        <div className="text-red-600 text-[14px] mb-[18px] text-balance">
          {t('tiktok_video_too_long', {
            defaultValue:
              'This video is {{duration}} seconds long. TikTok allows up to {{max}} seconds for this account.',
            duration: videoDuration,
            max: maxDuration,
          })}
        </div>
      )}
      {/*<CheckTikTokValidity picture={props?.values?.[0]?.image?.[0]?.path} />*/}
      {tiktokRestrictionNotice && (
        <div className="bg-tableBorder p-[10px] mb-[18px] rounded-[10px] flex gap-[10px] items-start text-[13px] text-balance">
          <div className="shrink-0 mt-[2px]">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M22.201 17.6335L14.0026 3.39569C13.7977 3.04687 13.5052 2.75764 13.1541 2.55668C12.803 2.35572 12.4055 2.25 12.001 2.25C11.5965 2.25 11.199 2.35572 10.8479 2.55668C10.4968 2.75764 10.2043 3.04687 9.99944 3.39569L1.80101 17.6335C1.60388 17.9709 1.5 18.3546 1.5 18.7454C1.5 19.1361 1.60388 19.5199 1.80101 19.8572C2.00325 20.2082 2.29523 20.499 2.64697 20.6998C2.99871 20.9006 3.39755 21.0043 3.80257 21.0001H20.1994C20.6041 21.0039 21.0026 20.9001 21.354 20.6993C21.7054 20.4985 21.997 20.2079 22.1991 19.8572C22.3965 19.52 22.5007 19.1364 22.5011 18.7456C22.5014 18.3549 22.3978 17.9711 22.201 17.6335ZM11.251 9.75006C11.251 9.55115 11.33 9.36038 11.4707 9.21973C11.6113 9.07908 11.8021 9.00006 12.001 9.00006C12.1999 9.00006 12.3907 9.07908 12.5313 9.21973C12.672 9.36038 12.751 9.55115 12.751 9.75006V13.5001C12.751 13.699 12.672 13.8897 12.5313 14.0304C12.3907 14.171 12.1999 14.2501 12.001 14.2501C11.8021 14.2501 11.6113 14.171 11.4707 14.0304C11.33 13.8897 11.251 13.699 11.251 13.5001V9.75006ZM12.001 18.0001C11.7785 18.0001 11.561 17.9341 11.376 17.8105C11.191 17.6868 11.0468 17.5111 10.9616 17.3056C10.8765 17.1 10.8542 16.8738 10.8976 16.6556C10.941 16.4374 11.0482 16.2369 11.2055 16.0796C11.3628 15.9222 11.5633 15.8151 11.7815 15.7717C11.9998 15.7283 12.226 15.7505 12.4315 15.8357C12.6371 15.9208 12.8128 16.065 12.9364 16.25C13.06 16.4351 13.126 16.6526 13.126 16.8751C13.126 17.1734 13.0075 17.4596 12.7965 17.6706C12.5855 17.8815 12.2994 18.0001 12.001 18.0001Z"
                fill="currentColor"
              />
            </svg>
          </div>
          <div>{tiktokRestrictionNotice}</div>
        </div>
      )}
      {isTitle && <Input label="Title" {...register('title')} maxLength={89} />}
      <div className={directPostOnly}>
        <Select
          label={t('label_who_can_see_this_video', 'Who can see this video?')}
          disabled={isUploadMode}
          {...register(
            'privacy_level',
            // TikTok Business videos publish with the account default.
            isBusiness ? { value: 'PUBLIC_TO_EVERYONE' } : undefined
          )}
        >
          <option value="">
            {creator === undefined
              ? t('loading', 'Loading...')
              : t('select', 'Select')}
          </option>
          {privacyLevel.map((item) => {
            const blocked =
              item.value === 'SELF_ONLY' && !!disclose && !!brand_content_toggle;
            return (
              <option key={item.value} value={item.value} disabled={blocked}>
                {item.label}
                {blocked
                  ? ` (${t(
                      'tiktok_branded_not_private',
                      'Branded content visibility cannot be set to private.'
                    )})`
                  : ''}
              </option>
            );
          })}
        </Select>
        {/* From creator_info; photo posts have no length limit. */}
        {!isTitle && !!maxDuration && (
          <div className="text-[14px] mt-[4px]">
            {t('tiktok_max_video_length', {
              defaultValue: 'Max video length for this account: {{duration}}',
              duration: formatDuration(maxDuration),
            })}
          </div>
        )}
      </div>
      <div className="text-[14px] mt-[10px] mb-[18px] text-balance">
        {t(
          'choose_upload_without_posting_description',
          `Choose upload without posting if you want to review and edit your content within TikTok's app before publishing.
        This gives you access to TikTok's built-in editing tools and lets you make final adjustments before posting. The additional settings are only available when posting directly to TikTok.`
        )}
      </div>
      <Select
        label={t('label_content_posting_method', 'Content posting method')}
        {...register('content_posting_method', {
          value: 'DIRECT_POST',
        })}
      >
        <option value="">{t('select', 'Select')}</option>
        {contentPostingMethod.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </Select>
      {isUploadMode && <div className="-mt-[23px] mb-[23px] text-red-600">After posting, you will find a notification about your post in your TikTok inbox.</div>}
      <div className={clsx('flex flex-col', directPostOnly)}>
        {/* Photo posts only. Hidden (not unmounted) for a video so it keeps
            its "no" and survives switching the media back to photos. */}
        <div
          className={clsx(
            'flex flex-col',
            isVideo && 'invisible h-0 overflow-hidden'
          )}
        >
          <Select
            label={
              isBusiness
                ? t('label_add_random_music', 'Add random music')
                : t('label_auto_add_music', 'Auto add music')
            }
            disabled={isUploadMode}
            {...register('autoAddMusic', {
              value: 'no',
            })}
          >
            <option value="">{t('select', 'Select')}</option>
            {yesNo.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
          <div className="text-[14px] mt-[10px] mb-[24px] text-balance">
            {isBusiness
              ? t(
                  'tiktok_random_music_only_for_photos',
                  'This feature is available only for photos, it adds a random trending track from TikTok\'s commercial music library.'
                )
              : t(
                  'this_feature_available_only_for_photos',
                  'This feature available only for photos, it will add a default music that\n        you can change later.'
                )}
          </div>
        </div>
        {isBusiness && (
          <div className="flex flex-col gap-[18px] mb-[24px]">
            {/* Random music replaces a manual choice for photos, so the
                selector is hidden (but stays registered) while it's on. */}
            <div
              className={clsx(
                !isVideo &&
                  autoAddMusic === 'yes' &&
                  'invisible h-0 overflow-hidden'
              )}
            >
              <TikTokMusicSelector
                label={t('tiktok_music_label', 'Music')}
                showVolumes={isVideo}
                {...register('music')}
              />
            </div>
            <TikTokLocationSelector
              label={t('tiktok_location_label', 'Location')}
              {...register('location')}
            />
          </div>
        )}
        <hr className="mb-[15px] border-tableBorder" />
        {!isTitle && (
          <div className="text-[14px] mb-[10px]">
            {t('tiktok_video_features', 'Video features')}
          </div>
        )}
        <div className="flex gap-[40px]">
          {/* TikTok has no Duet or Stitch for photo posts. */}
          {!isTitle && (
            <>
              <Checkbox
                variant="hollow"
                label={t('label_duet', 'Allow Duet')}
                disabled={isUploadMode || !!creator?.duet_disabled}
                title={
                  creator?.duet_disabled
                    ? t('tiktok_duet_off', 'Duet is turned off in your TikTok settings.')
                    : undefined
                }
                {...register('duet', {
                  value: false,
                })}
              />
              <Checkbox
                label={t('label_stitch', 'Allow Stitch')}
                variant="hollow"
                disabled={isUploadMode || !!creator?.stitch_disabled}
                title={
                  creator?.stitch_disabled
                    ? t('tiktok_stitch_off', 'Stitch is turned off in your TikTok settings.')
                    : undefined
                }
                {...register('stitch', {
                  value: false,
                })}
              />
            </>
          )}
          {!isTitle && (
            <Checkbox
              label={t('video_made_with_ai', 'Video made with AI')}
              variant="hollow"
              disabled={isUploadMode}
              {...register('video_made_with_ai', {
                value: false,
              })}
            />
          )}
        </div>
        <hr className="my-[15px] mb-[25px] border-tableBorder" />
        <div className="flex flex-col gap-[20px]">
          <Checkbox
            label={t('label_comments', 'Allow Comments')}
            variant="hollow"
            disabled={isUploadMode || !!creator?.comment_disabled}
            title={
              creator?.comment_disabled
                ? t('tiktok_comment_off', 'Comments are turned off in your TikTok settings.')
                : undefined
            }
            {...register('comment', {
              value: false,
            })}
          />
          {/* TikTok's Required UX Implementation puts "Your brand" and
              "Branded content" directly under the disclosure toggle. They used
              to sit after the label notice and the explanation, ~200px further
              down a pane that shows about 440px and does not scroll on its own,
              so ticking the toggle revealed the notice and nothing else.
              Hidden rather than unmounted: TikTokDto requires both booleans,
              and an unmounted field saves as undefined. */}
          <div>
            <Checkbox
              variant="hollow"
              label={t('label_disclose_video_content', 'Disclose Video Content')}
              disabled={isUploadMode}
              {...register('disclose', {
                value: false,
              })}
            />
            <div
              ref={discloseOptions}
              className={
                !disclose ? 'invisible h-0 overflow-hidden' : 'mt-[20px]'
              }
            >
              <Checkbox
                variant="hollow"
                label={t('label_your_brand', 'Your brand')}
                disabled={isUploadMode || !disclose}
                {...register('brand_organic_toggle', {
                  value: false,
                })}
              />
              <div className="text-balance my-[10px] text-[14px]">
                {t(
                  'you_are_promoting_yourself',
                  'You are promoting yourself or your own brand.'
                )}
                <br />
                {t(
                  'this_video_will_be_classified_brand_organic',
                  'This video will be classified as Brand Organic.'
                )}
              </div>
              <Checkbox
                variant="hollow"
                label={t('label_branded_content', 'Branded content')}
                disabled={
                  isUploadMode || !disclose || privacy_level === 'SELF_ONLY'
                }
                title={
                  privacy_level === 'SELF_ONLY'
                    ? t(
                        'tiktok_branded_not_private',
                        'Branded content visibility cannot be set to private.'
                      )
                    : undefined
                }
                {...register('brand_content_toggle', {
                  value: false,
                })}
              />
              <div className="text-balance my-[10px] text-[14px]">
                {t(
                  'you_are_promoting_another_brand',
                  'You are promoting another brand or a third party.'
                )}
                <br />
                {t(
                  'this_video_will_be_classified_branded_content',
                  'This video will be classified as Branded Content.'
                )}
              </div>
            </div>
          </div>
          {disclose && (
            <div className="bg-tableBorder p-[10px] mt-[10px] rounded-[10px] flex gap-[20px] items-center">
              <div>
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    d="M22.201 17.6335L14.0026 3.39569C13.7977 3.04687 13.5052 2.75764 13.1541 2.55668C12.803 2.35572 12.4055 2.25 12.001 2.25C11.5965 2.25 11.199 2.35572 10.8479 2.55668C10.4968 2.75764 10.2043 3.04687 9.99944 3.39569L1.80101 17.6335C1.60388 17.9709 1.5 18.3546 1.5 18.7454C1.5 19.1361 1.60388 19.5199 1.80101 19.8572C2.00325 20.2082 2.29523 20.499 2.64697 20.6998C2.99871 20.9006 3.39755 21.0043 3.80257 21.0001H20.1994C20.6041 21.0039 21.0026 20.9001 21.354 20.6993C21.7054 20.4985 21.997 20.2079 22.1991 19.8572C22.3965 19.52 22.5007 19.1364 22.5011 18.7456C22.5014 18.3549 22.3978 17.9711 22.201 17.6335ZM11.251 9.75006C11.251 9.55115 11.33 9.36038 11.4707 9.21973C11.6113 9.07908 11.8021 9.00006 12.001 9.00006C12.1999 9.00006 12.3907 9.07908 12.5313 9.21973C12.672 9.36038 12.751 9.55115 12.751 9.75006V13.5001C12.751 13.699 12.672 13.8897 12.5313 14.0304C12.3907 14.171 12.1999 14.2501 12.001 14.2501C11.8021 14.2501 11.6113 14.171 11.4707 14.0304C11.33 13.8897 11.251 13.699 11.251 13.5001V9.75006ZM12.001 18.0001C11.7785 18.0001 11.561 17.9341 11.376 17.8105C11.191 17.6868 11.0468 17.5111 10.9616 17.3056C10.8765 17.1 10.8542 16.8738 10.8976 16.6556C10.941 16.4374 11.0482 16.2369 11.2055 16.0796C11.3628 15.9222 11.5633 15.8151 11.7815 15.7717C11.9998 15.7283 12.226 15.7505 12.4315 15.8357C12.6371 15.9208 12.8128 16.065 12.9364 16.25C13.06 16.4351 13.126 16.6526 13.126 16.8751C13.126 17.1734 13.0075 17.4596 12.7965 17.6706C12.5855 17.8815 12.2994 18.0001 12.001 18.0001Z"
                    fill="white"
                  />
                </svg>
              </div>
              <div>
                {brand_content_toggle
                  ? isTitle
                    ? t('tiktok_photo_paid_partnership', 'Your photo/video will be labeled as "Paid partnership".')
                    : t('tiktok_video_paid_partnership', 'Your video will be labeled as "Paid partnership".')
                  : brand_organic_toggle
                  ? isTitle
                    ? t('tiktok_photo_promotional', 'Your photo/video will be labeled as "Promotional content".')
                    : t('tiktok_video_promotional', 'Your video will be labeled as "Promotional content".')
                  : t(
                      'tiktok_disclose_choose',
                      'You need to indicate if your content promotes yourself, a third party, or both.'
                    )}
                <br />
                {t(
                  'this_cannot_be_changed_once_posted',
                  'This cannot be changed once your video is posted.'
                )}
              </div>
            </div>
          )}
          <div className="text-[14px] my-[10px] text-balance">
            {t(
              'turn_on_to_disclose_video_promotes',
              'Turn on to disclose that this video promotes goods or services in\n          exchange for something of value. Your video could promote yourself, a\n          third party, or both.'
            )}
          </div>
        </div>
        {/* Required consent declaration, right before posting. */}
        <div className="mt-[20px] text-[14px] text-balance">
          {t('by_posting_you_agree_to_tiktoks', "By posting, you agree to TikTok's")}{' '}
          {disclose && brand_content_toggle && (
            <>
              <a
                target="_blank"
                rel="noreferrer"
                className="text-hp-primary-text hover:underline"
                href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              >
                {t('branded_content_policy', 'Branded Content Policy')}
              </a>{' '}
              {t('and', 'and')}{' '}
            </>
          )}
          <a
            target="_blank"
            rel="noreferrer"
            className="text-hp-primary-text hover:underline"
            href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
          >
            {t('music_usage_confirmation', 'Music Usage Confirmation')}
          </a>
          .
        </div>
      </div>
      <div className="mt-[14px] text-[14px] text-balance">
        {t(
          'tiktok_processing_notice',
          'After you publish, it may take a few minutes for TikTok to process your post and show it on your profile.'
        )}
      </div>
    </div>
  );
};
export default withProvider({
  postComment: PostComment.COMMENT,
  minimumCharacters: [],
  SettingsComponent: TikTokSettings,
  comments: false,
  CustomPreviewComponent: TiktokPreview,
  dto: TikTokDto,
  maximumCharacters: 2000,
});
