/**
 * The review card ("Enjoying Hookpost? A short review helps a lot."): which
 * review page it links to, and how the card follows the server's decision
 * (GET /user/review-ask) and claim (POST /user/review-ask). When the card is
 * due at all is the server's rule, tested in review.ask.policy.spec.ts.
 *   pnpm exec jest -c apps/frontend/jest.config.ts rate-prompt
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { SWRConfig } from 'swr';

// The modal stack pulls in ESM-only packages; the card only needs to know
// whether a modal is open, which each test sets through `modalOpen`.
let modalOpen = false;
jest.mock('@hookpost/frontend/components/layout/new-modal', () => ({
  areYouSure: jest.fn(() => Promise.resolve(true)),
  useHasOpenModal: () => modalOpen,
}));
jest.mock('@hookpost/react/translation/get.transation.service.client', () => ({
  useT: () => (_key: string, fallback: string) => fallback,
}));
let mockUser: any = { impersonate: false };
jest.mock('@hookpost/frontend/components/layout/user.context', () => ({
  useUser: () => mockUser,
}));

/** The API as the card sees it: what GET answers and whether the claim wins. */
let server: { ask: boolean; claim: boolean; status?: number };
const calls: { method: string; path: string; body?: any }[] = [];
const mockFetch = jest.fn(async (path: string, init?: RequestInit) => {
  const method = init?.method || 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, path, body });
  const status = server.status || 200;
  const json =
    method === 'GET'
      ? { ask: server.ask }
      : { ok: body?.action === 'shown' ? server.claim : true };
  return {
    ok: status < 400,
    status,
    json: async () => json,
  } as Response;
});
jest.mock('@hookpost/helpers/utils/custom.fetch', () => ({
  useFetch: () => mockFetch,
}));

import {
  G2_REVIEW_URL,
  isAndroidUserAgent,
  PLAY_REVIEW_URL,
  RATE_PROMPT_EVENT,
  recordSuccessfulPost,
  reviewButtons,
} from '@hookpost/frontend/components/layout/rate-prompt';
import { RatePrompt } from '@hookpost/frontend/components/layout/rate-prompt.component';
import {
  TWA_COOKIE,
  TWA_SESSION_KEY,
  TWA_STORAGE_KEY,
} from '@hookpost/frontend/components/layout/twa';

const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

let userAgent = DESKTOP;
Object.defineProperty(window.navigator, 'userAgent', {
  get: () => userAgent,
  configurable: true,
});

/** A tab the Play app opened (what the layout's bootstrap script records). */
const asPlayApp = () => window.sessionStorage.setItem(TWA_SESSION_KEY, '1');

const setReferrer = (value: string) =>
  Object.defineProperty(document, 'referrer', { value, configurable: true });

beforeEach(() => {
  modalOpen = false;
  mockUser = { impersonate: false };
  server = { ask: true, claim: true };
  calls.length = 0;
  mockFetch.mockClear();
  userAgent = DESKTOP;
  window.localStorage.clear();
  window.sessionStorage.clear();
  setReferrer('');
  document.cookie = `${TWA_COOKIE}=; path=/; max-age=0`;
  document.documentElement.removeAttribute('data-hp-twa');
});

describe('reviewButtons', () => {
  it('in the Play app: Google Play only', () => {
    expect(reviewButtons({ isTwa: true, isAndroid: true })).toEqual({
      primary: { target: 'play', href: PLAY_REVIEW_URL },
      secondary: null,
    });
  });

  it('on the website: G2, and Google Play as a second button only on Android', () => {
    expect(reviewButtons({ isTwa: false, isAndroid: false })).toEqual({
      primary: { target: 'g2', href: G2_REVIEW_URL },
      secondary: null,
    });
    expect(reviewButtons({ isTwa: false, isAndroid: true })).toEqual({
      primary: { target: 'g2', href: G2_REVIEW_URL },
      secondary: { target: 'play', href: PLAY_REVIEW_URL },
    });
  });

  it('links to the real listings', () => {
    expect(G2_REVIEW_URL).toBe('https://www.g2.com/products/hookpost/take_survey');
    expect(PLAY_REVIEW_URL).toBe(
      'https://play.google.com/store/apps/details?id=in.hookstep.hookpost.twa'
    );
  });
});

