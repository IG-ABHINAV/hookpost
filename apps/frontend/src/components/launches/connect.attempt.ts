import { providerName } from '@hookpost/frontend/components/launches/add.channel.helpers';

/**
 * A connect that left for the provider and never came back. 11 of 18
 * outsider connects on 6-22 Oct ended that way, and Hookpost said nothing
 * when the person returned: on 22 Oct an Android user tried X, Threads and
 * LinkedIn and was back on the calendar 4-7 s after each, with no channel and
 * no word about why.
 *
 * The connect remembers its provider in sessionStorage as it leaves. The
 * callback page clears it (the provider did answer, whatever it said); if
 * the calendar shows again with it still there, the connect was abandoned,
 * unless a channel of that provider appeared meanwhile: on Android an app
 * that opened instead of the sign-in page can finish the connect in a new
 * tab, whose callback page cannot clear this tab's sessionStorage.
 */
const KEY = 'hp_connect_attempt';
/** Younger than this, the browser may still be on its way out. */
export const ABANDONED_AFTER_MS = 3_000;
/** Older than this, it is not worth mentioning. */
export const ATTEMPT_FORGOTTEN_AFTER_MS = 30 * 60 * 1000;

export interface ConnectAttempt {
  provider: string;
  at: number;
  /** Ids of the channels the workspace had when the connect started. */
  known?: string[];
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const session = (): Store | null => {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

export const rememberConnectStart = (
  provider: string,
  now = Date.now(),
  store: Store | null = session(),
  known?: string[] | null
) => {
  try {
    store?.setItem(
      KEY,
      JSON.stringify({ provider, at: now, ...(Array.isArray(known) ? { known } : {}) })
    );
  } catch {
    // private mode or storage full: the card just never shows
  }
};

export const clearConnectAttempt = (store: Store | null = session()) => {
  try {
    store?.removeItem(KEY);
  } catch {
    // nothing to do
  }
};

const read = (store: Store | null): ConnectAttempt | null => {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (typeof parsed?.provider !== 'string' || typeof parsed?.at !== 'number') {
      return null;
    }
    const known = Array.isArray(parsed.known)
      ? parsed.known.filter((id: unknown): id is string => typeof id === 'string')
      : undefined;
    return {
      provider: parsed.provider,
      at: parsed.at,
      ...(known ? { known } : {}),
    };
  } catch {
    return null;
  }
};

/** A connect that was abandoned, or null. */
export const abandonedAttempt = (
  now = Date.now(),
  store: Store | null = session()
): ConnectAttempt | null => {
  const attempt = read(store);
  if (!attempt) {
    return null;
  }
  const age = now - attempt.at;
  if (age > ATTEMPT_FORGOTTEN_AFTER_MS || age < 0) {
    clearConnectAttempt(store);
    return null;
  }
  return age >= ABANDONED_AFTER_MS ? attempt : null;
};

/** The provider of a connect that was abandoned, or null. */
export const abandonedConnect = (
  now = Date.now(),
  store: Store | null = session()
): string | null => abandonedAttempt(now, store)?.provider ?? null;

/** The ids in a channel list (the SWR cache of /integrations/list), or null. */
export const channelIds = (list: unknown): string[] | null =>
  Array.isArray(list)
    ? list
        .map((channel) => (channel as { id?: unknown } | null)?.id)
        .filter((id): id is string => typeof id === 'string')
    : null;

/**
 * The connect did finish, somewhere this tab's callback page never ran: the
 * workspace now has a channel of that provider that it did not have when the
 * connect started. False when the starting list is unknown.
 */
export const finishedElsewhere = (
  attempt: ConnectAttempt,
  channels: unknown
): boolean => {
  const known = attempt.known;
  if (!known || !Array.isArray(channels)) {
    return false;
  }
  return channels.some((channel) => {
    const c = channel as { id?: unknown; identifier?: unknown } | null;
    return (
      c?.identifier === attempt.provider &&
      typeof c.id === 'string' &&
      !known.includes(c.id)
    );
  });
};

const TIPS: Record<string, string> = {
  instagram:
    'Instagram connects through Facebook: the Instagram account must be a Business or Creator account linked to a Facebook Page, and you sign in with the Facebook account that manages that Page.',
  facebook:
    "Pick at least one Facebook Page on Facebook's screen. A personal profile cannot be connected.",
  threads:
    'Threads asks you to sign in with Instagram. If the Threads or Instagram app opened instead, come back here and try again.',
  x: 'If the X app opened instead of the sign-in page, come back here and try again. Signing in to x.com in this browser first helps.',
  linkedin:
    'Sign in to LinkedIn in this browser and press Allow. If the LinkedIn app opened instead, come back here and try again.',
  youtube:
    'Choose the Google account that owns the channel, and tick every permission Google shows.',
  tiktok:
    'Sign in to TikTok in this browser and press Authorize. If the TikTok app opened instead, come back here and try again.',
  pinterest: 'Sign in to Pinterest in this browser and press Give access.',
};

/** What to say about an abandoned connect to this provider. */
export const abandonedConnectTip = (provider: string) =>
  TIPS[provider] ||
  `If ${providerName(provider)}'s app opened instead of its sign-in page, or the page closed, try again. Nothing was connected.`;
