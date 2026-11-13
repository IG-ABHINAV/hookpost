/**
 * The onboarding's "Write your first post" step. Of the 7 real users who
 * connected a channel by 18 Oct 2026, 5 stopped there and only 2 ever opened
 * the composer: once a channel is connected, the onboarding now says what to
 * do next and opens the composer with that channel selected.
 */

/** Channels the composer can post to right now. */
export const postableChannels = (integrations: unknown): any[] =>
  Array.isArray(integrations)
    ? integrations.filter(
        (i: any) => i && !i.disabled && !i.inBetweenSteps && !i.refreshNeeded
      )
    : [];

/**
 * Where "Write your first post" goes: /launches?compose=<id> selects the one
 * postable channel; with several, `first` opens the composer with none
 * selected, so nothing goes to a channel the user did not pick.
 */
export const firstPostUrl = (integrations: unknown): string => {
  const channels = postableChannels(integrations);
  return `/launches?compose=${
    channels.length === 1 ? encodeURIComponent(channels[0].id) : 'first'
  }`;
};

/**
 * "Create a post yourself" on a screen the plan locks (the AI Agent on Free):
 * the composer when a channel can post, otherwise the onboarding, which starts
 * with connecting one. It used to be the bare calendar, a dead end for the 3
 * audit users who opened the Agent before connecting anything.
 */
export const selfPostUrl = (integrations: unknown): string =>
  postableChannels(integrations).length
    ? firstPostUrl(integrations)
    : '/launches?onboarding=true';
