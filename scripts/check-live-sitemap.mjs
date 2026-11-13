#!/usr/bin/env node
/**
 * Live sitemap and internal-link check, as Googlebot sees the site.
 *
 *   node scripts/check-live-sitemap.mjs [https://hookpost.hookstep.in]
 *
 * Fails (exit 1) when:
 *   - a sitemap URL does not answer 200 itself (a redirect or 404 in the
 *     sitemap is what Search Console reports as "Page with redirect" / "Not
 *     found (404)" for submitted pages);
 *   - a sitemap URL is not self-canonical, or is noindex;
 *   - a page in the sitemap links (a href, canonical, hreflang alternate, or a
 *     JSON-LD value that is a bare URL) to a same-host URL that does not answer
 *     200, or llms.txt / llms-full.txt does.
 * URLs robots.txt disallows for Googlebot are skipped: those are the signed-in
 * app, which redirects to the login page on purpose.
 *
 * No dependencies; Node 18+ (global fetch). Read-only GETs, 6 at a time.
 */
const SITE = (process.argv[2] || 'https://hookpost.hookstep.in').replace(/\/+$/, '');
const HOST = new URL(SITE).host;
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

const get = async (url, { body = true } = {}) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      const text = body ? await res.text() : (res.body?.cancel(), '');
      return { status: res.status, location: res.headers.get('location'), xRobots: res.headers.get('x-robots-tag') || '', text };
    } catch (e) {
      if (attempt === 3) return { status: 0, location: null, xRobots: '', text: '', error: String(e) };
    }
  }
};

const pool = async (items, n, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
};

// robots.txt, Google's rules: the group naming Googlebot, else '*'; longest
// matching rule wins, allow wins a tie; `*` wildcard, trailing `$` anchor.
const robotsFor = (txt) => {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow') && val) cur.rules.push({ allow: key === 'allow', rule: val });
    }
  }
  const g = groups.find((x) => x.agents.includes('googlebot')) || groups.find((x) => x.agents.includes('*')) || { rules: [] };
  const re = (rule) => {
    const anchored = rule.endsWith('$');
    const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}${anchored ? '$' : ''}`);
  };
  const rules = g.rules.map((r) => ({ ...r, re: re(r.rule) }));
  return (path) => {
    const hits = rules.filter((r) => r.re.test(path)).sort((a, b) => b.rule.length - a.rule.length || b.allow - a.allow);
    return hits.length ? hits[0].allow : true;
  };
};

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]).replace(/&amp;/g, '&') : null;
};

const ldUrls = (node, out) => {
  if (typeof node === 'string') { if (/^https?:\/\/\S+$/.test(node)) out.push(node); }
  else if (Array.isArray(node)) node.forEach((x) => ldUrls(x, out));
  else if (node && typeof node === 'object') Object.values(node).forEach((x) => ldUrls(x, out));
};

const main = async () => {
  const problems = [];
  const rb = await get(`${SITE}/robots.txt`);
  // Without robots.txt every app URL would be fetched and reported as a redirect.
  if (rb.status !== 200) {
    console.error(`robots.txt ${SITE}/robots.txt: status ${rb.status}`);
    process.exit(1);
  }
  const allowed = robotsFor(rb.text);
  const sm = await get(`${SITE}/sitemap.xml`);
  const locs = [...sm.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  if (sm.status !== 200 || !locs.length) {
    console.error(`sitemap ${SITE}/sitemap.xml: status ${sm.status}, ${locs.length} URLs`);
    process.exit(1);
  }
  const refs = new Map(); // url -> Set(where)
  const abs = (href, base) => {
    try { return new URL(href, base).href; } catch { return null; }
  };
  const ref = (u, where) => {
    let url;
    try { url = new URL(u); } catch { return; }
    if (url.host !== HOST || !/^https?:$/.test(url.protocol)) return;
    url.hash = '';
    const key = url.href;
    if (!refs.has(key)) refs.set(key, new Set());
    refs.get(key).add(where);
  };

  await pool(locs, 6, async (loc) => {
    const r = await get(loc);
    if (r.status !== 200) {
      problems.push(`sitemap URL answers ${r.status}${r.location ? ` -> ${r.location}` : ''}: ${loc}`);
      return;
    }
    const tags = r.text.match(/<(a|link|meta)\s[^>]*>/gi) || [];
    const canon = tags.filter((t) => /^<link/i.test(t) && /\brel\s*=\s*["']?canonical/i.test(t)).map((t) => abs(attr(t, 'href') ?? '', loc) ?? `(bad href ${attr(t, 'href')})`);
    if (canon.length !== 1 || canon[0] !== new URL(loc).href) problems.push(`not self-canonical (${canon.join(', ') || 'none'}): ${loc}`);
    const robotsMeta = tags.filter((t) => /^<meta/i.test(t) && /name\s*=\s*["']?(robots|googlebot)["'\s]/i.test(t)).map((t) => attr(t, 'content') || '').join(' ');
    if (/noindex/i.test(robotsMeta + ' ' + r.xRobots)) problems.push(`noindex in the sitemap: ${loc}`);
    for (const t of tags) {
      const href = attr(t, 'href');
      if (!href || /^(mailto|tel|javascript|data):/i.test(href)) continue;
      const u = abs(href, loc);
      if (!u) continue;
      if (/^<a/i.test(t)) ref(u, `${loc} [a]`);
      else if (/^<link/i.test(t) && /\brel\s*=\s*["']?(canonical|alternate)/i.test(t)) ref(u, `${loc} [link]`);
    }
    for (const m of r.text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const urls = [];
        ldUrls(JSON.parse(m[1]), urls);
        urls.forEach((u) => ref(u, `${loc} [ld+json]`));
      } catch {
        problems.push(`JSON-LD does not parse: ${loc}`);
      }
    }
  });

  for (const f of ['llms.txt', 'llms-full.txt']) {
    const r = await get(`${SITE}/${f}`);
    if (r.status !== 200) continue;
    for (const m of r.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) ref(m[1], `${SITE}/${f}`);
  }

  const toCheck = [...refs.keys()].filter((u) => allowed(new URL(u).pathname + new URL(u).search));
  const results = await pool(toCheck, 6, async (u) => [u, await get(u, { body: false })]);
  for (const [u, r] of results) {
    if (r.status === 200) continue;
    const from = [...refs.get(u)];
    problems.push(`linked URL answers ${r.status}${r.location ? ` -> ${r.location}` : ''}: ${u}\n    from ${from.length}: ${from.slice(0, 3).join('; ')}${from.length > 3 ? ' ...' : ''}`);
  }

  console.log(`${SITE}: ${locs.length} sitemap URLs, ${toCheck.length} linked same-host URLs checked (${refs.size - toCheck.length} robots-disallowed skipped)`);
  if (problems.length) {
    console.log(problems.map((p) => `FAIL ${p}`).join('\n'));
    process.exit(1);
  }
  console.log('OK');
};

main().catch((e) => { console.error(e); process.exit(1); });
