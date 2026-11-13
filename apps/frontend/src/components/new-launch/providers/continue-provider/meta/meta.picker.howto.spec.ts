/**
 * The Facebook / Instagram (Facebook Business) account picker, with or
 * without accounts. In the 30 days to 7 Nov all 4 Instagram connects stopped
 * here (inBetweenSteps=true) and the user deleted the channel within 12-42 s,
 * although the OAuth login had worked. The picker now says what Instagram
 * needs, in three steps, and offers Try again (the same connect) right there.
 *   pnpm exec jest -c apps/frontend/jest.config.ts meta.picker.howto
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

jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => ({ email: 'someone@gmail.com', admin: false }),
}));

const remember = jest.fn();
jest.mock('@hookpost/frontend/components/launches/connect.attempt', () => ({
  ...jest.requireActual('@hookpost/frontend/components/launches/connect.attempt'),
  rememberConnectStart: (...args: unknown[]) => remember(...args),
}));

import { FacebookContinue } from '@hookpost/frontend/components/new-launch/providers/continue-provider/facebook/facebook.continue';
import { InstagramContinue } from '@hookpost/frontend/components/new-launch/providers/continue-provider/instagram/instagram.continue';

const igAccount = {
  id: 'ig1',
  pageId: 'p1',
  username: 'shop',
  name: 'My Shop',
  picture: { data: { url: '/p.png' } },
};
const fbPage = { id: 'p1', name: 'My Page', picture: { data: { url: '/p.png' } } };

const renderPicker = (
  Picker: any,
  initialData: any[],
  otherConnect: any = {},
  existingId: string[] = []
) =>
  render(
    React.createElement(Picker, {
      onSave: jest.fn(async () => undefined),
      existingId,
      initialData,
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
  assigned = undefined;
  replace.mockClear();
  delete (window as any).location;
  (window as any).location = {
    href: originalLocation.href,
    origin: originalLocation.origin,
    replace,
  };
});

afterEach(() => {
  (window as any).location = originalLocation;
});

const howTo = () => screen.getByTestId('meta-picker-howto');
const steps = () => howTo().querySelectorAll('ol > li');

describe.each([
  ['instagram', InstagramContinue, [igAccount], 'My Shop'],
  ['facebook', FacebookContinue, [fbPage], 'My Page'],
])('%s picker', (provider, Picker, items, itemName) => {
  it('with zero accounts says so, with the requirement and three steps, open', () => {
    renderPicker(Picker, []);
    expect(howTo().textContent).toMatch(
      /Instagram must be a Professional \(Business or Creator\) account linked to a Facebook Page/
    );
    expect(steps().length).toBe(3);
    expect((howTo() as HTMLDetailsElement).open).toBe(true);
    // No empty grid and no Save button for nothing.
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('with accounts keeps the list and the help one click away (collapsed)', () => {
    renderPicker(Picker, items);
    expect(screen.getByText(itemName)).toBeTruthy();
    expect(steps().length).toBe(3);
    expect((howTo() as HTMLDetailsElement).open).toBe(false);
  });

  it('Try again starts the same connect, drops the placeholder, then leaves', async () => {
    const order: string[] = [];
    connectLink.mockImplementationOnce(async () => {
      order.push('link');
      return 'https://www.facebook.com/dialog/oauth?x=1';
    });
    const beforeLeave = jest.fn(async () => {
      order.push('beforeLeave');
    });
    replace.mockImplementationOnce((url: string) => {
      order.push('leave');
      assigned = url;
    });
    renderPicker(Picker, [], { beforeLeave });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(connectLink).toHaveBeenCalledWith(`/integrations/social/${provider}`);
    expect(remember.mock.calls[0][0]).toBe(provider);
    expect(order).toEqual(['link', 'beforeLeave', 'leave']);
    expect(assigned).toBe('https://www.facebook.com/dialog/oauth?x=1');
  });

  it('Try again keeps onboarding going', async () => {
    connectLink.mockResolvedValueOnce('https://www.facebook.com/dialog/oauth?x=2');
    renderPicker(Picker, items, { onboarding: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(connectLink).toHaveBeenCalledWith(
      `/integrations/social/${provider}?onboarding=true`
    );
  });

  it('a refused link stays on the page and says so', async () => {
    connectLink.mockResolvedValueOnce(null);
    renderPicker(Picker, []);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(assigned).toBeUndefined();
    expect(howTo().querySelector('[role="alert"]')?.textContent).toMatch(
      /Could not restart the connect/
    );
  });

  it('where a reconnect would land elsewhere (no otherConnect) the steps stay, Try again does not', () => {
    renderPicker(Picker, [], null);
    expect(steps().length).toBe(3);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('when every account is already connected it says so instead of an empty list', () => {
    renderPicker(Picker, items, {}, [items[0].id]);
    expect(screen.queryByText(itemName)).toBeNull();
    expect(screen.queryByText('Save')).toBeNull();
    expect(document.body.textContent).toMatch(/already connected/);
  });
});
