/**
 * The Cloudflare Web Analytics loader must add the beacon once, only when
 * Cloudflare's own automatic injection has not already put one on the page.
 *   pnpm exec jest -c apps/frontend/jest.config.ts
 */
import {
  CF_BEACON_HOST,
  CF_BEACON_SRC,
  CF_BEACON_TOKEN,
  injectCloudflareBeacon,
  scheduleCloudflareBeacon,
} from './cloudflare-analytics';

const beacons = () =>
  document.querySelectorAll('script[src*="cloudflareinsights.com/beacon"]');

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('injectCloudflareBeacon', () => {
  it('adds a deferred beacon carrying the site token and spa mode', () => {
    expect(injectCloudflareBeacon(document)).toBe(true);
    const s = beacons();
    expect(s).toHaveLength(1);
    const el = s[0] as HTMLScriptElement;
    expect(el.src).toBe(CF_BEACON_SRC);
    expect(el.defer).toBe(true);
    expect(JSON.parse(el.getAttribute('data-cf-beacon')!)).toEqual({
      token: CF_BEACON_TOKEN,
      spa: true,
    });
  });

  it('does nothing when Cloudflare already injected its own beacon', () => {
    document.body.insertAdjacentHTML(
      'beforeend',
      '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v4bc70e2c" data-cf-beacon=\'{"token":"x"}\'></script>'
    );
    expect(injectCloudflareBeacon(document)).toBe(false);
    expect(beacons()).toHaveLength(1);
  });

  it('is idempotent', () => {
    injectCloudflareBeacon(document);
    expect(injectCloudflareBeacon(document)).toBe(false);
    expect(beacons()).toHaveLength(1);
  });
});

describe('scheduleCloudflareBeacon', () => {
  const fakeWin = (idle: boolean, hostname = CF_BEACON_HOST) => {
    const listeners: Record<string, () => void> = {};
    const queue: (() => void)[] = [];
    const win: any = {
      location: { hostname },
      addEventListener: (e: string, fn: () => void) => (listeners[e] = fn),
      setTimeout: (fn: () => void) => queue.push(fn),
    };
    if (idle) win.requestIdleCallback = (fn: () => void) => queue.push(fn);
    return { win, listeners, queue };
  };
  const setReady = (state: string) =>
    Object.defineProperty(document, 'readyState', {
      configurable: true,
      get: () => state,
    });

  afterEach(() => setReady('complete'));

  it('waits for window load, then for idle, before touching the page', () => {
    setReady('loading');
    const { win, listeners, queue } = fakeWin(true);
    scheduleCloudflareBeacon(win, document);
    expect(beacons()).toHaveLength(0);
    expect(queue).toHaveLength(0);
    listeners.load();
    expect(beacons()).toHaveLength(0); // queued for idle, not run yet
    queue.forEach((fn) => fn());
    expect(beacons()).toHaveLength(1);
  });

  it('goes straight to idle when the page already finished loading', () => {
    setReady('complete');
    const { win, listeners, queue } = fakeWin(true);
    scheduleCloudflareBeacon(win, document);
    expect(listeners.load).toBeUndefined();
    queue.forEach((fn) => fn());
    expect(beacons()).toHaveLength(1);
  });

  it('falls back to setTimeout without requestIdleCallback', () => {
    setReady('complete');
    const { win, queue } = fakeWin(false);
    scheduleCloudflareBeacon(win, document);
    expect(queue).toHaveLength(1);
    queue[0]();
    expect(beacons()).toHaveLength(1);
  });

  it('does nothing at all off the live host (local dev, Lighthouse, E2E)', () => {
    setReady('loading');
    for (const host of ['localhost', '127.0.0.1', 'hookpost.localhost']) {
      const { win, listeners, queue } = fakeWin(true, host);
      scheduleCloudflareBeacon(win, document);
      expect(listeners.load).toBeUndefined();
      expect(queue).toHaveLength(0);
    }
    setReady('complete');
    const { win, queue } = fakeWin(true, 'localhost');
    scheduleCloudflareBeacon(win, document);
    expect(queue).toHaveLength(0);
    expect(beacons()).toHaveLength(0);
  });

  it('adds nothing at idle time if a beacon appeared in the meantime', () => {
    setReady('complete');
    const { win, queue } = fakeWin(true);
    scheduleCloudflareBeacon(win, document);
    document.body.insertAdjacentHTML(
      'beforeend',
      '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>'
    );
    queue.forEach((fn) => fn());
    expect(beacons()).toHaveLength(1);
  });
});
