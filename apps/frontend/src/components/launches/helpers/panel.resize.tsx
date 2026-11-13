'use client';

import { FC, PointerEvent, useCallback, useEffect, useRef, useState } from 'react';

// The channel panel beside the calendar (lg and up) can be dragged wider or
// narrower from its right edge. 260px is the old fixed width; the chosen width
// is remembered per browser.
export const PANEL_DEFAULT = 260;
const PANEL_MIN = 220;
const PANEL_MAX = 480;
const STORAGE_KEY = 'channelsPanelWidth';

const clamp = (w: number) =>
  Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, w)));

const read = () => {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY));
    return v ? clamp(v) : PANEL_DEFAULT;
  } catch {
    return PANEL_DEFAULT;
  }
};

const save = (w: number) => {
  try {
    localStorage.setItem(STORAGE_KEY, String(w));
  } catch {
    // Private mode or blocked storage: the width just isn't remembered.
  }
};

export const usePanelWidth = () => {
  const [width, setWidth] = useState(PANEL_DEFAULT);
  // localStorage only exists in the browser, so start at the default on the
  // server and the first client render, then switch to the saved width.
  useEffect(() => setWidth(read()), []);
  const set = useCallback((w: number) => {
    const next = clamp(w);
    setWidth(next);
    save(next);
  }, []);
  return [width, set] as const;
};

export const PanelResizeHandle: FC<{
  width: number;
  onChange: (w: number) => void;
}> = ({ width, onChange }) => {
  const start = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    // The panel is on the left in LTR and on the right in RTL.
    const rtl = document.dir === 'rtl';
    const dx = e.clientX - start.current.x;
    onChange(start.current.w + (rtl ? -dx : dx));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize channels panel"
      aria-valuemin={PANEL_MIN}
      aria-valuemax={PANEL_MAX}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onChange(PANEL_DEFAULT)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') onChange(width - 16);
        if (e.key === 'ArrowRight') onChange(width + 16);
      }}
      className={
        'absolute top-0 end-[-3px] z-[2] h-full w-[6px] cursor-col-resize touch-none select-none ' +
        'after:absolute after:inset-y-0 after:start-[2px] after:w-[2px] after:transition-colors ' +
        (dragging
          ? 'after:bg-hp-primary'
          : 'after:bg-transparent hover:after:bg-hp-primary/60 focus-visible:after:bg-hp-primary/60')
      }
    />
  );
};
