/**
 * The OAuth callback page for a connect an api.market subscriber started
 * (the backend answers `marketplace: true`): the channel is in their API
 * workspace, so the page ends on "connected, close this tab", never the
 * calendar, whoever is signed in to Hookpost in this browser, and a page pick
 * goes through the public endpoint, not the signed-in user's workspace.
 *   pnpm exec jest -c apps/frontend/jest.config.ts continue.integration.marketplace
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
}));
const mockFetch = jest.fn();
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
jest.mock('@hookpost/react/helpers/variable.context', () => ({
  useVariables: () => ({ extensionId: '', backendUrl: 'https://api.test' }),
}));
jest.mock(
  '@hookpost/frontend/components/new-launch/providers/continue-provider/list',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const R = require('react');
    return {
      continueProviderList: {
        youtube: (props: any) =>
          R.createElement('button', { onClick: () => props.onSave({ id: 'yt-channel-1' }) }, 'Pick channel'),
      },
    };
  }
);

import { ContinueIntegration } from '@hookpost/frontend/components/launches/continue.integration';
import { marketplaceConnectedMessage } from '@hookpost/frontend/components/launches/add.channel.helpers';

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const open = (provider: string, logged: boolean) =>
  render(
    React.createElement(ContinueIntegration, {
      provider,
      searchParams: { state: 'state-1', code: 'code-1' },
      logged,
    })
  );

beforeEach(() => jest.clearAllMocks());

describe('ContinueIntegration for an api.market connect', () => {
  it.each([
    ['signed in to Hookpost', true],
    ['not signed in', false],
  ])('%s: says connected and to close the tab, and never opens the calendar', async (_n, logged) => {
    mockFetch.mockResolvedValue(response(201, { id: 'channel-1', reconnected: false, marketplace: true }));
    open('linkedin', logged);
    await waitFor(() => expect(screen.getByText('Channel Connected!')).toBeTruthy());
    expect(screen.getByText(marketplaceConnectedMessage('LinkedIn'))).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('a page pick goes through the public endpoint even when signed in, then says close the tab', async () => {
    mockFetch
      .mockResolvedValueOnce(
        response(201, { id: 'placeholder-1', inBetweenSteps: true, pages: [{ id: 'yt-channel-1' }], marketplace: true })
      )
      .mockResolvedValueOnce(response(201, { success: true }));
    open('youtube', true);
    fireEvent.click(await screen.findByText('Pick channel'));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    expect(mockFetch.mock.calls[1][0]).toBe('/integrations/public/provider/placeholder-1/connect');
    await waitFor(() => expect(screen.getByText(marketplaceConnectedMessage('YouTube'))).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('a page list the platform did not return is an error, not a picker that needs a session', async () => {
    mockFetch.mockResolvedValue(
      response(201, { id: 'placeholder-1', inBetweenSteps: true, pages: [], pagesError: true, marketplace: true })
    );
    open('youtube', true);
    await waitFor(() => expect(screen.getByText(/couldn't load the list/)).toBeTruthy());
  });

  it('an ordinary connect, signed in, still goes back to the calendar', async () => {
    mockFetch.mockResolvedValue(response(201, { id: 'channel-1', reconnected: false }));
    open('linkedin', true);
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/launches?added=linkedin&msg=Channel%20added'));
  });
});
