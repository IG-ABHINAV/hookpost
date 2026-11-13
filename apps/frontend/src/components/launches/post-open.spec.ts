/**
 * Opening a post: what the composer keeps from the post opened before it,
 * what an imported debug post sends, and what a video that no longer loads
 * shows instead of a black box.
 *   pnpm exec jest -c apps/frontend/jest.config.ts post-open
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

// The real useT suspends until the locale files load
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));

import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';
import { debugImportPayload } from '@hookpost/frontend/components/launches/import-debug-post.modal';
import { VideoOrImage } from '@hookpost/react/helpers/video.or.image';
import { VideoFrame } from '@hookpost/react/helpers/video.frame';

describe('composer store', () => {
  it('forgets the repeat interval when the composer closes', () => {
    useLaunchStore.getState().setRepeater(1);
    expect(useLaunchStore.getState().repeater).toBe(1);
    useLaunchStore.getState().reset();
    expect(useLaunchStore.getState().repeater).toBeUndefined();
  });
});

describe('debugImportPayload', () => {
  const exported = {
    type: 'draft',
    date: '2026-09-29T18:04:00.000Z',
    shortLink: false,
    tags: [{ value: 't1', label: 'Tag' }],
    posts: [
      {
        integration: { id: 'REPLACE_WITH_LOCAL_INTEGRATION_ID' },
        // exports made before the fix carried the original group
        group: 'customer-group',
        settings: { __type: 'pinterest' },
        value: [{ content: 'hello', image: [], delay: 0 }],
      },
    ],
    _debug: {
      providerIdentifier: 'pinterest',
      providerName: 'Board',
      state: 'ERROR',
      error: null,
      errors: [],
      originalGroup: 'customer-group',
      originalPublishDate: '2026-09-29T18:04:00.000Z',
      exportedAt: '2026-10-14T08:00:00.000Z',
    },
  };

  it('never sends the original group, which would delete the original post', () => {
    const payload = debugImportPayload(exported, 'local-int');
    expect(JSON.stringify(payload)).not.toContain('customer-group');
    expect(payload.posts[0]).not.toHaveProperty('group');
    expect(payload).not.toHaveProperty('_debug');
  });

  it('imports as a draft on the chosen channel', () => {
    const payload = debugImportPayload(exported, 'local-int');
    expect(payload.type).toBe('draft');
    expect(payload.tags).toEqual([]);
    expect(payload.posts[0].integration).toEqual({ id: 'local-int' });
    expect(payload.posts[0].value[0].content).toBe('hello');
    expect(payload.posts[0].settings).toEqual({ __type: 'pinterest' });
  });
});

describe('a video that no longer loads', () => {
  it('shows "Video unavailable" in previews instead of an empty player', () => {
    const { container } = render(
      React.createElement(VideoOrImage, {
        src: 'https://media.hookstep.in/SqkI7X8hpR.mp4',
        autoplay: true,
      })
    );
    fireEvent.error(container.querySelector('video')!);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByText(/Video unavailable/)).toBeTruthy();
  });

  it('marks the media tile in the editor', () => {
    const { container } = render(
      React.createElement(VideoFrame, {
        url: 'https://media.hookstep.in/SqkI7X8hpR.mp4',
      })
    );
    fireEvent.error(container.querySelector('video')!);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.getByRole('img').getAttribute('title')).toMatch(
      /Video unavailable/
    );
  });

  it('plays a video that loads', () => {
    const { container } = render(
      React.createElement(VideoOrImage, {
        src: 'https://media.hookstep.in/ok.mp4',
        autoplay: true,
      })
    );
    expect(container.querySelector('video')).not.toBeNull();
  });
});
