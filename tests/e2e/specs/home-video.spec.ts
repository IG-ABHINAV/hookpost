/**
 * The homepage demo video, from the production build: on a phone nothing of
 * it loads before a tap (not on load, not on scrolling to it) and a tap plays
 * the 9:16 cut; on desktop the 16:9 cut is the one picked (AV1 WebM where the
 * browser decodes it, else the H.264 MP4) and autoplays muted once in view,
 * but never with reduced motion, Save-Data or a 2G connection; the poster is a
 * lazy picture with fixed dimensions that shifts nothing; a phone held
 * sideways (as wide as a laptop) never autoplays; on slow 3G the button turns
 * into a spinner and the poster stays until a frame plays; without JS the
 * poster shows and the play button is a link to the MP4; when the files 404
 * the poster stays and a line points at the transcript; the play button hands keyboard
 * focus to the video; every file is served with ranges and the right type,
 * and the retired names are gone; the VideoObject in the homepage JSON-LD
 * points at files the build serves, and sitemap.xml lists the video. The
 * element itself, the copy around it, the encodes and the structured data's
 * fields: apps/frontend/src/app/(landing)/hero-demo.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import { failOnServerErrors } from './support';
import { HERO_DEMO } from '../../../apps/frontend/src/app/(landing)/hero-demo';

const DESKTOP = HERO_DEMO.desktop;
const MOBILE = HERO_DEMO.mobile;
const PHONE = { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true } as const;
const isMedia = (p: string) => /\.(mp4|webm)$/.test(p);

/** Every URL the page requests under /video/, in order. */
function videoRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname.startsWith('/video/')) seen.push(pathname);
  });
  return seen;
}

const media = (page: Page) =>
  page.getByTestId('hero-demo-video').evaluate((v: HTMLVideoElement) => ({
    readyState: v.readyState,
    paused: v.paused,
    muted: v.muted,
    controls: v.controls,
    currentSrc: new URL(v.currentSrc || 'http://x/', location.href).pathname,
    poster: v.getAttribute('poster'),
  }));

/** The poster <img> as the browser has it: which file it chose, and whether it decoded. */
const poster = (page: Page) =>
  page.getByTestId('hero-demo-poster').evaluate((img: HTMLImageElement) => ({
    currentSrc: new URL(img.currentSrc || 'http://x/', location.href).pathname,
    complete: img.complete,
    naturalWidth: img.naturalWidth,
    width: img.getAttribute('width'),
    height: img.getAttribute('height'),
  }));

const box = (page: Page) =>
  page.getByTestId('hero-demo-box').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  });

/** Layout shifts whose moved nodes include the video box or anything in it. */
async function videoShifts(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let sum = 0;
        const target = document.querySelector('[data-testid="hero-demo-box"]')!;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as any[]) {
            if ((e.sources ?? []).some((s: any) => s.node && (target === s.node || target.contains(s.node) || s.node.contains(target)))) {
              sum += e.value;
            }
          }
        }).observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => resolve(sum), 500);
      })
  );
}

