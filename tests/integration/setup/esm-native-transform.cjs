/**
 * Lets the in-process backend load its ESM-only dependencies under jest.
 *
 * The production backend runs on Node 22 with require(esm) (see
 * apps/backend/package.json, --experimental-require-module), so packages such
 * as file-type, @noble/curves (via nostr-tools) and others are ESM-only and
 * still load. Jest's own module system cannot require ESM. For a file that is
 * ESM (a .mjs file, or a .js file in a "type": "module" package), this
 * transform replaces its body with a call to Node's real require of the same
 * file, made available by node-environment.cjs. CommonJS files pass through
 * untouched.
 */
const { createHash } = require('crypto');
const { dirname, join } = require('path');
const { existsSync, readFileSync } = require('fs');

const typeCache = new Map();
function packageType(dir) {
  if (typeCache.has(dir)) return typeCache.get(dir);
  let type = 'commonjs';
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const json = JSON.parse(readFileSync(pkg, 'utf8'));
      // A nested package.json without "name" (e.g. dist/cjs/package.json)
      // still sets the type for its folder.
      type = json.type === 'module' ? 'module' : 'commonjs';
    } catch {
      type = 'commonjs';
    }
  } else {
    const parent = dirname(dir);
    type = parent === dir ? 'commonjs' : packageType(parent);
  }
  typeCache.set(dir, type);
  return type;
}

function isEsm(path) {
  if (path.endsWith('.mjs')) return true;
  if (path.endsWith('.cjs')) return false;
  return packageType(dirname(path)) === 'module';
}

module.exports = {
  process(sourceText, sourcePath) {
    if (!isEsm(sourcePath)) {
      return { code: sourceText };
    }
    return {
      code: `module.exports = globalThis.__nativeRequire(${JSON.stringify(sourcePath)});`,
    };
  },
  getCacheKey(sourceText, sourcePath) {
    return createHash('sha1')
      .update('esm-native-v1\0')
      .update(sourcePath)
      .update('\0')
      .update(sourceText)
      .digest('hex');
  },
};
