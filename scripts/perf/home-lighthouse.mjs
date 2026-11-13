#!/usr/bin/env node
/**
 * Lighthouse budgets for the homepage, mobile and desktop, with the demo
 * video's own checks (hero-demo-video.tsx): no video bytes on first load, a
 * small poster, no layout shift in the video box, and the page scores.
 *
 *   node scripts/perf/home-lighthouse.mjs [url] [--runs 3] [--json out.json]
 *
 * url defaults to https://hookpost.hookstep.in/ (a local `next start` works
 * too). Each form factor runs `--runs` times and the median run is judged, as
 * PageSpeed's own variance is a few points. Needs Google Chrome (CHROME_PATH)
 * and fetches lighthouse@12.8.2 with npx. Exit 1 if any budget fails. The
 * nightly prod-smoke job runs it against production.
 *
 * Budgets: the 25 Oct 2026 baseline was mobile 98 / desktop 96, LCP 1.9 s /
 * 1.1 s, CLS 0.012 / 0.003 (the pricing section's currency pill, not the
 * video), TBT 3 ms / 0, 381 KB with the tags. With the tags blocked (BLOCKED)
 * it was 100 / 100 and 371 / 369 KB. The budgets leave room for a GitHub
 * runner, which is slower than a laptop, so a failure means something real moved.
 * Mobile is measured with real throttling since 26 Oct 2026 (lighthouseArgs);
 * those laptop baselines were simulated.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BUDGETS = {
  mobile: { performance: 0.9, accessibility: 0.95, 'best-practices': 0.9, seo: 0.95, lcpMs: 2500, cls: 0.05, tbtMs: 200, bytes: 450 * 1024 },
  desktop: { performance: 0.9, accessibility: 0.95, 'best-practices': 0.9, seo: 0.95, lcpMs: 1500, cls: 0.05, tbtMs: 100, bytes: 450 * 1024 },
};
/** The video box's poster: one AVIF or WebP, fetched lazily. */
export const POSTER_MAX_BYTES = 30 * 1024;

/**
 * Analytics, ad and sign-in scripts are blocked in these runs: a nightly run is
 * not a visitor, and must not count as one in the site's analytics or ad
 * pixels. The budgets are for the page itself.
 *
 * That includes the site's own ViewContent beacon (view-content.tracker.tsx):
 * POST /api/public/t goes on to Meta's Conversions API, and Lighthouse's
 * mobile run sends an ordinary Android Chrome user agent, so until this was
 * blocked every nightly run reached Meta as a landing-page view.
 *
 * And the Meta pixel library itself: it is served first-party as /f.js
 * (facebook.component.tsx), so the connect.facebook.net pattern never caught
 * it. Simulated runs ended before the ~4 s engagement fallback loads it;
 * throttled mobile runs last longer, and it added 84 KB (442 of the 450 KB
 * budget) plus its evaluation to every run.
 */
export const BLOCKED = ['*googletagmanager.com*', '*google-analytics.com*', '*connect.facebook.net*', '*facebook.com/tr*', '*cloudflareinsights.com*', '*plausible.io*', '*dub.co*', '*sentry.io*', '*accounts.google.com/gsi*', '*/api/public/t', '*/f.js'];

const isVideo = (url) => /\.(mp4|webm|m3u8|mov)(\?|$)/i.test(url) || /youtube\.com\/embed|ytimg\.com|vimeo\.com/i.test(url);
const isPoster = (url) => /\/video\/[^?]+\.(avif|webp|jpe?g|png)(\?|$)/i.test(url);

/** The numbers judged, from one Lighthouse result (lhr). */
export function summarise(lhr) {
  const a = lhr.audits;
  const requests = a['network-requests']?.details?.items ?? [];
  const shifts = a['layout-shifts']?.details?.items ?? [];
  return {
    formFactor: lhr.configSettings.formFactor,
    scores: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map((k) => [k, lhr.categories[k]?.score ?? null])
    ),
    lcpMs: a['largest-contentful-paint']?.numericValue,
    cls: a['cumulative-layout-shift']?.numericValue,
    tbtMs: a['total-blocking-time']?.numericValue,
    bytes: a['total-byte-weight']?.numericValue,
    videoRequests: requests.filter((r) => isVideo(r.url)).map((r) => r.url),
    posterBytes: requests.filter((r) => isPoster(r.url)).reduce((s, r) => s + (r.transferSize || 0), 0),
    videoBoxShifts: shifts.filter((s) => /hero-demo/.test(s.node?.snippet ?? '') || /hero-demo/.test(s.node?.selector ?? '')).length,
    diagnostics: diagnose(lhr),
  };
}

