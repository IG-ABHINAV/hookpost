/**
 * Meta ad -> Play listing redirect on the homepage.
 *   pnpm exec jest -c apps/frontend/jest.config.ts meta-ad-redirect
 *
 * Runs the exact inline-script string the layout ships against a stand-in
 * `window` (jsdom cannot navigate), recording location.replace.
 */
import {
  META_AD_BAR_ATTR,
  META_AD_BAR_ID,
  META_AD_MODE,
  MetaAdMode,
  metaAdRedirectScript,
  REDIRECT_CAP_MS,
  REDIRECT_DONE_KEY,
} from '@hookpost/frontend/components/layout/meta-ad-redirect';
import { PLAY_STORE_URL } from '@hookpost/frontend/components/layout/twa';

const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const GOOGLEBOT_MOBILE =
  'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const AD =
  '?utm_source=meta&utm_medium=paid_social&utm_campaign=reel_claude_oct10&utm_content=hi';

type Opts = {
  ua?: string;
  path?: string;
  search?: string;
  referrer?: string;
  cookie?: string;
  twaAttr?: boolean;
  standalone?: boolean;
  session?: Record<string, string>;
  pixel?: string;
  mode?: MetaAdMode;
  noObserver?: boolean;
};

const run = (o: Opts = {}) => {
  const replace = jest.fn();
  const timers: Array<() => void> = [];
  const observers: Array<(list: any) => void> = [];
  const appended: any[] = [];
  const session: Record<string, string> = { ...(o.session || {}) };
  const attrs = new Set<string>(o.twaAttr ? ['data-hp-twa'] : []);
  const listeners: Array<(ev: any) => void> = [];
  const win: any = {
    location: { pathname: o.path ?? '/', search: o.search ?? AD, replace },
    navigator: { userAgent: o.ua ?? ANDROID },
    URLSearchParams,
    setTimeout: (fn: () => void) => timers.push(fn),
    matchMedia: (q: string) => ({ matches: !!o.standalone && /standalone/.test(q) }),
    sessionStorage: {
      getItem: (k: string) => session[k] ?? null,
      setItem: (k: string, v: string) => (session[k] = v),
    },
    PerformanceObserver: o.noObserver ? undefined : function (cb: (list: any) => void) {
      observers.push(cb);
      return { observe: () => undefined };
    },
    document: {
      referrer: o.referrer ?? 'https://l.facebook.com/',
      cookie: o.cookie ?? '',
      documentElement: {
        hasAttribute: (a: string) => attrs.has(a),
        setAttribute: (a: string) => attrs.add(a),
      },
      addEventListener: (_t: string, fn: (ev: any) => void) => listeners.push(fn),
      getElementById: () => null,
      createElement: () => ({}),
      head: { appendChild: (el: any) => appended.push(el) },
    },
  };
  new Function(
    'window',
    metaAdRedirectScript(o.pixel ?? '1834060401105252', o.mode ?? 'AUTO_REDIRECT')
  )(win);
  /** Simulates a tap on an element whose closest() match is `hit`. */
  const tap = (hit: any) =>
    listeners.forEach((fn) => fn({ target: { closest: () => hit } }));
  const pixelRequest = (name: string) =>
    observers.forEach((cb) => cb({ getEntries: () => [{ name }] }));
  return { replace, timers, pixelRequest, appended, win, session, attrs, tap, listeners };
};

const target = (replace: jest.Mock) => new URL(replace.mock.calls[0][0]);

