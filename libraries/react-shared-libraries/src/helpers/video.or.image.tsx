'use client';

import { FC, useRef } from 'react';
import { clsx } from 'clsx';
import { hasExtension } from '@hookpost/helpers/utils/has.extension';
import {
  useVideoFailed,
  VideoUnavailable,
} from '@hookpost/react/helpers/video.unavailable';
export const VideoOrImage: FC<{
  src: string;
  autoplay: boolean;
  isContain?: boolean;
  imageClassName?: string;
  videoClassName?: string;
}> = (props) => {
  const { src, autoplay, isContain, imageClassName, videoClassName } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const { failed, onError } = useVideoFailed(src, videoRef);
  if (hasExtension(src, 'mp4')) {
    if (failed) {
      return <VideoUnavailable />;
    }
    return (
      <video
        ref={videoRef}
        src={src}
        autoPlay={autoplay}
        className={clsx('w-full h-full', videoClassName)}
        muted={true}
        loop={true}
        onError={onError}
      />
    );
  }
  return (
    <img
      className={clsx(
        isContain ? 'object-contain' : 'object-cover',
        'w-full h-full',
        imageClassName
      )}
      src={src}
    />
  );
};
