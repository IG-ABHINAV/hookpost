/**
 * @jest-environment node
 *
 * AdSense auto ads: the exact tag Google issues, only on the public content
 * pages (/guides/*, /alternatives/*), and an ads.txt naming the same publisher.
 *   pnpm exec jest -c apps/frontend/jest.config.ts adsense
 */
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ADSENSE_CLIENT,
  ADSENSE_CMP,
  ADSENSE_SRC,
  AdSenseScript,
  CONSENT_COUNTRIES,
  adsenseLoader,
} from './adsense';

const frontend = join(__dirname, '..', '..', '..');
const appDir = join(frontend, 'src/app');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? files(p)
      : /\.tsx?$/.test(f) && !/\.spec\.ts$/.test(f)
      ? [p]
      : [];
  });

describe('AdSenseScript', () => {
  it('ships the gated loader, never the bare adsbygoogle tag', () => {
    expect(ADSENSE_CLIENT).toBe('ca-pub-6574958062528034');
    const html = renderToStaticMarkup(React.createElement(AdSenseScript));
    expect(html.startsWith('<script id="adsense-loader">')).toBe(true);
    expect(html).toContain(ADSENSE_SRC);
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(ADSENSE_CMP).toBe(false);
  });
});

/** Runs the inline loader against a fake browser and reports whether adsbygoogle.js was added. */
async function run(opts: {
  host?: string;
  trace?: string | null;
  cmp?: boolean;
  interact?: boolean;
}) {
  const {
    host = 'hookpost.hookstep.in',
    trace = 'h=x\nloc=IN\n',
    cmp = false,
    interact = true,
  } = opts;
  const added: string[] = [];
  const listeners: Array<() => void> = [];
  const fetched: string[] = [];
  const document = {
    querySelector: () => (added.length ? {} : null),
    createElement: () => ({} as { src?: string }),
    head: { appendChild: (s: { src: string }) => added.push(s.src) },
  };
  const fetch = (url: string) => {
    fetched.push(url);
    return trace === null
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ ok: true, text: () => Promise.resolve(trace) });
  };
  const addEventListener = (_e: string, fn: () => void) => listeners.push(fn);
  const removeEventListener = () => undefined;
  const window = { requestIdleCallback: (fn: () => void) => fn() };
  new Function(
    'location',
    'document',
    'fetch',
    'addEventListener',
    'removeEventListener',
    'window',
    adsenseLoader(cmp)
  )(
    { hostname: host },
    document,
    fetch,
    addEventListener,
    removeEventListener,
    window
  );
  if (interact) listeners.forEach((fn) => fn());
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return { added, fetched };
}

describe('EEA / UK / Switzerland consent gate', () => {
  it.each(['IN', 'US', 'BR'])(
    'loads the ad script for %s after the first interaction',
    async (c) => {
      const { added, fetched } = await run({
        trace: `fl=1\nloc=${c}\nwarp=off\n`,
      });
      expect(fetched).toEqual(['/cdn-cgi/trace']);
      expect(added).toEqual([ADSENSE_SRC]);
    }
  );

  it.each(['DE', 'FR', 'IE', 'NO', 'IS', 'LI', 'GB', 'GI', 'JE', 'CH'])(
    'loads nothing for %s',
    async (c) => {
      expect((await run({ trace: `loc=${c}\n` })).added).toEqual([]);
    }
  );

  it('covers every EU member state, EEA-EFTA, the UK and Switzerland', () => {
    const eu =
      'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(
        ' '
      );
    for (const c of [...eu, 'IS', 'LI', 'NO', 'GB', 'CH'])
      expect(CONSENT_COUNTRIES).toContain(c);
  });

  it.each([
    ['unknown country', 'loc=XX\n'],
    ['Tor', 'loc=T1\n'],
    ['no loc line', 'h=x\n'],
    ['trace fails', null],
  ])(
    'loads nothing when the country cannot be told (%s)',
    async (_n, trace) => {
      expect((await run({ trace: trace as string | null })).added).toEqual([]);
    }
  );

  it('does nothing before the visitor interacts (Core Web Vitals)', async () => {
    const { added, fetched } = await run({ interact: false });
    expect(fetched).toEqual([]);
    expect(added).toEqual([]);
  });

  it('does nothing off the production host (localhost, previews)', async () => {
    const { added, fetched } = await run({ host: 'localhost' });
    expect(fetched).toEqual([]);
    expect(added).toEqual([]);
  });

  it('with a working consent tool (cmp true) loads everywhere without asking Cloudflare', async () => {
    const { added, fetched } = await run({ cmp: true, trace: 'loc=DE\n' });
    expect(fetched).toEqual([]);
    expect(added).toEqual([ADSENSE_SRC]);
  });
});

describe('where the ad script loads', () => {
  const users = files(join(frontend, 'src'))
    .filter(
      (f) =>
        /components\/layout\/adsense/.test(readFileSync(f, 'utf8')) ||
        readFileSync(f, 'utf8').includes('adsbygoogle')
    )
    .map((f) => relative(appDir, f))
    .filter((f) => !f.endsWith('components/layout/adsense.tsx'))
    .sort();

  it('only the /guides and /alternatives layouts include it', () => {
    expect(users).toEqual([
      '(landing)/alternatives/layout.tsx',
      '(landing)/guides/layout.tsx',
    ]);
  });

  it('never the root, landing or app layouts (home, pricing, auth, checkout, the app)', () => {
    for (const f of [
      'layout.tsx',
      '(landing)/layout.tsx',
      '(app)/layout.tsx',
    ]) {
      let text = '';
      try {
        text = readFileSync(join(appDir, f), 'utf8');
      } catch {
        continue;
      }
      expect(text).not.toMatch(/adsense|adsbygoogle/i);
    }
  });

  it.each([['guides'], ['alternatives']])(
    '/%s layout renders the script before the page',
    (dir) => {
      const text = readFileSync(
        join(appDir, '(landing)', dir, 'layout.tsx'),
        'utf8'
      );
      expect(text).toMatch(/<AdSenseScript \/>\s*\{children\}/);
    }
  );
});

describe('/ads.txt', () => {
  it('authorises exactly the publisher the script uses, as a DIRECT seller', () => {
    const text = readFileSync(join(frontend, 'public/ads.txt'), 'utf8');
    const pub = ADSENSE_CLIENT.replace(/^ca-/, '');
    expect(text.trim()).toBe(`google.com, ${pub}, DIRECT, f08c47fec0942fa0`);
    expect(ADSENSE_SRC).toContain(`client=${ADSENSE_CLIENT}`);
  });

  it('is not caught by the proxy (dotted paths are excluded from its matcher)', () => {
    const proxy = readFileSync(join(frontend, 'src/proxy.ts'), 'utf8');
    const matcher = new RegExp(
      '^/' + proxy.match(/matcher: '\/(.+)',/)![1].replace(/\\\\/g, '\\') + '$'
    );
    expect(matcher.test('/ads.txt')).toBe(false);
    expect(matcher.test('/guides/schedule-x-threads')).toBe(true);
  });
});
