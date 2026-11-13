'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Tooltip, TooltipRefProps } from 'react-tooltip';

// A tap on a touch screen fires a synthetic mouseover, and nothing fires the
// matching mouseout, so the tooltip stayed up after the tap and covered the
// neighbouring avatars and editor tools. On a device that cannot hover it
// still opens on a tap (some, like the X post cap badge, carry the only
// explanation), but closes on the next tap elsewhere, on scroll, or after
// TOUCH_HIDE_MS.
const HOVER_QUERY = '(hover: hover) and (pointer: fine)';
export const TOUCH_HIDE_MS = 2500;

export function canHover(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(HOVER_QUERY).matches;
}

function subscribe(onChange: () => void) {
  const query = typeof window === 'undefined' ? null : window.matchMedia?.(HOVER_QUERY);
  query?.addEventListener?.('change', onChange);
  return () => query?.removeEventListener?.('change', onChange);
}

export const ToolTip = () => {
  const hover = useSyncExternalStore(subscribe, canHover, () => true);
  const ref = useRef<TooltipRefProps>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (hover) return <Tooltip className="z-[200]" id="tooltip" />;
  return (
    <Tooltip
      ref={ref}
      className="z-[200]"
      id="tooltip"
      globalCloseEvents={{ clickOutsideAnchor: true, scroll: true, resize: true, escape: true }}
      afterShow={() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => ref.current?.close(), TOUCH_HIDE_MS);
      }}
    />
  );
};
