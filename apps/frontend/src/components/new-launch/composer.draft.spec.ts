/**
 * An unsaved new post survives leaving the page. On 21 Oct the first trial
 * customer wrote a post, generated an AI image for it, connected a channel,
 * pressed Back, and lost the composer and everything in it.
 *   pnpm exec jest -c apps/frontend/jest.config.ts composer.draft
 */
import {
  clearDraft,
  composerDraftScope,
  draftFromState,
  draftScope,
  draftSummary,
  DRAFT_TTL_MS,
  keepDraft,
  loadDraft,
  saveDraft,
} from '@hookpost/frontend/components/new-launch/composer.draft';

const T0 = 1_761_000_000_000;
const SCOPE = 'user-1:org-1';
const IMAGE = { id: 'm1', path: 'https://media.hookstep.in/ai-1.png' };

const composer = (over: any = {}) => ({
  global: [{ id: 'v1', content: '<p>Join our NDA batch</p>', delay: 0, media: [IMAGE] }],
  internal: [],
  selectedIntegrations: [{ integration: { id: 'yt-1' } }],
  ...over,
});

beforeEach(() => window.localStorage.clear());

describe('draftFromState', () => {
  it('keeps the text, the media and the channels', () => {
    expect(draftFromState(composer(), T0)).toEqual({
      v: 1,
      savedAt: T0,
      values: [{ content: '<p>Join our NDA batch</p>', media: [IMAGE] }],
      channels: ['yt-1'],
    });
  });

  it('an empty composer is not a draft', () => {
    expect(
      draftFromState(composer({ global: [{ content: '<p> &nbsp;</p>', media: [] }] }))
    ).toBeNull();
  });

  it('an image with no text is worth keeping (the AI picture)', () => {
    const draft = draftFromState(composer({ global: [{ content: '<p></p>', media: [IMAGE] }] }));
    expect(draft?.values[0].media).toEqual([IMAGE]);
  });

  it('text written only on one channel tab is kept too', () => {
    const draft = draftFromState(
      composer({
        global: [{ content: '', media: [] }],
        internal: [{ integration: { id: 'yt-1' }, integrationValue: [{ content: '<p>YT only</p>', media: [] }] }],
      })
    );
    expect(draft?.values).toEqual([{ content: '<p>YT only</p>', media: [] }]);
  });
});

describe('save, load and expiry', () => {
  it('one draft per person and workspace', () => {
    expect(draftScope({ id: 'user-1', orgId: 'org-1' })).toBe(SCOPE);
    expect(draftScope({ id: 'user-1' })).toBeNull();
    expect(draftScope(undefined)).toBeNull();
  });

  it('a new post keeps a draft; editing a saved post or a Set does not', () => {
    const user = { id: 'user-1', orgId: 'org-1' };
    expect(composerDraftScope(user, {})).toBe(SCOPE);
    expect(composerDraftScope(user, { editing: { id: 'yt-1' } })).toBeNull();
    expect(composerDraftScope(user, { set: () => undefined })).toBeNull();
    expect(composerDraftScope(user, { dummy: true })).toBeNull();
  });

  it('comes back after the page is left', () => {
    saveDraft(SCOPE, draftFromState(composer(), T0));
    expect(loadDraft(SCOPE, T0 + 60_000)?.channels).toEqual(['yt-1']);
    expect(loadDraft('user-2:org-1', T0)).toBeNull();
  });

  it('is not offered after a week, and broken storage is no draft', () => {
    saveDraft(SCOPE, draftFromState(composer(), T0));
    expect(loadDraft(SCOPE, T0 + DRAFT_TTL_MS + 1)).toBeNull();
    window.localStorage.setItem(`hp_composer_draft:${SCOPE}`, '{not json');
    expect(loadDraft(SCOPE, T0)).toBeNull();
  });

  it('summary: the words, or what media there is', () => {
    expect(draftSummary(draftFromState(composer(), T0)!)).toBe('Join our NDA batch');
    expect(
      draftSummary(draftFromState(composer({ global: [{ content: '', media: [IMAGE] }] }), T0)!)
    ).toBe('1 image or video');
  });
});

describe('keepDraft (the composer while it is open)', () => {
  const fakeStore = () => {
    let listener: (s: any) => void = () => undefined;
    return {
      subscribe: (l: (s: any) => void) => {
        listener = l;
        return () => {
          listener = () => undefined;
        };
      },
      emit: (s: any) => listener(s),
    };
  };

  it('saves as the post is written, and removes it when the composer closes', () => {
    const store = fakeStore();
    const kept = keepDraft(SCOPE, store.subscribe);
    store.emit(composer());
    expect(loadDraft(SCOPE)?.values[0].content).toBe('<p>Join our NDA batch</p>');
    kept.close();
    expect(loadDraft(SCOPE)).toBeNull();
  });

  it('a full page load (OAuth, Back, reload) never closes it, so the draft stays', () => {
    const store = fakeStore();
    keepDraft(SCOPE, store.subscribe);
    store.emit(composer());
    // no close(): the page went away
    expect(loadDraft(SCOPE)).not.toBeNull();
  });

  it('opening an empty composer does not wipe the draft on offer', () => {
    saveDraft(SCOPE, draftFromState(composer(), Date.now()));
    const store = fakeStore();
    const kept = keepDraft(SCOPE, store.subscribe);
    store.emit(composer({ global: [{ content: '', media: [] }], selectedIntegrations: [] }));
    kept.close();
    expect(loadDraft(SCOPE)?.channels).toEqual(['yt-1']);
  });

  it('emptying a post it had saved removes the draft', () => {
    const store = fakeStore();
    keepDraft(SCOPE, store.subscribe);
    store.emit(composer());
    store.emit(composer({ global: [{ content: '', media: [] }] }));
    expect(loadDraft(SCOPE)).toBeNull();
  });

  it('clearDraft forgets it', () => {
    saveDraft(SCOPE, draftFromState(composer(), Date.now()));
    clearDraft(SCOPE);
    expect(loadDraft(SCOPE)).toBeNull();
  });
});
