/**
 * The homepage demo video (hero-demo.ts, hero-demo-video.tsx), rendered as
 * the production build makes the page (trial for new users, dollars sold
 * outside India): one <video> that loads nothing before play, the 16:9 cut and
 * poster on desktop and the 9:16 ones on mobile (AV1 WebM first, H.264 MP4
 * after it; a lazy AVIF/WebP <picture> with fixed dimensions as the poster),
 * muted autoplay on desktop only and never on reduced motion, Save-Data or 2G,
 * a fallback line when every source fails, no Free-plan or old-price copy, a
 * transcript of each cut, small content-hashed files in public/ (AV1/Opus
 * WebM, faststart H.264 MP4, AVIF and WebP posters), the figures burned into
 * the cuts held
 * against pricing.ts and competitor-facts.ts (hero-demo.facts.ts), and the
 * 16:9 cut as a VideoObject on / and a video entry in sitemap.xml
 * (hero-demo.schema.ts).
 *   pnpm exec jest -c apps/frontend/jest.config.ts hero-demo
 */
import fs from 'fs';
import path from 'path';
import { isSchemaDateTime } from './schema-datetime';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('./site-nav', () => ({ SiteNav: () => null }));

const KEYS = ['USD_CHECKOUT', 'GST_LUT_ARN', 'TRIAL_REQUIRED_SINCE_IN', 'TRIAL_REQUIRED_SINCE_GLOBAL'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const CUT = '2026-10-20T00:00:00Z';
const PRODUCTION = { USD_CHECKOUT: 'on', GST_LUT_ARN: 'AD0910260000000', TRIAL_REQUIRED_SINCE_IN: CUT, TRIAL_REQUIRED_SINCE_GLOBAL: CUT };
const NO_CUTOFF = {};

const PUBLIC = path.resolve(__dirname, '../../../public');
const SRC = path.resolve(__dirname, '../..');

/** An MP4's length in seconds, from the movie header (moov > mvhd). */
function mp4Seconds(buf: Buffer): number {
  const child = (from: number, to: number, type: string) => {
    for (let i = from; i + 8 <= to; ) {
      const size = buf.readUInt32BE(i);
      if (buf.toString('latin1', i + 4, i + 8) === type) return { at: i, end: i + size };
      if (size < 8) break;
      i += size;
    }
    throw new Error(`no ${type} box`);
  };
  const moov = child(0, buf.length, 'moov');
  const { at } = child(moov.at + 8, moov.end, 'mvhd');
  // Version 1 has 64-bit creation, modification and duration fields.
  return buf[at + 8] === 1
    ? Number(buf.readBigUInt64BE(at + 32)) / buf.readUInt32BE(at + 28)
    : buf.readUInt32BE(at + 24) / buf.readUInt32BE(at + 20);
}

type Mods = {
  page: typeof import('./page');
  demo: typeof import('./hero-demo');
  video: typeof import('./hero-demo-video');
  React: typeof import('react');
  rtl: typeof import('@testing-library/react');
  // The Node build: the browser one needs MessageChannel, which jsdom lacks.
  server: typeof import('react-dom/server');
};

function load(env: Record<string, string>): Mods {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let out!: Mods;
  jest.isolateModules(() => {
    out = {
      page: require('./page'),
      demo: require('./hero-demo'),
      video: require('./hero-demo-video'),
      React: require('react'),
      // /pure: no auto-cleanup hooks registered from inside a test.
      rtl: require('@testing-library/react/pure'),
      server: require('react-dom/server.node'),
    };
  });
  return out;
}

// The viewport as matchMedia reports it; jsdom has no layout.
// finePointer: a mouse is the main pointer (null: the same as desktop).
let viewport: { desktop: boolean; reducedMotion: boolean; finePointer?: boolean } = { desktop: true, reducedMotion: false };
const realMatchMedia = window.matchMedia;
const realFetch = (global as any).fetch;
beforeEach(() => {
  viewport = { desktop: true, reducedMotion: false };
  // The plan cards ask /api/public/pricing-context for the visitor's currency.
  (global as any).fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ({
      displayCurrency: 'USD',
      chargeCurrency: 'USD',
      lockedCurrency: null,
      checkoutAllowed: true,
      region: { country: 'US', tzSaysIndia: false, ipSaysIndia: false },
      prices: { STANDARD: { month: 19, year: 190 }, PRO: { month: 29, year: 290 } },
    }),
  }));
  window.matchMedia = ((query: string) => ({
    matches:
      query === '(min-width: 768px)' ? viewport.desktop
      : query === '(prefers-reduced-motion: reduce)' ? viewport.reducedMotion
      : query === '(hover: hover) and (pointer: fine)' ? (viewport.finePointer ?? viewport.desktop)
      : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

const views: Array<{ unmount: () => void }> = [];
afterEach(() => {
  while (views.length) views.pop()!.unmount();
  window.matchMedia = realMatchMedia;
  (global as any).fetch = realFetch;
  delete (window as any).IntersectionObserver;
  jest.restoreAllMocks();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

async function renderHome(m: Mods) {
  let view!: ReturnType<Mods['rtl']['render']>;
  await m.rtl.act(async () => {
    view = m.rtl.render(m.React.createElement(m.page.default));
  });
  views.push(view);
  return view.container;
}

describe('the homepage demo video', () => {
  it('is one <video> that loads nothing before play, with no autoplay attribute (controls: see below)', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const videos = page.querySelectorAll('video');
    expect(videos).toHaveLength(1);
    const video = videos[0];
    expect(video.getAttribute('preload')).toBe('none');
    // In the server HTML (no JS still plays it); hidden after hydration until play.
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('autoplay')).toBe(false);
    expect(video.getAttribute('aria-label')).toBe(m.demo.HERO_DEMO_LABEL);
  });

  it('offers the 16:9 cut to desktop and the 9:16 cut to everyone else, AV1 WebM before H.264 MP4', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const sources = [...page.querySelectorAll('video source')].map((s) => ({
      src: s.getAttribute('src'),
      media: s.getAttribute('media'),
      type: s.getAttribute('type'),
    }));
    const AV1 = 'video/webm; codecs="av01.0.05M.08, opus"';
    expect(m.demo.WEBM_AV1_TYPE).toBe(AV1);
    expect(sources).toEqual([
      { src: '/video/hookpost-home-s1-16x9.d4d0426f2f.webm', media: '(min-width: 768px)', type: AV1 },
      { src: '/video/hookpost-home-s1-16x9.31a51ee739.mp4', media: '(min-width: 768px)', type: 'video/mp4' },
      { src: '/video/hookpost-home-s1-9x16.4f72fe8145.webm', media: null, type: AV1 },
      { src: '/video/hookpost-home-s1-9x16.6ba28b4496.mp4', media: null, type: 'video/mp4' },
    ]);
    expect(m.demo.DESKTOP_QUERY).toBe('(min-width: 768px)');
  });

  it('has a lazy <picture> poster with fixed dimensions, the same breakpoint, AVIF before WebP, and no poster attribute', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const picture = page.querySelector('[data-testid="hero-demo-box"] picture')!;
    const sources = [...picture.querySelectorAll('source')].map((s) => ({
      srcset: s.getAttribute('srcset'),
      media: s.getAttribute('media'),
      type: s.getAttribute('type'),
      size: [s.getAttribute('width'), s.getAttribute('height')],
    }));
    expect(sources).toEqual([
      { srcset: '/video/hookpost-home-s1-16x9.e86c2e3210.avif', media: '(min-width: 768px)', type: 'image/avif', size: ['1280', '720'] },
      { srcset: '/video/hookpost-home-s1-16x9.a9ca8ae0f1.webp', media: '(min-width: 768px)', type: 'image/webp', size: ['1280', '720'] },
      { srcset: '/video/hookpost-home-s1-9x16.9de082db72.avif', media: null, type: 'image/avif', size: ['720', '1280'] },
    ]);
    const img = picture.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/video/hookpost-home-s1-9x16.a645fd3847.webp');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['720', '1280']);
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('fetchpriority')).toBe('low');
    // Decorative: the video beside it carries the label.
    expect(img.getAttribute('alt')).toBe('');
    expect(page.querySelector('video')!.hasAttribute('poster')).toBe(false);
    // The box's aspect ratio is fixed at both widths, so the poster cannot shift anything.
    const box = page.querySelector('[data-testid="hero-demo-box"]')!.className;
    expect(box).toContain('aspect-[9/16]');
    expect(box).toContain('md:aspect-video');
  });

  it('server HTML: the poster and every source are there, nothing loads eagerly, and without JS the play button is a link to the MP4', () => {
    const m = load(PRODUCTION);
    const { HERO_DEMO } = m.demo;
    const html = m.server.renderToString(m.React.createElement(m.video.HeroDemoVideo, { label: 'x' }));
    expect(html).toContain('preload="none"');
    expect(html).not.toContain('poster=');
    expect(html).not.toContain('autoPlay');
    expect(html).not.toMatch(/\sautoplay/);
    // No native controls before a frame plays: Chrome greys a frameless video
    // that has them, over the poster.
    expect(html).not.toMatch(/<video[^>]*\scontrols/);
    expect(html).toContain('playsInline=""');
    expect(html).toContain('loading="lazy"');
    const [outside, noscript] = [html.replace(/<noscript>[\s\S]*?<\/noscript>/, ''), html.match(/<noscript>([\s\S]*?)<\/noscript>/)![1]];
    expect(outside.match(/<source /g)).toHaveLength(7);
    expect(outside).toContain('media="(min-width: 768px)"');
    // The play button needs JS; without it, <noscript> puts the poster on top
    // (Chrome shows native controls with JS off, whose grey panel would cover
    // the one behind) and links each width's MP4.
    expect(html).not.toContain('hero-demo-play');
    expect(html.indexOf('<video')).toBeLessThan(html.indexOf('<noscript>'));
    expect(noscript.match(/<source /g)).toHaveLength(3);
    expect(noscript).toContain(`srcSet="${HERO_DEMO.mobile.posterAvif}"`);
    expect(noscript).toContain(`src="${HERO_DEMO.mobile.posterWebp}"`);
    expect(noscript).toContain(`href="${HERO_DEMO.mobile.mp4}"`);
    expect(noscript).toContain(`href="${HERO_DEMO.desktop.mp4}"`);
    expect(noscript).toMatch(/md:hidden/);
    expect(noscript).toMatch(/hidden[^"]*md:flex/);
    // The status line is mounted and empty.
    expect(html).toMatch(/<p[^>]*role="status"[^>]*data-testid="hero-demo-status"[^>]*><\/p>/);
  });

  // offer() as the closing CTA uses it: the free posts in a build with a cutoff,
  // the Free plan's words in one without, where new users still get Free.
  it.each([
    ['a trial cutoff (production)', PRODUCTION, 'Get 3 free posts'],
    ['no trial cutoff', NO_CUTOFF, 'Start free'],
  ] as const)('sits under the same button as the page closes with, with %s', async (_, env, label) => {
    const page = await renderHome(load(env));
    const cta = page.querySelector('[data-testid="hero-demo-cta"]')!;
    expect(cta.textContent).toBe(`${label} →`);
    expect(cta.getAttribute('href')).toBe('/auth');
    const links = [...page.querySelectorAll('a[href="/auth"]')].map((a) => a.textContent);
    expect(links[links.length - 1]).toBe(label);
  });

  // Names in general: public-names.spec.ts. Here, no title next to the face.
  it('calls nothing a founder demo', async () => {
    const page = await renderHome(load(PRODUCTION));
    const section = page.querySelector('[data-testid="hero-demo"]')!;
    expect(section.textContent).not.toMatch(/founder|walkthrough/i);
    expect(section.textContent).toContain('replayed from its log');
  });
});

describe('the transcript under it', () => {
  const transcriptOf = (page: HTMLElement) =>
    page.querySelector<HTMLDetailsElement>('[data-testid="hero-demo-transcript"]')!;
  const said = (li: Element) => li.querySelector('p')!.textContent;

  it('follows the video, closed until opened', async () => {
    const page = await renderHome(load(PRODUCTION));
    const video = page.querySelector('[data-testid="hero-demo-video"]')!;
    const t = transcriptOf(page);
    expect(t.tagName).toBe('DETAILS');
    expect(t.hasAttribute('open')).toBe(false);
    expect(t.querySelector('summary')!.textContent).toContain('Transcript');
    expect(video.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(t.closest('[data-testid="hero-demo"]')).not.toBeNull();
  });

  it('gives the figures the cuts show, from hero-demo.facts.ts', async () => {
    const m = load(PRODUCTION);
    const { HERO_DEMO_FACTS: v } = require('./hero-demo.facts') as typeof import('./hero-demo.facts');
    const text = transcriptOf(await renderHome(m)).textContent!;
    // The 10 Nov re-cut cut the spoken price and the $19/$29 price card; the
    // end card's small print is the only price left.
    expect(text).toContain(`then $${v.plan.usdPerMonth}/month”`);
    expect(text).not.toMatch(/Plans start at|plans from|Standard|\bPro\b|\$19|\$29/);
    // The 2 Nov re-cut ends on the free posts, not on a trial.
    expect(text).toContain(`Get ${v.freePosts} free posts →`);
    expect(text).not.toMatch(/\btrial\b/i);
    expect(text).toContain(`Connect your accounts once. ${v.networks.join(', ')}.`);
    // The only dollar figure is the end card's one plan.
    expect([...new Set([...text.matchAll(/\$(\d+)/g)].map((d) => Number(d[1])))]).toEqual([v.plan.usdPerMonth]);
  });

  it('says "free" only for the end card\'s free posts and names no one, with or without a trial cutoff', async () => {
    for (const env of [PRODUCTION, NO_CUTOFF]) {
      const text = transcriptOf(await renderHome(load(env))).querySelector('ul')!.textContent!;
      expect(text.match(/free/gi)).toEqual(['free']);
      expect(text).toContain('“Get 3 free posts →”');
      expect(text).not.toMatch(/founder|jatinder|mohan|bhanushali|sakshi/i);
      while (views.length) views.pop()!.unmount();
    }
  });

  // Both cuts say the same Script 1 words (its burned-in captions), so every
  // line shows at every width, in the order said, and no competitor is named.
  it('is the Script 1 narration, line for line, at every width', async () => {
    const items = [...transcriptOf(await renderHome(load(PRODUCTION))).querySelectorAll('li')];
    for (const li of items) expect(li.className).toBe('');
    expect(items.map(said)).toEqual([
      'Posting the same update to six apps eats an hour of your day.',
      'Here is the fastest way. This is Hookpost.',
      'Connect your accounts once. Instagram, LinkedIn, X, Threads, Facebook, YouTube, Pinterest.',
      'Then just tell Claude what you want.',
      'Write next week’s posts about my launch, one for each network, and schedule them for 9 am.',
      'Claude writes each post in that platform style and drops it into your Hookpost calendar.',
      'You review, tweak anything, and everything goes out on time.',
      'Prefer the terminal? Same thing from the Hookpost CLI.',
      'hookpost.hookstep.in',
    ]);
    expect(items.map((li) => li.textContent).join(' ')).not.toMatch(/Hootsuite|Sprout|\$99|\$79/);
    // Only the 16:9 CLI panel shows a `hookpost post` example; phones read this too.
    expect(items[7].textContent).not.toContain('hookpost post');
  });

  // Until 2 Nov 2026 the cut ended on "Start your 3-day trial" (said and on
  // the end card), an offer new users no longer get, and the transcript closed
  // on a note saying so. The re-cut ends on today's offer, so the transcript's
  // last line is the end card itself, and the note is gone.
  it('ends on the end card\'s free posts, the offer new users get today (production build)', async () => {
    const m = load(PRODUCTION);
    const { TRIAL_SENTENCE } = require('./trial-offer') as typeof import('./trial-offer');
    const t = transcriptOf(await renderHome(m));
    const last = [...t.querySelectorAll('li')].pop()!;
    expect(said(last)).toBe('hookpost.hookstep.in');
    expect(last.textContent).toContain(
      'On screen: The Hookpost logo and “Get 3 free posts →”, then “No card needed · then $7/month”.'
    );
    expect(TRIAL_SENTENCE).toContain('3 free posts, no card needed.');
    expect(t.querySelector('[data-testid="hero-demo-transcript-offer"]')).toBeNull();
    expect(t.textContent).not.toMatch(/\btrial\b|has since changed/i);
  });
});

describe('the homepage copy around it', () => {
  it('has no Free plan, old price or old trial length (production build)', async () => {
    const page = await renderHome(load(PRODUCTION));
    const text = page.textContent!;
    expect(text).not.toMatch(/free forever/i);
    expect(text).not.toMatch(/\$15\b/);
    expect(text).not.toMatch(/try it yourself free/i);
    expect(text).not.toMatch(/\bstart free\b/i);
    expect(text).not.toMatch(/\b7[- ]day/i);
    expect(text).not.toMatch(/founder demo/i);
    expect(text).toContain('Get 3 free posts');
  });

  // The video said "Start your 3-day trial" until its 2 Nov re-cut, and
  // nothing on the page may say it either: not the transcript, not the
  // VideoObject (nor the sitemap, which takes its description), not any other
  // JSON-LD node or copy.
  it('says "N-day trial" nowhere, transcript and JSON-LD included (production build)', async () => {
    const page = await renderHome(load(PRODUCTION));
    const transcript = page.querySelector('[data-testid="hero-demo-transcript"]')!;
    expect(transcript.textContent).not.toMatch(/\d+[- ]day (free )?trial/i);
    const ld = [...page.querySelectorAll('script[type="application/ld+json"]')].map((el) => el.textContent || '');
    expect(ld.join('\n')).toContain('"VideoObject"');
    expect(ld.join('\n')).not.toMatch(/\d+[- ]day (free )?trial/i);
    page.querySelectorAll('script').forEach((el) => el.remove());
    const text = page.textContent || '';
    expect(text).not.toMatch(/\d+[- ]day (free )?trial/i);
    expect(text).toContain('3 free posts, no card needed. Then $7/month');
    expect(ld.join('\n')).toContain('3 free posts, no card needed. Then $7/month');
    expect(text).not.toMatch(/₹\s?(599|699)/);
  });
});

describe('playback: tap to play, desktop autoplay', () => {
  type Observed = { callback: IntersectionObserverCallback; disconnected: boolean };
  let observers: Observed[];
  let play: jest.SpyInstance;
  let pause: jest.SpyInstance;

  // jsdom has neither IntersectionObserver nor media playback.
  beforeEach(() => {
    observers = [];
    (window as any).IntersectionObserver = class {
      private o: Observed;
      constructor(callback: IntersectionObserverCallback) {
        this.o = { callback, disconnected: false };
        observers.push(this.o);
      }
      observe() {}
      disconnect() {
        this.o.disconnected = true;
      }
    };
    const paused = new WeakMap<HTMLMediaElement, boolean>();
    jest.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (this: HTMLMediaElement) {
      return paused.get(this) ?? true;
    });
    // A fast network: the first frame plays at once ("playing" right after "play").
    play = jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      paused.set(this, false);
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    });
    pause = jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      paused.set(this, true);
      this.dispatchEvent(new Event('pause'));
    });
  });

  const scroll = async (m: Mods, inView: boolean) => {
    await m.rtl.act(async () => {
      for (const o of observers.filter((x) => !x.disconnected)) {
        o.callback([{ isIntersecting: inView } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });
  };

  it('plays muted when half of it is in view, and pauses when scrolled away', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    expect(observers).toHaveLength(1);
    expect(play).not.toHaveBeenCalled();
    await scroll(m, true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(video.muted).toBe(true);
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
    await scroll(m, false);
    expect(pause).toHaveBeenCalledTimes(1);
    await scroll(m, true);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('leaves the video alone once the visitor pauses it', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    await scroll(m, true);
    await m.rtl.act(async () => {
      video.pause(); // the visitor, through the controls
    });
    await scroll(m, false);
    await scroll(m, true);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('leaves the video playing once the visitor unmutes it', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    await scroll(m, true);
    await m.rtl.act(async () => {
      video.muted = false;
      video.dispatchEvent(new Event('volumechange'));
    });
    await scroll(m, false);
    expect(pause).not.toHaveBeenCalled();
  });

  it('never autoplays on mobile: it waits for a tap', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    await renderHome(m);
    expect(observers).toHaveLength(0);
    expect(play).not.toHaveBeenCalled();
  });

  it('on mobile, one tap on the poster plays it with sound and the play button goes', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const button = page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!;
    expect(button.getAttribute('aria-label')).toBe('Play the demo video');
    await m.rtl.act(async () => {
      button.click();
    });
    expect(play).toHaveBeenCalledTimes(1);
    expect(page.querySelector('video')!.muted).toBe(false);
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
  });

  // jsdom never focuses a <video>, so the call is what is checked here;
  // home-video.spec.ts checks document.activeElement in Chrome.
  it('hands keyboard focus to the video as the play button goes', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    const button = page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!;
    const focus = jest.spyOn(HTMLElement.prototype, 'focus');
    button.focus();
    expect(document.activeElement).toBe(button);
    await m.rtl.act(async () => {
      button.click();
    });
    expect(focus.mock.contexts).toContain(video);
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
  });

  it('never autoplays with reduced motion', async () => {
    viewport.reducedMotion = true;
    const m = load(PRODUCTION);
    await renderHome(m);
    expect(observers).toHaveLength(0);
  });

  // navigator.connection (Chromium): Save-Data, or a connection Chrome rates 2G.
  it.each([
    [{ saveData: true, effectiveType: '4g' }, false],
    [{ effectiveType: 'slow-2g' }, false],
    [{ effectiveType: '2g' }, false],
    [{ effectiveType: '3g' }, true],
    [{ effectiveType: '4g' }, true],
    [undefined, true],
  ])('autoplays on desktop with connection %p: %p', async (connection, autoplays) => {
    const had = Object.getOwnPropertyDescriptor(navigator, 'connection');
    Object.defineProperty(navigator, 'connection', { configurable: true, value: connection });
    try {
      const m = load(PRODUCTION);
      await renderHome(m);
      expect(observers).toHaveLength(autoplays ? 1 : 0);
      expect(m.video.autoplayAllowed()).toBe(autoplays);
    } finally {
      if (had) Object.defineProperty(navigator, 'connection', had);
      else delete (navigator as any).connection;
    }
  });

  it('hides the native controls after hydration, so the poster shows, and brings them back on play', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    expect(video.hasAttribute('controls')).toBe(false);
    await m.rtl.act(async () => {
      page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!.click();
    });
    expect(video.hasAttribute('controls')).toBe(true);
  });

  /** play() that starts but has no frame yet (a slow network), or refuses. */
  const slowPlay = (result: Promise<void> = Promise.resolve()) =>
    play.mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('play'));
      return result;
    });

  it('on desktop autoplay, the poster and button stay until a frame is playing, then the controls come back', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    slowPlay();
    await scroll(m, true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(page.querySelector('[data-testid="hero-demo-play"]')).not.toBeNull();
    expect(video.hasAttribute('controls')).toBe(false);
    await m.rtl.act(async () => {
      video.dispatchEvent(new Event('playing'));
    });
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('after a tap with no frame yet, the button is a spinner and the poster stays; the first frame swaps in the controls', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    slowPlay();
    const button = page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!;
    await m.rtl.act(async () => {
      button.click();
    });
    const loading = page.querySelector('[data-testid="hero-demo-play"]')!;
    expect(loading.getAttribute('data-phase')).toBe('loading');
    expect(loading.getAttribute('aria-label')).toBe('Loading the demo video');
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelector('.animate-spin')).not.toBeNull();
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.muted).toBe(false);
    await m.rtl.act(async () => {
      video.dispatchEvent(new Event('playing'));
    });
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('a play() the browser refuses puts the play button back', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    slowPlay(Promise.reject(new DOMException('no', 'NotAllowedError')));
    await m.rtl.act(async () => {
      page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!.click();
    });
    expect(page.querySelector('[data-testid="hero-demo-play"]')!.getAttribute('data-phase')).toBe('idle');
    expect(page.querySelector('video')!.hasAttribute('controls')).toBe(false);
  });

  // A phone held sideways, or a tablet, is as wide as a laptop: no autoplay
  // without a mouse.
  it('never autoplays on a wide touch screen', async () => {
    viewport.desktop = true;
    viewport.finePointer = false;
    const m = load(PRODUCTION);
    await renderHome(m);
    expect(observers).toHaveLength(0);
    expect(m.video.autoplayAllowed()).toBe(false);
    expect(play).not.toHaveBeenCalled();
  });

  it('autoplay moves keyboard focus from the play button to the video when the button goes', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    const button = page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!;
    const focus = jest.spyOn(HTMLElement.prototype, 'focus');
    button.focus();
    await scroll(m, true);
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
    expect(focus.mock.contexts).toContain(video);
  });

  // The 404 case: every <source> fails, which leaves networkState at
  // NETWORK_NO_SOURCE and fires "error" on the last <source> only.
  it('when every source fails: the poster stays, a line points at the transcript, no play button or controls', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    jest.spyOn(video, 'networkState', 'get').mockReturnValue(HTMLMediaElement.NETWORK_NO_SOURCE);
    const sources = video.querySelectorAll('source');
    await m.rtl.act(async () => {
      sources[sources.length - 1].dispatchEvent(new Event('error'));
    });
    const failed = page.querySelector('[data-testid="hero-demo-status"]')!;
    expect(failed.getAttribute('role')).toBe('status');
    expect(failed.textContent).toMatch(/didn.t load\. The transcript below/);
    expect(failed.className).not.toContain('sr-only');
    expect(page.querySelector('[data-testid="hero-demo-play"]')).toBeNull();
    expect(video.hasAttribute('controls')).toBe(false);
    expect(page.querySelector('[data-testid="hero-demo-poster"]')).not.toBeNull();
    // play() with nothing playable leaves the element "playing"; it is paused.
    expect(pause).toHaveBeenCalled();
  });

  // Right after parsing, networkState is NETWORK_NO_SOURCE until the browser
  // has picked a source; that alone is not a failure (a real page load).
  it('NETWORK_NO_SOURCE at hydration, with no error event, is not a failure', async () => {
    viewport.desktop = false;
    const spy = jest
      .spyOn(HTMLMediaElement.prototype, 'networkState', 'get')
      .mockReturnValue(HTMLMediaElement.NETWORK_NO_SOURCE);
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    expect(page.querySelector('[data-testid="hero-demo-status"]')!.textContent).toBe('');
    expect(page.querySelector('[data-testid="hero-demo-play"]')).not.toBeNull();
    spy.mockRestore();
  });

  it('one failed source is not a failure: the browser moves on to the next', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    jest.spyOn(video, 'networkState', 'get').mockReturnValue(HTMLMediaElement.NETWORK_LOADING);
    await m.rtl.act(async () => {
      video.querySelector('source')!.dispatchEvent(new Event('error'));
    });
    expect(page.querySelector('[data-testid="hero-demo-status"]')!.textContent).toBe('');
    expect(page.querySelector('[data-testid="hero-demo-play"]')).not.toBeNull();
  });

  it('a file that loads but cannot be decoded is a failure too, and desktop autoplay leaves it alone', async () => {
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    // jsdom has no media error; a real browser sets MediaError code 3 (DECODE).
    Object.defineProperty(video, 'error', { configurable: true, get: () => ({ code: 3 }) });
    await m.rtl.act(async () => {
      video.dispatchEvent(new Event('error'));
    });
    expect(page.querySelector('[data-testid="hero-demo-status"]')!.textContent).toMatch(/didn.t load/);
    await scroll(m, true);
    expect(play).not.toHaveBeenCalled();
  });

  it('a failure after a tap moves keyboard focus from the button to the status line', async () => {
    viewport.desktop = false;
    const m = load(PRODUCTION);
    const page = await renderHome(m);
    const video = page.querySelector('video')!;
    slowPlay(new Promise(() => undefined));
    const button = page.querySelector<HTMLButtonElement>('[data-testid="hero-demo-play"]')!;
    button.focus();
    await m.rtl.act(async () => {
      button.click();
    });
    jest.spyOn(video, 'networkState', 'get').mockReturnValue(HTMLMediaElement.NETWORK_NO_SOURCE);
    const sources = video.querySelectorAll('source');
    await m.rtl.act(async () => {
      sources[sources.length - 1].dispatchEvent(new Event('error'));
    });
    expect(document.activeElement).toBe(page.querySelector('[data-testid="hero-demo-status"]'));
  });
});

