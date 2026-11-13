'use client';

import { useEffect, useState } from 'react';

/**
 * True from `px` wide up. It is read synchronously on the first render (these
 * trees are only rendered in the browser, after the user has loaded) so a
 * desktop window never paints the phone layout for a frame.
 */
export const useMinWidth = (px: number) => {
  const query = `(min-width: ${px}px)`;
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
};
