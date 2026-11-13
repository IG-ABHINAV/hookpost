import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TikTokDto, TIKTOK_UNAUDITED_PUBLIC_MESSAGE } from './tiktok.dto';

const base = {
  privacy_level: 'SELF_ONLY',
  duet: false,
  stitch: false,
  comment: false,
  autoAddMusic: 'no',
  brand_content_toggle: false,
  brand_organic_toggle: false,
  content_posting_method: 'DIRECT_POST',
};

const errorsFor = async (settings: Record<string, unknown>) => {
  const errors = await validate(plainToInstance(TikTokDto, settings) as object, {
    skipMissingProperties: false,
  });
  return errors.flatMap((e) => Object.values(e.constraints || {}));
};

describe('TikTokDto (TikTok Content Sharing Guidelines)', () => {
  it('accepts a direct post with a privacy level chosen', async () => {
    expect(await errorsFor(base)).toEqual([]);
  });

  it('refuses a direct post with no privacy level (no default allowed)', async () => {
    expect(await errorsFor({ ...base, privacy_level: '' })).toContain(
      'Choose who can see this post.'
    );
  });

  it('does not ask for a privacy level on an inbox upload', async () => {
    expect(
      await errorsFor({
        ...base,
        privacy_level: '',
        content_posting_method: 'UPLOAD',
      })
    ).toEqual([]);
  });

  it('refuses branded content that is private', async () => {
    expect(
      await errorsFor({ ...base, disclose: true, brand_content_toggle: true })
    ).toContain(
      'Branded content visibility cannot be set to private ("Only me").'
    );
    expect(
      await errorsFor({
        ...base,
        disclose: true,
        brand_content_toggle: true,
        privacy_level: 'FOLLOWER_OF_CREATOR',
      })
    ).toEqual([]);
  });

  it('refuses disclosure with neither "Your brand" nor "Branded content"', async () => {
    expect(await errorsFor({ ...base, disclose: true })).toContain(
      'You need to indicate if your content promotes yourself, a third party, or both.'
    );
    expect(
      await errorsFor({ ...base, disclose: true, brand_organic_toggle: true })
    ).toEqual([]);
  });

  it('refuses when creator_info says the creator cannot post', async () => {
    expect(
      await errorsFor({ ...base, creator_cannot_post: 'spam_risk_too_many_posts' })
    ).toContain(
      'TikTok says this account cannot post right now. Please try again later.'
    );
    expect(await errorsFor({ ...base, creator_cannot_post: '' })).toEqual([]);
  });

  it('accepts a photo post without duet/stitch', async () => {
    const { duet, stitch, ...photo } = base;
    expect(await errorsFor(photo)).toEqual([]);
  });

  it('accepts a video post without autoAddMusic (photo-only setting)', async () => {
    const { autoAddMusic, ...video } = base;
    expect(await errorsFor(video)).toEqual([]);
    expect(await errorsFor({ ...base, autoAddMusic: 'maybe' })).not.toEqual([]);
  });

  it('lets an old post with disclose off be private even if a brand toggle was stored', async () => {
    expect(
      await errorsFor({ ...base, disclose: false, brand_content_toggle: true })
    ).toEqual([]);
  });

  it('refuses a direct post from a public account while Hookpost is unaudited', async () => {
    expect(
      await errorsFor({ ...base, creator_cannot_post: 'unaudited_public_account' })
    ).toContain(TIKTOK_UNAUDITED_PUBLIC_MESSAGE);
  });

  it('explains when creator_info could not be loaded', async () => {
    expect(
      await errorsFor({ ...base, creator_cannot_post: 'creator_info_unavailable' })
    ).toContain("Couldn't load your TikTok account details. Please try again.");
  });

  it('refuses a video longer than max_video_post_duration_sec', async () => {
    expect(
      await errorsFor({
        ...base,
        max_video_duration_sec: 60,
        video_duration_sec: 61,
      })
    ).toContain(
      'This video is longer than the 60 seconds TikTok allows for this account.'
    );
    expect(
      await errorsFor({
        ...base,
        max_video_duration_sec: 600,
        video_duration_sec: 35,
      })
    ).toEqual([]);
  });
});
