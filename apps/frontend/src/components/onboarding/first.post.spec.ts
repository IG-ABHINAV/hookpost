/**
 * A Free sign-up reaches the "Connect your channels" onboarding, and once a
 * channel is connected the onboarding leads to the first post:
 *   - "Start free" on the plans screen and a One Tap sign-up land on it
 *   - "Write your first post" opens the composer with the channel selected
 *   pnpm exec jest -c apps/frontend/jest.config.ts first.post
 */
import {
  firstPostUrl,
  postableChannels,
  selfPostUrl,
} from '@hookpost/frontend/components/onboarding/first.post';
import {
  CONTINUE_FREE_FLAG,
  rememberContinueFree,
  settleWithin,
  START_FREE_WAIT_MS,
  startFreeDestination,
} from '@hookpost/frontend/components/billing/start.free';
import { oneTapDestination } from '@hookpost/frontend/components/auth/google-one-tap';

describe('Start free', () => {
  it('goes to the onboarding while the workspace has no channel', () => {
    expect(startFreeDestination(false)).toBe('/launches?onboarding=true');
    expect(startFreeDestination(true)).toBe('/launches');
  });

  describe('waiting for the server', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it("uses the server's answer when it comes in time", async () => {
      await expect(
        settleWithin(Promise.resolve(true), START_FREE_WAIT_MS, false)
      ).resolves.toBe(true);
    });

    it('goes on without it after about 3 s when the request hangs', async () => {
      const hung = new Promise<boolean>(() => undefined);
      const result = settleWithin(hung, START_FREE_WAIT_MS, false);
      jest.advanceTimersByTime(START_FREE_WAIT_MS - 1);
      let settled = false;
      result.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      await expect(result).resolves.toBe(false);
      expect(START_FREE_WAIT_MS).toBe(3000);
    });

    it('a failed request is the safe default, not an error', async () => {
      await expect(
        settleWithin(Promise.reject(new Error('offline')), START_FREE_WAIT_MS, false)
      ).resolves.toBe(false);
    });
  });

  it('keeps the browser copy of the choice the layout reads', () => {
    localStorage.removeItem(CONTINUE_FREE_FLAG);
    rememberContinueFree();
    expect(localStorage.getItem(CONTINUE_FREE_FLAG)).toBe('true');
    expect(document.cookie).toContain(`${CONTINUE_FREE_FLAG}=true`);
  });
});

describe('One Tap', () => {
  it('sends a new account to the onboarding and a returning one to the calendar', () => {
    expect(oneTapDestination({ login: true, registered: true })).toBe(
      '/launches?onboarding=true'
    );
    expect(oneTapDestination({ login: true, registered: false })).toBe(
      '/launches'
    );
    // An older backend, or an unreadable body.
    expect(oneTapDestination({ login: true })).toBe('/launches');
    expect(oneTapDestination(null)).toBe('/launches');
    // Google signed a returning account in by itself on an invite page:
    // nothing was joined, and /invite asks (auth.controller googleOneTap).
    expect(oneTapDestination({ login: true, invite: 'ask' })).toBe('/invite');
    expect(oneTapDestination({ login: true, registered: true, invite: 'ask' }, '/billing')).toBe('/invite');
    expect(oneTapDestination({ login: true, invite: 'joined' })).toBe('/launches');
  });
});

describe('Write your first post', () => {
  const x = { id: 'x-1' };

  it('selects the one channel that can post', () => {
    expect(firstPostUrl([x])).toBe('/launches?compose=x-1');
    expect(
      firstPostUrl([
        x,
        { id: 'fb', inBetweenSteps: true },
        { id: 'li', refreshNeeded: true },
        { id: 'yt', disabled: true },
      ])
    ).toBe('/launches?compose=x-1');
  });

  it('selects none when there are several, so nothing posts to a channel the user did not pick', () => {
    expect(firstPostUrl([x, { id: 'li-1' }])).toBe('/launches?compose=first');
  });

  it('only offers the step once a channel can post', () => {
    expect(postableChannels([])).toHaveLength(0);
    expect(postableChannels(undefined)).toHaveLength(0);
    expect(postableChannels([{ id: 'fb', inBetweenSteps: true }])).toHaveLength(
      0
    );
    expect(postableChannels([x])).toEqual([x]);
  });

  it('escapes the channel id', () => {
    expect(firstPostUrl([{ id: 'a&b' }])).toBe('/launches?compose=a%26b');
  });
});

describe('"Create a post yourself" from the locked AI Agent', () => {
  it('opens the composer when a channel can post', () => {
    expect(selfPostUrl([{ id: 'x-1' }])).toBe('/launches?compose=x-1');
    expect(selfPostUrl([{ id: 'x-1' }, { id: 'li-1' }])).toBe(
      '/launches?compose=first'
    );
  });

  it('without one, the onboarding, which starts by connecting a channel', () => {
    expect(selfPostUrl([])).toBe('/launches?onboarding=true');
    expect(selfPostUrl(undefined)).toBe('/launches?onboarding=true');
    expect(selfPostUrl([{ id: 'fb', inBetweenSteps: true }])).toBe(
      '/launches?onboarding=true'
    );
  });
});