/**
 * Not judged; printed and kept in the JSON so a failed night says why.
 *
 * observed* are what the browser actually did. Mobile runs are throttled for
 * real (lighthouseArgs), so there they equal the scored metrics; desktop's
 * scored metrics are Lighthouse's simulation (Lantern) built from an
 * unthrottled load. The trap that moved mobile off simulation, kept here
 * because PageSpeed Insights still simulates: Lantern counts every script that STARTED running before the
 * observed LCP as needed for LCP, and adds its download at the simulated
 * 1.6 Mbps. On a fast network (a GitHub runner next to Cloudflare) the Next.js
 * chunks arrive before the first frame is on screen and run in the gap
 * between paint and presentation, so ~160 KB of JS lands in the simulated LCP
 * of a page whose LCP is a paragraph of server-rendered text. When
 * observedLcpMs > observedDclMs, that is what happened. benchmarkIndex is the
 * host's CPU speed (Lighthouse multiplies main-thread time by 4 on top of it).
 */
export function diagnose(lhr) {
  const a = lhr.audits;
  const observed = a.metrics?.details?.items?.[0] ?? {};
  const lcpEl = a['largest-contentful-paint-element']?.details?.items ?? [];
  const node = lcpEl[0]?.items?.[0]?.node;
  const phases = Object.fromEntries((lcpEl[1]?.items ?? []).map((p) => [p.phase, Math.round(p.timing)]));
  return {
    fcpMs: a['first-contentful-paint']?.numericValue,
    speedIndexMs: a['speed-index']?.numericValue,
    ttfbMs: a['server-response-time']?.numericValue,
    observedFcpMs: observed.observedFirstContentfulPaint,
    observedLcpMs: observed.observedLargestContentfulPaint,
    observedDclMs: observed.observedDomContentLoaded,
    benchmarkIndex: lhr.environment?.benchmarkIndex,
    lcpElement: node ? node.selector || node.nodeLabel : null,
    lcpPhases: phases,
  };
}

const fmt = (n, digits = 0, scale = 1) => (typeof n === 'number' ? (n * scale).toFixed(digits) : 'n/a');

