/**
 * The connect step a workspace that has to start its trial (planState
 * needs_trial) sees before the trial paywall. On 25 Oct 2026, 19 ad sign-ups
 * had reached the card or UPI step with nothing connected and all of them
 * left; now the first channel comes first, then the paywall, and the trial
 * still comes before any post (the backend refuses posting, AI and the rest
 * with TRIAL_REQUIRED). How many it may connect is /user/self
 * preTrialChannelLimit (trial.policy.ts PRE_TRIAL_CHANNEL_LIMIT on the
 * backend), which the backend enforces wherever a channel is created.
 */
import { providerName } from '@hookpost/frontend/components/launches/add.channel.helpers';

export interface ChannelRow {
  identifier?: string;
  inBetweenSteps?: boolean;
  refreshNeeded?: boolean;
}

/**
 * The channels that use up the allowance, as the backend counts them
 * (channel.limit.ts countsTowardChannelLimit): not the placeholder of an
 * unfinished two-step connect, and not one whose token died.
 */
export const countedChannels = <T extends ChannelRow>(list: unknown): T[] =>
  Array.isArray(list)
    ? (list as T[]).filter((c) => !!c && !c.inBetweenSteps && !c.refreshNeeded)
    : [];

/**
 * The connect step instead of the paywall: the workspace has to start its
 * trial, has room for a channel before it, and did not choose "Skip for now".
 * Only inside showFirstBilling (twa.ts), so never in the Play app, never for
 * a platform admin and never without billing. A backend without
 * preTrialChannelLimit leaves the paywall as it was.
 */
export const showConnectFirst = (p: {
  planState?: string | null;
  preTrialChannelLimit?: number | null;
  channels: number;
  skipped: boolean;
}): boolean =>
  p.planState === 'needs_trial' &&
  typeof p.preTrialChannelLimit === 'number' &&
  p.preTrialChannelLimit > 0 &&
  p.channels < p.preTrialChannelLimit &&
  !p.skipped;

/** "Skip for now", per workspace, in this browser only. */
export const CONNECT_FIRST_SKIP_KEY = 'hookpost_connect_first_skipped';

const skipKey = (orgId: string) => `${CONNECT_FIRST_SKIP_KEY}:${orgId}`;

/** Storage blocked or absent (a private window): not skipped. */
export const readConnectFirstSkipped = (orgId?: string | null): boolean => {
  if (!orgId) return false;
  try {
    return window.localStorage.getItem(skipKey(orgId)) === '1';
  } catch {
    return false;
  }
};

export const rememberConnectFirstSkipped = (
  orgId: string | null | undefined,
  skipped: boolean
): void => {
  if (!orgId) return;
  try {
    if (skipped) {
      window.localStorage.setItem(skipKey(orgId), '1');
    } else {
      window.localStorage.removeItem(skipKey(orgId));
    }
  } catch {
    // The choice lasts until the page is left; nothing else depends on it.
  }
};

/** [translation key, English default, values] for useT. */
export type CopyLine = [string, string, Record<string, string>];

/**
 * The line above the plans once a channel is connected: what the trial is
 * for now, naming the network when there is one channel. Null without a
 * connected channel. More than one only happens to a workspace whose Free
 * plan ended (FREE_PLAN_SUNSET_AT) with its channels.
 */
export const connectedChannelLine = (
  list: unknown,
  days: number
): CopyLine | null => {
  const channels = countedChannels(list);
  if (!channels.length) return null;
  if (channels.length === 1) {
    return [
      'paywall_channel_connected',
      'Your {{network}} is connected. Start your {{days}}-day trial to schedule your first post.',
      {
        network: providerName(channels[0].identifier || 'channel'),
        days: String(days),
      },
    ];
  }
  return [
    'paywall_channels_connected',
    'Your {{count}} channels are connected. Start your {{days}}-day trial to schedule your posts.',
    { count: String(channels.length), days: String(days) },
  ];
};