test.describe('homepage demo video on a phone (375px)', () => {
  test.use(PHONE);

  test('requests no video before a tap (on load or on scrolling to it), then plays the 9:16 cut', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const requested = videoRequests(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(requested.filter(isMedia)).toEqual([]);

    const video = page.getByTestId('hero-demo-video');
    await expect(video).toHaveAttribute('preload', 'none');
    await expect(video).toHaveAttribute('playsinline', '');
    await video.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await poster(page)).naturalWidth).toBe(MOBILE.width);
    await page.waitForLoadState('networkidle');

    expect(requested.filter(isMedia)).toEqual([]);
    // One poster, the 9:16 AVIF (Chromium decodes AVIF), and nothing of the 16:9 cut.
    expect(requested).toEqual([MOBILE.posterAvif]);
    expect(await poster(page)).toMatchObject({ currentSrc: MOBILE.posterAvif, width: '720', height: '1280' });
    expect(await media(page)).toMatchObject({ readyState: 0, paused: true, controls: false, poster: null });

    // One tap on the poster (a tap on a bare <video> this narrow only shows
    // Chrome's controls).
    await page.getByTestId('hero-demo-play').tap();
    await expect(page.getByTestId('hero-demo-play')).toHaveCount(0);
    await expect(video).toBeFocused();
    await expect.poll(async () => (await media(page)).readyState, { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => (await media(page)).paused).toBe(false);
    const after = await media(page);
    expect(after.currentSrc).toBe(MOBILE.webm);
    expect(after.muted).toBe(false);
    expect(after.controls).toBe(true);
    expect(requested.filter(isMedia)).toEqual([MOBILE.webm]);
    errors.assertNone();
  });

  test('the poster has fixed dimensions and the box never shifts while it loads', async ({ page }) => {
    await page.goto('/');
    const before = await box(page);
    // 9:16 at phone width (at most 320 px wide), fixed before any poster byte arrives.
    expect(before.width).toBeGreaterThan(200);
    expect(before.width).toBeLessThanOrEqual(320);
    expect(Math.abs(before.height - (before.width * 16) / 9)).toBeLessThanOrEqual(1);
    await page.getByTestId('hero-demo-video').scrollIntoViewIfNeeded();
    await expect.poll(async () => (await poster(page)).complete).toBe(true);
    expect(await box(page)).toEqual(before);
    expect(await videoShifts(page)).toBe(0);
  });

  test('on a slow 3G connection: still no video bytes before a tap, and the page is usable', async ({ page, context }) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // DevTools' "Slow 3G": 400 ms RTT, 400 kb/s down.
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });
    const requested = videoRequests(page);
    await page.goto('/', { timeout: 90_000 });
    await expect(page.locator('h1')).toBeVisible();
    await page.getByTestId('hero-demo-video').scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    expect(requested.filter(isMedia)).toEqual([]);
    await expect(page.getByTestId('hero-demo-play')).toBeVisible();
    await expect(page.getByTestId('hero-demo-transcript')).toBeVisible();
    // A tap with no frame yet: a spinner on the poster, no grey controls panel.
    await page.getByTestId('hero-demo-play').tap();
    await expect(page.getByTestId('hero-demo-play')).toHaveAttribute('data-phase', 'loading');
    expect((await media(page)).controls).toBe(false);
    expect((await poster(page)).naturalWidth).toBe(MOBILE.width);
  });

  test('when the video files 404, the poster stays and a line points at the transcript', async ({ page }) => {
    await page.route(/\/video\/.+\.(mp4|webm)$/, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto('/');
    const video = page.getByTestId('hero-demo-video');
    await video.scrollIntoViewIfNeeded();
    const before = await box(page);
    await page.getByTestId('hero-demo-play').tap();
    await expect(page.getByTestId('hero-demo-status')).toHaveText(/didn.t load\. The transcript below/, { timeout: 15_000 });
    await expect(page.getByTestId('hero-demo-status')).toBeVisible();
    await expect(page.getByTestId('hero-demo-play')).toHaveCount(0);
    expect(await media(page)).toMatchObject({ controls: false, paused: true });
    expect((await poster(page)).naturalWidth).toBe(MOBILE.width);
    expect(await box(page)).toEqual(before);
    await expect(page.getByTestId('hero-demo-transcript')).toBeVisible();
  });

  test('a browser that cannot load the WebM (as Safari without AV1) plays the H.264 MP4', async ({ page }) => {
    await page.route(/\/video\/.+\.webm$/, (route) => route.fulfill({ status: 404, body: 'not found' }));
    await page.goto('/');
    await page.getByTestId('hero-demo-video').scrollIntoViewIfNeeded();
    await page.getByTestId('hero-demo-play').tap();
    // play() clears paused at once; wait for the fallback to have a frame.
    await expect.poll(async () => (await media(page)).currentSrc, { timeout: 15_000 }).toBe(MOBILE.mp4);
    await expect.poll(async () => (await media(page)).readyState, { timeout: 15_000 }).toBeGreaterThan(1);
    expect(await media(page)).toMatchObject({ paused: false, muted: false });
    await expect(page.getByTestId('hero-demo-status')).toHaveText('');
  });
});

test.describe('homepage demo video without JavaScript', () => {
  test.use({ ...PHONE, javaScriptEnabled: false });

  test('shows the poster with a play link to the 9:16 MP4 on top (what is actually under the finger), every source, no JS button', async ({ page }) => {
    await page.goto('/');
    const video = page.getByTestId('hero-demo-video');
    await video.scrollIntoViewIfNeeded();
    await expect(video).not.toHaveAttribute('controls', /.*/);
    await expect(video.locator('source')).toHaveCount(4);
    // Chrome shows native controls with JS off whatever the attributes say, so
    // the <noscript> poster sits after the video (on top of their grey panel).
    const nojsPoster = page.getByTestId('hero-demo-poster-nojs');
    await expect.poll(async () => nojsPoster.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(MOBILE.width);
    expect(
      await nojsPoster.evaluate(
        (img) => !!(img.compareDocumentPosition(document.querySelector('[data-testid="hero-demo-video"]')!) & Node.DOCUMENT_POSITION_PRECEDING)
      )
    ).toBe(true);
    expect(await nojsPoster.evaluate((img) => getComputedStyle(img).position)).toBe('absolute');
    await expect(page.getByTestId('hero-demo-play')).toHaveCount(0);
    // The element at the box's centre is the <noscript> link, not a grey panel.
    const hit = await page.getByTestId('hero-demo-box').evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const a = top?.closest('a');
      return a ? new URL(a.href).pathname : top?.tagName;
    });
    expect(hit).toBe(MOBILE.mp4);
    const size = await box(page);
    expect(Math.abs(size.height - (size.width * 16) / 9)).toBeLessThanOrEqual(1);
    // The transcript is server-rendered and opens without JS.
    await page.getByTestId('hero-demo-transcript').locator('summary').click();
    await expect(page.getByTestId('hero-demo-transcript').locator('li').first()).toBeVisible();
  });
});

