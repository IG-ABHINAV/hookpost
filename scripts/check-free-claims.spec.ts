// The CI and deploy guard for PR-3: a trial-mode marketing build must not offer
// new users a Free plan, a free start or "no card". It reads built HTML, so
// these cases are built HTML and text, the way the pages and llms.txt come out.
//   pnpm exec jest -c apps/backend/jest.config.ts check-free-claims

import fs from 'fs';
import os from 'os';
import path from 'path';
import { FREE_POST_LIMIT } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { htmlSegments, checkText, checkBuild, loadAllow } = require('./check-free-claims.js');

const flagged = (...segments: string[]) =>
  checkText('page', segments, loadAllow()).map((h: any) => h.sentence);

describe('what counts as offering a Free plan', () => {
  it.each([
    'Start free',
    'Start free — no card',
    'Get Started for Free →',
    'Start Free (No CC Required) →',
    'Hookpost has a free plan and Pro at ₹1,999/mo flat.',
    'The free tier needs no card and does not expire.',
    'Free plan: 2 channels and 30 posts a month.',
    '100% No-Risk Free Trial',
    'Hookpost bundles channels into flat plans, starting at ₹0.',
    // Hookpost's own limits, even next to a competitor's name.
    'Buffer has 3 channels; Hookpost Free covers 2 channels and 30 posts a month.',
    // The free-posts allowance (28 Oct 2026) does not excuse a forever-free or
    // Free-plan claim made in the same sentence, nor a "no card" without it.
    '3 free posts, no card needed, and the free plan never expires.',
    '3 free posts, then a free tier that does not expire, no card needed.',
    'Free forever: 3 free posts, no card needed.',
    "Hookpost's free plan: 3 free posts, no card needed.",
    '3 free posts with no time limit, no card needed.',
    'Free plan: 2 channels and 30 posts a month, no card needed.',
    'Sign up, no card needed.',
    '3 posts a month free, no card needed.',
  ])('flags %p', (s) => {
    expect(flagged(s)).toEqual([s]);
  });

  it.each([
    // The free-posts offer (28 Oct 2026), the one "no card" a trial-mode build may make.
    '3 free posts, no card needed.',
    '3 free posts, no card needed. Then first month 20% off (new customers).',
    'Hookpost starts with 3 free posts, no card needed.',
    '3 free posts, no card needed. Then first month 20% off (new customers) in India, or $19/month elsewhere.',
    'New workspaces get 3 free posts with no card, and there is no time-limited trial.',
    'There is no free plan for new workspaces: a new workspace gets 3 free posts, no card needed, then first month 20% off (new customers).',
    'Get 3 free posts',
    // Comparison tables put the vendor's cell and ours in one sentence.
    "Buffer's free plan: 3 channels, 10 scheduled posts per channel (refills as posts publish). 3 free posts, no card needed.",
    '3 free posts for a new workspace, no card needed, then a paid plan.',
    'Standard is ₹599 a month for 5 channels, and new workspaces get 3 free posts first, no card needed.',
    // The trial's own terms (workspaces already on one keep it).
    '7-day trial: ₹0 today, ₹599/month after, UPI AutoPay or card, cancel at least 24 hours before the first charge.',
    'Free trial: 7 days, payment method required',
    'Start 7-day trial',
    '7-day trial: aaj ₹0, phir ₹599 mahina, UPI AutoPay ya card.',
    // Somebody else's plans, and saying there is none.
    "Buffer's free plan has one more channel (3) and includes its AI assistant.",
    'Hootsuite has no free plan (it offers a 14-day trial).',
    'Buffer has a free plan, with 3 channels and its AI assistant; Hookpost does not.',
    'Hookpost has no free plan for new workspaces: a 7-day trial, payment method required.',
    'Free plan: none (14-day trial).',
    // A column header or row label.
    'Free plan',
    'Free Tier',
    // Reviewed exceptions in check-free-claims.allow.
    "A workspace that had Hookpost's original free tier goes back to it instead.",
    'Cheapest plan, free plan, API and MCP for 12 schedulers, read from each vendor page.',
  ])('lets through %p', (s) => {
    expect(flagged(s)).toEqual([]);
  });

  it('a comparison cell belongs to the vendor named just before it', () => {
    // Card heading, then the vendor's own line.
    expect(flagged('2. Posttely', 'Free plan: 1 workspace, 28 scheduled posts a month.')).toEqual([]);
    // Hookpost's row: the same words are a claim.
    expect(flagged('Hookpost', 'Free plan: 3 channels, 10 posts.')).toEqual([
      'Free plan: 3 channels, 10 posts.',
    ]);
    // Nobody named at all: treated as Hookpost's.
    expect(flagged('Pricing', 'There is a free plan for everyone.')).toEqual([
      'There is a free plan for everyone.',
    ]);
  });

  it('"later" the word is not Later the vendor', () => {
    expect(flagged('Start free, publish later.')).toEqual(['Start free, publish later.']);
    expect(flagged('Its free plan is small, and you can upgrade later.')).toEqual([
      'Its free plan is small, and you can upgrade later.',
    ]);
  });
});

