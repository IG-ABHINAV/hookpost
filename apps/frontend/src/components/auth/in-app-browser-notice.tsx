'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attributionFromDocument,
  chromeIntentUrl,
  IN_APP_NAMES,
  InAppBrowser,
  inAppBrowser,
  urlWithAttribution,
} from '@hookpost/helpers/utils/attribution';

/**
 * Google refuses OAuth inside embedded/in-app browsers (it answers
 * `disallowed_useragent` and shows "This browser or app may not be secure").
 * Every Meta ad opens its link in Facebook's or Instagram's in-app browser,
 * and LinkedIn and TikTok do the same, so paid traffic lands in exactly the
 * place Google sign-in cannot work.
 *
 * Measured on the live NGINX logs, 18-20 Sep 2026:
 *   2,008 of 2,250 Meta ad requests (89%) carried FB_IAB/FBAV
 *   6 people tapped "Continue with Google" - all 6 from FB_IAB
 *   0 of them ever reached the OAuth callback
 * And in Oct 2026 phone sign-ups from outside the team stayed rare.
 *
 * So, in an in-app browser: hide Google, lead with the email form, and offer
 * the way out, "Open in your browser": the exact address (with the ad's utm
 * tags, so the other browser records the same first touch), a Copy link
 * button, and on Android an Open in Chrome button. Opening Chrome happens
 * only when the visitor taps it, never by itself.
 */

/** Which app's built-in browser this is, once mounted (null on the server). */
export const useInAppBrowser = (): InAppBrowser | null => {
  const [app, setApp] = useState<InAppBrowser | null>(null);
  useEffect(() => {
    setApp(inAppBrowser(navigator.userAgent));
  }, []);
  return app;
};

export const useIsInAppBrowser = () => !!useInAppBrowser();

/** This page's address, plus the first-touch tags it lost on the way. */
const shareableUrl = () =>
  urlWithAttribution(window.location.href, attributionFromDocument());

async function copyText(text: string, fallback: HTMLInputElement | null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some in-app browsers refuse the clipboard API: select and copy.
  }
  try {
    if (fallback) {
      fallback.focus();
      fallback.select();
      fallback.setSelectionRange(0, text.length);
    }
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * "Open in your browser": the address to open, a Copy link button, and on
 * Android a button that hands the page to Chrome. Renders nothing outside an
 * in-app browser.
 *
 * variant "card" sits above the sign-up and login forms; "bar" is the strip
 * at the top of the marketing pages, above every call to action.
 */
export const OpenInBrowserPrompt = ({
  variant = 'card',
  mode = 'signup',
}: {
  variant?: 'card' | 'bar';
  mode?: 'signup' | 'login';
}) => {
  const app = useInAppBrowser();
  const [url, setUrl] = useState('');
  const [isAndroid, setIsAndroid] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!app) return;
    const ua = navigator.userAgent || '';
    setIsAndroid(/Android/i.test(ua));
    setIsIOS(/iPhone|iPad|iPod/i.test(ua));
    setUrl(shareableUrl());
  }, [app]);

  const copy = useCallback(async () => {
    const ok = await copyText(url, input.current);
    setCopied(ok ? 'yes' : 'no');
  }, [url]);

  if (!app || dismissed) return null;
  const name = IN_APP_NAMES[app];
  const menuHint = isIOS
    ? 'tap ••• and choose “Open in browser” (or “Open in Safari”)'
    : 'tap ⋮ and choose “Open in browser”';

  const actions = (
    <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
      {isAndroid && (
        <a
          href={chromeIntentUrl(url)}
          data-testid="open-in-chrome"
          className="inline-flex h-[40px] items-center justify-center rounded-[8px] bg-white px-[14px] text-[13px] font-[600] text-black"
        >
          Open in Chrome
        </a>
      )}
      <button
        type="button"
        onClick={copy}
        className="inline-flex h-[40px] items-center justify-center rounded-[8px] border border-white/40 px-[14px] text-[13px] font-[600] text-hp-text"
      >
        {copied === 'yes' ? 'Link copied' : 'Copy link'}
      </button>
    </div>
  );

  const address = (
    <input
      ref={input}
      readOnly
      value={url}
      aria-label="Link to this page"
      onFocus={(e) => e.currentTarget.select()}
      className="mt-[8px] w-full rounded-[6px] border border-hp-border-strong bg-hp-bg/30 px-[10px] py-[8px] font-mono text-[12px] text-hp-text"
    />
  );

  if (variant === 'bar') {
    return (
      <div
        role="region"
        aria-label="Open in your browser"
        data-testid="open-in-browser"
        className="relative z-[60] w-full border-b border-amber-500/40 bg-[#2a1f05] px-[16px] py-[12px] text-[13px] leading-[1.5] text-amber-100"
      >
        <div className="mx-auto max-w-[1280px]">
          <div className="flex items-start justify-between gap-[12px]">
            <div>
              <div className="font-[600]">Open in your browser</div>
              <div className="opacity-90">
                You&apos;re in {name}&apos;s built-in browser, where Google sign-in
                doesn&apos;t work. Open this page in your browser ({menuHint}), or
                sign up with your email here.
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setDismissed(true)}
              className="shrink-0 px-[6px] text-[18px] leading-none opacity-70"
            >
              ×
            </button>
          </div>
          {address}
          {actions}
          {copied === 'no' && (
            <div className="mt-[6px] opacity-90">Press and hold the address above to copy it.</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="open-in-browser"
      className="mb-[16px] rounded-[8px] border border-amber-500/40 bg-amber-500/10 px-[14px] py-[12px] text-[13px] leading-[1.5] text-amber-100"
    >
      <div className="font-[600] mb-[4px]">
        {mode === 'signup' ? 'Sign up with your email below' : 'Google sign-in won’t work here'}
      </div>
      <div className="opacity-90">
        Google sign-in doesn&apos;t work in {name}&apos;s built-in browser. To use
        Google instead, open this page in your browser ({menuHint}):
      </div>
      {address}
      {actions}
      {copied === 'no' && (
        <div className="mt-[6px] opacity-90">Press and hold the address above to copy it.</div>
      )}
    </div>
  );
};

/** The /auth and /auth/login card (kept under its old name for callers). */
export const InAppBrowserNotice = ({ mode = 'signup' }: { mode?: 'signup' | 'login' }) => (
  <OpenInBrowserPrompt variant="card" mode={mode} />
);
