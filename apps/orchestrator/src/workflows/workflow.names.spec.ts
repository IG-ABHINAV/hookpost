/**
 * The Temporal workflow names the backend and the orchestrator start by
 * string, checked against what the worker actually registers
 * (workflows/index.ts). A static check: nothing is run.
 *
 * Why: the post workflow version is pinned in two call sites (posts.service.ts
 * starts it for every post made in the app or API; post.activity.ts pokes
 * missed posts). On 6 Sep 2026 only one was bumped and every app-created post
 * kept running the old version for weeks. A name the worker does not register
 * fails only at publish time, in production.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const root = join(__dirname, '..', '..', '..', '..');
const workflowsDir = join(root, 'apps/orchestrator/src/workflows');
const SOURCES = ['apps/backend/src', 'apps/orchestrator/src', 'libraries/nestjs-libraries/src'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist') continue;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

const version = (file: string) =>
  file
    .match(/post\.workflow\.v(\d+)\.(\d+)\.(\d+)\.ts$/)!
    .slice(1)
    .map(Number);
const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const postWorkflowFiles = readdirSync(join(workflowsDir, 'post-workflows'))
  .filter((f) => /^post\.workflow\.v\d+\.\d+\.\d+\.ts$/.test(f))
  .sort((a, b) => compare(version(a), version(b)));
const newest = postWorkflowFiles[postWorkflowFiles.length - 1];
const newestName = `postWorkflowV${version(newest).join('')}`;

const index = readFileSync(join(workflowsDir, 'index.ts'), 'utf8');

/** Names exported by the modules index.ts re-exports: what the worker registers. */
function registeredWorkflows(): Set<string> {
  const names = new Set<string>();
  for (const m of index.matchAll(/export \* from '\.\/(.+?)'/g)) {
    const src = readFileSync(join(workflowsDir, `${m[1]}.ts`), 'utf8');
    for (const fn of src.matchAll(/export (?:async )?function (\w+)/g)) names.add(fn[1]);
  }
  return names;
}

/** Every workflow started or signal-started by a literal name, with where. */
function startedByName(): Array<{ name: string; where: string }> {
  const found: Array<{ name: string; where: string }> = [];
  for (const dir of SOURCES) {
    for (const file of walk(join(root, dir))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/(?:workflow\.start|signalWithStart|workflow\.execute)\(\s*'(\w+)'/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ name: m[1], where: `${relative(root, file)}:${line}` });
      }
    }
  }
  return found;
}

describe('Temporal workflow names', () => {
  const registered = registeredWorkflows();
  const started = startedByName();

  it('finds the call sites it is meant to check', () => {
    expect(started.length).toBeGreaterThanOrEqual(5);
    expect(started.filter((s) => s.name.startsWith('postWorkflowV')).length).toBeGreaterThanOrEqual(2);
  });

  it('every post workflow version file is exported from index.ts under its versioned name', () => {
    for (const file of postWorkflowFiles) {
      expect(index).toContain(`export * from './post-workflows/${file.replace(/\.ts$/, '')}'`);
      expect(registered).toContain(`postWorkflowV${version(file).join('')}`);
    }
  });

  it('both post workflow call sites start the newest version', () => {
    const posts = started.filter((s) => s.name.startsWith('postWorkflowV'));
    for (const s of posts) {
      expect({ where: s.where, name: s.name }).toEqual({ where: s.where, name: newestName });
    }
  });

  it('every workflow started by name is one the worker registers', () => {
    const unknown = started.filter((s) => !registered.has(s.name));
    expect(unknown).toEqual([]);
  });
});
