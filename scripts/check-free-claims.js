#!/usr/bin/env node
// Fails when a marketing build made with a trial cutoff still offers new users
// a Free plan. PR-3 of local-assets/trial-usd-plan-2026-10-18.md. Since 28 Oct
// 2026 those users get FREE_POST_LIMIT free posts with no card instead of a
// trial: the exact sentence "3 free posts, no card needed" is allowed by
// check-free-claims.allow, and everything else about a free plan, a forever-free
// start or "no card" still fails.
//
//   node scripts/check-free-claims.js apps/frontend/.next
//   scripts/check-free-claims.sh                (same, with the default dir)
//
// It reads what the build actually emits, not the source: the copy switches
// with TRIAL_REQUIRED_SINCE_IN / _GLOBAL at build (apps/frontend/src/app/
// (landing)/trial-offer.ts), so the source carries both versions of every
// sentence by design and a grep over it could never come back clean. Every
// prerendered page (.html: visible text, <title>, meta descriptions, JSON-LD)
// and every prerendered route body (.body: llms.txt, llms-full.txt) is split
// into sentences, and a sentence fails when it offers a free plan, a free
// start or "no card", unless it is about another vendor, says there is none,
// or matches an entry in scripts/check-free-claims.allow.
//
// Run it only on a build made with a cutoff set: a build without one is
// supposed to offer the Free plan and fails here on purpose (the spec uses
// that to prove the check bites). With a cutoff that is not a valid UTC
// timestamp the build falls back to the Free copy, so this fails then too,
// which is the point: fix the value before deploying.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;

