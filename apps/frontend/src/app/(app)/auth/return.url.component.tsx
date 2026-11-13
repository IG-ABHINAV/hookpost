'use client';

import { useSearchParams } from 'next/navigation';
import { FC, useCallback, useEffect } from 'react';

// returnUrl comes from a query string anyone can link to, and after sign-in it
// is assigned to window.location.href. Only a path on this site may pass:
// a javascript: URL would run in our origin with the fresh session, and an
// absolute URL elsewhere would turn the login page into an open redirect.
export const safeReturnPath = (url?: string | null): string | null => {
  if (!url || typeof window === 'undefined') {
    return null;
  }
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) {
      return null;
    }
    // A leading '//' would be read as another host when assigned back.
    return (
      parsed.pathname.replace(/^\/+/, '/') + parsed.search + parsed.hash
    );
  } catch {
    return null;
  }
};

const ReturnUrlComponent: FC = () => {
  const params = useSearchParams();
  const url = params.get('returnUrl');
  useEffect(() => {
    const path = safeReturnPath(url);
    if (path) {
      localStorage.setItem('returnUrl', path);
    }
  }, [url]);
  return null;
};
export const useReturnUrl = () => {
  return {
    getAndClear: useCallback(() => {
      const data = localStorage.getItem('returnUrl');
      localStorage.removeItem('returnUrl');
      // Checked again so a value stored before this check existed is dropped.
      return safeReturnPath(data);
    }, []),
  };
};
export default ReturnUrlComponent;
