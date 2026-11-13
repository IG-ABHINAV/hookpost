/**
 * Runs the real build (scripts/build.mjs) for the store and for dev, and
 * checks the two manifests differ only in their localhost entries, and that
 * the store one asks for nothing it does not use.
 *   pnpm exec jest -c apps/extension/jest.config.ts manifest
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const root = join(__dirname, '..', '..', '..');
const script = join(root, 'apps', 'extension', 'scripts', 'build.mjs');

type Manifest = Record<string, any>;

function buildInto(dir: string, dev: boolean): void {
  execFileSync(
    process.execPath,
    [script, '--out-dir', dir, '--no-zip', ...(dev ? ['--dev'] : [])],
    { cwd: root, stdio: 'pipe', env: { ...process.env, NEXT_PUBLIC_BACKEND_URL: '' } }
  );
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

/** The manifest with every list entry that mentions localhost taken out. */
function withoutLocalhost(value: any): any {
  if (Array.isArray(value)) {
    return value
      .filter((v) => !(typeof v === 'string' && v.includes('localhost')))
      .map(withoutLocalhost);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withoutLocalhost(v)])
    );
  }
  return value;
}

describe('built manifests', () => {
  let tmp: string;
  let storeDir: string;
  let devDir: string;
  let store: Manifest;
  let dev: Manifest;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hookpost-ext-'));
    storeDir = join(tmp, 'store');
    devDir = join(tmp, 'dev');
    buildInto(storeDir, false);
    buildInto(devDir, true);
    store = JSON.parse(read(storeDir, 'manifest.json'));
    dev = JSON.parse(read(devDir, 'manifest.json'));
  }, 120_000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('differ only in localhost', () => {
    expect(dev).not.toEqual(store);
    expect(withoutLocalhost(dev)).toEqual(store);
    expect(dev.externally_connectable.matches).toEqual([
      ...store.externally_connectable.matches,
      'http://localhost/*',
      'https://localhost/*',
    ]);
    expect(dev.host_permissions).toEqual([...store.host_permissions, 'http://localhost/*']);
  });

  it('the store manifest talks to the Hookpost app only', () => {
    expect(store.externally_connectable).toEqual({
      matches: ['https://hookpost.hookstep.in/*'],
    });
    expect(JSON.stringify(store)).not.toContain('localhost');
    expect(JSON.stringify(store)).not.toContain('*.hookstep.in');
  });

  it('the store manifest asks only for what background.js uses', () => {
    expect(store.permissions).toEqual(['cookies', 'alarms', 'storage']);
    // The refresh POST to the API, and Skool's cookies.
    expect(store.host_permissions).toEqual(['https://hookpost.hookstep.in/*', 'https://www.skool.com/*']);
    const code = read(storeDir, 'background.js');
    expect(code).toContain('chrome.cookies.get(');
    // Only the two named Skool cookies, never the whole jar.
    expect(code).not.toContain('chrome.cookies.getAll');
    // No remote code: nothing evaluated or loaded at run time.
    for (const banned of ['eval(', 'new Function', 'importScripts', 'import(']) {
      expect(code).not.toContain(banned);
    }
    expect(code).toContain('chrome.alarms.');
    expect(code).toContain('chrome.storage.local');
    // No content scripts, tabs, scripting, web requests or broad hosts.
    for (const key of ['content_scripts', 'web_accessible_resources', 'optional_permissions', 'key']) {
      expect(store).not.toHaveProperty(key);
    }
  });

  it('is Hookpost 1.0.2 with no upstream traces', () => {
    expect(store.name).toBe('Hookpost');
    expect(store.version).toBe('1.0.2');
    expect(store.manifest_version).toBe(3);
    expect(store.description.length).toBeLessThanOrEqual(132);
    const all = ['manifest.json', 'background.js', 'popup.html', 'popup.js']
      .map((f) => read(storeDir, f))
      .join('')
      .toLowerCase();
    for (const word of ['postiz', 'gitroom', 'hookpost.com', 'localhost']) {
      expect(all).not.toContain(word);
    }
  });

  it('ships the Hookpost logo, not the purple "p" icon inherited from the fork', () => {
    // md5 of the icon-128.png committed before 25 Oct 2026.
    const md5 = createHash('md5').update(readFileSync(join(storeDir, 'icon-128.png'))).digest('hex');
    expect(md5).not.toBe('4779ecef57c6f5973f349e48b54e6fc8');
  });

  it('the store build holds exactly the six files the zip ships', () => {
    expect(readdirSync(storeDir).sort()).toEqual([
      'background.js',
      'icon-128.png',
      'icon-32.png',
      'manifest.json',
      'popup.html',
      'popup.js',
    ]);
  });

  it('has a toolbar popup, so clicking the icon shows something', () => {
    expect(store.action).toEqual({
      default_popup: 'popup.html',
      default_title: 'Hookpost',
      default_icon: { '32': 'icon-32.png', '128': 'icon-128.png' },
    });
    const html = read(storeDir, 'popup.html');
    // MV3 refuses inline scripts: the page loads popup.js and nothing else.
    expect(html).toMatch(/<script type="module" src="popup.js"><\/script>/);
    expect(html.match(/<script/g)).toHaveLength(1);
    const code = read(storeDir, 'popup.js');
    // The popup asks the background; it reads no cookies and fetches nothing itself.
    expect(code).toMatch(/type: ["']POPUP_STATUS["']/);
    for (const banned of ['chrome.cookies', 'fetch(', 'eval(', 'new Function', 'import(', 'innerHTML']) {
      expect(code).not.toContain(banned);
    }
  });

  it('the store background.js posts to the hardcoded API and the dev one to localhost', () => {
    const code = read(storeDir, 'background.js');
    // Since the popup also uses the origin, the bundle keeps it as a constant
    // and builds the API URL from it.
    expect(code).toMatch(/PRODUCTION_ORIGIN = ["']https:\/\/hookpost\.hookstep\.in["'];/);
    expect(code).toContain('PRODUCTION_BACKEND_URL = `${PRODUCTION_ORIGIN}/api`');
    expect(code).toContain('backendUrl: PRODUCTION_BACKEND_URL,');
    // The popup's "Open Hookpost" button.
    expect(code).toContain('appUrl: PRODUCTION_ORIGIN');
    expect(read(devDir, 'background.js')).toContain('http://localhost:3000');
  });
});
