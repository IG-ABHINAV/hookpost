/**
 * Channels people look for that cannot be connected yet. Each shows in Add
 * Channel as a greyed tile with a "Soon" badge, right after the channel it is
 * mistaken for, while its provider is hidden (HIDDEN_PROVIDERS on the
 * backend). Tapping it says why, like the other unavailable tiles. The day the
 * provider is unhidden, its real tile replaces this one.
 *
 * LinkedIn Pages wait on LinkedIn's Community Management review. Without the
 * tile, "LinkedIn" was the only LinkedIn choice, and brands connected their
 * personal profile and then removed it.
 */
/**
 * Channels a new account cannot use yet, with the reason shown instead of
 * starting an OAuth flow that is guaranteed to fail. Platform admins and
 * @hookstep.in accounts can still connect them. Keep in step with
 * app/(landing)/channels/channel-specs.ts; delete an entry the day it opens.
 *
 * Instagram (Standalone) signs in with Instagram Login, whose
 * instagram_business_* permissions never went through Meta App Review (the 9
 * Oct approval covered the Facebook-login set that "Instagram (Facebook
 * Business)" uses). Outside the app's roles it ends on Instagram's
 * "Insufficient developer role" page, which has no way back: two outsiders
 * started it (13 and 21 Oct) and neither came back. The empty Facebook /
 * Instagram page picker offers it too (meta.no.pages.help.tsx) under this
 * same rule; before deleting the entry, check the backend no longer lists it
 * in HIDDEN_PROVIDERS, since that button does not read the provider list.
 */
export const NOT_AVAILABLE_YET: Readonly<Record<string, string>> = {
  // Medium is not here: it can never open (no new integration tokens), so the
  // backend leaves it out of Add Channel altogether (RETIRED_PROVIDERS in
  // integration.manager.ts) instead of showing a greyed tile.
  'instagram-standalone':
    'Instagram (no Facebook Page needed) is waiting on Meta\'s approval. Use "Instagram via Facebook Page": it connects a Business or Creator account linked to a Facebook Page.',
};

/**
 * Add Channel tile names that say what each Instagram option needs. Four of
 * the 10 people who tried a channel from 25 Oct to 8 Nov picked the
 * Facebook-login Instagram, got 0 Pages and left: its old name, "Instagram
 * (Facebook Business)", never said a linked Facebook Page is required.
 * Every other tile keeps the provider's own name.
 */
export const ADD_CHANNEL_LABELS: Readonly<Record<string, string>> = {
  'instagram-standalone': 'Instagram\n(no Facebook Page needed)',
  instagram: 'Instagram via Facebook Page\n(Business account + linked Page)',
};

export const addChannelLabel = (item: { identifier: string; name: string }) =>
  ADD_CHANNEL_LABELS[item.identifier] ?? item.name;

/**
 * The Add Channel tiles in order: the ones this viewer can connect first, the
 * unavailable ones last (order otherwise kept), and, when it is open to the
 * viewer, Instagram without a Page right before the Facebook-login Instagram,
 * so it is the Instagram option people meet first. While it waits on Meta it
 * stays at the end with the other unavailable tiles.
 */
export const orderAddChannelTiles = <T extends { identifier: string }>(
  items: ReadonlyArray<T>,
  canUseBlocked: boolean
): T[] => {
  const blocked = (item: T) => !!blockedReason(item.identifier, canUseBlocked);
  const out = [...items].sort((a, b) => Number(blocked(a)) - Number(blocked(b)));
  const direct = out.findIndex((i) => i.identifier === 'instagram-standalone');
  const viaPage = out.findIndex((i) => i.identifier === 'instagram');
  if (direct > viaPage && viaPage >= 0 && !blocked(out[direct])) {
    const [tile] = out.splice(direct, 1);
    out.splice(viaPage, 0, tile);
  }
  return out;
};

/** Platform admins, and our own @hookstep.in accounts (Meta's reviewer logs in as one). */
export const canUseBlockedChannels = (
  user?: { admin?: boolean; email?: string | null } | null
) => !!user?.admin || /@hookstep\.in$/i.test(String(user?.email || '').trim());

/**
 * A channel that connects through the Hookpost Chrome extension (Skool), while
 * this deployment has no EXTENSION_ID to reach it. Its tile led to an
 * "Extension Not Found" dialog with nothing to install, so it is not offered
 * until the extension is published and EXTENSION_ID is set.
 */
export const needsMissingExtension = (
  item: { isChromeExtension?: boolean },
  extensionId: string | undefined
) => !!item.isChromeExtension && !extensionId;

