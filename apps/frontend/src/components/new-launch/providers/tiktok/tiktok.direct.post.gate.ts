export const ALL_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
];

export type TikTokGateCreator =
  | {
      privacy_level_options?: string[];
      // Added by Hookpost: false until TikTok's Content Posting audit passes.
      hookpost_direct_post_audited?: boolean;
    }
  | null
  | undefined;

// Until TikTok audits Hookpost it only takes a direct post from a private
// account, as "Only me" (unaudited_client_can_only_post_to_private_accounts).
// creator_info offers "Everyone" only to a public account, so its presence
// means every direct post from this account would fail at publish time.
//
// allowedPrivacyLevels is exactly what creator_info returns for this account
// (a private account has no "Everyone"), narrowed to "Only me" while
// unaudited. TikTok Business has no creator_info and keeps every level.
//
// A backend that sends no hookpost_direct_post_audited (older deploy) leaves
// the composer as it was.
export const tiktokDirectPostGate = (
  creator: TikTokGateCreator,
  isBusiness: boolean,
  isUploadMode: boolean
) => {
  const unaudited =
    !isBusiness && creator?.hookpost_direct_post_audited === false;
  const publicAccount =
    !!creator?.privacy_level_options?.includes('PUBLIC_TO_EVERYONE');
  const fromCreator = creator?.privacy_level_options?.length
    ? creator.privacy_level_options
    : isBusiness
    ? ALL_PRIVACY_LEVELS
    : [];

  return {
    unaudited,
    unauditedPublic: unaudited && publicAccount && !isUploadMode,
    allowedPrivacyLevels: unaudited
      ? fromCreator.filter((level) => level === 'SELF_ONLY')
      : fromCreator,
  };
};
