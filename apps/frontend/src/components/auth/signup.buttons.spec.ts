/**
 * The sign-up screen's provider row: one labelled "Continue with Google"
 * button, and no Solana wallet button.
 *   pnpm exec jest -c apps/frontend/jest.config.ts signup.buttons
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

const mockVariables = {
  isGeneral: true,
  genericOauth: false,
  neynarClientId: '',
  appleClientId: '',
  // On in production; the wallet button used to follow it.
  billingEnabled: true,
};
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => mockVariables,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => jest.fn(),
}));
jest.mock('@hookpost/helpers/utils/use.fire.events', () => ({
  useFireEvents: () => jest.fn(),
}));
jest.mock('@hookpost/react/helpers/use.track', () => ({
  useTrack: () => jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
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
// Off in production (no client ids); their SDKs do not load in jsdom.
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
// Throws if the sign-up screen still pulls in the wallet sign-in.
jest.mock('@hookpost/frontend/components/auth/providers/wallet.provider', () => {
  throw new Error('the sign-up screen must not load the wallet provider');
});

import { RegisterAfter } from '@hookpost/frontend/components/auth/register';

describe('Sign-up provider buttons', () => {
  it('shows "Continue with Google" as a named, non-submitting button', () => {
    render(React.createElement(RegisterAfter, { token: '', provider: '' }));
    const google = screen.getByRole('button', { name: 'Continue with Google' });
    expect(google.getAttribute('type')).toBe('button');
    expect(google.textContent).toBe('Continue with Google');
  });

  it('has no wallet button, even with billing enabled', () => {
    const { container } = render(
      React.createElement(RegisterAfter, { token: '', provider: '' })
    );
    expect(container.textContent).not.toMatch(/wallet/i);
    expect(screen.queryByRole('button', { name: /wallet|solana/i })).toBeNull();
  });
});
