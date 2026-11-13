'use client';

import { FC, RefObject, useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { useT } from '@hookpost/react/translation/get.transation.service.client';

/**
 * Tracks whether a <video> failed to load. Videos of published posts are
 * removed from storage a week after publishing (scripts/cleanup-expired-media.js),
 * and a <video> pointing at a missing file renders as an empty black box.
 * The error can fire before hydration on a server-rendered page, so the
 * element's own error state is checked once on mount as well.
 */
export const useVideoFailed = (
  src: string,
  ref: RefObject<HTMLVideoElement | null>
) => {
  const [failedSrc, setFailedSrc] = useState('');

  useEffect(() => {
    if (ref.current?.error) {
      setFailedSrc(src);
    }
  }, [src]);

  return {
    failed: !!src && failedSrc === src,
    onError: () => setFailedSrc(src),
  };
};

export const VideoUnavailable: FC<{ compact?: boolean; className?: string }> = ({
  compact,
  className,
}) => {
  const t = useT();
  const text = t(
    'video_unavailable_reupload',
    'Video unavailable. It may have expired; re-upload it to use it again.'
  );

  return (
    <div
      role="img"
      aria-label={text}
      title={text}
      className={clsx(
        'w-full h-full flex flex-col items-center justify-center gap-[8px] text-center bg-gray-500/10 text-gray-500 overflow-hidden',
        compact ? 'rounded-[4px]' : 'min-h-[120px] p-[12px] text-[13px]',
        className
      )}
    >
      <svg
        width={compact ? 16 : 24}
        height={compact ? 16 : 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0"
      >
        <path d="M10.66 6H14a2 2 0 0 1 2 2v2.34l1 1L22 8v8" />
        <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2l10 10Z" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
      {!compact && <div>{text}</div>}
    </div>
  );
};
