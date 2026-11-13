/**
 * Since 4 Nov 2026 (#147) no workspace starts a trial: without a plan it gets
 * 3 free posts, then the Hookpost plan. Public pages that still said Hookpost
 * "needs a trial" or that a tool "answers with how to start the trial" were
 * found on 7 Nov by scanning every sitemap URL and both llms files. Other
 * vendors' trials and the legal pages (which govern trials already running)
 * are out of scope.
 *   pnpm exec jest -c apps/frontend/jest.config.ts hookpost-no-trial
 */
import fs from 'fs';
import path from 'path';

const KEYS = [
  'USD_CHECKOUT',
  'GST_LUT_ARN',
  'USD_EXCLUDED_COUNTRIES',
  'USD_ALLOWLIST',
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CUT = '2026-10-20T00:00:00Z';
/** What production builds with (see mcp-trial-terms.spec.ts). */
const PROD = {
  USD_CHECKOUT: 'on',
  GST_LUT_ARN: 'AD0910260000000',
  TRIAL_REQUIRED_SINCE_IN: CUT,
  TRIAL_REQUIRED_SINCE_GLOBAL: CUT,
};

function loadWith<T>(env: Record<string, string>, mod: string): T {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let out!: T;
  jest.isolateModules(() => {
    out = require(mod);
  });
  return out;
}

/** Every string a module exports, however deeply nested. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

// Hookpost's own trial, as the stale copy put it. Competitors' "14-day trial"
// and "no time-limited trial" do not match.
const HOOKPOST_TRIAL =
  /\b(a|Hookpost) trial or (a )?(Standard|plan|paid)|start the trial|trial or plan|on a trial\b/i;
const NEVER = /free forever|forever free|lifetime (plan|deal|access)/i;

const LANDING = __dirname;
const source = (rel: string) => fs.readFileSync(path.join(LANDING, rel), 'utf8');

describe('no public page offers Hookpost a trial (production build)', () => {
  it('the ChatGPT guide: free posts, then the Hookpost plan', () => {
    const c = loadWith<any>(PROD, './guides/chatgpt-social-media-scheduling/content');
    const all = strings(c).join('\n');
    expect(all).not.toMatch(HOOKPOST_TRIAL);
    expect(all).not.toMatch(NEVER);
    expect(c.ANSWER).toMatch(/3 free posts/);
    expect(c.ANSWER).toMatch(/the Hookpost plan/);
    const planFaq = c.FAQ.find((f: any) => f.q === 'Which Hookpost plan do I need?');
    expect(planFaq.a).toMatch(/3 free posts[^.]*the Hookpost plan/);
  });

  it('the shared ChatGPT plan note', () => {
    const s = loadWith<any>(PROD, './mcp/mcp-setup');
    expect(s.CHATGPT_PLAN_NOTE).not.toMatch(HOOKPOST_TRIAL);
    expect(s.CHATGPT_PLAN_NOTE).toMatch(/3 free posts/);
  });

  it('/social-media-mcp-servers and /affiliates', () => {
    for (const rel of ['social-media-mcp-servers/page.tsx', 'affiliates/page.tsx']) {
      const text = source(rel);
      expect(text).not.toMatch(HOOKPOST_TRIAL);
      expect(text).not.toMatch(NEVER);
    }
  });

  it('llms.txt and llms-full.txt as served', () => {
    const llms = loadWith<any>(PROD, '@hookpost/frontend/llms/llms');
    for (const file of ['llms.txt', 'llms-full.txt']) {
      const text = llms.llmsText(file);
      expect(text).not.toMatch(HOOKPOST_TRIAL);
      expect(text).not.toMatch(NEVER);
      const chatgpt = text.split('\n').find((l: string) => l.startsWith('- ChatGPT:'))!;
      expect(chatgpt).toMatch(/3 free posts, then (a |the )?Hookpost plan/);
    }
  });
});