/** Why this tile cannot be connected by this user, or null when it can. */
export const blockedReason = (
  identifier: string,
  canUseBlocked: boolean
): string | null =>
  (!canUseBlocked && NOT_AVAILABLE_YET[identifier]) || null;

export interface ComingSoonTile {
  identifier: string;
  name: string;
  /** The tile it sits after, e.g. the personal-profile LinkedIn. */
  after: string;
  /** The toast when it is tapped. */
  reason: string;
}

export const COMING_SOON_PROVIDERS: ReadonlyArray<ComingSoonTile> = [
  {
    identifier: 'linkedin-page',
    name: 'LinkedIn Page',
    after: 'linkedin',
    reason:
      "LinkedIn Pages are waiting on LinkedIn's approval. You can connect your personal profile now.",
  },
];

export const comingSoonTiles = (
  available: ReadonlyArray<{ identifier: string }>,
  invite: boolean
) =>
  // An invite link is for a channel someone can connect now.
  invite
    ? []
    : COMING_SOON_PROVIDERS.filter(
        (soon) => !available.some((p) => p.identifier === soon.identifier)
      );

export type ChannelTile<T> =
  | { kind: 'live'; item: T }
  | { kind: 'soon'; item: ComingSoonTile };

/**
 * The Add Channel grid in order: each coming-soon tile right after the tile it
 * names in `after`, or at the end when that tile is not listed.
 */
export const withComingSoon = <T extends { identifier: string }>(
  tiles: ReadonlyArray<T>,
  soon: ReadonlyArray<ComingSoonTile>
): ChannelTile<T>[] => {
  const placed = new Set<string>();
  const out: ChannelTile<T>[] = [];
  for (const item of tiles) {
    out.push({ kind: 'live', item });
    for (const s of soon) {
      if (s.after === item.identifier && !placed.has(s.identifier)) {
        out.push({ kind: 'soon', item: s });
        placed.add(s.identifier);
      }
    }
  }
  for (const s of soon) {
    if (!placed.has(s.identifier)) {
      out.push({ kind: 'soon', item: s });
    }
  }
  return out;
};

/** The toast after a connect: a new channel is "added", not "updated". */
export const channelSavedMessage = (reconnected: boolean) =>
  reconnected ? 'Channel updated' : 'Channel added';

/** The toast when a connect that had already succeeded is sent again. */
export const CHANNEL_ALREADY_CONNECTED = 'This channel is already connected';

/**
 * Where the OAuth callback page goes after a connect, and the message it
 * shows. A repeat of a connect that already succeeded (the back button or a
 * reload of the callback page; the backend answers alreadyConnected) says so
 * and leaves out `added`, which would count the channel as added a second
 * time (channel_added) and reopen onboarding.
 */
export const afterConnect = (p: {
  provider: string;
  reconnected?: boolean;
  onboarding?: boolean;
  alreadyConnected?: boolean;
}): { path: string; message: string } => {
  if (p.alreadyConnected) {
    return {
      path: `/launches?msg=${encodeURIComponent(CHANNEL_ALREADY_CONNECTED)}`,
      message: CHANNEL_ALREADY_CONNECTED,
    };
  }
  const message = channelSavedMessage(!!p.reconnected);
  return {
    path: `/launches?added=${p.provider}&msg=${encodeURIComponent(message)}${
      p.onboarding ? '&onboarding=true' : ''
    }`,
    message,
  };
};

const PROVIDER_NAMES: Record<string, string> = {
  x: 'X',
  linkedin: 'LinkedIn',
  'linkedin-page': 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  'instagram-standalone': 'Instagram',
  threads: 'Threads',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  'tiktok-business': 'TikTok Business',
  pinterest: 'Pinterest',
  gmb: 'Google Business',
  reddit: 'Reddit',
  discord: 'Discord',
  slack: 'Slack',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  telegram: 'Telegram',
  tumblr: 'Tumblr',
  wordpress: 'WordPress',
};

/** "LinkedIn" for linkedin, "Instagram" for instagram-standalone. */
/**
 * What the callback page says when an api.market subscriber connected a
 * channel to their API workspace (the backend's `marketplace: true`).
 */
export const marketplaceConnectedMessage = (provider: string) =>
  `Your ${provider} channel is connected to your Hookpost API workspace. You can close this tab and go back to your app.`;

export const providerName = (identifier: string) =>
  PROVIDER_NAMES[identifier] ||
  identifier.charAt(0).toUpperCase() + identifier.slice(1);

/**
 * Consent-screen answers that mean the person said no: Meta, Google, TikTok
 * and Pinterest send ?error=access_denied (Meta adds error_reason=user_denied),
 * LinkedIn ?error=user_cancelled_login or user_cancelled_authorize, and X
 * ?denied=<token> instead of oauth_verifier.
 */
