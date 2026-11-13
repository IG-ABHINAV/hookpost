/**
 * A post whose file was purged from storage: the composer asks the backend
 * which files are gone, and holds publishing for the channels that would
 * send one until it is removed or replaced.
 *   pnpm exec jest -c apps/frontend/jest.config.ts composer.media
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';

// The real useT suspends until the locale files load
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import {
  channelsWithMissingMedia,
  checkMissingMedia,
  existingMediaPaths,
} from '@hookpost/frontend/components/new-launch/composer.media';
import { VideoFrame } from '@hookpost/react/helpers/video.frame';

const DEAD = 'https://media.hookstep.in/SqkI7X8hpR.mp4';
const LIVE = 'https://media.hookstep.in/Ab3dE6gH9j.png';

const channel = (id: string) =>
  ({ id, name: id, identifier: 'x', picture: '' } as any);

const value = (...paths: string[]) => ({
  id: paths.join(),
  content: '<p>hi</p>',
  delay: 0,
  media: paths.map((path, i) => ({ id: `m${i}`, path })),
});

afterEach(() => useLaunchStore.getState().reset());

describe('channelsWithMissingMedia', () => {
  const state = (overrides: any = {}) => ({
    selectedIntegrations: [
      { integration: channel('int-1') },
      { integration: channel('int-2') },
    ],
    global: [value(LIVE)],
    internal: [] as any[],
    missingMedia: { [DEAD]: true as const },
    ...overrides,
  });

  it('holds every channel that publishes the global values with a dead file', () => {
    expect(
      channelsWithMissingMedia(state({ global: [value(LIVE, DEAD)] }))
    ).toEqual(['int-1', 'int-2']);
  });

  it("holds only the channel whose own values carry it (a failed post's channel)", () => {
    expect(
      channelsWithMissingMedia(
        state({
          internal: [
            {
              integration: channel('int-1'),
              integrationValue: [value(LIVE), value(DEAD)],
            },
          ],
        })
      )
    ).toEqual(['int-1']);
  });

  it('lets go once the dead file is removed or replaced', () => {
    expect(
      channelsWithMissingMedia(
        state({
          internal: [
            { integration: channel('int-1'), integrationValue: [value(LIVE)] },
          ],
        })
      )
    ).toEqual([]);
  });

  it('holds nothing when the backend reported nothing gone', () => {
    expect(
      channelsWithMissingMedia(
        state({ global: [value(DEAD)], missingMedia: {} })
      )
    ).toEqual([]);
  });

  it('works on the composer store as the user removes the file', () => {
    const store = useLaunchStore.getState();
    store.setAllIntegrations([channel('int-1')]);
    store.addOrRemoveSelectedIntegration(channel('int-1'), {});
    store.addInternalValue(0, 'int-1', [value(DEAD)]);
    store.addMissingMedia([DEAD]);
    expect(channelsWithMissingMedia(useLaunchStore.getState())).toEqual([
      'int-1',
    ]);

    useLaunchStore.getState().removeInternalValueMedia('int-1', 0, 0);
    expect(channelsWithMissingMedia(useLaunchStore.getState())).toEqual([]);
  });
});

describe('existingMediaPaths', () => {
  it("collects the opened post's files, comments included", () => {
    expect(
      existingMediaPaths([
        { image: [{ path: DEAD }] },
        { image: JSON.stringify([{ path: LIVE }]) },
        { image: null },
        { image: 'not json' },
      ])
    ).toEqual([DEAD, LIVE]);
  });
});

describe('checkMissingMedia (POST /posts/missing-media)', () => {
  it('sends the paths and returns what the backend says is gone', async () => {
    const fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ missing: [DEAD] }),
    })) as any;
    await expect(checkMissingMedia(fetch, [DEAD, LIVE])).resolves.toEqual([
      DEAD,
    ]);
    expect(fetch).toHaveBeenCalledWith('/posts/missing-media', {
      method: 'POST',
      body: JSON.stringify({ paths: [DEAD, LIVE] }),
    });
  });

  it('never blocks on a check that could not run', async () => {
    const failed = jest.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as any;
    const thrown = jest.fn(async () => {
      throw new Error('offline');
    }) as any;
    await expect(checkMissingMedia(failed, [DEAD])).resolves.toEqual([]);
    await expect(checkMissingMedia(thrown, [DEAD])).resolves.toEqual([]);
  });

  it('asks nothing for a post without files', async () => {
    const fetch = jest.fn() as any;
    await expect(checkMissingMedia(fetch, [])).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('store: files that are gone', () => {
  it('keeps the confirmed paths and the failed previews until the composer closes', () => {
    useLaunchStore.getState().addMissingMedia([DEAD]);
    useLaunchStore.getState().reportMediaLoadError(DEAD);
    expect(useLaunchStore.getState().missingMedia).toEqual({ [DEAD]: true });
    expect(useLaunchStore.getState().mediaLoadErrors).toEqual({ [DEAD]: true });

    useLaunchStore.getState().reset();
    expect(useLaunchStore.getState().missingMedia).toEqual({});
    expect(useLaunchStore.getState().mediaLoadErrors).toEqual({});
  });
});

describe('VideoFrame (composer media thumbnail)', () => {
  it('says once that a video does not load, so the composer can check it', async () => {
    const onUnavailable = jest.fn();
    const { container } = render(
      React.createElement(VideoFrame, { url: DEAD, onUnavailable })
    );
    await act(async () => {
      fireEvent.error(container.querySelector('video')!);
    });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });
});
