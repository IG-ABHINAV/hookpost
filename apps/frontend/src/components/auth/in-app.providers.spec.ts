/**
 * The provider row on /auth and /auth/login inside an in-app browser
 * (Instagram, Facebook, LinkedIn...): only Google is hidden, because only
 * Google refuses OAuth there and the "Open in your browser" card names it.
 * Every other way in stays, so an account made with it can still sign in.
 *   pnpm exec jest -c apps/frontend/jest.config.ts in-app.providers
 */
import React from 'react';
import { render, screen } from '@testing-library/react';

const mockVariables: Record<string, unknown> = {};
const mockInApp = { value: true };
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
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@hookpost/frontend/components/auth/in-app-browser-notice', () => ({
  InAppBrowserNotice: () => null,
  useIsInAppBrowser: () => mockInApp.value,
}));
jest.mock('@hookpost/react/form/input', () => ({ Input: () => null }));
jest.mock('@hookpost/react/form/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'submit' }, children),
}));
const mockMarker = (name: string) => () =>
  React.createElement('button', { type: 'button' }, name);
jest.mock('@hookpost/frontend/components/auth/providers/google.provider', () => ({
  GoogleProvider: mockMarker('Continue with Google'),
}));
jest.mock('@hookpost/frontend/components/auth/providers/apple.provider', () => ({
  AppleProvider: mockMarker('Apple'),
}));
jest.mock('@hookpost/frontend/components/auth/providers/farcaster.provider', () => ({
  FarcasterProvider: mockMarker('Farcaster'),
}));
jest.mock('@hookpost/frontend/components/auth/providers/oauth.provider', () => ({
  OauthProvider: mockMarker('Generic OAuth'),
}));
jest.mock('@hookpost/frontend/components/auth/providers/github.provider', () => ({
  GithubProvider: mockMarker('GitHub'),
}));
jest.mock('@hookpost/frontend/components/auth/providers/wallet.provider', () => ({
  __esModule: true,
  default: mockMarker('Wallet'),
}));

import { Login } from '@hookpost/frontend/components/auth/login';
import { RegisterAfter } from '@hookpost/frontend/components/auth/register';

const setVariables = (v: Record<string, unknown>) => {
  for (const k of Object.keys(mockVariables)) delete mockVariables[k];
  Object.assign(mockVariables, {
    isGeneral: true,
    genericOauth: false,
    neynarClientId: '',
    appleClientId: '',
    billingEnabled: false,
    ...v,
  });
};
const button = (name: string) => screen.queryByRole('button', { name });

describe('in an in-app browser', () => {
  beforeEach(() => {
    mockInApp.value = true;
  });

  it('/auth/login hides Google and keeps the wallet sign-in (billing on, as in production)', () => {
    setVariables({ billingEnabled: true });
    const { container } = render(React.createElement(Login));
    expect(button('Continue with Google')).toBeNull();
    expect(button('Wallet')).not.toBeNull();
    expect(container.textContent).toContain('Continue With');
  });

  it('/auth/login keeps Apple and Farcaster when they are configured', () => {
    setVariables({ appleClientId: 'apple-id', neynarClientId: 'neynar-id' });
    render(React.createElement(Login));
    expect(button('Continue with Google')).toBeNull();
    expect(button('Apple')).not.toBeNull();
    expect(button('Farcaster')).not.toBeNull();
  });

  it('/auth/login with Google alone configured: no empty provider row', () => {
    setVariables({});
    const { container } = render(React.createElement(Login));
    expect(button('Continue with Google')).toBeNull();
    expect(container.textContent).not.toContain('Continue With');
  });

  it('/auth hides Google and keeps Apple when it is configured', () => {
    setVariables({ appleClientId: 'apple-id' });
    const { container } = render(React.createElement(RegisterAfter, { token: '', provider: '' }));
    expect(button('Continue with Google')).toBeNull();
    expect(button('Apple')).not.toBeNull();
    expect(container.textContent).toContain('Continue With');
  });

  it('/auth with Google alone configured leads with the email form', () => {
    setVariables({ billingEnabled: true });
    const { container } = render(React.createElement(RegisterAfter, { token: '', provider: '' }));
    expect(button('Continue with Google')).toBeNull();
    expect(container.textContent).not.toContain('Continue With');
  });
});

describe('in a real browser', () => {
  beforeEach(() => {
    mockInApp.value = false;
  });

  it('both pages offer Google', () => {
    setVariables({ billingEnabled: true });
    const login = render(React.createElement(Login));
    expect(button('Continue with Google')).not.toBeNull();
    login.unmount();
    render(React.createElement(RegisterAfter, { token: '', provider: '' }));
    expect(button('Continue with Google')).not.toBeNull();
  });
});
