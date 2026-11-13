/**
 * "Open in your browser" (in-app-browser-notice.tsx): shown only inside
 * Instagram's, Facebook's, LinkedIn's and TikTok's (and similar) built-in
 * browsers, with this page's address plus the ad's utm tags, a Copy link
 * button, and on Android an Open in Chrome link that only a tap follows.
 *   pnpm exec jest -c apps/frontend/jest.config.ts in-app-browser-notice
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OpenInBrowserPrompt } from '@hookpost/frontend/components/auth/in-app-browser-notice';
import { chromeIntentUrl, urlWithAttribution } from '@hookpost/helpers/utils/attribution';

const UA = {
  instagramAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 Instagram 352.0.0.38.100 Android',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54',
  linkedinIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1456',
  tiktokAndroid:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/128.0 Mobile Safari/537.36 trill_360303 AppName/musical_ly ByteLocale/en BytedanceWebview/d8a21c6',
  facebookAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/484.0.0.47.109;]',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const setUA = (ua: string) =>
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });

const renderPrompt = async (props: Parameters<typeof OpenInBrowserPrompt>[0] = {}) => {
  await act(async () => {
    render(React.createElement(OpenInBrowserPrompt, props));
  });
};

beforeEach(() => {
  document.cookie = 'hp_attr=; Path=/; Max-Age=0';
  window.history.replaceState({}, '', '/auth');
});
afterEach(() => cleanup());

describe('OpenInBrowserPrompt', () => {
  it('renders nothing in a real browser', async () => {
    for (const ua of [UA.chromeMac, UA.chromeAndroid]) {
      setUA(ua);
      await renderPrompt({ variant: 'bar' });
      expect(screen.queryByTestId('open-in-browser')).toBeNull();
      cleanup();
    }
  });

  it.each([
    ['Instagram', UA.instagramAndroid],
    ['Facebook', UA.facebookAndroid],
    ['LinkedIn', UA.linkedinIos],
    ['TikTok', UA.tiktokAndroid],
  ])('names %s and says how to get out', async (name, ua) => {
    setUA(ua);
    await renderPrompt({ variant: 'bar' });
    const bar = screen.getByTestId('open-in-browser');
    expect(bar.textContent).toContain('Open in your browser');
    expect(bar.textContent).toContain(`${name}'s built-in browser`);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
  });

  it('the address keeps the ad\'s utm tags and its whole click id, even after they left the URL', async () => {
    setUA(UA.instagramAndroid);
    // As long as real fbclids get (201 characters in production's log).
    const fbclid = `IwZXh0bgNhZW0BMABhZGlk_${'aem_Ab1Cd2Ef3Gh4-'.repeat(12)}`.slice(0, 200);
    document.cookie = `hp_attr=${encodeURIComponent(
      JSON.stringify({ utm_source: 'meta', utm_campaign: 'hp_ww', fbclid, landing_path: '/claude' })
    )}; Path=/`;
    window.history.replaceState({}, '', '/auth?ref=nav');
    await renderPrompt();
    const input = screen.getByLabelText('Link to this page') as HTMLInputElement;
    const url = new URL(input.value);
    expect(url.pathname).toBe('/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ref: 'nav',
      utm_source: 'meta',
      utm_campaign: 'hp_ww',
      fbclid,
    });
  });

  it('Android: Open in Chrome is a link to tap, and nothing navigates by itself', async () => {
    setUA(UA.instagramAndroid);
    window.history.replaceState({}, '', '/pricing?utm_source=meta&utm_campaign=x');
    const before = window.location.href;
    await renderPrompt({ variant: 'bar' });
    const link = screen.getByTestId('open-in-chrome') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(chromeIntentUrl(before));
    expect(link.getAttribute('href')).toMatch(
      /^intent:\/\/[^#]+\/pricing\?utm_source=meta&utm_campaign=x#Intent;scheme=https?;package=com\.android\.chrome;S\.browser_fallback_url=/
    );
    expect(window.location.href).toBe(before);
  });

  it('iPhone: no Chrome link, the ••• menu instead', async () => {
    setUA(UA.instagramIos);
    await renderPrompt();
    expect(screen.queryByTestId('open-in-chrome')).toBeNull();
    expect(screen.getByTestId('open-in-browser').textContent).toContain('tap •••');
  });

  it('Copy link copies the address', async () => {
    setUA(UA.tiktokAndroid);
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    window.history.replaceState({}, '', '/start?utm_campaign=tt');
    await renderPrompt({ variant: 'bar' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/start?utm_campaign=tt`);
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeTruthy();
  });

  it('the bar can be dismissed', async () => {
    setUA(UA.facebookAndroid);
    await renderPrompt({ variant: 'bar' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    });
    expect(screen.queryByTestId('open-in-browser')).toBeNull();
  });
});

describe('urlWithAttribution', () => {
  it('adds only the tags the address lacks', () => {
    expect(
      urlWithAttribution('https://hookpost.hookstep.in/auth?utm_source=keep', {
        utm_source: 'meta',
        utm_medium: 'paid_social',
        landing_path: '/x',
      })
    ).toBe('https://hookpost.hookstep.in/auth?utm_source=keep&utm_medium=paid_social');
    expect(urlWithAttribution('https://hookpost.hookstep.in/', null)).toBe('https://hookpost.hookstep.in/');
  });
});
