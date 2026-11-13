/**
 * One connect at a time. Nothing changed on screen while a connect link
 * loaded, so people tapped again: org d4ad9404 opened Instagram's connect 5
 * times in 5 s (22 Oct) and a Razorpay reviewer pressed "Continue with
 * Google" 4 times in 2 s (18 Oct), each a new OAuth state and navigation. On
 * a phone the Instagram requirement was a hover tooltip nobody could see.
 *   pnpm exec jest -c apps/frontend/jest.config.ts add.provider.inflight
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

const mockConnectLink = jest.fn();
const mockToast = jest.fn();
const mockFetch = jest.fn();
jest.mock('@hookpost/frontend/components/launches/use.connect.link', () => ({
  useConnectLink: () => mockConnectLink,
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: jest.fn(), closeAll: jest.fn(), closeCurrent: jest.fn() }),
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({ isGeneral: true, extensionId: '' }),
}));
jest.mock('@hookpost/react/toaster/toaster', () => ({
  useToaster: () => ({ show: mockToast }),
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ admin: false, email: 'rk@gmail.com' }),
}));
jest.mock('@hookpost/frontend/components/launches/web3/web3.list', () => ({
  web3List: [],
}));
jest.mock('@hookpost/frontend/components/launches/helpers/top.title.component', () => ({
  TopTitle: () => null,
}));
jest.mock('@hookpost/react/form/input', () => ({ Input: () => null }));
jest.mock('@hookpost/react/form/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) =>
    React.createElement('button', { type: 'submit' }, children),
}));

import {
  AddProviderButton,
  AddProviderComponent,
} from '@hookpost/frontend/components/launches/add.provider.component';
import { GoogleProvider } from '@hookpost/frontend/components/auth/providers/google.provider';

const INSTAGRAM = {
  identifier: 'instagram',
  name: 'Instagram\n(Facebook Business)',
  toolTip: 'Instagram must be business and connected to a Facebook page',
  isExternal: false,
  isWeb3: false,
};
const X = { identifier: 'x', name: 'X', isExternal: false, isWeb3: false };

const setTouch = (touch: boolean) => {
  (window as any).matchMedia = (query: string) => ({
    matches: touch && query === '(hover: none)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
};

const openAddChannel = () =>
  render(
    React.createElement(AddProviderComponent, {
      social: [INSTAGRAM, X],
      article: [],
      invite: false,
    } as any)
  );

const tile = (name: RegExp) =>
  screen.getAllByRole('button').find((b) => name.test(b.textContent || ''))!;

beforeEach(() => {
  jest.clearAllMocks();
  setTouch(false);
});

describe('Add Channel tiles', () => {
  it('a double tap starts one connect, and the tapped tile shows a spinner', async () => {
    mockConnectLink.mockReturnValue(new Promise(() => undefined));
    openAddChannel();
    await act(async () => {
      fireEvent.click(tile(/Instagram/));
      fireEvent.click(tile(/Instagram/));
      fireEvent.click(tile(/^X$/));
    });
    expect(mockConnectLink).toHaveBeenCalledTimes(1);
    expect(mockConnectLink.mock.calls[0][0]).toMatch(/^\/integrations\/social\/instagram/);
    expect(tile(/Instagram/).getAttribute('aria-busy')).toBe('true');
  });

  it('a connect that failed frees the tiles for another try', async () => {
    mockConnectLink.mockResolvedValue(null);
    openAddChannel();
    await act(async () => {
      fireEvent.click(tile(/Instagram/));
    });
    await act(async () => {
      fireEvent.click(tile(/Instagram/));
    });
    expect(mockConnectLink).toHaveBeenCalledTimes(2);
    expect(tile(/Instagram/).getAttribute('aria-busy')).toBe('false');
  });

  it('leaving for the provider remembers the connect, so a return without a channel can be noticed', async () => {
    window.sessionStorage.clear();
    mockConnectLink.mockResolvedValue('https://www.linkedin.com/oauth/v2/authorization?state=s');
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      openAddChannel();
      await act(async () => {
        fireEvent.click(tile(/^X$/));
      });
    } finally {
      error.mockRestore();
    }
    expect(JSON.parse(window.sessionStorage.getItem('hp_connect_attempt')!)).toMatchObject({
      provider: 'x',
    });
  });

  it('on a touch screen the Instagram requirement is written on the tile', () => {
    setTouch(true);
    openAddChannel();
    expect(
      screen.getByText('Instagram must be business and connected to a Facebook page')
    ).toBeTruthy();
  });

  it('with a mouse it stays a hover tooltip', () => {
    openAddChannel();
    expect(
      screen.queryByText('Instagram must be business and connected to a Facebook page')
    ).toBeNull();
    expect(tile(/Instagram/).getAttribute('data-tooltip-content')).toBe(INSTAGRAM.toolTip);
  });
});

describe('Continue with Google', () => {
  it('a double tap asks for one sign-in link', async () => {
    mockFetch.mockReturnValue(new Promise(() => undefined));
    render(React.createElement(GoogleProvider));
    const button = screen.getByRole('button', { name: 'Continue with Google' });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });
});

// 21 Oct: the first trial customer spent 13 minutes in the phone layout
// without opening Add Channel (a grey button), then switched Chrome to
// "Desktop site" and connected within a minute.
describe('Add Channel with no channel yet', () => {
  it('is the primary button and says what to do', () => {
    render(React.createElement(AddProviderButton, { primary: true }));
    const button = screen.getByText('Connect your first channel').closest('button')!;
    expect(button.className).toContain('bg-btnPrimary');
    expect(button.className).not.toContain('bg-btnSimple');
  });

  it('once there are channels it is the usual Add Channel', () => {
    render(React.createElement(AddProviderButton, {}));
    const button = screen.getByText('Add Channel').closest('button')!;
    expect(button.className).toContain('bg-btnSimple');
    expect(screen.queryByText('Connect your first channel')).toBeNull();
  });
});
