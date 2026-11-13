/**
 * The Facebook / Instagram (via Facebook Page) picker when Meta returns no
 * Page and no linked professional account (a personal profile). On 27 Oct
 * three new users reached it and left with nothing connected. It now says
 * what each path needs, offers Instagram login (no Page needed) when that
 * provider is open to the viewer, and links Instagram's help page.
 *   pnpm exec jest -c apps/frontend/jest.config.ts meta.no.pages
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));
jest.mock(
  '@hookpost/frontend/components/launches/helpers/use.custom.provider.function',
  () => ({ useCustomProviderFunction: () => ({ get: jest.fn() }) })
);

const connectLink = jest.fn();
jest.mock('@hookpost/frontend/components/launches/use.connect.link', () => ({
  useConnectLink: () => connectLink,
}));

let mockUser: any = { email: 'someone@gmail.com', admin: false };
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => mockUser,
}));

const remember = jest.fn();
jest.mock('@hookpost/frontend/components/launches/connect.attempt', () => ({
  ...jest.requireActual('@hookpost/frontend/components/launches/connect.attempt'),
  rememberConnectStart: (...args: unknown[]) => remember(...args),
}));

import { NOT_AVAILABLE_YET } from '@hookpost/frontend/components/launches/add.channel.helpers';
import {
  canOfferStandalone,
  INSTAGRAM_PROFESSIONAL_HELP_URL,
} from '@hookpost/frontend/components/new-launch/providers/continue-provider/meta/meta.no.pages.help';
import { FacebookContinue } from '@hookpost/frontend/components/new-launch/providers/continue-provider/facebook/facebook.continue';
import { InstagramContinue } from '@hookpost/frontend/components/new-launch/providers/continue-provider/instagram/instagram.continue';

const STANDALONE_GATE = NOT_AVAILABLE_YET['instagram-standalone'];
const mutableGate = NOT_AVAILABLE_YET as Record<string, string>;
/** As if Meta had approved Instagram login: the gate entry is gone. */
const openStandalone = () => {
  delete mutableGate['instagram-standalone'];
};
const restoreGate = () => {
  if (STANDALONE_GATE) mutableGate['instagram-standalone'] = STANDALONE_GATE;
  else delete mutableGate['instagram-standalone'];
};

const renderEmpty = (Picker: any, otherConnect: any = {}) =>
  render(
    React.createElement(Picker, {
      onSave: jest.fn(async () => undefined),
      existingId: [],
      initialData: [],
      onCancel: jest.fn(async () => undefined),
      ...(otherConnect ? { otherConnect } : {}),
    })
  );

const originalLocation = window.location;
let assigned: string | undefined;
const replace = jest.fn((url: string) => {
  assigned = url;
});

beforeEach(() => {
  connectLink.mockReset();
  remember.mockReset();
  mockUser = { email: 'someone@gmail.com', admin: false };
  assigned = undefined;
  replace.mockClear();
  // jsdom cannot navigate; record where the page would have gone.
  delete (window as any).location;
  (window as any).location = {
    href: originalLocation.href,
    origin: originalLocation.origin,
    replace,
  };
});

afterEach(() => {
  (window as any).location = originalLocation;
  delete (window as any).ReactNativeWebView;
  restoreGate();
});

describe('canOfferStandalone', () => {
  it('needs a page that allows another connect, outside the app WebView', () => {
    openStandalone();
    expect(canOfferStandalone(undefined, { admin: true }, false)).toBe(false);
    expect(canOfferStandalone({}, { email: 'a@gmail.com' }, false)).toBe(true);
    expect(canOfferStandalone({}, { email: 'a@gmail.com' }, true)).toBe(false);
  });

  it('follows the Add Channel gate while Instagram login is not open', () => {
    mutableGate['instagram-standalone'] = 'waiting';
    expect(canOfferStandalone({}, { email: 'a@gmail.com' }, false)).toBe(false);
    // The OAuth callback page has no user context: closed, even for admins.
    expect(canOfferStandalone({}, undefined, false)).toBe(false);
    expect(canOfferStandalone({}, { admin: true }, false)).toBe(true);
    expect(canOfferStandalone({}, { email: 'x@hookstep.in' }, false)).toBe(true);
  });
});

