/**
 * /mcp leads with the setup that needs nothing but a URL: the OAuth connector
 * for Claude and ChatGPT (sign in, Authorize, no API key), which any workspace
 * can use. 18 of 54 sign-ups in the 30 days to 7 Nov landed on /mcp and about
 * 15 came from claude.ai or chatgpt.com, while the page led with "Get an API
 * key", which a workspace without the Hookpost plan does not have.
 *   pnpm exec jest -c apps/frontend/jest.config.ts mcp-quick-start
 */
import fs from 'fs';
import path from 'path';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, prefetch: _p, ...rest }: any) =>
    require('react').createElement('a', { href, ...rest }, children),
}));
jest.mock('../site-nav', () => ({ SiteNav: () => null }));

const KEYS = [
  'USD_CHECKOUT',
  'GST_LUT_ARN',
  'USD_EXCLUDED_COUNTRIES',
  'USD_ALLOWLIST',
  'TRIAL_REQUIRED_SINCE_IN',
  'TRIAL_REQUIRED_SINCE_GLOBAL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const realFetch = (global as any).fetch;

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (global as any).fetch = realFetch;
});

const CUT = '2026-10-20T00:00:00Z';
/** What production builds with (see mcp-trial-terms.spec.ts). */
const PROD = {
  USD_CHECKOUT: 'on',
  GST_LUT_ARN: 'AD0910260000000',
  TRIAL_REQUIRED_SINCE_IN: CUT,
  TRIAL_REQUIRED_SINCE_GLOBAL: CUT,
};

const REPO = path.resolve(__dirname, '../../../../../..');

function textOf(el: Element): string {
  const div = el.cloneNode(true) as HTMLElement;
  div.querySelectorAll('script,style').forEach((s) => s.remove());
  div.querySelectorAll('p,li,h1,h2,h3,dt,dd,td,th,pre,div,section').forEach((s) => s.append('\n'));
  return (div.textContent || '').replace(/[ \t]+/g, ' ');
}

/** The page as a build with these keys renders it, plus its modules. */
function render(env: Record<string, string>) {
  (global as any).fetch = jest.fn(() => new Promise(() => undefined));
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  let mod: any, setup: any, R: any, rtl: any;
  jest.isolateModules(() => {
    mod = require('./page');
    setup = require('./mcp-setup');
    R = require('react');
    rtl = require('@testing-library/react/pure');
  });
  const { container, unmount } = rtl.render(R.createElement(mod.default));
  const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')!.textContent || '{}');
  const quick = container.querySelector('[data-testid="mcp-quick-start"]') as HTMLElement | null;
  const out = {
    mod,
    setup,
    ld,
    container: container as HTMLElement,
    quick,
    quickText: quick ? textOf(quick) : '',
    pageText: textOf(container),
  };
  return { ...out, unmount };
}

const before = (a: Node, b: Node) =>
  !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('/mcp quick start', () => {
  it('the URLs are endpoints the backend serves, not invented ones', () => {
    const { setup, unmount } = render(PROD);
    unmount();
    const startMcp = fs.readFileSync(
      path.join(REPO, 'libraries/nestjs-libraries/src/chat/start.mcp.ts'),
      'utf8'
    );
    expect(setup.CLAUDE_MCP_URL).toBe('https://hookpost.hookstep.in/mcp-oauth-claude');
    expect(setup.CHATGPT_MCP_URL).toBe('https://hookpost.hookstep.in/mcp-oauth');
    for (const url of [setup.CLAUDE_MCP_URL, setup.CHATGPT_MCP_URL]) {
      const route = new URL(url).pathname;
      expect(startMcp).toContain(`app.use('${route}'`);
      // OAuth-protected, so a connector discovers sign-in on its own.
      expect(startMcp).toContain(`mcpPath: '${route}'`);
    }
  });

  it('comes first: the connector URLs before any code block and before "Get an API key"', () => {
    const { container, quick, setup, unmount } = render(PROD);
    expect(quick).not.toBeNull();
    const pres = [...container.querySelectorAll('pre')];
    expect(pres[0].textContent).toBe(setup.CLAUDE_MCP_URL);
    expect(pres[1].textContent).toBe(setup.CHATGPT_MCP_URL);
    for (const pre of pres.slice(0, 2)) expect(quick!.contains(pre)).toBe(true);
    const apiKey = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Get an API key');
    expect(apiKey).toBeTruthy();
    expect(apiKey!.getAttribute('href')).toBe('/auth');
    expect(before(quick!, apiKey!)).toBe(true);
    expect(quick!.contains(apiKey!)).toBe(false);
    expect(before(quick!, container.querySelector('#setup')!)).toBe(true);
    unmount();
  });

  it('says where each URL goes and that no API key is needed', () => {
    const { quickText, unmount } = render(PROD);
    unmount();
    expect(quickText).toMatch(/no API key/i);
    expect(quickText).toMatch(/Add custom connector/);
    expect(quickText).toMatch(/Add custom MCP server/);
    expect(quickText).toMatch(/Authorize/);
  });

  it('production build: states the plan rule as the code applies it', () => {
    const { quickText, pageText, unmount } = render(PROD);
    unmount();
    // planGate refuses only needs_trial and locked (trial.policy.ts
    // planGateCode); a workspace without a plan is on its free posts.
    expect(quickText).toMatch(/3 free posts/);
    expect(quickText).toMatch(/then (a |the )?Hookpost plan/);
    // The API key is only issued on public_api tiers (the Hookpost plan).
    expect(pageText).toMatch(/API key[^.]*the Hookpost plan|the Hookpost plan[^.]*API key/);
    // No trial left to start (4 Nov 2026), and no "plan and above" gate on MCP as a whole.
    expect(pageText).not.toMatch(/start the trial|Start your \d+-day trial/i);
    expect(pageText).not.toContain('MCP server · Hookpost plan and above');
  });

  it('a build without the free-posts cutoff says the connector works on every plan', () => {
    const { quickText, unmount } = render({});
    unmount();
    expect(quickText).not.toMatch(/3 free posts/);
    expect(quickText).toMatch(/every (Hookpost )?plan/);
  });

  it('passes the free-claims check', () => {
    const { quickText, unmount } = render(PROD);
    unmount();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkText, loadAllow } = require('../../../../../../scripts/check-free-claims.js');
    expect(checkText('mcp', [quickText], loadAllow())).toEqual([]);
  });

  it('keeps the SEO metadata, and the HowTo markup is the quick start as shown', () => {
    const { mod, ld, quick, unmount } = render(PROD);
    unmount();
    expect(mod.metadata.alternates.canonical).toBe('https://hookpost.hookstep.in/mcp');
    expect(mod.metadata.title).toMatch(/Hookpost MCP Server/);
    expect(String(mod.metadata.description).length).toBeGreaterThan(50);
    const howto = ld['@graph'].find((g: any) => g['@type'] === 'HowTo');
    const shown = [...quick!.querySelectorAll('ol > li')].map((li) => li.textContent || '');
    expect(howto.step).toHaveLength(shown.length);
    howto.step.forEach((s: any, i: number) => {
      expect(shown[i]).toContain(s.name);
      expect(shown[i]).toContain(s.text);
    });
  });
});
