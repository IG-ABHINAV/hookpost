'use client';

import { FC, useEffect } from 'react';
import {
  reportClientEvent,
  SPINNER_STUCK_MS,
} from '@hookpost/frontend/components/layout/client.event';

const Spinner: FC<{
  type?: string;
  color?: string;
  width?: number;
  height?: number;
}> = ({ color = 'var(--hp-primary)', width = 100, height = 100 }) => {
  const size = Math.min(width, height);
  const borderWidth = Math.max(2, Math.round(size / 8));

  return (
    <div
      style={{
        width: size,
        height: size,
        border: `${borderWidth}px solid transparent`,
        borderTopColor: color,
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }}
    />
  );
};

export { Spinner as default };

export const LoadingComponent: FC<{
  width?: number;
  height?: number;
}> = (props) => {
  // A page-level spinner still on screen after 15 s is a failure the person
  // is looking at (the 7 Oct Google sign-up spun forever and nobody knew).
  useEffect(() => {
    const timer = setTimeout(
      () => reportClientEvent('spinner_stuck', { ms: SPINNER_STUCK_MS }),
      SPINNER_STUCK_MS
    );
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex-1 flex justify-center pt-[100px]">
      <Spinner
        color="var(--hp-primary)"
        width={props.width || 100}
        height={props.height || 100}
      />
    </div>
  );
};