describe('isAndroidUserAgent', () => {
  it.each([
    [ANDROID_CHROME, true],
    ['Mozilla/5.0 (Linux; Android 13; SM-A536E; wv) AppleWebKit/537.36 Version/4.0 Chrome/120 Mobile Safari/537.36 Instagram 300', true],
    [IPHONE, false],
    [DESKTOP, false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (ua, expected) => {
    expect(isAndroidUserAgent(ua as any)).toBe(expected);
  });
});

describe('recordSuccessfulPost', () => {
  it('stores nothing and tells the card to re-check', () => {
    const seen = jest.fn();
    window.addEventListener(RATE_PROMPT_EVENT, seen);
    recordSuccessfulPost();
    window.removeEventListener(RATE_PROMPT_EVENT, seen);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
  });
});

describe('RatePrompt card', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // A fresh SWR cache per render, so no test sees another's answer.
  const mount = () =>
    render(
      React.createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        React.createElement(RatePrompt)
      )
    );
  const wait = async (ms: number) => {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
    // Let the fetch promises and SWR's state updates settle.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  const posts = (action: string) =>
    calls.filter((c) => c.method === 'POST' && c.body?.action === action);
  const card = (c: HTMLElement) => c.querySelector('[data-testid="review-prompt"]');

  it('asks the server only after the page has settled, then claims and shows the card', async () => {
    const { container } = mount();
    await wait(7000);
    expect(calls).toEqual([]);
    await wait(1500);
    expect(calls[0]).toEqual({ method: 'GET', path: '/user/review-ask', body: undefined });
    expect(posts('shown')).toHaveLength(1);
    const aside = card(container) as HTMLElement;
    expect(aside).not.toBeNull();
    expect(aside.textContent).toContain('Enjoying Hookpost?');
    expect(aside.textContent).toContain('A short review helps a lot.');
    // Policy: no stars, no incentive, no "do you like it" gate.
    expect(aside.textContent).not.toMatch(/star|★|free|reward|discount|credit|coupon/i);
    expect(aside.querySelectorAll('a')).toHaveLength(1);
    expect(aside.querySelector('a')?.getAttribute('href')).toBe(G2_REVIEW_URL);
    expect(aside.querySelector('a')?.textContent).toBe('Review on G2');
  });

  it('shows nothing when the server says it is not due', async () => {
    server.ask = false;
    const { container } = mount();
    await wait(30000);
    expect(posts('shown')).toHaveLength(0);
    expect(card(container)).toBeNull();
  });

  it('shows nothing when another tab or device won the claim', async () => {
    server.claim = false;
    const { container } = mount();
    await wait(9000);
    expect(posts('shown')).toHaveLength(1);
    expect(card(container)).toBeNull();
  });

  it('shows nothing when the API fails', async () => {
    server.status = 500;
    const { container } = mount();
    await wait(9000);
    expect(posts('shown')).toHaveLength(0);
    expect(card(container)).toBeNull();
  });

  it('shows nothing when the claim itself fails (network down)', async () => {
    mockFetch.mockImplementationOnce(async (path: string, init?: RequestInit) => {
      calls.push({ method: init?.method || 'GET', path });
      return { ok: true, status: 200, json: async () => ({ ask: true }) } as Response;
    });
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    const { container } = mount();
    await wait(9000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(card(container)).toBeNull();
  });

  it('never calls the API while an admin is impersonating the user', async () => {
    mockUser = { impersonate: true };
    const { container } = mount();
    await wait(30000);
    expect(calls).toEqual([]);
    expect(card(container)).toBeNull();
  });

  it('waits behind an open modal (the composer), and claims only once it can be seen', async () => {
    modalOpen = true;
    const { container, rerender } = mount();
    await wait(9000);
    expect(posts('shown')).toHaveLength(0);
    expect(card(container)).toBeNull();
    modalOpen = false;
    rerender(
      React.createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        React.createElement(RatePrompt)
      )
    );
    await wait(10);
    expect(posts('shown')).toHaveLength(1);
    expect(card(container)).not.toBeNull();
  });

  it('steps aside while a modal opens over it, and comes back', async () => {
    const view = mount();
    await wait(9000);
    expect(card(view.container)).not.toBeNull();
    modalOpen = true;
    view.rerender(
      React.createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        React.createElement(RatePrompt)
      )
    );
    expect(card(view.container)).toBeNull();
    modalOpen = false;
    view.rerender(
      React.createElement(
        SWRConfig,
        { value: { provider: () => new Map(), dedupingInterval: 0 } },
        React.createElement(RatePrompt)
      )
    );
    expect(card(view.container)).not.toBeNull();
    expect(posts('shown')).toHaveLength(1);
  });

  it('"Not now" and Escape dismiss it on the server', async () => {
    const a = mount();
    await wait(9000);
    fireEvent.click(a.getByText('Not now'));
    expect(card(a.container)).toBeNull();
    expect(posts('dismissed')).toHaveLength(1);
    a.unmount();

    calls.length = 0;
    const b = mount();
    await wait(9000);
    // Escape is heard from the tick after the card appears (the Escape that
    // closed a modal must not dismiss the card it uncovers).
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(card(b.container)).not.toBeNull();
    await wait(1);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(card(b.container)).toBeNull();
    expect(posts('dismissed')).toHaveLength(1);
  });

  it('the close button dismisses it too', async () => {
    const view = mount();
    await wait(9000);
    fireEvent.click(view.getByLabelText('Close'));
    expect(card(view.container)).toBeNull();
    expect(posts('dismissed')).toHaveLength(1);
  });

  it('opening G2 records the click and closes the card', async () => {
    const view = mount();
    await wait(9000);
    const link = view.getByText('Review on G2');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    fireEvent.click(link);
    expect(card(view.container)).toBeNull();
    expect(posts('clicked')).toEqual([
      { method: 'POST', path: '/user/review-ask', body: { action: 'clicked', target: 'g2' } },
    ]);
  });

  it('in the Play app: one button, to Google Play', async () => {
    asPlayApp();
    userAgent = ANDROID_CHROME;
    const view = mount();
    await wait(9000);
    const links = card(view.container)!.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(PLAY_REVIEW_URL);
    expect(links[0].textContent).toBe('Review on Google Play');
    fireEvent.click(links[0]);
    expect(posts('clicked')[0].body).toEqual({ action: 'clicked', target: 'play' });
  });

  it('the Play app is recognised from its launch referrer as well', async () => {
    setReferrer('android-app://in.hookstep.hookpost.twa/');
    const view = mount();
    await wait(9000);
    expect(card(view.container)!.querySelector('a')?.getAttribute('href')).toBe(PLAY_REVIEW_URL);
  });

  it('plain Chrome on a phone that once opened the Play app is the website: G2 first', async () => {
    window.localStorage.setItem(TWA_STORAGE_KEY, '1');
    document.cookie = `${TWA_COOKIE}=1; path=/`;
    document.documentElement.setAttribute('data-hp-twa', '');
    userAgent = ANDROID_CHROME;
    const view = mount();
    await wait(9000);
    const links = card(view.container)!.querySelectorAll('a');
    expect(Array.from(links).map((a) => a.getAttribute('href'))).toEqual([
      G2_REVIEW_URL,
      PLAY_REVIEW_URL,
    ]);
    expect(links[1].textContent).toBe('Rate on Google Play');
  });

  it('an Android browser gets "Rate on Google Play" as a second button; an iPhone does not', async () => {
    userAgent = ANDROID_CHROME;
    const a = mount();
    await wait(9000);
    expect(a.getByText('Rate on Google Play')).toBeTruthy();
    a.unmount();
    userAgent = IPHONE;
    const b = mount();
    await wait(9000);
    expect(b.queryByText('Rate on Google Play')).toBeNull();
    expect(b.getByText('Review on G2')).toBeTruthy();
  });

  it('re-checks a while after a post is saved (the publish runs on the server)', async () => {
    server.ask = false;
    const view = mount();
    await wait(9000);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    server.ask = true;
    act(() => recordSuccessfulPost());
    await wait(19000);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(1);
    await wait(1500);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(card(view.container)).not.toBeNull();
  });

  it('is announced to screen readers without taking focus', async () => {
    const view = mount();
    await wait(9000);
    const status = view.container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Enjoying Hookpost? A short review helps a lot.');
    const dialog = view.container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement).toBe(document.body);
  });
});
