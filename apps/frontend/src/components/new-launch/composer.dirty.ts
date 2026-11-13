/**
 * Whether closing the composer would lose anything.
 *
 * The composer used to ask "Are you sure you want to close?" every time, even
 * when nothing had been touched. It now remembers what it held once it had
 * opened (markComposerClean in the store) and asks only when that changed, or
 * when a channel's settings form reports an edit (react-hook-form's isDirty,
 * published per channel as settingsDirty).
 *
 * Kept free of the store import so the store can use it without a cycle.
 */

interface ComposerValue {
  content: string;
  delay?: number;
  media?: Array<Record<string, any>>;
}

export interface ComposerDirtyState {
  selectedIntegrations: Array<{ integration: { id: string } }>;
  global: ComposerValue[];
  internal: Array<{
    integration: { id: string };
    integrationValue: ComposerValue[];
  }>;
  date?: { valueOf(): number };
  tags?: Array<{ value: string }>;
  repeater?: number;
  reminders?: Record<string, boolean>;
  composerBaseline?: string;
  settingsDirty?: Record<string, boolean>;
}

// What would be saved: text, delay and media (alt text and thumbnail
// included). Value ids are left out: they are not something the user edits.
const valueSnapshot = (value: ComposerValue) => ({
  content: value?.content || '',
  delay: value?.delay || 0,
  media: (value?.media || []).map((media) => ({ ...media })),
});

export const composerSnapshot = (state: ComposerDirtyState) =>
  JSON.stringify({
    channels: (state.selectedIntegrations || []).map((p) => p.integration?.id),
    global: (state.global || []).map(valueSnapshot),
    internal: (state.internal || []).map((p) => ({
      id: p.integration?.id,
      values: (p.integrationValue || []).map(valueSnapshot),
    })),
    date: state.date ? state.date.valueOf() : null,
    tags: (state.tags || []).map((tag) => tag.value),
    repeater: state.repeater || 0,
    reminders: (state.selectedIntegrations || [])
      .filter((p) => state.reminders?.[p.integration?.id])
      .map((p) => p.integration?.id),
  });

/**
 * True when closing would lose an edit. A composer that never finished
 * opening (no baseline) counts as changed, so it still asks.
 */
export const isComposerDirty = (state: ComposerDirtyState) => {
  if (Object.values(state.settingsDirty || {}).some(Boolean)) {
    return true;
  }
  if (state.composerBaseline === undefined) {
    return true;
  }
  return composerSnapshot(state) !== state.composerBaseline;
};
