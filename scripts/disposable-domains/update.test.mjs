// node --test scripts/disposable-domains/update.test.mjs
// The weekly refresh refuses a list that would lock real people out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseList, render } from './update.mjs';

const many = Array.from({ length: 1200 }, (_, i) => `d${i}.example`);

test('sorts, de-duplicates, lowercases and skips comments', () => {
  const out = parseList(['# header', 'B.example', 'a.example', 'a.example', '', ...many].join('\n'));
  assert.equal(out[0], 'a.example');
  assert.ok(out.includes('b.example'));
  assert.equal(new Set(out).size, out.length);
});
test('refuses a short list', () => {
  assert.throws(() => parseList('a.example\nb.example'), /refusing/);
});
test('refuses a mainstream provider', () => {
  assert.throws(() => parseList([...many, 'gmail.com'].join('\n')), /mainstream/);
});
test('refuses a line that is not a domain', () => {
  assert.throws(() => parseList([...many, 'not a domain'].join('\n')), /not domains/);
});
test('renders a module with the count and the CC0 credit', () => {
  const text = render(['a.example', 'b.example'], '2026-11-01');
  assert.match(text, /CC0 1\.0/);
  assert.match(text, /2 domains, fetched 2026-11-01/);
  assert.ok(text.includes('export const DISPOSABLE_DOMAINS_TEXT = "a.example\\nb.example";'));
});