const CANCEL_ERRORS = new Set([
  'access_denied',
  'user_denied',
  'user_cancelled_login',
  'user_cancelled_authorize',
  'consent_required',
]);

export interface ProviderReturn {
  /** The person cancelled or denied on the provider's screen. */
  cancelled: boolean;
  /** user_denied, or the provider's error code, for the log. */
  code: string;
  /** The provider's own description, shown when it was not a cancel. */
  detail?: string;
}

/**
 * The provider came back without a code: null when it did not (a normal
 * callback). Posting such a callback to social-connect was a 400 "code must
 * be a string" shown as "Could not add provider" (22 Oct, Instagram), and X's
 * denial read as "This connect link was already used or has expired".
 */
export const providerReturnedError = (
  params: Record<string, unknown> | null | undefined
): ProviderReturn | null => {
  const get = (key: string) =>
    typeof params?.[key] === 'string' ? (params[key] as string) : '';
  if (get('denied')) {
    return { cancelled: true, code: 'user_denied' };
  }
  const error = get('error');
  if (!error) {
    return null;
  }
  const reason = get('error_reason');
  if (CANCEL_ERRORS.has(error) || reason === 'user_denied') {
    return { cancelled: true, code: 'user_denied' };
  }
  const description = (get('error_description') || get('error_message'))
    .replace(/\+/g, ' ')
    .trim()
    .slice(0, 200);
  return {
    cancelled: false,
    code: error.slice(0, 60),
    detail: description || error,
  };
};

/** Where "Try again" goes after a connect that did not finish: Add Channel. */
export const ADD_CHANNEL_AGAIN_PATH = '/launches?add_channel=1';

/**
 * The calendar's query string without the one-time connect notice: `msg`,
 * and `added` unless `continue` is there too (the page picker after a
 * two-step login reads both). Every other parameter, `onboarding` included,
 * stays. Null when there is nothing to remove.
 *
 * Without this, every reload or reopened tab of
 * /launches?added=linkedin&msg=Channel%20Updated showed the toast again and
 * counted channel_added again (one user, four times over 6-15 Oct).
 */
export const withoutConnectNotice = (search: string): string | null => {
  const params = new URLSearchParams(search);
  let changed = false;
  if (params.has('msg')) {
    params.delete('msg');
    changed = true;
  }
  if (params.has('added') && !params.has('continue')) {
    params.delete('added');
    changed = true;
  }
  return changed ? params.toString() : null;
};

/** `url` when there is a link to follow; otherwise null, and why. */
export interface ConnectLink {
  url: string | null;
  planRefused: boolean;
}

/**
 * GET /integrations/social/:provider (a connect, a reconnect, or an invite
 * link), read only when it worked.
 *
 * A refusal must never be read as a link. The plan dialog reads its 402 from
 * a copy (layout.context.tsx), so the caller gets the body unread, and that
 * body carries `url: <frontend>/billing`. When the dialog was dismissed, Add
 * Channel took that as the provider's login page: OAuth tiles went to /billing,
 * invite links copied it, and custom-field and extension providers sent it on
 * as the connect state.
 *
 * `planRefused` is a 402: the plan dialog has already said why, so the
 * caller shows nothing more. Any other failure, `{ err: true }` included, is
 * one the caller reports.
 */
export const fetchConnectLink = async (
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  path: string
): Promise<ConnectLink> => {
  let response: Response;
  try {
    response = await fetch(path);
  } catch (e) {
    return { url: null, planRefused: false };
  }
  if (!response?.ok) {
    return { url: null, planRefused: response?.status === 402 };
  }
  const body = await response.json().catch(() => null);
  if (!body || body.err || typeof body.url !== 'string' || !body.url) {
    return { url: null, planRefused: false };
  }
  return { url: body.url, planRefused: false };
};

/** Where to log in, for the extension providers' "not logged in" message. */
const EXTENSION_LOGIN_SITE: Record<string, string> = { skool: 'skool.com' };

/**
 * The toast when the Hookpost extension could not read a platform session
 * (GET_COOKIES answered success: false). The extension's own error names the
 * cookies and is written for developers, so it is never shown as is.
 */
export const extensionCookiesMessage = (
  response: { missingCookies?: string[] } | null | undefined,
  identifier: string
): string => {
  const name = providerName(identifier);
  if (response?.missingCookies?.length) {
    const site = EXTENSION_LOGIN_SITE[identifier];
    return `You're not logged in to ${name} in this browser. Log in ${
      site ? `at ${site}` : 'there'
    }, then try connecting again.`;
  }
  return `Couldn't read your ${name} login from the Hookpost extension. Reload this page and try again.`;
};
