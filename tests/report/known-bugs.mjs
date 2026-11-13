#!/usr/bin/env node
/**
 * Lists the known bugs: tests named "BUG: ..." (tests/integration/setup/
 * known-bug.ts), which are skipped in the normal run so the nightly stays
 * green. Without this list a skipped bug never shows up anywhere, and a
 * security hole can stay open behind a green run.
 *
 *   node tests/report/known-bugs.mjs <dir-with-junit-xml> [more dirs...]
 *
 * Reads every *.xml under the directories (JUnit from jest-junit, node:test
 * and Playwright). The nightly also runs the BUG: tests once with
 * RUN_KNOWN_BUGS=1; from that run each bug is marked as still reproducing
 * (the test fails) or apparently fixed (it passes). Prints Markdown for the
 * run summary and the standing issue; exit code 0 either way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decode(m[1]) : undefined;
};

/** Every <testcase> in one JUnit document: name, file and outcome. */
export function testcases(xml) {
  const out = [];
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const [, attrs, body = ''] = m;
    const status = /<(failure|error)\b/.test(body) ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed';
    out.push({ name: attr(attrs, 'name') || '', file: attr(attrs, 'file'), status });
  }
  return out;
}

/** The known bugs among `cases`, one entry per bug, with what the runs say. */
export function knownBugs(cases) {
  const bugs = new Map();
  for (const c of cases) {
    const i = c.name.indexOf('BUG:');
    if (i < 0) continue;
    const title = c.name.slice(i + 4).trim();
    const bug = bugs.get(title) || { title, files: new Set(), statuses: new Set() };
    if (c.file) bug.files.add(basename(c.file));
    bug.statuses.add(c.status);
    bugs.set(title, bug);
  }
  return [...bugs.values()].map((b) => ({
    title: b.title,
    files: [...b.files],
    // A failure in the RUN_KNOWN_BUGS run means the bug still reproduces.
    state: b.statuses.has('failed') ? 'open' : b.statuses.has('passed') ? 'passes' : 'unchecked',
  }));
}

const STATE = {
  open: 'still reproduces',
  passes: '**test passes now**: fixed? make it a normal test',
  unchecked: 'not checked this run',
};

export function markdown(bugs) {
  const lines = [`### Known bugs pinned by skipped tests: ${bugs.length}`, ''];
  if (!bugs.length) {
    lines.push('None: no `BUG:` test was skipped in this run.');
    return lines.join('\n') + '\n';
  }
  lines.push(
    'Real product bugs a test reproduces. The tests are skipped so the nightly stays green, so they are listed here instead; `RUN_KNOWN_BUGS=1` runs them (TESTING.md).',
    '',
    '| Bug | Test file | Status |',
    '|---|---|---|'
  );
  for (const b of bugs.sort((x, y) => x.title.localeCompare(y.title))) {
    lines.push(`| ${b.title.replace(/\|/g, '\\|')} | ${b.files.join(', ') || '?'} | ${STATE[b.state]} |`);
  }
  return lines.join('\n') + '\n';
}

function xmlFiles(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out = out.concat(xmlFiles(p));
    else if (entry.endsWith('.xml')) out.push(p);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (!dirs.length) {
    console.error('usage: node tests/report/known-bugs.mjs <dir> [dir...]');
    process.exit(2);
  }
  const cases = dirs.flatMap((d) => xmlFiles(d)).flatMap((f) => testcases(readFileSync(f, 'utf8')));
  process.stdout.write(markdown(knownBugs(cases)));
}
