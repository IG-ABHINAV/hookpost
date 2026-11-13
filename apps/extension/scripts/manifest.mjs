/**
 * The extension's manifest, for the store build or a dev build.
 *
 * manifest.json IS the store manifest. A dev build appends manifest.dev.json's
 * localhost entries to its host_permissions and externally_connectable lists
 * and changes nothing else (manifest.int.spec.ts checks that on real builds),
 * so localhost can never reach the store zip by editing one file.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));

export function buildManifest({ dev = false } = {}) {
  const manifest = readJson('manifest.json');
  const pkg = readJson('package.json');
  if (manifest.version !== pkg.version) {
    throw new Error(
      `manifest.json version ${manifest.version} != package.json version ${pkg.version}`
    );
  }
  if (!dev) return manifest;

  const extra = readJson('manifest.dev.json');
  return {
    ...manifest,
    host_permissions: [
      ...manifest.host_permissions,
      ...extra.host_permissions,
    ],
    externally_connectable: {
      ...manifest.externally_connectable,
      matches: [
        ...manifest.externally_connectable.matches,
        ...extra.externally_connectable.matches,
      ],
    },
  };
}