describe('the video files', () => {
  // Budgets per file, for a 40.3 s narrated cut (not a short loop).
  const MAX = { webm: 2_000_000, mp4: 2_500_000, avif: 20 * 1024, webp: 40 * 1024 };

  // MP4 top-level boxes, in file order.
  const boxes = (buf: Buffer) => {
    const out: string[] = [];
    for (let i = 0; i + 8 <= buf.length; ) {
      const size = buf.readUInt32BE(i);
      out.push(buf.toString('latin1', i + 4, i + 8));
      if (size < 8) break;
      i += size;
    }
    return out;
  };
  // Width and height from the avc1 sample entry (after stsd: ftyp lists
  // "avc1" as a brand too).
  const avc1Size = (buf: Buffer) => {
    const at = buf.indexOf('avc1', buf.indexOf('stsd', 0, 'latin1'), 'latin1');
    return at < 0 ? null : { width: buf.readUInt16BE(at + 28), height: buf.readUInt16BE(at + 30) };
  };
  // Width and height from a lossy WebP's VP8 frame header.
  const webpSize = (buf: Buffer) => ({
    riff: buf.toString('latin1', 0, 4) + buf.toString('latin1', 8, 12),
    width: buf.readUInt16LE(26) & 0x3fff,
    height: buf.readUInt16LE(28) & 0x3fff,
  });
  // An AVIF's brand and its image size from the ispe property.
  const avifSize = (buf: Buffer) => {
    const at = buf.indexOf('ispe', 0, 'latin1');
    return {
      brand: buf.toString('latin1', 8, 12),
      width: at < 0 ? 0 : buf.readUInt32BE(at + 8),
      height: at < 0 ? 0 : buf.readUInt32BE(at + 12),
    };
  };
  // A WebM's DocType and codec IDs, and the seq_level_idx in AV1's
  // CodecPrivate (av1C: marker/version, then profile(3 bits) + level(5 bits)).
  const webmInfo = (buf: Buffer) => {
    const head = buf.subarray(0, 4096);
    const v = head.indexOf('V_AV1', 0, 'latin1');
    // CodecPrivate (0x63A2), then a one-byte size, then av1C.
    const cp = head.indexOf(Buffer.from([0x63, 0xa2]), v);
    const av1c = cp < 0 ? -1 : cp + 3;
    return {
      ebml: buf.readUInt32BE(0) === 0x1a45dfa3,
      docType: head.includes('webm', 0, 'latin1'),
      av1: v > -1,
      opus: head.includes('A_OPUS', 0, 'latin1'),
      level: av1c < 0 ? -1 : head[av1c + 1] & 0x1f,
      profile: av1c < 0 ? -1 : head[av1c + 1] >> 5,
    };
  };
  const sha10 = (buf: Buffer) => require('crypto').createHash('sha256').update(buf).digest('hex').slice(0, 10);

  const CUTS = [
    ['desktop', 1280, 720],
    ['mobile', 720, 1280],
  ] as const;

  it.each(CUTS)('%s: every file name carries its own SHA-256, so NGINX can cache it as immutable', (key) => {
    const { HERO_DEMO } = require('./hero-demo') as typeof import('./hero-demo');
    for (const url of [HERO_DEMO[key].webm, HERO_DEMO[key].mp4, HERO_DEMO[key].posterAvif, HERO_DEMO[key].posterWebp]) {
      const m = url.match(/^\/video\/[a-z0-9-]+\.([0-9a-f]{10})\.(webm|mp4|avif|webp)$/);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(sha10(fs.readFileSync(path.join(PUBLIC, url))));
    }
  });

  it.each(CUTS)('%s: AV1/Opus WebM at most 2 MB, level 3.1, the length of the MP4', (key, w, h) => {
    const { HERO_DEMO, WEBM_AV1_TYPE } = require('./hero-demo') as typeof import('./hero-demo');
    const webm = fs.readFileSync(path.join(PUBLIC, HERO_DEMO[key].webm));
    expect(webm.length).toBeLessThanOrEqual(MAX.webm);
    // av01.0.05M.08 in WEBM_AV1_TYPE: profile 0 (Main), seq_level_idx 5 (3.1).
    expect(WEBM_AV1_TYPE).toContain('av01.0.05M.08');
    expect(webmInfo(webm)).toEqual({ ebml: true, docType: true, av1: true, opus: true, level: 5, profile: 0 });
    expect(HERO_DEMO[key]).toMatchObject({ width: w, height: h });
  });

  it.each(CUTS)('%s: H.264 MP4 at most 2.5 MB, faststart, at the size of its box', (key, w, h) => {
    const { HERO_DEMO } = require('./hero-demo') as typeof import('./hero-demo');
    const mp4 = fs.readFileSync(path.join(PUBLIC, HERO_DEMO[key].mp4));
    expect(mp4.length).toBeLessThanOrEqual(MAX.mp4);
    const order = boxes(mp4);
    expect(order[0]).toBe('ftyp');
    expect(order.indexOf('moov')).toBeGreaterThan(-1);
    expect(order.indexOf('moov')).toBeLessThan(order.indexOf('mdat'));
    expect(avc1Size(mp4)).toEqual({ width: w, height: h });
    expect(mp4.indexOf('mp4a', 0, 'latin1')).toBeGreaterThan(-1);
    const { HERO_DEMO_VIDEO_FACTS } = require('./hero-demo.facts') as typeof import('./hero-demo.facts');
    expect(mp4Seconds(mp4)).toBeCloseTo(HERO_DEMO_VIDEO_FACTS.durationSeconds, 1);
  });

  it.each(CUTS)('%s: small AVIF and WebP posters at the size of the video', (key, w, h) => {
    const { HERO_DEMO } = require('./hero-demo') as typeof import('./hero-demo');
    const avif = fs.readFileSync(path.join(PUBLIC, HERO_DEMO[key].posterAvif));
    expect(avif.length).toBeLessThanOrEqual(MAX.avif);
    expect(avifSize(avif)).toEqual({ brand: 'avif', width: w, height: h });
    const webp = fs.readFileSync(path.join(PUBLIC, HERO_DEMO[key].posterWebp));
    expect(webp.length).toBeLessThanOrEqual(MAX.webp);
    expect(webpSize(webp)).toEqual({ riff: 'RIFFWEBP', width: w, height: h });
  });

  it('public/video holds only the files the page and the ad landing use', () => {
    const { HERO_DEMO } = require('./hero-demo') as typeof import('./hero-demo');
    const used = Object.values(HERO_DEMO).flatMap((c) => [c.webm, c.mp4, c.posterAvif, c.posterWebp]);
    const adLanding = ['/video/hookpost-claude-run-9x16.mp4', '/video/hookpost-claude-run-9x16.jpg'];
    const present = fs.readdirSync(path.join(PUBLIC, 'video')).map((f) => `/video/${f}`);
    expect(present.sort()).toEqual([...used, ...adLanding].sort());
  });

  // The figures in the cuts are pixels: a price change on the site never
  // reaches them, so each one is held against its source here.
  // [what, in the video (hero-demo.facts.ts), at its source]
  type Figure = [string, unknown, unknown];
  const RECUT =
    'The homepage demo video shows a figure its source no longer matches. Re-cut the video with the new figures ' +
    'and publish it under NEW file names (NGINX caches public/video for a day, see hero-demo.ts), then update ' +
    'hero-demo.ts, hero-demo.facts.ts and this spec to the new cut. Editing hero-demo.facts.ts alone leaves the ' +
    'old figures on screen.';
  const checkFigures = (figures: Figure[]) => {
    const wrong = figures.filter(([, video, source]) => video !== source);
    if (wrong.length) {
      throw new Error(
        [RECUT, ...wrong.map(([what, video, source]) => `  ${what}: the video says ${video}, the source says ${source}`)].join('\n')
      );
    }
  };
  // A network the cut names, as published-networks.ts has it: the name itself
  // when Hookpost has published there (the cut says "Facebook" for the
  // Facebook Pages integration), otherwise a value that never matches.
  const published = (name: string) => {
    const { PUBLISHED_NETWORKS } = require('./channels/published-networks') as typeof import('./channels/published-networks');
    return PUBLISHED_NETWORKS.some((n) => n === name || n.startsWith(`${name} `)) ? name : 'not in PUBLISHED_NETWORKS';
  };
  const figures = (): Figure[] => {
    const { HERO_DEMO_FACTS: v } = require('./hero-demo.facts') as typeof import('./hero-demo.facts');
    const { pricingUSD } = require('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing') as typeof import('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing');
    const { FREE_POST_LIMIT } = require('@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy') as typeof import('@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy');
    return [
      ['The plan, dollars a month (pricing.ts, pricingUSD.HOOKPOST.month_price)', v.plan.usdPerMonth, pricingUSD.HOOKPOST.month_price],
      ['Free posts on the end card (trial.policy.ts, FREE_POST_LIMIT)', v.freePosts, FREE_POST_LIMIT],
      ...v.networks.map((name): Figure => [
        `Network "${name}" (published-networks.ts, PUBLISHED_NETWORKS)`,
        name,
        published(name),
      ]),
    ];
  };

  it('every figure burned into the cuts matches pricing.ts, trial.policy.ts and published-networks.ts', () => {
    const list = figures();
    // The plan's price, the free posts, then the seven networks.
    expect(list).toHaveLength(9);
    checkFigures(list);
  });

  it('a network Hookpost has not published to fails the check', () => {
    expect(published('Facebook')).toBe('Facebook');
    expect(() => checkFigures([['Network "Bluesky"', 'Bluesky', published('Bluesky')]])).toThrow(
      /Network "Bluesky": the video says Bluesky, the source says not in PUBLISHED_NETWORKS/
    );
  });

  it('a source that moves fails with the instruction to re-cut under new file names', () => {
    const moved = figures().map(([what, video, source]): Figure =>
      what.startsWith('The plan, dollars') ? [what, video, Number(source) + 4] : [what, video, source]
    );
    expect(() => checkFigures(moved)).toThrow(/Re-cut the video .* under NEW file names/);
    expect(() => checkFigures(moved)).toThrow(/The plan, dollars a month .*: the video says 7, the source says 11/);
  });

  it('the synthetic-voice demo is gone from public/', () => {
    for (const old of ['hookpost-demo-en.mp4', 'founder-demo.mp4']) {
      expect(fs.existsSync(path.join(PUBLIC, 'video', old))).toBe(false);
    }
  });

  // The 24 Oct round-5 cuts (Hootsuite and Sprout Social prices) were
  // replaced by Script 1 on 25 Oct under new names; the old files go too.
  it('the 24 Oct cuts and posters are gone from public/ and from the code', () => {
    const old = ['hookpost-demo-16x9.mp4', 'hookpost-demo-16x9.webp', 'hookpost-demo-9x16.mp4', 'hookpost-demo-9x16.webp'];
    for (const f of old) expect(fs.existsSync(path.join(PUBLIC, 'video', f))).toBe(false);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
      );
    const refs = walk(SRC)
      .filter((f) => /\.(tsx?|jsx?|mjs|cjs|txt|md)$/.test(f) && !f.endsWith('hero-demo.spec.ts'))
      .filter((f) => /hookpost-demo-(16x9|9x16)\./.test(fs.readFileSync(f, 'utf8')));
    expect(refs).toEqual([]);
  });

  // The 25 Oct encodes ended on "Start your 3-day trial"; the 2 Nov re-cut
  // replaced them under new names, and the old files go too.
  it('the 25 Oct trial-offer encodes are gone from public/ and from the code', () => {
    const old = [
      'hookpost-home-s1-16x9.a449aeaa23.webm',
      'hookpost-home-s1-16x9.b981f0a952.mp4',
      'hookpost-home-s1-9x16.283d91a7a9.webm',
      'hookpost-home-s1-9x16.cead03cee8.mp4',
    ];
    for (const f of old) expect(fs.existsSync(path.join(PUBLIC, 'video', f))).toBe(false);
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
      );
    const refs = walk(SRC)
      .filter((f) => /\.(tsx?|jsx?|mjs|cjs|txt|md)$/.test(f) && !f.endsWith('hero-demo.spec.ts'))
      .filter((f) => old.some((o) => fs.readFileSync(f, 'utf8').includes(o)));
    expect(refs).toEqual([]);
  });

  it('the synthetic-voice demo is not referenced from the code', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
      );
    const refs = walk(SRC)
      .filter((f) => /\.(tsx?|jsx?|mjs|cjs|txt|md)$/.test(f) && !f.endsWith('hero-demo.spec.ts'))
      .filter((f) => /hookpost-demo-en\.mp4|founder-demo\.mp4/.test(fs.readFileSync(f, 'utf8')));
    expect(refs).toEqual([]);
  });
});

