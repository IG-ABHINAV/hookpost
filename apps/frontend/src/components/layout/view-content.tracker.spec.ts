/**
 * ViewContentTracker on the marketing pages: one server-side ViewContent per
 * path, posted to /public/t, carrying the first touch (hp_attr) so the
 * backend can keep its own HttpOnly copy of it (hp_attr_s), which Safari does
 * not cut short as it does a cookie written by script.
 *   pnpm exec jest -c apps/frontend/jest.config.ts view-content
 */
import { ATTRIBUTION_CAPTURE_SCRIPT } from '@hookpost/helpers/utils/attribution';
import { TrackEnum } from '@hookpost/nestjs-libraries/user/track.enum';

let mockPathname = '/claude';
jest.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

const KEYS = ['NEXT_PUBLIC_FACEBOOK_PIXEL', 'NEXT_PUBLIC_BACKEND_URL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = (global as any).fetch;

/**
 * The tracker as a build with these keys would have it (they are read at
 * module scope), rendered with React and Testing Library from the same module
 * registry, or its hooks would run against another copy of React.
 */
const mount = (env: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  jest.isolateModules(() => {
    const React = require('react');
    const rtl = require('@testing-library/react/pure');
    const { ViewContentTracker } = require('./view-content.tracker');
    rtl.render(React.createElement(ViewContentTracker));
    rtl.act(() => {
      jest.advanceTimersByTime(5000);
    });
    rtl.cleanup();
  });
};

const posts = () =>
  ((global as any).fetch as jest.Mock).mock.calls.map(([url, init]) => ({
    url,
    body: JSON.parse(init.body),
  }));

beforeEach(() => {
  jest.useFakeTimers();
  (global as any).fetch = jest.fn(async () => ({ json: async () => ({ track: 'trk_1' }) }));
  document.cookie = 'hp_attr=; Path=/; Max-Age=0';
});
afterEach(() => {
  jest.useRealTimers();
  (global as any).fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  window.history.replaceState({}, '', '/');
});

const PROD = { NEXT_PUBLIC_FACEBOOK_PIXEL: '1234567890', NEXT_PUBLIC_BACKEND_URL: 'https://hookpost.hookstep.in/api' };

describe('ViewContentTracker', () => {
  it('posts the first touch (hp_attr, as validated) with the ViewContent', () => {
    window.history.replaceState({}, '', '/claude?utm_source=meta&utm_campaign=hp_ww&fbclid=IwAR-ad&email=a%40b.co');
    // eslint-disable-next-line no-new-func
    new Function(ATTRIBUTION_CAPTURE_SCRIPT)();
    mockPathname = '/claude';
    mount(PROD);
    const [post] = posts();
    expect(post.url).toBe('https://hookpost.hookstep.in/api/public/t');
    expect(post.body).toMatchObject({
      tt: TrackEnum.ViewContent,
      additional: { content_name: '/claude' },
      attr: { utm_source: 'meta', utm_campaign: 'hp_ww', fbclid: 'IwAR-ad', landing_path: '/claude' },
    });
    expect(typeof post.body.attr.first_seen_at).toBe('number');
    // The address's other parameters never travel.
    expect(JSON.stringify(post.body)).not.toContain('a@b.co');
  });

  it('no hp_attr (a reset link, or cookies blocked): the ViewContent alone', () => {
    mockPathname = '/pricing';
    mount(PROD);
    const [post] = posts();
    expect(post.body).toEqual({ tt: TrackEnum.ViewContent, additional: { content_name: '/pricing' } });
  });

  it('without a pixel it posts nothing at all', () => {
    mockPathname = '/start';
    mount({ NEXT_PUBLIC_BACKEND_URL: PROD.NEXT_PUBLIC_BACKEND_URL });
    expect(posts()).toEqual([]);
  });
});
