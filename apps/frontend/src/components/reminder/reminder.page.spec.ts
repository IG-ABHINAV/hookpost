/**
 * /reminder/<postId>: download, copy caption, open the app (with the web
 * page as the fallback), "Mark as posted", and a plain message for a post of
 * another workspace (the API answers 404).
 *   pnpm exec jest -c apps/frontend/jest.config.ts reminder.page
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';

jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (key: string, fallback?: any) =>
    typeof fallback === 'string' ? fallback : key,
}));
const show = jest.fn();
jest.mock('@hookpost/react/toaster/toaster', () => ({
  useToaster: () => ({ show }),
}));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'post-1' }) }));
const copy = jest.fn();
jest.mock('copy-to-clipboard', () => (text: string) => copy(text));

let reminder: any;
let status = 200;
const fetchMock = jest.fn(async (path: string, init?: any) => {
  if (init?.method === 'POST') {
    reminder = { ...reminder, state: 'POSTED_MANUALLY' };
    return { ok: true, json: async () => ({}) } as any;
  }
  return { ok: status === 200, status, json: async () => reminder } as any;
});
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => fetchMock,
}));

import { openApp, ReminderPage } from '@hookpost/frontend/components/reminder/reminder.page';

const page = () =>
  render(
    React.createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      React.createElement(ReminderPage)
    )
  );

beforeEach(() => {
  jest.clearAllMocks();
  status = 200;
  reminder = {
    id: 'post-1',
    state: 'REMINDER_SENT',
    remind: true,
    caption: 'Sunset reel\n#travel',
    comments: ['link in bio'],
    media: [{ url: 'https://media.example/reel.mp4', video: true }],
    integration: { name: 'Sacred Smiles', providerIdentifier: 'instagram' },
    platform: 'Instagram',
    appLink: { name: 'Instagram', app: 'instagram://app', web: 'https://www.instagram.com/' },
  };
});

describe('ReminderPage', () => {
  it('shows the video with a download link, and copies the caption', async () => {
    page();
    await screen.findByText('Ready to post');
    expect(fetchMock).toHaveBeenCalledWith('/posts/post-1/reminder');
    const download = screen.getByText('Download').closest('a')!;
    expect(download.getAttribute('href')).toBe('https://media.example/reel.mp4');
    expect(download.hasAttribute('download')).toBe(true);
    expect(document.querySelector('video')!.getAttribute('src')).toBe(
      'https://media.example/reel.mp4'
    );
    fireEvent.click(screen.getByText('Copy caption'));
    expect(copy).toHaveBeenCalledWith('Sunset reel\n#travel');
    fireEvent.click(screen.getByText('Copy comment'));
    expect(copy).toHaveBeenCalledWith('link in bio');
  });

  it('"Mark as posted" posts once and then shows it as posted', async () => {
    page();
    fireEvent.click(await screen.findByTestId('reminder-mark-posted'));
    await screen.findByText('Posted');
    expect(fetchMock).toHaveBeenCalledWith('/posts/post-1/posted-manually', {
      method: 'POST',
    });
    expect(screen.queryByTestId('reminder-mark-posted')).toBeNull();
  });

  it.each([
    ['an auto-publish post', { remind: false }],
    ['a failed post', { state: 'ERROR' }],
    ['a draft', { state: 'DRAFT' }],
  ])('offers no "Mark as posted" for %s (the API refuses it)', async (_label, over) => {
    reminder = { ...reminder, ...over };
    page();
    await screen.findByText('Copy caption');
    expect(screen.queryByTestId('reminder-mark-posted')).toBeNull();
  });

  it('has no open-the-app button for a channel without an app link', async () => {
    reminder = { ...reminder, appLink: null };
    page();
    await screen.findByText('Ready to post');
    expect(screen.queryByTestId('reminder-open-app')).toBeNull();
  });

  it("says the post is not in this workspace on a 404, and shows none of it", async () => {
    status = 404;
    page();
    await screen.findByRole('alert');
    expect(screen.queryByText('Copy caption')).toBeNull();
    expect(screen.queryByTestId('reminder-mark-posted')).toBeNull();
  });
});

describe('openApp', () => {
  const fakeWindow = (hiddenAfterOpen: boolean) => {
    const listeners: Record<string, () => void> = {};
    const doc = {
      hidden: false,
      addEventListener: (name: string, fn: () => void) => (listeners[name] = fn),
      removeEventListener: jest.fn(),
    };
    const location = {
      set href(url: string) {
        hrefs.push(url);
        if (url.startsWith('instagram://') && hiddenAfterOpen) {
          doc.hidden = true;
          listeners.visibilitychange?.();
        }
      },
    };
    const hrefs: string[] = [];
    return {
      win: { document: doc, location, setTimeout: (fn: () => void) => fn() } as any,
      hrefs,
    };
  };
  const link = { app: 'instagram://app', web: 'https://www.instagram.com/' };

  it('opens the app and stays there when the app took over', () => {
    const { win, hrefs } = fakeWindow(true);
    act(() => openApp(link, win));
    expect(hrefs).toEqual(['instagram://app']);
  });

  it('falls back to the web page when nothing opened the app', () => {
    const { win, hrefs } = fakeWindow(false);
    act(() => openApp(link, win));
    expect(hrefs).toEqual(['instagram://app', 'https://www.instagram.com/']);
  });
});