/** The median run by performance score; with an even count (a run failed), the worse of the middle two. */
export function median(runs) {
  const sorted = [...runs].sort((x, y) => (x.scores.performance ?? -1) - (y.scores.performance ?? -1));
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

/** Failed budgets, as sentences. Empty when everything passes. */
export function judge(s, budgets = BUDGETS[s.formFactor]) {
  const fails = [];
  // A metric Lighthouse could not measure is a failure, never a silent pass.
  for (const k of ['lcpMs', 'cls', 'tbtMs', 'bytes']) {
    if (typeof s[k] !== 'number' || Number.isNaN(s[k])) fails.push(`${k} was not measured`);
  }
  for (const k of ['performance', 'accessibility', 'best-practices', 'seo']) {
    if (typeof s.scores[k] !== 'number') {
      fails.push(`${k} was not scored`);
      continue;
    }
    if (s.scores[k] < budgets[k]) fails.push(`${k} ${Math.round(s.scores[k] * 100)} < ${Math.round(budgets[k] * 100)}`);
  }
  if (s.lcpMs > budgets.lcpMs) fails.push(`LCP ${Math.round(s.lcpMs)} ms > ${budgets.lcpMs} ms`);
  if (s.cls > budgets.cls) fails.push(`CLS ${s.cls.toFixed(3)} > ${budgets.cls}`);
  if (s.tbtMs > budgets.tbtMs) fails.push(`TBT ${Math.round(s.tbtMs)} ms > ${budgets.tbtMs} ms`);
  if (s.bytes > budgets.bytes) fails.push(`page weight ${Math.round(s.bytes / 1024)} KB > ${Math.round(budgets.bytes / 1024)} KB`);
  if (s.videoRequests.length) fails.push(`video fetched on first load: ${s.videoRequests.join(', ')}`);
  if (s.posterBytes > POSTER_MAX_BYTES) fails.push(`poster ${Math.round(s.posterBytes / 1024)} KB > ${POSTER_MAX_BYTES / 1024} KB`);
  if (s.videoBoxShifts) fails.push(`${s.videoBoxShifts} layout shift(s) in the video box`);
  return fails;
}

/**
 * Mobile is throttled for real during the load (devtools: 150 ms RTT,
 * 1.6 Mbps, CPU 4x), not simulated afterwards. Simulated (Lantern) mobile LCP
 * on a GitHub runner is an artifact, not the page: the runner's network
 * delivers the Next.js chunks before the hero's first frame reaches the screen,
 * so Lantern counts ~160 KB of JS as needed for a text LCP and replays it at
 * 1.6 Mbps (see diagnose()). Measured 26 Oct 2026 on one runner, live page,
 * alternating, 5 runs each: simulate perf 84-94, LCP 2.3-3.4 s; devtools perf
 * 96-98, LCP 1.1 s, TBT about the same. The budgets did not change.
 * Desktop stays simulated: at 10 Mbps the JS costs little and it passes.
 *
 * The 4x CPU slowdown is Lighthouse's default, meant for a high-end desktop
 * host (benchmarkIndex 1500-2000). Lighthouse's throttling guide
 * recommends 2x on a low-end desktop host (1000-1500) for the same mid-tier
 * phone. Cloud Build's e2-standard-2 measures 1171-1185, and at 4x it scored
 * the live page 89 with TBT 435 ms (26 Oct 2026) while desktop scored 99, so
 * cloudbuild.tests.yaml sets LH_MOBILE_CPU_SLOWDOWN=2. Unset, it stays 4x.
 */
export function lighthouseArgs(url, formFactor, out, env = process.env) {
  const cpu = Number(env.LH_MOBILE_CPU_SLOWDOWN);
  const args = ['--yes', 'lighthouse@12.8.2', url, '--output=json', `--output-path=${out}`, '--quiet',
    '--only-categories=performance,accessibility,best-practices,seo',
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu', ...BLOCKED.map((p) => `--blocked-url-patterns=${p}`)];
  args.push(
    ...(formFactor === 'mobile'
      ? ['--form-factor=mobile', '--screenEmulation.mobile', '--throttling-method=devtools',
         ...(cpu > 0 ? [`--throttling.cpuSlowdownMultiplier=${cpu}`] : [])]
      : ['--preset=desktop', '--throttling-method=simulate'])
  );
  return args;
}

function lighthouse(url, formFactor, out) {
  execFileSync('npx', lighthouseArgs(url, formFactor, out), { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180_000 });
  return JSON.parse(readFileSync(out, 'utf8'));
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = argv.indexOf(name);
    return i < 0 ? dflt : argv.splice(i, 2)[1];
  };
  const runs = Number(flag('--runs', '3'));
  const jsonOut = flag('--json', null);
  const url = argv[0] || 'https://hookpost.hookstep.in/';
  const dir = mkdtempSync(join(tmpdir(), 'home-lh-'));
  const report = {};
  let failed = false;
  for (const formFactor of ['mobile', 'desktop']) {
    const all = [];
    const errors = [];
    for (let i = 0; i < runs; i++) {
      // One failed run (a timeout, a page-load error) does not decide the result; too few good runs does.
      try {
        all.push(summarise(lighthouse(url, formFactor, join(dir, `${formFactor}-${i}.json`))));
      } catch (e) {
        errors.push(String(e.message || e).split('\n')[0]);
      }
    }
    for (const e of errors) console.log(`  ${formFactor}: a run failed: ${e}`);
    if (all.length < Math.min(2, runs)) {
      console.log(`  FAIL ${formFactor}: only ${all.length} of ${runs} Lighthouse runs finished`);
      report[formFactor] = { median: null, perfRuns: [], fails: [`only ${all.length} of ${runs} runs finished`], errors };
      failed = true;
      continue;
    }
    const m = median(all);
    const fails = judge(m);
    report[formFactor] = { median: m, perfRuns: all.map((r) => fmt(r.scores.performance, 0, 100)), fails, errors };
    console.log(
      `${formFactor}: perf ${fmt(m.scores.performance, 0, 100)} (runs ${report[formFactor].perfRuns.join(', ')}), ` +
        `a11y ${fmt(m.scores.accessibility, 0, 100)}, best practices ${fmt(m.scores['best-practices'], 0, 100)}, ` +
        `SEO ${fmt(m.scores.seo, 0, 100)}, LCP ${fmt(m.lcpMs)} ms, CLS ${fmt(m.cls, 3)}, TBT ${fmt(m.tbtMs)} ms, ` +
        `${fmt(m.bytes, 0, 1 / 1024)} KB, video requests ${m.videoRequests.length}, poster ${fmt(m.posterBytes, 0, 1 / 1024)} KB`
    );
    const d = m.diagnostics;
    console.log(
      `  (median run) FCP ${fmt(d.fcpMs)} ms, SI ${fmt(d.speedIndexMs)} ms, TTFB ${fmt(d.ttfbMs)} ms, ` +
        `observed FCP/LCP/DCL ${fmt(d.observedFcpMs)}/${fmt(d.observedLcpMs)}/${fmt(d.observedDclMs)} ms, ` +
        `benchmarkIndex ${fmt(d.benchmarkIndex)}, LCP element ${d.lcpElement ?? 'n/a'} ${JSON.stringify(d.lcpPhases)}`
    );
    for (const f of fails) console.log(`  FAIL ${f}`);
    failed ||= fails.length > 0;
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
