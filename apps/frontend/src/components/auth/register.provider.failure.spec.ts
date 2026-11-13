/**
 * Back from Google on /auth?provider=google&code=...: a failed
 * /auth/oauth/GOOGLE/exists shows why, "Continue with Google" again and the
 * email form, instead of a spinner that never stops. On 7 Oct a visitor's
 * Google sign-up 500'd and the page spun forever (no account was created);
 * a reload of a finished sign-up (a spent code) did the same on 18 Oct.
 *   pnpm exec jest -c apps/frontend/jest.config.ts register.provider.failure
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';

const mockFetch = jest.fn();
let mockQuery = new URLSearchParams();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => mockQuery,
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({
    isGeneral: true,
    genericOauth: false,
    neynarClientId: '',
    appleClientId: '',
    billingEnabled: true,
  }),
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/helpers/utils/use.fire.events', () => ({
  useFireEvents: () => jest.fn(),
}));
jest.mock('@hookpost/react/helpers/use.track', () => ({
  useTrack: () => jest.fn(),
}));
jest.mock('@hookpost/frontend/components/auth/in-app-browser-notice', () => ({
  InAppBrowserNotice: () => null,
  useIsInAppBrowser: () => false,
}));
jest.mock('@hookpost/react/form/input', () => ({ Input: () => null }));
jest.mock('@hookpost/react/form/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'submit' }, children),
}));
jest.mock('@hookpost/frontend/components/auth/providers/farcaster.provider', () => ({
  FarcasterProvider: () => null,
}));
jest.mock('@hookpost/frontend/components/auth/providers/apple.provider', () => ({
  AppleProvider: () => null,
}));
jest.mock('@hookpost/frontend/components/auth/providers/oauth.provider', () => ({
  OauthProvider: () => null,
}));
jest.mock('@hookpost/frontend/components/auth/providers/github.provider', () => ({
  GithubProvider: () => null,
}));
const mockReport = jest.fn();
jest.mock('@hookpost/frontend/components/layout/client.event', () => ({
  reportClientEvent: (...args: unknown[]) => mockReport(...args),
  SPINNER_STUCK_MS: 15000,
}));

import { Register } from '@hookpost/frontend/components/auth/register';

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery = new URLSearchParams('provider=google&code=spent-code&state=s1');
});

describe('Register after a Google login', () => {
  it('a 400 shows the reason, Continue with Google again and the email form, not a spinner', async () => {
    mockFetch.mockResolvedValue(
      response(400, {
        statusCode: 400,
        message:
          'This Google sign-in link expired or was already used. Please continue with Google again.',
      })
    );
    render(React.createElement(Register));
    await waitFor(() =>
      expect(screen.getByText('That sign-in did not finish')).toBeTruthy()
    );
    expect(screen.getByText(/expired or was already used/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeTruthy();
    expect(
      screen.getByText('Sign up with your email instead').getAttribute('href')
    ).toBe('/auth');
    expect(mockReport).toHaveBeenCalledWith('signup_error', {
      provider: 'google',
      reason: expect.stringContaining('400'),
    });
  });

  it('a 500 with no message, or no network, still says something and offers a way on', async () => {
    mockFetch.mockResolvedValue(response(500, {}));
    const { unmount } = render(React.createElement(Register));
    await waitFor(() =>
      expect(
        screen.getByText(
          'Signing in did not finish. Please try again, or sign up with your email.'
        )
      ).toBeTruthy()
    );
    unmount();

    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render(React.createElement(Register));
    await waitFor(() =>
      expect(screen.getByText('That sign-in did not finish')).toBeTruthy()
    );
  });

  it('a new Google user still gets the sign-up form', async () => {
    mockFetch.mockResolvedValue(response(200, { token: 'google-access-token' }));
    render(React.createElement(Register));
    await waitFor(() => expect(screen.getByText('Sign Up')).toBeTruthy());
    expect(screen.queryByText('That sign-in did not finish')).toBeNull();
    expect(mockReport).not.toHaveBeenCalled();
  });
});
