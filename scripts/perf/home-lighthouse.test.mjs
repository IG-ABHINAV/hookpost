// node --test scripts/perf/home-lighthouse.test.mjs
// The budget logic of home-lighthouse.mjs on hand-made Lighthouse results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED, BUDGETS, POSTER_MAX_BYTES, judge, lighthouseArgs, median, summarise } from './home-lighthouse.mjs';

/** A Lighthouse result with the fields summarise() reads. */
function lhr({ formFactor = 'mobile', perf = 0.98, lcp = 1800, cls = 0.01, tbt = 5, bytes = 390_000, requests = [], shifts = [] } = {}) {
  return {
    configSettings: { formFactor },
    categories: {
      performance: { score: perf },
      accessibility: { score: 1 },
      'best-practices': { score: 1 },
      seo: { score: 1 },
    },
    audits: {
      'largest-contentful-paint': { numericValue: lcp },
      'cumulative-layout-shift': { numericValue: cls },
      'total-blocking-time': { numericValue: tbt },
      'total-byte-weight': { numericValue: bytes },
      'network-requests': { details: { items: requests } },
      'layout-shifts': { details: { items: shifts } },
    },
  };
}
const POSTER = { url: 'https://hookpost.hookstep.in/video/hookpost-home-s1-9x16.3018ce2284.avif', transferSize: 13_600 };

test('the 25 Oct baseline passes on both form factors', () => {
  assert.deepEqual(judge(summarise(lhr({ requests: [POSTER] }))), []);
  assert.deepEqual(judge(summarise(lhr({ formFactor: 'desktop', perf: 0.96, lcp: 1061, cls: 0.003, tbt: 0 }))), []);
});

test('any video request on first load fails, whatever the format or host', () => {
  for (const url of [
    'https://hookpost.hookstep.in/video/hookpost-home-s1-9x16.7d0cc61408.mp4',
    'https://hookpost.hookstep.in/video/hookpost-home-s1-9x16.f242d9c946.webm',
    'https://www.youtube.com/embed/abc',
    'https://i.ytimg.com/vi/abc/hqdefault.jpg',
  ]) {
    const fails = judge(summarise(lhr({ requests: [POSTER, { url, transferSize: 1000 }] })));
    assert.equal(fails.length, 1, url);
    assert.match(fails[0], /video fetched on first load/);
  }
});

test('a poster over the budget fails; the poster alone is not a video request', () => {
  const big = { ...POSTER, transferSize: POSTER_MAX_BYTES + 1 };
  const s = summarise(lhr({ requests: [big] }));
  assert.deepEqual(s.videoRequests, []);
  assert.deepEqual(judge(s), [`poster 30 KB > 30 KB`]);
});

test('a layout shift in the video box fails even when CLS is under budget', () => {
  const shift = { node: { snippet: '<div class="relative mx-auto" data-testid="hero-demo-box">', selector: 'section > div' } };
  assert.deepEqual(judge(summarise(lhr({ cls: 0.001, shifts: [shift] }))), ['1 layout shift(s) in the video box']);
  const elsewhere = { node: { snippet: '<div class="inline-flex">', selector: 'section#pricing > div' } };
  assert.deepEqual(judge(summarise(lhr({ cls: 0.012, shifts: [elsewhere] }))), []);
});

test('scores, LCP, CLS, TBT and page weight each have a budget', () => {
  const fails = judge(summarise(lhr({ perf: 0.7, lcp: 4000, cls: 0.2, tbt: 600, bytes: 900 * 1024 })));
  assert.deepEqual(fails, ['performance 70 < 90', 'LCP 4000 ms > 2500 ms', 'CLS 0.200 > 0.05', 'TBT 600 ms > 200 ms', 'page weight 900 KB > 450 KB']);
  assert.equal(BUDGETS.desktop.lcpMs < BUDGETS.mobile.lcpMs, true);
});

test('the median run is judged, not the best or the worst; of two (one run failed), the worse', () => {
  const runs = [0.91, 0.99, 0.96].map((perf) => summarise(lhr({ perf })));
  assert.equal(median(runs).scores.performance, 0.96);
  assert.equal(median([0.99, 0.91].map((perf) => summarise(lhr({ perf })))).scores.performance, 0.91);
});

test('a metric Lighthouse could not measure fails, never passes silently', () => {
  const r = lhr();
  delete r.audits['largest-contentful-paint'];
  delete r.categories.performance;
  const fails = judge(summarise(r));
  assert.ok(fails.includes('lcpMs was not measured'), fails.join(' | '));
  assert.ok(fails.includes('performance was not scored'), fails.join(' | '));
});

