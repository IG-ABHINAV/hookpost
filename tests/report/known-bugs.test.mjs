// node --test tests/report/known-bugs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { knownBugs, markdown, testcases } from './known-bugs.mjs';

// What jest-junit writes for the normal run (skipped) and the RUN_KNOWN_BUGS run.
const normal = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="jest tests" tests="3" failures="0" errors="0" time="1">
  <testsuite name="widgets" tests="3" skipped="2">
    <testcase classname="widgets lists widgets" name="widgets lists widgets" time="0.1" file="/w/tests/integration/widgets.int.spec.ts">
    </testcase>
    <testcase classname="x" name="widgets BUG: an empty widget name is refused" time="0" file="/w/tests/integration/widgets.int.spec.ts">
      <skipped/>
    </testcase>
    <testcase classname="x" name="gadgets BUG: a gadget &amp; its &quot;parts&quot; round-trip" time="0" file="/w/tests/integration/gadgets.int.spec.ts">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`;
const rerun = `<testsuites><testsuite>
    <testcase name="widgets BUG: an empty widget name is refused" file="/w/tests/integration/widgets.int.spec.ts">
      <failure message="expected undefined">Error: expected undefined</failure>
    </testcase>
    <testcase name="gadgets BUG: a gadget &amp; its &quot;parts&quot; round-trip" file="/w/tests/integration/gadgets.int.spec.ts"/>
</testsuite></testsuites>`;

test('reads name, file and outcome of every testcase, entities decoded', () => {
  const cases = testcases(normal);
  assert.equal(cases.length, 3);
  assert.deepEqual(cases.map((c) => c.status), ['passed', 'skipped', 'skipped']);
  assert.equal(cases[2].name, 'gadgets BUG: a gadget & its "parts" round-trip');
  assert.equal(testcases(rerun)[1].status, 'passed');
});

test('a skipped BUG: test alone is listed as not checked', () => {
  const bugs = knownBugs(testcases(normal));
  assert.equal(bugs.length, 2);
  assert.ok(bugs.every((b) => b.state === 'unchecked'));
});

test('the RUN_KNOWN_BUGS run marks each bug open (fails) or passing', () => {
  const bugs = knownBugs([...testcases(normal), ...testcases(rerun)]);
  const byTitle = Object.fromEntries(bugs.map((b) => [b.title, b]));
  assert.equal(byTitle['an empty widget name is refused'].state, 'open');
  assert.deepEqual(byTitle['an empty widget name is refused'].files, [
    'widgets.int.spec.ts',
  ]);
  assert.equal(byTitle['a gadget & its "parts" round-trip'].state, 'passes');
});

test('Markdown: a count, one row per bug, and a clear line when there are none', () => {
  const md = markdown(knownBugs([...testcases(normal), ...testcases(rerun)]));
  assert.match(md, /^### Known bugs pinned by skipped tests: 2$/m);
  assert.match(md, /\| an empty widget name is refused \| widgets\.int\.spec\.ts \| still reproduces \|/);
  assert.match(markdown([]), /Known bugs pinned by skipped tests: 0[\s\S]*None/);
});
