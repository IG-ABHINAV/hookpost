#!/usr/bin/env node
/**
 * Builds the Hookpost Chrome extension. The only build path: the store zip is
 * made here (or by .github/workflows/build-extension.yaml, which runs this),
 * never committed.
 *
 *   node apps/extension/scripts/build.mjs
 *       store build: apps/extension/dist/ and
 *       apps/extension/hookpost-extension-v<version>.zip
 *   node apps/extension/scripts/build.mjs --zip ~/Desktop/EXTENSION-UPLOAD/hookpost-extension-v1.0.2.zip
 *   node apps/extension/scripts/build.mjs --dev [--watch]
 *       dev build into dist-dev/: also answers localhost pages and posts to
 *       NEXT_PUBLIC_BACKEND_URL (default http://localhost:3000). No zip.
 *
 *   --out-dir <dir>   build somewhere else (the manifest test uses this)
 *   --no-zip          skip the zip
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildManifest } from './manifest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const dev = flag('--dev');
const watch = flag('--watch');
const manifest = buildManifest({ dev });
const outDir = resolve(option('--out-dir') ?? join(root, dev ? 'dist-dev' : 'dist'));
const zipPath =
  dev || flag('--no-zip')
    ? undefined
    : resolve(option('--zip') ?? join(root, `hookpost-extension-v${manifest.version}.zip`));

// Exactly what the store build may contain.
const STORE_FILES = [
  'background.js',
  'icon-128.png',
  'icon-32.png',
  'manifest.json',
  'popup.html',
  'popup.js',
];

const emitManifest = {
  name: 'hookpost-manifest',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'manifest.json',
      source: JSON.stringify(manifest, null, 2) + '\n',
    });
  },
};

await build({
  root,
  configFile: join(root, 'vite.config.ts'),
  mode: dev ? 'development' : 'production',
  logLevel: 'warn',
  plugins: [emitManifest],
  build: {
    outDir,
    emptyOutDir: true,
    ...(watch ? { watch: {} } : {}),
  },
});

if (watch) {
  console.log(`Watching; load ${outDir} unpacked at chrome://extensions`);
} else {
  if (!dev) {
    const files = readdirSync(outDir).sort();
    if (JSON.stringify(files) !== JSON.stringify(STORE_FILES)) {
      throw new Error(`Unexpected files in the store build: ${files.join(', ')}`);
    }
    for (const file of ['background.js', 'popup.js', 'popup.html']) {
      const code = readFileSync(join(outDir, file), 'utf8');
      for (const banned of ['localhost', '__HOOKPOST_', 'postiz', 'gitroom']) {
        if (code.toLowerCase().includes(banned.toLowerCase())) {
          throw new Error(`The store build's ${file} contains "${banned}"`);
        }
      }
    }
  }
  if (zipPath) {
    mkdirSync(dirname(zipPath), { recursive: true });
    if (existsSync(zipPath)) rmSync(zipPath);
    // -X: no extra file attributes; entries sit at the zip's root, as the
    // Chrome Web Store expects.
    execFileSync('zip', ['-q', '-X', '-r', zipPath, ...STORE_FILES], { cwd: outDir });
    console.log(`Built ${zipPath}`);
  } else {
    console.log(`Built ${outDir}`);
  }
}