describe('reading a built page', () => {
  it('takes the title, meta descriptions, JSON-LD strings and visible text, not scripts', () => {
    const html = `<!DOCTYPE html><html><head><title>Hookpost Pricing</title>
      <meta name="description" content="A free plan, then &#x27;flat&#x27; plans."/>
      <meta property="og:image" content="https://x/free-plan.png"/>
      <script type="application/ld+json">{"@type":"Offer","name":"Free","description":"Start free today"}</script>
      </head><body><script>self.__next_f.push([1,"Start free"])</script>
      <p>Plans <strong>start at</strong> &#x20B9;599.</p><style>.x{}</style></body></html>`;
    const segments = htmlSegments(html);
    expect(segments).toEqual(
      expect.arrayContaining([
        'Hookpost Pricing',
        "A free plan, then 'flat' plans.",
        'Start free today',
        'Plans start at ₹599.',
      ])
    );
    expect(segments.join(' ')).not.toMatch(/__next_f|free-plan\.png|\.x\{\}/);
  });

  it('checkBuild walks prerendered pages and route bodies under server/app', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-claims-'));
    try {
      const app = path.join(dir, 'server', 'app');
      fs.mkdirSync(path.join(app, 'alternatives'), { recursive: true });
      fs.writeFileSync(
        path.join(app, 'pricing.html'),
        '<html><body><p>7-day trial: ₹0 today, ₹599/month after, UPI AutoPay or card, cancel at least 24 hours before the first charge.</p></body></html>'
      );
      fs.writeFileSync(path.join(app, 'llms.txt.body'), 'Hookpost: 7-day trial, payment method required.\n');
      expect(checkBuild(dir)).toEqual({ pages: 2, hits: [] });

      fs.writeFileSync(
        path.join(app, 'alternatives', 'buffer.html'),
        '<html><body><a href="/auth">Get Started for Free</a></body></html>'
      );
      expect(checkBuild(dir).hits).toEqual([
        { file: path.join('alternatives', 'buffer.html'), sentence: 'Get Started for Free' },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// checkBuild reads text, and a PNG has none: the share image every landing page
// serves (apps/frontend/public/og-image.png) said "Free forever tier" after the
// Free plan was gone, and nothing above could see it. So read the sources the
// brand images are drawn from. Comments are dropped first: they record the
// claims that were taken out, and they never reach a pixel. The web manifest
// is read too: browsers show its name and description on install, and no
// build check reads it.
describe('brand image sources', () => {
  const ROOT = path.join(__dirname, '..');
  const SOURCES = [
    'scripts/og-image.html',
    'scripts/generate-brand-assets.js',
    'apps/frontend/public/site.webmanifest',
  ];
  // "#1" too: an unverifiable superlative ("The #1 Social Media Scheduler"
  // was what the generator wrote into site.webmanifest).
  const CLAIM = /free forever|free tier|free plan|open[- ]source|self-host|\bAGPL\b|#1\b/i;

  // Blanked, not removed, so a hit keeps its line number.
  const blank = (comment: string) => comment.replace(/[^\n]/g, '');
  const copy = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, blank)
      .replace(/\/\*[\s\S]*?\*\//g, blank)
      .replace(/^\s*\/\/.*$/gm, '');

  it.each(SOURCES)('%s offers no free plan and never calls Hookpost open source, self-hosted or #1', (rel) => {
    const hits = copy(rel)
      .split('\n')
      .map((line, i) => ({ line: line.trim(), at: `${rel}:${i + 1}` }))
      .filter(({ line }) => CLAIM.test(line))
      .map(({ line, at }) => `${at}: ${line}`);
    expect(hits).toEqual([]);
  });

  it('the share image states no trial, and the free-posts chip is FREE_POST_LIMIT', () => {
    const html = copy('scripts/og-image.html');
    expect([...html.matchAll(/\b(\d+)[- ]day trial\b/gi)]).toEqual([]);
    const stated = [...html.matchAll(/\b(\d+) free posts\b/gi)].map((m) => Number(m[1]));
    expect(stated).toEqual([FREE_POST_LIMIT]);
    // No card, no time limit and no first-month figure baked into a PNG.
    expect(html).not.toMatch(/no card|forever|\d+% off/i);
  });
});