test.describe('homepage demo video on a phone held sideways (915x412, touch)', () => {
  test.use({ viewport: { width: 915, height: 412 }, hasTouch: true, isMobile: true });

  test('gets the 16:9 layout but never autoplays: no video bytes until a tap', async ({ page }) => {
    const requested = videoRequests(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    await page.getByTestId('hero-demo-video').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    expect(requested.filter(isMedia)).toEqual([]);
    expect(await media(page)).toMatchObject({ paused: true, readyState: 0 });
    await expect(page.getByTestId('hero-demo-play')).toBeVisible();
  });
});

test.describe('homepage demo video on desktop', () => {
  test('picks the 16:9 cut and poster, and autoplays muted once in view', async ({ page }) => {
    const errors = failOnServerErrors(page);
    const requested = videoRequests(page);
    await page.goto('/');
    await page.waitForLoadState('load');
    const video = page.getByTestId('hero-demo-video');
    await video.scrollIntoViewIfNeeded();
    await expect.poll(async () => (await media(page)).paused, { timeout: 15_000 }).toBe(false);
    const now = await media(page);
    expect(now.currentSrc).toBe(DESKTOP.webm);
    expect(now.muted).toBe(true);
    expect(now.readyState).toBeGreaterThan(0);
    await expect.poll(async () => (await media(page)).controls).toBe(true);
    expect((await poster(page)).currentSrc).toBe(DESKTOP.posterAvif);
    expect(requested.filter((p) => p.includes('-9x16.'))).toEqual([]);
    errors.assertNone();
  });

  for (const [what, setup] of [
    ['reduced motion', async (page: Page) => page.emulateMedia({ reducedMotion: 'reduce' })],
    [
      'Save-Data',
      async (page: Page) =>
        page.addInitScript(() =>
          Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' } })
        ),
    ],
    [
      'a 2G connection',
      async (page: Page) =>
        page.addInitScript(() => Object.defineProperty(navigator, 'connection', { value: { effectiveType: '2g' } })),
    ],
  ] as const) {
    test(`never autoplays, or loads any video, with ${what}`, async ({ page }) => {
      await setup(page);
      const requested = videoRequests(page);
      await page.goto('/');
      await page.waitForLoadState('load');
      await page.getByTestId('hero-demo-video').scrollIntoViewIfNeeded();
      await page.waitForTimeout(2000);
      expect(requested.filter(isMedia)).toEqual([]);
      expect(await media(page)).toMatchObject({ paused: true, readyState: 0 });
      await expect(page.getByTestId('hero-demo-play')).toBeVisible();
    });
  }
});

test.describe('homepage demo video by keyboard', () => {
  test('Enter on the play button plays it, and focus stays on the video', async ({ page }) => {
    // Reduced motion: no autoplay, so the play button stays until pressed.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const play = page.getByTestId('hero-demo-play');
    await play.focus();
    await page.keyboard.press('Enter');
    await expect(play).toHaveCount(0);
    await expect(page.getByTestId('hero-demo-video')).toBeFocused();
    await expect.poll(async () => (await media(page)).paused, { timeout: 15_000 }).toBe(false);
    expect((await media(page)).muted).toBe(false);
  });
});

test.describe('homepage demo files', () => {
  const TYPES = { webm: 'video/webm', mp4: 'video/mp4', avif: 'image/avif', webp: 'image/webp' } as const;
  for (const cut of [DESKTOP, MOBILE]) {
    test(`${cut.mp4} and its WebM and posters are served, video with ranges`, async ({ request }) => {
      for (const src of [cut.webm, cut.mp4]) {
        // A Range request must get a range back: Safari will not play an MP4
        // whose server ignores it with a 200.
        const head = await request.get(src, { headers: { range: 'bytes=0-1023' } });
        expect(head.status()).toBe(206);
        expect(head.headers()['content-range']).toMatch(/^bytes 0-1023\/\d+$/);
        expect(head.headers()['content-type']).toContain(TYPES[src.split('.').pop() as 'webm' | 'mp4']);
        const whole = await request.get(src);
        expect([200, 206]).toContain(whole.status());
        expect(Number(whole.headers()['content-length'])).toBeLessThanOrEqual(2_500_000);
      }
      for (const img of [cut.posterAvif, cut.posterWebp]) {
        const res = await request.get(img);
        expect(res.status()).toBe(200);
        expect(res.headers()['content-type']).toContain(TYPES[img.split('.').pop() as 'avif' | 'webp']);
        expect((await res.body()).byteLength).toBeLessThan(40 * 1024);
      }
    });
  }

  test('the retired demo files are no longer served or referenced', async ({ request }) => {
    for (const old of [
      '/video/hookpost-demo-en.mp4',
      '/video/founder-demo.mp4',
      '/video/hookpost-demo-16x9.mp4',
      '/video/hookpost-demo-16x9.webp',
      '/video/hookpost-demo-9x16.mp4',
      '/video/hookpost-demo-9x16.webp',
      '/video/hookpost-home-s1-16x9.mp4',
      '/video/hookpost-home-s1-16x9.webp',
      '/video/hookpost-home-s1-9x16.mp4',
      '/video/hookpost-home-s1-9x16.webp',
    ]) {
      expect((await request.get(old)).status()).toBe(404);
    }
    const html = await (await request.get('/')).text();
    expect(html).not.toMatch(/hookpost-demo-en\.mp4|founder-demo\.mp4|hookpost-demo-(16x9|9x16)\.|hookpost-home-s1-(16x9|9x16)\.(mp4|webp)/);
    expect(html).not.toMatch(/Hootsuite from \$99\/user\/mo/);
    expect(html).not.toMatch(/free forever|try it yourself free|founder demo/i);
    // The old $15 Standard price. "$15" closed by a quote (escaped, \"$15\", in
    // the inline script) is a React Server Components reference, not a price.
    expect(html).not.toMatch(/\$15\b(?![\\"])/);
    expect(html).not.toMatch(/<iframe[^>]+youtube/i);
  });
});

/** Every object in the page's JSON-LD blocks, @graph members included. */
function jsonLdNodes(html: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === 'object') {
      out.push(value as Record<string, any>);
      Object.values(value).forEach(visit);
    }
  };
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    visit(JSON.parse(m[1]));
  }
  return out;
}

test.describe('homepage demo video as structured data', () => {
  const ORIGIN = 'https://hookpost.hookstep.in';

  test('/ has one VideoObject whose contentUrl and thumbnailUrl the build serves', async ({ request }) => {
    const html = await (await request.get('/')).text();
    const videos = jsonLdNodes(html).filter((n) => n['@type'] === 'VideoObject');
    expect(videos).toHaveLength(1);
    const [video] = videos;
    expect(video.contentUrl).toBe(`${ORIGIN}${DESKTOP.mp4}`);
    expect(video.thumbnailUrl).toBe(`${ORIGIN}${DESKTOP.posterWebp}`);
    expect(video.duration).toBe('PT44S');
    expect(video.uploadDate).toBe('2026-11-02T10:00:00+05:30');
    for (const key of ['name', 'description']) expect(String(video[key]).length).toBeGreaterThan(20);

    // The absolute URLs name production; the same paths on this build are
    // what will be deployed there.
    const content = await request.get(new URL(video.contentUrl).pathname, { headers: { range: 'bytes=0-1023' } });
    expect([200, 206]).toContain(content.status());
    expect(content.headers()['content-type']).toContain('video/mp4');
    const thumb = await request.get(new URL(video.thumbnailUrl).pathname);
    expect(thumb.status()).toBe(200);
    expect(thumb.headers()['content-type']).toContain('image/webp');
  });

  test('sitemap.xml lists the video on /', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    const home = xml.split('</url>').find((u) => u.includes(`<loc>${ORIGIN}</loc>`));
    expect(home).toBeDefined();
    expect(home).toContain(`<video:content_loc>${ORIGIN}${DESKTOP.mp4}</video:content_loc>`);
    expect(home).toContain(`<video:thumbnail_loc>${ORIGIN}${DESKTOP.posterWebp}</video:thumbnail_loc>`);
    expect(home).toContain('<video:duration>44</video:duration>');
    expect(xml.match(/<video:video>/g)).toHaveLength(1);
  });
});
