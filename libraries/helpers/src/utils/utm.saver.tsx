'use client';

import { FC, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocalStorage } from '@mantine/hooks';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';
import { useFireEvents } from '@hookpost/helpers/utils/use.fire.events';
import { useTrack } from '@hookpost/react/helpers/use.track';
import { useUtmCapture } from '@hookpost/helpers/utils/utm.capture';

// For the app layouts, which mount the providers useFireEvents and useTrack
// need. Marketing pages mount UtmCapture instead (see utm.capture.tsx for why).
const UtmSaver: FC = () => {
  const searchParams = useSearchParams();
  const fireEvents = useFireEvents();
  const track = useTrack();

  useEffect(() => {
    if (searchParams.get('check')) {
      fireEvents('purchase');
      track(TrackEnum.StartTrial);
    }
  }, []);

  // After the effect above, so the effects still run in their original order.
  useUtmCapture();

  return <></>;
};

export const useUtmUrl = () => {
  const [value] = useLocalStorage({ key: 'utm', defaultValue: '' });
  return value || '';
};
export default UtmSaver;
