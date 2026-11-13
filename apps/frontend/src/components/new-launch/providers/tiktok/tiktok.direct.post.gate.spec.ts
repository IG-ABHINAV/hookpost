/**
 * What the TikTok composer offers while TikTok hasn't audited Hookpost's
 * Content Posting API use: direct posts only as "Only me", and none at all
 * from a public account (TikTok refuses them with
 * unaudited_client_can_only_post_to_private_accounts).
 *   pnpm exec jest -c apps/frontend/jest.config.ts tiktok.direct.post.gate
 */
import {
  ALL_PRIVACY_LEVELS,
  tiktokDirectPostGate,
} from '@hookpost/frontend/components/new-launch/providers/tiktok/tiktok.direct.post.gate';

const publicAccount = {
  privacy_level_options: ['PUBLIC_TO_EVERYONE', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
};
const privateAccount = {
  privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
};

describe('tiktokDirectPostGate while unaudited', () => {
  it('blocks a direct post from a public account and offers only "Only me"', () => {
    expect(
      tiktokDirectPostGate(
        { ...publicAccount, hookpost_direct_post_audited: false },
        false,
        false
      )
    ).toEqual({
      unaudited: true,
      unauditedPublic: true,
      allowedPrivacyLevels: ['SELF_ONLY'],
    });
  });

  it('lets a public account send to its TikTok inbox instead', () => {
    expect(
      tiktokDirectPostGate(
        { ...publicAccount, hookpost_direct_post_audited: false },
        false,
        true
      ).unauditedPublic
    ).toBe(false);
  });

  it('lets a private account post as "Only me"', () => {
    expect(
      tiktokDirectPostGate(
        { ...privateAccount, hookpost_direct_post_audited: false },
        false,
        false
      )
    ).toEqual({
      unaudited: true,
      unauditedPublic: false,
      allowedPrivacyLevels: ['SELF_ONLY'],
    });
  });
});

describe('tiktokDirectPostGate otherwise', () => {
  it('offers what creator_info returns once audited', () => {
    expect(
      tiktokDirectPostGate(
        { ...publicAccount, hookpost_direct_post_audited: true },
        false,
        false
      )
    ).toEqual({
      unaudited: false,
      unauditedPublic: false,
      allowedPrivacyLevels: publicAccount.privacy_level_options,
    });
  });

  it('behaves as before against a backend that does not send the flag', () => {
    expect(tiktokDirectPostGate(publicAccount, false, false)).toEqual({
      unaudited: false,
      unauditedPublic: false,
      allowedPrivacyLevels: publicAccount.privacy_level_options,
    });
  });

  it('leaves TikTok Business alone (no creator_info)', () => {
    expect(tiktokDirectPostGate(null, true, false)).toEqual({
      unaudited: false,
      unauditedPublic: false,
      allowedPrivacyLevels: ALL_PRIVACY_LEVELS,
    });
  });

  it('offers nothing while creator_info is loading or failed', () => {
    expect(tiktokDirectPostGate(undefined, false, false).allowedPrivacyLevels).toEqual([]);
    expect(tiktokDirectPostGate(null, false, false).allowedPrivacyLevels).toEqual([]);
  });
});
