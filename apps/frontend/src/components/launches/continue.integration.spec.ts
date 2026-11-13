/**
 * The OAuth callback page (/integrations/social/<provider>?code=...) leaves
 * through router.replace, so it is not in the history: with push, Back
 * returned to it and re-sent the spent code, and on 21 Oct the first trial
 * customer was told three times that a channel he had just connected could
 * not be added. A repeat the backend recognises (alreadyConnected) goes back
 * to the calendar with no error.
 *   pnpm exec jest -c apps/frontend/jest.config.ts continue.integration
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
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
    // Records what the page hands the picker (see the Facebook tests below).
    const facebook = (props: any) => {
      mockPickerProps(props);
      return 'FACEBOOK PICKER';
    };
    return { continueProviderList: { youtube: () => 'PAGE PICKER', facebook } };
  }
);
const mockPickerProps = jest.fn();

import { ContinueIntegration } from '@hookpost/frontend/components/launches/continue.integration';

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

const open = (logged = true) =>
  render(
    React.createElement(ContinueIntegration, {
      provider: 'linkedin',
      searchParams: { state: 'state-1', code: 'code-1' },
      logged,
    })
  );

beforeEach(() => jest.clearAllMocks());

describe('ContinueIntegration', () => {
  it('a finished connect replaces the callback page instead of pushing after it', async () => {
    mockFetch.mockResolvedValue(
      response(201, { id: 'channel-1', reconnected: false })
    );
    open();
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/launches?added=linkedin&msg=Channel%20added'
      )
    );
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('Back to an already finished connect goes to the calendar with no error', async () => {
    mockFetch.mockResolvedValue(
      response(201, { id: 'channel-1', alreadyConnected: true, inBetweenSteps: false })
    );
    open();
    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith(
        '/launches?msg=This%20channel%20is%20already%20connected'
      )
    );
    expect(screen.queryByText('Could not add provider')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  // It used to redirect after 3 s, before most people had read why.
  it('a real failure shows the error and stays, with Try again and Back to calendar', async () => {
    jest.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(
        response(400, {
          message:
            'This connect link was already used or has expired. Add the channel again from Add Channel.',
        })
      );
      open();
      await waitFor(() =>
        expect(screen.getByText('Could not add provider')).toBeTruthy()
      );
      jest.advanceTimersByTime(10000);
      expect(mockReplace).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText('Back to calendar'));
      expect(mockReplace).toHaveBeenCalledWith('/launches');
      expect(mockPush).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a missing permission (409) shows the plain message and offers Try again', async () => {
    mockFetch.mockResolvedValue(
      response(409, {
        msg: 'Google asked you to tick each permission, and some were left unticked. Please connect again and tick all of them so Hookpost can post for you.',
      })
    );
    open();
    await waitFor(() =>
      expect(screen.getByText(/tick all of them/)).toBeTruthy()
    );
    fireEvent.click(screen.getByText('Try again'));
    expect(mockReplace).toHaveBeenCalledWith('/launches?add_channel=1');
  });

  it('without a session, the success is shown on the page', async () => {
    mockFetch.mockResolvedValue(
      response(201, { id: 'channel-1', alreadyConnected: true, inBetweenSteps: false })
    );
    open(false);
    await waitFor(() =>
      expect(screen.getByText('This channel is already connected')).toBeTruthy()
    );
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

// Cancel or Deny on the provider's consent screen. On 22 Oct an Android user
// denied Instagram: the page posted a callback with no code, got a 400 "code
// must be a string" shown as "Could not add provider", and was bounced to the
// calendar 3 s later; nothing reached the backend log.
describe('ContinueIntegration when the provider sends the person back without a code', () => {
  const openWith = (provider: string, searchParams: Record<string, string>, logged = true) =>
    render(
      React.createElement(ContinueIntegration, { provider, searchParams, logged })
    );
  const posts = () => mockFetch.mock.calls.map((c: any[]) => c[0]);

  beforeEach(() => mockFetch.mockResolvedValue(response(204, {})));

  it('Instagram ?error=access_denied: says it was cancelled and never posts the callback', async () => {
    jest.useFakeTimers();
    try {
      openWith('instagram', {
        error: 'access_denied',
        error_reason: 'user_denied',
        error_description: 'Permissions error',
        state: 'state-9',
      });
      expect(screen.getByText('Nothing was connected')).toBeTruthy();
      expect(
        screen.getByText('You cancelled on Instagram. Nothing was connected.')
      ).toBeTruthy();
      jest.advanceTimersByTime(10000);
      expect(mockReplace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
    await waitFor(() =>
      expect(posts()).toEqual(['/integrations/social-connect/instagram/cancelled'])
    );
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      state: 'state-9',
      reason: 'user_denied',
    });
  });

  it('X ?denied=: cancelled too, not "this connect link was already used"', async () => {
    openWith('x', { denied: 'oauth-token-1' });
    expect(screen.getByText('You cancelled on X. Nothing was connected.')).toBeTruthy();
    expect(screen.queryByText(/already used or has expired/)).toBeNull();
    await waitFor(() =>
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
        state: 'oauth-token-1',
        reason: 'user_denied',
      })
    );
  });

  it('LinkedIn user_cancelled_login is a cancel', () => {
    openWith('linkedin', { error: 'user_cancelled_login', state: 's' });
    expect(screen.getByText('You cancelled on LinkedIn. Nothing was connected.')).toBeTruthy();
  });

  it('Try again goes back to Add Channel; Back to calendar to the calendar', () => {
    openWith('instagram', { error: 'access_denied' });
    fireEvent.click(screen.getByText('Try again'));
    expect(mockReplace).toHaveBeenCalledWith('/launches?add_channel=1');
    fireEvent.click(screen.getByText('Back to calendar'));
    expect(mockReplace).toHaveBeenLastCalledWith('/launches');
  });

  it('any other provider error shows what the provider said', () => {
    openWith('linkedin', {
      error: 'invalid_scope',
      error_description: 'Scope+r_basicprofile+is+not+authorized',
    });
    expect(screen.getByText('Could not add provider')).toBeTruthy();
    expect(
      screen.getByText('LinkedIn: Scope r_basicprofile is not authorized')
    ).toBeTruthy();
  });

  it('an invite link (no session) explains, with no buttons into the app', () => {
    openWith('instagram', { error: 'access_denied' }, false);
    expect(screen.getByText('Nothing was connected')).toBeTruthy();
    expect(screen.queryByText('Try again')).toBeNull();
  });
});


// Facebook / Instagram returned no Page: the empty picker may offer Instagram
// login instead, but only where that connect lands in the user's own
// workspace on the web, and leaving drops the half-connected placeholder.
describe('ContinueIntegration hands the picker another way to connect', () => {
  const openFacebook = (body: Record<string, unknown>, logged = true, search: Record<string, string> = {}) => {
    mockFetch.mockResolvedValueOnce(
      response(201, { id: 'placeholder-1', inBetweenSteps: true, pages: [], ...body })
    );
    return render(
      React.createElement(ContinueIntegration, {
        provider: 'facebook',
        searchParams: { state: 'state-1', code: 'code-1', ...search },
        logged,
      })
    );
  };
  const lastProps = () => mockPickerProps.mock.calls.at(-1)![0];

  it('signed in, own workspace: offered, with onboarding, and leaving deletes the placeholder', async () => {
    openFacebook({ onboarding: true });
    await waitFor(() => expect(screen.getByText('FACEBOOK PICKER')).toBeTruthy());
    const { otherConnect } = lastProps();
    expect(otherConnect.onboarding).toBe(true);
    mockFetch.mockResolvedValueOnce(response(200, {}));
    await otherConnect.beforeLeave();
    expect(mockFetch).toHaveBeenLastCalledWith('/integrations', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'placeholder-1' }),
    });
  });

  it('not for an api.market connect, a connect returning to an app, or no session', async () => {
    for (const [body, logged] of [
      [{ marketplace: true }, true],
      [{ returnURL: 'hookpost://integrations' }, true],
      [{}, false],
    ] as const) {
      mockPickerProps.mockClear();
      const view = openFacebook(body, logged);
      await waitFor(() => expect(screen.getByText('FACEBOOK PICKER')).toBeTruthy());
      expect(lastProps().otherConnect).toBeUndefined();
      view.unmount();
    }
  });
});
