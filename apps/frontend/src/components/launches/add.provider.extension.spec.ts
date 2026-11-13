/**
 * Channels that need the Hookpost Chrome extension (Skool) are not offered
 * while this deployment has no EXTENSION_ID, and the "Extension Not Found"
 * dialog offers "Install Extension" only when there is a store listing to
 * open (it used to be a button that did nothing).
 *   pnpm exec jest -c apps/frontend/jest.config.ts add.provider.extension
 */
import React from 'react';

const mockCloseCurrent = jest.fn();
let mockVariables: { isGeneral: boolean; extensionId: string } = {
  isGeneral: true,
  extensionId: '',
};
jest.mock('@hookpost/frontend/components/launches/use.connect.link', () => ({
  useConnectLink: () => jest.fn(),
}));
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  useModals: () => ({ openModal: jest.fn(), closeAll: jest.fn(), closeCurrent: mockCloseCurrent }),
}));
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({ useFetch: () => jest.fn() }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => mockVariables,
}));
jest.mock('@hookpost/react/toaster/toaster', () => ({ useToaster: () => ({ show: jest.fn() }) }));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ admin: false, email: 'someone@gmail.com' }),
}));
jest.mock('@hookpost/frontend/components/launches/web3/web3.list', () => ({ web3List: [] }));
jest.mock('@hookpost/frontend/components/launches/helpers/top.title.component', () => ({
  TopTitle: () => null,
}));
jest.mock('@hookpost/react/form/input', () => ({ Input: () => null }));
jest.mock('@hookpost/react/form/button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { type: 'button', onClick }, children),
}));

import { fireEvent, render, screen } from '@testing-library/react';
import { AddProviderComponent } from '@hookpost/frontend/components/launches/add.provider.component';
import { needsMissingExtension } from '@hookpost/frontend/components/launches/add.channel.helpers';

const SKOOL = {
  identifier: 'skool',
  name: 'Skool',
  isExternal: false,
  isWeb3: false,
  isChromeExtension: true,
  extensionCookies: [{ name: 'auth_token', domain: '.skool.com' }],
};
const X = { identifier: 'x', name: 'X', isExternal: false, isWeb3: false };

const openAddChannel = () =>
  render(
    React.createElement(AddProviderComponent, {
      social: [SKOOL, X],
      article: [],
      invite: false,
    } as any)
  );

beforeEach(() => {
  jest.clearAllMocks();
  (window as any).matchMedia = () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
});

describe('needsMissingExtension', () => {
  it.each([
    [{ isChromeExtension: true }, '', true],
    [{ isChromeExtension: true }, undefined, true],
    [{ isChromeExtension: true }, 'abcdefghijklmnopabcdefghijklmnop', false],
    [{ isChromeExtension: false }, '', false],
    [{}, '', false],
  ])('%j with EXTENSION_ID %j -> %s', (item, id, hidden) => {
    expect(needsMissingExtension(item, id)).toBe(hidden);
  });
});

describe('Add Channel', () => {
  it('does not offer Skool while EXTENSION_ID is empty', () => {
    mockVariables = { isGeneral: true, extensionId: '' };
    openAddChannel();
    expect(screen.queryByText('Skool')).toBeNull();
    expect(screen.getByText('X')).toBeTruthy();
  });

  it('offers Skool once EXTENSION_ID is set', () => {
    mockVariables = { isGeneral: true, extensionId: 'abcdefghijklmnopabcdefghijklmnop' };
    openAddChannel();
    expect(screen.getByText('Skool')).toBeTruthy();
    expect(screen.getByText('X')).toBeTruthy();
  });
});

/** ExtensionNotFound, loaded fresh with NEXT_PUBLIC_CHROME_EXTENSION_URL = url. */
function loadExtensionNotFound(url: string | undefined) {
  const before = process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
  if (url === undefined) delete process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
  else process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL = url;
  try {
    let component: React.FC = () => null;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      component = require('@hookpost/frontend/components/launches/add.provider.component')
        .ExtensionNotFound;
    });
    return component;
  } finally {
    if (before === undefined) delete process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL;
    else process.env.NEXT_PUBLIC_CHROME_EXTENSION_URL = before;
  }
}

describe('Extension Not Found dialog', () => {
  const LISTING = 'https://chromewebstore.google.com/detail/hookpost/abcdefghijklmnopabcdefghijklmnop';

  it('has no Install Extension button while the extension is not in the store', () => {
    render(React.createElement(loadExtensionNotFound(undefined)));
    expect(screen.queryByText('Install Extension')).toBeNull();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('opens the store listing from Install Extension once it is', () => {
    const open = jest.spyOn(window, 'open').mockImplementation(() => null);
    try {
      render(React.createElement(loadExtensionNotFound(LISTING)));
      fireEvent.click(screen.getByText('Install Extension'));
      expect(open).toHaveBeenCalledWith(LISTING, '_blank', 'noopener,noreferrer');
      expect(mockCloseCurrent).toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });
});
