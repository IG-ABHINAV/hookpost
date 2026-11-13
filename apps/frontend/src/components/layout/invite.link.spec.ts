/**
 * The homepage moves an old invite link (/?org=<token>) to /invite/<token>
 * in the browser, because Cloudflare serves "/" from its cache whatever the
 * query string and the proxy never sees the request.
 *   pnpm exec jest -c apps/frontend/jest.config.ts invite.link
 *
 * Runs the exact inline-script string the landing layout ships against a
 * stand-in `window` (jsdom cannot navigate).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  INVITE_HTML_ATTR,
  INVITE_LINK_SCRIPT,
} from '@hookpost/frontend/components/layout/invite.link';
import {
  TWA_HOME_REDIRECT_SCRIPT,
  TWA_HTML_ATTR,
} from '@hookpost/frontend/components/layout/twa';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJvcmdJZCI6Im9yZy1hIn0.c2ln';

const run = (path: string, search: string) => {
  const calls: string[] = [];
  const attrs = new Set<string>();
  const win: any = {
    URLSearchParams,
    location: {
      pathname: path,
      search,
      replace: (to: string) => calls.push(`replace ${to}`),
    },
    history: {
      replaceState: (_s: unknown, _t: string, to: string) => calls.push(`replaceState ${to}`),
    },
    document: {
      documentElement: {
        setAttribute: (a: string) => attrs.add(a),
        hasAttribute: (a: string) => attrs.has(a),
      },
    },
  };
  new Function('window', INVITE_LINK_SCRIPT)(win);
  return { calls, attrs };
};

describe('INVITE_LINK_SCRIPT', () => {
  it('/?org=<token>: the token leaves the address bar, then /invite/<token>', () => {
    const { calls, attrs } = run('/', `?org=${TOKEN}`);
    expect(calls).toEqual(['replaceState /', `replace /invite/${TOKEN}`]);
    expect(attrs.has(INVITE_HTML_ATTR)).toBe(true);
  });

  it('an encoded token is decoded once and encoded again as one path segment', () => {
    expect(run('/', `?utm_source=x&org=${encodeURIComponent(TOKEN)}`).calls.at(-1)).toBe(
      `replace /invite/${TOKEN}`
    );
  });

  it('anything in ?org= stays one segment of a path on this site (the proxy checks it)', () => {
    for (const [org, expected] of [
      ['//evil.example', '/invite/%2F%2Fevil.example'],
      ['https://evil.example', '/invite/https%3A%2F%2Fevil.example'],
      ['javascript:alert(1)', '/invite/javascript%3Aalert(1)'],
      ['../../auth/logout', '/invite/..%2F..%2Fauth%2Flogout'],
      ['a.b', '/invite/a.b'],
    ]) {
      const { calls } = run('/', `?org=${encodeURIComponent(org)}`);
      const to = calls.at(-1)!.replace('replace ', '');
      expect(to).toBe(expected);
      expect(new URL(to, 'https://hookpost.hookstep.in').origin).toBe('https://hookpost.hookstep.in');
    }
  });

  it('leaves every other page and query alone', () => {
    expect(run('/', '').calls).toEqual([]);
    // An empty ?org= is no invite at all: the homepage stays (review of 1162ff204).
    expect(run('/', '?org=').calls).toEqual([]);
    expect(run('/', '?org=').attrs.size).toBe(0);
    expect(run('/', '?utm_source=meta').calls).toEqual([]);
    expect(run('/', '?organization=x').calls).toEqual([]);
    expect(run('/pricing', `?org=${TOKEN}`).calls).toEqual([]);
    expect(run('/auth', `?org=${TOKEN}`).calls).toEqual([]);
  });
});

describe('the other homepage redirects stand aside for an invite', () => {
  it("the Play app's / -> /auth does not run while an invite redirect is under way", () => {
    const replace = jest.fn();
    document.documentElement.setAttribute(TWA_HTML_ATTR, '');
    document.documentElement.setAttribute(INVITE_HTML_ATTR, '');
    try {
      new Function('window', TWA_HOME_REDIRECT_SCRIPT)({
        location: { pathname: '/', search: `?org=${TOKEN}`, replace },
      });
      expect(replace).not.toHaveBeenCalled();
      document.documentElement.removeAttribute(INVITE_HTML_ATTR);
      new Function('window', TWA_HOME_REDIRECT_SCRIPT)({
        location: { pathname: '/', search: '', replace },
      });
      expect(replace).toHaveBeenCalledWith('/auth');
    } finally {
      document.documentElement.removeAttribute(TWA_HTML_ATTR);
      document.documentElement.removeAttribute(INVITE_HTML_ATTR);
    }
  });

  it('the landing layout runs it before the attribution script and the signed-in redirect', () => {
    const layout = readFileSync(
      join(__dirname, '../../app/(landing)/layout.tsx'),
      'utf8'
    );
    const at = (s: string) => layout.indexOf(s);
    expect(at('__html: INVITE_LINK_SCRIPT')).toBeGreaterThan(-1);
    expect(at('__html: INVITE_LINK_SCRIPT')).toBeLessThan(at('__html: ATTRIBUTION_CAPTURE_SCRIPT'));
    expect(at('__html: INVITE_LINK_SCRIPT')).toBeLessThan(at('__html: TWA_HOME_REDIRECT_SCRIPT'));
    expect(at('__html: INVITE_LINK_SCRIPT')).toBeLessThan(at("fetch('/api/user/self'"));
    // ...and the signed-in redirect checks for it.
    expect(layout).toMatch(/if \(\$\{INVITE_REDIRECTING_CHECK\}\) return;/);
  });
});