// The E2E side (the build serves both URLs, sitemap.xml lists the video):
// tests/e2e/specs/home-video.spec.ts.
describe('the VideoObject on / (hero-demo.schema.ts)', () => {
  const ORIGIN = 'https://hookpost.hookstep.in';

  /** Every JSON-LD block the homepage renders, parsed, and their @graph nodes. */
  const ldOf = (page: HTMLElement) => {
    const blocks = [...page.querySelectorAll('script[type="application/ld+json"]')].map((s) =>
      JSON.parse(s.textContent!)
    );
    return { blocks, nodes: blocks.flatMap((b) => b['@graph'] ?? [b]) as Array<Record<string, any>> };
  };
  const videoOf = async (m: Mods) => ldOf(await renderHome(m)).nodes.find((n) => n['@type'] === 'VideoObject')!;

  // A build with no cutoff, where new users still get the Free plan: the
  // VideoObject gives the Free-plan words and offers no trial.
  it('with no trial cutoff: the description ends on the Free-plan words, no trial', async () => {
    const page = await renderHome(load(NO_CUTOFF));
    const video = ldOf(page).nodes.find((n) => n['@type'] === 'VideoObject')!;
    expect(video.description.endsWith(' There is a free tier with no card needed.')).toBe(true);
    expect(video.description).not.toMatch(/\d+[- ]day (free )?trial/i);
    expect(video.description).not.toContain('3 free posts');
  });

  it('is one VideoObject in JSON that parses, next to the FAQPage the page already had', async () => {
    const { blocks, nodes } = ldOf(await renderHome(load(PRODUCTION)));
    expect(blocks.length).toBeGreaterThan(0);
    expect(nodes.filter((n) => n['@type'] === 'VideoObject')).toHaveLength(1);
    const faq = nodes.find((n) => n['@type'] === 'FAQPage')!;
    expect(faq['@id']).toBe(`${ORIGIN}/#faq`);
    expect(faq.mainEntity.length).toBeGreaterThan(0);
  });

  // Google's video structured data: name, thumbnailUrl and uploadDate are
  // required; description, contentUrl and duration recommended.
  it('has every property Google asks of a VideoObject, in valid formats, under a schema.org @context', async () => {
    const { blocks, nodes } = ldOf(await renderHome(load(PRODUCTION)));
    const video = nodes.find((n) => n['@type'] === 'VideoObject')!;
    const block = blocks.find((b) => (b['@graph'] ?? [b]).includes(video))!;
    expect(block['@context']).toMatch(/^https?:\/\/schema\.org\/?$/);
    for (const key of ['name', 'description', 'thumbnailUrl', 'uploadDate', 'contentUrl', 'duration']) {
      expect(typeof video[key]).toBe('string');
      expect(video[key].length).toBeGreaterThan(0);
    }
    // A full ISO 8601 instant WITH a zone. The optional-time form this used to
    // allow is what let the bare '2026-10-25' through, which Search Console
    // then rejected (schema-datetime.ts).
    expect(isSchemaDateTime(video.uploadDate)).toBe(true);
    expect(video.uploadDate).toMatch(/[+-]\d{2}:\d{2}$|Z$/);
    expect(video.duration).toMatch(/^PT(\d+H)?(\d+M)?(\d+S)?$/);
    expect(video.contentUrl).toMatch(/\.mp4$/);
    expect(video.thumbnailUrl).toMatch(/\.(webp|jpe?g|png)$/);
    expect(video.description.length).toBeLessThanOrEqual(2048);
  });

  it('points at the 16:9 cut and its poster by absolute URL, and both files are in public/', async () => {
    const m = load(PRODUCTION);
    const video = await videoOf(m);
    for (const key of ['contentUrl', 'thumbnailUrl']) {
      expect(video[key]).toMatch(/^https:\/\//);
      const url = new URL(video[key]);
      expect(url.origin).toBe(ORIGIN);
      expect(fs.existsSync(path.join(PUBLIC, url.pathname))).toBe(true);
    }
    expect(video.contentUrl).toBe(`${ORIGIN}${m.demo.HERO_DEMO.desktop.mp4}`);
    expect(video.thumbnailUrl).toBe(`${ORIGIN}${m.demo.HERO_DEMO.desktop.posterWebp}`);
    expect([video.width, video.height]).toEqual([1280, 720]);
    expect(video).not.toHaveProperty('embedUrl');
  });

  it('has the length and upload date in hero-demo.facts.ts, and that length is the file’s own', async () => {
    const { HERO_DEMO_VIDEO_FACTS: f } = require('./hero-demo.facts') as typeof import('./hero-demo.facts');
    const m = load(PRODUCTION);
    const video = await videoOf(m);
    expect(video.duration).toBe(`PT${Math.round(f.durationSeconds)}S`);
    expect(video.duration).toBe('PT40S');
    expect(video.uploadDate).toBe(f.uploadDate);
    expect(video.uploadDate).toBe('2026-11-10T10:00:00+05:30');
    const mp4 = fs.readFileSync(path.join(PUBLIC, m.demo.HERO_DEMO.desktop.mp4));
    expect(mp4Seconds(mp4)).toBeCloseTo(f.durationSeconds, 1);
  });

  it.each([
    [46.2, 'PT46S'],
    [21.9, 'PT22S'],
    [65, 'PT1M5S'],
    [120, 'PT2M'],
    [0.4, 'PT0S'],
  ])('writes %p seconds as %p', (seconds, iso) => {
    const { isoDuration } = require('./hero-demo.schema') as typeof import('./hero-demo.schema');
    expect(isoDuration(seconds)).toBe(iso);
  });

  it('says "free" only in today\'s offer, no trial, names no one, and takes every plan figure from pricing.ts', async () => {
    const { pricingUSD } = require('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing') as typeof import('@hookpost/nestjs-libraries/database/prisma/subscriptions/pricing');
    const m = load(PRODUCTION);
    const video = await videoOf(m);
    expect(video.name).toBe(m.demo.HERO_DEMO_LABEL);
    const { TRIAL_SENTENCE } = require('./trial-offer') as typeof import('./trial-offer');
    expect(video.description.endsWith(` ${TRIAL_SENTENCE}`)).toBe(true);
    const cutText = video.description.replace(TRIAL_SENTENCE, '');
    for (const text of [video.name, cutText]) {
      expect(text).not.toMatch(/free/i);
      expect(text).not.toMatch(/founder|jatinder|mohan|bhanushali|sakshi/i);
    }
    const s = pricingUSD.STANDARD;
    const p = pricingUSD.PRO;
    // The description names no retired plan or old price (owner, 9 Nov 2026).
    void s;
    void p;
    expect(video.description).not.toMatch(/\$19|\$29|Standard|\bPro\b|Plans start at/);
    expect(video.description).not.toMatch(/\d+[- ]day (free )?trial/i);
    expect(video.description).toContain('3 free posts, no card needed. Then $7/month');
    expect(video.description).not.toMatch(/₹/);
    expect(video.description).toContain('Connect Instagram, LinkedIn, X, Threads, Facebook, YouTube and Pinterest to Hookpost once');
    // No dollar figure outside the free-posts sentence.
    expect(cutText).not.toMatch(/\$\d/);
  });
});

describe('the video in sitemap.xml (sitemap.ts)', () => {
  const sitemap = (): import('next').MetadataRoute.Sitemap => {
    load(PRODUCTION);
    let entries!: import('next').MetadataRoute.Sitemap;
    jest.isolateModules(() => {
      entries = require('../sitemap').default();
    });
    return entries;
  };

  it('lists the 16:9 cut on / and nowhere else, with the VideoObject’s title, URLs, length and date', () => {
    const entries = sitemap();
    const withVideo = entries.filter((e) => e.videos?.length);
    expect(withVideo.map((e) => e.url)).toEqual(['https://hookpost.hookstep.in']);
    const { heroDemoVideoObject } = require('./hero-demo.schema') as typeof import('./hero-demo.schema');
    const ld = heroDemoVideoObject();
    expect(withVideo[0].videos).toEqual([
      {
        title: ld.name,
        description: ld.description,
        thumbnail_loc: ld.thumbnailUrl,
        content_loc: ld.contentUrl,
        duration: 40,
        publication_date: '2026-11-10T10:00:00+05:30',
      },
    ]);
  });

  // Next copies the video fields into the XML without escaping them.
  it('comes out of Next’s serializer as well-formed XML with one <video:video>', () => {
    const { resolveSitemap } = require('next/dist/build/webpack/loaders/metadata/resolve-route-data');
    const entries = sitemap();
    const home = entries.find((e) => e.url === 'https://hookpost.hookstep.in')!;
    for (const value of Object.values(home.videos![0])) expect(String(value)).not.toMatch(/[&<>]/);
    const doc = new DOMParser().parseFromString(resolveSitemap(entries), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const NS = 'http://www.google.com/schemas/sitemap-video/1.1';
    expect(doc.getElementsByTagNameNS(NS, 'video')).toHaveLength(1);
    expect(doc.getElementsByTagNameNS(NS, 'content_loc')[0].textContent).toBe(
      'https://hookpost.hookstep.in/video/hookpost-home-s1-16x9.31a51ee739.mp4'
    );
    expect(doc.getElementsByTagNameNS(NS, 'duration')[0].textContent).toBe('40');
  });
});
