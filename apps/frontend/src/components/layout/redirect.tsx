'use client';

import { FC, useEffect } from 'react';
import { useRouter } from 'next/navigation';
export const Redirect: FC<{
  url: string;
  delay: number;
  /** Replace the current history entry, so Back does not return here. */
  replace?: boolean;
}> = (props) => {
  const { url, delay, replace } = props;
  const router = useRouter();
  useEffect(() => {
    setTimeout(() => {
      if (replace) router.replace(url);
      else router.push(url);
    }, delay);
  }, []);
  return null;
};
