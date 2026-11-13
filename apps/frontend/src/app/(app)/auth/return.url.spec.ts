/**
 * returnUrl is taken from a link anyone can craft and is followed after
 * sign-in, so only a path on this site may be stored or followed.
 *   pnpm exec jest -c apps/frontend/jest.config.ts return.url
 */
import { createElement } from 'react';
import { render, renderHook } from '@testing-library/react';

const mockParams: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockParams.current,
}));

import ReturnUrlComponent, {
  safeReturnPath,
  useReturnUrl,
} from '@hookpost/frontend/app/(app)/auth/return.url.component';
import { oneTapDestination } from '@hookpost/frontend/components/auth/google-one-tap';

describe('safeReturnPath', () => {
  it('keeps a same-origin URL as a path', () => {
    expect(safeReturnPath('https://hookpost.hookstep.in/p/abc?share=true#c')).toBe(
      '/p/abc?share=true#c'
    );
    expect(safeReturnPath('/p/abc?share=true')).toBe('/p/abc?share=true');
    // What proxy.ts sends a signed-out /billing visit to the login form with.
    expect(safeReturnPath('/billing')).toBe('/billing');
    expect(safeReturnPath('/billing?plan=standard')).toBe('/billing?plan=standard');
  });

  it.each([
    "javascript:fetch('/api/user/self')//http",
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'https://evil.example/login',
    'http://hookpost.hookstep.in/p/abc',
    '//evil.example/login',
    '/\\evil.example/login',
    '',
    null,
    undefined,
  ])('rejects %p', (url) => {
    expect(safeReturnPath(url as any)).toBeNull();
  });

  it('never returns a protocol-relative path', () => {
    expect(safeReturnPath('https://hookpost.hookstep.in//evil.example/x')).toBe(
      '/evil.example/x'
    );
  });
});

describe('ReturnUrlComponent and getAndClear', () => {
  beforeEach(() => localStorage.clear());

  it('stores a same-origin returnUrl as a path', () => {
    mockParams.current = new URLSearchParams({
      returnUrl: 'https://hookpost.hookstep.in/p/abc',
    });
    render(createElement(ReturnUrlComponent));
    expect(localStorage.getItem('returnUrl')).toBe('/p/abc');
  });

  it('does not store a javascript: or off-site returnUrl', () => {
    mockParams.current = new URLSearchParams({
      returnUrl: 'javascript:void(0)//http',
    });
    render(createElement(ReturnUrlComponent));
    expect(localStorage.getItem('returnUrl')).toBeNull();

    mockParams.current = new URLSearchParams({
      returnUrl: 'https://evil.example/login',
    });
    render(createElement(ReturnUrlComponent));
    expect(localStorage.getItem('returnUrl')).toBeNull();
  });

  it('drops an unsafe value already sitting in localStorage', () => {
    localStorage.setItem('returnUrl', 'javascript:alert(1)//http');
    const { result } = renderHook(() => useReturnUrl());
    expect(result.current.getAndClear()).toBeNull();
    expect(localStorage.getItem('returnUrl')).toBeNull();
  });

  it('returns and clears a stored path', () => {
    localStorage.setItem('returnUrl', '/p/abc');
    const { result } = renderHook(() => useReturnUrl());
    expect(result.current.getAndClear()).toBe('/p/abc');
    expect(localStorage.getItem('returnUrl')).toBeNull();
  });
});

describe('One Tap on /auth/login?returnUrl=/billing', () => {
  beforeEach(() => localStorage.clear());

  const afterLogin = (body: unknown) => {
    const { result } = renderHook(() => useReturnUrl());
    return oneTapDestination(body, result.current.getAndClear());
  };

  it('sends a returning account back to the page it came from', () => {
    mockParams.current = new URLSearchParams({ returnUrl: '/billing' });
    render(createElement(ReturnUrlComponent));
    expect(afterLogin({ login: true, registered: false })).toBe('/billing');
    expect(localStorage.getItem('returnUrl')).toBeNull();
  });

  it('goes to the calendar when there is no safe returnUrl', () => {
    expect(afterLogin({ login: true })).toBe('/launches');
    localStorage.setItem('returnUrl', 'https://evil.example/billing');
    expect(afterLogin({ login: true })).toBe('/launches');
  });

  it('still sends a brand-new account to the onboarding', () => {
    localStorage.setItem('returnUrl', '/billing');
    expect(afterLogin({ login: true, registered: true })).toBe(
      '/launches?onboarding=true'
    );
  });
  it('sends a brand-new account from an app asking for access back to the consent screen', () => {
    const authorize =
      '/oauth/authorize?response_type=code&client_id=pcd_abc&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback&code_challenge=xyz&state=s1';
    mockParams.current = new URLSearchParams({ returnUrl: authorize });
    render(createElement(ReturnUrlComponent));
    expect(afterLogin({ login: true, registered: true })).toBe(authorize);
    expect(localStorage.getItem('returnUrl')).toBeNull();
  });
});
