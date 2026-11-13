#!/usr/bin/env node
// Fails when a frontend build states a trial length that is not Hookpost's.
//
//   node scripts/check-trial-days.js apps/frontend/.next
//   scripts/check-trial-days.sh               (same, with the default dir)
//
// Hookpost's trial is TRIAL_DAYS days (libraries/nestjs-libraries/src/
// database/prisma/subscriptions/trial.policy.ts), the number checkout's
// start_at uses. It went from 7 to 3 on 22 Oct 2026, and a page still saying
// "7-day trial" would promise four days nobody gets. Since 28 Oct 2026 new
// workspaces get no trial (FREE_POST_LIMIT free posts instead), so the only
// "3-day trial" left on a built page is the legal pages' (workspaces already on
// a trial keep it) and the home demo video's transcript; this check does not
// require any trial text, it only rejects a wrong length, so it needs no change
// for that. trial-offer.spec.ts is what fails on a new-user page that says
// "N-day trial" at all. Every page reads the
// constant, but a typed "7-day" can come back in a new page or a copied
// sentence, so this reads what the build emits, the way check-free-claims.js
// does: every prerendered page (visible text, <title>, meta descriptions,
// JSON-LD) and every route body (llms.txt, llms-full.txt), sentence by
// sentence.
//
// A length tied to a trial ("7-day trial", "trial: 7 days") other than
// TRIAL_DAYS fails, unless it is the trial of a competitor the sentence
// names (Postiz and Publer have 7-day trials, Hootsuite and Buffer 14, and so
// on: VENDOR_TRIAL_DAYS, which check-trial-days.spec.ts keeps equal to
// compare/competitor-facts.ts). A comparison table names its vendors in the
// heading row, so each table cell is read with its column heading and row
// label in front of it; a sentence that names nobody, Hookpost included,
// borrows the vendor of the few text blocks before it. An offer in the
// imperative ("Start 7-day trial", "Try it for 7 days") is always Hookpost's,
// whatever is around it.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { htmlSegments } = require('./check-free-claims.js');

const REPO = path.join(__dirname, '..');
const POLICY = path.join(
  REPO,
  'libraries/nestjs-libraries/src/database/prisma/subscriptions/trial.policy.ts'
);

/** TRIAL_DAYS as trial.policy.ts declares it, so there is one number to change. */
function readTrialDays(file = POLICY) {
  const m = /export const TRIAL_DAYS = (\d+);/.exec(fs.readFileSync(file, 'utf8'));
  if (!m) throw new Error(`No "export const TRIAL_DAYS = <n>;" in ${file}`);
  return Number(m[1]);
}

/**
 * Competitors' trial lengths in days, as the pages state them (compare/
 * competitor-facts.ts: COMPETITOR_FACTS, INDIA_FACTS and MIXPOST_CLOUD).
 * A vendor named on a page but missing here has no length to check against,
 * so any length next to its name passes.
 */
const VENDOR_TRIAL_DAYS = {
  Buffer: [14],
  Hootsuite: [14],
  Later: [14],
  'Sprout Social': [30],
  Publer: [7],
  SocialPilot: [14],
  Agorapulse: [30],
  Postiz: [7],
  // Mixpost licences have no trial; Mixpost Cloud's is 7 days.
  Mixpost: [7],
  'Zoho Social': [15],
  Sendible: [14],
  Posttely: [30],
  PostStage: [14],
  RecurPost: [14],
  'Predis.ai': [3],
  Poststack: [15],
  Statusbrew: [14],
  // Not in competitor-facts.ts: quoted from its own page on
  // guides/chatgpt-social-media-scheduling (7-day trial, then $39 a month).
  Postbeam: [7],
};

// Every vendor the pages compare with, as capitalised, with or without a
// trial length on file (check-free-claims.js keeps the same list).
const VENDOR_NAMES = [
  ...Object.keys(VENDOR_TRIAL_DAYS),
  'Sprout',
  'Zoho',
  'Predis',
  'Metricool',
  'Planoly',
  'Typefully',
  'Loomly',
  'Tailwind',
  'CoSchedule',
  'MeetEdgar',
  'Ayrshare',
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VENDOR_RE = new RegExp(
  `\\b(${VENDOR_NAMES.sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\b`,
  'g'
);

const WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, twenty: 20, thirty: 30,
};
const NUM = `(\\d{1,3}|${Object.keys(WORDS).join('|')})`;
// A length tied to a trial: "7-day trial", "7-Day Free Trial", "14 day
// trial", or "trial: 7 days", "trial of 7 days", "trial is 3 days". Days
// that only share a sentence with a trial ("purged 30 days after deletion
// ... a second free trial") are not a trial's length.
const TRIAL_LENGTH_RES = [
  new RegExp(`\\b${NUM}[- ]days?(?:[- ](?:free|money[- ]back))?[- ]trials?\\b`, 'gi'),
  new RegExp(`\\btrials?\\b[^.;()]{0,20}?\\b${NUM}[- ]days?\\b`, 'gi'),
];
// An offer in the imperative is Hookpost's own, whatever is around it:
// "Start 7-day trial", "Start your 7-day trial", "Start 7-Day Free Trial",
// "Try it for 7 days".
const IMPERATIVE_RES = [
  new RegExp(`\\b(?:start|begin)\\b[^.!?]{0,20}?\\b${NUM}[- ]day\\b`, 'gi'),
  new RegExp(`\\btry\\b[^.!?]{0,15}?\\bfor ${NUM} days\\b`, 'gi'),
];
const HOOKPOST_RE = /\bhookpost\b/i;

