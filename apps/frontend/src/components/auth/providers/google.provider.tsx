'use client';

import { useCallback } from 'react';
import { useFetch } from '@hookpost/helpers/utils/custom.fetch';
import { useT } from '@hookpost/react/translation/get.transation.service.client';
import { useSingleFlight } from '@hookpost/frontend/components/launches/single.flight';
export const GoogleProvider = () => {
  const fetch = useFetch();
  const t = useT();
  // One sign-in at a time: nothing changed on screen while the link loaded,
  // so a Razorpay reviewer pressed this 4 times in 2 s (18 Oct), each one a
  // new OAuth state and a new navigation.
  const { pending, run } = useSingleFlight();
  const fetchLink = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch('/auth/oauth/GOOGLE');
      if (res.ok) {
        const link = await res.text();
        if (link && (link.startsWith('https://') || link.startsWith('http://'))) {
          window.location.href = link;
          return true;
        }
      }
    } catch (e) {
      console.warn('Configured fetch failed, falling back to direct API', e);
    }

    try {
      const directRes = await window.fetch('/api/auth/oauth/GOOGLE');
      if (directRes.ok) {
        const link = await directRes.text();
        if (link && (link.startsWith('https://') || link.startsWith('http://'))) {
          window.location.href = link;
          return true;
        }
      }
    } catch (err) {
      console.error('Failed to get Google OAuth link:', err);
    }
    return false;
  }, [fetch]);
  const gotoLogin = useCallback(() => run('google', fetchLink), [run, fetchLink]);
  const busy = pending === 'google';
  const label = t('continue_with_google', 'Continue with Google');
  // A real button (type="button": it sits inside the sign-up and login forms)
  // with its own name. It was a bare div whose only text, "Google", was hidden
  // below 401px, so on a phone screen readers announced nothing and sighted
  // visitors saw an unlabelled logo. flex-[2]: next to the icon-sized wallet
  // button on the login form the full label still fits on one line at 375px.
  return (
    <button
      type="button"
      onClick={gotoLogin}
      aria-label={label}
      aria-busy={busy}
      className={`cursor-pointer flex-[2] bg-white h-[52px] rounded-[10px] flex justify-center items-center text-[#0E0E0E] gap-[8px] px-[12px] text-[14px] font-[500] ${
        busy ? 'opacity-70 cursor-wait' : ''
      }`}
    >
      <div aria-hidden="true" className="shrink-0">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 48 48"
          width="21px"
          height="21px"
        >
          <path
            fill="#FFC107"
            d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
          />
          <path
            fill="#FF3D00"
            d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
          />
          <path
            fill="#4CAF50"
            d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
          />
          <path
            fill="#1976D2"
            d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"
          />
        </svg>
      </div>
      <span className="whitespace-nowrap">{label}</span>
      {busy && (
        <span
          aria-hidden="true"
          className="shrink-0 w-[14px] h-[14px] rounded-full border-2 border-black/20 border-t-black/70 animate-spin"
        />
      )}
    </button>
  );
};
