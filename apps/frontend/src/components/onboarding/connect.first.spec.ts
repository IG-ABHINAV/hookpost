/**
 * The connect step before the trial paywall (connect.first.ts): who gets it,
 * what counts as a connected channel, "Skip for now", and the line the
 * paywall shows once a channel is there.
 *   pnpm exec jest -c apps/frontend/jest.config.ts connect.first
 */
import {
  connectedChannelLine,
  CONNECT_FIRST_SKIP_KEY,
  countedChannels,
  readConnectFirstSkipped,
  rememberConnectFirstSkipped,
  showConnectFirst,
} from '@hookpost/frontend/components/onboarding/connect.first';
import { showFirstBilling } from '@hookpost/frontend/components/layout/twa';

const needsTrial = { planState: 'needs_trial', preTrialChannelLimit: 1, channels: 0, skipped: false };

describe('showConnectFirst', () => {
  it('needs_trial with no channel yet: the connect step', () => {
    expect(showConnectFirst(needsTrial)).toBe(true);
  });

  it('once the one pre-trial channel is connected: the paywall', () => {
    expect(showConnectFirst({ ...needsTrial, channels: 1 })).toBe(false);
  });

  it('"Skip for now": the paywall', () => {
    expect(showConnectFirst({ ...needsTrial, skipped: true })).toBe(false);
  });

  it('never for any other plan state, whatever the channels', () => {
    for (const planState of ['free', 'locked', 'trialing', 'active', 'dunning', 'cancelling', undefined, null]) {
      expect([planState, showConnectFirst({ ...needsTrial, planState })]).toEqual([planState, false]);
    }
  });

  it('a backend without preTrialChannelLimit (or 0) keeps the paywall as it was', () => {
    expect(showConnectFirst({ ...needsTrial, preTrialChannelLimit: undefined })).toBe(false);
    expect(showConnectFirst({ ...needsTrial, preTrialChannelLimit: null })).toBe(false);
    expect(showConnectFirst({ ...needsTrial, preTrialChannelLimit: 0 })).toBe(false);
  });

  // The connect step only replaces the paywall, so everything that keeps a
  // workspace off the paywall keeps it off the connect step too: the Play
  // app, a platform admin, no billing, and any workspace with a plan.
  it('lives inside showFirstBilling: never in the Play app, for an admin, without billing, or with a plan', () => {
    const web = { tier: 'FREE', isGeneral: true, billingEnabled: true, continueFree: false, isTwa: false, planState: 'needs_trial' };
    expect(showFirstBilling(web)).toBe(true);
    expect(showFirstBilling({ ...web, isTwa: true })).toBe(false);
    expect(showFirstBilling({ ...web, admin: true })).toBe(false);
    expect(showFirstBilling({ ...web, billingEnabled: false })).toBe(false);
    expect(showFirstBilling({ ...web, tier: 'STANDARD', planState: 'trialing' })).toBe(false);
    expect(showFirstBilling({ ...web, tier: 'STANDARD', planState: 'active' })).toBe(false);
  });
});

describe('countedChannels: as the backend counts them (channel.limit.ts)', () => {
  it('a live channel counts; a placeholder of an unfinished two-step login and a dead channel do not', () => {
    const list = [
      { id: 'a', identifier: 'linkedin' },
      { id: 'ph', identifier: 'facebook', inBetweenSteps: true },
      { id: 'dead', identifier: 'x', refreshNeeded: true },
    ];
    expect(countedChannels(list).map((c: any) => c.id)).toEqual(['a']);
  });

  it('anything that is not a list counts as none', () => {
    expect(countedChannels(undefined)).toEqual([]);
    expect(countedChannels({ integrations: [] })).toEqual([]);
    expect(countedChannels([null])).toEqual([]);
  });

  it('only a placeholder left (the page pick was abandoned): still the connect step', () => {
    const channels = countedChannels([{ identifier: 'facebook', inBetweenSteps: true }]).length;
    expect(showConnectFirst({ ...needsTrial, channels })).toBe(true);
  });
});

describe('"Skip for now", per workspace', () => {
  beforeEach(() => window.localStorage.clear());

  it('is remembered for that workspace only, and can be undone', () => {
    rememberConnectFirstSkipped('org-1', true);
    expect(readConnectFirstSkipped('org-1')).toBe(true);
    expect(readConnectFirstSkipped('org-2')).toBe(false);
    expect(window.localStorage.getItem(`${CONNECT_FIRST_SKIP_KEY}:org-1`)).toBe('1');
    rememberConnectFirstSkipped('org-1', false);
    expect(readConnectFirstSkipped('org-1')).toBe(false);
  });

  it('without a workspace id nothing is read or written', () => {
    rememberConnectFirstSkipped(undefined, true);
    expect(window.localStorage.length).toBe(0);
    expect(readConnectFirstSkipped(undefined)).toBe(false);
  });

  it('storage that throws (a private window) reads as not skipped and never throws', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readConnectFirstSkipped('org-1')).toBe(false);
    expect(() => rememberConnectFirstSkipped('org-1', true)).not.toThrow();
    get.mockRestore();
    set.mockRestore();
  });
});

describe('connectedChannelLine: what the paywall says once a channel is connected', () => {
  it('one channel: names the network and the trial length', () => {
    expect(connectedChannelLine([{ identifier: 'linkedin' }], 3)).toEqual([
      'paywall_channel_connected',
      'Your {{network}} is connected. Start your {{days}}-day trial to schedule your first post.',
      { network: 'LinkedIn', days: '3' },
    ]);
    expect(connectedChannelLine([{ identifier: 'instagram-standalone' }], 7)?.[2]).toEqual({
      network: 'Instagram',
      days: '7',
    });
  });

  it('several channels (a workspace whose Free plan ended): the count', () => {
    expect(connectedChannelLine([{ identifier: 'x' }, { identifier: 'threads' }], 3)?.[2]).toEqual({
      count: '2',
      days: '3',
    });
  });

  it('nothing connected, or only a placeholder: no line', () => {
    expect(connectedChannelLine([], 3)).toBeNull();
    expect(connectedChannelLine([{ identifier: 'facebook', inBetweenSteps: true }], 3)).toBeNull();
  });
});
