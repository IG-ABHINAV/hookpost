'use client';

import { FC, useEffect, useRef } from 'react';
import {
  useVideoFailed,
  VideoUnavailable,
} from '@hookpost/react/helpers/video.unavailable';
export const VideoFrame: FC<{
  url: string;
  autoplay?: boolean;
  // Told once the video turns out not to load (the composer then asks the
  // backend whether the file is gone)
  onUnavailable?: () => void;
}> = (props) => {
  const { url, onUnavailable } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const { failed, onError } = useVideoFailed(url, videoRef);
  useEffect(() => {
    if (failed) {
      onUnavailable?.();
    }
  }, [failed]);
  if (failed) {
    return <VideoUnavailable compact={true} />;
  }
  return (
    <video
      ref={videoRef}
      className="w-full h-full object-cover rounded-[4px]"
      src={url + '#t=0.1'}
      preload="metadata"
      autoPlay={!!props?.autoplay}
      onError={onError}
    />
  );
};