describe.each([
  ['Facebook', FacebookContinue],
  ['Instagram via Facebook Page', InstagramContinue],
])('%s picker with no Page and no professional account', (_name, Picker) => {
  it('leads with "No Facebook Page found." above the explanation', () => {
    renderEmpty(Picker);
    const heading = screen.getByRole('heading', { name: 'No Facebook Page found.' });
    const [explanation] = screen.getAllByText(/We found no|Facebook posts to Pages|Pages, not/, {
      selector: 'span',
    });
    // The heading comes first in the document.
    expect(
      heading.compareDocumentPosition(explanation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('when Instagram login is open, offers "Connect Instagram directly instead" with its button', () => {
    openStandalone();
    renderEmpty(Picker);
    expect(screen.getByText('Connect Instagram directly instead')).toBeTruthy();
    expect(screen.getByText('Connect Instagram directly').closest('button')).toBeTruthy();
  });

  it('while Instagram login waits on Meta, no "directly instead" offer and no button', () => {
    mutableGate['instagram-standalone'] = 'waiting';
    renderEmpty(Picker);
    expect(screen.getByRole('heading', { name: 'No Facebook Page found.' })).toBeTruthy();
    expect(screen.queryByText('Connect Instagram directly instead')).toBeNull();
    expect(screen.queryByText('Connect Instagram directly')).toBeNull();
  });

  it('says what Facebook and Instagram through Facebook each need', () => {
    renderEmpty(Picker);
    const text = document.body.textContent || '';
    expect(text).toMatch(/Pages, not (to )?personal profiles/);
    expect(text).toMatch(
      /professional Instagram account \(Business or Creator\) linked to a Facebook Page/
    );
  });

  it("links Instagram's help page for switching to a professional account", () => {
    renderEmpty(Picker);
    const link = screen
      .getByText('How to switch Instagram to a professional account')
      .closest('a')!;
    expect(link.getAttribute('href')).toBe(INSTAGRAM_PROFESSIONAL_HELP_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('keeps Create a Facebook Page and Cancel', () => {
    renderEmpty(Picker);
    expect(screen.getByText('Create a Facebook Page')).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('one button starts the Instagram login connect', async () => {
    openStandalone();
    connectLink.mockResolvedValueOnce('https://www.instagram.com/oauth/authorize?x=1');
    renderEmpty(Picker);
    await act(async () => {
      fireEvent.click(screen.getByText('Connect Instagram directly'));
    });
    expect(connectLink).toHaveBeenCalledTimes(1);
    expect(connectLink).toHaveBeenCalledWith(
      '/integrations/social/instagram-standalone'
    );
    expect(remember.mock.calls[0][0]).toBe('instagram-standalone');
    // Replaced, so Back never returns to the spent OAuth callback.
    expect(replace).toHaveBeenCalledWith(
      'https://www.instagram.com/oauth/authorize?x=1'
    );
  });

  it('drops the placeholder before leaving and keeps onboarding going', async () => {
    openStandalone();
    const order: string[] = [];
    const beforeLeave = jest.fn(async () => {
      order.push('beforeLeave');
    });
    connectLink.mockImplementationOnce(async () => {
      order.push('link');
      return 'https://www.instagram.com/oauth/authorize?x=3';
    });
    replace.mockImplementationOnce((url: string) => {
      order.push('leave');
      assigned = url;
    });
    renderEmpty(Picker, { onboarding: true, beforeLeave });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect Instagram directly'));
    });
    expect(connectLink).toHaveBeenCalledWith(
      '/integrations/social/instagram-standalone?onboarding=true'
    );
    expect(order).toEqual(['link', 'beforeLeave', 'leave']);
  });

  it('a failed delete of the placeholder still leaves for Instagram', async () => {
    openStandalone();
    connectLink.mockResolvedValueOnce('https://www.instagram.com/oauth/authorize?x=4');
    renderEmpty(Picker, {
      beforeLeave: jest.fn(async () => {
        throw new Error('offline');
      }),
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Connect Instagram directly'));
    });
    expect(assigned).toBe('https://www.instagram.com/oauth/authorize?x=4');
  });

  it('a refused link (plan dialog, platform down) stays on the page, ready to retry', async () => {
    openStandalone();
    connectLink.mockResolvedValueOnce(null);
    renderEmpty(Picker);
    await act(async () => {
      fireEvent.click(screen.getByText('Connect Instagram directly'));
    });
    expect(assigned).toBeUndefined();
    expect(remember).not.toHaveBeenCalled();
    // Said on the page: the OAuth callback page has no toaster.
    expect(screen.getByRole('alert').textContent).toMatch(
      /Could not start Instagram login/
    );
    connectLink.mockResolvedValueOnce('https://www.instagram.com/oauth/authorize?x=2');
    await act(async () => {
      fireEvent.click(screen.getByText('Connect Instagram directly'));
    });
    expect(assigned).toBe('https://www.instagram.com/oauth/authorize?x=2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('while Instagram login is not open to the viewer, says so instead of a button that fails', () => {
    mutableGate['instagram-standalone'] = 'waiting';
    renderEmpty(Picker);
    expect(screen.queryByText('Connect Instagram directly')).toBeNull();
    expect(screen.getByText(/waiting on Meta's approval/)).toBeTruthy();
    expect(
      screen.getByText('How to switch Instagram to a professional account')
    ).toBeTruthy();
  });

  it('on the callback page (no user context) the gate holds, admins included', () => {
    mutableGate['instagram-standalone'] = 'waiting';
    mockUser = undefined;
    renderEmpty(Picker);
    expect(screen.queryByText('Connect Instagram directly')).toBeNull();
    expect(screen.getByText(/waiting on Meta's approval/)).toBeTruthy();
  });

  it('where another connect would land elsewhere (no otherConnect) there is no button', () => {
    openStandalone();
    renderEmpty(Picker, null);
    expect(screen.queryByText('Connect Instagram directly')).toBeNull();
    // The gate is open, so not "waiting on Meta": points to Add Channel.
    expect(screen.queryByText(/waiting on Meta's approval/)).toBeNull();
    expect(screen.getByText(/open Add Channel and choose Instagram \(no Facebook Page needed\)/)).toBeTruthy();
    expect(
      screen.getByText('How to switch Instagram to a professional account')
    ).toBeTruthy();
  });

  it('inside the mobile app WebView there is no button', () => {
    openStandalone();
    (window as any).ReactNativeWebView = { postMessage: jest.fn() };
    renderEmpty(Picker);
    expect(screen.queryByText('Connect Instagram directly')).toBeNull();
  });
});

describe('a picker that has Pages', () => {
  it('shows no empty-state help', () => {
    render(
      React.createElement(FacebookContinue, {
        onSave: jest.fn(async () => undefined),
        existingId: [],
        initialData: [
          { id: 'p1', name: 'My Page', picture: { data: { url: '/p.png' } } },
        ],
      })
    );
    expect(screen.getByText('My Page')).toBeTruthy();
    expect(screen.queryByTestId('meta-no-pages-help')).toBeNull();
  });
});
