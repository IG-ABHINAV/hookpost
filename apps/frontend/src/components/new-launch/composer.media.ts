'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useLaunchStore } from '@hookpost/frontend/components/new-launch/store';

/**
 * A failed post whose video the 7-day purge already removed
 * (scripts/cleanup-expired-media.js) was retried with the dead link and
 * failed again at the platform. The composer now asks the backend which of a
 * post's files are gone, says so, and keeps the publish buttons off until the
 * dead file is removed or replaced.
 */

interface MediaValue {
  media?: Array<{ path?: string }>;
}

export interface MissingMediaState {
  selectedIntegrations: Array<{ integration: { id: string } }>;
  global: MediaValue[];
  internal: Array<{
    integration: { id: string };
    integrationValue: MediaValue[];
  }>;
  missingMedia: Record<string, true>;
}

/**
 * The selected channels that would publish a file the backend reported gone.
 * A channel publishes its own customised values, or the global ones.
 */
export const channelsWithMissingMedia = (
  state: MissingMediaState
): string[] => {
  const missing = state.missingMedia || {};
  if (!Object.keys(missing).length) {
    return [];
  }

  return (state.selectedIntegrations || [])
    .filter(({ integration }) => {
      const own = (state.internal || []).find(
        (p) => p.integration.id === integration.id
      )?.integrationValue;
      const values = own?.length ? own : state.global || [];
      return values.some((value) =>
        (value?.media || []).some((media) => !!missing[media?.path || ''])
      );
    })
    .map(({ integration }) => integration.id);
};

// GET /posts/group/:group sends `image` parsed; the Post type says string
const imagesOf = (image: unknown): Array<{ path?: string }> => {
  if (Array.isArray(image)) {
    return image;
  }
  try {
    const parsed = typeof image === 'string' ? JSON.parse(image) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Every media path of an opened post, comments included. */
export const existingMediaPaths = (
  posts: Array<{ image?: unknown }> = []
): string[] =>
  (posts || []).flatMap((post) =>
    imagesOf(post?.image)
      .map((image) => image?.path)
      .filter((path): path is string => !!path)
  );

/**
 * Asks POST /posts/missing-media which of these paths are our own uploads
 * that no longer exist. Any failure answers "none": the backend refuses the
 * publish itself, so a check that could not run never blocks the user here.
 */
export const checkMissingMedia = async (
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  paths: string[]
): Promise<string[]> => {
  if (!paths.length) {
    return [];
  }
  try {
    const response = await fetch('/posts/missing-media', {
      method: 'POST',
      body: JSON.stringify({ paths }),
    });
    if (!response?.ok) {
      return [];
    }
    const { missing } = await response.json();
    return Array.isArray(missing)
      ? missing.filter((path: unknown) => typeof path === 'string')
      : [];
  } catch {
    return [];
  }
};

/**
 * Checks the opened post's files once, and any file whose preview fails to
 * load later (a library pick that was purged too). Each path is asked once.
 */
export const useMissingMediaCheck = (
  initialPaths: string[],
  enabled: boolean
) => {
  const fetch = useFetch();
  const { mediaLoadErrors, addMissingMedia } = useLaunchStore(
    useShallow((state) => ({
      mediaLoadErrors: state.mediaLoadErrors,
      addMissingMedia: state.addMissingMedia,
    }))
  );
  const asked = useRef(new Set<string>());
  const alive = useRef(true);

  const check = useCallback(
    async (paths: string[]) => {
      const fresh = paths.filter((path) => !!path && !asked.current.has(path));
      if (!enabled || !fresh.length) {
        return;
      }
      fresh.forEach((path) => asked.current.add(path));
      const missing = await checkMissingMedia(fetch, fresh);
      if (alive.current && missing.length) {
        addMissingMedia(missing);
      }
    },
    [enabled, fetch, addMissingMedia]
  );

  useEffect(() => {
    alive.current = true;
    check(initialPaths);
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    check(Object.keys(mediaLoadErrors));
  }, [mediaLoadErrors, check]);
};
