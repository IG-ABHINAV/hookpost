'use client';

import { FC, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocalStorage } from '@mantine/hooks';

/**
 * The attribution half of UtmSaver: records the first landing URL, the
 * referrer and the utm/ref tag in localStorage. Nothing else.
 *
 * Split out for the marketing pages. UtmSaver also fires the `?check=`
 * purchase events through useFireEvents and useTrack, and useFireEvents imports
 * posthog-js, so mounting UtmSaver in (landing)/layout.tsx shipped the whole
 * PostHog SDK (188KB raw, 61KB gzipped, nearly the size of react-dom) to
 * every marketing visitor. On those pages both calls were dead code anyway:
 * (landing) mounts no VariableContextComponent, so billingEnabled and
 * facebookPixel read their createContext defaults (false and '') and both
 * functions return before doing anything.
 *
 * Same keys and the same useLocalStorage (JSON) serialisation as before, so
 * useUtmUrl() in the app reads what a marketing page wrote.
 */
export const useUtmCapture = () => {
  const query = useSearchParams();
  const [value, setValue] = useLocalStorage({ key: 'utm', defaultValue: '' });

  useEffect(() => {
    const landingUrl = localStorage.getItem('landingUrl');
    if (landingUrl) {
      return;
    }

    localStorage.setItem('landingUrl', window.location.href);
    localStorage.setItem('referrer', document.referrer);
  }, []);

  useEffect(() => {
    const utm = query.get('utm_source') || query.get('utm') || query.get('ref');
    if (utm && !value) {
      setValue(utm);
    }
  }, [query, value]);
};

const UtmCapture: FC = () => {
  useUtmCapture();
  return null;
};

export default UtmCapture;