const toNumber = (s) => {
  const t = s.toLowerCase();
  return /^\d+$/.test(t) ? Number(t) : WORDS[t];
};

const lengthsBy = (res, sentence) =>
  res.flatMap((re) => [...sentence.matchAll(re)].map((m) => toNumber(m[1])));

function vendorsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(VENDOR_RE)) {
    const name = m[1] === 'Sprout' ? 'Sprout Social' : m[1] === 'Zoho' ? 'Zoho Social' : m[1] === 'Predis' ? 'Predis.ai' : m[1];
    out.add(name);
  }
  return out;
}

/** Whose length can `n` be, among `vendors`? True when one of them has it, or one has none on file. */
function vendorExplains(n, vendors) {
  for (const v of vendors) {
    const known = VENDOR_TRIAL_DAYS[v];
    if (!known || known.includes(n)) return true;
  }
  return false;
}

/**
 * The wrong lengths in one sentence, or [] when it is fine. `context` is the
 * sentence's own text block and the few before it, read only when the
 * sentence names nobody: not a competitor, and not Hookpost.
 */
function wrongLengths(sentence, context = [], trialDays = readTrialDays()) {
  const offered = lengthsBy(IMPERATIVE_RES, sentence).filter((n) => n !== trialDays);
  if (offered.length) return offered;
  const other = lengthsBy(TRIAL_LENGTH_RES, sentence).filter((n) => n !== trialDays);
  if (!other.length) return [];
  let vendors = vendorsIn(sentence);
  if (!vendors.size && !HOOKPOST_RE.test(sentence)) {
    for (const block of context) {
      vendors = vendorsIn(block);
      if (vendors.size) break;
    }
  }
  return [...new Set(other.filter((n) => !vendorExplains(n, vendors)))];
}

const sentences = (segment) =>
  segment.split(/(?<=[.!?])\s+(?=[A-Z₹"'(])/).map((s) => s.trim()).filter(Boolean);

const CONTEXT_BEFORE = 4;

function checkText(name, segments, trialDays = readTrialDays()) {
  const hits = [];
  segments.forEach((segment, i) => {
    const before = segments.slice(Math.max(0, i - CONTEXT_BEFORE), i).reverse();
    for (const s of sentences(segment)) {
      const wrong = wrongLengths(s, [segment, ...before], trialDays);
      if (wrong.length) hits.push({ file: name, sentence: s, days: wrong });
    }
  });
  return hits;
}

const cellText = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A comparison table names its vendors once, in the heading row (and a row
 * label), while each cell under them states a fact. Read flat, a cell such as
 * "No free plan (7-day trial)" belongs to nobody. So every body cell is read
 * as "<column heading> (<row label>): <cell>", which names whose it is.
 */
function annotateTables(html) {
  const CELL = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  return html.replace(/<table\b[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
    const head = rows.find((r) => /<th\b/i.test(r) && !/<td\b/i.test(r));
    const headers = head ? [...head.matchAll(CELL)].map((m) => cellText(m[3])) : [];
    return table.replace(/<tr\b[\s\S]*?<\/tr>/gi, (row) => {
      if (row === head) return row;
      const cells = [...row.matchAll(CELL)];
      const label = cells.length ? cellText(cells[0][3]) : '';
      let i = -1;
      return row.replace(CELL, (whole, tag, attrs, inner) => {
        i++;
        if (i === 0) return whole;
        const owner = [headers[i], label && `(${label})`].filter(Boolean).join(' ');
        return owner ? `<${tag}${attrs}>${owner}: ${inner}</${tag}>` : whole;
      });
    });
  });
}

function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(html|body)$/.test(entry.name)) yield full;
  }
}

function checkBuild(distDir, trialDays = readTrialDays()) {
  const root = path.join(distDir, 'server', 'app');
  if (!fs.existsSync(root)) throw new Error(`${root} does not exist: build the frontend first`);
  const hits = [];
  let pages = 0;
  for (const file of files(root)) {
    const rel = path.relative(root, file);
    if (/^_(global-error|not-found)\b|sitemap\.xml|robots\.txt|\.rsc$|\.segments\//.test(rel)) continue;
    pages++;
    const raw = fs.readFileSync(file, 'utf8');
    const segments = file.endsWith('.html')
      ? htmlSegments(annotateTables(raw))
      : raw.split('\n');
    hits.push(...checkText(rel, segments, trialDays));
  }
  return { pages, hits };
}

module.exports = {
  VENDOR_TRIAL_DAYS,
  readTrialDays,
  annotateTables,
  wrongLengths,
  checkText,
  checkBuild,
};

if (require.main === module) {
  const dist = path.resolve(process.argv[2] || path.join(REPO, 'apps/frontend/.next'));
  const trialDays = readTrialDays();
  const { pages, hits } = checkBuild(dist, trialDays);
  if (!pages) {
    console.error(`No prerendered pages under ${dist}/server/app: build the frontend first.`);
    process.exit(2);
  }
  if (hits.length) {
    console.error(
      `${hits.length} sentence(s) in ${dist} give a trial length that is not Hookpost's ${trialDays} days (TRIAL_DAYS in trial.policy.ts) and is not the trial of a competitor they name:`
    );
    for (const h of hits) console.error(`  ${h.file}: ${h.sentence}`);
    process.exit(1);
  }
  console.log(`check-trial-days: ${pages} pages, every trial length is ${trialDays} days or a named competitor's.`);
}
