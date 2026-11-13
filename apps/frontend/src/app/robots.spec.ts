/**
 * @jest-environment node
 *
 * robots.txt keeps crawlers out of the signed-in app (a bare app URL 307s to
 * /auth, which Search Console files under "Page with redirect") without
 * catching a single marketing page.
 *   pnpm exec jest -c apps/frontend/jest.config.ts robots
 */
import robots from './robots';
import sitemap from './sitemap';
import { APP_ROUTE_SEGMENTS } from '@hookpost/frontend/proxy.routes';

type Group = { userAgent?: string | string[]; allow?: string | string[]; disallow?: string | string[] };

const list = (v?: string | string[]) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Google's matching: a rule is a path prefix where `*` is any run of characters
// and a trailing `$` anchors the end; the longest matching rule wins, and allow
// wins a tie. https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt
const matches = (rule: string, path: string) => {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
};

const allowed = (group: Group, path: string) => {
  const hits = [
    ...list(group.allow).map((r) => ({ r, allow: true })),
    ...list(group.disallow).map((r) => ({ r, allow: false })),
  ].filter(({ r }) => r && matches(r, path));
  if (!hits.length) return true;
  hits.sort((a, b) => b.r.length - a.r.length || Number(b.allow) - Number(a.allow));
  return hits[0].allow;
};

const groups = list(robots().rules as unknown as Group[]) as Group[];
const groupFor = (agent: string) =>
  groups.find((g) => list(g.userAgent).includes(agent)) ?? groups.find((g) => list(g.userAgent).includes('*'))!;

// '*' reads the generic group; Googlebot reads only the named group.
const AGENTS = ['*', 'Googlebot'];

describe('robots.txt', () => {
  it.each(AGENTS)('%s: every signed-in app route is disallowed', (agent) => {
    const g = groupFor(agent);
    const open = [...APP_ROUTE_SEGMENTS].map((s) => `/${s}`).filter((p) => allowed(g, p));
    expect(open).toEqual([]);
  });

  it.each(AGENTS)('%s: app sub-paths that share a prefix with a marketing page are disallowed', (agent) => {
    const g = groupFor(agent);
    for (const p of ['/integrations/social/x', '/oauth/authorize', '/posts/:id/settings', '/api/public/v1/groups']) {
      expect([p, allowed(g, p)]).toEqual([p, false]);
    }
  });

  it.each(AGENTS)('%s: the marketing pages next to them stay crawlable', (agent) => {
    const g = groupFor(agent);
    for (const p of ['/', '/affiliates', '/integrations/n8n', '/docs/oauth', '/docs/public-api', '/auth']) {
      expect([p, allowed(g, p)]).toEqual([p, true]);
    }
  });

  it.each(AGENTS)('%s: no sitemap URL is disallowed', (agent) => {
    const g = groupFor(agent);
    const blocked = sitemap()
      .map((e) => new URL(e.url).pathname)
      .filter((p) => !allowed(g, p));
    expect(blocked).toEqual([]);
  });
});

// The crawlers behind ChatGPT, Claude, Perplexity, Gemini, Apple, Bing, Brave
// and DuckDuckGo, by the tokens their vendors document. Each must be named, and
// each must be able to read the pages AI assistants cite.
describe('robots.txt: AI assistants and search engines', () => {
  const DOCUMENTED = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User',
    'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
    'PerplexityBot', 'Perplexity-User',
    'Googlebot', 'Google-Extended', 'GoogleOther', 'Google-CloudVertexBot',
    'Bingbot', 'Applebot', 'Applebot-Extended',
    'DuckDuckBot', 'DuckAssistBot', 'Bravebot', 'meta-externalagent',
  ];
  const CITED = ['/', '/mcp', '/pricing', '/best-social-media-scheduler-india', '/social-media-calendar-india', '/for/agencies', '/llms.txt', '/llms-full.txt', '/sitemap.xml'];
  const named = groups.flatMap((g) => list(g.userAgent));

  it.each(DOCUMENTED)('%s is named in robots.txt', (agent) => {
    expect(named).toContain(agent);
  });

  it.each(DOCUMENTED)('%s can read every page AI assistants cite', (agent) => {
    const g = groupFor(agent);
    expect(CITED.filter((p) => !allowed(g, p))).toEqual([]);
  });

  it.each(DOCUMENTED)('%s is still kept out of the signed-in app', (agent) => {
    const g = groupFor(agent);
    expect(['/api/mcp', '/launches', '/settings'].filter((p) => allowed(g, p))).toEqual([]);
  });

  it('names no user agent a vendor does not send', () => {
    // 'ClaudeBot-User' was listed for months; no Anthropic agent sends it.
    expect(named).not.toContain('ClaudeBot-User');
  });

  it('no agent is shut out of the whole site', () => {
    expect(groups.filter((g) => list(g.disallow).includes('/'))).toEqual([]);
  });
});
