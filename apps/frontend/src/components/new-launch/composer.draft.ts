/**
 * The new post being written, kept in localStorage while the composer is
 * open, so leaving the page does not lose it.
 *
 * On 21 Oct the first trial customer wrote a post and generated an AI image
 * for it, connected a channel, pressed Back, and the composer and everything
 * in it were gone (a page left for an OAuth login cannot be brought back,
 * and the composer lived only in memory). He never scheduled anything.
 *
 * Saved on every change of a new post (not while editing a saved one),
 * removed when the composer closes (posted, or closed on purpose). A full
 * page load (an OAuth login, Back, a reload, a closed tab) does not run that
 * cleanup, so the draft is still there and the calendar offers it back.
 *
 * Text, media and the selected channels only: per-channel settings (a
 * YouTube title, a Pinterest board) are not kept. Kept free of the store
 * import, like composer.dirty.ts.
 */

export interface DraftMedia {
  id: string;
  path: string;
  thumbnail?: string;
}

export interface ComposerDraft {
  v: 1;
  savedAt: number;
  values: Array<{ content: string; media: DraftMedia[] }>;
  channels: string[];
}

interface DraftSource {
  global: Array<{ content?: string; media?: DraftMedia[] }>;
  internal?: Array<{
    integrationValue?: Array<{ content?: string; media?: DraftMedia[] }>;
  }>;
  selectedIntegrations?: Array<{ integration?: { id?: string } }>;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A draft older than this is not offered back. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const PREFIX = 'hp_composer_draft:';

const local = (): Store | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** One draft per person and workspace: channels belong to a workspace. */
export const draftScope = (
  user?: { id?: string | null; orgId?: string | null } | null
): string | null =>
  user?.id && user?.orgId ? `${user.id}:${user.orgId}` : null;

/**
 * The scope for this composer's draft, or null when it keeps none: editing a
 * saved post (it is saved already), or a Set (a template, not a post).
 */
export const composerDraftScope = (
  user: { id?: string | null; orgId?: string | null } | null | undefined,
  composer: { editing?: unknown; set?: unknown; dummy?: unknown }
): string | null =>
  composer.editing || composer.set || composer.dummy ? null : draftScope(user);

/** The words of a post, without its HTML. */
export const plainText = (html: string) =>
  String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

const cleanValues = (
  values: Array<{ content?: string; media?: DraftMedia[] }> = []
) =>
  values.map((value) => ({
    content: value?.content || '',
    media: (value?.media || [])
      .filter((m) => m && m.id && m.path)
      .map((m) => ({
        id: m.id,
        path: m.path,
        ...(m.thumbnail ? { thumbnail: m.thumbnail } : {}),
      })),
  }));

const hasSomething = (values: ComposerDraft['values']) =>
  values.some((v) => plainText(v.content) !== '' || v.media.length > 0);

/**
 * The draft for the composer's state, or null when there is nothing worth
 * keeping (no text and no media anywhere).
 */
export const draftFromState = (
  state: DraftSource,
  now = Date.now()
): ComposerDraft | null => {
  let values = cleanValues(state.global);
  if (!hasSomething(values)) {
    // Written only for one channel ("Edit content" on its tab).
    const own = (state.internal || [])
      .map((i) => cleanValues(i.integrationValue))
      .find(hasSomething);
    if (!own) {
      return null;
    }
    values = own;
  }
  return {
    v: 1,
    savedAt: now,
    values,
    channels: (state.selectedIntegrations || [])
      .map((s) => s.integration?.id)
      .filter((id): id is string => !!id),
  };
};

export const saveDraft = (
  scope: string,
  draft: ComposerDraft | null,
  store: Store | null = local()
) => {
  try {
    if (!draft) {
      store?.removeItem(PREFIX + scope);
      return;
    }
    store?.setItem(PREFIX + scope, JSON.stringify(draft));
  } catch {
    // storage full or blocked: the composer works as before
  }
};

export const clearDraft = (scope: string, store: Store | null = local()) =>
  saveDraft(scope, null, store);

export const loadDraft = (
  scope: string,
  now = Date.now(),
  store: Store | null = local()
): ComposerDraft | null => {
  try {
    const raw = store?.getItem(PREFIX + scope);
    if (!raw) {
      return null;
    }
    const draft = JSON.parse(raw) as ComposerDraft;
    if (
      draft?.v !== 1 ||
      !Array.isArray(draft.values) ||
      !hasSomething(cleanValues(draft.values)) ||
      now - Number(draft.savedAt) > DRAFT_TTL_MS
    ) {
      store?.removeItem(PREFIX + scope);
      return null;
    }
    return {
      ...draft,
      values: cleanValues(draft.values),
      channels: Array.isArray(draft.channels)
        ? draft.channels.filter((c) => typeof c === 'string')
        : [],
    };
  } catch {
    return null;
  }
};

/** "Morning offer: 20% off…" for the restore bar. */
export const draftSummary = (draft: ComposerDraft, max = 80) => {
  const text = plainText(draft.values.map((v) => v.content).join(' '));
  if (text) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }
  const media = draft.values.reduce((n, v) => n + v.media.length, 0);
  return media === 1 ? '1 image or video' : `${media} images or videos`;
};

/**
 * Keeps the draft in step with the composer: `subscribe` is the store's
 * subscribe. Writes only when what would be saved changed. An empty composer
 * that never held anything leaves an older draft alone, so opening "Create
 * Post" does not wipe the one the calendar is offering back; once this
 * composer has saved something, emptying it removes the draft.
 *
 * `close()` on the composer's own close: stops, and removes the draft if this
 * composer wrote it (it was posted, or closed on purpose).
 */
export const keepDraft = (
  scope: string,
  subscribe: (listener: (state: DraftSource) => void) => () => void,
  store: Store | null = local()
) => {
  let last = '';
  let wrote = false;
  const stop = subscribe((state) => {
    const draft = draftFromState(state);
    const key = JSON.stringify(draft && { ...draft, savedAt: 0 });
    if (key === last) {
      return;
    }
    last = key;
    if (!draft && !wrote) {
      return;
    }
    wrote = true;
    saveDraft(scope, draft, store);
  });
  return {
    close: () => {
      stop();
      if (wrote) {
        clearDraft(scope, store);
      }
    },
  };
};