describe('metaAdRedirectScript', () => {
  it('waits for the pixel request, then goes to Play with the utms as install referrer', () => {
    const { replace, pixelRequest, appended, win, session } = run();
    expect(appended.find((e) => e.id === 'fb-pixel-lib')).toMatchObject({ src: '/f.js' });
    expect(appended.filter((e) => e.rel === 'preconnect').map((e) => e.href)).toEqual([
      'https://connect.facebook.net',
      'https://www.facebook.com',
    ]);
    expect(win.fbq.queue.map((a: any) => Array.from(a))).toEqual([
      ['init', '1834060401105252'],
      ['track', 'PageView'],
    ]);
    expect(replace).not.toHaveBeenCalled();
    pixelRequest('https://connect.facebook.net/signals/config/1834060401105252');
    expect(replace).not.toHaveBeenCalled();
    pixelRequest('https://www.facebook.com/tr/?id=1834060401105252&ev=PageView');
    expect(replace).toHaveBeenCalledTimes(1);
    const url = target(replace);
    expect(url.origin + url.pathname + '?id=' + url.searchParams.get('id')).toBe(PLAY_STORE_URL);
    expect(Object.fromEntries(new URLSearchParams(url.searchParams.get('referrer')!))).toEqual({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'reel_claude_oct10',
      utm_term: 'hi',
      utm_content: 'ad_redirect',
    });
    expect(session[REDIRECT_DONE_KEY]).toBe('1');
  });

  it('goes anyway when the cap fires first, and only once', () => {
    const { replace, timers, pixelRequest } = run();
    expect(REDIRECT_CAP_MS).toBe(1500);
    timers.forEach((t) => t());
    pixelRequest('https://www.facebook.com/tr/?id=1&ev=PageView');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('falls back to the cap where PerformanceObserver is missing', () => {
    const { replace, timers } = run({ noObserver: true });
    expect(replace).not.toHaveBeenCalled();
    timers.forEach((t) => t());
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('keeps an ad-supplied utm_term', () => {
    const { replace, timers } = run({ search: AD + '&utm_term=reel1' });
    timers.forEach((t) => t());
    const ref = new URLSearchParams(target(replace).searchParams.get('referrer')!);
    expect(ref.get('utm_term')).toBe('reel1');
    expect(ref.get('utm_content')).toBe('ad_redirect');
  });

  it('ships without the source comments', () => {
    expect(metaAdRedirectScript('1', 'AUTO_REDIRECT')).not.toMatch(/^\s*\/\//m);
  });

  it('goes straight away when no pixel is configured', () => {
    expect(run({ pixel: '' }).replace).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['facebook'],
    ['fb'],
    ['ig'],
    ['Instagram'],
    ['Facebook_Mobile_Feed'],
  ])('accepts utm_source=%s', (src) => {
    const { timers, replace } = run({ search: `?utm_source=${src}` });
    timers.forEach((t) => t());
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Opts]>([
    ['iPhone', { ua: IPHONE }],
    ['desktop', { ua: DESKTOP }],
    ['Googlebot smartphone', { ua: GOOGLEBOT_MOBILE }],
    ['facebookexternalhit', { ua: ANDROID + ' facebookexternalhit/1.1' }],
    ['no utms', { search: '' }],
    ['another source', { search: '?utm_source=youtube' }],
    ['a lookalike source', { search: '?utm_source=metabase' }],
    ['another page', { path: '/pricing' }],
    ['inside the Play app (marked <html>)', { twaAttr: true }],
    ['inside the Play app (referrer)', { referrer: 'android-app://in.hookstep.hookpost.twa' }],
    ['an installed app window', { standalone: true }],
    ['a signed-in customer', { cookie: 'a=1; hp_logged_in=1' }],
    ['a tab already sent once', { session: { [REDIRECT_DONE_KEY]: '1' } }],
  ])('leaves %s alone', (_label, opts) => {
    const { replace, timers, appended } = run(opts);
    timers.forEach((t) => t());
    expect(replace).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
  });
});

describe('metaAdRedirectScript, OFF mode', () => {
  it('ships OFF: ad visitors stay on the website while the Play app has no new-user path', () => {
    expect(META_AD_MODE).toBe('OFF');
  });

  it('is an empty script for OFF, and OFF is the default', () => {
    expect(metaAdRedirectScript('1834060401105252', 'OFF')).toBe('');
    expect(metaAdRedirectScript('1834060401105252')).toBe('');
  });

  it('never reaches Play from an Android Meta-ad visit', () => {
    const { replace, timers, pixelRequest, appended, attrs } = run({ mode: 'OFF' });
    timers.forEach((t) => t());
    pixelRequest('https://www.facebook.com/tr/?id=1&ev=PageView');
    expect(replace).not.toHaveBeenCalled();
    expect(appended).toHaveLength(0);
    expect(attrs.has(META_AD_BAR_ATTR)).toBe(false);
  });
});

describe('metaAdRedirectScript, INSTALL_BAR mode', () => {

  it('shows the bar, never navigates, and adds the referrer at tap time', () => {
    const { replace, timers, pixelRequest, attrs, tap, appended } = run({ mode: 'INSTALL_BAR' });
    expect(attrs.has(META_AD_BAR_ATTR)).toBe(true);
    expect(appended.find((e) => e.id === 'fb-pixel-lib')).toMatchObject({ src: '/f.js' });
    expect(appended.filter((e) => e.rel === 'preconnect').map((e) => e.href)).toEqual([
      'https://connect.facebook.net',
      'https://www.facebook.com',
    ]);
    timers.forEach((t) => t());
    pixelRequest('https://www.facebook.com/tr/?id=1&ev=PageView');
    expect(replace).not.toHaveBeenCalled();
    const link: any = { id: META_AD_BAR_ID, href: PLAY_STORE_URL };
    tap(link);
    const url = new URL(link.href);
    expect(url.searchParams.get('id')).toBe('in.hookstep.hookpost.twa');
    expect(Object.fromEntries(new URLSearchParams(url.searchParams.get('referrer')!))).toEqual({
      utm_source: 'meta',
      utm_medium: 'paid_social',
      utm_campaign: 'reel_claude_oct10',
      utm_term: 'hi',
      utm_content: 'ad_install_bar',
    });
  });

  it('still shows the bar in a tab that was already redirected once', () => {
    const { attrs } = run({ mode: 'INSTALL_BAR', session: { [REDIRECT_DONE_KEY]: '1' } });
    expect(attrs.has(META_AD_BAR_ATTR)).toBe(true);
  });

  it.each<[string, Opts]>([
    ['iPhone', { ua: IPHONE }],
    ['desktop', { ua: DESKTOP }],
    ['no utms', { search: '' }],
    ['the Play app', { twaAttr: true }],
  ])('hides the bar for %s', (_l, opts) => {
    const { attrs, listeners } = run({ ...opts, mode: 'INSTALL_BAR' });
    expect(attrs.has(META_AD_BAR_ATTR)).toBe(false);
    expect(listeners).toHaveLength(0);
  });
});
