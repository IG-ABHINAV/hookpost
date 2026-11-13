/**
 * The page picker after a two-step login (Facebook, Instagram, YouTube): a
 * failed load is an error with a way out, not "no pages", and the empty state
 * says what to do, with a link to create what is missing and a Cancel.
 *   pnpm exec jest -c apps/frontend/jest.config.ts with-continue-provider
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
// i18next is not initialised here: show each string's English default.
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: string) => fallback ?? key,
}));

// The platform call behind the picker (POST /integrations/function).
const platformCall = jest.fn();
jest.mock(
  '@hookpost/frontend/components/launches/helpers/use.custom.provider.function',
  () => ({ useCustomProviderFunction: () => ({ get: platformCall }) })
);

import { pickerItems } from '@hookpost/frontend/components/new-launch/providers/continue-provider/with-continue-provider';
import { FacebookContinue } from '@hookpost/frontend/components/new-launch/providers/continue-provider/facebook/facebook.continue';

describe('pickerItems', () => {
  it('passes a list through, an empty one included', () => {
    expect(pickerItems([{ id: 'p1' }], 'pages')).toEqual([{ id: 'p1' }]);
    expect(pickerItems([], 'pages')).toEqual([]);
  });

  it('a refused token (false) is an error, not "no pages"', () => {
    expect(() => pickerItems(false, 'pages')).toThrow(
      'Could not load the list (pages)'
    );
  });

  it('an error body is an error, with its message', () => {
    expect(() =>
      pickerItems({ statusCode: 500, message: 'Invalid integration' }, 'pages')
    ).toThrow('Invalid integration');
    expect(() => pickerItems(undefined, 'pages')).toThrow();
  });
});

describe('Facebook picker with no Page', () => {
  const empty = (onCancel?: () => Promise<void>) =>
    render(
      React.createElement(FacebookContinue, {
        onSave: jest.fn(async () => undefined),
        existingId: [],
        initialData: [],
        ...(onCancel ? { onCancel } : {}),
      })
    );

  it('says Hookpost posts to Pages and links to create one', () => {
    empty(jest.fn(async () => undefined));
    expect(screen.getByText(/has no Pages Hookpost can post to/)).toBeTruthy();
    const link = screen.getByText('Create a Facebook Page').closest('a')!;
    expect(link.getAttribute('href')).toBe(
      'https://www.facebook.com/pages/create'
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('Cancel removes the half-connected channel', async () => {
    const onCancel = jest.fn(async () => undefined);
    empty(onCancel);
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('without a way to remove it (no session), there is no Cancel', () => {
    empty();
    expect(screen.queryByText('Cancel')).toBeNull();
    expect(screen.getByText('Create a Facebook Page')).toBeTruthy();
  });
});

describe('Facebook picker when the platform call fails', () => {
  it('says so, with Try again and Cancel, instead of "no Pages"', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // The token was refused: /integrations/function answers false.
    platformCall.mockResolvedValueOnce(false);
    await act(async () => {
      render(
        React.createElement(FacebookContinue, {
          onSave: jest.fn(async () => undefined),
          onCancel: jest.fn(async () => undefined),
          existingId: [],
        })
      );
    });
    expect(screen.getByText(/couldn't load the list/)).toBeTruthy();
    expect(screen.queryByText(/has no Pages/)).toBeNull();
    expect(screen.getByText('Cancel')).toBeTruthy();

    platformCall.mockResolvedValueOnce([
      { id: 'p1', name: 'My Page', picture: { data: { url: '/p1.png' } } },
    ]);
    await act(async () => {
      fireEvent.click(screen.getByText('Try again'));
    });
    expect(screen.getByText('My Page')).toBeTruthy();
  });
});