test('analytics, ad and sign-in hosts are blocked in every run, so a nightly run is never counted as a visit', () => {
  for (const host of ['googletagmanager.com', 'connect.facebook.net', 'facebook.com/tr', 'cloudflareinsights.com']) assert.ok(BLOCKED.some((p) => p.includes(host)), host);
  for (const p of BLOCKED) assert.match(p, /^\*.+/);
});

// Chrome's --blocked-url-patterns: '*' matches anything, the rest literally, against the whole URL.
const blocked = (url) => BLOCKED.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.?+^$()[\]{}|\\/]/g, '\\$&')).join('.*')}$`).test(url));

test("the site's own ViewContent beacon is blocked too (it is forwarded to Meta), and nothing else of the site's API", () => {
  assert.ok(blocked('https://hookpost.hookstep.in/api/public/t'));
  // The Meta pixel library, served first-party (facebook.component.tsx).
  assert.ok(blocked('https://hookpost.hookstep.in/f.js'));
  for (const url of [
    'https://hookpost.hookstep.in/api/public/pricing-context?tz=UTC',
    'https://hookpost.hookstep.in/api/user/self',
    'https://hookpost.hookstep.in/',
    'https://hookpost.hookstep.in/_next/static/chunks/0ad9re6dqi4-q.js',
  ]) assert.ok(!blocked(url), url);
});

test('mobile is throttled for real during the load, desktop is simulated; both block the same hosts', () => {
  const mobile = lighthouseArgs('https://hookpost.hookstep.in/', 'mobile', '/tmp/m.json');
  const desktop = lighthouseArgs('https://hookpost.hookstep.in/', 'desktop', '/tmp/d.json');
  const methods = (args) => args.filter((a) => a.startsWith('--throttling-method='));
  assert.deepEqual(methods(mobile), ['--throttling-method=devtools']);
  assert.deepEqual(methods(desktop), ['--throttling-method=simulate']);
  assert.ok(mobile.includes('--form-factor=mobile') && mobile.includes('--screenEmulation.mobile'));
  assert.ok(desktop.includes('--preset=desktop'));
  for (const args of [mobile, desktop]) {
    for (const p of BLOCKED) assert.ok(args.includes(`--blocked-url-patterns=${p}`), p);
    assert.ok(args.includes('lighthouse@12.8.2'));
  }
});

test('LH_MOBILE_CPU_SLOWDOWN sets the mobile CPU multiplier only; unset, Lighthouse keeps 4x', () => {
  const cpuArgs = (args) => args.filter((a) => a.startsWith('--throttling.cpuSlowdownMultiplier='));
  const url = 'https://hookpost.hookstep.in/';
  assert.deepEqual(cpuArgs(lighthouseArgs(url, 'mobile', '/tmp/m.json', {})), []);
  assert.deepEqual(cpuArgs(lighthouseArgs(url, 'mobile', '/tmp/m.json', { LH_MOBILE_CPU_SLOWDOWN: '2' })), ['--throttling.cpuSlowdownMultiplier=2']);
  assert.deepEqual(cpuArgs(lighthouseArgs(url, 'desktop', '/tmp/d.json', { LH_MOBILE_CPU_SLOWDOWN: '2' })), []);
  assert.deepEqual(cpuArgs(lighthouseArgs(url, 'mobile', '/tmp/m.json', { LH_MOBILE_CPU_SLOWDOWN: 'x' })), []);
});

test('diagnostics come from the median run and are never judged', () => {
  const r = lhr({ lcp: 3300 });
  r.environment = { benchmarkIndex: 2400 };
  r.audits['first-contentful-paint'] = { numericValue: 1300 };
  r.audits['speed-index'] = { numericValue: 1350 };
  r.audits['server-response-time'] = { numericValue: 40 };
  r.audits.metrics = { details: { items: [{ observedFirstContentfulPaint: 370, observedLargestContentfulPaint: 370, observedDomContentLoaded: 330 }] } };
  r.audits['largest-contentful-paint-element'] = {
    details: {
      items: [
        { items: [{ node: { selector: 'section.mx-auto > div.grid > div.min-w-0 > p.mt-6' } }] },
        { items: [{ phase: 'TTFB', timing: 483.2 }, { phase: 'Render Delay', timing: 2986.4 }] },
      ],
    },
  };
  const s = summarise(r);
  assert.deepEqual(s.diagnostics, {
    fcpMs: 1300,
    speedIndexMs: 1350,
    ttfbMs: 40,
    observedFcpMs: 370,
    observedLcpMs: 370,
    observedDclMs: 330,
    benchmarkIndex: 2400,
    lcpElement: 'section.mx-auto > div.grid > div.min-w-0 > p.mt-6',
    lcpPhases: { TTFB: 483, 'Render Delay': 2986 },
  });
  assert.deepEqual(judge(s), ['LCP 3300 ms > 2500 ms']);
  // A result without any of it still summarises.
  assert.equal(summarise(lhr()).diagnostics.lcpElement, null);
});