// Offers only Hookpost makes on these pages: a free start, "no card", "no
// risk". Nothing about another vendor excuses these; only the allowlist does.
const OFFER = [
  /\bfree forever\b|\bforever free\b/i,
  /\bno (credit )?card\b|\(no cc\b|\bno cc required\b/i,
  /\bno[- ]risk\b/i,
  /\b(start(ed)?|try( it)?|get started|sign up|launch|create( your)?) (for )?free\b/i,
  /\bstarts free\b|\bfree to start\b|\bget free access\b/i,
];

// Free plans and prices of nothing: fine when they belong to another vendor.
const PLAN = [
  /\bfree[- ](plan|tier)s?\b/i,
  /\b(hosted|cloud) free\b|\bfree (hosted|cloud)\b/i,
  /\bfree to join\b|\bfree access\b|\bfree account\b/i,
  // "₹0 today" / "aaj ₹0" is the trial's own terms, not a free plan.
  /(?<!aaj )₹0(?! today)\b|\$0\b/i,
];

// Hookpost's Free-plan limits (pricing.ts FREE: 2 channels, 30 posts a month).
// A sentence quoting both is describing Hookpost Free whoever else it names.
const FREE_LIMITS = /\b2 channels\b[^.]*\b30 posts\b|\b30 posts\b[^.]*\b2 channels\b/i;

// Another vendor's name, as it is capitalised (case-sensitive, so the word
// "later" is not Later). "Hookpost" in the same sentence makes it Hookpost's
// claim again, unless the sentence also says Hookpost has none (NEGATION).
const VENDORS =
  /\b(Buffer|Hootsuite|Later|Sprout|Metricool|Publer|Postiz|Mixpost|SocialPilot|Agorapulse|Planoly|Typefully|Zoho|Sendible|Loomly|Tailwind|CoSchedule|MeetEdgar|Posttely|PostStage|Poststack|RecurPost|Predis|Ayrshare|Postbeam|Claude|ChatGPT|Canva|Meta Business Suite|YouTube Studio)\b/;

// Statements that there is no free plan (Hookpost's or anyone's).
const NEGATION =
  /\b(no|not|never|without) (a |any )?(hosted )?free[- ](plan|tier)s?\b|\bnot free plans\b|\bhas no free plan\b|\blists no free plan\b|\bfree plan: none\b|\bhookpost (does not|doesn't|has no)\b|\bnone on the hosted\b/i;

// Table headers and row labels: a free plan is being compared, not offered.
const LABEL =
  /^(hosted )?free (plan|tier|starter tier)s?( or trial)?(, api and mcp)?\??$|^free \/ trial$|^on a free plan$|^api and mcp on the free plan$/i;

function loadAllow() {
  const file = path.join(HERE, 'check-free-claims.allow');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => new RegExp(l, 'i'));
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→',
  larr: '←', mdash: '—', ndash: '–', hellip: '…', middot: '·', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', times: '×',
};
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

const INLINE = /^(a|abbr|b|code|em|i|kbd|mark|s|small|span|strong|sub|sup|u|time|data)$/i;

/** Text segments of one prerendered HTML page. */
function htmlSegments(html) {
  const out = [];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) out.push(decode(title[1]));
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = /\b(?:name|property)="([^"]+)"/i.exec(tag)?.[1] || '';
    if (/description|title/i.test(key)) {
      const content = /\bcontent="([^"]*)"/i.exec(tag)?.[1];
      if (content) out.push(decode(content));
    }
  }
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (v) => {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(JSON.parse(m[1]));
    } catch {
      out.push(decode(m[1]));
    }
  }
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '\n')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?([a-z0-9-]+)\b[^>]*>/gi, (_m, tag) => (INLINE.test(tag) ? '' : '\n'));
  for (const line of decode(body).split('\n')) out.push(line);
  return out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const sentences = (segment) =>
  segment.split(/(?<=[.!?])\s+(?=[A-Z₹"'(])/).map((s) => s.trim()).filter(Boolean);

const HOOKPOST = /\bhookpost\b/i;

/**
 * Why a sentence is fine, or null when it offers new users something free.
 * `context` is the sentence's own text block plus the few before it (a table
 * row's first cell, a card's heading), which is where a comparison names the
 * vendor a "Free plan: ..." cell belongs to.
 */
function verdict(sentence, segment, before = [], allow = []) {
  const allowed = allow.some((re) => re.test(sentence));
  if (FREE_LIMITS.test(sentence) && !NEGATION.test(sentence)) {
    return allowed ? 'allowlisted' : null;
  }
  if (OFFER.some((re) => re.test(sentence))) return allowed ? 'allowlisted' : null;
  if (!PLAN.some((re) => re.test(sentence))) return 'no claim';
  if (LABEL.test(segment) || LABEL.test(sentence)) return 'label';
  if (NEGATION.test(sentence)) return 'says there is none';
  if (allowed) return 'allowlisted';
  if (HOOKPOST.test(sentence)) return null;
  if (VENDORS.test(sentence)) return 'another vendor';
  // A comparison cell or card: whose is it? The nearest text naming a vendor
  // or Hookpost, from the sentence's own block back to a heading or row label.
  for (const block of [segment, ...before]) {
    const vendor = VENDORS.test(block);
    const hookpost = HOOKPOST.test(block);
    if (vendor && !hookpost) return 'another vendor';
    if (hookpost && !vendor) return null;
  }
  return null;
}

const CONTEXT_BEFORE = 4;

function checkText(name, segments, allow = []) {
  const hits = [];
  segments.forEach((segment, i) => {
    const before = segments.slice(Math.max(0, i - CONTEXT_BEFORE), i).reverse();
    for (const s of sentences(segment)) {
      if (verdict(s, segment, before, allow) === null) hits.push({ file: name, sentence: s });
    }
  });
  return hits;
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(html|body)$/.test(entry.name)) yield full;
  }
}

function checkBuild(distDir, allow = loadAllow()) {
  const root = path.join(distDir, 'server', 'app');
  if (!fs.existsSync(root)) throw new Error(`${root} does not exist: build the frontend first`);
  const hits = [];
  let pages = 0;
  for (const file of files(root)) {
    const rel = path.relative(root, file);
    // The signed-in app, error shells and machine files are not marketing copy.
    if (/^_(global-error|not-found)\b|sitemap\.xml|robots\.txt|\.rsc$|\.segments\//.test(rel)) continue;
    pages++;
    const raw = fs.readFileSync(file, 'utf8');
    const segments = file.endsWith('.html') ? htmlSegments(raw) : raw.split('\n');
    hits.push(...checkText(rel, segments, allow));
  }
  return { pages, hits };
}

module.exports = { htmlSegments, verdict, checkText, checkBuild, loadAllow };

if (require.main === module) {
  const dist = process.argv[2] || path.join(HERE, '..', 'apps', 'frontend', '.next');
  const { pages, hits } = checkBuild(dist);
  if (hits.length) {
    console.error(`check-free-claims: ${hits.length} sentence(s) in ${dist} still offer new users something free:`);
    for (const h of hits) console.error(`  ${h.file}: ${h.sentence}`);
    console.error(
      '\nEither switch the copy with offer() from trial-offer.ts, or, if the sentence is really about another vendor or says there is no free plan, add a reviewed pattern to scripts/check-free-claims.allow.'
    );
    process.exit(1);
  }
  console.log(`check-free-claims: ${pages} prerendered pages and files, no free-plan offers.`);
}
